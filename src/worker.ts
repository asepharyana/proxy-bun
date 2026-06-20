/**
 * Cloudflare Workers-compatible relay handler.
 *
 * Uses `env` bindings for configuration instead of `process.env`.
 * Exports `{ fetch }` as required by the Cloudflare Workers runtime.
 *
 * Reuses the same relay logic from `src/lib/` and `src/middleware/` as
 * the standalone Bun.serve() server, but:
 *   - Uses `env` for configuration (Workers don't have process.env)
 *   - Does NOT support WebSocket upgrades
 *   - Rate limiter is per-isolate (resets on cold start)
 */

import {
	normalizeTargetUrl,
	isAllowedTarget,
	filterRequestHeaders,
	buildRelayRequest,
	createRelayResponse,
	classifyFetchError,
	createErrorResponse,
	createCorsPreflightResponse,
	getCorsHeaders,
} from "./lib/relay-utils";

import { checkBodySize } from "./middleware/body-limiter";
import { createRateLimiter } from "./middleware/rate-limiter";
import { logRelayEvent } from "./middleware/logger";
import { handleChatCompletion, listModels } from "./lib/ai-proxy";
import { handleAnthropicMessages } from "./lib/anthropic-proxy";

// --- Types -------------------------------------------------------------------

export interface Env {
	/** Upstream fetch timeout in ms (default: 30000) */
	RELAY_TIMEOUT_MS?: string;
	/** Max requests per sliding window (default: 100) */
	RATE_LIMIT_MAX?: string;
	/** Sliding window duration in ms (default: 60000) */
	RATE_LIMIT_WINDOW_MS?: string;
	/** Server listen port (unused on Workers, here for local dev compatibility) */
	PORT?: string;
	/** API key for AI proxy auth (empty = disabled) */
	API_KEY?: string;
}

// --- Singletons (per-isolate, survives warm starts) ---------------------------

let rateLimiter: ReturnType<typeof createRateLimiter> | null = null;

function getRateLimiter(env: Env) {
	if (!rateLimiter) {
		rateLimiter = createRateLimiter({
			maxRequests: getNumericEnv(env, "RATE_LIMIT_MAX", 100),
			windowMs: getNumericEnv(env, "RATE_LIMIT_WINDOW_MS", 60000),
		});
	}
	return rateLimiter;
}

// --- Helpers ------------------------------------------------------------------

function getNumericEnv(
	env: Env,
	key: keyof Env,
	fallback: number,
): number {
	const val = env[key] ?? (typeof process !== "undefined" ? process.env[key as string] : undefined);
	return Number.parseInt(val ?? String(fallback), 10);
}

function getClientIP(req: Request): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}

	const cfIp = req.headers.get("cf-connecting-ip");
	if (cfIp) return cfIp;

	return "unknown";
}

// --- Auth Helper ---------------------------------------------------------------

function requireAuth(req: Request, env: Env): Response | null {
	const apiKey = env.API_KEY ?? "sk-dummy-key";
	const header = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
	const key = header.replace(/^Bearer\s+/i, "").trim();
	if (key === apiKey) return null;
	return new Response(
		JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }),
		{ status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
	);
}

// --- Route Handlers ------------------------------------------------------------

const SERVER_START_TIME = Date.now();
const RELAY_VERSION = "1.0.0";

function handleHealth(): Response {
	return new Response(
		JSON.stringify({
			status: "ok",
			uptime: Date.now() - SERVER_START_TIME,
			version: RELAY_VERSION,
		}),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json",
				...getCorsHeaders(),
			},
		},
	);
}

function handleIndex(): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edge Proxy Relay</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #e1e4e8; background: #0d1117; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    main { text-align: center; }
    h1 { font-size: 2rem; color: #58a6ff; margin-bottom: 0.5rem; }
    p { color: #8b949e; margin: 0.5rem 0; }
    a { color: #58a6ff; }
    .status { color: #3fb950; }
    .links { margin-top: 1.5rem; display: flex; gap: 1rem; justify-content: center; }
    .links a { text-decoration: none; background: #161b22; border: 1px solid #30363d; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; }
    .links a:hover { background: #1c2128; border-color: #58a6ff; }
  </style>
</head>
<body>
<main>
  <h1>Edge Proxy Relay</h1>
  <p class="status">Server is running</p>
  <div class="links">
    <a href="/docs">Interactive Test Page</a>
    <a href="/health">Health Check</a>
  </div>
</main>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
		},
	});
}

// --- Relay Logic ---------------------------------------------------------------

async function handleRelay(req: Request, env: Env): Promise<Response> {
	const startTime = performance.now();
	const method = req.method;
	const clientIP = getClientIP(req);
	const requestUrl = req.url;

	const RELAY_TIMEOUT_MS = getNumericEnv(env, "RELAY_TIMEOUT_MS", 30000);

	const limiter = getRateLimiter(env);

	// -- Pre-flight CORS --------------------------------------------------------
	if (method === "OPTIONS") {
		return createCorsPreflightResponse();
	}

	// -- Middleware: Body size check -------------------------------------------
	const bodyError = checkBodySize(req);
	if (bodyError) {
		logRelayEvent({
			method,
			url: requestUrl,
			status: bodyError.status,
			durationMs: Math.round(performance.now() - startTime),
			ip: clientIP,
		});
		return bodyError;
	}

	// -- Middleware: Rate limiting ---------------------------------------------
	const rateCheck = await limiter.checkAsync(clientIP);
	if (!rateCheck.allowed) {
		logRelayEvent({
			method,
			url: requestUrl,
			status: 429,
			durationMs: Math.round(performance.now() - startTime),
			error: "rate_limit_exceeded",
			ip: clientIP,
		});
		return new Response(
			JSON.stringify({
				error: true,
				code: "RATE_LIMITED",
				message: "Too many requests",
				retryAfterMs: rateCheck.retryAfterMs,
			}),
			{
				status: 429,
				headers: {
					"Content-Type": "application/json",
					...getCorsHeaders(),
					"Retry-After": String(
						Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 1000),
					),
				},
			},
		);
	}

	// -- Extract relay parameters from headers ---------------------------------
	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") ?? "/";

	// -- SSRF: Normalize and validate target URL --------------------------------
	const targetUrl = normalizeTargetUrl(target, relayPath);
	if (!targetUrl) {
		logRelayEvent({
			method,
			url: requestUrl,
			status: 400,
			durationMs: Math.round(performance.now() - startTime),
			error: "missing_target_header",
			ip: clientIP,
		});
		return createErrorResponse({
			code: "INVALID_TARGET",
			status: 400,
			message: "Missing or invalid x-relay-target header",
		});
	}

	if (!isAllowedTarget(targetUrl)) {
		logRelayEvent({
			method,
			url: requestUrl,
			status: 403,
			durationMs: Math.round(performance.now() - startTime),
			error: "target_not_allowed",
			ip: clientIP,
		});
		return createErrorResponse({
			code: "SSRF_BLOCKED",
			status: 403,
			message: "Target domain not allowed",
		});
	}

	// -- Build the upstream request ---------------------------------------------
	const filteredHeaders = filterRequestHeaders(req.headers);
	const fetchOptions = buildRelayRequest(
		req,
		filteredHeaders,
		RELAY_TIMEOUT_MS,
	);

	const targetUrlString = targetUrl.toString();

	// -- Execute upstream fetch -------------------------------------------------
	let response: Response;
	try {
		response = await fetch(targetUrlString, fetchOptions);
	} catch (err) {
		const classified = classifyFetchError(err);
		logRelayEvent({
			method,
			url: requestUrl,
			status: classified.status,
			durationMs: Math.round(performance.now() - startTime),
			error: classified.message,
			targetUrl: targetUrlString,
			ip: clientIP,
		});
		return createErrorResponse(classified);
	}

	// -- Build relay response ---------------------------------------------------
	const relayedResponse = createRelayResponse(response);

	logRelayEvent({
		method,
		url: requestUrl,
		status: relayedResponse.status,
		durationMs: Math.round(performance.now() - startTime),
		targetUrl: targetUrlString,
		ip: clientIP,
	});

	return relayedResponse;
}

// --- Exported Worker Handler ---------------------------------------------------

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/health") return handleHealth();
		if (url.pathname === "/docs" || url.pathname === "/test") {
			try {
				const file = Bun.file("public/test-api.html");
				const exists = await file.exists();
				return new Response(exists ? file : "Not found", {
					status: exists ? 200 : 404,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			} catch {
				// Bun.file not available in non-Bun runtimes (e.g. Workers)
				return new Response("Not found", {
					status: 404,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}
		}
		if (
			url.pathname === "/" &&
			req.method === "GET" &&
			!req.headers.get("x-relay-target")
		) {
			return handleIndex();
		}

		if (
			req.method === "GET" &&
			req.headers.get("upgrade")?.toLowerCase() === "websocket"
		) {
			return new Response(
				JSON.stringify({
					error: true,
					code: "UNSUPPORTED",
					message: "WebSocket relay is not available on this deployment",
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
						...getCorsHeaders(),
					},
				},
			);
		}

		if (url.pathname === "/v1/chat/completions") {
			if (req.method === "OPTIONS") return createCorsPreflightResponse();
			if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
			const authErr = requireAuth(req, env);
			if (authErr) return authErr;
			try {
				const body = await req.json();
				return handleChatCompletion(body);
			} catch {
				return new Response(
					JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
					{ status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
				);
			}
		}

		if (url.pathname === "/v1/messages") {
			if (req.method === "OPTIONS") return createCorsPreflightResponse();
			if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
			const authErr = requireAuth(req, env);
			if (authErr) return authErr;
			try {
				const body = await req.json();
				const anthropicVersion = req.headers.get("anthropic-version") ?? undefined;
				return handleAnthropicMessages(body, undefined, undefined, undefined, undefined, anthropicVersion);
			} catch {
				return new Response(
					JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
					{ status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
				);
			}
		}

		if (url.pathname === "/v1/models" && req.method === "GET") {
			const authErr = requireAuth(req, env);
			if (authErr) return authErr;
			const models = listModels().map((id) => ({
				id,
				object: "model",
				created: Math.floor(Date.now() / 1000),
				owned_by: "proxy",
				features: ["prompt_caching"],
			}));
			return new Response(
				JSON.stringify({ object: "list", data: models }),
				{ status: 200, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
			);
		}

		return handleRelay(req, env);
	},
};

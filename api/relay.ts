/**
 * Vercel-compatible relay handler (Bun runtime).
 *
 * This file is the entry point for Vercel serverless function deployments.
 * It exports `{ fetch }` — the contract Vercel's Bun runtime expects for
 * serverless functions.
 *
 * It reuses the same relay logic from `src/lib/` and `src/middleware/` as
 * the standalone Bun.serve() server, but:
 *   - Does NOT call Bun.serve() (Vercel manages the server)
 *   - Does NOT support WebSocket upgrades (not available in Vercel Functions)
 *   - Uses a simplified IP detection (no server.requestIP())
 *   - Rate limiter resets on cold starts (per-instance memory)
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
} from "../src/lib/relay-utils";

import { checkBodySize } from "../src/middleware/body-limiter";
import { createRateLimiter } from "../src/middleware/rate-limiter";
import { logRelayEvent } from "../src/middleware/logger";
import { handleChatCompletion, listModels } from "../src/lib/ai-proxy";
import { handleAnthropicMessages } from "../src/lib/anthropic-proxy";

// ─── Configuration ──────────────────────────────────────────────────────────────

const RELAY_TIMEOUT_MS = Number.parseInt(
	process.env.RELAY_TIMEOUT_MS ?? "30000",
	10,
);
const SERVER_START_TIME = Date.now();
const RELAY_VERSION = "1.0.0";

// ─── API Key Authentication ─────────────────────────────────────────────────────

const API_KEY = process.env.API_KEY ?? "";

function requireAuth(req: Request): Response | null {
	if (!API_KEY) return null;
	const header = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
	const key = header.replace(/^Bearer\s+/i, "").trim();
	if (key === API_KEY) return null;
	return new Response(
		JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }),
		{ status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
	);
}

// ─── Middleware instances (singletons — persist across warm invocations) ─────────

const rateLimiter = createRateLimiter({
	maxRequests: Number.parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10),
	windowMs: Number.parseInt(
		process.env.RATE_LIMIT_WINDOW_MS ?? "60000",
		10,
	),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Get the client IP from the request headers.
 *
 * Vercel populates `x-forwarded-for` and/or `cf-connecting-ip` automatically.
 * Unlike the standalone server, we do NOT call `server.requestIP()` since
 * that Bun API is not available in Vercel Functions.
 */
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

// ─── Route Handlers ─────────────────────────────────────────────────────────────

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
				"Access-Control-Allow-Origin": "*",
			},
		},
	);
}

function handleDocs(): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edge Proxy Relay — Docs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #e1e4e8; background: #0d1117; padding: 2rem; }
    main { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #58a6ff; }
    h2 { font-size: 1.25rem; margin: 2rem 0 0.75rem; color: #c9d1d9; border-bottom: 1px solid #30363d; padding-bottom: 0.25rem; }
    p, li { color: #8b949e; }
    code { background: #161b22; padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; color: #f0f6fc; }
    pre { background: #161b22; padding: 1rem; border-radius: 6px; overflow-x: auto; margin: 0.75rem 0; border: 1px solid #30363d; }
    pre code { background: none; padding: 0; }
    table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #30363d; }
    th { background: #161b22; color: #c9d1d9; }
    ul { padding-left: 1.5rem; margin: 0.5rem 0; }
    .endpoint { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; margin: 1rem 0; }
    .endpoint h3 { color: #58a6ff; font-family: monospace; margin-bottom: 0.5rem; }
    .status { color: #3fb950; }
    a { color: #58a6ff; }
  </style>
</head>
<body>
<main>
  <h1>Edge Proxy Relay</h1>
  <p>Forward HTTP requests to any target server via the <code>x-relay-target</code> header.</p>

  <h2>Endpoints</h2>

  <div class="endpoint">
    <h3>GET /health</h3>
    <p>Health check. Returns <span class="status">200 OK</span> with server status, uptime, and version.</p>
  </div>

  <div class="endpoint">
    <h3>GET /docs</h3>
    <p>This page.</p>
  </div>

  <div class="endpoint">
    <h3>Any Path (Catch-all Relay)</h3>
    <p>Send a request with the <code>x-relay-target</code> header and this proxy forwards it.</p>
  </div>

  <h2>Usage — HTTP Relay</h2>
  <pre><code>curl -s \\
  -H "x-relay-target: https://httpbin.org" \\
  -H "x-relay-path: /get" \\
  "https://your-proxy.example/any/path"</code></pre>
  <table>
    <tr><th>Header</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>x-relay-target</code></td><td>Yes</td><td>Base URL of the upstream (http:// or https://)</td></tr>
    <tr><td><code>x-relay-path</code></td><td>No</td><td>Path to append (default: <code>/</code>)</td></tr>
  </table>

  <h2>Status Codes</h2>
  <table>
    <tr><th>Code</th><th>Meaning</th></tr>
    <tr><td>204</td><td>CORS preflight success (OPTIONS)</td></tr>
    <tr><td>400</td><td>Missing <code>x-relay-target</code> header</td></tr>
    <tr><td>403</td><td>Target blocked (SSRF protection / not allowed)</td></tr>
    <tr><td>413</td><td>Request body exceeds size limit</td></tr>
    <tr><td>429</td><td>Rate limit exceeded</td></tr>
    <tr><td>502</td><td>Upstream network / DNS error</td></tr>
    <tr><td>504</td><td>Upstream timeout</td></tr>
  </table>

  <p><strong>Note:</strong> WebSocket relay is not available on this deployment.</p>
</main>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		},
	});
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
    p { color: #8b949e; }
    a { color: #58a6ff; }
    .status { color: #3fb950; }
  </style>
</head>
<body>
<main>
  <h1>Edge Proxy Relay</h1>
  <p class="status">Server is running</p>
  <p><a href="/health">/health</a> &middot; <a href="/docs">/docs</a></p>
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

// ─── Relay Logic ────────────────────────────────────────────────────────────────

async function handleRelay(req: Request): Promise<Response> {
	const startTime = performance.now();
	const method = req.method;
	const clientIP = getClientIP(req);
	const requestUrl = req.url;

	// ── Pre-flight CORS ──────────────────────────────────────────────
	if (method === "OPTIONS") {
		return createCorsPreflightResponse();
	}

	// ── Middleware: Body size check ──────────────────────────────────
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

	// ── Middleware: Rate limiting ────────────────────────────────────
	const rateCheck = rateLimiter.check(clientIP);
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
					"Access-Control-Allow-Origin": "*",
					"Retry-After": String(
						Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 1000),
					),
				},
			},
		);
	}

	// ── Extract relay parameters from headers ───────────────────────
	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") ?? "/";

	// ── SSRF: Normalize and validate target URL ─────────────────────
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

	// ── Build the upstream request ──────────────────────────────────
	const filteredHeaders = filterRequestHeaders(req.headers);
	const fetchOptions = buildRelayRequest(
		req,
		filteredHeaders,
		RELAY_TIMEOUT_MS,
	);

	const targetUrlString = targetUrl.toString();

	// ── Execute upstream fetch ──────────────────────────────────────
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

	// ── Build relay response ────────────────────────────────────────
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

// ─── Exported Vercel Function Handler ───────────────────────────────────────────

/**
 * Vercel Bun runtime handler.
 *
 * Vercel's Bun runtime expects a `default` export that is an object with
 * a `fetch` method — NOT a bare default function.  This matches the
 * standard `Bun.serve()` handler shape.
 *
 * Handles routing, middleware, and relay logic — same semantics as the
 * standalone Bun.serve() server, minus WebSocket support.
 */
export default {
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		// Static routes — show index only when no relay target is requested
		if (url.pathname === "/health") return handleHealth();
		if (url.pathname === "/docs") return handleDocs();
		if (
			url.pathname === "/" &&
			req.method === "GET" &&
			!req.headers.get("x-relay-target")
		) {
			return handleIndex();
		}

		// WebSocket upgrade — not supported in Vercel Functions
		if (
			req.method === "GET" &&
			req.headers.get("upgrade")?.toLowerCase() === "websocket"
		) {
			return new Response(
				JSON.stringify({
					error: true,
					code: "UNSUPPORTED",
					message: "WebSocket relay is not supported on this deployment",
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					},
				},
			);
		}

		// AI proxy routes — OpenAI-compatible
		if (url.pathname === "/v1/chat/completions") {
			if (req.method === "OPTIONS") return createCorsPreflightResponse();
			if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
			const authErr = requireAuth(req);
			if (authErr) return authErr;
			try {
				const body = await req.json();
				return handleChatCompletion(body);
			} catch {
				return new Response(
					JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
					{ status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
				);
			}
		}

		// AI proxy routes — Anthropic-compatible
		if (url.pathname === "/v1/messages") {
			if (req.method === "OPTIONS") return createCorsPreflightResponse();
			if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
			const authErr = requireAuth(req);
			if (authErr) return authErr;
			try {
				const body = await req.json();
				return handleAnthropicMessages(body);
			} catch {
				return new Response(
					JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
					{ status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
				);
			}
		}

		// Models list
		if (url.pathname === "/v1/models" && req.method === "GET") {
			const authErr = requireAuth(req);
			if (authErr) return authErr;
			const models = listModels().map((id) => ({
				id,
				object: "model",
				created: Math.floor(Date.now() / 1000),
				owned_by: "proxy",
			}));
			return new Response(
				JSON.stringify({ object: "list", data: models }),
				{ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
			);
		}

		// Generic HTTP relay
		return handleRelay(req);
	},
};

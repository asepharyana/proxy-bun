import {
	normalizeTargetUrl,
	isAllowedTarget,
	isAllowedTargetAsync,
	isSsrfDnsCheckEnabled,
	filterRequestHeaders,
	buildRelayRequest,
	createRelayResponse,
	createErrorResponse,
	createCorsPreflightResponse,
	getCorsHeaders,
	classifyFetchError,
} from "./relay-utils";

import { checkBodySize } from "../middleware/body-limiter";
import { createRateLimiter } from "../middleware/rate-limiter";
import { logRelayEvent } from "../middleware/logger";
import { ProxyPool, SessionProxyPool } from "./proxy-pool";
import { handleChatCompletion, listModels } from "./ai-proxy";
import { handleAnthropicMessages } from "./anthropic-proxy";
import { fetchWithRetry } from "./fetch-utils";

// --- Types -------------------------------------------------------------------

export interface RouterEnv {
	PORT?: string;
	RELAY_TIMEOUT_MS?: string;
	BODY_MAX_BYTES?: string;
	RATE_LIMIT_MAX?: string;
	RATE_LIMIT_WINDOW_MS?: string;
	CORS_ORIGIN?: string;
	NODE_ENV?: string;
	API_KEY?: string;
	PROXY_LIST?: string; // Comma-separated list of proxies for serverless
	// Optional KV binding for rate limiter
	KV?: {
		get(key: string): Promise<any>;
		put(key: string, value: any, options?: { expirationTtl?: number }): Promise<void>;
	};
}

// --- Global singletons (survives warm starts) --------------------------------

let rateLimiter: ReturnType<typeof createRateLimiter> | null = null;
let proxyPool: ProxyPool | null = null;
let sessionPool: SessionProxyPool | null = null;

const SERVER_START_TIME = Date.now();
const RELAY_VERSION = "1.0.0";

// --- Helpers -----------------------------------------------------------------

function getNumericEnv(env: RouterEnv, key: keyof RouterEnv, fallback: number): number {
	const raw = env[key];
	const val = typeof raw === "string" ? raw : (typeof process !== "undefined" ? process.env[key as string] : undefined);
	return Number.parseInt(val ?? String(fallback), 10);
}

function getEnv(env: RouterEnv, key: keyof RouterEnv, fallback: string): string {
	const raw = env[key];
	const fromEnv = typeof raw === "string" ? raw : (typeof process !== "undefined" ? process.env[key as string] : undefined);
	return fromEnv ?? fallback;
}

function initGlobals(env: RouterEnv) {
	if (!rateLimiter) {
		const kvAdapter = env.KV ? {
			get: async (k: string) => {
				const val = await env.KV!.get(k);
				return val ? JSON.parse(val) : null;
			},
			set: async (k: string, v: number[], ttl?: number) => {
				await env.KV!.put(k, JSON.stringify(v), { expirationTtl: ttl });
			}
		} : undefined;

		rateLimiter = createRateLimiter({
			maxRequests: getNumericEnv(env, "RATE_LIMIT_MAX", 100),
			windowMs: getNumericEnv(env, "RATE_LIMIT_WINDOW_MS", 60000),
			kv: kvAdapter,
		});
	}

	if (!proxyPool) {
		proxyPool = new ProxyPool();
		// For Bun (process.env.PROXY_FILE) it's loaded in index.ts, but for serverless we can load from env
		const proxies = getEnv(env, "PROXY_LIST", "");
		if (proxies) {
			for (const p of proxies.split(",")) {
				const pt = p.trim();
				if (pt) proxyPool.addProxy(pt);
			}
		}
		sessionPool = new SessionProxyPool(proxyPool);
		sessionPool.setFailureThreshold(3);
	}
}

function requireAuth(req: Request, env: RouterEnv): Response | null {
	const API_KEY = getEnv(env, "API_KEY", "sk-dummy-key");
	const header = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
	const key = header.replace(/^Bearer\s+/i, "").trim();
	if (key === API_KEY) return null;
	return new Response(
		JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }),
		{
			status: 401,
			headers: { "Content-Type": "application/json", ...getCorsHeaders() },
		},
	);
}

// --- Static Handlers ---------------------------------------------------------

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

function handleDocs(isWebSocketSupported: boolean): Response {
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
	  <p>Forward HTTP${isWebSocketSupported ? ' and WebSocket' : ''} requests to any target server via the <code>x-relay-target</code> header.</p>

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

${isWebSocketSupported ? `
	  <h2>Usage — WebSocket Relay</h2>
	  <pre><code>const ws = new WebSocket("wss://your-proxy.example/relay", {
	  headers: { "x-relay-target": "wss://echo-websocket.example" },
	});
	ws.onopen = () => ws.send("Hello via relay!");
	ws.onmessage = (e) => console.log("Got:", e.data);</code></pre>
` : `<p><strong>Note:</strong> WebSocket relay is not available on this deployment.</p>`}

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
	</main>
	</body>
	</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			...getCorsHeaders(),
		},
	});
}

// --- Generic HTTP Relay ------------------------------------------------------

async function handleRelay(
	req: Request,
	env: RouterEnv,
	clientIP: string,
): Promise<Response> {
	const startTime = performance.now();
	const method = req.method;
	const requestUrl = req.url;

	const RELAY_TIMEOUT_MS = getNumericEnv(env, "RELAY_TIMEOUT_MS", 30000);

	// -- Pre-flight CORS
	if (method === "OPTIONS") {
		return createCorsPreflightResponse();
	}

	// -- Middleware: Body size check
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

	// -- Middleware: Rate limiting
	const rateCheck = await rateLimiter!.checkAsync(clientIP);
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

	// -- Extract relay parameters from headers
	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") ?? "/";

	// -- SSRF: Normalize and validate target URL
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

	// -- SSRF: DNS rebinding protection (optional, via SSRF_DNS_CHECK=true) -----
	if (isSsrfDnsCheckEnabled()) {
		const asyncAllowed = await isAllowedTargetAsync(targetUrl);
		if (!asyncAllowed) {
			logRelayEvent({
				method,
				url: requestUrl,
				status: 403,
				durationMs: Math.round(performance.now() - startTime),
				error: "ssrf_dns_rebinding",
				ip: clientIP,
			});
			return createErrorResponse({
				code: "SSRF_BLOCKED",
				status: 403,
				message: "Target resolves to private/internal IP",
			});
		}
	}

	// -- Build the upstream request
	const filteredHeaders = filterRequestHeaders(req.headers);
	const fetchOptions = buildRelayRequest(
		req,
		filteredHeaders,
		RELAY_TIMEOUT_MS,
	) as RequestInit & { proxy?: string };

	const targetUrlString = targetUrl.toString();

	// -- Execute upstream fetch with shared retry
	const result = await fetchWithRetry(
		targetUrlString,
		fetchOptions,
		proxyPool!,
		"relay",
	);

	if (result.errorClassification) {
		logRelayEvent({
			method,
			url: requestUrl,
			status: result.errorClassification.status,
			durationMs: Math.round(performance.now() - startTime),
			error: result.errorClassification.message,
			targetUrl: targetUrlString,
			ip: clientIP,
		});
		return createErrorResponse(result.errorClassification);
	}

	const relayedResponse = createRelayResponse(result.response!);

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

// --- Main Router -------------------------------------------------------------

export interface RouterOptions {
	isWebSocketSupported?: boolean;
	getTestApiHtml?: () => string | Promise<string>;
}

export async function handleRequest(
	req: Request,
	env: RouterEnv,
	clientIP: string,
	options: RouterOptions = {},
): Promise<Response | undefined> {
	initGlobals(env);
	const url = new URL(req.url);

	// Static routes
	if (url.pathname === "/health") return handleHealth();
	if (url.pathname === "/docs") return handleDocs(options.isWebSocketSupported ?? false);
	if (url.pathname === "/test" && options.getTestApiHtml) {
		const html = await options.getTestApiHtml();
		return new Response(html, {
			status: 200,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}
	if (url.pathname === "/" && req.method === "GET" && !req.headers.get("x-relay-target")) {
		return handleIndex();
	}

	// AI proxy routes -- OpenAI-compatible API
	if (url.pathname === "/v1/chat/completions") {
		if (req.method === "OPTIONS") return createCorsPreflightResponse();
		if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		const authErr = requireAuth(req, env);
		if (authErr) return authErr;
		try {
			const body = await req.json();
			const sessionId = crypto.randomUUID();
			return handleChatCompletion(body, proxyPool!, sessionPool!, sessionId);
		} catch {
			return new Response(
				JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
				{ status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
			);
		}
	}

	// AI proxy routes -- Anthropic-compatible API
	if (url.pathname === "/v1/messages") {
		if (req.method === "OPTIONS") return createCorsPreflightResponse();
		if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		const authErr = requireAuth(req, env);
		if (authErr) return authErr;
		try {
			const body = await req.json();
			const sessionId = crypto.randomUUID();
			const anthropicVersion = req.headers.get("anthropic-version") ?? undefined;
			return handleAnthropicMessages(body, proxyPool!, sessionPool!, sessionId, undefined, anthropicVersion);
		} catch {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { message: "Invalid JSON body", type: "invalid_request_error" },
				}),
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
			owned_by: "edge-proxy",
			features: ["prompt_caching"],
		}));
		return new Response(
			JSON.stringify({
				object: "list",
				data: models,
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

	// WebSocket upgrade check (Bun specific - worker/vercel should handle their own rejection if needed)
	if (
		req.method === "GET" &&
		req.headers.get("upgrade")?.toLowerCase() === "websocket"
	) {
		if (!options.isWebSocketSupported) {
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
						...getCorsHeaders(),
					},
				},
			);
		}
		// Return undefined to let Bun handle the upgrade in its fetch method
		return undefined;
	}

	// Generic HTTP relay
	return handleRelay(req, env, clientIP);
}

// Ensure proxyPool is available for index.ts to use proxyPool.tryLoad()
export function getSharedProxyPool() {
	if (!proxyPool) {
		proxyPool = new ProxyPool();
		sessionPool = new SessionProxyPool(proxyPool);
		sessionPool.setFailureThreshold(3);
	}
	return proxyPool;
}

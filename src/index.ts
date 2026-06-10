/**
 * Edge Proxy Relay — Pure Bun HTTP + WebSocket relay server.
 *
 * Forwards requests/responses to a target URL specified via the
 * `x-relay-target` request header.  Supports WebSocket upgrades
 * when the target uses `ws://` or `wss://`.
 *
 * ── Environment Variables ───────────────────────────────────────
 * PORT                — Server listen port (default: 3000)
 * RELAY_TIMEOUT_MS    — Upstream fetch timeout (default: 30_000)
 * BODY_MAX_BYTES      — Maximum accepted request body (default: 1_048_576)
 * RATE_LIMIT_MAX      — Max requests per sliding window (default: 100)
 * RATE_LIMIT_WINDOW_MS— Sliding window duration  (default: 60_000)
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
} from "./lib/relay-utils";

import { checkBodySize } from "./middleware/body-limiter";
import { createRateLimiter } from "./middleware/rate-limiter";
import { logRelayEvent } from "./middleware/logger";
import { ProxyPool } from "./lib/proxy-pool";

import type { Server, ServerWebSocket } from "bun";

// ─── Configuration ──────────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const RELAY_TIMEOUT_MS = Number.parseInt(
	process.env.RELAY_TIMEOUT_MS ?? "30000",
	10,
);
const SERVER_START_TIME = Date.now();
const RELAY_VERSION = "1.0.0";

// ─── Middleware instances (singletons) ───────────────────────────────────────────

const rateLimiter = createRateLimiter({
	maxRequests: Number.parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10),
	windowMs: Number.parseInt(
		process.env.RATE_LIMIT_WINDOW_MS ?? "60000",
		10,
	),
});

// ─── Proxy pool (optional) ───────────────────────────────────────────────────────

const proxyPool = new ProxyPool();
proxyPool.tryLoad(
	process.env.PROXY_FILE || process.env.PROXY_LIST || "./proxy.txt",
);

// ─── WebSocket relay data type ──────────────────────────────────────────────────

interface WSRelayData {
	target: string;
	relayPath: string;
	upstream?: WebSocket;
}

// ─── Route handlers ────────────────────────────────────────────────────────────

/** Health check endpoint: returns status, uptime, and version. */
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

/** Simple embedded HTML documentation page. */
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
  <p>Forward HTTP and WebSocket requests to any target server via the <code>x-relay-target</code> header.</p>

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

  <h2>Usage — WebSocket Relay</h2>
  <pre><code>const ws = new WebSocket("wss://your-proxy.example/relay", {
  headers: { "x-relay-target": "wss://echo-websocket.example" },
});
ws.onopen = () => ws.send("Hello via relay!");
ws.onmessage = (e) => console.log("Got:", e.data);</code></pre>

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
			"Access-Control-Allow-Origin": "*",
		},
	});
}

/** Minimal status page shown at the root `/`. */
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

// ─── HTTP Relay Logic ──────────────────────────────────────────────────────────

/**
 * Get the client IP address from the request.
 * Tries `x-forwarded-for` first, then `cf-connecting-ip`, then falls back
 * to the direct connection address from `server.requestIP()`.
 */
function getClientIP(
	req: Request,
	ipGetter: { requestIP(req: Request): { address: string } | null },
): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}

	const cfIp = req.headers.get("cf-connecting-ip");
	if (cfIp) return cfIp;

	const remote = ipGetter.requestIP(req);
	if (remote) return remote.address;

	return "unknown";
}

/**
 * Core HTTP relay handler.
 *
 * Expects `x-relay-target` header to determine the upstream URL.
 * Applies middleware (body size check, rate limiting, logging) and
 * proxies the request while filtering sensitive headers.
 */
async function handleRelay(
	req: Request,
	ipGetter: { requestIP(req: Request): { address: string } | null },
): Promise<Response> {
	const startTime = performance.now();
	const method = req.method;
	const clientIP = getClientIP(req, ipGetter);
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

	// ── SSRF: Normalize and validate target URL ──────────────────────
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

	// ── Build the upstream request ───────────────────────────────────
	const filteredHeaders = filterRequestHeaders(req.headers);
	const fetchOptions = buildRelayRequest(
		req,
		filteredHeaders,
		RELAY_TIMEOUT_MS,
	) as RequestInit & { proxy?: string };

	const targetUrlString = targetUrl.toString();

	// ── Attach proxy (if pool is loaded) ────────────────────────────
	const proxyUrl = proxyPool.getProxyUrl();
	if (proxyUrl) fetchOptions.proxy = proxyUrl;

	// ── Execute upstream fetch (with proxy retry on failure) ─────────
	let response: Response;
	let retried = false;

	for (;;) {
		try {
			response = await fetch(targetUrlString, fetchOptions);
			break;
		} catch (err) {
			// Rotate proxy on network failure and retry once
			if (proxyPool.size > 0 && !retried) {
				retried = true;
				const next = proxyPool.markFailed();
				if (next) {
					fetchOptions.proxy = proxyPool.getProxyUrl()!;
					continue;
				}
			}

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
	}

	if (proxyUrl) proxyPool.markSuccess();

	// ── Build relay response ─────────────────────────────────────────
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

// ─── WebSocket Relay Logic ─────────────────────────────────────────────────────

/**
 * Upgrade an HTTP request to a WebSocket and relay bidirectionally to the
 * target URL specified in the `x-relay-target` header.
 *
 * Returns `undefined` when the upgrade has been accepted (Bun takes over),
 * or a Response when the upgrade failed or the target is invalid.
 */
function handleWebSocketUpgrade(
	req: Request,
	srv: Server<WSRelayData>,
): Response | undefined {
	const target = req.headers.get("x-relay-target");
	if (!target) return undefined;

	const isWS =
		target.startsWith("ws://") || target.startsWith("wss://");
	if (!isWS) return undefined;

	const relayPath = req.headers.get("x-relay-path") ?? "/";

	// Normalize the target URL to verify it's valid
	const normalized = normalizeTargetUrl(target, relayPath);
	if (!normalized) return undefined;
	if (!isAllowedTarget(new URL(normalized.toString()))) return undefined;

	const targetUrl = normalized.toString();

	const upgraded = srv.upgrade(req, {
		data: { target: targetUrl, relayPath },
	});

	if (!upgraded) {
		return new Response("WebSocket upgrade failed", { status: 400 });
	}

	// Returning undefined signals Bun that the upgrade was handled
	return undefined;
}

// ─── Server ─────────────────────────────────────────────────────────────────────

const server: Server<WSRelayData> = Bun.serve<WSRelayData>({
	port: PORT,
	development: {
		hmr: true,
		console: true,
	},

	async fetch(req: Request): Promise<Response | undefined> {
		const url = new URL(req.url);

		// Static routes
		if (url.pathname === "/health") return handleHealth();
		if (url.pathname === "/docs") return handleDocs();
		if (url.pathname === "/" && req.method === "GET" && !req.headers.get("x-relay-target"))
		return handleIndex();

		// WebSocket upgrade check — if the target is ws:// or wss://,
		// attempt to upgrade and relay.  This must happen before the
		// general HTTP relay.
		if (
			req.method === "GET" &&
			req.headers.get("upgrade")?.toLowerCase() === "websocket"
		) {
			const wsResult = handleWebSocketUpgrade(req, server);
			if (wsResult === undefined) {
				// Upgrade was handled by Bun — return undefined
				return undefined;
			}
			return wsResult;
		}

		// Generic HTTP relay
		return handleRelay(req, server);
	},

	websocket: {
		open(ws: ServerWebSocket<WSRelayData>) {
			const { target } = ws.data;

			logRelayEvent({
				method: "WS",
				url: target,
				status: 101,
				durationMs: 0,
				targetUrl: target,
			});

			// Connect to the upstream WebSocket
			const upstream = new WebSocket(target);

			upstream.onopen = () => {
				// Connection established — ready for bidirectional relay
			};

			upstream.onmessage = (event: MessageEvent) => {
				const data = event.data;
				if (typeof data === "string") {
					ws.sendText(data);
				} else if (data instanceof ArrayBuffer) {
					ws.sendBinary(new Uint8Array(data));
				} else if (data instanceof Blob) {
					data.arrayBuffer().then((buf) => {
						ws.sendBinary(new Uint8Array(buf));
					});
				} else {
					ws.sendBinary(data as unknown as Uint8Array);
				}
			};

			upstream.onerror = () => {
				ws.close(1011, "Upstream WebSocket error");
			};

			upstream.onclose = (event: CloseEvent) => {
				ws.close(event.code || 1000, event.reason || "Upstream closed");
			};

			// Store the upstream so we can close it on client disconnect
			ws.data.upstream = upstream;
		},

		message(ws: ServerWebSocket<WSRelayData>, message: string | Buffer<ArrayBuffer>) {
			const upstream = ws.data.upstream;
			if (upstream && upstream.readyState === WebSocket.OPEN) {
				if (typeof message === "string") {
					upstream.send(message);
				} else {
					upstream.send(message);
				}
			}
		},

		close(ws: ServerWebSocket<WSRelayData>, _code: number, _reason: string) {
			const upstream = ws.data.upstream;
			if (upstream) {
				try {
					upstream.close();
				} catch {
					// Already closed
				}
			}
		},

		drain(_ws: ServerWebSocket<WSRelayData>) {
			// Backpressure not implemented in this minimal relay
		},
	},
});

// ─── Startup ───────────────────────────────────────────────────────────────────

console.log(
	`[relay] Edge Proxy Relay v${RELAY_VERSION} listening on http://localhost:${server.port}`,
);

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

const shutdownHandler = (signal: string) => {
	console.log(`\n[relay] Received ${signal}, shutting down gracefully...`);
	server.stop();
	process.exit(0);
};

process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
process.on("SIGINT", () => shutdownHandler("SIGINT"));

// ─── Exports (for testing) ─────────────────────────────────────────────────────

export type { WSRelayData };
export {
	server,
	handleHealth,
	handleDocs,
	handleIndex,
	handleRelay,
	getClientIP,
};

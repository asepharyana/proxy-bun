/**
 * Edge Proxy Relay — Standalone Bun.serve() entry point.
 *
 * Thin wrapper around the shared router in src/lib/router.ts.
 * Adds:
 *   - Bun.serve() bindings
 *   - WebSocket relay support
 *   - IPv6 source rotation
 *   - Proxy pool file loading
 *   - Graceful shutdown
 */

import {
	normalizeTargetUrl,
	isAllowedTarget,
	createErrorResponse,
	setSsrfDnsCheck,
} from "./lib/relay-utils";

import {
	handleHealth,
	handleIndex,
	getClientIPFromServer as getClientIP,
	getSharedProxyPool,
} from "./lib/router";
import type { RouterEnv } from "./lib/router";

import { IPv6SourcePool } from "./lib/ipv6-pool";
import { closeAllActiveReaders, isDevMode } from "./lib/fetch-utils";

import type { Server, ServerWebSocket } from "bun";

// --- Configuration ------------------------------------------------------------

const RELAY_VERSION = "1.0.0";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "::";

// --- Proxy pool (optional) ----------------------------------------------------

const proxyPool = getSharedProxyPool();
proxyPool.tryLoad(
	process.env.PROXY_FILE || process.env.PROXY_LIST || "./proxy.txt",
);

// --- IPv6 source pool (optional) ----------------------------------------------

const ipv6Pool = new IPv6SourcePool();
ipv6Pool.loadFromEnv();
if (ipv6Pool.configured) {
	console.log(`[relay] IPv6 source pool loaded: ${ipv6Pool.size} addresses`);
}

// --- SSRF DNS rebinding protection --------------------------------------------

if (process.env.SSRF_DNS_CHECK === "true") {
	setSsrfDnsCheck(true);
	console.log("[relay] SSRF DNS rebinding protection enabled");
}

// --- Env bag for router (falls through to process.env) ------------------------

const routerEnv: RouterEnv = {};

// --- WebSocket relay data type -----------------------------------------------

interface WSRelayData {
	target: string;
	relayPath: string;
	upstream?: WebSocket;
	paused?: boolean;
}

// --- WebSocket relay ---------------------------------------------------------

function handleWebSocketUpgrade(
	req: Request,
	srv: Server<WSRelayData>,
): Response | undefined {
	const target = req.headers.get("x-relay-target");
	if (!target) return undefined;

	const isWS = target.startsWith("ws://") || target.startsWith("wss://");
	if (!isWS) return undefined;

	const relayPath = req.headers.get("x-relay-path") ?? "/";

	const normalized = normalizeTargetUrl(target, relayPath);
	if (!normalized) {
		return createErrorResponse({
			code: "INVALID_TARGET",
			status: 400,
			message: "Missing or invalid x-relay-target header",
		});
	}
	if (!isAllowedTarget(new URL(normalized.toString()))) {
		return createErrorResponse({
			code: "SSRF_BLOCKED",
			status: 403,
			message: "Target domain not allowed",
		});
	}

	const upgraded = srv.upgrade(req, {
		data: { target: normalized.toString(), relayPath },
	});

	if (!upgraded) {
		return new Response("WebSocket upgrade failed", { status: 400 });
	}

	return undefined;
}

// --- Server ------------------------------------------------------------------

const server: Server<WSRelayData> = Bun.serve<WSRelayData>({
	hostname: HOST,
	ipv6Only: false,
	port: PORT,
	development: isDevMode() ? { hmr: true, console: true } : undefined,

	async fetch(req: Request): Promise<Response | undefined> {
		const url = new URL(req.url);
		const ipv6Source = ipv6Pool.getNext() ?? undefined;

		// Static routes
		if (url.pathname === "/health") return handleHealth();
		if (url.pathname === "/docs" || url.pathname === "/test") {
			const file = Bun.file("public/test-api.html");
			const exists = await file.exists();
			return new Response(exists ? file : "Not found", {
				status: exists ? 200 : 404,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
		if (
			url.pathname === "/" &&
			req.method === "GET" &&
			!req.headers.get("x-relay-target")
		)
			return handleIndex();

		// WebSocket upgrade check
		if (
			req.method === "GET" &&
			req.headers.get("upgrade")?.toLowerCase() === "websocket"
		) {
			const wsResult = handleWebSocketUpgrade(req, server);
			if (wsResult === undefined) return undefined;
			return wsResult;
		}

		// Delegate all other routing (including AI proxy routes) to the shared router
		const clientIP = getClientIP(req, server);
		const result = await (await import("./lib/router")).handleRequest(
			req,
			routerEnv,
			clientIP,
			{
				isWebSocketSupported: true,
				ipv6Source,
			},
		);
		if (result !== undefined) return result;

		return undefined;
	},

	websocket: {
		open(ws: ServerWebSocket<WSRelayData>) {
			const { target } = ws.data;

			const {
				logRelayEvent,
			} = require("./middleware/logger");
			logRelayEvent({
				method: "WS",
				url: target,
				status: 101,
				durationMs: 0,
				targetUrl: target,
			});

			const upstream = new WebSocket(target);

			upstream.onopen = () => {};

			upstream.onmessage = (event: MessageEvent) => {
				if (ws.data.paused) return;
				const data = event.data;
				if (typeof data === "string") {
					ws.sendText(data);
				} else if (data instanceof ArrayBuffer) {
					ws.sendBinary(new Uint8Array(data));
				} else if (data instanceof Blob) {
					data.arrayBuffer().then((buf) => {
						if (!ws.data.paused) ws.sendBinary(new Uint8Array(buf));
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

			ws.data.upstream = upstream;
		},

		message(
			ws: ServerWebSocket<WSRelayData>,
			message: string | Buffer<ArrayBuffer>,
		) {
			const upstream = ws.data.upstream;
			if (upstream && upstream.readyState === WebSocket.OPEN) {
				upstream.send(message);
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

		drain(ws: ServerWebSocket<WSRelayData>) {
			const upstream = ws.data.upstream;
			if (!upstream || upstream.readyState !== WebSocket.OPEN) return;

			const buffered = (ws as any).bufferAmount ?? 0;
			const BACKPRESSURE_THRESHOLD = 512 * 1024; // 512KB
			const RESUME_THRESHOLD = 64 * 1024; // 64KB

			if (buffered > BACKPRESSURE_THRESHOLD) {
				if (!ws.data.paused) {
					ws.data.paused = true;
					console.warn(
						`[ws] Client backpressure: pausing upstream forwarding (${buffered} bytes buffered)`,
					);
				}
			} else if (ws.data.paused && buffered < RESUME_THRESHOLD) {
				ws.data.paused = false;
				console.log(
					`[ws] Client backpressure cleared: resuming upstream forwarding (${buffered} bytes buffered)`,
				);
			}
		},
	},
});

// --- Startup -----------------------------------------------------------------

console.log(
	`[relay] Edge Proxy Relay v${RELAY_VERSION} listening on http://${HOST}:${server.port}`,
);
if (isDevMode()) {
	console.log("[relay] Development mode: HMR enabled");
}

// --- Graceful Shutdown -------------------------------------------------------

const shutdownHandler = async (signal: string) => {
	console.log(`\n[relay] Received ${signal}, shutting down gracefully...`);
	await closeAllActiveReaders();
	server.stop();
	process.exit(0);
};

process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
process.on("SIGINT", () => shutdownHandler("SIGINT"));

// --- Exports (for testing) ---------------------------------------------------

export type { WSRelayData };
export { server, handleHealth, handleIndex, getClientIP };

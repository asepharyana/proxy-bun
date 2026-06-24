/**
 * Vercel-compatible relay handler (Bun runtime).
 *
 * Thin wrapper around the shared router in src/lib/router.ts.
 * Does NOT call Bun.serve() (Vercel manages the server).
 * Does NOT support WebSocket upgrades.
 */

import {
	handleRelayPlain,
	handleRequest,
	getClientIP,
} from "../src/lib/router";
import type { RouterEnv } from "../src/lib/router";

import { getTestPageHtml } from "../src/lib/test-page";

// --- Singletons (survives warm invocations) ----------------------------------

const routerEnv: RouterEnv = {};

/**
 * Hybrid handler for Vercel/Node web-api and Bun/Workers runtimes.
 */
async function fetchHandler(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const clientIP = getClientIP(req);

	// Static routes
	if (url.pathname === "/health") {
		const { handleHealth } = await import("../src/lib/router");
		return handleHealth();
	}
	if (url.pathname === "/docs" || url.pathname === "/test") {
		return new Response(getTestPageHtml(), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}
	if (
		url.pathname === "/" &&
		req.method === "GET" &&
		!req.headers.get("x-relay-target")
	) {
		const { handleIndex } = await import("../src/lib/router");
		return handleIndex();
	}

	// Delegate to shared router (handles AI proxy, model list, relay)
	const result = await handleRequest(req, routerEnv, clientIP, {
		isWebSocketSupported: false,
		skipProxyPool: true,
	});
	if (result !== undefined) return result;

	// Fallback (shouldn't reach here for relay)
	return handleRelayPlain(req, routerEnv, clientIP);
}

export default Object.assign(fetchHandler, {
	fetch: fetchHandler,
});

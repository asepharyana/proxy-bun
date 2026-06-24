/**
 * Cloudflare Workers-compatible relay handler.
 *
 * Thin wrapper around the shared router in src/lib/router.ts.
 * Uses `env` bindings for configuration instead of `process.env`.
 * Does NOT support WebSocket upgrades.
 * Exports `{ fetch }` as required by Cloudflare Workers.
 */

import {
	handleRelayPlain,
	handleRequest,
	getClientIP,
} from "./lib/router";
import type { RouterEnv } from "./lib/router";

import { getTestPageHtml } from "./lib/test-page";

// --- Types -------------------------------------------------------------------

export interface Env {
	RELAY_TIMEOUT_MS?: string;
	RATE_LIMIT_MAX?: string;
	RATE_LIMIT_WINDOW_MS?: string;
	PORT?: string;
	API_KEY?: string;
}

// --- Convert Workers Env to RouterEnv ----------------------------------------

function toRouterEnv(env: Env): RouterEnv {
	return {
		RELAY_TIMEOUT_MS: env.RELAY_TIMEOUT_MS,
		RATE_LIMIT_MAX: env.RATE_LIMIT_MAX,
		RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
		API_KEY: env.API_KEY,
	};
}

// --- Exported Worker Handler -------------------------------------------------

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const routerEnv = toRouterEnv(env);
		const clientIP = getClientIP(req);

		// Static routes
		if (new URL(req.url).pathname === "/health") {
			const { handleHealth } = await import("./lib/router");
			return handleHealth();
		}
		if (
			new URL(req.url).pathname === "/docs" ||
			new URL(req.url).pathname === "/test"
		) {
			return new Response(getTestPageHtml(), {
				status: 200,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
		if (
			new URL(req.url).pathname === "/" &&
			req.method === "GET" &&
			!req.headers.get("x-relay-target")
		) {
			const { handleIndex } = await import("./lib/router");
			return handleIndex();
		}

		// Delegate to shared router
		const result = await handleRequest(req, routerEnv, clientIP, {
			isWebSocketSupported: false,
			skipProxyPool: true,
		});
		if (result !== undefined) return result;

		return handleRelayPlain(req, routerEnv, clientIP);
	},
};

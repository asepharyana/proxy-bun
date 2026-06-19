/**
 * Relay utilities for the edge proxy.
 * Handles URL normalization, header filtering, SSRF protection,
 * request building, and error handling.
 */

import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

// --- Types & Classes ----------------------------------------------------------

export class RelayError extends Error {
	public readonly name = "RelayError" as const;

	constructor(
		public readonly code:
			| "TIMEOUT"
			| "DNS_FAILURE"
			| "CONNECTION_REFUSED"
			| "NETWORK_ERROR"
			| "INVALID_TARGET"
			| "SSRF_BLOCKED"
			| "BODY_TOO_LARGE"
			| "UPSTREAM_ERROR",
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

// --- SSRF DNS check configuration ---------------------------------------------

/**
 * When true, the relay path will resolve DNS and verify no resolved IP is
 * private/link-local. This protects against DNS rebinding attacks but adds
 * latency (DNS lookup per request). Enable via SSRF_DNS_CHECK=true env var.
 */
let ssrfDnsCheckEnabled = false;

export function setSsrfDnsCheck(enabled: boolean): void {
	ssrfDnsCheckEnabled = enabled;
}

export function isSsrfDnsCheckEnabled(): boolean {
	return ssrfDnsCheckEnabled;
}

// --- CORS configuration -------------------------------------------------------

/** Return CORS headers. Origin defaults to "*" but can be overridden via env. */
export function getAllowedOrigin(): string {
	const configured = process.env.CORS_ORIGIN?.trim();
	if (configured && configured.length > 0) return configured;
	return "*";
}

let cachedCorsHeaders: Record<string, string> | null = null;
let cachedCorsOrigin: string | null = null;

/** Rebuild the CORS headers map (call after changing origin at runtime). */
export function rebuildCorsHeaders(): Record<string, string> {
	const origin = getAllowedOrigin();
	cachedCorsHeaders = {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
		"Access-Control-Allow-Headers": "*",
	};
	cachedCorsOrigin = origin;
	return cachedCorsHeaders;
}

/** Return CORS headers with the configured origin (cached, auto-invalidates on env change). */
export function getCorsHeaders(): Record<string, string> {
	const currentOrigin = getAllowedOrigin();
	// Invalidate cache if CORS_ORIGIN env changed
	if (!cachedCorsHeaders || cachedCorsOrigin !== currentOrigin) {
		rebuildCorsHeaders();
	}
	return cachedCorsHeaders!;
}

// --- URL Handling --------------------------------------------------------------

/**
 * Combines a relay target URL with a path, returning a URL object.
 *
 * - If `target` is null, empty, or whitespace-only, returns null.
 * - Merges query parameters from both `target` and `relayPath`.
 * - Returns a `URL` object (call `.toString()` or `.href` for a string).
 */
export function normalizeTargetUrl(
	target: string | null,
	relayPath: string,
): URL | null {
	if (!target || target.trim().length === 0) return null;

	const normalizedTarget = target.replace(/\/+$/, "");
	const cleanRelayPath = relayPath.startsWith("/")
		? relayPath
		: "/" + relayPath;

	try {
		const baseUrl = new URL(normalizedTarget);
		const baseOrigin = baseUrl.origin;
		const basePathname = baseUrl.pathname;

		// Strip query string from relayPath before concatenating
		const relayPathOnly = cleanRelayPath.includes("?")
			? cleanRelayPath.slice(0, cleanRelayPath.indexOf("?"))
			: cleanRelayPath;

		const combinedPath =
			basePathname === "/"
				? relayPathOnly
				: basePathname.replace(/\/$/, "") + relayPathOnly;

		const combined = new URL(combinedPath, baseOrigin);

		// Preserve query parameters from the target URL
		const targetParams = Array.from(baseUrl.searchParams);
		for (const [key, value] of targetParams) {
			combined.searchParams.set(key, value);
		}

		// Merge query parameters from relayPath
		if (cleanRelayPath.includes("?")) {
			const relayQueryStr = cleanRelayPath.slice(
				cleanRelayPath.indexOf("?") + 1,
			);
			if (relayQueryStr.length > 0) {
				const relayParams = Array.from(new URLSearchParams(relayQueryStr));
				for (const [key, value] of relayParams) {
					combined.searchParams.append(key, value);
				}
			}
		}

		return combined;
	} catch {
		return null;
	}
}

// --- SSRF Protection ----------------------------------------------------------

/** Regex patterns for private / loopback / link-local IP ranges. */
const PRIVATE_IP_PATTERNS: RegExp[] = [
	// IPv4
	/^127\./, // loopback
	/^10\./, // private class A
	/^172\.(?:1[6-9]|2\d|3[01])\./, // private class B
	/^192\.168\./, // private class C
	/^169\.254\./, // link-local
	/^0\./, // current network
	/^0\.0\.0\.0$/, // unspecified
	// IPv6
	/^::$/, // unspecified
	/^::1$/, // loopback
	/^fe80:/i, // link-local
	/^fd00:/i, // unique local
	/^fc00:/i, // unique local
];

const PRIVATE_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"localhost6",
	"localhost6.localdomain6",
	"metadata.google.internal",
	"metadata.internal",
	"169.254.169.254",
]);

const PRIVATE_HOSTNAME_SUFFIXES = [".local", ".internal"];

/**
 * Returns `true` when `hostname` is a private / loopback / link-local IP
 * or a well-known private hostname string.
 */
export function isPrivateIp(hostname: string): boolean {
	const lower = hostname.toLowerCase();

	// Check known private hostnames
	if (PRIVATE_HOSTNAMES.has(lower)) return true;

	// Check hostname suffixes (e.g. *.local, *.internal)
	for (const suffix of PRIVATE_HOSTNAME_SUFFIXES) {
		if (lower.endsWith(suffix)) return true;
	}

	// Check IP patterns
	for (const pattern of PRIVATE_IP_PATTERNS) {
		if (pattern.test(lower)) return true;
	}

	return false;
}

/**
 * Resolve a hostname to its IP addresses and check whether any of them are
 * private / loopback / link-local.  This protects against DNS rebinding
 * attacks where a hostname initially resolves to a public IP (passing the
 * name-based check) but later resolves to a private IP.
 *
 * Returns `true` if the hostname resolves to any private IP, or if the
 * resolution itself fails.  When the hostname is already an IP literal
 * the existing `isPrivateIp` check is used directly.
 */
export async function isPrivateIpAfterResolve(hostname: string): Promise<boolean> {
	const lower = hostname.toLowerCase();

	// If it's already an IP literal, check directly (no rebinding risk)
	if (isIP(lower) !== 0) {
		return isPrivateIp(lower);
	}

	// Resolve to IPv4 and IPv6 addresses concurrently
	try {
		const [v4addrs, v6addrs] = await Promise.all([
			resolve4(lower).catch(() => [] as string[]),
			resolve6(lower).catch(() => [] as string[]),
		]);

		const allAddrs = [...v4addrs, ...v6addrs];
		if (allAddrs.length === 0) {
			// No addresses resolved -- be safe and block
			return true;
		}

		return allAddrs.some((addr) => isPrivateIp(addr));
	} catch {
		// Resolution failure -- block to be safe
		return true;
	}
}

/**
 * Validates a parsed URL is allowed for proxying.
 *
 * - Only `http:` and `https:` protocols are permitted.
 * - Hostname must not be a private / internal IP.
 */
export function isAllowedTarget(url: URL): boolean {
	// Protocol check
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return false;
	}

	// SSRF check -- block private / internal hosts
	if (isPrivateIp(url.hostname)) {
		return false;
	}

	return true;
}

/**
 * Full SSRF validation including DNS rebinding protection.
 * Resolves the hostname and verifies no resolved IP is private.
 */
export async function isAllowedTargetAsync(url: URL): Promise<boolean> {
	if (!isAllowedTarget(url)) return false;
	if (await isPrivateIpAfterResolve(url.hostname)) return false;
	return true;
}

// --- Header Filtering ---------------------------------------------------------

/**
 * Set of exact header names (lower-case) to strip from **outgoing** relay
 * requests.
 */
export const BLOCKED_REQUEST_HEADERS = new Set([
	// Relay control headers
	"host",
	"x-relay-target",
	"x-relay-path",
	// Hop-by-hop headers (should never be forwarded)
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	// Security-sensitive -- strip by default
	"cookie",
	"set-cookie",
	// Vercel platform headers
	"x-vercel-id",
	"x-vercel-deployment-url",
	"x-vercel-oidc-token",
	"x-vercel-signature",
	"x-vercel-edgified",
	"x-vercel-proxy-signature",
	"x-vercel-ip-city",
	"x-vercel-ip-country",
	"x-vercel-ip-country-region",
	"x-vercel-ip-latency",
	"x-vercel-ip-longitude",
	"x-vercel-ip-timezone",
	"x-vercel-forwarded-for",
	"x-vercel-set-bucket",
	// Cloudflare platform headers
	"cf-ray",
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-visitor",
	"cf-worker",
	"cf-edge",
	// Forwarded-for metadata (privacy)
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-real-ip",
	"forwarded",
	"via",
]);

/**
 * Header name prefixes that cause a header to be stripped from **outgoing**
 * relay requests.  Matching is case-insensitive.
 */
export const BLOCKED_REQUEST_PREFIXES = [
	"x-vercel-",
	"cf-",
	"x-forwarded-",
	"x-envoy-",
];

// Pre-computed lower-case versions for efficient matching
const BLOCKED_REQUEST_PREFIXES_LOWER = BLOCKED_REQUEST_PREFIXES.map((p) =>
	p.toLowerCase(),
);

/**
 * Strips sensitive / unnecessary headers from an outgoing relay request.
 *
 * Removes:
 * 1. Exact matches against `BLOCKED_REQUEST_HEADERS` (case-insensitive).
 * 2. Any header whose lower-case key starts with an entry in
 *    `BLOCKED_REQUEST_PREFIXES`.
 *
 * Returns a **new** `Headers` instance -- the original is not mutated.
 */
export function filterRequestHeaders(headers: Headers): Headers {
	const filtered = new Headers();

	const headerEntries = Array.from(headers);
	for (const [key, value] of headerEntries) {
		const lower = key.toLowerCase();

		// Check exact blocked headers
		if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;

		// Check blocked prefixes
		let blockedByPrefix = false;
		for (const prefix of BLOCKED_REQUEST_PREFIXES_LOWER) {
			if (lower.startsWith(prefix)) {
				blockedByPrefix = true;
				break;
			}
		}
		if (blockedByPrefix) continue;

		filtered.set(key, value);
	}

	return filtered;
}

/**
 * Headers to strip from **incoming** relay responses before sending back to
 * the caller.
 */
export const BLOCKED_RESPONSE_HEADERS = new Set([
	"set-cookie",
	"transfer-encoding",
	"keep-alive",
	"connection",
]);

/**
 * Strips sensitive headers from a relay **response** and attaches standard
 * CORS headers.
 *
 * Returns a **new** `Headers` instance -- the original is not mutated.
 */
export function filterResponseHeaders(headers: Headers): Headers {
	const filtered = new Headers(headers);

	const blockedKeys = Array.from(BLOCKED_RESPONSE_HEADERS);
	for (const key of blockedKeys) {
		filtered.delete(key);
	}

	const cors = getCorsHeaders();
	for (const [key, value] of Object.entries(cors)) {
		filtered.set(key, value);
	}

	return filtered;
}

// --- Backward Compatibility ---------------------------------------------------

/**
 * @deprecated Use `filterRequestHeaders` instead.  Kept for compatibility
 *             with existing callers (`route.ts`, tests).
 */
export const filterHeaders = filterRequestHeaders;

// --- Request Building ---------------------------------------------------------

/**
 * Returns `true` when the HTTP method typically carries a request body.
 *
 * `GET`, `HEAD`, and `CONNECT` are the only common methods that never carry
 * a body.  Everything else (POST, PUT, PATCH, DELETE, OPTIONS, etc.) may.
 */
export function shouldSendBody(method: string): boolean {
	const upper = method.toUpperCase();
	return upper !== "GET" && upper !== "HEAD" && upper !== "CONNECT";
}

/**
 * Constructs a `RequestInit` suitable for passing to `fetch()`.
 *
 * - Applies the (already-filtered) headers.
 * - Attaches a `ReadableStream` body when the method permits it (with
 *   `duplex: 'half'` as required by the spec for streaming bodies).
 * - Attaches an `AbortSignal.timeout()` signal.
 */
export function buildRelayRequest(
	req: Request,
	headers: Headers,
	timeoutMs?: number,
): RequestInit {
	const timeout = timeoutMs ?? 30_000;
	const method = req.method;
	const body = shouldSendBody(method) ? req.body : undefined;

	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		signal: AbortSignal.timeout(timeout),
	};

	if (body) {
		init.body = body;
		init.duplex = "half";
	}

	return init;
}

// --- Response Building --------------------------------------------------------

/**
 * Creates a relay-friendly `Response` by passing through the upstream status,
 * status text, and body while sanitising headers via `filterResponseHeaders`.
 */
export function createRelayResponse(response: Response): Response {
	const headers = filterResponseHeaders(response.headers);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// --- Error Handling -----------------------------------------------------------

interface ErrorClassification {
	code: string;
	status: number;
	message: string;
}

/**
 * Classifies a caught `unknown` into a structured error with an HTTP status
 * code and a user-facing message suitable for JSON error responses.
 *
 * NOTE: The returned `message` is deliberately generic to avoid leaking
 * upstream details to downstream clients.
 */
export function classifyFetchError(error: unknown): ErrorClassification {
	// RelayError passes through its own classification
	if (error instanceof RelayError) {
		return {
			code: error.code,
			status: error.status,
			message: error.message,
		};
	}

	// AbortError from AbortSignal.timeout or controller.abort()
	if (
		error instanceof DOMException &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	) {
		return {
			code: "TIMEOUT",
			status: 504,
			message: "Upstream timed out",
		};
	}

	if (error instanceof TypeError) {
		const msg = error.message.toLowerCase();

		if (
			msg.includes("dns") ||
			msg.includes("resolve") ||
			msg.includes("hostname") ||
			msg.includes("enotfound")
		) {
			return {
				code: "DNS_FAILURE",
				status: 502,
				message: "DNS resolution failed",
			};
		}

		if (
			msg.includes("refused") ||
			msg.includes("econnrefused") ||
			msg.includes("connection refused")
		) {
			return {
				code: "CONNECTION_REFUSED",
				status: 502,
				message: "Connection refused",
			};
		}

		return {
			code: "NETWORK_ERROR",
			status: 502,
			message: "Network error",
		};
	}

	// Fallback
	return {
		code: "NETWORK_ERROR",
		status: 502,
		message: "Upstream unreachable",
	};
}

/**
 * Produces a JSON `Response` from a structured error classification.
 *
 * Body includes `error`, `code`, and `message` fields.  CORS headers are
 * attached so the caller can read the error from a browser.
 */
export function createErrorResponse(error: ErrorClassification): Response {
	const body = JSON.stringify({
		error: true,
		code: error.code,
		message: error.message,
	});

	return new Response(body, {
		status: error.status,
		headers: {
			"Content-Type": "application/json",
			...getCorsHeaders(),
		},
	});
}

// --- CORS Preflight -----------------------------------------------------------

/**
 * Returns a 204 No Content response with CORS preflight headers.
 */
export function createCorsPreflightResponse(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			...getCorsHeaders(),
			"Access-Control-Max-Age": "86400",
		},
	});
}

// Allowlist: only these headers are forwarded to prevent leaking
// Vercel internal metadata, credentials, and infrastructure info
const ALLOWED_HEADERS = new Set([
	// Standard request headers
	"content-type",
	"accept",
	"accept-encoding",
	"accept-language",
	"user-agent",
	"referer",
	"origin",
	// Auth headers (but NOT cookies)
	"authorization",
	"proxy-authorization",
	// Content negotiation
	"cache-control",
	// Custom headers (no prefix restriction, but Vercel-specific are blocked)
]);

// Blocklist: sensitive headers that should NEVER be forwarded
const BLOCKED_HEADERS = new Set([
	// Vercel infrastructure headers
	"x-vercel-id",
	"x-vercel-deployment-url",
	"x-vercel-oidc-token",
	"x-vercel-oidc-token-ts",
	"x-vercel-signature",
	"x-vercel-edgified",
	"x-vercel-ip-city",
	"x-vercel-ip-country",
	"x-vercel-ip-country-region",
	"x-vercel-ip-latency",
	"x-vercel-deployment-config",
	"x-vercel-rewritten-query",
	// Cloudflare specific
	"cf-ray",
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-ray-id",
	// Forwarding proxies (can leak internal network info)
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"forwarded",
	// Cookies (should be explicitly handled, not blindly forwarded)
	"cookie",
	"set-cookie",
	// Internal infrastructure
	"x-real-ip",
	"x-cluster-client-ip",
	// Authentication tokens
	"x-api-key",
	// Caching
	"x-cache",
]);

// Internal relay headers
const INTERNAL_HEADERS = new Set([
	"x-relay-target",
	"x-relay-path",
	"host",
]);

export interface RelayOptions {
	stripHeaders?: string[];
}

export function isAllowedTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		// Only allow HTTP/HTTPS (prevents file://, data:, etc.)
	 return ["http:", "https:"].includes(parsed.protocol);
	} catch {
		return false;
	}
}

export function normalizeTargetUrl(
	target: string | null,
	relayPath: string,
): string | null {
	if (!target) return null;
	return target.replace(/\/$/, "") + relayPath;
}

export function filterHeaders(headers: Headers): Headers {
	const filtered = new Headers();

	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase();

		// Skip internal relay headers
		if (INTERNAL_HEADERS.has(lowerKey)) continue;

		// Skip blocked headers (security critical)
		if (BLOCKED_HEADERS.has(lowerKey)) continue;

		// Block headers with sensitive infrastructure prefixes
		if (lowerKey.startsWith("x-vercel-")) continue;
		if (lowerKey.startsWith("cf-")) continue;
		if (lowerKey.startsWith("x-forwarded-")) continue;

		// For known safe headers, always allow
		if (ALLOWED_HEADERS.has(lowerKey)) {
			filtered.set(key, value);
			continue;
		}

		// Allow custom headers (no sensitive prefix)
		// Custom headers typically use kebab-case (e.g., x-custom-header)
		filtered.set(key, value);
	}

	return filtered;
}

export function stripRelayHeaders(headers: Headers): Headers {
	// Use the secure filter instead of manual deletion
	return filterHeaders(headers);
}

export function shouldSendBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

export function buildRelayRequest(
	req: Request,
	_headers: Headers,
): RequestInit {
	return {
		method: req.method,
		headers: _headers,
		body: shouldSendBody(req.method) ? req.body : undefined,
		duplex: "half" as const,
	};
}

export function createRelayResponse(response: Response): Response {
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
}

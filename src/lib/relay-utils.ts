export const ALLOWED_HEADERS = new Set([
	"content-type",
	"accept",
	"accept-encoding",
	"accept-language",
	"user-agent",
	"referer",
	"origin",
	"authorization",
	"proxy-authorization",
	"cache-control",
]);

export const BLOCKED_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"x-relay-target",
	"x-relay-path",
	"cookie",
	"set-cookie",
	"x-real-ip",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-api-key",
]);

export function normalizeTargetUrl(target: string | null, relayPath: string): string | null {
	if (!target) return null;
	return target.replace(/\/$/, "") + relayPath;
}

export function filterHeaders(headers: Headers): Headers {
	const filtered = new Headers();
	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (BLOCKED_HEADERS.has(lowerKey)) continue;
		if (lowerKey.startsWith("x-vercel-")) continue;
		if (lowerKey.startsWith("cf-")) continue;
		filtered.set(key, value);
	}
	return filtered;
}

export function shouldSendBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

export function buildRelayRequest(
	req: Request,
	headers: Headers
): RequestInit {
	return {
		method: req.method,
		headers,
		body: shouldSendBody(req.method) ? req.body : undefined,
		duplex: "half",
	} as any;
}

export function isAllowedTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		return ["http:", "https:"].includes(parsed.protocol);
	} catch {
		return false;
	}
}

export function createRelayResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	// Remove headers that would confuse the browser or were handled by the proxy
	headers.delete("content-length");
	headers.delete("transfer-encoding");
	headers.delete("connection");
	headers.delete("keep-alive");

	// Add CORS for browser UI
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "*");

	return new Response(response.body, {
		status: response.status,
		headers,
	});
}

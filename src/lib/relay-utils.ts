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
	"cf-ray",
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-ray-id",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"forwarded",
	"cookie",
	"set-cookie",
	"x-real-ip",
	"x-cluster-client-ip",
	"x-api-key",
	"x-cache",
]);

const INTERNAL_HEADERS = new Set(["x-relay-target", "x-relay-path", "host"]);

export function normalizeTargetUrl(target: string | null, relayPath: string): string | null {
	if (!target) return null;
	return target.replace(/\/$/, "") + relayPath;
}

export function filterHeaders(headers: Headers): Headers {
	const filtered = new Headers();
	for (const [key, value] of headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (INTERNAL_HEADERS.has(lowerKey)) continue;
		if (BLOCKED_HEADERS.has(lowerKey)) continue;
		if (lowerKey.startsWith("x-vercel-")) continue;
		if (lowerKey.startsWith("cf-")) continue;
		if (lowerKey.startsWith("x-forwarded-")) continue;
		// Forward remaining headers
		filtered.set(key, value);
	}
	return filtered;
}

export function shouldSendBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

export function buildRelayRequest(
	req: Request,
	targetUrl: string,
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
	headers.delete("content-encoding");
	headers.delete("content-length");
	headers.delete("transfer-encoding");
	headers.delete("connection");
	headers.delete("keep-alive");
	return new Response(response.body, {
		status: response.status,
		headers,
	});
}

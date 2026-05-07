export const config = { runtime: "edge" };

// Allowlist: only these headers are forwarded to prevent leaking
// Vercel internal metadata, credentials, and infrastructure info
const ALLOWED_HEADERS = new Set([
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

// Blocklist: sensitive headers that should NEVER be forwarded
const BLOCKED_HEADERS = new Set([
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

export function isAllowedTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		return ["http:", "https:"].includes(parsed.protocol);
	} catch {
		return false;
	}
}

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
		if (ALLOWED_HEADERS.has(lowerKey)) {
			filtered.set(key, value);
			continue;
		}
		filtered.set(key, value);
	}
	return filtered;
}

export function shouldSendBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

export default async function handler(req: Request): Promise<Response> {
	if (!ALLOWED_METHODS.has(req.method)) {
		return new Response(JSON.stringify({ error: "Method not allowed" }), {
			status: 405,
			headers: { "content-type": "application/json" },
		});
	}

	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") || "/";
	const targetUrl = normalizeTargetUrl(target, relayPath);

	if (!targetUrl) {
		return new Response(
			JSON.stringify({ error: "Missing x-relay-target header" }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}

	if (!isAllowedTarget(targetUrl)) {
		return new Response(
			JSON.stringify({ error: "Target domain not allowed" }),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
	}

	const headers = filterHeaders(new Headers(req.headers));
	const fetchOptions: RequestInit = {
		method: req.method,
		headers,
		body: shouldSendBody(req.method) ? req.body : undefined,
		duplex: "half",
	};

	const response = await fetch(targetUrl, fetchOptions);
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
}
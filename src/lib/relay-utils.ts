const BLOCKED_HEADERS = new Set([
	"host",
	"x-relay-target",
	"x-relay-path",
]);

export function normalizeTargetUrl(target: string | null, relayPath: string): string | null {
	if (!target) return null;
	return target.replace(/\/$/, "") + relayPath;
}

export function filterHeaders(headers: Headers): Headers {
	const filtered = new Headers(headers);
	for (const key of BLOCKED_HEADERS) {
		filtered.delete(key);
	}
	return filtered;
}

export function shouldSendBody(method: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

export function buildRelayRequest(req: Request, headers: Headers): RequestInit {
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
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "*");

	return new Response(response.body, {
		status: response.status,
		headers,
	});
}

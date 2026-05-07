import {
	buildRelayRequest,
	createRelayResponse,
	normalizeTargetUrl,
	filterHeaders,
	isAllowedTarget,
} from "@/lib/relay-utils";

export const runtime = "edge";

async function handler(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
				"Access-Control-Allow-Headers": "*",
				"Access-Control-Max-Age": "86400",
			},
		});
	}

	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") || "/";

	const targetUrl = normalizeTargetUrl(target, relayPath);
	if (!targetUrl) {
		return new Response(
			JSON.stringify({ error: "Missing x-relay-target header" }),
			{
				status: 400,
				headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
			},
		);
	}

	if (!isAllowedTarget(targetUrl)) {
		return new Response(
			JSON.stringify({ error: "Target domain not allowed" }),
			{
				status: 403,
				headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
			},
		);
	}

	const headers = filterHeaders(new Headers(req.headers));
	const fetchOptions = buildRelayRequest(req, targetUrl, headers);

	const response = await fetch(targetUrl, fetchOptions);
	return createRelayResponse(response);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const HEAD = handler;
export const OPTIONS = handler;

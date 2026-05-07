import {
	buildRelayRequest,
	createRelayResponse,
	normalizeTargetUrl,
	filterHeaders,
	isAllowedTarget,
} from "@/lib/relay-utils";

export const runtime = "edge";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

export async function POST(req: Request) { return await handler(req); }
export async function GET(req: Request) { return await handler(req); }
export async function PUT(req: Request) { return await handler(req); }
export async function DELETE(req: Request) { return await handler(req); }
export async function PATCH(req: Request) { return await handler(req); }
export async function HEAD(req: Request) { return await handler(req); }
export async function OPTIONS(req: Request) { return await handler(req); }

async function handler(req: Request): Promise<Response> {
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
			{
				status: 400,
				headers: { "content-type": "application/json" },
			},
		);
	}

	if (!isAllowedTarget(targetUrl)) {
		return new Response(
			JSON.stringify({ error: "Target domain not allowed" }),
			{
				status: 403,
				headers: { "content-type": "application/json" },
			},
		);
	}

	const headers = filterHeaders(new Headers(req.headers));
	const fetchOptions = buildRelayRequest(req, targetUrl, headers);

	const response = await fetch(targetUrl, fetchOptions);
	return createRelayResponse(response);
}

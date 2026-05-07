import {
	buildRelayRequest,
	createRelayResponse,
	normalizeTargetUrl,
	stripRelayHeaders,
} from "~/relay-utils";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
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

	const headers = stripRelayHeaders(new Headers(req.headers));
	const fetchOptions = buildRelayRequest(req, headers);

	const response = await fetch(targetUrl, fetchOptions);
	return createRelayResponse(response);
}

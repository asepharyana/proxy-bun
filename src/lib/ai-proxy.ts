/**
 * OpenAI-compatible AI proxy.
 *
 * Accepts requests in OpenAI Chat Completions format (POST /v1/chat/completions)
 * and routes them to various backend AI providers based on the model name.
 *
 * Supported backends:
 *   - opencode.ai (OpenAI-compatible — passthrough)
 *   - surfsense.com (custom format — adapted)
 *   - deep-seek.ai (custom format — adapted)
 *
 * Streaming (SSE) is supported for all backends.
 */

import type { ProxyPool } from "./proxy-pool";

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface OpenAIRequest {
	model: string;
	messages: Array<{ role: string; content: string }>;
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	stream?: boolean;
	stop?: string | string[];
	presence_penalty?: number;
	frequency_penalty?: number;
}

export interface BackendConfig {
	provider: string;
	url: string;
	method?: "POST" | "GET";
	/** Extra headers to include (origin, referer, etc.) */
	headers: Record<string, string>;
	/** Field name for the model in the backend request (default: "model") */
	modelField?: string;
	/** Transform the OpenAI request into the backend format */
	adaptRequest?: (req: OpenAIRequest) => unknown;
	/** Transform a backend JSON response into OpenAI format */
	adaptResponse?: (raw: unknown, req: OpenAIRequest) => unknown;
	/** Transform a backend SSE/stream line into OpenAI SSE line (or null to skip) */
	adaptStreamLine?: (line: string, req: OpenAIRequest) => string | null;
}

// ─── Model routing table ─────────────────────────────────────────────────────────

/** Map of model name → backend configuration. Exported for reuse by anthropic-proxy. */
export const MODEL_ROUTES: Record<string, BackendConfig> = {
	// ── opencode.ai (OpenAI-compatible — passthrough) ────────────────
	"deepseek-v4-flash-free": {
		provider: "opencode",
		url: "https://opencode.ai/zen/v1/chat/completions",
		headers: {
			"Content-Type": "application/json",
		},
	},

	// ── surfsense.com (custom format) ───────────────────────────────
	"gpt-5.4-mini-no-login": {
		provider: "surfsense",
		url: "https://api.surfsense.com/api/v1/public/anon-chat/stream",
		modelField: "model_slug",
		headers: {
			accept: "*/*",
			"accept-language": "en-US,en;q=0.7",
			"content-type": "application/json",
			origin: "https://www.surfsense.com",
			referer: "https://www.surfsense.com/",
			"user-agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
		},
		adaptRequest: (req) => ({
			model_slug: req.model,
			messages: req.messages,
		}),
		adaptStreamLine: (line) => {
			if (!line.startsWith("data: ")) return null;
			try {
				const raw = JSON.parse(line.slice(6));
				if (raw.type === "finish" || raw.done) return "data: [DONE]";
				if (raw.type !== "text-delta") return null;
				const text = raw.delta ?? raw.content ?? "";
				if (!text) return null;
				return `data: ${JSON.stringify({
					id: `chatcmpl-${Date.now()}`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "gpt-5.4-mini-no-login",
					choices: [
						{
							index: 0,
							delta: { content: text },
							finish_reason: null,
						},
					],
				})}`;
			} catch {
				return null;
			}
		},
		adaptResponse: (raw: any) => ({
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: "gpt-5.4-mini-no-login",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: raw.content ?? raw.text ?? "",
					},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		}),
	},

	// ── deep-seek.ai (custom format) ────────────────────────────────
	"deepseek/deepseek-v4-flash": {
		provider: "deepseek",
		url: "https://deep-seek.ai/api/chat",
		headers: {
			Accept: "*/*",
			"Accept-Language": "en-US,en;q=0.8",
			"Content-Type": "application/json",
			Origin: "https://deep-seek.ai",
			Referer: "https://deep-seek.ai/chat",
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
		},
		adaptStreamLine: (line) => {
			// deep-seek.ai may return plain text chunks or SSE-like data
			if (!line || line.trim().length === 0) return null;
			// If it's already SSE format, try to pass through
			if (line.startsWith("data: ")) {
				// Rewrite the id and object fields
				try {
					const parsed = JSON.parse(line.slice(6));
					parsed.id = `chatcmpl-${Date.now()}`;
					parsed.object = "chat.completion.chunk";
					parsed.created = Math.floor(Date.now() / 1000);
					parsed.model = "deepseek/deepseek-v4-flash";
					return `data: ${JSON.stringify(parsed)}`;
				} catch {
					return line;
				}
			}
			// Plain text chunks — wrap in OpenAI SSE format
			return `data: ${JSON.stringify({
				id: `chatcmpl-${Date.now()}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "deepseek/deepseek-v4-flash",
				choices: [
					{
						index: 0,
						delta: { content: line },
						finish_reason: null,
					},
				],
			})}`;
		},
		adaptResponse: (raw: any) => ({
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: "deepseek/deepseek-v4-flash",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: raw.choices?.[0]?.message?.content ?? raw.content ?? raw.text ?? "",
					},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		}),
	},
};

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** List all available model names. */
export function listModels(): string[] {
	return Object.keys(MODEL_ROUTES);
}

/** Look up a backend config by model name. */
export function resolveModel(model: string): BackendConfig | undefined {
	return MODEL_ROUTES[model];
}

// ─── Request building ────────────────────────────────────────────────────────────

/**
 * Build the backend `fetch()` options from an OpenAI-style request.
 */
function buildBackendRequest(
	req: OpenAIRequest,
	config: BackendConfig,
	proxyPool?: ProxyPool,
): { url: string; init: RequestInit & { proxy?: string } } {
	const body =
		config.adaptRequest?.(req) ?? {
			model: req.model,
			messages: req.messages,
			temperature: req.temperature,
			max_tokens: req.max_tokens,
			top_p: req.top_p,
			stream: req.stream,
			stop: req.stop,
		};

	const init: RequestInit & { proxy?: string } = {
		method: config.method ?? "POST",
		headers: config.headers,
		body: JSON.stringify(body),
	};

	// Direct first, proxy as fallback (if pool available)
	if (proxyPool && proxyPool.size > 0) {
		init.proxy = undefined; // start direct
	}

	return { url: config.url, init };
}

// ─── Response parsing ───────────────────────────────────────────────────────────

/**
 * Try to parse a JSON response into OpenAI format.
 * Falls back to a generic wrapper if the adapter is unavailable.
 */
function parseJSONResponse(
	text: string,
	config: BackendConfig,
	req: OpenAIRequest,
): unknown {
	if (config.adaptResponse) {
		try {
			const raw = JSON.parse(text);
			return config.adaptResponse(raw, req);
		} catch {
			// fall through
		}
	}

	// Default fallback — assume raw text is the content
	return {
		id: `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: req.model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	};
}

// ─── Main handler ───────────────────────────────────────────────────────────────

/**
 * Handle an OpenAI-compatible chat completions request.
 *
 * @param body  Parsed JSON body (OpenAI format)
 * @param proxyPool  Optional proxy pool for fallback on failure
 */
export async function handleChatCompletion(
	body: unknown,
	proxyPool?: ProxyPool,
): Promise<Response> {
	const req = body as OpenAIRequest;

	if (!req.model) {
		return new Response(
			JSON.stringify({ error: { message: "model is required", type: "invalid_request_error" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	const config = resolveModel(req.model);
	if (!config) {
		return new Response(
			JSON.stringify({
				error: {
					message: `Unknown model: ${req.model}. Available: ${listModels().join(", ")}`,
					type: "invalid_request_error",
				},
			}),
			{
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}

	const wantsStream = req.stream === true;
	const { url, init } = buildBackendRequest(req, config, proxyPool);

	// ── Execute (direct → proxy fallback) ─────────────────────────
	let response: Response | undefined;

	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt === 0) {
			init.proxy = undefined; // direct
		} else if (attempt === 1 && proxyPool && proxyPool.size > 0) {
			init.proxy = proxyPool.getProxyUrl()!;
		} else if (attempt >= 2 && proxyPool && proxyPool.size > 0) {
			const next = proxyPool.rotate();
			if (!next) break;
			init.proxy = proxyPool.getProxyUrl()!;
		} else {
			break;
		}

		try {
			response = await fetch(url, init);
			if (response.ok) {
				// Success — reset proxy failure if we used one
				if (proxyPool && proxyPool.size > 0 && init.proxy && attempt > 0) {
					proxyPool.markSuccess();
				}
				break;
			}
			// Non-2xx — mark proxy as failed so next attempt rotates
			if (proxyPool && proxyPool.size > 0 && init.proxy) {
				proxyPool.markFailed();
			}
		} catch {
			// Network error — mark proxy as failed, retry
			if (proxyPool && proxyPool.size > 0 && init.proxy) {
				proxyPool.markFailed();
			}
		}
	}

	if (!response) {
		return new Response(
			JSON.stringify({
				error: { message: "Upstream service unreachable after retries", type: "server_error" },
			}),
			{ status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
		);
	}

	// ── Handle error responses from backend ───────────────────────
	if (!response.ok) {
		const errBody = await response.text().catch(() => "");
		return new Response(
			JSON.stringify({
				error: {
					message: `Upstream error ${response.status}: ${errBody.slice(0, 500)}`,
					type: "upstream_error",
				},
			}),
			{
				status: response.status,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			},
		);
	}

	// ── Handle streaming ─────────────────────────────────────────
	if (wantsStream || isStreamableResponse(response)) {
		const contentType = response.headers.get("content-type") ?? "";
		const isNativeStream = contentType.includes("text/event-stream");

		if (isNativeStream && config.provider === "opencode") {
			// Passthrough for OpenAI-compatible SSE
			return new Response(response.body, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"Access-Control-Allow-Origin": "*",
					"X-Accel-Buffering": "no",
				},
			});
		}

		// Transform the stream
		const transformed = transformStream(
			response.body!,
			config,
			req,
		);
		return new Response(transformed, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Access-Control-Allow-Origin": "*",
				"X-Accel-Buffering": "no",
			},
		});
	}

	// ── Handle non-streaming response ─────────────────────────────
	const text = await response.text();
	const adapted = parseJSONResponse(text, config, req);

	return new Response(JSON.stringify(adapted), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// ─── Stream handling ────────────────────────────────────────────────────────────

function isStreamableResponse(res: Response): boolean {
	const ct = res.headers.get("content-type") ?? "";
	return (
		ct.includes("text/event-stream") ||
		ct.includes("application/x-ndjson") ||
		ct.includes("text/plain")
	);
}

/**
 * Transform a backend ReadableStream into OpenAI SSE format.
 * Uses the config's `adaptStreamLine` if available.
 */
function transformStream(
	body: ReadableStream,
	config: BackendConfig,
	req: OpenAIRequest,
): ReadableStream {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	return new ReadableStream({
		async pull(controller) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						return;
					}

					const chunk = decoder.decode(value, { stream: true });
					const lines = chunk.split("\n");

					for (const line of lines) {
						if (config.adaptStreamLine) {
							const adapted = config.adaptStreamLine(line, req);
							if (adapted) {
								controller.enqueue(encoder.encode(adapted + "\n\n"));
							}
						} else {
							// Default passthrough
							controller.enqueue(encoder.encode(line + "\n\n"));
						}
					}
				}
			} catch (err) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ error: String(err) })}\n\n`,
					),
				);
				controller.close();
			}
		},
	});
}

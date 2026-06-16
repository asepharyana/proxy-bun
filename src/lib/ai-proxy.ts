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

import type { ProxyPool, SessionProxyPool } from "./proxy-pool";
import { fetchWithRetry, fetchWithSessionRetry, SSELineBuffer, isDevMode, type FetchWithRetryResult } from "./fetch-utils";

// --- Types -------------------------------------------------------------------

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

// --- Model routing table -------------------------------------------------------

/** Map of model name -> backend configuration. */
export const MODEL_ROUTES: Record<string, BackendConfig> = {
	// -- opencode.ai (OpenAI-compatible -- passthrough) --------------------------
	"deepseek-v4-flash-free": {
		provider: "opencode",
		url: "https://opencode.ai/zen/v1/chat/completions",
		headers: {
			"Content-Type": "application/json",
		},
	},

	// -- surfsense.com (custom format) -------------------------------------------
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

	// -- deep-seek.ai (custom format) --------------------------------------------
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
			if (!line || line.trim().length === 0) return null;
			if (line.startsWith("data: ")) {
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

// --- Helpers ------------------------------------------------------------------

/** List all available model names. */
export function listModels(): string[] {
	return Object.keys(MODEL_ROUTES);
}

/** Look up a backend config by model name. */
export function resolveModel(model: string): BackendConfig | undefined {
	return MODEL_ROUTES[model];
}

// --- Request building ----------------------------------------------------------

/**
 * Build the backend `fetch()` options from an OpenAI-style request.
 */
function buildBackendRequest(
	req: OpenAIRequest,
	config: BackendConfig,
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

	return { url: config.url, init };
}

// --- Response parsing ----------------------------------------------------------

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

	// Default fallback -- assume raw text is the content
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

// --- Input validation ---------------------------------------------------------

interface ValidationError {
	message: string;
	type: string;
}

function validateChatRequest(body: unknown): ValidationError | null {
	const req = body as Record<string, unknown>;

	if (!req.model || typeof req.model !== "string") {
		return { message: "model is required", type: "invalid_request_error" };
	}

	if (!Array.isArray(req.messages) || req.messages.length === 0) {
		return { message: "messages must be a non-empty array", type: "invalid_request_error" };
	}

	for (let i = 0; i < req.messages.length; i++) {
		const msg = req.messages[i] as Record<string, unknown> | undefined;
		if (!msg || typeof msg !== "object") {
			return { message: `messages[${i}] must be an object`, type: "invalid_request_error" };
		}
		if (!msg.role || typeof msg.role !== "string") {
			return { message: `messages[${i}].role is required`, type: "invalid_request_error" };
		}
		if (msg.content == null) {
			return { message: `messages[${i}].content is required`, type: "invalid_request_error" };
		}
	}

	return null;
}

// --- Standardized error helper -------------------------------------------------

/** Create a standardized OpenAI-style error response. */
function openAIError(status: number, message: string, type: string): Response {
	return new Response(
		JSON.stringify({ error: { message, type } }),
		{
			status,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			},
		},
	);
}

// --- Main handler --------------------------------------------------------------

/**
 * Handle an OpenAI-compatible chat completions request.
 *
 * Two calling conventions:
 *   1. Standard:    (body, proxyPool?)
 *   2. Session-aware: (body, proxyPool?, sessionPool, sessionId)
 *
 * When both `sessionPool` and `sessionId` are present the request uses
 * session-sticky proxy allocation via `fetchWithSessionRetry`; otherwise
 * the existing `fetchWithRetry` path is used (backward-compatible).
 */
export async function handleChatCompletion(
	body: unknown,
	proxyPool?: ProxyPool,
): Promise<Response>;
export async function handleChatCompletion(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): Promise<Response>;
export async function handleChatCompletion(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): Promise<Response> {
	// -- Input validation -------------------------------------------------------
	const validationError = validateChatRequest(body);
	if (validationError) {
		return openAIError(400, validationError.message, validationError.type);
	}

	const req = body as OpenAIRequest;

	const config = resolveModel(req.model);
	if (!config) {
		return openAIError(
			400,
			`Unknown model: ${req.model}. Available: ${listModels().join(", ")}`,
			"invalid_request_error",
		);
	}

	const wantsStream = req.stream === true;
	const { url, init } = buildBackendRequest(req, config);

	// -- Execute with session-aware or standard retry --------------------------
	const result: FetchWithRetryResult =
		sessionPool && sessionId
			? await fetchWithSessionRetry(url, init, sessionPool, sessionId, `openai:${req.model}`)
			: await fetchWithRetry(url, init, proxyPool, `openai:${req.model}`);

	if (result.errorClassification) {
		return new Response(
			JSON.stringify({
				error: {
					message: result.errorClassification.message,
					type: "upstream_error",
				},
			}),
			{
				status: result.errorClassification.status,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}

	const response = result.response!;

	// -- Handle error responses from backend ------------------------------------
	if (!response.ok) {
		const status = response.status;
		const genericMsg = status >= 500 ? "Upstream server error" : "Upstream rejected request";
		return openAIError(status, genericMsg, "upstream_error");
	}

	// -- Handle streaming -------------------------------------------------------
	if (wantsStream || isStreamableResponse(response)) {
		const contentType = response.headers.get("content-type") ?? "";
		const isNativeStream = contentType.includes("text/event-stream");

		if (isNativeStream && config.provider === "opencode") {
			// Passthrough for OpenAI-compatible SSE
			const headers: Record<string, string> = {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Access-Control-Allow-Origin": "*",
				"X-Accel-Buffering": "no",
			};
			return new Response(
				wrapStreamMaybe(response.body!, sessionPool, sessionId),
				{ status: 200, headers },
			);
		}

		// Transform the stream
		const transformed = transformStream(
			response.body!,
			config,
			req,
		);
		return new Response(
			wrapStreamMaybe(transformed, sessionPool, sessionId),
			{
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"Access-Control-Allow-Origin": "*",
					"X-Accel-Buffering": "no",
				},
			},
		);
	}

	// -- Handle non-streaming response ------------------------------------------
	const text = await response.text();
	if (sessionPool && sessionId) {
		sessionPool.release(sessionId);
	}
	const adapted = parseJSONResponse(text, config, req);

	return new Response(JSON.stringify(adapted), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// --- Stream handling -----------------------------------------------------------

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
 * Uses SSELineBuffer to handle lines split across chunk boundaries.
 */
function transformStream(
	body: ReadableStream,
	config: BackendConfig,
	req: OpenAIRequest,
): ReadableStream {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const lineBuffer = new SSELineBuffer();

	return new ReadableStream({
		async pull(controller) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						// Flush remaining text after stream ends
						const remaining = lineBuffer.flush();
						if (remaining.length > 0) {
							if (config.adaptStreamLine) {
								const adapted = config.adaptStreamLine(remaining, req);
								if (adapted) {
									controller.enqueue(encoder.encode(adapted + "\n\n"));
								}
							} else {
								controller.enqueue(encoder.encode(remaining + "\n\n"));
							}
						}
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						return;
					}

					const chunk = decoder.decode(value, { stream: true });
					const lines = lineBuffer.add(chunk);

					for (const line of lines) {
						if (config.adaptStreamLine) {
							const adapted = config.adaptStreamLine(line, req);
							if (adapted) {
								controller.enqueue(encoder.encode(adapted + "\n\n"));
							}
						} else {
							controller.enqueue(encoder.encode(line + "\n\n"));
						}
					}
				}
			} catch (err) {
				if (isDevMode()) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ error: String(err) })}\n\n`,
						),
					);
				} else {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ error: "Stream error" })}\n\n`,
						),
					);
				}
				controller.close();
			}
		},
	});
}

// --- Stream cleanup wrapper ----------------------------------------------------

/**
 * If a session is active, wrap the stream so the session is released on end/error.
 * Otherwise pass through the stream unchanged.
 */
function wrapStreamMaybe(
	body: ReadableStream,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): ReadableStream {
	if (!sessionPool || !sessionId) return body;
	return wrapStreamWithCleanup(body, () => sessionPool.release(sessionId));
}

/**
 * Wraps a ReadableStream and calls `cleanup` when the stream ends, errors,
 * or is cancelled by the consumer.
 */
function wrapStreamWithCleanup(body: ReadableStream, cleanup: () => void): ReadableStream {
	const reader = body.getReader();

	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					cleanup();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				cleanup();
				controller.error(err);
			}
		},
		cancel(reason) {
			cleanup();
			reader.cancel(reason);
		},
	});
}

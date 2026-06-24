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
import { fetchWithRetry, fetchWithSessionRetry, SSELineBuffer, isDevMode, trackReader, releaseReader, wrapStreamWithCleanup, type FetchWithRetryResult } from "./fetch-utils";
import { getJwt, invalidateJwt } from "./mimo-auth";
import * as aichatAuth from "./aichat-auth";


// --- Types -------------------------------------------------------------------

export interface OpenAIRequest {
	model: string;
	messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	top_k?: number;
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
	/** When true, the backend natively supports Anthropic Messages API format.
	 *  The proxy will pass through the Anthropic request directly without
	 *  translating to OpenAI format. Requires anthropicPassthroughRequest to be set. */
	anthropicPassthrough?: boolean;
	/** Optional function to transform an Anthropic request for a native-Anthropic backend.
	 *  Only used when anthropicPassthrough is true. Can add/modify headers, body fields, etc. */
	anthropicPassthroughRequest?: (body: unknown, model: string) => { body: unknown; headers?: Record<string, string> };
}

// --- Shared aichat.org backend config (all models use the same backend) ------

/** Shared backend config for all aichat.org model routes. */
const aichatConfig: BackendConfig = {
	provider: "aichat",
	url: "https://aichat.org/api/chat",
	headers: {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		Referer: "https://aichat.org/chat",
		"User-Agent":
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
	},
	adaptRequest: (req: OpenAIRequest) => ({
		model: req.model,
		messages: req.messages,
	}),
};

/** All aichat.org model IDs discovered from the chat UI. */
export const AICHAT_MODELS: readonly string[] = [
	"deepseek/deepseek-v4-flash",
	"openai/gpt-4o-mini",
	"anthropic/claude-haiku-4-5",
	"google/gemini-2.0-flash-001",
	"x-ai/grok-3-mini-beta",
	"deepseek/deepseek-chat-v3-0324",
	"qwen/qwen-2.5-72b-instruct",
	"moonshotai/moonlight-16k",
	"perplexity/sonar",
];

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

	// -- aichat.org (OpenAI-compatible, relay via session auth) ------------------
	// All models share the same backend config. aichat.org's /api/chat
	// proxies to OpenRouter internally and accepts any OpenRouter model ID.

	"deepseek/deepseek-v4-flash": aichatConfig,
	"openai/gpt-4o-mini": aichatConfig,
	"anthropic/claude-haiku-4-5": aichatConfig,
	"google/gemini-2.0-flash-001": aichatConfig,
	"x-ai/grok-3-mini-beta": aichatConfig,
	"deepseek/deepseek-chat-v3-0324": aichatConfig,
	"qwen/qwen-2.5-72b-instruct": aichatConfig,
	"moonshotai/moonlight-16k": aichatConfig,
	"perplexity/sonar": aichatConfig,

	// -- Xiaomi MiMo Free (OpenAI-compatible, JWT bootstrap auth) -----------------
	"mimo-auto": {
		provider: "mimo-free",
		url: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
		headers: {
			"Content-Type": "application/json",
			"X-Mimo-Source": "mimocode-cli-free",
			Accept: "text/event-stream",
		},
		adaptRequest: (req) => {
			// Inject the anti-abuse system-message marker if not present.
			// Without it the Mimo API returns 403 Illegal access.
			const messages = [...req.messages];
			const hasMarker = messages.some(
				(m) =>
					m.role === "system" &&
					(typeof m.content === "string" ? m.content.includes("You are MiMoCode") : false),
			);
			if (!hasMarker) {
				messages.unshift({
					role: "system",
					content:
						"You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.",
				});
			}
			return { model: req.model, messages, stream: req.stream };
		},
		adaptResponse: (raw: any) => ({
			id: raw.id ?? `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: raw.created ?? Math.floor(Date.now() / 1000),
			model: "mimo-auto",
			choices: (raw.choices ?? []).map((c: any) => ({
				index: c.index ?? 0,
				message: {
					role: c.message?.role ?? "assistant",
					content: c.message?.content ?? "",
				},
				finish_reason: c.finish_reason ?? "stop",
			})),
			usage: raw.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
	// Mimo Free always wraps with "data:" prefix (SSE-style), strip it.
	let cleaned = text;
	if (config.provider === "mimo-free" && text.startsWith("data:")) {
		cleaned = text.slice(5).trim();
	}

	if (config.adaptResponse) {
		try {
			const raw = JSON.parse(cleaned);
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
	ipv6Source?: string,
): Promise<Response>;
export async function handleChatCompletion(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
	ipv6Source?: string,
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

	// -- Mimo Free: inject JWT authentication and session affinity --------------
	if (config.provider === "mimo-free") {
		const jwt = await getJwt();
		init.headers = {
			...init.headers,
			Authorization: `Bearer ${jwt}`,
			"x-session-affinity": `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
		};
	}

	// -- aichat.org: inject session cookies + CSRF header ----------------------
	if (config.provider === "aichat") {
		const aichat = await aichatAuth.getAichatSession();
		init.headers = {
			...init.headers,
			Cookie: aichat.cookies,
			"X-CSRF-TOKEN": aichat.csrfToken,
		};
	}

	// -- Execute with session-aware or standard retry --------------------------
	let result: FetchWithRetryResult =
		sessionPool && sessionId
			? await fetchWithSessionRetry(url, init, sessionPool, sessionId, `openai:${req.model}`, undefined, ipv6Source)
			: await fetchWithRetry(url, init, proxyPool, `openai:${req.model}`, ipv6Source);

	// -- Mimo Free: auth failure → invalidate JWT and retry once ---------------
	if (
		config.provider === "mimo-free" &&
		result.response &&
		(result.response.status === 401 || result.response.status === 403)
	) {
		invalidateJwt();
		const jwt = await getJwt();
		init.headers = {
			...init.headers,
			Authorization: `Bearer ${jwt}`,
		};
		result =
			sessionPool && sessionId
				? await fetchWithSessionRetry(url, init, sessionPool, sessionId, `openai:${req.model}`, undefined, ipv6Source)
				: await fetchWithRetry(url, init, proxyPool, `openai:${req.model}`, ipv6Source);
	}

	// -- aichat.org: session expiry → invalidate session and retry once ---------
	if (
		config.provider === "aichat" &&
		result.response &&
		result.response.status === 401
	) {
		aichatAuth.invalidateAichatSession();
		const aichat = await aichatAuth.getAichatSession();
		init.headers = {
			...init.headers,
			Cookie: aichat.cookies,
			"X-CSRF-TOKEN": aichat.csrfToken,
		};
		result =
			sessionPool && sessionId
				? await fetchWithSessionRetry(url, init, sessionPool, sessionId, `openai:${req.model}`, undefined, ipv6Source)
				: await fetchWithRetry(url, init, proxyPool, `openai:${req.model}`, ipv6Source);
	}

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

	// -- aichat.org: refresh session cookies from every response -----------------
	if (config.provider === "aichat") {
		aichatAuth.updateAichatSessionFromResponse(response);
	}

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

		if (isNativeStream && (config.provider === "opencode" || config.provider === "aichat" || config.provider === "mimo-free")) {
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
	const reader = trackReader(body.getReader() as any as ReadableStreamDefaultReader);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const lineBuffer = new SSELineBuffer();

	// SSE keepalive: send a comment every 15s to prevent LB/proxy timeout
	let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	const KEEPALIVE_INTERVAL_MS = 15_000;

	function startKeepalive(controller: ReadableStreamDefaultController) {
		if (keepaliveTimer) return;
		keepaliveTimer = setInterval(() => {
			try {
				controller.enqueue(encoder.encode(": keepalive\n\n"));
			} catch {
				// Stream already closed
				if (keepaliveTimer) clearInterval(keepaliveTimer);
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	function stopKeepalive() {
		if (keepaliveTimer) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = null;
		}
	}

	return new ReadableStream({
		async pull(controller) {
			try {
				startKeepalive(controller);
				// Process multiple chunks before yielding to event loop
				// to reduce per-chunk setTimeout overhead (~1-4ms each)
				const BATCH_SIZE = 8;
				let chunksProcessed = 0;

				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						stopKeepalive();
						releaseReader(reader);
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

					chunksProcessed++;
					// Yield to event loop after batch to prevent starvation
					if (chunksProcessed >= BATCH_SIZE) {
						chunksProcessed = 0;
						await new Promise((r) => setTimeout(r, 0));
					}
				}
			} catch (err) {
				stopKeepalive();
				releaseReader(reader);
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
		cancel() {
			stopKeepalive();
			reader.cancel();
		},
	});
}

// --- Stream cleanup wrapper ----------------------------------------------------

/**
 * If a session is active, wrap the stream so the session is released on end/error.
 * Otherwise pass through the stream unchanged.
 * Uses the shared wrapStreamWithCleanup from fetch-utils.
 */
function wrapStreamMaybe(
	body: ReadableStream,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): ReadableStream {
	if (!sessionPool || !sessionId) return body;
	return wrapStreamWithCleanup(body, () => sessionPool.release(sessionId));
}

/**
 * Anthropic-compatible AI proxy.
 *
 * Accepts requests in Anthropic Messages API format (POST /v1/messages)
 * and routes them to the same backend AI providers as the OpenAI proxy.
 *
 * Translations:
 *   - Anthropic request -> backend format (OpenAI-compatible)
 *   - Backend response -> Anthropic Messages format
 *   - Backend SSE stream -> Anthropic SSE events
 */

import type { ProxyPool, SessionProxyPool } from "./proxy-pool";
import { MODEL_ROUTES, type BackendConfig } from "./ai-proxy";
import { fetchWithRetry, fetchWithSessionRetry, SSELineBuffer, isDevMode, trackReader, releaseReader, wrapStreamWithCleanup, type FetchWithRetryResult } from "./fetch-utils";

// --- Types -------------------------------------------------------------------

export interface AnthropicContentBlock {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral" };
}

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral" };
}

export interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	stream?: boolean;
	temperature?: number;
	top_p?: number;
t	top_k?: number;
		stream?: boolean;
	top_k?: number;
	stop_sequences?: string[];
	system?: string | AnthropicSystemBlock[];
	metadata?: Record<string, unknown>;
}

interface AnthropicResponse {
	id: string;
	type: "message";
	role: "assistant";
	content: Array<{ type: "text"; text: string }>;
	model: string;
	stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
	stop_sequence: string | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

// --- Model resolution ----------------------------------------------------------

/** Resolve a model name to a backend config (uses MODEL_ROUTES directly). */
function resolveAnthropicModel(
	model: string,
): { backendModel: string; config: BackendConfig } | undefined {
	const direct = MODEL_ROUTES[model];
	if (direct) return { backendModel: model, config: direct };
	return undefined;
}

/** List all available model names (same as OpenAI endpoint). */
export function listAnthropicModels(): string[] {
	return Object.keys(MODEL_ROUTES);
}

// --- Translation: Anthropic -> Backend (OpenAI-format) -------------------------

interface BackendBody {
	model: string;
	messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
	max_tokens: number;
	temperature?: number;
	top_p?: number;
t	top_k?: number;
		stream?: boolean;
	top_k?: number;
	stream?: boolean;
	stop?: string | string[];
}

/**
 * Convert an Anthropic Messages request into the backend's expected format.
 * Uses the backend config's own adaptRequest if available, otherwise
 * produces an OpenAI-compatible body.
 *
 * Preserves Anthropic content blocks with cache_control so that
 * caching directives are not lost during translation.
 *
 * @internal Exported for testing.
 */
export function anthropicToBackend(
	anthReq: AnthropicRequest,
	config: BackendConfig,
	backendModel: string,
	anthropicVersion?: string,
): { body: unknown; headers?: Record<string, string> } {
	// If the backend supports Anthropic natively, pass through directly
	if (config.anthropicPassthrough) {
		if (config.anthropicPassthroughRequest) {
			return config.anthropicPassthroughRequest(anthReq, backendModel);
		}
		const headers: Record<string, string> = {};
		if (anthropicVersion) {
			headers["anthropic-version"] = anthropicVersion;
		}
		return { body: { ...anthReq, model: backendModel }, headers };
	}

	// Convert Anthropic content blocks for OpenAI-compatible backend.
	// When a content block has cache_control, we keep it as a structured
	// content part so the backend (or downstream cache layer) can use it.
	const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = anthReq.messages.map((m) => {
		if (typeof m.content === "string") {
			return { role: m.role, content: m.content };
		}
		// Check if any block has cache_control — if so, preserve as structured array
		const hasCacheControl = m.content.some((c) => c.cache_control);
		if (hasCacheControl) {
			return {
				role: m.role,
				content: m.content.map((c) => {
					const part: Record<string, unknown> = { type: "text", text: c.text };
					if (c.cache_control) {
						part.cache_control = c.cache_control;
					}
					return part;
				}),
			};
		}
		// No cache_control — flatten to plain text for simpler backend processing
		return { role: m.role, content: m.content.map((c) => c.text).join("") };
	});

	// Prepend system prompt as a system message if present.
	// Preserve cache_control on system blocks when present.
	if (anthReq.system) {
		if (typeof anthReq.system === "string") {
			messages.unshift({ role: "system", content: anthReq.system });
		} else if (Array.isArray(anthReq.system)) {
			const hasCacheControl = anthReq.system.some((s) => s.cache_control);
			if (hasCacheControl) {
				messages.unshift({
					role: "system",
					content: anthReq.system.map((s) => {
						const part: Record<string, unknown> = { type: "text", text: s.text };
						if (s.cache_control) part.cache_control = s.cache_control;
						return part;
					}),
				});
			} else {
				messages.unshift({
					role: "system",
					content: anthReq.system.map((s) => s.text).join(""),
				});
			}
		}
	}

	const base: BackendBody = {
		model: backendModel,
		messages,
		max_tokens: anthReq.max_tokens,
		temperature: anthReq.temperature,
		top_p: anthReq.top_p,
		top_k: anthReq.top_k,
		stream: anthReq.stream,
	};

	if (anthReq.stop_sequences?.length) {
		base.stop =
			anthReq.stop_sequences.length === 1
				? anthReq.stop_sequences[0]
				: anthReq.stop_sequences;
	}

	if (config.adaptRequest) {
		const headers: Record<string, string> = {};
		if (anthropicVersion) {
			headers["anthropic-version"] = anthropicVersion;
		}
		return {
			body: config.adaptRequest({
				model: backendModel,
				messages,
				temperature: anthReq.temperature,
				max_tokens: anthReq.max_tokens,
				top_p: anthReq.top_p,
				top_k: anthReq.top_k,
				stream: anthReq.stream,
				stop: anthReq.stop_sequences?.length === 1
					? anthReq.stop_sequences[0]
					: anthReq.stop_sequences,
			}),
			headers,
		};
	}

	const headers: Record<string, string> = {};
	if (anthropicVersion) {
		headers["anthropic-version"] = anthropicVersion;
	}

	return { body: base, headers };
}

// --- Translation: Backend -> Anthropic -----------------------------------------

/**
 * Extract usage tokens from a backend response, normalizing across
 * OpenAI, Anthropic, and custom formats.
 */
function extractUsage(raw: any): AnthropicResponse["usage"] {
	const usage = raw.usage ?? {};
	return {
		input_tokens:
			usage.input_tokens ??
			usage.prompt_tokens ??
			0,
		output_tokens:
			usage.output_tokens ??
			usage.completion_tokens ??
			0,
		cache_creation_input_tokens:
			usage.cache_creation_input_tokens ?? undefined,
		cache_read_input_tokens:
			usage.cache_read_input_tokens ?? undefined,
	};
}

/**
 * Convert a backend JSON response body into Anthropic Messages format.
 * Extracts token usage and cache metrics from the backend response.
 */
function backendToAnthropicResponse(
	raw: any,
	model: string,
): AnthropicResponse {
	const text =
		raw.choices?.[0]?.message?.content ?? raw.content ?? raw.text ?? "";

	return {
		id: raw.id ?? `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "text", text }],
		model,
		stop_reason: raw.choices?.[0]?.finish_reason === "stop" ? "end_turn" : null,
		stop_sequence: raw.stop_sequence ?? null,
		usage: extractUsage(raw),
	};
}

// --- Streaming: Backend SSE -> Anthropic SSE -----------------------------------

/**
 * Accumulate text from an SSE response body (data: lines) into a single string.
 * Handles Claude Code SSE format: {"type":"text-delta","delta":"..."}
 */
function accumulateSSEText(sseBody: string): string {
	let accumulated = "";
	for (const rawLine of sseBody.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed.startsWith("data: ")) continue;
		const raw = trimmed.slice(6);
		if (raw === "[DONE]") continue;
		try {
			const parsed = JSON.parse(raw);
			if (parsed.type === "text-delta" && parsed.delta) {
				accumulated += parsed.delta;
			}
		} catch {
			// skip unparseable lines
		}
	}
	return accumulated;
}

/**
 * Extract text content from a parsed SSE data object regardless of format.
 *
 * Handles multiple SSE formats:
 *   - Claude Code format: { "type": "text-delta", "delta": "..." }
 *   - OpenAI format:     { "choices": [{ "delta": { "content": "..." } }] }
 *   - Generic JSON:      { "content": "..." } or { "text": "..." }
 */
function extractTextFromSSE(parsed: any): string | null {
	if (parsed == null) return null;

	if (typeof parsed === "object") {
		switch (parsed.type) {
			case "text-delta":
				return parsed.delta ?? null;
			case "content_block_delta":
				return parsed.delta?.text ?? parsed.delta?.delta ?? null;
		}
	}

	const openai = parsed.choices?.[0]?.delta?.content ??
		parsed.choices?.[0]?.text;
	if (openai) return openai;

	if (typeof parsed.content === "string") return parsed.content;
	if (typeof parsed.text === "string") return parsed.text;
	if (typeof parsed.delta === "string") return parsed.delta;

	return null;
}

/**
 * Try to extract usage info from a backend SSE data line.
 * Returns usage object if found, null otherwise.
 */
function extractUsageFromSSELine(line: string): AnthropicResponse["usage"] | null {
	if (!line.startsWith("data: ")) return null;
	const raw = line.slice(6);
	if (raw === "[DONE]") return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.usage) {
			return extractUsage(parsed);
		}
	} catch {
		// skip unparseable
	}
	return null;
}

/**
 * Transform a backend SSE line into Anthropic SSE content_block_delta events.
 * Optionally collects usage from the stream.
 * When outputCounter is provided, tracks the number of output characters
 * for estimating output tokens when the backend doesn't report them.
 */
function backendLineToAnthropicSSE(
	line: string,
	_model: string,
	config: BackendConfig,
	usageAccum?: AnthropicResponse["usage"],
	outputCounter?: OutputCounter,
): string | null {
	if (!line || line.trim().length === 0) return null;

	// Try to extract usage from this line
	if (usageAccum) {
		const lineUsage = extractUsageFromSSELine(line);
		if (lineUsage) {
			if (lineUsage.input_tokens) usageAccum.input_tokens = lineUsage.input_tokens;
			if (lineUsage.output_tokens) usageAccum.output_tokens = lineUsage.output_tokens;
			if (lineUsage.cache_creation_input_tokens) usageAccum.cache_creation_input_tokens = lineUsage.cache_creation_input_tokens;
			if (lineUsage.cache_read_input_tokens) usageAccum.cache_read_input_tokens = lineUsage.cache_read_input_tokens;
		}
	}

	if (config.adaptStreamLine) {
		const adapted = config.adaptStreamLine(line, {} as any);
		if (!adapted) return null;
		if (adapted === "data: [DONE]") {
			return null;
		}
		try {
			const parsed = JSON.parse(adapted.replace(/^data: /, ""));
			const text = extractTextFromSSE(parsed);
			if (text) {
				if (outputCounter) outputCounter.chars += text.length;
				return formatContentBlockDelta(text);
			}
			return null;
		} catch {
			return null;
		}
	}

	if (line.startsWith("data: ")) {
		const raw = line.slice(6);
		if (raw === "[DONE]") {
			return null;
		}
		try {
			const parsed = JSON.parse(raw);
			if (parsed.type === "start" || parsed.type === "start-step" ||
				parsed.type === "data-thinking-step" || parsed.type === "text-start" ||
				parsed.type === "ping") {
				return null;
			}
			const text = extractTextFromSSE(parsed);
			if (text) {
				if (outputCounter) outputCounter.chars += text.length;
				return formatContentBlockDelta(text);
			}
			return null;
		} catch {
			// Not JSON -- treat as plain text
		}
	}

	if (line.length > 0) {
		if (outputCounter) outputCounter.chars += line.length;
		return formatContentBlockDelta(line);
	}

	return null;
}

/** Format a content_block_delta SSE event for a text delta. */
function formatContentBlockDelta(text: string): string {
	return `event: content_block_delta\ndata: ${JSON.stringify({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	})}`;
}

/** Mutable counter shared between backendLineToAnthropicSSE and its caller. */
interface OutputCounter {
	chars: number;
}

// --- Stream transformer --------------------------------------------------------

function transformAnthropicStream(
	body: ReadableStream,
	model: string,
	config: BackendConfig,
): ReadableStream {
	const reader = trackReader(body.getReader() as any as ReadableStreamDefaultReader);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const lineBuffer = new SSELineBuffer();

	let phase: "init" | "block" | "done" = "init";
	let messageId = `msg_${Date.now()}`;
	const outputCounter: OutputCounter = { chars: 0 };

	// Accumulate usage from backend SSE lines (some backends include usage
	// in their SSE data). Start with zeros, update as we parse lines.
	const usage: AnthropicResponse["usage"] = {
		input_tokens: 0,
		output_tokens: 0,
	};

	// SSE keepalive: send a comment every 15s to prevent LB/proxy timeout
	let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	const KEEPALIVE_INTERVAL_MS = 15_000;

	function startKeepalive(controller: ReadableStreamDefaultController) {
		if (keepaliveTimer) return;
		keepaliveTimer = setInterval(() => {
			try {
				controller.enqueue(encoder.encode(": keepalive\n\n"));
			} catch {
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

				if (phase === "init") {
					phase = "block";
					messageId = `msg_${Date.now()}`;

					const startEvent = `event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: {
							id: messageId,
							type: "message",
							role: "assistant",
							content: [],
							model,
							stop_reason: null,
							stop_sequence: null,
							usage,
						},
					})}`;
					controller.enqueue(encoder.encode(startEvent + "\n\n"));

					const blockStart = `event: content_block_start\ndata: ${JSON.stringify({
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					})}`;
					controller.enqueue(encoder.encode(blockStart + "\n\n"));
				}

				while (phase === "block") {
					const BATCH_SIZE = 8;
					let chunksProcessed = 0;

					while (phase === "block") {
						const { done, value } = await reader.read();
						if (done) {
							stopKeepalive();
							releaseReader(reader);
							const remaining = lineBuffer.flush();
							if (remaining.length > 0) {
								const adapted = backendLineToAnthropicSSE(remaining, model, config, usage, outputCounter);
								if (adapted) {
									controller.enqueue(encoder.encode(adapted + "\n\n"));
								}
							}
							phase = "done";
							break;
						}

						const chunk = decoder.decode(value, { stream: true });
						const lines = lineBuffer.add(chunk);

						for (const line of lines) {
							const adapted = backendLineToAnthropicSSE(line, model, config, usage, outputCounter);
							if (adapted) {
								controller.enqueue(encoder.encode(adapted + "\n\n"));
							}
						}

						chunksProcessed++;
						if (chunksProcessed >= BATCH_SIZE) {
							chunksProcessed = 0;
							await new Promise((r) => setTimeout(r, 0));
							return;
						}
					}
				}

				if (phase === "done") {
					phase = "done";

					// Estimate output tokens from char count as fallback
					// when the backend doesn't report usage in SSE lines.
					if (usage.output_tokens === 0 && outputCounter.chars > 0) {
						usage.output_tokens = Math.max(1, Math.round(outputCounter.chars / 4));
					}

					controller.enqueue(
						encoder.encode(
							'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
						),
					);

					controller.enqueue(
						encoder.encode(
							`event: message_delta\ndata: ${JSON.stringify({
								type: "message_delta",
								delta: { stop_reason: "end_turn", stop_sequence: null },
								usage: { output_tokens: usage.output_tokens },
							})}\n\n`,
						),
					);

					controller.enqueue(
						encoder.encode(
							'event: message_stop\ndata: {"type":"message_stop"}\n\n',
						),
					);

					controller.close();
				}
			} catch (err) {
				stopKeepalive();
				releaseReader(reader);
				if (isDevMode()) {
					controller.enqueue(
						encoder.encode(
							`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
						),
					);
				} else {
					controller.enqueue(
						encoder.encode(
							'event: error\ndata: {"error":"Stream error"}\n\n',
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

// --- Input validation ----------------------------------------------------------

interface ValidationError {
	message: string;
	type: string;
}

function validateAnthropicRequest(body: unknown): ValidationError | null {
	const req = body as Record<string, unknown>;

	if (!req.model || typeof req.model !== "string") {
		return { message: "model is required", type: "invalid_request_error" };
	}

	if (!req.max_tokens || typeof req.max_tokens !== "number") {
		return { message: "max_tokens is required", type: "invalid_request_error" };
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

/** Cache-related response headers to forward from the backend. */
const CACHE_HEADERS = new Set([
	"x-cache",
	"x-cache-status",
	"cf-cache-status",
	"x-vercel-cache",
	"age",
	"cache-control",
]);

/**
 * Forward cache-related headers from the backend response to the client.
 * These headers help clients know whether the response was cached
 * (e.g., x-cache: HIT, cf-cache-status: HIT).
 */
function forwardCacheHeaders(
	response: Response,
	target: Record<string, string>,
): void {
	for (const name of CACHE_HEADERS) {
		const val = response.headers.get(name);
		if (val) {
			target[name] = val;
		}
	}
}

function anthropicError(status: number, message: string, type: string): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { message, type },
		}),
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
 * Handle an Anthropic-compatible messages request.
 *
 * Two calling conventions:
 *   1. Standard:    (body, proxyPool?)
 *   2. Session-aware: (body, proxyPool?, sessionPool, sessionId)
 *
 * When both `sessionPool` and `sessionId` are present the request uses
 * session-sticky proxy allocation via `fetchWithSessionRetry`; otherwise
 * the existing `fetchWithRetry` path is used (backward-compatible).
 *
 * The optional `anthropicVersion` parameter lets callers forward the
 * `anthropic-version` header from the client request, enabling prompt
 * caching and other version-gated features.
 */
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
): Promise<Response>;
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): Promise<Response>;
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
	ipv6Source?: string,
): Promise<Response>;
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
	ipv6Source?: string,
	anthropicVersion?: string,
): Promise<Response>;
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
	ipv6Source?: string,
	anthropicVersion?: string,
): Promise<Response> {
	// -- Input validation -------------------------------------------------------
	const validationError = validateAnthropicRequest(body);
	if (validationError) {
		return anthropicError(400, validationError.message, validationError.type);
	}

	const req = body as AnthropicRequest;

	const resolved = resolveAnthropicModel(req.model);
	if (!resolved) {
		return anthropicError(
			400,
			`Unknown model: ${req.model}. Available: ${listAnthropicModels().join(", ")}`,
			"invalid_request_error",
		);
	}

	const { config, backendModel } = resolved;
	const wantsStream = req.stream === true;

	// Default anthropic-version to 2023-06-01 (required for prompt caching).
	// The client can override via the anthropic-version header.
	const version = anthropicVersion || "2023-06-01";

	// Translate Anthropic -> backend, preserving cache_control directives
	// and forwarding anthropic-version when available
	const { body: backendBody, headers: extraHeaders } = anthropicToBackend(
		req, config, backendModel, version,
	);

	const init: RequestInit & { proxy?: string } = {
		method: "POST",
		headers: { ...config.headers, ...extraHeaders },
		body: JSON.stringify(backendBody),
	};

	const url = config.url;

	// -- Execute with session-aware or standard retry --------------------------
	const result: FetchWithRetryResult =
		sessionPool && sessionId
			? await fetchWithSessionRetry(url, init, sessionPool, sessionId, `anthropic:${req.model}`, undefined, ipv6Source)
			: await fetchWithRetry(url, init, proxyPool, `anthropic:${req.model}`, ipv6Source);

	if (result.errorClassification) {
		if (sessionPool && sessionId) {
			sessionPool.release(sessionId);
		}
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					message: result.errorClassification.message,
					type: "server_error",
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
		// Read the upstream error body so clients see the actual rejection reason,
		// not just a generic "Upstream rejected request" message.
		let upstreamMsg = status >= 500 ? "Upstream server error" : "Upstream rejected request";
		try {
			const errBody = await response.text();
			if (errBody) {
				const errJson = JSON.parse(errBody);
				// OpenAI-style: { error: { message, type } }
				if (errJson?.error?.message) {
					upstreamMsg = errJson.error.message;
				}
				// Anthropic-style: { type: "error", error: { message, type } }
				else if (errJson?.type === "error" && errJson?.error?.message) {
					upstreamMsg = errJson.error.message;
				}
				// Plain JSON with message field
				else if (errJson?.message) {
					upstreamMsg = errJson.message;
				}
				// Raw text error body
				else if (typeof errBody === "string" && errBody.length < 500) {
					upstreamMsg = errBody;
				}
			}
		} catch {
			// Could not read error body — keep generic message
		}
		if (sessionPool && sessionId) {
			sessionPool.release(sessionId);
		}
		return anthropicError(status, upstreamMsg, "upstream_error");
	}

	// -- For native Anthropic passthrough, relay the raw backend response -------
	if (config.anthropicPassthrough) {
		if (wantsStream) {
			const headers: Record<string, string> = {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Access-Control-Allow-Origin": "*",
				"X-Accel-Buffering": "no",
			};
			forwardCacheHeaders(response, headers);
			return new Response(wrapAnthropicStreamMaybe(response.body!, sessionPool, sessionId), {
				status: 200,
				headers,
			});
		}
		const rawBody = await response.text();
		if (sessionPool && sessionId) {
			sessionPool.release(sessionId);
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		};
		forwardCacheHeaders(response, headers);
		return new Response(rawBody, { status: 200, headers });
	}

	// -- Handle streaming (OpenAI-compatible backend) ---------------------------
	if (wantsStream) {
		let transformed = transformAnthropicStream(
			response.body!,
			req.model,
			config,
		);
		transformed = wrapAnthropicStreamMaybe(transformed, sessionPool, sessionId);
		const headers: Record<string, string> = {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
			"X-Accel-Buffering": "no",
		};
		forwardCacheHeaders(response, headers);
		return new Response(transformed, { status: 200, headers });
	}

	// -- Handle non-streaming (OpenAI-compatible backend) -----------------------
	const text = await response.text();
	if (sessionPool && sessionId) {
		sessionPool.release(sessionId);
	}

	const buildBaseHeaders = (): Record<string, string> => {
		const h: Record<string, string> = {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		};
		forwardCacheHeaders(response, h);
		return h;
	};

	if (text.trimStart().startsWith("data: ")) {
		const accumulated = accumulateSSEText(text);
		if (accumulated) {
			return new Response(
				JSON.stringify({
					id: `msg_${Date.now()}`,
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: accumulated }],
					model: req.model,
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				}),
				{
					status: 200,
					headers: buildBaseHeaders(),
				},
			);
		}
	}

	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { content: text };
	}

	const adapted = backendToAnthropicResponse(parsed, req.model);

	return new Response(JSON.stringify(adapted), {
		status: 200,
		headers: buildBaseHeaders(),
	});
}

// --- Stream cleanup wrapper ----------------------------------------------------

/**
 * If a session is active, wrap the stream so the session is released on end/error.
 * Otherwise pass through the stream unchanged.
 * Uses the shared wrapStreamWithCleanup from fetch-utils.
 */
function wrapAnthropicStreamMaybe(
	body: ReadableStream,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): ReadableStream {
	if (!sessionPool || !sessionId) return body;
	return wrapStreamWithCleanup(body, () => sessionPool.release(sessionId));
}

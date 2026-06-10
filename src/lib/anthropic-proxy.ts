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

import type { ProxyPool } from "./proxy-pool";
import { MODEL_ROUTES, type BackendConfig } from "./ai-proxy";
import { fetchWithRetry } from "./fetch-utils";
import { SSELineBuffer } from "./fetch-utils";
import { isDevMode } from "./fetch-utils";

// --- Types -------------------------------------------------------------------

export interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: Array<{
		role: "user" | "assistant";
		content: string | Array<{ type: "text"; text: string }>;
	}>;
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	system?: string;
}

interface AnthropicResponse {
	id: string;
	type: "message";
	role: "assistant";
	content: Array<{ type: "text"; text: string }>;
	model: string;
	stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
	stop_sequence: string | null;
	usage: { input_tokens: number; output_tokens: number };
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
	messages: Array<{ role: string; content: string }>;
	max_tokens: number;
	temperature?: number;
	top_p?: number;
	stream?: boolean;
	stop?: string | string[];
}

/**
 * Convert an Anthropic Messages request into the backend's expected format.
 * Uses the backend config's own adaptRequest if available, otherwise
 * produces an OpenAI-compatible body.
 */
function anthropicToBackend(
	anthReq: AnthropicRequest,
	config: BackendConfig,
	backendModel: string,
): unknown {
	// Flatten Anthropic content blocks to plain text
	const messages: Array<{ role: string; content: string }> = anthReq.messages.map((m) => ({
		role: m.role,
		content:
			typeof m.content === "string"
				? m.content
				: m.content.map((c) => c.text).join(""),
	}));

	// Prepend system prompt as a system message if present
	if (anthReq.system) {
		messages.unshift({ role: "system", content: anthReq.system });
	}

	const base: BackendBody = {
		model: backendModel,
		messages,
		max_tokens: anthReq.max_tokens,
		temperature: anthReq.temperature,
		top_p: anthReq.top_p,
		stream: anthReq.stream,
	};

	if (anthReq.stop_sequences?.length) {
		base.stop =
			anthReq.stop_sequences.length === 1
				? anthReq.stop_sequences[0]
				: anthReq.stop_sequences;
	}

	if (config.adaptRequest) {
		return config.adaptRequest({
			model: backendModel,
			messages,
			temperature: anthReq.temperature,
			max_tokens: anthReq.max_tokens,
			top_p: anthReq.top_p,
			stream: anthReq.stream,
		});
	}

	return base;
}

// --- Translation: Backend -> Anthropic -----------------------------------------

/**
 * Convert a backend JSON response body into Anthropic Messages format.
 */
function backendToAnthropicResponse(
	raw: any,
	model: string,
): AnthropicResponse {
	const text =
		raw.choices?.[0]?.message?.content ?? raw.content ?? raw.text ?? "";

	return {
		id: `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "text", text }],
		model,
		stop_reason: raw.choices?.[0]?.finish_reason === "stop" ? "end_turn" : null,
		stop_sequence: raw.stop_sequence ?? null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
		},
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
 * Transform a backend SSE line into Anthropic SSE content_block_delta events.
 */
function backendLineToAnthropicSSE(
	line: string,
	_model: string,
	config: BackendConfig,
): string | null {
	if (!line || line.trim().length === 0) return null;

	if (config.adaptStreamLine) {
		const adapted = config.adaptStreamLine(line, {} as any);
		if (!adapted) return null;
		if (adapted === "data: [DONE]") {
			return null;
		}
		try {
			const parsed = JSON.parse(adapted.replace(/^data: /, ""));
			const text = extractTextFromSSE(parsed);
			if (text) return formatContentBlockDelta(text);
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
			if (text) return formatContentBlockDelta(text);
			return null;
		} catch {
			// Not JSON -- treat as plain text
		}
	}

	if (line.length > 0) {
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

// --- Stream transformer --------------------------------------------------------

function transformAnthropicStream(
	body: ReadableStream,
	model: string,
	config: BackendConfig,
): ReadableStream {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const lineBuffer = new SSELineBuffer();

	let phase: "init" | "block" | "done" = "init";
	let messageId = `msg_${Date.now()}`;

	return new ReadableStream({
		async pull(controller) {
			try {
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
							usage: { input_tokens: 0, output_tokens: 0 },
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
					const { done, value } = await reader.read();
					if (done) {
						const remaining = lineBuffer.flush();
						if (remaining.length > 0) {
							const adapted = backendLineToAnthropicSSE(remaining, model, config);
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
						const adapted = backendLineToAnthropicSSE(line, model, config);
						if (adapted) {
							controller.enqueue(encoder.encode(adapted + "\n\n"));
						}
					}

					return;
				}

				if (phase === "done") {
					phase = "done";

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
								usage: { output_tokens: 0 },
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
 */
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
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
	const backendBody = anthropicToBackend(req, config, backendModel);

	const init: RequestInit & { proxy?: string } = {
		method: "POST",
		headers: config.headers,
		body: JSON.stringify(backendBody),
	};

	const url = config.url;

	// -- Execute (direct -> proxy fallback) with shared retry -------------------
	const result = await fetchWithRetry(
		url,
		init,
		proxyPool,
		`anthropic:${req.model}`,
	);

	if (result.errorClassification) {
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
		const genericMsg = status >= 500 ? "Upstream server error" : "Upstream rejected request";
		return anthropicError(status, genericMsg, "upstream_error");
	}

	// -- Handle streaming -------------------------------------------------------
	if (wantsStream) {
		const transformed = transformAnthropicStream(
			response.body!,
			req.model,
			config,
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

	// -- Handle non-streaming ---------------------------------------------------
	const text = await response.text();

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
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					},
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
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

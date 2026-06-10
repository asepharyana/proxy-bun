/**
 * Anthropic-compatible AI proxy.
 *
 * Accepts requests in Anthropic Messages API format (POST /v1/messages)
 * and routes them to the same backend AI providers as the OpenAI proxy.
 *
 * Translations:
 *   - Anthropic request → backend format (OpenAI-compatible)
 *   - Backend response → Anthropic Messages format
 *   - Backend SSE stream → Anthropic SSE events
 */

import type { ProxyPool } from "./proxy-pool";
import { MODEL_ROUTES, type BackendConfig } from "./ai-proxy";

// ─── Types ───────────────────────────────────────────────────────────────────────

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

// ─── Model resolution ─────────────────────────────────────────────────────────

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

// ─── Translation: Anthropic → Backend (OpenAI-format) ───────────────────────

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

	// If backend has a custom adaptRequest, use it
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

// ─── Translation: Backend → Anthropic ──────────────────────────────────────

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

// ─── Streaming: Backend SSE → Anthropic SSE ───────────────────────────────

/**
 * Transform a backend SSE line into Anthropic SSE format.
 *
 * Anthropic streaming protocol:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 */
function backendLineToAnthropicSSE(
	line: string,
	_model: string,
	config: BackendConfig,
): string | null {
	if (!line || line.trim().length === 0) return null;

	// Use the backend's adaptStreamLine if available (for custom backends)
	if (config.adaptStreamLine) {
		const adapted = config.adaptStreamLine(line, {} as any);
		if (!adapted) return null;
		if (adapted === "data: [DONE]") {
			return "event: message_stop\ndata: {\"type\":\"message_stop\"}";
		}
		// Parse the OpenAI-format chunk and convert to Anthropic
		try {
			const parsed = JSON.parse(adapted.replace(/^data: /, ""));
			const text = parsed.choices?.[0]?.delta?.content ?? "";
			if (!text) return null;
			return (
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text },
				})}`
			);
		} catch {
			return null;
		}
	}

	// OpenAI-compatible SSE (opencode.ai)
	if (line.startsWith("data: ")) {
		const raw = line.slice(6);
		if (raw === "[DONE]") {
			return "event: message_stop\ndata: {\"type\":\"message_stop\"}";
		}
		try {
			const parsed = JSON.parse(raw);
			const text = parsed.choices?.[0]?.delta?.content ?? "";
			if (!text) return null;
			return (
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text },
				})}`
			);
		} catch {
			return null;
		}
	}

	// Plain text chunks
	if (line.length > 0) {
		return (
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: line },
			})}`
		);
	}

	return null;
}

// ─── Stream transformer ────────────────────────────────────────────────────

function transformAnthropicStream(
	body: ReadableStream,
	model: string,
	config: BackendConfig,
): ReadableStream {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let sentStart = false;

	return new ReadableStream({
		async pull(controller) {
			try {
				// Emit message_start event first
				if (!sentStart) {
					sentStart = true;
					const startEvent = `event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: {
							id: `msg_${Date.now()}`,
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
				}

				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						controller.enqueue(
							encoder.encode(
								'event: message_stop\ndata: {"type":"message_stop"}\n\n',
							),
						);
						controller.close();
						return;
					}

					const chunk = decoder.decode(value, { stream: true });
					const lines = chunk.split("\n");

					for (const line of lines) {
						const adapted = backendLineToAnthropicSSE(line, model, config);
						if (adapted) {
							controller.enqueue(encoder.encode(adapted + "\n\n"));
						}
					}
				}
			} catch (err) {
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
					),
				);
				controller.close();
			}
		},
	});
}

// ─── Main handler ─────────────────────────────────────────────────────────

/**
 * Handle an Anthropic-compatible messages request.
 *
 * @param body  Parsed JSON body (Anthropic Messages format)
 * @param proxyPool  Optional proxy pool for fallback on failure
 */
export async function handleAnthropicMessages(
	body: unknown,
	proxyPool?: ProxyPool,
): Promise<Response> {
	const req = body as AnthropicRequest;

	if (!req.model) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: { message: "model is required", type: "invalid_request_error" },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	if (!req.max_tokens) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: { message: "max_tokens is required", type: "invalid_request_error" },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	const resolved = resolveAnthropicModel(req.model);
	if (!resolved) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					message: `Unknown model: ${req.model}. Available: ${listAnthropicModels().join(", ")}`,
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

	const { config, backendModel } = resolved;
	const wantsStream = req.stream === true;
	const backendBody = anthropicToBackend(req, config, backendModel);

	const init: RequestInit & { proxy?: string } = {
		method: "POST",
		headers: config.headers,
		body: JSON.stringify(backendBody),
	};

	const url = config.url;

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
				type: "error",
				error: { message: "Upstream service unreachable after retries", type: "server_error" },
			}),
			{ status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
		);
	}

	if (!response.ok) {
		const errBody = await response.text().catch(() => "");
		return new Response(
			JSON.stringify({
				type: "error",
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

	// ── Handle non-streaming ─────────────────────────────────────
	const text = await response.text();
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

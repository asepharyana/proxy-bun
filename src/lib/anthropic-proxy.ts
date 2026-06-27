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
import { parseDSML, looksLikeDSML, isCompleteDSML } from "./dsml-parser";
import { getResponseCache, isDSMLDetectionEnabled, ResponseCache } from "./response-cache";

// --- Types -------------------------------------------------------------------

/** Anthropic tool definition (from request `tools` parameter). */
export interface AnthropicToolDef {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

/** Tool_use content block for Anthropic response. */
export interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

/** tool_result content block (user role after tool execution). */
interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
}

/** Unified content block type: text, tool_use, or tool_result. */
export type AnthropicContentBlock =
	| { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
	| ToolUseBlock
	| ToolResultBlock;

export interface AnthropicMessage {
	role: "user" | "assistant" | "tool";
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
	top_k?: number;
	stop_sequences?: string[];
	system?: string | AnthropicSystemBlock[];
	tools?: AnthropicToolDef[];
	tool_choice?: unknown;
	metadata?: Record<string, unknown>;
}

interface AnthropicResponse {
	id: string;
	type: "message";
	role: "assistant";
	content: AnthropicContentBlock[];
	model: string;
	stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
	stop_sequence: string | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

/** Generate a unique tool_use ID. @internal Exported for testing. */
export function generateToolUseId(): string {
	return `toolu_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
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
	top_k?: number;
	stream?: boolean;
	stop?: string | string[];
	tools?: AnthropicToolDef[];
	tool_choice?: unknown;
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
	const messages: Array<{ role: string; content: string | Array<Record<string, unknown>>; tool_calls?: unknown[]; tool_call_id?: string }> = anthReq.messages.map((m) => {
		// Tool-role messages (OpenAI format after tool_use was executed)
		if (m.role === "tool") {
			const msg = m as any;
			return {
				role: "tool",
				content: typeof m.content === "string" ? m.content : "",
				tool_call_id: msg.tool_use_id ?? "",
			};
		}

		if (typeof m.content === "string") {
			return { role: m.role, content: m.content };
		}

		// Content is an array of blocks — may contain text, tool_use, tool_result
		const textBlocks: string[] = [];
		const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
		let isToolResult = false;
		let toolResultContent = "";
		let toolResultId = "";

		for (const block of m.content) {
			if (block.type === "text") {
				textBlocks.push((block as any).text);
			} else if (block.type === "tool_use") {
				toolCalls.push({
					id: (block as any).id,
					type: "function",
					function: {
						name: (block as any).name,
						arguments: JSON.stringify((block as any).input ?? {}),
					},
				});
			} else if (block.type === "tool_result") {
				isToolResult = true;
				toolResultContent = typeof (block as any).content === "string"
					? (block as any).content
					: JSON.stringify((block as any).content);
				toolResultId = (block as any).tool_use_id ?? "";
			}
		}

		// tool_result blocks come in user-role messages (Anthropic convention)
		if (isToolResult) {
			return { role: "tool", content: toolResultContent, tool_call_id: toolResultId };
		}

		const msg: any = { role: m.role };
		const hasCacheControl = m.content.some((c) => (c as any).cache_control);

		if (toolCalls.length > 0) {
			// Assistant with tool calls: content is text, tool_calls separate
			msg.content = textBlocks.join("");
			msg.tool_calls = toolCalls;
		} else if (hasCacheControl) {
			msg.content = m.content.map((c) => {
				const part: Record<string, unknown> = { type: "text", text: (c as any).text };
				if ((c as any).cache_control) {
					part.cache_control = (c as any).cache_control;
				}
				return part;
			});
		} else {
			// No cache_control — flatten to plain text for simpler backend processing
			msg.content = textBlocks.join("");
		}

		return msg;
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

	if (anthReq.tools?.length) {
		base.tools = anthReq.tools;
	}
	if (anthReq.tool_choice !== undefined) {
		base.tool_choice = anthReq.tool_choice;
	}

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
		const adaptedReq: any = {
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
		};
		if (anthReq.tools?.length) adaptedReq.tools = anthReq.tools;
		if (anthReq.tool_choice !== undefined) adaptedReq.tool_choice = anthReq.tool_choice;
		return {
			body: config.adaptRequest(adaptedReq),
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
 * Convert a backend JSON response body into Anthropic Messages format,
 * including DSML tool call detection.
 *
 * If the backend text response contains DSML markup (`<tool_calls>`), it is
 * parsed and converted into Anthropic tool_use content blocks. The text
 * portion before the DSML remains as a text block. Extracts token usage
 * and cache metrics from the backend response.
 */
export function backendToAnthropicResponse(
	raw: any,
	model: string,
): AnthropicResponse {
	const text =
		raw.choices?.[0]?.message?.content ?? raw.content ?? raw.text ?? "";

	const content: AnthropicContentBlock[] = [];

	// Check for DSML in the text
	const parsedDSML = text ? parseDSML(text) : null;

	if (parsedDSML && parsedDSML.toolCalls.length > 0) {
		// Add text before DSML if non-empty
		if (parsedDSML.textBefore) {
			content.push({ type: "text", text: parsedDSML.textBefore });
		}

		// Add a tool_use block for each parsed tool call
		for (const tc of parsedDSML.toolCalls) {
			content.push({
				type: "tool_use",
				id: generateToolUseId(),
				name: tc.name,
				input: tc.args,
			});
		}

		// Add text after DSML if non-empty
		if (parsedDSML.textAfter) {
			content.push({ type: "text", text: parsedDSML.textAfter });
		}
	} else {
		// No DSML — plain text response
		content.push({ type: "text", text });
	}

	return {
		id: raw.id ?? `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content,
		model,
		stop_reason: parsedDSML
			? "tool_use"
			: (raw.choices?.[0]?.finish_reason === "stop" ? "end_turn" : null),
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
				continue;
			}
			// Handle OpenAI-format SSE with reasoning_content
			const delta = parsed.choices?.[0]?.delta;
			if (delta?.reasoning_content) {
				accumulated += `<thinking>${delta.reasoning_content}</thinking>`;
			} else if (delta?.content) {
				accumulated += delta.content;
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
 *
 * Also handles reasoning_content (e.g., DeepSeek model output) by wrapping
 * it in <thinking> tags so it is preserved in the Anthropic stream output.
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

	const delta = parsed.choices?.[0]?.delta;
	const reasoningDelta = delta?.reasoning_content;
	const contentDelta = delta?.content;
	const textFallback = parsed.choices?.[0]?.text;

	// When the delta has reasoning_content but no content, wrap in <thinking> tags
	if (reasoningDelta && !contentDelta) {
		return `<thinking>${reasoningDelta}</thinking>`;
	}
	// When both exist, prepend thinking and follow with text content
	if (reasoningDelta && contentDelta) {
		return `<thinking>${reasoningDelta}</thinking>${contentDelta}`;
	}
	if (contentDelta) return contentDelta;
	if (textFallback) return textFallback;

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

// --- Stream state machine helpers ---------------------------------------------

/**
 * Emit message_start and content_block_start events.
 */
function emitInitEvents(
	controller: ReadableStreamDefaultController,
	encoder: TextEncoder,
	model: string,
	messageId: string,
	usage: AnthropicResponse["usage"],
): void {
	controller.enqueue(encoder.encode(
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: messageId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage },
		})}\n\n`,
	));
	controller.enqueue(encoder.encode(
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	));
}

/**
 * Emit content_block_stop + message_delta + message_stop and close.
 * Estimates output tokens from char count as fallback.
 */
function emitDoneEvents(
	controller: ReadableStreamDefaultController,
	encoder: TextEncoder,
	usage: AnthropicResponse["usage"],
	outputCounter: OutputCounter,
	dsmlText?: string | null,
): void {
	if (usage.output_tokens === 0 && outputCounter.chars > 0) {
		usage.output_tokens = Math.max(1, Math.round(outputCounter.chars / 4));
	}

	// Check DSML buffer for tool calls
	const dsmlResult = dsmlText ? parseDSML(dsmlText) : null;
	const hasToolUse = dsmlResult !== null && dsmlResult.toolCalls.length > 0;

	// Close the current text content block
	controller.enqueue(encoder.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));

	// Emit tool_use blocks if DSML was found
	if (hasToolUse) {
		let blockIndex = 1;
		for (const tc of dsmlResult!.toolCalls) {
			const id = generateToolUseId();
			// content_block_start for tool_use
			controller.enqueue(encoder.encode(
				`event: content_block_start\ndata: ${JSON.stringify({
					type: "content_block_start",
					index: blockIndex,
					content_block: { type: "tool_use", id, name: tc.name, input: tc.args },
				})}\n\n`,
			));
			// content_block_stop (full input available, no incremental delta needed)
			controller.enqueue(encoder.encode(
				`event: content_block_stop\ndata: ${JSON.stringify({
					type: "content_block_stop",
					index: blockIndex,
				})}\n\n`,
			));
			blockIndex++;
		}
	}

	controller.enqueue(encoder.encode(
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: usage.output_tokens },
		})}\n\n`,
	));
	controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
	controller.close();
}

/**
 * Emit error event and close — dev mode includes the error detail.
 */
function emitErrorEvent(
	controller: ReadableStreamDefaultController,
	encoder: TextEncoder,
	err: unknown,
): void {
	if (isDevMode()) {
		controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`));
	} else {
		controller.enqueue(encoder.encode('event: error\ndata: {"error":"Stream error"}\n\n'));
	}
	controller.close();
}

/**
 * Process one chunk from the upstream reader through the SSE line buffer
 * and emit adapted Anthropic SSE events for each complete line.
 * When a DSML buffer is provided, text that looks like DSML is held back
 * instead of being emitted as text deltas.
 * Returns true if the stream is done (reader returned done=true).
 */
async function processStreamChunk(
	reader: ReadableStreamDefaultReader,
	lineBuffer: SSELineBuffer,
	decoder: TextDecoder,
	controller: ReadableStreamDefaultController,
	encoder: TextEncoder,
	model: string,
	config: BackendConfig,
	usage: AnthropicResponse["usage"],
	outputCounter: OutputCounter,
	dsmlBuffer?: DSMLStreamBuffer | null,
): Promise<boolean> {
	const { done, value } = await reader.read();
	if (done) {
		// Flush remaining buffered data
		const remaining = lineBuffer.flush();
		if (remaining.length > 0) {
			const adapted = backendLineToAnthropicSSE(remaining, model, config, usage, outputCounter);
			if (adapted) {
				const text = extractTextFromSSEEvent(adapted);
				if (dsmlBuffer && text) {
					dsmlBuffer.push(text);
				} else if (adapted) {
					controller.enqueue(encoder.encode(adapted + "\n\n"));
				}
			}
		}
		return true;
	}

	const chunk = decoder.decode(value, { stream: true });
	const lines = lineBuffer.add(chunk);

	for (const line of lines) {
		const adapted = backendLineToAnthropicSSE(line, model, config, usage, outputCounter);
		if (adapted) {
			const text = extractTextFromSSEEvent(adapted);
			if (dsmlBuffer && text && (dsmlBuffer.isActive || looksLikeDSML(text))) {
				dsmlBuffer.push(text);
			} else {
				controller.enqueue(encoder.encode(adapted + "\n\n"));
			}
		}
	}
	return false;
}

/** Buffer for accumulating DSML content during streaming. */
interface DSMLStreamBuffer {
	text: string;
	isActive: boolean;
	push(chunk: string): void;
	flush(): string | null;
}

function createDSMLStreamBuffer(): DSMLStreamBuffer {
	let buffer = "";
	let active = false;

	return {
		get text() { return buffer; },
		get isActive() { return active; },

		push(chunk: string) {
			if (!active && looksLikeDSML(chunk)) {
				active = true;
			}
			buffer += chunk;
		},

		flush() {
			if (!buffer) return null;
			const text = buffer;
			buffer = "";
			active = false;
			return isCompleteDSML(text) ? text : null;
		},
	};
}

/** Extract plain text from a formatted content_block_delta SSE event. */
function extractTextFromSSEEvent(event: string): string | null {
	if (!event.startsWith("event: content_block_delta")) return null;
	const dataMatch = event.match(/data:\s*(\{.*\})/);
	if (!dataMatch) return null;
	try {
		const parsed = JSON.parse(dataMatch[1]);
		return parsed.delta?.text ?? null;
	} catch {
		return null;
	}
}

// --- Stream transformer --------------------------------------------------------

function transformAnthropicStream(
	body: ReadableStream,
	model: string,
	config: BackendConfig,
): ReadableStream {
	const reader = trackReader(body.getReader() as any as ReadableStreamDefaultReader);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const lineBuffer = new SSELineBuffer();

	let phase: "init" | "block" | "done" = "init";
	const outputCounter: OutputCounter = { chars: 0 };
	const usage: AnthropicResponse["usage"] = { input_tokens: 0, output_tokens: 0 };
	const dsmlBuffer = isDSMLDetectionEnabled() ? createDSMLStreamBuffer() : null;

	let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	const KEEPALIVE_INTERVAL_MS = 15_000;

	function startKeepalive(controller: ReadableStreamDefaultController) {
		if (keepaliveTimer) return;
		keepaliveTimer = setInterval(() => {
			try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { stopKeepalive(); }
		}, KEEPALIVE_INTERVAL_MS);
	}

	function stopKeepalive() {
		if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
	}

	return new ReadableStream({
		async pull(controller) {
			try {
				startKeepalive(controller);

				if (phase === "init") {
					phase = "block";
					emitInitEvents(controller, encoder, model, `msg_${Date.now()}`, usage);
				}

				const BATCH_SIZE = 8;
				let chunksProcessed = 0;

				while (phase === "block" && chunksProcessed < BATCH_SIZE) {
					const isDone = await processStreamChunk(reader, lineBuffer, decoder, controller, encoder, model, config, usage, outputCounter, dsmlBuffer);
					if (isDone) {
						stopKeepalive();
						releaseReader(reader);
						phase = "done";
						break;
					}
					chunksProcessed++;
				}

				if (chunksProcessed >= BATCH_SIZE) {
					await new Promise((r) => setTimeout(r, 0));
					return;
				}

				if (phase === "done") {
					const dsmlText = dsmlBuffer?.flush() ?? null;
					emitDoneEvents(controller, encoder, usage, outputCounter, dsmlText);
				}
			} catch (err) {
				stopKeepalive();
				releaseReader(reader);
				emitErrorEvent(controller, encoder, err);
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

/**
 * Handle a backend error response: parse upstream body, release session, return Anthropic error.
 */
async function handleUpstreamError(
	response: Response,
	sessionPool?: SessionProxyPool,
	sessionId?: string,
): Promise<Response> {
	const status = response.status;
	let upstreamMsg = status >= 500 ? "Upstream server error" : "Upstream rejected request";
	try {
		const errBody = await response.text();
		if (errBody) {
			const errJson = JSON.parse(errBody);
			if (errJson?.error?.message) upstreamMsg = errJson.error.message;
			else if (errJson?.type === "error" && errJson?.error?.message) upstreamMsg = errJson.error.message;
			else if (errJson?.message) upstreamMsg = errJson.message;
			else if (typeof errBody === "string" && errBody.length < 500) upstreamMsg = errBody;
		}
	} catch { /* keep default */ }
	if (sessionPool && sessionId) sessionPool.release(sessionId);
	return anthropicError(status, upstreamMsg, "upstream_error");
}

/** Build streaming response headers with CORS and cache forwarding. */
function buildStreamHeaders(response: Response): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
		Connection: "keep-alive", "Access-Control-Allow-Origin": "*", "X-Accel-Buffering": "no",
	};
	forwardCacheHeaders(response, h);
	return h;
}

/** Build JSON response headers with CORS and cache forwarding. */
function buildJsonHeaders(response: Response): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
	};
	forwardCacheHeaders(response, h);
	return h;
}

/**
 * Handle a non-streaming backend response that came back in SSE format
 * (it happens when the backend only supports SSE but we asked for non-stream).
 * Accumulates the text deltas into a single Anthropic response.
 */
function handleBackendSSEExtract(
	text: string,
	model: string,
): AnthropicResponse | null {
	if (!text.trimStart().startsWith("data: ")) return null;
	const accumulated = accumulateSSEText(text);
	if (!accumulated) return null;
	return {
		id: `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: accumulated }],
		model,
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 0, output_tokens: 0 },
	};
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
	const version = anthropicVersion || "2023-06-01";

	// -- Cache check (non-streaming only) ------------------------------------
	const cache = getResponseCache();
	const cacheKey = !wantsStream && cache
		? ResponseCache.buildKey(req.model, req.messages, wantsStream)
		: null;
	if (cacheKey && cache) {
		const cached = cache.get(cacheKey);
		if (cached) {
			if (isDevMode()) {
				console.log(`[anthropic-proxy] cache HIT for model=${req.model} key=${cacheKey.slice(0, 12)}`);
			}
			return new Response(cached.body, {
				status: cached.status,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...cached.headers },
			});
		}
	}

	// Translate Anthropic -> backend
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
			? await fetchWithSessionRetry(url, init, sessionPool, sessionId, `anthropic:${req.model}`, undefined)
			: await fetchWithRetry(url, init, proxyPool, `anthropic:${req.model}`);

	if (result.errorClassification) {
		if (sessionPool && sessionId) sessionPool.release(sessionId);
		return new Response(
			JSON.stringify({
				type: "error",
				error: { message: result.errorClassification.message, type: "server_error" },
			}),
			{
				status: result.errorClassification.status,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			},
		);
	}

	const response = result.response!;

	// -- Handle error responses from backend ------------------------------------
	if (!response.ok) {
		return handleUpstreamError(response, sessionPool, sessionId);
	}

	// -- For native Anthropic passthrough, relay the raw backend response -------
	if (config.anthropicPassthrough) {
		if (wantsStream) {
			return new Response(wrapAnthropicStreamMaybe(response.body!, sessionPool, sessionId), {
				status: 200,
				headers: buildStreamHeaders(response),
			});
		}
		const rawBody = await response.text();
		if (sessionPool && sessionId) sessionPool.release(sessionId);
		return new Response(rawBody, { status: 200, headers: buildJsonHeaders(response) });
	}

	// -- Handle streaming (OpenAI-compatible backend) ---------------------------
	if (wantsStream) {
		let transformed = transformAnthropicStream(response.body!, req.model, config);
		transformed = wrapAnthropicStreamMaybe(transformed, sessionPool, sessionId);
		return new Response(transformed, { status: 200, headers: buildStreamHeaders(response) });
	}

	// -- Handle non-streaming (OpenAI-compatible backend) -----------------------
	const text = await response.text();
	if (sessionPool && sessionId) sessionPool.release(sessionId);

	// Backend returned SSE even though we didn't ask for stream
	const sseAdapted = handleBackendSSEExtract(text, req.model);
	if (sseAdapted) {
		return new Response(JSON.stringify(sseAdapted), {
			status: 200,
			headers: buildJsonHeaders(response),
		});
	}

	// Parse JSON and adapt
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { content: text };
	}

	// Apply backend adaptResponse if available (handles double-nested responses
	// from providers like opencode.ai that wrap the real response as a JSON
	// string inside choices[0].message.content).
	if (config.adaptResponse && typeof parsed === "object" && parsed !== null) {
		parsed = config.adaptResponse(parsed, req as any) ?? parsed;
	}

	const adapted = backendToAnthropicResponse(parsed, req.model);

	// -- Store in cache --------------------------------------------------------
	if (cacheKey && cache) {
		const responseBody = JSON.stringify(adapted);
		cache.set(cacheKey, responseBody, 200, {});
		if (isDevMode()) {
			console.log(`[anthropic-proxy] cache MISS for model=${req.model} key=${cacheKey.slice(0, 12)} — stored`);
		}
	}

	return new Response(JSON.stringify(adapted), {
		status: 200,
		headers: buildJsonHeaders(response),
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

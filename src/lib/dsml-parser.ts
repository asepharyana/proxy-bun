/**
 * DSML (DeepSeek Markup Language) parser.
 *
 * DeepSeek models return tool calls embedded in text content using
 * DSML markup instead of structured JSON fields. This module detects
 * and parses that markup into a format the proxy can convert into
 * standard tool_use (Anthropic) / tool_calls (OpenAI) blocks.
 *
 * DSML format (DeepSeek output):
 * ```
 * <tool_calls>
 * <invoke name="tool_name">
 * <parameter name="param1">value1</parameter>
 * <parameter name="param2">value2</parameter>
 * ...
 * </invoke>
 * </tool_calls>
 * ```
 *
 * The markup can appear:
 *   - As the entire response content
 *   - After thinking/reasoning text (e.g. `<thinking>...</thinking><tool_calls>...`)
 *   - Mixed with regular text
 *   - Spanning multiple SSE chunks during streaming
 */

// --- Types -------------------------------------------------------------------

export interface ParsedDSML {
	/** Text that appeared before the first DSML tag (may include thinking). */
	textBefore: string;
	/** Parsed tool call definitions. */
	toolCalls: ToolCallDef[];
	/** Text that appeared after the last DSML tag. */
	textAfter: string;
}

export interface ToolCallDef {
	/** The tool/function name, e.g. "Bash", "Read", "Edit". */
	name: string;
	/** The parsed JSON arguments object. */
	args: Record<string, unknown>;
	/**
	 * Raw argument map (string->string before JSON parse).
	 * Only populated when `args` could not be fully parsed.
	 */
	rawArgs?: Record<string, string>;
}

// --- Constants ---------------------------------------------------------------

/** Maximum bytes to buffer when detecting DSML in a stream before giving up. */
export const MAX_DSML_BUFFER = 50_000;

// --- Regex patterns ----------------------------------------------------------

// Match opening <tool_calls> (case-insensitive, with optional whitespace)
const TOOL_CALLS_OPEN_RE = /<tool_calls>\s*/i;
// Match closing </tool_calls> (case-insensitive)
const TOOL_CALLS_CLOSE_RE = /<\/tool_calls>/i;
// Match <invoke name="..."> with optional whitespace
const INVOKE_OPEN_RE = /<invoke\s+name\s*=\s*"([^"]*)"\s*>/i;
// Match </invoke> (case-insensitive)
const INVOKE_CLOSE_RE = /<\/invoke>/i;
// Match <parameter name="...">value</parameter>
const PARAM_RE = /<parameter\s+name\s*=\s*"([^"]*)"\s*>\s*([\s\S]*?)\s*<\/parameter>/gi;
// Match CDATA sections
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

// --- Parser ------------------------------------------------------------------

/**
 * Try to parse DSML markup from a text string.
 * Returns null if no DSML markup is detected.
 */
export function parseDSML(text: string): ParsedDSML | null {
	if (!text || typeof text !== "string") return null;

	const openMatch = text.match(TOOL_CALLS_OPEN_RE);
	if (!openMatch) return null;

	const closeMatch = text.match(TOOL_CALLS_CLOSE_RE);
	if (!closeMatch) return null;

	// Extract text before the first <tool_calls> tag
	const textBefore = text.slice(0, openMatch.index!);

	// Extract the content between <tool_calls> and </tool_calls>
	const toolCallsStart = openMatch.index! + openMatch[0].length;
	const toolCallsEnd = closeMatch.index!;
	const toolCallsBody = text.slice(toolCallsStart, toolCallsEnd);

	// Text after the closing </tool_calls>
	const textAfter = text.slice(toolCallsEnd + closeMatch[0].length);

	// Parse individual <invoke> blocks from the tool calls body
	const toolCalls = parseInvokeBlocks(toolCallsBody);

	if (toolCalls.length === 0) return null;

	return { textBefore, toolCalls, textAfter };
}

/**
 * Extract tool calls from text by parsing DSML, then strip the DSML markup
 * leaving only non-DSML content.
 */
export function stripDSML(text: string): string {
	if (!text) return text;
	return text
		.replace(TOOL_CALLS_OPEN_RE, "")
		.replace(TOOL_CALLS_CLOSE_RE, "")
		.replace(INVOKE_OPEN_RE, "")
		.replace(INVOKE_CLOSE_RE, "")
		.replace(PARAM_RE, "")
		.replace(CDATA_RE, "$1")
		.trim();
}

/**
 * Check if a text string appears to be starting DSML markup.
 * Useful for stream buffering decisions.
 */
export function looksLikeDSML(text: string): boolean {
	if (!text) return false;
	const trimmed = text.trim();
	return (
		trimmed.startsWith("<tool_calls") ||
		trimmed.startsWith("<invoke") ||
		trimmed.startsWith("</invoke") ||
		trimmed.startsWith("</tool_calls") ||
		trimmed.startsWith("<parameter")
	);
}

/**
 * Check if text completes a DSML block (has both open and close tags).
 * Returns true only if the full <tool_calls>...</tool_calls> structure is present.
 */
export function isCompleteDSML(text: string): boolean {
	return TOOL_CALLS_OPEN_RE.test(text) && TOOL_CALLS_CLOSE_RE.test(text);
}

/**
 * Stream-ready DSML detection: buffered accumulator.
 * Accumulate chunks until DSML is complete or buffer max is reached.
 * Returns { result: ParsedDSML | null, consumed: number } where consumed
 * is how many bytes of the buffer were consumed by the DSML block.
 */
export interface DSMLAccumulator {
	buffer: string;
	flush(): ParsedDSML | null;
	add(chunk: string): { result: ParsedDSML | null; consumed: number };
}

export function createDSMLAccumulator(): DSMLAccumulator {
	let buffer = "";

	return {
		get buffer() {
			return buffer;
		},

		add(chunk: string) {
			buffer += chunk;

			// If buffer exceeds max without completing DSML, flush as non-DSML
			if (buffer.length > MAX_DSML_BUFFER) {
				const saved = buffer;
				buffer = "";
				return { result: null, consumed: saved.length };
			}

			// Only try to parse if we have a complete DSML block
			if (isCompleteDSML(buffer)) {
				const result = parseDSML(buffer);
				if (result) {
					// Calculate consumed bytes: up to the end of </tool_calls>
					const closeMatch = buffer.match(TOOL_CALLS_CLOSE_RE);
					const consumed = closeMatch
						? closeMatch.index! + closeMatch[0].length
						: buffer.length;
					buffer = buffer.slice(consumed);
					return { result, consumed };
				}
			}

			// Not yet complete or not DSML
			return { result: null, consumed: 0 };
		},

		flush() {
			if (!buffer) return null;
			const result = isCompleteDSML(buffer) ? parseDSML(buffer) : null;
			buffer = "";
			return result;
		},
	};
}

// --- Internal helpers --------------------------------------------------------

/**
 * Parse <invoke> blocks from the body of a <tool_calls> section.
 * Returns a list of tool call definitions.
 */
function parseInvokeBlocks(body: string): ToolCallDef[] {
	const results: ToolCallDef[] = [];
	let remaining = body;

	// First, unwrap any CDATA sections
	remaining = remaining.replace(CDATA_RE, (_, content) => content);

	while (remaining.length > 0) {
		const invokeMatch = remaining.match(INVOKE_OPEN_RE);
		if (!invokeMatch) break;

		const name = invokeMatch[1];
		const invokeStart = invokeMatch.index! + invokeMatch[0].length;
		const closeMatch = remaining.slice(invokeStart).match(INVOKE_CLOSE_RE);

		if (!closeMatch) break; // malformed — no closing </invoke>

		const paramsBody = remaining.slice(invokeStart, invokeStart + closeMatch.index!);

		// Parse parameters
		const args = parseParameters(paramsBody);

		results.push({ name, args });

		// Advance past this invoke block
		remaining = remaining.slice(invokeStart + closeMatch.index! + closeMatch[0].length);
	}

	return results;
}

/**
 * Parse <parameter name="...">value</parameter> blocks into key-value pairs.
 * Values are attempted as JSON parse, falling back to string.
 */
function parseParameters(body: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let match: RegExpExecArray | null;

	// Reset regex state
	PARAM_RE.lastIndex = 0;

	while ((match = PARAM_RE.exec(body)) !== null) {
		const key = match[1];
		let value: unknown = match[2].trim();

		// Try to parse the value as JSON
		if (value !== "") {
			try {
				value = JSON.parse(value as string);
			} catch {
				// Keep as string — not JSON
			}
		}

		args[key] = value;
	}

	return args;
}

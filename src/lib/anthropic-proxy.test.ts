import { test, expect, describe } from "bun:test";
import { anthropicToBackend, backendToAnthropicResponse, generateToolUseId } from "./anthropic-proxy";
import type { BackendConfig } from "./ai-proxy";

const passthroughConfig: BackendConfig = {
	provider: "opencode",
	url: "https://opencode.ai/zen/v1/chat/completions",
	headers: { "Content-Type": "application/json" },
};

const customConfig: BackendConfig = {
	provider: "opencode",
	url: "https://opencode.ai/zen/v1/chat/completions",
	headers: { "Content-Type": "application/json" },
	anthropicPassthrough: true,
};

const nativeConfig: BackendConfig = {
	provider: "opencode",
	url: "https://opencode.ai/zen/v1/messages",
	headers: { "Content-Type": "application/json" },
	anthropicPassthrough: true,
};

describe("anthropicToBackend", () => {
	test("should flatten content blocks without cache_control to plain string", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Hello " },
							{ type: "text", text: "world" },
						],
					},
				],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.messages[0].content).toBe("Hello world");
	});

	test("should preserve content blocks with cache_control as structured array", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Large context...", cache_control: { type: "ephemeral" } },
							{ type: "text", text: "Follow up question" },
						],
					},
				],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(Array.isArray(body.messages[0].content)).toBe(true);
		expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
		expect(body.messages[0].content[0].text).toBe("Large context...");
		expect(body.messages[0].content[1].text).toBe("Follow up question");
	});

	test("should not add cache_control to blocks that don't have it", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Hello" },
							{ type: "text", text: "world", cache_control: { type: "ephemeral" } },
						],
					},
				],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(Array.isArray(body.messages[0].content)).toBe(true);
		expect(body.messages[0].content[0].cache_control).toBeUndefined();
		expect(body.messages[0].content[1].cache_control).toEqual({ type: "ephemeral" });
	});

	test("should flatten system prompt as string when no cache_control", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				system: [
					{ type: "text", text: "You are helpful." },
					{ type: "text", text: "Be concise." },
				],
				messages: [{ role: "user", content: "Hi" }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[0].content).toBe("You are helpful.Be concise.");
	});

	test("should preserve system prompt cache_control as structured array", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				system: [
					{ type: "text", text: "Long system instruction...", cache_control: { type: "ephemeral" } },
				],
				messages: [{ role: "user", content: "Hi" }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.messages[0].role).toBe("system");
		expect(Array.isArray(body.messages[0].content)).toBe(true);
		expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
	});

	test("should forward anthropic-version header when provided", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
			"2023-06-01",
		);
		expect(result.headers?.["anthropic-version"]).toBe("2023-06-01");
	});

	test("should not add anthropic-version header when not provided", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		expect(result.headers?.["anthropic-version"]).toBeUndefined();
	});

	test("should pass through full Anthropic request when anthropicPassthrough is true", () => {
		const result = anthropicToBackend(
			{
				model: "claude-sonnet-4-20250514",
				max_tokens: 100,
				system: [{ type: "text", text: "Be helpful.", cache_control: { type: "ephemeral" } }],
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
						],
					},
				],
				stream: true,
			},
			nativeConfig,
			"claude-sonnet-4-20250514",
			"2023-06-01",
		);
		const body = result.body as any;
		expect(body.model).toBe("claude-sonnet-4-20250514");
		expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
		expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(body.stream).toBe(true);
		expect(result.headers?.["anthropic-version"]).toBe("2023-06-01");
	});

	test("should handle string content (not array) in messages", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [{ role: "user", content: "Plain text message" }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.messages[0].content).toBe("Plain text message");
	});

	test("should handle string system prompt", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				system: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Hi" }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[0].content).toBe("You are a helpful assistant.");
	});

	test("should forward tools in request body", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hi" }],
				tools: [{ name: "test_tool", input_schema: { type: "object" } }],
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.tools).toBeDefined();
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].name).toBe("test_tool");
	});

	test("should forward tool_choice in request body", () => {
		const result = anthropicToBackend(
			{
				model: "deepseek-v4-flash-free",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hi" }],
				tool_choice: { type: "tool", name: "test_tool" },
			},
			passthroughConfig,
			"deepseek-v4-flash-free",
		);
		const body = result.body as any;
		expect(body.tool_choice).toBeDefined();
		expect(body.tool_choice.type).toBe("tool");
	});
});

describe("backendToAnthropicResponse", () => {
	test("should convert plain text to text content block", () => {
		const raw = {
			id: "test_1",
			choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 20 },
		};
		const result = backendToAnthropicResponse(raw, "deepseek-v4-flash-free");
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toBe("Hello world");
		expect(result.stop_reason).toBe("end_turn");
	});

	test("should convert DSML to tool_use content blocks", () => {
		const raw = {
			id: "test_2",
			choices: [{
				message: { content: `<tool_calls>
<invoke name="Bash">
<parameter name="command">ls -la</parameter>
</invoke>
</tool_calls>` },
				finish_reason: "stop",
			}],
			usage: { prompt_tokens: 10, completion_tokens: 20 },
		};
		const result = backendToAnthropicResponse(raw, "deepseek-v4-flash-free");
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("tool_use");
		const toolUse = result.content[0] as any;
		expect(toolUse.name).toBe("Bash");
		expect(toolUse.input.command).toBe("ls -la");
		expect(toolUse.id).toBeTruthy();
		expect(result.stop_reason).toBe("tool_use");
	});

	test("should convert text before DSML as separate text block", () => {
		const raw = {
			id: "test_3",
			choices: [{
				message: { content: "Let me check.\n<tool_calls>\n<invoke name=\"Read\">\n<parameter name=\"path\">/tmp/test</parameter>\n</invoke>\n</tool_calls>" },
				finish_reason: "stop",
			}],
			usage: { prompt_tokens: 5, completion_tokens: 15 },
		};
		const result = backendToAnthropicResponse(raw, "deepseek-v4-flash-free");
		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("text");
		expect(((result.content[0] as any).text).trim()).toBe("Let me check.");
		expect(result.content[1].type).toBe("tool_use");
		expect((result.content[1] as any).name).toBe("Read");
	});

	test("should handle multiple tool calls in DSML", () => {
		const raw = {
			id: "test_4",
			choices: [{
				message: { content: `<tool_calls>
<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">test.txt</parameter>
</invoke>
</tool_calls>` },
				finish_reason: "stop",
			}],
			usage: { prompt_tokens: 5, completion_tokens: 15 },
		};
		const result = backendToAnthropicResponse(raw, "deepseek-v4-flash-free");
		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("tool_use");
		expect((result.content[0] as any).name).toBe("Bash");
		expect(result.content[1].type).toBe("tool_use");
		expect((result.content[1] as any).name).toBe("Read");
	});

	test("should return plain text when no DSML in response", () => {
		const raw = {
			id: "test_5",
			choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 10 },
		};
		const result = backendToAnthropicResponse(raw, "deepseek-v4-flash-free");
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect(result.stop_reason).toBe("end_turn");
	});
});

describe("generateToolUseId", () => {
	test("should generate unique IDs with toolu_ prefix", () => {
		const id1 = generateToolUseId();
		const id2 = generateToolUseId();
		expect(id1).toMatch(/^toolu_/);
		expect(id2).toMatch(/^toolu_/);
		expect(id1).not.toBe(id2);
	});
});

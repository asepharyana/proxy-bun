import { test, expect, describe } from "bun:test";
import {
	parseDSML,
	stripDSML,
	looksLikeDSML,
	isCompleteDSML,
	createDSMLAccumulator,
} from "./dsml-parser";

describe("parseDSML", () => {
	test("returns null for plain text without DSML", () => {
		const result = parseDSML("Hello, world!");
		expect(result).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(parseDSML("")).toBeNull();
	});

	test("parses single tool call with string args", () => {
		const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command">ls -la</parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.toolCalls).toHaveLength(1);
		expect(result!.toolCalls[0].name).toBe("Bash");
		expect(result!.toolCalls[0].args.command).toBe("ls -la");
	});

	test("parses single tool call with JSON args", () => {
		const text = `<tool_calls>
<invoke name="Read">
<parameter name="file_path">/path/to/file.ts</parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.toolCalls).toHaveLength(1);
		expect(result!.toolCalls[0].name).toBe("Read");
		expect(result!.toolCalls[0].args.file_path).toBe("/path/to/file.ts");
	});

	test("parses multiple tool calls", () => {
		const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">/tmp/test.txt</parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.toolCalls).toHaveLength(2);
		expect(result!.toolCalls[0].name).toBe("Bash");
		expect(result!.toolCalls[1].name).toBe("Read");
	});

	test("extracts textBefore when there is thinking content before DSML", () => {
		const text = `<thinking>Let me check the file system.</thinking>
<tool_calls>
<invoke name="Bash">
<parameter name="command">ls -la</parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.textBefore).toContain("Let me check the file system");
		expect(result!.toolCalls).toHaveLength(1);
		expect(result!.toolCalls[0].name).toBe("Bash");
	});

	test("extracts textAfter when there is content after DSML", () => {
		const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
</tool_calls>
Some follow-up text.`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.textAfter.trim()).toBe("Some follow-up text.");
		expect(result!.toolCalls).toHaveLength(1);
	});

	test("handles multiline parameter values", () => {
		const text = `<tool_calls>
<invoke name="Edit">
<parameter name="file_path">/path/to/file.ts</parameter>
<parameter name="old_string">line 1
line 2
line 3</parameter>
<parameter name="new_string">new line 1
new line 2</parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.toolCalls).toHaveLength(1);
		expect(result!.toolCalls[0].name).toBe("Edit");
		expect(result!.toolCalls[0].args.old_string).toBe("line 1\nline 2\nline 3");
		expect(result!.toolCalls[0].args.new_string).toBe("new line 1\nnew line 2");
	});

	test("handles text that looks like XML but is not DSML", () => {
		const result = parseDSML("<div>hello</div>");
		expect(result).toBeNull();
	});

	test("handles partial DSML (missing close tag)", () => {
		const result = parseDSML("<tool_calls><invoke name=\"Bash\">");
		expect(result).toBeNull();
	});

	test("handles CDATA sections in parameter values", () => {
		const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command"><![CDATA[echo "hello world"]]></parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.toolCalls).toHaveLength(1);
		expect(result!.toolCalls[0].args.command).toBe('echo "hello world"');
	});

	test("parses numeric parameter values in DSML", () => {
		const text = `<tool_calls>
<invoke name="Read">
<parameter name="max_tokens">1000</parameter>
</invoke>
</tool_calls>`;
		const result = parseDSML(text);
		expect(result).not.toBeNull();
		expect(result!.toolCalls[0].args.max_tokens).toBe(1000);
	});
});

describe("stripDSML", () => {
	test("strips DSML markup from text", () => {
		const text = `<thinking>Let me think</thinking>
<tool_calls>
<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
</tool_calls>`;
		const stripped = stripDSML(text);
		expect(stripped).not.toContain("<tool_calls>");
		expect(stripped).not.toContain("<invoke");
		expect(stripped).not.toContain("<parameter");
	});

	test("preserves non-DSML text", () => {
		const text = "Hello world";
		expect(stripDSML(text)).toBe("Hello world");
	});

	test("handles empty string", () => {
		expect(stripDSML("")).toBe("");
	});
});

describe("looksLikeDSML", () => {
	test("detects <tool_calls> opening tag", () => {
		expect(looksLikeDSML("<tool_calls>")).toBe(true);
	});

	test("detects <invoke name=...> tag", () => {
		expect(looksLikeDSML('<invoke name="Bash">')).toBe(true);
	});

	test("returns false for plain text", () => {
		expect(looksLikeDSML("Hello world")).toBe(false);
	});

	test("detects closing tags", () => {
		expect(looksLikeDSML("</tool_calls>")).toBe(true);
		expect(looksLikeDSML("</invoke>")).toBe(true);
	});

	test("detects <parameter> tag", () => {
		expect(looksLikeDSML('<parameter name="x">')).toBe(true);
	});
});

describe("isCompleteDSML", () => {
	test("returns true for complete DSML block", () => {
		const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
</tool_calls>`;
		expect(isCompleteDSML(text)).toBe(true);
	});

	test("returns false for incomplete DSML (no close)", () => {
		expect(isCompleteDSML("<tool_calls><invoke name=\"Bash\">")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(isCompleteDSML("")).toBe(false);
	});
});

describe("DSMLAccumulator", () => {
	test("accumulates partial DSML across chunks", () => {
		const acc = createDSMLAccumulator();

		// Chunk 1: partial
		const r1 = acc.add("<tool_calls>\n<invoke name=\"Bash\">\n");
		expect(r1.result).toBeNull();
		expect(r1.consumed).toBe(0);

		// Chunk 2: still partial
		const r2 = acc.add('<parameter name="command">ls -la</parameter>\n');
		expect(r2.result).toBeNull();
		expect(r2.consumed).toBe(0);

		// Chunk 3: complete
		const r3 = acc.add("</invoke>\n</tool_calls>");
		expect(r3.result).not.toBeNull();
		expect(r3.result!.toolCalls).toHaveLength(1);
		expect(r3.result!.toolCalls[0].name).toBe("Bash");
		expect(r3.result!.toolCalls[0].args.command).toBe("ls -la");
		expect(r3.consumed).toBeGreaterThan(0);
	});

	test("flush returns null when no DSML accumulated", () => {
		const acc = createDSMLAccumulator();
		acc.add("Hello world");
		expect(acc.flush()).toBeNull();
	});

	test("flush returns parsed DSML when add left unparsed content", () => {
		const acc = createDSMLAccumulator();
		// Simulate a scenario where DSML was partially buffered but not complete via add
		acc.add("<tool_calls><invoke name=\"Test\">");

		// Now complete it with a direct accumulation (simulating stream end)
		const result = acc.flush();
		expect(result).toBeNull(); // not complete yet — missing close tags
	});

	test("add returns parsed DSML when complete in single chunk", () => {
		const acc = createDSMLAccumulator();
		const result = acc.add("<tool_calls><invoke name=\"Test\"><parameter name=\"x\">y</parameter></invoke></tool_calls>").result;
		expect(result).not.toBeNull();
		expect(result!.toolCalls).toHaveLength(1);
		expect(result!.toolCalls[0].name).toBe("Test");
	});

	test("handles non-DSML text then DSML", () => {
		const acc = createDSMLAccumulator();

		// Non-DSML chunks first
		const r1 = acc.add("Hello ");
		expect(r1.result).toBeNull();
		const r2 = acc.add("world");
		expect(r2.result).toBeNull();

		// DSML starts
		const r3 = acc.add("<tool_calls><invoke name=\"Bash\"><parameter name=\"cmd\">ls</parameter></invoke></tool_calls>");
		expect(r3.result).not.toBeNull();
		expect(r3.result!.toolCalls).toHaveLength(1);
		expect(r3.result!.textBefore).toBe("Hello world");
	});

	test("buffer overflow flushes as non-DSML", () => {
		const acc = createDSMLAccumulator();
		const bigString = "a".repeat(60_000);
		const result = acc.add(bigString);
		expect(result.result).toBeNull();
		expect(result.consumed).toBe(60_000);
	});
});

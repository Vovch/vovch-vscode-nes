import { describe, expect, test } from "bun:test";

import type { CompletionResult } from "~/api/completion-client.ts";
import type {
	EditRegion,
	ModelFormat,
	ModelPrompt,
	PromptLine,
} from "~/api/model-format.ts";
import { computeLineByteOffsets, splitLines } from "~/api/sweep-prompt.ts";
import { buildZeta2Response } from "~/api/zeta2-completion.ts";

function makePrompt(
	fileContents: string,
	windowStartLine: number,
	windowEndLine: number,
	format: ModelFormat,
	extraRegions: EditRegion[] = [],
): ModelPrompt {
	const lines = splitLines(fileContents);
	const lineOffsets = computeLineByteOffsets(lines);
	const promptLines: PromptLine[] = lines.map((content, i) => ({
		startByte: lineOffsets[i] ?? 0,
		content,
	}));
	const primary: EditRegion = {
		startLine: windowStartLine,
		endLine: windowEndLine,
		isPrimary: true,
	};
	const regions: EditRegion[] = [primary, ...extraRegions].sort(
		(a, b) => a.startLine - b.startLine,
	);
	return {
		prompt: "",
		prefill: "",
		format,
		stopTokens: format === "zeta2.1" ? ["<|marker_2|>"] : [">>>>>>> UPDATED"],
		windowStartLine,
		windowEndLine,
		regions,
		lines: promptLines,
		cursorLineByteOffsets: lineOffsets,
	};
}

function completion(text: string): CompletionResult {
	return { text, finishReason: "stop" };
}

describe("buildZeta2Response — protocol 2.1 marker handling", () => {
	test("strips leading <|marker_1|> and trailing <|marker_2|>", () => {
		// File has a typo on the cursor line; the 2.1 model echoes the
		// open marker, emits the corrected region, then closes.
		const fileContents = ["line0", "psdlog::info();", "line2", ""].join("\n");
		const lineCount = splitLines(fileContents).length;
		const prompt = makePrompt(fileContents, 0, lineCount, "zeta2.1");

		const modelOutput =
			"<|marker_1|>\nline0\nspdlog::info();\nline2\n<|marker_2|>";
		const responses = buildZeta2Response(
			completion(modelOutput),
			prompt,
			"id-21",
		);
		expect(responses).not.toBeNull();
		if (!responses) return;
		expect(responses.length).toBe(1);
		const r = responses[0];
		expect(r).toBeDefined();
		if (!r) return;
		// Should isolate the single changed line.
		const cursorLineStart = "line0\n".length;
		expect(r.start_index).toBe(cursorLineStart);
		expect(r.end_index).toBe(cursorLineStart + "psdlog::info();".length);
		expect(r.completion).toBe("spdlog::info();");
	});

	test("close marker without trailing newline still strips", () => {
		const fileContents = ["a", "b", "c", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		const modelOutput = "<|marker_1|>\na\nb edited\nc<|marker_2|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).toBe("b edited");
	});

	test("strips stray internal markers (multi-region / hallucination)", () => {
		// Repro for the screenshot bug: 2.1 model occasionally emits an
		// extra pair of markers mid-output. With a global strip on the
		// single-region path the internal markers are gone too.
		const fileContents = ["line0", "line1", "line2", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		const modelOutput =
			"<|marker_1|>\nline0\n<|marker_2|>\n<|marker_1|>\nline1 edited\nline2\n<|marker_2|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).not.toContain("<|marker_1|>");
		expect(responses[0].completion).not.toContain("<|marker_2|>");
		expect(responses[0].completion).toBe("line1 edited");
	});

	test("2.0 still strips >>>>>>> UPDATED and respects NO_EDITS", () => {
		const fileContents = ["a", "b", "c", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2",
		);
		const modelOutput = "a\nb edited\nc\n>>>>>>> UPDATED";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).toBe("b edited");

		const noOp = buildZeta2Response(completion("NO_EDITS"), prompt, "id");
		expect(noOp).toBeNull();
	});

	test("multi-region 2.1 returns one response per pair, primary first", () => {
		// File with two areas to fix: cursor area on lines 1-3, distant
		// diagnostic area on lines 6-7.
		const fileContents = [
			"line0", // 0
			"psdlog::info();", // 1 (primary region: 0-3)
			"line2", // 2
			"line3", // 3
			"line4", // 4
			"line5", // 5 (gap)
			"int x = 28;", // 6 (secondary region: 6-8)
			"line7", // 7
			"line8", // 8
			"",
		].join("\n");
		const prompt = makePrompt(fileContents, 0, 4, "zeta2.1", [
			{ startLine: 6, endLine: 8, isPrimary: false },
		]);

		// Model emits replacements for both regions in marker order.
		const modelOutput =
			"<|marker_1|>\nline0\nspdlog::info();\nline2\nline3\n<|marker_2|>" +
			"<|marker_3|>\nint x = NAMED_CONSTANT;\nline7\n<|marker_4|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses) return;
		expect(responses.length).toBe(2);

		// Primary region (cursor) emitted first.
		expect(responses[0]?.completion).toBe("spdlog::info();");

		// Secondary region next.
		expect(responses[1]?.completion).toBe("int x = NAMED_CONSTANT;");
		// Distinct ID for the secondary so the editor can route it.
		expect(responses[1]?.autocomplete_id).toBe("id-r2");
	});

	test("multi-region 2.1 accepts an unclosed last pair (truncated)", () => {
		// Repro for the screenshot bug: model emits `<|marker_1|>\n…`
		// with replacement content, but stops on its native EOS instead
		// of `<|marker_2|>`. The strict pair regex would drop this, but
		// a forgiving parser should treat content-to-EOF as the region's
		// replacement.
		const fileContents = ["a", "b", "c", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
			[{ startLine: 100, endLine: 101, isPrimary: false }], // forces multi-region path
		);
		// Note: no `<|marker_2|>` — model didn't close.
		const modelOutput = "<|marker_1|>\na\nb fixed\nc\n";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).toBe("b fixed");
	});

	test("multi-region 2.1 skips regions the model didn't fill", () => {
		const fileContents = [
			"line0",
			"psdlog::info();",
			"line2",
			"line3",
			"line4",
			"line5",
			"int x = 28;",
			"",
		].join("\n");
		const prompt = makePrompt(fileContents, 0, 4, "zeta2.1", [
			{ startLine: 6, endLine: 7, isPrimary: false },
		]);

		// Model only emits a replacement for the primary region.
		const modelOutput =
			"<|marker_1|>\nline0\nspdlog::info();\nline2\nline3\n<|marker_2|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses) return;
		expect(responses.length).toBe(1);
		expect(responses[0]?.completion).toBe("spdlog::info();");
	});
});

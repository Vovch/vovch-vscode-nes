import { describe, expect, test } from "bun:test";

import { classifyEditDisplay } from "~/editor/edit-display-classifier.ts";

describe("classifyEditDisplay", () => {
	test("returns JUMP when edit is far from cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 20,
			editStartLine: 5,
			editEndLine: 6,
			cursorOffset: 500,
			startIndex: 120,
			endIndex: 120,
			completion: "x",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "far-from-cursor",
		});
	});

	test("returns JUMP for multiline edits before cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 9,
			editEndLine: 9,
			cursorOffset: 200,
			startIndex: 120,
			endIndex: 120,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-multiline",
		});
	});

	test("returns JUMP for same-line single-line edits before cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 120,
			endIndex: 120,
			completion: "replacement",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-single-line",
		});
	});

	test("returns INLINE for safe at-cursor suggestions", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 200,
			endIndex: 200,
			completion: "suffix",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "INLINE",
			reason: "inline-safe",
		});
	});

	test("returns SUPPRESS on single-newline boundary for multiline at-cursor edit", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 200,
			endIndex: 200,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: true,
		});

		expect(result).toEqual({
			decision: "SUPPRESS",
			reason: "single-newline-boundary",
		});
	});

	test("returns JUMP for multiline replacement at cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 18,
			cursorOffset: 200,
			startIndex: 200,
			endIndex: 350,
			completion: '"label");\n\tauto *x = ...',
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "multiline-replacement-at-cursor",
		});
	});

	test("returns JUMP for an insertion that starts after the cursor on a later line", () => {
		// Real .eslintrc.json case: cursor at end of `    },` (offset 315,
		// line 15), model inserts a new override block below (start 319,
		// line 16). Rendering this as ghost text would detach it on the
		// lower line where the user can't accept it.
		const result = classifyEditDisplay({
			cursorLine: 15,
			editStartLine: 16,
			editEndLine: 16,
			cursorOffset: 315,
			startIndex: 319,
			endIndex: 320,
			completion: '\r\n    {\r\n      "files": ["*.json"],\r\n      "rules": {}\r\n    }',
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "after-cursor-next-line",
		});
	});

	test("keeps INLINE for an edit that starts after the cursor on the same line", () => {
		// Forward completion on the cursor's own line must still render as
		// ghost text, not get bounced to a jump edit.
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 205,
			endIndex: 205,
			completion: "Suffix",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "INLINE",
			reason: "inline-safe",
		});
	});
});

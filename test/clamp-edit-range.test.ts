import { describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import {
	clampEditRangeToCompletion,
	shrinkEditToCommonAffix,
	stripRedundantLinePrefix,
} from "~/api/clamp-edit-range.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";

function mockDocument(text: string): vscode.TextDocument {
	const lines = text.split("\n");
	const offsetAt = (position: vscode.Position): number => {
		let offset = 0;
		for (let i = 0; i < position.line; i++) {
			offset += (lines[i]?.length ?? 0) + 1;
		}
		return offset + position.character;
	};
	return {
		getText(range?: vscode.Range): string {
			if (!range) return text;
			return text.slice(offsetAt(range.start), offsetAt(range.end));
		},
		offsetAt(position: vscode.Position): number {
			return offsetAt(position);
		},
		positionAt(offset: number): vscode.Position {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				const lineLen = lines[i]?.length ?? 0;
				if (remaining <= lineLen) {
					return new vscode.Position(i, remaining);
				}
				remaining -= lineLen + 1;
			}
			return new vscode.Position(
				lines.length - 1,
				lines[lines.length - 1]?.length ?? 0,
			);
		},
		lineAt(line: number): vscode.TextLine {
			const content = lines[line] ?? "";
			return {
				text: content,
				range: new vscode.Range(line, 0, line, content.length),
			} as vscode.TextLine;
		},
		lineCount: lines.length,
	} as vscode.TextDocument;
}

function result(
	overrides: Partial<AutocompleteResult> & Pick<AutocompleteResult, "startIndex" | "endIndex" | "completion">,
): AutocompleteResult {
	return {
		id: "test",
		confidence: 0.8,
		...overrides,
	};
}

describe("shrinkEditToCommonAffix", () => {
	test("collapses a whole-line replacement to the changed suffix at the cursor", () => {
		const source = [
			"/**",
			" * @des",
			" */",
			"@Module({})",
		].join("\n");
		const document = mockDocument(source);
		const lineStart = document.offsetAt(new vscode.Position(1, 0));
		const lineEnd = document.offsetAt(new vscode.Position(1, 7));

		const shrunk = shrinkEditToCommonAffix(
			document,
			result({
				startIndex: lineStart,
				endIndex: lineEnd,
				completion: " * @description",
			}),
		);

		// The shared ` * @des` prefix is trimmed; only `cription` remains,
		// anchored at the cursor (end of ` * @des`).
		expect(shrunk.startIndex).toBe(lineEnd);
		expect(shrunk.endIndex).toBe(lineEnd);
		expect(shrunk.completion).toBe("cription");
	});

	test("collapses a re-emitted multi-line window to just the changed line", () => {
		const source = [
			"/**",
			" * @des",
			" */",
			"@Module({})",
			"export class AppModule {}",
		].join("\n");
		const document = mockDocument(source);
		const lineStart = document.offsetAt(new vscode.Position(1, 0));
		// Model re-emitted lines 1..3 but only changed ` * @des`.
		const windowEnd = document.offsetAt(new vscode.Position(3, 11));

		const shrunk = shrinkEditToCommonAffix(
			document,
			result({
				startIndex: lineStart,
				endIndex: windowEnd,
				completion: " * @description\n */\n@Module({})",
			}),
		);

		expect(shrunk.startIndex).toBe(document.offsetAt(new vscode.Position(1, 7)));
		expect(shrunk.endIndex).toBe(document.offsetAt(new vscode.Position(1, 7)));
		expect(shrunk.completion).toBe("cription");
	});

	test("leaves a genuine pure insertion (empty range) unchanged", () => {
		const source = ["foo", "bar"].join("\n");
		const document = mockDocument(source);
		const at = document.offsetAt(new vscode.Position(0, 3));

		const unchanged = shrinkEditToCommonAffix(
			document,
			result({ startIndex: at, endIndex: at, completion: "baz" }),
		);

		expect(unchanged.startIndex).toBe(at);
		expect(unchanged.endIndex).toBe(at);
		expect(unchanged.completion).toBe("baz");
	});

	test("trims a shared suffix as well as prefix", () => {
		const source = "const x = 1;";
		const document = mockDocument(source);

		const shrunk = shrinkEditToCommonAffix(
			document,
			result({
				startIndex: 0,
				endIndex: source.length,
				completion: "const yy = 1;",
			}),
		);

		// Shared prefix `const ` and suffix ` = 1;` trimmed; `x` -> `yy`.
		expect(document.getText(
			new vscode.Range(
				document.positionAt(shrunk.startIndex),
				document.positionAt(shrunk.endIndex),
			),
		)).toBe("x");
		expect(shrunk.completion).toBe("yy");
	});
});

describe("stripRedundantLinePrefix", () => {
	test("strips a re-emitted JSDoc line prefix at the cursor", () => {
		const source = [
			"/**",
			" * @des",
			" */",
			"@Module({})",
		].join("\n");
		const document = mockDocument(source);
		const cursor = new vscode.Position(1, 7);
		const linePrefix = document.lineAt(1).text.slice(0, cursor.character);
		expect(linePrefix).toBe(" * @des");
		expect(" * @description".startsWith(linePrefix)).toBe(true);

		const stripped = stripRedundantLinePrefix(
			document,
			cursor,
			result({
				startIndex: document.offsetAt(cursor),
				endIndex: source.length,
				completion: " * @description",
			}),
		);

		expect(stripped?.completion).toBe("cription");
		expect(stripped?.startIndex).toBe(document.offsetAt(cursor));
		expect(stripped?.endIndex).toBe(document.offsetAt(cursor));
	});
});

describe("clampEditRangeToCompletion", () => {
	test("clamps a single-line completion that incorrectly spans to EOF", () => {
		const source = [
			"/**",
			" * @des",
			" */",
			"@Module({",
			"  imports: [AuthModule],",
			"})",
			"export class AppModule {}",
		].join("\n");
		const document = mockDocument(source);
		const cursor = new vscode.Position(1, 7);
		const startIndex = document.offsetAt(cursor);

		const clamped = clampEditRangeToCompletion(
			document,
			result({
				startIndex,
				endIndex: source.length,
				completion: "cription",
			}),
		);

		const startLine = document.positionAt(startIndex).line;
		const expectedEnd = document.offsetAt(
			new vscode.Position(startLine, document.lineAt(startLine).text.length),
		);

		expect(clamped).not.toBeNull();
		expect(clamped?.endIndex).toBe(expectedEnd);
		expect(clamped!.endIndex).toBeLessThan(source.length);
		expect(clamped?.completion).toBe("cription");
	});

	test("clamps a multiline completion to its own line footprint", () => {
		const source = [
			"/**",
			" * @des",
			" */",
			"@Module({})",
			"export class AppModule {}",
		].join("\n");
		const document = mockDocument(source);
		const cursor = new vscode.Position(1, 7);
		const startIndex = document.offsetAt(cursor);

		const clamped = clampEditRangeToCompletion(
			document,
			result({
				startIndex,
				endIndex: source.length,
				completion: "cription\n */",
			}),
		);

		const expectedEnd = document.offsetAt(
			new vscode.Position(2, document.lineAt(2).text.length),
		);
		expect(clamped?.endIndex).toBe(expectedEnd);
		expect(clamped!.endIndex).toBeLessThan(source.length);
	});

	test("preserves intentional multi-line replacements", () => {
		const source = [
			"  imports: [AuthModule],",
			"})",
		].join("\n");
		const document = mockDocument(source);
		const cursor = document.positionAt(source.indexOf("],") + 2);
		const editStart = document.positionAt(source.indexOf("})"));
		const closingBraceEnd = document.offsetAt(
			new vscode.Position(editStart.line, 2),
		);

		const clamped = clampEditRangeToCompletion(
			document,
			result({
				startIndex: document.offsetAt(cursor),
				endIndex: closingBraceEnd,
				completion: "\n  controllers: [],\n  providers: [],\n})",
			}),
		);

		expect(clamped?.endIndex).toBe(closingBraceEnd);
		expect(clamped?.completion).toBe(
			"\n  controllers: [],\n  providers: [],\n})",
		);
	});

	test("drops single-line completions whose range spans many lines", () => {
		const source = "alpha\nbeta\ngamma\ndelta\n";
		const document = mockDocument(source);

		const dropped = clampEditRangeToCompletion(
			document,
			result({
				startIndex: 0,
				endIndex: source.length,
				completion: "alpha-edited",
			}),
		);

		expect(dropped?.endIndex).toBe(document.offsetAt(new vscode.Position(0, 5)));
	});
});

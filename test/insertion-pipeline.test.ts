import { describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import {
	clampEditRangeToCompletion,
	ensureInsertionLineBreak,
	normalizeEditResultAtCursor,
	realignReemittedTrailingContext,
	shrinkEditToCommonAffix,
	stripRedundantLinePrefix,
} from "~/api/clamp-edit-range.ts";
import { reanchorNextLineEditAtCursor } from "~/api/reanchor-edit-at-cursor.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";

// Mirrors InlineEditProvider.trimSuffixOverlap (anchored at the edit end).
function trimSuffixOverlap(
	document: vscode.TextDocument,
	result: AutocompleteResult,
): AutocompleteResult | null {
	if (!result.completion) return null;
	const endOffset = result.endIndex;
	const documentLength = document.getText().length;
	const maxLookahead = Math.min(
		documentLength - endOffset,
		result.completion.length,
	);
	if (maxLookahead <= 0) return result;
	const followingText = document.getText(
		new vscode.Range(
			document.positionAt(endOffset),
			document.positionAt(endOffset + maxLookahead),
		),
	);
	let overlap = 0;
	for (let i = maxLookahead; i > 0; i--) {
		if (result.completion.endsWith(followingText.slice(0, i))) {
			overlap = i;
			break;
		}
	}
	if (overlap === 0) return result;
	const trimmed = result.completion.slice(0, result.completion.length - overlap);
	if (trimmed.length === 0) return null;
	return { ...result, completion: trimmed };
}

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
		eol: 1,
		getText(range?: vscode.Range): string {
			if (!range) return text;
			return text.slice(offsetAt(range.start), offsetAt(range.end));
		},
		offsetAt: (p: vscode.Position) => offsetAt(p),
		positionAt(offset: number): vscode.Position {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				const lineLen = lines[i]?.length ?? 0;
				if (remaining <= lineLen) return new vscode.Position(i, remaining);
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

function runPipeline(
	doc: vscode.TextDocument,
	cursor: vscode.Position,
	raw: AutocompleteResult,
): AutocompleteResult {
	const cursorOffset = doc.offsetAt(cursor);
	const docText = doc.getText();
	let result = reanchorNextLineEditAtCursor(doc, cursor, raw);
	result = shrinkEditToCommonAffix(doc, result);
	result = realignReemittedTrailingContext(doc, result);
	if (result.startIndex < cursorOffset && cursorOffset <= result.endIndex) {
		const prefix = docText.slice(result.startIndex, cursorOffset);
		if (result.completion.startsWith(prefix)) {
			result.startIndex = cursorOffset;
			result.completion = result.completion.slice(prefix.length);
		}
	}
	const stripped = stripRedundantLinePrefix(doc, cursor, result);
	if (stripped) result = stripped;
	const clamped = clampEditRangeToCompletion(doc, result);
	if (clamped) result = clamped;
	result = ensureInsertionLineBreak(doc, result);

	// The provider re-normalizes and runs trimSuffixOverlap before rendering /
	// setting up the jump edit.
	const renormalized = normalizeEditResultAtCursor(doc, cursor, result);
	if (renormalized) result = renormalized;
	const trimmed = trimSuffixOverlap(doc, result);
	if (trimmed) result = trimmed;
	return result;
}

const entry2546 = [
	"    {",
	'        "id": 2546,',
	'        "name": "Шоу Трумана (дублирование)",',
	'        "originalName": "The Truman Show",',
	'        "watchUrl": "https://archive.org/details/the-truman-show-1998"',
	"    },",
].join("\n");

const block2547Body =
	'    {\n        "id": 2547,\n        "name": "Шоу Трумана (дублирование 2)",\n        "originalName": "The Truman Show",\n        "watchUrl": "https://archive.org/details/the-truman-show-1998"\n    }';

describe("truman duplicate insertion before array close", () => {
	for (const [label, completion] of [
		["leading-newline", `\n${block2547Body}`],
		["no-leading-newline", block2547Body],
	] as const) {
		test(`full pipeline applies cleanly (${label})`, () => {
			const source = `[\n${entry2546}\n]\n`;
			const doc = mockDocument(source);
			// Cursor at end of the `    },` line.
			const closeBraceLine = 1 + entry2546.split("\n").length - 1; // `    },`
			const cursor = new vscode.Position(
				closeBraceLine,
				doc.lineAt(closeBraceLine).text.length,
			);
			const arrayCloseOffset = doc.offsetAt(
				new vscode.Position(closeBraceLine + 1, 0),
			);

			const raw: AutocompleteResult = {
				id: "t",
				confidence: 0.8,
				startIndex: arrayCloseOffset,
				endIndex: arrayCloseOffset,
				completion,
			};

			const result = runPipeline(doc, cursor, raw);

			// Simulate jump-edit accept: replace(Range(start,end), completion).
			const applied =
				source.slice(0, result.startIndex) +
				result.completion +
				source.slice(result.endIndex);

			// No gluing of `}` and `]`.
			expect(applied).not.toContain("    }]");
			expect(applied).toContain("    }\n]");
			// No spurious blank line between the existing `},` and the new `{`.
			expect(applied).not.toContain("    },\n\n    {");
			// New entry present and array still closed.
			expect(applied).toContain('"id": 2547');
			expect(applied.trimEnd().endsWith("]")).toBe(true);
		});
	}
});

import { describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import { reanchorNextLineEditAtCursor } from "~/api/reanchor-edit-at-cursor.ts";
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
			const start = offsetAt(range.start);
			const end = offsetAt(range.end);
			return text.slice(start, end);
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

describe("reanchorNextLineEditAtCursor", () => {
	test("pulls a next-line property insertion back to the cursor", () => {
		const source = [
			"@Module({",
			"  imports: [AuthModule],",
			"})",
			"export class AppModule {}",
		].join("\n");
		const document = mockDocument(source);
		const cursor = document.positionAt(
			document.getText().indexOf("],") + 2,
		);
		const editStart = document.positionAt(document.getText().indexOf("})"));

		const anchored = reanchorNextLineEditAtCursor(
			document,
			cursor,
			result({
				startIndex: document.offsetAt(editStart),
				endIndex: document.offsetAt(editStart),
				completion: "  controllers: [],\n  providers: [],\n",
			}),
		);

		expect(anchored.startIndex).toBe(document.offsetAt(cursor));
		expect(anchored.endIndex).toBe(document.offsetAt(editStart));
		expect(anchored.completion).toBe(
			"\n  controllers: [],\n  providers: [],\n",
		);
	});

	test("pulls a next-line replacement that includes the closing brace", () => {
		const source = [
			"@Module({",
			"  imports: [AuthModule],",
			"})",
		].join("\n");
		const document = mockDocument(source);
		const cursor = document.positionAt(source.indexOf("],") + 2);
		const editStart = document.positionAt(source.indexOf("})"));
		const closingBraceEnd = document.offsetAt(
			new vscode.Position(editStart.line, 2),
		);

		const anchored = reanchorNextLineEditAtCursor(
			document,
			cursor,
			result({
				startIndex: document.offsetAt(editStart),
				endIndex: closingBraceEnd,
				completion: "  controllers: [],\n  providers: [],\n})",
			}),
		);

		expect(anchored.startIndex).toBe(document.offsetAt(cursor));
		expect(anchored.endIndex).toBe(closingBraceEnd);
		expect(anchored.completion).toBe(
			"\n  controllers: [],\n  providers: [],\n})",
		);
	});

	test("leaves same-line and far-from-cursor edits unchanged", () => {
		const source = "alpha\nbeta\n";
		const document = mockDocument(source);
		const cursor = document.positionAt(5); // end of "alpha"

		const farEdit = reanchorNextLineEditAtCursor(
			document,
			cursor,
			result({
				startIndex: document.offsetAt(new vscode.Position(2, 0)),
				endIndex: document.offsetAt(new vscode.Position(2, 0)),
				completion: "gamma\n",
			}),
		);
		expect(farEdit.completion).toBe("gamma\n");

		const sameLine = reanchorNextLineEditAtCursor(
			document,
			document.positionAt(3),
			result({
				startIndex: 0,
				endIndex: 3,
				completion: "alp",
			}),
		);
		expect(sameLine.completion).toBe("alp");
	});
});

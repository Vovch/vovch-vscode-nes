import * as vscode from "vscode";

import type { AutocompleteResult } from "./schemas.ts";

// When the line-diff mapper reports an insertion or replacement at the
// beginning of the line *after* the cursor, VS Code ghost text and jump-edit
// previews anchor on that next line — so a NestJS `@Module({ imports: [...],
// })` edit with the cursor after `],` renders `controllers`/`providers`
// floating past `})`. Pull the edit range back to the cursor and prefix the
// completion with the gap text (usually `\n`) so the preview lands where the
// user is typing.
export function reanchorNextLineEditAtCursor(
	document: vscode.TextDocument,
	cursorPosition: vscode.Position,
	result: AutocompleteResult,
): AutocompleteResult {
	const cursorOffset = document.offsetAt(cursorPosition);
	const editStartPos = document.positionAt(result.startIndex);
	if (editStartPos.character !== 0) return result;
	if (editStartPos.line !== cursorPosition.line + 1) return result;

	const gap = document.getText(
		new vscode.Range(cursorPosition, editStartPos),
	);
	if (gap.length === 0) return result;

	return {
		...result,
		startIndex: cursorOffset,
		completion: gap + result.completion,
		...(result.cursorTargetOffset !== undefined
			? {
					cursorTargetOffset: result.cursorTargetOffset + gap.length,
				}
			: {}),
	};
}

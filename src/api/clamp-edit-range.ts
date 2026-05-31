import * as vscode from "vscode";

import type { AutocompleteResult } from "./schemas.ts";

// Shrink an edit to its true minimal diff by trimming the longest common
// prefix and suffix shared between the replaced document span and the
// completion, computed at character granularity against the live document.
//
// The model (and our line-diff post-processors) routinely emit a whole-line
// or whole-window replacement where most characters are unchanged — e.g.
// replacing ` * @des` with ` * @description`, or re-emitting an unchanged
// `*/` + `@Module({…})` tail. A replacement whose range starts before the
// cursor renders as duplicated ghost text and gets misrouted to a jump-edit
// box. Collapsing to the minimal diff pulls the edit's start forward (often
// onto the cursor) so it renders as clean ghost text instead.
export function shrinkEditToCommonAffix(
	document: vscode.TextDocument,
	result: AutocompleteResult,
): AutocompleteResult {
	if (result.endIndex <= result.startIndex) return result;

	const oldText = document.getText(
		new vscode.Range(
			document.positionAt(result.startIndex),
			document.positionAt(result.endIndex),
		),
	);
	const completion = result.completion;

	let prefix = 0;
	const maxPrefix = Math.min(oldText.length, completion.length);
	while (prefix < maxPrefix && oldText[prefix] === completion[prefix]) {
		prefix++;
	}

	let suffix = 0;
	const maxSuffix = Math.min(
		oldText.length - prefix,
		completion.length - prefix,
	);
	while (
		suffix < maxSuffix &&
		oldText[oldText.length - 1 - suffix] ===
			completion[completion.length - 1 - suffix]
	) {
		suffix++;
	}

	if (prefix === 0 && suffix === 0) return result;

	const newStartIndex = result.startIndex + prefix;
	const newEndIndex = result.endIndex - suffix;
	const newCompletion = completion.slice(prefix, completion.length - suffix);

	const adjusted: AutocompleteResult = {
		...result,
		startIndex: newStartIndex,
		endIndex: newEndIndex,
		completion: newCompletion,
	};
	if (result.cursorTargetOffset !== undefined) {
		if (result.cursorTargetOffset >= prefix) {
			adjusted.cursorTargetOffset = result.cursorTargetOffset - prefix;
		} else {
			delete adjusted.cursorTargetOffset;
		}
	}
	return adjusted;
}

// When the model re-emits a full line (e.g. ` * @description`) but the cursor
// already holds the leading portion (` * @des`), strip the overlap so ghost
// text only shows the suffix (`cription`) instead of duplicating the prefix.
export function stripRedundantLinePrefix(
	document: vscode.TextDocument,
	cursorPosition: vscode.Position,
	result: AutocompleteResult,
): AutocompleteResult | null {
	const cursorOffset = document.offsetAt(cursorPosition);
	if (result.startIndex > cursorOffset) return result;

	const lineText = document.lineAt(cursorPosition.line).text;
	const linePrefix = lineText.slice(0, cursorPosition.character);
	if (linePrefix.length === 0 || !result.completion.startsWith(linePrefix)) {
		return result;
	}

	const completion = result.completion.slice(linePrefix.length);
	if (completion.length === 0) return null;

	const adjusted: AutocompleteResult = {
		...result,
		startIndex: cursorOffset,
		endIndex: cursorOffset,
		completion,
	};
	if (result.cursorTargetOffset !== undefined) {
		if (result.cursorTargetOffset >= linePrefix.length) {
			adjusted.cursorTargetOffset =
				result.cursorTargetOffset - linePrefix.length;
		} else {
			delete adjusted.cursorTargetOffset;
		}
	}
	return adjusted;
}

// Guard against mis-mapped line diffs (or prefix-anchoring at the cursor)
// leaving endIndex far past the completion payload.
export function clampEditRangeToCompletion(
	document: vscode.TextDocument,
	result: AutocompleteResult,
): AutocompleteResult | null {
	if (result.endIndex <= result.startIndex) {
		return result;
	}

	if (result.completion.length === 0) {
		return result;
	}

	const startPos = document.positionAt(result.startIndex);
	const endPos = document.positionAt(result.endIndex);
	const oldText = document.getText(new vscode.Range(startPos, endPos));
	const oldLineCount = oldText.split("\n").length;
	const completionLineCount = result.completion.split("\n").length;
	const spanLineCount = endPos.line - startPos.line + 1;

	if (spanLineCount > completionLineCount || oldLineCount > completionLineCount) {
		const endLine = Math.min(
			document.lineCount - 1,
			startPos.line + completionLineCount - 1,
		);
		const lineEndOffset = document.offsetAt(
			new vscode.Position(endLine, document.lineAt(endLine).text.length),
		);
		if (result.endIndex > lineEndOffset) {
			return { ...result, endIndex: lineEndOffset };
		}
	}

	// When the edit starts at end-of-line, the span can include trailing
	// document lines even though the completion only extends forward from
	// the cursor. Shrink any range that reaches past the completion footprint.
	if (
		result.endIndex > result.startIndex &&
		result.endIndex - result.startIndex > result.completion.length
	) {
		const endLine = Math.min(
			document.lineCount - 1,
			startPos.line + completionLineCount - 1,
		);
		const lineEndOffset = document.offsetAt(
			new vscode.Position(endLine, document.lineAt(endLine).text.length),
		);
		if (result.endIndex > lineEndOffset) {
			return { ...result, endIndex: lineEndOffset };
		}
	}
	if (
		oldText.length > result.completion.length + 64 &&
		oldText.length > result.completion.length * 2 &&
		completionLineCount < oldLineCount
	) {
		return null;
	}

	return result;
}

export function normalizeEditResultAtCursor(
	document: vscode.TextDocument,
	cursorPosition: vscode.Position,
	result: AutocompleteResult,
): AutocompleteResult | null {
	const shrunk = shrinkEditToCommonAffix(document, result);
	const stripped = stripRedundantLinePrefix(document, cursorPosition, shrunk);
	if (!stripped) return null;
	return clampEditRangeToCompletion(document, stripped);
}

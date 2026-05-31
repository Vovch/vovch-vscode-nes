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

// Recover the intended insertion when the model re-emits trailing document
// context but truncates real closing structure.
//
// Example (adding an ESLint override before the array/object close):
//
//   …
//       "rules": {}
//     },        ← cursor here
//     ]          ← array close
//   }            ← object close
//
// The line-diff mapper hands us a replacement spanning `  ]\n}` whose
// completion is `{ … }\n  ]` — it re-emits the array close it sits in front of
// but stops before the object close. Applying that range deletes BOTH closes
// and only puts the array close back, silently dropping `}` (or, after
// downstream re-anchoring, dropping `]`). Either way the file is corrupted.
//
// Detect the case where the completion's tail equals the document text at the
// *start* of the deleted span and collapse the edit to a pure insertion,
// preserving everything the model did not actually rewrite.
export function realignReemittedTrailingContext(
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

	// Largest k such that the completion ends by re-emitting the document text
	// that *begins* the deleted span (doc[startIndex .. startIndex + k]).
	let tail = 0;
	const maxTail = Math.min(oldText.length, completion.length);
	for (let i = maxTail; i > 0; i--) {
		if (completion.endsWith(oldText.slice(0, i))) {
			tail = i;
			break;
		}
	}
	if (tail === 0) return result;
	// When the whole deleted span is re-emitted as the completion suffix this
	// is an ordinary affix overlap that shrinkEditToCommonAffix already handles;
	// only step in when the span reaches past the re-emitted region (i.e. the
	// model left trailing document content unreproduced).
	if (tail >= oldText.length) return result;

	let newCompletion = completion.slice(0, completion.length - tail);
	if (newCompletion.length === 0) return result;

	// Trim leading content that merely repeats the document text immediately
	// preceding the insertion point (the model re-emitted the line break that
	// already separates the previous line) so we don't inject a blank line.
	const before = document.getText(
		new vscode.Range(
			document.positionAt(Math.max(0, result.startIndex - newCompletion.length)),
			document.positionAt(result.startIndex),
		),
	);
	let lead = 0;
	const maxLead = Math.min(newCompletion.length, before.length);
	for (let i = maxLead; i > 0; i--) {
		if (newCompletion.slice(0, i) === before.slice(before.length - i)) {
			lead = i;
			break;
		}
	}
	if (lead > 0) newCompletion = newCompletion.slice(lead);
	if (newCompletion.length === 0) return result;

	const adjusted: AutocompleteResult = {
		...result,
		startIndex: result.startIndex,
		endIndex: result.startIndex,
		completion: newCompletion,
	};
	if (result.cursorTargetOffset !== undefined) {
		if (result.cursorTargetOffset >= lead) {
			const shifted = result.cursorTargetOffset - lead;
			if (shifted <= newCompletion.length) {
				adjusted.cursorTargetOffset = shifted;
			} else {
				delete adjusted.cursorTargetOffset;
			}
		} else {
			delete adjusted.cursorTargetOffset;
		}
	}
	return adjusted;
}

// A multi-line block inserted at the very start of a line must end with a
// line break, otherwise the existing line it sits in front of is glued onto
// the block's last line. E.g. inserting a new array element before the `]`
// close:
//
//   …
//       }   ← inserted block's last line
//   ]       ← existing array close
//
// is spliced as `…}]` because the completion (`{ … }`) carries no trailing
// newline and the editor replaces `[start,start)` then keeps the rest of the
// `]` line in place. Append the document's line break so the block occupies
// whole lines and the following line is preserved.
export function ensureInsertionLineBreak(
	document: vscode.TextDocument,
	result: AutocompleteResult,
): AutocompleteResult {
	if (result.startIndex !== result.endIndex) return result;
	if (result.completion.length === 0) return result;
	// Only multi-line blocks: a single-line insertion (e.g. prepending
	// `export `) is meant to join the following text, not split onto its own
	// line.
	if (!result.completion.includes("\n")) return result;

	const pos = document.positionAt(result.startIndex);
	if (pos.character !== 0) return result;
	// Nothing to glue onto when the anchor line is empty.
	if (document.lineAt(pos.line).text.length === 0) return result;

	const eol = result.completion.includes("\r\n")
		? "\r\n"
		: (document as { eol?: number }).eol === 2
			? "\r\n"
			: "\n";

	let completion = result.completion;
	// A leading newline at column 0 only injects a blank line above the block
	// (an artifact of the model re-emitting the previous line's break); drop it.
	const leading = /^(?:\r?\n)+/.exec(completion);
	const strippedLead = leading ? leading[0].length : 0;
	if (strippedLead > 0) completion = completion.slice(strippedLead);
	// A missing trailing newline glues the following line (e.g. `]`) onto the
	// block's last line (`}]`); add one.
	if (!/\n$/.test(completion)) completion += eol;

	if (completion === result.completion) return result;
	const adjusted: AutocompleteResult = { ...result, completion };
	if (result.cursorTargetOffset !== undefined) {
		const shifted = result.cursorTargetOffset - strippedLead;
		adjusted.cursorTargetOffset = Math.max(
			0,
			Math.min(shifted, completion.length),
		);
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
	const realigned = realignReemittedTrailingContext(document, shrunk);
	const stripped = stripRedundantLinePrefix(document, cursorPosition, realigned);
	if (!stripped) return null;
	const clamped = clampEditRangeToCompletion(document, stripped);
	if (!clamped) return null;
	return ensureInsertionLineBreak(document, clamped);
}

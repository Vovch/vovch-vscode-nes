export type EditDisplayDecision = "INLINE" | "JUMP" | "SUPPRESS";

export interface EditDisplayClassification {
	decision: EditDisplayDecision;
	reason:
		| "far-from-cursor"
		| "before-cursor-multiline"
		| "before-cursor-single-line"
		| "single-newline-boundary"
		| "multiline-replacement-at-cursor"
		| "after-cursor-next-line"
		| "inline-safe";
}

export interface EditDisplayClassifierInput {
	cursorLine: number;
	editStartLine: number;
	editEndLine: number;
	cursorOffset: number;
	startIndex: number;
	endIndex: number;
	completion: string;
	isOnSingleNewlineBoundary: boolean;
}

export const EDIT_RANGE_PADDING_ROWS = 2;

export function classifyEditDisplay(
	input: EditDisplayClassifierInput,
): EditDisplayClassification {
	const lineDifference = Math.abs(input.cursorLine - input.editStartLine);
	const isBeforeCursor = input.startIndex < input.cursorOffset;
	const hasMultilineCompletion = input.completion.includes("\n");

	const paddedStart = Math.max(
		0,
		input.editStartLine - EDIT_RANGE_PADDING_ROWS,
	);
	const paddedEnd = input.editEndLine + EDIT_RANGE_PADDING_ROWS;
	const isFarFromCursor =
		input.cursorLine < paddedStart || input.cursorLine > paddedEnd;

	if (isFarFromCursor) {
		return {
			decision: "JUMP",
			reason: "far-from-cursor",
		};
	}

	if (isBeforeCursor && hasMultilineCompletion) {
		return {
			decision: "JUMP",
			reason: "before-cursor-multiline",
		};
	}

	if (isBeforeCursor) {
		return {
			decision: "JUMP",
			reason: "before-cursor-single-line",
		};
	}

	if (
		hasMultilineCompletion &&
		input.startIndex === input.cursorOffset &&
		input.isOnSingleNewlineBoundary &&
		lineDifference <= 1
	) {
		return {
			decision: "SUPPRESS",
			reason: "single-newline-boundary",
		};
	}

	// Multi-line replacements anchored at the cursor don't render as inline
	// ghost text via vscode.InlineCompletionItem — VSCode silently swallows
	// them when the new text doesn't extend the existing line. Route to a
	// jump-edit decoration so the diff is at least visible.
	if (
		input.startIndex === input.cursorOffset &&
		input.endIndex > input.startIndex &&
		input.editEndLine > input.editStartLine
	) {
		return {
			decision: "JUMP",
			reason: "multiline-replacement-at-cursor",
		};
	}

	// An edit that starts after the cursor but on a later line can't render
	// as ghost text at the caret — VSCode draws it detached on the lower
	// line, where the user can't Tab-accept it inline, so it appears to be
	// silently ignored. This is the symmetric counterpart to the
	// before-cursor rules above; route it to a jump edit so the user gets a
	// visible "→ Edit at line N (Tab ✓)" affordance. Common case: inserting
	// a new array/object element a line or two below the cursor.
	if (
		input.startIndex > input.cursorOffset &&
		input.editStartLine > input.cursorLine
	) {
		return {
			decision: "JUMP",
			reason: "after-cursor-next-line",
		};
	}

	return {
		decision: "INLINE",
		reason: "inline-safe",
	};
}

// Postprocessing for Zeta2 / Zeta2.1 model output. Mirrors parseCompletion
// in cursortab.nvim's server/provider/zeta2/zeta2.go for the 2.0 path,
// extended for the 2.1 paired-marker layout (with optional multi-region
// support). Strips end-of-edit markers, short-circuits on the NO_EDITS
// sentinel (2.0), strips <|user_cursor|> markers, then maps each
// editable-region replacement to a UTF-8 byte-offset edit on the user's
// document.
//
// Returns an array because zeta2.1 multi-region prompts can carry up to
// MAX_REGIONS pairs and the model may emit a replacement for each. The
// primary (cursor) region is always first in the returned array; the
// editor renders it as ghost text and queues the rest as jump edits.
// Single-region prompts (sweep, 2.0, 2.1-with-no-extras) return an array
// of one.
//
// Unlike Sweep, the model output is *only* the new editable region (not
// a full window rewrite), so trimCommonEnds runs against the editable
// slice rather than the full original/current/updated window.

import { logger } from "~/core/logger.ts";
import type { CompletionResult } from "./completion-client.ts";
import type { EditRegion, ModelPrompt } from "./model-format.ts";
import type { AutocompleteResponse } from "./schemas.ts";
import { stripInjectedFixmesFromLines } from "./sweep-completion.ts";
import {
	ZETA2_CURSOR_MARKER,
	ZETA2_END_MARKER,
	ZETA2_NO_EDITS,
} from "./zeta2-prompt.ts";

export function buildZeta2Response(
	completion: CompletionResult,
	prompt: ModelPrompt,
	autocompleteId: string,
): AutocompleteResponse[] | null {
	if (completion.finishReason === "length") return null;

	const regions = prompt.regions ?? [
		{
			startLine: prompt.windowStartLine,
			endLine: prompt.windowEndLine,
			isPrimary: true,
		},
	];
	const primary = regions.find((r) => r.isPrimary) ?? regions[0];
	if (!primary) return null;

	const responses: AutocompleteResponse[] = [];

	if (prompt.format === "zeta2.1" && regions.length > 1) {
		// Multi-region path: split the model output by paired numbered
		// markers, one replacement per region. A region with no matching
		// pair (model decided not to edit it) is skipped silently.
		const replacements = parseRegionReplacements(completion.text);
		// Emit primary first so the editor renders it as ghost text and
		// queues the rest as jump edits.
		const ordered: EditRegion[] = [
			primary,
			...regions.filter((r) => r !== primary),
		];
		ordered.forEach((region, displayIdx) => {
			const regionIdx = regions.indexOf(region);
			const replacement = replacements.get(regionIdx);
			if (replacement === undefined) return;
			const id =
				displayIdx === 0
					? autocompleteId
					: `${autocompleteId}-r${regionIdx + 1}`;
			const response = buildRegionResponse(
				replacement,
				region,
				prompt,
				id,
				completion.finishReason,
			);
			if (response) responses.push(response);
		});
	} else {
		// Single-region path (sweep / 2.0 / 2.1 with no extra regions).
		// Strip the end-of-edit scaffolding once, then run a single-
		// region diff against the primary region.
		let cleaned = completion.text;
		if (prompt.format === "zeta2.1") {
			// Strip every marker_1 / marker_2 token globally — the model
			// occasionally emits stray markers mid-output (multi-region
			// hallucination); leftover ones would render as literal
			// `<|marker_…|>` text inside the suggestion. The tokens are
			// model-specific and won't appear in real source code.
			cleaned = cleaned.replace(/<\|marker_1\|>\n?/g, "");
			cleaned = cleaned.replace(/\n?<\|marker_2\|>/g, "");
		} else {
			// 2.0 / sweep-on-zeta2: strip trailing >>>>>>> UPDATED.
			if (cleaned.endsWith(ZETA2_END_MARKER)) {
				cleaned = cleaned.slice(0, -ZETA2_END_MARKER.length);
			} else {
				const trimmed = ZETA2_END_MARKER.replace(/\n$/, "");
				if (cleaned.endsWith(trimmed)) {
					cleaned = cleaned.slice(0, -trimmed.length);
				}
			}
			if (cleaned.trimStart().startsWith(ZETA2_NO_EDITS)) return null;
		}
		const response = buildRegionResponse(
			cleaned,
			primary,
			prompt,
			autocompleteId,
			completion.finishReason,
		);
		if (response) responses.push(response);
	}

	return responses.length > 0 ? responses : null;
}

// Parse a multi-region 2.1 response into a map of region index →
// replacement content. Region index is derived from the open marker
// number: marker_1/2 → region 0, marker_3/4 → region 1, marker_5/6 →
// region 2, etc.
//
// Lenient on close markers: if an open's matching close is missing
// (model emitted its native EOS instead of `<|marker_2|>`, or got cut
// off mid-stream), the content extends to the next open marker, or
// to end-of-text if no further markers exist. Strict on numbering:
// an open whose immediately-following marker is the wrong even number
// is dropped as malformed.
function parseRegionReplacements(text: string): Map<number, string> {
	type MarkerHit = { num: number; start: number; end: number };
	const re = /<\|marker_(\d+)\|>/g;
	const hits: MarkerHit[] = [];
	for (const m of text.matchAll(re)) {
		const idx = m.index ?? -1;
		if (idx < 0) continue;
		hits.push({
			num: Number.parseInt(m[1] ?? "0", 10),
			start: idx,
			end: idx + m[0].length,
		});
	}

	const map = new Map<number, string>();
	for (let i = 0; i < hits.length; i++) {
		const open = hits[i];
		if (!open || open.num % 2 !== 1 || open.num < 1) continue;
		const regionIdx = (open.num - 1) / 2;
		if (map.has(regionIdx)) continue; // first writer wins

		const next = hits[i + 1];
		let contentEnd: number;
		if (!next) {
			// Truncated last pair — model didn't emit a close. Take
			// everything to end of text.
			contentEnd = text.length;
		} else if (next.num === open.num + 1) {
			// Properly closed.
			contentEnd = next.start;
		} else if (next.num % 2 === 1) {
			// Another open marker before our close. Treat the current
			// region as truncated and let its content end at the next
			// open's start so the back-to-back regions parse cleanly.
			contentEnd = next.start;
		} else {
			// Wrong close number (e.g. open=1 followed by marker_4 with
			// no marker_2 between). Malformed — drop.
			continue;
		}

		let content = text.slice(open.end, contentEnd);
		content = content.replace(/^\n/, "").replace(/\n$/, "");
		map.set(regionIdx, content);
	}
	return map;
}

// Map one region's replacement text to a UTF-8 byte-offset edit. Shared
// between single-region and per-region multi-region paths. The caller
// is responsible for stripping end-of-edit / marker scaffolding before
// passing `text` in.
function buildRegionResponse(
	rawText: string,
	region: EditRegion,
	prompt: ModelPrompt,
	autocompleteId: string,
	finishReason: string,
): AutocompleteResponse | null {
	let text = rawText;

	// Replace the FIRST cursor marker with a sentinel so we can track
	// the post-edit cursor position through the line-diff and surface
	// it as a snippet $0 placeholder. Accept both <|user_cursor|>
	// (Zeta2's trained marker) and <|cursor|> (sweep-style — some
	// SeedCoder checkpoints echo it back). Only the primary region is
	// expected to contain a cursor marker, but secondary regions are
	// safe to run through this — countCursorMarkers will return 0.
	const markerCount = countCursorMarkers(text);
	if (markerCount > 0) {
		logger.debug(
			`zeta2 response contained ${markerCount} cursor marker(s); stripping`,
		);
	}
	text = injectCursorSentinel(text);
	text = text.replace(/[ \t\n\r]+$/g, "");
	if (text.replace(SENTINEL, "").trim() === "") return null;

	const stripped = stripRepetition(text);
	if (stripped === null) return null;

	const newLines = stripped.split("\n");
	stripInjectedFixmesFromLines(
		newLines,
		prompt.injectedFixmeMessages,
		prompt.commentPrefix,
		prompt.inlineDiagnosticsMarker,
	);
	const oldLines = prompt.lines
		.slice(region.startLine, region.endLine)
		.map((l) => l.content);

	if (trimRight(newLines.join("\n")) === trimRight(oldLines.join("\n"))) {
		return null;
	}

	const trimmed = trimCommonEnds(oldLines, newLines);
	if (trimmed === null) return null;

	const { skipPrefix, oldMiddle, newMiddle } = trimmed;
	const startLineIdx = region.startLine + skipPrefix;
	const endLineIdx = startLineIdx + oldMiddle.length; // exclusive

	const startByte = prompt.cursorLineByteOffsets[startLineIdx] ?? 0;
	let endByte: number;
	let completionText: string;

	if (oldMiddle.length === 0) {
		// Pure insertion — splice new lines in front of the suffix line.
		endByte = startByte;
		completionText = `${newMiddle.join("\n")}\n`;
	} else if (newMiddle.length === 0) {
		// Pure deletion — gobble the trailing newline of the last removed line.
		endByte = prompt.cursorLineByteOffsets[endLineIdx] ?? startByte;
		completionText = "";
	} else {
		const lastLineIdx = endLineIdx - 1;
		const lineStart = prompt.cursorLineByteOffsets[lastLineIdx] ?? startByte;
		const lineContent = prompt.lines[lastLineIdx]?.content ?? "";
		endByte = lineStart + Buffer.byteLength(lineContent, "utf8");
		completionText = newMiddle.join("\n");
	}

	const { text: cleanedCompletion, cursorTargetOffset } =
		extractCursorSentinel(completionText);
	completionText = cleanedCompletion;
	if (cursorTargetOffset !== undefined) {
		logger.debug(
			`zeta2 cursor target at offset ${cursorTargetOffset} of ${completionText.length}-char completion`,
		);
	}

	if (completionText.length === 0 && endByte === startByte) return null;

	return {
		autocomplete_id: autocompleteId,
		start_index: startByte,
		end_index: endByte,
		completion: completionText,
		confidence: 0.8,
		finish_reason: finishReason,
		...(cursorTargetOffset !== undefined
			? { cursor_target_offset: cursorTargetOffset }
			: {}),
	};
}

// U+E000 (Private Use Area) — never appears in real source, so it survives
// line-splitting / repetition trimming / line-diff trimming intact.
const SENTINEL = String.fromCharCode(0xe000);
const CURSOR_MARKERS = [ZETA2_CURSOR_MARKER, "<|cursor|>"];

function countCursorMarkers(text: string): number {
	let n = 0;
	for (const m of CURSOR_MARKERS) {
		const parts = text.split(m).length - 1;
		n += parts;
	}
	return n;
}

function injectCursorSentinel(text: string): string {
	let firstIdx = -1;
	let firstLen = 0;
	for (const m of CURSOR_MARKERS) {
		const i = text.indexOf(m);
		if (i !== -1 && (firstIdx === -1 || i < firstIdx)) {
			firstIdx = i;
			firstLen = m.length;
		}
	}
	let result = text;
	if (firstIdx !== -1) {
		result =
			result.slice(0, firstIdx) + SENTINEL + result.slice(firstIdx + firstLen);
	}
	for (const m of CURSOR_MARKERS) {
		if (result.includes(m)) result = result.split(m).join("");
	}
	return result;
}

function extractCursorSentinel(text: string): {
	text: string;
	cursorTargetOffset: number | undefined;
} {
	const idx = text.indexOf(SENTINEL);
	if (idx === -1) return { text, cursorTargetOffset: undefined };
	const cleaned = text.slice(0, idx) + text.slice(idx + SENTINEL.length);
	return { text: cleaned, cursorTargetOffset: idx };
}

interface TrimmedDiff {
	skipPrefix: number;
	oldMiddle: string[];
	newMiddle: string[];
}

function trimCommonEnds(
	oldLines: string[],
	newLines: string[],
): TrimmedDiff | null {
	// splitLines on a file ending with '\n' produces a phantom trailing ""
	// that has no counterpart in the model output (text is right-trimmed),
	// so suffix-match would fail at the last comparison and the diff would
	// blow up to span the whole window. Drop trailing empties from both
	// sides before aligning.
	let oldEnd = oldLines.length;
	while (oldEnd > 0 && oldLines[oldEnd - 1] === "") oldEnd--;
	let newEnd = newLines.length;
	while (newEnd > 0 && newLines[newEnd - 1] === "") newEnd--;

	let skipPrefix = 0;
	const minLen = Math.min(oldEnd, newEnd);
	while (skipPrefix < minLen && oldLines[skipPrefix] === newLines[skipPrefix]) {
		skipPrefix++;
	}

	let skipSuffix = 0;
	const remainingOld = oldEnd - skipPrefix;
	const remainingNew = newEnd - skipPrefix;
	const maxSuffix = Math.min(remainingOld, remainingNew);
	while (
		skipSuffix < maxSuffix &&
		oldLines[oldEnd - 1 - skipSuffix] === newLines[newEnd - 1 - skipSuffix]
	) {
		skipSuffix++;
	}

	const oldMiddle = oldLines.slice(skipPrefix, oldEnd - skipSuffix);
	const newMiddle = newLines.slice(skipPrefix, newEnd - skipSuffix);
	if (oldMiddle.length === 0 && newMiddle.length === 0) return null;
	return { skipPrefix, oldMiddle, newMiddle };
}

function trimRight(s: string): string {
	return s.replace(/[ \t\n\r]+$/g, "");
}

function stripRepetition(text: string): string | null {
	const lines = text.split("\n");
	let cutIdx = -1;
	for (let i = 2; i < lines.length; i++) {
		const a = lines[i];
		const b = lines[i - 1];
		const c = lines[i - 2];
		if (a === b && a === c && a !== undefined && a.trim() !== "") {
			cutIdx = i - 2;
			break;
		}
	}
	if (cutIdx < 0) return text;
	if (cutIdx === 0) return null;
	return lines.slice(0, cutIdx).join("\n");
}

import type { EditRecord } from "~/telemetry/document-tracker.ts";

export interface ParsedRange {
	newStart: number;
	newEnd: number;
}

export const MERGE_WINDOW_MS = 60_000;
// Tolerates a single inserted/removed line shifting downstream ranges
// (the common Enter case). Larger structural moves stay as distinct
// records — they are meaningful context.
export const MERGE_LINE_FUZZ = 1;

const HUNK_HEADER_RE = /@@ -\d+,\d+ \+(\d+),(\d+) @@/;

export function parseNewSideRange(diff: string): ParsedRange | null {
	const match = HUNK_HEADER_RE.exec(diff);
	if (!match || match[1] === undefined || match[2] === undefined) return null;
	const newStart = Number.parseInt(match[1], 10);
	const newCount = Number.parseInt(match[2], 10);
	if (!Number.isFinite(newStart) || !Number.isFinite(newCount)) return null;
	const newEnd = newStart + Math.max(0, newCount - 1);
	return { newStart, newEnd };
}

export function rangesOverlap(
	a: ParsedRange,
	b: ParsedRange,
	fuzz: number,
): boolean {
	return a.newStart - fuzz <= b.newEnd && b.newStart - fuzz <= a.newEnd;
}

export function shouldCoalesce(
	existing: EditRecord,
	incoming: EditRecord,
	now: number,
): boolean {
	if (existing.filepath !== incoming.filepath) return false;
	if (now - existing.timestamp > MERGE_WINDOW_MS) return false;
	const existingRange = parseNewSideRange(existing.diff);
	const incomingRange = parseNewSideRange(incoming.diff);
	if (!existingRange || !incomingRange) return false;
	return rangesOverlap(existingRange, incomingRange, MERGE_LINE_FUZZ);
}

import { describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import { DocumentTracker } from "~/telemetry/document-tracker.ts";

function doc(uri = "file:///movies.json"): vscode.TextDocument {
	return {
		uri: { scheme: "file", fsPath: uri, toString: () => uri },
		getText: () => "",
	} as unknown as vscode.TextDocument;
}

function sel(
	startLine: number,
	startChar: number,
	endLine: number,
	endChar: number,
): vscode.Selection {
	return {
		start: { line: startLine, character: startChar },
		end: { line: endLine, character: endChar },
		isEmpty: startLine === endLine && startChar === endChar,
	} as unknown as vscode.Selection;
}

describe("DocumentTracker multi-line selection lookback", () => {
	test("marks a multi-line selection as recent", () => {
		const tracker = new DocumentTracker();
		const d = doc();
		tracker.trackSelectionChange(d, [sel(10, 0, 13, 0)]);
		expect(tracker.wasRecentMultiLineSelection(d.uri.toString(), 5000)).toBe(
			true,
		);
	});

	test("clears the marker once the selection collapses to a caret", () => {
		const tracker = new DocumentTracker();
		const d = doc();
		// Select several lines …
		tracker.trackSelectionChange(d, [sel(10, 0, 13, 0)]);
		expect(tracker.wasRecentMultiLineSelection(d.uri.toString(), 5000)).toBe(
			true,
		);
		// … then delete them: the caret collapses to a single empty position.
		tracker.trackSelectionChange(d, [sel(10, 0, 10, 0)]);
		expect(tracker.wasRecentMultiLineSelection(d.uri.toString(), 5000)).toBe(
			false,
		);
	});

	test("keeps the marker while a non-empty single-line selection lingers", () => {
		const tracker = new DocumentTracker();
		const d = doc();
		tracker.trackSelectionChange(d, [sel(10, 0, 13, 0)]);
		// A single-line *non-empty* selection isn't a fully collapsed caret, so
		// the recent-selection guard stays until it expires.
		tracker.trackSelectionChange(d, [sel(10, 0, 10, 4)]);
		expect(tracker.wasRecentMultiLineSelection(d.uri.toString(), 5000)).toBe(
			true,
		);
	});
});

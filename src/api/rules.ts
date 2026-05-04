// Workspace-local sweep rules. The file lives at
//
//   <workspace>/.vscode/nes-<ext>.md
//
// where <ext> is the source file's extension (cpp, lua, js, ts, py, …).
// The body is wrapped in the language's single-line comment syntax and
// emitted as a sibling section <|file_sep|>context/rules\n... right
// before the original/current/updated triplet (see sweep-prompt.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// VSCode languageId → single-line comment prefix. Languages without a
// well-defined single-line comment style are intentionally omitted; the
// rules file is silently ignored for those.
const COMMENT_PREFIXES: Record<string, string> = {
	c: "//",
	cpp: "//",
	java: "//",
	javascript: "//",
	javascriptreact: "//",
	typescript: "//",
	typescriptreact: "//",
	rust: "//",
	go: "//",
	csharp: "//",
	swift: "//",
	kotlin: "//",
	scala: "//",
	dart: "//",
	objectivec: "//",
	objectivecpp: "//",
	glsl: "//",
	hlsl: "//",
	jsonc: "//",
	proto3: "//",
	lua: "--",
	haskell: "--",
	sql: "--",
	elm: "--",
	python: "#",
	shellscript: "#",
	yaml: "#",
	toml: "#",
	perl: "#",
	ruby: "#",
	makefile: "#",
	dockerfile: "#",
	powershell: "#",
	r: "#",
	elixir: "#",
};

interface CachedRules {
	mtimeMs: number;
	text: string;
}

const cache = new Map<string, CachedRules>();

export function loadWorkspaceRules(document: vscode.TextDocument): string {
	const ws = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!ws) return "";
	const ext = path.extname(document.uri.fsPath).slice(1).toLowerCase();
	if (!ext) return "";
	const file = path.join(ws.uri.fsPath, ".vscode", `nes-${ext}.md`);

	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		// stat() failures cache as "no rules" so we don't pay the syscall
		// every keystroke when the rules file simply isn't there.
		cache.set(file, { mtimeMs: 0, text: "" });
		return "";
	}
	const cached = cache.get(file);
	if (cached && cached.mtimeMs === mtimeMs) return cached.text;

	let body: string;
	try {
		body = fs.readFileSync(file, "utf8").trim();
	} catch {
		cache.set(file, { mtimeMs, text: "" });
		return "";
	}
	if (body === "") {
		cache.set(file, { mtimeMs, text: "" });
		return "";
	}

	const comment = COMMENT_PREFIXES[document.languageId];
	if (!comment) {
		cache.set(file, { mtimeMs, text: "" });
		return "";
	}

	const wrapped = wrapAsComment(body, comment);
	cache.set(file, { mtimeMs, text: wrapped });
	return wrapped;
}

function wrapAsComment(body: string, comment: string): string {
	const out: string[] = [];
	for (const line of body.split("\n")) {
		if (line === "") {
			out.push(comment);
		} else {
			out.push(`${comment} ${line}`);
		}
	}
	out.push(""); // trailing newline so the splice point is line-aligned
	return out.join("\n");
}

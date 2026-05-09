## NESweep — Next Edit autocompletion for VSCode

<img width="563" height="327" alt="image" src="https://github.com/user-attachments/assets/9a06ed4a-bf9b-41e0-a21b-2178cb2c67b9" />

NESweep is a fork of [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
that retargets the extension at a local OpenAI-compatible
`/v1/completions` server (e.g. llama.cpp's `llama-server`) running the
sweep GGUF, removing the upstream `uvx sweep-autocomplete` Python child
process (which falls back to CPU and is unusable for next-edit
latency).

The sweep prompt format (broad context, retrieval, diagnostics, diff
history, and the `original/current/updated` triplet with cursor marker
and prefill) is ported from
[cursortab.nvim](https://github.com/cursortab/cursortab.nvim)'s sweep
provider. Zeta2 / Zeta-2.1 support (single-region SeedCoder FIM and
the multi-region `<|marker_N|>` layout) is added on top.

## Features

### Backend

- **OpenAI-compatible `/v1/completions`.** The extension posts to a
  single endpoint with `model / prompt / temperature / max_tokens /
  stop`. Context size and idle eviction are server-side concerns
  (e.g. llama-server's `--ctx-size`), so neither `num_ctx` nor
  `keep_alive` are sent.
- **Three prompt formats, picked by model name.**
  - `zeta-2.1` / `zeta2.1` → SeedCoder FIM with paired numbered
    markers (`<|marker_1|>` … `<|marker_2|>`) and **multi-region
    edits** (the cursor area + up to two windows around nearby
    diagnostics, all packed into one request).
  - `zeta2` / `zeta-2` / `seedcoder` → SeedCoder FIM with the legacy
    git-conflict scaffold (`<<<<<<< CURRENT` … `=======` …
    `>>>>>>> UPDATED`). Single region.
  - Anything else → sweep `<|file_sep|>{path}` layout with the
    `original/current/updated` triplet and `<|cursor|>` marker.
    Single region.
  Stop tokens are switched per format (`<|marker_2|>` for 2.1,
  `>>>>>>> UPDATED` for 2.0, `<|file_sep|>` / `<|endoftext|>` for
  sweep).
- **Prompt assembled in TypeScript.** Broad file context, retrieval
  (open editors + LSP definitions/usages + clipboard), diagnostics,
  recent-changes diff history, and the format-specific edit window
  with cursor marker — all built from VS Code's API, no Python child
  process.
- **Cache-friendly section order.** The workspace-rules pseudo-section
  is emitted first (session-stable), then volatile context (broad
  view, retrieval, recent-changes), with diagnostics last so they sit
  immediately before the edit window. The longest-stable prompt
  prefix maps to a longer prefix-cache hit on backends that support
  it (vLLM, sglang, llama.cpp `--cache-prompt`).
- **Outgoing-prompt + token-usage trace.** Set the NESweep output
  channel to `Trace` (`Developer: Set Log Level… → NESweep`) to log
  the full request prompt and the response — useful for confirming
  what the model actually sees.

### Prompt shaping

- **`diagRadius=12`.** VS Code hands every diagnostic on the file to
  the prompt; this filter drops entries whose `Line N:` is more than
  ±N from the cursor.
- **`broadBefore=125 / broadAfter=75`.** Asymmetric trim of the
  leading `<|file_sep|>{path}` broad-context section, biased behind
  the cursor. The `original/current/updated` edit window is
  unaffected.
- **Cascading-error filter.** When the cursor line itself has an
  error-severity diagnostic, every diagnostic *below* the cursor is
  dropped before it reaches the prompt. clangd / tsserver routinely
  emit "expected ;" / "undeclared identifier" swarms downstream of a
  single root-cause typo; suppressing them focuses the model on the
  real fix.
- **Diagnostic message normalisation.** Built-in rewrites strip the
  IDE-internal `(fix|fixes available)` suffix and convert directive-
  style patterns (`did you mean 'X'?`, `consider using 'X'`,
  `replace with 'X'`) into `use 'X' instead`. Additional rewrites are
  user-configurable (see `sweep.diagnosticsMessageTransforms` —
  presets cover common clang / clang-tidy patterns: magic numbers,
  unused includes, uninitialised variables, narrowing conversions).
- **Reject `finish_reason=length`.** A truncated response gives a
  corrupt line-diff (window tail no longer matches the model output),
  so we drop it instead of producing a destructive edit.

### Multi-region edits (zeta-2.1)

When the model is `zed-industries/zeta-2.1` (or any name containing
`zeta-2.1`/`zeta2.1`/`zeta-2-1`/`zeta_2_1`), the prompt builder packs
up to **3 editable regions** into one request:

- **Primary region** — the cursor's ±15-line window, always present
  and emitted first in the response so the editor renders it as
  ghost text.
- **Up to two diagnostic regions** — small ±2-line windows around the
  closest in-radius diagnostics that fall *outside* the primary
  region. Overlapping regions are merged.

Each region is wrapped in `<|marker_{2k-1}|>` / `<|marker_{2k}|>`. The
response parser is lenient about model-side quirks: missing close
markers (model emits its native EOS instead of `<|marker_2|>`) treat
content-to-EOF as the replacement; stray internal markers
(multi-region hallucinations on a single-region request) are stripped
globally; mismatched-numbered pairs are dropped.

Replacements for secondary regions surface as queued jump-edit
decorations alongside the primary ghost text — same UI primitives the
extension already uses for sweep's queued suggestions.

### Edit-window post-processing

- **Line-diff trim.** The model usually re-emits the whole edit window
  with one or two lines changed. We compute the longest common prefix
  and suffix of the new vs. old window lines and return only the
  changed middle as the edit. Insertions splice in with a trailing
  `\n`; deletions gobble the trailing newline of the last removed line.
- **Cursor anchoring.** When the replacement starts before the cursor
  on the line that contains the cursor, the start is anchored to the
  cursor and the matching pre-cursor prefix is stripped from the
  completion, so accepting cleanly rewrites the line tail instead of
  inserting at the cursor and leaving the original tail in place.
- **Auto-retrigger after accept.** VS Code does not auto-fire the
  inline-completion provider for the text change that an accept itself
  applies, so after every accept we call
  `editor.action.inlineSuggest.trigger` to keep the next-edit loop
  alive.

### Workspace rules

- **`.vscode/nes-<languageId>.md`** — workspace-local rules.
  `<languageId>` is VS Code's document language id (`cpp`, `lua`,
  `javascript`, `typescript`, `python`, …), so e.g. a `.h` file
  resolves to `nes-cpp.md` alongside `.cpp`. The body is wrapped in
  the language's single-line comment syntax (`//`, `--`, `#`) and
  emitted as the **first** pseudo-section in the prompt
  (`<|file_sep|>context/rules` for sweep,
  `<filename>context/rules` for zeta2). File reads are mtime-cached,
  so editing a rules file picks up on the next keystroke without
  reloading the window.

### Inline-diagnostics mega-hack (`sweep.injectInlineDiagnostics`)

Off by default. Recommended for the small SweepAI checkpoints (0.5B
and 1.5B), which routinely ignore the structured diagnostics block
entirely. The 7B SweepAI default and 8B Zeta2 SeedCoder don't need it.

When on, the prompt builder appends a comment to every nearby
diagnosed line in the rendered prompt only:

```cpp
psdlog::info("hi"); // BUG: LSP error here (code: undeclared_var_use_suggest) - use 'spdlog' instead (Use of undeclared identifier 'psdlog')
```

The marker phrase is configurable via `sweep.inlineDiagnosticsMarker`
(default `BUG: LSP error here`); the response-side strip anchors on
the literal `<commentPrefix> <marker>` substring, so it survives the
model paraphrasing the rest of the comment. Original `prompt.lines`
stay untouched, so byte-mapping in the response builder is unaffected.

When inline injection is on, the structured diagnostics section is
suppressed (the inline comments already carry the same info, no need
to duplicate).

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `sweep.serverUrl` | `http://localhost:8080` | `/v1/completions` base URL |
| `sweep.modelName` | `sweepai/sweep-next-edit` | `model` field in the request body; substring-matched to pick the prompt format |
| `sweep.completionTimeoutMs` | `10000` | Per-request timeout (ms) |
| `sweep.diagRadius` | `12` | ±N lines around cursor; `0` disables |
| `sweep.broadBefore` | `125` | Lines of broad context before cursor |
| `sweep.broadAfter` | `75` | Lines of broad context after cursor |
| `sweep.injectInlineDiagnostics` | `false` | Mega-hack: inline `BUG:` comments next to diagnosed lines (recommended for 0.5B / 1.5B sweep) |
| `sweep.inlineDiagnosticsMarker` | `BUG: LSP error here` | Marker phrase used by the inline injection + response-side strip anchor |
| `sweep.diagnosticsMessageTransforms` | clang preset | Object of `{regex: replacement}` rewrites applied to every diagnostic message after the built-in normalisations |

## Setup

Run any supported edit-prediction GGUF behind an OpenAI-compatible
`/v1/completions` server. Examples with llama.cpp:

```sh
# Sweep next-edit (default; 7B works without the inline-diagnostics hack)
llama-server -hf sweepai/sweep-next-edit-7b-gguf --ctx-size 32768

# Sweep 1.5B (smaller, faster — turn on sweep.injectInlineDiagnostics)
llama-server -hf sweepai/sweep-next-edit-1.5b-gguf --ctx-size 32768

# Zeta-2 (Zed's SeedCoder-8B, single-region)
llama-server -hf bartowski/zed-industries_zeta-2-GGUF --ctx-size 16384

# Zeta-2.1 (Zed's SeedCoder-8B, multi-region)
llama-server -hf bartowski/zed-industries_zeta-2.1-GGUF --ctx-size 16384
```

Then point `sweep.modelName` at the right name. Detection rules:

- `zeta-2.1` / `zeta2.1` / `zeta-2-1` / `zeta_2_1` → Zeta-2.1 multi-region
- `zeta2` / `zeta-2` / `seedcoder` → Zeta-2 single-region
- everything else → sweep `<|file_sep|>` layout

Sweep's GGUF advertises 32k natively; the full prompt (broad context +
retrieval + diagnostics + diff history + edit window) routinely runs
15–20k tokens for non-trivial files, so a smaller `--ctx-size`
truncates real prompts. Zeta2 / 2.1's editable regions are much
tighter (±15 lines around cursor + tiny ±2-line halos for diagnostic
regions on 2.1), so those prompts are smaller.

Build & install the extension:

```sh
bun install
bun run build
bunx @vscode/vsce package --no-dependencies --skip-license
code --install-extension nesweep-*.vsix --force
```

## Credits

- Original [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
  by [SweepAI](https://github.com/sweepai).
- Sweep prompt format ported from
  [cursortab.nvim](https://github.com/cursortab/cursortab.nvim).
- Zeta-2 / Zeta-2.1 model card: [zed-industries on Hugging Face](https://huggingface.co/zed-industries).

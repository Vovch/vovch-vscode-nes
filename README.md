## Sweep Next Edit Suggestion for VSCode

<img width="563" height="327" alt="image" src="https://github.com/user-attachments/assets/9a06ed4a-bf9b-41e0-a21b-2178cb2c67b9" />

## Fork changes

This fork retargets the extension at a local Ollama running the sweep
GGUF, removing the upstream `uvx sweep-autocomplete` Python child
process (which falls back to CPU and is unusable for next-edit
latency).

The sweep prompt format (broad context, retrieval, diagnostics, diff
history, and the `original/current/updated` triplet with cursor marker
and prefill) is ported from
[cursortab.nvim](https://github.com/cursortab/cursortab.nvim)'s sweep
provider. Everything else listed below is new in this fork.

### Backend

- **Ollama, not the Python server.** The extension talks directly to
  Ollama's native `/api/generate` endpoint. Ollama's OpenAI-compat
  `/v1/completions` layer silently drops `options.num_ctx` and
  `keep_alive`, so the model would load with the host default and a
  4-minute idle timer regardless of what we sent. Field mapping:
  `max_tokens → options.num_predict`,
  `temperature/stop/num_ctx → options.*`, `keep_alive` top-level.
- **Sweep prompt built in TypeScript.** Broad file context, retrieval
  (open editors + LSP definitions/usages + clipboard), diagnostics,
  recent-changes diff history, and the `original/current/updated`
  triplet with cursor marker and prefill — all assembled directly from
  VSCode's API.
- **Eval-count log.** Each completion logs `prompt_eval_count` /
  `eval_count` to the Extension Host so it's easy to confirm prompts
  fit inside `num_ctx`.

### Prompt shaping

- **`num_ctx=32768` default.** Matches sweep's GGUF native context.
- **`diagRadius=12`.** VSCode hands every diagnostic on the file to the
  prompt; this filter drops entries whose `Line N:` is more than ±N
  from the cursor.
- **`broadBefore=125 / broadAfter=75`.** Asymmetric trim of the leading
  `<|file_sep|>{path}` broad-context section, biased behind the cursor.
  The `original/current/updated` edit window is unaffected.
- **Reject `finish_reason=length`.** A truncated response gives a
  corrupt line-diff (window tail no longer matches the model output),
  so we drop it instead of producing a destructive edit.

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
- **Auto-retrigger after accept.** VSCode does not auto-fire the
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
  emitted as a sibling section
  `<|file_sep|>context/rules\n…` placed right before the
  `original/current/updated` triplet, alongside `context/retrieval` /
  `context/diagnostics`. File reads are mtime-cached, so editing a
  rules file picks up on the next keystroke without reloading the
  window.

### Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `sweep.ollamaUrl` | `http://localhost:11434` | Ollama base URL |
| `sweep.modelName` | `sweepai/sweep-next-edit` | Model alias |
| `sweep.numCtx` | `32768` | `options.num_ctx` |
| `sweep.keepAlive` | `30m` | Ollama idle-unload timer |
| `sweep.completionTimeoutMs` | `60000` | Per-request timeout (ms) |
| `sweep.diagRadius` | `12` | ±N lines around cursor; `0` disables |
| `sweep.broadBefore` | `125` | Lines of broad context before cursor |
| `sweep.broadAfter` | `75` | Lines of broad context after cursor |

### Setup

```sh
ollama pull sweepai/sweep-next-edit
```

The model name matches `sweep.modelName`'s default, so no aliasing is
needed.

Build & install the extension:

```sh
bun install
bun run build
bunx @vscode/vsce package --no-dependencies --skip-license
code --install-extension sweep-nes-*.vsix --force
```

## Sweep Next Edit Suggestion for VSCode

<img width="563" height="327" alt="image" src="https://github.com/user-attachments/assets/9a06ed4a-bf9b-41e0-a21b-2178cb2c67b9" />

## Fork changes

This fork retargets the extension at a local Ollama running the sweep
GGUF, removing the upstream `uvx sweep-autocomplete` Python child process
(which falls back to CPU and is unusable for next-edit latency). The sweep
prompt builder, post-processor, and rules layer are ported from
[cursortab.nvim](https://github.com/cursortab/cursortab.nvim)'s sweep
provider.

### Backend

- **Ollama, not the Python server.** The extension talks directly to
  Ollama's native `/api/generate` endpoint. Ollama's OpenAI-compat
  `/v1/completions` layer silently drops `options.num_ctx` and
  `keep_alive`, so the model would load with the host default
  (often 32k via `OLLAMA_CONTEXT_LENGTH`) and a 4-minute idle timer
  regardless of what we sent. Field mapping mirrors cursortab-proxy:
  `max_tokens → options.num_predict`, `temperature/stop/num_ctx →
  options.*`, `keep_alive` top-level.
- **Sweep prompt built in TypeScript.** Broad file context, retrieval
  (open editors + LSP definitions/usages + clipboard), diagnostics,
  recent-changes diff history, and the
  `original/current/updated` triplet with cursor marker and prefill —
  all assembled directly from VSCode's API instead of a Python service.
- **Eval-count log.** Each completion logs `prompt_eval_count` /
  `eval_count` to the Extension Host so it's easy to confirm prompts
  fit inside `num_ctx`.

### Prompt shaping (context-overflow guards)

- **`num_ctx=32768` default.** Sweep's GGUF is 32k natively. Pinning
  8k truncates real prompts and yields delete-only completions.
- **`diagRadius=12`.** VSCode hands every diagnostic on the file to the
  prompt; this trim drops entries whose line is more than ±N from the
  cursor (chatty linters otherwise dominate the prompt).
- **`broadBefore=125 / broadAfter=75`.** Asymmetric trim of the leading
  `<|file_sep|>{path}` broad-context section, biased behind the cursor
  where prediction-relevant context typically lives. Cursortab hardcodes
  ±150. The original/current/updated edit window is unaffected.
- **`MAX_TOKENS=2048` + reject `finish_reason=length`.** Without
  cursortab's anchor-based truncation logic, a truncated response yields
  a corrupt line-diff (window tail no longer matches the model output),
  so we drop it instead of producing a destructive edit.

### Edit-window post-processing

- **Line-diff trim.** The model usually re-emits the whole edit window
  with one or two lines changed. Without trimming, VSCode would draw a
  giant ghost overlay even though most of it is identical to what's
  already there. We compute the longest common prefix and suffix of the
  new vs. old window lines and return only the changed middle as the
  edit. Insertions splice in with a trailing `\n`, deletions gobble the
  trailing newline of the last removed line.
- **Cursor anchoring.** When the replacement starts before the cursor
  on the line that contains the cursor, we pre-anchor `startIndex` to
  the cursor and strip the matching pre-cursor prefix from the
  completion ourselves. Otherwise `InlineEditProvider.normalizeInlineResult`
  collapses `endIndex` onto the cursor while auto-trimming the prefix,
  leaving the original line's tail (e.g. a stray `)`) behind.
- **Auto-retrigger after accept.** VSCode does not auto-fire the
  inline-completion provider for the text change that an accept itself
  applies, so without an explicit trigger we got exactly one suggestion
  per editing session. After every accept we now call
  `editor.action.inlineSuggest.trigger`, mirroring cursortab.nvim.

### Workspace rules

- **`.vscode/nes-<ext>.md`** — workspace-local rules, no global merge.
  `<ext>` is the source file's extension (`cpp`, `lua`, `js`, `ts`,
  `py`, …). The body is wrapped in the language's single-line comment
  syntax (`//`, `--`, `#`) and injected as a sibling section
  `<|file_sep|>context/rules\n…` right before the
  `original/current/updated` triplet — the same placement
  cursortab-proxy uses. Splicing rules into the broad-context section
  would let the model treat them as drift versus the pristine code in
  the edit window and try to add them to the output, breaking the
  line-diff. File reads are mtime-cached so editing a rules file
  picks up on the next keystroke without reloading the window.

### Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `sweep.ollamaUrl` | `http://localhost:11434` | Ollama base URL |
| `sweep.modelName` | `sweepai/sweep-next-edit` | Model alias |
| `sweep.numCtx` | `32768` | `options.num_ctx` |
| `sweep.keepAlive` | `30m` | Ollama idle-unload timer |
| `sweep.completionTimeoutMs` | `60000` | Cold load with 32k ctx can take 20–40s |
| `sweep.diagRadius` | `12` | ±N lines around cursor; `0` disables |
| `sweep.broadBefore` | `125` | Lines of broad context before cursor |
| `sweep.broadAfter` | `75` | Lines of broad context after cursor |

### Setup

```sh
ollama pull hf.co/sweepai/sweep-next-edit-1.5b
# (optional) alias to match the default sweep.modelName:
#   ollama cp hf.co/sweepai/sweep-next-edit-1.5b sweepai/sweep-next-edit
```

Build & install the extension:

```sh
bun install
bun run build
bunx @vscode/vsce package --no-dependencies --skip-license
code --install-extension sweep-nes-*.vsix --force
```

## 1. Configuration

- [x] 1.1 Add `decisionThinkingCapExclude` to `ContinueWatchdogConfig`, `BUILT_IN_CONFIG` (default `claude-3`, `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4`, `gpt-5`, `/o1`, `/o3`, `/o4-`), `KNOWN_KEYS`, `copyBuiltIn`, validation (array of trim-nonblank strings, stored trimmed and lowercased; `[]` valid) and merge in `src/config.ts`. Update test fixtures that build a full config. Verify with `test/config.test.ts` cases: default list; project `[" My-Gateway/ "]` and `[]` replace global `["gpt-5"]`; `"gpt-5"`, `[""]`, `["  "]` and `["ok", 1]` are diagnosed and keep `["gpt-5"]`.

## 2. Skip rule

- [x] 2.1 Add a pure `skipsThinkingCap(model, exclude)` in `src/config.ts`: true when lowercase `provider/id` contains any entry, or when `api` is `anthropic-messages`/`openai-responses` without `compat.supportsMidConvoEffort === true`, or when `api` is `azure-openai-responses`/`openai-codex-responses`. Verify with a table test covering: blacklisted `anthropic/claude-opus-4-1`; `openai-responses` with `compat` null; `openai-codex-responses` with compat true; `anthropic-messages` and `openai-responses` with compat true (not skipped); `openai-completions` (not skipped); an empty list.
- [x] 2.2 In `startPrivateDecision` (`src/runtime.ts`), use the cap `inherit` when `skipsThinkingCap(ctx.model, config.decisionThinkingCapExclude)` holds; otherwise use `config.decisionThinkingCap`. Verify with `test/runtime.test.ts`: the fake model (`fake/local`, `openai-completions`-like API) stays capped at `medium` for `high`; a harness model with a blacklisted id, or `openai-responses` without compat, keeps `high`.

## 3. Documents

- [x] 3.1 Update `README.md` (replace the "Thinking cap and prompt cache" note with the per-model rule and the two guards; add `decisionThinkingCapExclude` to the example and key table) and `docs/behavior-contract.md` (fork paragraph and key table). Verify with `rg -n 'for example Anthropic' README.md docs` finding nothing.
- [x] 3.2 Update `docs/programming-thinking/official-pi-idle-inquiry.idea.lean`: add `skipThinkingCap : Bool` to `Setup`, pass the effective cap (`"inherit"` when skipped) to `fullFork`, and prove that a skipped setup keeps `source.thinking`. Verify that `lean` compiles the file and that no `sorry`/`axiom` is used.

## 4. Integration check

- [x] 4.1 Run `npm run check` and verify that it passes.
- [x] 4.3 Add packed e2e wire checks in `test/e2e/packed.test.ts` (reasoning `openai-completions`: default cap → `medium`, excluded and `inherit` → `high`; minimal Responses SSE mock: mid-conversation compat keeps request-level effort fixed and sends a `medium` `configuration_update`, null compat sends request-level `high`). Verify that `npm run test:e2e` passes and that the excluded/null-compat cases fail with the skip rule removed.
- [x] 4.2 Run `openspec validate exclude-cache-sensitive-thinking-cap --strict` and verify that it passes.

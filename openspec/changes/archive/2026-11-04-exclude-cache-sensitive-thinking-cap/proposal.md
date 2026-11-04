## Why

The private decision thinking cap saves cost only when lowering the level keeps the inherited conversation's prompt cache. pi keeps the cache only on the paths where it carries effort mid-conversation (OpenAI GPT-6 `configuration_update`, Anthropic per-message effort): `openai-responses` or `anthropic-messages` with `compat.supportsMidConvoEffort === true`. Elsewhere it changes request-level effort, and OpenAI and Anthropic document that this invalidates the cached prefix. Old models and gateways without the compat flag (for example a Claude 5.5 model through an `openai-responses` gateway with `compat: null`) can therefore pay full price for the whole inherited context.

## What Changes

- The cap is skipped, and the child uses the main session's level unchanged, when either:
  - the lowercase `provider/id` contains an entry of the new `decisionThinkingCapExclude` list; or
  - the model API is `anthropic-messages`, `openai-responses`, `azure-openai-responses` or `openai-codex-responses` and pi will not carry effort mid-conversation for it (only `anthropic-messages`/`openai-responses` with `compat.supportsMidConvoEffort === true` qualify).
- New configuration key `decisionThinkingCapExclude`: an array of nonblank strings, matched case-insensitively as substrings. Default: `claude-3`, `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4`, `gpt-5`, `/o1`, `/o3`, `/o4-`. A valid list replaces the default; `[]` disables the blacklist.
- README and behavior contract: replace the "for example Anthropic" cache note with the per-model rule and the two guards.
- **BREAKING** (default behavior): models matching the default blacklist, or using those APIs without mid-conversation effort, are no longer capped.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog-private-fork-decisions`: the fork thinking requirement adds the cache-sensitive skip conditions.
- `watchdog-configuration`: add `decisionThinkingCapExclude` to the effective configuration keys.

## Non-goals

- Detecting ChatGPT sign-in credentials on `openai-responses` (pi refuses `configuration_update` there; the plugin cannot see the credential type).
- Cache rules for other APIs (`openai-completions`, Google, Bedrock, Mistral); they stay capped unless blacklisted.
- Measuring gateway cache behavior at runtime.

## Impact

- Code: `src/config.ts` (new key, default list, skip rule), `src/runtime.ts` (pass the selected model to the rule).
- Tests: `test/config.test.ts`, `test/runtime.test.ts`, and fixtures that build a full config.
- Docs: `README.md`, `docs/behavior-contract.md`, Lean model `docs/programming-thinking/official-pi-idle-inquiry.idea.lean`.

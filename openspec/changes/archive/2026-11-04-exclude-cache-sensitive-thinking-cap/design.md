## Context

`startPrivateDecision` (`src/runtime.ts`) builds the fork model string as `provider/id:capThinkingLevel(mainLevel, decisionThinkingCap)`. `ctx.model` is a pi-ai `Model` with `provider`, `id`, `api` and optional `compat`.

Evidence for the rule:
- OpenAI prompt-caching guide: request-level `reasoning.effort` "can change model-side reasoning instructions" in the hidden system message, which comes before everything else. GPT-6 `configuration_update` input items change effort while preserving the prefix.
- Anthropic prompt-caching docs: changing thinking parameters or `output_config.effort` invalidates message blocks. On models with per-message effort, a change carried in a `role: "system"` message inside `messages` leaves the prefix intact.
- pi-ai: only `api/openai-responses.js` and `api/anthropic-messages.js` read `compat.supportsMidConvoEffort`. When it is true they keep the request-level effort fixed and carry the level in messages. Every other path, and OpenAI with ChatGPT sign-in, sends request-level effort.
- The user's current `openai-api-extension/claude-opus-5-5` model is `openai-responses` with `compat: null`, so a name-only rule would cap it and lose the cache.

## Goals / Non-Goals

**Goals:**
- One pure predicate `skipsThinkingCap(model, exclude)`. A skip is equivalent to `inherit` for that decision.
- A built-in default blacklist that users can replace through configuration.

**Non-Goals:**
- Credential-type detection, runtime cache measurement, and rules for other APIs (see the proposal's Non-goals).

## Decisions

1. **Two guards, OR-ed.** The blacklist catches old models on any API, including gateways that set compat incorrectly. The compat guard catches models that have new-style names but run on non-mid-conversation paths. Either guard alone misses one of these cases.
2. **The compat guard covers only Responses/Messages-family APIs.** These are the paths where pi's behavior is known from source: `anthropic-messages`/`openai-responses` qualify only when `supportsMidConvoEffort === true`; `azure-openai-responses`/`openai-codex-responses` never carry mid-conversation effort. Other APIs have no evidence either way, so the cap still applies to them, and the blacklist is the user's lever there.
3. **Substring on lowercase `provider/id`.** Gateways prefix ids (`anyrouter/claude-opus-4-1`). Including the provider lets users exclude a whole gateway (`my-gateway/`). A leading `/` in a default entry (`/o3`) anchors it to an id segment start, so `o3` does not match inside unrelated ids. The trade-off: `gpt-5` matches only GPT-5.x and not GPT-6; ids that don't follow official naming are not caught.
4. **Validation mirrors `reasonTypes`.** Entries are trimmed, nonblank and lowercased at load time. A valid list replaces the default. `[]` is valid and disables the blacklist (the compat guard still applies). Invalid input keeps the lower-precedence value.
5. **Skip reduces to `inherit`.** The runtime computes the effective cap (`inherit` when skipped), then calls the existing `capThinkingLevel`. In the Lean model, `Setup` gains a `skipThinkingCap` flag, and `fullFork` receives the effective cap, so the existing "never raises" theorem still holds.

## Risks / Trade-offs

- [ChatGPT sign-in on `openai-responses` with compat `true` still loses the cache] → It is documented. Workaround: exclude the model or set `inherit`.
- [A blacklisted name can be a model that actually keeps the cache through a proper gateway] → The user replaces the list. Over-skipping only costs the reasoning savings; it never raises cost.
- [Default list staleness as new models ship] → New models are expected to support mid-conversation effort and so need no entry. The list only names known old families.
- [Default behavior changes for matching models] → Marked BREAKING. Setting `decisionThinkingCapExclude: []` disables the blacklist part (the compat guard remains).

## Migration Plan

No data migration. Rollback: revert the change. There is no config switch that restores capping on compat-unsafe APIs, by design.

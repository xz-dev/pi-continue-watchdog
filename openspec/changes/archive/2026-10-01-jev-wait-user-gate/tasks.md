## 1. Configuration

- [x] 1.1 Add the `jevWaitCheck` section (`enabled`, `apiUrl`, `model`, `confidenceThreshold`, `timeoutMs`, global-only `apiKey`) to `src/config.ts` with per-field validation and warning diagnostics. A project-layer `apiKey` must be ignored with a diagnostic. Verify with new cases in `test/config.test.ts`: defaults, invalid threshold keeps the lower layer, project `apiKey` rejected, `enabled: false`.

## 2. Gate module

- [x] 2.1 Create `src/jev-wait-gate.ts` with key and endpoint resolution: explicit `apiUrl` chain; otherwise TypeSafe then OpenRouter, each trying Pi registry, then env, then global `apiKey`; lookup errors mean no key. Verify with `test/jev-wait-gate.test.ts` using a fake registry and env.
- [x] 2.2 Add `classify(text, opts)`: one Choice request with an injected `fetch`, key redaction, a timeout plus lifecycle abort, and parsing into `{ waiting: boolean, confidence }` or a failure. Verify that tests cover waiting, not_waiting, unclear, HTTP error, malformed body, non-finite confidence, timeout, and that the sent body has no key.
- [x] 2.3 Add `buildJevReason(text)`: last paragraph split on blank lines, the fixed prefix, and a 1000-code-point cap that keeps the tail with a leading ellipsis. Verify tests for a short paragraph, an over-length paragraph (length ≤ 1000, the tail kept), and a multi-byte/surrogate-safe cut.

## 3. Runtime integration

- [x] 3.1 In `qualifyReady`, after the final re-check, read the latest assistant entry of the branch. If the gate is active, the key resolves, the message ended normally with non-blank text, and its id is not already classified, await `classify`. Otherwise dispatch as before. Verify runtime tests: no key means an unchanged continuation with zero fetch calls; a text-less final message makes zero fetch calls; the same message id is classified at most once.
- [x] 3.2 After the await, re-check ownership, the aggregate generation, the grace phase, fresh idle, the lock, and `localActivityGeneration`; drop the verdict on any change. Verify runtime tests: a new turn started during the request, a user message during the request, and a manual unlock during the request each produce neither a continuation nor an unlock.
- [x] 3.3 Add `applyJevUnlock`, which reuses the AI unlock state changes (`recordAiUnlock`, `pendingUnlock` with `AI_UNLOCK`/`WAIT_USER`/reason, the generation bump, `observeAggregate`) plus a UI notify. Verify runtime tests: a confident waiting verdict yields no continuation, an unchanged attempt count, and exactly one `user-ready` with the expected values after aggregate idle; low confidence or not-waiting yields exactly one continuation.
- [x] 3.4 Abort any in-flight gate request on shutdown or session switch. Verify with a runtime test that shutdown during the request neither dispatches nor unlocks.

## 4. Docs and model

- [x] 4.1 Update `README.md` (feature, key sources, config table, privacy note), `docs/architecture.md` (the gate step in the flow and the module map), and `docs/behavior-contract.md`. Verify by reading the docs against spec.md.
- [x] 4.2 Update `docs/programming-thinking/official-pi-idle-inquiry.idea.lean` to model the gate: fail-open, a stale verdict dropped, a confident verdict unlocking without an attempt. Verify that it builds and its checks pass with the repo's Lean command.

## 5. Verification

- [x] 5.1 Run `npm run check` (lint, typecheck, test, build) and confirm it passes.
- [x] 5.2 Manual smoke with a real TypeSafe key: end a turn with a clear question and see the Pi Wait notification with the jev reason. End a turn with a status report and see the normal continuation.

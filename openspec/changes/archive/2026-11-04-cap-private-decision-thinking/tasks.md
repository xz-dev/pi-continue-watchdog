## 1. Configuration

- [x] 1.1 Add `decisionThinkingCap` to `ContinueWatchdogConfig`, `BUILT_IN_CONFIG` (default `"medium"`), `KNOWN_KEYS` and `copyBuiltIn` in `src/config.ts`. Validate it as an exact string in `inherit | off | minimal | low | medium | high | xhigh | max`, emit a diagnostic for invalid values, and merge it with existing layer precedence. Verify with new `test/config.test.ts` cases: default `medium`; project `inherit` overrides global `low`; `High`, `" medium"`, `none`, `true` and a number are diagnosed and keep the lower-precedence value.

## 2. Child thinking cap

- [x] 2.1 Add a pure mapping `(parentLevel, cap) -> childLevel` with the ordered level list. `inherit`, a parent at or below the cap, or an unknown parent level returns the parent level; otherwise it returns the cap. Verify with a table-driven unit test covering every known parent level under `medium`, `inherit` and `off`, plus an unknown parent level.
- [x] 2.2 Use the mapping only in the private-decision fork model string in `startPrivateDecision` (`src/runtime.ts`), with `config.decisionThinkingCap`. Leave `sourceThinking` and `sourceCurrent()` on the uncapped main level. Verify that `test/runtime.test.ts` asserts `forkInputs[0].model` ends with `:medium` for a `high` parent and with `:off` for an `off` parent, and that changing the main level mid-decision still invalidates the decision.
- [x] 2.3 Update `test/private-runtime.test.ts` ("full effective fork ... selected thinking", parent `high`). The child gets `medium` under the default cap, and a variant with `inherit` keeps `high`. Verify that `npm run test` passes.

## 3. Contract documents

- [x] 3.1 Update `README.md` and `docs/behavior-contract.md` (lines stating "same ... thinking") to describe the capped level, the `decisionThinkingCap` key and its default, and the Anthropic prompt-cache trade-off with `inherit` as the escape hatch. Verify that `rg -n 'same selected provider/model and thinking|provider/model and thinking' README.md docs` finds no stale claims.
- [x] 3.2 Update `docs/programming-thinking/official-pi-idle-inquiry.idea.lean`: add the level order and the cap function, and change `full_fork_preserves_effective_source` so that `fork.thinking = capThinking source.thinking cap`. Add a theorem that the cap never raises the level. Verify that the file compiles with `lean` and has no `sorry`/`axiom`.

## 4. Integration check

- [x] 4.1 Run `npm run check` (lint, typecheck, test, build) and verify that it passes.
- [x] 4.2 Run `openspec validate cap-private-decision-thinking --strict` and verify that it passes.

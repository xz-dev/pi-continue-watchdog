## 1. Decision Prompt Classification

- [x] 1.1 Add concise ordered outcome-selection guidance to `buildDecisionPrompt`, including WAIT_USER priority, external-wait distinction, immediate-executable-action requirement, and the unfinished-work prohibition; verify focused prompt tests assert every rule and unchanged XML shape
- [x] 1.2 Preserve configured `reasonTypes` and `continueReasonTypes` list rendering and existing examples without adding config or parser behavior; verify mixed custom-list tests pass

## 2. Provider-Facing Regression Coverage

- [x] 2.1 Add a packed E2E scenario where ordinary output requests explicit production approval and the next decision request contains the ordered WAIT_USER guidance; verify the mock decision returns WAIT_USER without an intervening continuation turn
- [x] 2.2 Verify independent requested and authorized work remains eligible for continue by asserting prompt guidance requires naming the immediately executable action rather than the user-blocked action
- [x] 2.3 Run focused decision-protocol and packed tests, intentionally break one classification phrase to prove the regression assertions fail, then restore it and verify green

## 3. Documentation and Formal Process

- [x] 3.1 Update behavior-contract and architecture documentation with the ordered decision policy and examples for approval-gated, external-wait, immediately actionable, completed, and other-blocked work; verify text matches tested prompt semantics
- [x] 3.2 Update the affected `docs/programming-thinking/*.idea.lean` model to express mutually exclusive outcome guards and WAIT_USER priority, then verify Lean typecheck, execution, accepted axioms, and independent semantic round trip

## 4. Full Validation

- [x] 4.1 Run `npm run check` and `npm run test:e2e`; verify lint, typecheck, unit, build, packed, and cross-process suites pass without changing parser or continuation-envelope behavior

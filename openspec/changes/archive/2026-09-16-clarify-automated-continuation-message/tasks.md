## 1. Canonical Continuation Content

- [x] 1.1 Add a pure formatter that combines fixed extension attribution, non-authorization language, serialized accepted reason type/content, configured continuation guidance, and the stop-at-user-boundary instruction; verify focused unit tests cover exact output and escaping
- [x] 1.2 Preserve existing `continuePrompt` validation and configuration precedence while documenting it as embedded guidance; verify config tests pass for built-in, global, and trusted-project values

## 2. Runtime and Context Integration

- [x] 2.1 Format the canonical continuation body from the normalized accepted continue result before creating the inquiry fold replacement; verify runtime tests observe the accepted reason and configured guidance in the sent continuation
- [x] 2.2 Keep existing inquiry correlation, terminal fold metadata, cleanup, and resume behavior intact while replacing only continuation content; verify context-fold tests cover complete exchanges and persisted messages
- [x] 2.3 Strengthen provider-facing conversion coverage to assert the custom continuation becomes a user-role message whose body still denies user attribution and authorization; verify the focused context-fold test passes

## 3. End-to-End Safety and Compatibility

- [x] 3.1 Add a regression scenario with an unresolved approval request followed by automatic continuation; verify provider payload contains explicit non-approval language and no implied user consent
- [x] 3.2 Update packed and cross-process resume tests to verify reason propagation and confirm raw watchdog prompt, XML answer, audit data, and fold markers remain absent from later provider payloads
- [x] 3.3 Verify custom `continuePrompt` text remains present verbatim inside the fixed wrapper and existing stored fold messages remain compatible through targeted runtime/context tests

## 4. Documentation and Validation

- [x] 4.1 Update behavior-contract and architecture documentation with exact continuation-envelope semantics and configuration compatibility; verify documented wording matches tested canonical output
- [x] 4.2 Run `npm run check` and `npm run test:e2e`; verify all lint, typecheck, unit, build, packed, and cross-process checks pass

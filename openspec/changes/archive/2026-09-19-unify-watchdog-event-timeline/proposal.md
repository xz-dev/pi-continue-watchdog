## Why

The watchdog currently gives humans visible result entries while reconstructing a separate, timestamp-free history for the model. Repeated timed waits exposed this mismatch: the scheduler honors deadlines, but subsequent decisions lack explicit elapsed-time facts and ordinary work does not see the same result timeline as the user.

## What Changes

- Publish accepted automatic continue, wait, and AI-unlock results, plus decision failure and retry exhaustion, as shared human/model events with identical canonical text and explicit RFC 3339 time-zone offsets.
- Preserve a wait's acceptance time, requested duration, and deadline; at the next eligible inquiry, show and prepend the same factual wake summary containing the requested duration, observed elapsed duration, start, and wake time.
- Keep event bodies immutable. Use normal active-branch conversation history and Pi compaction rather than constructing a second watchdog-only history.
- Remove the new-event path's dependency on `src/decision-history.ts`, zero-loop scanning, normalized-history reinjection, and duplicate TUI-only result records. Retain exact inquiry correlation and internal exchange cleanup.
- **BREAKING**: newly emitted automatic watchdog results become ordinary context-bearing history instead of TUI-only records. The rendered result format gains timestamps, and continuation guidance/source attribution becomes human-visible as well as model-visible.
- Preserve XML parsing, reason bounds, authorization boundaries, shared retry accounting, wait deadlines, main ownership, cancellation/user takeover, and existing semantic-hook names and values. Do not add forced verification, background-task probes, or a new stall policy.
- Read old sessions without rewriting them or inventing missing timing data. Do not rehydrate pre-upgrade TUI-only records into model history.

## Capabilities

### New Capabilities

- `watchdog-event-timeline`: canonical shared automatic-result events, timestamp semantics, wait completion records, active-branch/resume/compaction behavior, and removal of special history reconstruction.

### Modified Capabilities

- `automated-continuation-message`: make the attributed continuation envelope the same timestamped event body that humans see, preserving effective guidance and permission boundaries.
- `decision-response-contract`: prepend runtime-authored wait-completion facts to the next eligible inquiry without altering outcome selection or XML response rules.
- `watchdog-waiting-hook`: define durable shared wait-event publication, rather than an optional audit/TUI-only entry, as the waiting-hook prerequisite.

## Impact

- Implementation areas: `src/runtime.ts`, `src/context-fold.ts`, `src/commands.ts`, `src/controller.ts` and `src/decision-protocol.ts` where needed for wait timing; removal of `src/decision-history.ts` and its callers.
- Verification: existing unit/runtime/context-fold tests and packed provider-payload E2E. Compare TUI text and provider text, test time facts with an injected clock, and retain cancellation, exhaustion, and failure coverage. Tests prove transport and timing contracts, not model judgment.
- Documentation: update `README.md`, `docs/architecture.md`, `docs/behavior-contract.md`, and affected `docs/programming-thinking/*.idea.lean` during implementation; main OpenSpec specs remain unchanged during proposal creation.
- Reuse Pi `CustomMessage` and existing inquiry utilities. No new dependency, configuration switch, external service, installed-plugin update, Git operation, or remote migration is required by this proposal.

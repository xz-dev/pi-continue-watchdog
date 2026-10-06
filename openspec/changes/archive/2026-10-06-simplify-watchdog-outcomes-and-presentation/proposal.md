## Why

Watchdog decisions currently publish verbose shared control messages: an unlock report appears in both the human transcript and model context, while a continuation's useful next action is buried as quoted historical data. The restored timed-wait branch also duplicates task-owned waiting and callback-driven workflows without being needed for the user's intended continue-or-stop behavior. Prompt optimization must also prevent already-granted permission or already-delivered work from being treated as missing, using the mature first function-generation's evidence checks rather than merely translating the old XML instructions into function syntax.

## What Changes

- Keep the stable reserved `cw` declaration and current exact inquiry/run/call authorization. Ordinary work must not be taught or allowed to call it proactively.
- Use the mature first function-generation, especially the exact-permission review semantics in `668b02b`, as the prompt behavior reference. Reconcile actual user instructions and successful human questionnaire answers before claiming a specific permission is missing; an assistant's own question is not proof of missing permission. Preserve existing scope, revocations, and genuinely unsatisfied confirmation requirements. Do not restore Jev, the old public callable tool, or a new permission-classification service.
- Prefer current delivery evidence over stale plans or watchdog reasons. An automated message adds no authorization and revokes no existing authorization; an already-delivered answer must not trigger another delivery-only turn.
- **BREAKING**: accept only `continue` and `unlock` decisions. Remove `action: "wait"`, `wait_seconds`, watchdog-owned wait deadlines, elapsed-wait events, and `watchdog-waiting` publication. Count only accepted, durably published continuations against `maxRetries`; retain the fixed idle fence, correction bound, cancellation, and terminal-error safeguards.
- Retain `WAIT_CALLBACK` as an unlock reason for an expected external wake-up. Do not synthesize callbacks, force callback-capable work into polling, or claim that elapsed time proves task completion.
- Present the accepted continuation reason as a clearly attributed Continue watchdog next-action hint rather than a quoted previous result. Preserve configured continuation guidance and the existing user-authorization boundary without disclosing the reserved-function protocol.
- Persist each successful AI unlock as one quiet, gray, UI-only status containing `unlocked`, its normalized reason type, and its reason. Do not show an inquiry, arguments, receipt, timestamp, message box, or authorization boilerplate in that status.
- Exclude finalized internal decision traffic and AI-unlock status from subsequent model input, including newly generated native compaction and branch-summary input. Preserve the active decision's executable call until dispatch. Verify host support rather than assuming `display: false` or the ordinary `context` hook provides this guarantee.
- Keep legacy records readable without rewriting sessions, restarting old actions, or pretending that already-generated summaries can be retroactively cleaned.

## Capabilities

### New Capabilities

- `decision-response-contract`: specify the narrowed, guarded two-outcome contract, continuation-only accounting, and evidence-first permission/delivery checks. This capability already exists in the completed but unsynchronized predecessor change; it is listed here as new relative to the current main-spec tree, not as a newly invented runtime subsystem.

### Modified Capabilities

- `automated-continuation-message`: action-oriented, extension-attributed continuation guidance that preserves existing permission, does not repeat delivered work, and contains no proactive control-function instructions.
- `watchdog-event-timeline`: separate continuation content from quiet UI-only unlock records; hide completed inquiry traffic and preserve context isolation across supported native history projections.
- `wait-callback-reason-type`: preserve decision-only callback unlocking without a timed-wait alternative.
- `watchdog-configuration`: make `maxRetries` continuation-only while preserving existing configuration keys, defaults, validation, and precedence.
- `watchdog-semantic-hooks`: remove waiting signals while preserving reason-bearing continuation and idle-gated terminal signals.
- `terminal-outcome-gate`: retain success/error/abort settlement behavior with only continue or unlock in a successful decision.

The baseline is source at `6c346b2` plus the completed `align-unlock-tool-with-reflection-contract` artifacts. Main specs still contain older proactive-tool behavior. This proposal neither revives that behavior nor authorizes synchronization, archive, or edits to the predecessor. Before eventual main-spec synchronization, reconcile the predecessor and this successor together: the pending `decision-response-contract` must have one final two-outcome definition, and the pending `watchdog-waiting-hook` must not be introduced as an active capability.

## Impact

- Protocol and lifecycle: `src/decision-protocol.ts`, `src/controller.ts`, `src/runtime.ts`, and affected config descriptions in `src/config.ts`.
- Presentation and context: `src/watchdog-event.ts`, `src/context-fold.ts`, `src/decision-tool.ts`, `src/commands.ts`, and extension hook wiring only where required.
- Notification payloads: `src/semantic-hook.ts`; consumers of `watchdog-waiting` will stop receiving that retired event. No consumer configuration is edited.
- Verification: existing Node/tsx component tests, packed-host and cross-process fixtures, rendered output, provider-request capture, native summary-input checks, and bounded permission/delivery regression examples derived from the reviewed Hermes session. Separate context/transport evidence from model-judgment evidence: neither a fake decision nor a prompt-substring assertion proves the reconfirmation defect fixed. No new testing framework or production model calls are authorized; report unmeasured model efficacy explicitly.
- Later implementation documentation: README, behavior contract, and affected Lean process models, especially `docs/programming-thinking/official-pi-idle-inquiry.idea.lean`. This planning change does not edit or claim to validate those shipped-behavior models.
- No host patch, dependency upgrade, new scheduler, general inquiry framework, global configuration change, installation/reload, release, commit, or push is authorized by this proposal workflow. A missing public host seam for the context guarantee is a blocker to resolve explicitly, not permission to expand scope or silently weaken the requirement.

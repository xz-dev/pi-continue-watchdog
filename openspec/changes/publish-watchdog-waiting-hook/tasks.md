## 1. Acceptance Baseline

- [x] 1.1 Confirm `master`, remote, tracked-tree state, and untouched pre-existing `artifacts/`; create one feature branch and verify no unrelated file enters the change.
- [x] 1.2 Add an independent-consumer acceptance test for a durably accepted wait and prove it fails because `watchdog-waiting` is absent.
- [x] 1.3 Add focused negative acceptance examples for invalid, stale/preempted, and persistence-failed waits plus a final-attempt deadline, and verify the baseline remains silent or lacks the required ordering.

## 2. Waiting Hook Contract

- [x] 2.1 Add the `watchdog-waiting` name, values type, and fresh frozen envelope builder with `REASON` and decimal `WAIT_SECONDS`; verify exact builder and immutability tests pass and no `REASON_TYPE` is present.
- [x] 2.2 Emit exactly once in the sequence append wait entry → post-append `stopIfStale` → guarded emit → post-emit `stopIfStale` → fold/schedule; verify runtime tests cover ordinary wait, re-entrant append demotion, rollback, pre-persistence preemption, no listener, and throwing listener.
- [x] 2.3 Verify a final-attempt wait emits waiting immediately while existing `user-ready / EXHAUSTED` remains blocked until the full deadline and is not duplicated by timer rescheduling.

## 3. Verification and Delivery

- [x] 3.1 Update README and behavior documentation separately, verifying wording matches the public untyped wait contract and best-effort delivery semantics.
- [x] 3.2 Run `npm run check`, `npm run test:e2e:packed`, `npm run test:e2e:cross-process`, `npm pack --dry-run --json`, `git diff --check`, `git status --short`, and `openspec validate publish-watchdog-waiting-hook --type change --strict --no-interactive`; verify all pass and generated artifacts remain untracked.
- [x] 3.3 Intentionally disable the new emit once and verify the acceptance test fails, then restore the candidate and rerun the focused test.
- [x] 3.4 Obtain provisional independent review of the uncommitted working-tree candidate, resolve every finding, and rerun affected checks; explicitly record that this review is not approval of an immutable SHA.
- [x] 3.5 After explicit user confirmation for local commits only, create separate GPG-signed Conventional functional and documentation commits and verify their signatures; do not push or integrate under this authorization.
- [ ] 3.6 Independently review the resulting exact commit SHAs or prove tree equivalence to the provisionally reviewed candidate, resolve any finding through separately authorized follow-up commits, rerun affected checks, and retain approval tied to the final exact SHAs.
- [ ] 3.7 After separate explicit user confirmation for push/integration, publish only the exact approved commits, fast-forward them into `master`, remove the feature branch, and confirm local/public SHAs match.

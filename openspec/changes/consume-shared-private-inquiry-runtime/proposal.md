## Why

Continue's private-fork execution is already published and verified, but its local pi-subagents patch, file transport and correction mechanism would otherwise be duplicated in Reflect. Consume the shared pi-extension-utils module without changing watchdog behavior.

## What Changes

- Replace the local private runtime and generic file/correction mechanisms with the `pi-extension-utils/private-inquiry` Interface defined by the coordinated `share-private-inquiry-runtime` change.
- Remove superseded local patch/preparation ownership after conformance and clean-distribution evidence passes. Keep a small Continue adapter for its prompt, validator, one optional review-triggered reconsideration, audit and publication.
- Preserve full effective context, selected model/thinking, file-only submission, three responses per inquiry, at most two inquiries in one child, exact-child cancellation, native main continuation behavior and legacy history.
- Retain all current payload normalization, WAIT_CALLBACK identity, maxContinue accounting, durable receipts/rollback, optional audit behavior and co-installation isolation.
- Keep the current Pi >=1.3.0 minimum and live Git distribution. Do not change global Pi, user configuration, public tools or ordinary session behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is an implementation/distribution refactor, not a new behavior contract. `.openspec.yaml` deliberately declares `skip_specs: true`; existing main specifications remain the authoritative acceptance contract rather than inventing a delta to restate them.

## Impact

- Expected implementation areas: `src/private-decision.ts`, the private dispatch/cancellation adapter in `src/runtime.ts`, `patches/pi-subagents-0.79.0/`, `scripts/prepare-private-runtime.mjs`, package inputs and matching runtime/packed tests.
- Shared dependency contract: `pi-extension-utils/openspec/changes/share-private-inquiry-runtime/specs/private-inquiry-runtime/spec.md`. Consume a verified immutable shared revision, not a moving branch or a copied private implementation.
- Reuse current conformance, packed, cross-process, native-summary, co-installation and actual TUI assertions. Update affected documentation/formal models during implementation only if their stated process or annotations change.
- Preserve unrelated `PLAN/provider-retry-accounting.md`. This change contains planning artifacts only: no implementation, dependency install, commit or push.

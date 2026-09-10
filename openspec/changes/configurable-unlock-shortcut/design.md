## Context

`handleUnlock` (src/commands.ts:567) already implements the full unlock path: controller claim → `controller.unlock()` → cleanup → effects → notify → optional reason entry. Extension shortcuts register via `pi.registerShortcut(key, { description, handler })`; Pi emits native conflict diagnostics but exposes no namespaced keybinding ids, so customization belongs in the plugin config. Config plumbing follows the established `ContinueWatchdogConfig` + loader diagnostics pattern (src/config.ts).

## Goals / Non-Goals

**Goals:**

- One shortcut gesture equivalent to `/unlock-continue-watchdog` with no reason.
- `unlockShortcut: string | false` config with documented default, disable, and invalid→default fallback.

**Non-Goals:**

- No reason prompt from the shortcut (slash command keeps optional reason).
- No rebinding via `keybindings.json` (impossible for extension shortcuts today).
- No lock/status shortcuts; unlock only.

## Decisions

- **Reuse `handleUnlock` verbatim.** The shortcut handler calls the same function with empty args (`""`), so shortcut and command can never drift apart. No reason entry is appended (empty reason normalizes to none), matching today's no-reason command behavior. Alternative (dedicated shortcut path) rejected: duplicated unlock sequencing is exactly where subtle divergences breed. Implementation: `handleUnlock` is exported from `commands.ts` and both `createMainCommands` and the shortcut handler share one command-runtime adapter. When already unlocked, the shortcut reproduces the command's unconditional unlock notification (the human-unlock contract is intentionally unconditional; see `docs/behavior-contract.md` same-state examples).
- **Default key `alt+u`** (mnemonic "unlock"), pending the pre-flight conflict check against built-ins and the user's installed extensions; if taken, pick another mnemonic and update spec/design before coding. `ctrl+u` and plain `u` are editor/text gestures — excluded.
- **Register per session from effective config, via a config-ready callback.** `createDecisionRuntime` accepts `onConfigReady(config)`; the extension factory calls `pi.registerShortcut` only after the effective config is committed for the current control acquisition (fired on both the injected-controller and async-load paths). Registration never depends on lock state; the handler reproduces command behavior when unlocked, avoiding register/unregister churn.
- **Discoverability in the existing state row (full format only; the compact row omits the hint — it exists for narrow widths where the hint would be truncated anyway).** `renderStateStatus` (the `Continue Watchdog | idle (enabled) | ...` row) gains an unlock hint segment while the watchdog is locked: `enabled · <key> unlock` from effective config, or `enabled · /unlock-continue-watchdog` when the shortcut is disabled; unlocked renders no hint. The key string comes from the same effective config value passed to `registerShortcut`, so display and registration cannot diverge. No new widget; the row already re-renders on state transitions.
- **Validation mirrors existing loader style:** accept string or `false`; anything else → bounded diagnostic + built-in default. Minimal key sanity (nonempty string) only; Pi owns key parsing and conflict diagnostics.

## Risks / Trade-offs

- Default key conflicts with a user's other extension → Pi diagnostics are loud and the key is user-fixable via config; accepted, no auto-rebind.
- Shortcut fires while a decision inquiry is streaming → same behavior as typing the unlock command mid-decision (unlock wins, decision machinery cleans up via existing generation/epoch guards); covered by reusing `handleUnlock`, verified by an unlock-during-decision test.

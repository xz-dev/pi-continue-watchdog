## Why

Unlocking the watchdog requires typing `/unlock-continue-watchdog`, which is slow when the user just wants to reclaim the keyboard mid-session. A keyboard shortcut makes unlock instant, but Pi does not provide namespaced keybinding ids for extension shortcuts, so the key must be user-configurable through the plugin's own config file rather than `keybindings.json`.

## What Changes

- New unlock keyboard shortcut that performs exactly the same unlock as `/unlock-continue-watchdog` with no reason.
- New optional config field `unlockShortcut: string | false` in `pi-continue-watchdog.json`: a Pi key id string to bind, `false` to disable; default is a documented mnemonic key (verified against built-in bindings before implementation).
- Invalid configured keys fall back to the default with a bounded diagnostic, following the existing config-loader diagnostic pattern.
- Shortcut registration relies on Pi's native extension-shortcut conflict diagnostics; no silent override handling.
- While the watchdog is locked, the existing state status bar row names the effective unlock key (or `/unlock-continue-watchdog` when the shortcut is disabled) so the gesture is discoverable.
- `/unlock-continue-watchdog`, lock/status commands, and all watchdog decision behavior are unchanged.

## Capabilities

### New Capabilities

- `unlock-shortcut`: Configurable keyboard shortcut that unlocks the watchdog identically to the unlock slash command, including disable and invalid-key fallback semantics.

### Modified Capabilities

None. The unlock slash command and decision protocol are untouched; the shortcut only adds a second gesture for the same operation.

## Impact

- `src/config.ts` / `src/config-loader.ts`: new `unlockShortcut` field, validation, merge, diagnostics.
- `src/commands.ts` or extension setup: `pi.registerShortcut` wired to the same unlock path as `handleUnlock` (no reason).
- README: shortcut, config field, default key, and why customization lives in the plugin config.
- Tests: config validation/merge, shortcut registration, unlock-equivalence, disabled and invalid-key fallback.
- No protocol, contract, or decision-behavior changes; no Pi host changes.

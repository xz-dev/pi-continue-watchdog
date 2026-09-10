## 1. Pre-flight

- [x] 1.1 Verify `alt+u` has no built-in Pi binding and no conflict among installed extensions; if taken, choose a different mnemonic default and update `design.md` + spec before coding
- [x] 1.2 Re-read `src/commands.ts` (handleUnlock), `src/config.ts`, `src/config-loader.ts` in full to confirm shapes match design assumptions

## 2. Config

- [x] 2.1 Add `unlockShortcut: string | false` to `ContinueWatchdogConfig` + `BUILT_IN_CONFIG` default and `KNOWN_KEYS`; verify `npx tsc --noEmit` passes
- [x] 2.2 Implement loader validation/merge (string key, `false` disables, invalid → bounded diagnostic + default); verify new config tests pass with the existing loader suite

## 3. Shortcut wiring

- [x] 3.1 Register unlock shortcut from effective config calling `handleUnlock(pi, runtime, "", ctx)`; skip registration when `false`; verify registration test and disabled-config test
- [x] 3.2 Verify equivalence: shortcut while locked produces the same unlock effects/notification as the command without reason; shortcut while unlocked no-ops with notification; add unlock-during-decision test
- [x] 3.3 Render unlock hint in the state status bar row while locked (effective key, or `/unlock-continue-watchdog` when disabled; no hint when unlocked); verify widget text tests cover all three states

## 4. Docs and verification

- [x] 4.1 Update README: shortcut, `unlockShortcut` config, default key, and why customization lives in the plugin config (no namespaced extension keybinding ids in Pi)
- [x] 4.2 Run `npm run check` and fix all findings before commit

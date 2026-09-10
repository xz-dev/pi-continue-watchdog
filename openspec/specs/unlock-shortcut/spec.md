## Purpose

Lets the user unlock the continue watchdog with a single configurable keystroke, equivalent to `/unlock-continue-watchdog`, without giving up the slash command or reconfiguring Pi keybindings.

## Requirements

### Requirement: Shortcut unlocks identically to the unlock command

Pressing the unlock shortcut SHALL perform the same unlock operation as `/unlock-continue-watchdog` with no reason: authoritative unlock first, then cleanup, effects, and notification, through the same controller path. When the watchdog is not locked, the shortcut SHALL be a no-op with a clear notification, matching command behavior.

#### Scenario: Locked watchdog unlocked by shortcut

- **GIVEN** the watchdog is locked
- **WHEN** the user presses the unlock shortcut
- **THEN** the watchdog becomes unlocked through the same controller unlock path as the slash command
- **AND** the user sees the same unlock confirmation surface as the command produces without a reason

#### Scenario: Shortcut with unlocked watchdog

- **GIVEN** the watchdog is not locked
- **WHEN** the user presses the unlock shortcut
- **THEN** behavior matches the slash command exactly: state remains unlocked and the user receives the same unconditional unlock notification the command produces (human unlock is intentionally unconditional)

### Requirement: Configurable key with disable and fallback

The shortcut key SHALL be read from the plugin's existing configuration file as `unlockShortcut`, accepting a Pi key id string or `false` to disable the shortcut entirely. The default key SHALL be documented and SHALL NOT collide with a built-in Pi binding. A value of `false` SHALL skip registration while keeping `/unlock-continue-watchdog` available. An invalid value (wrong type or unrecognized key) SHALL fall back to the default and produce a bounded diagnostic, never crashing extension load.

#### Scenario: Custom key registered

- **GIVEN** the user configured `"unlockShortcut": "alt+u"`
- **WHEN** the extension loads
- **THEN** the unlock shortcut is registered on `alt+u`

#### Scenario: Shortcut disabled

- **GIVEN** the user configured `"unlockShortcut": false`
- **WHEN** the extension loads
- **THEN** no unlock shortcut is registered
- **AND** `/unlock-continue-watchdog` still unlocks

#### Scenario: Invalid value falls back

- **GIVEN** the user configured `"unlockShortcut": 42`
- **WHEN** the extension loads
- **THEN** the default key is registered and a bounded diagnostic is emitted

### Requirement: Locked state advertises the shortcut

While the watchdog is locked, the plugin's state status bar row SHALL name the effective configured unlock shortcut key so the user can discover it, or the `/unlock-continue-watchdog` command when the shortcut is disabled. The row SHALL render the key from effective merged configuration, never a hardcoded default. When the watchdog is unlocked, no unlock hint SHALL be shown.

#### Scenario: Locked with shortcut enabled

- **GIVEN** the watchdog is locked and the unlock shortcut is enabled
- **WHEN** the state status bar row renders
- **THEN** it names the effective unlock key alongside the locked/enabled state

#### Scenario: Locked with shortcut disabled

- **GIVEN** the watchdog is locked and `"unlockShortcut": false` is configured
- **WHEN** the state status bar row renders
- **THEN** it names `/unlock-continue-watchdog` instead of a key

#### Scenario: Unlocked shows no hint

- **GIVEN** the watchdog is not locked
- **WHEN** the state status bar row renders
- **THEN** no unlock key or command hint is shown

### Requirement: Stock Pi only

The shortcut SHALL be implemented with stock upstream Pi public extension APIs (`pi.registerShortcut`) and SHALL rely on Pi's native extension-shortcut conflict diagnostics instead of custom conflict detection or rebinding. No forked or patched Pi is required.

#### Scenario: Conflict surfaces natively

- **GIVEN** another extension or a restricted built-in already claims the configured key
- **WHEN** the extension loads
- **THEN** Pi's native conflict diagnostic decides precedence and the plugin does not override it silently

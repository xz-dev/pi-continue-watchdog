## MODIFIED Requirements

### Requirement: Shortcut unlocks identically to the unlock command

Pressing the unlock shortcut SHALL perform the same unlock operation as `/unlock-continue-watchdog` with no reason: authoritative unlock first, ownership-aware cancellation of any current watchdog-owned run, then cleanup, effects, and notification, through the same controller and runtime path. The shortcut MUST NOT abort an ordinary user-started run. When the watchdog is not locked, the shortcut SHALL retain the command's unconditional same-state unlock behavior and notification.

#### Scenario: Locked watchdog unlocked by shortcut

- **GIVEN** the watchdog is locked
- **WHEN** the user presses the unlock shortcut
- **THEN** the watchdog becomes unlocked through the same controller and runtime path as the slash command
- **AND** the user sees the same unlock confirmation surface as the command produces without a reason

#### Scenario: Shortcut cancels an active watchdog-owned run

- **GIVEN** a watchdog decision or automated continuation is the current correlated run
- **WHEN** the user presses the unlock shortcut
- **THEN** behavior matches reasonless `/unlock-continue-watchdog`, including aborting that owned run and cleaning its cancellation residue
- **AND** no replacement model turn is started

#### Scenario: Shortcut preserves an ordinary user run

- **GIVEN** an ordinary user-started run is active and is not correlated to watchdog automation
- **WHEN** the user presses the unlock shortcut
- **THEN** the watchdog becomes unlocked
- **AND** the ordinary run is not aborted by the watchdog

#### Scenario: Shortcut with unlocked watchdog

- **GIVEN** the watchdog is not locked and no watchdog-owned run is active
- **WHEN** the user presses the unlock shortcut
- **THEN** behavior matches the slash command exactly: state remains unlocked and the user receives the same unconditional unlock notification the command produces

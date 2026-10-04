## MODIFIED Requirements

### Requirement: Manual unlock cancels only the current watchdog-owned run
When a human invokes `/unlock-continue-watchdog` or the configured unlock shortcut while the current main run is precisely correlated to a watchdog decision, correction, or automated continuation, the system SHALL unlock and abort that run. It MUST NOT abort an ordinary user-started or uncorrelated run. Unlock SHALL immediately revoke queued and active result-submission authorization and invalidate any pending wait deadline; later calls, tool results, or settlement callbacks from that cancelled exchange SHALL NOT restart it or affect a later cycle.

#### Scenario: Decision run is cancelled
- **GIVEN** a watchdog decision run is active and correlated to its exchange
- **WHEN** the human invokes manual unlock
- **THEN** the watchdog unlocks and aborts that decision with no replacement model turn
- **AND** its result function can no longer submit a verdict

#### Scenario: Automated continuation is cancelled
- **GIVEN** an automated continuation run is active and correlated to its accepted continue exchange
- **WHEN** the human invokes manual unlock
- **THEN** the watchdog unlocks and aborts that continuation with no replacement model turn

#### Scenario: Ordinary user run is preserved
- **GIVEN** the current run was started directly by user work and is not correlated to a watchdog decision or continuation
- **WHEN** the human invokes manual unlock
- **THEN** normal manual-unlock behavior applies without aborting that run

#### Scenario: Queued correction is cancelled
- **WHEN** the human unlocks before a queued correction prompt is consumed
- **THEN** it grants no submission authority and cannot cause a late verdict, retry charge, or replacement turn

#### Scenario: Late result after cancellation
- **WHEN** a cancelled decision's function result arrives after an ordinary user run has started
- **THEN** it cannot unlock, abort, clean up, or charge attempts to the later run

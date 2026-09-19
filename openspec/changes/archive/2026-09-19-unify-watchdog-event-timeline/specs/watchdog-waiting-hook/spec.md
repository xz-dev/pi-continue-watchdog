## MODIFIED Requirements

### Requirement: Accepted waits publish a waiting hook

The watchdog SHALL publish exactly one `pi:semantic-hook:v1` envelope named `watchdog-waiting` after a current valid `wait_watchdog` decision has been durably published as its shared human/model wait event. Its values SHALL contain the validated trimmed reason in `REASON` and the accepted integer duration rendered as a decimal string in `WAIT_SECONDS`. The envelope SHALL NOT contain or imply a wait reason type. Optional diagnostic-audit persistence SHALL NOT substitute for, or independently gate, publication of the shared wait event. Timestamp additions to conversation history SHALL NOT change the hook's existing names, values, or consumer-independent delivery contract.

#### Scenario: Valid wait is recorded
- **WHEN** a current decision accepts and durably publishes a valid shared wait event
- **THEN** one `watchdog-waiting` hook is published with the same `REASON` and `WAIT_SECONDS`
- **AND** the wait's timestamped canonical body is available to both the human and the model

#### Scenario: Wait cannot become durable
- **WHEN** a wait is invalid, preempted before publication, rolled back, or its shared event cannot be durably published
- **THEN** no `watchdog-waiting` hook is published

#### Scenario: Ownership changes during persistence
- **WHEN** publishing the shared wait event re-entrantly demotes or invalidates the current claim
- **THEN** no `watchdog-waiting` hook is published even if publication returned

#### Scenario: Optional audit is unavailable
- **WHEN** optional diagnostic-audit persistence fails but the current accepted shared wait event is durably published
- **THEN** the optional audit failure does not suppress the waiting hook or alter the accepted wait

#### Scenario: A completed wait is reported
- **WHEN** a completed-wait timing event is published at the later eligible wake
- **THEN** it does not republish the original `watchdog-waiting` hook
- **AND** the hook continues to mean wait acceptance, not wait completion

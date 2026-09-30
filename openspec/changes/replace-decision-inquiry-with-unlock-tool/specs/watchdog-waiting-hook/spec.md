## REMOVED Requirements

### Requirement: Accepted waits publish a waiting hook
**Reason**: The wait outcome is removed.
**Migration**: Consumers must drop `watchdog-waiting` handlers; see `watchdog-semantic-hooks`.

### Requirement: Waiting and exhaustion remain distinct events
**Reason**: The wait outcome is removed.
**Migration**: Exhaustion is still published as `user-ready` `EXHAUSTED`.

### Requirement: Notification consumers remain optional
**Reason**: This moves to `watchdog-semantic-hooks`.
**Migration**: See `watchdog-semantic-hooks`.

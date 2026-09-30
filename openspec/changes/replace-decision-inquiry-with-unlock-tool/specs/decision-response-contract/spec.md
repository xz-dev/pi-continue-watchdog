## REMOVED Requirements

### Requirement: Expired-wait inquiry begins with observed timing facts
**Reason**: The decision inquiry and wait outcome are removed.
**Migration**: None; waiting now happens inside the agent's own turn.

### Requirement: Timing preamble conveys no task outcome
**Reason**: The decision inquiry and its timing preamble are removed.
**Migration**: None.

### Requirement: Entire response is the watchdog XML document
**Reason**: The XML decision response is replaced by the `unlock_continue_watchdog` tool.
**Migration**: The agent calls `unlock_continue_watchdog`; see `ai-unlock-tool`.

### Requirement: Reask and block reasons state the same response shape
**Reason**: Re-asks and decision-time tool blocking are removed.
**Migration**: Invalid tool arguments fail as ordinary tool errors; see `ai-unlock-tool`.

### Requirement: Lenient parser acceptance is unchanged
**Reason**: The XML parser is removed.
**Migration**: None.

### Requirement: Prompt declares the reason content limit
**Reason**: The decision prompt is removed.
**Migration**: The tool schema and description state the limit; see `ai-unlock-tool`.

### Requirement: Reason content hard limit
**Reason**: This moves to the unlock tool contract.
**Migration**: The 1000-code-point limit is enforced on the tool's `reason`; see `ai-unlock-tool`.

### Requirement: Reconcile actual delivery before outcome selection
**Reason**: The model no longer answers a decision prompt.
**Migration**: The tool description and continuation guidance describe when to unlock.

### Requirement: Outcome selection follows user-boundary priority
**Reason**: The model no longer selects among three outcomes.
**Migration**: The agent either calls `unlock_continue_watchdog` or is continued.

### Requirement: Continue requires an immediately executable action
**Reason**: Continuation no longer requires a model decision.
**Migration**: The continuation guidance tells the agent to unlock when no authorized work remains.

### Requirement: External waiting remains distinct from user waiting
**Reason**: The wait outcome is removed.
**Migration**: Agents block, monitor, or sleep within their turn; user waits use the unlock tool with a user-action reason type.

### Requirement: Terminal outcome categories remain explicit
**Reason**: This moves to the unlock tool's configured `reasonTypes`.
**Migration**: Use `reason_type` on `unlock_continue_watchdog`.

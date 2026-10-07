# @zhushanwen/pi-notify-ledger-host

## 0.3.1

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@1.3.0 → @zhushanwen/subagent-core@1.4.0)

## 0.3.0

### Minor Changes

- 802af968f: Retire the optional `sendDisplayMessage` port: notification delivery is back to the single `sendDelivery` wake-turn channel, and the `sendDisplayMessage` factory option is removed from `CreatePiNotifyLedgerHostOptions` (requires pi 1.0.0).

## 0.2.4

### Patch Changes

- 492e02447: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@1.2.0 → @zhushanwen/subagent-core@1.2.1)

## 0.2.3

### Patch Changes

- b44f1316b: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@1.1.0 → @zhushanwen/subagent-core@1.2.0)

## 0.2.2

### Patch Changes

- a9b6a9fc7: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@1.0.0 → @zhushanwen/subagent-core@1.1.0)

## 0.2.1

### Patch Changes

- 0d36077d4: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@0.13.0 → @zhushanwen/subagent-core@1.0.0)

## 0.2.0

### Minor Changes

- 8aa4b40e8: New shared library package: `createPiNotifyLedgerHost` wires the five pi-extension runtime ports (appendEntry / sessionManager.getEntries / isIdle / agent_settled / sendMessage) into the `NotifyLedgerHost` consumed by the notify-once claim ledger, with stale-ctx guarded delivery built in — single wake-up channel `{ triggerTurn: true }`, silent downgrade with attributed warn on stale context, non-stale errors rethrown, and an optional non-waking `sendDisplayMessage` port for abandon notices. Previously duplicated as identical inline host literals in `pi-subagent-workflow` and `pi-session-manager`; both packages now assemble through this factory (behavior anchored field-by-field by its contract tests).

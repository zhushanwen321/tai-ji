---
'@zhushanwen/pi-notify-ledger-host': minor
---

New shared library package: `createPiNotifyLedgerHost` wires the five pi-extension runtime ports (appendEntry / sessionManager.getEntries / isIdle / agent_settled / sendMessage) into the `NotifyLedgerHost` consumed by the notify-once claim ledger, with stale-ctx guarded delivery built in — single wake-up channel `{ triggerTurn: true }`, silent downgrade with attributed warn on stale context, non-stale errors rethrown, and an optional non-waking `sendDisplayMessage` port for abandon notices. Previously duplicated as identical inline host literals in `pi-subagent-workflow` and `pi-session-manager`; both packages now assemble through this factory (behavior anchored field-by-field by its contract tests).

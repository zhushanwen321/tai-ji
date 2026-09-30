---
'@zhushanwen/pi-subagent-workflow': patch
---

Notify-ledger host assembly (five-port wiring + stale-ctx guarded delivery) now comes from the shared `@zhushanwen/pi-notify-ledger-host` factory instead of an inline literal. Delivery semantics are unchanged: single `{ triggerTurn: true }` wake-up channel, silent downgrade on stale context, abandon display messages stay non-waking; guard labels keep the `subagent-workflow:` prefix and warnings stay attributed to this package's logger.

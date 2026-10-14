---
"@zhushanwen/pi-pending-notifications": patch
---

Trim the pending_notifications description by dropping the internal state-maintenance note (EventBus/session-entries bookkeeping is invisible to callers), as part of the tool-declaration slimming pass.

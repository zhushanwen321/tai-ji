---
'@zhushanwen/pi-subagent-workflow': patch
---

Workflow runs finalize their pending-notification unregister by writing the entry directly instead of relying on the event bus, closing the reload window where the emitted unregister could be lost and the entry never recorded.

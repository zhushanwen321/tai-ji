---
'@zhushanwen/extension-protocol': minor
---

Added a runtime dependency on the new `@zhushanwen/state-machine` package; the plan lifecycle state machine is now declared with it. The public transition API is unchanged — same legal transitions and the same `{ ok: true, next } | { ok: false }` return shape as before, so no consumer changes are required.

---
'@zhushanwen/pi-pending-notifications': patch
---

Documents the direct appendEntry unregister producers (workflow finalizeRun, reconcile sweeps, session-start reconcile) in the event contract header so the emit-side producer list matches the durable write path; no behavior change.

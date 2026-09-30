---
'@zhushanwen/pi-structured-output': major
---

Replaces the `LoopGate` / `RetryState` / `setupLoopGate` public exports with a single `WorkflowGate` export: the soft retry-steering gate and the hard termination gate now live on one state machine with one listener. Removed exports are breaking for direct importers — migrate to `WorkflowGate`.

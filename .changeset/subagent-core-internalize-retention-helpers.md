---
'@zhushanwen/subagent-core': patch
---

Internalized retention helpers: `DEFAULT_STATE_TTL_MS`, `resolveStateTtlMs`, `DEFAULT_ORPHAN_RUN_GRACE_WINDOW_MS` and `resolveOrphanRunGraceWindowMs` are no longer exported from run-state-evidence — they are module-private implementation details with no external consumers. The `TAIJI_SUBAGENT_STATE_TTL_MS` / `TAIJI_WORKFLOW_ORPHAN_RUN_GRACE_WINDOW_MS` env override channels and all retention entry points (`pruneTerminalRunFiles`, `runRetentionMaintenanceRound`, `reapOrphanRuns`) are unchanged.

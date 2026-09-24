---
'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-subagent-workflow': patch
---

Converge the pi-host sessionDir layout (cwd slug + existsSync probe) into a single source of truth: `resolvePiSessionScopedDir` is now exported from the subagent-core barrel, and the shell extension's `resolveSessionDir` became a thin consumer that injects the live pi SDK `getAgentDir()` via `opts.agentDir`. The previously duplicated slug rule (shell + core copies cross-referenced only by comments, with drift surfacing as runtime failures such as the reconcile sweep wrongly unregistering active runs) is gone; `resolvePiWorkflowStateDir` is now a pure workflow-state suffix derivation over the shared resolver with byte-identical behavior.

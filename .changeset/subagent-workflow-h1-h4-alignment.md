---
'@zhushanwen/pi-subagent-workflow': minor
---

Align the extension with the subagent-core execution-runtime extraction and harden run lifecycle behavior.

- **Elapsed freeze**: a finished run's displayed duration is now frozen at its `completedAt` instead of growing with every status query.
- **Manifest as rebuildable cache**: startup tmp-file recovery is retired in favor of a silent sweep plus full `rebuildIndexes` boot leg — the record manifest is treated as disposable and rebuilt from the authoritative `.state` markers.
- **Store-backed workflow dispatch**: the legacy pump-bypass progress-record family is retired; workflow dispatch and view projections read through the record store (origin/parentRunId identity + persistence chain included).
- **Safer fork-from**: the fork guard now probes for a foreign live instance instead of relying on the old three-switch check.
- Execution runtime moved to `@zhushanwen/subagent-core` — this package keeps only the registration surface and pi host adapters.

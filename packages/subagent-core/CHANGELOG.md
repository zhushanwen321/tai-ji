# @zhushanwen/subagent-core

## 0.11.1

### Patch Changes

- 43a50ae2e: listModels now maps a dynamic empty catalog to null instead of surfacing an error (B1), and round-idle bookkeeping writes the derived manifest projection so reloaded runs observe the manifest without waiting for the next full rebuild (B2). Also recalibrates the D2 latency threshold for instrumented-load runs.

## 0.11.0

### Minor Changes

- 8285841af: Review-fix-loop workflow rework: reviews run in parallel and fixes are dispatched as aggregate-driven groups over a disjoint file bus, reviewer batching is rank-driven (fixed 3 + dynamic 1 per batch), and aggregator issue ids stay continuous across rounds. A disputed lane replaces the old fixer-abort-on-false-positive: a fixer that verifies a finding to be a false positive appeals it with counter-evidence instead of silently skipping or aborting; a human adjudicates after the run. Also ships: run finalize now unregisters pending notifications durably via a direct appendEntry write (closing the reload/factory-ordering window where an emitted unregister could be lost), reconcile sweeps map unregister reasons to statuses instead of hard-coding one, and pi worktree cwd conduction broken by engine protocolization is restored.

## 0.10.5

### Patch Changes

- a59739edb: feat(subagent-core): packageVersion in engine stable identity (D2b version face)

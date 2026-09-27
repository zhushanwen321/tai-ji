# @zhushanwen/subagent-core

## 0.11.0

### Minor Changes

- 8285841af: Review-fix-loop workflow rework: reviews run in parallel and fixes are dispatched as aggregate-driven groups over a disjoint file bus, reviewer batching is rank-driven (fixed 3 + dynamic 1 per batch), and aggregator issue ids stay continuous across rounds. A disputed lane replaces the old fixer-abort-on-false-positive: a fixer that verifies a finding to be a false positive appeals it with counter-evidence instead of silently skipping or aborting; a human adjudicates after the run. Also ships: run finalize now unregisters pending notifications durably via a direct appendEntry write (closing the reload/factory-ordering window where an emitted unregister could be lost), reconcile sweeps map unregister reasons to statuses instead of hard-coding one, and pi worktree cwd conduction broken by engine protocolization is restored.

## 0.10.5

### Patch Changes

- a59739edb: feat(subagent-core): packageVersion in engine stable identity (D2b version face)

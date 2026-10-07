# @zhushanwen/pi-pending-notifications

## 0.8.2

### Patch Changes

- 802af968f: (no changeset body; patch version bump)

## 0.8.1

### Patch Changes

- 0d36077d4: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.16.0 → @zhushanwen/extension-protocol@0.17.0)

## 0.8.0

### Minor Changes

- 8aa4b40e8: Managed-session completion notifications now fire exactly once (notify-once claim ledger):

  - `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
  - `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
  - `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
  - `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
  - `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

## 0.7.7

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0)

## 0.7.6

### Patch Changes

- 8285841af: Documents the direct appendEntry unregister producers (workflow finalizeRun, reconcile sweeps, session-start reconcile) in the event contract header so the emit-side producer list matches the durable write path; no behavior change.

## 0.7.5

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory

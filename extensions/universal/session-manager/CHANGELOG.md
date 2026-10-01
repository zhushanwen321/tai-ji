# @zhushanwen/pi-session-manager

## 0.2.1

### Patch Changes

- 0d36077d4: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.16.0 → @zhushanwen/extension-protocol@0.17.0, @zhushanwen/pi-notify-ledger-host@0.2.0 → @zhushanwen/pi-notify-ledger-host@0.2.1, @zhushanwen/subagent-core@0.13.0 → @zhushanwen/subagent-core@1.0.0)

## 0.2.0

### Minor Changes

- 8aa4b40e8: Managed-session completion notifications now fire exactly once (notify-once claim ledger):

  - `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
  - `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
  - `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
  - `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
  - `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

## 0.1.16

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.14.0 → @zhushanwen/extension-protocol@0.15.0)

## 0.1.15

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0)

## 0.1.14

### Patch Changes

- 8285841af: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.12.0 → @zhushanwen/extension-protocol@0.13.0)

## 0.1.13

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 0.1.12

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory

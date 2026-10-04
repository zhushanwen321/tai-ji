# @zhushanwen/session-delivery

## 1.0.0

### Major Changes

- 0d36077d4: The delivery kernel grows an ownership layer with typed contracts exported from the package root: entry state machine and dual views (`DeliveryLane`, `DeliveryEntryState`, `DeliveryEntry`, `DeliveryTombstone`, `DeliveryEntriesFull`, `DeliveryEntriesProjection`), the v2 handle surface (`DeliveryHandleV2` — a superset of `DeliveryHandle`, existing consumers keep working unchanged — plus `DeliverySubmitOptions`, `DeliverySendResult`, `DeliveryCancelResult`, `DrainResult`, `DeliveryWarnSink`, `DeliveryConfigWithWarn`), and the `DeliveryReclaimError` error class (rejects pending waiters on cancel/drain; discriminate via `instanceof`). Submits now carry an explicit `receiptAnchor` declaration (`'marker'` default | `'acceptance'`) so acceptance-only channels cannot deadlock in-flight entries. Contract tightening shipped in the same change: `DeliveryPort.hasPendingMessages()` and `DeliveryConfig.busyPolicy` are gone — busy gating now derives from send settlements and the settled-edge flush instead of a port capability plus a caller-chosen policy, so host adapters must drop those members.

## 0.11.0

### Minor Changes

- 8aa4b40e8: Managed-session completion notifications now fire exactly once (notify-once claim ledger):

  - `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
  - `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
  - `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
  - `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
  - `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

## 0.10.1

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives

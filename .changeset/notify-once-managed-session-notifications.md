---
'@zhushanwen/extension-protocol': minor
'@zhushanwen/session-delivery': minor
'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-session-manager': minor
'@zhushanwen/pi-pending-notifications': minor
---

Managed-session completion notifications now fire exactly once (notify-once claim ledger):

- `extension-protocol`: the session-manager channel gains a `watch` action (single-key `notifyId` addressing, fire-and-forget respond payload) and maps the four new watch reasons (stopped / exited / deleted / orphaned) onto existing pending statuses
- `session-delivery`: delivery messages accept an additive `meta` object (e.g. `notifyId`) that reaches per-message settled callbacks untouched, anchoring delivery receipts
- `subagent-core`: the registry reconcile sweep explicitly skips `type=session` notification claims, so active claims are never reaped by workflow run-state checks
- `pi-session-manager`: new watch-coordinator / notify-ledger / notify-content modules orchestrate watch requests with ledger discipline and session-start recovery; ships the `session-manager-ext-config` skill
- `pi-pending-notifications`: the pending vocabulary gains the `session` type for managed-session notification claims (unknown types still normalize to workflow)

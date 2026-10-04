# @zhushanwen/pi-base-tool-enhance

## 0.7.2

### Patch Changes

- 0d36077d4: Internal adjustments to the enhanced bash tool plumbing (background-mode handoff and error-audit paths follow the consolidated composer surface).

## 0.7.1

### Patch Changes

- 8aa4b40e8: Source-only annotation pass: oe-exempt framework markers added to protocol contract type exports (ReconciledMarkerData / ModelCatalogEntry); no behavior change.

## 0.7.0

### Minor Changes

- 50f31a73c: Background bash tasks no longer go permanently silent when their completion notification fails to deliver (notify throw, session process exit with reaper-finalized tasks, message lost before session flush): the session-start maintenance chain now also redelivers — a strict-terminal task (excluding killed) with no delivery trace and no reconciled marker in the session entries is merged into a single steer message, followed by a synchronously written marker entry for same-activation idempotency, with an in-flight guard keyed by taskId closing the startup+resume double-dispatch window. Tasks terminated by a session teardown get an explicit "was terminated when the session went down (exit code unknown)" line pointing at bash_output instead of a fabricated success/failure verdict. Because switching away and back re-attaches the same pi process without re-emitting session_start, the maintenance chain gained a second trigger: the `__taiji_bg_reconcile__` internal command, fired by the taiji runtime on command refresh with a 60s per-session throttle. Notification copy builders now accept a structural task subset so the main and redelivery paths share one wording source.

## 0.6.2

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0, @zhushanwen/pi-llm-shared@0.9.0 → @zhushanwen/pi-llm-shared@0.10.0)

## 0.6.1

### Patch Changes

- 8285841af: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.12.0 → @zhushanwen/extension-protocol@0.13.0, @zhushanwen/pi-llm-shared@0.8.1 → @zhushanwen/pi-llm-shared@0.9.0, @zhushanwen/pi-pending-notifications@0.7.5 → @zhushanwen/pi-pending-notifications@0.7.6)

## 0.6.0

### Minor Changes

- a59739edb: Background bash completion notifications now carry structured `details`

  (taskId, command, full-duration durationMs, endReason natural|timeout,
  exitCode nullable) alongside the existing text content, so the host can
  render task results instead of parsing log lines. The text content itself is
  unchanged byte-for-byte, and old hosts that ignore `details` are unaffected.
  Tool guidance now tells agents that completion is auto-notified via steer and
  must not `bash sleep` or busy-wait while a background task runs.

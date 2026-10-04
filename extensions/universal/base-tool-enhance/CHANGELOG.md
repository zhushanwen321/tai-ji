# @zhushanwen/pi-base-tool-enhance

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

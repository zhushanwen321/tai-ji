# @zhushanwen/pi-base-tool-enhance

## 0.6.0

### Minor Changes

- a59739edb: Background bash completion notifications now carry structured `details`

  (taskId, command, full-duration durationMs, endReason natural|timeout,
  exitCode nullable) alongside the existing text content, so the host can
  render task results instead of parsing log lines. The text content itself is
  unchanged byte-for-byte, and old hosts that ignore `details` are unaffected.
  Tool guidance now tells agents that completion is auto-notified via steer and
  must not `bash sleep` or busy-wait while a background task runs.

# @zhushanwen/pi-base-tool-enhance

## 0.10.2

### Patch Changes

- da658a786: 适配 pi-delivery-port 边沿即投契约：移除 `hasRunningBackground` 攒批条件注入，后台任务完成通知不再等待合批窗口。

## 0.10.1

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0, @zhushanwen/pi-llm-shared@0.11.3 → @zhushanwen/pi-llm-shared@0.12.0)

## 0.10.0

### Minor Changes

- 58a70ebc9: bash 后台任务完成通知改经统一投递端口提交并申报收取键：通知可被 collect_results 批量收取，被等待期间挂起不提前注入；session_start 补发改由投递日志重放承担（原补发标记机制移除）。

## 0.9.0

### Minor Changes

- 796f01b29: bash_output / bash_kill 结果 details 由空改为携带 summary 一行摘要，并新增 TUI renderResult（折叠态显示摘要、展开态显示原文）。

## 0.8.4

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.20.0 → @zhushanwen/extension-protocol@0.21.0, @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0)

## 0.8.3

### Patch Changes

- 993ee907f: Mark bash_output and bash_kill as exposure:deferred — they leave the resident tool list and activate on a tool_search hit, trimming standing prompt tokens for background-output tools that are rarely called up front.

  Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

## 0.8.2

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.19.0 → @zhushanwen/extension-protocol@0.20.0, @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4)

## 0.8.1

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.18.0 → @zhushanwen/extension-protocol@0.19.0)

## 0.8.0

### Minor Changes

- 802af968f: Background task completion is now detected via the child process `exit` event instead of a 2-second poll, so completion notices arrive immediately; nested sub-tool failures are no longer double-recorded in the tool error audit (requires pi 1.0.0).

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

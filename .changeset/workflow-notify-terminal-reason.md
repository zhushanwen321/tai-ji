---
'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-subagent-workflow': patch
---

New `isTerminalDoneReason(reason)` predicate exports the DoneReason terminality verdict (exhaustive switch, no default — adding a DoneReason member forces an explicit classification here at compile time). The shell's anti-laziness wrap-up directive in run-completion notifications now consumes this core predicate instead of a local `TERMINAL_REASONS` string-set mirror, which had already drifted: it contained a ghost member `circular` that core's vocabulary never produces. The shell module is also renamed from `interface/helpers.ts` to `src/workflow-notify.ts` (its content was always workflow-domain notification production, single production consumer `workflow-events.ts`) — internal move, no public surface change.

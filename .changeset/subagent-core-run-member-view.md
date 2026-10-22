---
"@zhushanwen/subagent-core": major
---

Breaking: the bundled `workflows/fan-out.js` template (published via the `./workflows/*` export) now takes `tasks` as an array of member objects, and the `agents` param is removed.

- `tasks: [{ task, agent?, model?, thinkingLevel? }]` — each member can set its own executor, model, and thinking level; fields a member omits inherit the run-level `$MODEL` / `$THINKING_LEVEL`. Old CLI forms `tasks=["..."]` / `agents="..."` fail loudly in `validateRunArgs` before the worker starts — `workflow_run` callers that drive fan-out directly must switch to member objects.
- `aggregate` remains a template-only param; the batch tool side (`subagents`) changed the same way in `@zhushanwen/pi-subagent-workflow` — see that package's changeset for the tool-side migration table.

Add the run member view API for workflow run status: `runMemberViews(run, { records?, now })` derives one row per dispatched member (four-state `MemberState`, record-first with trace fallback, per-`stepIndex` dedup), with `RunMemberView` / `RunMemberRecordView` / `RunMemberEventView` types, `lastErrorOf(eventLog)` derivation, and the `memberViewLine` / `truncateRunMemberViews` render-budget pair (8,000-char budget, failed/cancelled rows kept on truncation). `ArgsValidationError` is now exported from the package barrel so hosts can catch it by type.

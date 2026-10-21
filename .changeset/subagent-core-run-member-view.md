---
"@zhushanwen/subagent-core": minor
---

Add the run member view API for workflow run status: `runMemberViews(run, { records?, now })` derives one row per dispatched member (four-state `MemberState`, record-first with trace fallback, per-`stepIndex` dedup), with `RunMemberView` / `RunMemberRecordView` / `RunMemberEventView` types, `lastErrorOf(eventLog)` derivation, and the `memberViewLine` / `truncateRunMemberViews` render-budget pair (8,000-char budget, failed/cancelled rows kept on truncation). `ArgsValidationError` is now exported from the package barrel so hosts can catch it by type.

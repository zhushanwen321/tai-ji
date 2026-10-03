---
'@zhushanwen/subagent-core': minor
---

Add `displayWorkflowName` to the barrel export for basename display of workflow script paths. `WorkflowRecordRegisteredEntryData` gains an optional `scriptPath` field and `buildWorkflowRecordRegisteredEntryData` accepts an optional `scriptPath` param (both fall back to an empty string at runtime, so entry shape is unchanged); resume-rebuilt entries now carry the real `scriptPath` from the run-created frame instead of a hardcoded empty one.

---
'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-subagent-workflow': patch
---

Consolidate the workflow-record entry vocabulary and v1 guard into subagent-core as the single source: new exports WORKFLOW_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_ENTRY_VERSION, and classifyWorkflowRecordEntryData (pure classification, logging policy stays with callers). The pi shell store and the runtime extractors now consume the core barrel instead of holding their own copies, and the duplicated constant in @taiji/shared is removed.

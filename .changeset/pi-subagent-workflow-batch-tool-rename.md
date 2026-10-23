---
'@zhushanwen/pi-subagent-workflow': minor
---

The batch dispatch tool `subagents` is renamed to `subagent_batch` (no old-name alias), and tool exposure is rebalanced: `subagent_manage`, `subagent_message`, and `workflow_control` are now deferred behind tool_search while `workflow-script` is always declared.

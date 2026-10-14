---
"@zhushanwen/pi-subagent-workflow": minor
---

Split the subagent tool into subagent_start / subagent_manage / subagent_message and the workflow tool into workflow_run / workflow_control — legacy tool names are removed without aliases (permission rules pinned to old names are migrated in place by pi-permission), subagent_start now enforces task/slug as real required fields, and cross-tool dispatch discipline (no busy-waiting, budget/model defaults) is injected once via the subagent list instead of repeated in every tool declaration.

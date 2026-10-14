---
"@zhushanwen/pi-permission": patch
---

User permission rules pinned to the legacy subagent/workflow tool names now expand in place to the split names (subagent_start/manage/message, workflow_run/control) on config load — order-preserving, fresh ids, idempotent, and read-only on disk, so deny rules no longer silently fall back to ask after the tool split.

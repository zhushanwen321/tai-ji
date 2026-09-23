---
'@zhushanwen/pi-scheduler': minor
---

Scheduler direct-create + per-task execution model. The `schedule` tool now creates tasks immediately in every session mode — headless and interactive alike, with no confirmation gate and no headless annotation; an aborted create returns a cancelled notice and nothing is created. Humans create tasks through the `/schedule` command, which opens a form (GUI overlay with time chips/datetime, execution-model picker, prompt preview, live cron preview; TUI five-tab form). Tasks may pin a `model` field — at fire time the runtime switches to it, restores the previous model afterwards, with mutex retry and reconciliation fallback.

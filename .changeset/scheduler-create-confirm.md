---
'@zhushanwen/pi-scheduler': minor
---

Scheduler create confirmation + per-task execution model. When the agent creates a scheduled task the GUI now shows a confirmation overlay (time chips/datetime, execution-model picker, prompt preview, live cron preview) and the TUI a five-tab form; confirming creates the task immediately, cancelling informs the agent that nothing was created. Tasks may pin a `model` field — at fire time the runtime switches to it, restores the previous model afterwards, with mutex retry and reconciliation fallback. Headless environments create directly with an explicit "created without user confirmation" annotation.

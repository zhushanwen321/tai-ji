---
"@zhushanwen/pi-scheduler": minor
---

The scheduler widget stops pushing redundant keepalive frames while the task list is unchanged, and pending model switches restore via a direct idle-state query instead of tick counting, so recovery tracks actual agent state (requires pi 1.0.0).

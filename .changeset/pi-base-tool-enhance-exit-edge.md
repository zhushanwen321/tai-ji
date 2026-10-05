---
"@zhushanwen/pi-base-tool-enhance": minor
---

Background task completion is now detected via the child process `exit` event instead of a 2-second poll, so completion notices arrive immediately; nested sub-tool failures are no longer double-recorded in the tool error audit (requires pi 1.0.0).

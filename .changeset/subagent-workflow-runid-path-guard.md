---
'@zhushanwen/pi-subagent-workflow': patch
---

Enforce a runId shape whitelist on workflow record path joins. `workflow_control` `status`/`resume` called with a malformed runId (path separators, `..`) is now handled as an unknown run without touching the filesystem, blocking path traversal and file-existence probing through the "settled-evicted vs not found" error split. The run store additionally fails fast if asked to build a record path that would escape the runs directory.

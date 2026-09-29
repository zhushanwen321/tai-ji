---
'@zhushanwen/zcode-subagent-cli': patch
---

Fire-and-forget reverse requests (`host/streamDelta`, `host/handleReady`) no longer risk crashing the engine process via unhandled rejection: a failed reverse request now logs a warning and the run continues without that channel report. A synchronous write failure (e.g. closed stdout) inside a reverse request is contained — the pending entry and its timer are cleaned up and the call rejects with an actionable message. The retired `schemaEnv` context channel is dropped from run-context restoration; schema enforcement now travels as the wire `task.schema` field.

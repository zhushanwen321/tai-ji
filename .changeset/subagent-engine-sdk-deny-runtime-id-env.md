---
"@zhushanwen/subagent-engine-sdk": patch
---

Strip `TAIJI_RUNTIME_ID` from the environment of processes spawned by the subagent engine: the runtime instance marker issued by the supervisor per spawn is now on the engine env deny list, so descendant processes no longer inherit a stale instance id from an already-exited runtime and present it as their own.

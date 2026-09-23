---
'@zhushanwen/pi-subagent-cli': patch
---

Restores worktree cwd conduction lost by engine protocolization: a `cwd` present on the run-context wire is now merged back into the local full task before `engine.run`. Absent `cwd` stays absent (additive wire semantics) and the engine falls back to its own process cwd, so worktree-isolated subagent sessions spawn with the intended working directory again.

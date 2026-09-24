---
'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-subagent-workflow': patch
---

Move the state-retention cap env parsing into subagent-core: resolveStateMaxRuns and STATE_MAX_RUNS_ENV are now exported from the core barrel, replacing the shell's identical local implementation. The shell's JsonlRunStore also declares `implements RunStore` against the core port type (signature drift is now caught at compile time) and its class doc gains an index of its five interface facets.

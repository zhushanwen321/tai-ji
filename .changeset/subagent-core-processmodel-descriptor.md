---
"@zhushanwen/subagent-core": patch
---

Fix engine descriptor assembly dropping the manifest `processModel` declaration: engines declaring `shared-service` (zcode) were misjudged as `per-window`, so direct subagent dispatch failed with `engine_window_scoped` and workflow members cold-started a fresh engine process per run instead of sharing the registry singleton.

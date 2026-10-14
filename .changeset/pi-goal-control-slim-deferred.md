---
"@zhushanwen/pi-goal": patch
---

Slim the goal_control declaration (per-action semantics and budget policy single-sourced into schema field descriptions and guidelines instead of three redundant layers) and mark it exposure:deferred — it activates on a tool_search hit instead of staying in the resident tool list.


Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

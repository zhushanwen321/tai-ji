---
"@zhushanwen/pi-rename-session": patch
---

Mark rename_session exposure:deferred (activates on a tool_search hit instead of the resident tool list) and fold the title format spec into the title field description, keeping the tool description to when-to-call guidance.


Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

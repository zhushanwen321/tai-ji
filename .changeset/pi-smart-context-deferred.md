---
"@zhushanwen/pi-smart-context": patch
---

Mark compact_context exposure:deferred (it activates on a tool_search hit instead of the resident tool list) and trim its description — the three-condition self-check remains the single source of calling discipline.


Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

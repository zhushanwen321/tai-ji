---
"@zhushanwen/pi-session-reader": patch
---

Slim the session_read declaration — action semantics collapse into the action enum description, parameter prose shrinks to essentials, guidelines keep only reading discipline — and mark it exposure:deferred, so the tool activates on a tool_search hit instead of the resident tool list.


Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

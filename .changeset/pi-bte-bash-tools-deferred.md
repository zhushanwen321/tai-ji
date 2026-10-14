---
"@zhushanwen/pi-base-tool-enhance": patch
---

Mark bash_output and bash_kill as exposure:deferred — they leave the resident tool list and activate on a tool_search hit, trimming standing prompt tokens for background-output tools that are rarely called up front.


Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

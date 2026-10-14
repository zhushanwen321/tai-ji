---
"@zhushanwen/pi-scheduler": patch
---

Mark schedule and schedule_control exposure:deferred (they activate on a tool_search hit instead of the resident tool list) and single-source their guidance — parameter semantics now live only in schema field descriptions, guidelines keep just call discipline.


Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

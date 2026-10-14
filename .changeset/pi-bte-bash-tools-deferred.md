---
"@zhushanwen/pi-base-tool-enhance": patch
---

Mark bash_output and bash_kill as exposure:deferred — they leave the resident tool list and activate on a tool_search hit, trimming standing prompt tokens for background-output tools that are rarely called up front.

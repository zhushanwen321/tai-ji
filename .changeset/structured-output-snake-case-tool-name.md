---
"@zhushanwen/pi-structured-output": patch
---

Register the structured-output tool under the snake_case name models actually emit (`structured_output`; `workflow_script` renamed likewise), so direct tool calls no longer miss. Nested codemode calls no longer mask a missed structured-output turn — the reminder now fires correctly. Session and journal replay still recognize the legacy hyphenated name.

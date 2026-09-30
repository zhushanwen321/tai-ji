---
'@zhushanwen/pi-plan': minor
---

Adds the `@zhushanwen/pi-exec-skills` dependency: execution-mode selection now discovers plan-exec skills through the exec-skills registry (`detectExecSkills`) and builds the exec-mode options from them; when no skills are registered the plan completes with the default execute mode directly, without the exec-mode form.

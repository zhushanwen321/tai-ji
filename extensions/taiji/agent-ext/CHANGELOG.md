# @zhushanwen/pi-agent-ext

## 1.3.0

### Minor Changes

- 50f31a73c: The `/__taiji_reload__` internal command is removed along with the W5 skill-change→pi-reload orchestration it served: slash menu and composer injection now resolve skills from the taiji SkillRegistry, so a full pi reload (extension ctx invalidate + extension cache clear) bought nothing but stale pi-side skill lists, and the reload itself broke background-task completion notifications in the stale module world — accepted degradation per ADR-0050. The Trace view's `/__taiji_get_system_prompt__` fetch-current command is unchanged.

## 1.2.2

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory

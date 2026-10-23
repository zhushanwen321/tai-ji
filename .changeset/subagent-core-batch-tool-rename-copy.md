---
'@zhushanwen/subagent-core': patch
---

Align the recovery hints embedded in runtime messages with the batch tool rename in `@zhushanwen/pi-subagent-workflow` (`subagents` → `subagent_batch`): the workflow-origin messaging rejection now says results are re-dispatched via `subagent_batch`, the nested-teardown warning points at `subagent_manage action:'list' includeWorkflow:true` plus `subagent_batch`, and the `workflows/fan-out.js` template usage text names `subagent_batch`. No behavior change — these strings name the workflow package's tool registration names (cross-package implicit contract, see docs/extensions/extension-conventions.md) and are locked verbatim by unit and e2e assertions.

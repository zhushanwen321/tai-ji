---
'@zhushanwen/pi-subagent-workflow': major
'@zhushanwen/subagent-core': major
---

BREAKING CHANGE: the nested `workflow()` orchestration API family is removed (workflow capability audit verdicts C-1/C-2 + A-1, commit 6960477cf).

- Worker-script `workflow(name, args)` global no longer exists. Scripts saved in `.pi/workflows/` / `~/.pi/agent/workflows/` that call `workflow()` now fail at run start with a ReferenceError — this is not caught by script lint, so existing scripts only break when run. Migration: inline the sub-workflow's steps as direct `agent()` calls, or split the composition into separate `workflow run` invocations. The built-in orchestration workflows (chain / parallel / fan-out / scatter-gather / map-reduce / review-fix-loop in the `workflows/` directory of `@zhushanwen/subagent-core`) remain available; they compose via `agent()` directly.
- `pipeline()` only accepts the single-array form `pipeline([stage1, stage2, ...])`; the multi-argument Cartesian form `pipeline([items], stage1, stage2, ...)` is removed. Migration: map items through the stages manually, e.g. `await parallel(items.map((item) => stage1(item).then(stage2)))` or an explicit for-loop.
- `pi.__workflowRun` cross-extension programming API is removed from the extension registration surface. No migration needed: the channel was already unreachable at runtime under pi 0.84.4 per-extension API isolation and had zero consumers.

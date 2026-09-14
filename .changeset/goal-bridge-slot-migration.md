---
'@zhushanwen/pi-goal': patch
'@zhushanwen/pi-plan': patch
---

goal-bridge cross-extension channel fix (pi 0.84.4 per-extension API isolation):

- goal: `__goalInit` exposure migrated from pi-API-object mounting (runtime
  unreachable — pi 0.84.4 creates an independent ExtensionAPI per extension)
  to a bare-function `globalThis[Symbol.for("@zhushanwen/pi-goal.goalInit")]`
  slot (C-ext-06 convention); `GoalInitFn` signature unchanged
- plan: goal-bridge probe migrated to the same slot with a typeof guard
  (`getGoalInit`/`detectGoalCapability`/`tryGoalInit` signatures drop the
  pi param); the "Goal-driven execution" tier now appears in the complete
  dialog when both extensions are loaded — bridged goal init works end to
  end, five D2 failure exits become reachable on the real path
- tests on both sides mount the slot (mock world mirrors the real channel);
  docs/design bridge wording backfilled (ext-simplify-03/06, pi-ext-020
  dead-channel annotation)

---
'@zhushanwen/pi-goal': patch
'@zhushanwen/pi-plan': patch
'@zhushanwen/pi-scheduler': patch
'@zhushanwen/pi-todo': patch
---

State reconstruction now follows the session tree's active path after a rewind (message revoke via `__taiji_nav__`, or a manual tree jump), so rewinded-away content no longer leaks back into the agent:

- `pi-goal`: new `session_tree` handler rebuilds goal state and refreshes the widget immediately; the reconstruction input is clipped to the active path, so revoked goals are no longer injected round after round via `before_agent_start` and no longer linger in the widget when revoked before goal creation
- `pi-plan`: same `session_tree` handler closes the stale `getPlanState` cache window after a rewind; plan-state replay is clipped to the active path, so revoked requirements no longer surface in compaction summaries or the plan widget
- `pi-scheduler`: task folding is clipped to the active path and re-folded when the tree is rewound (new optional `SchedulerBackend.onSessionTree` hook), so revoked tasks no longer come back as pending and no longer fire a real turn when due
- `pi-todo`: todo-state replay is clipped to the active path, so revoked todo snapshots no longer ride into model context via `<todo_context>`

The rewind handlers are pure rebuilds — no messages sent, no entries appended — preserving the "revoked content never happened" semantics. Legacy linear session files without tree info keep the previous whole-file replay behavior; the scheduler interface additions are optional so custom backends and test doubles are unaffected.

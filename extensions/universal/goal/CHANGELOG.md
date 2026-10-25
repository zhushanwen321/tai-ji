# @zhushanwen/pi-goal

## 0.16.1

### Patch Changes

- 318994f4a: The `goal_control` tool is now always declared to the model (resident) instead of being activated only through tool_search, so goal tracking works without a discovery step.

## 0.16.0

### Minor Changes

- df839883b: The goal engine's status machine is now declared via `@zhushanwen/state-machine` instead of the hand-written adjacency table. **Breaking for direct importers: the exported `VALID_TRANSITIONS` constant was removed from the goal engine — the state machine declaration is the single source of truth for legal transitions.** The public `transitionStatus` wrapper keeps its signature and behavior: identical legal transitions, identical throw (same message) on out-of-table transitions. Users interacting only through the `/goal` command see no change.

## 0.15.0

### Minor Changes

- 796f01b29: goal_control 结果 details 新增 summary 收起态一行摘要；TUI 展开态改为显示 content 全文，折叠态显示摘要行，历史条目回退原 ◆ 状态行。

## 0.14.15

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.20.0 → @zhushanwen/extension-protocol@0.21.0)

## 0.14.14

### Patch Changes

- 993ee907f: Slim the goal_control declaration (per-action semantics and budget policy single-sourced into schema field descriptions and guidelines instead of three redundant layers) and mark it exposure:deferred — it activates on a tool_search hit instead of staying in the resident tool list.

  Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

## 0.14.13

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.19.0 → @zhushanwen/extension-protocol@0.20.0)

## 0.14.12

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.18.0 → @zhushanwen/extension-protocol@0.19.0)

## 0.14.11

### Patch Changes

- 802af968f: message_end handling now consumes only user/assistant messages, so pi 1.0.0's frequent system-message writes (tool-set changes) and malformed message shapes no longer pollute goal token accounting. Also pins the pi peer dependency range to ^1.0.0.

## 0.14.10

### Patch Changes

- 0d36077d4: State reconstruction now follows the session tree's active path after a rewind (message revoke via `__taiji_nav__`, or a manual tree jump), so rewinded-away content no longer leaks back into the agent:

  - `pi-goal`: new `session_tree` handler rebuilds goal state and refreshes the widget immediately; the reconstruction input is clipped to the active path, so revoked goals are no longer injected round after round via `before_agent_start` and no longer linger in the widget when revoked before goal creation
  - `pi-plan`: same `session_tree` handler closes the stale `getPlanState` cache window after a rewind; plan-state replay is clipped to the active path, so revoked requirements no longer surface in compaction summaries or the plan widget
  - `pi-scheduler`: task folding is clipped to the active path and re-folded when the tree is rewound (new optional `SchedulerBackend.onSessionTree` hook), so revoked tasks no longer come back as pending and no longer fire a real turn when due
  - `pi-todo`: todo-state replay is clipped to the active path, so revoked todo snapshots no longer ride into model context via `<todo_context>`

  The rewind handlers are pure rebuilds — no messages sent, no entries appended — preserving the "revoked content never happened" semantics. Legacy linear session files without tree info keep the previous whole-file replay behavior; the scheduler interface additions are optional so custom backends and test doubles are unaffected.

## 0.14.9

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.15.0 → @zhushanwen/extension-protocol@0.16.0, @zhushanwen/pi-pending-notifications@0.7.7 → @zhushanwen/pi-pending-notifications@0.8.0)

## 0.14.8

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.14.0 → @zhushanwen/extension-protocol@0.15.0)

## 0.14.7

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.13.0 → @zhushanwen/extension-protocol@0.14.0)

## 0.14.6

### Patch Changes

- 8285841af: Route resume/set prompts through the sendContextMessage port: injected steering prompts now go out as custom messages instead of user messages, so the conversation stream no longer fabricates user bubbles. LLM-visible content is unchanged.

## 0.14.5

### Patch Changes

- a59739edb: Goal widget meta now pushes an explicit tray icon (`icon: "target"`, the

  lucide key the host maps `goal` to by default). The icon no longer relies on
  the host's built-in widgetKey fallback map, so host-side mapping changes
  cannot silently swap the goal icon. No `badge` is pushed: the tray derives
  the budget percentage from the existing `progress.label` (e.g. "42%"), so the
  percentage format keeps a single source of truth.

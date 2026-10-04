# @zhushanwen/pi-scheduler

## 0.9.3

### Patch Changes

- 0d36077d4: State reconstruction now follows the session tree's active path after a rewind (message revoke via `__taiji_nav__`, or a manual tree jump), so rewinded-away content no longer leaks back into the agent:

  - `pi-goal`: new `session_tree` handler rebuilds goal state and refreshes the widget immediately; the reconstruction input is clipped to the active path, so revoked goals are no longer injected round after round via `before_agent_start` and no longer linger in the widget when revoked before goal creation
  - `pi-plan`: same `session_tree` handler closes the stale `getPlanState` cache window after a rewind; plan-state replay is clipped to the active path, so revoked requirements no longer surface in compaction summaries or the plan widget
  - `pi-scheduler`: task folding is clipped to the active path and re-folded when the tree is rewound (new optional `SchedulerBackend.onSessionTree` hook), so revoked tasks no longer come back as pending and no longer fire a real turn when due
  - `pi-todo`: todo-state replay is clipped to the active path, so revoked todo snapshots no longer ride into model context via `<todo_context>`

  The rewind handlers are pure rebuilds — no messages sent, no entries appended — preserving the "revoked content never happened" semantics. Legacy linear session files without tree info keep the previous whole-file replay behavior; the scheduler interface additions are optional so custom backends and test doubles are unaffected.

## 0.9.2

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.15.0 → @zhushanwen/extension-protocol@0.16.0)

## 0.9.1

### Patch Changes

- 43a50ae2e: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged. Also in `@zhushanwen/pi-llm-shared`: the `callLLM` success result now carries an optional terminal `stopReason` (additive, present only when reported), letting callers distinguish `length` budget truncation from a normally empty completion on `stop`.

## 0.9.0

### Minor Changes

- 8285841af: Scheduler direct-create + per-task execution model. The `schedule` tool now creates tasks immediately in every session mode — headless and interactive alike, with no confirmation gate and no headless annotation; an aborted create returns a cancelled notice and nothing is created. Humans create tasks through the `/schedule` command, which opens a form (GUI overlay with time chips/datetime, execution-model picker, prompt preview, live cron preview; TUI five-tab form). Tasks may pin a `model` field — at fire time the runtime switches to it, restores the previous model afterwards, with mutex retry and reconciliation fallback.

- 8285841af: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged.

## 0.8.1

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory

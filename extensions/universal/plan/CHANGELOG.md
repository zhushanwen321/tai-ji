# @zhushanwen/pi-plan

## 1.1.1

### Patch Changes

- 32854b942: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.18.0 → @zhushanwen/extension-protocol@0.19.0, @zhushanwen/pi-goal@0.14.11 → @zhushanwen/pi-goal@0.14.12)

## 1.1.0

### Minor Changes

- 802af968f: The `/plan` command now shows visible notifications for entering plan mode, for existing plan files found in `.tmp/plans`, and for fail-fast errors (unknown skills, template problems) — these were previously injected into the model context only and invisible to you (requires pi 1.0.0).

## 1.0.0

### Major Changes

- 0d36077d4: State reconstruction now follows the session tree's active path after a rewind (message revoke via `__taiji_nav__`, or a manual tree jump), so rewinded-away content no longer leaks back into the agent:

  - `pi-goal`: new `session_tree` handler rebuilds goal state and refreshes the widget immediately; the reconstruction input is clipped to the active path, so revoked goals are no longer injected round after round via `before_agent_start` and no longer linger in the widget when revoked before goal creation
  - `pi-plan`: same `session_tree` handler closes the stale `getPlanState` cache window after a rewind; plan-state replay is clipped to the active path, so revoked requirements no longer surface in compaction summaries or the plan widget
  - `pi-scheduler`: task folding is clipped to the active path and re-folded when the tree is rewound (new optional `SchedulerBackend.onSessionTree` hook), so revoked tasks no longer come back as pending and no longer fire a real turn when due
  - `pi-todo`: todo-state replay is clipped to the active path, so revoked todo snapshots no longer ride into model context via `<todo_context>`

  The rewind handlers are pure rebuilds — no messages sent, no entries appended — preserving the "revoked content never happened" semantics. Legacy linear session files without tree info keep the previous whole-file replay behavior; the scheduler interface additions are optional so custom backends and test doubles are unaffected.

- 0d36077d4: Adds the `@zhushanwen/pi-exec-skills` dependency: execution-mode selection now discovers plan-exec skills through the exec-skills registry (`detectExecSkills`) and builds the exec-mode options from them; when no skills are registered the plan completes with the default execute mode directly, without the exec-mode form.

  Further public-surface changes in this release:

  - Removes the `isolation` parameter from the `plan` tool schema (the compact|direct two-tier dispatch is gone; a single direct-delivery path remains).
  - `submit-review` now hard-requires a non-empty `selfReview` (agent self-review conclusions, no exemption — including re-submissions after revisions): missing input gets a corrective error instead of an open review, and re-submitting changed documents with a byte-identical selfReview is rejected as stale.
  - Review decisions gain a third key `dismiss` (non-destructive shelve: plan mode stays active, no state lost, the shelved approval does not come back) alongside approve / revise.
  - `complete` is now gated on user approval as a structural guarantee: calling it without a pending approval (e.g. straight from planning state) fails with `out-of-order` and is steered back to `submit-review`.
  - The `plan-state` session entry writes the unified `state` field (eight-value lifecycle) plus `selfReview` / `resumeHint`; the legacy `reviewState` / `reviewStateSource` fields are no longer written (read-side mapping keeps old sessions readable).
  - `/plan abort` on an already-inactive plan now answers with a corrective warning instead of a silent no-op.

## 0.5.2

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.15.0 → @zhushanwen/extension-protocol@0.16.0, @zhushanwen/pi-goal@0.14.8 → @zhushanwen/pi-goal@0.14.9)

## 0.5.1

### Patch Changes

- 43a50ae2e: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged. Also in `@zhushanwen/pi-llm-shared`: the `callLLM` success result now carries an optional terminal `stopReason` (additive, present only when reported), letting callers distinguish `length` budget truncation from a normally empty completion on `stop`.

## 0.5.0

### Minor Changes

- 8285841af: Plan review mode: agents can present plan documents for human review before implementation. Adds a `--skills` extension workflow with review actions (approve / revise / cancel), a submit-review result channel whose cancelled and inactive outcomes are explicitly worded as "not an approval" (so the agent never mistakes a cancellation for a go-ahead), a resubmission guard that warns when reviewed docs are unchanged, and an E8 text-channel result that always carries the revision-loop instructions.

  **Dependency requirement change**: the pi peer dependency is tightened from `>=0.73.0` to `^0.84.4` (plus a new optional `pi-tui` peer at the same range) — installs alongside pi 0.73–0.84.3 will fail peer resolution. Taiji's bundled distribution is unaffected (built-in extensions bypass npm peer resolution).

- 8285841af: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged.

## 0.4.9

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory

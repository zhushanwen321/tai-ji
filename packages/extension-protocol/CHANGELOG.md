# @xyz-agent/extension-protocol

## 0.10.0

### Minor Changes

- 893b702b6: BREAKING CHANGE (0.x, carried as minor): the subagent in-flight report protocol drops the `kind` field. The exported type `InFlightReportKind` and constant `INFLIGHT_REPORT_KINDS` are removed, and `SubagentInFlightReport` no longer carries a required `kind` field — a frame is now `{ inFlight, sessionId?, emittedAt }`, and the `isSubagentInFlightReport` guard accepts the narrowed shape. Consumers producing or consuming in-flight frames must stop writing and reading `kind`.

## 0.9.0

### Minor Changes

- 4955dad6e: Subagent in-flight report protocol module.

  Adds the `src/extensions/subagent-inflight/` protocol module (~195 lines): `SUBAGENT_INFLIGHT_MARKER` marker constant, `isInFlightReportAck` frame predicate, `SubagentInFlightReport` / ack payload types, and encode/decode helpers for the in-flight subagent reporting channel consumed by `@zhushanwen/pi-subagent-workflow` (host/inflight-reporter). Purely additive — no existing exports change.

## 0.8.2

### Patch Changes

- bbd8e5e8a: README fixes: example fidelity and structure alignment; session-manager nested {action,params} fix guidance split by entry form (ghost-entry guidance).

## 0.8.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.8.0

### Minor Changes

- 7b33e6f00: **Supplemental changesets for five packages that changed src without a declaration (4N.1 scan finding)**

  - `@xyz-agent/extension-protocol`: add the `background-task` protocol module (task registration/reaping contract types consumed by the runtime background-task reaper sunk from base-tool-enhance), plus 183 lines of contract tests and index re-exports.
  - `@zhushanwen/pi-msg-id-mapper`: comment/test text sync with implementation (stale pi version comment fix, dead test mock dropped).
  - `@zhushanwen/pi-smart-context`: minor text sync in pure.ts.
  - `@zhushanwen/pi-system-prompt`: doc-comment sync clarifying the deliberate divergence from pi 0.84.4's `loadContextFileFromDir` (global-dir-only candidate list, no `AGENTS.override.md`); no behavior change.
  - `@zhushanwen/pi-unified-hooks` (deprecated package): text sync with implementation in the deprecated notice era.

## 0.7.0

### Minor Changes

- b3a8cf77b: **extension-protocol: subagent-engine discoverability contract**

  - New `extensions/subagent-engine` contract shared by the write side (`pi-subagent-workflow` publishes the registered engine list to `<agentDir>/subagents/engines.json` on session start) and the read side (xyz-agent runtime `subagent.getEngineConfig` / `subagent.setDefaultEngine` RPC feeding the Settings engine dropdown)
  - Exports: `SUBAGENTS_ENGINES_FILENAME`, `SubagentEnginesFile` (v1 state-file shape) and `SubagentEngineConfigView` (engines + defaultEngine composite view with `['pi']` fallback)

## 0.6.0

### Minor Changes

- df69a18fc: Add session-manager public API: SESSION_MANAGER_MARKER, SESSION_MANAGER_ACTIONS, 16 session-manager types and 6 param guards (consumed by @zhushanwen/pi-session-manager 0.1.0)

## 0.5.1

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.5.0

### Minor Changes

- 07b5a813d: GUI widget protocol v1.1: meta-head architecture and new layout primitives

  `WidgetMeta` introduces a single head row (title, status dot, progress count "N/M", mini progress bar) rendered by the host shell, replacing per-row icons and ids burned into labels. The body now uses a numbered `list-tree` (optional `numbered` field for flat ordered lists) and gains a `vertical-group` container primitive — a visually transparent grouping root for composing multiple components inside a widget once the host shell owns the card chrome. The head status field maps running/done/failed/idle onto accent/success/danger/neutral dots.

  Extensions push widget state through the new `guiSetWidget` channel (marker-encoded `GuiRenderResult` over the native `setWidget` transport) instead of attaching `details.__gui__` to tool results. `extractGui` keeps v1/v1.1 dual-format support as a legacy read path during the transition.

## 0.4.0

### Minor Changes

- Remove the ask-user comment feature end-to-end and drop `AskUserOption.value`.

  Breaking changes in this version:

  - `AskUserQuestion.allowComment` field removed — the comment interaction is deleted from all three consumers (protocol, pi-ask-user extension, renderer `AskUserOverlay`) in one atomic delivery. This is the corrective counterpart of 6e2e453 (which restored the field after a one-sided 0.3.0 deletion broke the contract); this time the extension and renderer are changed in the same wave, so no consumer is left depending on the removed API.
  - `AskUserOption.value` removed — proto options no longer carry a separate return value; the selected label is the value (D1 model merge).
  - `getAskUserComment` helper removed — the `${key}__comment` protocol key no longer exists. Answers are decoded with `getAskUserAnswer` / `getAskUserOther` only.

  Per semver convention for 0.x packages, this breaking change ships as a minor bump (0.3.1 → 0.4.0).

## 0.3.1

### Patch Changes

- 6e2e453: Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

  **Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

  Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.

## 0.3.1-dev.0

### Patch Changes

- 6e2e453: Restore `getAskUserComment` helper and `AskUserQuestion.allowComment` field removed in 0.3.0: consumers (pi-ask-user TUI comment mode, renderer AskUserOverlay) still implement the comment interaction end-to-end, so the protocol deletion broke the contract (pi-ask-user@4.0.0 ESM import crash).

  **Version alignment note**: pi-ask-user is linked with `@zhushanwen/pi-subagent-workflow` and `@zhushanwen/pi-structured-output` in `.changeset/config.json`. The subagent-workflow major changeset (tidy-waves-description-phase-lint, 4.0.0 → 5.0.0) forces the whole linked group to 5.0.0, so pi-ask-user will actually be published as **5.0.0**, not the originally expected 4.0.1 — the original 4.0.1 expectation is absorbed by the linked-group major bump.

  Renderer side: `packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue` and its test carry branch-side changes (comment UI + U12 `__comment` assertion) that conflict with main's 4.0.0 deletion — resolve the merge keeping the comment UI, since the restored `allowComment` field's GUI consumer lives there.

## 0.3.0

### Minor Changes

- 74a0b10: Two changes ship in this PR:

  1. Remove the ask-user comment feature end-to-end:

     - `@xyz-agent/extension-protocol`: remove `getAskUserComment` helper and
       `allowComment` field from the ask-user protocol (breaking — package is
       still 0.x, so a `minor` bump denotes a breaking change per semver).
     - `@zhushanwen/pi-ask-user`: remove the public tool-schema field
       `allowComment`, the `ANSWER_COMMENT_SEPARATOR` split, the comment
       interaction mode, and `getAskUserComment` usage (breaking — public API
       removal, `major` bump).

  2. Add `thinkingLevel` support to subagent-workflow's `agent()`:
     - `@zhushanwen/pi-subagent-workflow`: `agent()` now accepts an optional
       `thinkingLevel` option (off|minimal|low|medium|high|xhigh) propagated
       through to the pi CLI spawn args (additive feature, `minor` bump).

  `@zhushanwen/pi-structured-output` is in the same changeset `linked` group as
  the two `@zhushanwen/pi-*` packages and has no code changes; `changeset
version` will reconcile it to the group's highest bump automatically.

## 0.2.0

### Minor Changes

- Initial npm release of the extension GUI rendering protocol package.
  Includes types and helper functions for pi extension dual-mode (TUI/GUI) rendering.

## 0.1.1-dev.0

### Patch Changes

- Prerelease build for testing.

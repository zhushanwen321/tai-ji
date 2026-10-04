# @zhushanwen/extension-protocol

## 0.14.0

### Minor Changes

- 43a50ae2e: Adds `action-bar` as the first interactive GuiComponent primitive, and sinks the scheduler task folder and its formatters from the scheduler extension into this shared protocol package (single source for cross-package schedule draft handling).

## 0.13.0

### Minor Changes

- 8285841af: Adds the plan-review marker protocol (`PLAN_REVIEW_MARKER`) and the scheduler-create interactive protocol (`SCHEDULE_CREATE_MARKER`), plus a new `scheduler-create` submodule with schedule draft helpers (`dateToOnceCron`, `onceCronToDate`, `isScheduleDraft`) and `PlanReview` shared types for the plan review workflow. Also adds the new `ui-form` submodule: the unified ask/form protocol with `UI_FORM_MARKER`, `uiFormInteract`, the `FormQuestion` type family (`FormQuestion`/`ChoiceQuestion`/`TextQuestion`/`ScheduleQuestion`/`FormOption`/`FormAnswers`/`UiFormInteractResult`/`UiFormInteractOptions`), and the `isFormQuestion`/`isFormAnswers` shape guards.

  **Removal**: the retired `askUserInteract` export is gone from the public surface — GUI ask-user interactions moved to the unified form protocol (`uiFormInteract` in the `ui-form` submodule). The bundled `@zhushanwen/pi-ask-user` extension ships its own independent copy, so already-installed ask-user versions are unaffected. `ASK_USER_MARKER` remains exported as a legacy frame identifier until its removal window.

## 0.12.0

### Minor Changes

- a59739edb: Widen the custom widget icon path whitelist to the complete SVG `d` command set:

  - `validateWidgetIconPaths` now accepts `S`/`s`/`T`/`t` (smooth cubic /
  quadratic curve commands) on top of the previous `MLCQAZHV` command letters.
  The old charset rejected 58 of the 5869 `d` strings across the 1746
  `@lucide/vue` icons (~1%), so about 1% of valid shapes silently fell back to
  a built-in icon plus a warn. Visible to extension authors: a `{ paths }`
  value previously rejected as `illegal-char` may now validate.
  - No other character is added — `e`/`E` (exponent notation) and every other
  non-command character stay rejected; the limits (at most 8 paths, 512 chars
  per path, 2048 chars in total) are unchanged.

- a59739edb: Composer task tray protocol fields (all additive, backward compatible):

  - `WidgetMeta` gains optional `icon?: string | { paths: string[] }` and
  `badge?: string`: a tray icon reference (host-resolved lucide key, or
  extension-defined shape as path `d` strings) and a short
  extension-formatted badge text (host truncates to 6 chars, full text in
  title). Shape belongs to the extension, style stays host-locked (the
  renderer fixes stroke width/color/size, so custom shapes are always the
  same thin-line family as lucide icons). Old hosts/old extensions are
  unaffected — both fields are optional and the `isGuiRenderResult` guard
  does not inspect meta shape.
  - `tab-bar` props gain optional `sections?: GuiComponent[][]` (same length
  as `tabs`): section i is the subtree rendered while `tabs[i]` is active.
  Omitted keeps the current display-only tab-bar; the host owns the active
  index locally (a push never resets the user's local tab choice), and a
  length mismatch degrades to display-only plus a warn.
  - New `validateWidgetIconPaths` helper (`WidgetIconPathsValidation` /
  `WidgetIconPathsRejection`): whitelist validation for custom icon path
  `d` strings (charset `^[MLCQAZHVSTmlcqazhvst0-9 ,.\-]+$` — S/s/T/t smooth
  curve commands included so ~1% of real-world shapes are not rejected; at
  most 8 paths, at most 512 chars per path, at most 2048 chars in total).
  Never throws — it returns the validated paths copy or a rejection reason
  so the host can fall back to a built-in icon and warn.

## 0.11.0

### Minor Changes

- 65a462c: First public release of `@zhushanwen/extension-protocol` on npm. The package was previously workspace-only while `@zhushanwen/subagent-core` (and renderer consumers) declare it as a dependency, so publishing subagent-core without it would replace `workspace:*` with a range that resolves to nothing on the registry (npm install E404). Publishing at the current 0.10.0 version keeps the monorepo version line intact.

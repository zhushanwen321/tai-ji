---
'@zhushanwen/extension-protocol': minor
---

Adds the plan-review marker protocol (`PLAN_REVIEW_MARKER`) and the scheduler-create interactive protocol (`SCHEDULE_CREATE_MARKER`), plus a new `scheduler-create` submodule with schedule draft helpers (`dateToOnceCron`, `onceCronToDate`, `isScheduleDraft`) and `PlanReview` shared types for the plan review workflow. Also adds the new `ui-form` submodule: the unified ask/form protocol with `UI_FORM_MARKER`, `uiFormInteract`, the `FormQuestion` type family (`FormQuestion`/`ChoiceQuestion`/`TextQuestion`/`ScheduleQuestion`/`FormOption`/`FormAnswers`/`UiFormInteractResult`/`UiFormInteractOptions`), and the `isFormQuestion`/`isFormAnswers` shape guards.

**Removal**: the retired `askUserInteract` export is gone from the public surface — GUI ask-user interactions moved to the unified form protocol (`uiFormInteract` in the `ui-form` submodule). The bundled `@zhushanwen/pi-ask-user` extension ships its own independent copy, so already-installed ask-user versions are unaffected. `ASK_USER_MARKER` remains exported as a legacy frame identifier until its removal window.

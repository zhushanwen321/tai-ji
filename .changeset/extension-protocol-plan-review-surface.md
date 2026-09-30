---
'@zhushanwen/extension-protocol': minor
---

Extends the plan contract surface: `PlanReviewDecision` gains the `dismiss` member, `PlanReviewRequest` gains the optional `selfReview` field (agent self-review summary attached to review requests), the `extensions/plan` contract family (state machine, review contract, legacy entries) is now exported from the package root, and the `PLAN_STATE_CUSTOM_TYPE` constant moves into this package.

---
'@zhushanwen/pi-plan': major
---

Adds the `@zhushanwen/pi-exec-skills` dependency: execution-mode selection now discovers plan-exec skills through the exec-skills registry (`detectExecSkills`) and builds the exec-mode options from them; when no skills are registered the plan completes with the default execute mode directly, without the exec-mode form.

Further public-surface changes in this release:

- Removes the `isolation` parameter from the `plan` tool schema (the compact|direct two-tier dispatch is gone; a single direct-delivery path remains).
- `submit-review` now hard-requires a non-empty `selfReview` (agent self-review conclusions, no exemption — including re-submissions after revisions): missing input gets a corrective error instead of an open review, and re-submitting changed documents with a byte-identical selfReview is rejected as stale.
- Review decisions gain a third key `dismiss` (non-destructive shelve: plan mode stays active, no state lost, the shelved approval does not come back) alongside approve / revise.
- `complete` is now gated on user approval as a structural guarantee: calling it without a pending approval (e.g. straight from planning state) fails with `out-of-order` and is steered back to `submit-review`.
- The `plan-state` session entry writes the unified `state` field (eight-value lifecycle) plus `selfReview` / `resumeHint`; the legacy `reviewState` / `reviewStateSource` fields are no longer written (read-side mapping keeps old sessions readable).
- `/plan abort` on an already-inactive plan now answers with a corrective warning instead of a silent no-op.

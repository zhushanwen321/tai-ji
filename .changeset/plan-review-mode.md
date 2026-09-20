---
'@zhushanwen/pi-plan': minor
---

Plan review mode: agents can present plan documents for human review before implementation. Adds a `--skills` extension workflow with review actions (approve / revise / cancel), a submit-review result channel whose cancelled and inactive outcomes are explicitly worded as "not an approval" (so the agent never mistakes a cancellation for a go-ahead), a resubmission guard that warns when reviewed docs are unchanged, and an E8 text-channel result that always carries the revision-loop instructions.

**Dependency requirement change**: the pi peer dependency is tightened from `>=0.73.0` to `^0.84.4` (plus a new optional `pi-tui` peer at the same range) — installs alongside pi 0.73–0.84.3 will fail peer resolution. Taiji's bundled distribution is unaffected (built-in extensions bypass npm peer resolution).

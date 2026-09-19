---
'@zhushanwen/pi-plan': minor
---

Plan review mode: agents can present plan documents for human review before implementation. Adds a `--skills` extension workflow with review actions (approve / revise / cancel), a submit-review result channel whose cancelled and inactive outcomes are explicitly worded as "not an approval" (so the agent never mistakes a cancellation for a go-ahead), a resubmission guard that warns when reviewed docs are unchanged, and an E8 text-channel result that always carries the revision-loop instructions.

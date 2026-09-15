---
'@zhushanwen/subagent-core': patch
'@zhushanwen/pi-subagent-workflow': patch
---

Fix silent loss of round-2 batch completion notifications for `collect:"sync"` subagents (2026-09-14 incident, session 01a09f85). Root cause was threefold: `collectMode:"sync"` persisted across rounds so message-driven follow-up rounds re-routed their notifications into the sync batch buffer; the batch notifyId only hashed member ids so the second round collided with the first round's already-acked ledger key; and the idempotent rejection was fully silent. Batch notifyId now includes per-member epoch/round, `action:"message"` to a sync member is rejected with close-and-restart recovery guidance (tool description updated to match), and duplicate-notifyId rejections now log a warn. Same-round re-flush dedup semantics are preserved.

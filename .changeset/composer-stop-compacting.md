---
"@taiji/electron": patch
---

Restore the stop button on the composer send slot during compaction: while compacting (any turn state, including manual `/compact` and threshold auto-compaction) the send button becomes a stop button titled "Stop compaction" that aborts the compaction run (via the existing abort path — pi `session.abort` → `abortCompaction`). Sending during compaction still works through Enter (the delivery kernel queues the message and flushes it when compaction ends). Previously the button stayed in queue form for the whole compaction window, leaving no way to stop a long-running compression. Runtime aborts during compaction with no turn in flight now use compaction-cancel semantics: no `stopped` session outcome is persisted and no `message.complete{aborted}` frame is broadcast (the session stays alive and idle; queued messages are flushed immediately).

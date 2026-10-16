---
"@zhushanwen/subagent-core": patch
---

Fix executeAndAwait engine resolution: the run now resolves its engine through a one-shot window keyed by the record id (the same key as the journal task id) and disposes that window at both settle points, instead of the keyless path that returned a read-only proxy for per-window engines and made engine.run() throw WindowScopeEngineError (this broke canvas reviewer dispatch). Also harden review-fix-loop aggregation: reject duplicate (round, id) entries within one review-append batch instead of silently keeping the last one, and carry title/severity through on aggregator carry-forward entries.

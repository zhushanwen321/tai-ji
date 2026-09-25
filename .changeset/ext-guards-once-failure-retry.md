---
'@zhushanwen/pi-ext-guards': patch
---

`oncePerProcess` no longer caches failures: a synchronous throw or a rejected Promise leaves no cached record, so the next call with the same key re-executes instead of replaying the old error. Successful results are still cached and replayed by reference exactly once. This lets process-level maintenance guards (crash recovery, config migration) retry on the next trigger after a transient failure instead of staying broken for the rest of the process; the retry cadence is up to the caller, and a failed operation may run twice across retries (by design, since only successes are memoized).

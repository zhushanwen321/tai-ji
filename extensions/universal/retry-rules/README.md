# @zhushanwen/pi-retry-rules

Retryable error rules for Pi: rewrites finalized `stopReason=error` assistant messages via the
official `message_end` hook (appending a `[taiji-retry:` marker) so that throttling-class provider
errors hit pi-ai's native retryable word list and the native retry loop (auto_retry events,
exponential backoff, failed-attempt omission) takes over.

- Decision pipeline: two-tier order — `non_retryable` verdict rules exclude first (per source),
  then same-verdict rules by source priority `custom > remote > builtin`, first match wins.
- Matching channels: regex against `errorMessage` (ReDoS-guarded) + JSON-snippet dot-path
  extraction (`"${status}: ${body-json}"` openai-compat form).
- Config file: `<agentDir>/config/retry-rules-ext-config.json` (mtime hot reload; written by the
  taiji runtime — single data source, this extension is a pure consumer).
- Disable path: no dedicated switch — turn off pi's native retry settings
  (`enabled=false` / `maxRetries=0`); the native gate is checked before the retryable-word-list
  verdict, so rewrites never trigger retries when disabled.
- Semantic SSOT: `packages/shared/src/retry-rules.ts` (this bundle carries a mirrored copy with
  behavior-lock tests).

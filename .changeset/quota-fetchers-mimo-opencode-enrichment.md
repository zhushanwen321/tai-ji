---
'@xyz-agent/runtime': patch
---

Quota fetchers: enrich MiMo month window (token used/limit from `tokenPlan/usage` items, reset countdown from `tokenPlan/detail` `currentPeriodEnd` parsed as UTC) and align request headers with the web console (browser UA + fixed `x-timezone: UTC`); classify all cookie-expiry shapes as `unauthorized` (in-body code 401/403, 3xx login redirect via `redirect: manual`); normalize pasted cookie whitespace; OpenCode fetcher now tolerates partially missing SSR usage windows instead of failing the whole query.

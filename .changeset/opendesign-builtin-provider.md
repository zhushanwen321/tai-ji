---
'@taiji/shared': minor
'@taiji/runtime': minor
'@taiji/frontend': minor
---

Add OpenDesign as a builtin provider with Coding Plan quota support. The provider settings page now lists OpenDesign (12 models, `deepseek-v4.1-flash` verified with deepseek thinking compat) via the builtin template list, and the quota system gains an `opendesign` fetcher that queries `coding-plan-usage` with the better-auth session cookie plus a workspace id; workspace input normalization is now routed per fetcher (bare workspace id or amr-api URL for OpenDesign).

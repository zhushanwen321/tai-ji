---
"@zhushanwen/subagent-core": patch
---

Raise review-fix-loop wall-clock defaults to 2h: reviewer / aggregator / retry / env-fix / repair agent timeouts (was 1h / 20min / 10min) and the git retry / stage / status wrappers (was 60s / 30s) in the pi build; the zcode build's git/sh runner now passes an explicit 2h timeout instead of falling back to the engine's 300s default. Commits carrying pre-commit hooks and instrumented gate runs under load were being killed by the short defaults.

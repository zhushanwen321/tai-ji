---
"@zhushanwen/pi-subagent-workflow": patch
---

Fix built-in workflows and agents not being discovered in bundled/packaged builds: the resolver now falls back to the staged scope root when `require.resolve` fails in self-contained bundles, so the `subagents` batch tool no longer reports "Built-in workflow fan-out is not available".

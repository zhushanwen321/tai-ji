---
"@zhushanwen/pi-subagent-workflow": patch
---

fix: grandchild pi inherits main-process extensions minus an exclusion list

The previous whitelist (structured-output only) stripped network-reachability
and utility extensions from grandchild pi processes. LLM requests then ran on
flaky paths — observed as batch `Request timed out.` / `Connection error.`
results with 10.5s connect-timeout signatures (IPv6-first happy-eyeballs
exhausting the connect budget). Grandchildren are full agents and also lost
commonly needed tools (session_read, collect_results, compact_context).

Grandchildren now inherit the main process extension set except packages that
need a human or the host session lifecycle: plan, canvas, goal, scheduler.
Both npm staged (`@zhushanwen/pi-*`) and dev source (`<group>/<pkg>`) path
aliases are registered per package.

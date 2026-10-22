---
"@zhushanwen/pi-subagent-workflow": major
---

Breaking: `subagents` tool batch params — `tasks` now takes member objects instead of strings, and the `agents` / `aggregate` params are removed.

- `tasks: [{ task, agent?, model?, thinkingLevel? }]` (min 1) — each member can set its own executor, model, and thinking level (e.g. use a healthy provider for one member while others inherit the run-level default). Run-level `agent` / `model` / `thinkingLevel` act as defaults for members that omit them.
- `agents` (comma-separated path string) is replaced by per-member `agent` or the run-level `agent` param; `aggregate` is removed — reduce results yourself after the batch returns. Calls carrying either old param fail fast with a `Correct:` shape.
- `subagents` is now always declared to the model (no longer deferred), so the member-object schema is visible from the first turn.

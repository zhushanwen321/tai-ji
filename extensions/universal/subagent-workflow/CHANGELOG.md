# @zhushanwen/pi-subagent-workflow

## 8.14.5

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 8.14.4

### Patch Changes

- a59739edb: The `/subagents` and `/workflows` noop hints now point to the composer task

  tray instead of the retired sidebar Agents/Flows tabs, and tool guidance now
  explicitly forbids `bash sleep` busy-waiting while a subagent or workflow run
  completes in the background (completion is auto-delivered).

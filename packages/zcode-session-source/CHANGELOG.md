# @zhushanwen/zcode-session-source

## 0.2.3

### Patch Changes

- 0d36077d4: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.7.1 → @zhushanwen/subagent-engine-sdk@0.8.0)

## 0.2.2

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.7.0 → @zhushanwen/subagent-engine-sdk@0.7.1)

## 0.2.1

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.6.1 → @zhushanwen/subagent-engine-sdk@0.7.0)

## 0.2.0

### Minor Changes

- 43a50ae2e: New package: the single read-only source for zcode subagent session databases. It ships a runtime-probed sqlite driver (bun:sqlite on bun hosts, node:sqlite on node, both loaded via variable-indirect dynamic import), a four-level CANTOPEN recovery ladder (direct open, immutable escape gated on `-wal` absence, size-capped snapshot fallback with table-set validation, structured unreadable error), transcript row queries over the session/message/part tables, a schema version gate against the known version set, and db path projection helpers derived from the subagent-engine-sdk path constants.

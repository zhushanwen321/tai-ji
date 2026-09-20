---
'@zhushanwen/zcode-session-source': minor
---

New package: the single read-only source for zcode subagent session databases. It ships a runtime-probed sqlite driver (bun:sqlite on bun hosts, node:sqlite on node, both loaded via variable-indirect dynamic import), a four-level CANTOPEN recovery ladder (direct open, immutable escape gated on `-wal` absence, size-capped snapshot fallback with table-set validation, structured unreadable error), transcript row queries over the session/message/part tables, a schema version gate against the known version set, and db path projection helpers derived from the subagent-engine-sdk path constants.

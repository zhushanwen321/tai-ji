# @zhushanwen/pi-session-reader

## 0.8.0

### Minor Changes

- 50f31a73c: Teach session_read to discover and overview workflow runs recorded in the new v2 record-stream format: workflow refs now resolve through a three-tier entry chain (v2 workflow-record journal anchor > v1 snapshot > legacy workflow-state-link pointer), `.record.jsonl` streams are parsed directly into run overviews with three-state status (running | interrupted | done), and zcode session anchors additionally accept v2 settled subagent-record entries while keeping v1 snapshot reads compatible.

## 0.7.0

### Minor Changes

- 43a50ae2e: `session_read` can now route into zcode engine sessions: resolves zcode session ids and record anchors (with an explicit db-path allowlist gate and a readable error surface for unsupported hosts or schema drift), reads zcode manifests directly, and includes zcode subagent nodes in family queries. Parse/header first-line primitives now come from `@zhushanwen/session-core`, keeping byte-level behavior identical.

## 0.6.1

### Patch Changes

- a59739edb: refactor(extensions): single-source rename landing pipeline and session-reader units

# @zhushanwen/pi-session-reader

## 0.10.0

### Minor Changes

- 802af968f: The session outline now folds record-only entries (usage, session info, model changes, custom audit entries, branch summaries): outline lines and turn counts reflect conversation turns only, while expand/detail still reach every entry by its original turn index (requires pi 1.0.0).

## 0.9.1

### Patch Changes

- 492e02447: chore: refresh dependency range (triggered by @zhushanwen/zcode-session-source@0.2.3 → @zhushanwen/zcode-session-source@0.2.4)

## 0.9.0

### Minor Changes

- 0d36077d4: workflow run 发现链收敛为单档：只识别 workflow-record v2 注册条目（recordPath 锚点指向 record 流），v1 全量快照条目与旧 workflow-state-link 指针条目不再被识别——历史格式 run 从读取面静默消失（不拒读、不报错；ADR-0095 裁决：项目未上线无历史数据，不迁移不兼容）。zcode 锚同步只认 v2 终态条，v1 快照形态不再命中。

## 0.8.1

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/zcode-session-source@0.2.1 → @zhushanwen/zcode-session-source@0.2.2)

## 0.8.0

### Minor Changes

- 50f31a73c: Teach session_read to discover and overview workflow runs recorded in the new v2 record-stream format: workflow refs now resolve through a three-tier entry chain (v2 workflow-record journal anchor > v1 snapshot > legacy workflow-state-link pointer), `.record.jsonl` streams are parsed directly into run overviews with three-state status (running | interrupted | done), and zcode session anchors additionally accept v2 settled subagent-record entries while keeping v1 snapshot reads compatible.

## 0.7.0

### Minor Changes

- 43a50ae2e: `session_read` can now route into zcode engine sessions: resolves zcode session ids and record anchors (with an explicit db-path allowlist gate and a readable error surface for unsupported hosts or schema drift), reads zcode manifests directly, and includes zcode subagent nodes in family queries. Parse/header first-line primitives now come from `@zhushanwen/session-core`, keeping byte-level behavior identical.

## 0.6.1

### Patch Changes

- a59739edb: refactor(extensions): single-source rename landing pipeline and session-reader units

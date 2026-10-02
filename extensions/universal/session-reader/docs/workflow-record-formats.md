# workflow run 磁盘格式速查（session-reader 兼容读面）

> 现行文档：session-reader 的 `workflow` / `family` action 在磁盘上会遇到的三种 workflow run 格式与判定。写入侧语义的权威登记 = [ADR-0095](../../../../docs/adr/decisions.md)（快照机制退役、record 单模式收敛）；本文只记读取侧要认的形状。

## 三种格式与判定

| 版本标记 | 物理形态 | 判定 | 来源 |
|---|---|---|---|
| `wf-run-v2`（现行唯一写入口径） | `<agentDir>/sessions/<encodeCwd>/workflow-state/wf-<ts>-<base36>.record.jsonl`——事件流（每行一帧 JSON，词表 = agent-started / agent-retrying / agent-settled / phase-started / phase-settled / run-created / run-interrupted / run-resumed / run-settled / worker-log） | 文件名 `.record.jsonl` 后缀 | record 单模式（ADR-0095 起） |
| `wf-run-v1` | `<agentDir>/sessions/<encodeCwd>/workflow-state/<runId>.jsonl`——单行 rewrite JSON 快照（RunSnapshot：state/meta/spec 三段） | 文件名无 `.record` 后缀且首行可解析出 RunSnapshot 形状 | 旧写入口径已删（ADR-0095），磁盘存量数据仍会遇到——**读取兼容保留，禁止按损坏处理** |
| `legacy` | v1 快照缺字段 / 半写形态 | 解析不出上述两种形状 | 磁盘残留，`parseRunSnapshot` 返 null 时该 run 在概览中标 legacy |

## 实装位置

- 读取原语：`src/discovery/workflows.ts` 的 `readRunSnapshot`（v1 / 旧指针档 → unknown）
- 解析与版本标记：`src/core/workflow.ts` 的 `parseRunSnapshot`（`version: 'wf-run-v1' | 'wf-run-v2' | 'legacy'`，随 `details.runs` 透传给程序化消费方）
- 跨包纪律：本包不 import `@zhushanwen/pi-subagent-workflow` 的 RunSnapshot 类型（跨包类型耦合会使上游演化绑架读取面——`core/workflow.ts` 头注释）

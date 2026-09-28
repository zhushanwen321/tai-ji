# TODO：zcode 宿主 run 双源 / 判终局双判据待裁决

状态：待裁决（2026-09-29 登记；议题承接自 workflow-run-resume-revision 设计的射程外清单）

## 背景

workflow run 的 record 单源收敛（设计 `.tmp/tech-design/workflow-run-resume-revision.md` D1，[ADR-0082](../adr/decisions.md)）只在 pi 壳侧落地：run 唯一事实源 = record 事件流（`<runId>.record.jsonl`），判终局 = record fold 唯一判法。zcode 宿主路径原以 core 侧 FileRunStore 承载 run 态读侧，pi 壳侧收敛后该路径若仍走快照读 + fold 的两套判据，即「run 双源 / 判终局双判据」残留（FM-1 同族问题的射程外残留）。

## 现状

- core 侧 FileRunStore 已随 commit bd5750b70（audit B-1，单元 u-foundation / u-enum-reroute / u-write-retire）退役删除：读侧收敛到 journal 证据核（`findRunSettlementEvidence`，落点 `packages/subagent-core/src/execution/persistence/run-state-evidence.ts`），写身份整体退役、文件已删。源码全仓零命中（`packages/subagent-core/dist/` 旧构建产物中的类型残留随下次构建消失，不构成消费方）。
- 该「双源收敛是否在 zcode 宿主路径补做（FileRunStore record 化或等价收敛）」议题本身未裁决——收敛实装已删，议题从「实现层残留」变为「是否需要为 zcode 宿主形态重建等价读侧」的纯裁决问题。
- zcode 引擎现无 workflow 编排链（`packages/zcode-subagent-cli` 为单任务引擎适配包，无 run 调度 / phase 状态机 / record 流实装；包内 `workflow_run` 等词仅为 zcode 引擎自身 sqlite 会话库表名）——无编排即无 run 态持久化消费，该议题实际等待 zcode 侧出现编排需求时再裁。

## 待裁决点

- zcode 宿主形态未来出现 workflow 编排需求时，run 态持久化是否直接采用 pi 壳侧同款 record 单源形态（复用 `run-state-evidence.ts` 证据核），不再引入第二套快照读侧。

## 出处

- 设计文档射程外清单：`.tmp/tech-design/workflow-run-resume-revision.md` R:53（Out of scope 第 4 条，D1「射程裁决」段）
- 退役 commit：bd5750b70

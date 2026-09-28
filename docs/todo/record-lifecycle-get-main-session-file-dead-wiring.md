# RecordLifecycleDeps.getMainSessionFile 死接线清理

## 背景

idle-gc 机制退役（ADR-0081，2026-09-28）删除了 record 收编归属判定链，`RecordLifecycleDeps.getMainSessionFile` 在聚合内随之零消费。D2 一致性审查（dev-consistency-loop，idle-gc-retirement）确认：成员声明行之外全文件零命中，机制本体已删净（`writeSettledRecordEntryVia` / `writePendingUnregisterEntryVia` / `markIdleEvicted` 链 grep 零命中）。

## 现状

- 成员声明：`packages/subagent-core/src/execution/service/record-lifecycle.ts:99-101`（带「成员与装配点接线暂留待后续批次清理」注释）
- 装配点接线：`packages/subagent-core/src/execution/subagent-service.ts:297-300`
- 未删原因：删除波及 10+ 个不在退役设计改动面内的测试构造点（超出该批次领地，实施方按显式取舍留待后续批次）

## 实现要点

1. grep `getMainSessionFile` 定位声明 / 装配 / 测试构造点全集
2. 删 deps 成员 + 装配点传参 + 注释登记行
3. 测试构造点随动删（机械删参，无行为断言依赖——该成员零消费即无断言）
4. 验证：subagent-core typecheck + `src/execution` 全域测试绿

## 登记来源

D2 审查 reasonable 项 docSyncSuggestion（2026-09-28，idle-gc-retirement D2 stuck 终态处置时落盘）。

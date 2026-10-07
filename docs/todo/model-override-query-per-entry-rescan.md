# model-override-query 读路径逐条目全目录重扫（性能形态，非正确性）

状态：已登记待修（dev-merge-gates 审查残余 dmg-r4-1，minor 级随分支带走；2026-10-07 登记）。

- 现象（读码核实）：`packages/runtime/src/services/session/model-override-query.ts:136` 的
  `sessionCwdOf` 每次调用都跑 `sessionStore.scanSessions({ force: true })` 全目录扫描；
  `enhanceSubagentDetails`（session-records.ts）与 `projectSubagentModelDetailIntoRuns`
  （workflow-record-projection.ts）在同一读帧内对 N 条成员逐条触发该查询——N 个成员 =
  N 次全目录同步 IO，session meta 同帧重复解析。
- 影响面：records 读取延迟随成员数线性放大（同步 IO），正确性不受影响（force 扫描
  每次都返回正确 cwd）。
- 修复方向：同帧内 cwd 解析提升到调用方一次解析后透传，或在 model-override-query 层
  加 per-call MemoizedSession 路径参数（保持「scanSessions force 单点解析」语义不变，
  禁时间平抑类缓存——事实驱动原则）。
- 关联：ADR-0128（模型切换决策）；登记来源 dev-merge-gates run
  `.tmp/dev-merge-review/dmg-46eabfb04/`（dmg-r4-1）。

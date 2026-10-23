# scanDegradedFlag 零消费方登记（已关闭：旗标退役）

状态：已解决（2026-10-23 just-do-it 批次 3 条目 64 执行：旗标本体与置位/复位逻辑摘除——`scanPiSessionsFromDisk` 的降级判定分支删除，catch 内 console.error 留痕与降级计数打点保留；data-source-registry §8 EX-C 补登段同批清扫；旗标测试改写为扫描降级容错测试 `session-scan-degraded-tolerance.test.ts`）

## 退役内容

- `packages/runtime/src/infra/pi/session-file-utils.ts`：`scanDegradedFlag` 导出、`hasScanDegradation`（唯一消费点 = 旗标置位）、`scanPiSessionsFromDisk` 内三处置位/复位。
- 保留的现行副作用：降级空返回 `[]` 的容错（顶层 readdir 失败 console.error 留痕）、降级计数统计与 `logScanDegradedSummary` 轮末打点（单条坏文件「侧栏少一条」可归因）。

## 原登记背景

`scanDegradedFlag`（`{ last }` 可变单例）原唯一消费方 = btw 孤儿补账的不可逆删除闸（读 `.last`），补账随 session-store-layout-inversion（ADR-0151）整体退役后零消费方，旗标以「每轮扫描写一个无人读的模块级变量」形态暂留。退出条件「置位/复位逻辑摘除」已于 2026-10-23 满足，本登记关闭。

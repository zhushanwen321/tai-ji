# scanDegradedFlag 零消费方暂留（退出清理待后续单元）

状态：未解决（旗标本体暂留为显式登记的延迟项；2026-10-18 终态同步 G1 登记）

## 现状

`packages/runtime/src/infra/pi/session-file-utils.ts` 的导出旗标 `scanDegradedFlag`（:1134-1139）原消费方 = btw 孤儿补账闸（读 `.last`），补账已随 session-store-layout-inversion（ADR-0151）整体退役，当前零消费方：置位点（:1251-1252 / :1262-1264 附近）仍在每轮扫描写一个无人读的模块级变量。

## 退出条件（择一即关闭本登记）

- 置位/复位逻辑摘除（`scanPiSessionsFromDisk` 的降级判定改写，属扫描器登记单元 territory，非消费方代码组）；
- 或新消费方出现（旗标重新承载闸语义，届时本登记转正常文档）。

退役前旗标本体暂留无害：纯内存模块级变量，无磁盘写、无行为副作用。

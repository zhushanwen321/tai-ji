# @zhushanwen/pi-delivery-port

## 0.3.1

### Patch Changes

- 3107549df: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.24.0 → @zhushanwen/extension-protocol@0.25.0)

## 0.3.0

### Minor Changes

- da658a786: 后台任务通知改为边沿即投：移除 60s 合批窗口（`deliver` 选项删除 `merge` 字段、宿主接口移除 `hasRunningBackground`），收取条目 `outcome` 值域扩展为支持结清原因（`SettlementReason`）。

## 0.2.1

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0)

## 0.2.0

### Minor Changes

- 58a70ebc9: 新增 pi 扩展侧统一投递端口：custom 投递路径通知唯一执行者——deliver 提交（幂等判重 / 合批 / 失败保留策略）、投递日志落盘、session_start 差集重放，并提供 collect 批量收取 API（collectArm / collectArrival / consume / collectRelease）供 result-collect 能力接入。

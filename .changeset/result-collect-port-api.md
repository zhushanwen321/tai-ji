---
"@zhushanwen/pi-delivery-port": minor
---

新增 pi 扩展侧统一投递端口：custom 车道通知唯一执行者——deliver 提交（幂等判重 / 合批 / 失败保留策略）、投递日志落盘、session_start 差集重放，并提供 collect 批量收取 API（collectArm / collectArrival / consume / collectRelease）供 result-collect 能力接入。

---
"@zhushanwen/pi-delivery-port": minor
---

后台任务通知改为边沿即投：移除 60s 合批窗口（`deliver` 选项删除 `merge` 字段、宿主接口移除 `hasRunningBackground`），收取条目 `outcome` 值域扩展为支持结清原因（`SettlementReason`）。

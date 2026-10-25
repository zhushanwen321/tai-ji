---
"@zhushanwen/pi-pending-notifications": minor
---

`collect_results` 的 `outcome` 终态标注改读注销 reason 的结清解析（不可判读时新增 `unknown` 标注）；unregister 事件 reason 缺失或畸形时按 `no_result` 结算并留痕告警，不再误标为 `completed`。

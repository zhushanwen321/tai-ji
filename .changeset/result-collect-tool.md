---
"@zhushanwen/pi-pending-notifications": minor
---

新增 collect_results 工具：一次调用等待并批量收取后台操作结果（bash 后台命令、workflow 等）；未指定 ids 时缺省收取当前会话全部活跃操作（自动排除 managed-session 终身条目），超时返回已到达子集、其余照常推送。

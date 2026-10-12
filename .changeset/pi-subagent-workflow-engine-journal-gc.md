---
"@zhushanwen/pi-subagent-workflow": patch
---

进程级维护从「扫描清理过期子代理会话文件」改为「引擎 journal 30 天 TTL 回收定时器」（接线扫一次 + 每 24 小时复扫）；子代理会话文件不再被本扩展独立清理，改随删除主会话级联回收。

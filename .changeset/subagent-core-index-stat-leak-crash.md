---
"@zhushanwen/subagent-core": patch
---

修复冷启动扫描崩溃：索引命中腿不再对象展开索引条目（`{ ...hit }` 会把 number 型 turns/totalTokens 等统计字段泄漏进身份基底，collectRecords 迭代即抛 TypeError），改为显式逐字段装配；泄漏形态再出现时按轻量基底降级并 warn（含恢复动作提示）。

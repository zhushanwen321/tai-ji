---
"@zhushanwen/pi-retry-rules": minor
---

新增 retry-rules 扩展：对限流类 provider 错误在 message_end 改写错误分类以触发 pi 原生重试循环，规则支持内置基线、远程覆盖与用户自定义三层合并，正则匹配带 ReDoS 防护。

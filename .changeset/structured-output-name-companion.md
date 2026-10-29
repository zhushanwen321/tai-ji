---
"@zhushanwen/pi-subagent-cli": patch
"@zhushanwen/subagent-core": patch
---

structured-output 工具名 snake_case 化配套：结构化返回提示词与失败诊断改用 `structured_output`，读侧（resume / 结果补收的重放路径）同时识别旧连字符名 `structured-output`，旧 run 记录不失效。

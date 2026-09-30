---
"@zhushanwen/pi-subagent-workflow": minor
---

run 恢复重建与会话替换可靠性增强：record 流折叠重建现在恢复生效预算（budgetTimeMs/budgetTokens 按 run-resumed > run-created 三档回落）、真实 token 会计与 errorLogs 诊断日志（此前重建产物为空/零值）；终局事实随重建注入 core 终局记录注册表。会话替换（switchSession / reload）时作废 core pi 读面绑定，避免旧失效句柄上的 assertActive 抛错打断在途 run 的轮终收尾。历史格式条目（v1 快照 / 旧指针）不再识别、从读取面消失；record 锚点字段与常量对齐 subagent-core 改名（journalPath → recordPath、RUN_EVENT_JOURNAL_SUFFIX → RUN_EVENTS_SUFFIX），跨包 slot key 收敛到 core `GLOBAL_SLOT_KEYS`。

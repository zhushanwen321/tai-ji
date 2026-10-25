---
"@zhushanwen/subagent-core": minor
---

review-fix-loop（pi 内置版）新增统一 commit 的 content 补修子循环：commit 被提交前检查拦截且恢复需改仓库内文件时，自动派补修 agent 按报错原文补全（上限 2 次，含 git status 快照差集对账与显式路径 add），不再直接 fix-failure 终态交人工。聚合失败重试改为回注失败原因（报告已写好场景命中率提升）。跨轮条目字段继承（防空壳）与补修子循环已单源化：实装移入 workflows/src/review-fix-loop.shared.ts，与 zcode 版（~/.zcode/workflows/review-fix-loop.dwf.ts）共用同一实现，经 pnpm build:workflows 构建拼装双平台产物。

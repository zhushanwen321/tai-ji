---
"@zhushanwen/pi-plan": patch
---

plan enter 的计划目录创建改为原子独占：目标目录已被占用时自动递增为 `<slug>-2`/`<slug>-3`，修复并发进入计划模式时两轮计划互覆 plan.md 的问题；纯中文需求（slug 折叠为空）不再把 plan.md 直落 `.tmp/plans` 骨架目录，改落 `untitled/`。

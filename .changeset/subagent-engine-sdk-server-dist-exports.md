---
"@zhushanwen/subagent-engine-sdk": minor
---

修复 npm 发布形态 `./server` 导出入口断裂：publishConfig.exports['./server'] 的 import/default 条件此前误指 TS 源码（src/server/index.ts），而 files 白名单不含 src，npm 消费者经 ESM/default 条件解析必报 MODULE_NOT_FOUND；现全部条件改指 dist 产物，对齐 './' 与 './protocol' 出口形态。

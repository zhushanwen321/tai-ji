# subagent streaming cancel 的 Done 回执缺失（成功路径无回执写入）

- **状态**：未解决（2026-10-22 验收技能 verify-taiji 发现，5 轮确定性复现）
- **现象**：成员 running 态调 `session.subagentAction { action:'cancel', subagentId }` →
  WS error envelope `handler_error — subagent action result missing（宿主命令回执缺失）`。
  **取消效果本身达成**（成员 stopReason=interrupted，record 收敛 idle）——缺陷只在回执通道。
- **根因（2026-10-22 对抗审查源码核实，修正早前的「异步竞态」误判）**：
  1. pi 1.0.0 实装对 `/` 开头输入走扩展命令分支并 **await handler 执行完毕**后才回
     `handled`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
     `_tryExecuteExtensionCommand`）——runtime 的 prompt resolve 时扩展侧已跑完，**不是竞态**；
  2. 真缺口 = `extensions/universal/subagent-workflow/src/interface/command/subagents.ts`
     rpcCancel：`service.cancel(recordId)` 返回 true（取消成功）时**不写结果文件**，只有
     `!ok`（subagent_cancel_not_found）与异常分支写；
  3. runtime `packages/runtime/src/services/session/session-records.ts` 的
     `consumeSubagentActionResultFile` 把「文件不存在」一律判「回执缺失」抛 handler_error。
  成功路径无回执 + 缺失即报错 = 确定性复现（真竞态应时好时坏，实测 5/5 全复现与之自洽）。
- **对用户的影响**：renderer 取消按钮依赖 rejection 回滚乐观翻边（subagent-composer
  2026-10-18 设计）——用户会看到「取消失败」但实际已取消。
- **建议修复方向**：扩展侧 rpcCancel 成功路径补写 `{scope:"ok"}` 结果文件（对齐同文件
  rpcMessage 的成功回执先例）；或 runtime 侧把 cancel 的结果文件缺失降级为可接受形态
  （以 getSubagents 轮询收敛代替回执判定）。**不建议** consume 侧轮询——等不来一个
  永远不会写的文件。
- **复现**：`node .agents/skills/verify-taiji/scripts/run.mjs
  .agents/skills/verify-taiji/scenarios/p0-interrupt-cancel.mjs --artifacts-dir /tmp/x --json`
  （断言「B: streaming 态 cancel（回执通道）」失败即复现；record 的 stopReason=interrupted
  证明取消效果达成；成员自然收敛后二次 cancel 会命中 `subagent_cancel_not_found` 的
  错误回执分支——该分支的回执写入正常，恰为对照）。

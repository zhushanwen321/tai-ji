# workflow 成员级模型切换前端入口（subagent-model-switch §6.1 分流规则第三条后续项）

状态：待排期（设计 §2 Out of scope 划出——「机制已覆盖、入口登记后续项」的前提义务，本文件即该登记；2026-10-07 终态同步轮 F1-31/F1-5 补立）。

- 现状（读码核实）：**机制已覆盖**——chat 域会话级切换路径可直接作用于 workflow 成员（成员 = 有自身 record/session 的 subagent，会话级 setModel 目标 = 成员 recordId，引擎热切 + `record-model-override` 记账对成员同样生效）；缺的只是**成员级前端入口**——本期只暴露 run 级（run 详情模型选择器）与会话级（subagent 面板）两种（设计 §6.1；`SubagentTab.vue` agentcall 视图只显示、无切换入口，`SubagentTab.model-label.test.ts`「agentcall 视图」用例锚定该现状）。
- 实施量级（后续项）：`SubagentTab.vue` agentcall 视图（`chatMeta === null && subagentMeta?.meta` 分支）复用 `ModelSelectPopover` 接线（trigger 形态照 chat 域分支，`#trigger` 自包 `PopoverTrigger as-child`——D3 缺陷一教训）；提交走既有 `subagent.setModel` 消息（recordId 目标），无需新协议面。
- 关联：设计文档 `.tmp/tech-design/subagent-model-switch.md` §6.1 作用域分流第三条 / §2 Out of scope；ADR-0128。

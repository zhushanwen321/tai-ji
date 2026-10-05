# 插件工具接入通路暂缺（plugin-bridge 退役后）

状态：待设计（pi1-disposition-chat-flow 设计 D7④ / 裁决 Q11 承接，2026-10-04 退役落地时登记）。

- 现状：plugin-bridge 整体退役（删除清单 `pi1-disposition-chat-flow/audit/bridge-retirement-scope.md`，用户裁决「直接废除 bridge」）后，插件（PluginService Worker）向 pi 进程注册工具的通路消失——`api.tools.register` 注册的工具不再出现在 pi 的模型工具清单，插件工具能力暂缺。pi 侧工具接入的原生承载 = MCP（`pi.registerMcpServer` / mcp.json，pi 1.0 内置支持），接入形态另行设计，不在退役批次范围。
- 影响面：当前仓库内插件零工具使用（statusline / scheduler-manager 均只用 ui/hooks/sessions API），退役无实际受害方；第三方插件若依赖 `@zhushanwen/pi-plugin-bridge` 旧通路（npm registry 历史版本可装），升级到本版本后工具不再可达（bridge 扩展不再随 taiji 装载）。
- 已做的收尾：npm 侧 `@zhushanwen/pi-plugin-bridge` 历史 version 的 deprecate 属发布面动作（`scripts/check-publish-surface.mjs` 已摘条目），随下次发布流程执行；本仓不再维护该包。
- 恢复通道：插件工具通路按 MCP 路线另行设计（候选形态与开放问题见退役调研报告 §7/§8：taiji 托管 mcp.json 的目录归属、exposure 档位产品行为、runtime 内嵌 MCP server vs 每插件独立进程）。设计落地后本登记关闭。
- 重审触发：出现真实的插件工具需求方（仓内插件或第三方插件生态），或 MCP 路线设计排期时。

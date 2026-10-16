# @zhushanwen/pi-canvas

问题解决画布的 pi extension 工具面（taiji 组，role=taiji，tier=feature）。

六个 `canvas_*` 工具（全部 `exposure: "deferred"`，tool_search 检索激活）：`canvas_enter`（创建/打开）、`canvas_edit`（grow/patch/select/transition/comment-respond 五 action）、`canvas_read`、`canvas_review`（run/append/resolve）、`canvas_export`、`canvas_list`。

架构（设计 `.tmp/tech-design/problem-solve-canvas.md` §3.1(2)）：

- 画布状态唯一权威在 taiji runtime 的 CanvasService；本扩展是薄工具面——每工具 execute 把调用转译为 `CANVAS_MARKER` 的 `{action, params}` 嵌套载荷，经 `ctx.ui.select` 挂起，由 runtime marker 显式分支路由（session-manager 同款通道；契约 SSOT 在 `@zhushanwen/extension-protocol` 的 `src/extensions/canvas/` 契约模块）。
- 宿主检测：`TAIJI_AGENT_EXT_LOG === "1"` 且 `ctx.mode === "rpc"`（对齐 plan 的 `isTaijiGuiHost` 完整谓词）——非 taiji GUI 宿主返回结构化错误，不进入 select，禁超时探测。
- 审查编排：`canvas_review(run)` 经 subagent-workflow 的 `SubagentService`（globalThis service 槽）派单个 reviewer（六维度模板 + 画布全量内联，reviewer 零工具——无改图通道），报告条目经 marker `review-append` 写回（runtime 按 U1 权限矩阵映射 actor=review）。
- 无墙钟超时：marker select 与 reviewer 派发均不设时限（任务级正常路径不设限；session-manager watch 先例）。

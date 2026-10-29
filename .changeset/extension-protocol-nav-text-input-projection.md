---
"@zhushanwen/extension-protocol": minor
---

GUI 组件协议增量：新增 `text-input` 输入原语组件（值变更经 plugin.uiEvent 回传插件）、`HostContainerAction` 宿主容器导航类型（打开浮层/抽屉的目标标签页）、`TreeItem.action` 行点击动作与 action-bar 按钮 `hostAction`（命令链与容器导航两条执行路径）。新增 subagent 投影判据单点导出 `isRunningProjection` / `failedRoundOf` / `failureCauseLabel`（+ 入参类型 `SubagentProjectionRecord` / `SubagentFailureLike`——插件侧托盘 widget 与宿主 renderer 共享的占用/失败轮/失败分类判据，入参取两侧 SubagentRecord 形状子集）。

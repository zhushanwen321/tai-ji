---
"@zhushanwen/pi-subagent-workflow": minor
---

subagent / workflow 工具 RPC 模式 execute 附加 `details.__gui__` GUI 组件树（经 tool-shared.ts 的 withGuiAttach 单点构造，workflow / subagent_batch 均消费；TUI 模式不构造）；新增 `buildWorkflowGui` / `buildBatchGui` 导出（工具结果的 GUI 组件构造器）；新增 subagent / workflow 托盘 widget 推送器（tray-widget.ts / workflow-tray-widget.ts，经 setWidgetDual 双模推送——RPC 模式推 widget 树到宿主托盘 widget 区，TUI 模式推原生文本行，对外部 pi 宿主可见）。

# @xyz-agent/extension-protocol

Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。pi extension 双模式（TUI/GUI）渲染的契约层。

## 包结构

- `core/` —— 通用协议层（所有 extension 共用：`GuiComponent` + 布局原语 + 传输编码）
- `extensions/` —— 有运行时定制逻辑的 extension（marker + helper）
  - `ask-user/` —— 富交互（select 通道 + marker）
  - `session-manager/` —— agent-managed session 嵌套 `{action, params}` 契约（select 通道 + marker）
  - `plugin-bridge/` —— plugin system bridge（插件工具/事件/拦截经 select 通道 + marker 桥接）
  - `subagent-engine/` —— 引擎可发现性（`engines.json` 状态文件 + 引擎配置视图）
- `background-task` —— base-tool-enhance 后台任务 `registry.json` 文件契约

## 设计原则

- **core 只保留结构性、中性的通用原语**（card / stats-line / progress-bar / list-tree / columns / tab-bar / ansi-text）。特定 extension 的领域数据结构不进协议层——extension 用通用原语组合表达，形状太特殊时走 custom 通道。
- **零运行时依赖**：纯类型 + 纯函数，两端（extension 与 renderer）共享同一契约。
- **marker 通道**：GUI 能力协商经 `GUI_WIDGET_MARKER` / 各 extension 专属 marker（如 `ASK_USER_MARKER`）走 pi 消息流。

## 使用

```ts
import { guiComponent, guiResult, extractGui, isGuiCapable } from '@xyz-agent/extension-protocol'

// extension 侧：构造 GUI 组件渲染结果（guiResult 收单个 component，非数组）
const result = guiResult(guiComponent('stats-line', { items: [{ label: 'turns', value: '12' }] }))

// 宿主侧：从 tool result 的 details.__gui__ 字段提取 GUI 渲染结果
const extracted = extractGui(toolResultDetails)
```

session-manager 嵌套 `{action, params}` 契约的类型（各 action 的 params/result 类型）同样从本包导出。

## 开发

```bash
cd packages/extension-protocol
npx vitest run        # 跑测试
npx tsc --noEmit      # 类型检查
```

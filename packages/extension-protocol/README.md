# @zhushanwen/extension-protocol

pi extension 跨层契约包：类型 + helper 函数 + 共享行为原语，零运行时依赖。覆盖双模式（TUI/GUI）渲染、session-manager / background-task / pending-entries 协议与跨端共享的行为原语（进程处置 / registry 文件 IO / output tail）。

## 包结构

- `core/` —— 通用协议层（所有 extension 共用：`GuiComponent` + 布局原语 + 传输编码 + 双模 widget helper）
- `extensions/` —— 有运行时定制逻辑的 extension（marker + helper）
  - `ask-user/` —— 富交互（select 通道 + marker）
  - `plan/` —— plan 生命周期状态机 + 审阅回传值域契约 + 旧 entry legacy 读取（纯函数零 pi 依赖，扩展 / runtime / renderer 三层共用）
  - `scheduler/` —— scheduler 任务条目契约 + entry 重放折叠（replayFoldEntries）+ 时间格式化（纯契约与纯函数，零 pi/node 依赖）
  - `scheduler-create/` —— scheduler 创建确认共享资产（ScheduleDraft / ScheduleFormResult 类型 + 形状与时间折叠守卫 + marker）
  - `session-manager/` —— agent-managed session 嵌套 `{action, params}` 契约（select 通道 + marker）
  - `subagent-engine/` —— 引擎可发现性（`engines.json` 状态文件 + 引擎配置视图）
  - `subagent-inflight/` —— subagent 在途聚合上报（绝对计数报告 + marker，select 通道）
  - `subagent-notify/` —— subagent-workflow 通知通道 customType 常量唯一来源（workflow 结果 / 后台通知 / subagent 指令三类）
  - `ui-form/` —— 统一提问表单协议（ask-user / scheduler / plan 三方提问统一入口：类型 + marker + 交互 helper + 守卫）
  - 完整子协议清单以 `src/index.ts` 导出为准
- `pending-entries` —— pending 事件流差集核心（register 去重 + unregister 抵消，纯算法）
- `background-task` —— base-tool-enhance 后台任务 `registry.json` 文件契约
- 子出口 `@zhushanwen/extension-protocol/background-task` —— 后台任务行为原语（进程处置 / registry 文件 IO / output tail，含 node 内建依赖，不进 index 桶出口）

## 设计原则

- **core 只保留结构性、中性的通用原语**（card / stats-line / progress-bar / list-tree / columns / tab-bar / ansi-text）。特定 extension 的领域数据结构不进协议层——extension 用通用原语组合表达，形状太特殊时走 custom 通道。
- **零运行时依赖**：纯类型 + 纯函数，两端（extension 与 renderer）共享同一契约。
- **marker 通道**：GUI 能力协商经 `GUI_WIDGET_MARKER` / 各 extension 专属 marker（如 `ASK_USER_MARKER`）走 pi 消息流。

## 使用

```ts
import { guiComponent, guiResult, extractGui, isGuiCapable } from '@zhushanwen/extension-protocol'

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

# Extension GUI 渲染协议规范

> **版本**: v1-implemented
> **状态**: P0+P1 已实现（协议包 + runtime 适配 + AnsiText 渲染 + ask-user 富交互）
> **日期**: 2026-07-12
> **审查记录**: 见文末 §13「审查修正日志」
> **目标**: 为 pi extension 提供一套结构化 GUI 渲染协议，在 pi TUI 渲染契约基础上扩展，使 extension 一套代码根据运行环境（TUI / GUI）自动路由渲染逻辑。
> **代码 SSOT**: `packages/extension-protocol/src/`（协议包）、`packages/runtime/src/infra/pi/event-adapter.ts`（runtime 适配）、`packages/renderer/src/components/panel/message-stream/GuiComponentRenderer.vue`（前端路由）

---

## 1. 问题陈述

### 1.1 现状

pi extension 有 5 个渲染入口，全部返回 `Component { render(width): string[] }`——ANSI 文本行：

| pi 渲染入口 | 用途 | RPC 模式行为 |
|---|---|---|
| `ToolDefinition.renderCall` | tool 调用标题行 | **no-op**（从不调用） |
| `ToolDefinition.renderResult` | tool 结果展示 | **no-op**（从不调用） |
| `ctx.ui.setWidget(factory)` | editor 上下方面板 | **factory 被丢弃**，仅 `string[]` 生效 |
| `registerMessageRenderer` | 自定义消息卡片 | **no-op**（从不调用） |
| `ctx.ui.custom(factory)` | 交互式自定义组件 | **返回 undefined**（崩溃） |

taiji 以 `--mode rpc` 运行 pi。RPC 模式下 `Component` 无法序列化进 JSON-RPC，上述渲染入口全部失效。extension 精心编写的 TUI 渲染（带色、布局、spinner）全部丢失。

### 1.2 目标

提供一套**可序列化的结构化渲染协议**，作为 pi `Component` 的 GUI 镜像。extension 通过 `ctx.mode` 判断运行环境，TUI 走原生 `Component` 渲染，GUI 走结构化 `GuiComponent` 渲染。

**设计原则**：
1. **兼容 pi 协议**——不修改 pi 源码，不覆盖 pi 原有行为。TUI 模式下零影响。
2. **镜像 pi 概念**——每个 pi 渲染入口有对应的 GUI 数据通道，概念对齐。
3. **一套接口两套实现**——extension 只写一版 `execute`，内部按 `ctx.mode` 分支。
4. **不改 pi 的 result.content**——`content` 是 LLM 可见的，协议数据只放 `details`。

---

## 2. 架构总览

```
extension execute() / event handler
  │
  ├─ ctx.mode === 'tui'
  │   └─ 返回 details（无 __gui__）
  │      pi TUI 调用 renderResult(render) → Component → ANSI string[]
  │
  └─ ctx.mode === 'rpc'
      └─ 返回 details.__gui__ = GuiComponent
         pi RPC 原样透传 result（agent-session.js:451 零过滤）
         taiji event-adapter 原样透传 details（零白名单）
         前端检测 __gui__.type → 路由到 Vue 组件
```

### 数据流链路（已验证）

| 环节 | 位置 | 行为 |
|---|---|---|
| extension 构造 | extension execute() | `details.__gui__ = { type, props }` |
| pi agent-core | `agent-session.js:451-460` | `result: event.result` 原样引用，零过滤 |
| pi RPC stdout | `rpc-mode.js:264` + `jsonl.js:8` | `JSON.stringify(event)` 原样输出 |
| taiji runtime | `event-adapter.ts:147-151` | `details as Record<string, unknown>` 原样透传 |
| 前端 Block.vue | `tool.details.__gui__` | 按 `.type` 路由到 Vue 组件 |

**边界约束**：`__gui__` 必须放在 `result.details` 下（整体透传），不能放在 `result.content` 内（会被 event-adapter 过滤成 text/image）。

---

## 3. 核心类型定义

### 3.1 GuiComponent——pi Component 的可序列化镜像

pi 的 `Component` 接口是 `{ render(width: number): string[] }`——返回 ANSI 文本行，不可序列化。

`GuiComponent` 是可序列化的结构化数据，前端有对应的 Vue 组件把它渲染成 GUI：

```typescript
/**
 * GUI 渲染组件——pi Component 的可序列化镜像。
 *
 * pi:  Component { render(width): string[] }   ← ANSI 文本行
 * gui: GuiComponent = { type, props }           ← 结构化数据
 *
 * 两者概念对齐：pi 的 renderResult 返回 Component 给 TUI 渲染，
 * taiji 的 details.__gui__ 返回 GuiComponent 给 Vue 渲染。
 */
export interface GuiComponent<T extends GuiComponentType = GuiComponentType> {
  /** 组件类型，前端按此路由到 Vue 组件 */
  type: T
  /** 组件 props，类型由 type 决定 */
  props: GuiComponentProps[T]
}
```

### 3.2 内置组件类型

协议只定义**结构性、中性的通用原语**——不包含任何特定 extension 的业务领域概念。extension 用通用原语组合表达领域数据；形状太特殊时走 `custom` 逃生口。

```typescript
export type GuiComponentType = keyof GuiComponentProps

export interface GuiComponentProps {
  /** ANSI 文本兜底——保留原始 ANSI 序列，前端用 ansi_up 渲染 */
  'ansi-text': {
    lines: string[]
  }

  // ── 布局原语（替代 TUI ASCII 布局，见 §14）──

  /** 卡片容器——替代 TUI 的 ┌─┐││└─┘ / ╭╮╰╯ box 边框 */
  'card': {
    variant?: 'default' | 'elevated' | 'danger' | 'success'
    header?: GuiComponent | string       // 标题区（可为文本或嵌套组件）
    body: GuiComponent[]                 // 内容区子组件数组
  }

  /** 统计行——替代 TUI 的 "N turns · Nk · Ns" 分隔行 */
  'stats-line': {
    items: StatItem[]
  }

  /** 进度条——替代 TUI 的 ████░░░░ 字符 */
  'progress-bar': {
    label?: string
    current: number
    total: number
    unit?: string
    severity?: 'ok' | 'warn' | 'danger'
  }

  /** 列表树——替代 TUI 的 ⎿ ├─ └─ 缩进 */
  'list-tree': {
    items: TreeItem[]
  }

  /** 双列网格——替代 TUI 的 │ 列分隔 */
  'columns': {
    children: GuiComponent[]
    ratios?: number[]
  }

  /** 标签栏——替代 TUI 的 tab │ 分隔 */
  'tab-bar': {
    tabs: { label: string; active?: boolean; status?: 'done' | 'pending' }[]
    /** 容器化分段（v1.1 可选字段）：第 i 段 = tabs[i] 激活时渲染的子树，与 tabs 等长 */
    sections?: GuiComponent[][]
  }

  /** 自定义组件——逃生口（仅限内置 extension 编译期注册，见 §9.1） */
  'custom': {
    component: string
    props: Record<string, unknown>
  }
}
```

> **tab-bar 容器化（v1.1 可选字段）**：`sections` 与 `tabs` 等长时，宿主渲染 `tabs[active]` 对应的分段；**active 归宿主本地**——首次挂载取推送的 `tabs[i].active`，用户点击只切本地索引，extension 的后续推送更新内容但**不重置用户选择**（组件重建除外）。缺省 = 纯展示 tab-bar（现状行为，旧 extension 零改动）；`sections` 与 `tabs` 长度不等时**忽略 sections 退化为纯展示 + warn**。协议不提供 UI→extension 回传通道，故「用户切了 tab」不是 agent 事件（extension 一次推送全量、宿主本地切换零往返）。

> **设计原则**：协议层不包含特定 extension 的领域数据结构（如任务状态枚举、目标生命周期、工作流 reason 码）。这些是 extension 的业务逻辑，不是 UI 层该知道的。extension 用 `card` + `stats-line` + `list-tree` 等通用原语组合表达自己的领域数据。

### 3.3 通用子类型

```typescript
/** stats-line 的单项 */
export interface StatItem {
  label?: string
  value: string          // 已格式化的显示文本（如 "3"、"12.4k"、"47s"）
  severity?: 'ok' | 'warn' | 'danger'
  icon?: string          // 可选 lucide 图标名
}

/** list-tree 的节点 */
export interface TreeItem {
  icon?: TreeItemIcon
  label: string
  status?: 'running' | 'done' | 'failed'
  depth?: number
  children?: TreeItem[]
}
export type TreeItemIcon = 'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'
```

### 3.4 GuiRenderResult——带协议版本号

```typescript
export const PROTOCOL_VERSION = 1 as const

/**
 * tool result / message details 中 __gui__ 字段的完整类型。
 * 前端检测 v 字段做版本协商，不认识的版本降级为 ansi-text。
 */
export interface GuiRenderResult {
  v: typeof PROTOCOL_VERSION
  component: GuiComponent
  /** v1.1 扩展：widget 宿主元数据（head + 托盘 icon/badge，见 §3.5）；缺省时宿主 fallback 到 viewId 标题、无状态点/进度/icon */
  meta?: WidgetMeta
}
```

### 3.5 WidgetMeta——widget 宿主元数据（v1.1）

widget 通道（M17）除 `component` 外可带 `meta`：head（标题/状态点/进度）与托盘条目（icon/badge）都由宿主按此元数据渲染，extension 不需要用 `card` 原语 header 表达这些。

```typescript
/** widget 宿主元数据——head 渲染契约（title + 状态点 + 进度 + 折叠 chevron）+ 托盘 icon/badge。 */
export interface WidgetMeta {
  /** head 标题（todo → "Todo"；goal → slug） */
  title: string
  /** head 状态点语义：running=accent / done=success / failed=danger / idle=neutral 弱点（托盘呼吸点同源） */
  status?: 'running' | 'done' | 'failed' | 'idle'
  /** head 进度（mini bar + 计数文本）；progress-bar 原语从 body 移入 head 的承载 */
  progress?: {
    current: number
    total: number
    /** 计数显示文本（head 空间有限，extension 全权格式化：todo "2/5"、goal "42%"）。缺省 `${current}/${total}` */
    label?: string
    /** fill 语义色（预算阈值映射）；缺省按 meta.status（done→success，否则 accent） */
    severity?: 'ok' | 'warn' | 'danger'
  }
  /** 托盘 icon：icon key 字符串（宿主按 lucide 名解析）或自定义形状 { paths } */
  icon?: string | { paths: string[] }
  /** 托盘 badge：extension 全权格式化的短文本（'2' / '42%' / '!'），建议 ≤6 字符，宿主超长 truncate */
  badge?: string
}
```

**icon/badge 均为 v1.1 可选字段**：旧宿主忽略、旧 extension 不发，双向兼容（`isGuiRenderResult` 只校验 `v` 与 `component`，不校验 meta 形状）。

**自定义形状：形状归 extension、风格归宿主**。`{ paths }` 是 SVG path 的 `d` 字符串数组，extension 只定义形状；宿主渲染统一锁定 `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap/linejoin="round"`——线宽/颜色/尺寸由宿主锁死，输出必然与 @lucide 细线图标同构（不会出现风格失控的自定义 icon）。渲染经 Vue `<path :d>`（DOM 属性赋值，无 innerHTML 注入面）。

**paths 白名单防御（`validateWidgetIconPaths`，协议包导出）**：字符白名单正则 `^[MLCQAZHVmlcqazhv0-9 ,.\-]+$`（d 语法命令字母 + 数字 + 空格/逗号/小数点/负号，刻意不含指数记法等其余字符）、条数 ≤8、单条 ≤512 字符、总长 ≤2048 字符。校验不抛异常，返回判定对象（合法携带 paths 副本 / 非法携带拒绝原因：`not-array` / `empty` / `too-many` / `non-string` / `too-long` / `total-too-long` / `illegal-char`）——宿主据 `!valid` 落兜底 icon + console warn 一次（去重）。

**fallback 链（宿主侧实现契约）**：

| 字段 | 链 |
|---|---|
| icon | `meta.icon` 自定义 paths（过白名单）→ `meta.icon` key 解析 → 宿主内置 widgetKey 映射（'todo'→ListChecks、'goal'→Target）→ 通用 widget icon |
| badge | `meta.badge` → `progress.label ?? String(progress.current)` → 无 badge |

badge 的视觉态（亮/色/呼吸点）由 `meta.status` 决定，与 built-in 任务条目同视觉语言。

---

## 4. 五个渲染入口的 GUI 镜像

### 4.1 映射总表

| pi 渲染入口 | GUI 数据通道 | 数据载体 | 挂载点 | 传输方向 |
|---|---|---|---|---|
| `renderCall(args)` | extension 在 execute 中构造 | `details.__gui__.call` | **M4** tool result block | 单向 |
| `renderResult(result)` | extension 在 execute 中构造 | `details.__gui__.result` | **M4** tool result block | 单向 |
| `setWidget(key, factory)` | `guiSetWidget()` helper（直编码） | extension_ui_request（marker 编码进 string[]） | **M17** composer 任务托盘的协议 widget 区 | 单向 |
| `setStatus(key, text)` | 复用 pi 原生（已有效） | extension_ui_request | **M8** status bar | 单向 |
| `registerMessageRenderer` | extension 在 sendMessage 中构造 | `message.details.__gui__` | **M5** custom message | 单向 |
| `ctx.ui.custom(factory)` | `askUserInteract()` helper（extensions/ask-user/） | select 通道 + `ASK_USER_MARKER` + WS 回传 | **M11** companion | **双向** |

### 4.2 tool result（renderCall + renderResult）

extension 在 `execute` 中根据 `ctx.mode` 分支：

```typescript
execute(toolCallId, params, signal, onUpdate, ctx) {
  const result = doWork(params)

  // ── 给 LLM 的 content（两模式相同）──
  const content = [{ type: 'text' as const, text: formatForLLM(result) }]

  if (ctx.mode === 'rpc') {
    // GUI 模式：结构化渲染数据放进 details.__gui__
    return {
      content,
      details: {
        ...result,
        __gui__: {
          v: PROTOCOL_VERSION,
          component: {
            type: 'stats-line',
            props: {
              items: [
                { label: '总数', value: String(result.total) },
                { label: '成功', value: String(result.success), severity: 'ok' },
                { label: '失败', value: String(result.failed), severity: result.failed > 0 ? 'danger' : 'ok' },
              ],
            },
          },
        },
      },
    }
  }

  // TUI 模式：renderResult 会被 pi TUI 调用
  return { content, details: { ...result } }
}

// TUI 实现（已有，保持不变）
renderResult(result, options, theme) {
  return buildTodoListText(result.details.todos, theme, options.expanded)
}
```

**streaming 进度**（`onUpdate`）：RPC 模式下 `onUpdate(partialResult)` 的 `partialResult.details.__gui__` 会被 `tool_execution_update` 事件透传。**注意**：当前 event-adapter 的 handleToolExecutionUpdate 把整个 `partialResult` 塞进 `detail`（单数），未提取 `partialResult.details`——需改为提取 `partialResult.details`（见 §8.1 修正项）。

### 4.3 widget（setWidget）

widget 通过 `guiSetWidget()` helper **直接编码进 string[]**——不需要 shim extension，不需要 monkey-patch。

**挂载点（M17）**：widget 在 GUI 下渲染到 **composer 任务托盘的协议 widget 区**（composer 工具条左簇，对应 TUI「editor 上方常驻面板」；2026-09-16 起 — 原「对话流 widget 面板」消费端已随入口唯一化退役，见 [composer-task-tray.md](../design/composer-task-tray.md) D11）。语义与 pi 原生完全一致：**常驻 + 同 key 覆盖更新 + undefined 清除**。taiji 前端按 widgetKey 分区缓存（ViewHostStore per-session 分区），一个 widgetKey = 托盘上的一个 icon 条目（经该条目面板渲染 `guiTree`），条目序 = known-order（todo/goal）优先 + 其余按当前插入序。任何 extension 推 widget 都走此挂载点（通用承接，不特化）。

#### 原理

pi 的 `ctx.ui.setWidget(key, string[])` 在 RPC 模式下原样输出 `widgetLines`（rpc-mode.js:122-135 零预处理）。helper 把 GuiComponent 的 JSON 用协议 marker 前缀编码进单行 string[]，runtime event-adapter 检测 marker 后解码。

#### helper 实现

```typescript
// @zhushanwen/extension-protocol
const GUI_WIDGET_MARKER = '\x00TAIJI_GUI_WIDGET:'  // NUL 开头，不会出现在正常文本中

function guiSetWidget(
  ctx: ExtensionContext,
  key: string,
  component: GuiComponent | undefined
): void {
  if (component) {
    // RPC 模式：编码进 string[]（pi 原样透传）
    const encoded = [GUI_WIDGET_MARKER + JSON.stringify(stripUndefined(component))]
    ctx.ui.setWidget(key, encoded)
  } else {
    ctx.ui.setWidget(key, undefined)  // 清除
  }
}
```

**为什么不需要 shim**（审查结论）：extension 本就要改代码调 `guiSetWidget()`，helper 内部直接调原生 `ctx.ui.setWidget(key, [MARKER+JSON])` 就能走通整条链路。shim 的唯一潜在价值是透明拦截未引入协议包的第三方 extension，但第三方传的是 string[]（ANSI 文本），不触发 GuiComponent 分支，shim 无所作为。

**runtime 侧解码**：event-adapter.ts 的 setWidget 分支检测 marker 前缀（详见 §8.1）。


#### extension 怎么用

协议包提供 `guiSetWidget()` helper，extension 开发者不需要知道底层编码：

```typescript
import { guiSetWidget, guiComponent } from '@zhushanwen/extension-protocol'

/** 单段清单：两段共用同一构造（仅过滤条件不同） */
function todoListTree(todos: Todo[]) {
  return guiComponent('list-tree', {
    items: todos.map(t => ({
      label: t.text,
      icon: t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'circle' : 'dot',
      status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : undefined,
    })),
  })
}

function refreshDisplay(ctx: ExtensionContext, todos: Todo[]) {
  if (ctx.mode === 'rpc') {
    // GUI 模式：内容根 = tab-bar 双段（用通用原语组合表达任务列表）——
    // 待办段 = 未完成项、已完成段 = completed 项；sections 与 tabs 等长一一对应，
    // 宿主渲染 active 段并本地持有切换态（§3.2），不回传 extension
    const open = todos.filter(t => t.status !== 'completed')
    const completed = todos.filter(t => t.status === 'completed')
    guiSetWidget(ctx, 'todo', guiComponent('tab-bar', {
      tabs: [
        { label: `待办 ${open.length}`, active: true },
        { label: `已完成 ${completed.length}` },
      ],
      sections: [[todoListTree(open)], [todoListTree(completed)]],
    }))
  } else {
    // TUI 模式：Component factory（已有）
    ctx.ui.setWidget('todo', (tui, theme) => buildTodoWidget(todos, theme))
  }
}
```

### 4.4 status（setStatus）

**复用 pi 原生**，无需改动。`ctx.ui.setStatus()` 在 RPC 模式下已有效（fire-and-forget），event-adapter 已正确翻译。

修复点仅在前端：将 status 从 SideDrawer footer 提升为全局底栏，并恢复 ANSI 着色（不再 stripAnsi）。

### 4.5 custom message（registerMessageRenderer）

extension 在 `sendMessage` 时把 `__gui__` 放进 details：

```typescript
import { sendMessage } from '@mariozechner/pi-coding-agent'

// extension 推送自定义消息
sendMessage({
  customType: 'workflow-node-completed',
  content: '部署到 staging 完成',
  details: {
    node: 'deploy',
    status: 'done',
    duration: 45000,
    __gui__: {
      v: PROTOCOL_VERSION,
      component: {
        type: 'custom',
        props: {
          component: 'workflow-node-card',
          props: { node: 'deploy', status: 'done', durationMs: 45000 },
        },
      },
    },
  },
})
```

前端 `message.customStart` handler 检测 `details.__gui__`，按 `component.type` 路由。TUI 模式下 `registerMessageRenderer` 照常工作。

### 4.6 交互式组件（ctx.ui.custom）—— 见 §6

---

## 5. 协议包 API（@zhushanwen/extension-protocol）

独立 npm 包，只含类型定义和辅助函数，零运行时依赖。extension 以 `dependencies` 引入。

### 5.1 导出清单

```typescript
// @zhushanwen/extension-protocol

// ── core 类型 ──
export type { GuiComponent, GuiComponentType, GuiComponentProps, GuiRenderResult, WidgetMeta }
export type { StatItem, TreeItem, TreeItemIcon }
export type { GuiContext }

// ── core 常量 ──
export { PROTOCOL_VERSION }
export { GUI_WIDGET_MARKER }

// ── core helper ──
export { isGuiCapable }       // 检测 RPC 模式
export { isGuiComponent }     // 鸭子类型校验（runtime 用）
export { guiResult }          // 构造 GuiRenderResult
export { guiComponent }       // 构造 GuiComponent（带类型推断）
export { guiSetWidget }       // 设置 GUI widget（marker 编码）
export { validateWidgetIconPaths }  // 校验 meta.icon 自定义 paths（白名单，见 §3.5）
export { extractGui }         // 从 details 提取 __gui__（前端用）

// ── extensions/ask-user（富交互，见 §6）──
export type { AskUserQuestion, AskUserOption, AskUserAnswers }
export { ASK_USER_MARKER }
export { askUserInteract }    // 双向交互（select+marker 通道）
export { getAskUserAnswer, getAskUserOther, getAskUserComment }  // 答案解析
```

### 5.2 辅助函数签名

```typescript
/** 检测当前环境是否支持 GUI 渲染（RPC 模式返回 true） */
function isGuiCapable(ctx: GuiContext): boolean

/** 构造 GuiRenderResult，放进 details.__gui__ */
function guiResult(component: GuiComponent): GuiRenderResult

/** 构造 GuiComponent，带类型推断 */
function guiComponent<T extends GuiComponentType>(
  type: T,
  props: GuiComponentProps[T]
): GuiComponent<T>

/** 设置 GUI widget（RPC 模式编码 marker 进 string[]，TUI 模式 no-op） */
function guiSetWidget(
  ctx: GuiContext,
  key: string,
  component: GuiComponent | undefined
): void

/** 校验 meta.icon 自定义形状的 paths（白名单字符集 + 条数/长度上限，见 §3.5）；不抛异常 */
function validateWidgetIconPaths(value: unknown): WidgetIconPathsValidation
// WidgetIconPathsValidation = { valid: true; paths: string[] } | { valid: false; reason: WidgetIconPathsRejection }

/** 从 details 提取 __gui__，带版本校验 */
function extractGui(details: Record<string, unknown> | undefined): GuiRenderResult | undefined

/** 鸭子类型校验（runtime event-adapter 用） */
function isGuiComponent(value: unknown): value is GuiComponent
```

---

## 6. ask-user 富交互层

### 6.1 技术约束

`ctx.ui.custom()` 在 RPC 模式下返回 `undefined`（no-op），且：
- factory 参数（questions/options）在闭包内，无法提取
- pi 的 execute 在 `await ctx.ui.custom()` 处阻塞，RPC 返回 undefined 后直接崩溃

**但 `ctx.ui.select()` 在 RPC 模式下有效**——它走 `extension_ui_request` / `extension_ui_response` 双向通道，runtime 已有完整的请求-回复路由 + 5 分钟超时兜底。

### 6.2 设计：askUserInteract() — 复用 select 通道 + marker 检测

ask-user 不走 `details.__gui__`（那是单向渲染通道），而是**借用 select 的双向通信能力**。helper 把富交互数据序列化进 select 的 `options[0]`，用 marker 标记区分普通 select：

```typescript
// extensions/ask-user/helpers.ts
async function askUserInteract(
  ctx: GuiContext,
  questions: AskUserQuestion[],
  options?: { signal?: AbortSignal; allowCancel?: boolean }
): Promise<AskUserAnswers | null> {
  if (!isGuiCapable(ctx) || !ctx.ui?.select) {
    throw new Error('askUserInteract requires RPC mode. TUI mode: use ctx.ui.custom() directly.')
  }

  // pi select 的 request 硬编码 { method, title, options, timeout }，
  // helper 无法通过标准参数注入自定义字段，只能借用 options 数组。
  const payload = JSON.stringify({
    questions,
    allowCancel: options?.allowCancel ?? true,
  })

  const value = await ctx.ui.select(
    ASK_USER_MARKER,    // title = marker，runtime/前端据此识别
    [payload],          // options[0] = JSON payload
    { signal: options?.signal },
  )

  if (value === undefined) return null  // 取消/超时/abort
  return JSON.parse(value) as AskUserAnswers
}
```

**数据流**：

```
extension: askUserInteract(ctx, questions)
  │
  ├─ ctx.ui.select(ASK_USER_MARKER, [JSON_payload])
  │
  ▼
pi RPC: extension_ui_request{method:'select', title:ASK_USER_MARKER, options:[JSON]}
  │
  ▼
runtime event-adapter (L379):
  ├─ 检测 title === ASK_USER_MARKER
  ├─ JSON.parse(options[0]) → { questions, allowCancel }
  ├─ 产 extension-ui kind 事件（timeout-manager 注册 5min 超时）
  └─ 产 extension.ui_request WS 帧 { askUser:true, askUserQuestions, allowCancel }
  │
  ▼
前端 useExtensionUI:
  ├─ currentAskUserRequest = queue.find(r => r.askUser === true)
  └─ Panel.vue inline 渲染 AskUserOverlay（覆盖 composer 位置）
  │
  ▼
用户操作 → extension.ui_response { result: JSON_answers }
  │
  ▼
runtime → pi stdin → ctx.ui.select() Promise resolve
  │
  ▼
askUserInteract 返回 parsed answers
```

**为什么不走 `details.__gui__`**：`__gui__` 是单向渲染通道（extension → 前端），无法承载双向交互（等用户回传答案）。select 是 pi 原生的双向通道，复用它意味着零 runtime 改动就获得队列/超时/abort 能力。

### 6.3 AskUserQuestion 类型

```typescript
export interface AskUserQuestion {
  header?: string           // Tab 标签（≤12 字符，缺失时用 question）
  question: string          // 完整问题文本
  context?: string          // 上下文摘要
  options?: AskUserOption[] // 互斥选项（无 = 纯自由文本输入）
  multiSelect?: boolean     // 多选
  allowOther?: boolean      // Other 自由文本输入（有 options 时默认 true）
  allowComment?: boolean    // 附加评论
}

export interface AskUserOption {
  label: string
  value?: string            // 缺失时用 label
  description?: string
}

export type AskUserAnswers = Record<string, string>
```

**答案编码规则**：key = `header`（缺失时用 `question`）；单选 value = 选中值 string；多选 value = `JSON.stringify(string[])`；Other 单独 key `${header}__other`；comment 单独 key `${header}__comment`。

### 6.4 前端集成：Panel.vue inline（非 ExtensionUIDialog）

ask-user 富交互**不走 ExtensionUIDialog**（那是 confirm/select/input 等标准对话框的渲染器）。AskUserOverlay 在 `Panel.vue` 中 inline 渲染，覆盖 composer 位置——per-panel 隔离，非全屏 modal。

```typescript
// useExtensionUI.ts 分流
currentAskUserRequest = computed(() => queue.value.find(r => r.askUser === true))   // → Panel
currentDialogRequest  = computed(() => queue.value.find(r => r.askUser !== true))   // → ExtensionUIDialog
```

`AskUserOverlay.vue`（`components/extension/ask-user/`）：标签页切换、单选（radio 圆圈）、多选（复选框）、Other 输入、评论输入、提交/取消。与 Composer 互斥（`v-if="hasAskUserRequest"` / `v-else-if="showPanelComposer"`）。

### 6.5 答案解析 helper

```typescript
// 多选自动 JSON.parse，失败降级返回 [raw]
function getAskUserAnswer(answers: AskUserAnswers, question: AskUserQuestion): string | string[] | undefined

// 读 `${header}__other` key
function getAskUserOther(answers: AskUserAnswers, question: AskUserQuestion): string | undefined

// 读 `${header}__comment` key
function getAskUserComment(answers: AskUserAnswers, question: AskUserQuestion): string | undefined
```

### 6.6 extension 怎么用

```typescript
import { askUserInteract, type AskUserQuestion, type GuiContext } from '@zhushanwen/extension-protocol'

execute(toolCallId, params, signal, onUpdate, ctx) {
  const questions: AskUserQuestion[] = [
    {
      header: '部署目标',
      question: '选择部署环境',
      options: [
        { label: '生产环境', value: 'prod', description: '正式环境，需审批' },
        { label: '预发环境', value: 'staging' },
      ],
      allowComment: true,
    },
  ]

  const answers = await askUserInteract(ctx as GuiContext, questions, { signal })

  if (answers === null) {
    return { content: [{ type: 'text', text: '用户取消' }], details: { cancelled: true } }
  }

  const target = getAskUserAnswer(answers, questions[0])  // 'prod' | 'staging'
  return { content: [{ type: 'text', text: `部署到 ${target}` }], details: { answers } }
}
```

**TUI 模式**：`askUserInteract` 抛错（RPC-only）。extension 必须自行调 `ctx.ui.custom(AskUserComponent)`。

---

## 7. ~~shim extension 设计~~（已移除）

> **审查修正（S1）**：v1-draft 的 shim extension 方案经审查判定为多此一举。`guiSetWidget()` helper 内部直接调原生 `ctx.ui.setWidget(key, [MARKER+JSON])` 即可走通整条链路，不需要 monkey-patch `ctx.ui`。
>
> 已验证的事实（备查）：
> - `ctx.ui` 是所有 extension 共享的同一对象（`runner.js:411-480`，getter 返回 `runner.uiContext`），monkey-patch 技术上可行
> - `runner.uiContext` 无 `Object.freeze/seal`（全文件扫描确认），patch 不会静默失败
> - `session_start` handler 确实传 ctx（`runner.js:531`），且在 `bindExtensions` 后触发
> - 但 shim 的唯一潜在价值（透明覆盖第三方 extension 的原生 setWidget）不成立——第三方传 string[] 不触发 GuiComponent 分支
>
> 结论：砍掉 shim extension，消除 monkey-patch 风险面、session_start 时序依赖、加载顺序讨论三个复杂度来源。widget 传输改为 helper 直编码（§4.3）。

---

## 8. runtime 侧改动

### 8.1 event-adapter.ts

**setWidget 分支增强**（检测协议标记）：

```typescript
const GUI_WIDGET_MARKER = '\x00TAIJI_GUI_WIDGET:'  // NUL 字符开头，不会出现在正常文本中

if (method === 'setWidget') {
  const rawLines = Array.isArray(event.widgetLines) ? event.widgetLines as unknown[] : []

  // 检测 GUI 协议标记
  if (rawLines.length === 1 && typeof rawLines[0] === 'string' && rawLines[0].startsWith(GUI_WIDGET_MARKER)) {
    try {
      const json = (rawLines[0] as string).slice(GUI_WIDGET_MARKER.length)
      const gui = JSON.parse(json)
      // 发结构化 WS 帧（不走 stripAnsi）
      return [{
        kind: 'message',
        message: {
          type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
          payload: { sessionId: sid, widgetKey: String(event.widgetKey ?? ''), gui },
        },
      }]
    } catch {
      // JSON 解析失败，降级为纯文本
    }
  }

  // 原有行为：stripAnsi + string[]
  const lines = rawLines.map(l => stripAnsi(String(l)))
  return [{
    kind: 'message',
    message: {
      type: EXTENSION_EVENTS.WIDGET as ServerMessageType,
      payload: { sessionId: sid, widgetKey: String(event.widgetKey ?? ''), lines },
    },
  }]
}
```

**setStatus 分支**：不再 stripAnsi（保留颜色信息），或提供 `textRaw` 字段。

**handleToolExecutionUpdate 修正**（审查 S5）：当前把整个 `partialResult` 塞进 `detail`（单数），需改为提取 `partialResult.details`：

```typescript
// event-adapter.ts handleToolExecutionUpdate（约 381-394 行）
// 修正前：detail = partialResult（整个对象）
// 修正后：提取 partialResult.details，与 tool_execution_end 路径对齐
const detail: Record<string, unknown> | string | undefined =
  partialResult != null && typeof partialResult === 'object'
    ? ((partialResult as Record<string, unknown>).details as Record<string, unknown> | undefined)
      ?? (partialResult as Record<string, unknown>)  // fallback：无 details 时用整个对象（兼容 subagent 的 progress 形态）
    : (partialResult as string | undefined)
```

### 8.2 历史路径修复（审查 F1——致命）

**这是最关键的修复**。`message-converter.ts:73-95` 的 toolResult 分支完全不读 `details`，重开 session 后 `__gui__` 全丢。

```typescript
// message-converter.ts toolResult 分支（约 73-95 行）
if (tc) {
  const textParts = (Array.isArray(toolResult.content) ? toolResult.content : [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text ?? '')
    .join('\n')
  tc.output = textParts
  if (toolResult.isError) tc.status = 'error'
  // ★ 新增：透传 details（含 __gui__），与实时路径 event-interpreter.ts:209 对齐
  const d = (toolResult as Record<string, unknown>).details
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    tc.details = d as Record<string, unknown>
  }
}
```

同步修类型——`PiHistoryToolResult` 补 `details` 字段：

```typescript
// pi-protocol.ts PiHistoryToolResult（约 360-366 行）
export interface PiHistoryToolResult extends PiHistoryMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  isError?: boolean
  details?: Record<string, unknown>  // ★ 新增：pi 实际持久化了 details，类型声明补齐
}
```

### 8.3 新增 WS 消息类型（审查 S4——三处缺一不可）

```typescript
// shared/src/extension.ts
export const EXTENSION_EVENTS = {
  WIDGET: 'extension:widget',
  WIDGET_GUI: 'extension:widgetGui',  // 新增：结构化 widget
  STATUS: 'extension:status',
} as const
```

```typescript
// shared/src/protocol.ts —— 三处必须同步改，否则 TS 编译报错

// 1. ServerMessageType 联合（约 183 行）加入：
| 'extension:widgetGui'

// 2. ServerMessageMap（约 245 行）加入 payload 映射：
'extension:widgetGui': { sessionId: string; widgetKey: string; gui: GuiComponent }
```

### 8.4 Message 类型补 details（审查 S3）

custom message 方案（§4.5）前端拿不到 `__gui__`，因为 Message 类型没有 details 字段，customStart handler 读了但没存。

```typescript
// shared/src/message.ts Message 接口（约 189-230 行）
export interface Message {
  // ... 已有字段
  customType?: string
  bgNotify?: BgNotifyDetails
  details?: Record<string, unknown>  // ★ 新增：透传 pi customMessage details（含 __gui__）
}
```

同步改 `chat-message-effects.ts` 的 customStart handler（约 400-407 行）：构造 msg 时把 raw details 存进去：

```typescript
const msg: Message = {
  id: `cm-${crypto.randomUUID()}`,
  role: 'system',
  content,
  status: 'complete',
  customType,
  details,  // ★ 新增：保留原始 details（含 __gui__）
  timestamp: Date.now(),
}
```

### 8.5 ToolCall 类型（不改，但提供 helper）

`ToolCall.details` 已是 `Record<string, unknown>`，不需改。但前端读 `__gui__` 需类型守卫（审查 S7/C3）：

```typescript
// @zhushanwen/extension-protocol 提供
export function extractGui(details: Record<string, unknown> | undefined): GuiRenderResult | undefined {
  const g = details?.__gui__
  if (g && typeof g === 'object' && 'v' in g && 'component' in g) {
    return g as GuiRenderResult
  }
  return undefined
}
```

前端统一用 `extractGui(tool.details)` 读取，集中校验版本号，避免散落的 `as` 断言。

**命名陷阱提醒**（审查 C4）：ToolCall 同时有 `details`（复数，来自 tool_call_end 的 result.details）和 `detail`（单数，来自 tool_call_update 的 partialResult）。`__gui__` 在 `details`（复数）里。streaming 期间从 `detail`（单数）读，但修正后（§8.1）也提取了 details，路径统一。

---

## 9. 前端侧改动

### 9.1 GuiComponent 渲染路由（审查 S2——custom 注册机制）

```typescript
// renderer/src/components/panel/message-stream/GuiComponentRenderer.vue
<script setup lang="ts">
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import AnsiText from './gui/AnsiText.vue'

// 已实现的内置组件映射。P2 阶段逐步补充 card / stats-line / progress-bar 等。
const BUILTIN_MAP: Record<string, Component> = {
  'ansi-text': AnsiText,
  // P2 待实现: 'card' / 'stats-line' / 'progress-bar' / 'list-tree' / 'columns' / 'tab-bar'
}

// custom 组件注册表（内置 extension 编译期注册，P2 实现）
const CUSTOM_MAP = inject<Record<string, Component>>('gui-custom-registry', {})

const props = defineProps<{ component: GuiComponent }>()

const resolved = computed(() => {
  if (props.component.type === 'custom') {
    const name = (props.component.props as { component?: string }).component
    return CUSTOM_MAP[name ?? ''] ?? AnsiText
  }
  return BUILTIN_MAP[props.component.type] ?? AnsiText  // 未知类型降级
})
</script>
```

**降级行为**：未注册的 type（P2 前的 card/stats-line 等）一律降级到 `AnsiText`，把 props 序列化为 JSON 文本展示（不崩渲染、不丢信息）。

**custom 类型约束**：外部（用户安装的）extension 的 custom 组件无法在前端注册——Vue 组件定义需要编译期打包，不能通过 WS 传输。仅 taiji 内置 extension 可在编译期注册到 `CUSTOM_MAP`。

### 9.2 Block.vue 集成（审查 S6——不能直接落地）

Block.vue 当前结构：折叠态 header（1 行）+ 展开态详情（`<template v-if="toolExpanded">`），且 subagent 有独立分支。GuiComponentRenderer 插入在**展开态详情内**，替换原来的纯文本 result：

```vue
<!-- 普通 tool 块展开态（Block.vue 约 101-116 行） -->
<template v-if="toolExpanded">
  <div class="mt-1 font-mono text-[12px] text-fg">
    <span :class="isFailed ? 'text-danger' : 'text-info'">{{ toolName }}</span>
    <span class="text-muted">({{ argPath }})</span>
  </div>
  <!-- ★ __gui__ 优先 → 结构化渲染 -->
  <GuiComponentRenderer
    v-if="guiComponent"
    :component="guiComponent"
  />
  <!-- ★ 无 __gui__ → ANSI 渲染（需先加 outputRaw 字段，见下方）-->
  <div
    v-else-if="result"
    class="mt-1 inline-flex items-start gap-1 pl-0.5 font-mono text-[12px] leading-snug whitespace-pre-wrap"
    :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'"
  >
    <Check v-if="!isFailed" class="mt-0.5 size-3 shrink-0 text-success" />
    <XCircle v-else class="mt-0.5 size-3 shrink-0 text-danger" />
    <AnsiText v-if="ansiContent" :content="ansiContent" />
    <span v-else>{{ result }}</span>
  </div>
</template>
```

```typescript
// Block.vue script 新增 computed
import { extractGui } from '@zhushanwen/extension-protocol'

const guiComponent = computed(() => extractGui(props.tool?.details)?.component)

// ANSI 兜底：ToolCall 需新增 outputRaw 字段（保留原始 ANSI）
// shared/src/message.ts: ToolCall 加 outputRaw?: string
// event-adapter handleToolExecutionEnd: output 不 stripAnsi，额外存 outputRaw
const ansiContent = computed(() => props.tool?.outputRaw)
```

### 9.3 SideDrawer widget 渲染

- 新增 `extension:widgetGui` WS 订阅（SideDrawer.vue 约 288 行旁加 `onMessage`）
- 新增 `activeGuiComponent` ref，与 `activeLines` 互斥
- `mapWidgetKeyToTab` 扩展：识别 pi-todo/goal/workflow 的 widgetKey 路由到对应 tab
- 模板加 `v-else-if="activeGuiComponent"` 分支渲染 `<GuiComponentRenderer>`

### 9.4 全局 Status Bar（审查 C5——状态提升）

当前 status 绑死在 SideDrawer footer（SideDrawer.vue:104-116），SideDrawer 用 v-if 卸载时 status 丢失。需提取 composable：

```typescript
// renderer/src/composables/useExtensionStatus.ts
const statusMaps = new Map<string, Ref<Map<string, string>>>()  // 按 sessionId 分区

export function useExtensionStatus(sessionId: Ref<string | null>) {
  // 从 SideDrawer 移出订阅逻辑 + statusMap
  // 注册 extension:status 订阅（useSessionEvents）
  // 返回 computed statusEntries
}
```

挂载点：`Workspace.vue` 底部（PanelContainer 的兄弟节点），不依赖 SideDrawer 开关。

### 9.5 ExtensionUIDialog + AskUserOverlay（已实现）

**ExtensionUIDialog**（`components/extension/ExtensionUIDialog.vue`）：渲染 pi 原生的 confirm/select/input/editor 对话框。消费 `useExtensionUI().currentDialogRequest`（非 ask-user 的请求）。

**AskUserOverlay**（`components/extension/ask-user/AskUserOverlay.vue`）：渲染 ask-user 富交互。在 `Panel.vue` inline 集成（非 ExtensionUIDialog），覆盖 composer 位置。消费 `useExtensionUI().currentAskUserRequest`。

两者通过 `useExtensionUI` 分流：`askUser === true` → AskUserOverlay，否则 → ExtensionUIDialog。

**回复通道**：用户操作后前端发 `extension.ui_response` WS 帧，runtime `extension-message-handler.ts` 注入回 pi stdin → pi 的 select/confirm/input Promise resolve。

---

## 10. extension 编写指南

### 10.1 迁移步骤

以 pi-todo 为例：

1. **安装协议包**：`npm install @zhushanwen/extension-protocol`
2. **execute 分支**：在 execute 返回处加 `if (ctx.mode === 'rpc')` 分支，构造 `details.__gui__`
3. **widget 分支**：refreshDisplay 加 `if (ctx.mode === 'rpc')` 分支，调 `guiSetWidget()`
4. **renderResult 保持**：TUI 的 renderResult 不动，RPC 模式下不会被调用

### 10.2 最小改动模板

```typescript
import { guiResult, guiSetWidget, isGuiCapable, guiComponent, PROTOCOL_VERSION } from '@zhushanwen/extension-protocol'

execute(toolCallId, params, signal, onUpdate, ctx) {
  const data = doWork(params)
  const content = [{ type: 'text' as const, text: formatForLLM(data) }]

  if (isGuiCapable(ctx)) {
    return {
      content,
      details: {
        ...data,
        __gui__: guiResult(
          guiComponent('stats-line', {  // 或其他通用原语 / custom
            items: [{ label: '结果', value: String(data.count) }],
          })
        ),
      },
    }
  }

  return { content, details: { ...data } }
}
```

### 10.3 不使用协议包的 extension

不引入协议包的 extension 不受影响——`details.__gui__` 不存在，前端走纯文本 / ANSI 兜底。协议是渐进增强，不是强制要求。

---

## 14. ASCII 布局→结构化映射

### 14.1 问题：extension 自画 ASCII 布局

pi 的 Box 组件**不画 Unicode 边框**（只做 padding + 背景），所以 extension 被迫在代码里手写 `┌─┐││└─┘` / `╭╮╰╯` 拼接逻辑（含 ANSI 安全截断、宽度计算、padding 对齐）。

已确认的自画边框实例：
- `ask-user/src/component.ts:124-129`——box `┌┐└┘─│`
- `subagents/src/tui/bg-notify-render.ts:114-177`——`╭╮╰╯─│`（注释明确「为何不用 Box 组件：Box 不画 Unicode 边框」）
- `subagents/src/tui/list-component.ts:255-361`——`│├┬┴┤─` 双列表格
- `workflow/src/interface/views/WorkflowsView.ts:107-109,547-599`——完整 `╭╮╰╯├┤│─` + sidebar divider
- `todo/src/render.ts:88-107`——双列 `│` 分隔
- `goal/src/projection/widget.ts:76-80`——progress bar `█░`

### 14.2 TUI 字符三类映射

extension 的 TUI 字符分三类，每类有不同的 GUI 处理方式：

#### A 类：语义 glyph（~50%）→ lucide 图标 + 语义色

有语义含义的字符，GUI 下用图标库替代，**完全不保留 ASCII**：

| TUI glyph | 语义 | GUI 曠代 | 出现的 extension |
|-----------|------|---------|-----------------|
| `✓` | 完成/成功 | `<Check>` text-success | 全部 |
| `✗` `✕` | 失败/取消 | `<XCircle>` text-danger | subagents/todo/workflow |
| `●` | 进行中 | `<CircleDot>` text-warning | todo/workflow |
| `○` | 待办 | `<Circle>` text-subtle | todo |
| `■` | cancelled | `<Square>` text-muted | subagents |
| `◆` | goal 标识 | `<Target>` text-accent | goal |
| `☑` | todo 标识 | `<ListChecks>` text-accent | todo |
| `⏸` | paused | `<Pause>` text-warning | goal/workflow |
| `⊘` | blocked | `<OctagonX>` text-danger | goal |
| `⊗` | 预算耗尽 | `<CircleSlash>` text-danger | goal |
| `⏱` | 时间耗尽 | `<Timer>` text-danger | goal |
| `→` | tool 调用 | `<ArrowRight>` text-info | subagents/workflow |
| `∘` | turn 摘要 | `<Circle>` text-subtle | workflow |
| `❯` `>` | 选中指针 | CSS（active 项样式） | workflow/ask-user |
| `[✓]` `[ ]` | checkbox | `<Checkbox>` 组件 | ask-user |
| `⠋⠙⠹…` | spinner 动画 | `<Loader2 class="animate-spin">` | subagents |

协议处理方式：这些 glyph 不出现在 GuiComponent 的 props 数据里——前端组件内部按 status/icon 字段渲染对应图标。extension 侧只需传语义数据（如 `{status: 'completed'}`），前端组件自动映射到 Check 图标。

#### B 类：布局字符（~30%）→ CSS 布局，完全不保留

纯视觉排版字符，GUI 下用 CSS 替代：

| TUI 字符 | 用途 | GUI 替代 | 协议组件 |
|---------|------|---------|---------|
| `┌─┐││└─┘` `╭╮╰╯` | box 边框 | CSS `border` + `rounded-md` | `card` |
| `─` `═══` | 水平分隔线 | CSS `border-t` 或 `<hr>` | `card.header` 分隔 |
| `│` | 列分隔 | CSS `grid` / `gap` | `columns` |
| `  ⎿ ` | 层级缩进 | CSS `padding-left` / `border-l` | `list-tree`（depth 字段）|
| `████░░░░` | progress bar | CSS `<progress>` 或 div+width | `progress-bar` |
| `├┤┬┴┼` | T 型连接 | CSS grid 边框 | `columns` + `card` |
| `tab │ tab` | 标签栏分隔 | CSS `gap` + active 样式 | `tab-bar` |

协议处理方式：这些字符不出现在 GuiComponent 的 props 数据里。前端组件用 CSS 实现：
- `card`：`rounded-md border border-border` + variant 淡底色（`color-mix`）
- `columns`：`grid` + `gap`，`ratios` 转为 `grid-template-columns`
- `list-tree`：递归渲染，每层 `padding-left` + 左 `border-l`
- `progress-bar`：`<div>` + inner `<div style="width: pct%">`

#### C 类：数据格式化（~20%）→ 结构化字段

信息编码字符串，GUI 下拆成数据字段：

| TUI 格式 | 数据结构 | 协议字段 |
|---------|---------|---------|
| `N turns · Nk · Ns` | `{turns, tokens, duration}` | `stats-line.items[]` |
| ` | N% tokens` | `{tokenPct}` | `progress-bar`（current/total 算出 pct）|
| `Token: Nk/Mk (P%)` | `{used, total, percent}` | `progress-bar` |
| `N/M agents` | `{completed, total}` | `stats-line` |

协议处理方式：extension 不格式化文本，直接传数值字段。前端组件负责格式化显示（`12.4k tokens` 等）。

### 14.3 嵌套组合

布局原语可嵌套组合表达复杂布局。例：pi-workflow 的 WorkflowsView（sidebar + main + footer）：

```typescript
// extension 构造的 GuiComponent
{
  type: 'card',
  props: {
    variant: 'default',
    body: [
      {
        type: 'columns',
        props: {
          ratios: [1, 2],  // sidebar 窄、main 宽
          children: [
            // 左列：phase 列表
            { type: 'list-tree', props: { items: phaseItems } },
            // 右列：agent 列表（可滚动）
            { type: 'list-tree', props: { items: agentItems } },
          ],
        },
      },
      {
        type: 'stats-line',
        props: { items: [{ value: '↑↓ navigate · ⏎ enter · esc back' }] },
      },
    ],
  },
}
```

### 14.4 各 extension 的结构化覆盖度

extension 用通用原语组合表达领域数据，不再有专属组件类型：

| Extension | 主组件组合 | 需要的通用原语 |
|-----------|-----------|--------------|
| pi-todo | `tab-bar`（`sections` 双段：待办/已完成 各一段 `list-tree`）| meta `icon`/`badge`（托盘条目，v1.1）|
| pi-goal | `card` + `stats-line` + `progress-bar` | — |
| pi-subagents | `card`(bg-notify) + `list-tree`(eventLog) + `stats-line` | — |
| pi-workflow | `card` + `columns` + `list-tree` | sidebar+main 双列 |
| ask-user | AskUserOverlay（独立组件，不走 GuiComponentRenderer） | — |

**设计原则**：协议层不定义 extension 专属类型。各 extension 的领域数据（任务状态、目标生命周期、工作流 reason 码等）用通用原语的 props 表达。如果通用原语组合无法覆盖，走 `custom` 通道在前端注册专属 Vue 组件。

---

## 15. GUI 渲染映射——各入口当前能力与协议对接

### 15.1 当前渲染能力总览

| 渲染入口 | 当前能力 | DOM 结构 | 协议对接改动 |
|---------|---------|---------|-------------|
| **tool result** | 纯文本 `{{ result }}` | Block.vue: `<span>{{ result }}</span>` + `font-mono whitespace-pre-wrap` | 加 `GuiComponentRenderer` 分支 + `AnsiRenderer` 兜底 |
| **widget（M17）** | composer 任务托盘的协议 widget 区（已实现；原「对话流 WidgetArea」消费端已于 2026-09-16 退役，见 [D11](../design/composer-task-tray.md)） | 托盘 widget 区：icon 按钮行（`meta` 驱动 icon/badge/状态色）+ 面板内 `GuiComponentRenderer`（`guiTree` 逐项渲染） | `extension:widget`/`extension:widgetGui` 订阅 → ViewHostStore per-session 缓存 → 托盘消费；widget 不再进 SideDrawer/sidebar |
| **status** | 纯文本 footer | SideDrawer.vue: `<footer><span>key</span><span>text</span></footer>` | 提取 `useExtensionStatus()` composable + 挂载到 Workspace 底部 |
| **custom message** | BgNotifyCard（结构化）/ SystemNotice（纯文本）| MessageStream.vue: `v-else-if="bgNotify"` | 加 `message.details.__gui__` 检测 + `GuiComponentRenderer` |
| **dialog** | **不存在** | — | 新建 `ExtensionUIDialog` + `extension.ui_request` handler |

### 15.2 已有结构化范例的 CSS 约定（协议前端组件必须遵循）

taiji 已有 3 个结构化渲染范例，协议新增组件必须对齐其 CSS 约定：

| 约定 | 范例来源 | 具体用法 |
|------|---------|---------|
| Tailwind 工具类内联 | 全部 | `flex flex-wrap items-center gap-x-3` |
| CSS 变量语义色 | BgNotifyCard | `text-danger`、`text-success`、`text-info`、`text-reasoning` |
| `color-mix` 状态淡底 | BgNotifyCard | `bg-[color-mix(in_oklch,var(--danger)_5%,transparent)]` |
| @lucide/vue 图标 | BgNotifyCard / Block.vue | `size-3`（12px）尺寸约定 |
| `font-mono` 等宽小字 | Block.vue stats 行 | `text-[11px]` 或 `text-[12px]` |
| 卡片形态 | BgNotifyCard / ChangeSetCard | `rounded-md border px-3 py-2` |

### 15.3 前端组件清单与设计

协议需要的前端 Vue 组件（`packages/renderer/src/components/panel/message-stream/gui/`）：

| 组件 | 对应 GuiComponent type | 状态 | CSS 布局核心 |
|------|----------------------|------|-------------|
| `AnsiText.vue` | `ansi-text` | **已实现** | `ansi_up` → `<span>` 着色 |
| `GuiCard.vue` | `card` | P2 待实现 | `rounded-lg border` + variant + header/body 递归渲染 |
| `GuiStatsLine.vue` | `stats-line` | P2 待实现 | `flex flex-wrap gap-x-3` + severity 颜色 |
| `GuiProgressBar.vue` | `progress-bar` | P2 待实现 | `<div>` + inner `<div style="width%">` |
| `GuiListTree.vue` | `list-tree` | P2 待实现 | 递归 + `padding-left` depth + icon SVG |
| `GuiColumns.vue` | `columns` | P2 待实现 | `grid` + `grid-template-columns` |
| `GuiTabBar.vue` | `tab-bar` | P2 待实现 | `flex gap-1` + active 样式 |

**ask-user 富交互组件**（不在 BUILTIN_MAP，独立集成）：

| 组件 | 位置 | 状态 |
|------|------|------|
| `AskUserOverlay.vue` | `components/extension/ask-user/` | **已实现** |

P2 前，非 `ansi-text` 的通用原语降级为 JSON 序列化文本展示（不崩渲染）。

### 15.4 渲染挂载点

| 渲染入口 | 挂载位置 | 文件 |
|---------|---------|------|
| tool result GuiComponent | Block.vue 展开态详情内（`extractGui` 调用 ×2） | `Block.vue:191,198` |
| widget GuiComponent（M17） | **composer 任务托盘的协议 widget 区**（composer 工具条左簇；`extension:widgetGui`/`extension:widget` WS 事件 → ViewHostStore per-session 缓存 → 托盘 widget 按钮/面板渲染） | `packages/renderer/src/components/panel/tray/TrayWidgetButton.vue` / `TrayWidgetPanel.vue`（已实现）；历史：对话流 pill（`WidgetArea.vue`，已随 2026-09-16 退役删除）、SideDrawer.vue:332-345（已废弃方向） |
| custom message GuiComponent | MessageStream.vue system 消息分支（`extractGui` 调用 ×1） | `MessageStream.vue:130` |
| ask-user 富交互 | **Panel.vue inline**（覆盖 composer 位置，与 Composer 互斥） | `Panel.vue:90-97` |
| ExtensionUIDialog（confirm/select/input） | 全局 portal | `ExtensionUIDialog.vue` |

---

## 11. 实施分阶段

| Phase | 范围 | 状态 |
|---|---|---|
| **P0: ANSI 兜底 + 历史路径修复** | tool output ANSI 渲染（ansi_up + Block.vue + outputRaw）+ message-converter.ts details 透传（F1）+ handleToolExecutionUpdate details 提取（S5） | ✅ 已完成 |
| **P1: 协议包 + ExtensionUIDialog + ask-user 富交互** | extension-protocol 包 + event-adapter widget/ask-user marker 检测 + shared/protocol.ts 类型 + ExtensionUIDialog（confirm/select/input）+ askUserInteract + AskUserOverlay（Panel.vue inline） | ✅ 已完成 |
| **P2: 通用原语渲染** | GuiCard / GuiStatsLine / GuiProgressBar / GuiListTree / GuiColumns / GuiTabBar Vue 组件 + custom 注册机制 | 待实现 |
| **P3: extension 迁移** | 各 extension 接入协议（用通用原语组合表达领域数据） | 待实现 |

---

## 12. 与 pi 协议的关系

本协议**不修改 pi 源码**，**不覆盖 pi 原有行为**。具体：

- TUI 模式下 extension 的 renderResult/renderCall/setWidget(custom factory)/registerMessageRenderer 照常工作
- RPC 模式下 pi 原有的 setWidget(string[]) / setStatus / select / confirm / input 行为不变
- `details.__gui__` 是 extension 自主放入的额外字段，pi 原样透传（agent-session.js `result: event.result` 零过滤），不与 pi 的任何逻辑冲突
- 协议包是纯类型 + helper，零运行时副作用，不引入对 pi 的依赖

**如果 pi 未来原生支持结构化 GUI 渲染**（如 RPC 模式透传 renderResult 的结构化数据），本协议可以平滑迁移——extension 只需把 `details.__gui__` 的构造逻辑移到 pi 原生支持的通道里。

---

## 13. 审查修正日志

v1-draft 经 4 路并行技术审查（shim 可行性 / 交互层 / 数据链路 / 前端路由），修正如下：

### 致命问题（阻塞落地）

| ID | 问题 | 修正 |
|---|---|---|
| **F1** | `message-converter.ts:73-95` toolResult 分支不读 details，重开 session 后 `__gui__` 全丢，违反 [HISTORICAL] 关键规则 9 | §8.2 补 details 透传 + `PiHistoryToolResult` 类型补 `details?` 字段 |
| **F2** | 前端无 `extension.ui_request` handler，交互 RPC 分支不可用，select() 卡 5 分钟超时 | §6 明确标注约束；ExtensionUIDialog + AskUserOverlay 已实现（§11 P1 完成）|

### 严重问题（需改设计/文档）

| ID | 问题 | 修正 |
|---|---|---|
| **S1** | shim extension 对 widget 场景多此一举——helper 直编码即可 | §7 整节移除，§4.3 改为 `guiSetWidget()` helper 直编码 |
| **S2** | custom 组件注册机制完全空白，外部 extension 自定义组件名无法路由 | §9.1 明确约束：内置 extension 编译期注册，外部用内置类型或 CustomFallback |
| **S3** | Message 类型无 details 字段，custom message 方案前端拿不到 `__gui__` | §8.4 Message 加 `details?` + customStart handler 改造 |
| **S4** | shared/protocol.ts 三处类型缺失（ServerMessageType / ServerMessageMap / EXTENSION_EVENTS） | §8.3 补全三处 |
| **S5** | handleToolExecutionUpdate 把整个 partialResult 塞进 detail（单数），没提取 details | §8.1 补提取逻辑 |
| **S6** | Block.vue 集成代码不能直接落地（outputRaw 不存在 + 渲染结构假设错误）| §9.2 重写，明确插入位置和 ToolCall.outputRaw 新增 |

### 可简化项

| ID | 问题 | 修正 |
|---|---|---|
| **C1** | shim extension | 砍掉（见 S1）|
| **C2** | undefined 序列化约定缺失 | guiResult() helper strip undefined（协议层约定）|
| **C3** | extractGui() 类型守卫 helper | §8.5 提供 |
| **C4** | ToolCall.details vs detail 命名陷阱 | §8.5 显式标注 |
| **C5** | statusMap 绑死 SideDrawer | §9.4 提取 useExtensionStatus() composable |
| **C6** | WS payload 大小防御 | 协议层约定 GuiComponent 体积上限 |

### 行号引用修正

文档中行号引用（agent-session.js:451 / rpc-mode.js:264 / jsonl.js:8 等）会随 pi 版本漂移。实现时应以函数名为准（`_emitExtensionEvent` / `serializeJsonLine` / `createExtensionUIContext`）。

### M17 挂载点变更（2026-08-14 定稿）

**变更**：`setWidget` 的 GUI 挂载点从 **M7 drawer widget** 改为 **M17 对话流 widget 面板**（MessageStream 与 composer 之间）。

**背景**：todo/goal 的 TUI widget（setWidget，常驻 + 覆盖更新，官方文档定位 "persistent content, good for todo lists, progress"）映射到 drawer（M7）/sidebar（M2）与产品诉求冲突——用户明确拒绝 drawer/sidebar，要求「常驻 + 更新」语义落在**对话流**。M5 custom message 是 append-only 消息语义（无更新 API），不承担面板语义。

**决策**：
1. GUI 侧新增 M17 挂载点，语义与 pi setWidget 完全一致（常驻 + 同 key 覆盖更新 + undefined 清除），数据通道不变（`extension:widget`/`extension:widgetGui`）
2. todo/goal 走 M17：tool result 不再带 `__gui__`（M4 移除）、不推 custom message（M5 不走）
3. widget 不进 sidebar（M2 方向废弃，动态 view 发现移除）
4. M5（custom message 渲染）保留为独立能力，与 M17 正交（subagent-workflow 等已推 `__gui__` message）
5. **[2026-09-16 后续]** M17 的宿主由「对话流 widget 面板」迁至 **composer 任务托盘的协议 widget 区**（对话流 pill 形态退役，setWidget 语义与数据通道不变；见 [composer-task-tray.md](../design/composer-task-tray.md) D11）

### v1.1 字段扩展（2026-09-16）

**变更**（全部 additive，`PROTOCOL_VERSION` 不变；来源设计 `docs/design/composer-task-tray.md` D4/D5）：
1. `WidgetMeta` 加 `icon?`（lucide key 或自定义形状 `{ paths }`）与 `badge?`（extension 全权格式化的短文本，宿主超长 truncate 至 6）——见 §3.5；形状归 extension、风格由宿主锁死（线宽/颜色/尺寸固定）
2. 协议包新增 `validateWidgetIconPaths`（paths 白名单：字符集 + 条数 ≤8 / 单条 ≤512 / 总长 ≤2048），不抛异常返回判定对象，宿主据 `!valid` 落兜底 icon + warn——见 §3.5
3. `tab-bar` 加 `sections?`（与 `tabs` 等长的分段子树容器），缺省维持纯展示；active 归宿主本地、后续推送不重置用户选择——见 §3.2
4. 配套同步：`packages/plugin-sdk/src/types.ts` 平行副本（手维护，同 commit）；消费端（协议 widget 的托盘挂载位）在 renderer 侧另行实施

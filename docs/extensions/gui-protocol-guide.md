# Extension GUI 协议接入指南

> **面向**：pi extension 开发者（how-to）
> **目标**：将现有 TUI-only extension 改造为 TUI/GUI 双模，在 taiji 桌面端获得结构化 GUI 渲染
> **协议权威**：GuiComponent 渲染协议族（类型全集、Helper 完整语义、端到端数据流链路）见 [docs/architecture/extension-gui-protocol.md](../architecture/extension-gui-protocol.md)；**统一提问表单协议（ui-form）的权威描述在本指南 §3.4**，代码 SSOT = `packages/extension-protocol/src/extensions/ui-form/`。

---

## 1. 问题：为什么需要改造

taiji 以 `--mode rpc` 运行 pi，pi 的 5 个渲染入口（`renderResult` / `setWidget` / `setStatus` / `registerMessageRenderer` / `ctx.ui.custom`）在 RPC 模式下失效或降级——pi 的 `Component` 返回 ANSI 文本行，不可序列化进 JSON-RPC。

**解决思路**：extension 在 `execute()` 内部按 `ctx.mode` 分支——TUI 走原生 `Component`，RPC 走结构化 `GuiComponent`（可序列化的 `{ type, props }`）。代码只写一版，运行时自动路由。问题陈述与入口失效明细见协议权威文档 §1。

---

## 2. 快速开始

### 2.1 安装协议包

```bash
npm install @zhushanwen/extension-protocol
# 或
pnpm add @zhushanwen/extension-protocol
```

协议包是纯 TypeScript 类型 + helper 函数，零运行时依赖。

### 2.2 最小改造模板

改造前（TUI-only）：

```typescript
export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Do something',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = doWork(params)
    // TUI 模式下 pi 调 renderResult 渲染 Component
    return {
      content: [{ type: 'text', text: result.summary }],
      details: { data: result.data },
    }
  },
  // renderResult 返回 ANSI Component —— RPC 模式下从不调用
  renderResult(result) {
    return new MyTuiComponent(result.details.data)
  },
}
```

改造后（TUI/GUI 双模）：

```typescript
import {
  isGuiCapable,
  guiResult,
  guiComponent,
  type GuiContext,
} from '@zhushanwen/extension-protocol'

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Do something',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = doWork(params)

    const details: { data: unknown; __gui__?: unknown } = { data: result.data }

    // ★ RPC 模式：构造结构化 GUI 组件放进 details.__gui__
    if (isGuiCapable(ctx as GuiContext)) {
      details.__gui__ = guiResult(
        guiComponent('stats-line', {
          items: [
            { label: '总数', value: String(result.total) },
            { label: '成功', value: String(result.success), severity: 'ok' },
            { label: '失败', value: String(result.failed), severity: result.failed > 0 ? 'danger' : 'ok' },
          ],
        })
      )
    }
    // TUI 模式：details 不含 __gui__，pi 调 renderResult 渲染 Component

    return {
      content: [{ type: 'text', text: result.summary }],
      details,
    }
  },
  renderResult(result) {
    // TUI 模式下仍走原生 Component 渲染，不受影响
    return new MyTuiComponent(result.details.data)
  },
}
```

核心模式只有三步：
1. `isGuiCapable(ctx)` 检测 RPC 模式
2. `guiComponent(type, props)` 构造结构化组件
3. `guiResult(component)` 包装后放进 `details.__gui__`

---

## 3. 渲染入口点适配

| 入口点 | 适配方式 | 双向交互 |
|---|---|---|
| renderResult（tool 结果） | `details.__gui__` | 否 |
| setWidget（持久面板） | `setWidgetDual(ctx, key, { gui, text })` | 否 |
| setStatus（状态栏） | pi 原生，无需改造 | 否 |
| ctx.ui.custom（交互式） | `uiFormInteract(ctx, form)`（统一提问表单协议，见 §3.4） | 是 |
| registerMessageRenderer（消息卡片） | `message.details.__gui__` | 否 |

### 3.1 renderResult：tool 结果结构化渲染

最常用的入口。extension 在 `execute()` 返回时构造 `details.__gui__`，前端在 tool 结果块展开态检测到 `__gui__` 后渲染结构化组件（完整示例见 §2.2 模板）。

**注意事项**：
- `__gui__` 必须放在 `result.details` 下（整体透传），不能放在 `result.content` 内（content 会被 runtime 过滤成 text/image，`__gui__` 丢失）
- `content` 里的 text 仍然会展示给 LLM（content 是 LLM 可见的），`details` 里的 `__gui__` 只给前端渲染用
- 重开 session 后 `__gui__` 仍可见——runtime 已修复历史路径透传（message-converter.ts F1 修复）

### 3.2 setWidget：持久化面板

Widget 是常驻面板（如任务列表）；GUI 下渲染到 **composer 任务托盘的协议 widget 区**，按 widgetKey 一行一个 icon 条目（`meta` 驱动 icon/badge/状态色），条目面板内渲染组件树。RPC 模式下 `ctx.ui.setWidget` 的 factory 参数被丢弃、只吃 `string[]`，所以协议 helper 把 `GuiRenderResult` 编码进单行 `string[]`（NUL 标记 JSON），runtime 解码为结构化 WS 帧。

**双模唯一入口 = `setWidgetDual(ctx, key, { gui, text } | undefined)`**：内部按 `isGuiCapable(ctx)` 分派两臂——RPC 走 marker 编码的 GUI 臂，TUI/json/print 把 `text` 原样推给 pi 原生 widget；`undefined` 清屏与模式无关。**不要自己写 `ctx.mode` 分支，也不要单独调 `guiSetWidget`**（见下方注意事项）。

```typescript
import {
  setWidgetDual, guiResult, guiComponent, type GuiContext,
} from '@zhushanwen/extension-protocol'

// 在 tool execute 或 event handler 中：
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const tasks = await getTasks()

  // ★ 双模一次调用：gui 臂走 GUI 托盘，text 臂走 pi 原生面板
  setWidgetDual(ctx as GuiContext, 'my-widget', {
    gui: guiResult(
      guiComponent('list-tree', {
        items: tasks.map(t => ({
          label: t.text,
          status: t.done ? 'done' : 'running',
        })),
      }),
      // meta 可选：head（标题/状态点/进度）+ 托盘 icon/badge（见协议权威文档 §3.5）
      { title: 'Tasks', status: 'running', badge: String(tasks.filter(t => !t.done).length) },
    ),
    text: renderWidgetLines(tasks),   // TUI/json/print：pi 原生渲染的文本行
  })

  return { content: [{ type: 'text', text: 'Widget updated' }], details: {} }
}
```

**清除 widget**：

```typescript
setWidgetDual(ctx as GuiContext, 'my-widget', undefined)   // 模式无关；托盘 icon 条目随之消失
```

**注意事项**：
- ⚠️ **`guiSetWidget()` 不是 no-op，而是没有 mode 守卫**——它只查 `ctx.ui?.setWidget` 是否存在。TUI/json/print 模式下误调会把 marker 编码行推进 pi 原生 widget，表现为乱码。模式分派只在 `setWidgetDual` 内部（单点），extension 不要自行复写 `isGuiCapable` 判定；「no-op」只属于「`ctx.ui.setWidget` 不存在」（headless）这一种情形。
- 不需要手动拼接 NUL 标记或 JSON.stringify——helper 已封装
- 前端通过 `extension:widgetGui` WS 消息接收（`ViewHostStore` per-session 缓存）→ composer 任务托盘的 icon 条目/面板；推 `undefined` = invalidate = 条目消失

### 3.3 setStatus：状态栏

**无需改造**。pi 的 `ctx.ui.setStatus(key, text)` 在 RPC 模式下已有效。runtime 同时保留 `text`（stripAnsi 纯文本）和 `textRaw`（原始 ANSI），extension 不改代码即可获益：

```typescript
// 现有代码无需改动
ctx.ui.setStatus('my-ext:status', '\x1b[32m● Running\x1b[0m')
// 前端收到 { text: '● Running', textRaw: '\x1b[32m● Running\x1b[0m' }
```

### 3.4 ctx.ui.custom：富交互组件（统一提问表单协议 ui-form）

`ctx.ui.custom()` 在 RPC 模式下返回 undefined（崩溃）。`uiFormInteract()` helper 复用 select 双向通道 + `UI_FORM_MARKER` 检测，前端 FormOverlay 在 Panel 内联渲染统一表单（覆盖 composer 位置；多问 = 多 tab，单问 = 单视图）。ask-user / scheduler / plan 三个内置 extension 的提问已全部收口到该协议；新 extension 的「向用户提问」应直接使用它，而不是自建 marker + 专用组件。

```typescript
import {
  uiFormInteract,
  type FormQuestion,
  type GuiContext,
} from '@zhushanwen/extension-protocol'

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const form: FormQuestion[] = [
    {
      type: 'choice',
      header: '部署目标',
      question: '选择部署环境',
      options: [
        { label: '生产环境', description: '正式环境，需审批' },
        { label: '预发环境', description: '预发布验证' },
      ],
    },
    {
      type: 'text',
      header: '确认信息',
      question: '输入发布说明',
    },
  ]

  const result = await uiFormInteract(ctx as GuiContext, form, { signal })

  if (!result.ok && (result.reason === 'cancelled' || result.reason === 'timeout')) {
    return {
      content: [{ type: 'text', text: '用户取消' }],
      details: { cancelled: true },
    }
  }
  if (!result.ok) {
    // channel-error（含 echo 检测，见下）/ non-json：通道契约破坏，按调用方策略折叠
    return {
      content: [{ type: 'text', text: `交互通道失败：${result.reason}` }],
      details: { failed: result.reason },
    }
  }

  // answers = { '部署目标': '生产环境', '确认信息__other': '修复登录bug' }
  // key = header ?? question，直接按键取值（choice 单选 = label）
  const target = result.answers['部署目标']
  return {
    content: [{ type: 'text', text: `部署到 ${target}` }],
    details: { answers: result.answers },
  }
}
```

**问题类型与答案格式**（`FormQuestion` 判别联合，answers key = `header ?? question`）：

| 问题类型 | 前端渲染 | 答案格式 |
|---|---|---|
| choice 单选（无 multi） | Radio 圆圈选择 + auto-advance | 选中项 label（协议无独立 value 字段，label 即选中值） |
| choice 多选（multi） | Checkbox 复选框 | `JSON.stringify(labels[])` |
| choice Other（allowOther，默认 true） | 末尾 Other 项 + 展开文本输入 | `${key}__other` 独立键 |
| text（无 options 纯自由文本） | Text input | `${key}__other` 键（与纯 Other 形态同键位） |
| schedule（时间输入） | ScheduleForm 整表单（预填 `initial` 草稿打开即可一键确认） | `JSON.stringify(ScheduleFormResult)` |

choice/text 部分与旧 `AskUserAnswers` 逐字兼容（含 Other 键规则与多选序列化）——ask-user 等以 `AskUserQuestion` 为 LLM 契约的消费方用 `getAskUserAnswer` / `getAskUserOther` 解码零改动（两 helper 的入参类型是 `AskUserQuestion`；纯 `FormQuestion` 消费方直接按 `header ?? question` 键取值）。

**回包四态判别**（`uiFormInteract` 返回判别联合，不抛错）：

| 态 | 语义 | 调用方折叠建议 |
|---|---|---|
| `ok` | 收到 FormAnswers | 正常消费 |
| `cancelled` / `timeout` | 用户未作答 | 按「用户取消」折叠 |
| `channel-error` | 通道契约破坏，含 **echo 检测**：收包等于发送 payload 表明宿主 taiji 过旧不识别 `UI_FORM_MARKER`（用户在 band 看到的是 payload 乱码单选项），echo 命中时 message 携带升级指引（非 echo 的真实通道故障 message 为 undefined） | 明确报错（scheduler 禁用本会话工具 / plan 折 cancelled result 留 plan mode） |
| `non-json` | 协议版本错配类故障 | 同 channel-error 策略 |

**TUI 模式**：`uiFormInteract` 抛错（RPC 专用）——formQuestions 在 TUI 无呈现语义，extension 必须自行调 `ctx.ui.custom()` 传 TUI Component（按 `ctx.mode` 分支）。

**内置消费方**：ask-user（问卷，包内 `AskUserQuestion ↔ FormQuestion` 归一 adapter；subagent 间接链 channel-handler 以 `ui_form` / `ask_user` 双通道名注册并双读 `formQuestions ?? questions` 入参）/ scheduler（`ScheduleQuestion` 单问整表单）/ plan（complete 执行方式单 choice 问题）。

### 3.5 registerMessageRenderer：自定义消息卡片

extension 通过 `ctx.sendMessage()` 发送自定义消息时，在 `details.__gui__` 附带 GuiComponent，前端会渲染为自定义消息卡片。

```typescript
import { isGuiCapable, guiResult, guiComponent, type GuiContext } from '@zhushanwen/extension-protocol'

// 在 event handler 或 tool execute 中：
async onMessage(msg, ctx) {
  if (msg.type === 'some_event') {
    const details: Record<string, unknown> = { event: msg.type }

    if (isGuiCapable(ctx as GuiContext)) {
      details.__gui__ = guiResult(
        guiComponent('card', {
          variant: 'elevated',
          header: '事件通知',
          body: [
            guiComponent('stats-line', {
              items: [
                { label: '类型', value: msg.type },
                { label: '时间', value: new Date().toLocaleTimeString() },
              ],
            }),
          ],
        })
      )
    }

    ctx.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `Event: ${msg.type}` }],
      customMessageType: 'my-event',
      details,
    })
  }
}
```

---

## 4. GuiComponent 类型速查

8 个布局/文本原语 + `custom` 逃生口，全部是结构性通用原语（完整类型定义与 props 契约见协议权威文档 §3）。前端渲染状态随类型标注。

| 类型 | 用途 | 关键 props | 渲染状态 |
|---|---|---|---|
| `ansi-text` | ANSI 文本兜底 | `lines: string[]` | 已实现（ansi_up，XSS 安全） |
| `card` | 卡片容器 | `variant?` / `header?` / `body[]` | 已实现 |
| `stats-line` | 统计行 | `items: { label?, value, severity?, icon? }[]` | 已实现 |
| `progress-bar` | 进度条 | `label?` / `current` / `total` / `unit?` / `severity?` | 已实现 |
| `list-tree` | 列表树 | `items: { label, icon?, status?, depth?, children? }[]` / `numbered?`（行首弱化序号） | 已实现 |
| `group` | 垂直组合容器（无视觉样式） | `children: GuiComponent[]` | 已实现 |
| `columns` | 双列网格 | `children[]` / `ratios?` | 已实现 |
| `tab-bar` | 标签栏 | `tabs: { label, active?, status? }[]` / `sections?: GuiComponent[][]`（与 `tabs` 等长的分段子树容器） | 已实现（容器化：`sections` 与 `tabs` 等长时渲染 `tabs[active]` 的子树，active 归宿主本地持有、后续推送不重置；长度不等或缺渲染器上下文时退化为纯展示 + warn） |
| `custom` | 自定义逃生口 | `component`（注册名）/ `props` | 注册表机制已实现（仅内置 extension 编译期注册；未注册名降级 JSON 文本） |

`list-tree` 的 `icon` 取值：`'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'`；`status` 取值：`'running' | 'done' | 'failed'`。

**custom 限制**：Vue 组件定义无法经 WS 传输，仅 taiji 内置 extension 可编译期注册（`provide('gui-custom-registry', ...)`）；外部 extension 的 custom 组件降级为 JSON 文本展示。

**设计原则**：协议层不定义 extension 专属组件类型。各 extension 的领域数据用通用原语组合表达（任务列表用 `list-tree`，目标卡片用 `card` + `stats-line` + `progress-bar`），只有组合无法覆盖的特殊形状才走 `custom`。

---

## 5. Helper API 速查

（完整签名与语义见协议权威文档 §5。）

| Helper | 用途 | 关键行为 |
|---|---|---|
| `isGuiCapable(ctx)` | 检测 RPC 模式 | `GuiContext` 是结构化子类型（零 pi SDK 依赖），pi ctx 天然满足 |
| `guiResult(component, meta?)` | 构造 `details.__gui__` / widget 载荷值 | 返回 `{ v: 1, component, meta? }`；递归删除 undefined 字段 |
| `guiComponent(type, props)` | 构造组件 | 类型参数约束 props 形状 |
| `setWidgetDual(ctx, key, { gui, text } \| undefined)` | 设置/清除 widget（双模唯一入口） | 内部做 `isGuiCapable` 分派：RPC 编码 NUL 标记 JSON、TUI/json/print 推原生文本行；`undefined` 清屏且模式无关 |
| `guiSetWidget(ctx, key, result \| undefined)` | 推送 GUI 臂（低层原语） | ⚠️ 无 mode 守卫：TUI/json/print 误调会把 marker 行推进原生 widget（乱码）；正常路径用 `setWidgetDual` |
| `uiFormInteract(ctx, form, options?)` | 统一提问表单（RPC 专用） | select 通道 + `UI_FORM_MARKER`；返回判别联合 `ok / cancelled / timeout / channel-error / non-json`（不抛错，channel-error 含 echo 检测升级指引）；TUI 误调抛错 |
| `isFormQuestion / isFormAnswers` | 表单形状守卫 | `isFormQuestion` 收窄 `unknown` 为合法问题对象（发送侧不合法项抛错 fail-fast，消费侧逐项过滤） |
| `getAskUserAnswer / getAskUserOther / isAskUserQuestion` | 答案解析与守卫 | `getAskUserAnswer` 多选自动 `JSON.parse`（失败降级 `[raw]`）；`getAskUserOther` 读 `${header}__other` key；入参类型是 `AskUserQuestion`（ask-user 的 LLM 契约），`FormAnswers` 的 choice/text 部分与之逐字兼容 |
| `extractGui(details)` | 提取 `__gui__`（带版本校验） | 前端消费侧用，extension 一般不需要 |

---

## 6. 完整迁移示例：任务列表 extension 改造

用通用原语 `list-tree` + `card` 组合表达任务列表，不依赖专属组件类型（示意组合；pi-todo 实装用 `tab-bar` + `sections`，见协议权威文档 §4.3）。

### 改造前（TUI-only）

```typescript
export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage tasks',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const tasks = await loadTasks()

    // 更新 widget（TUI 专属）
    ctx.ui.setWidget('todo', new TodoWidget(tasks))

    return {
      content: [{ type: 'text', text: `${tasks.length} tasks` }],
      details: { tasks },
    }
  },
  renderResult(result) {
    // TUI 渲染
    return new TodoResultComponent(result.details.tasks)
  },
}
```

### 改造后（双模）

```typescript
import {
  isGuiCapable,
  guiResult,
  guiComponent,
  setWidgetDual,
  type GuiContext,
} from '@zhushanwen/extension-protocol'

// 任务状态 → 通用原语的 icon/status 映射
function toTreeItems(tasks: Task[]) {
  return tasks.map(t => ({
    label: t.title,
    icon: t.status === 'completed' ? 'check'
      : t.status === 'in_progress' ? 'circle'
      : 'dot',
    status: t.status === 'completed' ? 'done'
      : t.status === 'in_progress' ? 'running'
      : undefined,
  }))
}

export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage tasks',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const tasks = await loadTasks()
    const guiCtx = ctx as GuiContext
    const doneCount = tasks.filter(t => t.status === 'completed').length

    // ── Widget（持久面板）──
    // 双模一次调用：gui 臂走 GUI 托盘（marker 通道），text 臂走 pi 原生面板
    setWidgetDual(guiCtx, 'todo', {
      gui: guiResult(
        guiComponent('card', {
          header: `任务 (${doneCount}/${tasks.length})`,
          body: [
            guiComponent('list-tree', { items: toTreeItems(tasks) }),
          ],
        }),
        { title: 'Todo', icon: 'list-checks', badge: String(tasks.length - doneCount) },
      ),
      text: renderWidgetLines(tasks),   // TUI/json/print：pi 原生文本行（示例函数）
    })

    // ── Tool result（结果展示）──
    const details: Record<string, unknown> = { tasks }

    if (isGuiCapable(guiCtx)) {
      details.__gui__ = guiResult(
        guiComponent('card', {
          variant: 'default',
          body: [
            guiComponent('stats-line', {
              items: [
                { label: '完成', value: String(doneCount), severity: 'ok' },
                { label: '待办', value: String(tasks.length - doneCount) },
              ],
            }),
            guiComponent('list-tree', { items: toTreeItems(tasks) }),
          ],
        })
      )
    }

    return {
      content: [{ type: 'text', text: `${tasks.length} tasks` }],
      details,
    }
  },
  renderResult(result) {
    // TUI 模式仍走原生 Component，RPC 模式从不调用
    return new TodoResultComponent(result.details.tasks)
  },
}
```

---

## 7. 常见陷阱

### 7.1 `__gui__` 放错位置

`__gui__` 必须放在 `result.details.__gui__`，不能放在 `result.content` 内。

```typescript
// 错误 —— content 内的 __gui__ 会被 runtime 过滤成 text，丢失结构化数据
return {
  content: [{ type: 'text', text: '...', __gui__: guiResult(...) }],
  details: {},
}

// 正确
return {
  content: [{ type: 'text', text: '...' }],
  details: { __gui__: guiResult(...) },
}
```

### 7.2 widget 的双模覆盖

`setWidgetDual()` 是双模唯一入口——一次调用覆盖两种模式：`gui` 臂走 GUI 托盘（marker 通道），`text` 臂走 pi 原生面板。不需要再手写 `ctx.mode` 分支。

```typescript
// 正确 —— 双模一次调用
setWidgetDual(ctx as GuiContext, 'key', {
  gui: guiResult(guiComponent('list-tree', { items }), { title: 'Tasks' }),
  text: renderWidgetLines(items),
})

// 清屏（模式无关）——托盘 icon 条目随之消失
setWidgetDual(ctx as GuiContext, 'key', undefined)
```

**别拿 `guiSetWidget()` 当双模入口**：它是 `setWidgetDual` 内部的 GUI 臂原语，**没有 mode 守卫**（只查 `ctx.ui?.setWidget` 是否存在）——TUI/json/print 模式下调用会把 marker 编码行推进 pi 原生 widget，表现为乱码，**不是 no-op**。no-op 只发生在「`ctx.ui.setWidget` 不存在」（headless）这一种情形。

同理 `uiFormInteract()` —— TUI 模式下它抛错。extension 需按 ctx.mode 分支，TUI 调 `ctx.ui.custom()`，RPC 调 `uiFormInteract()`。

### 7.3 content 与 details 的分工

| 字段 | LLM 可见 | 前端渲染 | 用途 |
|---|---|---|---|
| `result.content` | 是 | 是（text/image） | 给 LLM 的工具结果摘要 |
| `result.details.__gui__` | 否 | 是（结构化组件） | 给前端的结构化渲染数据 |

`content` 里的文本是给 LLM 看的——保持简洁摘要。结构化展示数据放 `details.__gui__`。

### 7.4 undefined 字段

`guiResult()` 内部调 `stripUndefined()` 递归删除 undefined 字段。但如果 extension 手动构造对象（不经过 helper），需自行确保 JSON.stringify 不含 undefined（JSON.stringify 会丢弃 undefined 字段，但数组中的 undefined 会变成 null）。

### 7.5 ctx 类型断言

协议包用结构化类型 `GuiContext`（零依赖），不 import pi SDK。pi 的 ExtensionContext 天然满足此结构，但 TypeScript 需要 `ctx as GuiContext` 断言。这是设计取舍——避免协议包依赖 pi SDK 版本。

---

## 8. 检查清单

改造 extension 前对照确认：

- [ ] 安装 `@zhushanwen/extension-protocol`
- [ ] `execute()` 内用 `isGuiCapable(ctx)` 做 RPC 分支判断
- [ ] RPC 分支构造 `guiComponent(type, props)` + `guiResult()` 放进 `details.__gui__`
- [ ] TUI 分支保留原有 `renderResult` / `ctx.ui.setWidget` / `ctx.ui.custom` 逻辑
- [ ] widget 用 `setWidgetDual()` 双模一次调用（`gui` 臂 + `text` 臂），清屏传 `undefined`；不要单独调 `guiSetWidget()`（它是无 mode 守卫的 GUI 臂原语，TUI 误调会乱码）
- [ ] 提问交互用 `uiFormInteract()`（RPC 模式，统一提问表单协议 §3.4）/ `ctx.ui.custom()`（TUI 模式）按 ctx.mode 分支
- [ ] `content` 只放 LLM 可见的摘要文本，结构化数据放 `details`
- [ ] `details.__gui__` 放在 `result.details` 下，不在 `content` 内
- [ ] 确认重开 session 后 `__gui__` 仍可见（依赖 runtime F1 修复，已落地）

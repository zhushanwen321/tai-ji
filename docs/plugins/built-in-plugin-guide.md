# xyz-agent 内置插件开发指南

> 本文档面向需要为 xyz-agent 创建**内置插件**（built-in plugin）的开发者。内容覆盖从零搭建到最佳实践的全流程。
>
> **定位**：使用指南（how-to），原在 `docs/architecture/subsystems/plugin/`（2026-09-13 迁出并解散该目录——按 architecture 目录判定标准，「怎么写」不属架构文档）。架构与协议的权威入口：
> - 协议 SSOT：[extension-gui-protocol.md](../architecture/extension-gui-protocol.md)（五个渲染入口的 GUI 镜像 / §13 决策日志 / §15 挂载现状）
> - 架构：[renderer-package-topology.md](../architecture/renderer-package-topology.md) §4（ExtensionHost / 挂载点注册表 / contribution schema）
> - 视觉规格：`docs/page-design/v6-spec-plugin-rendering.html`（组件级权威）与 `docs/page-design/v6-plugin-max-demo.html`（全景 mockup）
> - 关键 ADR：ADR-0007 ~ ADR-0013（`docs/adr/`）

---

## 1. 概述

### 1.1 什么是内置插件

内置插件是随 xyz-agent 应用一起分发的插件，位于 `resources/plugins/` 目录下。由 `PluginService` 统一管理生命周期：trusted 插件共享 **Worker Thread**（≤10 插件/Worker），外部 sandbox 插件独占 **fork 子进程**（`plugin-host-process.ts`）。

### 1.2 内置插件 vs 外部插件

| 维度 | 内置插件 | 外部插件 |
|------|---------|---------|
| 位置 | `resources/plugins/<name>/` | `~/.xyz-agent/plugins/<name>/` |
| 信任等级 | `trusted`（默认） | `sandbox`（默认） |
| Worker 策略 | 共享 trusted Worker | 独占 sandbox fork 子进程 |
| API 访问 | 完整 `Phase2AgentAPI` | 受限 API（无 `agent` 模块） |
| 权限声明 | `permissions` 字段可为空（默认全授权） | 必须显式声明所需权限 |
| Node.js 能力 | 可使用 Node.js builtins | 受限 require，不可直接访问 `fs`/`child_process` 等 |
| 分发方式 | 随应用打包 | npm install / 手动安装 |

### 1.3 运行环境

插件由 runtime 进程内的 PluginService 管理执行：**trusted（内置）插件共享 Worker Thread**，**外部 sandbox 插件独占 fork 子进程**（`plugin-host-process.ts`：「sandbox 插件独占子进程；trusted 插件共享 ≤10 插件/进程」）：

```
┌─ Runtime 进程 ─────────────────────────────┐
│  PluginService                             │
│    ├── Trusted Worker Thread（共享）        │
│    │     ├── statusline (内置)              │
│    │     ├── todo (内置)                    │
│    │     └── ... (其他内置插件)              │
│    └── Sandbox fork 子进程（外部插件独占）   │
└────────────────────────────────────────────┘
```

- **隔离**：每个 Worker/fork 有独立的 `globalThis`，同名变量不冲突
- **通信**：trusted 经 JSON-RPC over `MessagePort` 与 runtime 主线程通信；sandbox fork 经 stdio RPC
- **崩溃隔离**：单个插件崩溃不会影响其他插件或主进程

---

## 2. 快速开始

### 2.1 目录结构

在 `resources/plugins/` 下创建插件目录：

```
resources/plugins/
└── my-plugin/
    ├── package.json      ← 插件清单（必须）
    ├── index.ts          ← 入口文件（必须）
    └── src/              ← 业务代码（可选）
        ├── helper.ts
        └── ...
```

### 2.2 package.json 必填字段

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "displayName": "My Plugin",
  "description": "一句话描述插件功能",
  "xyzAgent": {
    "manifestVersion": 1,
    "main": "index.js",
    "activationEvents": [
      "onStartupFinished"
    ],
    "trustLevel": "trusted",
    "source": "built-in",
    "permissions": []
  }
}
```

**字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 插件唯一标识，同时也是 pluginId。小写，短横线分隔 |
| `version` | ✅ | 语义化版本号 |
| `displayName` | ✅ | 展示名称，出现在 UI 中 |
| `description` | ✅ | 一句话功能描述 |
| `xyzAgent.manifestVersion` | ✅ | 当前必须为 `1` |
| `xyzAgent.main` | ✅ | 入口文件路径（编译后的 `.js`，相对于 package.json） |
| `xyzAgent.activationEvents` | ✅ | 激活事件数组，见下表 |
| `xyzAgent.trustLevel` | 推荐 | 内置插件填 `"trusted"` |
| `xyzAgent.source` | 推荐 | 内置插件填 `"built-in"` |
| `xyzAgent.permissions` | 视情况 | 需要的权限列表。内置 trusted 插件可省略（默认全授权） |

**激活事件类型：**

| 事件 | 触发时机 |
|------|---------|
| `onStartupFinished` | 应用启动完成后（最常用） |
| `onSessionCreate` | 新 session 创建时 |
| `onSlashCommand` | 用户使用 slash 命令时 |
| `onToolCall` | LLM 调用 tool 时 |

**常见权限值：**

| 权限 | 用途 |
|------|------|
| `tools.register` | 注册自定义 AI Tool |
| `hooks.onPiEvent` | 监听 pi 事件 |
| `hooks.register` | 注册 hooks |
| `sessionData.get` | 读取 session 数据 |
| `sessionData.set` | 写入 session 数据 |
| `sessions.sendMessage` | 向 session 发送消息 |

### 2.3 最小 index.ts 模板

```typescript
import type { PluginContext } from '../../../packages/runtime/src/services/plugin-service/plugin-types.js'

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  // 在此注册 hooks、tools、监听事件等
  // ...
}

// deactivate 可选。context.subscriptions 会自动清理
export async function deactivate(): Promise<void> {
  // 额外的清理逻辑（如有）
}
```

### 2.4 生命周期

插件的生命周期由 `PluginService` 管理：

```
应用启动
  │
  ├─ PluginService 扫描 resources/plugins/
  │    └─ 解析每个 package.json → PluginDescriptor
  │         状态: UNLOADED → LOADING
  │
  ├─ 激活事件触发（如 onStartupFinished）
  │    └─ 状态: LOADING → ACTIVATING
  │         └─ Worker Thread 加载 index.js
  │         └─ 调用 activate(context)
  │         └─ 状态: ACTIVATING → ACTIVE
  │
  ├─ 运行中
  │    └─ 插件通过 api 与系统交互
  │
  └─ 应用关闭 / 插件停用
       └─ 调用 deactivate()（如有）
       └─ context.subscriptions 自动 dispose
       └─ 状态: ACTIVE → DEACTIVATING → UNLOADED
```

---

## 3. Plugin API

所有 API 通过 `context.api` 访问，类型为 `Phase2AgentAPI`。API 分为以下模块：

### 3.1 activate(context) 函数

```typescript
export async function activate(context: PluginContext): Promise<void>
```

- **调用时机**：激活事件触发后，由 Worker Thread 调用
- **参数 `context`**：`PluginContext` 对象，包含以下只读属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `pluginId` | `string` | 插件唯一标识（即 package.json 的 `name`） |
| `pluginPath` | `string` | 插件目录的绝对路径 |
| `globalState` | `PluginStateStorage` | 全局 KV 存储（跨 workspace） |
| `workspaceState` | `PluginStateStorage` | 工作区级 KV 存储 |
| `api` | `Phase2AgentAPI` | 核心 API 对象（见下文） |
| `subscriptions` | `Disposable[]` | 推入 Disposable 对象，deactivate 时自动清理 |

### 3.2 context.subscriptions 自动清理

`context.subscriptions` 是一个 `Disposable[]` 数组。将所有需要清理的资源（hook 监听、tool 注册等）推入此数组，插件停用时系统会自动调用每个 `dispose()` 方法：

```typescript
export async function activate(context: PluginContext): Promise<void> {
  const disposable = await api.hooks.onPiEvent('some_event', async () => { /* ... */ })
  context.subscriptions.push(disposable)  // ← deactivate 时自动 dispose
}
```

### 3.3 api.ui — UI API

用于与前端 UI 交互。

#### updateStatusBarItem

在应用底部状态栏添加或更新状态项。

```typescript
api.ui.updateStatusBarItem(
  id: string,           // 状态项唯一 ID
  text: string,         // 显示文本
  options?: StatusBarItemOptions
): Promise<void>
```

**StatusBarItemOptions 参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `tooltip` | `string?` | 鼠标悬停时显示的提示文字 |
| `commandId` | `string?` | 点击时触发的命令 ID |
| `priority` | `number?` | 排序优先级，数字越小越靠前 |
| `scope` | `'per-session' \| 'global'?` | 作用域：`per-session` 绑定特定 session，`global` 全局显示 |
| `sessionId` | `string?` | 当 `scope: 'per-session'` 时，关联的 session ID |

#### showMessage / notify

```typescript
api.ui.notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
```

在客户端 Toast 中显示通知。

#### 交互式对话框

```typescript
// 选择列表
api.ui.showSelect(title: string, options: string[]): Promise<string | undefined>

// 确认对话框
api.ui.showConfirm(title: string, message: string): Promise<boolean>

// 文本输入
api.ui.showInput(title: string, defaultValue?: string): Promise<string | undefined>
```

### 3.4 api.hooks — Hooks API

用于监听和拦截系统事件。

#### onPiEvent

监听从 pi 桥接过来的事件（只读，不可拦截）。

```typescript
api.hooks.onPiEvent(
  eventName: string,                              // 事件名
  handler: (eventName: string, data: unknown) => Promise<void>  // 回调
): Promise<Disposable>
```

**常见 eventName：**

| 事件名 | 触发时机 |
|--------|---------|
| `session_start` | Session 开始 |
| `session_end` | Session 结束 |
| `plugin:statusSetUpdate` | pi extension 设置状态（statusline 场景） |
| `agent_start` | Agent 开始生成 |
| `agent_end` | Agent 完成生成 |

#### 拦截型 hooks

以下 hooks 可以**修改数据或阻止操作**：

```typescript
// 消息发送前
api.hooks.onBeforeSendMessage(handler: HookInterceptor): Promise<Disposable>

// Tool 调用前
api.hooks.onBeforeToolCall(handler: HookInterceptor): Promise<Disposable>

// Agent 启动前
api.hooks.onBeforeAgentStart(handler: HookInterceptor): Promise<Disposable>

// Tool 结果返回后
api.hooks.onAfterToolResult(handler: HookObserver): Promise<Disposable>
```

拦截器返回 `InterceptorResult`：

```typescript
interface InterceptorResult {
  proceed: boolean     // true = 放行, false = 阻止
  reason?: string      // 阻止时的原因说明
  modifiedData?: unknown  // 修改后的数据
}
```

### 3.5 api.tools — Tool 注册 API

```typescript
// 注册自定义 AI Tool
api.tools.register(registration: ToolRegistration): Promise<string>

// 注销
api.tools.unregister(toolKey: string): Promise<void>
```

**ToolRegistration：**

```typescript
interface ToolRegistration {
  name: string                          // Tool 名称
  description: string                   // LLM 可读的描述
  parameters: Record<string, unknown>   // JSON Schema 格式的参数定义
  execute?: (params: {                  // 执行函数
    arguments: Record<string, unknown>
    sessionId?: string
    toolCallId?: string
  }) => Promise<{ content: string; isError?: boolean }>
}
```

### 3.6 api.sessionData — Session 数据 API

```typescript
api.sessionData.get(sessionId: string, key: string): Promise<unknown>
api.sessionData.set(sessionId: string, key: string, value: unknown): Promise<void>
api.sessionData.delete(sessionId: string, key: string): Promise<void>
api.sessionData.keys(sessionId: string): Promise<string[]>
```

用于按 session 存储插件数据（如 todo 列表、工作流状态等）。

### 3.7 api.sessions — Session 管理 API

```typescript
api.sessions.list(): Promise<SessionInfo[]>
api.sessions.get(id: string): Promise<SessionInfo | undefined>
api.sessions.getActive(): Promise<SessionInfo | undefined>
api.sessions.sendMessage(params: {
  sessionId?: string
  role: 'user' | 'system'
  content: string
}): Promise<void>
api.sessions.onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
api.sessions.onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
```

### 3.8 api.agent — Agent 桥接 API（trusted 专属）

```typescript
api.agent.setModel(model: string): Promise<void>
api.agent.getModel(): Promise<string>
api.agent.getThinkingLevel(): Promise<string>
api.agent.setThinkingLevel(level: string): Promise<void>
api.agent.getActiveTools(): Promise<string[]>
```

### 3.9 api.events — 跨插件通信

```typescript
api.events.on(event: string, handler: (data: unknown) => void): Disposable
api.events.emit(event: string, data: unknown): void
```

同一 Worker 内的插件间通信，无需 RPC 中转。

### 3.10 api.config — 配置 API

```typescript
api.config.get(key: string): Promise<unknown>
api.config.getAll(): Promise<Record<string, unknown>>
api.config.set(key: string, value: unknown): Promise<void>
```

---

## 4. 案例走读：Statusline Plugin

以 `resources/plugins/statusline/` 为完整案例，讲解一个内置插件的实现。

### 4.1 功能说明

Statusline 插件监听 pi extension 通过 `plugin:statusSetUpdate` 事件发送的状态更新，将状态数据映射到 xyz-agent 的状态栏系统。例如，pi 的 goal/todo/workflow 状态会实时显示在 xyz-agent 底部状态栏中。

### 4.2 Manifest 解析

```json
{
  "name": "statusline",
  "version": "0.1.0",
  "displayName": "Statusline",
  "description": "Bridges pi extension setStatus events to xyz-agent status bar system",
  "xyzAgent": {
    "manifestVersion": 1,
    "main": "index.js",
    "activationEvents": ["onStartupFinished"],    // ① 启动后自动激活
    "trustLevel": "trusted",
    "source": "built-in",
    "permissions": ["hooks.onPiEvent"]             // ② 只需监听 pi 事件权限
  }
}
```

**要点：**
- ① `onStartupFinished`：应用启动后立即激活，确保在 pi 事件到来之前就已就绪
- ② `permissions: ["hooks.onPiEvent"]`：只声明最小权限——监听 pi 事件

### 4.3 数据映射设计

插件使用 `Record<string, StatusKeyMetadata>` 查找表，将 pi 的 status key 映射到状态栏所需的元数据：

```typescript
interface StatusKeyMetadata {
  priority: number                    // 排序优先级（数字越小越靠前）
  tooltip?: string                    // 悬停提示
  scope: 'per-session' | 'global'     // 作用域
}

const KEY_METADATA_MAP: Record<string, StatusKeyMetadata> = {
  goal:     { priority: 10, tooltip: 'Goal task progress', scope: 'per-session' },
  todo:     { priority: 20, tooltip: 'Todo list progress', scope: 'per-session' },
  workflow: { priority: 15, tooltip: 'Workflow status',    scope: 'per-session' },
  preset:   { priority: 30, tooltip: 'Active preset',      scope: 'global' },
  ssh:      { priority: 40, tooltip: 'SSH connection',     scope: 'global' },
  model:    { priority: 50, tooltip: 'Current model',      scope: 'global' },
}

// 未知 key 的默认元数据
const DEFAULT_METADATA: StatusKeyMetadata = {
  priority: 100,
  tooltip: undefined,
  scope: 'global',
}
```

### 4.4 事件处理与状态更新

完整的 activate 函数：

```typescript
export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  // ① 监听 pi 事件
  const disposable = await api.hooks.onPiEvent(
    'plugin:statusSetUpdate',
    async (_eventName: string, data: unknown) => {
      // ② 类型断言：桥接事件的数据结构
      const bridgeData = data as BridgeEventData
      const { sessionId, key, text } = bridgeData.data

      // ③ 空 text 表示清除该状态项 — 跳过
      if (text === '') return

      // ④ 从查找表获取元数据（未知 key 使用默认值）
      const meta = KEY_METADATA_MAP[key] ?? DEFAULT_METADATA

      // ⑤ 更新状态栏
      await api.ui.updateStatusBarItem(
        `pi-${key}`,        // ID 带前缀，避免与其他插件冲突
        text,
        {
          tooltip: meta.tooltip,
          priority: meta.priority,
          scope: meta.scope,
          // per-session 项需传入 sessionId
          sessionId: meta.scope === 'per-session' ? sessionId : undefined,
        },
      )
    },
  )

  // ⑥ 推入 subscriptions，停用时自动清理
  context.subscriptions.push(disposable)
}
```

**逐步解析：**

| 步骤 | 说明 |
|------|------|
| ① | 通过 `api.hooks.onPiEvent` 监听 `plugin:statusSetUpdate` 事件。pi extension 调用 `setStatus()` 时会触发此事件 |
| ② | 桥接事件的数据结构是 `BridgeEventData`，包含 `eventName`、`data`（含 `sessionId`/`key`/`text`）和 `sessionId` |
| ③ | pi 用空字符串 `""` 表示清除某个状态。此时直接 `return`，不调用 `updateStatusBarItem` |
| ④ | 从预定义的查找表中获取优先级、tooltip、作用域等元数据。未知 key 走 `DEFAULT_METADATA` |
| ⑤ | 调用 `updateStatusBarItem` 更新状态栏。ID 使用 `pi-` 前缀避免与其他插件冲突 |
| ⑥ | 将返回的 `Disposable` 推入 `context.subscriptions`，插件停用时自动解除监听 |

### 4.5 事件数据流

```
pi extension 调用 ctx.ui.setStatus(key, text)
  │
  ├─ Sidecar 桥接层转发为 plugin:statusSetUpdate 事件
  │
  ├─ Statusline 插件的 onPiEvent handler 收到事件
  │    └─ 解析 key、text、sessionId
  │    └─ 查找 KEY_METADATA_MAP 获取元数据
  │
  └─ 调用 api.ui.updateStatusBarItem()
       └─ RPC → Sidecar → WS → 前端 StatusBar 组件更新
```

---

## 5. 最佳实践

### 5.1 使用 Map/Object 查找表替代 if/else 链

**❌ 不推荐：**

```typescript
let priority: number
if (key === 'goal') priority = 10
else if (key === 'todo') priority = 20
else if (key === 'workflow') priority = 15
// ... 随 key 增多越来越难维护
```

**✅ 推荐：**

```typescript
const KEY_METADATA_MAP: Record<string, StatusKeyMetadata> = {
  goal:     { priority: 10, tooltip: 'Goal task progress', scope: 'per-session' },
  todo:     { priority: 20, tooltip: 'Todo list progress', scope: 'per-session' },
  // 新增 key 只需加一行
}
const meta = KEY_METADATA_MAP[key] ?? DEFAULT_METADATA
```

查找表可读性高、易扩展、O(1) 查找，且数据与逻辑分离。

### 5.2 空 text 表示清除状态

状态栏的约定：`text === ''` 代表清除该状态项。不要发送空字符串给 `updateStatusBarItem`：

```typescript
if (text === '') return  // 直接跳过，不调用 updateStatusBarItem
```

如果需要显式清除某个状态项，应设计独立的 `removeStatusBarItem` 逻辑或使用特殊标记值。

### 5.3 ID 前缀避免冲突

所有状态栏 item 的 ID 应带插件专属前缀，防止与其他插件冲突：

```typescript
// ✅ 使用 'pi-' 前缀
await api.ui.updateStatusBarItem(`pi-${key}`, text, options)

// ❌ 裸 key，可能与 todo 插件的 'goal' 冲突
await api.ui.updateStatusBarItem(key, text, options)
```

### 5.4 始终将 Disposable 推入 subscriptions

所有注册操作（hooks、tools、事件监听等）返回的 `Disposable` 都应推入 `context.subscriptions`，确保插件停用时资源被正确清理：

```typescript
// ✅ 推入 subscriptions
const disposable = await api.hooks.onPiEvent('session_start', handler)
context.subscriptions.push(disposable)

// ❌ 忘记推入 — 停用后 hook 仍然生效，可能导致错误
const disposable = await api.hooks.onPiEvent('session_start', handler)
// 忘记 push...
```

### 5.5 错误处理

插件的 `activate` 函数和所有回调应妥善处理错误，避免未捕获异常导致 Worker 崩溃：

```typescript
export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  const disposable = await api.hooks.onPiEvent(
    'plugin:statusSetUpdate',
    async (_eventName: string, data: unknown) => {
      try {
        const bridgeData = data as BridgeEventData
        // ... 业务逻辑
      } catch (err) {
        // 降级处理：记录日志，不中断其他事件处理
        console.error(`[statusline] Error handling event:`, err)
      }
    },
  )

  context.subscriptions.push(disposable)
}
```

### 5.6 类型安全

利用 TypeScript 的类型系统，定义事件 payload 的接口，避免 `as` 断言散落各处：

```typescript
// 集中定义事件数据结构
interface StatusSetUpdateData {
  sessionId: string
  key: string
  text: string
}

interface BridgeEventData {
  eventName: string
  data: StatusSetUpdateData
  sessionId: string
}

// 在 handler 中使用
const bridgeData = data as BridgeEventData
```

### 5.7 权限最小化

即使是内置 trusted 插件，也建议在 `permissions` 中声明实际需要的权限。这不仅是一种文档化手段，也为将来权限收紧时提供兼容性：

```json
{
  "permissions": ["hooks.onPiEvent"]
}
```

### 5.8 模块化组织

当插件逻辑较复杂时，将代码拆分到 `src/` 目录下，保持 `index.ts` 作为精简的入口：

```
resources/plugins/todo/
├── package.json
├── index.ts              ← 入口：调用 registerTodoTool + 监听事件
└── src/
    ├── todo-tool.ts      ← Tool 注册和执行逻辑
    ├── todo-state.ts     ← 状态恢复逻辑
    └── types.ts          ← 类型定义
```

`index.ts` 只负责组装：

```typescript
import { registerTodoTool, restoreTodoState } from './src/todo-tool.js'

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context
  await registerTodoTool(api)

  const sessionStartDisposable = await api.hooks.onPiEvent('session_start', async (_eventName, data) => {
    const sessionId = extractSessionId(data)
    if (sessionId) {
      await restoreTodoState(api, sessionId)
    }
  })
  context.subscriptions.push(sessionStartDisposable)
}
```

---

## 附录 A：PluginStateStorage 接口

```typescript
interface PluginStateStorage {
  get<T>(key: string): Promise<T | undefined>
  get<T>(key: string, defaultValue: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}
```

存储限制：单值上限 1MB，单插件总计 10MB。

## 附录 B：插件状态枚举

| 状态 | 说明 |
|------|------|
| `UNLOADED` | 未加载 |
| `LOADING` | 加载中 |
| `ACTIVATING` | 激活中 |
| `ACTIVE` | 运行中 |
| `DEACTIVATING` | 停用中 |
| `CRASHED` | 崩溃 |
| `DEPS_MISSING` | 依赖缺失 |

## 附录 C：完整 API 速查

| 模块 | 方法 | 返回 |
|------|------|------|
| `api.ui` | `updateStatusBarItem(id, text, options?)` | `Promise<void>` |
| `api.ui` | `showSelect(title, options)` | `Promise<string \| undefined>` |
| `api.ui` | `showConfirm(title, message)` | `Promise<boolean>` |
| `api.ui` | `showInput(title, defaultValue?)` | `Promise<string \| undefined>` |
| `api.ui` | `notify(level, message)` | `Promise<void>` |
| `api.hooks` | `onPiEvent(eventName, handler)` | `Promise<Disposable>` |
| `api.hooks` | `onBeforeSendMessage(handler)` | `Promise<Disposable>` |
| `api.hooks` | `onBeforeToolCall(handler)` | `Promise<Disposable>` |
| `api.hooks` | `onBeforeAgentStart(handler)` | `Promise<Disposable>` |
| `api.hooks` | `onAfterToolResult(handler)` | `Promise<Disposable>` |
| `api.tools` | `register(registration)` | `Promise<string>` |
| `api.tools` | `unregister(toolKey)` | `Promise<void>` |
| `api.sessionData` | `get(sessionId, key)` | `Promise<unknown>` |
| `api.sessionData` | `set(sessionId, key, value)` | `Promise<void>` |
| `api.sessionData` | `delete(sessionId, key)` | `Promise<void>` |
| `api.sessionData` | `keys(sessionId)` | `Promise<string[]>` |
| `api.sessions` | `list()` | `Promise<SessionInfo[]>` |
| `api.sessions` | `get(id)` | `Promise<SessionInfo \| undefined>` |
| `api.sessions` | `getActive()` | `Promise<SessionInfo \| undefined>` |
| `api.sessions` | `sendMessage(params)` | `Promise<void>` |
| `api.agent` | `setModel(model)` | `Promise<void>` |
| `api.agent` | `getModel()` | `Promise<string>` |
| `api.agent` | `setThinkingLevel(level)` | `Promise<void>` |
| `api.agent` | `getThinkingLevel()` | `Promise<string>` |
| `api.agent` | `getActiveTools()` | `Promise<string[]>` |
| `api.events` | `on(event, handler)` | `Disposable` |
| `api.events` | `emit(event, data)` | `void` |
| `api.config` | `get(key)` | `Promise<unknown>` |
| `api.config` | `getAll()` | `Promise<Record<string, unknown>>` |
| `api.config` | `set(key, value)` | `Promise<void>` |

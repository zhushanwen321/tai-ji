# xyz-agent 完整架构设计

> ⚠️ **部分被取代**：本文 §D4「Runtime 四层（transport/services/adapters/infra）」已被
> [runtime-three-layer-design.md](runtime-three-layer-design.md) 取代（Runtime 三层 + ports 依赖倒置）。
> D4 的 transport/services 部分仍有效；adapters 独立成层的设计被放弃（实证 adapters 名存实亡）。
> 其余 D1–D3、D5–D9 不受影响。

**版本**: 1.0 · **日期**: 2026-06-16 · **分支**: refactor-architecture-design
**输入**: [架构评审问题记录](history/refactor-2026-06/review-issues.md)（9 个盲点/细化点 D1–D9，2026-06 重构期记录）
**方法**: 逐点决策 → 汇总为完整架构 → 距离评估与迁移路线

---

## 阅读指引

- **第一部分**：逐个解决 D1–D9，每个点给出「问题回顾 / 可选方案 / 决策 / 理由」
- **第二部分**：完整架构（统一视图 + 分层规则 + 依赖矩阵 + 双维度模型）
- **第三部分**：现状距离评估 + 迁移路线（分阶段、低风险优先）
- **第四部分**：各进程**内部**细化设计（Renderer / Main / Runtime 的子目录、模块边界、不变量与依赖规则）

---

# 第一部分 · 设计决策（逐点解决）

## D1. 双出口通道建模（WS + IPC）

### 问题回顾
渲染进程有**两条独立出口通道**，原 6 层架构只画了 WS 一条：
```
渲染进程
  ├─ WebSocket (ws-client)  → Runtime   业务/数据（session/config/model/plugin...）
  └─ IPC (electronAPI)       → Main     系统/窗口/进程生命周期（getRuntimePort, createWindow...）
```

最关键的隐式契约是**启动时序**：渲染进程必须先经 IPC 向 Main 取 runtime 端口，才能连 WS（见 `useConnection.ts`）。

### 可选方案
| 方案 | 做法 | 问题 |
|------|------|------|
| A. 维持隐式 | 不建模，靠注释约束 | 启动时序/重连逻辑散落在 `useConnection`，无人守护 |
| B. 双通道显式建模 | 把 Main 的职责拆成 3 类，画出双通道与启动时序契约 | ✅ 推荐 |

### 决策：方案 B —— 把 Electron Main 从「thin shell」重新定义为 3 个职责明确的编排子系统

**Main 进程的 3 个真实职责**（原架构统称「Electron 壳」，掩盖了它的重量）：

| 子系统 | 职责 | 对应 IPC API |
|--------|------|-------------|
| **M1 Process Supervisor** | Runtime 子进程的 spawn/kill/端口发现/健康检查 | `getRuntimePort`、`getRuntimePortOffset`、`onRuntimePort`、`onRuntimeError` |
| **M2 Window Manager** | 原生窗口创建/聚焦/销毁 + **跨窗口注册表** | `createWindow`、`getWindows`、`focusWindow`、`findSessionWindow`、`updateWindowState`、`onWindowCreated/Closed/ListUpdated` |
| **M3 OS Gateway** | 需要 OS 特权的原语：对话框、外链、快捷键、全屏 | `pickDirectory`、`openExternal`、`openSettingsWindow`、`onShortcut`、`onFullscreenChanged` |

**通道边界规则**（决定一个能力走哪条通道）：
> 一个能力走 **IPC** 当且仅当它需要 Main 的特权访问（原生窗口/进程/OS）。其余一律走 **WS**。

**启动时序契约**（必须显式文档化、并由集成测试守护）。
> ⚠️ **订正（plan-review-round-1）**：原版写「spawn 先于 createWindow」，与代码现状相反。实际 `main.ts:142 createWindow` **先于** `:154 runtimeManager.start()`（窗口先出来，runtime 后台异步启动）。以下按代码现状写，**不改代码**：
```
1. Main 启动
2. Main 创建 BrowserWindow（渲染进程立即可见）
3. RuntimeManager spawn Runtime 子进程（后台，端口探测 BASE_PORT..+10）
4. 渲染进程启动 → useConnection.init()
5. 渲染进程注册 onRuntimePort 监听器（用于 Runtime 重启后重连）
6. 渲染进程 IPC getRuntimePort() → 取得已知端口 → connect WS(port)
7. WS 连通 → 业务就绪
8. （运行期）Runtime 重启 → Main 经 onRuntimePort 推新端口 → 渲染进程重连
```
> M1（main.ts spawn 去重，见 phase-2.5）会抽 `startAndNotify(win)`，但**不改这个先后顺序**（先窗口后 runtime 是有意的 UX 决策）。

### 理由
- 端口发现链路是「runtime 崩溃自愈」「多窗口端口隔离」「热重启」的前提，当前完全隐式，重构时是第一踩坑点。
- 把 Main 的 3 个职责命名出来后，「Electron 壳不放业务逻辑」这句口号才能落地——Window Manager 持有的窗口注册表恰恰是领域状态（见 D2）。

---

## D2. 跨进程窗口/面板状态协调

### 问题回顾
`WindowManager`（Main）与 `stores/panel.ts` + `stores/window.ts`（渲染进程）**各自维护一份** PanelTree / 窗口状态，靠 IPC 同步。原架构把它归为「壳」，回避了分布式一致性问题。

### 代码事实
- **Main**（`window-manager.ts`）持有每个窗口的 `WindowState`（含 `panelTree` + `focusedPanelId`）——这是渲染进程**推上来**的镜像缓存。
- **渲染进程**（`stores/panel.ts`）是自己窗口 PanelTree 的**唯一写入者**（不可变树替换：split/replace）。
- Main 镜像的唯一用途：跨窗口查询 `findSessionBySessionId`（只有 Main 能看到所有窗口）。

### 决策：正式确立「**单一写入者 + 读副本**」双真相源模型

| 真相源 | 归属 | 权威范围 |
|--------|------|---------|
| **窗口注册表**（windowId → 窗口、跨窗口 session 归属） | Main（M2 Window Manager） | 进程级，跨窗口 |
| **PanelTree 结构**（本窗口的分屏树、panel↔session 绑定） | 渲染进程（stores/panel.ts） | 视图级，单窗口 |

**一致性模型**：单一写入者/窗口（渲染进程） + Main 读副本（最终一致）。
- 每个窗口的树恰有一个写入者 → 树内无写冲突。
- Main 副本通过「推上去」（`syncPaneState` / `updateWindowState`）在结构变更时刷新。

**全局不变量：一个 session 全局最多绑定一个 panel。** 通过 **session 迁移协议** 守护：
```
用户请求在窗口 B 打开 session X
  → 渲染进程 B 先查 Main 镜像 findSessionWindow(X)
     ├─ 命中窗口 A → 聚焦窗口 A（不重复打开）
     └─ 未命中   → 本地绑定 + syncPaneState 推给 Main
```

### 理由
- 这是正确且最小化的模型：Main 只保留「跨窗口可见性」所需的最小投影，不持有渲染细节。
- 命名出来后，D1 的 M2 Window Manager 与本节互锁——窗口编排是跨 Main+渲染进程的**纵向关注点**，不属于任何单一层。

### 补充 · session 迁移协议的并发语义（G1 决策）

> 原设计未覆盖多窗口并发请求打开同一 session 的 race。澄清后补全。

**决策：单实例语义** —— 一个 session 全局最多绑定一个 panel，已绑定某窗口时新请求一律**聚焦跳转到原窗口**，绝不复制实例。

- 这从产品层消除了「复制实例」的可能，符合不变量「全局一个 session 最多绑一个 panel」。
- **实现要点（简化 D2）**：把 `session→window` 绑定做成 **Main 的原子 claim**（Main 单线程串行处理 IPC，天然无 race），而非现状的「本地绑定 + 推送镜像」。这反而**简化**了 D2：Main 从「被动读副本」升级为「绑定权威 + 最小投影」，职责更聚焦（与 M3「Main 不存完整 tree」一致）。
- **剩余 race**（两窗口同时首次打开同一未绑定 session）由 Main 的串行 claim 消除——绑定请求在 Main 排队处理，先到先得，后到者收到「已绑定 A 窗口」→ 聚焦跳转。

---

## D3. API Client 层核心设计（请求/响应 vs 事件驱动）⭐

### 问题回顾
原架构提「新增 api/ 协议封装」但回避了核心决策：当前协议是**事件驱动 + fire-and-forget**，`send()` 无返回值，响应经 `event-bus` 异步回来，每个调用方手写监听器。若 API Client 只是给 `send()` 包类型，价值有限（`protocol.ts` 已有类型）。

### 操作分类（决策依据）
扫描 `protocol.ts` 的 60+ 消息类型，按「响应形态」分三类：

| 类别 | 响应形态 | 举例 | 调用方写法 |
|------|---------|------|-----------|
| **请求/响应**（有单一确定响应） | 一次返回 | `session.create`→`session.created`、`config.getProviders`、`model.switch`、`file.read` | `await api.session.create()` |
| **触发即流**（响应是 push 事件序列） | 无返回，订阅流 | `message.send`→`message_start/text_delta*/complete` | `api.chat.send()` + `api.events.on('message.text_delta', …)` |
| **纯 push**（服务端发起） | 只订阅 | `context.update`、`plugin:statusChange`、`message.stream_error` | `api.events.on(...)` |

### 可选方案
| 方案 | 做法 | 评价 |
|------|------|------|
| A. 纯类型封装 | `api.session.create(p)` 内部仅 `send({type,payload})`，调用方仍自接监听 | 价值低，不解决手写监听痛点 |
| B. 全部 Promise 化 | 所有操作都返回 Promise | 违背流式语义，`message.send` 无法表达 |
| **C. 混合：命令(Promise) + 事件(可订阅)** ⭐ | 请求/响应类返回 Promise（靠 `id` 关联）；流式类返回 void + 事件可订阅 | ✅ 契合现有协议语义，收益最大 |

### 决策：方案 C —— 混合 API Client

**形态**：
```ts
// 命令：请求/响应类，返回 Promise（按 id 关联响应）
const session = await api.session.create({ cwd })
await api.config.setProvider('openai', { apiKey })
const tree = await api.tree.navigate(sid, entryId)

// 命令：触发即流类，返回 void；结果经事件订阅
api.chat.send({ sessionId, content })
api.events.on('message.text_delta', (msg) => chatStore.appendToStreaming(msg.payload.delta, msg.payload.sessionId))
api.events.on('message.complete',   (msg) => chatStore.completeStreaming(msg.payload, msg.payload.sessionId))

// 事件：纯 push
api.events.on('context.update', ...)
api.events.on('plugin:statusChange', ...)
```

**协议增强（小且向后兼容）**：`ClientMessage.id` 字段已存在但几乎没用。Runtime 在**直接响应**（非广播）消息上回填请求 `id`，API Client 用 `id` 关联 `resolve()`。广播/纯 push 不回填。

```ts
// api-client.ts 核心（示意）
const pending = new Map<string, { resolve: Function; reject: Function }>()

function command<T>(msg: ClientMessage): Promise<T> {
  const id = crypto.randomUUID()
  pending.set(id, { /* resolve/reject */ })
  ws.send({ ...msg, id })
  return promise  // 超时 30s 自动 reject
}
// event-bus 收到带 id 的 ServerMessage → 命中 pending → resolve
```

**统一外观（关键）**：API Client 是 **WS + IPC 的统一门面**，调用方不关心走哪条通道：
```ts
api.session.create(...)        // → WS
api.window.create(...)         // → IPC (electronAPI)
api.dialog.pickDirectory(...)  // → IPC
```

### 附带解决
- **D8 Mock 边界**：mock 注入在 API Client 层 `createApiClient({ ws, ipc, mock })`。mock 实现同一 `api` 接口，返回预制 Promise / emit 预制事件——mock 的是**业务语义**而非协议字节。`VITE_MOCK` 从 ws-client 下沉到 api-client。
- **D9 协议复用**：直接复用 `protocol.ts` 的 `ClientMessage`/`ServerMessage`/`ClientMessageMap` union 做 `api` 的类型签名，不重新定义协议。

### 理由
- 把「等结果」的同步心智和「流式」的异步心智分开表达，是这套协议能给出的最大人体工学改进。
- 统一门面让 D1 的双通道对组件透明——组件只见 `api.xxx`，不见 ws/ipc。

### API Client 实现细则（G3–G6 决策）

> 原设计未覆盖命令超时善后、错误流入口优先级、事件订阅生命周期、重连期 UI 收尾。澄清后补全。

**G3 · 错误流入口优先级**：`stream_error` / 命令超时等错误消息统一走 D6a 的 `chatStore.markSessionError(sid, err)` 收尾。**不**在 API Client 第 2 层丢弃——丢弃规则（D6b）只针对「session-scoped 但无 sessionId」的消息（无法路由）；有 sessionId 的错误消息正常路由到 store 分区，由 `markSessionError` 统一处理。两者职责不冲突：路由层管「去哪」，markSessionError 管「怎么收尾」。

**G4 · 命令超时善后**：`command()` 返回的 Promise 默认 **30s 超时**（可配置），超时后：
1. `reject(new ApiTimeoutError(msg))` 抛给调用方
2. 从 `pending` Map 删除该 id（防泄漏）
3. Runtime **迟到**的响应到达时 `pending` 已无该 id → 静默丢弃（不触发 resolve/reject）
- 错误类型分类：`ApiTimeoutError`（超时）/ `ApiDisconnectError`（WS 断连，pending 全 reject）/ 业务错误（Runtime 返回的 error payload）。调用方可按类型区分处理。

**G5 · 重连期 UI 收尾**：Runtime 重启 → Main 经 `onRuntimePort` 推新端口 → 渲染进程重连。重连时**不续传**中断的 streaming（runtime 进程重启意味着 pi 上下文丢失）。决策：重连成功后，对所有 `isGenerating=true` 的 session 调 `markSessionError(sid, '连接已重置')` 收尾，避免 UI 卡在「思考中」。重连失败则保留错误提示，不自动重试到死循环（退避上限后报错）。

**G6 · 事件订阅生命周期**：`api.events.on(type, handler)` 返回 `unsubscribe` 函数。**继承 CLAUDE.md #2 的 refCount 防重复注册约定**——组件多实例（split mode）下，同一 type+handler 的重复订阅用模块级 refCount 合并，避免事件处理翻倍。组件 `onUnmounted` 时调 `unsubscribe`，refCount 归零才真正移除监听。

---

## D4. Runtime 内部分层细化（infra / adapters / services）

> 🔴 **已被取代**：本节的「adapters 独立成层」设计已被 [runtime-three-layer-design.md](runtime-three-layer-design.md)（三层 + ports 依赖倒置）取代。
> 原因：实证 adapters 名存实亡（pi-config-bridge 是 re-export 杂物间）、PiXxx 类型泄漏 service、infra 反依赖 adapters。
> 详见新设计的「第一部分 · 决策」。本节保留作为历史决策记录。

### 问题回顾
原架构把 `rpc-client / process-manager / pi-config-bridge / npm-installer` 归入 `infra/`，但漏了 `event-adapter.ts`、`message-converter.ts`——它们是**防腐层**（翻译 pi 格式），不是基础设施（管连接）。

### 决策：Runtime 内部明确 4 层，把「防腐层」从 infra 独立出来

```
runtime/src/
├── transport/        # ① WS 传输 + 消息路由（只路由，无业务）
│   ├── server.ts
│   └── handlers/     # 各 *-message-handler
├── services/         # ② 业务逻辑 + bounded contexts（保持）
│   ├── session-service.ts / config-service.ts / model-service.ts / tree-service.ts / extension-service.ts
│   └── plugin-service/   # 纵向切片（见 D5）
├── adapters/         # ③ 防腐层：pi 格式 ↔ 内部格式翻译（从平铺抽出，NEW）
│   ├── event-adapter.ts          # pi RPC 事件 → ServerMessage
│   ├── message-converter.ts      # pi 历史 → Message[]
│   ├── session-tree-reader.ts    # pi JSONL → 树
│   ├── session-file-utils.ts     # pi session 文件解析
│   ├── pi-config-bridge.ts       # pi 配置路径/getConfigDir
│   ├── pi-paths.ts / pi-provider-store.ts
│   └── navigate-interceptor.ts
├── infra/            # ④ 基础设施：外部系统连接（不翻译）
│   ├── rpc-client.ts             # pi 子进程 JSON-RPC
│   ├── process-manager.ts        # pi spawn/kill
│   ├── npm-installer.ts          # npm 操作
│   ├── extension-resolver.ts     # extension 路径解析
│   └── scanner-base.ts / skill-scanner.ts / agent-scanner.ts
├── interfaces.ts     # DI 契约
└── index.ts          # 组合根（composition root）
```

**关键区分（防腐层 vs 基础设施）**：
| 层 | 关心什么 | 例子 |
|----|---------|------|
| **infra/** | 「**怎么连上**外部系统」 | rpc-client（pi 进程 RPC）、process-manager（进程生命周期）、npm-installer（npm 调用） |
| **adapters/** | 「**怎么翻译**外部系统的话」 | event-adapter（pi 事件→WS）、message-converter（pi 历史→Message） |

**依赖方向**：`transport → services → adapters → infra`。`infra` 对上层一无所知；`adapters` 依赖 `infra`（拿 rpc-client）；`services` 依赖 `adapters`（经接口）。

### 理由
- [context.md](context.md) 原始设计本就有 `pi-adapter/` 子模块意图，原 6 层架构反而退化了。
- 防腐层独立后，pi 升级只动 `adapters/` + `infra/rpc-client`，业务层零改动——「变化隔离」原则真正落地。
- 这也回答了 CLAUDE.md 规则 #5「pi 适配层不信任外部格式」：adapters/ 就是那个唯一适配点。

---

## D5. PluginService 垂直切片定位

### 问题回顾
`services/plugin-service/` 有 27 个文件，自身就是 mini 架构（同时含 transport/infra/service/adapter），原架构笼统归「Services 层 + plugins/ 子域」失真。

### 决策：架构用**双正交维度**建模

**维度 1 · 水平层**（「这是什么代码」）：transport / services / adapters / infra
**维度 2 · 纵向上下文 / bounded context**（「这是哪个领域」）：Chat/Session、Config、Model、Plugin、Extension、Window

PluginService 是一个**自包含的纵向切片**——内部有自己的四层，对外只通过 `IPluginService` 暴露。这是 **Bounded Context + Facade** 模式。

```
services/plugin-service/   # 纵向切片（bounded context）
├── plugin-service.ts      # Facade：IPluginService 唯一实现
├── api/                   # 对插件暴露的 agentAPI（contract）
├── plugin-host.ts / plugin-bootstrap.ts   # infra：Worker Thread 宿主
├── plugin-rpc-client/server/setup.ts      # transport：Worker RPC
├── plugin-sandbox.ts                      # infra：require/env 拦截
├── plugin-registry.ts / plugin-installer.ts / plugin-version-checker.ts  # service：发现/安装
├── plugin-permission.ts / -storage.ts     # service：权限
├── hook-api.ts / bridge-interop.ts / tool-api.ts  # adapter：与 pi 引擎交互
├── plugin-storage.ts / session-data-*.ts  # infra：持久化
└── plugin-types.ts                        # 内部类型
```

**规则**：纵向切片可有内部分层，但**禁止把内部模块泄漏到切片外**——只有 `IPluginService` 接口越界。这把 CLAUDE.md 规则 #11「Plugin Service 是唯一适配层」从口号变成可检查的边界。

### 理由
- 双维度模型让「27 个文件塞进一层」的困惑消失：PluginService 不是 services 层里的一坨，而是一个自带四层的独立上下文。
- 这种模型可推广：未来若 Config/Model 变复杂，同样可升级为 bounded context，而水平层规则不变。

---

## D6. 横切关注点归宿（错误流 / session 路由 / DI 循环）⭐

### 问题回顾
原架构通篇是「文件放哪」，但 CLAUDE.md 反复强调的三个关键不变量**没有归宿**：错误必须重置 isGenerating（#3）、消息必须带 sessionId（#7）、服务间解耦机制（DI 组合根如何 wire 跨服务依赖）。

> **订正（tracing-round-1）**：原版把第三点称为「DI 组合根的循环依赖」。经核对，Session↔Plugin↔Model **无编译期循环**——setter 注入是正常 DI，hook 注入是 IoC。第三点的真实问题从「打破循环」改为「明确服务间解耦机制的选择」（接口依赖 / 回调注入 / 事件总线三选其一，见 D6c）。

### 决策 6a · 错误流：不变量下沉到 Store 单一 action

**现状**（经核对订正，tracing-round-1）：不变量的**实现**已在 `chatStore` 集中——`completeStreaming`（内含 `streamingMessage=null` + `isGenerating=false`）、`setGenerating`、`setError`。composable 侧调的是这些 store 方法，并非各自重置。**真实问题**是错误路径无**单一入口**：调用方需自己组合「调哪个 store 方法」，仍可能漏（规则 #3 的根源）。

**决策**：`chatStore` 提供**唯一**错误入口 action，所有错误路径调用它：
```ts
// chat.ts
function markSessionError(sessionId: string, error: Error | string): void {
  const s = getSessionState(sessionId)
  s.isGenerating = false           // ← 不变量集中在此
  s.streamingMessage = null        // ← 不变量集中在此
  s.messages.push(toSystemNotification(error))  // 错误作为内联消息
}
```
调用方（useChat / api.events 错误订阅）只调 `chatStore.markSessionError(sid, err)`，不再各自重置。**不变量从「散落在每个 composable」收敛到「Store 一个 action」。**

### 决策 6b · session 路由：命名「Session 路由管线」并强制第 2 层丢弃

**现状**：三层隔离（chat store 分区、useChat 路由、PaneSessionView 过滤）逻辑正确但散落。

**决策**：正式化为 **Session 路由管线**（4 阶段），并把「无 sessionId 即丢弃」规则提到 API Client（第 2 层）强制执行：

```
① 传输入口    ws-client → event-bus（原始 ServerMessage）
② 全局路由    API Client：抽 payload.sessionId → 派发到 store 分区
              ⚠️ 无 sessionId 的 session-scoped 消息 → 丢弃 + dev 模式 warn
③ Store 分区  chatStore.getSessionState(sid)：per-session 状态隔离
④ 组件过滤    PaneSessionView：defense-in-depth，只响应自身 sessionId
```
API Client（D3）天然是第 2 层的家——它是所有 ingress 的必经之路，在这里强制「带 sessionId」比散在三处可靠。

### 决策 6c · 服务间解耦机制：hook 注入已是 IoC，事件总线列为可选演进

> ⚠️ **本节经代码核对订正**（见 `history/refactor-2026-06/changes/tracing-round-1.md`）。原版误诊存在「循环依赖」，实际不存在。下方为订正版。

**核对后的真实结构**（`文件:行` 证据见 tracing-round-1.md）：

- **SessionService 不依赖 PluginService / ModelService**：`session-service.ts` 的 import 列表与构造参数均不含二者。所谓「三向循环」不存在。
- **ModelService → ISessionService 是单向委托**：`model-service.ts:48` `switchModel` 委托给 `session-service.ts:328`（真正的编排者：pi RPC `setModel` + 缓存更新）。**方向与原诊断相反**——SessionService 才是 owner，ModelService 是薄委托层。
- **PluginService → ISessionService 经接口依赖**：`plugin-service.ts:85` 持有 `ISessionService`（给 agentAPI 用，如 `findActiveSession`、转发 `sendMessage`）。
- **hook 已是控制反转（IoC）**：`plugin-service.ts:197` 通过 `sessionService.setSendMessageHook(...)` 把检查逻辑**注入** SessionService；SessionService 只持有 `SendMessageHook | null` 函数引用（`session-service.ts:59`），不知其来自 PluginService。`await` 后检查 `blocked` 中止发送——**block 语义完整保留**。
- **setter 注入是正常 DI**（解决构造顺序：PluginService 先于 SessionService 实例化，故需后置 wire），非「掩盖循环」。

**决策：保持 hook 注入，事件总线降级为「可选未来演进」**

事件总线（进程内 pub-sub）本身是合理的解耦演进，但当前**无现存痛点驱动**——唯一的 hook 订阅者是 PluginService，点对点回调已足够优雅且保留同步 block 语义。引入进程内总线是真实复杂度（订阅管理、事件流难调试、与前端 event-bus 同名混淆——见 T7 自述风险），属 YAGNI。

**升级触发条件**（满足任一才引入进程内事件总线）：
1. 出现**第二个**想监听 `session.beforeSendMessage` / 会话生命周期的模块（如审计日志、限流、独立扩展系统）
2. 需要让 hook 链**可插拔**（多个 hook 串联、优先级排序）

未满足前，保持 hook 注入 + setter DI。原版「通用原则」订正为：

> 服务间通信优先**接口单向依赖**；需要解耦「调用方不知监听者存在」时用**回调注入（IoC）**（如现状的 hook）；只有当出现**多订阅者**需求时才升级为**进程内事件总线**。出现 setter 注入是构造顺序信号，**不等于**循环依赖——需先核对是否真有环。

### 理由
- 6a / 6b 两点是 bug 高发区（CLAUDE.md 用「违反必出 bug」标注）。原架构完全不碰它们，等于只画了骨架没画神经。
- 6c 订正：原版以「循环依赖」为前提推导「必须引入事件总线」，经核对前提不成立；保持 hook 注入成本最低、block 语义完整，事件总线降级为可选演进。

---

## D7. 命名债（引用既有计划）

### 决策：直接引用既有计划，不重复
- terminology.md（已删除，git 可追溯）已有 R1–R5（sidecar→runtime、Pane→Panel、SystemChatMessage→SystemNotification、Drawer→SideInspector、Overview→PanelGrid）；术语表现由 [context.md](context.md) 承载。
- 本设计新增的命名对齐：
  - `SidecarServer`（server.ts）→ `RuntimeServer`，并迁入 `transport/server.ts`
  - `server.ts` 注释 "pure Transport layer" 与实际不符 → 迁入 transport/ 后注释与实现一致
- 原则：命名债是**认知信号**，「挪目录」须同时「正注释」，否则只换皮不治本。

---

## D8. Mock 边界（已在 D3 解决）

- mock 从 `ws-client.ts`（传输层）**下沉到 API Client 层**（D3 的 `createApiClient({ mock })`）。
- mock 实现同一 `api` 接口 → mock 业务语义（`api.session.create()` 返回假数据）而非协议字节。
- `VITE_MOCK` 的检查点随之迁移。

---

## D9. 协议复用（已在 D3 解决）

- `protocol.ts` 的 `ClientMessage` / `ServerMessage` / `ClientMessageMap` union 是 API Client 类型签名的**直接来源**，不重新定义协议。
- 前端缺的不是「类型」（已有），而是「把类型用起来的调用约定」（D3 的命令/事件混合）。

---

# 第二部分 · 完整架构设计

综合 D1–D9 的决策，以下是最终架构。核心特征：**三进程 · 双通道 · 水平层 × 纵向上下文双维度 · 统一 API Client 桥接**。

## 2.1 全局架构图

```
                          ┌─────────────────────────────────────────┐
                          │           @xyz-agent/shared              │
                          │  协议类型 · 常量 · 环境白名单 · 领域类型    │
                          └──────┬──────────────────────┬───────────┘
                                 │                      │
            ┌────────────────────┘                      └─────────────────────┐
            ▼                                                                  ▼
┌── 渲染进程 (Renderer) ────────────────────┐        ┌── 主进程 (Electron Main) ──────────────┐
│                                           │        │                                         │
│  R1 UI 展示层                              │        │  M1 Process Supervisor                  │
│     components/（按功能域）design-system/   │   IPC  │     Runtime 子进程生命周期/端口/健康       │
│                                           │◄──────►│                                         │
│  R2 业务逻辑层                             │        │  M2 Window Manager                      │
│     composables/（useChat/useSession…）    │   IPC  │     原生窗口 + 跨窗口注册表（读副本）      │
│                                           │◄──────►│                                         │
│  R3 状态层                                 │        │  M3 OS Gateway                          │
│     stores/（Pinia：chat/session/panel…）   │   IPC  │     对话框/外链/快捷键/全屏              │
│                                           │◄──────►│                                         │
│  R4 API Client 层 ⭐（NEW，统一门面）        │        └─────────────────────────────────────────┘
│     api/  —— WS + IPC 统一外观              │                       ▲
│     命令(Promise) + 事件(可订阅)            │                       │ spawn / 端口探测
│     mock 注入点 · session 路由第 2 层        │                       │
│                                           │                        │
│  R5 传输层                                 │                        ▼
│     ws-client.ts（WS） event-bus.ts        │        ┌── Runtime 子进程 (Node.js) ───────────┐
│     electronAPI bridge（IPC）              │        │                                         │
└───────────────────┬───────────────────────┘        │  T1 Transport 层                         │
                    │                                  │     transport/server.ts + handlers/      │
                    │           WebSocket              │     （纯路由，不含业务）                  │
                    └─────────────────────────────────►│                                         │
                                                       │  T2 Services 层 + 纵向上下文             │
                                                       │     session/config/model/tree/extension │
                                                       │     plugin-service/（bounded context）   │
                                                       │     内部领域事件总线（解耦循环）          │
                                                       │                                         │
                                                       │  T3 Adapters 层（防腐层）                │
                                                       │     event-adapter / message-converter    │
                                                       │     pi 格式 ↔ 内部格式 翻译              │
                                                       │                                         │
                                                       │  T4 Infra 层                             │
                                                       │     rpc-client / process-manager         │
                                                       │     npm-installer / scanners             │
                                                       └─────────────────────────────────────────┘
```

## 2.2 分层规则与依赖矩阵

### 渲染进程（前端）

| 层 | 依赖方向 | 禁止 | 现状 |
|----|---------|------|------|
| R1 UI 展示层 | → R2 R3 | 不直接调 R4/R5；不用 ipcRenderer | ✅ 已合规 |
| R2 业务逻辑层 | → R3 R4 | 不碰 node: 内置模块 | ⚠️ 直调 ws-client（待迁 R4） |
| R3 状态层 | → R4（可选）| 不直接调 ws-client | ⚠️ 被 R2 直接操作（可接受） |
| R4 API Client ⭐ | → R5 + shared | 统一封装 WS+IPC；强制 session 路由 | ❌ 待新建 |
| R5 传输层 | → shared | 只管字节/IPC 调用 | ✅ 已合规 |

### 主进程（Electron Main）

| 子系统 | 职责 | 实现（重构后） | 现状 |
|--------|------|------|------|
| M1 Process Supervisor | Runtime 子进程 spawn/kill/端口/健康 | `supervisor/runtime-supervisor.ts`（Facade）+ 4 子模块 | 🔨 骨架已落地，mock 最小实现可用，完整 spawn/stop 待 B 类填充 |
| M2 Window Manager | 原生窗口 + 跨窗口注册表（读副本） | `window/window-manager.ts`（Facade）+ `window-factory` + `panel-tree-utils` | ✅ 已填充 |
| M3 OS Gateway | 对话框/外链/快捷键/全屏 | `gateway/ipc-handlers.ts`（Facade）+ `privileged-handlers` + `bridge-handlers` + `input-validators` | 🔨 骨架已落地，最小可运行 handler（runtime-port/get-windows）已注册，特权/桥接 handler 待 B 类填充 |
| M5 Shortcut Registry | 全局快捷键注册/注销 | `shortcuts/shortcut-registry.ts`（Facade） | ✅ 已填充 |

> Main 不再是「壳」。它持有窗口注册表（领域状态，D2），并编排 Runtime 生命周期（D1）。三者职责清晰、互不交叉。
>
> 重构后结构（commit `0b865fb6` 落地骨架，本次填充使 mock 模式可运行）：`main.ts`（M1 编排）→ `MainContext` 容器 + 4 个 Facade（`WindowManager`/`RuntimeSupervisor`/`ShortcutRegistry`/`registerIpcHandlers`）。旧平铺 5 文件（`runtime-manager.ts`/`window-manager.ts`/`ipc-handlers.ts`/`shortcuts.ts`/`main.ts`）已拆为按领域分层的目录。

### Runtime 子进程

| 层 | 依赖方向 | 禁止 | 现状 |
|----|---------|------|------|
| T1 Transport | → T2 | 不放业务逻辑；纯路由 | ⚠️ server.ts 注释「pure」但持 6 service（待拆 handler） |
| T2 Services | → T3 + shared；经接口 | 不碰 WebSocket；不直接依赖其他具体 service | ⚠️ service 间循环（待 6c 解耦） |
| T3 Adapters（防腐层）| → T4 | 不含业务决策；只翻译 | ❌ 与 infra 混排（待分离） |
| T4 Infra | → 外部系统 | 不知道 WS 协议与业务 | ⚠️ 与 adapters 混排 |

### 跨进程依赖铁律

1. **渲染进程 ↔ Runtime 只经 WebSocket**（业务/数据）
2. **渲染进程 ↔ Main 只经 IPC**（系统/窗口/进程）
3. **两侧只通过 `@xyz-agent/shared` 共享类型**，无运行时 import 穿透
4. **API Client（R4）是渲染进程的唯一出口**，对组件屏蔽「走 WS 还是 IPC」

## 2.3 双维度模型（水平层 × 纵向上下文）

架构同时由两个正交维度组织：

```
                      纵向上下文（领域，按业务域切）
                          Session  Config  Model  Plugin  Extension  Window
                       ┌────────┬───────┬──────┬────────┬──────────┬───────┐
            transport  │   ●    │   ●   │  ●   │   ●    │    ●     │   ─   │  水平层
            services   │   ●    │   ●   │  ●   │   ●    │    ●     │   ─   │  （代码性质）
            adapters   │   ●    │   ─   │  ─   │   ●    │    ●     │   ─   │
            infra      │   ●    │   ─   │  ─   │   ●    │    ●     │   ─   │
                       └────────┴───────┴──────┴────────┴──────────┴───────┘
```

- **水平层**回答「这是什么代码」（transport/services/adapters/infra）
- **纵向上下文**回答「这是哪个领域」（Session/Config/Model/Plugin/Extension/Window）
- 多数上下文（Session/Config/Model）当前只占 services 一格，是「轻量上下文」
- **Plugin 是完整纵向切片**（D5）：四层全占、自包含、只经 `IPluginService` 越界
- 未来任何上下文变复杂，都可「升级」为完整切片，水平层规则不变

## 2.4 关键横切机制（D6 落地）

| 机制 | 位置 | 作用 |
|------|------|------|
| 错误不变量 | `chatStore.markSessionError(sid, err)` | isGenerating/streamingMessage 重置集中一处（规则 #3） |
| Session 路由管线 | API Client 第 2 层强制 | 无 sessionId 的 session-scoped 消息丢弃 + dev warn（规则 #7） |
| 领域事件总线（可选） | Runtime 进程内（仅 D6c 触发时） | 多订阅者解耦；现状 hook 注入已够，未引入 |
| 组合根 | `runtime/src/index.ts` | 手动 DI（保留，3-Phase 线性构造）；hook 注入保留 |

---

# 第三部分 · 现状距离评估与迁移路线

## 3.1 距离评估（按改动量）

| 差距项 | 对应决策 | 严重度 | 改动量 | 收益 |
|--------|---------|--------|--------|------|
| 前端缺 API Client 层 | D3 | 🔴 高 | 中（新建 api/ + 迁 7 composable 的 send 调用） | 协议变更不再散改；mock 业务化 |
| Runtime 文件平铺、adapters 未分离 | D4 | 🟡 中 | 中（git mv，机械重构） | pi 升级隔离；认知清晰 |
| ~~service 循环依赖（setter 掩盖）~~ | ~~D6c~~ | ✅ 经核对不存在 | — | — （见订正说明） |
| 错误流无单一入口 | D6a | 🟡 中 | 小（Store 加 `markSessionError` action） | 规则 #3 不再复发 |
| session 路由第 2 层未强制 | D6b | 🟢 低 | 小（API Client 内加丢弃规则） | 规则 #7 可检查 |
| 双通道/启动时序未文档化 | D1 | 🟢 低 | 小（文档 + 集成测试） | 重连/热重启可扩展 |
| 命名债（SidecarServer 等） | D7 | 🟢 低 | 小（引用既有 R1–R5） | 消除认知债 |
| 窗口双真相源未命名 | D2 | 🟢 低 | 小（文档化） | 迁移 session 协议明确 |
| PluginService 定位 | D5 | 🟢 低 | 无（仅建模认知） | 不再误判为「一坨」 |

**总体判断**：架构**逻辑骨架正确**（依赖方向无穿透、interfaces.ts/handler 分离已就位）。主要差距是**目录未表达分层** + **前端缺 API Client** + **错误流无单一入口**。三者均可分阶段、低风险推进。

> **D6c 订正说明**：原版称「service 循环依赖（setter 掩盖）」为🟡中等差距。经代码核对（tracing-round-1）证明：Session↔Plugin↔Model 无编译期循环，hook 注入已是 IoC，setter 是正常 DI。此差距项**不存在**，已从迁移计划移除。事件总线降级为「可选未来演进」（见 D6c 升级触发条件）。

## 3.2 迁移路线（分阶段，低风险优先）

> ⚠️ **阶段 0–2 已落地（2026-06）**：前端 API Client（`renderer/src/api/`）、Runtime 三层目录分层（`transport/services/infra`）、`SidecarServer → RuntimeServer` 迁入 `transport/server.ts` 均已完成。详见 [runtime-three-layer-design.md](runtime-three-layer-design.md)（已落地快照）与 runtime-migration-progress.md（R0–R9 执行记录，已删除，git 可追溯）。以下路线保留作决策记录，阶段标注见各条。阶段 3+ 未完成项以本路线为准。

```
阶段 0 · 文档与认知（0 代码风险）
  ├─ 本设计文档 + 问题记录 已完成
  └─ 双通道/启动时序/窗口双真相源 写入 CLAUDE.md 架构章节

阶段 1 · 前端 API Client 层（最高收益，独立可验证）
  ├─ 新建 renderer/src/api/，实现 command(Promise)+event(订阅) 混合
  ├─ 复用 protocol.ts union 做 typing
  ├─ Runtime 直接响应消息回填 id（向后兼容）
  ├─ 8 个 composable 的 ws-client send 调用 → 迁到 api.xxx
  ├─ chatStore.markSessionError 落地（D6a）
  └─ VITE_MOCK 下沉到 api 层（D8）
  验证：pnpm run dev 全功能 + mock 模式可跑

阶段 2 · Runtime 目录分层（机械重构，低风险）
  ├─ git mv：transport/ · adapters/ · infra/ 分离（D4）
  ├─ SidecarServer → RuntimeServer，迁 transport/server.ts（D7）
  └─ 修正 server.ts「pure Transport」注释
  验证：pnpm run build + validate-runtime-bundle.sh
  ⚠️ 目录迁移后 import 链需顺畅（见 CLAUDE.md #12）。**tsup 配置本身零改动**（bundle 模式，entry 不含被迁移的 server.ts 等——详见 §3.3 铁律 #2）

阶段 3 · 拆 session-service 巨石（中等风险，需测试）
  ├─ 拆 session-service.ts（722 行）为 session-lifecycle / message-dispatcher / session-scanner（T2）
  ├─ message-dispatcher 统一 sendMessage/sendSubagentMessage 为 sendPrompt
  └─ （D6c 订正：不引入事件总线、不动 switchModel——无循环可解。事件总线降为可选演进）
  验证：vitest + 手测 sendMessage/abort/switchModel 流程

阶段 4 · 命名对齐（引用既有计划）
  └─ 执行 terminology.md 的 R1–R5

阶段 5 · 防护加固（可选）
  ├─ session 路由第 2 层「无 sessionId 丢弃」+ dev warn（D6b）
  ├─ 启动时序契约的集成测试（D1）
  └─ pre-commit：禁止 composable 直 import ws-client（阶段 1 后）
```

## 3.3 迁移铁律（避免重蹈覆辙）

1. **每阶段独立 commit、独立验证**——禁止一次性大重构（CLAUDE.md #12 的教训）
2. **阶段 2 目录迁移不涉及 tsup 配置改动**——runtime 用 `bundle: true` 模式，仅 2 个 entry（`index` + `plugin-bootstrap`），server.ts/handlers/adapters/infra 都经 `index.ts` import 链打包进 `index.cjs`，非独立 entry。目录 mv 后 import 路径自动跟随，**entry/noExternal/asarUnpack 零改动**。（plan-review-round-3 订正：原「必须同步 tsup entry」误读了 CLAUDE.md #12——#12 原文是「noExternal 覆盖所有 dependencies（新增依赖才追加）」「plugin-bootstrap 独立打包（已在 entry）」，未要求目录迁移改 entry。）
3. **阶段 1 API Client 不破坏现有事件流**——先并存（api + 直 send），逐个 composable 迁移，灰度替换
4. **阶段 3 拆 session-service 前先写 vitest**——覆盖 sendMessage（含 hook 拦截）、switchModel、abort 三条路径
5. **命名变更用 `git mv`**——保留历史追踪
6. **回滚策略（G7）**——每阶段是独立 commit，出问题用 `git revert <commit>` 回退单阶段。各阶段间无强耦合（阶段 1 的 API Client 可独立上线，不依赖阶段 2/3）；阶段 2 目录迁移若与 tsup 联动出问题，单独 revert 该 commit + 还原 tsup。禁止跨阶段部分回滚（如只 revert 阶段 1 的一半 composable 迁移，会造成 api/直 send 混用的中间态）。

---

# 附录 · 决策索引

| 决策 | 主题 | 优先级 |
|------|------|--------|
| D1 | 双出口通道（WS+IPC）建模 + 启动时序契约 | 阶段 0 |
| D2 | 窗口/面板双真相源（单写者+读副本）+ session 迁移协议 | 阶段 0 |
| D3 | API Client：命令(Promise)+事件(订阅)混合 + 统一门面 ⭐ | 阶段 1 |
| D4 | Runtime 四层：transport/services/adapters/infra（防腐层独立） | 阶段 2 |
| D5 | 双维度模型：水平层 × 纵向上下文（Plugin 为完整切片） | 阶段 0 |
| D6 | 横切：错误不变量下沉 + session 路由管线 + 服务解耦机制 | 6a/6b 阶段1，6c 已订正（见 D6c） |
| D7 | 命名债（引用 terminology.md R1–R5，已删除，git 可追溯；术语现见 [context.md](context.md)） | 阶段 4 |
| D8 | Mock 下沉到 API Client 层 | 阶段 1 |
| D9 | 复用 protocol.ts union | 阶段 1 |

---

**一句话总结**：原 6 层架构的**骨架正确**，但只画了「文件该放哪」的骨架。本设计补全了三件事——**双通道与跨进程状态的显式建模**（D1/D2）、**API Client 的命令/事件混合决策**（D3）、**横切不变量与服务解耦机制**（D6，经核对订正：hook 注入已是 IoC，事件总线降为可选演进）——并把架构升级为**水平层 × 纵向上下文的双维度模型**（D5），使 PluginService 等「重型领域」能自洽归位。

---

# 第四部分 · 各进程内部细化设计

前三部分定义了三进程的边界与职责。本部分深入每个进程**内部**，按「现状 → 细化点 → 目标内部结构」逐一拆解，把抽象的「层」落实到具体的子目录、模块边界、不变量与依赖规则。

## 4.0 细化原则

每个进程的内部细化遵循三条原则：

1. **按关注点分离，而非按文件类型** —— `components/` `composables/` `stores/` 是文件类型，不是关注点。子目录要按「领域」（session / config / panel / plugin）而非「技术」切。
2. **单向数据流要可画出** —— 每个进程内部的数据流向必须能用一张图表达清楚，且无环（环=隐藏的耦合）。
3. **内部模块只暴露 Facade** —— 一个模块对外只暴露一个入口类型（store 的 return 对象、service 的 interface），内部 helper 不外泄。

---

## 4.1 Renderer 进程内部细化

### 现状（5 个平级目录）

```
renderer/src/
├── components/   (10 个域，86 个 .vue)  — 按域分了（chat 33 / settings 20 / panel 9…），但与 stores/composables 关系不清
├── composables/  (19 个)               — 业务逻辑，但职责混杂（有的调 store，有的调 ws-client，有的只算纯函数）
├── stores/       (11 个 Pinia store)   — 状态层，但 store 之间互相 import
├── lib/          (10 个工具)           — 混杂：传输(ws-client)、事件(event-bus)、纯函数(markdown)、工具(clipboard)
├── design-system/ mock/ i18n/ types/
```

### 细化点 R1–R5

#### R1 · 组件层（UI 展示）—— 已按域分，但需明确「展示组件」与「容器组件」边界

**现状**（经核对订正）：10 个域目录（chat 33、settings 20、panel 9…），但组件直接读 store、直接发 ws 消息的情况存在。

**细化规则**：
- **展示组件**（presentational）：只接 props + emit 事件，**不依赖任何 store / api**。可复用、可测试。例：单个 `MessageBubble.vue`、`ModelPicker.vue`。
- **容器组件**（container）：注入 store + composable，向下传 props。例：`ChatPanel.vue`、`SessionList.vue`。
- **命名约定**：容器组件文件名无前缀（`ChatPanel.vue`），展示组件加 `Base`/`The` 前缀或在 `components/ui/` 下（`BaseButton.vue`）。
- **design-system/** 是**跨域展示组件库**（与具体业务无关的 UI 原子），组件层**禁止反向依赖 design-system 之外的业务代码**。

#### R2 · Composables 层 —— 需区分「业务编排」「副作用胶水」「纯逻辑」

**现状**：19 个 composable 混在一起。实测职责分三类：
- **业务编排**：`useChat`（发消息+订阅流）、`useSession`（生命周期）、`useModel`、`useProvider`、`useTree`、`usePlugin` —— 这些**调 api + 操作 store**
- **副作用胶水**：`useConnection`（WS 连接管理）、`useChatScroll`（滚动跟随）、`useLiveTimer`（计时）
- **纯逻辑**（本不该是 composable）：`useBatchSelect`、`useMarkdownRender`、`useProviderValidation`、`useSlashCommands`

**细化规则**：分三个子类，目录体现：
```
composables/
├── features/      # 业务编排：调 api.* + 操作 store（useChat, useSession, useModel...）
├── effects/       # 副作用胶水：连接、滚动、计时、生命周期订阅（useConnection, useChatScroll）
└── logic/         # 纯逻辑：无响应式依赖的应改为 lib/ 下的纯函数（useProviderValidation → lib/validation.ts）
```
**铁律**：`features/*` 是 **唯一**允许同时 import `api/` 和 `stores/` 的层。`effects/*` 只 import `api/`（传输层），不碰 store。`logic/` 两者都不碰。

#### R3 · Stores 层 —— 需收敛 store 间互相 import + 明确「会话状态分区」

**现状**：11 个 store，存在跨 store 引用（`useSession` import `useChatStore`/`useTreeStore`）。chat store 用 `Map<sessionId, ChatSessionState>` 做了 per-session 分区（✅ 正确，对应规则 #7），但 session 状态散落在多个 store。

**细化规则**：
- **Store 间禁止直接互相 import**。跨 store 协调由 `composables/features/` 做（它同时持有两个 store 的引用）。store 只管自己的状态切片。
- **会话状态按职责明确唯一源**：
  - `session.ts` = session **列表与元数据**的唯一源
  - `chat.ts` = per-session **消息流与生成状态**的唯一源
  - `tree.ts` = per-session **任务树**的唯一源
  - 三者以 `sessionId` 关联，不交叉存储。
- **每个 store 对外只暴露 return 对象**（Pinia setup store 惯例），内部 helper 函数不导出。

#### R4 · API Client 层（D3 已定）—— 细化内部结构

```
api/
├── index.ts            # createApiClient({ ws, ipc, mock }) → 统一 api 对象
├── transport.ts        # 底层：ws send/recv 包装 + ipc invoke 包装，抹平两通道差异
├── pending.ts          # 命令的 id→Promise 关联表（D3 的 command 实现）
├── events.ts           # 事件订阅：on(type, handler)，背后是 event-bus
├── domains/            # 按领域拆分的 typed 方法
│   ├── session.ts      # api.session.create/list/switch/delete...（命令型，返回 Promise）
│   ├── chat.ts         # api.chat.send/abort/steer（触发即流型）
│   ├── config.ts       # api.config.getProviders/setSkill...
│   ├── model.ts / tree.ts / extension.ts / plugin.ts
│   └── system.ts       # api.window.* / api.dialog.* / api.shortcut.*（走 IPC）
└── mock/               # 同接口的假实现，VITE_MOCK 时注入
```
**依赖方向**：`domains/* → transport.ts + events.ts → ws-client/event-bus/electronAPI`。`index.ts` 是组合根。
**这是 D6b「session 路由第 2 层」的家**：所有 ingress 在 `events.ts` 收口，无 `sessionId` 的 session-scoped 消息在此丢弃。

#### R5 · 传输层 —— 需明确两个子模块的职责边界

**现状**：`lib/ws-client.ts`（WS）+ `lib/event-bus.ts`（事件分发）+ preload 暴露的 `window.electronAPI`（IPC）。

**细化规则**：传输层是**纯管道**，不含任何业务语义：
- `ws-client.ts`：连接管理、重连退避、心跳、消息收发（字节级）。**不解析 payload 语义**。
- `event-bus.ts`：按 `msg.type` 分发到 handler。**不关心 payload 内容**。
- `electronAPI`（preload 注入）：IPC 调用代理。**不组合多个 IPC**（组合是 `api/domains/system.ts` 的事）。
- 业务语义（如「session.created 后要刷新列表」）**禁止**出现在传输层，应在 `composables/features/` 订阅。

### Renderer 内部依赖图（目标）

```
main.ts / App.vue
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│ components/ (展示) ──props──► 容器组件 ──► composables/features/ ──► stores/ ──► (无下游)
│ design-system/                          │                      │
│                                         ▼                      ▼
│                                 composables/effects/ ──► api/domains/ ──► api/transport+events
│                                                                │                    │
│                                                                └► api/system.ts ───┤
│                                                                                     ▼
│                                                  lib/ws-client · event-bus · electronAPI
└──────────────────────────────────────────────────────────────┘
   规则：features 唯一同时碰 api+store；store 不互 import；传输层无业务语义
```

---

## 4.2 Main 进程内部细化

### 现状（已重构为 M1–M5 分层骨架）

重构前是 5 个平铺文件（`main.ts`/`window-manager.ts`/`runtime-manager.ts`/`ipc-handlers.ts`/`shortcuts.ts`），commit `0b865fb6` 拆为按领域分层：

```
main/
├── main.ts              M1 应用入口（纯编排：构造 MainContext + 串联生命周期）
├── interfaces.ts        ⭐类型契约源（4 Facade 接口 + MainContext + IpcHandlerDeps）
├── context.ts           MainContext 容器（聚合 3 Facade + mainWindow/settingsWindow）
├── window/              M2 窗口管理
│   ├── window-manager.ts     Facade（窗口注册表 + 跨窗口 session 查询）
│   ├── window-factory.ts     BrowserWindow 创建（含 dev waitForVite）
│   └── panel-tree-utils.ts   PanelTree 纯函数（findPanelBySessionId / initialWindowState）
├── supervisor/          M3 Runtime 子进程监管
│   ├── runtime-supervisor.ts Facade（编排 start/stop 时序，持有 child/port 状态）
│   ├── port-discoverer.ts    端口探测 + stale 进程清理
│   ├── process-control.ts    spawn / kill 进程树（含 stop 时序图）
│   ├── health-checker.ts     TCP 健康检查
│   ├── port-file.ts          端口文件持久化
│   └── safe-env.ts           最小权限环境变量
├── gateway/             M4 OS Gateway
│   ├── ipc-handlers.ts       Facade（编排 privileged + bridge 注册）
│   ├── privileged-handlers.ts 特权 handler（pickDirectory/openExternal/openSettingsWindow）
│   ├── bridge-handlers.ts    桥接 handler（runtime port / 窗口系列）+ broadcastWindowList
│   └── input-validators.ts   输入校验纯函数（isValidExternalUrl / isPathInAllowedPrefixes）
└── shortcuts/           M5 快捷键
    └── shortcut-registry.ts  Facade（registerGlobal / unregisterAll）
```

> 命名变更：`runtime/` 子目录 → `supervisor/`（避免和顶层 `packages/runtime/` 撞名）；类名 `RuntimeManager` → `RuntimeSupervisor`。
>
> 填充进度：M2（window 全部）+ M5（shortcut）+ M1（main 编排）+ 最小可运行 handler 已完成，`pnpm run dev:mock` 可启动 mock 模式。M3 supervisor 子模块 + M4 特权/桥接 handler 保留 `throw` 骨架，待 B 类填充。

### 细化点 M1–M5

#### M1 · 应用生命周期编排（main.ts）—— 需明确「编排脚本」定位

**现状**：`main.ts` 直接写了 `app.whenReady`、`window-all-closed`、`activate`、`before-quit` 的处理，且 runtime 启动/端口通知逻辑在两个分支（whenReady + activate）里**重复**。

**细化规则**：`main.ts` 是**纯编排脚本**，只做：① 注册子系统 ② 串联生命周期事件。具体能力委托给 M2/M3/M4。重复的「spawn runtime + 通知端口」抽成 `runtimeManager.startAndNotify(win)` 一个方法，消除 whenReady/activate 两处重复。

#### M2 · Process Supervisor（runtime-manager.ts）—— 需明确 4 个子职责

> **已落地（2026-06）**：本节细化规则已实现为 `main/supervisor/` 子系统——`runtime-supervisor.ts`（编排）+ `port-discoverer.ts`（端口探测）+ `health-checker.ts`（健康检查）+ `process-control.ts`（进程 spawn/kill）+ `port-file.ts`（端口持久化）+ `safe-env.ts`。4 个子职责已物理拆分为独立模块，不再揉在一个类。以下「现状」描述为重构前状态，保留作决策记录。

**现状**：runtime-manager.ts 把 4 件事揉在一个类：端口探测、进程 spawn/kill、健康检查、端口文件读写。

**细化规则**：逻辑上分 4 个子职责（可仍在一个文件，但方法边界清晰）：

| 子职责 | 方法 | 不变量 |
|--------|------|--------|
| 端口探测 | `discoverFreePort()` | 返回 BASE_PORT..+10 内首个空闲端口；被占则 kill stale（白名单进程名） |
| 进程生命周期 | `start()` / `stop()` | 用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 启动；stop 先 SIGTERM 等 200ms 再 SIGKILL |
| 健康检查 | `waitForHealth(port)` | TCP socket 连接检测（`isPortInUse`，30 次 × 200ms），超时则启动失败。注：runtime 进程暴露了 `/health` 端点（`server.ts`），但 RuntimeManager 未调用它 |
| 端口持久化 | `writePortFile()` / `getPortOffset()` | 写 `~/.xyz-agent/runtime.port`，供多实例/dev 偏移用 |

**关键不变量（必须守护）**：`start()` 是**幂等**的 —— 已有活进程则复用，不重复 spawn。这决定了「Runtime 崩溃后能否被 Main 自动重启」。

#### M3 · Window Manager（window-manager.ts）—— 需明确「权威 vs 副本」边界（呼应 D2）

**现状**：`WindowManager` 持有每个窗口的完整 `WindowState`（含 `panelTree` + `focusedPanelId` + `sessionIds`），但**这是 Renderer 推上来的副本**（D2 已分析）。

**细化规则**：
- Main 只保留**跨窗口查询所需的最小投影**：`windowId`、`focusedPanelId`、`sessionIds[]`。**完整 PanelTree 结构是 Renderer 的权威**，Main 不应解析其内部（当前代码却存了，是过度同步）。
- Main 的唯一跨窗口查询是 `findSessionBySessionId`（用于「session 迁移协议」）。**建议**：Main 只存 `sessionIds: Set<string>`，不再存整棵 tree —— 减少同步面、消除「Main/Renderer 树结构不一致」的可能。
- 递归遍历加深度上限（已有 `MAX_PANE_DEPTH=16`）防畸形 payload。✅ 保留。

#### M4 · OS Gateway（ipc-handlers.ts）—— 需按「是否触碰特权」分类 handler

**现状**：8+ 个 IPC handler 混在一个函数 `registerIpcHandlers` 里。

**细化规则**：handler 分两类，便于审计：
- **特权 handler**（需 OS 能力）：`pickDirectory`（原生对话框）、`openExternal`（外链）、`openSettingsWindow`（创建窗口）—— 每个**单独做输入校验**（如 `openExternal` 已校验 http/https 协议 ✅，其他也要补）。
- **桥接 handler**（纯转发）：`getRuntimePort`、`getWindows`、`findSessionWindow` —— 无副作用，只读 Main 内部状态。

#### M5 · 全局快捷键（shortcuts.ts）—— 需明确注册时机与窗口作用域

**现状**：`registerShortcuts(mainWindow)` 在窗口创建时注册，`window-all-closed`/`before-quit` 时注销。

**细化规则**：全局快捷键（`globalShortcut`）vs 窗口快捷键（`accelerator`）要区分：全局的（如唤起 app）注册一次且不绑窗口；窗口内的（如切换 panel）随窗口生灭。当前代码在 activate 时重新注册，需确认无重复注册（`globalShortcut.register` 对已占用的组合会静默失败）。

### Main 内部依赖图（目标）

```
main.ts (M1 编排：构造 MainContext + 串联生命周期)
   ├──► WindowManager          [M2 Window Manager]  window/window-manager.ts
   │       ├─► window-factory.ts     (BrowserWindow 创建 + dev waitForVite)
   │       └─► panel-tree-utils.ts   (findPanelBySessionId / initialWindowState)
   ├──► RuntimeSupervisor      [M3 Process Supervisor]  supervisor/runtime-supervisor.ts
   │       ├─► port-discoverer.ts    (端口探测 + stale kill)
   │       ├─► process-control.ts    (spawn / kill 进程树)
   │       ├─► health-checker.ts     (TCP 健康检查)
   │       └─► port-file.ts          (端口文件持久化)
   ├──► registerIpcHandlers    [M4 OS Gateway]  gateway/ipc-handlers.ts
   │       ├─► privileged-handlers.ts (校验输入 → OS API：对话框/外链/设置窗)
   │       └─► bridge-handlers.ts     (读 M2/M3 状态 + broadcastWindowList)
   └──► ShortcutRegistry       [M5 快捷键]  shortcuts/shortcut-registry.ts
   规则：main.ts 纯编排无能力；子职责单一；M3 不存完整 tree（只保留跨窗口查询投影）
   依赖注入：gateway 经 interfaces.ts 的 IpcHandlerDeps 注入，不反向引用 Facade 具体类
```

---

## 4.3 Runtime 进程内部细化

### 现状（T1–T4 已定，但内部模块边界未落到具体）

```
runtime/src/
├── server.ts (Transport，但持 6 service + 6 handler，注释「pure」失真)
├── services/ (5 service + plugin-service/ 纵向切片 27 文件)
├── 30+ 平铺文件 (adapters/infra 混排)
├── interfaces.ts (DI 契约)
└── index.ts (组合根，3-Phase 线性构造 + setter DI)
```

### 细化点 T1–T7

#### T1 · Transport 层（server.ts + handlers/）—— 需把「路由」与「handler」边界划清

**现状**：`server.ts` 的 `handleMessage` 是一个大 switch（~50 case），按 `msg.type` 分发到 6 个 handler；但 server 自己还持有 6 个 service 引用 + 做广播（`broadcast`）。

**细化规则**：
- **server.ts = 纯路由 + 连接管理 + 广播**。路由表（type → handler）应**可声明式配置**（一张 map），而非 switch。这让「新增一个消息类型」只改一行映射，不动路由逻辑。
- **handler 只做「参数提取 + 调 service + 组装响应」**，不含业务决策。当前的 `SessionMessageHandler` 符合（只调 `sessionService.*`），保持。
- **server 不直接持有 service 具体类**，只持有 handler 实例（handler 持有 service）。这解耦「传输」与「业务」。

#### T2 · Services 层 —— 需拆解 `session-service.ts`（722 行，职责过重）⭐

**现状**：`session-service.ts` 一个文件揉了 5 类职责（实测方法清单）：

| 职责 | 方法（举例） | 问题 |
|------|-------------|------|
| Session 生命周期 | create/delete/rename/restore/rebind | 核心 |
| 消息发送 | sendMessage/sendSubagent/steer/followUp/abort | 与「发送」编排耦合 |
| 进程绑定 | ensureActive/getRpcClient/hasActive/initializeManaged | pi 进程 attach 逻辑 |
| 持久化扫描 | listPersistedSessions/listGrouped/listAll/pruneGitCache | 磁盘扫描 |
| 路径注入 | getSkillPaths/getExtensionPaths/getAgentDir | 配置组装 |

**细化规则**：拆成 3 个协作模块（仍是 `ISessionService` 门面，内部组合）：
```
services/session/
├── session-service.ts     # Facade，实现 ISessionService，委托给下面
├── session-lifecycle.ts   # create/delete/rename/restore/rebind（生命周期）
├── message-dispatcher.ts  # sendMessage/abort/steer/followUp（发送编排，含 hook）
└── session-scanner.ts     # listPersistedSessions/listGrouped（磁盘扫描，含 git 缓存）
```
**收益**：722 行拆成 3 个 ~200 行文件；`sendMessage` 和 `sendSubagentMessage` 的重复代码（review 已指出）在 `message-dispatcher` 里统一为一个 `sendPrompt(content, hookContent?)`。

#### T3 · Adapters 层（防腐层，D4 已定）—— 需明确「翻译表」可维护性

**现状**：`event-adapter.ts`（~480 行）用一堆 `handleXxx(event, ctx)` 函数把 pi 事件翻译成 ServerMessage。

**细化规则**：
- 翻译逻辑应组织成**事件类型 → handler 的映射表**（声明式），而非散落的 if/switch。新增一个 pi 事件类型 = 加一行映射 + 一个纯函数。
- **防腐层铁律**：`adapters/` 是 pi 格式进入内部系统的**唯一入口**。任何业务代码若发现自己在 `if (event.type === 'pi_xxx')`，说明它漏过了防腐层，应挪到 `adapters/`。
- `message-converter.ts`（pi 历史 → Message[]）同理：纯函数，可单测，不依赖运行时状态。

#### T4 · Infra 层（D4 已定）—— 需明确「外部系统连接」边界

**现状**：rpc-client（pi RPC）、process-manager（pi spawn）、npm-installer、scanners。

**细化规则**：infra 的每个模块是**一个外部系统的连接器**：
- `rpc-client.ts`：pi JSON-RPC 协议封装（prompt/abort/getHistory...）。**唯一**直接和 pi 进程 stdin/stdout 打交道的模块。
- `process-manager.ts`：pi 进程池（createSession/destroySession/lookup）。**唯一**spawn pi 子进程的模块。
- `npm-installer.ts`：npm CLI 调用。**唯一**执行 `npm install` 的模块。
- **铁律**：infra 模块不知道「session」「config」等业务概念，只暴露通用的「连/发/收/spawn」能力。业务语义由 adapters/services 赋予。

#### T5 · PluginService 纵向切片（D5 已定）—— 需明确 Facade 边界

**现状**：27 文件，自带 api/host/rpc/sandbox/registry/permission/hook/storage。

**细化规则**：
- 对外**只暴露 `IPluginService` + `index.ts` 的具名导出**。切片内任何模块被切片外代码 import = 边界违规。
- 内部遵循同样的水平层（api=contract、host/rpc=transport、sandbox/registry/storage=infra、hook=adapter），但**这是切片自治**，不强制与全局 runtime 层目录对齐。
- 横切插件（如权限 `plugin-permission.ts`）可被切片内任意模块调，但不越过 Facade。

#### T6 · 组合根（index.ts）—— 现状已是线性，事件总线为可选演进（呼应 D6c）

> 订正（tracing-round-1）：原版称「3-Phase 构造掩盖 Session↔Plugin↔Model 循环」，经核对**无编译期循环**，setter 是正常 DI。

**现状**（核对后）：`index.ts` 的 3-Phase 构造是**按依赖顺序的线性构造**——Phase 1 创建无依赖实例，Phase 2 创建有依赖的，Phase 3 wire 跨服务引用（如 `pluginService.setSessionService(...)`，因 PluginService 先于 SessionService 实例化）。这本身正确，非「掩盖」。

**细化规则**：
- **保持**现有 3-Phase 构造 + setter 注入（正常 DI）。hook 注入（`setSendMessageHook`）亦保持现状——SessionService 不持有 PluginService 引用，只持有函数。
- **事件总线降级**：仅当 D6c 升级触发条件满足（出现第二个 hook 订阅者）时，才在 `infra/` 引入进程内事件总线；届时必须遵守 T7 的命名区分。
- 本阶段（拆 session-service，T2）**不动** index.ts 组合根结构与 switchModel 归属（现状正确：SessionService 编排，ModelService 薄委托）。

#### T7 · 内部事件总线 vs 前端 event-bus —— 仅当引入事件总线时适用（D6c 订正后为条件性条目） ⚠️

> 订正（tracing-round-1）：D6c 事件总线降级为可选演进后，本条目从「必须区分」降为「若引入则须注意」。

**易混淆点**：前端有 `lib/event-bus.ts`（Renderer 内 WS 事件分发）。若 Runtime 引入进程内事件总线，两者同名但**完全不同**：
- **前端 event-bus**（`renderer/src/lib/event-bus.ts`）：分发 **WebSocket ServerMessage**，按 `msg.type` 路由到 UI。是「网络消息 → UI」。
- **Runtime 内部事件总线**（**仅在 D6c 触发条件满足时新增**）：分发 **进程内领域事件**（如 `session.beforeSendMessage`），用于解耦多订阅者。是「service → service」。

**若引入**：两者绝不共享类型，文档/命名上明确区分（建议 runtime 的叫 `domainEvents` 或 `internalBus`）。未引入前不创建空模块。

### Runtime 内部依赖图（目标）

```
index.ts (组合根，线性构造)
   │
   ▼
┌─ infra/ ────────────────────────────────────────────┐
│  rpc-client · process-manager · npm-installer       │
│  scanners · (事件总线仅 D6c 触发时新增)               │
└───────┬─────────────────────────────────────────────┘
        ▼
┌─ adapters/ (防腐层) ────────────────────────────────┐
│  event-adapter · message-converter · session-tree-reader │
│  pi-config-bridge · navigate-interceptor            │  ← pi 格式唯一入口
└───────┬─────────────────────────────────────────────┘
        ▼
┌─ services/ (业务) ──────────────────────────────────┐
│  session/(lifecycle+dispatcher+scanner) · config/   │
│  model · tree · extension                            │
│  plugin-service/ (纵向切片，Facade=IPluginService)   │
│    Plugin→ISessionService 经接口 + hook 回调注入（T6 订正后保持）│
└───────┬─────────────────────────────────────────────┘
        ▼
┌─ transport/ ────────────────────────────────────────┐
│  server.ts (纯路由+广播) + handlers/ (参数→service→响应) │
└─────────────────────────────────────────────────────┘
   规则：单向 infra→adapters→services→transport；无循环；adapters 是 pi 唯一入口
```

---

## 4.4 三进程内部细化的优先级汇总

| 细化点 | 所在进程 | 价值 | 风险 | 建议阶段 |
|--------|---------|------|------|---------|
| R4 API Client 内部结构 | Renderer | 高 | 低 | 阶段 1 |
| R2 composables 三分 | Renderer | 中 | 低 | 阶段 1（随 API Client） |
| R3 store 不互 import | Renderer | 中 | 低 | 阶段 1 |
| R1 展示/容器组件边界 | Renderer | 中 | 低 | 阶段 2 |
| M2 runtime-manager 子职责 | Main | 中 | 低 | 阶段 0（文档） |
| M3 Main 不存完整 tree | Main | 低（已降级） | 低 | **阶段 0（仅文档化）**——plan-review-round-3：改 Set 会丢 paneId 契约（前端类型声明，IPC 透传）且风险本身弱、无实际 bug、spec §3.1 已定低优。降级为文档化，不做代码改动。现状记录见 phase-2.5「M3 文档化说明」 |
| M1 main.ts spawn 去重 | Main | 中 | 低 | 阶段 2.5 |
| T2 拆 session-service | Runtime | 高 | 中 | 阶段 3 |
| T6 组合根（事件总线已降级） | Runtime | 低（已订正） | 低 | 不在必做项 |
| T1 路由表声明式 | Runtime | 低 | 低 | 阶段 2 |
| T5 Plugin Facade 边界 | Runtime | 中 | 低 | 阶段 0（文档+lint） |

**与第三部分迁移路线的衔接**：本部分的细化点大多落入既有阶段 1/2/3，无需新增阶段。最值得先做的是 **R4（API Client 内部结构）+ T2（拆 session-service）** —— 这两者分别治前端协议散乱、后端巨石文件两个最痛的点。（T6 事件总线经订正后降为可选，不再在此列。）

---

## 4.5 第四部分总结：从「进程边界」到「模块边界」

如果说前三部分解决的是「**哪个进程负责什么、进程之间怎么通信**」（进程边界），那么第四部分解决的是「**进程内部各模块怎么组织、模块之间怎么依赖**」（模块边界）。两者是不同粒度的设计：

| 粒度 | 关注问题 | 产出 | 对应部分 |
|------|---------|------|---------|
| 进程级 | Renderer / Main / Runtime 各自职责、双通道契约、跨进程状态真相源 | 三进程架构图 + 依赖铁律 | 第一/二/三部分 |
| 模块级 | 每个进程内部的子目录、模块 Facade、单向依赖、不变量 | 三个进程的内部依赖图 + R/M/T 细化点 | 第四部分 |

**第四部分的三条核心规则**（贯穿三个进程）：

1. **按领域（关注点）切目录，不按文件类型** —— `features/` 而非「所有 composable 平铺」；`session/` 而非「所有 service 平铺」。
2. **单向依赖、无环** —— 每个进程内部都能画一张从上到下的依赖图。Runtime service 间经核对已无编译期环（hook 注入是 IoC，非循环）；未来若出现多订阅者需求，用领域事件解耦，不用 setter 掩盖（但 setter 注入本身是正常 DI，非环的信号）。
3. **每个模块只暴露一个 Facade** —— store 的 return 对象、service 的 interface、plugin 切片的 `IPluginService`。内部 helper 不外泄。

这三条规则在三个进程里以不同形态体现，但本质相同：**把「正确但模糊」的骨架，变成「明确可检查」的边界**。

至此，完整架构设计覆盖了从**全局进程拓扑**（三进程、双通道）到**进程内部模块组织**（各层子目录、Facade、依赖图）的全部层次。后续落地可从第三部分定义的阶段 1（R4 前端 API Client）开始执行。

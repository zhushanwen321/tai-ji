# xyz-agent 跨进程架构决策记录（D1–D9）

> **性质**：2026-06 架构重构期的逐点决策记录。长期保留的是**跨进程边界的决策与理由**；已消费完毕的实施内容（现状距离评估、分阶段迁移路线、各进程内部细化设计）于 2026-09-13 删除，git 可追溯。
>
> **现行架构入口**：[`docs/architecture.md`](../architecture.md)（进程拓扑与分层实质说明）。各域 SSOT：renderer 包拓扑 [renderer-package-topology.md](renderer-package-topology.md) · runtime 分层 [runtime-layering.md](runtime-layering.md) · 数据治理 [data-source-governance.md](data-source-governance.md) / [data-source-registry.md](data-source-registry.md) · 术语表 [context.md](context.md)。
>
> **状态标注**：✅ 生效（现行机制，落点可能已随重构迁移）· ⛔ 已被取代（保留作历史决策与理由）。

---

## D1. 双出口通道建模（WS + IPC）✅

渲染进程有两条独立出口通道：

```
渲染进程
  ├─ WebSocket (ws-client)  → Runtime   业务/数据（session/config/model/plugin...）
  └─ IPC (electronAPI)       → Main     系统/窗口/进程生命周期（getRuntimePort, createWindow...）
```

最关键的隐式契约是**启动时序**：渲染进程必须先经 IPC 向 Main 取 runtime 端口，才能连 WS。

**Main 进程的 3 个真实职责**（原架构统称「Electron 壳」，掩盖了它的重量）：

| 子系统 | 职责 | 对应 IPC API |
|--------|------|-------------|
| **M1 Process Supervisor** | Runtime 子进程的 spawn/kill/端口发现/健康检查 | `getRuntimePort`、`onRuntimePort`、`onRuntimeError` |
| **M2 Window Manager** | 原生窗口创建/聚焦/销毁 + 跨窗口注册表 | `createWindow`、`getWindows`、`focusWindow` |
| **M3 OS Gateway** | 需要 OS 特权的原语：对话框、外链、快捷键、全屏 | `pickDirectory`、`openExternal`、`onShortcut` |

**通道边界规则**：一个能力走 **IPC** 当且仅当它需要 Main 的特权访问（原生窗口/进程/OS）。其余一律走 **WS**。

**启动时序契约**（`apps/electron/main/main.ts` 头注释引用本决策；先窗口后 runtime 是有意的 UX 决策）：

```
1. Main 启动
2. Main 创建 BrowserWindow（渲染进程立即可见）
3. RuntimeManager spawn Runtime 子进程（后台，端口探测 BASE_PORT..+10）
4. 渲染进程启动 → 连接初始化
5. 渲染进程注册 onRuntimePort 监听器（Runtime 重启后重连）
6. 渲染进程 IPC getRuntimePort() → connect WS(port)
7. WS 连通 → 业务就绪
8. （运行期）Runtime 重启 → Main 经 onRuntimePort 推新端口 → 渲染进程重连
```

**理由**：端口发现链路是「runtime 崩溃自愈」「多实例端口隔离」「热重启」的前提；把 Main 的 3 个职责命名出来后，「Electron 壳不放业务逻辑」才可检查——Window Manager 持有的窗口注册表是领域状态而非壳。

---

## D2. 跨进程窗口/面板状态协调 ⛔ 已被 v2 panel 模型取代

> 原决策：Main 持有窗口注册表（跨窗口 session 归属查询的读副本）+ 渲染进程持有 PanelTree（唯一写入者），配「一个 session 全局最多绑一个 panel」不变量与 session 迁移协议（Main 原子 claim、先到先得、后到者聚焦跳转）。
>
> **被取代原因**：v3/v2 重构后窗口内收敛为单 panel 形态（`packages/renderer/src/stores/panel.ts` 头注释自述「v1 用 PanelTree 递归树……历史背景」），跨窗口 session 查询与镜像同步链（`syncPaneState`/`updateWindowState` IPC）已随之删除。若未来恢复多 panel/多窗口协调，从 git 历史恢复本决策再评估。

---

## D3. API Client 层核心设计（请求/响应 vs 事件驱动）✅

### 问题回顾
协议是**事件驱动 + fire-and-forget**，`send()` 无返回值，响应经 event-bus 异步回来，每个调用方手写监听器。若 API Client 只是给 `send()` 包类型，价值有限。

### 操作分类（决策依据）
按「响应形态」分三类：

| 类别 | 响应形态 | 举例 | 调用方写法 |
|------|---------|------|-----------|
| **请求/响应**（单一确定响应） | 一次返回 | `session.create`、`config.getProviders`、`model.switch` | `await api.session.create()` |
| **触发即流**（push 事件序列） | 无返回，订阅流 | `message.send`→`message_start/text_delta*/complete` | `api.chat.send()` + 事件订阅 |
| **纯 push**（服务端发起） | 只订阅 | `context.update`、`plugin:statusBarUpdate` | `api.events.on(...)` |

### 决策：混合 API Client——命令(Promise) + 事件(可订阅)

请求/响应类返回 Promise（按 `id` 关联：Runtime 在直接响应消息上回填请求 `id`，广播/纯 push 不回填）；流式类返回 void + 事件订阅。API Client 是 **WS + IPC 的统一门面**，组件只见 `api.xxx`，不见 ws/ipc。

**行为契约（原 G3–G6 细则，压缩保留）**：
- **错误流入口**：`stream_error` / 命令超时等错误统一走 `chatStore.markSessionError(sid, err)` 收尾（见 D6a）；路由层管「去哪」，markSessionError 管「怎么收尾」。
- **命令超时善后**：`command()` 超时 reject 后从 pending 表删除该 id（防泄漏）；Runtime 迟到的响应命中不了 pending → 静默丢弃。错误分类：超时 / 断连（pending 全 reject）/ 业务错误。
- **重连收尾**：重连成功后对所有生成中的 session 调 `markSessionError` 收尾，避免 UI 卡在「思考中」（runtime 重启意味着 pi 上下文丢失，不续传 streaming）。
- **事件订阅生命周期**：`on(type, handler)` 返回 unsubscribe；同 type+handler 的重复订阅用模块级 refCount 合并（组件多实例防重复注册），refCount 归零才真正移除。
- **Mock 边界（原 D8）**：mock 注入在 API Client 层，实现同一 `api` 接口——mock 的是**业务语义**而非协议字节。现行落点：`packages/core/src/transport/mock/`。
- **协议复用（原 D9）**：直接复用 `shared/protocol.ts` 的消息 union 做 `api` 类型签名，不重新定义协议。类型化 `command()` 原语的完整落地见 [ADR-0046](../adr/0046-rpc-type-pairing-ssot.md)。

**现行落点**：`packages/core/src/transport/`（transport/pending/events/request/domains 分层）。

**理由**：把「等结果」的同步心智和「流式」的异步心智分开表达，是这套协议能给出的最大人体工学改进；统一门面让双通道对组件透明。

---

## D4. Runtime 内部分层 ⛔ 已被 [runtime-layering.md](runtime-layering.md) 取代

> 原决策：transport/services/adapters/infra 四层，adapters（防腐层）独立成层。
>
> **被取代原因**：实证 adapters 名存实亡（pi-config-bridge 是 re-export 杂物间、PiXxx 类型泄漏 service、infra 反依赖 adapters）。终态 = 三层 + ports 依赖倒置（连接与翻译合并进 infra），决策全文见 [runtime-layering.md](runtime-layering.md) 第一部分。原四层中仍生效的部分：transport 纯路由、services 按域切、防腐职责唯一入口（现为 infra/pi）。

---

## D5. 双维度模型（水平层 × 纵向上下文）✅

PluginService（services/plugin-service/ 27+ 文件）自身就是 mini 架构（同时含 transport/infra/service/adapter），笼统归「Services 层的一坨」失真。

**决策：架构用双正交维度建模。**

- **维度 1 · 水平层**（「这是什么代码」）：现行 runtime 三层 transport / services / infra（D4 修订后）。
- **维度 2 · 纵向上下文 / bounded context**（「这是哪个领域」）：Chat/Session、Config、Model、Plugin、Extension、Window。

PluginService 是一个**自包含的纵向切片**——内部有自己的分层，对外只通过 `IPluginService` 暴露（Bounded Context + Facade）。**规则**：纵向切片可有内部分层，但**禁止把内部模块泄漏到切片外**——只有 `IPluginService` 接口越界。

**理由**：双维度模型让「27 个文件塞进一层」的困惑消失；该模型可推广——未来 Config/Model 变复杂可同样升级为 bounded context，水平层规则不变。

---

## D6. 横切关注点归宿（错误流 / session 路由 / 服务解耦）✅

### 决策 6a · 错误流：不变量下沉到 Store 单一 action

错误路径的唯一收尾入口：

```ts
// packages/core/src/domain/chat/store.ts
function markSessionError(sessionId: string, errorText: string): void {
  // isGenerating/streaming 复位 + 错误作为内联系统提示插入消息流——不变量集中在此
}
```

调用方（useChat / 事件错误订阅）只调 `markSessionError(sid, err)`，不再各自重置。**理由**：错误必须重置生成状态是「违反必出 bug」级不变量，散落在每个 composable 必然漏。

### 决策 6b · session 路由管线

Session 级消息必须按 `sessionId` 路由到 session 通道，无 `sessionId` 的消息走 global 通道，两通道互不串扰（`packages/core/src/coordination/route-inbound.ts` 头注释）+ 组件层 per-session 过滤兜底（ADR-0049 Map 分区范式）。路由形态已从原设计的 if-else 管线演进为**声明式 ROUTE_TABLE**（查表 + 执行，见 [renderer-package-topology.md](renderer-package-topology.md) §4.3）——新增 server-push 消息类型 = 加一行路由条目 + 一个 handler，不动路由核心。

### 决策 6c · 服务间解耦机制：hook 注入（IoC）+ setter 注入（正常 DI）

经代码核对（tracing-round-1 订正，原文误诊「循环依赖」）：Session↔Plugin↔Model **无编译期循环**——

- PluginService → ISessionService 经接口依赖；hook 经 `sessionService.setSendMessageHook(...)` 注入（`session-service.ts` 现委托给 dispatcher），SessionService 只持函数引用不知来源——已是控制反转，保留同步 block 语义。
- setter 注入是构造顺序信号（PluginService 先于 SessionService 实例化），**不等于**循环依赖。
- ModelService 与 SessionService 的委托编排随 composer-model-session-isolation 修订演进，以现行代码为准。

**事件总线升级触发条件**（满足任一才引入进程内事件总线）：① 出现第二个想监听 session 生命周期的模块；② hook 链需要可插拔（多 hook 串联、优先级排序）。未满足前保持 hook 注入 + setter DI——引入进程内总线是真实复杂度（订阅管理、调试困难、与前端 event-bus 同名混淆），无现存痛点驱动时不做。

---

## D7. 命名债 ✅ 已执行完毕

sidecar→runtime、Pane→Panel、SystemChatMessage→SystemNotification、Drawer→SideInspector、Overview→PanelGrid 等改名已完成（术语现状见 [context.md](context.md)）。原则保留：命名债是认知信号，「挪目录」须同时「正注释」，否则只换皮不治本。

---

## 附录 · 决策索引

| 决策 | 主题 | 状态 |
|------|------|------|
| D1 | 双出口通道（WS+IPC）建模 + 启动时序契约 | ✅ 生效（main.ts 头注释引用） |
| D2 | 窗口/面板双真相源 + session 迁移协议 | ⛔ 被 v2 单 panel 模型取代 |
| D3 | API Client：命令+事件混合 + 统一门面 + G3–G6 行为契约 | ✅ 生效（core/src/transport/） |
| D4 | Runtime 四层（adapters 独立） | ⛔ 被 runtime-layering 三层+ports 取代 |
| D5 | 双维度模型：水平层 × 纵向上下文（Plugin 完整切片） | ✅ 生效 |
| D6 | 横切：错误不变量（6a）/ session 路由管线（6b）/ hook 注入与事件总线升级条件（6c） | ✅ 生效（6b 形态演进为 ROUTE_TABLE） |
| D7 | 命名债 | ✅ 已执行完毕 |
| D8 | Mock 下沉到 API Client 层 | ✅ 生效（并入 D3） |
| D9 | 复用 protocol.ts union | ✅ 生效（并入 D3，类型化见 ADR-0046） |

# taiji 插件架构总览

> **定位**：插件体系的架构 SSOT（现状描述 + 契约边界 + 数据流）。回答「插件能扩展什么、怎么被加载、数据怎么流动」。
> 逐点扩展点清单见 [extension-points.md](extension-points.md)；「怎么写一个插件」的操作指南见 [built-in-plugin-guide.md](built-in-plugin-guide.md)。
>
> **关键区分（先读这条）**：taiji 里「扩展」有**两层机制**，语义不通用，混用是绝大多数误设计的原因：
>
> | | **taiji Plugin** | **pi extension** |
> |---|---|---|
> | 是什么 | taiji 自有插件（`resources/plugins/` + 用户安装） | pi coding agent 的扩展包（`extensions/` 下 29 个 `@zhushanwen/pi-*`，其中 21 个在内置清单 `packages/shared/src/mandatory-extensions.json`） |
> | 跑在哪 | runtime 进程管理的 Worker / fork 子进程 | **pi 子进程内**（每 session 一个 pi 进程） |
> | 解决什么 | UI 贡献、后台服务、provider 来源、命令 | 模型可见能力：tool / slash 命令 / 消息渲染 / provider / pi 事件钩子 |
> | 契约 | `packages/plugin-sdk/src/types.ts`（`PluginContributes` / `Phase2AgentAPI`） | `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` |
> | 能否直接渲染 UI | 能（`GuiComponent` 树经 ViewHost） | 只能经 pi 通道投递（marker / widget / tool details） |
>
> 判据：**能力要出现在模型眼前（tool/命令/上下文）→ pi extension；要出现在屏幕上或常驻后台 → taiji plugin**。两者可配对（羊毛 provider 就是插件做管理 + pi 扩展做协议转换的双产物形态）。

---

## §1 四层模型

```
┌─ Renderer 进程 ─────────────────────────────────────────────────┐
│  L4  壳与渲染消费面                                              │
│      AppShell / Sidebar / PanelHeader / Composer / PanelContainer │
│      挂载点容器（ViewHost / HeaderActionsHost / PluginProviderFlow）│
├─────────────────────────────────────────────────────────────────┤
│  L3  ExtensionHost（core headless + ui 渲染件）                  │
│      ContributionRegistry  声明式贡献（manifest → 可路由记录）    │
│      MountPointRegistry    壳注册可用挂载点（能力集合）          │
│      CommandRegistry       命令表（命令面板/快捷键/slash/菜单）  │
│      ViewHostStore         GuiComponent 树缓存（per scope/view）  │
│      OverlayLifecycle      伴生浮层状态机                        │
├─────────────────────────────────────────────────────────────────┤
│  L2  ExtensionHostBridge（壳装配层，composable）                 │
│      ws 消息 ↔ InternalEventBus；connected 边沿全量拉取           │
├─────────────────────────────────────────────────────────────────┤
│  L1  transport（ws-client + domains）                            │
└─────────────────────────────────────────────────────────────────┘
                              ↕ WebSocket（plugin.* 请求 / plugin:* 广播）
┌─ Runtime 进程 ──────────────────────────────────────────────────┐
│  PluginService（唯一适配层，WS → service）                       │
│    ├─ PluginRegistry      扫描 manifest → PluginDescriptor       │
│    ├─ PluginActivator     激活/权限审批/激活事件                  │
│    ├─ PluginHost          trusted 共享 Worker（≤10）/ sandbox fork│
│    ├─ PluginRpcServer     插件 RPC 服务器（api.* → handler）      │
│    ├─ HookPipeline        onBeforeToolCall / onAfterToolResult … │
│    └─ PluginUiSnapshotStore  视图/徽标快照（拉取恢复源）          │
├─────────────────────────────────────────────────────────────────┤
│  pi 适配层（infra/pi）：event-adapter / event-interpreter        │
└─────────────────────────────────────────────────────────────────┘
                              ↕ JSON-RPC over MessagePort / stdio
┌─ 插件执行体 ────────────────────────────────────────────────────┐
│  activate(context) → context.api（Phase2AgentAPI）               │
└─────────────────────────────────────────────────────────────────┘
                              ↕（另一条独立链路，不经过 PluginService）
┌─ pi 子进程（每 session）─────────────────────────────────────────┐
│  pi extension：registerTool / registerCommand / registerProvider  │
│               registerMessageRenderer / on(event) / ctx.ui.*     │
└─────────────────────────────────────────────────────────────────┘
```

**依赖方向铁律**（包管理器 + lint 强制，见 [renderer-package-topology.md](../architecture/renderer-package-topology.md)）：
`shared ← extension-protocol ← core ← ui ← renderer / mobile-renderer`；`plugin-sdk → shared + extension-protocol`（单向，runtime 的 `plugin-types.ts` 只是 re-export 薄壳）。

---

## §2 贡献点契约（manifest 声明面）

manifest 位于 `package.json` 的 `taijiPlugin` 字段，类型 SSOT = `packages/plugin-sdk/src/types.ts` 的 `TaijiManifest` / `PluginContributes`。

### 2.1 元字段

| 字段 | 作用 | 消费方 |
|---|---|---|
| `manifestVersion` | 当前必须 `1` | `docs/plugins/built-in-plugin-guide.md` §2.2 |
| `main` | 入口文件（相对 package.json） | `plugin-registry.ts` `resolveEntry` |
| `activationEvents` | 激活时机声明（`onStartupFinished` / `onSessionCreate` / `onSlashCommand:<name>` / `onToolCall:<name>`） | `PluginService` 激活链 |
| `trustLevel` | `trusted`（共享 Worker）/ `sandbox`（独占 fork） | `plugin-host.ts` |
| `permissions` | RPC 权限词（归一为方法名，见 `packages/shared/src/plugin-permission-map.ts`） | `plugin-permission.ts` |
| `capabilities` | 业务能力词（`network.http` / `fs.read-user-data` / `crypto` / `process.spawn`）→ fork 放行 Node 内置模块 | `packages/shared/src/plugin-capability-map.ts` |
| `readPaths` | `fs.read-user-data` 的家目录相对路径白名单 | `plugin-fs-guard.ts` |
| `namespace` | provider 插件的命名空间（必须等于包名推导值） | `plugin-namespace.ts` |
| `extensionDependencies` | 依赖的其他插件 id | `plugin-deps.ts` |

**capabilities 与 permissions 是两套机制**：`permissions` 管「能调哪些 RPC 方法」，`capabilities` 管「fork 里能 require 哪些 Node 内置模块」。二者词表、消费链、执法点都不同，不可互替。

### 2.2 `contributes` 声明块

| 段 | 形状 | 路由去向 | 消费点现状 |
|---|---|---|---|
| `views` | `{ id, title, placement, viewType?, activationEvent?, initialVisibility? }` | `ContributionRegistry` → `MountPointRegistry` | `sidebar.tab` 有消费（`PluginViewContainer` → `ViewHost`）；其余 placement 由壳注册决定 |
| `headerActions` | `{ id, title, icon, commandId, order? }`（core 版另带 `activation?: 'scheduler-overlay'`，两版 `commandId` 必填性不一致，见 §7 缺口 7） | `panel.header` 名下的按钮区 | `HeaderActionsHost.vue`（渲染 + 三态灰置 + 点击分派） |
| `commands` | `{ command, title, category?, keybinding?, when?, icon? }` | `CommandRegistry`（声明提供元数据，`api.commands.register` 提供 handler） | `useExtensionHostBridge.ts` `ensureCommandDeclarationsSync` |
| `slashCommands` | `{ name, description }` | `CommandRegistry` 的 slash 段（声明即显示，ADR-0050） | `resolveSlashCommands` 合并源 |
| `menus` | `{ 'composer.toolbar'?: [...], 'sidebar.footer'?: [...] }` | 解析为 `menu` 类型记录 | **当前零渲染消费方** |
| `configuration` | JSON Schema 子集 `{ title?, properties }` | 解析为 `configuration` 类型记录 | **当前零渲染消费方**（设置页无表单自动生成） |
| `hooks` | `string[]`（hook 类型名） | `PluginRegistry.inferActivationEvents` 推断激活事件 | 实际注册走 `api.hooks.*` |
| `tools` | `{ name, description, parameters }[]` | `inferActivationEvents` 推断 `onToolCall:<name>` | 仅用于激活推断；运行时注册走 `api.tools.register`（进 `toolRegistry`，**不注入 pi 工具表**，见 §7 缺口 2） |

> **声明 ≠ 可用**：`contributes` 只是「想让宿主展示什么」，真正可路由还要求对应挂载点已由壳注册（`mount-point-registry`）。未注册挂载点的贡献会 `emit('unregistered-mount-point')` 并置灰，不静默丢弃。

### 2.3 运行时 API（`context.api`，`Phase2AgentAPI`）

按能力族分组，全部经 RPC 转发回 runtime 主线程：

| 族 | 方法 | 备注 |
|---|---|---|
| `storage` | `global` / `workspace`（`get/set/delete/keys`） | 稳定面 |
| `notify` | `info/warning/error` | |
| `sessions` | `list/get/getActive/sendMessage/readEntries/getCommands` + `onDidCreateSession/onDidDestroySession/onDidActivateSession/onEntriesInvalidated` | `readEntries` 是 custom entry 镜像读（live only） |
| `events` | `on/emit`（**未实现，调用即抛 NOT_IMPLEMENTED**）+ `report(channel, payload)` | `report` 是插件 → renderer 业务上报出口 |
| `tools` | `register/unregister` | 进 `toolRegistry` |
| `hooks` | `onBeforeSendMessage/onBeforeToolCall/onAfterToolResult/onPiEvent` | interceptor 可改写或阻断（阻断不阻止 pi turn） |
| `config` | `get/getAll/set` | |
| `sessionData` | `get/set/delete/keys`（per session KV） | 落 `<dataDir>/ext-sessions/<sid>/plugin-data.json` |
| `ui` | `showSelect/showConfirm/showInput`（带 `opts.timeout`）/ `notify` / `updateHeaderAction` / `openUrl` | 对话框超时 = 取消非替答 |
| `providers` | `write/delete/credential` | 命名空间受限；走宿主写策略链，不直写 models.json |
| `agent` | `setModel/getModel/getThinkingLevel/setThinkingLevel/getActiveTools` | 返回**实际生效值**回执 |
| `workspace` | `rootPath` / `name` / `findFiles` | |
| `commands` | `register/unregister` | 复合键 `pluginId:commandId` |
| `views` | `update(viewId, guiTree, scope)` / `listMountPoints()` / `onUiEvent()` | scope 二选一：`{sessionId}` 或 `{mountId}` |

能力分层标注（`@stable` / `@proposed` / `@experimental` / `@internal`）在同文件内逐条标出——`@internal` 不进插件作者契约范围。

---

## §3 生命周期与执行模型

### 3.1 执行体隔离

| 维度 | trusted（内置） | sandbox（外部） |
|---|---|---|
| 载体 | Worker Thread，**共享 ≤10 插件/Worker** | 独立 fork 子进程 |
| 通信 | JSON-RPC over MessagePort | JSON-RPC over stdio |
| Node 内置 | 基线可用 | 由 `capabilities` 决定放行集，基线黑名单全拦 |
| 权限 | 默认全授权 | 必须显式声明并获用户批准 |
| 目录 | `resources/plugins/<name>/` | `<dataDir>/plugins/<name>/` |

**trusted 共享 Worker 的副作用**：无唯一插件身份，因此 `providers.credential` 之类的身份敏感 API 对 trusted 插件 fail-closed 拒绝；`views.onUiEvent` 的通知在该 Worker 内广播给全部 handler 而非定向投递。

### 3.2 状态机

```
UNLOADED → LOADING → ACTIVATING → ACTIVE → DEACTIVATING → UNLOADED
                 ↘ CRASHED                     ↗
               DEPS_MISSING（extensionDependencies 未满足）
```

激活触发 = `activationEvents` 命中（`onStartupFinished` 启动后一次性；`onSlashCommand:<name>` / `onToolCall:<name>` 由 contributes 自动推断）。插件崩溃时该插件的 hook / tool / command 条目全部清理（`plugin-contributions.ts`），残留调用会指向死 Worker，所以清理是必需的而非优化。

**已知缺口**：renderer 侧 `ActivationManager` 注入的是 no-op trigger（`useExtensionHostBridge.ts` 中 `ensureActivated: async () => {}`），且 `registerActivationEvents` 生产零调用。即懒激活链路目前**未闭环**——实际激活全部在 runtime 启动时按 `onStartupFinished` 完成。

### 3.3 两段式安装与权限审批

1. `plugin.prepareInstall`：拉清单 → 克隆/下载到 tmp → 扫描候选 → 返回待确认视图
2. `plugin.confirmInstall`：用户确认后落地 + 能力授权（授权时机 = 安装，运行时不做逐次审批）
3. 权限：`plugin:permissionRequest` 广播 → 用户批准 → `plugin.approvePermissions`；到期 `plugin:permissionRequestExpired` = 取消非判拒

---

## §4 数据流

### 4.1 插件 → 界面（推送 + 拉取两通道）

```
插件 api.views.update(viewId, tree, scope)
  → runtime PluginRpcServer handler
  → PluginUiSnapshotStore（写快照，供恢复）
  → broadcast 'plugin:viewUpdate'
  → renderer MessageBusBridge → InternalEventBus('extension-widget')
  → ViewHostStore（per scope 分区缓存）
  → ViewHost.vue computed → GuiComponentRenderer
```

**拉为主、推补充（ADR-0097）**：推送帧是 transient（不入 ring、不重放），丢失后的收敛靠两条拉取通道——① WS `connected` 边沿全量 `plugin.ui.snapshot`；② `ViewHost` 挂载时发现分区为空则按 `(scope, viewId)` 自举补拉。**因此不允许在消费侧写推送补偿逻辑**（定时器重拉、本地重建等）。

headerAction 的同族链路：`api.ui.updateHeaderAction` → `plugin:headerActionUpdate`（全局广播 transient）→ `HeaderActionStore`（per-session）→ `HeaderActionsHost`。缺省语义是「插件从未推送 = 不可见」（fail-safe，见 `isVisibleHeaderAction`）。

### 4.2 pi extension → 界面（marker 通道）

pi 进程内无法直接渲染，只能用 `ctx.ui.select(title, options)` 这类既有 API 传出可序列化载荷，靠 **NUL 前缀 marker title** 让 runtime 识别。marker 常量单源在 `@zhushanwen/extension-protocol`：

| marker | 生产者 | runtime 处理 |
|---|---|---|
| `GUI_WIDGET_MARKER` | 各 extension 的 `setWidget` | 解码为结构化 widget |
| `ASK_USER_MARKER` | `pi-ask-user` | → 提问表单 |
| `UI_FORM_MARKER` | `pi-ask-user` / `pi-scheduler` / `pi-plan` | → 统一提问表单 |
| `SCHEDULE_CREATE_MARKER` | `pi-scheduler` | → 定时建任务表单 |
| `PLAN_REVIEW_MARKER` | `pi-plan` | → 计划三键审阅条 |
| `SESSION_MANAGER_MARKER` | `pi-session-manager` | runtime 内部消费（无降级） |
| `CANVAS_MARKER` | `pi-canvas` | runtime 内部消费（画布服务） |
| `SUBAGENT_INFLIGHT_MARKER` | `pi-subagent-workflow` | 就地消费 + ack（不广播） |
| `SUBAGENT_JOURNAL_MARKER` | `pi-subagent-workflow` | 就地消费 → 事件推送通道 |

分发点两处：`event-adapter.ts` 的 `MARKER_DIALOG_FALLBACKS` 表（可降级族，检测失败降级为普通 dialog）与 `translateInteractiveRequest` 内的显式段（无降级族）。**新增 marker = 协议包常量 + runtime 表登记 + 前端消费方三件套**，缺一即静默降级成对话框。

### 4.3 GuiComponent 渲染协议

`packages/extension-protocol/src/core/types.ts` 定义可序列化组件树（`GuiComponentProps`）。原语：

`ansi-text`（ANSI 兜底）· `card` · `stats-line` · `progress-bar` · `list-tree` · `group` · `columns` · `tab-bar` · `action-bar`（首个交互原语，items 携 commandId）· `text-input`（值经 `plugin.uiEvent` 回传）· `custom`（**仅 builtin**）。

渲染路由：`core/src/rendering-protocol/resolve.ts`（纯函数，未知类型 → `ansi-text` JSON 降级）→ `ui/src/rendering-protocol/GuiComponentRenderer.vue` → `primitives/*`。

**协议演进纪律**：`custom` 逃生口只对 builtin 开放（编译期 provide），external 强制用原语；原语不够时**补原语**（四同步：类型 + 渲染组件 + 视觉 + ANSI 降级），不放开 custom。ANSI 兜底永留——未接入协议的 pi extension 开箱即用是兼容性铁律。

---

## §5 挂载点体系

挂载点**不是硬编码在 ExtensionHost，而是由壳注册**（`MountPointRegistry.register`）。这样移动壳天然获得子集，无需 if-else 特判。

### 5.1 当前注册集（`packages/core/src/bootstrap.ts` `registerMountPoints`）

| 挂载点 | 容器 | 用途 |
|---|---|---|
| `sidebar.tab` | `PluginViewContainer` → `ViewHost` | 侧栏 Plugins tab 内的二级 tab |
| `panel.header` | `HeaderActionsHost` + `ViewHost` | 卡头按钮区（headerAction）+ 信息条视图 |
| `composer.toolbar` | `ViewHost`（Composer + 托盘聚合面板两处） | 输入框工具条 |
| `provider.authorize` | `PluginProviderFlow` | Provider 授权流程插件渲染位（全局域） |
| `provider.detail-extra` | `ProviderRowCard` | Provider 条目展开体尾部（全局域） |

被文档/类型提及但**未注册**：`drawer.tab`、`sidebar.footer`、`message-stream`、`slash`、`companion`（移动壳文档所述子集亦未在 `mobile-renderer` 实装注册）。

### 5.2 scope 联合（分区键）

- 会话域 `{ kind: 'session', sessionId }`——内容绑会话，runtime 定向投递
- 全局域 `{ kind: 'global', mountId, pluginId }`——无会话归属的挂载位（Provider 页），分区键并入插件 id，多插件同挂载位互不覆盖

---

## §6 与 pi extension 的分工边界

### 6.1 分工表

| 需求 | 归谁 | 理由 |
|---|---|---|
| LLM 可调用的 tool | pi extension | 只有 pi 的 `registerTool` 能让模型看见 |
| slash 命令的执行 | pi extension（`registerCommand`）+ 声明副本进 taiji（`contributes.slashCommands`，供 landing 态显示，ADR-0050） | 声明与执行分离 |
| 会话内联消息渲染 | pi extension 投递 + 前端承接 | `registerMessageRenderer` 的 details 经 pi 协议到 taiji |
| 侧栏/卡头/工具条 UI | taiji plugin | pi extension 无 DOM |
| 设置页配置表单 | taiji plugin（`configuration` 段，尚未实装）或宿主内置页 | |
| provider 注册 / 协议转换 | pi extension（`registerProvider`） | 必须让 pi 的模型注册表认到 |
| provider 凭据管理 / 授权 UI | taiji plugin（`providers.*` + `provider.authorize`） | 能力与 UI 都在插件侧，凭据经写策略链落盘 |
| 常驻后台服务 | taiji plugin | 有 Worker/fork 生命周期；pi 进程随会话生灭 |

### 6.2 双产物配对（羊毛范式）

`configs/remote/v2-plugins.json` 的 `{ pluginVersion, piExtensionVersion }` 是两包版本配对的唯一权威（`wool-extension-installer.ts` 校验，`VERSION_PAIR_MISMATCH` 拒装）。这解决了「插件改了管理协议但 pi 扩展还是旧版」的错配——单产物做不到。

### 6.3 pi 边界可靠性（ADR-0064）

四条支柱：能力注册表 / 生效回执（`agent.setModel` 等返回实际生效值，与请求值区分）/ 确认式送达（`sendMessage` 返回 `{accepted, reason}`）/ 漂移检查。详见 [pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)。

---

## §7 已知缺口与设计债

以下是本次盘点核实的现状缺口（不是计划，是事实登记）：

1. **`contributes` 走到 renderer 的通路未闭环**：`scanContributions` 里 `loadExternal([])` 恒传空数组，且 `PluginInfo`（`config.plugins` 广播载荷，`packages/shared/src/plugin.ts`）**不含 `contributes` 字段**。结果是只有 `bootstrap.ts` 里静态写死的 `builtinContributions`（tasks / scheduler-manager / scheduler 三条）能产生 renderer 贡献；任何新装插件声明的 `views` / `headerActions` / `commands` 都不会出现在界面上。
2. **插件 tool 不注入 pi 工具表**：`api.tools.register` 只写 runtime 侧 `toolRegistry`，`agent.getActiveTools` 会列出它，但没有任何代码把 schema 传给 pi。模型永远看不到插件工具。（旁证：`packages/pi-rpc/src/commands.ts` 的命令帧族里也没有运行时注册 tool 的帧。）
3. **懒激活未闭环**：见 §3.2。
4. **`menus` / `configuration` 两段零消费方**：解析进 `ContributionRecord` 后无人读。
5. **`events.on/emit` 插件间事件总线未实现**（调用即抛）。
6. **`custom` 原语注册表无生产 provide 点**：`GUI_CUSTOM_REGISTRY_KEY` 只有 inject，仓库内无 `provide`，因此 `custom` 组件在运行时恒降级。
7. **`PluginContributesHeaderAction` 两版形状不一致**：`packages/plugin-sdk/src/types.ts`（声明为 SSOT）里 `commandId: string` 必填且**无 `activation` 字段**；`packages/core/src/extension-host/types.ts` 里 `commandId?: string` 可选且带 `activation?: 'scheduler-overlay'`。两份定义不同步，插件作者照 SDK 写不出 scheduler-manager 那种 overlay 直开入口。

---

## §8 相关文档

| 主题 | 文档 |
|---|---|
| 逐点扩展点清单（renderer / runtime / pi extension） | [extension-points.md](extension-points.md) |
| 怎么写内置插件（操作指南） | [built-in-plugin-guide.md](built-in-plugin-guide.md) |
| GuiComponent 协议细节 | [extension-gui-protocol.md](../architecture/extension-gui-protocol.md) |
| pi extension 接入 GUI 的操作指南 | [extensions/gui-protocol-guide.md](../extensions/gui-protocol-guide.md) |
| Renderer 包拓扑与 ExtensionHost 分层 | [renderer-package-topology.md](../architecture/renderer-package-topology.md) |
| pi extension 开发指南 / 强约束 | [extensions/development-guide.md](../extensions/development-guide.md) · [extensions/extension-conventions.md](../extensions/extension-conventions.md) |
| provider 插件形态 | ADR-0166（[decisions.md](../adr/decisions.md)） |
| 拉为主推补充原则 | ADR-0097（[decisions.md](../adr/decisions.md)） |
| 插件 SDK 契约源码 | `packages/plugin-sdk/src/types.ts` |

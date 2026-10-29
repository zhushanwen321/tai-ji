# taiji 扩展点全量盘点

> **定位**：逐点清单——「系统里哪些位置允许第三方/外置代码参与」，每点标注**契约、消费方、注册机制、实装状态**。
> 架构总览（四层模型 / 数据流 / 已知缺口归因）见 [architecture.md](architecture.md)。
>
> **读法**：本文按**执行位置**分三层（renderer / runtime / pi extension），不按功能分。同一个功能可能跨层（例如「provider 来源」= renderer 渲染位 + runtime RPC + pi 扩展注册）。
> **状态列**：`已达` = 实装且在用 / `受限` = 实装但弱（有代码与消费方，但能力受限或有已知缺口）/ `空壳` = 通道存在但零消费 / `缺失` = 仅声明未实装。

---

## 图例

| 缩写 | 含义 |
|---|---|
| **契约** | 类型/接口定义所在（扩展写代码时要 import 的东西） |
| **注册** | 扩展如何把自己接进去（manifest 字段 / RPC / provide） |
| **消费** | 谁读取并使用这个扩展点 |
| **状态** | 上表四值 |

编号前缀：`R*` = renderer 层，`T*` = runtime 层，`P*` = pi extension 层，`G*` = 缺口。

---

## §1 Renderer 层扩展点

Renderer 层是三处里**最成熟也最不平衡**的：容器机制（挂载点 + GuiComponent）已经完整，但真正接上线的挂载点只有 5 个，且**大部分界面区域仍是固定实现**（详见 [§4 缺口汇总](#4-三层缺口汇总) 与后续扫描报告）。

### 1.1 挂载点（MountPointRegistry 注册的容器）

契约：`packages/core/src/extension-host/mount-point-registry.ts` 的 `MountPointRegistry.register(name, host?)`
注册点：`packages/core/src/bootstrap.ts` `registerMountPoints()`
声明侧：`contributes.views[].placement`

| # | 挂载点 | 容器组件 | 当前消费 | 状态 |
|---|---|---|---|---|
| R1 | `sidebar.tab` | `packages/ui/src/extension-host/PluginViewContainer.vue` → `ui/src/extension-host/ViewHost.vue`（容器在 ui 包，renderer `Sidebar.vue` 挂） | 侧栏 Plugins tab 内二级 tab（`VIEWS_SOURCE_KEY` 供给清单） | `受限` 机制完整；当前无插件声明 view，tab 恒空态 |
| R2 | `panel.header` | `renderer/src/components/panel/PanelHeader.vue`（`ViewHost` 信息条）+ `renderer/src/components/extension/HeaderActionsHost.vue`（按钮区） | scheduler-manager 徽标入口 | `已达` 在用（唯一真实消费者） |
| R3 | `composer.toolbar` | `renderer/src/components/panel/Composer.vue` + `panel/tray/ComposerTray.vue`（托盘聚合段） | 插件 toolbar 贡献（`use-plugin-toolbar.ts` 判定） | `受限` 机制完整，消费方为密度判定；当前无插件产出此 view |
| R4 | `provider.authorize` | `renderer/src/components/settings/provider/PluginProviderFlow.vue` | 羊毛家族授权流程 | `已达` 在用（全局域 scope） |
| R5 | `provider.detail-extra` | `renderer/src/components/settings/provider/ProviderRowCard.vue` | Provider 条目展开尾部扩展 | `已达` 在用（全局域 scope） |

**被提及但未注册**的挂载点（写进类型注释/文档但 `registerMountPoints` 未调用）：`drawer.tab`、`sidebar.footer`、`message-stream`、`slash`、`companion`。移动壳（`packages/mobile-renderer`）**当前一处挂载点也未注册**（grep `MountPointRegistry` 零命中），文档所说的「mobile 子集」尚未实装。

### 1.2 声明式贡献类型（`contributes` → `ContributionRegistry`）

契约：`packages/core/src/extension-host/types.ts` 的 `ContributionRecord` / `ContributionType`
注册：`ContributionRegistry.registerBuiltin()`（静态表 `builtin-contributions.ts`）+ `loadExternal()`（外部注入）
消费：各处 `getContributions({ type })`

| # | 贡献类型 | 声明字段 | 路由去向 | 消费点 | 状态 |
|---|---|---|---|---|---|
| R6 | `view` | `contributes.views` | 按 `placement` 路由到挂载点 | `VIEWS_SOURCE_KEY`（侧栏 L2 tab）、`ViewHost` | `受限` 见 R1 |
| R7 | `headerAction` | `contributes.headerActions` | 固定 `panel.header` | `HeaderActionsHost.vue`（含三态灰置、badge 截断、`activation` 分派） | `已达` 在用 |
| R8 | `command` | `contributes.commands` | `commands` 逻辑名 | `CommandRegistry`（`ensureCommandDeclarationsSync`） | `已达` 在用 |
| R9 | `slashCommand` | `contributes.slashCommands` | `slash` 逻辑名 | `resolveSlashCommands` 合并源（声明即显示，ADR-0050） | `已达` 在用 |
| R10 | `menu` | `contributes.menus` | `composer.toolbar` / `sidebar.footer` 键 | **无** | `空壳` 解析进记录后零渲染消费 |
| R11 | `configuration` | `contributes.configuration` | `settings` 逻辑名 | **无** | `空壳` 零消费（设置页未实装 schema 驱动表单） |
| R12 | `tools`（renderer 视角） | `contributes.tools` | `onToolCall:<name>` 激活事件 | 仅用于激活推断 | `空壳` renderer 无消费 |

### 1.3 其它 renderer 注入位（`app.provide` 的 InjectionKey）

契约：`packages/ui/src/extension-host/*.ts` 各 `InjectionKey`
装配：`packages/renderer/src/composables/shell/useExtensionHostBridge.ts` `initExtensionHostBridge`

| # | Key | 提供内容 | 消费组件 | 状态 |
|---|---|---|---|---|
| R13 | `VIEW_HOST_SOURCE_KEY` | `getView/getViewIds/refreshView/getViewInScope/refreshViewInScope` | `ViewHost.vue`、`TrayWidgetButton.vue` | `已达` |
| R14 | `VIEWS_SOURCE_KEY` | sidebar.tab 视图声明清单 | `PluginViewContainer.vue` | `已达` |
| R15 | `HEADER_ACTIONS_SOURCE_KEY` | 声明镜像 + 运行时状态 + 命令可用性 | `HeaderActionsHost.vue`、托盘密度判定 | `已达` |
| R16 | `SLASH_COMMAND_SOURCE_KEY` | `resolveSlashCommands(piCommands)` | `CommandPopover.vue` | `已达` |
| R17 | `PluginSettingsDataSourceKey` | 插件清单订阅 + 贡献列表 | `PluginSettingsPage.vue` | `已达` |
| R18 | `DIALOG_REQUEST_SOURCE_KEY` / `UI_RESPONSE_TRANSPORT_KEY` | 对话框请求流 + 回传通道 | `CompanionBand.vue` | `已达` |
| R19 | `PERMISSION_TRANSPORT_KEY` | 权限审批回传 | `PermissionRequestDialog.vue` | `已达` |
| R20 | `OVERLAY_LIFECYCLE_KEY` | 伴生浮层状态机 | overlay 消费方 | `已达` |
| R21 | `ACTION_EXECUTOR_KEY` | action-bar 点击执行器 → 命令链 | `Actionbar.vue`（rendering-protocol） | `已达` |
| R22 | `GUI_CUSTOM_REGISTRY_KEY` | custom 组件注册表（builtin-only） | `GuiComponentRenderer.vue`、`PrimitiveRouter.vue` | `缺失` 仓库内**无 provide 点**，恒空表 → `custom` 恒降级 |

### 1.4 渲染协议扩展（GuiComponent 原语）

契约：`packages/extension-protocol/src/core/types.ts` 的 `GuiComponentProps`
渲染：`packages/ui/src/rendering-protocol/primitives/`（每个 type 一个组件，`container-registry.ts` 登记容器型）

| # | 原语 | 说明 | 状态 |
|---|---|---|---|
| R23 | `ansi-text` | ANSI 文本兜底（兼容 pi 生态基本盘） | `已达` |
| R24 | `card` / `stats-line` / `progress-bar` / `list-tree` / `group` / `columns` / `tab-bar` | 布局原语 | `已达` |
| R25 | `action-bar` | 首个交互原语（items 携 `commandId` → 命令链） | `已达` |
| R26 | `text-input` | 值经 `plugin.uiEvent` 回传 | `已达` |
| R27 | `custom` | 逃生口，仅 builtin 可用 | `缺失` 无 provide 点（见 R22） |

**扩展方式**：新原语 = `extension-protocol` 类型 + `ui/rendering-protocol/primitives/<X>.vue` + `PrimitiveRouter` 登记 + v6 视觉 + ANSI 降级，五处同步。

### 1.5 命令与快捷键

| # | 扩展点 | 契约 | 注册 | 状态 |
|---|---|---|---|---|
| R28 | `CommandRegistry` | `packages/core/src/extension-host/command-registry.ts` | `contributes.commands`（声明）+ `api.commands.register`（handler，经 runtime） | `已达` |
| R29 | slash 命令候选源 | `SLASH_COMMAND_SOURCE_KEY` | pi 真源（`session.getCommands`）∪ 声明 | `已达` |
| R30 | 全局快捷键 | `renderer/src/composables/features/app/key-orchestrator/` + `panel/composer-shortcut-actions.ts` | **普通硬编码表**；`contributes.commands.keybinding` 字段被解析进 `CommandRecord` 但无人消费 | `空壳` 不可扩展 |

### 1.6 空态 / 交互桥（pi 侧内容进入 renderer 的落点）

| # | 通道 | 落点组件 | 状态 |
|---|---|---|---|
| R31 | 统一提问表单（ui-form） | `renderer/src/components/extension/form/FormOverlay.vue`（+ `ChoiceQuestion` / `TextQuestion` / `ScheduleForm`） | `已达` 三方共用（ask-user / scheduler / plan） |
| R32 | 普通对话框（confirm/select/input/editor） | `renderer/src/components/extension/ExtensionUIDialog.vue` → `CompanionBand.vue` | `已达` |
| R33 | 计划审阅三键条 | `renderer/src/components/panel/plan/PlanReviewBar.vue` | `已达` |
| R34 | 计划文档抽屉 | `renderer/src/components/panel/plan/PlanDocsPanel.vue` | `已达` |
| R35 | 画布 | `renderer/src/components/canvas/*`（`CanvasPane` 等） | `已达` 但为**固定实现**，走 schema 驱动（`agent-canvas` 工具集）而非插件渲染 |
| R36 | workflow 可视化浮层 | `renderer/src/components/panel/workflow-viz/overlay/*`（`OverlayTab` 已开放 `string`，容器统一批次；tab 元信息与内容分支仍宿主持有） | `已达`，tab 位已开放、派生未完成 |
| R37 | 后台任务托盘 | `renderer/src/components/panel/tray/*`（`TrayNativePanel` / `TraySessionPanel` / `TrayCanvasPanel`） | `已达` 但面板族固定（`TrayBuiltinKind = 'bash' \| 'subagent' \| 'workflow' \| 'session' \| 'canvas'` 联合写死） |
| R38 | tool 详情富渲染 | `renderer/src/components/panel/detail-renderers/ToolDetailRenderer.vue`（`read` / `write` / `edit` 三分支） | `已达` 但为**按 toolName 硬编码分支** |
| R39 | system / custom 消息渲染 | `ui/src/features/chat/SystemNotice.vue`（`customType` 匹配分支） | `受限` 按 `customType` 硬编码（`subagent-directive` / `pi-respawn-notice`） |

---

## §2 Runtime 层扩展点

### 2.1 PluginService 主通道（taiji plugin）

| # | 扩展点 | 契约 | 状态 |
|---|---|---|---|
| T1 | 插件扫描与描述 | `plugin-registry.ts`（`PluginDescriptor`）、`packages/plugin-sdk/src/types.ts` | `已达` |
| T2 | 生命周期激活 | `plugin-activator.ts`、`activationEvents` | `受限` 懒激活未闭环（`onStartupFinished` 一次性） |
| T3 | 执行体托管 | `plugin-host.ts`（trusted Worker ≤10）/ `plugin-host-process.ts`（sandbox fork） | `已达` |
| T4 | RPC 服务端（`api.*` 的 runtime 侧） | `plugin-rpc-setup.ts` + `api/*.ts`（agent / commands / config / notify / providers / session / session-data / storage / ui / views / workspace） | `已达` 11 个 API 域 |
| T5 | hook 管线 | `hook-pipeline.ts`、`hook-api.ts`；`PluginService.executeHooks` 是唯一执行入口 | `已达` |
| T6 | hook 触发点 | 共 4 个：`event-interpreter.ts` 的 `onBeforeToolCall` / `onAfterToolResult`；`plugin-service.ts` 的 `onBeforeSendMessage` / `onPiEvent` | `已达` 四者全覆盖；`onToolCall` / `onSlashCommand` / `onMessageSend` 三个 hook 类型**零注册点** |
| T7 | 工具注册表 | `tool-api.ts`、`ToolEntry` | `受限` **只进 runtime 表，不注入 pi 工具表** → 模型看不见（见 §4） |
| T8 | 命令注册表 | `api/commands-api.ts`、`commands-executor.ts` | `已达` |
| T9 | 视图推送 + 快照 | `api/views-api.ts`、`plugin-ui-snapshot-store.ts` | `已达` |
| T10 | 权限与能力 | `plugin-permission.ts`（RPC 方法名集会）、`plugin-capability-map.ts`（Node 内置模块放行）、`plugin-fs-guard.ts`（readPaths） | `已达` |
| T11 | 安装 / 卸载 / 更新 | `installed-store.ts`、`plugin-catalog.ts`、`plugin-deps.ts`、`ports/plugin-installer.ts` | `已达` 两段式安装 |
| T12 | 热重载 | `plugin-hot-reload.ts`、`plugin-entry-invalidation-dispatch.ts` | `已达` |
| T13 | provider 受控通道 | `services/provider-write-proxy.ts`（`providers.write/delete/credential`） | `已达` 命名空间受限 |
| T14 | 双产物安装编排 | `services/wool-extension-installer.ts`（`IPluginServiceDeps.piExtensionInstaller`） | `已达` 版本配对校验 |

### 2.2 服务层 SPI（代码级扩展，需改本仓）

这些是**编译期 SPI**——不是插件能声明的，而是「新增一种 X」时的接入位。改造时要注意：它们是固定表 + 组合根装配，没有运行时可插拔能力。

| # | SPI | 契约 | 装配点 | 状态 |
|---|---|---|---|---|
| T15 | session 导入源 | `services/session/import-source.ts`（`SessionImportSource`） | `index.ts` 的组合根 source 表（当前 2 个：external-file / zcode） | `已达` 表格驱动 |
| T16 | subagent 引擎 | `packages/subagent-engine-sdk/src/port-contract.ts` | `subagent-core` 引擎注册 + `engines.json` | `已达` |
| T17 | RPC 消息域 | `transport/*-message-handler.ts` | `transport/server.ts` 静态注册 | `空壳` 每新增域必须改 server |
| T18 | 配额 fetcher | `services/quota-providers/` + `configs/remote/quota-fetchers.json` | 声明式引擎 `declarative-engine.ts` | `已达` 远程热更新 |
| T19 | provider 模板 | `configs/remote/builtin-providers.json` + `remote-config/` | 远程拉取 | `已达` 远程热更新 |
| T20 | TTS provider | `infra/tts/`（`base.ts` + 3 实装） | 固定表 | `空壳` 非表格驱动 |
| T21 | 插件清单目录（可安装插件列表） | `configs/remote/v2-plugins.json` | `plugin-catalog.ts` | `已达` 远程热更新 |

---

## §3 pi extension 层扩展点

跑在 pi 子进程内。契约 = `@earendil-works/pi-coding-agent` 的 `ExtensionAPI`（`dist/core/extensions/types.d.ts`）。

### 3.1 注册式扩展点

| # | API | 能力 | taiji 侧承接 | 状态 |
|---|---|---|---|---|
| P1 | `registerTool` | 模型可见的 tool | tool result 的 `details.__gui__` 经 `extractGui` 渲染 | `已达` 22 处使用 |
| P2 | `registerCommand` | slash 命令执行 | 声明副本进 taiji（`contributes.slashCommands`，ADR-0050） | `已达` |
| P3 | `registerShortcut` | 键盘快捷键（pi TUI 语义） | taiji 内**无承接**（键位体系独立） | `空壳` |
| P4 | `registerFlag` | CLI flag | taiji 内不适用 | — |
| P5 | `registerMessageRenderer` | custom message 渲染器 | `details.__gui__` 或 `customType` 分支（R39） | `受限` `customType` 需宿主预登记分支 |
| P6 | `registerEntryRenderer` | custom entry 渲染 | **无承接**（仅测试 mock 中占位） | `缺失` |
| P7 | `registerMarkdownTransformer` | user/assistant markdown 变换 | **无承接**（同上） | `缺失` |
| P8 | `registerProvider` | 注册模型 provider | 直接进 pi 模型注册表（不经 taiji） | `已达` 羊毛用此 |
| P9 | `registerMcpServer` | 运行时注册 MCP server | pi 连接 | `已达` |
| P10 | `addAutocompleteProvider` | 自动补全候选 | taiji `CommandPopover` 独立实现，不消费 | `空壳` |
| P11 | `on(<event>, handler)` | pi 生命周期事件（40+ 种） | 部分经 `event-adapter` 翻译为 WS 帧；其余由扩展自消费 | `已达` |

### 3.2 `ctx.ui.*`（pi 的 UI 表面，经 runtime 翻译）

| # | 方法 | runtime 处理 | 前端落点 | 状态 |
|---|---|---|---|---|
| P12 | `ctx.ui.select` | marker 检测 → 结构化帧（6 个 marker 分支）或普通 dialog | FormOverlay / PlanReviewBar / CompanionBand | `已达` |
| P13 | `ctx.ui.confirm` / `input` / `editor` | → `extension.ui_request` | `ExtensionUIDialog` | `已达` |
| P14 | `ctx.ui.notify` | → `extension:notify` | Toast | `已达` |
| P15 | `ctx.ui.custom` | 经 select marker 携带 GuiComponent/表单 | 同 P12 | `已达` |
| P16 | `ctx.ui.setWidget` | `GUI_WIDGET_MARKER` 解码 → `extension:widgetGui` | composer 托盘 widget 区（R37） | `已达` |
| P17 | `ctx.ui.setStatus` | **静默 noop**（状态栏退役，ADR-0141） | — | `空壳` 有意不承接 |
| P18 | `ctx.ui.setTitle` | 未知 method warn + noop | — | `空壳` |
| P19 | `ctx.ui.set_editor_text` | → `extension:setEditorText` | Composer | `已达` |
| P20 | `ctx.ui.theme` / `addAutocompleteProvider` | 部分使用 | taiji 内无对应 | `空壳` |

### 3.3 marker 协议（pi → taiji 结构化的唯一泛用通道）

契约 SSOT：`packages/extension-protocol/src/core/markers.ts` + `src/extensions/*/marker.ts`
分发：`packages/runtime/src/infra/pi/event-adapter.ts`

| # | marker | 生产者 | 分发处理 | 可降级 |
|---|---|---|---|---|
| P21 | `GUI_WIDGET_MARKER` | 各扩展 `setWidget` | widget 结构化 | `已达` |
| P22 | `ASK_USER_MARKER` | `pi-ask-user` | 提问表单 | `已达` |
| P23 | `UI_FORM_MARKER` | ask-user / scheduler / plan | 统一表单 | `已达` |
| P24 | `SCHEDULE_CREATE_MARKER` | `pi-scheduler` | 定时表单 | `已达` |
| P25 | `PLAN_REVIEW_MARKER` | `pi-plan` | 审阅条 | `已达` |
| P26 | `SESSION_MANAGER_MARKER` | `pi-session-manager` | runtime 内部消费 | `缺失` 无降级 |
| P27 | `CANVAS_MARKER` | `pi-canvas` | runtime 画布服务 | `缺失` 无降级 |
| P28 | `SUBAGENT_INFLIGHT_MARKER` | `pi-subagent-workflow` | 镜像 + ack，不广播 | `缺失` |
| P29 | `SUBAGENT_JOURNAL_MARKER` | `pi-subagent-workflow` | journal 路由 | `缺失` |

**新增 marker 的三件套**（缺一即静默降级成乱码对话框）：协议包常量 + runtime 表/分支登记 + 前端消费方。

### 3.4 pi extension 自身的分发/配置机制

| # | 机制 | 说明 | 状态 |
|---|---|---|---|
| P30 | 打包内置 | `packages/shared/src/mandatory-extensions.json`（`infrastructure` 不可禁 + `feature` 可禁）+ `scripts/bundle-extensions.mjs` → 构建期 staged 到应用资源目录下的扩展包集合（gitignored 产物，落点常量见 `scripts/bundle-extensions.mjs` 的 `STAGED_ROOT`） | `已达` |
| P31 | 远程热更新扩展 | `configs/remote/v2-plugins.json` 的 `piExtensionVersion` + `wool-extension-installer.ts` | `已达` |
| P32 | `pi.agents` / `pi.workflows` / `pi.skills` | 包内资源声明，经 `resource-discovery.ts` 七源扫描 | `已达` |
| P33 | 扩展配置 | 各扩展自己读 `~/.taiji/.../<ext>.json`（无统一 schema 注册机制） | `受限` 分散实现 |

---

## §4 三层缺口汇总

按「影响改造决策的程度」排序，每条附归因。

### 4.1 阻断级（改插件化前必须先修）

**G1. `contributes` 从 runtime 到 renderer 无通路**

- 事实：`packages/core/src/bootstrap.ts` 的 `scanContributions()` 调用 `loadExternal([])`（恒空数组）；`packages/shared/src/plugin.ts` 的 `PluginInfo`（`config.plugins` 广播载荷）**不含 `contributes`**。
- 归因：`loadExternal` 契约注释自述「s3 透传未完成」。
- 后果：只有 `builtin-contributions.ts` 里写死的三条（tasks / scheduler-manager / scheduler）能产生 renderer 贡献。**任何插件新声明的 view / headerAction / command 都不会出现在界面上**。
- 修复面：`PluginInfo` 加 `contributes` 字段（shared 协议）→ `plugin-info-mapper.ts` 透传 → renderer connected 边沿 `loadExternal`。

**G2. 插件 tool 不进 pi 工具表**

- 事实：`api.tools.register` → `toolRegistry`（`plugin-service.ts` 的 Map）；`agent.getActiveTools` 从该 Map 读；`grep` 全仓无「把 toolRegistry 转成 pi tool schema 下发」的代码。
- 后果：插件注册的 tool 模型永远看不见。
- 修复面：需要 pi RPC 侧支持运行时注册 tool（`pi-rpc` 是否有对应命令帧待核实），或改成 pi extension 承载。

**G3. 懒激活未闭环**

- 事实：`useExtensionHostBridge.ts` 注入 `ActivationManager({ trigger: { ensureActivated: async () => {} } })`；`registerActivationEvents` 生产零调用。
- 后果：`activationEvents` 的 `onSlashCommand:<name>` / `onToolCall:<name>` 推断逻辑（`plugin-registry.ts` `inferActivationEvents`）产出的值无人消费。

### 4.2 使「插件化」收益打折的（renderer 固定实现，对应第 3 步扫描）

| # | 区域 | 现状 | 可插件化方向 |
|---|---|---|---|
| G4 | 右抽屉 tab 集 | `core/src/domain/drawer/registry.ts` 的 `RIGHT_DRAWER_REGISTRY` 8 员写死（git/doc/detail/subagent/bashTask/plan/btw/trace）；`PanelContainer.vue` 8 分支 `v-else-if` | 抽屉 tab 作为挂载点（`drawer.tab` 已提名未注册），内容走 `ViewHost` |
| G5 | 底抽屉 / 浮层内容 | `core/src/domain/overlay/types.ts` `OverlayContent` 4 员写死（browser/workflow/scheduler/canvas）；`WorkflowVizOverlay.vue` 3 tab 写死 | 与 G4 同族：新增 kind 必须改 core 联合类型 |
| G6 | 侧栏 tab 集 | `stores/sidebar.ts` `SidebarTab = 'sessions' \| 'files' \| 'plugins'` 写死；`SegmentedTab.vue` 硬编码 3 tab | tab 集改为注册表驱动 |
| G7 | 设置页 nav | `SettingsModal.vue` 的 `navGroups` 硬编码 17 项（三分组） | `contributes.configuration` 已有契约但零消费（R11），可由此驱动 |
| G8 | 托盘面板族 | `useTrayCounts.ts` `TrayBuiltinKind` 联合写死；`TrayAggregatePanel.vue` 按 kind 三路分派 | 面板族改为插件声明 |
| G9 | tool 详情渲染 | `ToolDetailRenderer.vue` 按 `toolName === 'edit' / 'write' / 'read'` 硬编码分支 | 改为 tool 名 → 渲染器注册表（内置 + 插件可注册） |
| G10 | system/custom 消息渲染 | `SystemNotice.vue` 按 `customType` 硬编码分支 | 改为 `customType` → 渲染器注册表 |
| G11 | pi widget 排序 | `tray-order.ts` `TRAY_WIDGET_KNOWN_ORDER = ['todo','goal']` 硬编码 | 顺序应来自声明 |
| G12 | headerAction 分派特例 | `HeaderActionsHost.vue` 里 `activation === 'scheduler-overlay'` 专属分支 + `SchedulerQuickCard` 组件 | 泛化为「activation → 浮层 opener」注册表 |
| G13 | overlay opener | `core/src/domain/overlay/coordination.ts` 三个专用 opener（`openSchedulerOverlay` / `openCanvasOverlay` 等） | 泛化为声明驱动 |
| G14 | 全局快捷键 | key-orchestrator 硬编码表（见 R30） | 插件 `command.keybinding` 声明成真 |
| G15 | custom GuiComponent | `GUI_CUSTOM_REGISTRY_KEY` 无 provide 点（R22） | 壳装配时 provide builtin 注册表 |

### 4.3 契约已声明但零实现

| # | 项 | 事实 |
|---|---|---|
| G16 | `contributes.menus` | 解析为 `menu` 记录后无任何 `getContributions({type:'menu'})` 调用 |
| G17 | `contributes.configuration` | 同上，设置页无 schema 驱动表单 |
| G18 | `events.on/emit`（插件间总线） | 调用即抛 `NOT_IMPLEMENTED` |
| G19 | `custom` GuiComponent | 见 G15 |
| G20 | 移动壳挂载点 | `packages/mobile-renderer` 零 `MountPointRegistry` 引用 |
| G21 | `command.keybinding` | 解析进 `CommandRecord` 但无消费（键位系统独立） |
| G22 | hook 死类型 | `InterceptorHookType` 的 `onToolCall` / `onSlashCommand` / `onMessageSend` 无注册方法（`hook-api.ts` 只暴露 4 个），属死类型残留 |

---

## §5 改造前必读的约束

改造任何一层前，以下约束会直接决定方案可行性：

| 约束 | 内容 | 出处 |
|---|---|---|
| C1 | 拉为主、推补充——功能域**禁止**写推送补偿（定时重拉 / 本地重建） | ADR-0097 |
| C2 | 事实驱动——状态判定锚定确定性事实（回执/断连/同步查询），禁时间推测 | ADR-0122 |
| C3 | GuiComponent `custom` 逃生口仅 builtin；原语不足时补原语，不放开 custom | `renderer-package-topology.md` §5.3 |
| C4 | per-session 状态必须用 `useSessionScopedState` Map 分区范式 | ADR-0049 |
| C5 | pi 词汇（import / 事件名 / 方法名）只允许出现在合法持有点清单内 | ADR-0126 |
| C6 | 新增原语五处同步（类型+组件+视觉+路由+ANSI 降级） | `extension-gui-protocol.md` §15.3 |
| C7 | sandbox 真隔离落地前，external 插件安装开关不得打开（builtin 不受限） | `renderer-package-topology.md` §4.4 |
| C8 | 时间平抑类逻辑默认视为通道缺陷症状，出现前须答「为何不能靠事件顺序/单一事实源解决」 | 项目 AGENTS.md 关键规则 |

---

## §6 相关文档

- 架构总览：[architecture.md](architecture.md)
- 写内置插件：[built-in-plugin-guide.md](built-in-plugin-guide.md)
- GuiComponent 协议：[extension-gui-protocol.md](../architecture/extension-gui-protocol.md)
- pi extension GUI 接入：[extensions/gui-protocol-guide.md](../extensions/gui-protocol-guide.md)
- pi extension 开发：[extensions/development-guide.md](../extensions/development-guide.md)
- Renderer 分层：[renderer-package-topology.md](../architecture/renderer-package-topology.md)
- 约束登记表：`docs/constraints.json`

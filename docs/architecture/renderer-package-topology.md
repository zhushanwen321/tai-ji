# Renderer 终态包拓扑（SSOT）

> **状态**：renderer 架构现行 SSOT——§2 包拓扑 / §3 core 分层。2026-08 重做期的现状评判、逐域绞杀迁移策略、成本评估、旧层映射表已删除（git 可追溯；P1–P3 迁移已落地，P4 ExtensionHost 已交付）。原文件名 `renderer-package-topology.md`，2026-09-13 改名（去掉 rebuild 动作名，名即主题）。
>
> **核心判断（保留三条活规则）**：① **以包为层，不以目录为层**——分层约束由 pnpm workspace 包边界 + lint 物理强制，不靠自觉；② **想共享就下沉，不想下沉就各自实现**——壳之间禁止互相 import，共享只能经 core/ui 下沉，这是显式决策点（取代旧 sync-copy 的隐性契约）；③ core 不含 .vue 文件、不触 DOM，但允许 Vue reactivity（双端同为 Vue 3，强行框架无关化是过度工程）。

---

## §1 终态包拓扑

```
packages/
  shared/                # 跨进程协议 DTO（renderer/runtime 共享类型 SSOT）
  extension-protocol/    # GuiComponent 协议包
  plugin-sdk/            # plugin API 契约

  core/                  # ★ 平台无关内核（headless）
    # Vue reactivity 可用，零 DOM、零 electron、零浏览器 API 假设
    # （localStorage/WebSocket 等经 PlatformPort 注入，见 §6）

  ui/                    # ★ 跨端共享 Vue 组件库
    # ui 原语（shadcn-vue 风格）+ RenderingProtocol 渲染器 + message-stream + 共享 feature view

  renderer/              # 桌面壳
    # Shell/Workspace 布局 + 桌面独占 view + ElectronPlatformAdapter + vite 入口

  mobile-renderer/       # 移动壳
    # 移动布局 + MobilePlatformAdapter + vite 入口

  runtime/               # pi 适配 + plugin-service + transport 服务器
```

**依赖方向（包管理器强制）**：

```
shared ◄── extension-protocol
shared ◄── core ◄── ui ◄── renderer（桌面壳）
                    └◄── mobile-renderer（移动壳）
shared ◄── runtime
```

- `core` 不 import `ui`（headless 不依赖组件）；`ui` 可 import `core`（组件读 store/composable）。
- 壳不互相 import；`core`/`ui` 内零 `node:`、零 `window.electronAPI`、零直接 `localStorage`/`WebSocket` 调用（经 PlatformPort）。lint 强制（`no-restricted-imports` + 边界检查）。

### 1.1 core 内允许 Vue reactivity 的理由

Pinia store 和 composable 是 headless 逻辑的最佳载体，强行「框架无关化」（纯 TS 状态机 + 适配层）是过度工程。约束只有一条：**core 不含 .vue 文件、不触 DOM**。effects 中触 DOM 的（useVirtuaFollow / useMermaidZoom 等）不下沉，留在 ui 或壳。

---

## §2 core 内部分层设计

七个概念层在新包拓扑里的归位——**层不再是目录，而是 core/ui/壳 三个包内的分区**：

| 概念层 | 归位 | 说明 |
|---|---|---|
| Shell | `renderer/src/shell/` + `mobile-renderer/src/shell/` | 各端自己的壳：窗口拓扑、view 路由、快捷键 |
| Workspace | `renderer/src/workspace/` + 移动对应物 | 双 panel/drawer 容器是桌面形态 |
| Feature | `core/src/domain/*/` | **业务域 headless 化**：每域 = store + composable + logic 内聚一个目录。实施终态（2026-09-12 核验）：实际 `core/src/domain` = chat / composer / drawer / new-task-search / session / session-trace / settings；跨端共享的组件进 `ui/src/features/<域>/`，桌面独占的留壳 |
| ExtensionHost | `core/src/extension-host/`（headless）+ `ui/src/extension-host/`（ViewHost 等渲染件） | 见 §4 |
| RenderingProtocol | `core/src/rendering-protocol/`（类型/注册/降级逻辑）+ `ui/src/rendering-protocol/`（原语组件） | 见 §5 |
| T&C | `core/src/transport/` + `core/src/coordination/` | 连接与协同，见 §3 |
| Foundation | `core/src/foundation/`（useSessionScopedState / event 通道 / 基础设施 store）+ `ui/src/primitives/` | |

### 2.1 依赖铁律（包级强制）

单向：Shell → Workspace → Feature(domain) → ExtensionHost → RenderingProtocol → T&C → Foundation。跨越规则：

- domain 不直接 import `core/transport` 的 ws-client——经 `coordination` 的连接层 / RPC domains。
- store 零跨域 import、零 import composable。跨 store 编排只存在于 domain 的 effects 模块或 coordination 层。
- ExtensionHost 不 import domain 内部——它只面对 RenderingProtocol + 挂载点注册表（§4.3）。

### 2.2 per-session 隔离内建（ADR-0049）

- `useSessionScopedState` 在 `core/foundation/`，所有 per-session composable 强制使用（防护 = ADR-0049 Code Review Checklist + taste-lint `no-instance-level-session-state`）。
- **显式例外只有两个**：presence（全局协同态）与 lease（runtime TTL 管控），住 `core/coordination/`，文件头标注例外依据。
- `triggerSessionCleanups(id)` 订阅 `session.deleted` 广播，保证他端删 session 时本地分区同步清除。

### 2.3 消息链路

```
ws-client（transport：连接/握手/seq/RTT）
  → routeInbound（coordination：声明式 ROUTE_TABLE，查表+执行，零业务内联）
     ├─ RPC 响应 → pending resolve/reject（error envelope 在此展开，不进路由表）
     ├─ session 通道 → seq gap 中间件 → dispatchSession → 各域 effect（domain/*）
     └─ global 通道 → dispatchGlobal → 全局 effect（presence/config/plugin 等）
```

routeInbound 只做三件事：pending 分流、seq 中间件、查表执行。**新增 server-push 消息类型 = 加一行路由表条目 + 一个 handler，不动路由核心**。

### 2.4 T&C 双模式与多端的关键约束

1. **连接发现策略可插拔**：本地 = IPC 端口发现（经 PlatformPort），远程 = profile（storage 经 PlatformPort），mock = VITE_MOCK。init() 分支在 coordination 一处，壳不感知。
2. **可靠投递语义不进 domain**：seq gap/reconcile/seqReset→reload 全部在 transport+coordination。domain store 只面对「已排序、已去重的消息流」。
3. **send.rejected 是 reply 点对点**，不回退广播语义。
4. **presence 弱可靠通道**：不入 seq 桶、靠 auth.ok/presence.list 兜底——在 `coordination/presence.ts` 注释并测试锁定，防未来误「修复」成入桶。
5. **mobile 无 MANUAL_FORK**：移动壳的 connection-lifecycle 就是 coordination 的一个 mode（`platform: 'mobile'` 时本地分支不注册）。

---

## §3 ws-client 与迁移边界（历史裁决，保留约束）

- **ws-client 不预拆**：P1 从 remote-use 原样整体迁入，拆分后置按实测耦合定边界；不变量从「本地模式逐字节不变」修正为**「特征测试覆盖的关键行为不变」**（连接状态机/auth 握手/close code 分流/seq 回放/重连退避）——规格沉淀于 `packages/core/src/transport/__tests__/ws-client.invariants.test.ts` 头部注释（现行 SSOT）。
- **PlatformPort 收敛裁决**：不为假设中的 web 版预付全量抽象——P0 只做 storage/websocket/ipc 三端口，其余保留隐式降级、迭代收编（每 domain 迁移波次顺手收编，不设独立大波次）。终态规则：core 内禁止直接出现 `window.electronAPI` / `localStorage` / `new WebSocket`——lint 强制。

---

## §4 ExtensionHost 层

### 4.1 组成（core/src/extension-host/，headless）

```
extension-host/
  contribution-registry.ts   # 扫描 plugin manifest，注册声明式贡献（views/menus/commands/statusBarItems/slashCommands/configuration）
  activation-manager.ts      # 懒激活：activationEvents → 触发 runtime 激活
  command-registry.ts        # 统一命令表：命令面板 + 快捷键 + slash + 菜单按钮的唯一来源
  status-bar-controller.ts   # 状态项聚合（pi setStatus + plugin statusBarItems 统一），per-session/global 两 scope
  message-bus-bridge.ts      # plugin:* 下行消息族 → renderer 内部事件
  overlay-lifecycle.ts       # companion overlay 状态机：expanded → minimized(badge) → restored，per-session + per-requestId
  mount-point-registry.ts    # ★ 壳向 ExtensionHost 注册可用挂载点（见 4.3）
  view-host-store.ts         # plugin view 的 GuiComponent 树缓存（per viewId，per-session 分区）
```

渲染件（ui/src/extension-host/）：`ViewHost.vue`、`StatusBar.vue`（main-panel 局部底栏）、`PluginSettingsPage.vue`、`PermissionRequestDialog.vue`。

提问表单渲染面（renderer/src/components/extension/form/，桌面壳）：`FormOverlay.vue`（壳：表头 / 多问 tab 条 / Submit 门 / 取消）+ `ChoiceQuestion.vue` / `TextQuestion.vue` / `ScheduleForm.vue` 三类型渲染器——统一提问表单协议（ui-form，ask-user / scheduler / plan 三方提问收口）的 GUI 唯一渲染面，Panel 内联覆盖 composer 挂载。

### 4.2 三套 UI 接口统一（pi ctx.ui × plugin api.ui × GuiComponent）

| 统一项 | 方案 |
|---|---|
| 对话框原语 | pi `ctx.ui.select/confirm/input` + plugin `api.ui.showSelect/Confirm/Input` → 统一 `DialogRequest` 内部协议，渲染统一走 companion-band |
| 状态展示 | pi `setStatus` + plugin `updateStatusBarItem` → 统一 StatusBarController。**信息流向**：只消费「runtime 广播的消息」，不主动读 domain store（与 §2.1「ExtensionHost 不 import domain」一致） |
| 结构化渲染 | 统一 GuiComponent（§5） |
| 提问表单 | 统一表单协议（ui-form，select + `UI_FORM_MARKER` 双向通道）：ask-user / scheduler / plan 三方提问收口一个入口（`uiFormInteract`）+ 一个渲染器（renderer FormOverlay），覆盖 composer 挂载；不并入单向 GuiComponent（需等用户回传） |
| overlay lifecycle | plugin 只 await 结果，不感知 expanded/minimized/restored；状态机集中在 overlay-lifecycle.ts |

### 4.3 挂载点注册表（desktop 全集 vs mobile 子集）

**挂载点不是硬编码在 ExtensionHost，而是由壳注册**：桌面壳 bootstrap 注册 sidebar.tab / panel.header.action / composer.toolbar / statusbar 等；移动壳只注册 message-stream / slash / companion。ContributionRegistry 把 plugin 声明按类型路由到对应挂载点——mobile 天然获得子集，无需 if-else 特判；未来新形态只写自己的挂载点注册。

**Plugin DX**：挂载点未注册 ≠ 静默失败——打 warning 日志（含 plugin id + contribution id + 期望挂载点），管理页对不可用 contribution 置灰；提供 `api.views.listMountPoints()` 让 plugin 自行降级。

### 4.4 plugin-sdk 主干化硬锁（runtime/sdk 侧前置约束）

1. **sandbox 真隔离**：external/third-party 插件的安装与激活开关，必须在 sandbox 真隔离落地后才允许打开（builtin 插件是自有代码不受影响）。落地状态以 `plugin-bootstrap-process.ts` / `plugin-sandbox.ts` 实装为准。
2. **API 稳定性分层 + Object.freeze**：stable/proposed/internal——freeze 是主干化冻结点；时序 = 2 个缺口 API（commands.register / views.update）落地之后、收尾前完成。

---

## §5 RenderingProtocol 层

### 5.1 定位

GuiComponent 是**一切非 renderer 进程内容的统一渲染协议**——pi extension（pi 子进程）和 plugin（Worker/fork）都只能在 WS 上传可序列化数据，用同一套协议。协议本体 SSOT：[extension-gui-protocol.md](extension-gui-protocol.md)（协议包）+ `packages/extension-protocol/src/`（代码）。

### 5.2 组成

- `core/src/rendering-protocol/`：类型 re-export、`extractGui` 校验、未注册 type → AnsiText 降级、custom 注册表（provide/inject，builtin-only）
- `ui/src/rendering-protocol/`：单一渲染入口 + 原语组件（按 v6 token 原生视觉）

### 5.3 协议演进纪律

- **custom 逃生口仅 builtin**（编译期 provide 注册），external plugin 强制原语。原语不够时**补原语**，不放开 custom。
- 新原语 = extension-protocol 类型 + ui 渲染组件 + v6 视觉 + ANSI 降级 四同步，走 proposed → stable 流程。
- **ANSI 兜底永留**：未引入 extension-protocol 的 pi extension 开箱即用是兼容性铁律（pi 生态是基本盘）。

---

## §6 平台适配层 PlatformPort

```ts
// core/src/platform/port.ts
interface PlatformPort {
  readonly kind: 'electron' | 'mobile' | 'web' | 'mock'
  storage: KVStorage                 // localStorage / 内存 Map
  webSocket: WebSocketFactory        // 浏览器原生 / mock
  ipc: IpcBridge | null              // electronAPI 全集；非 electron 为 null
  // 其余（notify/sound/clipboard/filePicker/terminal…）：迭代收编区，沿用隐式降级
}
```

core 通过模块级 `providePlatform(port)` 在壳 bootstrap 时注入（先注入后 initApp，测试注入 MockPlatform）。桌面壳的 ElectronPlatformAdapter 与移动壳的 MobilePlatformAdapter 各自实现。

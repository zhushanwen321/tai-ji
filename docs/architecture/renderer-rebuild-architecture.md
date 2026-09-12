# xyz-agent Renderer 重做：完整评估与终态架构方案

> **创建**：2026-08-03 · **v2 修订**：2026-08-03（吸收两份开发者审查，修订记录见附录 B）
> **性质**：评估 + 终态设计 + 迁移方案。基于对现状代码、feat-remote-use 分支、plugin 体系的实测调研（3 路 explorer 交叉验证 + 2 轮独立审查复核）。
> **已确认前提**（与用户对齐）：
> 1. **renderer 全新实现**——不动旧层，但需给出旧层映射迁移方案
> 2. **pi extension 不进 renderer**——沿用 WS 数据通道，runtime 适配层不动，新 renderer 只负责消费（RenderingProtocol / ExtensionHost）
> 3. **mobile-renderer 纳入共享层设计**——renderer 拆为平台无关 core + 双端壳，取代 sync-copy 机制

---

## 目录

- §1 现状评判（定量 + 定性）
- §2 核心判断（6 条）
- §3 终态包拓扑（core / ui / desktop / mobile）
- §4 core 内部分层设计（七层归位到包结构）
- §5 T&C 层：feat-remote-use 能力内建设计
- §6 ExtensionHost 层：plugin 架构完整支持
- §7 RenderingProtocol 层：统一渲染协议
- §8 pi extension 消费通道（不动 runtime 的边界）
- §9 平台适配层 PlatformPort
- §10 旧层 → 新架构映射表
- §11 迁移与实施策略（逐域绞杀为主线）
- §12 风险与诚实的成本评估
- §13 与现有文档/决策的关系（采纳 / 修订 / 推翻）
- 附录 A 调研依据 · 附录 B v2 修订记录（含对审查意见的事实复核）

---

## §1 现状评判

### 1.1 总体判断

**顶层架构（进程拓扑 / 包依赖 / 通信边界）是优秀的，问题全部集中在 renderer 内部。** 具体来说：main 是壳、runtime 是唯一 pi 适配点、renderer 零 `node:` 导入、包依赖单向无环——这些不用动。要重做 renderer，不是因为它"烂"，而是因为它的内部组织结构承载不了三个即将到来的重量：feat-remote-use 的 T&C 复杂度、plugin 架构的完整落地、mobile 双端共享。

### 1.2 定量画像（实测，v2 复核修正）

| 维度 | 数字 | 评价 |
|---|---|---|
| 总规模 | **生产代码 55,396 行**（components 26k + composables 19k + stores 5.6k + api 4.4k + i18n 2.7k + 其余 ~2k）+ **测试 53,185 行**（src/__tests__ 53,086 + colocated 99），合计约 **10.9 万行** | 中大型前端。注意：生产代码约 5.5 万行，「10.8 万」是生产+测试合计口径，引用时勿混用 |
| stores | 30 文件。chat 域 11 文件集群 **2,610 行**（chat.ts 906 + chat-message-effects.ts 737 为最大两块） | chat 集群已做过一轮拆分，是其他域的模板；但两个巨型文件仍是编排与状态混杂 |
| composables | **118 个生产文件**（126 含测试），7 种组织范式并存（根级 12 / features 平铺 41 / panel 平铺 37 / logic / effects / new-task / terminal） | 组织失序是最大表面问题；features/panel 两巨型桶无业务域分组 |
| api 层 | transport/pending/events/request/domains 分层清晰（15 domains 1,552 行统一走 `command<K>()`） | **这是好地基，原样继承** |
| routeInbound | useConnection.ts:95-198，if-else 串联 + 硬编码兜底，直触 6 个 store | **结构最差的关键路径**，且 remote-use 已往里塞了 6 个新分支，是合并冲突第一热点 |
| ws-client | main 上 262 行 → remote-use 上 807 行，17 条不变量 + auth/seq/RTT 三状态堆在单文件模块级 | remote-use 让它从简单连接骨架变成最复杂的模块，且全是模块级可变状态 |
| Composer | import 20 个 composable，useContenteditableInput 873 行上帝模块 | 上帝模块典型 |
| ADR-0049 | 13 个生产文件已迁移 Map 分区派，无 watch 清理反模式残留；残留少数模块级 Map（useChat streamSubscriptions 等） | 范式正确且已过半，重写时内建即可 |
| plugin renderer 侧 | 仅 api/domains/plugin.ts 16 行骨架，**无任何消费者**；**9 个下行消息全部零订阅**（`plugin:uiRequest`/`statusBarUpdate`/`crashed`/`permissionRequest`/`notification`/`messageDecoration`/`statusSetUpdate`/`config`/`statusChange`）；contributes.panels/statusBarItems 零消费 | **完全空白**，不是"欠完善"是"不存在" |
| pi extension 消费 | 散布 5+ 处（useDrawerWidgetBuffers / SideDrawer / registry.ts / chat-message-effects / Block.vue） | 功能成熟但无宿主层概念 |
| 测试 | 293 文件（271 集中 + 22 colocated），coverage gate 硬编码（lines 72 / branches 59）；大量断言内部调用/mock spy | 数量够，质量分层不足；重写时内部断言型测试必然大量作废，这本来就是既定方针 |

### 1.3 定性诊断（4 条根因）

1. **没有"层"的物理约束**。七层架构目前只是文档和文件头 JSDoc，目录结构不表达它（features 41 文件平铺），import 规则无工具强制。结果是依赖方向靠自觉——chat-message-effects 一个 store 反向 import composable（useSideDrawer）就是证明。
2. **消息分发没有注册表**。routeInbound 是唯一入口且是 if-else 大函数，每加一个 server-push 消息类型都要改它。main 在加（subagents/workflow 兜底），remote-use 也在加（busy/idle/presence/deleting/deleted），这是两个分支最确定的冲突点。
3. **扩展消费没有宿主**。pi extension 的 UI 消费散在 5 处，plugin 的 contribution 消费是零——因为架构里根本没有"ExtensionHost"这个位置，贡献物无处归位。
4. **跨端共享靠 shell 脚本 copy**。sync-mobile-from-renderer.sh 的 COPY_MAP + MANUAL_FORK 是"目录结构必须冻结"的隐性契约（useConnection.ts 路径锁定），任何重组都会断 mobile——这直接锁死了重构空间。

### 1.4 结论

缝补路线（B1-B9）能解决 1 和 2 的一部分，但解决不了 3（要从零建 ExtensionHost）和 4（要改包拓扑），而且缝补全程要和 remote-use 的 98 commits 缠斗在同文件冲突里。**四个根因有三个是结构性的，结构性问题用结构方案解：重做，且一次把包拓扑做对。**

---

## §2 核心判断（6 条）

1. **以包为层，不以目录为层**。当前"七层"落在 packages/renderer 内部目录上，无物理约束。终态把分层升级为 pnpm workspace 的包边界——`core` 包物理上无法 import electron、无法 import 桌面壳组件，依赖铁律由包管理器 + lint 强制，不靠自觉。
2. **feat-remote-use 不是"要预留的扩展"，是重做的地基**。远程化已交付（**98 commits 领先 main**，P0-P7 全交付），它的 ws-client 807 行、routeInbound 新分支、presence/lease、mobile-renderer 就是 T&C 层的 V1 实现。重做直接以 remote-use 合并后的 main 为基线，把 T&C 能力**内建**进 core，而不是在旧 renderer 上"预留接口"。
3. **plugin 支持的最大工作量在 renderer，且几乎全是新建**。协议族（10 上行 + 9 下行 WS 消息）和 runtime plugin-service（5,746 行，Worker 隔离/hook 管线/热重载）已完整，缺的是 renderer 的整个 ExtensionHost 层 + 2 个 API（commands.register / views.update）+ UI 接口统一。这不是"适配"，是"建层"。
4. **pi extension 链路保持不动，渲染协议统一**。runtime 的 event-adapter / message-converter 不动；renderer 侧把 GuiComponent 从"pi extension 专用渲染"提升为"pi extension + plugin 共享的渲染协议层"，pi 的 ctx.ui 和 plugin 的 api.ui 统一为一套 DialogRequest/StatusBar 协议消费。
5. **mobile 共享的方式是"共享包"，不是"共享目录"**。sync-copy 机制删除。core 包（headless：stores/composables/api/ws-client/协调逻辑，零 DOM）+ ui 包（跨端 Vue 组件：原语/message-stream/GuiComponentRenderer），桌面壳和移动壳各自只做布局与平台适配。
6. **视觉与架构一次成型**。重写即按 v6 太极 token 原生构建（demo `.tmp/v6/` 是活验证层），不做"v3 重写一遍再升 v6"的两遍工。阶段 C 视觉波次概念被重写吸收。

---

## §3 终态包拓扑

```
packages/
  shared/                # 不变：跨进程协议 DTO（renderer/runtime 共享类型 SSOT）
  extension-protocol/    # 不变：GuiComponent 协议包（npm 已发布）
  plugin-sdk/            # 需演进：见 §6.6（API 分层 + freeze + 发布决策）

  core/                  # ★ 新增 ★ 平台无关内核（headless）
    # Vue reactivity 可用（双端都是 Vue），零 DOM、零 electron、零浏览器 API 假设
    # （localStorage/WebSocket 等经 PlatformPort 注入，见 §9）

  ui/                    # ★ 新增 ★ 跨端共享 Vue 组件库
    # ui 原语（xyz-ui fork）+ RenderingProtocol 渲染器 + message-stream + 共享 feature view

  renderer/              # 桌面壳（现 packages/renderer 的继任者）
    # Shell/Workspace 布局 + 桌面独占 view + ElectronPlatformAdapter + vite 入口

  mobile-renderer/       # 移动壳（继承 feat-remote-use 的 mobile-renderer）
    # 移动布局 + MobilePlatformAdapter + vite 入口

  runtime/               # 不变（pi 适配 + plugin-service + transport 服务器）
```

**依赖方向（包管理器强制）**：

```
shared ◄── extension-protocol
shared ◄── core ◄── ui ◄── renderer（桌面壳）
                    └◄── mobile-renderer（移动壳）
shared ◄── runtime
```

- `core` 不 import `ui`（headless 不依赖组件）；`ui` 可 import `core`（组件读 store/composable）。
- 壳不互相 import。壳之间的共享只能经 `core` / `ui` 下沉——这就是"想共享就下沉，不想下沉就各自实现"的显式决策点，取代 COPY_MAP 的隐性契约。
- `core`/`ui` 内零 `node:`、零 `window.electronAPI`、零直接 `localStorage`/`WebSocket` 调用（经 PlatformPort）。lint 规则强制（`no-restricted-imports` + 边界检查）。

### 3.1 为什么 core 里允许 Vue reactivity

mobile-renderer 与桌面壳同为 Vue 3（feat-remote-use 实测）。Pinia store 和 composable 是 headless 逻辑的最佳载体，强行"框架无关化"（纯 TS 状态机 + 适配层）是过度工程。约束只有一条：**core 不含 .vue 文件、不触 DOM**。effects 中触 DOM 的（useVirtuaFollow / useMermaidZoom 等 9 个）不下沉，留在 ui 或壳。

---

## §4 core 内部分层设计

七层架构（renderer-target-architecture.md §2）的概念全部保留，但在新包拓扑里重新归位——**层不再是 renderer 里的目录，而是 core/ui/壳 三个包内的分区**：

| 原七层 | 新归位 | 说明 |
|---|---|---|
| Shell | `renderer/src/shell/` + `mobile-renderer/src/shell/` | 各端自己的壳：窗口拓扑、view 路由、快捷键。桌面 AppShell/AsideRegion/traffic-light；移动底部 tab |
| Workspace | `renderer/src/workspace/` + 移动对应物 | 双 panel/drawer 容器是桌面形态；移动端自己的导航容器 |
| Feature | `core/src/domain/*/` | **业务域 headless 化**：每域 = store + composable + logic 内聚一个目录（chat/ session/ composer/ sidebar/ settings/ search/ new-task/ drawer/）。域内组件分两类：跨端共享的进 `ui/src/features/<域>/`，桌面独占的留壳。实施终态（2026-09-12 核验）：实际 `core/src/domain` = chat / composer / drawer / new-task-search / session / session-trace / settings（sidebar 未独立成域、search 与 new-task 合并为 new-task-search、新增 session-trace） |
| ExtensionHost | `core/src/extension-host/`（headless）+ `ui/src/extension-host/`（ViewHost 等渲染件） | 见 §6 |
| RenderingProtocol | `core/src/rendering-protocol/`（类型/注册/降级逻辑）+ `ui/src/rendering-protocol/`（7 原语组件） | 见 §7 |
| T&C | `core/src/transport/` + `core/src/coordination/` | 见 §5 |
| Foundation | `core/src/foundation/`（useSessionScopedState / event 通道 / 基础设施 store）+ `ui/src/primitives/`（xyz-ui fork 原语） | |

### 4.1 依赖铁律（同原设计，包级强制）

单向：Shell → Workspace → Feature(domain) → ExtensionHost → RenderingProtocol → T&C → Foundation。跨越规则：

- domain 不直接 import `core/transport` 的 ws-client——经 `coordination` 的 `useConnection` / RPC domains。
- store 零跨域 import、零 import composable（现违规：chat-message-effects → tasks/panel/useSideDrawer）。跨 store 编排只存在于 domain 的 effects 模块或 coordination 层。
- ExtensionHost 不 import domain 内部——它只面对 RenderingProtocol + 挂载点注册表（§6.3）。

### 4.2 per-session 隔离内建

ADR-0049 原样继承并强化：

- `useSessionScopedState` 在 `core/foundation/`，所有 per-session composable 强制使用（原计划的 ESLint 自定义规则——禁止模块级 `new Map<string, ...>` 存 session 状态——已被 [ADR-0049](../../adr/0049-session-isolation-map-partition.md) spec_review D4 放弃：AST 判定 ref/let 是否 per-session 语义铺天盖地误报，不可行；现行防护 = ADR-0049 Code Review Checklist + taste-lint `no-instance-level-session-state`）。
- **显式例外只有两个**：presence（全局协同态）与 lease（runtime TTL 管控），住 `core/coordination/`，并在文件头标注例外依据。
- `triggerSessionCleanups(id)` 订阅 `session.deleted` 广播（remote-use 已引入的两步删除），保证他端删 session 时本地分区同步清除。

### 4.3 消息链路（新）

```
ws-client（transport：连接/握手/seq/RTT）
  → routeInbound（coordination：声明式 ROUTE_TABLE，查表+执行，零业务内联）
     ├─ RPC 响应 → pending resolve/reject（error envelope 在此展开，不进路由表）
     ├─ session 通道 → seq gap 中间件 → dispatchSession → 各域 effect（domain/*）
     └─ global 通道 → dispatchGlobal → 全局 effect（presence/config/plugin 等）
```

routeInbound 只做三件事：pending 分流、seq 中间件、查表执行。所有"消息到了该干什么"在 domain effect 或 coordination handler 里。**新增 server-push 消息类型 = 加一行路由表条目 + 一个 handler，不动路由核心**——这条直接消除 main × remote-use 的第一冲突热点。

---

## §5 T&C 层：feat-remote-use 能力内建设计

remote-use 的代码是 T&C 的 V1，但组织形态要升级（它是在旧 renderer 约束下长出来的）。迁移时按以下结构落位：

### 5.1 transport/（连接骨架）

| 模块 | 来源 | 说明 |
|---|---|---|
| `ws-client.ts` | remote-use `lib/ws-client.ts`（807 行） | **P1 先原样整体迁入，不预拆**。auth/seq/RTT 三者经模块级状态紧耦合，架构层预定 4 模块边界（v1 方案）可能制造更隐蔽的跨文件耦合——迁入后按实际耦合测量再定拆分边界（拆分是 P1 之后的独立小步，非前置）。不变量从 v1 的"本地模式逐字节不变"修正为**"特征测试覆盖的关键行为不变"**（连接状态机/auth 握手/close code 分流/seq 回放/重连退避），逐字节约束无法用测试锁定，不可执行 |
| `remote/` | remote-use `lib/remote/` 5 文件原样迁入 | connection-config / parse-connect-info / probe / ws-origin / types。probe 与 ws-client 共用 `buildAuthMessage` 的约束保留（防漂移测试随迁） |
| `pending.ts` / `events.ts` / `request.ts` / `domains/` | 现 api/ 层原样继承 | 这层本来就是好地基，不动 |
| `terminal-reconnect-signal.ts` | remote-use 原样迁入 | |

### 5.2 coordination/（协同与路由）

| 模块 | 来源 | 说明 |
|---|---|---|
| `route-inbound.ts` | 新建（ROUTE_TABLE 模式） | remote-use routeInbound 的全部分支（含 busy/idle/presence/deleting/deleted）落成路由表条目 |
| `seq-gap.ts` | 从 routeInbound 抽出 | gap 检测/reconcile 纯函数中间件 |
| `presence.ts` | remote-use `stores/presence.ts` | 全局协同态 store（ADR-0049 显式例外） |
| `lease.ts` | 从 routeInbound if-else 抽出 | session.busy/idle → session store 的 setSessionBusy/clearSessionBusy；acquire/release/过期清理 |
| `connection-lifecycle.ts` | remote-use `useConnection.ts` 拆分 | init 三分支（mock/远程/本地）、模式切换 reload、visibility 重连、finalizeAllStreaming(disconnect) 兜底、retryRuntime 分模式 |
| `subscribed-sessions.ts` | remote-use syncSubscribedSessions | panel 活跃 session 列表 → ws-client 重连 auth 携带 |

### 5.3 双模式与多端的关键约束（内建，非补丁）

1. **连接发现策略可插拔**：本地 = IPC 端口发现（经 PlatformPort），远程 = profile（storage 经 PlatformPort），mock = VITE_MOCK。init() 分支在 coordination 一处，壳不感知。
2. **可靠投递语义不进 domain**：seq gap/reconcile/seqReset→reload 全部在 transport+coordination。domain store 只面对"已排序、已去重的消息流"。reload 前静默窗口逻辑随 ws-client 迁移。
3. **send.rejected 已是 reply 点对点**（remote-use 语义变更），新链路按此建模，不回退广播语义。
4. **presence 弱可靠通道**：不入 seq 桶、靠 auth.ok/presence.list 兜底——在 coordination/presence.ts 注释并测试锁定，防未来误"修复"成入桶。
5. **mobile 无 MANUAL_FORK**：移动壳的 connection-lifecycle 就是 coordination 的一个 mode（`platform: 'mobile'` 时本地分支不注册），不再有"人工砍掉本地分支的 fork 文件"。这是包共享取代 sync-copy 的最大红利。

---

## §6 ExtensionHost 层：plugin 架构完整支持

这是新架构里**新建量最大**的层。现状：runtime plugin-service 完整（5,746 行）、协议族完整、renderer 消费为零。

### 6.1 组成（core/src/extension-host/，headless）

```
extension-host/
  contribution-registry.ts   # 扫描所有 plugin manifest，注册声明式贡献（views/menus/commands/statusBarItems/slashCommands/configuration）
  activation-manager.ts      # 懒激活：activationEvents（onView/onCommand/onSlashCommand/onStartupFinished/onSessionCreate）→ 触发 runtime 激活
  command-registry.ts        # 统一命令表：命令面板 + 快捷键 + slash + 菜单按钮的唯一来源
  status-bar-controller.ts   # 底栏状态项聚合（pi setStatus + plugin statusBarItems 统一），per-session/global 两 scope
  message-bus-bridge.ts      # plugin:* 下行消息族（uiRequest/statusBarUpdate/crashed/permissionRequest/notification/...）→ renderer 内部事件
  overlay-lifecycle.ts       # companion overlay 状态机：expanded → minimized(badge) → restored，per-session + per-requestId
  mount-point-registry.ts    # ★ 新机制 ★ 壳向 ExtensionHost 注册可用挂载点（见 6.3）
  view-host-store.ts         # plugin view 的 GuiComponent 树缓存（per viewId，per-session 分区）
```

渲染件（ui/src/extension-host/）：`ViewHost.vue`（plugin view 宿主，交给 GuiComponentRenderer）、`StatusBar.vue`（main-panel 局部底栏）、`PluginSettingsPage.vue`（插件管理页，现 Settings 里也没有，需新建）、`PermissionRequestDialog.vue`。

### 6.2 必须补的 2 个 API + 消息接线

| 缺口 | 现状 | 动作 |
|---|---|---|
| `api.commands.register` | 不存在 | plugin-sdk + runtime + ExtensionHost.CommandRegistry 三处落地。落地后 A3（M9/M12 按钮）、D1（slash 统一）从空壳变闭环 |
| `api.views.update` | 不存在 | 同上，落地后 A1（sidebar 第 5 tab）变闭环 |
| `plugin:uiRequest` | runtime 已发（60s 超时真队列），renderer 零消费 → **插件弹窗永远超时拿默认值** | MessageBusBridge 接入，统一走 companion-band（M11） |
| `plugin:permissionRequest` | 零消费 | PermissionRequestDialog + approve/revoke RPC 回路 |
| `plugin:statusBarUpdate` | 零消费（builtin statusline plugin 的输出目前无人看） | StatusBarController |
| `plugin:crashed` / `plugin:notification` / `plugin:config` / `plugin:messageDecoration` | 零消费 | MessageBusBridge → toast / 设置页 / 消息装饰 |
| `plugin:statusChange` | 零消费 | MessageBusBridge → 状态变更分发（plugin 活跃/错误等状态），状态栏侧由 StatusBarController 聚合消费 |

### 6.3 挂载点注册表（解"desktop 16 挂载点 vs mobile 子集"）

16 挂载点是桌面拓扑专属，mobile 只支持 B（对话流）+ D（命令）。新机制：**挂载点不是硬编码在 ExtensionHost，而是由壳注册**：

```ts
// 桌面壳 bootstrap
mountPoints.register('sidebar.tab', sidebarTabHost)
mountPoints.register('panel.header.action', panelHeaderHost)
mountPoints.register('composer.toolbar', composerToolbarHost)
mountPoints.register('statusbar', statusBarHost)
mountPoints.register('drawer.tab', ...)        // proposed，桌面也暂不开放
// 移动壳 bootstrap：只注册 message-stream / slash / companion
```

ContributionRegistry 把 plugin 声明的 contribution 按类型路由到对应挂载点。效果：

- mobile 天然获得 B+D 子集，无需 if-else 特判。
- 未来新形态（web 版？）只写自己的挂载点注册。
- Tier 2 挂载点（M3/M6/M13/M15 边缘项）不注册即关闭，开放是壳的一行代码而非架构改动。

**Plugin DX（审查新增）**：

- **挂载点未注册 ≠ 静默失败**：contribution 路由到未注册挂载点时，打 **warning 级日志**（含 plugin id + contribution id + 期望挂载点名），并在 plugin 管理页对「声明了但当前平台不可用的 contribution」置灰标注。静默会让 plugin 作者以为自己的 bug。
- 提供 `api.views.listMountPoints()`（runtime 中继 ExtensionHost 状态）让 plugin 在 activate 时能查询当前平台可用挂载点，自行降级。

### 6.4 三套 UI 接口统一（pi ctx.ui × plugin api.ui × GuiComponent）

| 统一项 | 方案 |
|---|---|
| 对话框原语 | pi `ctx.ui.select/confirm/input` + plugin `api.ui.showSelect/Confirm/Input` → 统一 `DialogRequest` 内部协议。MessageBusBridge 同时消费 `extension.ui_request` 与 `plugin:uiRequest`，归一后进同一 pending 队列，渲染统一走 companion-band（M11，顶替 composer、阻塞式）。M15 全局 modal 降级为仅致命错误 |
| 状态展示 | pi `setStatus` + plugin `updateStatusBarItem` → 统一 StatusBarController（builtin statusline plugin 已在桥接 pi status，renderer 只需一个聚合出口）。**信息流向**：StatusBarController 只消费「runtime 广播的 plugin statusBarItems + pi setStatus 消息」，不主动读 domain store；domain 状态若要进状态栏，经 builtin statusline plugin 走 runtime 广播路径——即 ExtensionHost 是消息消费端，不是 domain 读取端（与 §4.1「ExtensionHost 不 import domain」一致） |
| 结构化渲染 | 统一 GuiComponent（§7）。pi 经 widget marker/tool result details；plugin 经 `plugin:viewUpdate`（新增）/ tool result details |
| ask-user | 保留独立双向通道（等用户回传），不并入单向 GuiComponent |
| overlay lifecycle | 窗口化是 renderer 能力：plugin 只 await 结果，不感知 expanded/minimized/restored。状态机集中在 overlay-lifecycle.ts，不散落各挂载点 |

### 6.5 Contribution schema v2（plugin-sdk 演进）

现有 `PluginContributes` 只有 5 个字段（slashCommands/tools/hooks/panels/statusBarItems），且 panels 是「声明未消费」。按 renderer-target §4 落地完整 schema：

- `panels` → `views[]`（+placement/viewType/activationEvent/initialVisibility）
- 新增 `menus`（composer.toolbar / panel.header / sidebar.footer）、`commands`（含 keybinding/when/category）、`configuration`（settings schema 驱动表单）
- `statusBarItems` 扩展（alignment/scope/commandId/tooltip）
- D1 双轨收编：slash command 以 contributes.slashCommands 为唯一声明源，session.commands 通道保留为 pi 侧数据源，CommandRegistry 做归一

### 6.6 plugin-sdk 主干化前置修复（runtime/sdk 侧）——排期硬锁

非 renderer 范围，但"完整支持 plugin 架构"必须包含，且**与 ExtensionHost 排期有硬依赖，不得脱钩**：

1. **sandbox ESM 绕过**（实测确认：plugin-bootstrap.ts:79 `await import()` 加载 + 只 patch `Module._resolveFilename`，sandbox 名存实亡）→ vm 模块真隔离或 per-plugin 子进程。**【排期硬锁】外部插件（external/third-party）的安装与激活开关，必须在 sandbox 真隔离落地之后才允许打开**。builtin tasks（P4）可先于 sandbox 修复落地——builtin 是自有代码、免权限审批，不受 sandbox 缺陷影响。若 sandbox 修复延期，ExtensionHost 照常建设，但 plugin-installer 的 external 来源保持关闭。
2. **API 稳定性分层**：stable/proposed/internal + `Object.freeze`（实测确认全 sdk 无 freeze）。主干化即冻结点（VSCode 教训）。**【排期硬锁】freeze + 分层在 P4 内部、2 API 落地之后、P4 收尾前完成**（而非「P4 开始前」），否则 P4 建好的 API 表面就是未冻结的公共契约。
3. **过期注释清理**：agent-api.ts / ui-api.ts 头注自称 stub，实际已接线（plugin-rpc-setup.ts:184-214）——注释骗人比没注释更糟。
4. **tool/hook 统一**：plugin toolRegistration 与 pi registerTool 归一到统一注册表，bridge-handler 唯一执行路由；pi extension hook 翻译为 plugin HookPipeline 语义。
5. **发布决策**：plugin-sdk 目前 `private: true` 未发布。若外部插件是目标，需定名（@xyz-agent/plugin-sdk？）并纳入 npm-v* 发布管线。与 sandbox 硬锁联动：未发布前 external 插件无安装渠道，天然安全。
6. **打包校验**：resources/plugins（builtin statusline）疑似不在 electron-builder.yml 的 extraResources——需验证并纳入 preflight/postbuild 检查。

### 6.7 第一个 builtin plugin：tasks（goal/todo）

沿用已裁决方案（renderer-target §12）：core 删 `HIDDEN_TOOL_NAMES` 特判 + tasks store/GoalCard/TasksPanel/tasks tab/tasks-adapter 全删，goal/todo 的 `details.__gui__` 落普通 tool 路径由 RenderingProtocol 自动渲染，`/goal` `/todo` 经 plugin 声明。验证信号：core 代码零 tool name 特判、对话流正常渲染、slash 可用。这是 ExtensionHost 全链路的第一个真实验证，且因 builtin 身份不受 sandbox 排期锁影响。

---

## §7 RenderingProtocol 层：统一渲染协议

### 7.1 定位

GuiComponent 从"pi extension 专用"升格为**一切非 renderer 进程内容的统一渲染协议**——pi extension（pi 子进程）和 plugin（Worker Thread）都只能在 WS 上传可序列化数据，面对的是同一个问题，用同一套协议。

### 7.2 组成

- `core/src/rendering-protocol/`：类型 re-export（@xyz-agent/extension-protocol）、`extractGui` 校验、未注册 type → AnsiText 降级逻辑、custom 注册表（provide/inject，builtin-only）
- `ui/src/rendering-protocol/`：`GuiComponentRenderer.vue`（唯一渲染入口）+ 7 原语组件（card/list-tree/stats-line/progress-bar/columns/tab-bar/ansi-text），**按 v6 token 原生重写视觉**（去边框靠层级 / severity 收窄 / fill 柔化 / SegmentedTab 范式 / ANSI 16 色→v6 语义色映射）

### 7.3 消费点收敛（4 → 1）

现状 4 处各自 import GuiComponentRenderer（Block / MessageStream / SideDrawer / +新增 ViewHost）。新架构：所有挂载点共享 `ui/rendering-protocol` 的单一渲染器，消费点只是壳上的放置位置。

### 7.4 协议演进纪律

- **custom 逃生口仅 builtin**（编译期 provide 注册），external plugin 强制 7 原语。7 原语不够时**补原语**（候选：rows 垂直 stack [高优，解跨栏 footer 盲区] / kv-list / table），不放开 custom。
- 新原语 = extension-protocol 类型 + ui 渲染组件 + v6 视觉 + ANSI 降级 四同步，走 proposed → stable 流程。
- **ANSI 兜底永留**：未引入 extension-protocol 的 pi extension 开箱即用是兼容性铁律（pi 生态是基本盘）。

---

## §8 pi extension 消费通道（不动 runtime 的边界）

用户已裁决：pi extension 不进 renderer，runtime 适配层不动。新 renderer 侧的消费归位：

| pi 侧通道 | 现状消费点（散落） | 新归位 |
|---|---|---|
| tool result `details.__gui__` | chat-message-effects + Block.vue | domain/chat effect 提取 → RenderingProtocol 渲染（M4） |
| custom message `__gui__` | MessageStream.vue | 同上（M5） |
| `extension:widget` / `extension:widgetGui` | useDrawerWidgetBuffers + registry.ts + SideDrawer | ExtensionHost.MessageBusBridge → ViewHost/ drawer widget 区（M7），ExtensionRegistry adapter 模式升格为 ContributionRegistry 的正式机制 |
| `extension:status` | useDrawerWidgetBuffers | StatusBarController（M8） |
| `extension.ui_request`（select/confirm/input/ask-user） | useExtensionUI + extension-ui store | MessageBusBridge → DialogRequest 统一队列 → companion-band（M11） |
| `extension.notify` | toast | MessageBusBridge → toast |

**runtime 侧一个字符都不改**：event-adapter / message-converter / 双通路（实时 + 持久化）原样。新 renderer 只是把消费从 5 个散落点收敛到 ExtensionHost 一个入口。

**F2-S3 新增 WS 接口的消费**（审查补充）：A3 IPC 收敛把 3 个业务持久化从 main 进程迁到 runtime WS——`session.writeImage` / `session.migrateImage` / `session.writeSegments`。新架构中这 3 个调用落在 **domain/session 的 api domains**（与现有 15 个 domains 同层同模式），调用方是 composer 附件粘贴与 segments 元数据写入流程；runtime 侧是 F2 已交付成果，renderer 只是新增消费点，无特殊设计。F1/F2 的其他成果（entry-tree-builder、message-converter 透传 details 等）全部经「runtime 不动」原则原样继承。

---

## §9 平台适配层 PlatformPort

remote-use 的 `lib/ipc.ts`（393 行，每个方法 `api?.method() ?? 安全默认`）证明了降级模式可行。新架构升级为显式端口，但**采纳审查意见：不全量端口化，P0 只做 3 个核心端口的 spike 验证，其余保留隐式降级、迭代收编**——为「未来 web 版可能性」预付全量抽象成本不值（当前无 web 版承诺），而 storage/websocket/electronAPI 三个端口是 core 可测试性与双端共享的真实刚需。

```ts
// core/src/platform/port.ts —— P0 落地 3 项，其余迭代收编
interface PlatformPort {
  readonly kind: 'electron' | 'mobile' | 'web' | 'mock'
  storage: KVStorage                 // localStorage / 内存 Map（connection-config 等依赖）
  webSocket: WebSocketFactory        // 浏览器原生 / mock（ws-client 可注入）
  ipc: IpcBridge | null              // electronAPI 全集；非 electron 为 null（= 现 lib/ipc.ts 的正式化）
  // ── 以下为迭代收编区（P0 不抽象，沿用隐式降级）──
  // notify / sound / clipboard / filePicker / terminal …
}
```

- core 通过模块级 `providePlatform(port)` 在壳 bootstrap 时注入（先注入后 initApp，测试注入 MockPlatform）。
- **P0 spike 验证项**：① storage 抽象能否覆盖 connection-config 的 5-key SSOT + 降级内存 Map；② websocket 工厂注入后 ws-client 测试是否摆脱对全局 WebSocket 的依赖；③ ipc 端口化后 `lib/ipc.ts` 的 45 个调用点改动量是否可控。三项有任何一项验证失败，回退隐式降级方案重估，不硬推。
- **终态规则（逐步逼近）**：core 内禁止直接出现 `window.electronAPI` / `localStorage` / `new WebSocket`——lint 强制。收编节奏：每个 domain 迁移波次顺手把该域的平台访问收进端口，不设独立大波次。
- 桌面壳的 ElectronPlatformAdapter = 现 lib/ipc.ts 的正式化（45→~41 方法，IPC 收敛 A3 项顺手做掉：proxy 通道改名 + 3 个业务持久化迁 WS，见 §8 末尾）。

---

## §10 旧层 → 新架构映射表

> 重做的是组织结构，不是业务逻辑。大部分旧代码的去向是"迁移 + 按新边界拆分"，真正丢弃的是：sync-copy 机制、routeInbound if-else、上帝模块的组织方式、plugin 真空（无旧可丢）。

### 10.1 → core/transport + coordination

| 旧（feat-remote-use 合并后的 main） | 新归位 | 方式 |
|---|---|---|
| `lib/ws-client.ts`（807 行） | transport/ws-client（**先整体迁入**，拆分后置按耦合测量定边界，见 §5.1） | 迁移 |
| `lib/remote/*`（5 文件） | transport/remote/ | 原样迁移 |
| `composables/useConnection.ts`（532 行） | coordination/connection-lifecycle + route-inbound + lease + subscribed-sessions | **重构迁移**：routeInbound if-else → ROUTE_TABLE |
| `stores/presence.ts` | coordination/presence.ts | 原样迁移 |
| `stores/session.ts` lease 字段 | store 留 domain/session，消费逻辑 → coordination/lease.ts | 拆分 |
| `api/transport.ts` / `pending.ts` / `events.ts` / `request.ts` / `domains/*` | transport/ 原样继承 | 原样迁移 |
| `lib/ipc.ts` | 桌面壳 ElectronPlatformAdapter（PlatformPort.ipc 实现） | 重构迁移 |
| `lib/terminal-reconnect-signal.ts` | transport/ | 原样迁移 |

### 10.2 → core/domain/*

| 旧 | 新归位 | 方式 |
|---|---|---|
| `stores/chat.ts` + 10 个 chat-* 模块（2,610 行） | domain/chat/（store + mutations + readers + lru + changeset + handoff + bash-effects + chunk-processor + timers） | 集群原样迁移为域内模块；chat-message-effects 737 行**拆解**：纯 chat 内聚部分留 domain/chat/effects，跨域编排（→tasks/panel/sideDrawer）随 tasks 特判删除（§6.7） |
| `composables/features/useChat.ts`（563 行） | domain/chat/useChat.ts | 迁移 + 残留模块级 Map 改 useSessionScopedState（B1 内容被吸收；若 B1 已作为暖身先做，直接迁移修后版本） |
| `composables/panel/useComposer*`（12 个）+ `useContenteditableInput.ts`（873 行） | domain/composer/（input / dispatch / context 三个深模块，B4 合并方案被吸收） | 重构迁移 |
| `stores/session.ts` / `useSidebar.ts` / `useNewTaskFlow*` | domain/session/ | 迁移 |
| `stores/settings.ts` / `useProviderEdit.ts` / settings 数据 | domain/settings/ | 迁移 + compat-fields.ts 归位 |
| `stores/subagent.ts` / `workflow.ts` | domain/subagent/ + domain/workflow/ | 迁移（后续第二阶段再评估 plugin 化，本次不动） |
| `stores/tasks.ts` + tasks-readers | **删除**（§6.7 builtin plugin 化） | 删除 |
| `stores/command.ts` / `fileSearch.ts` / `quota.ts` / `preset.ts` / `navigation.ts` / `workspace.ts` / `panel.ts` / `sidebar.ts` / `turn-expansion.ts` / `terminal-write-queue.ts` / `composer-injection.ts` / `extension-ui.ts` | 按域归入 domain/* 或 extension-host（extension-ui → DialogRequest 队列） | 迁移 |
| `composables/logic/*`（15 文件） | 随域下沉（markdown → domain/chat/）或 foundation | 迁移 |
| `composables/effects/*`（9 个 DOM 副作用） | ui/ 或壳（不下沉 core） | 迁移 |
| `composables/useSessionScopedState.ts` / `useMessageBusSubscription.ts` / `useToast.ts` 等 | core/foundation/ | 原样迁移 |
| `extensions/registry.ts` + adapters/ | extension-host/contribution-registry（升格） | 重构迁移 |

### 10.3 → ui/ 与壳

| 旧 | 新归位 | 方式 |
|---|---|---|
| `components/ui/*`（58 文件，reka 封装原语） | ui/primitives/ | 迁移 + v6 token 原生 + B8 双名清洗被吸收（bg-accent 98 处双义在重写时自然消除） |
| `components/panel/message-stream/*`（35 文件） | ui/features/chat/ | 迁移 + v6 视觉 |
| `components/panel/message-stream/gui/*`（7 原语） | ui/rendering-protocol/ | 迁移 + v6 视觉重写 |
| `components/extension/ask-user/AskUserOverlay.vue` | ui/extension-host/ | 迁移 |
| `components/extension/ExtensionUIDialog.vue` | ui/extension-host/（消费 `extension.ui_request` 的 dialog，与 `stores/extension-ui.ts` 同链路，随其被 DialogRequest 统一队列取代） | 迁移 |
| `components/overlays/SearchModal.vue` | ui/overlays/ | 迁移 |
| `components/shell/*` / `workspace/*` / `sidebar/*` / `settings/*` / `new-task/*` / `panel/DetailPane` 等桌面布局件 | renderer/src/（桌面壳） | 按 v6 视觉重写 + 布局归壳 |
| `components/remote/*`（4 组件） | renderer/src/remote/ + mobile 对应物 | 迁移（连接 UI 是壳职责） |
| `api/mock/*`（2,539 行） | core/transport/mock/（MockPlatform + mock domains） | 迁移，测试基建继续用 |
| `i18n/*`（29 文件） | core/i18n/ | 原样迁移 |
| `scripts/sync-mobile-from-renderer.sh` | **删除** | 删除 |

---

## §11 迁移与实施策略（v2 主线修正：逐域绞杀）

> **实施状态（2026-09-12 核验）**：P1/P2/P3 已落地——`packages/core` / `packages/ui` 已建成，chat 域等已迁入 core（renderer `stores/chat.ts` 为 31 行薄壳）；§10 映射表多数已执行。读者按「现状」读 §3/§4（包拓扑与 core 分层），按「已执行」读本章迁移计划（P4-P6 余项以实际进度为准）。

### 11.0 P0 开工前必须落地的 4 项架构决策（审查新增）

这 4 项不定，P0/P1 启动后会反复返工：

1. **状态管理 DOM 耦合审计**：core 零 DOM 要求 store 无 DOM 副作用。实测审计 30 个 store 的 DOM/浏览器 API 触点（如 chat-timers 的 setTimeout 属允许范围，但任何 `document.`/`window.` 直连需列出），产出「需改造 store 清单」作为 P3 各域迁移的前置输入。
2. **路由：沿用状态驱动，不引入 vue-router**（确认现状决策）。settingsStore.currentView / navigation store 的模式在双端都成立，webview 式多页路由无收益。壳负责 view 容器，core 的 navigation store 提供状态。
3. **bootstrap 时序链**：`providePlatform(port)` → `ws-client init`（connection-lifecycle 三分支）→ `session 恢复`（active session + subscribed sessions 注入）→ `挂载点注册` → `ExtensionHost contribution 扫描`。顺序写成 core/bootstrap.ts 的显式编排，不许隐式依赖 import 顺序。
4. **ws-client 不变量定义**：从「本地模式逐字节不变」修正为「特征测试覆盖的关键行为不变」（见 §5.1）。

### 11.1 总顺序

```
前置：feat-remote-use（98 commits）→ main 合并完成（既定决策，独立风险评估，不重开）
  │    （可选暖身：B1 useChat 状态隔离 + B2 stores 契约修复，见 11.5）
  │
P0 骨架 + 决策 + 可行性验证
  │    4 包骨架（core/ui/renderer/mobile-renderer）+ PlatformPort 3 端口 spike
  │    + 11.0 的 4 项决策落地 + 特征测试 PoC（3-5 个，见 11.3）
  │    【P0 验收门：① PlatformPort spike 3 项全过 ② PoC 特征测试（3-5 个）在新 core 上跑通 ③ 新旧共存接缝机制（构建 flag / 双入口按域灰度）spike 验证通过 → 三项全绿才进入全量推进】
  │
P1 T&C 迁移         transport + coordination 全量（ws-client 原样迁入 / ROUTE_TABLE / presence / lease）
  │                 —— 从 remote-use 代码迁，这是唯一"必须迁对不能丢"的部分
  │
P2 RenderingProtocol 7 原语 v6 原生 + GuiComponentRenderer + 降级链
  │                 【P2 验收门：特征测试 PoC 覆盖的消息流在新链路全绿 → 可行性验证完毕】
  │
P3 逐域绞杀（主线）  每域一个完整周期：迁移 → 接入新壳该域入口 → 该域验收 → 删旧域代码
  │                 顺序：chat（最大，先啃）→ composer → session/sidebar → settings
  │                      → new-task/search → drawer
  │                 每域独立交付，中途停手也有已完成域的部分价值
  │
P4 ExtensionHost    6.1 全新建 + 2 API 落地 + UI 统一 + builtin tasks plugin 验证
  │                 【排期硬锁：external plugin 开关卡 sandbox 修复（§6.6-1）；
  │                  API freeze + 分层在 P4 完成前落地（§6.6-2）】
  │
P5 双壳收尾         桌面壳剩余区域（v6 视觉）+ 移动壳切换 core/ui；删 sync 脚本
  │
P6 清尾             旧 renderer 剩余残留删除 + 全量验收（§11.4）
```

### 11.2 逐域绞杀（主线，取代 v1 的「全量冻结 + P6 大爆炸切换」）

v1 主线是「旧 renderer 功能冻结数周 → 新系统建成后一次切换」。两份审查一致指出：remote-use 合并本身就有一段高风险期，叠加数周产品冻结，对一个高度迭代的代码库**几乎不可能执行**。修正为：

- **主线：逐域绞杀**。P3 中每个域完成「迁移 → 切换该域入口 → 验收 → 删旧」的完整闭环。二次迁移窗口（旧域继续收 fix 的风险期）缩到单域周期内。
- **域级短冻结**：只在单域迁移周期内（预期数天）对该域冻结新功能，其他域照常迭代。全局冻结不存在。
- **新旧共存的接缝**：切换期新壳已接入口、旧 renderer 仍持有未迁移域——两者通过「同一 runtime、同一 WS 协议」天然共存（新壳是独立 vite 入口/Electron 窗口或构建产物切换，按域灰度）。接缝机制的具体形态（构建 flag 切换 vs 双入口并存）在 P0 spike 中验证后定。
- **P3 迁移与 P4 挂载点机制解耦**：P3 各域（chat/composer/session/sidebar/drawer）迁移的是「域逻辑 + 组件」，ExtensionHost 挂载点机制（contribution 路由 / CommandRegistry，见 §6.3）是 P4 才建的事。P3 期间这些 UI 入口（composer.toolbar / sidebar.tab / drawer.tab 等）先以「壳内硬编码占位」形态存在——壳直接渲染该域原生组件，不走 contribution 路由；待 P4 ExtensionHost 落地后再把占位统一替换为 contribution 驱动。这样 P3 域迁移不被 P4 阻塞，P4 闭环时统一升级挂载点。
- **回退单元是域**：任何域切换后发现回归，回退该域入口即可，不影响已切换的其他域。

### 11.3 测试策略

- **特征测试 PoC 先行（P0，3-5 个）**：先写 3-5 个「WS 消息序列 → store 终态」的黄金测试验证可操作性——routeInbound 直触 6 个 store、mock 基建 2,539 行，特征测试的 mock 复杂度需要 PoC 实证，不能假设可行。候选场景：session 生命周期 / 对话流流式（含 tool result）/ compact / busy-lease / presence 重连回放。**PoC 成功率是 P0 之后全量推进 vs 收缩的最关键信号**。
- **特征测试全量化（P1-P2）**：PoC 验证后扩展为完整安全网，对实现解耦，新 core 必须原样通过。
- **行为测试随域迁移**：现有 293 个测试文件按价值筛——断言用户可见行为/状态机的随域迁移改写；断言内部调用/mock spy 的删除（既定方针：删旧测试随重构同步，无覆盖空窗）。
- **渲染 gate 保留**：每域至少一条「mount 顶层容器断言关键 DOM 存在」的首屏冒烟（AGENTS.md 测试规范 §8）。
- **coverage gate 平移**：新 core 从第一行就带 coverage 配置，阈值随迁移滚动校准。
- **E2E 双轨**（mock 快跑 + real 慢 job）进 CI——这是旧架构欠的，新架构原生带上。

### 11.4 验收基准（终态）

- core 包零 `node:` / 零 `window.electronAPI` / 零直接 `localStorage`/`WebSocket`（lint 强制）
- routeInbound 查表 + 执行，无业务逻辑内联；新增 server-push 消息不动路由核心
- stores 零跨域 import、零 import composable
- 零 `reset*ModuleState`；per-session 状态 100% 经 useSessionScopedState（presence/lease 两个标注例外）
- plugin 全链路：`contributes.views` 声明 → sidebar 第 5 tab 渲染 GuiComponent；按钮点击 → command 执行；`plugin:uiRequest` → companion-band 弹窗 → 响应回传不再超时
- builtin tasks：core 零 tool name 特判，goal/todo 对话流正常渲染
- mobile 与桌面共享 core/ui，sync 脚本已删除，双端 `pnpm build` 通过
- 远程模式：auth/seq/presence/lease 行为与 remote-use 一致（特征测试锁定）

### 11.5 可选暖身：B1/B2 独立交付（审查新增）

v1 把 B1-B9 缝补「整体取消」偏绝对。修正：**B1（useChat 残留模块级 Map → useSessionScopedState）与 B2（chat-message-effects 跨域编排抽离）是局部、独立、可立即见效的修复，可在 P0 前作为暖身独立交付**——成果（修后的 useChat / 抽离的事件消费层）直接成为 P3 chat 域迁移的输入，不做两遍工。B3-B9 仍取消（被重做吸收，在旧代码上做是沉没成本）。若重做立即启动，暖身可跳过，B1/B2 内容直接在迁移时做。

---

## §12 风险与诚实的成本评估（v2 重估）

1. **工作量重估**：v1 的「数周级」低估。实测口径：生产代码 5.5 万行 + 测试 5.3 万行。按内容分解：
   - 迁移重组 ~60%（store/composable/组件逻辑大体保留，逐域绞杀节奏）
   - 新建/重写 ~40-45%：ExtensionHost 全层（8 模块 + 2 跨 sdk/runtime/renderer 三端的 API + contribution schema v2 + UI 统一）、PlatformPort、ROUTE_TABLE、双壳布局、7 原语 v6 视觉、composer 合并
   - **测试改写单列 ~20%**：293 个测试文件中大量内部断言型作废，行为型随域改写，特征测试全新建（以上三块为口径交叉：测试改写横跨迁移与新建两类，非互斥分块相加）
   - **诚实估算：2-4 人月全职当量**（两位审查者分别估 1.5-2 个月与 3-6 人月，本文档取中并保留区间）。**P0 验收门（PlatformPort spike + 特征测试 PoC）是估算校准点**：P0 实际耗时与 PoC 成功率出来后再锁定全程估算，不在启动前假装精确。
2. **分期交付原则**：P0-P2 验证可行性（最小投入）→ P3 逐域迁移（每域独立价值）→ P4-P5 ExtensionHost 与双壳 → P6 清尾。**中途停手的最坏结果从 v1 的「新旧两套都不完整」改善为「已完成域在新架构、未完成域在旧架构，两边都可用」**——这是逐域绞杀相对全量冻结的核心收益。
3. **remote-use 合并本身就是大动作**：98 commits 先进 main 再启动重做。重做计划不能取代合并计划，两者是串行关系。合并期间是事实上的代码扰动期，P0 最好在合并稳定后启动。
4. **plugin-sdk 主干化前置项在 runtime 侧**（sandbox/API 分层），renderer 重做不依赖它完成，但「完整支持 plugin」的终点依赖——已设为排期硬锁（§6.6），external 开关卡 sandbox，builtin tasks 不受影响。
5. **双壳是两倍视觉工作量**：v6 视觉规格（demo/18 份 spec）全是桌面拓扑。mobile 视觉需要补设计，不能默认「共享组件自动好看」。

---

## §13 与现有文档/决策的关系

### 采纳（原样继承）

- 七层架构概念与依赖铁律（renderer-target §2）——但落位从"目录"升级为"包"（§3/§4）
- ADR-0049 Map 分区派 + presence/lease 显式例外
- routeInbound 声明式 ROUTE_TABLE（remote-use-merge §4）——从"合并时缝补方案"升级为"原生设计"
- ExtensionHost 6 组件 + 挂载点 Tier 分层 + contribution schema v2 + 3 自定义级别（L1/L2/L3）
- GuiComponent 统一渲染协议 + ANSI 兜底永留 + custom 仅 builtin
- tasks 作为第一个 builtin plugin
- 「remote 先进 main」的合并顺序
- v6 视觉全部裁决（D1-D14 / R1-R14 / 太极 6 主题 / demo 为活验证层）
- 路由沿用状态驱动，不引入 vue-router（§11.0-2）

### 修订

- 「v6 重构在 remote 之上做（B1-B9 缝补）」→ **B1/B2 保留为可选暖身**（§11.5），**B3-B9 取消**被重做吸收（B3 落进 ROUTE_TABLE 原生设计；B4 落进 composer 域合并；B5/B7 落进双壳重写；B6 落进 chat 域迁移；B8/B9 落进 ui 重写与包拓扑）。旧 renderer 不再做大规模缝补。
- 「sync-mobile 兼容纪律 + MANUAL_FORK 路径锁定」→ 随包共享落地**整体作废**，sync 脚本删除。
- 阶段 C 视觉波次（C1-C8）→ 吸收进 P2/P5，视觉与架构一次成型。
- 「renderer 单包 + 全量冻结 + 一次切换」（v1 迁移主线）→ **逐域绞杀主线**（§11.2）。

### 推翻

- 「renderer 是一个包」的默认假设 → core/ui/desktop/mobile 四包拓扑。
- 「plugin 渲染等 Phase 3+」的搁置状态 → ExtensionHost 是重做的核心新建层，P4 落地（含 sandbox 排期硬锁）。

---

## 附录 A：调研依据

本文档所有数字经 3 路 explorer 对源码实测（2026-08-03），并经理两轮独立审查复核修正：

- 现 renderer 盘点：packages/renderer/src 生产代码 55,396 行 / 测试 53,185 行（v2 复核）；stores 依赖图；ADR-0049 采用 13 文件；plugin 下行 9 消息全零订阅；测试 293 文件
- feat-remote-use（worktree `../feat-remote-use`，**98 commits 领先 main**，v2 复核：`git log main..HEAD` 与 `git merge-base main HEAD..HEAD` 均为 98）：lib/remote 5 文件、ws-client 262→807、useConnection 532 行 routeInbound 新分支、presence/lease、mobile-renderer + sync 脚本、runtime transport 新增 6 模块、shared +159 行协议
- plugin 体系：plugin-sdk 601 行纯类型（contributes 5 字段）、extension-protocol 7 原语、runtime plugin-service 5,746 行、builtin statusline plugin、ESM sandbox 绕过/无 freeze/过期 stub 注释三处实测确认

关键参考文档：

- `docs/architecture/renderer-target-architecture.md`（七层 + 挂载点 + ExtensionHost 设计，本文档 §4/§6 的概念源头）
- `docs/architecture/v6-architecture-refactor.md`（现状审查，数字经本文档二次验证）
- `docs/todo/remote-use-merge-architecture.md`（T&C 归位清单 + routeInbound 合并设计 + sync 纪律）
- `docs/page-design/v6-master-spec.md`（v6 视觉单一权威源）+ `.tmp/v6/` demo

---

## 附录 B：v2 修订记录（2026-08-03，吸收两份开发者审查）

两份审查全文见 `/tmp/renderer-rebuild-review.md` 及会话记录。处理原则：事实性主张逐条实测复核，工程判断择优吸收，不盲从。

### B.1 事实复核（审查方 vs 本文档 vs 实测）

| 审查主张 | 实测复核 | 处理 |
|---|---|---|
| 「feat-remote-use 3079 commits」（审查 1） | `git log main..HEAD` = **98**；3079 是 `git rev-list HEAD` 的全历史计数（含 main 全部祖先），与合并范围无关 | **本文档 98 正确，维持**。审查 1 此条失准 |
| 「src 10.8 万行 + 测试 5.3 万行，文档 5.7+4.9 万低估近半」（审查 1） | 生产代码（剔除 `__tests__`/`*.test.ts`）= **55,396 行**；测试 = **53,185 行**。审查 1 的「10.8 万」实为生产+测试合计（55.4k+53.2k≈108.6k），再外加一遍测试 5.3 万，属**口径重复计算** | 本文档 v1 的 5.7 万（生产）口径正确但精度不足，v2 改为精确分解：生产 5.5 万 + 测试 5.3 万。**「低估近半」不成立**；但「总触及代码量约 10.9 万、成本高于数周」的方向性结论采纳（§12 重估） |
| 「chat 域 2,610 行非 2,740」（审查 2） | `wc -l src/stores/chat*.ts` = **2,610** | 审查 2 正确，已修正 |
| 「composables 生产 118 个非 126」（审查 2） | 实测 118 生产 + 8 测试 = 126 | 审查 2 正确，已修正并标注口径 |
| 「plugin 下行 9 个非 10 个」（审查 2） | 复核 protocol.ts：9 个 plugin 族下行消息，全零订阅 | 审查 2 正确，已修正（结论不变：全部零消费） |

### B.2 采纳的工程判断（6 项）

1. **逐域绞杀取代全量冻结为主线**（两份审查一致）：§11.2 重写。域级短冻结取代全局冻结，回退单元是域，中途停手有部分交付。
2. **成本诚实重估**：§12 改为 2-4 人月区间 + 测试改写单列 ~20% + P0 验收门作为估算校准点。两位审查者估算（1.5-2 月 / 3-6 人月）均记录，取中不取极。
3. **sandbox 排期硬锁**（§6.6）：external plugin 开关必须卡在 sandbox 真隔离之后；API freeze + 分层卡 P4 完成前。builtin tasks 不受影响可先落地。
4. **ws-client 不预拆**（§5.1）：P1 原样迁入，拆分后置按实测耦合定边界；不变量从「逐字节不变」修正为「特征测试覆盖的关键行为不变」。
5. **PlatformPort 收敛**（§9）：P0 只做 storage/websocket/ipc 三端口 spike，其余保留隐式降级迭代收编，不为假设中的 web 版预付全量抽象。
6. **P0 前置 4 项架构决策 + 特征测试 PoC**（§11.0/§11.3）：状态管理 DOM 耦合审计、路由确认、bootstrap 时序、ws-client 不变量；PoC 3-5 个验证特征测试可操作性，其成功率是全量推进的关键信号。

### B.3 部分采纳（1 项）

- **B1/B2 暖身**（§11.5）：接受「缝补与重写不是假二元」的批评，B1/B2 保留为 P0 前可选暖身且成果直接进迁移；B3-B9 仍取消——它们的形态（routeInbound 路由表/settings 全屏化/composables 分层）在重做里是原生设计而非改造，在旧代码上先做一遍是沉没成本。

### B.4 不采纳（1 项）

- 审查 1 的「整体冻结不可能执行」论据部分基于 3079 commits 的失准数字；其结论（逐域绞杀）本身正确且与审查 2 一致，故采纳结论、不采纳论据。

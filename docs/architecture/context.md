# xyz-agent 领域术语表

> **关系模型 SSOT**：Project – Session 直接关联（跨目录逻辑分组，cwd 仅展示聚合）见
> [project-session-model.md](project-session-model.md)（D14 语义修正，2026-08-04）。

## 核心概念

### Session
一个与 pi 引擎的对话实例。xyz-agent 不存在脱离 pi 的纯本地 session。每个 session 始终绑定一个 pi 进程（活跃时可实时通信，休眠时从 `.jsonl` 文件恢复历史）。持久化在 `~/.xyz-agent/sessions/` 下，扁平文件结构。

**归属**：session 创建时归属当前 activeProject（`projectId`，与 cwd 无关；无值 = 未归类，展示层归入默认项目）。持久化在 `<sessionFile>.project.json` sidecar。详见 [project-session-model.md](project-session-model.md)。

**生命周期**: create → active/idle → compact → restore → delete

### Panel
Session 的视口。每个 Panel 最多绑定一个 Session，每个 Session 同一时刻全局只能绑定到一个 Panel（跨窗口唯一）。空 Panel（sessionId=null）等待用户选择或创建 session。

**代码映射**: 已统一为 `Panel` / `PanelLeaf` / `PanelTree`（2026-06 完成 Pane→Panel 重命名，见 terminology R2）

### Session 切入链
用户在侧栏点选一个 session 后，前端按固定顺序执行的 12 步动作序列：`cancelActiveFlow → switchSession RPC → setActiveId → clearUnread → ensureStreamSubscription → touchRecency → syncSessionToPanel → navigation.push → hydrate/reconcile → preloadFileTree → touchRecency(panel 绑定 session) → evictLru`。

**代码映射**（renderer-deepening D3/D4，2026-09-03 u5.1/u5.2 落地）：链的唯一载体 = `packages/core/src/domain/session/use-session.ts` 的 `selectSession`（12 步顺序有接口级断言，改时序只改这一处）；跨域步骤（取消新建任务流 / 清未读 / 流订阅 / chat LRU / 文件树预加载）经 `SessionEntryPort` 端口束注入（全成员可选、缺省 no-op），桌面壳 `useSidebar.selectSession` 为一行代理 + 端口接线（原 `useSidebarNew` 已于 2026-08-31 改名回 `useSidebar`、旧轨删除——chat-stream-perf §3.3 D-D3；现桌面壳编排 = `packages/renderer/src/composables/features/sidebar/useSidebar.ts`），headless/mobile 未接线环境零新增步骤执行完整链。时序采 panel-first（panel/导航先于历史回填，链尾两步保护 panel 绑定 session 不被 LRU 驱逐——[lru-panel-exempt-fix]）；「订阅先于 panel 载入」前提（C-W3-4，2026-07-29 handoff 回复丢失事故）由链本体步 5→7 顺序保证，不再依赖注释跨文件同步。

### Agent Runtime
xyz-agent 的后端服务进程（Node.js）。职责：托管 pi 子进程的生命周期、协议翻译（pi stdin/stdout JSON RPC ↔ WebSocket）、session CRUD、配置持久化（provider/skill/agent）、model 查询。是 xyz-agent 唯一的后端，所有业务逻辑和数据持久化都在这里。前端不直接和 pi 通信，前端不做业务决策。

**对应目录**: `packages/runtime/`（2026-06 完成 sidecar→runtime 重命名，见 terminology R1）

**内部分层**（单进程，模块隔离）:

```
Agent Runtime（一个 Node.js 进程）
├── pi-adapter/    瘦层：pi 进程生命周期 + 协议翻译。只关心 pi RPC 协议细节。
│                  对外暴露 sendPrompt/abort/onEvent 等接口。
├── engine/        业务核心：session 管理、树形任务引擎、预算控制。
│                  依赖 pi-adapter 接口，不直接碰 pi 协议。
├── config/        配置持久化：provider/skill/agent/model。
└── server.ts      WebSocket 入口，路由前端消息到 engine/config。
```

设计原则：变化隔离——pi 升级改 pi-adapter，业务能力改 engine，不同速率的变化不交叉。

**内部模块（2026-05 架构重构后）**:

| 模块 | 职责 | 对外接口 |
|------|------|----------|
| Transport (`server.ts`) | WS 连接管理 + 消息分发 | 无（内部消费 Service） |
| SessionService | Session 生命周期、历史、compaction、restore | `ISessionService` |
| ConfigService | Provider/Skill/Agent/Model CRUD 编排 | `IConfigService` |
| ModelService | 模型聚合 + API 发现 | `IModelService` |
| RpcClient | pi 子进程通信（JSON-RPC） | `IRpcClient` |
| EventAdapter | pi 事件 → ServerMessage 翻译 | `IEventAdapter` |
| ProcessManager | pi 进程 spawn/kill/lookup | `IProcessManager` |
| MessageConverter | pi 历史格式 → 前端 Message[] | 纯函数 |
| MessageBroker | 统一 WS 广播 | `IMessageBroker` |

**依赖方向**: Transport → Service → Adapter/Config。Service 不直接碰 pi 协议，Transport 不包含业务逻辑。

### 语义吸收层（pi-boundary-reliability，2026-08-28）

xyz-agent 与 pi 之间对 pi 私有语义的统一适配层（[ADR-0064](../adr/0064-pi-semantic-absorption-layer.md)）：对 pi 语义的推断与跨边界承诺只在边界一次吸收（四支柱：能力注册表 / 生效回执 / 确认式送达 / 漂移守卫），域内只剩确定性。EventAdapter 只适配传输格式；语义适配（这个模型支持什么、这条消息是否真的到达、这个状态是否真的生效）归本层——散布在扩展/core/renderer 的本地推断即「影子推断」，是该层要消灭的问题类。

### 能力注册表

runtime `model-capability.ts` 单点服务面：模型全等 id / reasoning / 实际支持思考档位等 pi 能力事实的唯一进入点（pi-ai 同源函数离线计算 + `get_available_models` RPC 在线对账，覆盖 models-store 刷新漂移），结果以 view-ready `supportedLevels` 随模型信息下发，renderer/扩展禁止本地推断档位（约束 C-pi-12）。

### 生效回执

改状态 RPC（setThinkingLevel / model.switch 等）的 reply 一律回 pi 实际生效值（pi 钳制时 ≠ 请求值），消费方以回执写显示态、禁乐观写请求值（约束 C-pi-13）。「请求-生效」零距离是协议级不变量。

### 确认式送达

结果语义（终态/完成）跨边界通知的送达形态：持久账本 + 幂等键（notifyId）+ settled 边沿 courier（投递员，销账即确认）at-least-once 重放——账本、销账、courier 概念归并于本条。禁新建依赖 pi steer/nextTurn 内存队列的 at-most-once 通道（约束 C-ext-19）；交互式 steer/followUp 注入仅限非结果语义。

### SubAgent
pi 引擎的底层 extension，负责派生子进程执行子任务。这是 pi 侧的实现概念，不是 xyz-agent 的领域术语。

### TaskNode
xyz-agent 树形引擎中的节点。一个 TaskNode 对应一个 pi 子进程（底层复用 pi 的 SubAgent extension）。TaskNode 组成 TaskTree，支持递归嵌套（子→孙，max_depth=20）。每个节点有独立状态（running/completed/pending/error/aborted）。

**关系**: xyz-agent 的 TaskNode ≈ pi 的一个 SubAgent 实例。上层叫 TaskNode，底层实现叫 SubAgent。

### ToolCall
pi 引擎单次工具调用的记录。是数据模型的最小单位（bash、read、edit、write、subagent 等）。挂在 Message.toolCalls[] 上。

**TaskNode 与 ToolCall 的关系**: TaskNode 是 ToolCall 的上层抽象。一个 `toolName=subagent` 的 ToolCall 可以展开为整棵 TaskNode 子树。ToolCall 是底层数据，TaskNode 是 UI/业务层的聚合视图。

### Provider
用户自定义的模型提供商配置。一个 Provider = 一组 (baseUrl + apiKey)。同一真实厂商（如 OpenAI）可以有多个 Provider（如官方端点 + Azure 端点）。Provider 之间完全独立。

### Model
具体的模型实例（如 gpt-4o、claude-sonnet-4-20250514）。附属于唯一一个 Provider。不存在跨 Provider 共享的 Model。

### Skill
无状态的 prompt 模板。本质是一段提示词，注入到主 Agent 的上下文中使用。不产生独立进程、不拥有独立上下文。

### Agent
有状态的执行实体。拥有独立的上下文和元数据（绑定的模型、执行参数、工具集）。可通过树形引擎创建为 TaskNode，拥有独立的对话流和生命周期。

**Skill vs Agent**: Skill 是提示词片段，Agent 是独立执行单元。

### Compaction
上下文窗口管理动作。当 session 的 token 使用量接近上限时，压缩历史消息以腾出空间。压缩后 session 继续，不新建。是 session 级操作，非破坏性的。

### Context Window
session 的 token 预算。由底层模型决定上限（如 200K tokens），ContextBar 实时显示使用百分比。Compaction 的触发条件就是 Context Window 接近满。

### Session Context
session 的语义内容——对话历史、项目知识（CLAUDE.md 等）、skill/agent 注入的提示词。是 agent 能感知到的全部信息。Session Context 的 token 占用量受 Context Window 上限约束。

### SystemNotification
前端本地生成的通知消息，不出自 pi。用于在聊天流中内联展示操作提示（如"可用命令"、"上下文压缩完成"）和错误提示（如"操作已被用户终止"）。不是 pi 消息的一部分，不参与 Context Window 计算。

**代码映射**: terminology R3 计划的 `SystemChatMessage`/`Message(role='system')` 统一为 `SystemNotification` 已执行（前端消息模型中旧符号已清除；plugin agentAPI 的 `sendMessage({role})` 是独立插件契约，不在范围内）。v3 重构后聊天流内联系统通知暂未重新落地，错误/提示走 overlay/toast 层，该概念待 v3 内容层深化时重新接入。
### Thinking
模型的内部推理过程，在回答生成前产生。属于单条 Message（挂在 `Message.thinking[]` 上），不属于整个 Session。UI 中默认折叠展示。

### Tool Approval
工具权限审批。Agent 执行危险操作（如写入文件、运行命令）前请求用户许可。用户回复是三选一：Allow（本次允许）/ Deny（拒绝）/ Always Allow（永久允许该工具）。

### Human Confirm
子任务请求用户确认。TaskNode 在执行过程中需要用户输入指导或确认方向时发起。用户回复不是简单的 allow/deny，可能是自由文本、修正指令或附加信息。

**Tool Approval vs Human Confirm**: Tool Approval 是权限控制（binary + always allow），Human Confirm 是任务级沟通（开放式输入）。

### Generating State
Session 级状态，表示 pi 进程正在工作（从用户发送消息到 agent_end）。由两个标志共同描述：
- `isGenerating` — pi 是否在处理中。发送消息时立即置 true，agent_end 时置 false。
- `streamingMessage` — 当前正在逐字输出的消息。由 pi 的 text_delta/thinking_start 等事件驱动创建。

两者可能不同步：isGenerating=true 但 streamingMessage=null 表示 pi 已收到请求但尚未开始输出内容。

> **术语演进（2026-09）**：`streamingMessage` 实体已消亡——流式态 = 末位消息 `status:'streaming'` + turn 级 `isStreaming` 派生；UI 活跃态 SSOT 是 `isActive`（含 pendingSend 空窗期，`packages/core/src/domain/chat/derive-status.ts` W1）。

### Side Drawer（原 Side Inspector）

> **术语演进**：原 `Side Inspector`（terminology R4 计划改 `SideInspector`）在 v3 重构中收敛为 **Side Drawer**。v3 版更通用：不再限于运行时状态面板，而是 header 多 tab 通用容器。

Panel 联动的浮层抽屉。一个 header + 多 tab 容器，tab 承载不同实体（文件×N / 终端 / 子Agent / 浏览器）。Diff/预览下沉为文件 tab 内部 view-toggle。与 Panel 数据强耦合，从触发它的 Panel 内浮起，固定挂该 Panel，v1 不跨 Panel 覆盖对侧。

**与旧 Side Inspector 的差异**：旧版三 Tab（TaskTree/已完成/请求回应）是运行时状态面板；v3 版是通用容器，旧三 Tab 的能力归入 TaskTree/子Agent tab + Flow-3 进度聚合。

### Session Tree
pi session 文件（JSONL）中通过 `parentId` 构建的逻辑树结构。同一文件内可存在多个分支（fork 点），唯一的可变状态是内存中的 `leafId` 指针。xyz-agent 通过 runtime 直接读取 JSONL 文件构建树，不依赖 pi RPC。

**术语映射**:
- Entry — JSONL 文件中每行一个 JSON 对象（message/branch_summary/label 等）
- leafId — pi 进程内存中指向当前活跃分支末端的指针，不在 JSONL 文件中持久化
- Navigate — 在同一文件内移动 leafId 到历史某个 entry（不创建新文件）
- Fork — 从历史某个 entry 创建新 session 文件，复制 root→entry 的路径
- Clone — Fork 的特例，在当前 leaf 位置复制完整路径

### ~~Panel Grid~~（v3 已废弃）

> **废弃说明**：v3 重构后窗口内最多双 Panel（主从模式），不再需要"全局 panel 缩略图网格"。该鸟瞰能力收敛到 [Overview](#overview)（session 维度统筹）+ 双 Panel split。旧 `overviewVisible`/`toggleOverview` 等代码引用待清理。

~~全局面板网格视图。展示所有 Panel 的缩略图，类似 macOS Mission Control / Windows Task View。用于快速定位和跳转 Panel。~~

### Window
操作系统级 Electron BrowserWindow。v3 拓扑：窗口 (bg-base 平铺) 内含 `.app-shell`（flex + p-3），由持久 **Sidebar**（透明融合）+ 可切换的 **main** 区（float-panel 浮起）组成。main 区在 chat / overview / settings 三 view 间互斥切换。支持多窗口。

**命名约定**: "Panel" 统一指 Session 的视口（即代码中的 Pane/PaneLeaf），不用于其他含义。

---

## v3 UI 结构术语（2026-06 重构）

> 以下术语由 v3-demo 设计稿确立，规范源：`docs/page-design/archive/v3/architecture-and-terminology.html §1`（术语唯一来源）。历史 md/draft 中的废弃词见 `docs/page-design/archive/v3/README.md` 术语映射表。

### Sidebar（侧栏）
L0/L1。持久容器（非单列表），所有 view 共用。顶部 Logo + 主操作区 → segmented tab（会话|文件）互斥切换 → 子视图列表 → 底部设置/用户。透明融合于 base（无 background）。折叠态 + Overview 入口按钮。

### Workspace（工作区）
L1 Region。main 区在 `view=chat` 时的容器。承载双 Panel 主从模式（单 Panel = 默认态，开第二 session 才 split）。

### Panel（面板）的 5 zone
L2 Module。一个 Panel 内部固定 5 个 zone 自上而下：① panel-header（per-session 元信息）② message-stream（消息流 + 回合折叠）③ progress-zone（单 Session 进度，内嵌 composer 上方）④ composer（输入区 + 工具区）⑤ git-zone（暂存/提交/Diff 入口）。

### Overview（概览）
L1 独立 Region（与 Sidebar / Workspace 并列，非 workspace 子视图）。多会话鸟瞰统筹——卡片网格 + 筛选排序 + 后台 agent 聚合。入口由 sidebar 按钮 + ⌘⇧O 触发，激活后覆盖 main 区，sidebar 持久。与 Session List 分工：Session List = 导航切换（紧凑单列），Overview = 统筹监控（信息密集网格）。入口裁决见 [ADR-0023](../adr/0023-overview-entry-coverage.md)。

> **别名**：`Mission Control`（已废弃，统一用 Overview）、`Panel Grid`（概念被 Overview 吸收，见上）。

### Search Modal（搜索浮层）
L1 Overlay。⌘K 全局搜索浮层，归 Overlay 层（非 Sidebar 子组件）。Sidebar 仅保留触发入口。

### Extension
pi 引擎的扩展模块，通过 `ExtensionAPI` 注册工具、监听事件、注册命令。xyz-agent 通过 RPC 透出 pi extension 的能力到 GUI 层。Extension 运行在 pi 子进程内，xyz-agent 不负责加载/执行 extension 代码，只负责 UI 交互桥接和生命周期管理。

**避免使用**: "插件"（Plugin）——Plugin 指 xyz-agent 自己的插件系统（Phase 2+），与 pi Extension 是不同概念。

### Extension UI Bridge
xyz-agent 将 pi extension 的 `ctx.ui.select/confirm/input/notify` 请求映射到 GUI 对话框/通知的机制。使用独立的 WS 事件通道（`extension.ui_request` / `extension.ui_response`），与 Tool Approval 通道完全隔离。

### Extension Data Directory
xyz-agent 管理的 extension 存储目录（`~/.xyz-agent/extensions/`）。与 pi 的数据目录（`~/.pi/agent/`）完全隔离——xyz-agent 不能读写 pi 的 extension/skill/config 目录，反之亦然。

### Extension Service
runtime 侧的新增服务模块（`extension-service.ts`），负责扫描 Extension Data Directory、解析 extension manifest、管理启用/禁用状态、将 extension 路径注入 pi 进程启动参数。

### Plugin
xyz-agent 自己的插件系统（Phase 1+），运行在 runtime 的 Worker Thread 中，使用 agentAPI（非 pi ExtensionAPI）。与 pi Extension 是完全不同的概念。Plugin 通过 PluginService 管理，数据存储在 `~/.xyz-agent/plugins/`。

**避免使用**: "扩展"（Extension）——Extension 指 pi 的扩展，Plugin 指 xyz-agent 的插件。

### Pi Bridge Extension
特殊的 pi extension，作为 xyz-agent plugin 系统与 pi 引擎之间的唯一适配层。职责：向 pi 注册代理 tool/slash command、转发 tool execute 请求到 runtime、桥接 pi 事件到 PluginService、代理 pi.appendEntry()。Bridge 是插件系统内部唯一感知 pi 存在的模块。

### sessionData
Plugin 的 per-session KV 存储 API（`api.sessionData`）。数据通过 Pi Bridge 走 `pi.appendEntry()` 持久化在 pi 的 session JSONL 文件中，天然跟随 session 生灭。与 PluginStorage（global/workspace scope，存在独立 JSON 文件中）不同。

### Built-in Plugin
随 xyz-agent 打包分发的插件（`source: 'built-in'`）。不可卸载、不可禁用、自动 trusted。存放在 app resources 的 `plugins/` 目录下。

### Plugin Source
插件的来源分类：`built-in`（随 app 打包）、`external`（用户安装）。`bundled`（预装可卸载）留到 Phase 3+。

### Plugin Dependency
插件间依赖关系，通过 manifest 的 `extensionDependencies` 字段声明（格式：`pluginId@semverRange`）。激活时拓扑排序，循环依赖拒绝激活。

### Statusline
xyz-agent 的运行时状态可视化系统，包含三个 UI 区域：Input Toolbar（输入框内底部，per-panel）、Session Strip（输入框下方，per-panel）、Global Statusbar（窗口底部，全局）。数据来源于两条通道：pi extension 的 `setStatus()` 和 xyz-agent plugin 的 `updateStatusBarItem()`。

### Input Toolbar
输入框内部的底部工具栏，per-panel。包含 model picker、thinking level picker、context bar、token stats、send button。显示 session 级的模型和资源使用信息。

### Session Strip
输入框下方的信息条，per-panel。包含 git branch、cost、extension status chips（如 goal/todo 进度）。split panel 时各 panel 独立。

### Global Statusbar
窗口最底部的全局状态栏。包含连接状态、pi 版本、所有活跃 extension 的 status chips。聚合 pi extension setStatus 和 xyz-agent plugin statusBarUpdate 两条数据通道。

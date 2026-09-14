# xyz-agent 领域术语表（统一语言）

> **关系模型 SSOT**：Project – Session 直接关联（跨目录逻辑分组，cwd 仅展示聚合）见
> [project-session-model.md](project-session-model.md)（D14 语义修正，2026-08-04）。
>
> 2026-09-13：根目录 CONTEXT.md（design workflow 精简统一语言）并入本文件——isActive / Task / 新建任务词条来自该版，其余过时词条（旧 Session 路径、Human Confirm、streamingMessage 现行态）按本文件既有词条为准。

## 核心概念

### Session
一个与 pi 引擎的对话实例。xyz-agent 不存在脱离 pi 的纯本地 session。每个 session 始终绑定一个 pi 进程（活跃时可实时通信，休眠时从 `.jsonl` 文件恢复历史）。持久化在 `<dataDir>/agent/sessions/<encodeCwd>/` 下（pi 按 cwd 自动分子目录，文件名形态 `<ISO时间戳>_<uuid>.jsonl`；路径唯一来源 `packages/shared/src/paths.ts` 的 `getPiSessionsDir`，dev 实例 dataDir 可为 `~/.xyz-agent-dev/instances/<worktree>/`）。

**归属**：session 创建时归属当前 activeProject（`projectId`，与 cwd 无关；无值 = 未归类，展示层归入默认项目）。持久化在 `<sessionFile>.project.json` sidecar。详见 [project-session-model.md](project-session-model.md)。

**生命周期**: create → active/idle → compact → restore → delete

### Panel
Session 的视口。每个 Panel 最多绑定一个 Session，每个 Session 同一时刻全局只能绑定到一个 Panel（跨窗口唯一）。空 Panel（sessionId=null）等待用户选择或创建 session。

**代码映射**: 已统一为 `Panel` / `PanelLeaf` / `PanelTree`（2026-06 完成 Pane→Panel 重命名，见 terminology R2）

### Task（任务）
**「任务」是「会话」的产品化措辞，1:1 同义。** 对用户暴露的概念叫"任务"（更贴近工作意图），系统/代码层统一叫"session"。不存在"一个任务跨多 session"的聚合实体。

### isActive（执行态 SSOT）
用户视角的「session 在忙」信号。定义：`isGenerating ∨ pendingSend`。UI 层（圆点/状态点/Composer/Panel 守卫）统一消费此信号，不直接用 isGenerating。isCompacting 是独立互斥态（compact 期间不可 steer/abort），不并入 isActive，但 deriveStatus 第 4 参数 isCompacting=true 时也返回 running（视觉态属 running）。实现：`packages/core/src/domain/chat/derive-status.ts`。

### 新建任务（New Task Flow）
用户从「无活跃会话」进入「准备开聊」的业务动作。终点是 session 发出第一条消息。用户流程 5 步：落地空态 → 选目录 popover → 选分支 popover → 系统原生目录选择器 → 创建分支 modal；对应状态机 8 态（`idle/landing/dir-popover/branch-popover/dir-dialog/branch-modal/completed/cancelled`，`useNewTaskFlow.ts`）。**directory / branch** 是 session 的元信息，非任务本体，显示为 composer 顶部 chip，可随时改。

### Session 切入链
用户在侧栏点选一个 session 后，前端按固定顺序执行的 12 步动作序列：`cancelActiveFlow → switchSession RPC → setActiveId → clearUnread → ensureStreamSubscription → touchRecency → syncSessionToPanel → navigation.push → hydrate/reconcile → preloadFileTree → touchRecency(panel 绑定 session) → evictLru`。

**代码映射**（renderer-deepening D3/D4，2026-09-03 u5.1/u5.2 落地）：链的唯一载体 = `packages/core/src/domain/session/use-session.ts` 的 `selectSession`（12 步顺序有接口级断言，改时序只改这一处）；跨域步骤（取消新建任务流 / 清未读 / 流订阅 / chat LRU / 文件树预加载）经 `SessionEntryPort` 端口束注入（全成员可选、缺省 no-op），桌面壳 `useSidebar.selectSession` 为一行代理 + 端口接线（原 `useSidebarNew` 已于 2026-08-31 改名回 `useSidebar`、旧轨删除——chat-stream-perf §3.3 D-D3；现桌面壳编排 = `packages/renderer/src/composables/features/sidebar/useSidebar.ts`），headless/mobile 未接线环境零新增步骤执行完整链。时序采 panel-first（panel/导航先于历史回填，链尾两步保护 panel 绑定 session 不被 LRU 驱逐——[lru-panel-exempt-fix]）；「订阅先于 panel 载入」前提（C-W3-4，2026-07-29 handoff 回复丢失事故）由链本体步 5→7 顺序保证，不再依赖注释跨文件同步。

### Agent Runtime
xyz-agent 的后端服务进程（Node.js）。职责：托管 pi 子进程的生命周期、协议翻译（pi stdin/stdout JSON RPC ↔ WebSocket）、session CRUD、配置持久化（provider/skill/agent）、model 查询。是 xyz-agent 唯一的后端，所有业务逻辑和数据持久化都在这里。前端不直接和 pi 通信，前端不做业务决策。

**对应目录**: `packages/runtime/`（2026-06 完成 sidecar→runtime 重命名，见 terminology R1）

**内部分层**（单进程，transport / services / infra 三层，`packages/runtime/src/` 实际目录）:

```
Agent Runtime（一个 Node.js 进程）
├── transport/   WS 消息面：server.ts 入口 + 按域拆分的 message handler
│                （session/config/extension/plugin/git/file/terminal/... 各一）
│                + message-broker（统一广播）。只做连接管理与消息路由，不含业务逻辑。
├── services/    业务服务：session/（生命周期、历史、compaction、restore、fork）、
│                config-service、model-service、plugin-service/、extension-service、
│                model-capability、git/、terminal/、quota/ 等；跨服务接口契约
│                在 interfaces.ts，pi 引擎接口唯一权威在 services/ports/pi-engine.ts。
└── infra/       基础设施与外部系统适配：pi/（rpc-client、process-manager、
                 event-adapter、message-converter、session-store 等 pi 协议适配族）、
                 relay/、git、fs、spawn-env、watchdog 等。
```

设计原则：变化隔离——pi 升级改 infra/pi，业务能力改 services，WS 契约改 transport，不同速率的变化不交叉。

**内部模块与现行落点**:

| 模块 | 职责 | 对外接口 |
|------|------|----------|
| Transport (`transport/server.ts`) | WS 连接管理 + 消息分发 | 无（内部消费 Service） |
| SessionService (`services/session/session-service.ts`) | Session 生命周期、历史、compaction、restore | `ISessionService` |
| ConfigService (`services/config-service.ts`) | Provider/Skill/Agent CRUD 编排 | `IConfigService` |
| ModelService (`services/model-service.ts`) | 模型聚合 + API 发现 | `IModelService` |
| RpcClient (`infra/pi/rpc-client.ts`) | pi 子进程通信（JSON-RPC） | 实现 `IPiEngine`（`IRpcClient` 为兼容别名） |
| EventAdapter (`infra/pi/event-adapter.ts`) | pi 事件 → ServerMessage 翻译 | `IEventAdapter` |
| ProcessManager (`infra/pi/process-manager.ts`) | pi 进程 spawn/kill/lookup | 实现 `IProcessManager` |
| MessageConverter (`infra/pi/message-converter.ts`) | pi 历史格式 → 前端 Message[] | 纯函数 |
| MessageBroker (`transport/message-broker.ts`) | 统一 WS 广播 | `IMessageBroker` |

**依赖方向**: Transport → Service → ports → infra。Service 经 `services/ports/` 定义的 port 接口消费 pi 能力（`IPiEngine` / `IProcessManager` 由 `infra/pi/rpc-client.ts` + `process-manager.ts` 实现，D24 收口），不直接碰 pi 协议；Transport 不包含业务逻辑。

### 语义吸收层（pi-boundary-reliability，2026-08-28）

xyz-agent 与 pi 之间对 pi 私有语义的统一适配层（[ADR-0064](../adr/0064-pi-semantic-absorption-layer.md)）：对 pi 语义的推断与跨边界承诺只在边界一次吸收，域内只剩确定性；EventAdapter 只适配传输格式，语义适配归本层，散布在各处的本地推断即「影子推断」。四支柱（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫）的权威词条落 [extensions glossary 的 pi 边界可靠性段](../extensions/glossary.md)，设计全文见 [docs/architecture/pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)。

### Subagent

> **术语演进（2026-09）**：旧「树形引擎 / TaskNode / TaskTree」词条随树形引擎退役消亡（旧实现 = subagent-workflow 单包三层，已迁 `packages/subagent-core` + 引擎协议化，历史见 [subagents/architecture.md §7](../extensions/subagents/architecture.md)）。本词条描述现行体系。

xyz-agent subagent 体系的子任务执行单元：由引擎进程派生子进程（pi 引擎 spawn pi 子进程；zcode 引擎走 app-server RPC）执行子任务，宿主与引擎经 engine-protocol v1（NDJSON stdio）通信。体系由 5 类包协作：shell（`extensions/universal/subagent-workflow`）→ host core（`packages/subagent-core`）→ engine（`packages/pi-subagent-cli` / `packages/zcode-subagent-cli`）→ contract（`packages/subagent-engine-sdk`）。结构导航 SSOT：[docs/extensions/subagents/architecture.md](../extensions/subagents/architecture.md)。

### Execution Record

subagent 运行状态的单一真源（`packages/subagent-core/src/execution/persistence/execution-record.ts` + `record-store.ts`）：内存 record 与磁盘 `session.jsonl` 重建两条通路共用同一 reducer；对外状态两态（`active` / `ended`），终态经 `<session>.state` sidecar 标记。

### ToolCall

pi 引擎单次工具调用的记录。是数据模型的最小单位（bash、read、edit、write、subagent 等）。挂在 Message.toolCalls[] 上。

**Subagent 调用与 ToolCall 的关系**: `toolName` 属 subagent/workflow 族的 ToolCall（`SUBAGENT_TOOL_NAMES` / `WORKFLOW_TOOL_NAMES`，定义于 `packages/shared/src/constants.ts`，判定函数 `isAgentgraphToolName` 在 `packages/core/src/domain/chat/message-turns.ts`）在对话流中渲染为 agentgraph 块（`OrderedBlock` 的 `kind: 'agentgraph'` → `packages/ui/src/features/chat/BlockSubagent.vue` 单行折叠块，只展示发起参数：agent · slug · model · thinking）。点击整行经 `openSubagent`（`packages/core/src/domain/drawer/`）打开 SideDrawer 的 subagent tab——嵌套只读 MessageStream，虚拟 id 形如 `subagent:<mainSid>:<subId>`（`subagentVirtualId`，`packages/shared/src/virtual-session-id.ts`）。ToolCall 是底层数据，agentgraph 块是 UI 层的折叠视图，完整执行记录在 Execution Record / subagent session。

### Provider
用户自定义的模型提供商配置。一个 Provider = 一组 (baseUrl + apiKey)。同一真实厂商（如 OpenAI）可以有多个 Provider（如官方端点 + Azure 端点）。Provider 之间完全独立。

### Model
具体的模型实例（如 gpt-4o、claude-sonnet-4-20250514）。附属于唯一一个 Provider。不存在跨 Provider 共享的 Model。

### Skill
无状态的 prompt 模板。本质是一段提示词，注入到主 Agent 的上下文中使用。不产生独立进程、不拥有独立上下文。

### Agent
有状态的执行实体，配置形态 = `.md` 文件（frontmatter 元数据：name、description、tools 等 + body：systemPrompt）。xyz-agent 强制目录 `<dataDir>/agents/`（ADR-0021），CRUD 经 runtime ConfigService（`services/agent-config-helper.ts` + `infra/pi/agent-crud.ts`）；subagent/workflow 派生子任务时按 agent 名选用，拥有独立的对话流和生命周期。pi 侧同名概念（user/project 级 agents 目录发现）见 [extensions glossary](../extensions/glossary.md)。

**Skill vs Agent**: Skill 是提示词片段，Agent 是独立执行单元。

### Compaction
上下文窗口管理动作。当 session 的 token 使用量接近上限时，压缩历史消息以腾出空间。压缩后 session 继续，不新建。是 session 级操作，非破坏性的。

### Context Window
session 的 token 预算。由底层模型决定上限（如 200K tokens），composer 工具条的 `ContextCapacityPopover` 展示用量（hover 出容量 popover，session 通道订阅 `context.update`，`packages/renderer/src/components/panel/Composer.vue`）。Compaction 的触发条件就是 Context Window 接近满。

### Session Context
session 的语义内容——对话历史、项目知识（CLAUDE.md 等）、skill/agent 注入的提示词。是 agent 能感知到的全部信息。Session Context 的 token 占用量受 Context Window 上限约束。

### SystemNotice
前端本地生成/派生的系统提示行，不出自 pi 的对话消息。渲染流转过程的元信息：压缩摘要（compactionSummary）、分支摘要（branchSummary）、pi 崩溃恢复提示条（RespawnNoticeBar 分支）、`@` 定向气泡（subagent directive）。不是 pi 消息的一部分，不参与 Context Window 计算。

**代码映射**: 现行符号 `SystemNotice`（`packages/ui/src/features/chat/SystemNotice.vue` 唯一渲染点；core 写入点 `appendSystemNotice` / `appendSubagentDirective`，`packages/core/src/domain/chat/store.ts`）。

> **术语演进**：历史名 `SystemNotification`（terminology R3 统一产物）已随 v3 重构消亡，现行符号为 `SystemNotice`，内联系统提示行已重新落地聊天流。
### Thinking
模型的内部推理过程，在回答生成前产生。属于单条 Message（挂在 `Message.thinking[]` 上），不属于整个 Session。UI 中默认折叠展示。

### Marker RPC（select+marker 通道原语，2026-09-14）

extension 与 xyz-agent runtime 之间的请求-回包通道原语（`packages/extension-protocol/src/core/select-rpc.ts` 的 `callMarkerRpc`）：extension 侧以 `ctx.ui.select(MARKER, [payload])` 发起（payload 为已序列化字符串），runtime 侧对应 handler 响应同一 marker。回包是判别联合 `MarkerRpcResult`——`{ok:true, value}`（value 恒 raw string，JSON 合法性由原语检测但 parse 消费留调用方）或 `{ok:false, reason}` 四态失败（`cancelled` / `timeout` / `channel-error` / `non-json`，由 `signal.aborted` 反推区分）。mode 门控（裸 TUI 下不发）留在调用方。现役消费方：session-manager / plugin-bridge / subagent-workflow inflight-reporter；错误回包形状单源为 `ChannelErrorResult`。

### Tool Approval
工具权限审批。Agent 执行危险操作（如写入文件、运行命令）前请求用户许可。用户回复是三选一：Allow（本次允许）/ Deny（拒绝）/ Always Allow（永久允许该工具）。

### Ask User（ask_user）

> **术语演进（2026-09 核对）**：原词条「Human Confirm」的代码符号已消亡，任务级用户确认统一到 ask_user 概念（主对话的 ask-user 工具与子代理的反向 UI 通道是同一交互面）。

agent（主对话或子代理 run）在执行中请求用户输入/确认的交互。子代理场景的链路：引擎进程的 dialog/UI 请求经 engine-protocol v1 的 `host/askUser` 反向通道到达宿主（`packages/subagent-core/src/execution/ui/ui-request-handler-factory.ts`，dialog 类经 `dialog-queue.ts` 跨子进程串行），GUI 模式透传进宿主 UI 通道，以 extension UI 请求呈现给用户（富交互形态见 `packages/ui/src/extension-host/AskUserForm.vue`：选项/多选/Other/自由文本/多行编辑）。用户回复不是简单的 allow/deny，可以是自由文本、修正指令或附加信息。

**Tool Approval vs Ask User**: Tool Approval 是权限控制（binary + always allow），Ask User 是任务级沟通（开放式输入）。

### Generating State
Session 级状态，表示 pi 进程正在工作（从用户发送消息到 agent_end）。由两个标志共同描述：
- `isGenerating` — pi 是否在处理中。发送消息时立即置 true，agent_end 时置 false。
- `streamingMessage` — 当前正在逐字输出的消息。由 pi 的 text_delta/thinking_start 等事件驱动创建。

两者可能不同步：isGenerating=true 但 streamingMessage=null 表示 pi 已收到请求但尚未开始输出内容。

> **术语演进（2026-09）**：`streamingMessage` 实体已消亡——流式态 = 末位消息 `status:'streaming'` + turn 级 `isStreaming` 派生；UI 活跃态 SSOT 是 `isActive`（含 pendingSend 空窗期，`packages/core/src/domain/chat/derive-status.ts` W1）。

### Side Drawer（原 Side Inspector）

> **术语演进**：原 `Side Inspector`（terminology R4 计划改 `SideInspector`）在 v3 重构中收敛为 **Side Drawer**。v3 版更通用：不再限于运行时状态面板，而是 header 多 tab 通用容器。

Panel 联动的浮层抽屉。一个 header + 多 tab 容器，tab 承载不同实体：terminal（终端）/ browser（浏览器）/ git（变更集）/ doc（命令文档）/ detail（文件详情）/ subagent（子代理只读对话流）/ workflow（workflow agent call 列表）/ bashTask（后台命令详情）。tab 枚举与状态 SSOT = `packages/core/src/domain/drawer/types.ts`。与 Panel 数据强耦合，从触发它的 Panel 内浮起，固定挂该 Panel，v1 不跨 Panel 覆盖对侧。

**与旧 Side Inspector 的差异**：旧版三 Tab 是运行时状态面板；v3 版是通用容器，旧三 Tab 的运行时状态能力由 subagent/workflow tab + Flow-3 进度聚合承接。

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

**命名约定**: "Panel" 统一指 Session 的视口（即代码中的 `Panel` / `PanelLeaf` / `PanelTree`，`packages/renderer/src/stores/panel.ts`），不用于其他含义。

---

## v3 UI 结构术语（2026-06 重构）

> 以下术语由 v3-demo 设计稿确立。原规范源 `docs/page-design/archive/v3/architecture-and-terminology.html` 已随 v3 视觉稿于 2026-08-02 被 v6 取代删除（归档说明见 `docs/architecture/v3-specs/README.md`，其指认本章节为术语/拓扑定义载体）；当前视觉 SSOT = `docs/DESIGN.md`。

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

**避免使用**: "插件"（Plugin）——Plugin 指 xyz-agent 自己的插件系统（见下方 Plugin 词条），与 pi Extension 是不同概念。

### Extension UI Bridge
xyz-agent 将 pi extension 的 `ctx.ui.select/confirm/input/notify` 请求映射到 GUI 对话框/通知的机制。使用独立的 WS 事件通道（`extension.ui_request` / `extension.ui_response`），与 Tool Approval 通道完全隔离。

### Extension Data Directory
xyz-agent 管理的 extension 存储目录（`<dataDir>/extensions/`，本地/Git 安装副本 + discovery 扫描根；npm 安装在 `<dataDir>/npm/`，路径唯一来源 `packages/shared/src/paths.ts`）。与内嵌 pi 的 agent 目录（`<dataDir>/agent/`，≙ 系统 pi 的 `~/.pi/agent`）完全分离——xyz-agent 的 extension/skill/config 存储不混入 pi agent 目录，反之亦然（ADR-0009 隔离）。

### Extension Service
runtime 侧服务模块（`packages/runtime/src/services/extension-service.ts`，接口 `IExtensionService`），管理 pi extension 生命周期：发现扫描（用户安装目录 `<dataDir>/extensions/`、npm 目录 `<dataDir>/npm/`）、settings.json `packages[]` 与 `disabled-packages.json` 启停管理、npm / 本地目录 / Git 三种安装来源、将 extension 路径注入 pi 进程启动参数。builtin pi-extensions 的打包内置清单 SSOT = `packages/shared/src/mandatory-extensions.json`（infrastructure 组不可禁、feature 组可禁）。

### Plugin
xyz-agent 自己的插件系统，由 PluginService 统一管理（`packages/runtime/src/services/plugin-service/`，接口 `IPluginService`）。宿主双轨：trusted 插件共享 Worker Thread（≤10 插件/Worker，`plugin-host.ts`），sandbox 插件独占 fork 子进程（`plugin-host-process.ts`，`ELECTRON_RUN_AS_NODE=1`）。使用 agentAPI（非 pi ExtensionAPI）。数据（storage KV、权限授予）存储在 `<dataDir>/plugins/` 下。与 pi Extension 是完全不同的概念。

**避免使用**: "扩展"（Extension）——Extension 指 pi 的扩展，Plugin 指 xyz-agent 的插件。

### Plugin Bridge（`@zhushanwen/pi-plugin-bridge`）
xyz-agent plugin 系统与 pi 引擎之间的桥（`extensions/taiji/plugin-bridge/`，builtin 清单 infrastructure 组）。机制：runtime PluginService 的插件工具清单经 select + BRIDGE_MARKER 通道（pi 公开承诺的 dialog 帧契约）同步进 pi 注册（registerTool），工具 execute、pi 事件转发与 intercept 经同一通道往返 runtime；runtime 侧识别/回包在 `packages/runtime/src/transport/bridge-handler.ts`，协议 v2 形状 SSOT 在 `@xyz-agent/extension-protocol` 的 plugin-bridge 协议模块。Bridge 是插件系统内唯一感知 pi 存在的模块。

> **术语演进**：原「Pi Bridge Extension」基于私有通道（extension_ui_request）的旧方案已废弃重写（bridge-rewrite-pi-0.84）；其「代理 pi.appendEntry()」职责随 sessionData 存储迁移（见下）消亡。

### sessionData
Plugin 的 per-session KV 存储 API（`api.sessionData`）。由 runtime 侧 `SessionDataStore` 承载（`packages/runtime/src/services/plugin-service/session-data-store.ts`）：内存 write-back 缓存（500ms debounce flush）+ 退出前 `flushAll` 落盘，持久化在 `<dataDir>/session-data/` 下按 sessionId 分区，单 session 容量上限 10MB。与 PluginStorage（global/workspace scope，`<dataDir>/plugins/<pluginId>/` 下的 `globalState.json` / `workspace-<cwdHash>.json`）不同。

### Built-in Plugin
随 xyz-agent 打包分发的插件（`source: 'built-in'`，现役实例：`resources/plugins/statusline`）。打包产物落 app resources 的 `plugins/` 目录（electron-builder `to: resources/plugins`），运行时经 `--builtin-plugins-dir` 注入扫描目录（`plugin-registry.ts`，防 cwd 探测被冒充）。自动 trusted（`resolveTrustLevel`：built-in → trusted）、免权限审批（`plugin-permission.ts`）、不参与热重载 watch（`plugin-activator.ts`）。

### Plugin Source
插件的来源分类（`packages/runtime/src/services/plugin-service/plugin-types/descriptor-types.ts` 的 `PluginSource`）：`built-in`（随 app 打包）、`external`（用户安装），仅此两值。

### Plugin Dependency
插件间依赖关系，通过 manifest 的 `extensionDependencies: string[]` 声明（依赖 pluginId 列表）。激活前拓扑排序（Kahn 算法，`plugin-deps.ts`）并检测循环依赖（`detectCycle`）与缺失依赖（`plugin-activator.ts`）。

### Statusline
xyz-agent 的运行时状态可视化。现行形态 = 单组件 `StatusBar`（`packages/ui/src/extension-host/StatusBar.vue`）：main-panel 局部底栏，per panel leaf 挂载（`packages/renderer/src/components/workspace/PanelContainer.vue`），聚合 per-session + global 两个 scope 的状态项，按 alignment(left/right) + priority 排序，项前置状态点（ok/warn/danger/neutral/accent 五色），空项自隐藏。数据来源两条通道：pi extension 的 `setStatus()` → runtime `extension:status` WS 帧（内置 statusline 插件负责桥接，`resources/plugins/statusline`）；xyz-agent plugin 的 `updateStatusBarItem()` → `StatusBarRegistry` → `plugin:statusBarUpdate` 广播（ADR-0015）。

> **术语演进（2026-09 核对）**：旧「三区域」模型（Input Toolbar / Session Strip / Global Statusbar）已不成立——窗口底部的独立全局状态栏不存在，global scope 状态项并入 per-panel StatusBar 聚合；原 Input Toolbar 的职责由 composer 内置工具条承载（见下），plugin 另可经 `composer.toolbar` 挂载点贡献视图（ViewHost，`view-id="composer.toolbar"`）。

### Composer 工具条
composer（Panel zone ④）内底部的展示型工具带（`packages/renderer/src/components/panel/Composer.vue`）：生成指标（`GenStatsTriggers`：速度 t/s + 缓存命中率）、上下文容量（`ContextCapacityPopover`，`context.update` 通道）、模型切换（`ModelSelectPopover`）、思考档位（`ThinkingLevelPopover`）、发送位四态（send/stop/queue/spinner）。renderer 内置组件，非 statusline 数据面。

### WidgetArea
对话流内的单行 pill 状态带（`packages/ui/src/features/chat/WidgetArea.vue`）：聚合该 session 全部 extension widget（todo/goal 等「给 agent 看的工作记忆」），每个 widget 一个 seg（状态点 + 标题 + 进度计数），点击 pill 经 Popover 弹出完整列表浮层，对话流零挤压。

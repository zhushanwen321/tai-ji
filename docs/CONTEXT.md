# taiji 领域术语表（统一语言）

> **关系模型 SSOT**：Project – Session 直接关联（跨目录逻辑分组，cwd 仅展示聚合）见
> [project-session-model.md](project-session-model.md)（D14 语义修正，2026-08-04）。
>
> 2026-09-13：根目录 CONTEXT.md（design workflow 精简统一语言）并入本文件——isActive / Task / 新建任务词条来自该版，其余过时词条（旧 Session 路径、Human Confirm、streamingMessage 现行态）按本文件既有词条为准。

## 核心概念

### Session
一个与 pi 引擎的对话实例。taiji 不存在脱离 pi 的纯本地 session。每个 session 始终绑定一个 pi 进程（活跃时可实时通信，休眠时从 `.jsonl` 文件恢复历史）。持久化在 `<dataDir>/agent/sessions/<encodeCwd>/` 下（pi 按 cwd 自动分子目录，文件名形态 `<ISO时间戳>_<uuid>.jsonl`；路径唯一来源 `packages/shared/src/paths.ts` 的 `getPiSessionsDir`，dev 实例 dataDir 可为 `~/.taiji-dev/instances/<worktree>/`）。

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

### 模式（Mode）
**启动预设（launch preset）的用户可见名**：一组 pi 启动参数（工具面 + 扩展面 + 提示词面）的命名集合，用户可创建/编辑/删除，内置四项（全工具 / Orchestrator / 只读 / 调度）。**代码与协议保留 `preset` 标识**（RPC `preset.*`、类型 `PiLaunchPreset`、**会话绑定字段 `SessionSummary.launchPresetId`**、sidecar `<sessionFile>.preset.json`）——改名只落在用户可见文案层（设置页菜单、landing chip、命令面板、chip tooltip）。

**锁定语义 = 锁模式 id，不锁模式定义**：模式 id 在会话创建时确定、生命周期内不可更换（无任何 UI 路径可切）；模式定义（提示词文本 / 工具面 / 扩展面）以设置页为唯一可信源（活定义），用户编辑后该模式的全部会话（含已建）在**下次进程启动**（restore / fork / respawn）采用新定义。会话 = 对模式 id 的引用，不是创建时快照。

**可见性**：landing 首行第三 chip（可选，三档退化：模式名 → 短名 → 纯图标）+ 对话态 `#meta-row` 只读 chip（**仅非默认模式渲染**，判据 `launchPresetId !== (defaultPresetId || 'builtin:full')`——**用 `||` 不用 `??`**：store 未加载时 `defaultPresetId === ''`，`??` 会让空串穿透，把任意会话误判为非默认）+ 非默认模式在消息流顶部一条派生**模式声明行**（零新 entry 类型，不进 transcript、不进 LLM 上下文）。

### 模式提示词（Mode Prompt）
模式的可选提示词面（`PiLaunchPreset.prompt`）：`replace` 段顶掉 pi 核心系统提示词、`append` 段追加在 pi 基础之后，两段各自启用；**单段与两段合计均 ≤ 16000 字符**。校验双语义：写路（保存 / 导入）整条拒绝、读路（磁盘加载）段级折叠（超限优先丢 `append`）。注入通道 = pi 原生两条 argv（`--system-prompt` / `--append-system-prompt`），**不新增 env、扩展零改动**；替换优先级 = **模式 > 全局 > pi 默认**。链序与 `\n` 前缀构造性区分（防 pi 把文案当文件路径）见 [pi-launch-presets.md §2.6](architecture/pi-launch-presets.md)。

### 调度模式（Session Dispatch Mode）
内置模式 `builtin:session-dispatch`（显示序第 4）：主 agent 只做拆解与派发、执行由独立会话完成。工具面 = `allowlist`（`read/grep/find/ls` + 六个 session 管理工具 + `ask_user/todo`），扩展面 = `denylist` 屏蔽 `@zhushanwen/pi-subagent-workflow`（派发不经 subagent，直接开会话），提示词面 = 预置可编辑 `append` 纪律文案。子会话经 `create_managed_session` 创建，**服务端继承父会话 projectId**（不新增工具参数），在侧栏命名 project 视图与父会话同屏。

### Session 切入链
用户在侧栏点选一个 session 后，前端按固定顺序执行的 12 步动作序列：`cancelActiveFlow → switchSession RPC → setActiveId → clearUnread → ensureStreamSubscription → touchRecency → syncSessionToPanel → navigation.push → hydrate/reconcile → preloadFileTree → touchRecency(panel 绑定 session) → evictLru`。

**代码映射**（renderer-deepening D3/D4，2026-09-03 u5.1/u5.2 落地）：链的唯一载体 = `packages/core/src/domain/session/use-session.ts` 的 `selectSession`（12 步顺序有接口级断言，改时序只改这一处）；跨域步骤（取消新建任务流 / 清未读 / 流订阅 / chat LRU / 文件树预加载）经 `SessionEntryPort` 端口束注入（全成员可选、缺省 no-op），桌面壳 `useSidebar.selectSession` 为一行代理 + 端口接线（原 `useSidebarNew` 已于 2026-08-31 改名回 `useSidebar`、旧轨删除——chat-stream-perf §3.3 D-D3；现桌面壳编排 = `packages/renderer/src/composables/features/sidebar/useSidebar.ts`），headless/mobile 未接线环境零新增步骤执行完整链。时序采 panel-first（panel/导航先于历史回填，链尾两步保护 panel 绑定 session 不被 LRU 驱逐——[lru-panel-exempt-fix]）；「订阅先于 panel 载入」前提（C-W3-4，2026-07-29 handoff 回复丢失事故）由链本体步 5→7 顺序保证，不再依赖注释跨文件同步。

### 导入源（Import Source）
session 导入统一入口的多 coding-agent 抽象：一个导入源负责「定位外部会话 → 校验 → 转换为合法 pi session JSONL」，实现 runtime 的 SessionImportSource SPI（`listCandidates` + `prepareImport`）；公共编排（互斥/去重/原子落盘/sidecar）由 ImportService 统一承担，导入完成广播由 handler 层在 reply 后发出。现役源：pi（外部 pi JSONL 原样复制）、zcode（宿主 SQLite 库转换）。导入产物落太极 sessions 目录后完全复用现有会话消费链（渲染/续聊/搜索），导入后续聊由 pi 引擎接管。**幂等键 = 产物 header.id**；**文件名不变量**：文件名剥 `.jsonl` 后最后 `_` 尾段 === header.id（源 id 含 `_` 须归一化）。扩展指南（新增源的步骤清单与不变量全集）：[docs/architecture/session-import-sources.md](architecture/session-import-sources.md)。

### Agent Runtime
taiji 的后端服务进程（Node.js）。职责：托管 pi 子进程的生命周期、协议翻译（pi stdin/stdout JSON RPC ↔ WebSocket）、session CRUD、配置持久化（provider/skill/agent）、model 查询。是 taiji 唯一的后端，所有业务逻辑和数据持久化都在这里。前端不直接和 pi 通信，前端不做业务决策。

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

taiji 与 pi 之间对 pi 私有语义的统一适配层（[ADR-0064](../adr/decisions.md)）：对 pi 语义的推断与跨边界承诺只在边界一次吸收，域内只剩确定性；EventAdapter 只适配传输格式，语义适配归本层，散布在各处的本地推断即「影子推断」。四支柱（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫）的权威词条落 [extensions glossary 的 pi 边界可靠性段](../extensions/glossary.md)，设计全文见 [docs/architecture/pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)。

### Subagent

> **术语演进（2026-09）**：旧「树形引擎 / TaskNode / TaskTree」词条随树形引擎退役消亡（旧实现 = subagent-workflow 单包三层，已迁 `packages/subagent-core` + 引擎协议化，历史见 [subagents/architecture.md §7](../extensions/subagents/architecture.md)）。本词条描述现行体系。

taiji subagent 体系的子任务执行单元：由引擎进程派生子进程（pi 引擎 spawn pi 子进程；zcode 引擎走 app-server RPC）执行子任务，宿主与引擎经 engine-protocol v1（NDJSON stdio）通信。体系由 5 类包协作：shell（`extensions/universal/subagent-workflow`）→ host core（`packages/subagent-core`）→ engine（`packages/pi-subagent-cli` / `packages/zcode-subagent-cli`）→ contract（`packages/subagent-engine-sdk`）。结构导航 SSOT：[docs/extensions/subagents/architecture.md](../extensions/subagents/architecture.md)。

### Fan-out / 批量派发

2+ 独立任务并行、结果收齐一起处理的批量编排形态。唯一入口是 `subagents` 批量 tool：一次调用传 `tasks` 数组（每个元素 = 一条自包含任务 prompt），handler 转译 `runWorkflow("fan-out")` 走 workflow 单管道——`parallel()` allSettled 并行派 N 个一次性成员（one-shot，不可 message/续聊，恢复 = 重派），任一成员失败降 `partial` 不炸 run；run 收口后主 agent 收到一条聚合结果通知（结构化 results：task / taskIndex / status / summary / fullReportPath）。机制落点：[subagents/architecture.md §4 批量编排行](../extensions/subagents/architecture.md)。

**collect 退役迁移说明（2026-09-16 落地）**：
1. 旧调用形态（`subagent start` 显式带 `collect` 字段）不会被 pi 拒绝——typebox 参数校验无 `additionalProperties`，未知字段静默放行且不剥离；字段退役后行为等价原 `collect:"async"` 缺省路径（立即逐条通知），无迁移动作、无功能损失。
2. 误读风险 = 调用方以为仍会攒批、等一条聚合通知——`subagent` tool 的 start description 已留迁移期提示（"The former collect param is removed — for 2+ independent tasks in one dispatch, use the `subagents` tool instead."）。
3. 2+ 独立任务并行的正确调用 = `subagents` tool（`tasks` 数组、一次调用、一条聚合结果通知）。

### Resume 锚点（锚）

subagent 跨 run 续聊时定位既有会话的凭据（引擎中立形态 `ResumeAnchor`，`packages/subagent-engine-sdk/src/protocol/contract-types.ts`）：引擎自选载体——zcode 锚 = `sessionRef {sessionId, dbPath}`（隔离库定位），pi 锚 = `{recordId?, sessionFile?}`（JSONL 定位）。经 `run.params.resume` 协议帧携带；锚判活 = 引擎侧载体存在性（库条目/文件在），失效走世代推进（reopen，同 id 带历史重开）。衍生用语：「锚稳定」（续轮 sessionId 不变）、「锚换钉」（锚被替换为新会话锚，历史连续性切断的降级形态）、「锚生命周期」（锚的确立/复刻/清空时点义务）。契约义务权威：[docs/extensions/subagents/engine-development-guide.md](../extensions/subagents/engine-development-guide.md) §5/§7/§10。

### Execution Record

subagent 运行状态的单一真源（`packages/subagent-core/src/execution/persistence/execution-record.ts` + `record-store.ts`）：内存 record 与磁盘 `session.jsonl` 重建两条通路共用同一 reducer；对外状态两态（`active` / `idle`，ended 随终态概念删除），收口经 `<session>.state` sidecar 标记。

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
有状态的执行实体，配置形态 = `.md` 文件（frontmatter 元数据：name、description、tools 等 + body：systemPrompt）。taiji 强制目录 `<dataDir>/agents/`（ADR-0021），CRUD 经 runtime ConfigService（`services/agent-config-helper.ts` + `infra/pi/agent-crud.ts`）；subagent/workflow 派生子任务时按 agent 名选用，拥有独立的对话流和生命周期。pi 侧同名概念（user/project 级 agents 目录发现）见 [extensions glossary](../extensions/glossary.md)。

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

extension 与 taiji runtime 之间的请求-回包通道原语（`packages/extension-protocol/src/core/select-rpc.ts` 的 `callMarkerRpc`）：extension 侧以 `ctx.ui.select(MARKER, [payload])` 发起（payload 为已序列化字符串），runtime 侧对应 handler 响应同一 marker。回包是判别联合 `MarkerRpcResult`——`{ok:true, value}`（value 恒 raw string，JSON 合法性由原语检测但 parse 消费留调用方）或 `{ok:false, reason}` 四态失败（`cancelled` / `timeout` / `channel-error` / `non-json`，由 `signal.aborted` 反推区分）。mode 门控（裸 TUI 下不发）留在调用方。现役消费方：session-manager / plugin-bridge / subagent-workflow inflight-reporter / ui-form（统一表单协议，见下节）；错误回包形状单源为 `ChannelErrorResult`。

### 统一表单协议（ui-form，2026-09-19）

ask-user / scheduler / plan 三个 extension 提问交互的统一协议：问题即数据（类型化问题集），GUI 链路一个入口一个渲染器——多问 = 多 tab，单问 = 单视图（planReview 审批条与 permission 等 band 流程对话框不属提问表单，不在收口范围）。协议 SSOT = `packages/extension-protocol/src/extensions/ui-form/`：

- **问题集 `FormQuestion` 判别联合**：`choice`（选项题：`options`（label 即选中值，无独立 value 字段）/ `multi` 多选 / `allowOther`，默认 true）/ `text`（纯自由文本）/ `schedule`（时间输入整表单，`initial` 预填 `ScheduleDraft`）。answers key = `header ?? question`。
- **回传 `FormAnswers = Record<string, string>`**：choice 单选 = label、多选 = `JSON.stringify(labels[])`、Other 文本独立键 `${key}__other`、text 键位 `${key}__other`（与纯 Other 形态同键位）、schedule value = `JSON.stringify(ScheduleFormResult)`。choice/text 部分与 `AskUserAnswers` 逐字兼容——`getAskUserAnswer` / `getAskUserOther` 解码零改动。
- **wire 通道**：extension 侧统一入口 `uiFormInteract(ctx, form, opts?)`（传输核复用 [Marker RPC](#marker-rpcselectmarker-通道原语2026-09-14) 的 `callMarkerRpc`）以 `UI_FORM_MARKER = '\x00TAIJI_UI_FORM'` 为 select title、`options[0]` 携 `{ formQuestions, allowCancel }` JSON；runtime event-adapter 按 marker 翻译为 `extension.ui_request` 帧（`form: true` + `formQuestions`，逐项 `isFormQuestion` 守卫过滤，全不合法降级普通 select 落 band）；renderer `FormOverlay`（`packages/renderer/src/components/extension/form/`）Panel 内联覆盖 composer 渲染，按问题 type 分派渲染器（ChoiceQuestion / TextQuestion / ScheduleForm）。回包四态判别（`cancelled` / `timeout` / `channel-error` / `non-json`），channel-error 含 **echo 检测**——收包等于发送 payload 时报「宿主过旧需升级」（旧 taiji × 新扩展组合的确定性识别）。
- **TUI 契约**：`uiFormInteract` 在 TUI 误调抛错——formQuestions 在 TUI 无呈现语义，各 extension 自行渲染（ask-user AskUserComponent / scheduler ScheduleCreateComponent / plan 原生 select），属有意取舍。
- **版本偏斜窗口**：旧 ask-user 帧（`askUser` + `askUserQuestions`）/ 旧 scheduler 帧（`scheduleCreate` + `scheduleDraft`）由 renderer `normalizeFormRequest` 双挂点归一（bus 判定前 + pending addRequest 前）后进 FormOverlay。退役窗口终局（新 marker 版三包 npm 发布 + 一个大版本后独立 PR）：event-adapter 的 ASK_USER / SCHEDULE_CREATE legacy 分支、两旧 marker 常量、payload 旧字段、renderer 归一层、ask-user channel 旧名注册（`ask_user`）一并清理。

**代码映射**: `packages/extension-protocol/src/extensions/ui-form/`（types/marker/helpers/guards）；消费方 `extensions/universal/{ask-user, scheduler, plan}/src/`；渲染面 `packages/renderer/src/components/extension/form/`。

### Schedule Create（schedule 创建确认，2026-09-18）

`schedule` 工具创建路径的「先确认后创建」交互：agent 提交预填草稿，用户可视化确认/调整后任务才创建，取消 = 不创建（agent 收到明确 cancelled 语义，不猜测、不重试）。交互入口已收口[统一表单协议](#统一表单协议ui-form2026-09-19)：extension 侧 `uiFormInteract` 携 `ScheduleQuestion` 单问整表单（预填草稿经 `initial` 直传，打开即可一键确认），GUI 由 FormOverlay 的 ScheduleForm 渲染器呈现，确认回包 `FormAnswers` envelope 解出 `ScheduleFormResult` 经 `isScheduleFormResult` 判别（判别职责在 scheduler 包内）；TUI 走 `ctx.ui.custom` 挂 `ScheduleCreateComponent`。scheduler-create 模块现为共享资产层：草稿 `ScheduleDraft`（LLM 参数即预填值，含 `models` 列表注入）与回传 `ScheduleFormResult`（`action: 'create'`；取消不走此形状——select resolve undefined）契约类型 + `isScheduleDraft` / `isScheduleFormResult` 形状守卫 + 时间折叠单点 `dateToOnceCron` / `onceCronToDate`（一次性时刻 ↔ 一次性 cron（5 段 `分 时 日 月 *`）互转，GUI/TUI 共用禁止双实现）。

### 计划模式（Plan Mode）

pi-plan extension 提供的只读规划态：用户输入 `/plan <需求> [--skills a,b]` 或 `/plan <需求> --template <path>` 进入，agent 限只读工具集（read/bash/grep/find/ls/plan），按挂载技能（AI 自行 read 技能 SKILL.md）或模板流程产出计划文档——模板三源发现（内置 5 + 用户级 `~/.agents/plans/` + 项目级 `.agents/plans/`，同名项目 > 用户 > 内置 last-writer-wins），进入计划态时清单以 `<available-plans>` 段随提示词一次性注入（name + location，模型自选，无查询 action），`select-template` 返回 content 携带胜者文件全文、错名报错自带可用清单；`--template` 直传任意外部 md（与 `--skills` 互斥 fail-fast）时提示词内嵌该文件全文且不注入清单段。文档就绪后 `submit-review` 挂审阅，用户三键裁决（确认执行 / 提交评论并要求修订 / 请求进一步解释），approve/abort 退出并恢复工具集；approve 后调 `complete` 时弹出执行方式选择（统一表单协议单 choice 问题）：内置 Develop (auto-parallel)（LLM 自判复杂度）+ 自动检测带 `plan-exec: true` frontmatter 的 skill（四根扫描，同构 pi loadSkillsFromDir）+ goal 档（能力在场时）。修订后重写文档须重调 `register-doc`（version+1）。taiji 形态的挂载信号 = `TAIJI_AGENT_EXT_LOG=1`（runtime 对托管 pi 恒注入）。

**代码映射**: `extensions/universal/plan/src/`（command.ts 命令与 --skills/--template 解析 / tool.ts 五 action / state.ts 状态 / prompts.ts 提示词四段（模板流程含三源清单注入与直传全文内嵌）/ index.ts hooks）。

### plan-state entry

计划模式在 session JSONL 中的持久化状态条目（customType 字面量 `"plan-state"`，session 内取最后一条为当前态）。字段 = 现状四字段 `isActive` / `planFilePath` / `requirement` / `templateName` + 五个 optional 字段 `templateProvidedPath`（`--template` 直传标记：直传进入时为展开后模板绝对路径，select-template 防御判据；模板流程缺失）/ `skills`（挂载技能名）/ `docs`（产物清单 `PlanDocMeta[]`：fileName + absPath + sourceSkill + version）/ `reviewState`（`awaiting` 审阅挂起 | `revising` 修订中 | 无值 进行中）/ `lastSubmitReviewDocsFingerprint`（submit-review 重提交指纹快照）。旧 entry（无新字段）逐字段降级读。runtime 投影链按同字面量派生扫描，前端消费与冷启动首拉共用同一份派生代码。

**代码映射**: `extensions/universal/plan/src/state.ts`（schema + 重建/落盘唯一入口）；`packages/extension-protocol/src/core/types.ts` 的 `PlanDocMeta`（产物元数据契约）。

### PLAN_REVIEW_MARKER

plan 审阅请求的 select title marker（`\x00TAIJI_PLAN_REVIEW:`，与 `UI_FORM_MARKER` / `GUI_WIDGET_MARKER` 同族 select 通道 marker）：pi-plan 的 `submit-review` 挂审批时以此 marker 为 title 发 `ctx.ui.select`（options[0] = `PlanReviewRequest` JSON：`{ docs }`），runtime event-adapter 按 marker 检测后广播 `extension_ui_request`（planReview 标记，与 form 帧同构分流），前端审批条渲染三键审批而非原始 dialog——marker 控制符 title 落入通用 dialog 会渲染成乱码。回传 `PlanReviewResponse` 判别联合（approve 无评论 / revise·explain 必带 `{ quote, comment }[]`）。

**代码映射**: `packages/extension-protocol/src/core/markers.ts`（常量）+ `core/types.ts`（payload/decision/comment 契约 SSOT）。

### record 投影链

会话持久派生态到前端 stateSnapshot 的统一通道（subagent/workflow 现役，plan-state 为第三员——plan-mode-redesign 方案 A）。链路：custom entry append → event-adapter `handleEntryAppended` 白名单 → interpreter record 联合类型 + 失效透传 → `SessionRecords.invalidateRecordEntries` 派生扫描（冷启动读盘与 live 更新共用同一份派生代码，live ≡ reload 构造性成立）→ publish 走 diff 基线 → message-bus `TOPIC_TABLE` / `STATE_TYPE_KEY_MAP` 分发 → 前端 store 订阅 + 切换/冷启动 RPC 首拉。三道运行时 customType 门 + 冷启动首拉全部要过，缺一则静默失效（三道门均为字符串判定，编译器不保护——加员时逐点核对）。

**代码映射**: `packages/runtime/src/infra/pi/event-adapter.ts` / `packages/runtime/src/services/session/session-records.ts` / `packages/runtime/src/services/message-bus/message-bus.ts`。

### Tool Approval
工具权限审批。Agent 执行危险操作（如写入文件、运行命令）前请求用户许可。用户回复是三选一：Allow（本次允许）/ Deny（拒绝）/ Always Allow（永久允许该工具）。

### Ask User（ask_user）

> **术语演进（2026-09 核对）**：原词条「Human Confirm」的代码符号已消亡，任务级用户确认统一到 ask_user 概念（主对话的 ask-user 工具与子代理的反向 UI 通道是同一交互面）。

agent（主对话或子代理 run）在执行中请求用户输入/确认的交互。子代理场景的链路：引擎进程的 dialog/UI 请求经 engine-protocol v1 的 `host/askUser` 反向通道到达宿主（`packages/subagent-core/src/execution/ui/ui-request-handler-factory.ts`，dialog 类经 `dialog-queue.ts` 跨子进程串行），GUI 模式透传进宿主 UI 通道，以 extension UI 请求呈现给用户（富交互形态 = [统一表单协议](#统一表单协议ui-form2026-09-19)的 FormOverlay：选项/多选/Other/自由文本）。ask-user 包的 channel-handler 以 `ui_form` / `ask_user` 双通道名注册并双读 `formQuestions ?? questions` 入参（孙进程版本不可控的兼容面）。用户回复不是简单的 allow/deny，可以是自由文本、修正指令或附加信息。

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
pi session 文件（JSONL）中通过 `parentId` 构建的逻辑树结构。同一文件内可存在多个分支（fork 点），唯一的可变状态是内存中的 `leafId` 指针。taiji 通过 runtime 直接读取 JSONL 文件构建树，不依赖 pi RPC。

**术语映射**:
- Entry — JSONL 文件中每行一个 JSON 对象（message/branch_summary/label 等）
- leafId — pi 进程内存中指向当前活跃分支末端的指针，不在 JSONL 文件中持久化
- Navigate — 在同一文件内移动 leafId 到历史某个 entry（不创建新文件）
- Fork — 从历史某个 entry 创建新 session 文件，复制 root→entry 的路径
- Clone — Fork 的特例，在当前 leaf 位置复制完整路径

### ~~Panel Grid~~（v3 已废弃）

> **废弃说明**：v3 重构后窗口内最多双 Panel（主从模式），不再需要“全局 panel 缩略图网格”。鸟瞰形态已随 Overview 视图整体移除而消亡（见 [ADR-0067](adr/decisions.md)），会话统筹由 Sidebar Session List 承担。旧 `overviewVisible`/`toggleOverview` 等代码引用待清理。

~~全局面板网格视图。展示所有 Panel 的缩略图，类似 macOS Mission Control / Windows Task View。用于快速定位和跳转 Panel。~~

### Window
操作系统级 Electron BrowserWindow。v3 拓扑：窗口 (bg-base 平铺) 内含 `.app-shell`（flex + p-3），由持久 **Sidebar**（透明融合）+ 可切换的 **main** 区（float-panel 浮起）组成。main 区在 chat / settings 两 view 间互斥切换。支持多窗口。

**命名约定**: "Panel" 统一指 Session 的视口（即代码中的 `Panel` / `PanelLeaf` / `PanelTree`，`packages/renderer/src/stores/panel.ts`），不用于其他含义。

---

## v3 UI 结构术语（2026-06 重构）

> 以下术语由 v3-demo 设计稿确立。原规范源 `docs/page-design/archive/v3/architecture-and-terminology.html` 已随 v3 视觉稿于 2026-08-02 被 v6 取代删除（归档说明见 `docs/architecture/v3-specs/README.md`，其指认本章节为术语/拓扑定义载体）；当前视觉 SSOT = `docs/DESIGN.md`。

### Sidebar（侧栏）
L0/L1。持久容器（非单列表），所有 view 共用。顶部 Logo + 主操作区 → segmented tab（会话|文件|Plugins）互斥切换 → 子视图列表 → 底部设置/用户。透明融合于 base（无 background）。折叠态。

### Workspace（工作区）
L1 Region。main 区在 `view=chat` 时的容器。承载双 Panel 主从模式（单 Panel = 默认态，开第二 session 才 split）。

### Panel（面板）的 5 zone
L2 Module。一个 Panel 内部固定 5 个 zone 自上而下：① panel-header（per-session 元信息）② message-stream（消息流 + 回合折叠）③ progress-zone（单 Session 进度，内嵌 composer 上方）④ composer（输入区 + 工具区）⑤ git-zone（暂存/提交/Diff 入口）。

### Search Modal（搜索浮层）
L1 Overlay。⌘K 全局搜索浮层，归 Overlay 层（非 Sidebar 子组件）。Sidebar 仅保留触发入口。

### Extension
pi 引擎的扩展模块，通过 `ExtensionAPI` 注册工具、监听事件、注册命令。taiji 通过 RPC 透出 pi extension 的能力到 GUI 层。Extension 运行在 pi 子进程内，taiji 不负责加载/执行 extension 代码，只负责 UI 交互桥接和生命周期管理。

**避免使用**: "插件"（Plugin）——Plugin 指 taiji 自己的插件系统（见下方 Plugin 词条），与 pi Extension 是不同概念。

### Extension UI Bridge
taiji 将 pi extension 的 `ctx.ui.select/confirm/input/notify` 请求映射到 GUI 对话框/通知的机制。使用独立的 WS 事件通道（`extension.ui_request` / `extension.ui_response`），与 Tool Approval 通道完全隔离。

### Extension Data Directory
taiji 管理的 extension 存储目录（`<dataDir>/extensions/`，本地/Git 安装副本 + discovery 扫描根；npm 安装在 `<dataDir>/npm/`，路径唯一来源 `packages/shared/src/paths.ts`）。与内嵌 pi 的 agent 目录（`<dataDir>/agent/`，≙ 系统 pi 的 `~/.pi/agent`）完全分离——taiji 的 extension/skill/config 存储不混入 pi agent 目录，反之亦然（ADR-0009 隔离）。

### Extension Service
runtime 侧服务模块（`packages/runtime/src/services/extension-service.ts`，接口 `IExtensionService`），管理 pi extension 生命周期：发现扫描（用户安装目录 `<dataDir>/extensions/`、npm 目录 `<dataDir>/npm/`）、settings.json `packages[]` 与 `disabled-packages.json` 启停管理、npm / 本地目录 / Git 三种安装来源、将 extension 路径注入 pi 进程启动参数。builtin pi-extensions 的打包内置清单 SSOT = `packages/shared/src/mandatory-extensions.json`（infrastructure 组不可禁、feature 组可禁）。

### Plugin
taiji 自己的插件系统，由 PluginService 统一管理（`packages/runtime/src/services/plugin-service/`，接口 `IPluginService`）。宿主双轨：trusted 插件共享 Worker Thread（≤10 插件/Worker，`plugin-host.ts`），sandbox 插件独占 fork 子进程（`plugin-host-process.ts`，`ELECTRON_RUN_AS_NODE=1`）。使用 agentAPI（非 pi ExtensionAPI）。数据（storage KV、权限授予）存储在 `<dataDir>/plugins/` 下。与 pi Extension 是完全不同的概念。

**避免使用**: "扩展"（Extension）——Extension 指 pi 的扩展，Plugin 指 taiji 的插件。

### Plugin Bridge（`@zhushanwen/pi-plugin-bridge`）
taiji plugin 系统与 pi 引擎之间的桥（`extensions/taiji/plugin-bridge/`，builtin 清单 infrastructure 组）。机制：runtime PluginService 的插件工具清单经 select + BRIDGE_MARKER 通道（pi 公开承诺的 dialog 帧契约）同步进 pi 注册（registerTool），工具 execute、pi 事件转发与 intercept 经同一通道往返 runtime；runtime 侧识别/回包在 `packages/runtime/src/transport/bridge-handler.ts`，协议 v2 形状 SSOT 在 `@zhushanwen/extension-protocol` 的 plugin-bridge 协议模块。Bridge 是插件系统内唯一感知 pi 存在的模块。

> **术语演进**：原「Pi Bridge Extension」基于私有通道（extension_ui_request）的旧方案已废弃重写（bridge-rewrite-pi-0.84）；其「代理 pi.appendEntry()」职责随 sessionData 存储迁移（见下）消亡。

### sessionData
Plugin 的 per-session KV 存储 API（`api.sessionData`）。由 runtime 侧 `SessionDataStore` 承载（`packages/runtime/src/services/plugin-service/session-data-store.ts`）：内存 write-back 缓存（500ms debounce flush）+ 退出前 `flushAll` 落盘，持久化在 `<dataDir>/session-data/` 下按 sessionId 分区，单 session 容量上限 10MB。与 PluginStorage（global/workspace scope，`<dataDir>/plugins/<pluginId>/` 下的 `globalState.json` / `workspace-<cwdHash>.json`）不同。

### Built-in Plugin
随 taiji 打包分发的插件（`source: 'built-in'`，现役实例：`resources/plugins/statusline`）。打包产物落 app resources 的 `plugins/` 目录（electron-builder `to: resources/plugins`），运行时经 `--builtin-plugins-dir` 注入扫描目录（`plugin-registry.ts`，防 cwd 探测被冒充）。自动 trusted（`resolveTrustLevel`：built-in → trusted）、免权限审批（`plugin-permission.ts`）、不参与热重载 watch（`plugin-activator.ts`）。

### Plugin Source
插件的来源分类（`packages/runtime/src/services/plugin-service/plugin-types/descriptor-types.ts` 的 `PluginSource`）：`built-in`（随 app 打包）、`external`（用户安装），仅此两值。

### Plugin Dependency
插件间依赖关系，通过 manifest 的 `extensionDependencies: string[]` 声明（依赖 pluginId 列表）。激活前拓扑排序（Kahn 算法，`plugin-deps.ts`）并检测循环依赖（`detectCycle`）与缺失依赖（`plugin-activator.ts`）。

### 宿主元数据键 `"taiji"`（package.json 顶层）
pi extension 包与 subagent engine 包的 package.json 顶层命名空间键（键 = 平台命名空间，对齐 pi 的 `pi.agents` 先例）。两种现役形态：extension 包 `{"taiji": {"role": "taiji" | "universal"}}`（目录分组声明，`scripts/check-extension-dependencies.mjs` 校验 role 与所在目录组一致）；engine 包 `{"taiji": {"subagentEngine": {...}}}`（引擎协议声明，消费方 `scripts/bundle-extensions.mjs` / `validate-runtime-bundle.sh` / `postbuild-validate.sh`）。仅宿主消费，随包发布但对独立 pi 用户无影响。

### 插件清单键 `taijiPlugin`（plugin-sdk 契约）
taiji Plugin 的 package.json 清单键（`packages/plugin-sdk` 类型契约）：`"taijiPlugin": { manifestVersion, main, activationEvents, trustLevel, source, permissions, engines? }`，其中 `engines: { 'taiji': <版本> }` 声明兼容的宿主。字段细则见 [built-in-plugin-guide.md](plugins/built-in-plugin-guide.md)。**近形防混淆**：与上一条「宿主元数据键 `"taiji"`」是两个不同契约层面——裸 `"taiji"` 键（extension/engine 包宿主元数据）≠ `taijiPlugin` 键（Plugin 系统插件清单）；脚手架入口 `packages/create-taiji-plugin`。

### Statusline
taiji 的运行时状态可视化。现行形态 = 单组件 `StatusBar`（`packages/ui/src/extension-host/StatusBar.vue`）：main-panel 局部底栏，per panel leaf 挂载（`packages/renderer/src/components/workspace/PanelContainer.vue`），聚合 per-session + global 两个 scope 的状态项，按 alignment(left/right) + priority 排序，项前置状态点（ok/warn/danger/neutral/accent 五色），空项自隐藏。数据来源两条通道：pi extension 的 `setStatus()` → runtime `extension:status` WS 帧（内置 statusline 插件负责桥接，`resources/plugins/statusline`）；taiji plugin 的 `updateStatusBarItem()` → `StatusBarRegistry` → `plugin:statusBarUpdate` 广播（ADR-0015）。

> **术语演进（2026-09 核对）**：旧「三区域」模型（Input Toolbar / Session Strip / Global Statusbar）已不成立——窗口底部的独立全局状态栏不存在，global scope 状态项并入 per-panel StatusBar 聚合；原 Input Toolbar 的职责由 composer 内置工具条承载（见下），plugin 另可经 `composer.toolbar` 挂载点贡献视图（ViewHost，`view-id="composer.toolbar"`）。

### Composer 工具条
composer（Panel zone ④）内底部的展示型工具带（`packages/renderer/src/components/panel/Composer.vue`）：生成指标（`GenStatsTriggers`：速度 t/s + 缓存命中率）、上下文容量（`ContextCapacityPopover`，`context.update` 通道）、模型切换（`ModelSelectPopover`）、思考档位（`ThinkingLevelPopover`）、发送位四态（send/stop/queue/spinner）。renderer 内置组件，非 statusline 数据面。

> **命中率归因降噪（2026-09-19）**：缓存命中率 `current` 是「本会话最近一次 LLM 请求」的单样本口径，任何一次 total miss 都会显示 0%。已知成因的 0%（会话首请求 `cold-start` / 空闲超 5min provider TTL `idle-expiry` / compaction 后前缀重建 `context-rewrite`）改为渲染成因文案（`cacheRatio.currentMiss`，中性色 + 浮层说明行），未知成因的 0%（如服务端淘汰）**保留原值三档色**——降噪只覆盖预期内 miss，不吞真信号；provider 从未上报 cache 字段时命中率为「无数据」（null，显示「—」）而非 0%。

### 任务托盘（Widget Tray）
composer 工具条左簇的常驻观察入口（`packages/renderer/src/components/panel/tray/`，`ComposerTray.vue`）：条目 = built-in 四件（后台命令 / 子代理 / 工作流 / **子会话**，固定序）+ 协议 widget 区（extension 经 `setWidget` 推送的 todo/goal 等「给 agent 看的工作记忆」，icon/badge/状态色由 `WidgetMeta` 驱动）。hover icon 弹出该条目的分桶面板（计数与行集同源，可就地 kill/cancel/abort、点行开 drawer 详情，子会话行点开即跳该会话），点击 icon 可 pin。三态：该类有进行中 → accent 计数 + 呼吸点；仅历史 → dim 常驻；全无记录 → 不渲染（归零不虚噪）。窄窗口下底盘密度状态机可将整托盘聚合为「层叠图标 + 运行数」单入口（层叠图标 = 聚合入口，省略号 = 溢出菜单入口，两者不共用）。设计文档 `docs/design/composer-task-tray.md`。

> **术语演进（2026-09 核对）**：原「WidgetArea」（对话流内的单行 pill 状态带，`@taiji/ui` 组件）已退役——widget 消费端收敛为上述托盘（2026-09-16，设计 D11：对话流回归纯内容，入口唯一化）。子会话第 4 件为模式体系设计 D7 新增（u7 已落地，面板 `TraySessionPanel.vue` 为扁平列表而非分桶槽）。

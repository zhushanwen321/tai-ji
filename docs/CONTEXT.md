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
用户视角的「session 在忙」信号。定义：`isGenerating ∨ pendingSend`。UI 层（圆点/状态点/Composer/Panel 检查）统一消费此信号，不直接用 isGenerating。isCompacting 是独立互斥态（compact 期间不可 steer/abort），不并入 isActive，但 deriveStatus 第 4 参数 isCompacting=true 时也返回 running（视觉态属 running）。实现：`packages/core/src/domain/chat/derive-status.ts`。

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

### 通知债权（claim / lifetime / notifyId）

managed session 完成通知的判据模型（[ADR-0087](adr/decisions.md)）：一笔债权 = 主 session 一次「等待子会话结果」的请求，携带唯一 `notifyId`（幂等键，`sm-` 前缀形态）；请求被消费的轮次结束时销账并经 B-ledger 通知一次，无债权的完成一律静默。两种记录：**claim**（随单笔请求生灭——create+prompt / send 成功产生，settle 兑现 / exit·deleted 终结 / 主 abort 抹除）与 **lifetime**（随 session 生灭——create 时 runtime 自动 arm，非 respawn 链终局死亡时发声，携带 runtime 生成的 `lifetimeNotifyId`，与 claim 键独立杜绝撞幂等键）。claim 状态机 = `armed → injected → fulfilled → 删除`，吸收/终态 `orphaned` / `aborted`；唯一键 `(parentSessionId, notifyId)`，重复 arm 拒绝。**不变量**：债权只在 session-manager 通道产生与消灭，UI 续聊/插话、scheduler、孙会话回流一律不触碰（「插话仍通知」「只通知第一次」均由不变量推导，无需特判 flag）。

**代码映射**: `packages/runtime/src/services/session/notify-claims.ts`（ClaimLedger 纯状态机）。

### watch 桥

session-manager extension 与 taiji runtime 之间的长挂应答事件通道（[ADR-0087](adr/decisions.md)）：extension 以 `{action:'watch', params:{notifyId}}` **单键寻址** fire-and-forget 挂起 select（不传 timeout，前提 = marker select 长挂语义探针实测），runtime 按（调用方 parentSid, notifyId）反查 claim 后 deferred respond——查无 fail-closed 立即 'cancelled'、已兑现 catch-up 快照、未兑现挂等、已终结回终结 reason；每 claim 单 watch 槽新覆盖旧（被覆盖的旧 watch 悬置为已知无害）。respond payload 回带 `sessionId` + `deathSeq`/`settleSeq`/`fulfills N`/`exitCode`/`stderrTail`/`sessionFilePath`，extension 据此 unregister + `notifyLedger.record`（两例外：cancelled·orphaned 静默、死亡新闻槽 (sessionId, deathSeq) 去重）。它把「生命周期观测者在 runtime、注册者在父 pi 进程内」的跨进程缝桥起来，是 managed session 并入 pending-notifications 注册面与 notify-ledger 送达面的唯一事件通路。与 [Marker RPC](#marker-rpcselectmarker-通道原语2026-09-14) 的区别 = 挂起等待状态迁移，而非即问即答。

### pending type 'session'

`pending_notifications` 查询面的注册类型之一：managed session 债权在挂期间以三键 `{id: notifyId, type: 'session', name}` 注册（P4 既有 emit 契约零改动；lifetime 同类——每子会话 1 条 register，随终局死亡 unregister，写入面每 session 共 2 行 entry）。词表真身 = `extensions/universal/pending-notifications/src/state.ts`（`PendingType` 扩值 + `normalizePendingType` 放行，否则写侧归一成 'workflow' 展示错标）；`reconcile-sweep` 按 raw type 分流时对 `session` 跳过（不入 workflow run-state 判据，防误销活跃 claim）；注销 reason 经 `mapReasonToStatus` 族映射（stopped→aborted、exited/deleted/orphaned→cancelled），**不扩共享词表**——精确状态由通知正文与 `get_session_status` 承载。消费方 `countActiveFromEntries()` 不传 type 过滤，managed session 计入活跃集 = 有意为之（goal continuation 守卫在子会话未收口时不误判「已干完」）。

**代码映射**: `extensions/universal/pending-notifications/src/state.ts`（词表）；`packages/extension-protocol/src/pending-entries.ts`（族映射）；`packages/subagent-core/src/execution/round-supervisor/reconcile-sweep.ts`（skip 分支）。

### Session 切入链
用户在侧栏点选一个 session 后，前端按固定顺序执行的 12 步动作序列：`cancelActiveFlow → switchSession RPC → setActiveId → clearUnread → ensureStreamSubscription → touchRecency → syncSessionToPanel → navigation.push → hydrate/reconcile → preloadFileTree → touchRecency(panel 绑定 session) → evictLru`。

**代码映射**（renderer-deepening D3/D4，2026-09-03 u5.1/u5.2 落地）：链的唯一载体 = `packages/core/src/domain/session/use-session.ts` 的 `selectSession`（12 步顺序有接口级断言，改时序只改这一处）；跨域步骤（取消新建任务流 / 清未读 / 流订阅 / chat LRU / 文件树预加载）经 `SessionEntryPort` 端口束注入（全成员可选、缺省 no-op），桌面壳 `useSidebar.selectSession` 为一行代理 + 端口接线（原 `useSidebarNew` 已于 2026-08-31 改名回 `useSidebar`、旧轨删除——chat-stream-perf §3.3 D-D3；现桌面壳编排 = `packages/renderer/src/composables/features/sidebar/useSidebar.ts`），headless/mobile 未接线环境零新增步骤执行完整链。时序采 panel-first（panel/导航先于历史回填，链尾两步保护 panel 绑定 session 不被 LRU 驱逐——[lru-panel-exempt-fix]）；「订阅先于 panel 载入」前提（C-W3-4，2026-07-29 handoff 回复丢失事故）由链本体步 5→7 顺序保证，不再依赖注释跨文件同步。

### 导入源（Import Source）
session 导入统一入口的多 coding-agent 抽象：一个导入源负责「定位外部会话 → 校验 → 转换为合法 pi session JSONL」，实现 runtime 的 SessionImportSource SPI（`listCandidates` + `prepareImport`）；公共编排（互斥/去重/原子落盘/sidecar）由 ImportService 统一承担，导入完成广播由 handler 层在 reply 后发出。现役源：pi（外部 pi JSONL 原样复制）、zcode（宿主 SQLite 库转换）。导入产物落太极 sessions 目录后完全复用现有会话消费链（渲染/续聊/搜索），导入后续聊由 pi 引擎接管。**幂等键 = 产物 header.id**；**文件名不变量**：文件名剥 `.jsonl` 后最后 `_` 尾段 === header.id（源 id 含 `_` 须归一化）。扩展指南（新增源的步骤清单与不变量全集）：[docs/architecture/session-import-sources.md](architecture/session-import-sources.md)。

### 消息投影（Message Projection）
源 coding-agent 对单条消息「给谁看」的裁决，与 `role` 是**两个正交维度**：`role` 只表达角色（user/assistant），不表达这条消息是真人输入还是运行时注入。zcode 用四字段（`semantics` / `visibility` / `source` / `synthetic`）联合判定出六种投影策略（`realUserInput` / `visibleAssistant` / `compactSummary` / `providerContextOnly` / `hiddenSynthetic` / `timelineOnly`），导入转换器按策略映射到 pi entry 类型。**教训**：只按 `role` 分派会让源系统的合成消息（提醒/通知/引用回放）冒充用户消息——zcode 全库 user 消息 67% 是合成。完整判据与闭集枚举：[session-import-sources.md §6.1](architecture/session-import-sources.md)。

### 消息撤回（Message Revoke）
撤回 = 把一条已发出的 user 消息（连同其引发的回复与派生）从模型上下文移出，原文回草稿。机制 = pi `navigateTree` **树内回退**（被撤内容移出活跃路径，非删除——session 文件保留完整历史），LabelEntry（label `taiji:revoked`）落文件尾 = 持久化锚（重启/空闲回收后回退不复活）。**派生面口径二分准则**：未来状态随树回退（plan/todo/goal/scheduler/模型绑定——经 session_tree 重建或失效信号重建），已发生事实照实保留（subagent/workflow run 记录、usage 消耗）。撤回 ≠ 抹除：tee 日志、provider 侧已收请求、工具副作用均如实保留，UI 按此表述。机制裁决与重审触发：[decisions.md ADR-0076](adr/decisions.md)。

### 会话读取基座（session-core / zcode-session-source）
session「发现 → 读取 → 归一化 → 序列化」的零依赖共享实现，两层：`packages/session-core/`（canonical 原语——`NormalizedSession` 归一化模型 `{header, entries, degradations}`、JSONL parse/serialize、首行读取、session/zcode sa-id 工具）与 `packages/zcode-session-source/`（zcode 宿主 SQLite 库只读访问层——sqlite 驱动双形态适配、**四级恢复阶梯**（L1 直开 → L2 immutable 逃逸 → L3 快照 → L4 SqliteUnreadableError）、transcript 转换）。两个消费方：session-reader 扩展（通知链 `session_read` 的 zcode 读链）与 runtime zcode 导入源——同一套实现，禁止各自复制副本。`degradations` 承载无法保真的内容（显式登记，禁止伪造）；sa-id → zcode 会话的路由经 manifest/entry 锚双键（`engine: 'zcode'` + sessionRef）判别，db 路径白名单闸放行。

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


**依赖方向**: Transport → Service → ports → infra。Service 经 `services/ports/` 定义的 port 接口消费 pi 能力（`IPiEngine` / `IProcessManager` 由 `infra/pi/rpc-client.ts` + `process-manager.ts` 实现，收敛于 D24），不直接碰 pi 协议；Transport 不包含业务逻辑。


### 语义吸收层（pi-boundary-reliability，2026-08-28）

taiji 与 pi 之间对 pi 私有语义的统一适配层（[ADR-0064](../adr/decisions.md)）：对 pi 语义的推断与跨边界承诺只在边界一次吸收，域内只剩确定性；EventAdapter 只适配传输格式，语义适配归本层，散布在各处的本地推断即「影子推断」。四支柱（能力注册表 / 生效回执 / 确认式送达 / 漂移检查）的权威词条落 [extensions glossary 的 pi 边界可靠性段](../extensions/glossary.md)，设计全文见 [docs/architecture/pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)。

### Subagent

> **术语演进（2026-09）**：旧「树形引擎 / TaskNode / TaskTree」词条随树形引擎退役消亡（旧实现 = subagent-workflow 单包三层，已迁 `packages/subagent-core` + 引擎协议化，历史见 [subagents/architecture.md §7](../extensions/subagents/architecture.md)）。本词条描述现行体系。

taiji subagent 体系的子任务执行单元：由引擎进程派生子进程（pi 引擎 spawn pi 子进程；zcode 引擎走 app-server RPC）执行子任务，宿主与引擎经 engine-protocol v1（NDJSON stdio）通信。体系由 5 类包协作：shell（`extensions/universal/subagent-workflow`）→ host core（`packages/subagent-core`）→ engine（`packages/pi-subagent-cli` / `packages/zcode-subagent-cli`）→ contract（`packages/subagent-engine-sdk`）。结构导航 SSOT：[docs/extensions/subagents/architecture.md](../extensions/subagents/architecture.md)。

### Fan-out / 批量派发


2+ 独立任务并行、结果收齐一起处理的批量编排形态。唯一入口是 `subagents` 批量 tool：一次调用传 `tasks` 数组（每个元素 = 一条自包含任务 prompt），handler 转译 `runWorkflow("fan-out")` 走 workflow 单管道——`parallel()` allSettled 并行派 N 个一次性成员（one-shot，不可 message/续聊，恢复 = 重派），任一成员失败降 `partial` 不炸 run；run 收敛后主 agent 收到一条聚合结果通知（结构化 results：task / taskIndex / status / summary / fullReportPath）。机制落点：[subagents/architecture.md §4 批量编排行](../extensions/subagents/architecture.md)。


**collect 退役迁移说明（2026-09-16 落地）**：
1. 旧调用形态（`subagent start` 显式带 `collect` 字段）不会被 pi 拒绝——typebox 参数校验无 `additionalProperties`，未知字段静默放行且不剥离；字段退役后行为等价原 `collect:"async"` 缺省路径（立即逐条通知），无迁移动作、无功能损失。
2. 误读风险 = 调用方以为仍会攒批、等一条聚合通知——`subagent` tool 的 start description 已留迁移期提示（"The former collect param is removed — for 2+ independent tasks in one dispatch, use the `subagents` tool instead."）。
3. 2+ 独立任务并行的正确调用 = `subagents` tool（`tasks` 数组、一次调用、一条聚合结果通知）。

### Resume 锚点（锚）

subagent 跨 run 续聊时定位既有会话的凭据（引擎中立形态 `ResumeAnchor`，`packages/subagent-engine-sdk/src/protocol/contract-types.ts`）：引擎自选载体——zcode 锚 = `sessionRef {sessionId, dbPath}`（隔离库定位），pi 锚 = `{recordId?, sessionFile?}`（JSONL 定位）。经 `run.params.resume` 协议帧携带；锚判活 = 引擎侧载体存在性（库条目/文件在），失效走世代推进（reopen，同 id 带历史重开）。衍生用语：「锚稳定」（续轮 sessionId 不变）、「锚换钉」（锚被替换为新会话锚，历史连续性切断的降级形态）、「锚生命周期」（锚的确立/复刻/清空时点义务）。契约义务权威：[docs/extensions/subagents/engine-development-guide.md](../extensions/subagents/engine-development-guide.md) §5/§7/§10。

### Execution Record


subagent 运行状态的内存单源（`packages/subagent-core/src/execution/persistence/execution-record.ts` + `record-store.ts`）：事实源 = record 事件文件（W1 介质归位，[ADR-0094](adr/decisions.md)），恢复 = v2 注册条目定界 + 事件文件 fold（v1 全量快照兼容层已整体删除，2026-09-30）；状态词表三维正交（见下文 [run/record 状态词表](#runrecord-状态词表w2-收敛adr-0080)），对外投影两态（`active` / `idle`，ended 随终态概念删除），轮终收条由 `record-settled` / `record-round-idle` 事件帧承载（事件流是唯一事实源），manifest 为物化投影。


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
session 的语义内容——对话历史、项目知识（AGENTS.md 等）、skill/agent 注入的提示词。是 agent 能感知到的全部信息。Session Context 的 token 占用量受 Context Window 上限约束。

### SystemNotice
前端本地生成/派生的系统提示行，不出自 pi 的对话消息。渲染流转过程的元信息：压缩摘要（compactionSummary）、分支摘要（branchSummary）、pi 崩溃恢复提示条（RespawnNoticeBar 分支）、`@` 定向气泡（subagent directive）。不是 pi 消息的一部分，不参与 Context Window 计算。

**代码映射**: 现行符号 `SystemNotice`（`packages/ui/src/features/chat/SystemNotice.vue` 唯一渲染点；core 写入点 `appendSystemNotice` / `appendSubagentDirective`，`packages/core/src/domain/chat/store.ts`）。

> **术语演进**：历史名 `SystemNotification`（terminology R3 统一产物）已随 v3 重构消亡，现行符号为 `SystemNotice`，内联系统提示行已重新落地聊天流。
### Thinking
模型的内部推理过程，在回答生成前产生。属于单条 Message（挂在 `Message.thinking[]` 上），不属于整个 Session。UI 中默认折叠展示。

### Marker RPC（select+marker 通道原语，2026-09-14）

extension 与 taiji runtime 之间的请求-回包通道原语（`packages/extension-protocol/src/core/select-rpc.ts` 的 `callMarkerRpc`）：extension 侧以 `ctx.ui.select(MARKER, [payload])` 发起（payload 为已序列化字符串），runtime 侧对应 handler 响应同一 marker。回包是判别联合 `MarkerRpcResult`——`{ok:true, value}`（value 恒 raw string，JSON 合法性由原语检测但 parse 消费留调用方）或 `{ok:false, reason}` 四态失败（`cancelled` / `timeout` / `channel-error` / `non-json`，由 `signal.aborted` 反推区分）。mode 门控（裸 TUI 下不发）留在调用方。现役消费方：session-manager / plugin-bridge / subagent-workflow inflight-reporter / ui-form（统一表单协议，见下节）；错误回包形状单源为 `ChannelErrorResult`。

### 统一表单协议（ui-form，2026-09-19）


ask-user / scheduler / plan 三个 extension 提问交互的统一协议：问题即数据（类型化问题集），GUI 链路一个入口一个渲染器——多问 = 多 tab，单问 = 单视图（planReview 审批条与 permission 等 band 流程对话框不属提问表单，不在统一范围）。协议 SSOT = `packages/extension-protocol/src/extensions/ui-form/`：


- **问题集 `FormQuestion` 判别联合**：`choice`（选项题：`options`（label 即选中值，无独立 value 字段）/ `multi` 多选 / `allowOther`，默认 true）/ `text`（纯自由文本）/ `schedule`（时间输入整表单，`initial` 预填 `ScheduleDraft`）。answers key = `header ?? question`。
- **回传 `FormAnswers = Record<string, string>`**：choice 单选 = label、多选 = `JSON.stringify(labels[])`、Other 文本独立键 `${key}__other`、text 键位 `${key}__other`（与纯 Other 形态同键位）、schedule value = `JSON.stringify(ScheduleFormResult)`。choice/text 部分与 `AskUserAnswers` 逐字兼容——`getAskUserAnswer` / `getAskUserOther` 解码零改动。
- **wire 通道**：extension 侧统一入口 `uiFormInteract(ctx, form, opts?)`（传输核复用 [Marker RPC](#marker-rpcselectmarker-通道原语2026-09-14) 的 `callMarkerRpc`）以 `UI_FORM_MARKER = '\x00TAIJI_UI_FORM'` 为 select title、`options[0]` 携 `{ formQuestions, allowCancel }` JSON；runtime event-adapter 按 marker 翻译为 `extension.ui_request` 帧（`form: true` + `formQuestions`，逐项 `isFormQuestion` 检查过滤，全不合法降级普通 select 落 band）；renderer `FormOverlay`（`packages/renderer/src/components/extension/form/`）Panel 内联覆盖 composer 渲染，按问题 type 分派渲染器（ChoiceQuestion / TextQuestion / ScheduleForm）。回包四态判别（`cancelled` / `timeout` / `channel-error` / `non-json`），channel-error 含 **echo 检测**——收包等于发送 payload 时报「宿主过旧需升级」（旧 taiji × 新扩展组合的确定性识别）。
- **TUI 契约**：`uiFormInteract` 在 TUI 误调抛错——formQuestions 在 TUI 无呈现语义，各 extension 自行渲染（ask-user AskUserComponent / scheduler ScheduleCreateComponent / plan 原生 select），属有意取舍。
- **turn 预期声明 `expectTurn`**（2026-09-22，ADR-0073）：opts 可选布尔，扩展作者声明「表单提交后是否有 turn 跟随」——缺省 true（桥接 message_start 照旧，存量全兼容）；显式 `false`（command handler 内 select 的源，如 scheduler /schedule）经 event-adapter 条件落键（仅显式 false 落帧）→ respond 严格双条件 `result≠null && expectTurn===false` 即时清 pendingSend（真机 91ms/48ms 两轮实测），不再命中 30s 兜底。
- **版本偏斜窗口**：旧 ask-user 帧（`askUser` + `askUserQuestions`）/ 旧 scheduler 帧（`scheduleCreate` + `scheduleDraft`）由 runtime event-adapter 的 ASK_USER / SCHEDULE_CREATE marker 分支直接归一为 `form: true` 统一表单帧（askUser 源含 type 推断映射，renderer 只消费 view-ready 帧）。退役窗口终局（新 marker 版三包 npm 发布 + 一个大版本后独立 PR）：event-adapter 的 ASK_USER / SCHEDULE_CREATE legacy 分支、两旧 marker 常量、payload 旧字段（shared/core wire 类型同批）、ask-user channel 旧名注册（`ask_user`）一并清理。

**代码映射**: `packages/extension-protocol/src/extensions/ui-form/`（types/marker/helpers/guards）；消费方 `extensions/universal/{ask-user, scheduler, plan}/src/`；渲染面 `packages/renderer/src/components/extension/form/`。

### Schedule Create（schedule 创建表单 / 触发反转，2026-09-20）


调度任务的创建入口两路：**人侧 `/schedule` 命令打开创建表单**（无参 = 空草稿、带参 `<schedule> <prompt>` = 预填；命令 handler 异步打开、立即返回，填表时长不受 prompt RPC 60s 窗口约束），**模型侧 `schedule` tool 直建**（不再弹确认表单；参数不完整时要求模型先经 ask-user / 对话澄清）。交互入口收敛[统一表单协议](#统一表单协议ui-form2026-09-19)：extension 侧 `uiFormInteract` 携 `ScheduleQuestion` 单问整表单（预填草稿经 `initial` 直传），GUI 由 FormOverlay 的 ScheduleForm 渲染器呈现，回包 `FormAnswers` envelope 解出 `ScheduleFormResult` 经 `isScheduleFormResult` 判别（判别职责在 scheduler 包内）；TUI 走 `ctx.ui.custom` 挂 `ScheduleCreateComponent`；`json` / `print` 模式无交互通道，带参直建、无参/失败一律 `throw`（stderr 是唯一可见通道）。scheduler-create 模块为共享资产层：草稿 `ScheduleDraft`（表单预填值，含 `models` 列表注入）与回传 `ScheduleFormResult`（`action: 'create'`；取消不走此形状——select resolve undefined）契约类型 + `isScheduleDraft` / `isScheduleFormResult` 形状检查 + 时间折叠单点 `dateToOnceCron` / `onceCronToDate`（一次性时刻 ↔ 一次性 cron（5 段 `分 时 日 月 *`）互转，GUI/TUI 共用禁止双实现）。


### 计划模式（Plan Mode）

pi-plan extension 提供的只读规划态：用户输入 `/plan <需求> [--skills a,b]` 或 `/plan <需求> --template <path>` 进入，agent 限只读工具集（read/bash/grep/find/ls/plan/ask_user，D10——ask_user 供探索期结构化提问），按挂载技能（AI 自行 read 技能 SKILL.md）或模板流程产出计划文档——模板三源发现（内置 5 + 用户级 `~/.agents/plans/` + 项目级 `.agents/plans/`，同名项目 > 用户 > 内置 last-writer-wins），进入计划态时清单以 `<available-plans>` 段随提示词一次性注入（name + location，模型自选，无查询 action），`select-template` 返回 content 携带胜者文件全文、错名报错自带可用清单；`--template` 直传任意外部 md（与 `--skills` 互斥 fail-fast）时提示词内嵌该文件全文且不注入清单段。文档就绪后 `submit-review`（必带 selfReview 自审结论，见词条「selfReview（自审结论）」）挂审阅，用户三键裁决（approve 确认执行 / revise 提交评论并要求修订 / dismiss 搁置——非破坏协议级决策，见词条「dismiss（搁置）」；选择框被解散非批准），approve/abort 退出并恢复工具集；approve 后调 `complete` 时弹出执行方式选择（统一表单协议单 choice 问题；**无 plan-exec 技能时不弹表单，直通 execute**，D7②）：≤2 个检测到的 plan-exec skill 档（`Execute via skill: <name>`，`plan-exec: true` frontmatter 四根扫描检测，同构 pi loadSkillsFromDir，root 序前 2 个）+ Execute 档（goal 跟踪已整合：可用时先建 goal 跟踪，再按复杂度派发 subagent / 本会话直执）+ 暂不执行（Not now，留在 plan mode）。修订后重写文档须重调 `register-doc`（version+1）。taiji 形态的挂载信号 = `TAIJI_AGENT_EXT_LOG=1`（runtime 对托管 pi 恒注入；marker 交互另需 `ctx.mode === 'rpc'`，env 泄漏到 TUI 等非 rpc 形态回落文本软门）。

**代码映射**: `extensions/universal/plan/src/`（command.ts 命令与 --skills/--template 解析 / tool.ts 六 action（enter / select-template / register-doc / submit-review / complete / abort）/ state.ts 状态 / prompts.ts 提示词五段（产物纪律 / Phase C.5 自审清单 / 只读纪律 / 模板流程含三源清单注入与直传全文内嵌）/ index.ts hooks）。

### plan-state entry


计划模式在 session JSONL 中的持久化状态条目（customType 字面量 `"plan-state"`，session 内取最后一条为当前态）。字段 = 现状四字段 `isActive` / `planFilePath` / `requirement` / `templateName` + 旧 entry 可缺省字段 `templateProvidedPath`（`--template` 直传标记：直传进入时为展开后模板绝对路径，select-template 防御判据；模板流程缺失）/ `skills`（挂载技能名）/ `docs`（产物清单 `PlanDocMeta[]`：fileName + absPath + sourceSkill + version）/ `state`（生命周期八值，D1/D2 取代式——每次转移落盘，见词条「计划生命周期状态机」）/ `selfReview`（上次 submit-review 的自审结论，≤4KB 写侧截断：E3 重挂回传源 + 防照抄比较基线，见词条「selfReview（自审结论）」）/ `resumeHint`（降级等待原因 `resubmit`：会话重启待重提交，仅描述当前降级等待、submit-review 重挂起点清空，不跨轮残留）/ `lastSubmitReviewDocsFingerprint`（submit-review 重提交指纹快照）。旧键 `reviewState` / `reviewStateSource` **已停写**（取代式演进），仅作重建映射输入（reviewState：awaiting→reviewing / revising→revising / 无→planning|idle 按 isActive；reviewStateSource:'resubmit'→resumeHint:'resubmit'）。旧 entry（无新字段）逐字段降级读 + 映射读。runtime 投影链按同字面量派生扫描，前端消费与冷启动首拉共用同一份派生代码。


**代码映射**: `extensions/universal/plan/src/state.ts`（schema + 重建/落盘唯一入口）；`packages/extension-protocol/src/core/types.ts` 的 `PlanDocMeta`（产物元数据契约）。

### 计划生命周期状态机（Plan Lifecycle State Machine）

plan 模式流程的单一显式状态契约（状态散落三处 → 任意两者漂移即产「僵尸/谎言」UI 的根因修复）。8 存储态 `idle / planning / reviewing / revising / approved / dispatching / completed / exited`（`idle` = 无 plan 缺省；终态两值 `completed`（批准并派发执行）/ `exited`（主动退出）共享全部终态规则，仅留诊断/审计区分）+ `transition(state, event)` 纯函数转移表（守卫集中一处；非法转移返回 `{ ok: false }` 由调用方降级，不 throw 炸 turn；副作用不进返回值）+ `derivePhase` 呈现映射（8 存储态 → 5 呈现相位：规划中 = planning|revising / 待审批 = reviewing / 已批准 = approved|dispatching / 终态 = completed|exited 同映 / 无 plan = idle——用户口述四主态是呈现层，不是存储）。状态写全走转移函数；挂起事实唯一权威 = runtime pending 注册表，entry 不镜像挂起。

**代码映射**: `packages/extension-protocol/src/extensions/plan/state-machine.ts`（契约 SSOT，全边表 19 合法边 / 53 非法格）；消费面清单与勾销锚 = 同目录 `consumers.md`。

### plan 状态机事件（Plan Lifecycle Event）

状态机边的名字（9 值闭集）：`enter`（进入/新一轮，idle|终态 → planning）/ `submit`（submit-review 重挂，planning|revising → reviewing）/ `revise`（用户评论修订，reviewing → revising）/ `dismiss`（用户搁置——非破坏协议级决策，reviewing → planning，被搁置的审批不复活）/ `review_aborted`（挂起期外部解散，如 turn abort：reviewing → planning；dispatching → approved，批准事实保留不倒退）/ `approve`（确认执行意向——reviewing|approved → dispatching 进入执行方式选择；含「批准后重调 complete 重新选执行方式」，事件命名裁决见 state-machine.ts 模块头）/ `exec_chosen`（选定执行方式并派发，dispatching → completed）/ `later`（用户显式「暂不执行」，dispatching → approved，不是解散不进解散文案桶）/ `exit`（退出 plan 模式，任何非终态 → exited）。归口点按 `via: 'later' | 'dissolved'` 判别选择 `later` / `review_aborted` 边，不从 result/details 反推。

**代码映射**: `packages/extension-protocol/src/extensions/plan/state-machine.ts`（`PlanLifecycleEvent` + 边表）。

### selfReview（自审结论）

agent 提交计划审批（submit-review）前的自审摘要，审批交互的硬门参数（D9）：每次 submit-review 必带非空 selfReview（**无豁免**，含修订后重挂——自审对象是新版本文档），缺失/空被拒收并附纠偏指令。门语义三层边界：存在性（非空必填）= 结构保证；防照抄（文档已变而 selfReview 与上次逐字节相同 → 拒收）= 启发式；语义级新鲜度（自审是否真的对着新文档做了）= 提示词纪律（Phase C.5 自审清单），机器不可判。单字段双角色：E3 会话重启重挂的回传源（仅独立 pi/TUI 形态——该形态自动重挂是唯一恢复路径，steer 携带上轮全文，指示原样回传不重新思考，豁免只在「自审内容」、过门义务不豁免；taiji GUI 宿主 E3 不自动重挂，恢复走 renderer degraded 按钮由用户触发重提，重提时正常过门）+ 防照抄比较基线。有界 4KB（写侧单点截断，UTF-8 码点界安全）。投影面止于审批请求帧（`PlanReviewRequest.selfReview` → `extension.ui_request`）：不进 `PlanStateView` / `session.planState` 帧；entry 持久字段 = `plan-state.selfReview`。

**代码映射**: `packages/extension-protocol/src/extensions/plan/review-contract.ts`（截断/上限权威）+ `core/types.ts`（`PlanReviewRequest.selfReview`）；消费面勾销锚 = 同目录 `consumers.md`。

### dismiss（搁置）

plan 审批的第三键裁决（D3）：`PlanReviewResponse` 判别联合 `{ decision: 'dismiss' }`，用户「暂不审阅本次提交」的**非破坏**协议级决策（不杀 turn、不丢状态，无需确认 Popover）——取代旧「忽略 = message.abort 杀整个 turn」的副作用实现（F1/F2/F3 根因构造性消除）。语义：转移 `reviewing --dismiss--> planning` 落盘，plan 模式保持、文档与进度不变，**被搁置的审批不复活**（重开 session 不卷土重来）；tool result 指示 agent 简短告知用户已搁置并询问下一步（继续完善/等待指示），**不实施改动**。与「退出」（exit，退出整个模式）语义距离三层；值域守卫 canonical = `review-contract.ts`（未知 decision 值域降级为「宿主/扩展版本不匹配」指引，**不再引导重挂**——防再入循环）。

**代码映射**: `packages/extension-protocol/src/core/types.ts`（`PlanReviewDecision` 三键值域）+ `extensions/plan/review-contract.ts`（值域守卫）；消费面勾销锚 = 同目录 `consumers.md`。

### PLAN_REVIEW_MARKER

plan 审阅请求的 select title marker（`\x00TAIJI_PLAN_REVIEW:`，与 `UI_FORM_MARKER` / `GUI_WIDGET_MARKER` 同族 select 通道 marker）：pi-plan 的 `submit-review` 挂审批时以此 marker 为 title 发 `ctx.ui.select`（options[0] = `PlanReviewRequest` JSON：`{ docs, selfReview }`），runtime event-adapter 按 marker 检测后广播 `extension_ui_request`（planReview 标记，与 form 帧同构分流），前端审批条渲染三键审批（提交修订/确认执行/搁置）而非原始 dialog——marker 控制符 title 落入通用 dialog 会渲染成乱码。回传 `PlanReviewResponse` 判别联合（approve 无评论 / revise 必带 `{ quote, comment }[]` / dismiss 无评论）。

**代码映射**: `packages/extension-protocol/src/core/markers.ts`（常量）+ `core/types.ts`（payload/decision/comment 契约 SSOT）。

### record 投影链

会话持久派生态到前端 stateSnapshot 的统一通道（subagent/workflow 现役，plan-state 为第三员——plan-mode-redesign 方案 A）。链路：custom entry append → event-adapter `handleEntryAppended` 白名单 → interpreter record 联合类型 + 失效透传 → `SessionRecords.invalidateRecordEntries` 派生扫描（冷启动读盘与 live 更新共用同一份派生代码，live ≡ reload 构造性成立）→ publish 走 diff 基线 → message-bus `TOPIC_TABLE` / `STATE_TYPE_KEY_MAP` 分发 → 前端 store 订阅 + 切换/冷启动 RPC 首次拉取。三道运行时 customType 门 + 冷启动首次拉取全部要过，缺一则静默失效（三道门均为字符串判定，编译器不保护——加员时逐点核对）。

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

### 投递所有权内核（delivery-ownership kernel）

用户消息（composer）、agent 消息（session_manager send）、回流消息（completion-backflow）等全部发送方的唯一投递所有者：runtime 侧每 session 单例——纯逻辑状态机在 `packages/session-delivery/`，pi 适配与对账在 `packages/runtime/src/services/session/session-delivery-registry.ts`。pi 的 steer/followUp 内存队列降级为**交接槽位**（消息从「前端持有」到「进入 transcript」之间的临时存放格），所有权在消息进 transcript 之前属于本内核；renderer 只提交（`delivery.submit`）与渲染（`session.delivery` 状态帧，队列区单一数据源），不做车道判定。

**lane（投递车道）**：一条消息交给 pi 的方式，三档——`direct`（pi 空闲，直接 prompt 起新 run）/ `steer`（pi 有活跃 run，入 steeringQueue 等 turn 边界注入）/ `queued`（pi 暂不可收，内核 FIFO 持有等时机）。lane 判定单一源 = runtime 权威 occupancy 投影（C-data-19 单写原语）+ 内核队列态；renderer 的 `resolveSendRoute` 降级为发送位按钮形态（send/stop/queue）的 UI 预测，真实车道以 `session.delivery` 帧的 lane 字段为准。

**条目五态（`DeliveryEntryState`）**：内核条目状态机——`queued`（内核持有排队）/ `in-flight`（已交 pi 槽位、未确认）/ `delivered`（拿到送达回执；marker 锚 = `message_end` 回执命中，acceptance 锚 = 受理即落地，ADR-0074 申报制）/ `failed`（重试耗尽，等用户处置：重试钮经 `delivery.resync` 单条重报，或 × 移除）/ `cancelled`（用户撤销或 drain 回收）。进入 `session.delivery` 帧的是**投影视图**而非五态全量：活跃态（queued / in-flight / failed）全量 + delivered 最近 50 条完整条目，**cancelled 不投影**（撤销即从队列区消失，全文经 `delivery.cancel` reply 回草稿）——该帧是队列区行形态的唯一来源。

**两类回执（两阶段 receipt）**：①**受理** = pi 收下消息（direct 车道 = prompt 受理；steer 车道 = 文本进入 pi 槽位）；②**送达** = `message_end(user)` 文本命中裸标记 = 消息已写入 transcript（durable）。受理 ≠ 送达：只拿受理的条目停留 `in-flight`、由对账器盯（marker 锚情形；acceptance 锚条目受理即落地，见 `receiptAnchor`）。`sendChecked` 的同步 settle 时点维持**受理口径**（session_manager send 的 `{queued:true}` 契约锚定在受理时点，后移到送达会让 agent 工具调用阻塞至目标 session 当前 turn 结束）——onSettled 记账回调为送达口径，两者显式分离。

**receiptAnchor（回执锚）**：投递条目级回执锚申报（`DeliverySubmitOptions.receiptAnchor`），`'marker'` 缺省 / `'acceptance'` 无标记 agent 通路受理即落地，来源清单 SSOT 在 [decisions.md ADR-0074](adr/decisions.md)。

**对账器（Reconciler）**：registry 侧组件，在五个触发点（agent_settled / compaction_end / abort 完成 / pi restored / 30s watchdog；`delivery.cancel` 复用同一路径为撤销兜底入口）执行对账，条件 = 「空闲 + pi 槽位非空」，处置 = `clear_queue` 全收后按裸标记**三分**——**reclaim**（内核在册条目回队首重投，保持原相对序）/ **rebuild**（**尾附锚**标记但内核无记录 = runtime 重启 reattach，先按标记对 transcript 全量扫描判 delivered：已送达只重建记账不重投）/ **adopt**（无身份承接的外来文本——notifyDone / scheduler 提醒等存量注入，或标记字面量全部非尾附锚——以新身份入内核 FIFO 正常投递，不丢弃）。pi 只有队列级 `clear_queue` 原语（无条目级撤回），条目级收回以「全收 + 标记识别 + 其余重投」实现。

**裸标记（bare marker）**：出站文本尾附的 `<!--taiji:msg:<uuid>-->`（裸 uuid 形态）作为逐消息身份，随文本进 transcript，供送达回执与判重匹配按 id 精确查找（身份非内容匹配——skill 注入 / BeforeSend 文本改写不影响）。与 msg-id-mapper 的 `u-<uuid>` 前缀标记空间互斥（mapper 只剥 u- 形态且仅覆盖富内容直发通路；裸标记在 steer/followUp 通路不被剥离而存活）——两者正交共存，rich 通路同时携带双标记各司其职。展示层剥离 SSOT = `packages/core/src/domain/chat/apply-entry-convert.ts`（live / reload 同点）。

**投递身份（delivery identity）**：一条出站消息的逐消息身份载体 = 裸标记携带的 id。「这是不是投递身份」的判定权威 = `DELIVERY_MARKER_ID_RE`（`packages/runtime/src/services/session/session-delivery-registry.ts`，shared `MSG_ID_TAG_RE` source 派生的严格 uuid 双形态 ∪ 本地收养条目 `m-<base36>-<seq>` 形态）——uuid 段禁止手写正则，SSOT 形态变化自动跟随。_Avoid_：把任意形似标记的文本当身份（宽松 `[^>]*` 形态仅授权剥除面，判定宽松会让用户文本中的字面假标记产生重复投递）。**出站尾附锚（outbound tail anchor）** = rebuild 重投的附加判据：仅精确文末（原文串 endsWith，不 trimEnd 尾换行）的标记构成 rebuild 身份（剥标记不吞尾换行，P5 口径，与 ADR-0077 一致；出站标记恒尾附，与写侧 `withDeliveryMarker` 读写同形），文本中部/前部的合法形态标记字面量不构成投递身份。判据形态二分裁决：[decisions.md ADR-0077](adr/decisions.md)。

**tombstone 判重锚**：已终态条目（delivered / cancelled）的轻量记录（id / 终态 / lane / settledAt），在 **runtime 存活期内全量保留、不设数量窗口**——`delivery.resync` 断连重报去重与 reattach 收养判重的查询表；cancelled tombstone 防「撤销确认帧在断连窗口丢失 → 已撤销消息被 resync 复活」。判重表栖身 runtime 进程内存、不跨 runtime 重启，reattach（滚动重启后）判重锚回落 **transcript 全量标记扫描**（按重报集/滞留集 uuid 查找，transcript 是唯一跨进程持久事实源）。

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

> **废弃说明**：v3 重构后窗口内最多双 Panel（主从模式），不再需要“全局 panel 缩略图网格”。鸟瞰形态已随 Overview 视图整体移除而消亡（见 [ADR-0084](adr/decisions.md)），会话统筹由 Sidebar Session List 承担。旧 `overviewVisible`/`toggleOverview` 等代码引用待清理。

~~全局面板网格视图。展示所有 Panel 的缩略图，类似 macOS Mission Control / Windows Task View。用于快速定位和跳转 Panel。~~

### Window
操作系统级 Electron BrowserWindow。v3 拓扑：窗口 (bg-base 平铺) 内含 `.app-shell`（flex + p-3），由持久 **Sidebar**（透明融合）+ 可切换的 **main** 区（float-panel 浮起）组成。main 区在 chat / settings 两 view 间互斥切换。支持多窗口。

**命名约定**: "Panel" 统一指 Session 的视口（即代码中的 `Panel` / `PanelLeaf` / `PanelTree`，`packages/renderer/src/stores/panel.ts`），不用于其他含义。

### 远程访问（Remote Access）
手机浏览器经局域网直连 runtime 的可选能力，默认关闭（纯回环监听，与既有形态一致）。开启后 runtime 改绑 `0.0.0.0`，同一端口同源托管移动壳构建产物（HTTP 静态面 + WS）；WS 鉴权集合 = {per-spawn token} ∪ {remote token}。配置面 = 设置 → 远程访问面板（开关 / token 轮换 / LAN 地址+二维码 / Tailscale 指引），配置持久化 `<dataDir>/remote-access.json`（0600，main 原子写，关态留存）。开启信号 = argv `--remote-access`（无 env 通道，脚本直跑 / e2e 池等非 supervisor 路径不传 flag 即天然关态）；`--mobile-dist=<path>` 是移动壳 dist 的唯一来源（main 按运行环境解析：dev 仓库 dist / prod 打包资源）。**代码映射**：runtime `packages/runtime/src/transport/connection-manager.ts`（绑定地址 / token 集合 / 静态托管白名单）、组合根 `packages/runtime/src/index.ts`、main 配置面 `apps/electron/main/remote-access/`、supervisor 拼参 `apps/electron/main/supervisor/process-control.ts`、面板 `packages/renderer/src/components/settings/remote-access/`、契约 `packages/shared/src/remote-access.ts`。

### 移动壳（mobile shell）
`@taiji/mobile-renderer` 构建出的手机 web 客户端（浏览器运行、触控交互），与桌面 renderer 并列的双壳成员（拓扑见 [renderer-package-topology.md](architecture/renderer-package-topology.md)）。连接装配：WS URL 从 `location.host` 同源派生、凭据经 PlatformPort.storage（localStorage）持久、storage/webSocket 为真实实现。UI 主体 = session 列表 / 消息流 / 新建任务表单 / token 输入视图 + 底部 tab + 根级权限审批弹窗（ui PermissionRequestDialog，PermissionTransport 经 plugin.approvePermissions/revokePermissions 回传）；业务逻辑复用 core 业务域，展示复用 ui 共享组件（markdown 渲染链模块与被 ui 组件消费的 locale 域文件已下沉 ui 包，双壳共享单源）。v1 能力边界：slash 命令 bar / plugin view 全集 / terminal / 文件树 / git 面板不在移动壳（挂载点子集 = message-stream / slash(隐藏保留) / companion）；图片粘贴降级为文本占位（`[图片粘贴：需桌面环境]`）、mermaid 图表占位呈现、hover 类消息操作不可用。壳间禁止互相 import。

### remote token
远程访问的持久凭据：64 位 hex 小写字符串（32 字节随机值的 hex 编码）。main 生成与轮换——重写 `remote-access.json` 即生效（runtime 每次 WS auth 握手热读文件，轮换不重启 runtime、不中断在途 turn）；文件缺失/损坏 → remote 集合为空退化为仅 spawn token（fail-closed）。存量已认证连接不随轮换踢除（auth 只门禁握手）——「怀疑泄漏」的完整处置 = 面板轮换（断新接入）+ 关开开关（重启 runtime 踢全部存量连接）。移动壳侧 token 经验身成功才写 localStorage（key `taiji.remote-access.token`）；URL query 携带的 token 验身失败**不动**既有 storage（坏链接不毁好凭据），storage 来源验身失败才清空（落 token 输入视图重扫恢复）。

### profile 连接策略（connection profile）
连接发现三分支中的远程形态，形态判定收口在 `packages/core/src/transport/use-connection.ts` 的 resolveConnectionMode() 薄谓词（init 首连 / HMR 重连 / retryRuntime 三处消费；连接目标解析留在各分支原地）：**本地 = IPC** 端口发现（electronAPI 有值）、**远程 = profile**（移动壳）、**mock = VITE_MOCK**。profile 的注入实现 = `packages/mobile-renderer/src/platform/connection-profile.ts`：凭据采纳顺序 = URL query `?token=`（显式携带的新凭据 = 用户新意图，验身成功落 storage 并 `history.replaceState` 抹地址栏）→ storage（验身过的持久凭据，跨 runtime 重启免重扫）→ 皆无（不带凭据发起连接，runtime fail-closed 拒绝 → `onAuthRejected` 信号 → token 输入视图）。auth 被拒时移动壳抑制全部自动重连触发点（退避重连 + visibility 切前台主动重连）；连接失败（非凭据失败）维持重连等待态，不落 token 视图。

### Run record 事件流（workflow 域）
workflow run 的唯一持久化：`<sessionDir>/workflow-state/<runId>.record.jsonl`（workspace 有活跃 session 时落 `sessions/<slug>/workflow-state/`），append-only JSONL 逐行记录 run 生命周期事件（[ADR-0082](adr/decisions.md) 对齐 pi 后 9 事件：`run-created / phase-started / agent-started / agent-retrying / agent-settled / phase-settled / run-interrupted / run-resumed / run-settled`，事件行携带单调 seq；`run-created` 带 scriptSource 全文、`agent-settled` 带 result 全文与 sessionFile）。`agent-started` 载荷携带 `phase?`（call 归属快照——fold 推导无需回溯转移事件）与 `memberRecordId?`（[D6] 绑定字段——同名续写路由）；`phase-started`/`phase-settled` 是 phase 状态机转移事件（[D3]——worker 模板 `phase()` 经 postMessage 写入 record，异步丢失窗口由 fold 自愈规则承接）。run 生命周期四态 + interrupted 暂停态（`created → running → settling → terminal`；`running/settling → interrupted → resume → running`）——interrupted 非终局（run-interrupted 转移帧，可续跑）；终局 outcome 四值 `done/failed/cancelled/time_limited`。manifest（`<runId>.json`）降格为 run-settled 终局事件的派生缓存。判读 = record fold 唯一权威（注册表投影 / 终局诊断引用 / resume 资格全部折叠）。由显式状态机单点写入（terminal-actions.ts 的 dispatchRunTrigger 单写者链），引擎不直接写。无主 run 的磁盘清理走对账清理（裁决点 7：引用集三代解析 + 宽限窗——run 数据生命周期跟随 session 归属）。

### run/record 状态词表（W2 收敛 + 生命周期重构，[ADR-0080](adr/decisions.md) / [ADR-0082](adr/decisions.md)）
run 与 record 两域状态词表的单源口径，消费方按维取值、禁止跨维混用：

- **run 域两维正交**：lifecycle 维 = `RunLifecycle` 四态 + `interrupted` 暂停态（`created/running/settling/terminal` + `interrupted`——dispatched 已并入 running（两态行为相同且零消费方，[ADR-0082] D2）；`packages/subagent-core/src/orchestration/run-events.ts` 的 `RUN_TRANSITIONS` 转移表唯一裁决，表外转移 fail-fast）；outcome 维 = `RunOutcome` 四值（`done/failed/cancelled/time_limited`，`ALL_RUN_OUTCOMES` 单源），outcome 仅 terminal 出现。`interrupted` 不是终局——是「执行中断、无活体」的 lifecycle 暂停态（running/settling → interrupted：崩溃收编 / terminate 被动失联（resume 来源 run，[ADR-0082] D11）；interrupted → running：resume），自动终局化写入方已随 abandon 移除消失（[ADR-0082] D9），中断来源细分由 `run-interrupted` 帧 errorCode 承载（`crashed` / `terminated` / `startup-sweep`；历史成员 `interrupted_abandoned` / `idle-evicted` 保留只读解析）；`cancelled` 保留「用户主动取消」语义，显示面「已取消」（主动）与「已中断」（被动）禁混用。旧 `RunStatus` 两态机（running|done + `state.status`/`state.reason` 快照字段）降级 v1 兼容层（W4 sunset），禁止作活体终局判据或载荷源。
- **record 域三维正交**：lifecycle 维 = `ExecutionStatus`（running|idle）× 停因维 = `StopReason`（上一轮收条语义，由 `record-settled` / `record-round-idle` 事件帧承载，仅展示排障）× 结果维 = outcome 四值（轮终参数 `ExecutionOutcome` 为独立实体字面量 `completed/failed/cancelled`——原 `Exclude<RunOutcome,"interrupted">` 派生别名随 interrupted 移出 RunOutcome 取消，[ADR-0082] 实施期裁决：execution/subagent-record 域写入值不变）。record 域不建显式转移表：意图原语族即状态机（C-data-20 唯一写入口 + `tryEnterRunning` CAS 表外拒绝）。
- **投影相 ≠ 状态**：注册表投影 = record fold 四相（missing/active/terminal/interrupted，`run-registry.ts` 的 `RunRegistryPhase`）——interrupted 相是投影判读（`run-interrupted` 转移帧已写入 record，或事件流停止且活体未命中的 host-died 判读），对应 lifecycle 暂停态而非终局（[ADR-0082] 后投影相与 lifecycle 同构，interrupted 相可流转回 active）。manifest 的投影持久化格式（record 终局事件的派生缓存，单一生产者）不计入消费方状态词表口径。

### 介质归位（run/record 运行态持久化，W1）
run 与 record 的运行态数据持久化形态（[ADR-0094](adr/decisions.md) / [ADR-0082](adr/decisions.md) D1）：**事件流是唯一事实源**——run 侧 = record 事件流（`<runId>.record.jsonl`，[ADR-0082] D1 由 journal 更名并升格：全文入事件、state 快照删除），record 侧 = 事件文件 `<recordsDir>/<sa-id>.events`（无 .jsonl 后缀，既有 .jsonl 扫描器结构性忽略；首行 `{"type":"record-events"}` 头行自描述）。子术语：

- **注册条目 / 终态条目**：主 session JSONL 里每实体只写的两条小 entry（v:2，kind 判别 registered/settled，customType 不变）——注册条记身份与锚点（诞生时写；workflow-record 族携带 recordPath 锚点），终态条记终局与摘要（结束时写，含 result 全文与 engineHandle 双键）。旧读者按版本门跳过 v2。
- **落盘键的旧词裁决（已完成）**：事件流升格前的旧词（journal）在代码符号与落盘键里的残留已全部改成现行词，不做迁移、不留兼容读——项目未上线，不存在需要兼容的 v1 数据。三处落盘键现状：事件文件头行 = `{"type":"record-events"}`（`RECORD_EVENTS_HEADER_TYPE`，`record-events.ts`）；engineHandle 落盘键 = `engineHandle.eventsPath`（引擎侧事件文件路径——SDK `EngineHandleData`/`ResumeAnchor` wire 契约、core record/manifest/entry 形状、读写两侧与扫描守卫同批改名）；workflow-record 注册条目锚点键 = `recordPath`（record 流路径，D16③ 后锚点语义 = `<runId>.record.jsonl`）。
- **物化投影 / 索引**：折叠结果的落盘副本（record 侧 manifest、run 侧 manifest、`.record-binding`、`sessions-index.json`）。三条硬性质（可删 / 带水位 / 无独有字段）与逐项现状见 [物化投影与索引](#物化投影与索引)。`.alive` 是操作租约，不计事实源。
- **事件流增量读**：从上次读到的位置（offset）继续读新增事件行的增量读取方式（`packages/subagent-core/src/execution/persistence/event-tail.ts`，run 与 record 两域共用）——runtime 内存投影的增量喂入源之一（另一源 = pi entry 游标）。
- **收编**：把「有注册记录、无终态记录」的实体判定为中断并补齐记录的动作（本域领域词）——run 侧 = 落 `run-interrupted` 转移帧转 interrupted 暂停态（[ADR-0082] D15：壳侧 recoverCrashedRuns 与 runtime startupSweep 两链经终局编排单一入口），record 侧 = 幂等追加终态事件；事件流重放后幂等追加。`recoverCrashedRuns`（崩溃孤儿收编链）与 `rebuildRunFromRecord`（resume 正常路径的聚合重建面——fold 判 resume 资格、重建供 worker 接管的完整聚合）均经调用链甄别为现役机制非补偿残留，保留。
- **惰性兼容读（run 侧存量）**：run 侧旧格式两件套（`.events.jsonl` + `<runId>.jsonl` 快照）无兼容读——不读、不写、不主动删（[ADR-0082] D1 历史数据处置，随裁决点 7 清理自然消亡）；subagent-record 的 v1 全量快照兼容层已整体删除（无 v1 数据）。
- **保留窗口**：事件流的显式保留期限（默认 30 天）——窗口内全保留，窗口外的终态实体由统一保留维护轮清理（折叠终态资格判据；cap=50 已废除）。

### 事件流（唯一事实源）

run 与 record 的状态变化唯一落盘形态：append-only 文本流，逐行一个事件，行带单调 `seq`。

- record 侧 = `<recordsDir>/<sa-id>.events`（首行 `{"type":"record-events"}` 自描述；六类事件 `record-created` / `bound` / `round-started` / `round-idle` / `settled` / `reopened`）；
- run 侧 = `<sessionDir>/workflow-state/<runId>.record.jsonl`（九类事件，见 [Run record 事件流](#run-record-事件流workflow-域)）；
- **单一写者**：状态变化只能追加事件，其它模块禁止直写盘上投影（写面检查 `scripts/check-record-write-surface.mjs`）；
- **崩溃安全**：只追加、不原地改，尾部损坏按 [事件流损坏形态](#事件流损坏形态半写--坏行--截断)处理，不需要跨文件事务。

**遗留符号改名（已完成）**：原待改名清单 `JsonlEventJournal` / `RecordJournalWriteFace` / `RecordJournalFoldState` / `journal-tail.ts` / `SessionJournalProjection` 已全部改成现行词——`JsonlEventStream`（`shared/jsonl-event-stream.ts`）/ `RecordEventsWriteFace` / `RecordEventFoldState` / `event-tail.ts` / `SessionEventProjection`（runtime `events-projection.ts`）；`journal-wiring.ts` 同批改名 `event-journal-wiring.ts`。journal 词的保留边界（现行词，不改）：引擎域自己的 journal 概念（`engine/common/event-journal.ts` 的 `JournalWriter`、zcode 引擎 `journal-io.ts`、磁盘文件名 `journal-<taskId>.jsonl`）与 run 域 journal 概念（`run-event-journal.ts` 等）。同族收尾批（record 域与 runtime 投影）已完成：record 域事件词族现行词 = `RecordEvent` / `RecordEventInput` / `RecordEventHeader`，流式读口 = `RecordEventStream` / `createRecordEventStream`（接口对齐 run 侧单写者纪律，基座仍是 `JsonlEventStream`）；runtime 投影面现行词 = `EventProjectionSources` / `initialEventProjectionSources` / `mergeEventProjection` / `onEventProjectionChange` / `eventTailerRecheckMs`。事件文件首行头行的 type 判别值 = `record-events`（`RECORD_EVENTS_HEADER_TYPE`，落盘格式）。journal 词的保留边界前句即全部保留项。

### 折叠（fold）

按 `seq` 顺序重放事件流、得到实体当前状态的动作。它是「事件流 → 状态」的唯一推导方式，也是判读权威——注册表投影、终局诊断引用、resume 资格、保留窗口资格都由折叠结果裁决。

**唯一实现原则**：折叠与状态词表只有一份实现，runtime 内存投影、core 查询面、扩展与 session-reader 一律复用它，禁止各自再写一份「从事件算状态」的代码。

### 物化投影与索引

物化投影 = 把折叠结果写到盘上、免去每次重算的文件。判断它是**索引（缓存）**还是**第二份事实源**，用三条硬性质：

1. **可删**：整目录删掉后行为不变，只有性能下降；
2. **带水位**：自带「派生自事件流的哪个 seq / 内容摘要」，读时对不上就回落事件流重建；
3. **无独有字段**：它有的字段，事件流必须有。

| 载体 | ① 可删 | ② 带水位 | ③ 无独有字段 | 现状 |
|---|---|---|---|---|
| `sessions-index.json` | 是 | **是**（每条带该 jsonl 的 mtime+size，消费点 `record-store.ts` 逐条比对，不匹配即重探测） | 是 | **三性质齐备**——唯一的纯索引 |
| manifest（`<sa-id>.json`） | 是（惰性通道 + boot 轮双重建） | **是**（`eventsStamp` = 派生自 `<id>.events` 的 mtime+size，写点先事件后投影构造性新鲜；读侧不匹配即跳过回落重建） | 是（`stopReason` / `turns` / `totalTokens` 已随读侧换源由 `record-settled` / `record-round-idle` 帧承载） | **三性质齐备的物化投影**；跨包读取面（session-reader 只认它）是整体退场的挂起点 |
| ~~`.state` 收条~~ | — | — | — | **已删除**：收条由 `record-settled` / `record-round-idle` 帧承载（写侧、读侧、戳与常量全部退场；快路径走索引收条，重建路径走折叠） |
| `.record-binding` | 写点退场后可达 | 戳（写面覆盖写变 mtime，缓存键职责） | 是（身份域 + 统计域已全部入事件载荷） | **读侧已全部换源事件流折叠**（身份 = `identityFromFold`、统计 = `receiptStatisticsFromFold`、revive 基线 = `baselineStatisticsFromFold`）——binding 只剩写面（spawn 回填 / settle 快照 / reopen merge）与负缓存击穿戳；写点退场 = 后续批次 |

**终态目标**：只有索引存在，且三性质齐备；其余载体删除。

**`.state` 退场已完成**（记录于此以免后人重复排查）：写函数族 / 读函数 / `statStateStamp` / 三个后缀常量与 `SidecarStat` 已从 `state-marker.ts` 删除；`markResurrected` 不再清理旧终态文件（磁盘终态由事件流决定，重开由 `record-reopened` 帧表达）；12 处测试 fixture 迁到事件帧播种（helper `execution/__tests__/helpers/seed-terminal-record.ts`），纯旧兼容用例随其被测对象一并删除。

**索引承载终态收条的裁决**（换源时不可回避）：终态域（`stopReason` / `turns` / `totalTokens`）换源到折叠后，索引快路径**不能**去读每条记录的事件文件——那正好废掉索引存在的理由（冷启动零内容读取）。因此索引条目必须自己承载终态收条，且它的水位要覆盖**事件文件**的 stat（今天只盖 jsonl 的 mtime+size：轮终收条写在 jsonl 末次写入之后，只比 jsonl 会漏掉收条变化）。两条腿：① 索引条目加终态字段；② 水位扩到 `jsonl + <id>.events` 两个 stat。**两腿均已落地**：索引条目自承收条（`receipt` = stopReason + endedAt；v3 起再加 `turns` / `totalTokens`——统计域随读侧换源由折叠承载，索引自承后快路径零内容读取即可回答「为什么停/何时停/停时多少量」），`INDEX_VERSION` 升到 3；round 不入索引（既有缺口，消费侧登记，下轮戳变化重探补齐）。

第 ② 腿的改动面（动手前先看这里，别低估）：事件戳属于缓存键，而缓存新鲜度判定是中心面——连带影响 `isFreshCache`、负缓存条目、以及索引投影 `projectIndexEntries` 的正/负两类条目。**已完成**：`FileStamps` 去掉 state 维（现为 `jsonl` + `binding`），事件戳落在 `FileCacheEntry.events` 并由 `isFreshCache` 作为第四维比对；索引条目承载事件戳（`eventsMtimeMs` / `eventsSize`）与终态收条（`receipt`），`INDEX_VERSION` 升到 2。

### 身份绑定（`.record-binding`）与写权（`epoch`）

`.record-binding` = 每子会话一个 sidecar（`<sessionFile>.record-binding`），记 record id ↔ 会话文件映射。**读侧已全部换源事件流折叠**（[② 读侧换源]：身份 = `identityFromFold`、统计 = `receiptStatisticsFromFold`、revive 基线 = `baselineStatisticsFromFold`，`.record-binding` 读函数零生产读路径）——binding 只剩写面（spawn 回填 / settle 快照 / reopen merge-or-create，best-effort）与缓存键戳职责（写面覆盖写变 mtime，负缓存击穿）。写点退场 = 后续批次，退场后该文件删除。

`epoch` = 写权世代计数，随写权取得递增，用于判定过期写者（`acquireWriteLease` 一族）。

### 记录谱系字段（origin / rootSessionId / parentRecordId / depth）

判读 record 归属与嵌套深度的四件套：`rootSessionId` = 根会话（跨 tree 归属判据）、`parentRecordId` = 直接父 record、`depth` = 嵌套层数（`MAX_FORK_DEPTH` 上限判据）、`origin` = 诞生来源（工具调用 / workflow 成员 / resume 等）。查询面按 `rootSessionId` 过滤，禁止跨 tree 混读。

### 轮次（round）与轮次事件

record 的执行单位：一次「派发 → 回收」= 一轮。`round-started` 记轮起、`round-idle` 记轮终（带 `stopReason` / `endedAt`）、`bound` 记引擎会话锚在轮内回填。轮次是终局进度与统计（`turns` / `totalTokens`）的聚合单位。

### 事件流损坏形态（半写 / 坏行 / 截断）

- **半写**：进程在写入途中被杀，末尾留下不完整 JSON 行；
- **坏行**：行能解析成 JSON 但不满足事件形状（缺 `seq` / 未知 type）；
- **截断**：读到的文件短于上次记录的 offset（外部清理或轮转）。

处置纪律：尾部半写与截断行可丢弃（保留已确认前缀）；坏行跳过并计数/告警。**禁止把跳过做成无声**——静默跳过会把数据损坏伪装成「什么都没发生过」。

### 三级降级读取链（引擎历史）

非 pi 引擎的 record 详情读取顺序：① 引擎原生读取（zcode 隔离会话库 / 协议 `read`）→ ② 宿主事件文件重放 → ③ outcome-only（record 字段投影摘要）。逐级降级并留痕；pi record 不走该链（走会话文件直读）。**身份已知才允许降级**——「有会话锚却没有 engine」是数据损坏，必须显式失败，不能按 pi 链读。

### 模型引用与三元组（`{provider, id, thinkingLevel}`）

模型引用在人类输入与磁盘格式里是字符串 `provider/id[:thinkingLevel]`（后缀 = 该模型的思考档位，spawn 时拼成 `--model provider/id:level` 交给 pi）。内部表示目标是**三元组** `{provider, id, thinkingLevel?}`：

- 字符串只在**入口**解析一次——工具参数 / agent `.md` frontmatter / 配置 / GUI 选择器 / runtime IPC / 扩展 `ctx` / CLI 参数；
- core、runtime、SDK、引擎协议、renderer 之间只传结构体；
- 解析单点 = `parseModelSelector`（无损，连档位一起返回）；禁止各处再按 `/` 或 `:` 自行切分；
- thinking 档位词表现存三份副本，收敛为单一事实源后删比对脚本。

### 武装回执（armed，workflow 域）
schema 强制链的引擎确认信号：native 引擎在启动期武装断言通过 + 孙进程 spawn 成功后上报一次 `armed` 事件（载荷 = env 变量名 + 必备扩展包名）。宿主是独立信号源（监控不与施控同源），等待窗内未收到即 fail-fast。仅 native 引擎、仅 schema 任务；emulated 引擎恒不上报。契约义务见 [engine-development-guide](extensions/subagents/engine-development-guide.md) §6。

### 终局必达通知
workflow run 的结果语义通知纪律：成功/失败/取消一律出终局通知，走确认式送达（持久账本 + 幂等键，at-least-once）。是 C-ext-19 确认式送达在 workflow 域的细化（C-ext-26），终局内容由 run 状态机统一裁决，禁止旁路第二通知面。

### 模型目录（pi 引擎域）
pi 引擎的可用模型集合及其能力（思考档位等）。能力判定只在 `packages/runtime/src/services/model-capability.ts` 一点进入（ADR-0064 能力注册表），离线快照由 builtin provider 快照承载（`scripts/check-model-references.mjs` 检查漂移）。workflow 派发按全路径形态引用模型：裸名不解析、解析失败为期望行为（C-ext-24）。
### 窗口外壳（window chrome）
窗口的标题栏区装饰总和：关闭/最小化/最大化按钮、边框圆角、拖拽区、默认尺寸行为。本项目的平台分叉：mac 由系统绘制（`titleBarStyle: hidden`，原生红黄绿圆点）；win/linux 由应用自绘（`frame: false` + renderer 的 TrafficLight 圆点 + `-webkit-app-region` 拖拽条带）。

---

## Settings 域

### 乐观更新协议
「乐观写本地 → await 持久化 → 失败回滚后 rethrow」的唯一实现（`packages/core/src/foundation/optimistic-update.ts`，提供 `runOptimisticUpdate`/`optimisticUpdate`/`refCell` 三形态）；错误映射到既有错误面（toast / actionError / saveError 标志）由调用方或字段 module 承接。RPC 设置项字段编排（`setting-field` module）与 settings 域全部乐观写现场均收编于此协议。**Avoid**：手写 prev/rollback 快照样板、组件内 try/catch 回滚、置标志式失败语义。

### 动作错误来源标签（ActionErrorSource）
provider-edit 域动作错误的归属判定机制：每条动作错误带 source 标签（save/headers/discover/models），清除与归属按 source 判定。**Avoid**：比对错误展示文案判定归属（i18n 运行时值不稳定，locale 切换后失效——曾致旧错误滞留的真 bug）。

### 组级 load 归并（loadError）
字段组（`setting-field` 的 `SettingFieldGroup`）任一字段 loader 失败即整组置 loadError：控件禁用 + 常驻提示 + 重试，加载失败时默认值明确标注为默认而非已存值（RD-4#8 契约），全部 loader 成功后复位。**Avoid**：逐字段独立 try/catch 后按默认值静默渲染、console.warn 冒充已存值。

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
composer（Panel zone ④）内底部的展示型工具带（`packages/renderer/src/components/panel/Composer.vue`）：生成指标（`GenStatsTriggers`：速度 t/s + 缓存命中率 + TTFT 首字延迟（首字延迟 = 请求发出 → 首个输出 token 到达，p50 聚合））、上下文容量（`ContextCapacityPopover`，`context.update` 通道）、模型切换（`ModelSelectPopover`）、思考档位（`ThinkingLevelPopover`）、发送位四态（send/stop/queue/spinner）。renderer 内置组件，非 statusline 数据面。

> **命中率归因降噪（2026-09-19）**：缓存命中率 `current` 是「本会话最近一次 LLM 请求」的单样本口径，任何一次 total miss 都会显示 0%。已知成因的 0%（会话首请求 `cold-start` / 空闲超 5min provider TTL `idle-expiry` / compaction 后前缀重建 `context-rewrite`）改为渲染成因文案（`cacheRatio.currentMiss`，中性色 + 浮层说明行），未知成因的 0%（如服务端淘汰）**保留原值三档色**——降噪只覆盖预期内 miss，不吞真信号；provider 从未上报 cache 字段时命中率为「无数据」（null，显示「—」）而非 0%。

### 任务托盘（Widget Tray）
composer 工具条左簇的常驻观察入口（`packages/renderer/src/components/panel/tray/`，`ComposerTray.vue`）：条目 = built-in 四件（后台命令 / 子代理 / 工作流 / **子会话**，固定序）+ 协议 widget 区（extension 经 `setWidget` 推送的 todo/goal 等「给 agent 看的工作记忆」，icon/badge/状态色由 `WidgetMeta` 驱动）。hover icon 弹出该条目的分桶面板（计数与行集同源，可就地 kill/cancel/abort、点行开 drawer 详情，子会话行点开即跳该会话），点击 icon 可 pin。三态：该类有进行中 → accent 计数 + 呼吸点；仅历史 → dim 常驻；全无记录 → 不渲染（归零不虚噪）。底栏密度状态机实测放不下时（fit L1）整托盘 + 插件 toolbar 聚合为**单图标**聚合按钮（角标 = 运行数数字）单入口，点击弹出全部图标列表；托盘全无条目且插件零贡献时不渲染（无死入口）。设计文档已删除（git 可追溯）。

> **术语演进（2026-09 核对）**：原「WidgetArea」（对话流内的单行 pill 状态带，`@taiji/ui` 组件）已退役——widget 消费端收敛为上述托盘（2026-09-16，设计 D11：对话流回归纯内容，入口唯一化）。子会话第 4 件为模式体系设计 D7 新增（u7 已落地，面板 `TraySessionPanel.vue` 为扁平列表而非分桶槽）。

### 语音朗读（TTS）
taiji 的 assistant 回复朗读能力（ai-voice-tts 设计，P2 辅助功能）。链路：朗读按钮（TurnSummary `speak-btn`，三态 idle/loading/playing + 生成中置灰）→ `useTtsPlayer` 全局单例（ADR-0049 例外清单，窗口级唯一播放任务态）→ core 域 `tts.speak` → runtime `TtsService` 八步编排（现读配置 → 清洗复核 → 缓存键 → 分句 → 逐段合成 → WAV 封装 → 原子写 + FIFO 封顶 → reply `filePath`）→ local-file 音频播放。三家 provider：MiniMax `t2a_v2` / StepFun `audio/speech` / MiMo 借壳 `chat/completions`，配置入口 = 设置页「语音」菜单（表单投影驱动，用户不接触 JSON）。

### 语音朗读总开关
设置页「启用语音朗读」开关（`use-tts-enabled.ts`，localStorage key `taiji.tts.enabled`，data-source-registry #47）：只拦 idle 新朗读（关闭时点朗读 → 「语音服务未配置」toast 不发 RPC）；非 idle 停止与设置页「保存并测试」不受拦。默认开启（键缺失/读失败同默认开）。

### settings-tts-test（伪 id）
设置页「保存并测试」的播放通道：走与朗读按钮完全相同的 `useTtsPlayer.speak`，但用固定伪 messageId（`SETTINGS_TTS_TEST_MESSAGE_ID`）驱动，与对话朗读天然双向互斥（同一全局单例任务态）。

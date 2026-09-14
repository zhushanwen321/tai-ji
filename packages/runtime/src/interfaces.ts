/**
 * Dependency Injection interfaces for the Service layer.
 *
 * These interfaces decouple the Transport layer (server.ts) from
 * concrete implementations, enabling independent testing and
 * future swaps of business logic modules.
 */
import type {
  ServerMessage,
  ServerMessageMap,
  SessionSummary,
  SessionGroup,
  Message,
  ProviderInfo,
  BuiltinProviderTemplate,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
  SourceDetectResult,
  ProviderSource,
  ProviderImportPreview,
  ProviderImportResult,
  PluginInfo,
  GitStatusResult,
  FileNode,
  SubagentRecord,
  WorkflowRunRecord,
  SystemPromptConfig,
  TerminalConfig,
  BatchDeleteResult,
  SegmentsMetadataEntry,
  SkillDirConfig,
  ProviderId,
  LlmRetryConfig,
  RenameMode,
} from '@xyz-agent/shared'
import type { SubagentEngineConfigView } from '@xyz-agent/extension-protocol'
import type { DirScopes } from './services/skill-dir-config.js'
import type { SessionTraceSnapshot } from './services/session/trace-sync.js'
import type { Credential } from './services/auth/auth-storage.js'
import type { IPiEngine, PiEventListener } from './services/ports/pi-engine.js'
import type { IManagedSessionView } from './services/session/types.js'
import type { CatalogRefreshResult } from './services/provider-catalog-refresh.js'

/**
 * pi 引擎 / 进程池 port 的权威定义在 services/ports/pi-engine.ts（D24 收口）。
 *
 * 历史上 IRpcClient（engine 的重复定义）与 IProcessManager 都在本文件，
 * 现已迁移到 ports/。此处仅 re-export，保留 interfaces.ts 作为「跨服务 facade
 * 契约」入口的同时，避免下游大量 import 改动一次性断裂。新代码请直接从
 * services/ports/pi-engine.js 导入。
 *
 * @deprecated 从 services/ports/pi-engine.js 导入 IPiEngine / IProcessManager。
 */
export type { IPiEngine, IProcessManager } from './services/ports/pi-engine.js'
/**
 * IRpcClient 是 IPiEngine 的兼容别名（D24 合并遗留）。
 * @deprecated 改用 IPiEngine（见 services/ports/pi-engine.js）。
 */
export type IRpcClient = IPiEngine

// ── IMessageBroker ────────────────────────────────────────────────

/**
 * Transport-layer message broker.
 *
 * Uses `unknown` for the WebSocket parameter to avoid coupling
 * the Service layer to the `ws` module.
 *
 * wave:perf-w09（02 文档 D1-2 / ADR-0055 7d）：`broadcast` 退化为**纯全局通道**——
 * 只服务 payload 无 sessionId 的全局消息（config.*、app.info、plugin:statusBar*、
 * session.forkNotice、session.handoffComplete/handoffAborted 等，见 02 文档 D5-1 排除清单）。
 * session 级 push 型消息（payload 带 sessionId）一律走 `IMessageBus.publish`
 * （services/message-bus，seq/ring/snapshot + 只推订阅该 sid 的连接），双写已收口。
 */
export interface IMessageBroker {
  send(ws: unknown, msg: ServerMessage): void
  /** 纯全局通道：盲推所有连接。session 级消息禁止走此方法（见接口注释）。 */
  broadcast(msg: ServerMessage): void
  /** D10/P0-B: 第 5 参数从 sessionId(string) 改为 details(ErrorDetails)，sessionId 进 details.sessionId。 */
  sendError(ws: unknown, code: string, message: string, id?: string, details?: { sessionId?: string; [key: string]: unknown }): void
}

// ── IEventAdapter ─────────────────────────────────────────────────

/** Translates pi RPC events into WS protocol ServerMessages. */
export interface IEventAdapter {
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void
  detach(): void
}

// ── ISessionService ───────────────────────────────────────────────

/** Session create 选项（SessionService.create / SessionLifecycle.create 共用）。 */
export interface SessionCreateOptions {
  /**
   * 隐藏 session（公共 session）：scanner listAll 过滤，不进 sidebar 列表。
   * 用于 landing 态命令源等内部场景。
   */
  hidden?: boolean
  /** Launch preset id（设计文档 §4.1），绑定到新 session 并解析为 pi 启动参数。 */
  presetId?: string
  /**
   * Landing Model Chip 传入值，覆盖 preset.modelOverride。
   * 优先级（设计文档 §5.2）：Landing Chip > preset.modelOverride > 全局默认。
   */
  modelOverride?: string
  /**
   * Landing Thinking Chip 传入值，覆盖 preset.thinkingLevel。
   * 优先级（设计文档 §5.2）：Landing Chip > preset.thinkingLevel > 全局默认。
   */
  thinkingOverride?: string
  /** 归属 project id（D14 语义修正 2026-08-04）：创建时归属当前 activeProject；空 = 默认项目兑底。 */
  projectId?: string
  /** 发起来源：'user' | 'agent'。agent-managed session 标记（session-manager create 链路传入）。 */
  spawnSource?: 'user' | 'agent'
  /** 父 agent session id（spawnSource='agent' 时传入，session-manager list 按此过滤子 session）。 */
  parentAgentSessionId?: string
  /**
   * label 是否为语义性命名（需持久化到 pi session_info 且防 auto-rename 覆盖）。
   * true：handoff 承接名 / agent-managed 显式命名。false（默认）：前端派生 prompt
   * 预览名 display-only（2026-08-24 A' 修正，见 session-lifecycle persistExplicitLabel）。
   */
  persistLabel?: boolean
}

/** Session lifecycle: creation, deletion, messaging, history. */
export interface ISessionService {
  create(cwd?: string, label?: string, options?: SessionCreateOptions): Promise<SessionSummary>
  delete(sessionId: string): Promise<void>
  deleteByCwd(cwd: string): Promise<BatchDeleteResult>
  renameSession(sessionId: string, newName: string): Promise<void>
  /** 手动归类（D14 语义修正 2026-08-04）：写 session 归属 project sidecar（空 = 归回默认项目）。 */
  setProject(sessionId: string, projectId: string): Promise<void>
  /**
   * 发送用户消息。
   *
   * images 透传给 pi prompt（message.send 的 images 字段，shared 形状 {data;base64;mimeType}）。
   * 类型组装（补 pi 私有 type:'image'）在 infra 层 RpcClient 内完成，本接口只暴露 shared 形状。
   * undefined 时不传 images，走原路径。
   *
   * clientUuid（session-occupancy-send-closure D2）：客户端幂等 id 透传给 dispatcher，
   * 拒绝广播（预检与 pi 转译两路）原样带回；正常路径不消费。
   */
  sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>, clientUuid?: string): Promise<{ blocked: boolean; rejected?: boolean }>
  // [HISTORICAL] sendSubagentMessage 已删除（composer 四符号设计 D2，marker 半成品通道废弃）：
  // 定向消息改走 subagentAction(message/start) 直达 subagent。
  abort(sessionId: string): Promise<void>
  /** 强制退出卡死 session（sidebar 右键入口，杀 pi 进程 + stopped 收敛）。 */
  forceQuit(sessionId: string): Promise<void>
  /**
   * 直接执行 bash 命令（pi bash RPC，不经 LLM turn）。
   *
   * 返回语义与 sendMessage 对称：{ blocked: true, rejected?: true } 表示预检拒绝或执行失败。
   * excludeFromContext 透传给 pi bash RPC（控制是否进 LLM 上下文）。
   */
  sendBash(sessionId: string, command: string, excludeFromContext?: boolean): Promise<{ blocked: boolean; rejected?: boolean }>
  /**
   * 取消进行中的 bash 执行（pi abort_bash）。
   *
   * 返回 sent = abort_bash RPC 是否发出且 pi 确认（P6 断言④回执真实化）：
   * 守卫短路（无 bash 在跑且无孤儿标记）或发送失败均为 false，调用方不得据此回 aborted。
   */
  abortBash(sessionId: string): Promise<{ sent: boolean }>
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>
  compact(sessionId: string, customInstructions?: string): Promise<void>
  /**
   * 拉取 session 历史（缓存增量三分支重建 + 双预算窗口，crash-resilience §3.3 D4）。
   * truncated=true 表示窗口外仍有历史；loadedTurns=本次返回的完整 turn 数；
   * totalTurnsEstimate=turn 总数估计（全量重建路径精确，窗口截断路径为下界）。
   * [u6] query 可选（crash-resilience §3.3 D4 中期分页协议）：cursor=turn 边界锚点
   * entryId（返回锚点之前的最近窗口，活跃/离线两路径共用语义）；limitTurns/maxBytes
   * 覆盖默认预算（缺省回落 HISTORY_BUDGET）。cursor 未命中返回空页 + truncated=false
   * （翻页到头，不报错）。
   */
  getHistory(sessionId: string, query?: { cursor?: string; limitTurns?: number; maxBytes?: number }): Promise<{ messages: Message[]; truncated: boolean; loadedTurns: number; totalTurnsEstimate: number }>
  /**
   * 获取 session 派生的 subagent 列表（从主 session JSONL 的 subagent toolCall/toolResult 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 subagent 调用时返回空数组。
   */
  getSubagents(sessionId: string): Promise<SubagentRecord[]>
  /**
   * 获取 subagent 的对话流历史（直读 subagent JSONL，复用 convertPiHistory 转换）。
   * subagentId 对应 SubagentRecord.subagentId，从 getSubagents 结果中查找 sessionFile 路径。
   * 文件超 READ_PRECHECK_MAX_BYTES 预检（crash-resilience §3.3 D5①）时返回最近
   * 预算窗口 + truncated 标记（不拒绝）。
   */
  getSubagentHistory(sessionId: string, subagentId: string): Promise<{ messages: Message[]; truncated: boolean }>
  /**
   * [U7] 子代理引擎配置视图（engines.json 动态引擎列表 + config.json defaultEngine 合成）。
   * 纯磁盘读取，不依赖 pi 进程活跃；engines.json 缺失/损坏时 engines 兜底 ['pi']。
   */
  getSubagentEngineConfig(): Promise<SubagentEngineConfigView>
  /**
   * [U7] 设置全局默认子代理引擎（读改写 config.json defaultEngine，保留其他字段，
   * tmp+rename 原子写）。engineId 不在 engines.json 清单内时 throw（防写坏配置）。
   * 生效时机：新 session（extension 在 session_start 读 config——与模型配置同节奏）。
   */
  setSubagentDefaultEngine(engineId: string): Promise<void>
  /**
   * 获取 session 派生的 workflow 列表（从主 session JSONL 的 workflow-state-link 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 workflow 调用时返回空数组。
   */
  getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]>
  /**
   * 获取 workflow 内 agent call 的对话流历史。
   * agentCallSessionId 是 trace[].sessionId（pi session ID），按 sessionId 全局查找 JSONL。
   */
  getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<{ messages: Message[]; truncated: boolean }>
  /**
   * 解析 agent call 对话流 JSONL 绝对路径（与 getAgentCallHistory 共用 record 查找路径
   * ——subagentId → record.sessionFile，见 session-records.ts）。
   * 找不到返回空串（展示型功能，不 throw）。
   */
  getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string>
  /** 触发 workflow 生命周期操作（pause/resume/abort，经扩展 slash command，不经 LLM） */
  workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void>
  /**
   * 拉取 session trace 台账快照（session-trace design D4 数据通路 A1）。
   *
   * 路由：活跃 session 走 pi get_entries RPC（权威解析）+ 文件首行补 header；非活跃/
   * RPC 失败降级走 JSONL+sidecar 文件直读（core parse-jsonl 容错）；未落盘返回
   * source='empty' 空态标记。同时建立增量腿 since 基线（活跃路径）。供 renderer
   * Trace 视图打开时全量拉取（session.getTraceEntries → reply session.traceEntries）。
   */
  getTraceEntries(sessionId: string): Promise<SessionTraceSnapshot>
  /**
   * 现取当前 system prompt（session-trace design §3.1 失败路径 / D2）：经常驻扩展
   * /__xyz_get_system_prompt__ 命令写 xyz:current-system-prompt custom entry，轮询
   * get_entries(since) 拉到后提取返回。仅活跃 session 可用（非活跃无 pi 进程）。
   * @throws code=session_not_active / session_busy / fetch_current_prompt_timeout
   */
  fetchCurrentSystemPrompt(sessionId: string): Promise<ServerMessageMap['session.currentSystemPrompt']>
  /**
   * 增量腿补拉（session-trace A33）：触发事件（message_end/compaction_end/agent_settled/
   * entry_appended）或 lifecycle RPC（set_model/set_thinking_level）成功后调用。
   * get_entries(since=上次 leafId) 拉 delta → 广播 session.traceEntryAppended（含
   * sessionId）；无基线（trace 未打开过）/无活跃 client 时 no-op。fire-and-forget 安全。
   */
  syncTraceEntries(sessionId: string, trigger: string): void
  /**
   * subagent 生命周期/定向消息操作（经扩展 /subagents 命令，不经 LLM；对称 workflowAction）。
   * 字段按 action 取用：cancel 用 subagentId，message 用 subagentId+text，start 用 slug+task。
   * text/task 的换行经 encodeDirectiveText 编码为字面 \n（extension 侧 decodeNewlineEscapes 互逆还原）。
   */
  subagentAction(sessionId: string, action: 'cancel' | 'message' | 'start', params: { subagentId?: string; text?: string; slug?: string; task?: string }): Promise<void>
  /** W5：session 是否空闲（进程存活且非生成中），供 ReloadOrchestrator 判断立即/排队 reload。 */
  isSessionIdle(sessionId: string): boolean
  /** W5：session 是否仍存活（未被 delete），供 ReloadOrchestrator 检测排队期删除。 */
  hasSession(sessionId: string): boolean
  /** W5：发 `/__xyz_reload__` 触发 pi reload（builtin extension handler 调 ctx.reload）。 */
  promptReload(sessionId: string): Promise<void>
  /**
   * U3（composer 四符号 §3.3.5）：reload 成功后失效 commands 快照（markDirty 防抖重拉
   * get_commands，经既有挂钩自动广播 session.commands）。供 ReloadOrchestrator 在
   * promptReload resolve（= reload 完成，设计 F8）后调用；失败路径不调。
   */
  handleSessionReloaded(sessionId: string): void
  /** 查询 session 的扩展命令（pi getCommands）。纯查询无副作用，用于 renderer 主动拉取。 */
  getCommands(sessionId: string): Promise<Array<{ name: string; description?: string; source: string }>>
  /**
   * 拉取 session 上下文用量（pi getSessionStats → contextUsage）。
   * contextUsage.tokens=null（compaction 后未跑新 turn）或 session 未激活时返回 null。
   * 用于 renderer 切 session 后主动拉取（修复 broadcast 与订阅时序竞争）。
   */
  fetchContext(sessionId: string): Promise<{ inputTokens: number; contextLimit: number; usagePercent: number } | null>
  /** 活跃 session id 列表（含公共 session）。供 SkillRegistry 计算 skill 变更广播的 affectedSessionIds。 */
  getActiveSessionIds(): string[]
  /** 取 session 的 cwd（未激活/不存在返回 undefined）。供 SkillRegistry 按项目 skill 变更定位受影响 session。 */
  getSessionCwd(sessionId: string): string | undefined
  restoreSession(sessionId: string): Promise<SessionSummary>
  /**
   * Fork session：从 srcSessionId 截断到 fromPiEntryId，创建新 session（独立 pi 进程）。
   * runtime 读源 JSONL 按树回溯截断，写新文件后 switch_session 加载。源 session 不受影响。
   */
  forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    opts?: {
      fromMessageTimestamp?: number
      fromMessageRole?: string
      /** Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset.modelOverride。 */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，优先于源 preset.thinkingLevel。 */
      thinkingOverride?: string
    },
  ): Promise<SessionSummary>
  hasActiveSession(sessionId: string): boolean
  getSummary(sessionId: string): SessionSummary | undefined
  /**
   * 取活跃 session 的运行时状态视图（isGenerating / isCompacting / isBashRunning /
   * lastActiveAt 等可写字段；未激活/不存在返回 undefined）。sd-u5 起 delivery 装配
   * 经此读 isIdle 判定标志；字段可写语义见 IManagedSessionView 注释。
   */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** W10：取最近 inputTokens——usage 实例快照派生（唯一数据源 = get_session_stats，旧缓存直写已删）。 */
  getInputTokens(sessionId: string): number
  /**
   * 处理 context.update（pi agent_end/turn_end 推 inputTokens + totalTokens）。session 级状态单一 owner：
   * W12 起事件只做 usage 实例失效（markDirty + 防抖重拉 get_session_stats），发布归
   * 快照应用后的挂钩（payload 全字段来自实例快照；W18 起 resolver 窗口重算链已删）。
   * index.ts onContextUpdate 仅调本方法。W10：事件参数不再直写 session 缓存
   * （totalTokens 与 inputTokens 同值，tokenCount 由 usage 实例快照派生）。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void
  /**
   * W18（data-source-governance P3.1）：自描述 record entry（subagent-record /
   * workflow-record）失效信号唯一入口（interpreter 经组合根注入；entry_appended 主信号
   * + subagent/workflow 事件兜底信号汇于此）。只做失效（防抖调度），事件 payload 不进
   * 数据缓存——entry 扫描（get_entries 重拉）是派生缓存唯一数据写路径。
   */
  invalidateRecordEntries(sessionId: string, customType: string): void
  /** W10：取 session 当前 usagePercent——usage 实例快照派生（pi 权威 percent 投影）。 */
  getUsagePercent(sessionId: string): number
  /** Get the underlying RpcClient for direct command sending (e.g., extension responses). */
  getRpcClient(sessionId: string): IRpcClient | undefined

  /**
   * Ensure a session is active (has a running pi process). If not, auto-restore it.
   * @returns The active RpcClient
   * @throws if restore fails or session not found
   */
  ensureActive(sessionId: string): Promise<IRpcClient>

  listPersistedSessions(): SessionGroup[]
  destroyAll(): Promise<void>

  /** 注册 onBeforeSendMessage hook，由 PluginService 调用（可阻止发送或改写内容） */
  setSendMessageHook(hook: (sessionId: string, content: string) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>): void
  /** S3-W2：注册 session 创建回调（PluginService 绑插件 session 事件注册表投递） */
  setOnSessionCreated(handler: (summary: SessionSummary) => void): void
  /**
   * S3-W2：注册 session 销毁回调（触发点 removeSessionEntry，全部删除路径汇聚处：
   * 主动删 / 进程退出 / restore 清场）。D6a：追加式注册（回调列表），多方共存互不覆盖
   *（PluginService didDestroy 投递 + server 的挂起 UI 请求汇聚清理），单 handler 异常被隔离。
   */
  setOnSessionDestroyed(handler: (summary: SessionSummary) => void): void
  /** Set thinking level for a session's pi subprocess. Returns pi-effective level (P3: pi clamps unsupported levels). */
  setThinkingLevel(sessionId: string, level: string): Promise<string>
  /** Steer an actively generating session */
  steerMessage(sessionId: string, content: string): Promise<void>
  /** Queue a follow-up message for a session */
  followUpMessage(sessionId: string, content: string): Promise<void>

  // ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写（从 main IPC 迁 WS，安全校验原样搬 TC3）──
  /** 写入粘贴截图（base64→attachments/tmpdir）。安全校验：mimeType image/* + 20MB 上限 + name sanitize */
  writeImage(sessionId: string, base64: string, mimeType: string, name: string): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }>
  /** 迁移 tmpdir 图片到 attachments 持久化目录。安全校验：fromPath 白名单（tmpdir/attachments） */
  migrateImage(fromPath: string, sessionId: string, fileName: string): Promise<{ path: string }>
  /** 追加/覆盖 segments.json sidecar（atomic 写，同 clientUuid 覆盖） */
  writeSegmentsMetadata(sessionId: string, entry: SegmentsMetadataEntry): Promise<void>

  /**
   * M3：标记源 session 已交接给新 session（内存写 handedOffTo + 磁盘写 handoff_marker）。
   * HandoffService 消费（绑具体类）。仅 active session 生效；非 active 源 session 按
   * no-op 处理（见具体类 docstring）。S2 自内部协议迁入（迁移非新增，设计 D2①）。
   */
  markHandedOff(srcSessionId: string, newSessionId: string): void
}

// ── IConfigService ────────────────────────────────────────────────

/** Provider / Skill / Agent CRUD and tool permissions. */
export interface IConfigService {
  listProviders(): ProviderInfo[]
  /** 远程模型目录按需刷新（settings-provider 页进入时触发，fail-safe）。 */
  refreshProviderCatalogs(): Promise<CatalogRefreshResult>
  /** 列出内置 provider 模板（wave 2，import generated JSON，无参只读）。 */
  listBuiltinProviders(): BuiltinProviderTemplate[]
  /**
   * 环境变量检测（I3，wave-env-check）：检查 runtime process.env 中指定变量是否已设置。
   * 安全红线：只返回布尔不返回值（env 值可能含凭证，不能泄露到前端）。names 去重。
   */
  checkEnvVars(names: string[]): Record<string, boolean>
  getDefaultModel(): { provider: ProviderId; modelId: string } | null
  setDefaultModel(provider: string, modelId: string): void
  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null> }>
    enabled?: boolean
  }): Promise<{ newDefault?: { provider: ProviderId; modelId: string } }>
  /**
   * 切换 provider 启用状态（wave3 IF2）——写 enabledModels 白名单。
   *
   * enabled=true: 若 enabledModels 非空加 `<id>/*`；空时 no-op（CL1）。
   * enabled=false: 移除所有 `<id>/*`/`<id>/<model>` pattern；边界3 空时 delete 字段（CL2）；
   *   边界2 若 defaultModel 承载该 provider 重选并返回 newDefault。
   *
   * @returns 触发 defaultModel 重选时含 newDefault；否则空对象。
   */
  toggleProviderEnabled(providerId: string, enabled: boolean): { newDefault?: { provider: ProviderId; modelId: string } }
  /**
   * 按体系移除 provider（wave4 IF3）——catalog 清凭据/override/残留（不删 pi catalog 定义），
   * custom 删 models.json 条目 + 清残留。renderer 传 ProviderInfo.kind（CL1）。
   *
   * @returns custom 分支透传 configStore.removeProvider 的 newDefault（default 承载被删 provider 时重选）；
   *          catalog 分支透传 removeProvider 的 newDefault（override 承载 default 时重选 default + mutate settings.json）。
   */
  removeProviderByKind(providerId: string, kind: 'catalog' | 'custom'): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }>
  deleteProvider(providerId: string): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }>
  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined
  updateToolPermissions(permissions: Record<string, string>): void
  // ── Skill/Agent 加载路径（ADR-0021 §1 discovery.json v2 SSOT）──
  /** 覆盖 skill 路径（SkillDirConfig[] 带 scope，按 scope 分发写 projectPaths/globalPaths）。写 discovery.json + 投影 settings.json。 */
  setSkillDirs(dirs: SkillDirConfig[]): void
  /** 读取 skill 合并路径（project ∪ global 去重，项目在前）。 */
  getSkillDirs(): string[]
  /** 读取 skill 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getSkillPathScopes(): DirScopes
  /** 覆盖 agent 路径（SkillDirConfig[] 带 scope）。写 discovery.json。 */
  setAgentDirs(dirs: SkillDirConfig[]): void
  /** 读取 agent 合并路径（project ∪ global 去重，项目在前）。 */
  getAgentDirs(): string[]
  /** 读取 agent 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getAgentPathScopes(): DirScopes
  /** 覆盖 extension 路径（SkillDirConfig[] 带 scope）。写 discovery.json。 */
  setExtensionDirs(dirs: SkillDirConfig[]): void
  /** 读取 extension 合并路径（project ∪ global 去重，项目在前）。 */
  getExtensionDirs(): string[]
  /** 读取 extension 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getExtensionPathScopes(): DirScopes
  /** 一次性迁移：settings.json.skills → discovery.json（首启用，幂等）。 */
  migrateSettingsSkillsToDiscovery(): void
  loadSkills(projectRoot: string): SkillInfo[]
  saveSkills(projectRoot: string, skills: SkillInfo[]): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  upsertSkill(skill: SkillInfo): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  deleteSkill(skillId: string): void
  loadAgents(projectRoot: string): AgentInfo[]
  saveAgents(projectRoot: string, agents: AgentInfo[]): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  upsertAgent(agent: AgentInfo): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  deleteAgent(agentId: string): void
  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[]
  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[]
  /**
   * 检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录（W1 迁移功能）。
   * 只读检测，不读文件内容；返回每个源的安装状态 + 资源计数。
   */
  detectSources(): SourceDetectResult[]
  /**
   * W2 迁移：预览从其他 agent 源导入的 provider 列表（脱敏，不含 apiKey 值）。
   *
   * 安全红线（DM1）：返回的 ProviderImportPreview 只含 apiKeyExtracted 布尔，**不含 apiKey 明文**。
   * 完整配置（含 apiKey 明文）暂存在 runtime 内存缓存（5min TTL），由 applyImportProviders 消费。
   *
   * @param source 迁移源（pi/zcode/codex/claude）。
   * @returns 成功 { importId, preview }；源未安装 { error: { code: 'SOURCE_NOT_INSTALLED', message } }。
   *          importId 供 applyImportProviders 第二步使用。
   */
  previewImportProviders(source: ProviderSource): { importId: string; preview: ProviderImportPreview } | { error: { code: string; message: string } }
  /**
   * W2 迁移：应用导入（写入 models.json）。从缓存取完整配置 → 剥离 _ 元数据 → 逐个 upsertProvider。
   *
   * apply 成功后立即删缓存（一次性，防 importId 复用）。apply 时再次查冲突（preview 后 models.json 可能被改），
   * 同名 provider 标 skipped（不覆写）。
   *
   * @param importId previewImportProviders 返回的 importId。
   * @param selectedIds 用户勾选导入的 provider id 列表（对应源里的 provider 名）。
   * @returns 成功 { result }；缓存过期/不存在 { error: { code: 'PREVIEW_EXPIRED', message } }。
   */
  applyImportProviders(importId: string, selectedIds: string[]): Promise<{ result: ProviderImportResult } | { error: { code: string; message: string } }>
  /** pi agent 配置目录（settings.json/agents/skills 所在地）。 */
  getPiAgentDir(): string
  /** xyz-agent 配置根目录（~/.xyz-agent/，plugins/session-data 所在地）。 */
  getConfigDir(): string
  // ── System prompt config（FR-6/FR-7，ADR-0044）──
  /** 读取 system-prompt.json。损坏时 corrupted=true 且返回默认配置。 */
  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean }
  /** 写入 system-prompt.json。replace.prompt 超长（>SYSTEM_PROMPT_MAX_LENGTH）返回 ok:false + error，不写盘。 */
  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string }
  /** 返回当前生效的替换提示词（replace.enabled && prompt 非空白时），否则 undefined。rpc-client spawn 时透传。 */
  getReplaceSystemPrompt(): string | undefined
  // ── Terminal config（Phase 6 settings）──
  /** 读取 terminal.json。损坏时 corrupted=true 且返回默认配置。 */
  getTerminalConfig(): { config: TerminalConfig; corrupted: boolean }
  /** 写入 terminal.json。校验失败返回 ok:false + error，不写盘。 */
  setTerminalConfig(config: TerminalConfig): { ok: boolean; error?: string }
  // ── LLM retry config（llm-retry-settings 设计，经 ILlmRetrySettings port）──
  /** 读 pi settings.json retry 域：缺省键合并为 pi 默认值 + configured 标记（D7）。 */
  getRetryConfig(): { config: LlmRetryConfig; configured: boolean }
  /** 写 retry 域：D8 全量校验失败返回 ok:false + error 不落盘；成功 D3 嵌套键级 merge。 */
  setRetryConfig(config: LlmRetryConfig): { ok: boolean; error?: string }
  // ── Worktree config（git-cwt-anywhere）──
  /** 读取 worktree 根目录（config.json.worktreeRootDir），默认 '~/worktrees'。 */
  getWorktreeRootDir(): string
  /** 写入 worktree 根目录到 config.json.worktreeRootDir。 */
  setWorktreeRootDir(dir: string): void
  /** 读取 setup 脚本路径（config.json.setupScript），默认 'custom-hooks/setup-worktree.sh'。 */
  getSetupScript(): string
  /** 写入 setup 脚本路径到 config.json.setupScript。 */
  setSetupScript(script: string): void
  /** 读取 bare-workspace 初始化脚本路径（config.json.bareSetupScript），默认 'custom-hooks/setup-worktree.sh'。 */
  getBareSetupScript(): string
  /** 写入 bare-workspace 初始化脚本路径到 config.json.bareSetupScript。 */
  setBareSetupScript(script: string): void
  /** 读取 worktree 创建超时时间（config.json.worktreeTimeout），默认 60 秒。 */
  getTimeout(): number
  /** 写入 worktree 创建超时时间到 config.json.worktreeTimeout。 */
  setTimeout(timeout: number): void
  /** 读取对话流式空闲超时阈值（config.json.streamingIdleTimeout，秒），默认 1800 秒（timeout-streaming-ui-idle §5.3 D3）。 */
  getStreamingIdleTimeout(): number
  /** 写入对话流式空闲超时阈值：clamp 到 [60, 3600] 秒后落盘，返回生效值。 */
  setStreamingIdleTimeout(timeout: number): number
  /** 读取默认基分支（config.json.defaultBaseBranch），默认 'origin/main'。 */
  getDefaultBaseBranch(): string
  /** 写入默认基分支到 config.json.defaultBaseBranch。 */
  setDefaultBaseBranch(baseBranch: string): void
  /** 读取是否启用 session 自动重命名（标志文件存在=开），默认 false。 */
  getAutoRenameEnabled(): boolean
  /** 设置 session 自动重命名开关（true 创建标志文件 / false 删除）。 */
  setAutoRenameEnabled(enabled: boolean): void
  /** 读取 rename 标题生成模型（"provider/modelId"，未设置 = 空串；读 extension 配置文件）。 */
  getRenameModel(): string
  /** 设置 rename 标题生成模型（读改写 extension 配置文件的 model 字段，保留其他字段）。 */
  setRenameModel(model: string): void
  /** 读取 rename 触发模式（first-prompt/first-stop/agent-tool；读 extension 配置文件，缺失/非法回默认 first-stop）。 */
  getRenameMode(): RenameMode
  /** 设置 rename 触发模式（读改写 extension 配置文件的 mode 字段，非法值归一默认，保留其他字段）。 */
  setRenameMode(mode: RenameMode): void
  /** 读取智能上下文压缩配置快照（extension 配置文件，字段非法回退默认值）。 */
  getSmartContextConfig(): import('./services/worktree-config-helper.js').SmartContextConfigSnapshot
  /** 设置智能上下文压缩开关（读改写 extension 配置文件的 enabled 字段，保留其他字段）。 */
  setSmartContextEnabled(enabled: boolean): void
  /** 设置压缩模型（读改写 compactModel 字段；空串 = 跟随当前会话模型）。 */
  setSmartContextCompactModel(model: string): void
  /** 设置 3 档提醒阈值（token 绝对数；clamp 升序 3 档，空回退默认）。 */
  setSmartContextThresholds(thresholds: number[]): void
  /** 设置排除模型列表（过滤无 "/" 条目去重后写入 excludedModels 字段）。 */
  setSmartContextExcludedModels(models: string[]): void
  // ── Scoped Models（scoped-model 设计文档 §3.3 D2）──
  /** 读取 scoped models 白名单（providers.json 顶层 scopedModels 字段）。空数组 = 未启用。 */
  getScopedModels(): string[]
  /** RMW scoped models 白名单（锁内重读 → fn(current) → 原子写回，config.setScopedModels RPC 写入口）。 */
  modifyScopedModels(fn: (current: string[]) => string[]): Promise<string[]>
}

// ── IExtensionService ──────────────────────────────────────────────

/** Extension lifecycle: discovery, enable/disable, install/uninstall, path resolution. */
export interface IExtensionService {
  scanExtensions(): Promise<import('@xyz-agent/shared').ExtensionInfo[]>
  /** 推荐扩展列表（含已安装状态，前端 Settings 快捷安装按钮数据源） */
  getRecommendedExtensions(): Promise<Array<{ name: string; description: string; installed: boolean }>>
  toggleExtension(name: string, enabled: boolean): Promise<void>
  /** 升级单个 user-installed 扩展到 npm latest 版本（已是最新则 upgraded=false）。 */
  upgradeExtension(name: string): Promise<{ upgraded: boolean; from: string; to: string }>
  /** 开关某扩展的启动期自动升级。 */
  setAutoUpgrade(name: string, autoUpgrade: boolean): Promise<void>
  /** 启用的 extension 路径列表（供 pi --extension 参数）。cwd 用于解析相对的 discovery extension 目录。 */
  getExtensionPaths(cwd?: string): Promise<string[]>
  /**
   * 供 PresetService 做 preset 二次筛选：返回原始发现结果（不过滤；npm 化 builtin
   * infrastructure 包随 discovery 一并返回）+ disabled 集合。
   */
  getDiscoveredAndDisabled(cwd?: string): Promise<{ discovered: import('./services/ports/installer.js').DiscoveredExtension[]; disabledSet: Set<string> }>
  installExtension(source: string): Promise<void>
  uninstallExtension(name: string): Promise<void>
  installLocalDirectory(sourcePath: string): Promise<{ tempDir: string; candidates: import('@xyz-agent/shared').ExtensionInfo[] }>
  installGitRepository(url: string): Promise<{ tempDir: string; candidates: import('@xyz-agent/shared').ExtensionInfo[] }>
  finishInstall(tempDir: string, selected: string[]): Promise<void>
  cancelInstall(tempDir: string): Promise<void>
}

// ── IModelService ─────────────────────────────────────────────────

/**
 * OAuth Login 编排服务（slice design I1/T5）。
 * 实现：services/auth/auth-service.ts（路径 B 自实现：device/callback flow 拿 token 写 auth.json）。
 */
export interface IAuthService {
  /** 启动 OAuth login（异步执行）。无 oauthConfig / 已有进行中 flow → started:false + error。 */
  login(providerId: string): { started: boolean; error?: string }
  /** 中止进行中 flow。幂等：无 flow 返回 cancelled:false。 */
  cancel(providerId: string): { cancelled: boolean }
  /** 读 auth.json：该 provider 是否有 oauth 凭据。 */
  hasOAuth(providerId: string): Promise<boolean>
  /** 退出登录（B-1 场景 C）：移除 auth.json 中该 provider 的凭证（有进行中 flow 先中止，幂等）。 */
  logout(providerId: string): Promise<void>
  /** 读 auth.json 凭证（A1-4 收口读通道，Phase A2 QuotaService 凭证源）。直读不缓存。 */
  getCredential(providerId: string): Promise<Credential | undefined>
  /** 写 auth.json 凭证（A1-4 收口写通道）：全 runtime 对 auth.json 写入的唯一入口。 */
  saveCredential(providerId: string, credential: Credential): Promise<void>
}

/** Model aggregation, API discovery, and model/thinking-level orchestration. */
export interface IModelService {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[]
  /**
   * 双参版聚合：scopedModels 由调用方传入（单次读盘值复用，保证同一帧内
   * config.providers.scopedModels 与 model.list 一致）。design D2 否决改
   * aggregateModels 公开单参签名，故独立命名。
   */
  aggregateModelsWithScoped(providers: ProviderInfo[], scopedModels: string[]): ModelInfo[]
  discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; contextWindow?: number }>>

  /** Switch model with full side-effects: pi RPC + persist default + broadcast. */
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>

  /** Set thinking level for a session's pi subprocess. Returns pi-effective level (P3: pi clamps unsupported levels). */
  setThinkingLevel(sessionId: string, level: string): Promise<string>

  /** 给 ProviderInfo.models 逐模型标注 supportedLevels（U5 能力注册表服务面，pi 同源计算，
   *  签名与 ModelService 逐字对齐——view-ready 字段，renderer 零推导）。 */
  attachSupportedLevels(providers: ProviderInfo[], piVersion?: string): ProviderInfo[]
  /** 在线对账（U6 D2②）：session 附着后调用，返回本次 drift 项（引擎不可用/RPC 失败降级返回 []）。 */
  reconcileModelCapabilities(sessionId: string): Promise<import('./services/model-capability.js').CapabilityDrift[]>
  /** 订阅对账 drift 事件（单订阅者语义，重复调用覆盖）。 */
  setCapabilityDriftSink(sink: (drifts: import('./services/model-capability.js').CapabilityDrift[]) => void): void
}

// ── IPluginService ────────────────────────────────────────────────

/** Plugin lifecycle: discovery, activation, deactivation, shutdown. */
export interface IPluginService {
  initialize(): Promise<void>
  /**
   * 已发现插件列表，按 WS 协议契约返回 PluginInfo[]（config.plugins）。
   *
   * 内部 PluginDescriptor（含 main/activationEvents/contributes 等私有字段）由
   * PluginRegistry.getDescriptor/getAllDescriptors 暴露给 service 内部协作；
   * 对 transport 仅暴露协议类型，避免内部类型外泄。
   */
  getDiscoveredPlugins(): PluginInfo[]
  togglePlugin(pluginId: string, enabled: boolean): Promise<PluginInfo[]>
  shutdown(): Promise<void>

  /** Uninstall a plugin: deactivate, remove files, rescan registry */
  uninstallPlugin(pluginId: string): Promise<PluginInfo[]>
  /** Approve specific permissions for a plugin */
  approvePermissions(pluginId: string, permissions: string[]): Promise<void>
  /** Revoke all permissions for a plugin */
  revokePermissions(pluginId: string): Promise<void>
  /** Execute a command contributed by a plugin（S3-W1：返回插件 handler 的执行结果） */
  executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<unknown>
  /** Get plugin config value(s) */
  getPluginConfig(pluginId: string, key?: string): Promise<unknown>
  /** Set a plugin config value */
  setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void>
  /** 覆盖式写入挂载点集合（renderer 经 plugin.mountPoints.sync 上报，DM3 全量镜像） */
  syncMountPoints(mountPoints: string[]): void
  // [B5 触发面收窄 2026-09-15] 原 clearSessionData(sessionId) 条目已删：实装 facade 零调用点
  // （真删除链经模块级 clearRemovedSessionData 分发，见 session-lifecycle.ts delete），
  // 且原签名 sync void 与实现 async 不符（陈旧契约，组 A 顺手修 low 项）。
  /** Handle UI response from frontend (confirm/select/input dialogs) */
  handleUiResponse(requestId: string, result: unknown): void

  /** Bridge routing methods */
  handleBridgeRequest?(method: string, payload: Record<string, unknown>, sessionId: string): Promise<unknown>

  /** Install a plugin from an npm package specifier */
  installPlugin(packageSpecifier: string): Promise<import('./services/ports/plugin-installer.js').InstallResult>
  getToolSchemas?(): import('./services/plugin-service/plugin-types.js').ToolRegistration[]
  /** 构造 bridge:sync 同步负载（工具 schema 塑形下沉 service，transport 只 reply） */
  getBridgeSyncPayload?(): import('./services/plugin-service/plugin-types.js').BridgeSyncPayload
  handleBridgeToolExecute?(request: import('./services/plugin-service/plugin-types.js').BridgeToolExecuteRequest): Promise<import('./services/plugin-service/plugin-types.js').BridgeToolExecuteResponse>
  handleBridgeEvent?(eventName: string, data: unknown, sessionId: string): void
  handleBridgeIntercept?(eventName: string, data: Record<string, unknown>, sessionId: string): Promise<import('./services/plugin-service/plugin-types.js').BridgeInterceptResponse>
}

// ── IGitService ───────────────────────────────────────────────────

/**
 * Git 域 service port（与 ISessionService / IExtensionService 对称的 DI seam）。
 * GitMessageHandler 经此接口依赖 git 能力，不直接 import 具体的 GitService 类。
 * 方法签名与 GitService（services/git-service.ts）逐字对齐——行为保持不变。
 */
export interface IGitService {
  getStatus(sessionId: string): Promise<GitStatusResult>
  getFileDiff(sessionId: string, path: string): Promise<{ patch: string; binary: boolean }>
  stage(sessionId: string, filePaths?: string[]): Promise<void>
  unstage(sessionId: string, filePaths?: string[]): Promise<void>
  commit(sessionId: string, message?: string): Promise<void>
  checkout(sessionId: string, name: string): Promise<void>
  checkoutByCwd(cwd: string, name: string): Promise<void>
  createBranch(sessionId: string, name: string): Promise<void>
  /**
   * 写操作成功后的状态缓存失效（perf W17）：handler 在 stage/unstage/commit/checkout/
   * createBranch（sessionId）与 checkoutCwd（cwd，session-less）成功后调用。
   */
  invalidateStatusCache(target: { sessionId?: string; cwd?: string }): void
}

// ── IFileService ──────────────────────────────────────────────────

/**
 * 文件树编排 service port（与 ISessionService / IExtensionService 对称的 DI seam）。
 * FileMessageHandler 经此接口依赖文件树能力，不直接 import 具体的 FileService 类。
 * 方法签名与 FileService（services/file-service.ts）逐字对齐——行为保持不变。
 */
export interface IFileService {
  listTree(sessionId: string): Promise<FileNode[]>
  expandDir(sessionId: string, path: string): Promise<FileNode[]>
  searchFiles(sessionId: string, showIgnored?: boolean): Promise<FileNode[]>
  /** landing cwd 路核心（file.search.cwd）：全量递归给定 cwd；session 路经 searchFiles 薄包装复用。
   *  truncated = DoS 上限 5000 截止（D7，file.search.cwd:result 携带；file.search:result 不带）。 */
  searchFilesInCwd(cwd: string, showIgnored?: boolean): Promise<{ files: FileNode[]; truncated: boolean }>
  readFile(sessionId: string, path: string): Promise<{ content: string; truncated: boolean }>
  readFileFromWhitelist(path: string): Promise<{ content: string; truncated: boolean }>
  createFile(sessionId: string, path: string, content: string): Promise<never>
  renameFile(sessionId: string, oldPath: string, newPath: string): Promise<never>
  deleteFile(sessionId: string, path: string): Promise<never>
}

// Client → Runtime message types

import type { ProviderInfo, SkillInfo, AgentInfo, ModelInfo, SkillDirConfig, ScannedSkillInfo, ScannedAgentInfo, BuiltinProviderTemplate, ProviderId } from './provider'
import type { SessionGroup, SessionSummary, SessionStatus, SessionDataSource } from './session'
import type { FileChange, ChangeSetStatus, Message } from './message'
import type { PiMessageEntry, PiToolCallEntryForm } from './pi-entry'
import type { FileNode } from './file-tree'
// 领域 DTO 已下沉到各自领域文件（E2 架构候选）：protocol.ts 仅保留 type→payload 映射 SSOT，
// 领域形状（ExtensionInfo / GitStatusResult / PluginInfo …）按领域就近归属。
import type { ExtensionInfo, RecommendedExtension, ExtensionInteractMethod } from './extension'
import type { ProjectStoreState } from './project'
import type { GitStatusResult } from './git'
import type { PluginInfo } from './plugin'
import type { RecentWorkspaceRecord } from './workspace'
import type { LlmRetryConfig } from './llm-retry'
import type { SubagentRecord } from './subagent'
import type { WorkflowRunRecord } from './workflow'
import type { PiLaunchPreset, PresetUsageEntry, ThinkingLevel } from './pi-preset'
import type { SourceDetectResult } from './migration'
import type {
  ProviderSource,
  ProviderImportPreview,
  ProviderImportResult,
} from './migration'
import type { SegmentsMetadataEntry } from './message-metadata'
import type { ImportCandidatesRequest, ImportCandidatesReply, ImportRequest, ImportReply } from './import-session'
import type { UsageStatsResult } from './usage-stats'
// composer-gen-stats：生成指标帧形状 SSOT（本文件仅登记 type→payload 映射）
import type { GenStatsFrame } from './gen-stats'
// quota.configure payload 形状 SSOT 引用（coding-plan-quota-config-ux §7.1 契约收敛）
import type { QuotaConfigurePayload } from './quota-types'

/**
 * 测试连接按协议分组的单行结果（SSOT，2026-09-10 review S-9 手写重复收编）：
 * protocol `config.discoveredModels.results` 元素 / core transport / core TestConnectionResult /
 * runtime port ConnectionTestResult 四处同形状，全部引用本类型，漂移编译期红。
 */
export interface ConnectionTestResultRow {
  /** 协议（pi model.api） */
  api: string
  /** 该协议分组的代表模型 id */
  modelId: string
  ok: boolean
  /** 失败时的真实原因（HTTP 状态码与响应截断） */
  error?: string
}

// ── Client → Runtime message types

/** pi get_commands 返回的命令来源元信息（RpcSlashCommand.sourceInfo 透传）。
 *  sourceInfo.path 是 SKILL.md / extension 文件绝对路径，供 CommandDocPanel 直接读文件渲染。 */
export interface CommandSourceInfo {
  /** SKILL.md / extension 文件绝对路径 */
  path: string
  /** pi 来源分类（extension / prompt / skill） */
  source: string
  /** 作用域：user / project / temporary */
  scope?: string
  /** 包来源：package / top-level */
  origin?: string
  /** 基础目录（pi 用于相对路径解析的基准） */
  baseDir?: string
}

// ── ClientMessageType（保持向后兼容）──────────────────────────

export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.deleteByCwd' | 'config.sessions' | 'session.switch' | 'session.restore' | 'session.history' | 'session.getCommands' | 'session.getContext'
  | 'session.compact' | 'session.rename' | 'session.fork' | 'session.setProject'
  // composer-gen-stats（D4）：session.getGenStats 拉该 session
  // 当前模型的速度/缓存命中率快照（恢复腿——切 session 主动拉取，规避 broadcast 早于订阅的时序竞争）。
  // reply session.stats_update（payload 消费型，同 session.getContext → context.update 模式）。
  | 'session.getGenStats'
  // session-trace（design D4 数据通路 A1）：session.getTraceEntries 拉全量 trace 台账
  //（活跃走 RPC get_entries + header 首行补读；非活跃走文件直读），reply session.traceEntries。
  | 'session.getTraceEntries'
  // session-trace（design §3.1 失败路径 / D2）：现取当前 system prompt（pi RPC 无
  // get_system_prompt，通道在 builtin agent-ext 包（不可禁）的 /__taiji_get_system_prompt__
  // 命令 → taiji:current-system-prompt custom entry → runtime 轮询拉取）。
  | 'session.fetchCurrentSystemPrompt'
  | 'session.handoff' | 'session.abortHandoff'
  // runtime-message-bus（slice:runtime-message-bus，wave:protocol-seq）：
  // session.subscribe 订阅某 session 的 live 事件流（bus.publish 推送的带 seq 消息），
  // reply { snapshot, lastSeq, gap? }（见 ReplyPayloadMap）。
  // session.unsubscribe 取消订阅，reply message.status ack。
  // wave:runtime-wiring 已在 ClientMessageMap 补登记 request payload 形状（见下方）。
  | 'session.subscribe' | 'session.unsubscribe'
  | 'session.getSubagents' | 'session.getSubagentHistory'
  // plan 模式重设计（D1-⑥ 冷启动首拉）：getPlanState 读 session JSONL 内最后一条
  // plan-state entry 派生状态视图（stateSnapshot 是 bus 内存态、pi exit 即清空，
  // 冷送达/切换首拉靠本 RPC——与 session.getSubagents 首拉同构）。
  // abortPlan：横幅「退出 ×」→ runtime 经 ensureActive 恢复后 client.prompt('/plan abort')
  // 直发（绕 busy 预检，streaming 中可用）。
  | 'session.getPlanState' | 'session.abortPlan'
  // [U7] 子代理引擎配置（Settings 引擎选择器：动态引擎列表 + defaultEngine 读写）
  | 'session.getSubagentEngineConfig' | 'session.setSubagentDefaultEngine'
  | 'session.getWorkflows' | 'session.getAgentCallHistory' | 'session.getAgentCallFilePath'
  | 'session.workflowAction' | 'session.subagentAction'
  // session.forceQuit：强制退出卡死 session（杀 pi 子进程 + stopped 收敛，区别于 message.abort 的协作式中止）。
  | 'session.forceQuit'
  // wave:runtime-patch ipc-converge-a3 W2：业务持久化写迁 WS（session 数据单一出口归 runtime）。
  // session.writeImage 粘贴截图落地 attachments；session.migrateImage landing tmpdir→attachments 迁移；
  // session.writeSegments 追加/覆盖 segments.json sidecar。原 main IPC handler，现 runtime session-service。
  | 'session.writeImage' | 'session.migrateImage' | 'session.writeSegments'
  // session.importCandidates / session.import（docs/design/import-session.md（已删除，git 可追溯）§3.3 D5）：导入 pi 会话
  // 两步流——importCandidates 拉候选列表，import 执行导入；reply 同名（request/reply 同名模式）。
  | 'session.importCandidates' | 'session.import'
  | 'message.send' | 'message.abort' | 'message.steer' | 'message.follow_up'
  | 'message.bash' | 'message.abortBash'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'config.refreshProviderCatalogs'
  | 'config.discoverModels' | 'config.setDefaultModel'
  | 'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
  | 'config.scanSessionSkills'
  | 'config.getGlobalSkills' | 'config.getProjectSkills'
  | 'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
  | 'config.setSkillDirs' | 'config.setAgentDirs' | 'config.setExtensionDirs'
  | 'config.getSystemPrompt' | 'config.setSystemPrompt'
  | 'model.list' | 'model.switch' | 'session.setThinkingLevel'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'extension.ui_response' | 'extension.toggle' | 'extension.list'
  | 'extension.install' | 'extension.uninstall'
  | 'extension.installDir' | 'extension.installGit' | 'extension.finishInstall' | 'extension.cancelInstall'
  | 'extension.recommended'
  | 'extension.upgrade' | 'extension.setAutoUpgrade'
  | 'extension.getPendingRequests'
  | 'ping'
  // WS 传输层认证握手（S1-W1，spec §3.3 D4）：连接建立后的首条消息，校验通过前
  // runtime 不受理任何其他消息（10s 超时断开、失败 close 1008）。不走 handleMessage
  // 路由（ConnectionManager 传输层消费），reply 'auth.result'。
  | 'auth'
  | 'plugin.list' | 'plugin.toggle'
  | 'plugin.install' | 'plugin.uninstall'
  | 'plugin.approvePermissions' | 'plugin.revokePermissions'
  | 'plugin.executeCommand'
  | 'plugin.config.get' | 'plugin.config.set'
  | 'plugin.uiResponse'
  | 'plugin.mountPoints.sync'
  | 'file.read'
  | 'file.tree' | 'file.tree.expand' | 'file.search' | 'file.search.cwd'
  | 'git.diff'
  | 'file.write.create' | 'file.write.rename' | 'file.write.delete'
  | 'git.status' | 'git.stage' | 'git.unstage' | 'git.commit' | 'git.checkout' | 'git.checkoutCwd' | 'git.createBranch'
  | 'workspace.listRecent' | 'workspace.record' | 'workspace.detectBare' | 'workspace.detect'
  | 'project.load' | 'project.save'
  | 'worktree.create' | 'worktree.listBranches' | 'worktree.list'
  | 'terminal.spawn' | 'terminal.write' | 'terminal.resize' | 'terminal.kill' | 'terminal.attach'
  | 'config.getTerminalConfig' | 'config.setTerminalConfig'
  | 'config.getRetryConfig' | 'config.setRetryConfig'
  | 'quota.fetch' | 'quota.getCached' | 'quota.configure' | 'quota.refresh'
  | 'usage.getStats'
  | 'config.setWorktreeRootDir' | 'config.getWorktreeRootDir'
  | 'config.setSetupScript' | 'config.getSetupScript'
  | 'config.setBareSetupScript' | 'config.getBareSetupScript'
  | 'config.setTimeout' | 'config.getTimeout'
  | 'config.setDefaultBaseBranch' | 'config.getDefaultBaseBranch'
  | 'config.setAutoRenameEnabled' | 'config.getAutoRenameEnabled'
  | 'config.setRenameModel' | 'config.getRenameModel'
  | 'config.setRenameMode' | 'config.getRenameMode'
  | 'config.getSmartContextConfig'
  | 'config.setSmartContextEnabled'
  | 'config.setSmartContextCompactModel'
  | 'config.setSmartContextThresholds'
  | 'config.setSmartContextExcludedModels'
  | 'preset.list' | 'preset.getDefault' | 'preset.setDefault'
  | 'preset.create' | 'preset.update' | 'preset.delete'
  | 'preset.recordUsage' | 'preset.getUsage'
  | 'preset.export' | 'preset.import'
  // 迁移：检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录。
  // 只读检测，不读文件内容（安全）。reply config.sourcesDetected。
  | 'config.detectSources'
  // wave 2：列出内置 provider 模板（import generated JSON，无参只读）。reply config.builtinProviders。
  | 'config.listBuiltinProviders'
  // 迁移 W2：Provider 导入两步流。Step1 preview（脱敏，apiKey 不进前端）→ Step2 apply（写 models.json）。
  // reply config.providersPreviewed / config.providersImported。
  | 'config.previewImportProviders' | 'config.applyImportProviders'
  // OAuth Login（路径 B 自实现，slice design I1/I2）：启动/中止 OAuth flow。
  // 中间态经 server→client 事件推送（auth.deviceCode / auth.authUrl / auth.success / auth.error）。
  | 'config.oauthLogin' | 'config.oauthCancel'
  // 环境变量检测（I3，wave-env-check）：只返回布尔不返回值（env 值可能含凭证）。
  | 'config.checkEnvVars'
  // OAuth 凭据查询（MF-1）：auth.json 是否已有该 provider 的 oauth 凭据（只返回布尔，token 不出协议）。reply config.hasOAuthReply。
  | 'config.hasOAuth'
  // OAuth 退出登录（B-1 场景 C）：移除 auth.json 中该 provider 的凭证（有进行中 flow 先中止）。reply config.oauthLogoutReply。
  | 'config.oauthLogout'
  // wave4：provider 启用切换（写 enabledModels 白名单，reply config.providerUpdated）。替代旧 setProvider({enabled})。
  | 'config.toggleProviderEnabled'
  // wave4：按体系移除 provider（catalog 清凭据/custom 删条目，reply config.providerUpdated）。
  | 'config.removeProviderByKind'
  // scoped model：配置模型白名单 + 有序列表（reply config.scopedModels）。
  | 'config.setScopedModels'
  // backgroundTask 域（docs/architecture/background-task-sidebar-view.md §3.3 D3，u-proto）：后台命令
  // 侧边栏的拉取/操作 RPC——list 拉全量并隐式把 session 加入 runtime watched 集合（D8③）；
  // output 按字节窗口 tail 输出尾部；kill 走 D6 分支矩阵。回执/广播登记见 ServerMessageType。
  | 'backgroundTask.list' | 'backgroundTask.output' | 'backgroundTask.kill'
  // rollingRestart.status（crash-forensics-and-watchdog §3.3 D5，u7b）：滚动重启状态只读查询
  // （无参数；reply 与 request 同名——session.subscribe 模式）。状态机实现在 u7c。
  | 'rollingRestart.status'

// ── Payload 类型定义 ────────────────────────────────────────────

/** quota fetch/getCached/refresh 三 reply 的共享 payload（A2-4）：
 *  data=null 失败态时携带 reason（getCached 为内存中最近一次失败原因，
 *  UI 失败态 + 「查看上次成功数据」入口用，Phase B 渲染）。 */
export interface QuotaFetchResultPayload {
  data: import('./quota-types').NormalizedQuotaRow | null
  lastFetchAt: number | null
  reason?: import('./quota-types').QuotaFetchFailureReason
}

/** config.setProvider 除 providerId 外的透传字段，与 IConfigService.setProvider 参数对齐。
 *  models 元素字段与 runtime ConfigModelDefinition 对齐（含 api/baseUrl/enabled 透传位，
 *  W2/W4 model 级配置不丢字段）。
 *
 *  写入语义（design catalog-provider-field-authority §3.5 D1「setProvider 契约变化」，
 *  协议形状不变、向后兼容，行为变化在 runtime 侧）：
 *  - catalog provider：忽略 `type`（协议是模型级属性，provider 级 api 无用户语义）；
 *    `baseUrl` 非空 = 设置网关（覆盖该 provider 全部模型端点）、显式空串带键 = 清除网关
 *    回退内置、未带键（undefined）= 不变（既有 merge 协议不动）。
 *  - custom 与模型级字段：空串 `name`/`baseUrl`/`apiKey`/`api` 按 pi schema 语义转译——
 *    `apiKey` 空串 = 清除（删键），其余 = 未指定（不写键）；pi 对空串的 minLength:1 校验
 *    会拒绝整个 models.json，故空串不得落盘。
 */
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  /**
   * 认证方式（I6，wave-quick-setup-c）：ProviderQuickSetup.onSave 按所选认证方式填充，
   * runtime 写入 models.json 该 provider 条目旁。兼容旧数据：未设置时按 apiKey 格式推断
   * （$开头→env_var，非空→api_key）。
   */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  baseUrl?: string
  /** 自定义请求头（provider 级，与 ProviderInfo.headers 对齐）。 */
  headers?: Record<string, string>
  /** 是否把 apiKey 写入 Authorization header（与 ProviderInfo.authHeader 对齐）。 */
  authHeader?: boolean
  models?: Array<string | {
    id: string
    name?: string
    api?: string
    baseUrl?: string
    reasoning?: boolean
    input?: Array<'text' | 'image'>
    contextWindow?: number
    maxTokens?: number
    thinkingLevelMap?: Record<string, string | null>
    /** model 级自定义请求头（B-4b 白名单，pi ModelDefinitionSchema 内字段）。 */
    headers?: Record<string, string>
    /**
     * model 级计费（B-4b 白名单，pi ModelDefinitionSchema 内字段）。pi schema 要求
     * input/output/cacheRead/cacheWrite 四字段必填 number，runtime setProvider 校验后落盘。
     * tiers 可选透传（请求级分档定价，最高匹配阈值整单生效）。
     */
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> }
    /** model 级启停（W2）。省略时默认 true，与 PiModelDefinition 同构。 */
    enabled?: boolean
  }>
  enabled?: boolean
}

/** 系统提示词配置（FR-6）。文件：<dataDir>/system-prompt.json。
 *  - replace: 替换 pi 核心系统提示词（走 --system-prompt CLI，**每次进程启动都生效**，含 restore/resume——D1 活定义依据；[HISTORICAL] 早期注释写"仅新建会话生效"与实装不符）
 *  - append:  追加注入（走 before_agent_start hook，每轮读配置热生效）
 *  - capability: taiji capability 固定注入段开关（schema v2 新增，D6）
 *  version: schema 版本号（SR1） */
export interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
  /**
   * 可选 = v1 存量 json 无此字段的常态形态。语义权威在扩展侧解析（消费方是
   * system-prompt 扩展的 before_agent_start hook，直接读原始 json）：缺字段/
   * 形态不对/文件损坏 → 按 enabled true 生效，仅显式布尔 false 关闭——与
   * replace/append 的「缺省 false」方向相反（capability 是 taiji 内置告知，
   * 默认开是设计裁决）。renderer 读侧对 undefined 同样兜底 true。
   */
  capability?: { enabled: boolean }
}

/** 终端配置（Phase 6 settings）。文件：<dataDir>/terminal.json。
 *  - shell: 默认 shell 路径（如 /bin/zsh）；空串则 fallback $SHELL → /bin/bash（win: powershell）
 *  - shellArgs: 传给 shell 的额外参数
 *  - fontSize/fontFamily: xterm 渲染偏好（纯前端，但合并进同一文件便于一次读写）
 *  - scrollback: xterm scrollback 行数上限
 *  - cursorStyle: 光标样式
 *  - bell: 是否响铃
 *  version: schema 版本号
 *  仅对新 spawn 的 PTY 生效（已启动的 PTY 不动态切换 shell）。 */
export interface TerminalConfig {
  version: number
  shell: string
  shellArgs: string[]
  fontSize: number
  fontFamily: string
  scrollback: number
  cursorStyle: 'block' | 'underline' | 'bar'
  bell: boolean
}

/** 终端错误码（TerminalService 主动抛出）。 */
export type TerminalErrorCode =
  | 'spawn_failed'     // pty.spawn 失败（shell 不存在/无执行权限）
  | 'not_found'        // 操作的 sessionId 无对应 PTY
  | 'resize_failed'    // pty.resize 失败
  | 'kill_failed'      // pty.kill 失败
/** handler 对未知错误归一的兜底字面量（非 TerminalService 主动抛出，单列让 renderer switch 可穷尽） */
export type TerminalUnknownErrorCode = 'terminal_failed'
/** envelope code 字段的完整联合（业务码 + 兜底） */
export type TerminalEnvelopeCode = TerminalErrorCode | TerminalUnknownErrorCode

/**
 * folder 维度批量删除结果（session.deleteByCwd 的 reply payload）。
 * 用 `type =` 而非 `interface` —— 与 GitStatusResult 同理：interface 无隐式索引签名，
 * mock 用 `Record<string, unknown>` 接收 reply payload 时会报 TS2345（见 git.ts 注释）。
 */
export type BatchDeleteResult = {
  cwd: string
  deleted: string[]
  failed: Array<{ sessionId: string; error: string }>
}

/**
 * rename-session 触发模式（设计 rename-session-three-modes §3.3 D1）。与 extension 侧
 * extensions/universal/rename-session/src/pure.ts 的 RenameMode 值域同构——跨包不 import，
 * 本处是协议层声明，供 runtime settings 通路（config.get/setRenameMode）与 renderer
 * 模式 Select 共用；默认 first-stop（三处默认值真相：pure.ts DEFAULT_RENAME_CONFIG /
 * package.json startupConfig.content / runtime rename-session-config.ts 镜像）。
 */
export type RenameMode = 'first-prompt' | 'first-stop' | 'agent-tool'

// ── ClientMessage discriminated union ───────────────────────────

/** 每个 type 对应的 payload 类型映射 */
export interface ClientMessageMap {
  'ping': Record<string, never>
  // auth：WS 传输层握手凭据（S1-W1）。token = Electron 主进程 spawn runtime 时生成的
  // 随机 32B hex（renderer 经 preload getRuntimeToken IPC / CLI 经 <dataDir>/runtime-token 文件获取）。
  'auth': { token: string }
  // hidden:true 创建隐藏 session（公共 session），不进 sidebar 列表，仅供内部使用。
  // presetId：session 创建时锁定的 pi 启动预设 id（设计文档 §4.1）。runtime 写入 .preset.json sidecar，
  // restoreSession 据此重建 pi args。可选——省略时 runtime 用默认预设。透传链路见 wave3。
  // modelOverride / thinkingOverride：Landing Model/Thinking Chip 的覆盖值（设计文档 §5.2）。
  // 优先级：Landing Chip override > preset.modelOverride/thinkingLevel > 全局默认。
  //   - modelOverride：模型 ID 字符串（如 'anthropic/claude-sonnet-4'），覆盖 preset.modelOverride
  //   - thinkingOverride：ThinkingLevel 值（= PI_THINKING_LEVELS 全集 7 值，含 'max'），覆盖 preset.thinkingLevel
  // 两者均可选——省略时按 preset 字段或全局默认回退。
  // landing 新建恒传 renderer resolveLaunchConfig 解析终值（D5 契约快照化，非 chip
  // 显式覆盖值）；fork/handoff/agent-managed create 走可选覆盖 + preset/默认 fallback 链。
  'session.create': {
    cwd?: string
    label?: string
    hidden?: boolean
    presetId?: string
    /** 归属 project id（D14 语义修正）：创建时归属当前 activeProject；空 = 默认项目兑底。 */
    projectId?: string
    modelOverride?: string
    thinkingOverride?: ThinkingLevel
  }
  'session.delete': { sessionId: string }
  // session.deleteByCwd：批量删除指定 cwd（folder）下所有 session（folder 维度清理）。
  'session.deleteByCwd': { cwd: string }
  'config.sessions': Record<string, never>
  'session.switch': { sessionId: string }
  'session.restore': { sessionId: string }
  'session.forceQuit': { sessionId: string }
  // session.history 参数（D4 中期分页协议，u6-paging-protocol）：
  // - 不带 cursor：最近窗口（u4b 双预算现状）——「打开/切入 session」与 hydrate 通路。
  // - 带 cursor：游标翻页——cursor = turn 边界锚点 entryId（renderer 当前窗口最早消息的
  //   piEntryId），返回该锚点之前的最近 limitTurns turns（仍受 maxBytes 字节预算、单 turn
  //   原子性、首 turn 豁免语义，同 u4b）；活跃/离线两路径共用同一参数语义。
  // - cursor 指向的消息已不存在（被清理 / 超出预算扫描域）→ 返回空页 + truncated=false
  //   （翻页到头语义，不报错）。
  // limitTurns/maxBytes 缺省回落 HISTORY_BUDGET.RECENT_TURNS / HISTORY_BUDGET.MAX_BYTES。
  'session.history': { sessionId: string; cursor?: string; limitTurns?: number; maxBytes?: number }
  'session.getCommands': { sessionId: string }
  'session.getContext': { sessionId: string }
  // session.getGenStats（D4）：生成指标恢复腿。
  // reply = session.stats_update payload 同形（无任何数据时 speed/cacheRatio 全 null + model 缺省）。
  'session.getGenStats': { sessionId: string }
  'session.getTraceEntries': { sessionId: string }
  'session.fetchCurrentSystemPrompt': { sessionId: string }
  'session.compact': { sessionId: string; customInstructions?: string }
  'session.rename': { sessionId: string; name: string }
  // session.setProject：手动归类（SessionItem「归入项目」菜单）。
  // runtime 写 `<sessionFile>.project.json` sidecar + 刷新列表广播。projectId 空 = 归回默认项目。
  'session.setProject': { sessionId: string; projectId: string }
  // fork：从 srcSessionId 截断到 fromPiEntryId（pi JSONL entry id，前端 Message.piEntryId），
  // includeFrom=true 保留到该 entry（含），false 保留到该 entry 前（不含）。
  // runtime 按 fromPiEntryId 在源 session JSONL 树回溯截断，写新 JSONL，switch_session 加载。
  // fromPiEntryId 缺失（RPC 路径读取的 session 无 piEntryId）时，用 fromMessageTimestamp +
  // fromMessageRole fallback 读 JSONL 按 timestamp 匹配 entryId（HISTORICAL: 2026-07-16）。
  //
  // ⚠️ timestamp fallback 精度风险（W21）：
  // 调用方应优先传 fromPiEntryId 确保精确匹配。一旦走 fromMessageTimestamp fallback，
  // 当 timestamp + role 在容差内仍匹配失败时（session-service.resolveEntryIdByTimestamp），
  // runtime 只 console.warn 后 fallback 取 msgEntries[last]——用户以为 fork 到消息 A，
  // 实际可能 fork 到完全不相关的最近一条。前端在能取到 piEntryId 时务必走 RPC 之外的路径
  // （如 session.history 返回的 message 已填充 piEntryId）以保证 fork 点语义正确。
  'session.fork': {
    srcSessionId: string
    /** pi JSONL entry id（精确匹配，优先使用）。缺失时走 timestamp fallback（见上方风险注释）。 */
    fromPiEntryId?: string
    /** timestamp fallback 匹配键（Unix ms）。匹配失败会静默 fallback 到最近一条 message（非用户期望 fork 点）。 */
    fromMessageTimestamp?: number
    /** timestamp fallback 辅助收窄键（与 timestamp 配对，缩小匹配范围）。失败同样 fallback 到最近一条。 */
    fromMessageRole?: string
    includeFrom?: boolean
    label?: string
    /** Staging Mode（ADR-0056）：composer 暂存的模型覆盖（"provider/modelId" 格式）。
     *  存在时优先于源 session preset 的 modelOverride；不存在时继承源 preset。 */
    modelOverride?: string
    /** Staging Mode：composer 暂存的思考等级覆盖（合法值见 VALID_THINKING_LEVELS）。 */
    thinkingOverride?: string
  }
  // handoff：在源 session 触发 fast-handoff（agent-driven 模式）——runtime HandoffService 让源 session
  // 跑 handoff turn（内置 HANDOFF_PROMPT_TEMPLATE）生成文档 → 从 agent_end 提取 text → 新建 session
  // 由 runtime 注入 doc 触发新 turn。与 fork 的区别：fork 从某点分叉继承历史；handoff 不继承历史，
  // 只注入文档（"打包交接到新线程"）。reply sanitize 后拼到 handoff prompt 末尾告知 agent 下一 session 关注点。
  // 完成经独立通道 session.handoffComplete 广播，reply 是 message.status ack（前端不读 payload）。
  // Staging Mode（ADR-0056）：modelOverride/thinkingOverride 来自 composer 暂存态的模型选择，
  // 用于新 session 创建（源 session turn 仍用源 session 自身模型，不受 override 影响）。
  'session.handoff': {
    sessionId: string
    reply?: string
    modelOverride?: string
    thinkingOverride?: string
  }
  // abortHandoff：中断进行中的 handoff（runtime client.abort + 清 listener/timer/inflight）。
  // onTurnEnd 检测 aborted 标记跳过新建/注入。无进行中 handoff 时 no-op。
  'session.abortHandoff': { sessionId: string }
  // subagent 列表/对话流读取（runtime 直读主 session JSONL + subagent JSONL，不依赖扩展）
  'session.getSubagents': { sessionId: string }
  'session.getSubagentHistory': { sessionId: string; subagentId: string }
  // plan 模式（plan 模式重设计 D1-⑥/D5）：getPlanState 状态首拉，reply 复用 session.planState
  // 广播 payload（同 session.getSubagents → session.subagents 复用形态）；abortPlan 横幅退出命令，
  // reply ack——退出结果经投影链 session.planState 广播推回，失败走 error envelope（E9）。
  'session.getPlanState': { sessionId: string }
  'session.abortPlan': { sessionId: string }
  // [U7] 子代理引擎配置读写（payload：set 带 engineId；get 无参）
  'session.getSubagentEngineConfig': Record<string, never>
  'session.setSubagentDefaultEngine': { engineId: string }
  // workflow 列表/agent call 对话流读取（runtime 直读主 session JSONL + workflow-state JSONL，不依赖扩展）
  'session.getWorkflows': { sessionId: string }
  'session.getAgentCallHistory': { sessionId: string; agentCallSessionId: string }
  'session.getAgentCallFilePath': { sessionId: string; agentCallSessionId: string }
  'session.workflowAction': { sessionId: string; action: 'abort'; runId: string }
  // session.subagentAction：subagent 生命周期/定向消息操作（cancel/message/start，对称 workflowAction
  // 的扩展 slash command 转发）。runtime 经 client.prompt("/subagents <action> ...") 调扩展（不经 LLM）。
  // 字段按 action 取用：cancel 用 subagentId，message 用 subagentId+text，start 用 slug+task
  // （composer 四符号设计 §3.3.4——@ 定向消息直达 subagent，不走主 agent prompt 通道）。
  // text/task 的换行由 runtime encodeDirectiveText 编码为字面 \n、反斜杠编码为 \\（命令保持单行），
  // extension 侧 decodeNewlineEscapes 互逆还原（设计 §3.3.3 / 探针 P3）。
  'session.subagentAction': { sessionId: string; action: 'cancel' | 'message' | 'start'; subagentId?: string; text?: string; slug?: string; task?: string }
  // wave:runtime-patch ipc-converge-a3 W2：业务持久化写 WS 请求 payload（从 main IPC 原样搬，零字段变更）。
  // writeImage：base64 解码后写 attachments（sessionId 空降级 tmpdir，persisted 反映落地位置）。
  // migrateImage：landing 落 tmpdir 的图，session 创建后 move 到 attachments（fromPath 白名单守门）。
  // writeSegments：追加/覆盖 segments.json sidecar（同 clientUuid 覆盖，atomic 写）。
  'session.writeImage': { sessionId: string; base64: string; mimeType: string; name: string }
  'session.migrateImage': { fromPath: string; sessionId: string; fileName: string }
  'session.writeSegments': { sessionId: string; entry: SegmentsMetadataEntry }
  // session.subscribe（runtime-message-bus wave:runtime-wiring 补登记，对应 IF6 契约）：
  // renderer 切换/创建 session 时调用，触发 bus.subscribe 注册订阅 + 拉 ring snapshot。
  // fromSeq 可选：重连场景带 lastSeenSeq，bus 返回 seq > fromSeq 的增量
  // （若 ring 内已淘汰 fromSeq 之前的消息则返回全量 snapshot + reply 标记 gap=true）。
  // reply 'session.subscribe' { snapshot: ServerMessage[]; lastSeq: number; gap?: boolean }。
  'session.subscribe': { sessionId: string; fromSeq?: number }
  // session.unsubscribe（runtime-message-bus wave:runtime-wiring 补登记，对应 IF7 契约）：
  // renderer 切走 session 时调用（可选），触发 bus.unsubscribe 减少不活跃 session 的 live push 开销。
  // 不调也安全——ws 断开时 ConnectionManager.onClose → bus.unsubscribeAll 兜底。
  // reply 'session.unsubscribe' undefined（ack 型，ReplyPayloadMap 已定 void）。
  'session.unsubscribe': { sessionId: string }
  // session.importCandidates / session.import（docs/design/import-session.md（已删除，git 可追溯）§3.3 D5）：
  // 导入 pi 会话两步流：importCandidates 拉候选列表（对话框/搜索/切目录），import 执行导入。
  'session.importCandidates': ImportCandidatesRequest
  'session.import': ImportRequest
  // message.send：images 是 Cmd+V 富呈现通路的图片数据（base64，不含 data: 前缀）。
  // runtime 适配层（rpc-client）补 type:'image' 组装成 pi 的 ImageContent。
  // 不带 type 字段（type 是 pi 私有，runtime 适配层负责补）。
  // clientUuid（session-occupancy-send-closure D2/D5）：客户端生成的幂等 id，runtime 拒绝时在
  // send.rejected 广播原样带回，renderer 据此消歧发送来源（flush 重放的拒绝不重入队）。
  // [HISTORICAL] subagent 可选字段已删除（composer 四符号设计 D2）：曾经的 marker 半成品通道
  // （base64 隐藏注释前缀拼进主 agent prompt，extension 侧零消费方，且经主 agent 转发违背
  // 「直达 subagent」目标）——定向消息改走 session.subagentAction(message/start)。
  'message.send': { sessionId: string; content: string; images?: Array<{ data: string; mimeType: string }>; clientUuid?: string }
  'message.abort': { sessionId: string }
  'message.steer': { sessionId: string; content: string }
  'message.follow_up': { sessionId: string; content: string }
  // message.bash：composer 直接执行 bash 命令（不经 LLM turn）。command 原样透传 pi bash RPC，
  // excludeFromContext 控制是否进 LLM 上下文（pi bash excludeFromContext 参数，透传不转换）。
  'message.bash': { sessionId: string; command: string; excludeFromContext?: boolean }
  // message.abortBash：取消进行中的 bash 执行（调 pi abort_bash）。
  'message.abortBash': { sessionId: string }
  'config.getProviders': Record<string, never>
  // 进入 Settings Provider 页时触发远程模型目录刷新（无参：刷新列表内全部 catalog provider）
  'config.refreshProviderCatalogs': Record<string, never>
  'config.setProvider': { providerId: ProviderId } & SetProviderData
  'config.deleteProvider': { providerId: ProviderId }
  // wave4：provider 启用切换（wave3 RPC 链路在 wave4 补全）。enabled=false 时 runtime 移除白名单 pattern，
  // 若 default 承载该 provider 会重选并广播 config.defaults（见 settings-message-handler）。
  'config.toggleProviderEnabled': { providerId: ProviderId; enabled: boolean }
  // wave4：按体系移除 provider。kind 来自 ProviderInfo.kind（wave2 聚合层标注），catalog 清凭据/custom 删条目。
  'config.removeProviderByKind': { providerId: ProviderId; kind: 'catalog' | 'custom' }
  'config.setToolPermissions': { permissions: Record<string, string> }
  // 模型发现 / 测试连接共享入口（design catalog-provider-field-authority §3.5 D4）。
  // discover 模式：拉 GET /v1/models（baseUrl 必填），只对 custom provider 有意义；
  // test 模式：按模型协议分组发真实最小请求（providerId 必填，baseUrl/apiKey 忽略，
  // 凭据经 runtime 唯一的 provider 凭据解析通道取）。
  'config.discoverModels': {
    baseUrl: string
    apiKey?: string
    providerType?: string
    providerId?: string
    /** 缺省 'discover'，向后兼容旧调用方（runtime CLI 等）。 */
    mode?: 'test' | 'discover'
  }
  // W3 默认模型持久化：前端设置全局默认模型，runtime 调 configService.setDefaultModel 写 settings.json。
  'config.setDefaultModel': { provider: ProviderId; modelId: string }
  'config.scanSkills': { sources: string[] }
  // W2（cw-2026-07-21-scan-project-agents-skills）：按 session cwd 拉 project skill（.agents/skills + .taiji/skills）。
  // 与 config.scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery；scanSessionSkills 扫某 cwd 已生效目录。
  'config.scanSessionSkills': { cwd: string }
  // W4（cw-2026-07-21-fix-ask-user-ime）：landing 全局 skill 走 skillRegistry globalCache（经 RPC），
  // 不走 settingsStore.skills（FR-5：landing 全局 skill 与配置态扫描解耦）。
  'config.getGlobalSkills': Record<string, never>
  // W4：按 cwd 拉项目 skill（skillRegistry projectCache，首次扫描 + watcher，命中缓存零开销）。
  // 与 config.scanSessionSkills 区分：scanSessionSkills 直接调 configService.loadSkills(cwd)（无缓存无 watcher），
  // getProjectSkills 走 skillRegistry（带缓存 + 文件监听，W1 单例）。
  'config.getProjectSkills': { cwd: string }
  'config.setSkill': { skill: SkillInfo }
  'config.deleteSkill': { skillId: string }
  'config.scanAgents': { sources: string[] }
  'config.setAgent': { agent: AgentInfo }
  'config.deleteAgent': { agentId: string }
  /**
   * 目录级管道写入（ADR-0021 §5）：dirs 为有序 SkillDirConfig[]（含 scope），靠前覆盖靠后。写 discovery.json。
   * v2：写入侧带 scope，消费端（skill-dirs.ts）直接读 scope 决定 project/global 归属，不再推断（方案 §2.5 路径 A）。
   */
  'config.setSkillDirs': { dirs: SkillDirConfig[] }
  'config.setAgentDirs': { dirs: SkillDirConfig[] }
  'config.setExtensionDirs': { dirs: SkillDirConfig[] }
  'config.getSystemPrompt': Record<string, never>
  'config.setSystemPrompt': { config: SystemPromptConfig }
  'model.list': Record<string, never>
  'model.switch': { sessionId: string; provider: ProviderId; modelId: string }
  'session.setThinkingLevel': { sessionId: string; level: string }
  'tool.approve': { sessionId: string; toolCallId?: string }
  'tool.deny': { sessionId: string; toolCallId?: string; reason?: string }
  'tool.always_allow': { sessionId: string; toolName?: string }
  'extension.ui_response': { sessionId: string; requestId: string; method: string; result: boolean | string | null }
  'extension.toggle': { name: string; enabled: boolean }
  'extension.list': Record<string, never>
  'extension.install': { source: string }
  'extension.uninstall': { name: string }
  'extension.installDir': { path: string }
  'extension.installGit': { url: string }
  'extension.finishInstall': { tempDir: string; selected: string[] }
  'extension.cancelInstall': { tempDir: string }
  'extension.recommended': Record<string, never>
  'extension.upgrade': { name: string }
  'extension.setAutoUpgrade': { name: string; autoUpgrade: boolean }
  'extension.getPendingRequests': { sessionId: string }
  'plugin.list': Record<string, never>
  'plugin.toggle': { pluginId: string; enabled: boolean; trustLevel?: 'trusted' | 'sandbox' }
  'plugin.install': { packageSpec: string }
  'plugin.uninstall': { pluginId: string }
  'plugin.approvePermissions': { pluginId: string; permissions: string[] }
  'plugin.revokePermissions': { pluginId: string }
  'plugin.executeCommand': { pluginId: string; commandId: string; args?: Record<string, unknown> }
  'plugin.config.get': { pluginId: string; key?: string }
  'plugin.config.set': { pluginId: string; key: string; value: unknown }
  'plugin.uiResponse': { requestId: string; result: unknown }
  'plugin.mountPoints.sync': { mountPoints: string[] }
  'file.read': { path: string; sessionId?: string }
  'file.tree': { sessionId: string }
  'file.tree.expand': { sessionId: string; path: string }
  /** file.search：composer $ 文件候选，全量递归当前 cwd（受 ignore 过滤 + 深度上限 8 + DoS 上限 5000）*/
  'file.search': { sessionId: string; showIgnored?: boolean }
  /** file.search.cwd：landing 态 composer $ 文件候选，按 cwd 全量递归，与 file.search 同约束——ignore 过滤 + 深度上限 8 + DoS 上限 5000 */
  'file.search.cwd': { cwd: string }
  'git.diff': { sessionId: string; path: string }
  'file.write.create': { sessionId: string; path: string; content: string }
  'file.write.rename': { sessionId: string; oldPath: string; newPath: string }
  'file.write.delete': { sessionId: string; path: string }
  'git.status': { sessionId: string }
  'git.stage': { sessionId: string; filePaths?: string[] }
  'git.unstage': { sessionId: string; filePaths?: string[] }
  'git.commit': { sessionId: string; message?: string }
  'git.checkout': { sessionId: string; name: string }
  'git.checkoutCwd': { cwd: string; name: string }
  'git.createBranch': { sessionId: string; name: string }
  'workspace.listRecent': Record<string, never>
  'workspace.record': { cwd: string }
  // project.load / project.save：project 列表持久化（D14，2026-08-04 迁 runtime projects.json，
  // 对齐 recent-workspaces.json 模式；localStorage 仅首启迁移源）。
  'project.load': Record<string, never>
  'project.save': ProjectStoreState
  /** workspace.detectBare：向后兼容别名，等价于 workspace.detect。 */
  'workspace.detectBare': { cwd: string }
  /** workspace.detect：检测 cwd 所在 git 仓库模式（bare-workspace / plain-repo / not-repo）。
   *  返回三态 { mode, wsRoot, barePath, repoRoot, defaultBranch }。
   *  workspace.detectBare 为此接口的向后兼容别名。 */
  'workspace.detect': { cwd: string }
  /** worktree.listBranches：列出 cwd 所在仓库的本地和远程分支。 */
  'worktree.listBranches': { cwd: string }
  /** worktree.list：列出 cwd 所在 workspace 的所有 worktree。 */
  'worktree.list': { cwd: string }
  /** worktree.create：在 bare repo + worktree 结构中创建隔离的工作目录。
   *  branch 必填；baseBranch 默认 'current'（继承当前分支），可为任意分支名（runtime 验证存在性）。
   *  locationMode 控制 worktree 创建位置：'workspace'（workspace 根，bare 模式默认）、
   *  'repo-dir'（.bare 同级 repo 子目录）、'dedicated-dir'（用户指定的专用目录）。
   *  workspaceHint 用于显式指定 workspace 根（检测 .bare 的起点 cwd），省略则用 process.cwd()。 */
  'worktree.create': {
    branch: string
    /** 基础分支。'current' 为特殊值（继承当前分支），其余为具体分支名（runtime 验证存在性）。 */
    baseBranch?: string
    /** worktree 创建位置模式。省略时 bare 模式默认 'workspace'。 */
    locationMode?: 'workspace' | 'repo-dir' | 'dedicated-dir'
    workspaceHint?: string
  }
  // terminal.*：drawer 集成终端的 PTY 控制（Phase 2 runtime service）。
  // spawn 是 lazy 的（首次打开 terminal tab 才调），cwd 省略则用 session.cwd。
  // write 的 data 是原始字节字符串（含 ANSI/控制字符），不带换行则 shell 不提交（联动 2 填命令）。
  'terminal.spawn': { sessionId: string; cwd?: string; cols: number; rows: number }
  'terminal.write': { sessionId: string; data: string }
  'terminal.resize': { sessionId: string; cols: number; rows: number }
  'terminal.kill': { sessionId: string }
  'terminal.attach': { sessionId: string }
  'config.getTerminalConfig': Record<string, never>
  'config.setTerminalConfig': { config: TerminalConfig }
  'config.getRetryConfig': Record<string, never>
  'config.setRetryConfig': { config: LlmRetryConfig }
  // Coding Plan 额度查询
  'quota.fetch': { providerId: string }
  'quota.getCached': { providerId: string }
  /**
   * quota.configure：Coding Plan 额度查询配置。payload 形状 SSOT = QuotaConfigurePayload
   * （quota-types.ts，coding-plan-quota-config-ux §7.1——四处共用单一类型，加字段零改动）。
   * workspace（D1-1）：资源维度 fetcher（opencode）的 workspace 地址——完整 URL 或裸 wrk_ id
   * 均可（runtime 归一化存储）；空字符串 = 清除（恢复未配置态，查询报 not_configured）。
   */
  'quota.configure': QuotaConfigurePayload
  /** 强制刷新额度（绕过 throttle，Settings 测试查询用）。 */
  'quota.refresh': { providerId: string }
  /** usage.getStats：拉取用量统计数据（无参数）。 */
  'usage.getStats': Record<string, never>
  /** config.setWorktreeRootDir：设置 worktree 专用目录配置（前端写入）。 */
  'config.setWorktreeRootDir': { dir: string }
  /** config.getWorktreeRootDir：读取 worktree 专用目录配置（前端读取）。 */
  'config.getWorktreeRootDir': Record<string, never>
  /** config.setSetupScript：设置 worktree 初始化脚本配置（前端写入）。 */
  'config.setSetupScript': { script: string }
  /** config.getSetupScript：读取 worktree 初始化脚本配置（前端读取）。 */
  'config.getSetupScript': Record<string, never>
  /** config.setBareSetupScript：设置 bare-workspace 初始化脚本配置（前端写入）。 */
  'config.setBareSetupScript': { script: string }
  /** config.getBareSetupScript：读取 bare-workspace 初始化脚本配置（前端读取）。 */
  'config.getBareSetupScript': Record<string, never>
  /** config.setTimeout：设置 worktree 创建超时时间（秒，前端写入）。 */
  'config.setTimeout': { timeout: number }
  /** config.getTimeout：读取 worktree 创建超时时间配置（前端读取）。 */
  'config.getTimeout': Record<string, never>
  /** config.setDefaultBaseBranch：设置默认基分支（前端写入）。 */
  'config.setDefaultBaseBranch': { baseBranch: string }
  /** config.getDefaultBaseBranch：读取默认基分支配置（前端读取）。 */
  'config.getDefaultBaseBranch': Record<string, never>
  /** config.setAutoRenameEnabled：设置 session 自动重命名开关（前端写入）。 */
  'config.setAutoRenameEnabled': { enabled: boolean }
  /** config.getAutoRenameEnabled：读取 session 自动重命名开关配置（前端读取）。 */
  'config.getAutoRenameEnabled': Record<string, never>
  /** config.setRenameModel：设置自动重命名标题生成模型（"provider/modelId"，空串 = 未设置）。 */
  'config.setRenameModel': { model: string }
  /** config.getRenameModel：读取自动重命名标题生成模型（前端读取）。 */
  'config.getRenameModel': Record<string, never>
  /** config.setRenameMode：设置自动重命名触发模式（非法值由 runtime 侧归一为默认 first-stop）。 */
  'config.setRenameMode': { mode: RenameMode }
  /** config.getRenameMode：读取自动重命名触发模式（前端读取）。 */
  'config.getRenameMode': Record<string, never>
  /** config.getSmartContextConfig：读取智能上下文压缩配置（前端读取）。 */
  'config.getSmartContextConfig': Record<string, never>
  /** config.setSmartContextEnabled：设置智能上下文压缩开关（前端写入）。 */
  'config.setSmartContextEnabled': { enabled: boolean }
  /** config.setSmartContextCompactModel：设置压缩模型（"provider/modelId" 复合串，空串 = 跟随当前会话模型）。 */
  'config.setSmartContextCompactModel': { model: string }
  /** config.setSmartContextThresholds：设置 3 档提醒阈值（token 绝对数，runtime 侧 clamp 升序 3 档）。 */
  'config.setSmartContextThresholds': { thresholds: number[] }
  /** config.setSmartContextExcludedModels：设置排除模型列表（每条完整 provider/modelId，runtime 侧过滤去重）。 */
  'config.setSmartContextExcludedModels': { models: string[] }
  // pi 启动预设域（设计文档 pi-launch-presets.md）。
  // preset.list：列出全部预设（内置 + 自定义）；preset.getDefault：读全局默认预设 id；
  // preset.setDefault：设全局默认预设（写入 pi-presets.json）。均按需 RPC，无 server-push 广播。
  'preset.list': Record<string, never>
  'preset.getDefault': Record<string, never>
  'preset.setDefault': { presetId: string }
  // preset CRUD（本 slice 新增）：preset.create 创建自定义预设；preset.update 更新预设（含内置预设用户编辑）；
  // preset.delete 删除自定义预设（内置不可删，runtime PresetGuardError 拦截）。
  'preset.create': { preset: PiLaunchPreset }
  'preset.update': { preset: PiLaunchPreset }
  'preset.delete': { presetId: string }
  // FR-14：预设使用统计（session 创建时 runtime 调 recordUsage，前端调 getUsage 拉排序数据）
  'preset.recordUsage': { presetId: string }
  'preset.getUsage': Record<string, never>
  // FR-13：预设导入/导出（前端传 JSON 字符串，runtime 解析/生成）。
  // json 是 `JSON.stringify(PresetExportPayload)` 的结果——只含 presets/defaultPresetId/version
  // 三字段，故意排除 usage（runtime 本地状态，不随预设分享）。
  // 见 pi-preset.ts 的 PresetExportPayload 类型。
  'preset.export': Record<string, never>
  'preset.import': { json: string }
  /** config.detectSources：检测本机其他 agent 的 skill/agent 配置目录（无参数，只读检测）。 */
  'config.detectSources': Record<string, never>
  /** config.listBuiltinProviders：列出内置 provider 模板（wave 2，无参只读，import generated JSON）。 */
  'config.listBuiltinProviders': Record<string, never>
  /**
   * config.previewImportProviders：Step1 预览从其他 agent 源导入的 provider 列表（脱敏，apiKey 不进前端）。
   * source 是迁移源（pi/zcode/codex/claude）。
   */
  'config.previewImportProviders': { source: ProviderSource }
  /**
   * config.applyImportProviders：Step2 应用导入（写 models.json）。
   * importId 来自 Step1 preview 的 reply；selectedIds 是用户勾选的 provider id 列表。
   */
  'config.applyImportProviders': { importId: string; selectedIds: string[] }
  /** config.oauthLogin：启动 OAuth flow（device/callback，按 provider 的 oauthConfig）。reply config.oauthLoginReply。 */
  'config.oauthLogin': { providerId: string }
  /** config.checkEnvVars：批量检测环境变量是否已设置。reply config.envVarsChecked。 */
  'config.checkEnvVars': { names: string[] }
  /** config.oauthCancel：中止进行中的 OAuth flow（停轮询/关 server/清 state）。reply config.oauthCancelReply。 */
  'config.oauthCancel': { providerId: string }
  /** config.hasOAuth：查询 auth.json 是否已有该 provider 的 oauth 凭据（只返回布尔）。reply config.hasOAuthReply。 */
  'config.hasOAuth': { providerId: string }
  /** config.oauthLogout：移除 auth.json 中该 provider 的凭证（退出登录，幂等）。reply config.oauthLogoutReply。 */
  'config.oauthLogout': { providerId: string }
  // ── scoped model ──
  'config.setScopedModels': { models: string[] }
  // ── backgroundTask 域（docs/architecture/background-task-sidebar-view.md §3.3 D3，u-proto）──
  // list：拉取该 session 后台任务全量（runtime 直读 registry 的投影；目录/文件不存在 → 空数组）。
  // 首次调用同时把 session 加入 runtime watched 集合（D8③）——订阅语义由 list 隐含，协议面无
  // subscribe/unsubscribe 消息（D3 被否项）；watched 退订挂 session 销毁汇聚点（runtime 侧职责）。
  'backgroundTask.list': { sessionId: string }
  // output：读任务输出尾部（字节窗口，从文件末尾读；maxBytes 省略时 runtime 用默认 32KB 上界，
  // 对齐 bash_output 的 tail 语义，D7；超出 1MB 的请求值被 runtime clamp 到 1MB——D6 #1/BG-4）。
  'backgroundTask.output': { sessionId: string; taskId: string; maxBytes?: number }
  // kill：终止任务（D6 分支矩阵；reason 回执语义见 BackgroundTaskKillReason）。
  'backgroundTask.kill': { sessionId: string; taskId: string }
  // rollingRestart.status（crash-forensics-and-watchdog §3.3 D5，u7b）：只读查询，无参数
  //（全局状态，非 session 级）。reply 见 ServerMessageMap['rollingRestart.status']。
  'rollingRestart.status': Record<string, never>
}

// ClientMessage 由 ClientMessageMap 直接派生：每个 type 字面量映射到
// { type: K; id?: string; payload: ClientMessageMap[K] }。此前是一份 ~70 行手写
// discriminated union，与 ClientMessageMap 逐条重复——加新 type 要改两处且易漂移。
// 映射派生后 ClientMessageMap 成为唯一真值源；消费侧的 Extract<ClientMessage, { type: 'X' }>
// 收窄与 switch narrowing 行为完全一致。
export type ClientMessage = {
  [K in keyof ClientMessageMap]: { type: K; id?: string; payload: ClientMessageMap[K] }
}[keyof ClientMessageMap]

// ── Runtime → Client message types ──────────────────────────────

/**
 * config.defaults 广播的来源标签（仅 broadcast 携带，reply 不带）。
 * 收紧为联合类型：新增来源时编译器强制在此登记，避免 runtime 散落未约束的字面量。
 */
export type DefaultModelSource =
  | 'provider-updated' // setProvider 后 fallback 修正了默认模型
  | 'provider-deleted' // deleteProvider 后 fallback 修正了默认模型
  | 'default-set'      // config.setDefaultModel 主动设置
  | 'model-switch'     // model.switch 时持久化全局默认模型

/**
 * WorktreeService 抛出的业务错误码（runtime ↔ renderer 契约 SSOT）。
 *
 * runtime WorktreeService.create 抛 `Object.assign(new Error(msg), { code, detail })` 扁平错误，
 * WorktreeMessageHandler.sendWorktreeError 把 code 透传到 error envelope 的 code 字段。
 * renderer CreateWorktreeModal / useConnection 按 code 分流：
 * - WORKTREE_EXISTS → modal 转 exists 态（detail 是已存在 cwd 字符串）
 * - SETUP_FAILED / GIT_FAILED / INVALID_BRANCH / NOT_BARE_REPO → modal 转 error 态（detail 是 {exitCode,stderr} 或无）
 * - 兜底字面量 'worktree_failed'（handler 对未知错误归一，不在 WorktreeService 主动抛出）
 *
 * 新增错误码必须在此登记，编译器强制两端同步（防止 runtime 改码 renderer switch 静默失效）。
 */
export type WorktreeErrorCode =
  | 'NOT_GIT_REPO'      // cwd 不在 git 仓库内（git rev-parse 失败）
  | 'NOT_BARE_REPO'     // 当前 cwd 非 .bare workspace（WorkspaceDetector 未命中）
  | 'WORKTREE_EXISTS'   // 目标 worktree 目录已存在（detail: string = 已存在 cwd）
  | 'SETUP_FAILED'      // .bare/custom-hooks/setup-worktree.sh 失败（detail: {exitCode, stderr}）
  | 'GIT_FAILED'        // git worktree add 失败（detail: {exitCode, stderr}）
  | 'INVALID_BRANCH'    // 分支名非法（INVALID_BRANCH_REGEX 拦截，含路径遍历防护）
/** handler 对未知错误归一的兜底字面量（非 WorktreeService 主动抛出，单列让 renderer switch 可穷尽） */
export type WorktreeUnknownErrorCode = 'worktree_failed'
/** envelope code 字段的完整联合（业务码 + 兜底） */
export type WorktreeEnvelopeCode = WorktreeErrorCode | WorktreeUnknownErrorCode

export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.deletedByCwd' | 'config.sessions' | 'session.history' | 'session.switched'
  | 'session.compacting' | 'session.compacted' | 'session.renamed' | 'session.forkNotice' | 'session.skillNotice' | 'session.handoffStarted' | 'session.handoffComplete' | 'session.handoffAborted' | 'session.setProject'
  // session.occupancy（session-occupancy-send-closure P3）：占用三维快照广播（state topic，
  // last-value 语义——重连/切回 session 自动恢复，不依赖广播时序），renderer sessionPhase 唯一数据源。
  | 'session.occupancy'
  | 'project.loaded'
  | 'session.subagents' | 'session.subagentHistory'
  // plan 模式状态投影广播（plan 模式重设计 D1）：stateSnapshot 'plan' typeKey 的 live 载体帧
  //（last-value 语义——重连/切回经 stateSnapshot 回放自动恢复）；冷启动/切换首拉走
  // session.getPlanState RPC，reply 复用本 payload。
  | 'session.planState'
  // [U7] 子代理引擎配置（Settings 引擎选择器；形状 = @zhushanwen/extension-protocol SubagentEngineConfigView，契约 SSOT 在彼处）
  | 'session.subagentEngineConfig' | 'session.subagentDefaultEngineSet'
  // E 方案（subagent-realtime-channel §4.3）：runtime relay tee 产出的 subagent entry 增量帧
  | 'session.subagentEntriesAppended'
  | 'session.workflows' | 'session.agentCallHistory' | 'session.agentCallFilePath'
  | 'session.workflowUpdate' | 'session.workflowActionDone' | 'session.subagentActionDone'
  // session-trace（design D4）：getTraceEntries 的 reply（全量台账）+ 增量腿推送（since 增量 entries）。
  | 'session.traceEntries' | 'session.traceEntryAppended'
  // session-trace（design §3.1 失败路径）：现取当前 system prompt 的 reply（当前值非历史）。
  | 'session.currentSystemPrompt'
  | 'subagent.stream_delta' | 'subagent.directive'
  | 'message.message_start' | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end'
  | 'message.tool_call_start' | 'message.tool_call_end'
  | 'message.bashStart' | 'message.bashResult'
  | 'message.complete' | 'message.error' | 'message.status'
  | 'context.update'
  // composer-gen-stats（D4）：生成指标帧——双发送点同形：
  // ① turn-usage 采样后扩展广播（对该模型全部已知 session 逐 sid 发帧）；② session.getGenStats
  // RPC 的 reply（恢复腿）。payload 形状 SSOT = gen-stats.ts；无值一律 null（null=无数据，
  // 0=真实测量值），与 context.update 的无值编码纪律同源。
  | 'session.stats_update'
  | 'config.providers' | 'config.providerUpdated' | 'config.discoveredModels' | 'config.defaults'
  | 'config.providerCatalogsRefreshed'
  | 'config.scopedModels'
  | 'config.scannedSkills' | 'config.skillUpdated' | 'config.skillDeleted'
  | 'config.sessionSkills'
  | 'config.globalSkills' | 'config.projectSkills'
  | 'config.scannedAgents' | 'config.agentUpdated' | 'config.agentDeleted'
  | 'config.skills' | 'config.agents'
  | 'config.skillDirs' | 'config.agentDirs' | 'config.extensionDirs'
  | 'config.skillCacheInvalidated'
  | 'config.systemPrompt'
  | 'model.list' | 'model.switched'
  // model:capabilityDrift：能力注册表在线对账漂移上报（U6，pi-boundary-reliability D2 ②）。
  // 全局诊断通道（无 sessionId 路由需求，消费方=设置页/composer 档位显示的自省入口）。
  | 'model:capabilityDrift'
  | 'session.thinkingLevelSet'
  | 'session.state_changed'
  // wave:runtime-wiring：session.subscribe 的 RPC reply type（payload 消费型，含 snapshot/lastSeq/gap）。
  // 与 ClientMessageType 的 'session.subscribe'（request）同名——request/reply 同名是本项目惯用模式
  //（见 session.compact→session.compacted 等多数用不同名，但 session.subscribe 因其「订阅」语义
  // request 与 reply 同名更直观：renderer register<{snapshot,lastSeq,gap}> 按 id resolve）。
  // session.unsubscribe 的 reply 走 message.status（ack 型，见 ReplyPayloadMap :1192 注释），不在此登记。
  | 'session.subscribe'
  // auth.result：auth 握手的结果回复（S1-W1，ConnectionManager 传输层生产，见 ClientMessageMap 'auth'）。
  | 'auth.result'
  | 'pong' | 'error'
  | 'extension.ui_request' | 'extension.error'
  | 'extension.discovered' | 'extension.installCancelled'
  | 'extension.recommended'
  | 'extension.pendingRequests'
  | 'message.tool_call_update' | 'config.extensions'
  // w21 data-source-governance：message_end 重构 entry 的实时 feed 载体帧（见 ServerMessageMapBase 条目注释）
  | 'message.message_end'
  | 'session.commands'
  // session.importCandidates / session.import（docs/design/import-session.md（已删除，git 可追溯）§3.3 D5）：reply 与 request
  // 同名（session.subscribe 模式，sendCommand 按 id resolve），payload 见 ServerMessageMapBase。
  | 'session.importCandidates' | 'session.import'
  | 'session.exited'
  // D7（u8-pi-respawn）：pi 崩溃自动恢复结果推送（payload 见
  // ServerMessageMapBase 两行注释）。
  | 'session.restored' | 'session.restoreFailed'
  | 'app.info'
  | 'config.plugins' | 'plugin:crashed' | 'plugin:notification'
  | 'plugin:statusChange' | 'plugin:permissionRequest'
  | 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
  | 'plugin:statusSetUpdate'
  | 'plugin:uiRequest'
  // plugin:uiRequestExpired：plugin dialog 到期取消下行（timeout-plugin-service D2，
  // runtime UiRequestQueue cancelRequest / 防泄漏兜底生产）。广播无条件发出（含排队中
  // 从未展示的请求）；前端对未展示/已关闭弹窗的撤窗 miss 须 noop 幂等。
  | 'plugin:uiRequestExpired'
  // plugin:permissionRequestExpired：权限审批到期取消下行（timeout-plugin-service D3，
  // runtime PluginActivator 审批等待超时生产——取消非判拒：插件置 UNLOADED 且可经
  // 重触发 activation event 重新激活 + 重新弹审批）。前端收到后撤回该插件的审批弹窗；
  // 迟到批准对已删 pending noop 幂等（旧版前端未消费此帧时无异常回退，P-11）。
  | 'plugin:permissionRequestExpired'
  | 'plugin:viewUpdate'
  | 'extension:widget' | 'extension:widgetGui' | 'extension:status' | 'extension:notify'
  | 'extension:setEditorText'
  | 'message.compactionSummary' | 'message.branchSummary'
  | 'message.auto_retry_start' | 'message.auto_retry_end' | 'message.queue_update'
  | 'message.stream_error'
  | 'message.stream_warn'
  | 'send.rejected'
  | 'message.file_changes'
  | 'message.changeSetInvalidated'
  | 'message.customStart'
  | 'file.read:result'
  | 'file.tree:result' | 'file.tree.expand:result' | 'file.search:result' | 'file.search.cwd:result'
  | 'git.diff:result'
  | 'file.write.create:result' | 'file.write.rename:result' | 'file.write.delete:result'
  // wave:runtime-patch ipc-converge-a3 W2：业务持久化写 reply（:result 后缀复用 file.write.create:result 约定）
  | 'session.writeImage:result' | 'session.migrateImage:result' | 'session.writeSegments:result'
  | 'git.status:result'
  | 'workspace.recentList'
  | 'workspace.bareDetected'
  | 'workspace.detected'
  | 'worktree.created'
  | 'terminal.data' | 'terminal.exit' | 'terminal.alive' | 'terminal.ack'
  | 'config.terminalConfig'
  | 'config.retryConfig'
  | 'quota.fetch:result' | 'quota.getCached:result' | 'quota.configure:result' | 'quota.refresh:result'
  | 'usage.getStats:result'
  | 'worktree.branches'
  | 'worktree.list:result'
  | 'config.worktreeRootDir'
  | 'config.setupScript'
  | 'config.bareSetupScript'
  | 'config.worktreeTimeout'
  | 'config.defaultBaseBranch'
  | 'config.autoRenameEnabled'
  | 'config.renameModel'
  | 'config.renameMode'
  | 'config.smartContextConfig'
  | 'config.smartContextEnabled'
  | 'config.smartContextCompactModel'
  | 'config.smartContextThresholds'
  | 'config.smartContextExcludedModels'
  | 'preset.list' | 'preset.getDefault' | 'preset.setDefault'
  | 'preset.create' | 'preset.update' | 'preset.delete'
  | 'preset.recordUsage' | 'preset.getUsage'
  | 'preset.export' | 'preset.import'
  | 'config.sourcesDetected'
  // wave 2：listBuiltinProviders reply（内置 provider 模板数组）。
  | 'config.builtinProviders'
  // 迁移 W2：Provider 导入 reply（preview 脱敏 / apply 结果含 imported/skipped/failed 三态）。
  | 'config.providersPreviewed' | 'config.providersImported'
  // OAuth Login 事件（路径 B，slice design I4）：payload 必带 providerId（前端按 providerId 路由，支持并发多 provider）。
  // token 永不出现在事件 payload（脱敏红线）。
  | 'auth.deviceCode' | 'auth.authUrl' | 'auth.success' | 'auth.error'
  // OAuth Login RPC reply（config.oauthLogin/oauthCancel 的回复，消费型）。
  | 'config.oauthLoginReply' | 'config.oauthCancelReply'
  // OAuth 凭据查询 reply（MF-1）。
  | 'config.hasOAuthReply'
  // OAuth 退出登录 reply（B-1 场景 C：ok 布尔 + 错误原因）。
  | 'config.oauthLogoutReply'
  // 环境变量检测 reply（I3）。
  | 'config.envVarsChecked'
  // backgroundTask 域（docs/architecture/background-task-sidebar-view.md §3.3 D3，u-proto）：3 个 RPC 回执
  // + session 级变更广播。backgroundTask:updated 用冒号 camelCase（Server→Client 推送命名规则，
  // 对齐 plugin:statusBarUpdate / extension:widgetGui），payload 单对象必带 sessionId（架构规则 7），
  // 经 IMessageBus.publish(sessionId, msg) session 级定向推。
  | 'backgroundTask.tasks' | 'backgroundTask.outputResult' | 'backgroundTask.killResult'
  | 'backgroundTask:updated'
  // rollingRestart 域（crash-forensics-and-watchdog §3.3 D5，u7b 协议面）：status = 只读查询
  // reply（与 request 同名）；deferred / forced = 全局推送事件（Server→Client 冒号
  // camelCase，对齐 backgroundTask:updated 规则；与台账 event 值同源）；countdown =
  // 执行前 T-30s 二次预告（D5 ③，u7c 补缺——推迟期内新开终端的知情窗口）。
  | 'rollingRestart.status' | 'rollingRestart:deferred' | 'rollingRestart:countdown' | 'rollingRestart:forced'
  // watchdog 域（crash-forensics-and-watchdog §3.3 D4，u6）：memoryPressure = 内存压力
  // 全局推送（Server→Client 冒号 camelCase，对齐 rollingRestart:deferred 规则；越线期每
  // 采样拍重发，payload 见 WatchdogMemoryPressurePayload）。
  | 'watchdog:memoryPressure'
  // reattach 域（crash-forensics-and-watchdog §3.3 D3 高水位延迟，偏差 #27）：deferred =
  // 启动 reattach 高水位延迟推送（Server→Client 冒号 camelCase；进入单发 + 缓解退出单发，
  // payload 见 ReattachDeferredPayload）。
  | 'reattach:deferred'

/** skill 缓存失效广播的作用域：global=全局 skill 变动，project=某项目 cwd 的 skill 变动。 */
export type SkillCacheScope = 'global' | 'project'

/**
 * 能力注册表对账漂移项（'model:capabilityDrift' 的 drifts 元素形状，U6）。
 * 三类（与 runtime model-capability.ts CapabilityDrift 同构）：
 * - config_only：配置有而 pi 合并清单无全等命中（且无大小写孪生）；
 * - reasoning_mismatch：全等命中但 reasoning 归一值不一致（config 缺失按 false 归一）；
 * - case_twin：pi 无全等 id 但存在仅大小写不同的条目（pi pattern 引擎静默换模形态）。
 */
export type ModelCapabilityDriftItem =
  | { kind: 'config_only'; providerId: string; modelId: string }
  | { kind: 'reasoning_mismatch'; providerId: string; modelId: string; configReasoning?: boolean; piReasoning: boolean }
  | { kind: 'case_twin'; providerId: string; modelId: string; piModelId: string }

// ── session-trace payload 辅助类型（design D4，trace-runtime 单元）──
// 字段镜像 core domain/session-trace 的 TraceSessionHeader / TraceSessionEndMeta——shared 不依赖
// core（依赖方向 core → shared），结构兼容即协议兼容；消费端（renderer）直接收窄为 core 类型。

/** session.traceEntries 的 header（JSONL 首行 type=session 的完整 entry）。parentSession 两形态
 *  （源 session 已落盘时为文件路径、未落盘时为源 sessionId fallback）原样透传。 */
export interface SessionTraceHeaderPayload {
  version?: number
  id?: string
  timestamp?: string
  cwd?: string
  parentSession?: string
  forkEntryId?: string
  [key: string]: unknown
}

/** 损坏 JSONL 行占位（文件直读路径；行号 1-based，raw 为原文）。 */
export interface SessionTraceMalformedLine {
  lineNumber: number
  raw: string
}

/** sidecar `.jsonl.meta.json` 的 session_end 终态（ADR 0042；不进 JSONL）。 */
export interface SessionTraceSessionEndPayload {
  outcome: 'done' | 'error' | 'stopped'
  reason?: string
  timestamp?: string
}

/** config.skillCacheInvalidated 消息的 payload。scope='project' 时 cwd 携带变更的项目根；
 *  setSkillDirs 改全局配置触发的 project 广播 cwd 仍缺省（影响所有 cwd，非单个 cwd 变更）。 */
export interface SkillCacheInvalidatedPayload {
  scope: SkillCacheScope
  /** scope='project' 时携带变更的项目根；setSkillDirs 全局配置变更场景缺省（影响所有 cwd）。 */
  cwd?: string
}

// ── backgroundTask 域 payload 辅助类型（docs/architecture/background-task-sidebar-view.md §3.3 D3/D9，u-proto）──
// shared 不依赖 @zhushanwen/extension-protocol（SubagentEngineConfigView / SessionTraceHeaderPayload
// 同先例：契约 SSOT 在彼处，shared 侧放结构镜像，结构兼容即协议兼容）。任务条目逐字段镜像
// extension-protocol background-task.ts 的 BackgroundTaskRegistryEntry（D9 数据契约零新造——
// 字段名/枚举/可选性禁止单侧改名）；镜像 ⇔ 契约的逐字段全等由 core transport api domain
//（packages/core/src/transport/api/domains/background-task.ts）的 BackgroundTaskMirrorEqualsContract
// 编译期守卫，漂移即 tsc 红。

/** 任务状态机（镜像 extension-protocol BackgroundTaskState）：running → killing（intent 瞬态）→
 *  exited；orphaned 由 runtime 收殓侧写入。 */
export type BackgroundTaskState = 'running' | 'killing' | 'exited' | 'orphaned'

/** 终态 reason 枚举（仅 exited 语义；orphaned 保持缺省。镜像 extension-protocol BackgroundTaskEndReason）。 */
export type BackgroundTaskEndReason = 'natural' | 'timeout' | 'killed' | 'process-exit'

/** registry.json 持久化条目的 WS 协议镜像（逐字段同构 extension-protocol BackgroundTaskRegistryEntry，
 *  契约 SSOT 在彼处，D9 禁止另造 DTO）。 */
export interface BackgroundTaskRegistryEntry {
  /** 任务 id（registry 表内唯一键；`bt-` 前缀）。 */
  taskId: string
  /** 任务进程 pid（判活/补杀目标）。 */
  pid: number
  /** 原始命令全文。 */
  command: string
  /** stdout/stderr 重定向输出文件路径。 */
  outputFile: string
  /** 任务登记时刻（epoch 毫秒）。 */
  startedAt: number
  /** 状态机（见 BackgroundTaskState）。 */
  state: BackgroundTaskState
  /** 属主 pi 进程 pid（孤儿判定依据）。 */
  ownerPiPid: number
  /** 发起 session（registry 目录归属）。 */
  sessionId: string
  /** 进程退出码（被 signal 终止时为 null；条目未终态时字段缺省）。 */
  exitCode?: number | null
  /** 终态成因（仅 exited 语义；orphaned 保持缺省）。 */
  reason?: BackgroundTaskEndReason
  /** 终态时刻（epoch 毫秒）。 */
  endedAt?: number
  /** 存活时长 = endedAt - startedAt（毫秒）。 */
  durationMs?: number
  /** exit 边沿组装的输出尾部摘要。 */
  tailSummary?: string
  /** 任务进程 start time（epoch 秒；防 pid 复用误判，缺省走 startedAt 降级校验）。 */
  pidStartTime?: number
}

/**
 * backgroundTask.kill 回执的 reason 枚举（D6 kill 分支矩阵的操作结果语义；注意与
 * BackgroundTaskEndReason 分工——后者是 registry 条目的持久化终态成因，本枚举是 kill
 * 操作回执的结果）。
 */
export type BackgroundTaskKillReason =
  | 'killed'                 // 分支①：发令成功（killing 预写 + killProcessTree；终态由 extension poller 边沿写）
  | 'already-exited'         // 分支③：任务已退出，无副作用
  | 'identity-unverifiable'  // 分支④：进程身份无法验证，拒绝终止（宁不杀勿误杀，可重试）
  | 'registry-write-failed'  // 分支⑤：锁内 registry 写失败，操作未生效（可重试）

/**
 * session.skillNotice 的事件种类（composer-multi-skill-injection §3.3 D6/D8，u5 呈现面据此
 * 区分文案——两种降级 reason 的文案必须可区分，见设计场景 2b②）：
 * - budget_exceeded：预检估算 > 0.8 × contextWindow，整条降级为标记模式（D6）
 * - context_window_unavailable：get_session_stats 失败/无效，fail-safe 降级为标记模式（D6）
 * - skill_missing：name 在 get_commands 无映射（已卸载/未装），标记原样透传（D8）
 * - skill_read_failed：SKILL.md 读取失败（权限/损坏/映射缺 sourceInfo.path），标记原样透传（D8）
 * - marker_malformed：`<taiji-skill/>` 标记被 BeforeSend hook 改写破坏至不可解析，残缺部分透传（D8/D9）
 * - mapping_unavailable：get_commands RPC 整体失败，全部标记透传（映射服务不可用，降级块
 *   依赖映射提供的 location 无从构建，故不走降级路径；契约要求「至少可区分」四类，此为第五类）
 */
export type SkillNoticeReason =
  | 'budget_exceeded'
  | 'context_window_unavailable'
  | 'skill_missing'
  | 'skill_read_failed'
  | 'marker_malformed'
  | 'mapping_unavailable'

// ── 滚动重启协议面（crash-forensics-and-watchdog §3.3 D5，u7b 契约）────────────
//
// 三块：① rollingRestart.status 只读查询 RPC（状态机实现在 u7c，本处只钉类型契约；
// renderer 重连/刷新后主动拉取恢复横幅——「broadcast 时序竞争」教训：需立即消费的持续
// 状态必须可拉取，T-30s 广播只作加速显示）；② rollingRestart:deferred / rollingRestart:forced
// 两个 WS 推送事件（Server→Client 冒号 camelCase，对齐 backgroundTask:updated 命名规则；
// 与台账 event=rolling-restart-deferred / rolling-restart-forced 同源）。

/** 滚动重启状态机相位（D5 ③ 执行链）。 */
export type RollingRestartState =
  | 'idle'       // 无滚动重启（常态；重启完成后清除，故重连拉取到 idle 即「横幅不重现」）
  | 'deferred'   // 检测到在途（或计数未知）→ 推迟等待中
  | 'countdown'  // 推迟结束，执行前 30s 二次预告中
  | 'rolling'    // 正在执行滚动重启（完整 shutdown 序）

/**
 * 滚动重启成因 / 事件 reason 值域（D5 ②/④）：
 * - 'inflight'：有在途任务 → 推迟（正常形态）
 * - 'absent-report'：已注入但从未收到上报（旧版 extension 组合）→ errs 推迟；
 *   在途计数字段取 null 独立标记（0 = 在场且无在途的已证事实，null = 计数未知）
 * - 'hard-threshold'：双维硬升级（runtime heap ≥92% 或 memPressure 越限）→ 立即执行
 * - 'defer-limit'：30min 推迟上限到点 → 强制执行（不含 absent-report 形态——errs 推迟必然
 *   走到上限，其 defer-limit 在评估器 #8 占比子句分子中被排除）
 */
export type RollingRestartReason = 'inflight' | 'absent-report' | 'hard-threshold' | 'defer-limit'

/**
 * 滚动重启的在途摘要（D5 ④ 字段语义钉死）：镜像在途计数合计。
 * null = 计数未知（errs 形态，配 reason='absent-report'）；0 = 在场且无在途的已证事实。
 */
export interface RollingRestartInflightSummary {
  inFlight: number | null
}

/** rollingRestart:deferred —— 推迟开始推送（D5 ②；台账 event=rolling-restart-deferred 同源）。 */
export interface RollingRestartDeferredPayload {
  reason: 'inflight' | 'absent-report'
  inflight: RollingRestartInflightSummary
  /** 30min 推迟上限到点时刻（ms epoch）——横幅「等待有界」的数据源。 */
  deferDeadlineAt: number
}

/** rollingRestart:forced —— 强制升级执行推送（D5 ②；台账 event=rolling-restart-forced 同源）。 */
export interface RollingRestartForcedPayload {
  reason: 'hard-threshold' | 'defer-limit'
  inflight: RollingRestartInflightSummary
}

/**
 * rollingRestart:countdown —— 执行前 T-30s 二次预告推送（D5 ③，u7c 生产）：
 * 覆盖「推迟期内新开终端」的知情窗口（T0 横幅只覆盖预告时刻的终端集合）；
 * forced（硬升级/到点）路径立即执行，不发本预告（红牌即执行）。
 */
export interface RollingRestartCountdownPayload {
  /** 预计执行时刻（ms epoch）——横幅倒计时数据源。 */
  executesAt: number
  inflight: RollingRestartInflightSummary
}

/** rollingRestart.status 的 reply：状态机相位 + 成因 + 在途摘要（state='idle' 时 reason 缺省）。 */
export interface RollingRestartStatusPayload {
  state: RollingRestartState
  reason?: RollingRestartReason
  inflight: RollingRestartInflightSummary
  /** deferred/countdown 态的推迟上限到点时刻（ms epoch）；其余态缺省。 */
  deferDeadlineAt?: number
}

// ── reattach 域（crash-forensics-and-watchdog §3.3 D3 高水位延迟，偏差 #27）────
//
// reattach:deferred = 启动 reattach 高水位延迟的全局推送（Server→Client 冒号 camelCase，
// 对齐 rollingRestart:deferred 命名规则；无 sessionId——窗口级全局态，非 session 级消息，
// 不受「session 级消息必带 sessionId」约束）。生产方 = startup-reattach 高水位轮询循环
// （u5 交付，#27 补广播半腿：进入单发 + 缓解退出单发——广播形态选择见
// ReattachDeferredPayload 注释）；消费方 = renderer useRollingRestartStatus（reattach
// 延迟横幅腿，与滚动重启横幅共用窗口级容器——两种延迟态时域不相交：reattach 延迟只在
// runtime 启动后短窗口，滚动重启推迟只在运行期，互斥不冲突）。无只读拉取 RPC（D3 高
// 水位延迟是启动期瞬态，非持续态；滚动重启的「持续态必须可拉取」教训按状态生命周期
// 区分适用）。

/**
 * reattach 高水位延迟原因（D3：崩溃本身由内存高压诱发时，集中 spawn 会诱发二次崩溃——
 * 「恢复→再崩→退避」循环的缓解；当前唯一成因 = 系统级 memPressure 越限，开放枚举预留）。
 */
export type ReattachDeferReason = 'high-memory'

/**
 * reattach:deferred 的 payload。active=true 进入延迟 / active=false 压力缓解恢复执行。
 *
 * **广播形态裁决（单次进入 + 单次退出，非延迟中每拍重发）**：每拍重发对「窗口内重连」
 * 自愈更快，但缓解退出帧两种形态都是单发——重连错过退出帧的陈旧态残留窗口等价，重发
 * 只增冗余帧；且 reattach 延迟只存在于启动后短窗口（收割等待 + 高水位轮询），无只读
 * 拉取面（协议面仅本事件）。残余窗口 = 「进入帧后断连、退出帧也错过后重连」的低概率
 * 组合，接受并登记。
 *
 * **预计恢复语义**：高压复查周期 pollMs 随帧携带——恢复无总上限（D3：高压持续则逐拍
 * 复查至缓解；总时长不可预估），横幅文案据此不承诺恢复时刻；手动 lazy 恢复恒可用。
 */
export interface ReattachDeferredPayload {
  /** true = 进入延迟（高压，reattach spawn 暂停）；false = 压力缓解，恢复执行。 */
  active: boolean
  /** 延迟成因（当前唯一 'high-memory'）。 */
  reason: ReattachDeferReason
  /** 高压复查周期 ms（生产方 DEFAULT_HIGH_WATER_POLL_MS，缺省 30s——逐拍复查至缓解）。 */
  pollMs: number
}

// ── 看门狗协议面（crash-forensics-and-watchdog §3.3 D4，u6）────────────────
//
// watchdog:memoryPressure = 内存压力全局推送（Server→Client 冒号 camelCase，对齐
// rollingRestart:deferred 命名规则；无 sessionId——窗口级全局态，非 session 级消息，
// 不受「session 级消息必带 sessionId」约束）。生产方 = runtime 看门狗采样环（u6），
// 消费方 = renderer useMemoryPressure composable（memory-relief 降级的 renderer 半边：
// 收到 warn 及以上 → 收紧 renderer 侧 LRU 缓存）。

/**
 * 看门狗内存压力级别（D4 两级阈值）。'normal' 不广播（renderer 缺省态即 normal，
 * 压力解除的回落不产生帧——消费方回落感知走下一帧缺失 + 本地常态假设）。
 */
export type WatchdogMemoryLevel = 'warn' | 'critical'

/** watchdog:memoryPressure 的 payload：当前用量 + 阈值 + 动作级别（越线期每采样拍重发——
 *  广播重发作低配拉取，renderer 重连/刷新后最多丢一个采样周期即补上）。 */
export interface WatchdogMemoryPressurePayload {
  /** 动作级别：warn = memory-relief 档；critical = 滚动重启决策档（D5，u7c 消费）。 */
  level: WatchdogMemoryLevel
  /** 当前 heap used（bytes，process.memoryUsage().heapUsed）。 */
  heapUsed: number
  /** heap 上限（bytes，v8.getHeapStatistics().heap_size_limit）。 */
  heapSizeLimit: number
  /** 当前用量占上限百分比（0-100，两位精度由生产方预舍入）。 */
  usedPercent: number
  /** 告警档阈值（%，默认 70，env 可覆盖——阈值面随帧携带使 renderer 无需同步配置）。 */
  warnPercent: number
  /** 临界档阈值（%，默认 85，env 可覆盖）。 */
  criticalPercent: number
}

/**
 * # ServerMessageMap —— Runtime → Client payload 类型映射
 *
 * 与 ClientMessageMap 对称：每个 ServerMessageType 对应的 payload 类型。
 * 消费侧（renderer events.onGlobalType / events.on）handler 内 payload 自动收窄，
 * 不再需要 `as ProviderInfo[]` 等断言。
 *
 * 收录原则：
 * - **已消费 + 已契约化**的类型 → 精确 payload（domain 订阅 + sendInitialState 推送的 7 条）。
 * - **未消费 / 协议待定**的类型 → `Record<string, unknown>`（占位，待对应 wave 实装时收紧：
 *   message.* 进 W05-W07，plugin:* / extension:* widget 等属后续 wave）。
 *
 * 收紧某条目时，runtime 构造点会同步得契约校验（若 payload 字段对不上，tsc 报错——这是 D5 的预期收益）。
 */
// ── Mutation reply 具名类型（C-pi-14 / ADR-0065）──────────────────
//
// mutation 类 RPC（改状态值且 renderer 有 store 副本）的 reply 统一提取具名
// `XxxMutationReply` interface，生效值/回显字段**类型必需、不 optional**（编译期强制）。
// 乐观/回执两分支裁决标准与新 mutation 接入检查单见 docs/adr/decisions.md（ADR-0065 条目）；
// 清单守卫（新增 mutation 不入 MUTATION_RPC_REGISTRY 即测试红）在
// packages/runtime/src/__tests__/mutation-reply-contract.test.ts。
//
// 分支一（后端可变换请求值——pi 钳制/pattern 换模，reply 生效值是显示态唯一合法来源）：

/** model.switch 的 reply（model.switched）：provider/modelId 是 pi 实际生效模型（runtime
 *  set→get_state 读回拆解；pattern 引擎静默换模时 ≠ 请求值）。消费侧禁乐观写请求值。 */
export interface ModelSwitchMutationReply {
  sessionId: string
  provider: string
  modelId: string
}

/** session.setThinkingLevel 的 reply（session.thinkingLevelSet）：level 是 pi 实际生效档
 *  （pi 钳制不支持的档位时 ≠ 请求值，如 mimo 族 max→high）。消费侧禁乐观写请求值。 */
export interface ThinkingLevelMutationReply {
  sessionId: string
  level: string
}

// 分支二（后端原样存储——runtime 自有数据，reply 回显落盘态；允许乐观写 + reply 权威覆盖 + 失败回滚）：

/** preset.create / preset.update 的 reply：回显保存后的预设（原样存储，请求值即生效值；
 *  内置预设保护字段的规范化差异由消费方 preset.list 重拉兜底——ADR-0065 已知近似）。 */
export interface PresetMutationReply {
  preset: PiLaunchPreset
}

/** session.setSubagentDefaultEngine 的 reply：写 config.json 后的确认回显。 */
export interface SubagentDefaultEngineMutationReply {
  engineId: string
}

/** session.rename 的 reply：回显请求名（原样存储）。本类型同时是广播帧形状（broadcastSessionList）。 */
export interface SessionRenameMutationReply {
  sessionId: string
  name: string
}

/** session.setProject 的 reply：回显归入的 projectId（原样存储）。同 session.renamed 模式。 */
export interface SessionSetProjectMutationReply {
  sessionId: string
  projectId: string
}

/**
 * 计划产物文档元数据（plan 模式重设计 D1）。
 * 与 @zhushanwen/extension-protocol core/types 的 PlanDocMeta 同形——shared 是最底层
 * 共享包不能反向依赖 extension-protocol，同形状漂移由双端契约测试守卫。
 */
export interface PlanDocMeta {
  /** 文件名（drawer 文档 tab 标题，不含目录） */
  fileName: string
  /** 文件绝对路径（前端 file.read RPC 带 sessionId 读取） */
  absPath: string
  /** 来源技能名（挂载 --skills 时产出该文档的技能；模板流程产出时为空串） */
  sourceSkill: string
  /** 修订版本，从 1 起，每次修订重登记 +1（前端凭 version 变化重拉 file.read） */
  version: number
}

/**
 * plan 模式状态视图——session JSONL 内最后一条 plan-state entry 的派生投影（D1）。
 *
 * 四个必填字段是 entry schema v1 原有字段；三个 optional 字段是 schema 扩展
 * （D4 向后兼容契约）：旧 entry 无新字段，前端逐字段判存在降级显示
 * （skills 缺 → 横幅显示「（未指定）」；docs 缺 → 产物区显示 planFilePath 单文件）。
 * optional 性是兼容契约，禁改必填（契约测试断言守卫）。
 * reviewState 无值 = 进行中（三步阶段推导：① 激活无文档 / ② 激活有文档无审阅态 /
 * ③ awaiting|revising——阶段指示由推导承载，不落盘，ext-simplify-06 D6 延续）。
 */
export interface PlanStateView {
  isActive: boolean
  planFilePath: string | null
  requirement: string | null
  templateName: string | null
  /** 挂载技能名清单（/plan <需求> --skills a,b 解析结果） */
  skills?: string[]
  /** 产物文档清单（产物 tab 由 docs.length 驱动，与 isActive 解耦——退出/执行后仍可回看） */
  docs?: PlanDocMeta[]
  /** awaiting = 文档就绪等审批；revising = 修订中；无值 = 进行中 */
  reviewState?: 'awaiting' | 'revising'
}

export interface ServerMessageMapBase {
  // ── sendInitialState 推送 / domain 订阅（精确）──
  'config.providers': { providers: ProviderInfo[]; scopedModels?: string[] }
  // refreshed = 远程目录协商完成的 provider（304/404 也算完成）；failed 携带原因
  'config.providerCatalogsRefreshed': { refreshed: string[]; failed: Array<{ providerId: string; reason: string }> }
  'config.skills': { skills: SkillInfo[] }
  /**
   * skill 缓存失效信号（landing useGlobalSkills/useProjectSkills 失效缓存重拉）。
   * 与 config.skills 区分：config.skills 推全量列表给 settingsStore；本 type 推失效信号给 landing composable。
   * scope='global' 时 cwd 缺省（所有 panel 刷全局）；scope='project' 时 cwd 携带变更的项目根（前端按 cwd 路由）。
   * setSkillDirs 改全局配置触发的 project 广播 cwd 仍缺省（影响所有 cwd，非单个 cwd 变更）。
   */
  'config.skillCacheInvalidated': SkillCacheInvalidatedPayload
  'config.agents': { agents: AgentInfo[] }
  /** discovery.json 加载路径广播（ADR-0021 §1，目录级管道配置） */
  'config.skillDirs': { dirs: SkillDirConfig[] }
  'config.agentDirs': { dirs: SkillDirConfig[] }
  'config.extensionDirs': { dirs: SkillDirConfig[] }
  'config.defaults': {
    defaultModel: string
    /** 默认模型变更来源，仅 broadcast 携带（reply 不带）。reply/broadcast 共用此类型，故 source 为 optional。 */
    source?: DefaultModelSource
  }
  /** config.setScopedModels 的 reply（去重保序后的白名单；scoped-model design §4.1 A9）。 */
  'config.scopedModels': { scopedModels: string[] }
  'config.extensions': { extensions: ExtensionInfo[]; upgradeResult?: { upgraded: boolean; from: string; to: string } }
  /** extension.recommended reply：推荐扩展列表（含已安装状态） */
  'extension.recommended': { recommended: Array<RecommendedExtension & { installed: boolean }> }
  'config.plugins': { plugins: PluginInfo[] }
  // plugin:config：plugin.config.get / plugin.config.set 的 reply（plugin-message-handler.ts:56/61
  // reply { pluginId, config }）。config 是该插件全量配置对象（get 不带 key 时）或单 key 子树。
  // 用 Record<string, unknown> 保持 shared 依赖最小化（与 extension:widgetGui.gui:unknown 同先例）。
  'plugin:config': { pluginId: string; config: Record<string, unknown> }
  // plugin:viewUpdate：plugin views.update 下行广播（plugin-rpc-setup.ts handleViewUpdate 生产，
  // 带 sessionId 走 session 通道 + crossSession 声明条目分发到 ExtensionHost）。
  // guiTree 用 unknown[] 保持 shared 包依赖最小化（与 extension:widgetGui 的 gui:unknown 同先例），
  // 消费端（core MessageBusBridge parseViewUpdate → ViewHostStore）用 isGuiComponent 守卫收窄。
  'plugin:viewUpdate': {
    sessionId: string
    viewId: string
    pluginId: string
    guiTree: unknown[]
    updatedAt: number
  }
  // plugin:uiRequest：plugin dialog 交互请求下行（runtime UiRequestQueue 广播回调生产，
  // payload 注入当前活跃 sessionId 后经 bus.publish 定向发布，无活跃 session 时回退全局广播）。
  // requestId 必带（前端 message-bus-bridge.parseUiRequest 缺失即丢弃整条）；method/title 等
  // dialog 字段（select/confirm/input 及各自扩展字段）由 plugin 侧透传，用索引签名保持形状开放
  //（消费端 parseUiRequest 对 method 超界兜底 'input'，未知字段原样保留），与 runtime
  // UiBroadcastFn 的 Record<string, unknown> 同形。
  'plugin:uiRequest': { requestId: string; sessionId?: string } & Record<string, unknown>
  // plugin:uiRequestExpired：plugin dialog 到期取消下行（timeout-plugin-service D2，
  // runtime UiRequestQueue cancelRequest / 防泄漏兜底两路径共用此帧）。与 plugin:uiRequest
  // 契约形态一致（requestId 必带 + 索引签名透传 dialog 字段）；pluginId 必带（前端按插件
  // 定位撤窗）。广播无条件发出（含排队中从未展示的请求——前端对未展示/已关闭弹窗的撤窗
  // miss 须 noop 幂等，P-11：旧版前端未消费此帧时无异常回退）。
  'plugin:uiRequestExpired': { requestId: string; pluginId: string; sessionId?: string } & Record<string, unknown>
  // plugin:permissionRequestExpired：权限审批到期取消下行（timeout-plugin-service D3，
  // runtime PluginActivator 审批等待超时生产）。pluginId 必带（前端按插件定位撤窗）。
  // 与 D2 的 plugin:uiRequestExpired 同为「取消非替答」语义——插件置 UNLOADED（未装载
  // 态）而非「被拒」，重触发 activation event 即可重新激活 + 重新弹审批；前端撤窗
  // miss noop 幂等（P-11：旧版前端未消费此帧时无异常回退）。
  'plugin:permissionRequestExpired': { pluginId: string } & Record<string, unknown>
  'model.list': { models: ModelInfo[] }
  // model:capabilityDrift：runtime 能力注册表在线对账（reconcileModelCapabilities）发现
  // 配置聚合与 pi 合并清单漂移时经 setCapabilityDriftSink 广播（drift 项已同步记 runtime
  // 日志，本帧供前端后续消费——U6 先接通上报通道）。drifts 形状与 runtime
  // model-capability.ts CapabilityDrift 结构兼容（shared 不依赖 runtime，结构同构即协议兼容，
  // 与 SessionTraceHeaderPayload 先例同款）。
  'model:capabilityDrift': { drifts: ModelCapabilityDriftItem[] }
  'config.sessions': { groups: SessionGroup[] }
  /** config.systemPrompt：reply + broadcast + 初始推送三用。corrupted=true 表示磁盘配置损坏已回退默认（SR5）。 */
  'config.systemPrompt': { config: SystemPromptConfig; corrupted?: boolean }

  // ── 协议级 reply / push（精确）──
  'pong': Record<string, never>
  // auth.result：WS auth 握手结果（S1-W1）。ok=false 时 reason 描述拒绝原因
  // （bad_token / no_token_configured），客户端据此提示。握手失败连接随后被 close 1008。
  'auth.result': { ok: boolean; reason?: string }
  'error': { code: string; message: string; sessionId?: string; details?: Record<string, unknown> }
  // 流式异步推送失败（server-push 通道，区别于请求级 error envelope；见错误契约文档）
  'message.error': { sessionId: string; message: string }
  // message.stream_error：流式真错误（pi 异常 / 流终止）。前端收到后 finalizeSession 收口。
  // content 为人类可读原因（前端 chat-message-effects 读 readString(payload,'content')）。
  'message.stream_error': { sessionId: string; content: string; kind?: string }
  // message.stream_warn：pi 静默卡死 WARN（120s 无活动，提示性，不中断流）。
  // 与 stream_error 物理隔离——前端仅追加提示文案，不调 finalizeSession，session 保持 streaming 态。
  // B1（PR#86 review）：原先 WARN 复用 stream_error{kind:'silent'}，前端无条件收口破坏「不中断」设计。
  'message.stream_warn': { sessionId: string; content: string }
  // send.rejected：runtime 预检拦截（busy 时发送），防御性反馈通道（D-006）。
  // 语义：操作拒绝，区别于 message.error（流终止）。不进对话流，不翻流式态。
  // useChat 收到后回滚 pendingSend + toast。
  // reason（session-occupancy-send-closure D2）：'busy' = runtime 预检（generating/bash 忙，存量）；
  // 'compacting' | 'processing' = pi 侧拒绝经 runtime 转译——前者 manual 压缩中（pi 抛
  // "Cannot submit a prompt while compaction is in progress"），后者 auto 压缩 / post-run settling
  // 窗口（pi 抛 "Agent is already processing"）。renderer 按 reason 分型兜底入队（'busy' 兼容存量）。
  // clientUuid：renderer 发送时经 message.send RPC 透传的客户端幂等 id，拒绝广播原样带回——
  // 兜底 handler 见 uuid 命中 defer 队列已有条目即跳过重入队（flush 来源消歧，防双条目双投递）。
  'send.rejected': { sessionId: string; reason: 'busy' | 'compacting' | 'processing'; message: string; clientUuid?: string }
  // session.exited：pi 进程异常退出（区别于 message.error 的「单次消息失败」）。
  // 前端 routeInbound 收到后标记 session 为 dead 态 + 插入 error 消息 + toast。
  // reason: 人类可读的错误原因（含 stderr 尾部截断），供诊断面板展开显示。
  // code: pi 进程退出码（null 表示进程被信号杀死无退出码）。
  'session.exited': { sessionId: string; code: number | null; reason: string }
  // session.restored / session.restoreFailed（D7，u8-pi-respawn）：
  // pi 非主动退出后的自动恢复结果推送（恢复编排点 = ProcessManager onSessionExit 链 →
  // pi-respawn.ts 编排；5s 延迟 + 连续 2 次失败熔断）。两者只在「非主动退出触发的自动
  // 恢复」链路产生——用户手动强制退出（forceQuitSession，不经 onSessionExit）与惰性
  // 恢复（ensureActive）都不推。
  // session.restored：自动恢复成功。前端在对话流插入恢复提示条（T4 文案：在途回合未保留、
  // 后台任务/子代理已终止不自动恢复、可继续发消息），并恢复 session dead 态标记。
  'session.restored': { sessionId: string; attempts: number }
  // session.restoreFailed：一次自动恢复尝试失败。willRetry=false（连续失败达熔断阈值）
  // 时前端把提示条切换为失败态（「引擎恢复失败，点此重试或新建会话」+ 手动重试按钮）；
  // willRetry=true 仅落 runtime 日志（前端不渲染中间失败，避免闪烁）。
  // reason: 人类可读失败原因（含 cwd 死路径附着的 MissingSessionCwdError 场景，P-restore-skip 分支二）。
  'session.restoreFailed': { sessionId: string; attempts: number; willRetry: boolean; reason: string }
  // 扩展 UI 推送通道（EventAdapter 翻译 pi setWidget/setStatus，runtime 固定形状生产）
  'extension:widget': { sessionId: string; widgetKey: string; lines: string[] }
  // 结构化 widget（GuiComponent 经 NUL marker 编码透传，event-adapter 检测 marker 解码）
  'extension:widgetGui': { sessionId: string; widgetKey: string; gui: unknown }
  'extension:status': { sessionId: string; statusKey: string; text: string; textRaw?: string }
  // extension notify（pi fire-and-forget 通知，前端渲染为 toast）
  'extension:notify': { sessionId: string; message: string; level: 'info' | 'warn' | 'error' }
  // extension.ui_request：交互对话框请求（select/confirm/input/editor + ask-user 富交互）。
  // ask-user 扩展字段（askUser/askUserQuestions/allowCancel）仅在 method='select' + askUser=true 时存在。
  // askUserQuestions 用 unknown[] 保持 shared 包依赖最小化（与 extension:widgetGui 的 gui:unknown 先例一致），
  // 前端消费时用类型守卫收窄为 AskUserQuestion[]。
  // schedule-create 扩展字段（scheduleCreate/scheduleDraft）仅在 method='select' + scheduleCreate=true 时存在
  // （runtime event-adapter 第 4 marker 分支翻译 SCHEDULE_CREATE_MARKER select，U5）；
  // scheduleDraft 用 unknown 保持 shared 依赖最小化，前端用 extension-protocol 的 isScheduleDraft 守卫收窄。
  'extension.ui_request': {
    sessionId: string
    requestId: string
    method: ExtensionInteractMethod
    title?: string
    message?: string
    options?: string[]
    default?: string
    level?: 'info' | 'warn' | 'error'
    prefill?: string
    // ask-user 富交互扩展（仅 method='select' + askUser=true 时存在）
    askUser?: boolean
    askUserQuestions?: unknown[]
    allowCancel?: boolean
    // schedule 创建确认富交互扩展（仅 method='select' + scheduleCreate=true 时存在）
    scheduleCreate?: boolean
    scheduleDraft?: unknown  // ScheduleDraft（@zhushanwen/extension-protocol），前端守卫收窄
    // planReview 审批扩展（仅 method='select' + planReview=true 时存在；plan 模式重设计 D5：
    // PLAN_REVIEW_MARKER select 通道，前端 C4 分流给 PlanReviewBar 不落 CompanionBand）。
    // planReviewDocs 用 unknown[] 保持 shared 依赖最小化（与 askUserQuestions 同款先例），
    // 前端消费时收窄为 PlanDocMeta[]。
    planReview?: boolean
    planReviewDocs?: unknown[]
    // 统一提问表单扩展（仅 method='select' + form=true 时存在；ui-presentation-protocol D1：
    // UI_FORM_MARKER select 通道，前端 C4 分流给 FormOverlay 渲染类型化问题集）。
    // formQuestions 用 unknown[] 保持 shared 依赖最小化（与 askUserQuestions 同款先例），
    // 前端消费时用 extension-protocol 的 isFormQuestion 守卫收窄为 FormQuestion[]。
    form?: true
    formQuestions?: unknown[]
  }
  // session 通道推送（runtime session-service / index.ts 生产，W04 收紧）
  // compacting：compaction_start → interpreter 广播（唯一发送点 event-interpreter.handleCompactionStart），
  // status/reason 以 runtime 实发为准（R1 type-safety S4 补登记）：reason 透传 pi compaction_start 的
  // PiCompactionReason，驱动前端 compacting 浮层文案区分手动/自动。
  'session.compacting': { sessionId: string; status: 'compacting'; reason: 'manual' | 'threshold' | 'overflow' }
  'session.compacted': { sessionId: string; status: 'compacted'; error?: string }
  // session.occupancy（session-occupancy-send-closure D3/P3）：占用三维结构快照，state topic
  // （message-bus 分配 seq + 写 last-value 快照、不入 ring——重连/切回 session 经 stateSnapshot
  // 回放自动恢复）。turn 三阶段：dispatching = prompt 已发、message_start 未到；
  // generating = turn-start..turn-end；settling = turn-end..agent-settled（pi post-run 收尾期）。
  // 三维独立（compacting/bash 与 turn 各阶段可并存：settling+compacting 是 overflow 收尾常态，
  // threshold 模式 turn 内自动压缩则 generating+compacting）。session.compacting/compacted 事件
  // 保留（浮层 reason 文案源），isCompacting 改由本消息派生。
  'session.occupancy': { sessionId: string; turn: 'idle' | 'dispatching' | 'generating' | 'settling'; compacting: boolean; bash: boolean }
  // session.subscribe（wave:runtime-wiring）：session.subscribe RPC 的 reply payload（IF6 契约）。
  // snapshot：订阅时刻 bus ring 内当前事件序列（元素为带 seq 的 ServerMessage），renderer 据此 reconcile。
  // stateSnapshot：6 个 state topic（commands/context/subagents/workflows/state_changed/occupancy）
  //   的 last-value 数组拷贝（wave:remove-bandaids 新增，后补 state_changed/occupancy 两键）。
  //   让 renderer subscribe 后一次性把 commands/context/subagents 的
  //   当前状态灌入对应 store（dispatch 到 events 通道 → routeInbound 兜底分支 applyRecords），
  //   替代 selectSession/submitFirstMessage 内的主动拉取 RPC 兜底。stateSnapshot 与 snapshot 独立：
  //   snapshot 受 subscribe RPC 的 fromSeq 增量过滤影响，stateSnapshot 是 last-value 语义不受影响。
  // lastSeq：当前 per-session seq 计数器值，renderer 记为 lastSeenSeq 做 gap 检测基线。
  // gap：fromSeq 早于 ring 最旧 seq（旧消息已被 FIFO 淘汰）时 true，renderer 需全量重拉而非增量 backfill。
  'session.subscribe': { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }
  // session.commands：pi 扩展命令列表（fetchAndBroadcastCommands 广播）
  // sourceInfo 透传自 pi get_commands 的 RpcSlashCommand（SKILL.md / extension 文件路径等），可选（旧消费方向后兼容）
  'session.commands': { sessionId: string; commands: Array<{ name: string; description?: string; source: string; sourceInfo?: CommandSourceInfo }> }
  // session.importCandidates / session.import reply（docs/design/import-session.md（已删除，git 可追溯）§3.3 D5）：
  // 与 ClientMessageMap 同名 request 一一对应；失败走 error envelope（code 见 ImportErrorCode）。
  'session.importCandidates': ImportCandidatesReply
  'session.import': ImportReply
  // session.subagents：当前 session 派生的 subagent 列表（runtime 从主 session JSONL 提取）
  'session.subagents': { sessionId: string; subagents: SubagentRecord[] }
  // session.planState：plan 模式状态投影（runtime 读 session JSONL 最后一条 plan-state entry
  // 派生，冷热两路径共用同一份派生代码）。live 腿 = 投影链 stateSnapshot('plan') 广播；
  // 冷腿 = session.getPlanState RPC reply 复用本 payload。docs 缺省 = 旧 schema entry（D4 降级）。
  'session.planState': { sessionId: string; planState: PlanStateView }
  // session.subagentHistory：subagent 对话流消息（runtime 直读 subagent JSONL，复用 convertPiHistory）。
  // truncated：u4b（D5①）巨型 subagent JSONL（高发源）超预检阈值后逆序窗口降级标志
  //（optional——mock / 旧 runtime 不带此键，消费方按 false 处理）。
  'session.subagentHistory': { sessionId: string; subagentId: string; messages: import('./message').Message[]; truncated?: boolean }
  // [U7] getSubagentEngineConfig 的 reply（engines = extension engines.json 动态清单；形状与 extension-protocol 契约一致）
  'session.subagentEngineConfig': { engines: string[]; defaultEngine: string }
  // [U7] setSubagentDefaultEngine 的 reply（写 config.json 后确认；新 session 生效）。
  // [C-pi-14/ADR-0065] mutation reply（分支二原样存储）：engineId 回显必需。
  'session.subagentDefaultEngineSet': SubagentDefaultEngineMutationReply
  // session.subagentEntriesAppended（E 方案，subagent-realtime-channel §4.3/§6）：runtime relay
  // tee 翻译层产出的 subagent entry 增量帧——子进程 stdout 事件经 event-adapter 独立实例
  // 翻译 + entry 化（与主对话流 message.message_end / tool_call_* 帧的 entry 形态同构，
  // 但路由到虚拟分区）。sessionId 是主 session id（bus 路由键 + 帧归属），subagentId 是
  // record id（虚拟分区第三段，subagentVirtualId(sessionId, subagentId)）。entries 元素：
  // message/自定义 entry（PiEntry，前端喂 applyEntry）与 toolCall overlay 形态
  // （PiToolCallEntryForm，前端挂 running toolCall，同 message.tool_call_start 载体）。
  // 帧间可能交错 stream_delta（中间态），reducer 按 entry 幂等去重（entry 帧是终态权威）。
  'session.subagentEntriesAppended': {
    sessionId: string
    subagentId: string
    entries: Array<import('./pi-entry').PiEntry | import('./pi-entry').PiToolCallEntryForm>
  }
  // session.workflows：当前 session 派生的 workflow 列表（runtime 从主 session JSONL 的 workflow-state-link 提取）
  'session.workflows': { sessionId: string; workflows: WorkflowRunRecord[] }
  // session.agentCallHistory：workflow 内 agent call 的对话流消息（runtime 按 trace[].sessionId 查找 JSONL）。
  // truncated：u4b（D5①）巨型 JSONL 超预检阈值后逆序窗口降级标志（optional，消费方按 false 处理）。
  'session.agentCallHistory': { sessionId: string; agentCallSessionId: string; messages: import('./message').Message[]; truncated?: boolean }
  // session.agentCallFilePath：agent call 对话流 JSONL 绝对路径（PanelHeader overlay 文件名展示用，找不到为空串）
  'session.agentCallFilePath': { sessionId: string; agentCallSessionId: string; filePath: string }
  // session.workflowUpdate：workflow 状态变化增量信号（event-interpreter 推送，发起/结束时刻）。
  // 前端收到后调 loadWorkflows RPC 拉取完整列表。与 session.workflows（RPC reply 全量列表）区分。
  'session.workflowUpdate': { sessionId: string; update: { runId: string; status: string; reason?: string } }
  // ── session-trace（design D4 数据通路 A1，trace-runtime 单元）──
  // session.traceEntries：session.getTraceEntries 的 reply。source 区分数据通路：
  //   rpc = 活跃 session（pi get_entries 权威解析 + 文件首行补 header）；
  //   file = 非活跃/降级（JSONL 直读 + sidecar 合并）；
  //   empty = session 未落盘（pi 延迟写入窗口，规则 6——空态标记，前端显示「尚未落盘」）；
  //   oversize = 文件超 runtime 读取预检阈值（D5④，u4c）——entries 恒空、
  //     oversizeMessage 提供降级文案（体积 + 源文件绝对路径），不与 empty 混淆。
  // header 是 JSONL 首行 type=session 的完整 entry（字段镜像 core TraceSessionHeader——
  // shared 不依赖 core，结构兼容即协议兼容；parentSession 两形态（源文件路径/源 sessionId
  // fallback）原样透传，溯源解析归消费端）。entries 是 pi entry JSON 逐条（消费端按 core
  // TraceSessionEntry 收窄）；malformed 两路径均产出（文件解析提取坏行行号与原文——RPC 路径
  // pi get_entries 静默跳坏行，由 runtime 补文件解析占位，G1 损坏行不静默丢失）。
  'session.traceEntries': {
    sessionId: string
    source: 'rpc' | 'file' | 'empty' | 'oversize'
    /** session JSONL 绝对路径（reveal 按钮数据源——MALFORMED 行「打开所在目录」经 Electron
     *  shell.showItemInFolder 定位；empty 未落盘/路径未知时缺省）。 */
    filePath?: string | null
    header?: SessionTraceHeaderPayload
    entries: unknown[]
    malformed: SessionTraceMalformedLine[]
    sessionEnd?: SessionTraceSessionEndPayload
    /** 当前叶子 entry id（RPC 路径；增量腿 since 基准）。文件路径无 leaf 概念，缺省。 */
    leafId?: string | null
    /** D5④ oversize 降级文案（source='oversize' 时提供：「Trace 过大无法渲染（XX MB），源文件：<绝对路径>」）。 */
    oversizeMessage?: string
  }
  // session.traceEntryAppended：增量腿推送（event-interpreter 触发事件 → get_entries(since=lastLeafId)
  // 拉取后的 delta entries；lifecycle RPC 成功后 runtime 主动补拉同走此通道）。entries 为空时
  // 不推送（触发事件到达但无新 entry）。消费端按 entry.id 去重追加。
  'session.traceEntryAppended': {
    sessionId: string
    entries: unknown[]
    leafId: string | null
  }
  // session.currentSystemPrompt：session.fetchCurrentSystemPrompt 的 reply。当前时刻
  // 的 system prompt 全文（常驻扩展现取，非留痕历史——留痕归 taiji:system-prompt entry）。
  // fetchedAt 是扩展取值时刻（ISO），charCount 与 fullText 一致。
  'session.currentSystemPrompt': {
    sessionId: string
    fullText: string
    charCount: number
    fetchedAt: string
  }
  // session.workflowActionDone：workflow 操作完成确认（session.workflowAction RPC reply）
  'session.workflowActionDone': { sessionId: string; action: 'abort'; runId: string }
  // session.subagentActionDone：subagent 操作完成确认（session.subagentAction RPC reply）。
  // 字段按 action 回显目标标识：cancel/message 回 subagentId，start 回 slug（text/task 不回显——
  // ack 型 payload，回显长文本无消费方）。
  'session.subagentActionDone': { sessionId: string; action: 'cancel' | 'message' | 'start'; subagentId?: string; slug?: string }
  // subagent.stream_delta：running subagent 的逐字 streaming（路径 A-1）。
  // pi 扩展层合并 text_delta 后经 ctx.ui.setWidget("subagent-stream-<recordId>", lines) 转发，
  // runtime EventAdapter 捕获后转为此 WS 帧。lines 是累积全文（split('\n')），undefined = 终态清除。
  'subagent.stream_delta': { sessionId: string; recordId: string; lines: string[] | undefined }
  // subagent.directive：用户定向消息的 live 广播（@ subagent chip 发送 → extension 留痕
  // custom_message entry → pi message_end{role:'custom'} → 本广播，设计 §3.3.3a live 链路）。
  // 带 sessionId（架构约定 #7 session 隔离）；renderer（U2b）聊天流据此插定向气泡
  // （「→ @slug：text」特殊样式，非 user/assistant 气泡）。reload 链路（mapSessionEntries
  // 对该 customType 覆写 display:true）产出同字段的 custom system message，字段解析 SSOT =
  // shared.parseSubagentDirective（live ≡ reload，关键规则 9）。
  'subagent.directive': { sessionId: string; subagentId: string; slug: string; direction: 'user'; text: string }
  // app.info：runtime 启动时推送应用 + pi 版本号（全局通道，无 sessionId）。
  'app.info': { appVersion: string; piVersion: string }
  // context.update：上下文用量（index.ts onContextUpdate 推；cacheHit/modelId 无来源，D9 保留 UI 占位）。
  // usage 三字段 optional：字段缺失 = 无值（pi tokens=null，compact 后无新 turn / 新 session 未跑 turn；
  // pi 源码锚点见 context-consistency-design「系统是什么」§1：extensions/types.ts:289 + rpc-mode.ts:591）。
  // [HISTORICAL] D1 协议收敛（context-consistency Phase 1）：无值以「字段缺失」表达，禁止 ?? 0 编码
  // （0 物理上不可能是真值——任何模型 contextWindow > 0）；仅含 sessionId 的帧 = 无值占位帧。
  'context.update': { sessionId: string; usagePercent?: number; inputTokens?: number; contextLimit?: number }
  // session.stats_update：Composer 生成指标（token 速度 + 缓存命中率；current 为会话私有样本
  // ——本会话最近一次请求，同模型多 session 各自独立；day/d7/d30 为该模型跨会话全局聚合，
  // 同模型多 session 聚合值相同是预期行为）。形状 SSOT = GenStatsFrame
  // （gen-stats.ts，设计 §3.4 唯一权威）。无值编码纪律 [HISTORICAL] 与 context.update 同源：
  // null = 无数据，0 = 真实测量值，禁止 ?? 0 编码（0 物理上可能是真值，null/0 必须可区分）。
  'session.stats_update': GenStatsFrame
  // message.compactionSummary：上下文压缩摘要（compact 执行后推送，进对话流作 SystemNotice）。
  // runtime message-dispatcher.compact() 从 pi CompactionResult 提取 summary/tokensBefore 广播。
  // 前端 chat-message-effects 把它渲染成 system 消息（SystemNotice.vue「上下文已压缩」）。
  'message.compactionSummary': { sessionId: string; summary?: string; tokensBefore?: number; timestamp?: number }
  // session.state_changed：session 级状态变更（model.switch 成功后推送，含新 modelId + 当前
  // thinkingLevel）。前端据 modelId/thinkingLevel 同步 Composer 工具条。thinkingLevel optional
  // （未设置时省略）。
  // [HISTORICAL] D1 协议收敛（context-consistency Phase 1）：usage 三字段已从本帧删除——
  // usage 只经 context.update 一条帧贯穿（广播 / stateSnapshot / getContext reply 同形），
  // 消除「同一数据两条帧、快照缺失时 ?? 0 发 0 基线帧」的协议债。ContextCapacityPopover
  // 的用量刷新改订 context.update（Phase 2 useContextUsage composable 全量重构）。
  'session.state_changed': {
    sessionId: string
    modelId: string
    thinkingLevel?: string
  }
  // session.thinkingLevelSet：pi thinking_level_changed → event-adapter 广播 + setThinkingLevel RPC
  // reply（settings-message-handler）双发送点，payload 形状一致（R1 type-safety S4 补登记——
  // 此前 map 未登记条目落 Record<string, unknown> 占位，消费侧被迫 as）。补 state_changed 的
  // 时序缺口：switchModel 的 state_changed 在 set_model RPC resolve 后立即广播，而
  // thinking_level_changed 事件可能晚到，本帧独立更新 thinkingLevel。
  // [C-pi-14/ADR-0065] mutation reply（分支一后端可变换）：level = pi 生效档，必需不 optional。
  'session.thinkingLevelSet': ThinkingLevelMutationReply
  // FileChanges 通道（ADR-0024 D5 重构：git 作为唯一真值源）。baseline diff 机制——
  // message_start 采集 git status 快照，write/edit/bash 结束后 diff vs baseline 推 accumulating，
  // agent_end 推 ready。isFullSet 恒 true（每次 diff 都是全量结果，前端全集替换不增量合并）。
  // partially-reviewed/resolved/superseded 审查态由前端驱动，不经 runtime 推送。
  'message.file_changes': {
    sessionId: string
    messageId: string
    fileChanges: FileChange[]
    changeSetStatus: ChangeSetStatus
    isFullSet: boolean
  }
  // changeSet 失效广播（ADR-0024 D5 重构）：git.commit 成功后工作区 diff 已重置，
  // 旧的 changeSet 卡片成为过期数据。runtime 广播此帧通知前端把该 session 的 changeSet 推 superseded。
  'message.changeSetInvalidated': {
    sessionId: string
    /** 失效原因：'committed'（git commit 后工作区重置） */
    reason: 'committed'
  }
  // git.status:result：git.status 请求的同步 reply（Wave 1a git domain 经 pending.resolve 消费）。
  // git.stage/unstage/commit 的 ack 复用既有 'message.status'（payload {sessionId, status}），非新增。
  'git.status:result': GitStatusResult
  /** file.tree:result：文件树首加载 reply，顶层+一级子 FileNode[] */
  'file.tree:result': { sessionId: string; tree: FileNode[] }
  /** file.tree.expand:result：展开目录 reply，单层子 FileNode[] */
  'file.tree.expand:result': { sessionId: string; children: FileNode[] }
  /** file.search:result：composer $ 文件候选 reply，全量递归 FileNode[]（受 ignore + 深度 8 + DoS 上限 5000）*/
  'file.search:result': { sessionId: string; files: FileNode[] }
  /** file.search.cwd:result：composer $ 文件候选（landing cwd 路）reply，全量递归 FileNode[]（受 ignore + 深度 8 + DoS 上限 5000）。
   *  truncated：DoS 上限 5000 截止触发（还有未收集条目时 true）——前端据此提示「结果已截断」
   *  （adversarial-review-fixes §3.4 D7：截断事实必须来自 runtime）。 */
  'file.search.cwd:result': { files: FileNode[]; truncated: boolean }
  /** git.diff:result：文件 diff reply（patch + binary 标志） */
  'git.diff:result': { sessionId: string; patch: string; binary: boolean }
  /** file.write.*.result：文件操作骨架 reply（D-018 实现延后，AC-14.4 结构化「待实现」） */
  'file.write.create:result': { sessionId: string; path: string; implemented: false }
  'file.write.rename:result': { sessionId: string; newPath: string; implemented: false }
  'file.write.delete:result': { sessionId: string; path: string; implemented: false }
  // wave:runtime-patch ipc-converge-a3 W2：业务持久化写 reply payload（与原 main IPC 返回值零字段变更）
  /** session.writeImage:result：落地结果。persisted=true 落 attachments（已持久化）；false 落 tmpdir（landing 降级，需迁移） */
  'session.writeImage:result': { path: string; fileName: string; displayName: string; id: string; persisted: boolean }
  /** session.migrateImage:result：迁移后新路径（调用方据此更新 segment.path） */
  'session.migrateImage:result': { path: string }
  /** session.writeSegments:result：ack 型空 payload（atomic 写成功） */
  'session.writeSegments:result': Record<string, never>
  'workspace.recentList': { records: RecentWorkspaceRecord[] }
  /** workspace.bareDetected：workspace.detectBare 的向后兼容 reply（isBare/wsRoot/barePath）。 */
  'workspace.bareDetected': { isBare: boolean; wsRoot: string; barePath: string }
  /** workspace.detected：workspace.detect 的三态 reply。 */
  'workspace.detected': {
    mode: 'bare-workspace' | 'plain-repo' | 'not-repo'
    wsRoot: string
    barePath: string
    repoRoot: string
    defaultBranch: string
  }
  /** worktree.created：worktree.create 的成功 reply（新 worktree 的 cwd 与分支名）。 */
  'worktree.created': { cwd: string; branch: string }
  // terminal.data：PTY 输出流（高频广播，按 sessionId 路由到对应 panel 的 scrollback buffer）。
  'terminal.data': { sessionId: string; data: string }
  // terminal.exit：PTY 进程退出（exitCode 来自 node-pty onExit）。PTY 销毁后 ptyMap 移除。
  'terminal.exit': { sessionId: string; exitCode: number }
  // terminal.alive：PTY 就绪信号（spawn 成功后发，renderer flush 写队列——联动 2 异步写时序）。
  'terminal.alive': { sessionId: string }
  // terminal.ack：spawn/write/resize/kill/attach 的通用 ack reply（空 payload，前端按 id 匹配）。
  'terminal.ack': Record<string, never>
  // config.terminalConfig：reply + broadcast + sendInitialState 三用（复刻 config.systemPrompt 范式）。
  'config.terminalConfig': { config: TerminalConfig; corrupted?: boolean }
  // config.retryConfig：reply + broadcast 多窗口同步（同 terminal 范式）；configured 区分「显式配置」与「未配置（显示默认）」。
  'config.retryConfig': { config: LlmRetryConfig; configured: boolean }
  // Coding Plan 额度查询（payload 见 QuotaFetchResultPayload）。
  'quota.fetch:result': QuotaFetchResultPayload
  'quota.getCached:result': QuotaFetchResultPayload
  'quota.configure:result': { ok: boolean; error?: string }
  'quota.refresh:result': QuotaFetchResultPayload
  'usage.getStats:result': UsageStatsResult
  /** worktree.branches：worktree.listBranches 的 reply（本地/远程分支列表 + 默认分支名）。 */
  'worktree.branches': { local: string[]; remote: string[]; defaultBranch: string }
  /** worktree.list:result：worktree.list 的 reply（worktree 条目列表）。 */
  'worktree.list:result': { items: Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> }
  /** config.worktreeRootDir：config.getWorktreeRootDir 的 reply。 */
  'config.worktreeRootDir': { dir: string }
  /** config.setupScript：config.getSetupScript 的 reply。 */
  'config.setupScript': { script: string }
  /** config.bareSetupScript：config.getBareSetupScript 的 reply。 */
  'config.bareSetupScript': { script: string }
  /** config.worktreeTimeout：config.getTimeout 的 reply。 */
  'config.worktreeTimeout': { timeout: number }
  /** config.defaultBaseBranch：config.getDefaultBaseBranch 的 reply。 */
  'config.defaultBaseBranch': { baseBranch: string }
  /** config.autoRenameEnabled：config.getAutoRenameEnabled 的 reply。 */
  'config.autoRenameEnabled': { enabled: boolean }
  /** config.renameModel：config.getRenameModel / config.setRenameModel 的 reply（"provider/modelId"，空串 = 未设置）。 */
  'config.renameModel': { model: string }
  /** config.renameMode：config.getRenameMode / config.setRenameMode 的 reply（归一后生效值，默认 first-stop）。 */
  'config.renameMode': { mode: RenameMode }
  /** config.smartContextConfig：config.getSmartContextConfig 的 reply（compactModel 为 "provider/modelId" 复合串，空串 = 未设置；thresholds 为 token 绝对数）。 */
  'config.smartContextConfig': {
    enabled: boolean
    compactModel: string
    reminderThresholds: number[]
    excludedModels: string[]
  }
  /** config.smartContextEnabled：config.setSmartContextEnabled 的 reply。 */
  'config.smartContextEnabled': { enabled: boolean }
  /** config.smartContextCompactModel：config.setSmartContextCompactModel 的 reply（"provider/modelId"，空串 = 跟随当前会话模型）。 */
  'config.smartContextCompactModel': { model: string }
  /** config.smartContextThresholds：config.setSmartContextThresholds 的 reply（clamp 后的 token 绝对数，升序 3 档）。 */
  'config.smartContextThresholds': { thresholds: number[] }
  /** config.smartContextExcludedModels：config.setSmartContextExcludedModels 的 reply（过滤去重后）。 */
  'config.smartContextExcludedModels': { models: string[] }

  // ── preset 域 reply（设计文档 pi-launch-presets.md，runtime PresetMessageHandler reply）──
  // 仅登记 payload 消费型 reply（domain 读 reply 字段）。
  // ack 型（setDefault/delete/recordUsage）刻意不登记——runtime 回 {} 空对象，
  // 留作 Record<string, unknown> 占位（与 ServerMessageMapBase 收录原则一致：「未消费/协议待定」走占位）。
  // preset.list：preset.list 的 reply（payload 消费型，domain 读 presets 列表）。
  'preset.list': { presets: PiLaunchPreset[] }
  // preset.getDefault：preset.getDefault 的 reply。presetId 始终是 string——
  // runtime getDefaultPresetId() 在未配置时兜底返回 'builtin:full'（设计文档 §5.3）。
  'preset.getDefault': { presetId: string }
  // preset.create：preset.create 的 reply（回显创建后的预设，含 runtime 规范化结果）。
  // [C-pi-14/ADR-0065] mutation reply（分支二原样存储）：preset 回显必需。
  'preset.create': PresetMutationReply
  // preset.update：preset.update 的 reply（回显更新后的预设）。[C-pi-14/ADR-0065] 同上。
  'preset.update': PresetMutationReply
  // preset.getUsage：preset.getUsage 的 reply（FR-14）。key=presetId, value=PresetUsageEntry。
  'preset.getUsage': { usage: Record<string, PresetUsageEntry> }
  // preset.export：preset.export 的 reply（FR-13）。json 是 `JSON.stringify(PresetExportPayload)`
  //   的结果——只含 presets/defaultPresetId/version 三字段，排除 usage。
  //   见 pi-preset.ts 的 PresetExportPayload 类型。
  'preset.export': { json: string }
  // preset.import：preset.import 的 reply（FR-13）。count = 成功导入的预设数量。
  'preset.import': { count: number }

  // ── RPC reply（W1 方案C 补全：精确 payload，对齐 runtime handler 的 reply 调用字面量）──
  // session.created：session.create / session.fork 的成功 reply。
  // session 是 SessionSummary（session-message-handler.ts:36/56 reply { session }）。
  'session.created': { session: SessionSummary }
  // session.deleted：session.delete reply（session-message-handler.ts:72 reply { sessionId: delSid }）。
  'session.deleted': { sessionId: string }
  // session.deletedByCwd：session.deleteByCwd reply（session-message-handler.ts reply BatchDeleteResult，
  // 含 deleted/failed 聚合列表，前端据此 toast 部分失败）。
  'session.deletedByCwd': BatchDeleteResult
  // project.loaded：project.load reply（project 列表全量，D14 迁 runtime projects.json）。
  'project.loaded': ProjectStoreState
  // session.renamed：session.rename reply（session-message-handler.ts:162 reply { sessionId, name }）。
  // [C-pi-14/ADR-0065] mutation reply（分支二原样存储）：wire 回显请求名 + broadcastSessionList
  // 全量广播兜底；ReplyPayloadMap 登记为 ack 型（豁免理由见 ADR-0065 豁免清单）。
  'session.renamed': SessionRenameMutationReply
  // session.setProject：session.setProject reply（确认即可；归属更新经 config.sessions 全量广播）。
  // [C-pi-14/ADR-0065] mutation reply（分支二原样存储）：同 session.renamed 模式。
  'session.setProject': SessionSetProjectMutationReply
  // session.forkNotice：session.fork 成功后的广播（FR-12 修订 PR2），通知 srcSession 所在 panel
  // 在对话流插一条 ForkNotice 反馈行。广播时机：fork RPC 成功创建 newSession 之后。
  // branchName/preview optional——纯后台 fork 传 branchName，fork-ask 传 preview（提问预览）。
  'session.forkNotice': {
    srcSessionId: string
    newSessionId: string
    branchName?: string
    preview?: string
  }
  // session.skillNotice：composer 多 skill 注入的发送前处理结果提示广播（composer-multi-skill-injection
  // D6/D8，范式对齐 session.forkNotice 的 session 级 push）。时机：message-dispatcher 三入口
  // （sendPrompt/steerMessage/followUpMessage）在 client.prompt/steer/followUp 成功之后，
  // 按注入器产出的 notices 逐条发布——消息已真正入队，提示描述的注入形态才成立；prompt 失败
  // 路径不发（message.error 已覆盖）。renderer（u5）据此呈现 toast + 消息内联提示。
  // clientUuid：sendPrompt 路径从发送文本中的 `<!--taiji:msg:<uuid>-->` 标记提取（非纯文本消息才有，
  // 与 pi 侧 msg-id-mapper TAG_MATCH 同款全文正则）；steer/followUp 路径无 sidecar/clientUuid
  // 链路，字段缺省（类型如实标注可选，u5 消费时按可空处理）。
  // skills：受影响 skill 名列表（去重，保持首次出现顺序）；marker_malformed 的残缺片段无法
  // 可靠提取 name 时可为空数组。
  'session.skillNotice': {
    sessionId: string
    clientUuid?: string
    reason: SkillNoticeReason
    skills: string[]
  }
  // session.handoffStarted：handoff 开始时广播到源 session 对话流（B1 修复）。
  // 时机：runHandoff 发送 handoff prompt 给源 session pi 之前。
  // 前端据此在对话流中显示「正在生成 handoff 文档...」提示，让用户知道 handoff 已启动。
  'session.handoffStarted': { sessionId: string }
  // session.handoffComplete：fast-handoff 完成后的广播（FR-fast-handoff，agent-driven 模式）。
  // 时机：源 session 的 pi 跑完 handoff turn（HANDOFF_PROMPT_TEMPLATE）→ runtime 从 agent_end 提取
  // 文档文本 → 新建空白 session → 用 wrapWithXmlTag(doc) + reply 注入新 session 触发新 turn 之后。
  // agent-driven 模式下 doc 由 runtime 直接发给新 session pi（wave1 已实现），不再经广播回传前端——
  // 广播 payload 仅通知前端复位源 session handingOff + 刷新列表 + 跳转新 session（selectSession 内部
  // 自带 hydrate + 订阅 + 命令/上下文兜底拉取，前端不再手动 ensureStreamSubscription/send）。
  // sourceLabel：交接来源 session 名称（可选，前端用于构造 handoff badge segment）。
  'session.handoffComplete': { srcSessionId: string; newSessionId: string; sourceLabel?: string }
  // session.handoffAborted：fast-handoff 中断后的广播（agent-driven 模式 wave2）。
  // 时机：用户取消进行中的 handoff（或 abort 兜底）→ runtime 调 handoffService.abortHandoff
  // （内部 client.abort + 清 inflight）→ 广播此帧让前端复位源 session 的 handingOff 态。
  // srcSessionId：被中断的源 session id（与 handoffComplete 的 srcSessionId 同义，统一字段名）。
  'session.handoffAborted': { srcSessionId: string }
  // session.history：session.history 的成功 reply（显式历史拉取 RPC；wave:perf-w20 后 switch
  // reply 已拆分到 session.switched，不再复用本类型）。session optional 保留向后兼容。
  // truncated/loadedTurns/totalTurnsEstimate：历史加载双预算窗口契约（D4）——
  // truncated=true 表示窗口外仍有历史；loadedTurns=本次返回的完整 turn 数；
  // totalTurnsEstimate=session 的 turn 总数估计（读到头为精确值，窗口截断时为下界）。
  // [u6] legacy historyTruncated 字段已退役（偏差表 D7 清账：与 truncated 同值并存的双轨收口）。
  'session.history': {
    sessionId: string
    session?: SessionSummary
    messages: Message[]
    truncated: boolean
    loadedTurns: number
    totalTurnsEstimate: number
  }
  // session.switched：session.switch 的成功 reply（wave:perf-w20 R-11 瘦身——switch reply 不再
  // 无条件全量 getHistory 塞 messages，被驱逐 session 切回走显式 session.history RPC（全量），
  // LRU 内切回本就零请求）。renderer switchSession 返回 void 不读 payload，历史消费路径是
  // selectSession 内显式 chat.getHistory。与 session.history 类型拆分（历史 reply 形状不动）。
  'session.switched': {
    sessionId: string
    session: SessionSummary
  }
  // [u6] session.fullHistory / session.getFullHistory 已退役（D4 中期：
  // 「加载更早」改走 session.history 游标翻页，全量通路删除——游标翻页完全替代）。
  // model.switched：model.switch reply（settings-message-handler.ts:324-339 reply { sessionId, provider, modelId }，U6 后回传 pi 生效值拆解）。
  // [C-pi-14/ADR-0065] mutation reply（分支一后端可变换）：provider/modelId = pi 生效值，必需不 optional。
  'model.switched': ModelSwitchMutationReply
  // message.status：send/abort/steer/follow_up + git stage/unstage/commit/checkout/createBranch 的 ack reply。
  // status 是动作结果字面量（sent/rejected/steered/queued/aborted/staged/unstaged/committed/switched/branch_created），
  // CL10 决策不收窄死字面量，统一 string（ack 型 domain register<void> 不读 status 值）。
  // 见 session-message-handler.ts:175/180/186/198/211 + git-message-handler.ts:65/74/87/96/105。
  'message.status': { sessionId?: string; status: string }
  // extension.discovered：installDir/installGit 的成功 reply（extension-message-handler.ts:162/176 reply { tempDir, candidates }）。
  // candidates 是发现的扩展候选列表（runtime ExtensionInfo[]，与 extension.ts ExtensionDiscoveredPayload 同构）。
  'extension.discovered': { tempDir: string; candidates: ExtensionInfo[] }
  // extension.installCancelled：cancelInstall reply（extension-message-handler.ts:205 reply {}）。
  'extension.installCancelled': Record<string, never>
  // extension.pendingRequests：getPendingRequests reply（extension-message-handler.ts:249 reply { sessionId, requests }）。
  // requests 元素是 runtime PendingUIRequest（runtime 专有类型，未下沉 shared），
  // 用 unknown[] 保持 shared 依赖最小化（与 extension.ui_request 的 askUserQuestions:unknown[] 先例一致）。
  'extension.pendingRequests': { sessionId: string; requests: unknown[] }
  // file.read:result：file.read reply（file-message-handler.ts:86 reply { content, truncated, path }，runtime 不发 sessionId）。
  // sessionId optional 对齐前端 file.ts:47 register（无 sessionId）+ rpc-type-pairing.test U1（带 sessionId 样本）。
  'file.read:result': { sessionId?: string; content: string; truncated: boolean; path: string }
  // config.scannedSkills：scanSkills reply（settings-message-handler.ts:69 reply { skills, success: true }）。
  // skills 是扫描发现结果，形状为 ScannedSkillInfo（含 sourceType/alreadyImported），非已加载的 SkillInfo。
  'config.scannedSkills': { skills: ScannedSkillInfo[]; success: boolean }
  // W2：scanSessionSkills reply（settings-message-handler.ts reply { skills }，不广播，按需 RPC）。
  // skills 是已加载的 SkillInfo（loadSkills(cwd) 扫描结果），非 ScannedSkillInfo。
  'config.sessionSkills': { skills: SkillInfo[] }
  // W4：getGlobalSkills reply（settings-message-handler reply skillRegistry.getGlobalSkills()，不广播，按需 RPC）。
  'config.globalSkills': { skills: SkillInfo[] }
  // W4：getProjectSkills reply（settings-message-handler reply skillRegistry.getProjectSkills(cwd)，不广播，按需 RPC）。
  'config.projectSkills': { skills: SkillInfo[] }
  // config.scannedAgents：scanAgents reply（settings-message-handler.ts:99 reply { agents, success: true }）。
  // agents 是扫描发现结果，形状为 ScannedAgentInfo（含 sourceType/alreadyImported），非已加载的 AgentInfo。
  'config.scannedAgents': { agents: ScannedAgentInfo[]; success: boolean }
  // config.sourcesDetected：detectSources reply（settings-message-handler.ts reply { sources }）。
  // sources 是本机其他 agent（Claude/Codex/Pi/ZCode）skill/agent 目录的检测结果（只读，不读文件内容）。
  'config.sourcesDetected': { sources: SourceDetectResult[] }
  // config.builtinProviders：listBuiltinProviders reply（wave 2，内置 provider 模板数组）。
  'config.builtinProviders': { providers: BuiltinProviderTemplate[] }
  // config.providersPreviewed：previewImportProviders reply（W2 迁移）。
  // 成功 { importId, preview }（preview 脱敏，只含 apiKeyExtracted 布尔，无 apiKey 值）；
  // 失败 { error: { code, message } }（如 SOURCE_NOT_INSTALLED）。
  // importId 供 applyImportProviders 第二步使用。前端按有无 error 字段判断成败。
  'config.providersPreviewed':
    | { importId: string; preview: ProviderImportPreview }
    | { error: { code: string; message: string } }
  // config.providersImported：applyImportProviders reply（W2 迁移）。
  // 成功 { result }（含 imported/skipped/failed 三态条目 + failedCount）；
  // 失败 { error: { code, message } }（如 PREVIEW_EXPIRED）。前端按有无 error 字段判断成败。
  'config.providersImported':
    | { result: ProviderImportResult }
    | { error: { code: string; message: string } }
  // ── OAuth Login 事件（路径 B，slice design I4）──
  /** device flow 中间态：user_code 大字号展示 + verification_uri 打开浏览器 + 轮询倒计时。 */
  'auth.deviceCode': { providerId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn?: number; interval?: number }
  /** callback flow 中间态：授权 URL（前端打开浏览器）+ 固定端口提示。 */
  'auth.authUrl': { providerId: string; url: string; callbackPort?: number }
  /** 授权成功：token 已写 auth.json。 */
  'auth.success': { providerId: string; oauthName?: string }
  /** 授权失败（expired_token / access_denied / 端口占用 / 超时 / exchange 失败）。 */
  'auth.error': { providerId: string; message: string }
  /** config.oauthLogin reply（成功/失败布尔 + 错误原因）。 */
  'config.oauthLoginReply': { started: boolean; error?: string }
  /** config.oauthCancel reply（幂等：无进行中 flow 返回 cancelled:false 不报错）。 */
  'config.oauthCancelReply': { cancelled: boolean }
  /** config.hasOAuth reply：auth.json 是否已有该 provider 的 oauth 凭据（布尔，无 token）。 */
  'config.hasOAuthReply': { hasOAuth: boolean }
  /** config.oauthLogout reply（成功/失败布尔 + 错误原因；token 永不出现在协议中）。 */
  'config.oauthLogoutReply': { ok: boolean; error?: string }
  /** config.checkEnvVars reply：只含布尔（安全红线：env 值不进前端）。 */
  'config.envVarsChecked': { results: Record<string, boolean> }
  // config.discoveredModels：discoverModels reply（settings-message-handler.ts:178/180）。
  // 成功 { models, success: true }；失败 { models: [], success: false, error }（D10 降级响应，非 error envelope）。
  // models 元素形状对齐前端 config.ts:49 DiscoveredModelsResult（id + 可选 name/contextWindow）。
  'config.discoveredModels': {
    models: Array<{ id: string; name?: string; contextWindow?: number }>
    success: boolean
    error?: string
    // test 模式填（按协议分组的真实连接测试结果）；discover 模式不填；
    // optional 向后兼容——旧消费方不读该字段，行为不变。
    // 行形状 SSOT = ConnectionTestResultRow（下方导出，4 处手写重复收编）。
    results?: ConnectionTestResultRow[]
  }
  // config.providerUpdated：setProvider/deleteProvider reply（settings-message-handler.ts:37/51/65）。
  // 三种 shape：setProvider 成功 { saved: true }；deleteProvider { providerId, deleted: true }；
  // setProvider 首启用 fallback { providerId }（统一并集，字段均 optional 除共性外）。
  'config.providerUpdated': { providerId?: string; saved?: boolean; deleted?: boolean }
  // config.skillUpdated：setSkill reply（settings-message-handler.ts:86 reply { skill, success: true }）。
  'config.skillUpdated': { skill: SkillInfo; success: boolean }
  // config.skillDeleted：deleteSkill reply（settings-message-handler.ts:93 reply { skillId, success: true }）。
  'config.skillDeleted': { skillId: string; success: boolean }
  // config.agentUpdated：setAgent reply（settings-message-handler.ts:115 reply { agent, success: true }）。
  'config.agentUpdated': { agent: AgentInfo; success: boolean }
  // config.agentDeleted：deleteAgent reply（settings-message-handler.ts:122 reply { agentId, success: true }）。
  'config.agentDeleted': { agentId: string; success: boolean }

  // ── 消息流控制（W11+ 审查补充类型）──
  'message.auto_retry_start': { sessionId: string; attempt: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }
  'message.auto_retry_end': { sessionId: string; success: boolean; attempt: number; finalError?: string }
  // message.queue_update：队列深度变化广播。pendingMessageCount = steering + followUp 条数和
  //（event-adapter 翻译恒附，W8 补声明——renderer 窄读取此前读不到该字段类型；帧内值 =
  // pi 队列深度的推送投影，与 get_state().pendingMessageCount 同公式同源、数值恒等，
  // PR #185 MF2 定口径：renderer 对账直读帧值，原「queue 实例快照权威、帧仅事件即时信号」
  // 口径作废——queue ReplicatedState 实例已撤销）。
  'message.queue_update': { sessionId: string; steering?: string[]; followUp?: string[]; pendingMessageCount: number }
  // message.bashStart：bash 执行开始广播（与 message.bashResult 对称的实时反馈）。
  // excludeFromContext 透传自请求（前端据此渲染「不进上下文」标记）。
  'message.bashStart': {
    sessionId: string
    command: string
    excludeFromContext: boolean
    timestamp: number
  }
  // message.bashResult：bash 执行结束广播（含 output/exitCode/cancelled 等终态字段）。
  // exitCode 用 number|null：pi 返回 number|undefined，runtime 广播时统一 `?? null` 防 JSON 丢值。
  // cancelled=true 也可能是 abortBash 触发的兜底终态（与 abort 广播 message.complete{aborted} 对称）。
  'message.bashResult': {
    sessionId: string
    command: string
    output: string
    exitCode: number | null
    cancelled: boolean
    truncated: boolean
    excludeFromContext: boolean
    timestamp: number
    /** pi truncated 时的完整输出文件路径（前端按需读取全文） */
    fullOutputPath?: string
  }
  // pi CustomMessage 注入（扩展经 pi.sendMessage 向对话流注入结构化通知，如 subagent-bg-notify）。
  // event-adapter 把 pi message_start{role:'custom', customType, content, details} 翻译为此帧。
  // 前端 customStart effect 建 role:'system' 消息（保留 customType/details），按 customType 渲染。
  'message.customStart': {
    sessionId: string
    customType: string
    content?: string
    details?: Record<string, unknown>
    display?: boolean
  }
  // ── W21 entry 形态实时 feed（data-source-governance P3.3）──
  // message.message_end：pi message_end 事件重构的 message entry（user/assistant/toolResult/custom
  // 的持久化触发点，agent-session.ts:545-561），实时路径与文件重放（get_entries）喂同一个
  // core reducer（applyEntry）的权威载体。entry.id 恒缺省（pi 在 emit 之后才 appendMessage
  // 分配 uuidv7，事件上拿不到）——reducer 按 `e<N>` 确定性派生，W22 对账靠 get_entries。
  'message.message_end': { sessionId: string; entry: PiMessageEntry }
  // message.tool_call_start：tool_execution_start 重构的 toolCall entry 形态（替换直译平铺
  // payload——overlay 挂 running toolCall 从 entry 读取）。contentIndex/messageId 由
  // event-interpreter 从缓存补齐（产出顺序锚点 + 挂载目标）；turnId 恒缺省（值填充归
  // fix-chat-flow-order 分组 wave）。
  'message.tool_call_start': { sessionId: string; entry: PiToolCallEntryForm }
  // message.tool_call_end：tool_execution_end 重构的 toolResult message entry 形态。
  // entry.message.content 是 plugin hook 改写后的工具产出（string 或 content block 数组，
  // 与 pi 持久化 toolResult entry 同构）；isError/details 透传。前端 registry 喂
  // applyEntry（toolResult 窗口局部配对回填）+ overlay 收口。
  'message.tool_call_end': { sessionId: string; entry: PiMessageEntry }

  // ── backgroundTask 域（docs/architecture/background-task-sidebar-view.md §3.3 D3，u-proto）──
  // 后台命令侧边栏：3 个 RPC 回执 + 1 个 session 级变更广播；全部必带 sessionId（架构规则 7）。
  // tasks 元素是 shared 协议镜像 BackgroundTaskRegistryEntry（逐字段同构 extension-protocol 同名
  // 契约，D9；等价性由 core transport api domain（packages/core/src/transport/api/domains/
  // background-task.ts）的 BackgroundTaskMirrorEqualsContract 编译期守卫）。
  // backgroundTask.list 的 reply（registry 全量投影；目录/文件不存在 → 空数组）。
  // corrupted=true = registry 解析失败被 .corrupt 隔离的「损坏空表」（S7 错误条依据，
  // 区分于真空表；缺省/false = 正常拍，仿 config.systemPrompt 同名字段先例）。
  'backgroundTask.tasks': { sessionId: string; tasks: BackgroundTaskRegistryEntry[]; corrupted?: boolean }
  // backgroundTask.output 的 reply。text = 输出尾部窗口内容（lost 时为空串）；truncated = 超出
  // 窗口上界截断；lost = 输出文件不可用（已清理/丢失，§3.1 失败路径「输出不可用」分支）。
  'backgroundTask.outputResult': { sessionId: string; taskId: string; text: string; truncated: boolean; lost: boolean }
  // backgroundTask.kill 的 reply（D6 分支矩阵回执；reason 语义见 BackgroundTaskKillReason）。
  'backgroundTask.killResult': { sessionId: string; taskId: string; killed: boolean; reason: BackgroundTaskKillReason }
  // backgroundTask:updated：registry 变更的 session 级广播（Server→Client 冒号 camelCase，
  // 对齐 plugin:statusBarUpdate 命名规则；经 IMessageBus.publish(sessionId, msg) 定向推）。
  // 广播只做增量刷新、不做唯一真相——renderer 切换/激活 session 后仍须主动 list 拉取
  //（架构约定「runtime broadcast 时序竞争」C6：拉取兜底是唯一真相入口）。
  // corrupted 语义与 backgroundTask.tasks 同源（损坏空表标记，S7）；缺省/false = 正常拍。
  'backgroundTask:updated': { sessionId: string; tasks: BackgroundTaskRegistryEntry[]; corrupted?: boolean }

  // ── rollingRestart 域（crash-forensics-and-watchdog §3.3 D5，u7b 协议面）──
  // status：只读查询 reply（u7c 状态机生产；renderer 重连/刷新后主动拉取恢复横幅——持续态
  // 不可依赖广播时序，T-30s 广播只作加速显示）。
  'rollingRestart.status': RollingRestartStatusPayload
  // deferred / forced：推迟开始 / 强制升级执行的全局推送（u7c 生产；与台账
  // rolling-restart-deferred / rolling-restart-forced 同源，在途摘要字段语义见 payload 类型）。
  'rollingRestart:deferred': RollingRestartDeferredPayload
  // countdown：执行前 T-30s 二次预告（D5 ③，u7c 补缺；status 拉取是持续态唯一真相，
  // 本广播只作加速显示——「broadcast 时序竞争」教训同源）。
  'rollingRestart:countdown': RollingRestartCountdownPayload
  'rollingRestart:forced': RollingRestartForcedPayload

  // ── watchdog 域（crash-forensics-and-watchdog §3.3 D4，u6）──
  // memoryPressure：内存压力全局推送（u6 看门狗生产；renderer useMemoryPressure 消费——
  // warn 及以上收紧 renderer 侧 LRU；字段语义见 payload 类型）。
  'watchdog:memoryPressure': WatchdogMemoryPressurePayload

  // ── reattach 域（crash-forensics-and-watchdog §3.3 D3 高水位延迟，偏差 #27）──
  // deferred：启动 reattach 高水位延迟推送（u5 生产；renderer useRollingRestartStatus
  // 消费——高压延迟横幅腿；active 进入/缓解退出两态，字段语义见 payload 类型）。
  'reattach:deferred': ReattachDeferredPayload
}

/**
 * Runtime → Client payload 类型映射（与 ClientMessageMap 对称）。
 *
 * 精确条目见 ServerMessageMapBase（已消费 + 已契约化的 type）；其余未消费 / 协议待定的
 * type 走 `Record<string, unknown>` 占位，待对应 wave 实装时收紧：
 * message.* 进 W05-W07，plugin:* / extension:* widget 等属后续 wave。
 *
 * 收紧某条目时，runtime 构造点会同步得契约校验（若 payload 字段对不上，tsc 报错——D5 的预期收益）。
 */
export type ServerMessageMap = ServerMessageMapBase & {
  [K in Exclude<ServerMessageType, keyof ServerMessageMapBase>]: Record<string, unknown>
}

/**
 * Runtime → Client 消息。泛型化后 payload 按 type 收窄（见 ServerMessageMap）。
 *
 * 构造侧（runtime server.ts 的 send/reply/broadcast）仍可传 `ServerMessage`（默认 T=ServerMessageType，
 * payload 为联合）——存储/传输层不感知具体 type。消费侧 onGlobalType<T>/on<T> 收窄后才解构 payload。
 */
export interface ServerMessage<T extends ServerMessageType = ServerMessageType> {
  type: T
  /** RPC reply 关联 ID（renderer 在 ClientMessage 生成 UUID，runtime reply 原样回填）。
   *  与 seq 互斥（见 D7）：同一条消息要么是 RPC reply（带 id）要么是 server-push live（带 seq），
   *  runtime routeInbound 先判 id 再判 seq。 */
  id?: string
  /** server-push live 事件的单调序号（per-session，bus.publish 分配，DM3/D5）。
   *  与 id 互斥（见 D7）：subscribe 后 renderer 用 lastSeenSeq 做 gap 检测与 reconcile backfill。
   *  类型层不强制 id/seq union（避免破坏现有构造侧默认泛型赋值），互斥由 runtime 保证。 */
  seq?: number
  payload: ServerMessageMap[T]
}

/**
 * ServerMessage 的分发联合形态（消费侧收窄用，R1 type-safety S5）。
 *
 * ServerMessage<T> 接口的 payload 是 `ServerMessageMap[T]` 泛型查询——T 未绑定时（默认全联合）
 * payload 为全 payload 联合，`switch (msg.type)` 无法收窄，消费侧被迫 `msg.payload as {...}`，
 * 契约缺字段时 as 静默放行（S4 的 thinkingLevelSet 曾因此不可见）。本类型把每个 type 展开为
 * 独立成员，TS 判别联合自动收窄 payload，ServerMessageMap 登记缺口直接变编译错误。
 *
 * 与 ServerMessage 的关系：同一 wire 形状的两种 TS 表达（值域相同），ServerMessageUnion 的
 * 任一成员可赋给 ServerMessage（窄→宽）。构造侧（runtime server.ts send/reply/broadcast）继续
 * 用 ServerMessage；消费入口（订阅 handler 签名）用本类型。二者收敛为单一表达是后续 wave。
 */
export type ServerMessageUnion = {
  [K in ServerMessageType]: {
    type: K
    id?: string
    seq?: number
    payload: ServerMessageMap[K]
  }
}[ServerMessageType]

/**
 * # ReplyPayloadMap —— RPC request → reply payload 一级映射（方案C 精简版）。
 *
 * key = RPC 型 ClientMessageType（runtime 有成功 reply 的请求）。
 * value：
 * - **payload 消费型**：引用 `ServerMessageMap[<reply type>]`，domain 读取 reply 字段；
 * - **ack 型**：`void`，domain `register<void>` 不读 reply payload（状态变更由独立订阅通道推回）。
 *
 * 不含 fire-and-forget 型（extension.ui_response 无成功 reply）、不含订阅/通知型（ping 等）。
 * command<K>()（renderer api/request.ts）用此 map 推导返回类型：`Promise<ReplyPayloadMap[K]>`。
 *
 * [C-pi-14/ADR-0065] mutation 类 RPC（改状态值且 renderer 有 store 副本，覆盖域 = session
 * 配置状态 / model / preset 三域）的映射约定：分支一（后端可变换请求值——pi 钳制/pattern
 * 换模）必须 payload 消费型引用携带生效值字段的 `XxxMutationReply` 具名类型，禁 void；
 * 分支二（后端原样存储）reply 携带回显字段，确需 ack 型的须在 ADR-0065 豁免清单登记理由。
 * 新增 mutation 必须同步登记 runtime 契约测试 MUTATION_RPC_REGISTRY（不入清单即测试红）。
 *
 * 运行时漂移防御（RequestReplyMap 双向校验）在后续 wave，此处仅一级映射。
 */
export interface ReplyPayloadMap {
  // ── payload 消费型（value 引用 ServerMessageMap[<reply type>]）──
  'config.discoverModels': ServerMessageMap['config.discoveredModels']
  'config.getProviders': ServerMessageMap['config.providers']
  'config.refreshProviderCatalogs': ServerMessageMap['config.providerCatalogsRefreshed']
  'config.scanAgents': ServerMessageMap['config.scannedAgents']
  'config.scanSkills': ServerMessageMap['config.scannedSkills']
  'config.detectSources': ServerMessageMap['config.sourcesDetected']
  'config.listBuiltinProviders': ServerMessageMap['config.builtinProviders']
  // W2 迁移：provider 导入两步流 reply（payload 消费型，前端读 importId/preview/result/error）。
  'config.previewImportProviders': ServerMessageMap['config.providersPreviewed']
  'config.applyImportProviders': ServerMessageMap['config.providersImported']
  // OAuth Login（路径 B）：reply 消费型（started/cancelled 布尔）。
  'config.oauthLogin': ServerMessageMap['config.oauthLoginReply']
  'config.oauthCancel': ServerMessageMap['config.oauthCancelReply']
  'config.hasOAuth': ServerMessageMap['config.hasOAuthReply']
  'config.oauthLogout': ServerMessageMap['config.oauthLogoutReply']
  'config.checkEnvVars': ServerMessageMap['config.envVarsChecked']
  'config.scanSessionSkills': ServerMessageMap['config.sessionSkills']
  'config.getGlobalSkills': ServerMessageMap['config.globalSkills']
  'config.getProjectSkills': ServerMessageMap['config.projectSkills']
  // 系统提示词配置（W2，FR-4/FR-5）：get/setSystemPrompt reply config.systemPrompt
  //   形状 `{ config, corrupted? }`。
  'config.getSystemPrompt': ServerMessageMap['config.systemPrompt']
  'config.setSystemPrompt': ServerMessageMap['config.systemPrompt']
  'extension.getPendingRequests': ServerMessageMap['extension.pendingRequests']
  'extension.installDir': ServerMessageMap['extension.discovered']
  'extension.installGit': ServerMessageMap['extension.discovered']
  'extension.recommended': ServerMessageMap['extension.recommended']
  'file.read': ServerMessageMap['file.read:result']
  'file.search': ServerMessageMap['file.search:result']
  'file.search.cwd': ServerMessageMap['file.search.cwd:result']
  'file.tree': ServerMessageMap['file.tree:result']
  // file.write.*（D-018 实现延后，runtime 回 implemented:false 骨架 reply；reply type 见 :result）
  'file.write.create': ServerMessageMap['file.write.create:result']
  'file.write.rename': ServerMessageMap['file.write.rename:result']
  'file.write.delete': ServerMessageMap['file.write.delete:result']
  // wave:runtime-patch ipc-converge-a3 W2：业务持久化写 request→reply 映射（payload 消费型，domain 读 reply 字段）
  'session.writeImage': ServerMessageMap['session.writeImage:result']
  'session.migrateImage': ServerMessageMap['session.migrateImage:result']
  'session.writeSegments': ServerMessageMap['session.writeSegments:result']
  'file.tree.expand': ServerMessageMap['file.tree.expand:result']
  'git.diff': ServerMessageMap['git.diff:result']
  'git.status': ServerMessageMap['git.status:result']
  // model.list：runtime reply 'model.list' { models }（settings-message-handler.ts:128）。
  //   当前 renderer 当订阅型消费（onGlobalType），但协议层是 RPC 型，此处登记保证 SSOT 完整。
  'model.list': ServerMessageMap['model.list']
  'session.create': ServerMessageMap['session.created']
  'session.fork': ServerMessageMap['session.created']
  'session.restore': ServerMessageMap['session.created']
  'session.getAgentCallFilePath': ServerMessageMap['session.agentCallFilePath']
  'session.getAgentCallHistory': ServerMessageMap['session.agentCallHistory']
  'session.getCommands': ServerMessageMap['session.commands']
  'session.getContext': ServerMessageMap['context.update']
  // session.getGenStats：reply = session.stats_update payload 同形（payload 消费型；
  // D4 恢复腿，runtime 侧 modelId 解析降级链权威）。
  'session.getGenStats': ServerMessageMap['session.stats_update']
  'session.getTraceEntries': ServerMessageMap['session.traceEntries']
  'session.fetchCurrentSystemPrompt': ServerMessageMap['session.currentSystemPrompt']
  'session.getSubagentHistory': ServerMessageMap['session.subagentHistory']
  'session.getSubagentEngineConfig': ServerMessageMap['session.subagentEngineConfig']
  'session.setSubagentDefaultEngine': ServerMessageMap['session.subagentDefaultEngineSet']
  'session.getSubagents': ServerMessageMap['session.subagents']
  // plan 模式（D1-⑥ 冷启动首拉）：reply 复用 session.planState 广播 payload（同 getSubagents 先例）
  'session.getPlanState': ServerMessageMap['session.planState']
  'session.getWorkflows': ServerMessageMap['session.workflows']
  'session.history': ServerMessageMap['session.history']
  'config.sessions': ServerMessageMap['config.sessions']
  // session.importCandidates / session.import（docs/design/import-session.md（已删除，git 可追溯）§3.3 D5）：reply 与 request 同名
  'session.importCandidates': ServerMessageMap['session.importCandidates']
  'session.import': ServerMessageMap['session.import']
  // plugin.* RPC reply 映射（plugin-message-handler.ts 全部发 reply）：
  //  - plugin.list / toggle / uninstall / install / approvePermissions / revokePermissions
  //    → reply 'config.plugins' { plugins }（前端读 plugins 列表刷新 UI）
  //  - plugin.executeCommand → reply 'pong' {}（fire-and-forget ack，前端不读 payload）
  //  - plugin.config.get / set → reply 'plugin:config' { pluginId, config }（前端读 config 应用到设置面板）
  'plugin.list': ServerMessageMap['config.plugins']
  'plugin.toggle': ServerMessageMap['config.plugins']
  'plugin.uninstall': ServerMessageMap['config.plugins']
  'plugin.install': ServerMessageMap['config.plugins']
  'plugin.approvePermissions': ServerMessageMap['config.plugins']
  'plugin.revokePermissions': ServerMessageMap['config.plugins']
  'plugin.executeCommand': ServerMessageMap['pong']
  'plugin.config.get': ServerMessageMap['plugin:config']
  'plugin.config.set': ServerMessageMap['plugin:config']
  'plugin.mountPoints.sync': ServerMessageMap['pong']
  'workspace.listRecent': ServerMessageMap['workspace.recentList']
  'workspace.record': ServerMessageMap['workspace.recentList']
  'project.load': ServerMessageMap['project.loaded']
  'project.save': void                  // ack 型（保存成功即 resolve）
  'workspace.detectBare': ServerMessageMap['workspace.detected']
  'workspace.detect': ServerMessageMap['workspace.detected']
  'worktree.create': ServerMessageMap['worktree.created']
  'config.getTerminalConfig': ServerMessageMap['config.terminalConfig']
  'config.setTerminalConfig': ServerMessageMap['config.terminalConfig']
  'config.getRetryConfig': ServerMessageMap['config.retryConfig']
  'config.setRetryConfig': ServerMessageMap['config.retryConfig']
  'quota.fetch': ServerMessageMap['quota.fetch:result']
  'quota.getCached': ServerMessageMap['quota.getCached:result']
  'quota.configure': ServerMessageMap['quota.configure:result']
  'quota.refresh': ServerMessageMap['quota.refresh:result']
  'usage.getStats': ServerMessageMap['usage.getStats:result']
  'worktree.listBranches': ServerMessageMap['worktree.branches']
  'worktree.list': ServerMessageMap['worktree.list:result']
  'config.setWorktreeRootDir': ServerMessageMap['config.worktreeRootDir']
  'config.getWorktreeRootDir': ServerMessageMap['config.worktreeRootDir']
  'config.setSetupScript': ServerMessageMap['config.setupScript']
  'config.getSetupScript': ServerMessageMap['config.setupScript']
  'config.setBareSetupScript': ServerMessageMap['config.bareSetupScript']
  'config.getBareSetupScript': ServerMessageMap['config.bareSetupScript']
  'config.setTimeout': ServerMessageMap['config.worktreeTimeout']
  'config.getTimeout': ServerMessageMap['config.worktreeTimeout']
  'config.setDefaultBaseBranch': ServerMessageMap['config.defaultBaseBranch']
  'config.getDefaultBaseBranch': ServerMessageMap['config.defaultBaseBranch']
  'config.setAutoRenameEnabled': ServerMessageMap['config.autoRenameEnabled']
  'config.getAutoRenameEnabled': ServerMessageMap['config.autoRenameEnabled']
  'config.setRenameModel': ServerMessageMap['config.renameModel']
  'config.getRenameModel': ServerMessageMap['config.renameModel']
  'config.setRenameMode': ServerMessageMap['config.renameMode']
  'config.getRenameMode': ServerMessageMap['config.renameMode']
  'config.getSmartContextConfig': ServerMessageMap['config.smartContextConfig']
  'config.setSmartContextEnabled': ServerMessageMap['config.smartContextEnabled']
  'config.setSmartContextCompactModel': ServerMessageMap['config.smartContextCompactModel']
  'config.setSmartContextThresholds': ServerMessageMap['config.smartContextThresholds']
  'config.setSmartContextExcludedModels': ServerMessageMap['config.smartContextExcludedModels']
  // preset 域（设计文档 pi-launch-presets.md）：runtime PresetMessageHandler reply。
  // 全部引用 ServerMessageMapBase 中登记的精确 payload 形状（W-SH-1 收紧，SSOT）。
  //  - preset.list / getDefault / getUsage / export / import
  //    → payload 消费型（domain 读 reply 字段）
  //  - preset.setDefault / delete / recordUsage
  //    → ack 型（domain register<void>，默认预设变更无独立广播通道）
  'preset.list': ServerMessageMap['preset.list']
  'preset.getDefault': ServerMessageMap['preset.getDefault']
  'preset.setDefault': void
  // preset CRUD：create/update 返回 { preset }（payload 消费型），delete ack 型。
  'preset.create': ServerMessageMap['preset.create']
  'preset.update': ServerMessageMap['preset.update']
  'preset.delete': void
  // FR-14/FR-13 reply（payload 消费型 vs ack 型）
  'preset.recordUsage': void
  'preset.getUsage': ServerMessageMap['preset.getUsage']
  'preset.export': ServerMessageMap['preset.export']
  'preset.import': ServerMessageMap['preset.import']

  // ── ack 型（value = void，domain register<void> 不读 reply payload）──
  'config.deleteAgent': void      // reply config.agentDeleted
  'config.deleteProvider': void   // reply config.providerUpdated
  'config.deleteSkill': void      // reply config.skillDeleted
  'config.setAgent': void         // reply config.agentUpdated
  'config.setAgentDirs': void     // reply config.agentDirs
  'config.setDefaultModel': void  // reply config.defaults
  'config.setExtensionDirs': void // reply config.extensionDirs
  'config.setProvider': void      // reply config.providerUpdated
  'config.toggleProviderEnabled': void  // wave4：reply config.providerUpdated（同 setProvider 模式）
  'config.removeProviderByKind': void   // wave4：reply config.providerUpdated（同 deleteProvider 模式）
  'config.setSkill': void         // reply config.skillUpdated
  'config.setSkillDirs': void     // reply config.skillDirs
  'config.setToolPermissions': void // reply config.providerUpdated（settings-message-handler.ts:65）
  'extension.cancelInstall': void // reply extension.installCancelled
  'extension.finishInstall': void // reply config.extensions
  'extension.install': void       // reply config.extensions
  'extension.list': void          // reply config.extensions
  'extension.setAutoUpgrade': void // reply config.extensions
  'extension.toggle': { extensions: ExtensionInfo[] }  // reply config.extensions（前端消费 reply 刷新 store；RPC reply 命中 pending 不走 dispatchGlobal）
  'extension.uninstall': void     // reply config.extensions
  'extension.upgrade': void       // reply config.extensions
  'git.checkout': void            // reply message.status
  'git.checkoutCwd': void        // reply message.status
  'git.commit': void              // reply message.status
  'git.createBranch': void        // reply message.status
  'git.stage': void               // reply message.status
  'git.unstage': void             // reply message.status
  'message.abort': void           // reply message.status
  // message.bash / message.abortBash：reply message.status（sent/rejected/aborted ack）。
  // bash 是 fire-and-forget 型——实际结果经 message.bashStart/bashResult 广播通道推回（不走 reply）。
  'message.bash': void             // reply message.status
  'message.abortBash': void        // reply message.status
  'message.follow_up': void       // reply message.status
  'message.send': void            // reply message.status
  'message.steer': void           // reply message.status
  'model.switch': ServerMessageMap['model.switched'] // reply model.switched（回执修型 U6：transport 层在
            // model.switch case 消费 switchModel 返回的生效值（session-service 读回 get_state 生效模型）
            // 拆解回填 provider/modelId，对齐 C-pi-13 改状态 RPC 一律回生效值）
  'session.compact': void         // reply session.compacted
  'session.delete': void          // reply session.deleted
  'session.deleteByCwd': BatchDeleteResult // reply session.deletedByCwd（前端读 deleted/failed 列表）
  // session.handoff：触发后 runtime HandoffService 异步让源 session 跑 handoff turn 生成文档，
  // 完成经 session.handoffComplete 独立广播通道推回。reply message.status ack（前端不读 payload，等广播跳转新 session）。
  'session.handoff': void         // reply message.status
  // session.abortHandoff：取消进行中 handoff，reply message.status ack（与 message.abort 同模式）。
  'session.abortHandoff': void    // reply message.status
  // session.forceQuit：强杀 pi 进程并走 stopped 收敛（终态经 session.exited 广播推回），reply message.status ack。
  'session.forceQuit': void       // reply message.status
  // session.abortPlan：横幅退出 → runtime 转发 '/plan abort'（E10 挂起 select 联动在 extension 侧），
  // reply message.status ack——退出后的状态变化经投影链 session.planState 广播推回（isActive=false），
  // 前端 register<void> 不读 reply payload（session.forceQuit 同构形态）。失败走 error envelope（E9）。
  'session.abortPlan': void       // reply message.status
  // session.subscribe（runtime-message-bus wave:protocol-seq）：订阅某 session 的 live 事件流。
  // payload 消费型——renderer 读 snapshot 做 reconcile（订阅时刻 bus ring 内当前事件序列，
  // 元素为带 seq 的 ServerMessage），记 lastSeq 作为后续 gap 检测基线；gap=true 标记本次
  // snapshot 因 ring 容量溢出存在缺口（renderer 需全量重拉而非增量 backfill）。
  // stateSnapshot（wave:remove-bandaids）：6 个 state topic（commands/context/subagents/
  // workflows/state_changed/occupancy）的 last-value 数组拷贝，让 renderer
  // subscribe 后一次性把 commands/context/subagents 的当前状态灌入对应 store，替代主动拉取兜底。
  'session.subscribe': { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }
  // session.unsubscribe（runtime-message-bus wave:protocol-seq）：取消订阅，ack 型。
  // 与 session.handoff/session.abortHandoff/message.abort 同模式，renderer register<void>
  // 不读 reply payload，取消订阅的副作用由后续 live 事件停发体现。
  'session.unsubscribe': void     // reply message.status
  'session.rename': void          // reply session.renamed
  'session.setProject': void      // reply session.setProject
  // session.setThinkingLevel：reply 生效值（回执修型 U6，pi-boundary-reliability D3）——runtime
  // settings-message-handler 已在回传 set→get_state→effective（pi 钳制档位时 ≠ 请求值），
  // 消费方（useModel）以回执 level 写显示态，禁止乐观写请求值（改状态 RPC 一律回生效值）。
  // [C-pi-13] 约束登记 docs/constraints.json C-pi-13：改状态命令 reply 禁 void、须回 pi 生效值，
  // 新增/修改本区段改状态命令时同口径执行（权威源 ADR-0064）。
  'session.setThinkingLevel': ServerMessageMap['session.thinkingLevelSet']
  'session.subagentAction': void  // reply session.subagentActionDone
  'session.switch': ServerMessageMap['session.switched'] // reply session.switched（R-11 瘦身：无 messages；前端 register<void> 不读 payload）
  'session.workflowAction': void  // reply session.workflowActionDone
  // ── scoped model 域──
  'config.setScopedModels': { scopedModels: string[] }  // reply config.scopedModels（去重保序后结果）
  // ── backgroundTask 域（docs/architecture/background-task-sidebar-view.md §3.3 D3，u-proto）──
  // 三个 RPC 全部 payload 消费型（renderer 读回执字段）；backgroundTask:updated 是 session 级
  // 广播（非 RPC reply），不走本映射——消费侧经 events 通道订阅。
  'backgroundTask.list': ServerMessageMap['backgroundTask.tasks']
  'backgroundTask.output': ServerMessageMap['backgroundTask.outputResult']
  'backgroundTask.kill': ServerMessageMap['backgroundTask.killResult']
  // rollingRestart.status（crash-forensics-and-watchdog §3.3 D5，u7b）：只读查询 reply
  //（payload 消费型；与 request 同名——session.subscribe / backgroundTask.list 同款模式）。
  'rollingRestart.status': ServerMessageMap['rollingRestart.status']

  // terminal.* 都是 ack 型，统一 reply 'terminal.ack'（空 payload，前端 command() 按 id 匹配 resolve）
  'terminal.attach': ServerMessageMap['terminal.ack']
  'terminal.kill': ServerMessageMap['terminal.ack']
  'terminal.resize': ServerMessageMap['terminal.ack']
  'terminal.spawn': ServerMessageMap['terminal.ack']
  'terminal.write': ServerMessageMap['terminal.ack']
}

/**
 * # 错误契约（D10/P0-B）
 *
 * 「告诉客户端操作失败」有三种语义通道，**不可混用**：
 *
 * 1. **请求级失败 → 统一 `error` envelope**（install / uninstall / toggle / file.read /
 *    steer / followUp 等同步请求的失败回复）。客户端只需一处 catch：
 *    `{ type:'error', id, payload:{ code, message, sessionId?, details? } }`。
 *    扩展信息（hint / path 等）进 `details`，不再为每种失败造独立 *Error 子类型。
 *
 * 2. **流式异步推送失败 → `message.error`**（message-dispatcher 在 streaming 过程中广播，
 *    非「请求回复」而是「server-push 通道」）。payload: `{ sessionId, message }`。
 *
 * 3. **部分成功的降级响应 → 内联 `success:false`**
 *    （config.discoveredModels 成功/失败共用同 type 用 `success` 字段区分）。**不是错误**，
 *    是带错误信息的成功响应——保留各自 type，不并入 error envelope。
 *
 * 此前 6 种碎片化形状（extension.installError / file.read:error / ...）已统一：
 * `extension.installError` 和 `file.read:error` type 已删除（客户端 0 消费者时合并）。
 *
 * 领域 DTO（ExtensionInfo / GitStatusResult / PluginInfo / StatusBarItem …）已下沉到
 * extension.ts / git.ts / plugin.ts，本文件顶部 import 引用，ServerMessageMapBase 照常引用。
 */

/**
 * session 级 view-ready 快照 DTO（W13 data-source-governance P2.1，D7 原则）。
 *
 * 单 session 的 owner 权威投影：runtime 侧 state 话题（state_changed/queue_update/
 * commands/context/subagents-类，W12 起）publish 以 owner 数据源为基准（ReplicatedState
 * 实例快照，或事件帧投影——如 queue_update 的 pendingMessageCount，见 message.queue_update
 * 注释，PR #185 MF2 定口径），本 DTO 是这些 payload 的
 * renderer 渲染字段并集——renderer 收到后直接渲染，零 merge/normalize/推导。core
 * createSessionStore.applySnapshot 以此为单 session 快照入参（session store 唯一写入口）。
 *
 * 合并语义 = D1b 整字段覆盖：字段值非 undefined 即覆盖现值，含显式空值（owner 声明空即空）；
 * undefined = 快照未涉及该字段，保留现值。W15 起按来源分流（SessionDataSource）：磁盘扫描
 * 来源快照（source='scan'）的占位空值（modelId:''/tokenCount:0）在 core 合并侧被守卫，
 * 不覆盖已知真值；owner 来源（缺省）显式空值仍正常覆盖——两条空值语义并存不混用。
 *
 * 字段 → runtime 来源对照（W12 后 publish payload）：
 * - label：session.renamed（pi 改名）/ config.sessions（整表 SessionSummary.label）
 * - status：SessionStatus 六态（session.exited → dead 等）
 * - modelId / thinkingLevel：session.state_changed
 * - pendingMessageCount：message.queue_update（帧 = pi 队列深度推送投影，与 get_state 同公式同源，PR #185 MF2 撤销 W8 实例后帧即权威）
 * - commands：session.commands（pi 扩展命令清单，形状与广播 payload 一致）
 * - tokenCount：SessionSummary.tokenCount（磁盘扫描占位值 0，守卫对象）
 *
 * [HISTORICAL] usagePercent/inputTokens/contextLimit 三字段已删（D1 协议收敛，context-consistency
 * Phase 1，2026-08）：state_changed 帧不再携带 usage，context 用量经 context.update 帧直达各自
 * 消费方。session store 注释明证本三字段从不落盘、全库无生产写方——「类型存在、来源已删」的
 * 协议债一并清除（详见 context-consistency-design §3.3 D1）。
 */
export interface SessionViewSnapshot {
  /** session 标签（侧栏列表项 / panel 标题）。 */
  label?: string
  /** 进程三态 + 终态（侧栏状态点 / dead 置灰）。 */
  status?: SessionStatus
  /** 当前模型复合串 "provider/modelId"（Composer 工具条）。 */
  modelId?: string
  /** 思考等级（前端 6 级枚举串）。undefined = 未设置，快照省略不覆盖。 */
  thinkingLevel?: string
  /** 队列深度（steering + followUp 条数和，QueueBubble 计数）。 */
  pendingMessageCount?: number
  /** slash 命令清单（Composer 补全数据源）。 */
  commands?: ServerMessageMap['session.commands']['commands']
  /** 累计 token 数（SessionSummary 同名字段；磁盘扫描占位值 0 是 W15 守卫对象）。 */
  tokenCount?: number
  /**
   * 快照数据来源（W15 守卫判定依据）：'scan' = 磁盘扫描占位快照（modelId/tokenCount
   * 的空值是占位，core mergeViewSnapshot 守卫其不覆盖已知真值）；缺省 = owner
   * （runtime 实例广播 / 乐观更新，D1b 整字段覆盖含显式空值）。
   */
  source?: SessionDataSource
}

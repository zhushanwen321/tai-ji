/**
 * Pi Engine 域 ports —— pi 引擎交互 + 进程池管理。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/rpc-client.ts + process-manager.ts 实现。
 * services 经此与 pi 交互，不直接持有 RpcClient/ProcessManager 具体类。
 *
 * 归属约定（D24 收口）：pi 相关的 port 定义一律在本文件，interfaces.ts 只保留
 * 跨服务 facade 契约。本文件是 pi 引擎 / 进程池接口的唯一权威定义点。
 */

import type { ProviderId } from '@taiji/shared'

/**
 * pi 任意 JSON 响应的逃生类型。
 *
 * pi 的命令响应结构是动态的（get_state/fork/getEntries 各不相同），无法用单一精确类型
 * 描述。services 用 `as PiMessage` 后再 `as` 具体结构——这是「类型系统对 pi 动态响应认输」
 * 的诚实标注，不是协议泄露。
 *
 * 注意：sendCommand/sendRaw 逃生口已从 IPiEngine 删除（W2 收口）。响应归一下沉到
 * RpcClient 内部，services 只消费语义方法（switchSession/getState/sendExtensionUiResponse 等），
 * 不再有「发任意 pi 命令」的能力。
 */
export type PiMessage = unknown

/** pi 事件监听器：接收原始 pi 事件（动态 JSON），由 EventAdapter 翻译成 ServerMessage。 */
export type PiEventListener = (event: PiMessage) => void

/** pi 扩展命令描述（getCommands 返回项）。 */
export interface PiCommandInfo {
  name: string
  description?: string
  source: string
  /** 命令来源元信息（SKILL.md / extension 文件路径等），透传自 pi RpcSlashCommand.sourceInfo。
 *  CommandDocPanel 据此直接读文件渲染，不再依赖 settingsStore.skills 扫描（解决 cwd 错位扫不到项目 skill）。 */
  sourceInfo?: {
    path: string
    source: string
    scope?: string
    origin?: string
    baseDir?: string
  }
}

/**
 * pi compact RPC 返回的压缩结果（agent-session.ts CompactionResult）。
 * dispatcher 用 summary/tokensBefore 广播 message.compactionSummary，
 * 用 estimatedTokensAfter 触发 context.update 刷新用量。
 */
export interface PiCompactionResult {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}

/**
 * pi bash RPC 返回的执行结果（agent-session.ts BashResult）。
 *
 * dispatcher.sendBash 调 client.bash 后读 output/exitCode/cancelled/truncated 广播
 * message.bashResult。fullOutputPath 是 pi 截断后写入磁盘的完整输出文件路径
 * （truncated=true 时有值，前端可按需读取全文）。
 */
export interface PiBashResult {
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
}

/**
 * pi 当前上下文占用估算（get_session_stats.contextUsage）。
 * pi 从 session 历史实时估算，处理了 compaction 边界。
 * tokens=null 表示 compaction 后未跑新 turn，占用未知。
 */
export interface PiContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** pi get_session_stats 响应。contextUsage.tokens=null（compact 后无新 turn）时，
 *  fetchContext 退化用 tokens.total（保留消息的 usage 累加）做近似占用估算。 */
export interface PiSessionStats {
  contextUsage?: PiContextUsage
  /** 所有 assistant 消息 usage 累加（input+output+cacheRead+cacheWrite）。compact 后保留消息少时近似当前占用。 */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

/** pi 进程退出回调。stderr 为 pi 进程尾部输出（诊断信息）。 */
export type PiExitCallback = (sessionId: string, code: number | null, stderr: string) => void

/** 单个 pi 进程退出回调（IPiEngine.onExit 用）。stderr 为 pi 进程尾部输出（诊断信息）。 */
export type PiProcessExitCallback = (code: number | null, stderr: string) => void

/** createSession 的进程启动选项。 */
export interface PiSessionOptions {
  cwd?: string
  provider?: string
  model?: string
  /** 附着恢复模式：true 不拼 --model（含全局默认兜底），模型由 pi 从 model_change entry 恢复。语义见 RpcClientOptions 同名字段。 */
  inheritSessionModel?: boolean
  env?: Record<string, string>
  skillPaths?: string[]
  extensionPaths?: string[]
  /** 替换 pi 核心系统提示词（透传到 RpcClientOptions.systemPrompt → --system-prompt CLI）。 */
  systemPrompt?: string
  /** 追加在 pi 基础系统提示词之后（透传到 RpcClientOptions.appendSystemPrompt → --append-system-prompt CLI）。 */
  appendSystemPrompt?: string
  piCommand?: string
  /** 工具白名单（替换语义），透传到 RpcClientOptions.tools → --tools。 */
  tools?: string[]
  /** 工具黑名单（叠加语义），透传到 RpcClientOptions.excludeTools → --exclude-tools。 */
  excludeTools?: string[]
  /** 禁用所有工具，透传到 RpcClientOptions.noTools → --no-tools。 */
  noTools?: boolean
  /** 禁用所有 skill，透传到 RpcClientOptions.noSkills → --no-skills。 */
  noSkills?: boolean
  /** 禁用 context files，透传到 RpcClientOptions.noContextFiles → --no-context-files。 */
  noContextFiles?: boolean
  /** 覆盖思考级别，透传到 RpcClientOptions.thinkingLevel → --thinking。 */
  /**
   * 档位字符串透传（非空即发）；合法性由上游入口层校验（launch-params
   * resolveEffectiveThinking，词表 = shared PI_THINKING_LEVELS），本层不重复校验。
   * 不可把「pi 会拒绝非法档位」当兜底依赖——pi（1.0.0 复核）对非法 --thinking 仅 push
   * warning diagnostic 并丢弃档位、进程照常以缺省档启动（pi-coding-agent
   * dist/cli/args.js `--thinking` 分支；仅 diagnostics 含 type==="error" 才 exit：dist/main.js）。
   */
  thinkingLevel?: string
}

/**
 * pi 引擎 port —— 每个 session 对应一个实例（RpcClient 实现）。
 *
 * 涵盖「单个 pi 进程的全部能力」：与 pi 的命令通信 + 该进程自身的生命周期
 * （start / kill / onExit / exited）+ session 级命令（compact）。
 *
 * 逃生口已关闭（W2 收口）：sendCommand/sendRaw 不再暴露，响应归一下沉到 RpcClient 内部。
 * 调用方消费语义方法（switchSession/getState/sendExtensionUiResponse 等），不再有「发任意 pi 命令」的能力。
 *
 * RPC 墙钟超时（sendCommand timeout 档位 / prompt timeoutMs 不限时档 /
 * SendCommandOptions maintenance 维护豁免）已随 ADR-0122 防御机制清查退役——
 * pi 对 RPC 永不响应时调用方 promise 悬挂，失败信号归 pi exit/error 事件链。
 */
export interface IPiEngine {
  // ── 命令通信 ──
  /**
   * 发送用户消息。
   *
   * images 是 shared 层图片附件形状（{data;base64;mimeType}，无 pi 私有 type 字段）。
   * 类型组装（补 type:'image'）下沉到 RpcClient 实现内部，本接口只暴露 shared 形状，
   * 保持 pi 私有字段不出 infra 层（AGENTS.md 规则 #5）。undefined/空数组归一化为不传。
   *
   * streamingBehavior 控制 streaming 期间的投递语义：
   * - undefined（默认）：streaming 时抛错（旧行为，MessageDispatcher 等调用方依赖此守卫）
   * - 'steer'：streaming 时入队，turn 边界注入（等价于 pi steer）
   * - 'followUp'：streaming 时入队，run 结束后注入（等价于 pi followUp）
   */
  prompt(content: string, images?: Array<{ data: string; mimeType: string }>, streamingBehavior?: 'steer' | 'followUp'): Promise<PiMessage>
  abort(): Promise<PiMessage>
  steer(content: string): Promise<PiMessage>
  followUp(content: string): Promise<PiMessage>
  setModel(provider: ProviderId, modelId: string): Promise<PiMessage>
  setThinkingLevel(level: string): Promise<PiMessage>
  /**
   * 设置 session 名（set_session_name）——活跃 session label 持久化的唯一写入口
   * （W1 数据源治理：经 pi 落盘 + 广播，taiji 不再直写 session JSONL）。
   * success:false / 超时 reject，失败语义由调用方决定（rename 抛错 / create-fork 降级）。
   */
  setSessionName(name: string): Promise<PiMessage>
  /**
   * 拉取 pi session 的完整 entry 树（get_entries RPC）。
   *
   * 返回全部 entry 类型（message/custom/label/compaction/branch_summary/...），含 parentId
   * 树结构。entry-tree-builder.rebuildHistoryFromEntries 用 message entry + "taiji.client-msg-id"
   * custom entry 重建结构化 Message[]（重开 session 时按 clientUuid ↔ userEntryId 映射回填
   * image/file badge）。
   *
   * since 可选：传 entry id 时返回该 entry 之后的 entry（增量拉取，pi 找不到 since id 会报错）。
   * 返回的 PiMessage.data 已由 sendCommand 归一（data ?? payload），调用方按 GetEntriesResponse 断言。
   */
  getEntries(since?: string): Promise<PiMessage>
  getCommands(): Promise<PiCommandInfo[]>
  /** 查询 pi session 统计（含 contextUsage 上下文占用估算）。用于恢复 session 后拉取当前用量。 */
  getSessionStats(): Promise<PiSessionStats>
  /** 切换 pi 进程到指定 session 文件（restore / fork 用）。 */
  switchSession(sessionPath: string): Promise<void>
  /** 查询 pi session 状态（get_state），返回归一后的 state 对象。 */
  getState(): Promise<Record<string, unknown> | undefined>
  /**
   * 向 pi 发送 extension_ui_response（extension UI / bridge 请求的响应，pi 不回 RPC reply）。
   * 返回 boolean（false = 未写进 pi stdin：进程不在/已退出或写失败）——应答承载用户决策，
   * 调用方须消费 false 走可感知失败路径，不得静默丢弃。
   */
  sendExtensionUiResponse(id: string, response: unknown, method?: string): boolean
  /** 订阅 pi 事件流。返回 unsubscribe。事件由 EventAdapter 翻译，service 一般不直接处理。 */
  onEvent(listener: PiEventListener): () => void

  // ── session 级命令 ──
  /** 压缩当前会话上下文（pi compact 命令）。customInstructions 透传给 pi 压缩 prompt。返回 CompactionResult 供 dispatcher 广播 summary + 刷新 context 用量。 */
  compact(customInstructions?: string): Promise<PiCompactionResult>
  /**
   * 直接执行 bash 命令（pi bash 命令，不经 LLM turn）。
   *
   * excludeFromContext 控制是否进 LLM 上下文：undefined 时不传该参数（走 pi 默认），
   * 显式 true/false 透传给 pi bash RPC。返回 BashResult 供 dispatcher 广播 message.bashResult。
   */
  bash(command: string, excludeFromContext?: boolean): Promise<PiBashResult>
  /** 取消进行中的 bash 执行（pi abort_bash 命令）。 */
  abortBash(): Promise<PiMessage>

  // ── 进程生命周期（本进程自身） ──
  /** 启动 pi 子进程。由 ProcessManager.createSession 内部调用，service 一般不直接调。 */
  start(): Promise<void>
  /** 终止 pi 子进程（SIGKILL 直杀，grace 等待窗已随 ADR-0122 退役）。 */
  kill(): Promise<void>
  /** 注册本进程退出回调。多播（可多订阅者），返回 unsubscribe（与 onEvent 对称）。 */
  onExit(callback: PiProcessExitCallback): () => void
  /** 进程是否已退出。 */
  readonly exited: boolean

  // ── 活动时钟（观测面） ──
  /**
   * 最近一次 pi 双向活动时刻（ms epoch）。
   * 写点（RpcClient 内部）：出站 sendCommand / 入站 handleMessage 全帧。初值 = spawn 时刻。
   * 消费方为观测面（crash 取证「死前最后活动时刻」等）。原空闲回收判定消费
   * （idle-pi-reclamation reaper + touchActivity 手动刷新）已随 ADR-0122 退役。
   */
  readonly lastActivityAt: number
}

/**
 * pi 进程池 port —— session↔pi 绑定（ProcessManager 实现）。
 *
 * services 经此管理 session 的 pi 进程，getClient 返回 IPiEngine 而非 RpcClient。
 * 这是「多进程调度」视角：按 sessionId 查/建/销毁 pi 进程，是 IPiEngine 的集合管理者。
 */
export interface IProcessManager {
  /**
   * 创建并启动一个新的 pi 进程，绑定到 sessionId。返回其 IPiEngine 句柄。
   *
   * pi 会话启动门禁（fail-fast）：settings.json 损坏（getSettingsCorruption 现查命中）
   * 时抛 `code = 'settings_corrupted'` 错误，进程不 spawn——创建/恢复/fork/自动重生/
   * 短命 pi 全部经本方法，单点覆盖；已运行会话不经此入口，不受影响。
   */
  createSession(sessionId: string, cwd: string, options?: PiSessionOptions): Promise<IPiEngine>
  /** 销毁 sessionId 对应的 pi 进程。 */
  destroySession(sessionId: string): Promise<void>
  /** 获取 sessionId 对应的 pi 引擎（不存在返回 undefined）。 */
  getClient(sessionId: string): IPiEngine | undefined
  /** 反查：由 pi 引擎句柄找 sessionId（不存在返回 undefined）。 */
  getSessionIdByClient(client: IPiEngine): string | undefined
  /**
   * W11（数据源治理）：短命 pi 附着指定 session 文件执行一次性 RPC，用后即毁
   * （spawn → switchSession 附着，就绪上限 5s → fn(client) → 销毁）。
   * session JSONL 的唯一写方是 pi——fn 内 RPC（如 setSessionName）由 pi 自身落盘。
   * spawn 失败 / 就绪超时 / fn 抛错一律 rethrow，调用方保留旧值可重试。
   */
  withEphemeralPi<T>(sessionFile: string, fn: (client: IPiEngine) => Promise<T>): Promise<T>
  /** sessionId 是否有活跃的 pi 进程。 */
  hasClient(sessionId: string): boolean
  /** 重绑定：把 oldId 的 pi 进程改挂到 newId（fork / rebind 用）。 */
  rekey(oldId: string, newId: string): void
  /** 注册「任一 session 的进程退出」回调。返回 unsubscribe。 */
  onSessionExit(callback: PiExitCallback): () => void
  /** 销毁全部 pi 进程（关闭时清理用）。 */
  destroyAll(): Promise<void>
  /** 探测 pi 二进制版本（首次 execSync，后续读缓存）。失败返回 'unknown'。 */
  getPiVersion(): Promise<string>
}

/**
 * Session 模块内部共享类型。
 *
 * 叶子模块:仅 `import type`,不引入任何项目内运行时依赖,
 * 因此 interfaces.ts 反向 import 此处的类型不会形成模块环
 * (types.ts ← interfaces.ts 单向)。
 *
 * Facade 内部用完整 ManagedSession(extends IManagedSessionView,
 * 额外持有 adapter 等运行时句柄)。
 * 子模块经内部协议窄接口(ILifecycleSessionOps 等,见 session-internal.ts)
 * 只看到 IManagedSessionView,
 * 但拿到的是 ManagedSession 实例,可读写字段(lastActiveAt / isGenerating)。
 */
import type { ServerMessage, PiMessageEntry, PiToolCallEntryForm } from '@taiji/shared'
import type { SessionManagerAction } from '@zhushanwen/extension-protocol'
import type { ScannedSessionMeta } from '../ports/session.js'

/**
 * SendMessage hook:消息发送前触发,可阻止发送或改写内容。
 *
 * modifiedContent:onBeforeSendMessage 拦截器经 modifiedData 改写后的消息文本
 * （D2-3 transform 语义消费侧出口，01 文档 §3.1 成功路径第 4 步）——消费点
 * （message-dispatcher.sendPrompt）用它替代原文发 pi；blocked 优先级高于改写。
 */
export type SendMessageHook = (
  sessionId: string,
  content: string,
) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>

/** scanPiSessions 返回的元素类型（经 ISessionStore.scanSessions）。 */
export type ScannedSession = ScannedSessionMeta

/**
 * 会话占用状态（session-occupancy-send-closure D3/P3）——三维结构而非单枚举：
 * - turn 三阶段：dispatching（prompt 已发、message_start 未到）→ generating（turn-start..turn-end）
 *   → settling（turn-end..agent-settled，pi post-run 收尾期）；idle 为空档。
 * - compacting / bash 独立布尔（与 turn 各阶段可并存：settling+compacting 是 overflow 收尾常态，
 *   threshold 模式 turn 内自动压缩则 generating+compacting）。
 *
 * wire 形状见 shared protocol.ts 的 'session.occupancy' payload（本形状是其 runtime 侧镜像，
 * 广播帧由 updateSessionOccupancy 按字段展开构造，两处字段名/值域必须保持一致）。
 */
export type SessionTurnPhase = 'idle' | 'dispatching' | 'generating' | 'settling'

export interface SessionOccupancy {
  turn: SessionTurnPhase
  compacting: boolean
  bash: boolean
}

/**
 * ManagedSession 的子模块可见视图(不含运行时句柄)。
 * 子模块经此引用更新 lastActiveAt 等可变字段；isGenerating/isCompacting/isBashRunning
 * 三个忙闲布尔为只读派生存储（session-dead-structural-fixes D2 防回潮，u3c readonly 收紧）——
 * 唯一写点 = applySessionOccupancyTransition 原语（经 SessionOccupancyStateStore 写视图），
 * 类型层 readonly 使绕开原语的直写在编译期红（约束 C-data-19）。
 */
export interface IManagedSessionView {
  id: string
  cwd: string
  label: string
  modelId: string
  createdAt: number
  lastActiveAt: number
  tokenCount: number
  /** 最近一次 agent_end / context.update 的 inputTokens 缓存，供 switchModel 重算用量 */
  inputTokens: number
  /**
   * 生成中派生标志（只读派生存储，D2/u3c readonly）。覆盖 dispatching+generating 两段，
   * 唯一写点 = applySessionOccupancyTransition 的 'dispatching'/'generating'/'settling'/'idle'/
   * 'reject-*'/'full-reset' 等行派生——绕开原语直写编译期红（C-data-19）。
   */
  readonly isGenerating: boolean
  /**
   * compact 进行中标记（W3, U6；只读派生存储，唯一写点 = 原语 'compacting-start'/'compacting-end'
   * /'full-reset' 行派生）。
   *
   * compact 期间 pi 正在做上下文压缩（不开 isGenerating），sendPrompt 的 busy 预检
   * 只看 isGenerating 会让 compact 中途的消息进入 pi.prompt 触发竞态/卡死。
   * 故 compact 用 try/finally 置此标记，sendPrompt 预检同时拒 isGenerating/isCompacting。
   * 与 isGenerating 对称：不进 toSummary（前端状态摘要只看 isGenerating 推 active/idle）。
   */
  readonly isCompacting: boolean
  /**
   * bash 执行进行中标记（composer-bash-execute W1；只读派生存储，唯一写点 = 原语
   * 'bash-start'/'bash-end'/'full-reset' 行派生）。
   *
   * composer 直接执行 bash（pi bash RPC，不经 LLM turn）期间置 true，与 isGenerating/isCompacting
   * 三者互斥（任一为 true 时 sendPrompt/sendBash 都拒）。用 try/finally 置位，finally 复位。
   * 不进 toSummary（前端状态摘要只看 isGenerating 推 active/idle，bash 执行不改变 active/idle 态）。
   */
  readonly isBashRunning: boolean
  /**
   * bash 执行的「代次令牌」（composer-bash-execute W1 竞态守卫，纯运行时态不进 toSummary）。
   *
   * sendBash 每次 await client.bash() 前生成新 token 存入此字段；await 返回后比对 token 是否未变。
   * abortBash 在广播 cancelled bashResult 终态前旋转此 token（清 undefined），标记「已被 abort 抢先收口」。
   * sendBash 检测到 token 变化（!== 自身 token）时静默跳过 bashResult/error 终态广播——
   * 避免与 abortBash 的 cancelled bashResult 撞出双终态（先 cancelled 后真实结果，前端渲染错乱）。
   */
  bashRunToken: string | undefined
  /**
   * pi 侧孤儿 bash 标记（timeout-slow-flow-wallclock D2 + P6 断言④，纯运行时态不进 toSummary）。
   *
   * bash RPC 超时（RpcTimeoutError）后 runtime 已停止等待（isBashRunning 由 finally 复位），
   * 但 D2 语义是「停止等待 ≠ 处决」——pi 侧命令可能仍在跑且照常落盘。置此标记让 abortBash
   * 守卫放行（诚实文案第①步「abortBash 可终止」的 runtime 承诺），否则守卫「runtime 不等待
   * = 无命令在跑」的旧语义会短路早退，abort_bash 永不发出、UI 谎报已取消。
   *
   * 写方：sendBash 超时 catch 置 true；abortBash 的 abort_bash 发出且 pi 确认后清 false。
   * bash 自然结束无法自动清（迟到 response 被 timedOutIds/NULL_EVENTS 丢弃，runtime 无从
   * 得知）——标记残留只导致下次 abortBash 再发一次幂等的 abort_bash（pi 对无 bash 在跑时
   * 无操作正常返回），无害。session 条目删除时随对象一同丢弃（与 pendingBashResults 同区）。
   */
  orphanBashRunning?: boolean
  /**
   * bash 结果待落列（W1 fix-chat-flow-order，D2 双分支镜像 pi）。
   *
   * session 处于 streaming（活跃 run）时，sendBash 收到的 pi bash RPC 结果压入此列
   * （不立即广播）；agent_settled（级联结束，晚于 pi finally flush 的 bash 落盘）到达时由
   * dispatcher.flushPendingBashResults 按序转 message.bashResult 帧发布并清空——taiji live
   * 入流位置构造性对齐 pi 落盘位置（级联末，镜像 pi recordBashResult 的
   * _pendingBashMessages 双分支，agent-session.js:2225-2247）。
   *
   * 唯一写方 = message-dispatcher（sendBash 压入 / flush 发布清空）。挂在本 session 对象上
   * （与 bashRunToken 同区）：session 条目删除（removeSessionEntry）时随对象一同丢弃，
   * 无孤儿残留；flush 信号按 sessionId 定向，跨 session 不误清。
   */
  pendingBashResults?: PendingBashResultData[]
  /**
   * 会话占用状态投影（session-occupancy-send-closure D3/P3）——turn 三阶段 + compacting/bash
   * 三维的权威聚合，唯一写方 = updateSessionOccupancy（幂等写 + 变化才广播 session.occupancy
   * state 帧）。与上方 isGenerating/isCompacting/isBashRunning 同源同点写入（11 挂点见设计
   * D3 转移表），但维度划分不同：isGenerating 覆盖 dispatching+generating 两段，turn 把
   * settling（turn-end..agent-settled 的 pi post-run 窗口）从「空闲」中显式分离。
   *
   * 可选（undefined = idle）：registerSession 显式初始化为 idle；测试 mock 与历史构造点
   * 缺省时由 updateSessionOccupancy 按 idle 兜底合并，不强制所有构造点同步改。
   * 运行时内部状态，不进 toSummary（对外投影只经 session.occupancy state 帧）。
   */
  occupancy?: SessionOccupancy
  thinkingLevel?: string
  sessionFilePath?: string
  /**
   * 隐藏 session（公共 session）：不进 sidebar 列表（scanner listAll 过滤），
   * 仅供内部使用（如 landing 态命令源）。toSummary 透传到 SessionSummary.hidden。
   */
  hidden?: boolean
  /**
   * 父 session 血缘键（FR-2 active 路径回传血缘）。fork 出的 session 在 initializeManagedSession
   * 时写入，toSummary 透传到 SessionSummary.parentSession。源 session 未落盘时用源 sessionId 作
   * fallback（FR-20）。ManagedSession 经 extends 自动继承此字段。
   */
  parentSession?: string
  /** fork 锚点 entry id（FR-2）。toSummary 透传到 SessionSummary.forkEntryId。 */
  forkEntryId?: string
  /**
   * handoff 目标 session id（FR-5 active 路径透传）。
   *
   * 与 scannedToSummary（磁盘路径从 ScannedSessionMeta.handedOffTo 取）对称：toSummary
   * 透传此字段到 SessionSummary.handedOffTo，保持双路径输出一致。ManagedSession 经
   * extends 自动继承此字段。
   *
   * [HISTORICAL] 批 1 时期该字段曾恒 undefined（写入逻辑待批 2 handoff-service 接线）。
   * 现写入链 = handoff-service.runHandoff → markHandedOff（内存态 + W11 起
   * persistHandoffSidecar 写 `.handoff.json` sidecar，原 persistHandedOff 直写 JSONL
   * 已随 W11 删除）。
   */
  handedOffTo?: string
}

/**
 * forceQuit 的调用源分型（session-dead-structural-fixes D4 置位点分型）。
 *
 * 仅「用户要停」的来源置 userStopped 标记：K1（用户强制退出）与 K2（用户 abort 无响应的
 * 超时强杀收口）。K3/K5/K6/K7/K8（restore 清场 / delete / destroyAll / 孤儿收殓 / 异常退出
 * 收敛）不置——pi 崩溃等非用户意图场景不继承「停止」，restore 后 notify replay 属设计内
 * 行为照常补投（设计 §3.3 D4）。
 */
export type ForceQuitSource = 'user_force_quit' | 'abort_timeout'

/**
 * userStopped 标记存取窄接口（session-dead-structural-fixes D4）。
 *
 * 宿主 Map 是 session-service.ts 的模块级独立 Map（sessionId 键控，独立于 ManagedSession
 * 生命周期——forceQuit 尾步 removeSessionEntry 删条目后标记仍可被后续 restore 读到）。
 * 子模块（dispatcher/lifecycle/interpreter 挂点）不直接 import session-service（模块依赖
 * 单向性：session-service 值导入全部子模块，反向 import 成环），统一经 event-interpreter.ts
 * 的 userStoppedGate 门面（configure 注入本接口实现）间接存取。
 *
 * 清理路径全列（设计 §3.3 D4）：restore 收敛消费（主路径，gate 窗满清）/ delete /
 * destroyAll / 进程退出（内存态整体消亡，天然清理）。removeSessionEntry 刻意不清——
 * forceQuit（K1/K2）尾步经过它，标记必须存活到 restore。
 */
export interface UserStoppedMarkStore {
  /** 置标记（forceQuitSession K1/K2 置位分型的唯一写入口）。 */
  markUserStopped(sessionId: string, source: ForceQuitSource): void
  /** 标记是否存活（restoreSession 返回前检测 + 收敛环 agent_start 拦截守卫）。 */
  hasUserStoppedMark(sessionId: string): boolean
  /** 清单条标记（收敛消费 / delete / 显式投递放行经 gate 门面调用）。 */
  clearUserStoppedMark(sessionId: string): void
  /** 清空全部标记（destroyAll shutdown 路径）。 */
  clearAllUserStoppedMarks(): void
}

/**
 * session 忙闲状态的封闭转移枚举（session-dead-structural-fixes D2 转移表，转移表即文档）。
 *
 * 每行的 occupancy 三维 patch 与三布尔派生语义登记在 event-interpreter.ts 的
 * SESSION_OCCUPANCY_TRANSITIONS 表——新增转移必须先在此扩枚举再在表内登记派生，
 * 绕开原语直写三布尔/occupancy 的路径由 u3c readonly 收紧在编译期拦截。
 *
 * 行分组：
 * - turn 四相：dispatching / generating / settling / idle（#1/#2/#3/#4 挂点语义）；
 * - compacting± / bash±：与 turn 正交维度的置位/复位（#5/#6/#7/#11 挂点）；
 * - full-reset：三维全复位（#10 forceQuit/进程退出失败路径腿）；
 * - reject-processing / reject-other：A1 止血的转正（prompt 失败按 pi 拒绝分型收口，
 *   processing → isGenerating=true+generating 以 pi 拒绝为权威信号；其余 → 复位 idle）；
 * - announce-idle：registerSession 宣告帧收编行——强制广播当前投影，跳过全等去重
 *   （Gate B V6b④；内部合并/派生均为 no-op，走 state-topic 通路双腿）；
 * - abort-stall-converged / abort-stall-force-kill：为 fix-subagent-no-notification 分支
 *   abort 三级阶梯预留的两行（D8 对齐点①），本单元只登记枚举与派生定义，挂点接线由
 *   兄弟分支合并方完成。
 */
export type SessionOccupancyTransition =
  | 'dispatching'
  | 'generating'
  | 'settling'
  | 'idle'
  | 'compacting-start'
  | 'compacting-end'
  | 'bash-start'
  | 'bash-end'
  | 'full-reset'
  | 'reject-processing'
  | 'reject-other'
  | 'announce-idle'
  | 'abort-stall-converged'
  | 'abort-stall-force-kill'

/**
 * occupancy 转移原语的写视图（session-dead-structural-fixes D2/u3c readonly 收紧的配套）。
 *
 * IManagedSessionView 的三布尔 readonly 化后，applySessionOccupancyTransition 的内部派生写
 * 需要一个可变视图——本接口即原语内部对 session 记录的最小可写投影（id + occupancy + 三布尔）。
 * readonly 不参与 TS 结构兼容判定，ManagedSession / IManagedSessionView 可直接传入；
 * 原语是三布尔与 occupancy 的唯一合法写点（C-data-19），本接口不得用于原语之外的写路径。
 */
export interface SessionOccupancyStateStore {
  id: string
  occupancy?: SessionOccupancy
  isGenerating: boolean
  isCompacting: boolean
  isBashRunning: boolean
}

/**
 * bash 待落列元素（W1 fix-chat-flow-order）：sendBash 收到 pi bash RPC 结果时构造的
 * message.bashResult payload（除 sessionId 外的全部终态字段）。flush 时原样作为帧
 * payload 发布（emit 只传单个 payload 对象）。timestamp 取 RPC 完成时刻（= pi
 * recordBashResult 落盘时刻），不取 flush 时刻——保证 entry timestamp 两侧一致。
 */
export interface PendingBashResultData {
  command: string
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  excludeFromContext: boolean
  timestamp: number
  fullOutputPath?: string
}

// ── PiTranslatedEvent：infra(event-adapter) → service(interpreter) 中间事件 ──

/**
 * pi 事件经 EventAdapter「纯翻译」后产出的中间事件（R1 重构）。
 *
 * 设计目标：把 event-adapter 从「翻译 + 业务编排混合体」收敛为纯翻译器。
 * adapter 只负责把 pi 原始事件（动态 JSON）翻译为下面这些结构化中间事件，
 * 不做任何副作用（不调 hook、不 diff git、不回写状态、不持有可变态）。
 *
 * 中间事件分两类：
 * 1. `message` —— 纯 WS 帧翻译结果，interpreter 直接转发（无业务处理）。
 * 2. 其余 kind —— 携带「业务编排所需的最小上下文」，interpreter 据此执行副作用：
 *    - hook 触发 / 阻断 / 改写（tool-call-start/end 携带原始 input/output 供 hook 改写后转发）
 *    - file_changes baseline diff（tool-changed / turn-bound）
 *    - context.update / thinkingLevel 回写 session 缓存
 *    - status / bridge / extension-ui 路由到 server
 *
 * 一个 pi 事件可产生多个 translated event（数组返回）。
 * EventAdapter 不 import services 域类型 —— hook 的结构化契约（HookTransform）编码在此，
 * 彻底消除 infra→services 的反向依赖（原 `HookResult` import）。
 */
export type PiTranslatedEvent =
  /** 纯 WS 帧翻译结果，interpreter 直接转发。 */
  | { kind: 'message'; message: ServerMessage }
  /** 无输出（pi 内部记账事件，如 NULL_EVENTS / toolResult 抑制）。 */
  | { kind: 'noop' }
  /** assistant turn 开始（message_start 无 role / 兜底）。interpreter 记 messageId + 推进回合代际（turnGen，W18 帧序三件套）。 */
  | { kind: 'turn-start'; messageId: string }
  /** 工具调用开始 —— interpreter 跑 onBeforeToolCall hook（可阻断/改写 input）后产出 tool_call_start。 */
  | {
      kind: 'tool-call-start'
      toolCallId: string
      toolName: string
      input: unknown
      /**
       * [W21] toolCall entry 形态（实时 feed 权威载体，event-adapter 翻译时重构）。
       * interpreter hook 改写 input 后同步回 entry.arguments，WS 帧 payload 只发 entry；
       * contentIndex/messageId 锚点由 interpreter 从缓存补进。平铺字段保留供 hook 上下文消费。
       */
      entry: PiToolCallEntryForm
    }
  /**
   * toolCall 产出顺序锚点（pi toolcall_start，模型输出 tool_use 时，带 contentIndex）。
   * interpreter 缓存 toolCallId → contentIndex，tool-call-start 到达时附到 tool_call_start WS 帧，
   * 前端按 contentIndex 有序插入 contentBlocks（§11 检查点 3：两条填充路径统一顺序语义）。
   */
  | { kind: 'tool-call-index'; toolCallId: string; contentIndex: number }
  /** 工具调用结束 —— interpreter 跑 onAfterToolResult hook（改写 output）+ 触发 file_changes diff。 */
  | {
      kind: 'tool-call-end'
      toolCallId: string
      output: string
      /** 原始文本（含 ANSI 转义），output 已 stripAnsi。有 ANSI 时 outputRaw !== output。 */
      outputRaw?: string
      details: Record<string, unknown> | undefined
      images: Array<{ data: string; mimeType: string }> | undefined
      toolName: string
      isError: boolean
      /**
       * [W21] toolResult message entry 形态（实时 feed 权威载体，event-adapter 翻译时重构，
       * 与 pi 持久化 toolResult entry 同构）。interpreter hook 改写 output 后同步回
       * entry.message.content，WS 帧 payload 只发 entry。平铺字段保留供 hook 上下文与
       * subagent/workflow 编排消费。
       */
      entry: PiMessageEntry
    }
  /** turn 结束（agent_end）—— interpreter 触发 context.update 回写 + file_changes ready diff（排 diff 链尾）+ hook。 */
  | {
      kind: 'turn-end'
      message: ServerMessage
      inputTokens?: number
      totalTokens?: number
      stopReason?: string
      usage?: { input?: number; output?: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number }
    }
  /**
   * 单 turn 用量更新（pi turn_end）—— 只回写 context.update，不转发 message.complete。
   * 与 turn-end（agent_end）的区别：pi 0.80.3 一个 agent 循环含 N 个 turn，每个 turn_end 带 usage；
   * 若每 turn 都走 turn-end 路径会触发 message.complete → 前端 setStreaming(false) 闪烁。
   * 故 turn_end 走本 kind，仅刷新用量数字；message.complete 仍由 agent_end（turn-end）独占。
   *
   * composer-gen-stats（D1）：扩展字段全来自 turn_end.message 的 AssistantMessage 自带结构
   * （output/cacheRead/cacheWrite/input/model/provider），event-adapter 缺省补 null（禁 ?? 0，
   * 无值编码纪律 D4）——interpreter 组装 GenStatsSample 调 onGenStats 采样。
   * 结构与通路已锚定 PS-25（docs/pi-semantics.json，探针 pi-semantics-turn-usage-model）：
   * turn_end.message 恒为完整 AssistantMessage（正常 = streamAssistantResponse 产物，失败 =
   * handleRunFailure 合成 failureMessage + EMPTY_USAGE，后者被下方 totalTokens gate 丢弃），
   * RPC 原样下发不裁剪 model/provider/usage。
   */
  | {
      kind: 'turn-usage'
      sessionId: string
      inputTokens: number
      totalTokens: number
      /** gen-stats：本 turn 真实 output（usage.output，缺省 null） */
      outputTokens: number | null
      /** gen-stats：prompt 缓存读（usage.cacheRead，缺省 null） */
      cacheRead: number | null
      /** gen-stats：prompt 缓存写（usage.cacheWrite，缺省 null） */
      cacheWrite: number | null
      /** gen-stats：本 turn 增量 input（usage.input，缺省 null） */
      input: number | null
      /**
       * gen-stats：样本模型 id（PS-25：AssistantMessage.model = 请求侧 model.id，即用户选择/
       * 会话当前模型，必填恒有；非 responseModel——那是 provider 实际报告的响应模型，仅
       * openai-completions 在路由结果 ≠ 请求 id 时才有，多数 provider 恒缺，不采）。缺省 null
       * 仅防御异常通路（类型层必填）。
       */
      model: string | null
      /** gen-stats：样本 provider（AssistantMessage.provider = 请求侧 model.provider，PS-25 锚定，缺省 null 同上） */
      provider: string | null
    }
  /** extension setStatus —— interpreter 路由到 server.handleStatusSetUpdate + 转发 WS。 */
  | { kind: 'status-set'; sessionId: string; key: string; text: string; textRaw?: string }
  /** extension setStatus 对应的 WS 帧（interpreter 转发）。 */
  | { kind: 'status-broadcast'; message: ServerMessage }
  /** bridge:* 前缀请求 —— interpreter 路由到 server.handleBridgeRequest。 */
  | { kind: 'bridge-ui'; requestId: string; sessionId: string; method: string; data: Record<string, unknown> }
  /** 交互式 extension_ui_request（confirm/select/input/notify/editor）—— interpreter 注册超时。 */
  | { kind: 'extension-ui'; requestId: string; sessionId: string; method: string; payload: Record<string, unknown> }
  /** session-manager 请求（select + SESSION_MANAGER_MARKER）—— interpreter fire-and-forget 路由到 SessionManagerHandler。 */
  | { kind: 'session-manager-ui'; requestId: string; sessionId: string; action: SessionManagerAction | '__malformed__'; params: Record<string, unknown> }
  /** thinking_level_changed —— interpreter 回写 session 缓存（与 session.thinkingLevelSet WS 帧成对）。 */
  | { kind: 'thinking-level'; level: string | undefined }
  /** session_info_changed —— interpreter 回写 session label 缓存（与 session.renamed WS 帧成对）。 */
  | { kind: 'session-renamed'; name: string | undefined }
  /** 触发 plugin hook（agent_start / tool_execution_* / agent_end 等观测事件）—— interpreter 调 pluginService.executeHooks。 */
  | { kind: 'hook'; eventType: string; data: Record<string, unknown> }
  /**
   * subagent 逐字 streaming（路径 A-1）—— 扩展层合并 text_delta 后经 setWidget("subagent-stream-<id>") 转发。
   * interpreter 转成 subagent.stream_delta WS 帧 → 前端 applyStreamDelta 增量更新虚拟 session。
   * lines 是累积全文（split('\n')），undefined = subagent 终态清除（setWidget(key, undefined)）。
   */
  | { kind: 'subagent-stream'; sessionId: string; recordId: string; lines: string[] | undefined }
  /**
   * 自描述 record entry 到达的失效信号（W18，D4）——pi entry_appended（extension appendEntry
   * 路径，message entry 不发射）经 adapter customType 过滤后仅对 subagent-record / workflow-record /
   * plan-state 产出（第三员为 plan 模式重设计 D1② 扩容）。interpreter 据此触发
   * onRecordEntriesInvalidated（组合根注入 sessionService
   * .invalidateRecordEntries：markDirty → 防抖 get_entries(since) 增量重拉 → entry 扫描写入
   * 派生缓存）。事件 payload 不进任何数据缓存（ReplicatedState「事件只做失效」不变量）。
   */
  | { kind: 'record-entry-appended'; customType: 'subagent-record' | 'workflow-record' | 'plan-state' }
  /**
   * compaction 生命周期开始（pi compaction_start{reason}）—— interpreter 编排：
   * 广播 session.compacting{reason} + isCompacting 置位经 occupancy 转移原语
   * 'compacting-start' 行（isCompacting 派生 + occupancy 合并 + state 帧广播原子完成）。
   * onCompactingStateChange 回调通道为「与原语 compacting± 行幂等的冗余通道，勿新增使用」
   * （u3c 裁决：与 interpreter 内 onOccupancyTransition 通道汇入同一原语行，保留仅因
   * 删除牵连组合根接线与存量测试断言的接口级变更超收口单元领地——新挂点一律走
   * onOccupancyTransition 通道）。
   * reason 驱动前端文案区分手动（'manual'）/自动（'threshold'|'overflow'）。
   */
  | { kind: 'compaction-start'; reason: string }
  /**
   * run 级联结束（pi agent_settled，W1 fix-chat-flow-order 探针 ②）——晚于 pi
   * _runAgentPrompt finally 的 _flushPendingBashMessages（agent-session.js:744-756，
   * streaming 期间缓存的 bash entry 已统一落盘）。interpreter 据此触发
   * onAgentSettled（组合根注入 sessionService.flushPendingBashResults：dispatcher 的
   * per-session bash 待落列按序转 message.bashResult 帧发布——taiji live 入流位置
   * 构造性对齐 pi 落盘位置）。与 turn-end（agent_end）的区别：followUp drain 续跑
   * 在同一次 settled 级联内，agent_end 非级联边界。
   */
  | { kind: 'agent-settled' }
  /**
   * compaction 生命周期结束（pi compaction_end）—— interpreter 唯一驱动 compaction 全部前端态：
   * - result 真值（成功）→ message.compactionSummary + applyContextUpdate + session.compacted + 复位 isCompacting
   * - 无 errorMessage 真值（aborted）→ session.compacted（不带 error，前端 flush queue）+ 复位
   * - errorMessage 真值（failed）→ session.compacted{error} + message.error 对话流提示 + 复位
   *
   * 失败判据以 errorMessage 真值为准（非 aborted 字段、非 key 存在性）—— pi 三种 aborted:true
   * 形态在 errorMessage 真值层面一致（都 falsy）。result 类型暂 unknown（M5 契约清理时收紧，CQ1——事件路径宽松形状 PiCompactionResult 在 infra/pi/pi-protocol，services/session import 会违分层）。
   * 孤儿 end 容错：overflow 早退路径无 preceding start，end handler 复位对「本来就 false 的 isCompacting」幂等无害。
   */
  | { kind: 'compaction-end'; reason: string; result?: unknown; aborted: boolean; errorMessage?: string }
  /**
   * session-trace 增量腿触发信号（design D4 / A33）—— pi 无「每次 append 都广播」的 entry
   * 事件，改用现存事件作触发：message_end / agent_settled / entry_appended（pi 原始事件名）
   * 到达 → interpreter 调 onTraceSync 回调（sessionService.syncTraceEntries：get_entries(since)
   * 追赶式拉 delta → 广播 session.traceEntryAppended）。compaction_end 走 compaction-end kind，
   * 在其 handler 内同调 onTraceSync（四类触发信号的第四类）。
   */
  | { kind: 'trace-trigger'; trigger: 'message_end' | 'agent_settled' | 'entry_appended' }
  /**
   * 送达水位对账触发信号（reload-closeout D2）—— agent_settled（run 级联结束）到达 →
   * interpreter 调 onRecordReconcile 回调（sessionService.reconcileRecordEntries：重跑
   * fetch→merge→publish 管线，发布门 = 已发布快照水位，diff 非空补发——守卫/发布门处
   * 曾丢的帧下轮触发必补发）。组合注册追加（withRecordReconcileTrigger，照抄
   * trace-trigger 先例），只由 agent_settled 产出。
   */
  | { kind: 'record-reconcile-trigger' }


/**
 * composer-gen-stats（D1/D2）turn-usage 携带的生成指标样本（interpreter 组装 → onGenStats →
 * GenStatsService.recordSample）。字段缺省一律 null（无值编码纪律 D4，禁 ?? 0——null 由
 * service 侧逐字段判定丢弃语义，0 只允许作为真实测量值出现）。
 */
export interface GenStatsSample {
  /** 本 turn 真实 output（usage.output，缺省 null） */
  outputTokens: number | null
  /** LLM 请求窗口：assistant message_start → assistant message_end 本地时钟差（不含工具执行时间；
   * 真缺闭/缺起（pi 崩溃断连 / runtime
   * 中途启动丢 message_start）→ null，速度样本跳过） */
  durationMs: number | null
  /** 样本模型 id（AssistantMessage.model 运行时字段，缺省 null；D2 探针待验证真实性） */
  model: string | null
  /** 样本 provider（AssistantMessage.provider 运行时字段，缺省 null） */
  provider: string | null
  /** 本 turn 增量 input（usage.input，缺省 null） */
  input: number | null
  /** prompt 缓存读（usage.cacheRead，缺省 null；D7③ service 侧按 0 计入 promptTotal） */
  cacheRead: number | null
  /** prompt 缓存写（usage.cacheWrite，缺省 null） */
  cacheWrite: number | null
}

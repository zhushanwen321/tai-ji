/**
 * MessageDispatcher — 从 session-service 巨石拆出的消息派发职责。
 *
 * 负责:sendMessage / abort / steerMessage / followUpMessage / compact +
 * sendMessageHook 注册。
 *
 * sendMessage 经 sendPrompt 骨架(hook 拦截 → ensureActive → 标记活跃 → prompt)。
 * [occupancy D2 拒绝转译] pi busy 类确定性拒绝(manual 压缩 / auto 压缩+post-run)经
 * classifyPromptRejection 识别转译为 send.rejected{reason:'compacting'|'processing'},
 * 不进 message.error 错误气泡;busy 预检按命中维度分型(isCompacting → 'compacting')。
 * [HISTORICAL] sendSubagentMessage(marker 拼装分支)已删除(composer 四符号设计 D2)——
 * 定向消息改走 session-service.subagentAction 直发 client.prompt,不经本骨架。
 *
 * 依赖经构造注入:svc(dispatcher 窄接口 IDispatcherSessionOps,按消费者收窄——
 * 调用点实测 6 方法,见 session-internal.ts)、
 * pm(getClient / 进程操作)、messageBus(发布,wave:perf-w09 接口收敛——
 * dispatcher 只依赖 publish 抽象,broker 依赖已删除:命令编排消息全部是
 * session 级 push 型,单通道走 bus 定向发布,broadcast 双写腿已收口)。
 */
import type { IDispatcherSessionOps } from './session-internal.js'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import type { SendMessageHook, PendingBashResultData, IManagedSessionView, ForceQuitSource } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { toErrorMessage, RpcTimeoutError } from '../../utils/errors.js'
import { applySessionOccupancyTransition, IDLE_SESSION_OCCUPANCY, userStoppedGate } from './event-interpreter.js'
import { SkillInjector, type SkillNotice } from './skill-injector.js'
import { publishSkillNotices as publishSkillNoticesShared } from './skill-notice-publisher.js'
import { AbortLiveness } from './abort-liveness.js'
import type { AbortSource } from './abort-liveness.js'

// abort 阶梯协作类（test-infra-source-simplify T5 抽离）：三级阶梯 + 防重入 + 处置竞态
// 独立单元在 abort-liveness.ts，本模块持实例并委托；符号 re-export 保持原公开面
// （abort-liveness 测试与既有 import 方零改动）。
export { resetAbortLivenessForTest, type AbortSource } from './abort-liveness.js'

/** 生成代次 token 用的进制（base-36：数字 + 小写字母，紧凑且无符号字符）。 */
const RANDOM_TOKEN_RADIX = 36
/** Math.random().toString(N) 返回形如 "0.xxxx"，跳过前导 "0." 取随机段。 */
const RANDOM_TOKEN_SLICE_START = 2

/**
 * bash RPC 返回值的 services 层内部类型（翻译层标准做法）：字段与 ports/pi-engine 的
 * pi bash 结果逐字段一致（output / exitCode: number | undefined / cancelled / truncated /
 * fullOutputPath?）。PiXxx 命名只许 infra/pi 内部使用（三层设计边界规则，C-comm-02），
 * services 层以结构化本地类型承接 ports 返回值——结构化兼容，直接赋值无需断言。
 */
interface InternalBashResult {
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
}

/**
 * 时长换算系数（命名对齐 dialog-queue 惯例）：formatTimeoutDuration 的整时折算用，
 * 是纯单位换算（ms/秒、ms/分、ms/时）而非业务超时值——业务超时链值域 SSOT 在
 * packages/shared/src/timeouts.ts，两者语义不同禁止混用。
 */
const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

/**
 * 超时时长的人类可读格式（诚实文案用）：整小时/整分钟取整表述，其余折算秒。
 * env 逃生门可把 bash RPC 超时调成任意值，文案必须如实反映实际等待上限（timeout-slow-flow-wallclock D2）。
 */
function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs >= MS_PER_HOUR && timeoutMs % MS_PER_HOUR === 0) return `${timeoutMs / MS_PER_HOUR} 小时`
  if (timeoutMs >= MS_PER_MINUTE && timeoutMs % MS_PER_MINUTE === 0) return `${timeoutMs / MS_PER_MINUTE} 分钟`
  return `${Math.round(timeoutMs / MS_PER_SECOND)} 秒`
}

/**
 * bash RPC 超时的合成终态诚实文案（§5.2 样例 6 三步恢复指引）。
 *
 * 设计要点：超时是「停止等待」不是「处决命令」——pi 侧命令可能仍在后台运行且照常落盘，
 * 文案必须诚实告知这一事实 + 给出可操作出路（取消 / 重开查结果 / 先取消再重跑），
 * 取代旧「[bash error] RPC ... timed out」的技术性误导措辞（用户误以为命令失败）。
 */
function buildBashTimeoutOutput(timeoutMs: number): string {
  return [
    `命令执行超过 ${formatTimeoutDuration(timeoutMs)}，已停止等待——命令可能仍在后台运行。`,
    '① 点 bash 气泡的取消（abortBash）可终止它；',
    '② 等它自然结束后，重开本 session 可在历史记录中看到完整结果；',
    '③ 需要立即重跑请先取消再发送。',
  ].join('\n')
}

/**
 * 生成短随机字符串，用作 sendBash / abortBash 的代次令牌后缀。
 * 与 `Date.now()` 拼接保证唯一性，比对即可判定是否被抢收口。
 */
function randomTokenSuffix(): string {
  return Math.random().toString(RANDOM_TOKEN_RADIX).slice(RANDOM_TOKEN_SLICE_START)
}

/**
 * pi prompt() 确定性拒绝的错误原文（session-occupancy-send-closure D2 转译识别依据）。
 * 字符串受 pi-semantics PS-22 / PS-23 探针锁守卫（pi 版本 bump 时探针红 = 文案漂移，须同步此处）。
 */
const PI_REJECTION_COMPACTING = 'Cannot submit a prompt while compaction is in progress'
const PI_REJECTION_PROCESSING = 'Agent is already processing'

/** send.rejected 拒绝提示文案（人类可读中文，renderer toast 用；P1 阶段 'compacting' 会入队）。 */
const REJECT_MESSAGE_COMPACTING = '压缩进行中，消息将自动排队'
const REJECT_MESSAGE_BUSY = 'Agent 正在处理'

export type PromptRejectionReason = 'compacting' | 'processing'

/**
 * 识别 pi prompt() 的 busy 类确定性拒绝（按错误消息原文），输出转译 reason；非 busy 类返回 null。
 *
 * 两个拒绝分支（pi 0.84.4 agent-session.js prompt()）：
 * - manual 压缩中：`_compactionAbortController` 置位窗口 throw "Cannot submit a prompt while
 *   compaction is in progress..." → 'compacting'
 * - auto 压缩 / post-run settling 窗口：isStreaming getter（含 post-run）为 true 且无
 *   streamingBehavior 时 throw "Agent is already processing..." → 'processing'
 *
 * 独立小函数（非内联）：单测直测映射表 + 未来探针/调用方复用。
 */
export function classifyPromptRejection(errorMessage: string): PromptRejectionReason | null {
  if (errorMessage.includes(PI_REJECTION_COMPACTING)) return 'compacting'
  if (errorMessage.includes(PI_REJECTION_PROCESSING)) return 'processing'
  return null
}

export class MessageDispatcher {
  private sendMessageHook: SendMessageHook | null = null

  /**
   * abort 阶梯协作实例（W7 三级阶梯 + 防重入 + 处置竞态，实现见 abort-liveness.ts）。
   * deps 回调经宿主转发：publish 动态读 this.messageBus（setMessageBus 后置注入后仍正确），
   * forceQuitSession 复用宿主编排（与 forceQuit 入口共用同一条收敛链）。
   */
  private readonly abortLiveness: AbortLiveness

  constructor(
    private readonly svc: IDispatcherSessionOps,
    private readonly pm: IProcessManager,
    private readonly workspaceService: WorkspaceService,
    private messageBus?: IMessageBus,
    // [composer-multi-skill-injection D9] skill 注入器：三入口统一调用（hook 之后、
    // client 发送之前）；构造注入便于测试替换 spy（每入口恰好单次调用的结构化幂等）。
    private readonly injector: SkillInjector = new SkillInjector(),
  ) {
    this.abortLiveness = new AbortLiveness({
      getClient: (sessionId) => this.pm.getClient(sessionId),
      persistSessionOutcome: (sessionId, outcome, reason) => this.svc.persistSessionOutcome(sessionId, outcome, reason),
      publish: (sessionId, msg) => this.messageBus?.publish(sessionId, msg),
      forceQuitSession: (sessionId, outcomeReason, exitReason, source) =>
        this.forceQuitSession(sessionId, outcomeReason, exitReason, source),
    })
  }

  /**
   * 后置注入 / 回填 MessageBus（SessionService.setMessageBus 同步回填调用）。
   *
   * bus 的两条注入通道：①构造参数（index.ts 构造 SessionService 时传导）；
   * ②SessionService.setMessageBus 后置注入路径——该路径下 dispatcher 已构造（bus 为
   * undefined），必须回填，否则全部 session 级发布静默 no-op（null-safe 但消息丢失）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
  }

  /** 注册消息发送前 hook(PluginService 调用,实现 beforeSend 拦截)。 */
  setSendMessageHook(hook: SendMessageHook): void {
    this.sendMessageHook = hook
  }

  /**
   * 返回 { blocked: true } 表示消息被 BeforeSend hook 拦截（已广播 message.error 错误气泡），
   * 调用方（session-message-handler）必须据此走 error envelope（带请求 id）让 renderer
   * pending.reject，不得 reply success（round7 must-fix #3：避免「composer 清空 + 错误气泡」矛盾态）。
   */
  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>, clientUuid?: string): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.sendPrompt(sessionId, content, images, clientUuid)
  }

  /**
   * sendMessage 的发送骨架。
   * @param sessionId    会话 id
   * @param hookContent  hook 审核的文本(用户原文)
   * @param images       shared 形状图片附件（{data;mimeType}），透传给 client.prompt。
   *                     undefined 时不传 images，走原路径。
   * @param clientUuid   客户端幂等 id（message.send RPC 透传，session-occupancy-send-closure D2）。
   *                     拒绝广播（预检与 catch 转译两路）原样带回，renderer 据此消歧发送来源
   *                     （flush 重放的拒绝不重入队）；正常路径不消费。
   */
  private async sendPrompt(
    sessionId: string,
    hookContent: string,
    images?: Array<{ data: string; mimeType: string }>,
    clientUuid?: string,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    // ── dispatcher 入口同步 touch（idle-pi-reclamation D6-1，任何 await 之前）──
    // markSessionActive 置 occupancy=dispatching 位于 await runBeforeSendHook（插件
    // hook，单 handler 5s 超时）与 await ensureActiveOrBroadcast（restore 600ms-3s）
    // 之后——若不入口 touch，「prompt 已发出、hook/restore 执行中」窗口内空闲回收
    // 判定满足阈值会误回收在途 session。client 未附着（已回收态）时无需 touch：
    // restore spawn 的新 client lastActivityAt 初值 = spawn 时刻，空闲时长天然不达标。
    const attachedClient = this.pm.getClient(sessionId)
    if (attachedClient) {
      attachedClient.touchActivity()
    }

    // ── BeforeSend hook ──
    // blocked: 已广播 message.error（错误气泡），此处返回 {blocked:true} 让 handler 改发 error envelope。
    // modifiedContent: hook 改写后的文本（transform 语义，Fix-1），未改写时回退原文。
    const hookOutcome = await this.runBeforeSendHook(sessionId, hookContent)
    if (hookOutcome.blocked) {
      return { blocked: true }
    }

    // D4 显式投递清标记：经 runtime sendPrompt 的投递（用户新消息 / 前端队列 flush 重放）
    // = 新意图，投递前清 userStopped 标记放行 + 停收敛环——新 turn 是显式意图，不受任何
    // 闸门拦截。时序构造性保证：清标记先于 ensureActive/restore（restore-abort 读不到标记
    // 即不掐），也先于 client.prompt（显式投递开 turn 的 agent_start 事件回流时环已停，
    // 不会被收敛环误掐）。不经 runtime 的补发腿（notify-ledger）不适用本放行——区分点 =
    // 投递路径本身。
    userStoppedGate.consumeForExplicitDelivery(sessionId)

    // ── ensureActive(必要时 restore)──
    const client = await this.ensureActiveOrBroadcast(sessionId)

    // ── 标记活跃 + 生成中（busy 预检拒绝时中止）──
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      if (this.rejectBusyPrecheck(sessionId, activeSession, clientUuid)) {
        return { blocked: true, rejected: true }
      }
      this.markSessionActive(activeSession, sessionId)
    }
    // ── 发送 prompt + 错误广播 ──
    const promptText = hookOutcome.modifiedContent ?? hookContent
    // [composer-multi-skill-injection D9] 注入器：BeforeSend hook 之后、client.prompt 之前
    // 统一处理（展开 / 预检降级 / 失效透传）。hook 审核的是用户原文，注入器处理改写后文本；
    // hook 若破坏标记完整性，注入器内部走残缺透传 + notice（D8）。每入口恰好单次调用。
    const injection = await this.injector.inject(client, promptText)
    try {
      await client.prompt(injection.text, images)
    } catch (e) {
      return this.handlePromptFailure(sessionId, activeSession, clientUuid, e)
    }
    // [D6/D8] 发送成功后才发布 skillNotice：消息已真正入队，提示描述的注入形态才成立；
    // prompt 失败路径不发（handlePromptFailure 的 message.error 已覆盖用户可见错误）。
    this.publishSkillNotices(sessionId, promptText, injection.notices)
    return { blocked: false }
  }

  /**
   * ensureActive(必要时 restore)骨架：失败时补广播 message.error 后原样 rethrow。
   *
   * 补广播 message.error：让已订阅 session 通道的前端能在聊天流看到错误气泡。
   * 之前只靠 server.ts 外层 handler_error envelope（走 pending.reject，不进聊天流），
   * 导致 ensureActive 失败（如 pi 进程已死、restore 再 spawn 再 exit）时用户在对话流看不到错误。
   */
  private async ensureActiveOrBroadcast(sessionId: string): Promise<IPiEngine> {
    try {
      return await this.svc.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${toErrorMessage(e)}`
      console.error(`[message-dispatcher] ${errMsg}`)
      const msg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.messageBus?.publish(sessionId, msg)
      throw e
    }
  }

  /**
   * [D-009 预检] busy 预检拒绝（send.rejected 已广播，返回 true 调用方中止发送，不调 pi.prompt）。
   *
   * [W3, U6] 加 isCompacting：compact 进行中时 prompt 会与压缩竞态，同样必须拒。
   * [composer-bash-execute W1] 加 isBashRunning：bash 执行中 prompt 会与 bash 竞态，双向互斥。
   * [session-dead-structural-fixes D2 预检改读 occupancy（u3b settling 预检裁决）] 预检门
   * 改读 occupancy 投影（occupancy 为体，D1 立场）：turn !== 'idle'（dispatching/generating/
   * **settling**）/ compacting / bash 任一命中即拒——settling 自此计为忙（与前端 D1 双门归一），
   * 拒绝转 send.rejected{busy} → 消息入 defer 队列 → agent_settled idle 帧自动投递。这是
   * D2 显式声明的行为变更（原 settling 窗口直发成功的消息现在延迟 ≤2s 投递，P-2 探针门
   * P95 ≤ 2s）。occupancy 与三布尔经原语原子同步，缺省（undefined）按 idle 兜底。
   */
  private rejectBusyPrecheck(
    sessionId: string,
    activeSession: IManagedSessionView,
    clientUuid: string | undefined,
  ): boolean {
    const occ = activeSession.occupancy ?? IDLE_SESSION_OCCUPANCY
    if (occ.turn !== 'idle' || occ.compacting || occ.bash) {
      const reason = occ.compacting ? ('compacting' as const) : ('busy' as const)
      console.warn(`[message-dispatcher] preemptive reject (${reason}), sid=${sessionId}`)
      this.publishSendRejected(sessionId, reason, clientUuid)
      return true
    }
    return false
  }

  /**
   * 预检通过后的活跃标记：occupancy #1 'dispatching' 转移（原语派生 isGenerating=true）+
   * workspace record best-effort 副作用。
   *
   * occupancy #1（D2 迁移）：sendPrompt 预检通过 → 'dispatching'（prompt 已发、message_start
   * 未到）。isGenerating=true 由原语 flags 原子派生（不再直写布尔）。本挂点先于 client.prompt
   * ——pi busy 类拒绝（catch 转译）发生时 turn 已处于 dispatching，由 #8 按拒绝分型收口：
   * processing 拒绝（pi 有 runtime 不知情的 turn 在跑）→ 'reject-processing'，compacting 拒绝
   * 与非 busy 真失败 → 'reject-other'（见 handlePromptFailure 注释）。
   */
  private markSessionActive(activeSession: IManagedSessionView, sessionId: string): void {
    activeSession.lastActiveAt = Date.now()
    applySessionOccupancyTransition(activeSession, this.messageBus, 'dispatching')
    // [W6] record 是非用户阻塞的副作用（记最近工作区），不应阻断发消息主流程。
    // 当前 record 同步链路（WorkspaceService.record → store.record → cache.set/trim）几乎不抛，
    // 但作为防御：未来 store 实现变更（如引入 sync flush）或 lazy partition 加载异常都不该让
    // session 卡在「生成中」。包 try/catch：失败仅 warn，isGenerating 已置 true 不回退，pi.prompt 照常执行。
    try {
      this.workspaceService.record(activeSession.cwd)
    } catch (e) {
      // best-effort 降级：record 是非用户阻塞的副作用，失败仅 warn 不传播——
      // isGenerating 已置 true 不回退，pi.prompt 照常执行（见上方 W6 说明）。
      console.warn('[message-dispatcher] workspace.record failed (non-blocking), sid=',
        sessionId, e instanceof Error ? e.message : e)
    }
  }

  /**
   * prompt 失败收口（catch 体整体，恒 blocked）：按拒绝分型收口 isGenerating + occupancy →
   * pi busy 类确定性拒绝转译 send.rejected 分型广播；其余错误广播 message.error。
   *
   * [occupancy D2b] 复位语义按 classifyPromptRejection 分型分叉（不再无条件回 idle）：
   * - 'processing'：pi 明确拒绝「已有一个 turn 在跑」——该 turn 由 pi 自发起（auto-retry /
   *   steer / followUp），runtime 此前已收 agent_end 复位 isGenerating（幽灵空闲）故预检放行。
   *   此时以 pi 的拒绝为权威信号反转状态：置 isGenerating=true + turn:'generating'。
   *   若仍写 idle（改动前行为）：前端 occupancy 投影为 idle → D1 占用短路失效 → defer 队列
   *   1 秒一次无限重投（实测 90 秒 82 次 `prompt failed: ... Agent is already processing`）。
   * - 'compacting' / 非 busy 真失败：turn 确实没跑起来 → isGenerating=false + turn:'idle'（现状）。
   */
  private handlePromptFailure(
    sessionId: string,
    activeSession: IManagedSessionView | undefined,
    clientUuid: string | undefined,
    e: unknown,
  ): { blocked: true; rejected?: boolean } {
    const errMsg = toErrorMessage(e)
    console.error(`[message-dispatcher] prompt failed: sessionId=${sessionId}`, errMsg)
    // [occupancy D2 拒绝转译] pi busy 类确定性拒绝分型：决定下方复位语义，并广播
    // send.rejected（不走 message.error 错误气泡链路——busy 类不进对话流；非 busy 的 pi
    // 错误保留现状）。返回 rejected:true 与预检拒绝同构：handler 回 message.status{rejected}
    // 让 renderer pending 干净 resolve（send.rejected 兜底已接管用户反馈；error envelope
    // 会让 pending.reject 恢复草稿，与入队/回滚流程冲突）。
    const rejectionReason = classifyPromptRejection(errMsg)
    if (activeSession) {
      // occupancy #8（D2 迁移）：prompt 抛错 → turn 收口。核实：#1 已先于 client.prompt 置
      // dispatching，故两个分支都必须写终态，否则 turn 永卡 dispatching、occupancy 永不全
      // idle（P3 起 renderer flush 触发条件，G2 投递必达被破坏）。
      if (rejectionReason === 'processing') {
        // pi 侧 turn 正在跑（runtime 之前误判空闲），拒绝的语义不是「turn 没跑起来」——
        // 以 pi 的拒绝为权威信号反推状态（'reject-processing' 行：派生 isGenerating=true +
        // turn='generating'），让前端 D1 占用短路生效、defer 队列停止重投（本挂点不再伪造空闲）。
        // [session-dead 2026-09-10 已收口] 复位依赖该 turn 正常收尾——但**不能只靠 agent_end**：
        // pi 实装里 agent_end 每次 attempt 都发（retry / auto-compaction 续跑会重发），真正的 run
        // 终点是 _runAgentPrompt 的 finally 中 _emitAgentSettled()（pi dist/core/agent-session.js:772-786），
        // 且存在「post-run 尾段直接 settle」这条不含 agent_end 的收尾路径。若 prompt 落在该窗口，
        // 本分支置的 true 会永久残留（occupancy 已被 #4 复位 idle → 前端 flush，但 busy 预检读
        // occupancy → 后续消息恒被拒）。故第二复位点挂在 agent_settled：组合根 onAgentSettled →
        // SessionStateProjection.handleAgentSettledSideEffects。
        // isGenerating 复位点全集：agent_end（handleTurnEndSideEffects）/ agent_settled（本补丁）/
        // abort / forceQuit / session 退出。
        applySessionOccupancyTransition(activeSession, this.messageBus, 'reject-processing')
      } else {
        // compacting 拒绝（窗口 1）与非 busy 真失败：turn 确实没跑起来，'reject-other' 行
        // （派生 isGenerating=false + turn='idle'）。compacting 拒绝后续仅 compaction_start/end
        // （#5/#6 只写 compacting 维度），同样依赖此处复位。
        applySessionOccupancyTransition(activeSession, this.messageBus, 'reject-other')
      }
    }
    if (rejectionReason) {
      this.publishSendRejected(sessionId, rejectionReason, clientUuid)
      return { blocked: true, rejected: true }
    }
    const errMsgMsg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
    this.messageBus?.publish(sessionId, errMsgMsg)
    // 与 hook 拦截同等对待：已广播 message.error 气泡，返回 blocked 让 handler 走 error envelope（sendError），
    // renderer pending.reject 触发 Composer 恢复草稿。否则 handler reply success → pending.resolve 误判发送成功。
    return { blocked: true }
  }

  /**
   * send.rejected 拒绝广播（busy 预检与 pi 拒绝转译两路共用的发布原语）。
   * 文案按 isCompacting 分型映射；clientUuid 原样带回（undefined 时缺省），renderer
   * 据此消歧发送来源（flush 重放的拒绝不重入队）。
   */
  private publishSendRejected(
    sessionId: string,
    reason: PromptRejectionReason | 'busy',
    clientUuid: string | undefined,
  ): void {
    const msg = {
      type: 'send.rejected' as const,
      payload: {
        sessionId,
        reason,
        message: reason === 'compacting' ? REJECT_MESSAGE_COMPACTING : REJECT_MESSAGE_BUSY,
        ...(clientUuid !== undefined && { clientUuid }),
      },
    }
    this.messageBus?.publish(sessionId, msg)
  }

  /**
   * 运行 BeforeSend hook：返回 { blocked: true } 时调用方应中止发送；
   * 返回 { modifiedContent } 时调用方应以改写后的文本发送（transform 语义，Fix-1）。
   * 统一处理 hook 拦截（blocked）与 hook 自身异常（广播 message.error 后视作 blocked）。
   */
  private async runBeforeSendHook(
    sessionId: string,
    hookContent: string,
  ): Promise<{ blocked: boolean; modifiedContent?: string }> {
    if (!this.sendMessageHook) return { blocked: false }
    try {
      const hookResult = await this.sendMessageHook(sessionId, hookContent)
      if (hookResult?.blocked) {
        const msg = { type: 'message.error' as const, payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' } }
        this.messageBus?.publish(sessionId, msg)
        return { blocked: true }
      }
      if (typeof hookResult?.modifiedContent === 'string') {
        return { blocked: false, modifiedContent: hookResult.modifiedContent }
      }
      return { blocked: false }
    } catch (e) {
      console.error('[message-dispatcher] sendMessage hook error:', e)
      const msg = { type: 'message.error' as const, payload: { sessionId, message: 'Plugin hook error: ' + (toErrorMessage(e)) } }
      this.messageBus?.publish(sessionId, msg)
      return { blocked: true }
    }
  }

  /**
   * 中止 session 当前 turn（协作式 abort RPC）：成功 → occupancy #9 idle 复位 + stopped 终态
   * 写入 + message.complete{aborted} 收口广播；失败 → 终态兜底（超时走 K2 强杀收敛）。
   *
   * [U2 修复] source 分型（默认 'user' 既有调用方零改动）：'convergence' 由收敛环通路传入
   * （session-service gate.configure 接线），成功路径终态 reason 写 'Convergence abort (auto)'
   * ——收敛环掐的是 runtime 自动收敛的补发 turn，终态/日志不得谎报用户操作语义。
   * aborted 完成帧广播两种 source 均保持不变（前端 no-op，U2 明确不动广播逻辑）。
   */
  async abort(sessionId: string, source: AbortSource = 'user'): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'abort')
    try {
      await client.abort()
    } catch (e) {
      // [HISTORICAL] abort 失败也必须广播终态（规则 #3）：否则前端 isStreaming / runtime
      // isGenerating 永不复位，UI 卡在「思考中」。pi 卡死时 client.abort() 无响应，靠这条兜底。
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] abort failed (source=${source}): sessionId=${sessionId}`, errMsg)
      // 先取 active 再 destroy——destroySession 会删 processes/clientToId 条目，
      // 之后再经 getSessionByClient 反查会拿 undefined。
      const active = this.svc.getSessionByClient(client)
      if (active) {
        // occupancy #9（D2 迁移）：abort RPC 失败兜底 → 'idle' 行（pi 卡死时 agent_settled
        // 永不到达，turn 不能停留在 dispatching/generating/settling）。isGenerating=false 由
        // 原语 flags 派生。
        applySessionOccupancyTransition(active, this.messageBus, 'idle')
      }

      if (e instanceof RpcTimeoutError) {
        // W7（chat-domain-v1x-liveness-governance D3）：abort RPC 超时 ≠ pi 冻结——实装 pi 的
        // abort 应答即收敛，收敛前无中间信号，60s 超时只能区分「收敛了/没收敛」，不能区分
        // 「忙/死」。旧代码直接强杀正是 2026-09-08 事故环 6 的误杀源（pi 循环中还在正常执行
        // 工具调用却被判 frozen 连带击杀子代理）。改走三信号判据 + 三级阶梯（见
        // runAbortStallLadder）；强杀保留为阶梯 3 的收窄形态（双信号：探测无响应 + 事件窗
        // 静默超保守窗才触发）。检测即收敛的编排理由（exit 事件被双层守卫拦截，需手动编排
        // 与 onSessionExit 同构的收敛链）见 forceQuitSession 方法头。
        // [session-dead D5①/U2] abort 的 source 传入阶梯：阶梯 3 强杀的 K2 日志按调用源
        // 区分 who——收敛环 re-abort 超时（convergence）不得在 kill 日志里冒充用户 abort。
        await this.abortLiveness.handleAbortRpcTimeout(sessionId, client, errMsg, source)
        return
      }

      // 非超时错误（EPIPE / 进程已退出 / RPC 显式失败等）：保持现行 abort 收口行为。
      // W4：abort 失败（异常退出）写 stopped 终态
      this.svc.persistSessionOutcome(sessionId, 'stopped', `Abort failed: ${errMsg}`)
      const abortErrMsg = { type: 'message.error' as const, payload: { sessionId, message: `Abort failed: ${errMsg}` } }
      this.messageBus?.publish(sessionId, abortErrMsg)
      return
    }
    // [HISTORICAL] abort 成功后必须主动广播 message.complete{stopReason:'aborted'} + 重置
    // isGenerating。不能依赖 pi 自发 agent_end——pi 卡死（静默不退出）时永远不会发。
    // session-message-handler 的 message.status{status:'aborted'} reply 走 pending 通道，
    // 只让 renderer 的 abort() Promise resolve，不触发 chat store 的 message.complete 收口
    // 逻辑（chat-message-effects 只认 'message.complete' type），isStreaming 仍为 true。
    // 广播流式 message.complete 让前端正常收口（与 sendPrompt 错误路径广播 message.error 对称）。
    const active = this.svc.getSessionByClient(client)
    if (active) {
      // occupancy #9（D2 迁移）：abort 成功 → 'idle' 行（与上方的 message.complete{aborted}
      // 收口对称）。isGenerating=false 由原语 flags 派生。
      applySessionOccupancyTransition(active, this.messageBus, 'idle')
    }
    // W4：abort 写 stopped 终态。[U2] reason 按发起方分型：收敛环 re-abort（restore-abort
    // 收敛环掐补发 turn / 掐 idle pi）是 runtime 自动收敛而非用户操作，写区分性文案——
    // 终态 entry 是「谁 stopped 了 session」的权威记录，语义不得谎报。
    if (source === 'convergence') {
      console.warn(`[message-dispatcher] convergence abort (runtime auto, userStopped convergence loop), sid=${sessionId}`)
      this.svc.persistSessionOutcome(sessionId, 'stopped', 'Convergence abort (auto)')
    } else {
      console.warn(`[message-dispatcher] user abort accepted, sid=${sessionId}`)
      this.svc.persistSessionOutcome(sessionId, 'stopped', 'User aborted')
    }
    const completeMsg = { type: 'message.complete' as const, payload: { sessionId, stopReason: 'aborted' as const } }
    this.messageBus?.publish(sessionId, completeMsg)
  }

  /**
   * forceQuit —— 强制退出 session（session.forceQuit）：跳过协作式 abort RPC，直接杀 pi
   * 进程并走与 abort 超时相同的收敛编排。
   *
   * 场景：pi 卡在 processing（前端 isGenerating 已丢失 / retry 窗口等不一致态），Composer
   * 无 stop 按钮可用、新 prompt 被 pi 拒绝——用户从 sidebar 右键「强制退出」让进程退出；
   * session.exited 广播后前端标记 dead，点击 dead session 走 restore 重开（历史完整）。
   */
  async forceQuit(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // 不在活跃进程表（已退出 / 未 spawn）：无可杀对象，幂等成功。菜单入口对 dead/idle
      // 历史 session 隐藏，此分支是「菜单渲染后 session 恰好退出」的竞态兑底。
      // [U3 修复] 早退也须置 userStopped 标记：用户点「强制退出」的意图与进程死活无关
      // （与 K1 同源）——无 client 时 pi 可能已自行 spawn 恢复链（restore replay turn），
      // 缺标记会让后续 restore 的收敛环不设防，被杀的旧执行复活。
      console.log(`[message-dispatcher] forceQuit: session ${sessionId} not active, nothing to kill (userStopped mark still set)`)
      userStoppedGate.markUserStopped(sessionId, 'user_force_quit')
      return
    }
    // D5①（session-dead-structural-fixes）：kill 路径全量日志 K1——含调用源（kill_source）
    // 与触发信号链（谁发起、为什么），exit 143 类进程死亡可从此行回溯到发起方。
    console.warn(`[message-dispatcher] force quit requested by user, killing session ${sessionId} (kill_source=user_force_quit | who: user via session.forceQuit RPC | chain: skip abort -> SIGTERM destroy -> persist stopped -> occupancy reset -> session.exited)`)
    // D4 置位分型 K1：用户强制退出 = 「用户要停」，置标记。
    await this.forceQuitSession(sessionId, 'User forced quit', '用户强制退出，进程已终止。重新打开该 session 即可恢复（历史完整）。', 'user_force_quit')
  }

  /**
   * 强杀收敛编排（abort RPC 超时路径与 forceQuit 共用）：detach → destroy → persist stopped →
   * 广播 session.exited → removeEntry。收敛需手动编排而非依赖 pm.onSessionExit 回调：kill 路径
   * 的 exit 事件被双层守卫拦截（rpc-client.kill 置 _killing 跳过 exitCallback；process-manager
   * 的 exit 回调按 processes.has 拦截 intentional destroy），不会传播到 session-service 的
   * onSessionExit 收敛链。编排与 lifecycle.delete / onSessionExit 回调同构，非新发明。
   *
   * outcomeReason 进终态 entry（诊断）；exitReason 经 session.exited 广播给用户（可操作指引）。
   *
   * [D4] source 为置位分型（K1 user_force_quit / K2 abort_timeout）：「用户要停」的调用方
   * 在编排开头置 userStopped 标记（宿主 = session-service.ts 模块级 Map，独立于
   * ManagedSession 生命周期——尾步 removeSessionEntry 删条目后标记仍可被 restore 读到）。
   * 标记驱动 restore-abort 收敛环：被杀的旧执行（notify replay / 补发腿）不得自动复活。
   */
  private async forceQuitSession(sessionId: string, outcomeReason: string, exitReason: string, source: ForceQuitSource): Promise<void> {
    userStoppedGate.markUserStopped(sessionId, source)
    // 先 detach 再 destroy——destroySession 会删 processes/clientToId 条目，
    // 之后再经 getSessionByClient 反查会拿 undefined。
    this.svc.detachSession(sessionId)
    await this.pm.destroySession(sessionId)
    // stopped 终态须在 removeSessionEntry 前写（persistSessionOutcome 内部按 id 查
    // sessions Map，条目删除后静默跳过）。
    this.svc.persistSessionOutcome(sessionId, 'stopped', outcomeReason)
    // occupancy #10（D2 迁移，forceQuit/abort 超时收敛腿）：进程被强杀后 agent_settled /
    // compaction_end 永不到达，'full-reset' 行三维全复位 + 三布尔派生同步复位（结构上不再有
    // 「只复位一边」）——session.exited 广播前发，且必须在 removeSessionEntry（内部
    // bus.clearSession）之前，否则帧送空集合。
    const exiting = this.svc.getSession(sessionId)
    if (exiting) applySessionOccupancyTransition(exiting, this.messageBus, 'full-reset')
    // session.exited 须在 removeSessionEntry 前发（其后 messageBus.clearSession 清空
    // 订阅者集合，再发等于空投，前端一条也收不到）。code=null：强杀场景退出码未知，
    // 与 shared 协议「被信号杀死无退出码」语义一致。前端 handleSessionExited 会把
    // reason 作为 error 消息插入聊天流 + toast（与 pi 崩溃路径同一入口）。
    const exitedMsg = { type: 'session.exited' as const, payload: { sessionId, code: null, reason: exitReason } }
    this.messageBus?.publish(sessionId, exitedMsg)
    this.svc.removeSessionEntry(sessionId)
  }

  /**
   * 直接执行 bash 命令（pi bash RPC，不经 LLM turn）。
   *
   * 与 sendMessage 共享 ensureActive 骨架，但 busy 预检语义不同（W2 起）：
   * sendBash 仅 bash↔bash / bash↔compacting 互斥，允许 AI streaming（isGenerating）期间执行 bash，
   * 对齐 pi-tui——pi 把 bash RPC 排入 _pendingBashMessages 待当前 turn 结束后按 JSONL 顺序回放，
   * 对 RPC 透明。sendMessage 仍保留 isGenerating 三者互斥（spec OQ-1：本期不放宽 prompt 路径）。
   *
   * 不走 sendPrompt（bash 不调 client.prompt，不需 BeforeSend hook、不需图片附件、不触发 isGenerating 流式态）。
   *
   * [W1 fix-chat-flow-order D2] bashResult 双分支延迟——镜像 pi recordBashResult 的双分支
   * （agent-session.js:2225-2247：streaming 期间 bash 缓存到 _pendingBashMessages、级联结束
   * 统一落盘；空闲立即落盘），消除「live 即时入流 vs 文件级联末落盘」的顺序分叉（重开分组跳变）：
   * - session streaming（isGenerating，活跃 run）→ 结果压入 activeSession.pendingBashResults
   *   待落列（不立即广播），agent_settled（级联结束，晚于 pi finally flush 的 bash 落盘，
   *   探针 ②）到达时 flushPendingBashResults 按序以帧发布；
   * - 空闲 → 立即以帧发布。
   * 前端（core registry bashResult handler）把帧转 bashExecution entry 经 applyEntryFrame 入流
   * ——两侧位置都构造性等于 pi 落盘位置。
   *
   * 生命周期：bashStart 广播（开始，执行中反馈——前端 ephemeral executingBash 态，不建消息）
   * → pi bash RPC → bashResult 广播（终态，双分支延迟如上）。
   * 返回 { blocked: true } 有四种形态（一致性审查 SG-A1 修订——catch abort skip 是 D1 新增分支）：
   * 预检拒绝（send.rejected 已广播）、执行失败（message.error + 错误 bashResult 终态帧均已广播）、
   * catch abort skip（**不广播**——abortBash 已抢先收口广播哨兵帧，token 不匹配即跳过，D1 收窄
   * 后唯一残余例外⑤）、空命令哨兵不变式早退（**不广播**——程序不变式守卫非用户可见错误，见方法头；
   * 实施审查 SG-2：调用方对后两种形态的 ack 文案失真已知，归 bash 互斥专项）。
   * 调用方（session-message-handler）据此走对应 ack 路径，与 sendMessage 的返回语义对称。
   */
  async sendBash(
    sessionId: string,
    command: string,
    excludeFromContext?: boolean,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    // ── 哨兵不变式守卫（D1 closure，实施审查 S-2 上移至真正入口）──
    // bash-effects 哨兵帧判定 command === '' && cancelled（识别 abortBash 兜底广播、只清态不产
    // entry）。真实帧 command 恒非空是「约定」——空命令在此早退使其升级为结构性不变式：入口
    // 不可能发出 command === '' 的 bash，两类帧永不混淆。程序不变式守卫（UI `!` 解析必出非空
    // 命令，正常不可达）：不广播 send.rejected / message.error（非用户可见错误，广播会以失真
    // 文案打扰），仅 console.warn 留痕；blocked 返回值仅为类型完备。
    if (command === '') {
      console.warn(`[message-dispatcher] sendBash: empty command rejected (sentinel invariant), sid=${sessionId}`)
      return { blocked: true }
    }

    // ── ensureActive(必要时 restore)──
    // [时序不变量 timeout-tick-parity] 必须保持 HEAD 内联 try/await/catch 形态：
    // 任何 Promise 组合子（async 包装 / .catch 链）都会使衍生 promise 在 resolve 路径
    // 多一拍微任务，bashStart 广播与 reserveBashSlot 置位整体晚一拍，race 测试 W1 的
    // 1-tick 断言（bashStart 已广播 / isBashRunning 已置位）即落空（U08 两轮实测）。
    let client: IPiEngine
    try {
      client = await this.svc.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${toErrorMessage(e)}`
      console.error(`[message-dispatcher] sendBash: ${errMsg}`)
      const errMsgObj = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.messageBus?.publish(sessionId, errMsgObj)
      throw e
    }

    // ── busy 预检 + 占槽（W2: bash↔streaming 放宽并发，对齐 pi-tui）──
    // 语义变化（w2）：bash 不再与 AI streaming（isGenerating）互斥，允许 streaming 期间执行 bash。
    // 原因（spec C1）：pi 把 bash RPC 排入 _pendingBashMessages，待当前 turn 结束后按 JSONL
    // 顺序回放——对 RPC 透明，runtime 侧无需排队等待。对齐 pi-tui 行为（pi-tui 允许 streaming 时发 bash）。
    // 保留的互斥（仍 reject）：
    // - isBashRunning：bash↔bash 互斥——pi 单 bash slot，并发会乱序。
    // - isCompacting：bash↔compact 互斥——compact 重写上下文，期间 bash 会读到半压缩状态。
    // 注意：sendMessage（sendPrompt）预检仍保留 isGenerating/isBashRunning/isCompacting 三者互斥，
    // 本期不放宽（spec OQ-1）——pi prompt 在 isStreaming 时强制要求 streamingBehavior 参数，
    // sendMessage 预检拒 isGenerating 是安全网。
    // null = 预检拒绝（send.rejected 已广播）；activeSession 为 undefined 时原逻辑不拒直接执行。
    const reservation = this.reserveBashSlot(sessionId, client)
    if (!reservation) return { blocked: true, rejected: true }
    const { activeSession, myToken } = reservation

    // ── bashStart 广播（实时反馈，与 bashResult 终态对称）──
    const excludeFlag = !!excludeFromContext
    const bashStartMsg = { type: 'message.bashStart' as const, payload: { sessionId, command, excludeFromContext: excludeFlag, timestamp: Date.now() } }
    this.messageBus?.publish(sessionId, bashStartMsg)

    // ── 调 pi bash + 广播终态 ──
    try {
      const result = await client.bash(command, excludeFromContext)
      this.handleBashSuccess(sessionId, command, excludeFlag, result, activeSession, myToken)
    } catch (e) {
      return this.handleBashFailure(sessionId, command, excludeFlag, e, activeSession, myToken)
    } finally {
      this.releaseBashReservation(activeSession, myToken)
    }
    return { blocked: false }
  }

  /**
   * sendBash 阶段 2：busy 预检 + 占用 bash slot + 生成本次代次令牌。
   *
   * 返回 null = 预检拒绝（send.rejected 已广播，调用方直接 { blocked: true, rejected: true }）；
   * 返回 { activeSession, myToken }：activeSession 可为 undefined（session 无 managed view 时
   * 原逻辑跳过预检直接执行）；myToken 为本地捕获的本次 token（abortBash 旋转后 activeSession
   * 上的值已变，本地值不变，比对即可判定未被抢收口）。
   */
  private reserveBashSlot(
    sessionId: string,
    client: IPiEngine,
  ): { activeSession: IManagedSessionView | undefined; myToken: string | undefined } | null {
    const activeSession = this.svc.getSessionByClient(client)
    if (activeSession) {
      if (activeSession.isCompacting || activeSession.isBashRunning) {
        console.warn(`[message-dispatcher] sendBash preemptive reject (busy), sid=${sessionId}`)
        const rejectMsg = { type: 'send.rejected' as const, payload: { sessionId, reason: 'busy' as const, message: 'Agent 正在处理' } }
        this.messageBus?.publish(sessionId, rejectMsg)
        return null
      }
      // occupancy #7（D2 迁移）：sendBash 置位 → 'bash-start' 行（派生 isBashRunning=true +
      // 合并 bash=true；与 turn 维度正交，streaming 中可并存）。
      applySessionOccupancyTransition(activeSession, this.messageBus, 'bash-start')
      // [W1] 生成本次 sendBash 的代次令牌：abortBash 在广播 cancelled 终态前会旋转此 token
      // （清 undefined）。await 返回后比对 token，可判定是否被 abortBash 抢先收口。
      activeSession.bashRunToken = `bash_${Date.now()}_${randomTokenSuffix()}`
    }
    // [W1] 捕获本次 sendBash 的 token 到本地（abortBash 旋转后 activeSession.bashRunToken 已变，
    // 本地 myToken 不变，比对 myToken === activeSession.bashRunToken 即可判定未被抢收口）。
    const myToken = activeSession?.bashRunToken
    return { activeSession, myToken }
  }

  /**
   * sendBash 成功收口（try 体）：abort 抢收口守卫 warn + 终态数据构造 + 双分支延迟发布。
   *
   * [W1 → D1 closure 修订] abort 抢收口守卫：await 期间若 abortBash 被调用，它已广播
   * 哨兵帧（command:''，bash-effects 只清 executingBash 不产 entry）并旋转 token。旧逻辑
   * 在此静默丢弃真实结果——但 pi 侧 recordBashResult 对 cancelled 无分支照常落盘
   * （bash-executor abort 返回 cancelled 结果而非 throw），丢弃导致 live 无记录、重开多出
   * 一条（登记例外①）。哨兵帧与真实帧职责正交（一个只清态、一个产 entry，均幂等），
   * 双终态担忧不成立——故此处不再跳过，发布真实数据（含 streaming 双分支延迟，与 pi
   * 落盘位置一致）。例外收窄登记：仅 catch 分支（transport 抛错，无真实数据可发布）
   * 维持哨兵不产 entry。
   *
   * [W1 fix-chat-flow-order D2] 双分支镜像 pi recordBashResult（agent-session.js:2237-2247）：
   * pi 在 isStreaming 时把 bash 缓存到 _pendingBashMessages（run 级联 finally 统一落盘），
   * xyz 镜像为——session 处于活跃 run（isGenerating）时结果进待落列，agent_settled
   * （级联结束信号，晚于 pi 的 finally flush，探针 ②）到达时 flushPendingBashResults
   * 按序发布；空闲立即发布。已知窄竞态（设计已登记）：xyz 判空闲但 pi 实际 streaming
   * 的窗口内两侧位置短暂不一致，重开后以文件为准收敛。
   */
  private handleBashSuccess(
    sessionId: string,
    command: string,
    excludeFlag: boolean,
    result: InternalBashResult,
    activeSession: IManagedSessionView | undefined,
    myToken: string | undefined,
  ): void {
    if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
      console.warn(`[message-dispatcher] sendBash: aborted during await, publishing real cancelled terminal. sid=${sessionId}`)
    }
    // 终态数据在 RPC 完成时刻构造（timestamp = pi recordBashResult 落盘时刻，非 flush 时刻，
    // 保证与文件 entry timestamp 一致）。emit 只传单个 payload 对象。
    const bashResultData: PendingBashResultData = {
      command,
      output: result.output,
      exitCode: result.exitCode ?? null,
      cancelled: result.cancelled,
      truncated: result.truncated,
      excludeFromContext: excludeFlag,
      timestamp: Date.now(),
      ...(result.fullOutputPath !== undefined && { fullOutputPath: result.fullOutputPath }),
    }
    if (activeSession?.isGenerating) {
      activeSession.pendingBashResults = [...(activeSession.pendingBashResults ?? []), bashResultData]
    } else {
      this.publishBashResult(sessionId, bashResultData)
    }
  }

  /**
   * sendBash 失败收口（catch 体整体，恒返回 { blocked: true }）：
   * ① abort 抢收口竞态守卫（跳过重复报错）；② RpcTimeoutError 诚实文案合成终态；
   * ③ 通用错误兜底（错误 bashResult + message.error，S2 对称收口）。
   */
  private handleBashFailure(
    sessionId: string,
    command: string,
    excludeFlag: boolean,
    e: unknown,
    activeSession: IManagedSessionView | undefined,
    myToken: string | undefined,
  ): { blocked: boolean } {
    const errMsg = toErrorMessage(e)
    console.error(`[message-dispatcher] sendBash failed: sessionId=${sessionId}`, errMsg)
    // [W1] 竞态守卫：若 await 抛错是因 abortBash 抢先收口（如 abort_bash 触发 pi 关闭流），
    // 已有 cancelled bashResult 广播，此处不再发 message.error，避免双重报错。
    if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
      console.warn(`[message-dispatcher] sendBash: aborted during await (catch), skip duplicate error. sid=${sessionId}`)
      return { blocked: true }
    }
    // [D2 timeout-slow-flow-wallclock] bash RPC 超时（RpcTimeoutError，字段化 commandType/
    // timeoutMs）：合成终态换诚实文案（三步恢复指引），不自动 abort_bash——超时是「停止
    // 等待」不是「处决命令」，pi 侧照常执行并 recordBashResult 落盘，重开 session 可见真实
    // 结果；迟到响应维持既有丢弃机制（rpc-client timedOutIds/NULL_EVENTS，本分支不动）。
    // 此处 pi 未卡死（bash 长跑是合法活跃任务，ADR-0047 静默≠卡死），与 abort() 的
    // RpcTimeoutError→强杀自愈分支语义不同，不得复用强杀路径。
    if (e instanceof RpcTimeoutError) {
      const honestOutput = buildBashTimeoutOutput(e.timeoutMs)
      // P6 断言④：超时是「停止等待」不是「处决」——pi 侧孤儿 bash 仍在跑。置孤儿标记让
      // abortBash 守卫放行（诚实文案第①步「abortBash 可终止」的 runtime 承诺），
      // abort_bash 发出且 pi 确认后由 abortBash 清除（见 abortBash）。
      if (activeSession) activeSession.orphanBashRunning = true
      // 错误帧不进待落列（立即发布）：xyz 合成帧，无 pi 落盘时序语义（同下方通用错误分支）。
      this.publishBashResult(sessionId, {
        command,
        output: honestOutput,
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: excludeFlag,
        timestamp: Date.now(),
      })
      // [P6 deviation] 不广播 message.error 技术帧（'RPC command "bash" timed out after...'）：
      // Gate B 实测它与诚实气泡在聊天流双条目并存（renderer 把 message.error 插入对话流），
      // 与 G2「诚实告知」矛盾；诊断信息由 error envelope（session-message-handler blocked
      // 分支）+ runtime 日志承载，用户可见面只保留诚实气泡。
      return { blocked: true }
    }
    // [S2] 对称兜底：与 abortBash「无论成败都广播 bashResult 终态」对称。
    // 前端 message.error handler 只收口 streaming **assistant** 消息（finalizeSession 按
    // role==='assistant' 过滤），不收口 role==='system' 的 streaming bash 消息——
    // 若只发 message.error，前端 bash 气泡会卡在 streaming 态。故此处补发一条
    // cancelled:false + exitCode:null + output 含错误信息的 bashResult 终态让 bash 收口。
    // [W1 fix-chat-flow-order] 错误帧不进待落列（立即发布）：它是 xyz 合成帧，无 pi 落盘
    // 时序语义；且失败场景（transport 断/pi 死）级联可能永不结束，延迟会让用户无反馈。
    this.publishBashResult(sessionId, {
      command,
      output: `[bash error] ${errMsg}`,
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: excludeFlag,
      timestamp: Date.now(),
    })
    const bashErrMsg = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
    this.messageBus?.publish(sessionId, bashErrMsg)
    return { blocked: true }
  }

  /**
   * sendBash finally 清理：复位 isBashRunning + 条件复位 token。仅当 token 仍是本次 sendBash
   * 的（未被 abortBash 旋转、也未被下一次 sendBash 覆盖）时才清，避免误清 abortBash 或后续
   * sendBash 的标记。
   */
  private releaseBashReservation(activeSession: IManagedSessionView | undefined, myToken: string | undefined): void {
    if (activeSession) {
      // occupancy #7（D2 迁移）：sendBash finally（成功/失败/abort-skip 全路径）→ 'bash-end' 行
      // （派生 isBashRunning=false + 合并 bash=false）。
      applySessionOccupancyTransition(activeSession, this.messageBus, 'bash-end')
      // [W1] 复位 token：仅当 token 仍是本次 sendBash 的（未被 abortBash 旋转、
      // 也未被下一次 sendBash 覆盖）时才清，避免误清 abortBash 或后续 sendBash 的标记。
      if (myToken !== undefined && activeSession.bashRunToken === myToken) {
        activeSession.bashRunToken = undefined
      }
    }
  }

  /**
   * 发布单条 bashResult 帧（sendBash 空闲分支 / 错误兜底 / 待落列 flush 共用）。
   * emit 只传单个 payload 对象（架构规则 1）。
   */
  private publishBashResult(sessionId: string, data: PendingBashResultData): void {
    this.messageBus?.publish(sessionId, { type: 'message.bashResult' as const, payload: { sessionId, ...data } })
  }

  /**
   * [W1 fix-chat-flow-order D2] 按 sessionId 定向 flush bash 待落列。
   *
   * 触发：pi agent_settled（run 级联结束）经 EventInterpreter.onAgentSettled →
   * sessionService.flushPendingBashResults 到达（组合根 index.ts 接线）。时序保证（探针 ②）：
   * pi 在 _runAgentPrompt finally 先 _flushPendingBashMessages（bash entry 统一落盘，
   * agent-session.js:754）再 _emitAgentSettled（:755），故本方法发布帧时 pi 文件内 bash
   * entry 已就位，live 入流位置（级联末）与落盘位置一致。
   *
   * 语义：按入列序（= pi RPC 完成序 = pi _pendingBashMessages 落盘序）发布；先清空再发布
   * （发布中若新 bash 压入，下一轮 settled flush 处理，不混批）。session 已删除 → 条目随
   * session 对象丢弃（挂 activeSession 同区的生命周期语义，见 types.ts 注释），此处自然 no-op。
   */
  flushPendingBashResults(sessionId: string): void {
    const session = this.svc.getSession(sessionId)
    const queue = session?.pendingBashResults
    if (!session || !queue || queue.length === 0) return
    session.pendingBashResults = []
    for (const data of queue) {
      this.publishBashResult(sessionId, data)
    }
  }

  /**
   * 取消进行中的 bash 执行（pi abort_bash）。
   *
   * 与 abort() 对称：失败不 throw（console.error 兑底），finally 兑底广播 bashResult{cancelled:true}
   * 终态——与 abort 广播 message.complete{aborted} 对称，前端据 bashResult 收口 isBashRunning 态。
   *
   * 返回 sent = abort_bash 是否真的发出且 pi 确认（P6 断言④回执真实化）：调用方
   * （session-message-handler）据此决定回执——sent=true 才回 message.status{aborted}，
   * sent=false（守卫短路 / 发送失败）不得谎报 aborted。
   */
  async abortBash(sessionId: string): Promise<{ sent: boolean }> {
    const client = this.getClientOrThrow(sessionId, 'abortBash')
    const activeSession = this.svc.getSessionByClient(client)
    // [W1 + P6 断言④] 守卫：isBashRunning（runtime 在等待）或 orphanBashRunning（D2 超时后
    // runtime 已停止等待但 pi 侧孤儿 bash 仍在跑）任一在 → 放行。旧守卫只看 isBashRunning，
    // 语义「runtime 不等待 = 无命令在跑」与 D2 超时形态「停止等待 ≠ 处决」冲突——超时后
    // abort_bash 被短路永不发出，诚实文案第①步「abortBash 可终止」落空，UI 却仍收 aborted。
    // 两态皆无（空闲 session 的重复/误触取消）→ 短路 { sent: false }，由调用方回执真实化。
    if (!activeSession?.isBashRunning && !activeSession?.orphanBashRunning) return { sent: false }
    // sent = abort_bash 是否发出且 pi 确认（sendCommand 对 success:false reject，resolve =
    // pi 已执行 abort）。失败不提前 return：兑底 cancelled 哨兵广播必须照发（T8b 既有契约）。
    let sent = true
    try {
      await client.abortBash()
      // pi 确认取消 → 孤儿标记清除（pi 单 bash slot，孤儿已终止）。
      if (activeSession) activeSession.orphanBashRunning = false
    } catch (e) {
      // 与 abort() 的错误兑底一致：不 throw，避免请求级 envelope 双重报错。孤儿标记保留：
      // abort_bash 失败（pi 卡死/管道断）时 bash 状态未知，标记残留只让下次 abortBash 再发
      // 一次幂等的 abort_bash，比误清（谎称无孤儿）更诚实。
      console.error(`[message-dispatcher] abortBash failed: sessionId=${sessionId}`, toErrorMessage(e))
      sent = false
    } finally {
      if (activeSession) {
        // occupancy #11（D2 迁移）：abortBash（成败皆兜底）→ 'bash-end' 行，与下方 cancelled
        // 哨兵帧广播同源同点（pi 卡死时 abort_bash 无响应，靠 finally 保证维度复位）。
        applySessionOccupancyTransition(activeSession, this.messageBus, 'bash-end')
        // [W1] 旋转 token：通知 sendBash「已被 abort 抢先收口」。sendBash 在 await 返回后
        // 检测到 activeSession.bashRunToken !== myToken 即静默跳过终态广播，避免双终态。
        // 用新 token 而非清 undefined：若 sendBash 尚未读 myToken（仍在 await），清 undefined
        // 会让 sendBash 误判「无 abort」——而新 token 保证 sendBash 比对必然不等。
        activeSession.bashRunToken = `abort_${Date.now()}_${randomTokenSuffix()}`
      }
    }
    // 兑底终态：无论 pi 是否响应 abort_bash，都广播 cancelled=true 的 bashResult。
    // pi 卡死时不发任何事件，靠这条让前端 isBashRunning 复位（与 abort 广播 message.complete 同理）。
    const cancelMsg = {
      type: 'message.bashResult' as const,
      payload: {
        sessionId,
        command: '',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: Date.now(),
      },
    }
    this.messageBus?.publish(sessionId, cancelMsg)
    return { sent }
  }

  /**
   * [composer-multi-skill-injection D6/D8] 发布 skill 注入提示广播（session.skillNotice，
   * payload 契约见 protocol.ts）。三入口共用：注入器产出的 notices 逐条定向发布。
   *
   * [A2 D-A2-2] 广播编排提取为共享函数（skill-notice-publisher.ts）——subagentAction
   * （session-records.ts）与 deliverText（session-delivery-registry.ts）两个新挂载点
   * 同款复用；本方法保留薄委托（调用点不变，messageBus 的 undefined 语义照旧）。
   * clientUuid 提取与 payload 形态见共享函数注释。
   */
  private publishSkillNotices(sessionId: string, sentText: string, notices: SkillNotice[]): void {
    publishSkillNoticesShared(this.messageBus, sessionId, sentText, notices)
  }

  async steerMessage(sessionId: string, content: string): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'steer')
    // [composer-multi-skill-injection D9] 注入器：入队前统一处理（与 sendPrompt 同构）。
    // steer 路径现状无 BeforeSend hook 调用点（hook 仅注册在 sendMessage 骨架），
    // 「hook 之后」约束在此自然成立。
    const injection = await this.injector.inject(client, content)
    await client.steer(injection.text)
    this.publishSkillNotices(sessionId, content, injection.notices)
  }

  async followUpMessage(sessionId: string, content: string): Promise<void> {
    const client = this.getClientOrThrow(sessionId, 'followUp')
    // [composer-multi-skill-injection D9] 同 steerMessage：入队前统一处理，恰一次调用。
    const injection = await this.injector.inject(client, content)
    await client.followUp(injection.text)
    this.publishSkillNotices(sessionId, content, injection.notices)
  }

  /**
   * D8: abort/steer/followUp 共享的「getClient → 空抛」骨架（此前 3 处逐行平行，只差方法名）。
   * @param op 调用方方法名，仅用于构造诊断串。
   */
  private getClientOrThrow(sessionId: string, op: 'abort' | 'steer' | 'followUp' | 'abortBash'): IPiEngine {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // abort 的历史报错串是 "Session X not found"（无前缀），steer/followUp 带 [message-dispatcher] 前缀。
      // 保持原样以免破坏依赖报错文本的测试。
      throw op === 'abort' || op === 'abortBash'
        ? new Error(`Session ${sessionId} not found`)
        : new Error(`[message-dispatcher] ${op}: session ${sessionId} not active`)
    }
    return client
  }

  async compact(sessionId: string, customInstructions?: string): Promise<void> {
    const startTime = Date.now()
    const client = this.pm.getClient(sessionId)
    if (!client) {
      console.error('[message-dispatcher] compact: session not found, sessionId=' + sessionId)
      throw new Error(`Session ${sessionId} not found`)
    }

    console.log('[message-dispatcher] compact: start, sessionId=' + sessionId + ', customInstructions=' + (customInstructions ? `"${customInstructions}"` : '(none)'))

    // [W3 + M4] busy 预检：与 sendBash/sendMessage 的 isCompacting 拒绝对称 + 防并发 compact 重入。
    // 补 isCompacting：A 置位（interpreter 从 compaction_start 事件）后，B 进来预检若无 isCompacting
    // 看不到 A → 两个 client.compact RPC 并发 → 双 compaction 事件流。补上后事件层 P-dedup by construction 成立。
    //
    // 事件驱动（M4）：compaction 生命周期广播全删——由 interpreter 从 compaction_start/compaction_end
    // 唯一编排（session.compacting / message.compactionSummary / session.compacted / 对话流错误提示）。
    // dispatcher 退化为「预检 + RPC 触发 + 失败复位」三件事。
    const active = this.svc.getSessionByClient(client)
    if (active && (active.isBashRunning || active.isGenerating || active.isCompacting)) {
      const reason = active.isCompacting ? 'compaction already running'
        : active.isBashRunning ? 'bash running'
          : 'agent generating'
      const errMsg = `Cannot compact while ${reason}`
      console.warn(`[message-dispatcher] compact preemptive reject (busy), sid=${sessionId}, reason=${reason}`)
      // 零广播：不广播 session.compacted{error}。预检在 RPC 前，pi 未发 compaction_start，interpreter 不参与；
      // 错误经 throw → session-message-handler error envelope → useChat compact catch（MF-1：busy/transport 级失败
      // compaction_end 未到达 → catch toast 兜底；compaction 级失败由 interpreter 进对话流，catch 不 toast）。
      throw new Error(errMsg)
    }

    // 事件驱动（M4）：不广播 session.compacting、不置 active.isCompacting——均由 interpreter 从
    // compaction_start 事件驱动。dispatcher 只做 RPC 触发 + 失败复位。
    try {
      await client.compact(customInstructions)
      console.log('[message-dispatcher] compact: complete, sessionId=' + sessionId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error('[message-dispatcher] compact: failed, sid=' + sessionId + ', err=' + errMsg + ', elapsed=' + (Date.now() - startTime) + 'ms')
      // 零广播：不广播 session.compacted{error}。pi 手动 compact 失败必发 compaction_end{errorMessage}
      // （agent-session.js:1464-1483 无静默路径），interpreter 统一编排失败提示（session.compacted{error} +
      // message.error 对话流提示）。此处只传播 RPC error，复位交由下方 finally（兜底防 transport 级失败
      // ——RPC 未达 pi / pi 来不及发 compaction_end——时 session 卡死）。
      throw e
    } finally {
      // 兜底复位：interpreter 的 compaction_end 是复位主力（三路对称），此处防 transport 级失败时
      // interpreter 未触发 compaction_end 导致 session 卡死。置位归 interpreter（compaction_start），
      // dispatcher 不置 true，故此处只写 false（对 false 无害，幂等）。
      if (active) {
        // occupancy #6 兜底（D2 迁移，'compacting-end' 行）：transport 级失败时 compaction_end
        //（#6）不到达，compacting 维度在此镜像复位（派生 isCompacting=false；对未置位场景幂等无害）。
        applySessionOccupancyTransition(active, this.messageBus, 'compacting-end')
      }
    }
  }
}

/**
 * BashDispatcher —— bash 通道（直接执行 bash 命令，不经 LLM turn）的协作类。
 *
 * [MF-1-10 拆分] 从 MessageDispatcher 整体搬移（对齐 abort-liveness.ts 先例：文件搬移 +
 * 构造接线，禁 facade 转发层）。拆分依据：bash 通道是稳定存量（sendBash 双分支延迟 /
 * 代次令牌 / 孤儿标记 / 待落列 flush 全部 bash 专属），与投递受理（活跃热点）、abort
 * 收敛是三个正交变化原因——按变化原因分模块，不按符号数量。
 *
 * 行为逐字保持（搬移不改行为）：
 * - bashStart/bashResult 帧序与 timeout-tick-parity 时序不变量（sendBash 内联 try/await/catch
 *   形态，不得引入额外微任务拍）；
 * - occupancy bash-start/bash-end 转移挂点时点不变；
 * - abort 抢收口 token 比对守卫语义不变。
 *
 * [MF-1-9] bash-end 转移后经 deps.notifyHoldRelease 唤醒投递内核持有期等待者（view
 * isBashRunning 复位的边沿源——等待者由 500ms 轮询收编为事件驱动）。
 */
import type { IPiEngine } from '../ports/pi-engine.js'
import type { PendingBashResultData, IManagedSessionView } from './types.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { toErrorMessage } from '../../utils/errors.js'
import { applySessionOccupancyTransition } from './event-interpreter.js'

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
 * bash 投递回执的 services 层内部类型（翻译层标准做法）：字段与 shared 的
 * BashDispatchReceipt 逐字段一致，transport 层（session-message-handler.handleMessageBash）
 * 1:1 翻译进 message.status 回执。
 *
 * status 语义（消费方判定「命令是否已执行」的权威依据）：
 * - started = 已开跑未收口（如 bash 等待超时置孤儿，仍在执行）；
 * - settled = 已执行并收口（成功或失败终态已广播）；
 * - rejected = 未执行（busy 预检拒绝 / 空命令不变式 / restore 失败）。
 */
export interface InternalBashDispatchReceipt {
  status: 'started' | 'settled' | 'rejected'
  error?: string
}

/**
 * 生成短随机字符串，用作 sendBash / abortBash 的代次令牌后缀。
 * 与 `Date.now()` 拼接保证唯一性，比对即可判定是否被抢收口。
 */
function randomTokenSuffix(): string {
  return Math.random().toString(RANDOM_TOKEN_RADIX).slice(RANDOM_TOKEN_SLICE_START)
}

/** 构造依赖（窄面）：MessageDispatcher 构造持有本类，按宿主成员接线。 */
export interface BashDispatcherDeps {
  /** ensureActive（必要时 restore）——sendBash 入口交接。 */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** RPC client 反查 managed session（预检 / token 挂点）。 */
  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined
  /** 按 id 查 managed session（flushPendingBashResults 待落列）。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 按 id 取 pi client（abortBash 入口，与宿主 getClientOrThrow 同款）。 */
  getClient(sessionId: string): IPiEngine | undefined
  /** MessageBus 当前值（getter 动态读：setMessageBus 后置注入后仍正确）。 */
  getMessageBus(): IMessageBus | undefined
  /**
   * hold 解除边沿（MF-1-9）：bash-end 转移后调用，唤醒投递内核持有期等待者。
   * 注册表未接线时 no-op（可选）。
   */
  notifyHoldRelease?(sessionId: string): void
}

export class BashDispatcher {
  constructor(private readonly deps: BashDispatcherDeps) {}

  private get bus(): IMessageBus | undefined {
    return this.deps.getMessageBus()
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
   * 返回 InternalBashDispatchReceipt（bash 投递可靠性契约）：回执携带执行状态，是「命令是否
   * 已执行」的权威判定（消费方据此决定是否恢复 !command 草稿，不依赖推送帧是否到达——帧丢失
   * 不得致「未执行」误判、双执行）：
   * - 'rejected' = 未执行（busy 预检拒绝，send.rejected 已广播 / restore 失败，message.error
   *   已广播）；
   * - 'settled' = 已执行并收口（成功；或执行失败——message.error + 错误 bashResult 终态帧均已
   *   广播，失败原因随 error 携带；或 catch abort skip——**不广播**，abortBash 已抢先收口广播
   *   哨兵帧，token 不匹配即跳过，D1 收窄后唯一残余例外⑤）；
   * - 'started' = 已开跑未收口（收口归 abortBash 抢收口竞态路径）。
   * 调用方（session-message-handler）把回执翻译进 message.status reply，与 sendMessage 的
   * 返回语义对称。
   */
  async sendBash(
    sessionId: string,
    command: string,
    excludeFromContext?: boolean,
  ): Promise<InternalBashDispatchReceipt> {
    // ── ensureActive(必要时 restore)──
    // [时序不变量 timeout-tick-parity] 必须保持 HEAD 内联 try/await/catch 形态：
    // 任何 Promise 组合子（async 包装 / .catch 链）都会使衍生 promise 在 resolve 路径
    // 多一拍微任务，bashStart 广播与 reserveBashSlot 置位整体晚一拍，race 测试 W1 的
    // 1-tick 断言（bashStart 已广播 / isBashRunning 已置位）即落空（U08 两轮实测）。
    let client: IPiEngine
    try {
      client = await this.deps.ensureActive(sessionId)
    } catch (e) {
      const errMsg = `Failed to restore session: ${toErrorMessage(e)}`
      console.error(`[bash-dispatcher] sendBash: ${errMsg}`)
      const errMsgObj = { type: 'message.error' as const, payload: { sessionId, message: errMsg } }
      this.bus?.publish(sessionId, errMsgObj)
      // restore 失败 = 命令从未开跑 → 'rejected' 回执（消费方可安全恢复 !command 草稿）。
      // 不再 throw：throw 会让 transport 层走 error envelope，回执状态缺失 → 消费方只能按
      // 「可能已执行」保守处置，白白丢草稿（bash 投递可靠性契约）。
      return { status: 'rejected', error: errMsg }
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
    // busy 预检拒绝 = 未执行 → 'rejected'（send.rejected 已广播，用户反馈由前端该 handler 承担）
    if (!reservation) return { status: 'rejected' }
    const { activeSession, myToken } = reservation

    // ── bashStart 广播（实时反馈，与 bashResult 终态对称）──
    const excludeFlag = !!excludeFromContext
    const bashStartMsg = { type: 'message.bashStart' as const, payload: { sessionId, command, excludeFromContext: excludeFlag, timestamp: Date.now() } }
    this.bus?.publish(sessionId, bashStartMsg)

    // ── 调 pi bash + 广播终态 ──
    try {
      const result = await client.bash(command, excludeFromContext)
      this.handleBashSuccess(sessionId, command, excludeFlag, result, activeSession, myToken)
    } catch (e) {
      return this.handleBashFailure(sessionId, command, excludeFlag, e, activeSession, myToken)
    } finally {
      this.releaseBashReservation(sessionId, activeSession, myToken)
    }
    return { status: 'settled' }
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
    const activeSession = this.deps.getSessionByClient(client)
    if (activeSession) {
      if (activeSession.isCompacting || activeSession.isBashRunning) {
        console.warn(`[bash-dispatcher] sendBash preemptive reject (busy), sid=${sessionId}`)
        const rejectMsg = { type: 'send.rejected' as const, payload: { sessionId, reason: 'busy' as const, message: 'Agent 正在处理' } }
        this.bus?.publish(sessionId, rejectMsg)
        return null
      }
      // occupancy #7（D2 迁移）：sendBash 置位 → 'bash-start' 行（派生 isBashRunning=true +
      // 合并 bash=true；与 turn 维度正交，streaming 中可并存）。
      applySessionOccupancyTransition(activeSession, this.bus, 'bash-start')
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
   * message.bashAborted 帧（bash-effects 只清 executingBash 不产 entry）并旋转 token。旧逻辑
   * 在此静默丢弃真实结果——但 pi 侧 recordBashResult 对 cancelled 无分支照常落盘
   * （bash-executor abort 返回 cancelled 结果而非 throw），丢弃导致 live 无记录、重开多出
   * 一条（登记例外①）。哨兵帧与真实帧职责正交（一个只清态、一个产 entry，均幂等），
   * 双终态担忧不成立——故此处不再跳过，发布真实数据（含 streaming 双分支延迟，与 pi
   * 落盘位置一致）。例外收窄登记：仅 catch 分支（transport 抛错，无真实数据可发布）
   * 维持哨兵不产 entry。
   *
   * [W1 fix-chat-flow-order D2] 双分支镜像 pi recordBashResult（agent-session.js:2237-2247）：
   * pi 在 isStreaming 时把 bash 缓存到 _pendingBashMessages（run 级联 finally 统一落盘），
   * taiji 镜像为——session 处于活跃 run（isGenerating）时结果进待落列，agent_settled
   * （级联结束信号，晚于 pi 的 finally flush，探针 ②）到达时 flushPendingBashResults
   * 按序发布；空闲立即发布。已知窄竞态（设计已登记）：taiji 判空闲但 pi 实际 streaming
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
      console.warn(`[bash-dispatcher] sendBash: aborted during await, publishing real cancelled terminal. sid=${sessionId}`)
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
   * sendBash 失败收口（catch 体整体）：回执按执行状态收口（bash 投递可靠性契约）——
   * ① abort 抢收口竞态守卫（跳过重复报错，已执行已收口 → 'settled'）；
   * ② 通用错误兜底（错误 bashResult + message.error，S2 对称收口 → 'settled'）。
   * 失败原因随回执 error 携带（消费方 toast 用）。
   * [ADR-0112 退役登记] bash RPC 超时诚实文案分支（timeout-slow-flow-wallclock D2，
   * RpcTimeoutError 合成终态 + orphanBashRunning 标记）随 RPC 墙钟整体删除。
   */
  private handleBashFailure(
    sessionId: string,
    command: string,
    excludeFlag: boolean,
    e: unknown,
    activeSession: IManagedSessionView | undefined,
    myToken: string | undefined,
  ): InternalBashDispatchReceipt {
    const errMsg = toErrorMessage(e)
    console.error(`[bash-dispatcher] sendBash failed: sessionId=${sessionId}`, errMsg)
    // [W1] 竞态守卫：若 await 抛错是因 abortBash 抢先收口（如 abort_bash 触发 pi 关闭流），
    // 已有 cancelled bashResult 广播，此处不再发 message.error，避免双重报错。
    if (activeSession && myToken !== undefined && activeSession.bashRunToken !== myToken) {
      console.warn(`[bash-dispatcher] sendBash: aborted during await (catch), skip duplicate error. sid=${sessionId}`)
      // 命令已执行且已由 abortBash 收口（哨兵帧已广播）→ 'settled'
      return { status: 'settled', error: errMsg }
    }
    // [S2] 对称兜底：与 abortBash「无论成败都广播 bashResult 终态」对称。
    // 前端 message.error handler 只收口 streaming **assistant** 消息（finalizeSession 按
    // role==='assistant' 过滤），不收口 role==='system' 的 streaming bash 消息——
    // 若只发 message.error，前端 bash 气泡会卡在 streaming 态。故此处补发一条
    // cancelled:false + exitCode:null + output 含错误信息的 bashResult 终态让 bash 收口。
    // [W1 fix-chat-flow-order] 错误帧不进待落列（立即发布）：它是 taiji 合成帧，无 pi 落盘
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
    this.bus?.publish(sessionId, bashErrMsg)
    // 命令已执行并收口（错误终态帧已广播）→ 'settled'（消费方不得恢复草稿）
    return { status: 'settled', error: errMsg }
  }

  /**
   * sendBash finally 清理：复位 isBashRunning + 条件复位 token。仅当 token 仍是本次 sendBash
   * 的（未被 abortBash 旋转、也未被下一次 sendBash 覆盖）时才清，避免误清 abortBash 或后续
   * sendBash 的标记。
   */
  private releaseBashReservation(sessionId: string, activeSession: IManagedSessionView | undefined, myToken: string | undefined): void {
    if (activeSession) {
      // occupancy #7（D2 迁移）：sendBash finally（成功/失败/abort-skip 全路径）→ 'bash-end' 行
      // （派生 isBashRunning=false + 合并 bash=false）。
      applySessionOccupancyTransition(activeSession, this.bus, 'bash-end')
      // [MF-1-9] bash 结束边沿：唤醒投递内核持有期等待者（bash hold 释放）。
      this.deps.notifyHoldRelease?.(sessionId)
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
    this.bus?.publish(sessionId, { type: 'message.bashResult' as const, payload: { sessionId, ...data } })
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
    const session = this.deps.getSession(sessionId)
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
   * 与 abort() 对称：失败不 throw（console.error 兑底），finally 兑底广播 message.bashAborted
   * 独立帧——与 abort 广播 message.complete{aborted} 对称，前端据 bashAborted 收口 isBashRunning 态。
   *
   * 返回 sent = abort_bash 是否真的发出且 pi 确认（P6 断言④回执真实化）：调用方
   * （session-message-handler）据此决定回执——sent=true 才回 message.status{aborted}，
   * sent=false（守卫短路 / 发送失败）不得谎报 aborted。
   */
  async abortBash(sessionId: string): Promise<{ sent: boolean }> {
    const client = this.deps.getClient(sessionId)
    if (!client) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const activeSession = this.deps.getSessionByClient(client)
    // 守卫：isBashRunning（runtime 在等待）→ 放行；否则（空闲 session 的重复/误触取消）
    // 短路 { sent: false }，由调用方回执真实化。
    if (!activeSession?.isBashRunning) return { sent: false }
    // sent = abort_bash 是否发出且 pi 确认（sendCommand 对 success:false reject，resolve =
    // pi 已执行 abort）。失败不提前 return：兑底 bashAborted 广播必须照发（T8b 既有契约）。
    let sent = true
    try {
      await client.abortBash()
    } catch (e) {
      // 与 abort() 的错误兑底一致：不 throw，避免请求级 envelope 双重报错。孤儿标记保留：
      // abort_bash 失败（pi 卡死/管道断）时 bash 状态未知，标记残留只让下次 abortBash 再发
      // 一次幂等的 abort_bash，比误清（谎称无孤儿）更诚实。
      console.error(`[bash-dispatcher] abortBash failed: sessionId=${sessionId}`, toErrorMessage(e))
      sent = false
    } finally {
      if (activeSession) {
        // occupancy #11（D2 迁移）：abortBash（成败皆兜底）→ 'bash-end' 行，与下方 cancelled
        // 哨兵帧广播同源同点（pi 卡死时 abort_bash 无响应，靠 finally 保证维度复位）。
        applySessionOccupancyTransition(activeSession, this.bus, 'bash-end')
        // [MF-1-9] bash 结束边沿：唤醒投递内核持有期等待者（bash hold 释放）。
        this.deps.notifyHoldRelease?.(sessionId)
        // [W1] 旋转 token：通知 sendBash「已被 abort 抢先收口」。sendBash 在 await 返回后
        // 检测到 activeSession.bashRunToken !== myToken 即静默跳过终态广播，避免双终态。
        // 用新 token 而非清 undefined：若 sendBash 尚未读 myToken（仍在 await），清 undefined
        // 会让 sendBash 误判「无 abort」——而新 token 保证 sendBash 比对必然不等。
        activeSession.bashRunToken = `abort_${Date.now()}_${randomTokenSuffix()}`
      }
    }
    // 兑底终态（独立帧 message.bashAborted，msg-pipeline-debloat D4-3）：无论 pi 是否响应
    // abort_bash 都广播——pi 卡死时不发任何事件，靠这条让前端清 executingBash（UI 中止态，
    // 与 abort 广播 message.complete 同理）。真实 abort 结果由 sendBash await 返回后经
    // bashResult{cancelled:true} 照常发布（与 pi 落盘一致），与本帧职责正交。
    const abortMsg = {
      type: 'message.bashAborted' as const,
      payload: {
        sessionId,
        timestamp: Date.now(),
      },
    }
    this.bus?.publish(sessionId, abortMsg)
    return { sent }
  }
}

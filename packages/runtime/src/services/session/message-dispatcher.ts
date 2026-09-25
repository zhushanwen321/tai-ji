/**
 * MessageDispatcher — 从 session-service 巨石拆出的消息派发职责。
 *
 * 负责:sendMessage / abort / compact + sendMessageHook 注册 + bash 通道（BashDispatcher
 * 协作类持有）。
 *
 * [投递所有权内核 u2] 用户消息路径（sendMessage）**内核化**：投递所有权移交
 * SessionDeliveryRegistry（D1 单一所有者）——本类保留「BeforeSend hook 拦截 + 入口 touch +
 * 错误面编排」，投递交由 `registry.submit()`（lane 判定 + 裸标记 + 内核 FIFO + 两阶段回执
 * 全在注册表/内核侧）。退役面：busy 预检（rejectBusyPrecheck）、send.rejected 广播（budy
 * 类拒绝转译）、markSessionActive 三副作用（迁至注册表 deliverOne 的出站交接点，§3.4+ 表）、
 * skill 注入（迁至同一交接点——注入器所有权随出站交接点走）。保留面：BeforeSend hook
 * （提交前）、入口 touchActivity（idle-pi-reclamation D6-1）。pi busy 类拒绝识别函数
 * classifyPromptRejection 定义与消费均在注册表（session-delivery-registry.ts）。
 * [occupancy D2 拒绝转译] 错误分类迁移后由注册表的出站交接 catch 面消费（D6）。
 * [HISTORICAL] sendSubagentMessage(marker 拼装分支)已删除(composer 四符号设计 D2)——
 * 定向消息改走 session-service.subagentAction 直发 client.prompt,不经本骨架。
 * [MF-1-8 退役] steerMessage / followUpMessage 转发腿已删除——renderer/core 消费方经
 * delivery.submit 统一提交（u3b），协议侧 message.steer / message.follow_up 条目随
 * runtime transport 路由删除同批退役（u5a 退役条件兑现）。
 * 注：bash 通道（sendBash / abortBash）不经 LLM turn、不经投递内核，行为不变
 * （设计 §1.3 In/Out：bash 通道不在本期改造面）；[MF-1-10] 实现整体搬移至
 * bash-dispatcher.ts（对齐 abort-liveness 先例），本类构造持有并保持公开签名不变。
 *
 * 依赖经构造注入:svc(dispatcher 窄接口 IDispatcherSessionOps,按消费者收窄——
 * 调用点实测 6 方法,见 session-internal.ts)、
 * pm(getClient / 进程操作)、messageBus(发布,wave:perf-w09 接口收敛——
 * dispatcher 只依赖 publish 抽象,broker 依赖已删除:命令编排消息全部是
 * session 级 push 型,单通道走 bus 定向发布,broadcast 双写腿已收口)。
 * delivery（[MF-1-7 装配收编] 投递注册表）：经 setDeliveryRegistry 后置注入（组合根装配序：
 * 注册表创建晚于 SessionService/本类构造，后置注入对齐 setMessageBus 先例）——原进程内
 * 活动槽（getActiveDeliveryRegistry）已删除，依赖在 setter 可见。
 */
import type { IDispatcherSessionOps } from './session-internal.js'
import { runDestroyStepIsolated } from './session-entry-removal.js'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import type { SendMessageHook, ForceQuitSource } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { toErrorMessage, RpcTimeoutError } from '../../utils/errors.js'
import { applySessionOccupancyTransition, IDLE_SESSION_OCCUPANCY, userStoppedGate } from './event-interpreter.js'
import type { SessionDeliveryRegistry, DeliverySubmitResult } from './session-delivery-registry.js'
import type { DeliveryIntent } from '@zhushanwen/session-delivery'
import { AbortLiveness } from './abort-liveness.js'
import type { AbortSource } from './abort-liveness.js'
import { BashDispatcher } from './bash-dispatcher.js'

// abort 阶梯协作类（test-infra-source-simplify T5 抽离）：三级阶梯 + 防重入 + 处置竞态
// 独立单元在 abort-liveness.ts，本模块持实例并委托；resetAbortLivenessForTest re-export
// 保持原公开面（abort-liveness 测试与既有 import 方零改动）。AbortSource 类型消费方直接
// import abort-liveness（本模块仅内部使用，不再转写）。
export { resetAbortLivenessForTest } from './abort-liveness.js'

/**
 * sendMessage 回执 reason 词表（plugin-header-action-modal-points D6/AP-4，u5a）：
 * 投递所有权内核架构下受理段实际产出 = 'command-missing'（requireCommand 未命中）与
 * 'hook-blocked'（BeforeSend hook 拦截）两值；busy/compacting/bash 三态已随「排队取代
 * 拒绝」（D5）退役——暂不可收时态由内核持有，不再回拒。词表保留全值集为 interfaces
 * 层插件回执契约（plugin-sdk / plugin-service api/session-api 映射消费兼容），插件不得
 * 依赖 reason 精确值做行为分支（运行面只看 blocked）。
 */
export type SendPromptReason = 'busy' | 'compacting' | 'bash' | 'command-missing' | 'hook-blocked' | 'error'

/**
 * requireCommand 未命中的短重试参数（P9 探针定案，impl-plan u-probe 行）：命令可用 gap
 * 实测 1.3-3.0ms，500ms 间隔 × 6 次重试对 E4「30s 内首个 tick」约束留 10 倍余量。非
 * 任务级超时（AGENTS.md #19）：发送路径内的确定性失败探测，量级按恢复窗口校准。
 * 内核架构语义：client 未附着（restore 在途）时同样进入重试等待附着——附着后命令表
 * 即可探测；总预算 3s 内未附着或未命中均拒发（fail-closed）。
 */
const REQUIRE_COMMAND_RETRY_INTERVAL_MS = 500
const REQUIRE_COMMAND_RETRY_ATTEMPTS = 6

/**
 * sendSystemCommand 的判别结果（消息撤回 D1/D8）：编排按 kind 映射错误码——
 * 'sent' = prompt resolve（完成确认由调用方 get_entries 校验，受理口径不反映执行结果）；
 * 'extension-missing' = requireCommand 探测耗尽（fail-closed，命令串未进模型）；
 * 'pi-reclaimed' = ensureActive 拉活失败（终态码，区别于命令真缺失）；
 * 'error' = prompt 抛错（传输级；pi 侧 command 执行错误不发此形态——command 抛错只发
 * extension error 事件、prompt 照常成功 'sent'，缺陷面由调用方事后校验兜住）。
 */
export type SystemCommandOutcome =
  | { kind: 'sent' }
  | { kind: 'extension-missing' }
  | { kind: 'pi-reclaimed' }
  | { kind: 'error'; message: string }

export class MessageDispatcher {
  private sendMessageHook: SendMessageHook | null = null
  /** per-session 受理串行链（hook 竞态顺序闭合，见 sendMessage；settled 后自清）。 */
  private readonly sendMessageChains = new Map<string, Promise<unknown>>()

  /**
   * abort 阶梯协作实例（W7 三级阶梯 + 防重入 + 处置竞态，实现见 abort-liveness.ts）。
   * deps 回调经宿主转发：publish 动态读 this.messageBus（setMessageBus 后置注入后仍正确），
   * forceQuitSession 复用宿主编排（与 forceQuit 入口共用同一条收敛链）。
   */
  private readonly abortLiveness: AbortLiveness

  /**
   * bash 通道协作实例（[MF-1-10] 实现在 bash-dispatcher.ts，本类构造持有；公开方法
   * sendBash/abortBash/flushPendingBashResults 签名不变，session-service 消费面零改动）。
   */
  private readonly bash: BashDispatcher

  /**
   * 投递注册表（[MF-1-7 装配收编]）：经 setDeliveryRegistry 后置注入（组合根装配序所迫，
   * 对齐 setMessageBus 后置注入先例）。未接线时 submitToKernel 显式失败（不静默）。
   */
  private delivery?: SessionDeliveryRegistry

  constructor(
    private readonly svc: IDispatcherSessionOps,
    private readonly pm: IProcessManager,
    private readonly workspaceService: WorkspaceService,
    private messageBus?: IMessageBus,
  ) {
    this.abortLiveness = new AbortLiveness({
      getClient: (sessionId) => this.pm.getClient(sessionId),
      persistSessionOutcome: (sessionId, outcome, reason) => this.svc.persistSessionOutcome(sessionId, outcome, reason),
      publish: (sessionId, msg) => this.messageBus?.publish(sessionId, msg),
      forceQuitSession: (sessionId, outcomeReason, exitReason, source) =>
        this.forceQuitSession(sessionId, outcomeReason, exitReason, source),
    })
    this.bash = new BashDispatcher({
      ensureActive: (sessionId) => this.svc.ensureActive(sessionId),
      getSessionByClient: (client) => this.svc.getSessionByClient(client),
      getSession: (sessionId) => this.svc.getSession(sessionId),
      getClient: (sessionId) => this.pm.getClient(sessionId),
      getMessageBus: () => this.messageBus,
      notifyHoldRelease: (sessionId) => this.delivery?.notifyHoldRelease(sessionId),
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

  /**
   * 后置注入投递注册表（[MF-1-7 装收编] 组合根经 SessionService 同名转发调用；注册表创建
   * 晚于本类构造，此 setter 是唯一注入通道）。幂等覆盖（同实例重复注入无害）。
   */
  setDeliveryRegistry(registry: SessionDeliveryRegistry): void {
    this.delivery = registry
  }

  /** 注册消息发送前 hook(PluginService 调用,实现 beforeSend 拦截)。 */
  setSendMessageHook(hook: SendMessageHook): void {
    this.sendMessageHook = hook
  }

  /**
   * 用户消息发送入口（message.send / delivery.submit RPC / plugin-service / handoff 通路）
   * ——「入口 touch + BeforeSend hook + 内核提交」的唯一组合点，两条 RPC 入口共用同一
   * veto/transform 面（tech-design must-fix ①：hook 不得旁路出第二个提交通道）。
   *
   * 返回 { blocked: true } 表示消息被 BeforeSend hook 拦截（已广播 message.error 错误气泡），
   * 调用方（session-message-handler）必须据此走 error envelope（带请求 id）让 renderer
   * pending.reject，不得 reply success（round7 must-fix #3：避免「composer 清空 + 错误气泡」矛盾态）。
   *
   * [投递所有权内核 u2] 三层职责（D1 单一所有者）：①入口同步 touch（idle 回收防误杀）
   * ②BeforeSend hook 拦截（提交前，唯一 veto 面；受理阶段一次语义——内核投递执行点
   * requeue/rebuild/adopt 可重入，重投不得重复过 hook，防 transform 双重改写）③内核提交
   * `registry.submit()`（lane 判定 + 裸标记 + 内核 FIFO + 两阶段回执），受理回执经
   * receipt 透出供 delivery.submit reply 使用。
   * busy 预检与 send.rejected 已退役——排队取代拒绝（D5）：暂不可收时态（compacting / bash）
   * 由内核持有，settled 边沿/对账器驱动投递，消息不再被拒回 renderer。
   *
   * [hook 竞态顺序闭合（复审 R2）] 同 session 并发提交按 per-session 链串行：hook 是异步
   * 等待（Worker RPC，单 handler 5s 超时），而 WS 分发逐帧 fire-and-forget——不串行时
   * hook 完成序可倒置内核提交序（内核 FIFO 保提交序而非发送序，G1/V6 可违）。串行化让
   * 到达序 = 提交序；链只含 hook + 同步内核提交（有界：hook 数 × 5s），settled 后自清。
   *
   * rejected 返回值保留为类型完备（恒 undefined）——handler 的 message.status{rejected}
   * ack 分支自此不可达，protocol 条目退役归 u5。
   *
   * [plugin-header-action-modal-points D6/u5a] requireCommand 透传（可选，既有调用方零改动）：
   * 插件写路径的前置原子校验，插入点见 runAcceptance 内注释。回执 reason 词表见 SendPromptReason。
   */
  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>, clientUuid?: string, requireCommand?: string): Promise<{ blocked: boolean; rejected?: boolean; receipt?: DeliverySubmitResult; reason?: SendPromptReason }> {
    // ── 入口同步 touch（idle-pi-reclamation D6-1，任何 await 之前）──
    // 出站交接（ensureActive/restore 600ms-3s + prompt）在注册表侧异步发生，若不入口
    // touch，「hook 执行中 + 交接在途」窗口内空闲回收判定会误回收在途 session。
    // client 未附着（已回收态）时无需 touch：restore spawn 的新 client lastActivityAt
    // 初值 = spawn 时刻，空闲时长天然不达标。
    this.pm.getClient(sessionId)?.touchActivity()

    // ── per-session 受理串行链（到达序 = 内核提交序）──
    // 前驱失败不毒化链（catch 吞 rejection，错误面已由链内各层自广播）。
    const prev = this.sendMessageChains.get(sessionId) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(() => this.runAcceptance(sessionId, content, images, clientUuid, requireCommand))
    this.sendMessageChains.set(sessionId, run)
    run.then(
      () => this.releaseSendChain(sessionId, run),
      () => this.releaseSendChain(sessionId, run),
    )
    return run
  }

  /** 受理段（hook + requireCommand 校验 + 内核提交）——仅经 per-session 串行链进入。 */
  private async runAcceptance(
    sessionId: string,
    content: string,
    images?: Array<{ data: string; mimeType: string }>,
    clientUuid?: string,
    requireCommand?: string,
  ): Promise<{ blocked: boolean; rejected?: boolean; receipt?: DeliverySubmitResult; reason?: SendPromptReason }> {
    // ── BeforeSend hook（提交前唯一拦截面）──
    // blocked: 已广播 message.error（错误气泡），此处返回 {blocked:true} 让 handler 改发 error envelope。
    // modifiedContent: hook 改写后的文本（transform 语义，Fix-1），未改写时回退原文。
    // [D6/u5a] reason:'hook-blocked' 为回执面增量（hook 管道既有 reason 已随 message.error 上浮）。
    const hookOutcome = await this.runBeforeSendHook(sessionId, content)
    if (hookOutcome.blocked) {
      return { blocked: true, reason: 'hook-blocked' }
    }

    // ── requireCommand 原子校验（plugin-header-action-modal-points D6/u5a）──
    // 插件写路径前置校验：未命中 → 拒发回执（reason='command-missing'），不广播
    // message.error——回执机制（E14）就是它的反馈面，命令串不进模型、对话流无新消息。
    // 校验位置 = hook 之后、内核提交之前（main 侧原位置为「restore 之后、busy 预检之前」，
    // 内核架构下 busy 预检已退役；restore 窗口由 ensureCommandAvailable 的重试循环覆盖：
    // client 未附着时按间隔重取，附着后命令表即可探测，总预算耗尽 fail-closed）。
    if (requireCommand !== undefined) {
      const available = await this.ensureCommandAvailable(sessionId, requireCommand)
      if (!available) {
        console.warn(
          `[message-dispatcher] requireCommand "${requireCommand}" not registered after ${REQUIRE_COMMAND_RETRY_ATTEMPTS} retries, rejecting send (reason=command-missing), sid=${sessionId}`,
        )
        return { blocked: true, rejected: true, reason: 'command-missing' }
      }
    }

    const receipt = this.submitToKernel(sessionId, hookOutcome.modifiedContent ?? content, { images, clientUuid })
    return { blocked: false, receipt }
  }

  /**
   * requireCommand 探测（plugin-header-action-modal-points D6/u5a）：直连
   * client.getCommands()（不走 sessionService.getCommands 的 markDirty 查询语义——那是
   * UI 状态查询面路径），未命中按间隔短重试。client 未附着（restore 在途）同样进入
   * 重试等待——附着后命令表即可探测；总预算耗尽 fail-closed（拒发由调用方收口）。
   * 探测 RPC 失败（transport 抖动等）视同未命中参与重试，不中断发送主流程——
   * warn 落日志留排查线索（非静默吞）。
   */
  private async ensureCommandAvailable(sessionId: string, requireCommand: string): Promise<boolean> {
    for (let attempt = 0; attempt <= REQUIRE_COMMAND_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, REQUIRE_COMMAND_RETRY_INTERVAL_MS))
      }
      const client = this.pm.getClient(sessionId)
      if (!client) continue
      try {
        const commands = await client.getCommands()
        if (commands.some((c) => c.name === requireCommand)) return true
      } catch (e) {
        // 降级策略（best-effort 探测）：单次 RPC 抖动视同未命中参与下一轮重试（总预算
        // 耗尽 fail-closed），不中断发送/信令主流程——warn 留排查线索，非静默吞。
        console.warn(
          `[message-dispatcher] requireCommand probe failed (attempt ${attempt + 1}/${REQUIRE_COMMAND_RETRY_ATTEMPTS + 1}):`,
          toErrorMessage(e),
        )
      }
    }
    return false
  }

  /** 串行链尾自清：本 run 仍是链尾时释放槽位（跨 session 恒不互相阻塞）。 */
  private releaseSendChain(sessionId: string, run: Promise<unknown>): void {
    if (this.sendMessageChains.get(sessionId) === run) {
      this.sendMessageChains.delete(sessionId)
    }
  }

  /**
   * 系统信令入口（消息撤回设计 D1：sendSystemCommand）——与用户消息链路（sendMessage）
   * 刻意分流的旁路通道，供 runtime 编排对 pi 触发 extension command（`/` 前缀 prompt——
   * pi 同步执行、不进模型、无 turn，P2 前提）。
   *
   * 分流契约（D1 逐条）：
   * - **不经 runBeforeSendHook**：系统指令不是用户消息，不暴露给插件 veto/transform 改写面
   *   （hook 的 transform 可破坏命令形态，D1 否决记录的第三缺陷）；
   * - **不经 registry.submit**：无裸标记尾附（标记会污染 command args 使 navigateTree throw）、
   *   无内核条目、无车道判定——信令不被 hold/排队（撤回编排自持 revoking hold，若经内核
   *   提交会自锁死等）；
   * - **复用 ensureCommandAvailable 探测**（requireCommand 语义保留：命令未注册 fail-closed
   *   extension-missing，命令串不进模型）；
   * - **前置 ensureActive 交接 + 入口 touchActivity**：restore 的唯一触发点在内核出站交接，
   *   旁路必须自带——否则「发错消息隔久回来撤」形态下 pi 已被空闲回收，纯探测耗尽误报
   *   extension-missing 且诊断错位；touch 防「探测+prompt 在途窗口被回收器误杀」。
   *
   * 返回判别结果（不 throw——编排按 kind 映射 D8 错误码；'error' = prompt 抛错等传输级
   * 失败，编排归 nav-failed 可重试）。
   */
  async sendSystemCommand(
    sessionId: string,
    commandLine: string,
    requireCommand?: string,
  ): Promise<SystemCommandOutcome> {
    // ── 入口同步 touch（idle-pi-reclamation D6-1，任何 await 之前——与 sendMessage 同款）──
    this.pm.getClient(sessionId)?.touchActivity()
    // ── ensureActive 交接（旁路自带的 restore 触发点；拉活失败 = pi-reclaimed 终态码）──
    let client: IPiEngine
    try {
      client = await this.svc.ensureActive(sessionId)
    } catch (e) {
      console.error(`[message-dispatcher] sendSystemCommand: ensureActive failed, sid=${sessionId}`, toErrorMessage(e))
      return { kind: 'pi-reclaimed' }
    }
    // 拉活后 touch：restore spawn 的新 client lastActivityAt 初值 = spawn 时刻（天然新鲜），
    // 此处防御性刷新覆盖「探测重试循环（≤3s）+ prompt 在途」窗口的回收误杀。
    client.touchActivity()
    if (requireCommand !== undefined) {
      const available = await this.ensureCommandAvailable(sessionId, requireCommand)
      if (!available) {
        console.warn(
          `[message-dispatcher] sendSystemCommand: command "${requireCommand}" not registered after ${REQUIRE_COMMAND_RETRY_ATTEMPTS} retries (fail-closed), sid=${sessionId}`,
        )
        return { kind: 'extension-missing' }
      }
    }
    try {
      await client.prompt(commandLine)
    } catch (e) {
      console.error(`[message-dispatcher] sendSystemCommand: prompt failed, sid=${sessionId}`, toErrorMessage(e))
      return { kind: 'error', message: toErrorMessage(e) }
    }
    return { kind: 'sent' }
  }

  /**
   * 内核提交（提交路径共用）：取 setDeliveryRegistry 装配的注册表（[MF-1-7] 组合根单例）
   * → `submit`（受理口径，D9⑤：同步返回受理回执，不等送达）。
   *
   * 装配缺失（无注册表 = 组合根未接线）：显式失败（message.error 广播 + 返回 undefined），
   * 不静默丢消息（"失败要出声"）。
   */
  private submitToKernel(
    sessionId: string,
    content: string,
    opts: { images?: Array<{ data: string; mimeType: string }>; clientUuid?: string; intent?: DeliveryIntent },
  ): DeliverySubmitResult | undefined {
    const registry = this.delivery
    if (!registry) {
      const errMsg = 'delivery registry not wired (composition root)'
      console.error(`[message-dispatcher] submit rejected: ${errMsg}, sid=${sessionId}`)
      this.messageBus?.publish(sessionId, { type: 'message.error', payload: { sessionId, message: `消息未发送：${errMsg}` } })
      return undefined
    }
    const result = registry.submit(sessionId, {
      content,
      ...(opts.images !== undefined && { images: opts.images }),
      ...(opts.clientUuid !== undefined && { clientUuid: opts.clientUuid }),
      ...(opts.intent !== undefined && { intent: opts.intent }),
    })
    console.log(
      `[message-dispatcher] submitted to delivery kernel: sid=${sessionId}, id=${result.clientUuid}, lane=${result.lane}, state=${result.state}`,
    )
    return result
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
    const client = this.getClientOrThrow(sessionId)
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
    // [投递所有权内核 u2 / D3 触发点③ + D10 子形态] abort 完成 → occupancy 已复位 idle →
    // 对账器本轮回收 pi 槽位滞留（abort 不清 pi 队列，F5）并立即重投，避免用户消息滞留
    // 等下一次发送才被顺带取走（故事 B 形态）。fire-and-forget（对账内部自节流/幂等）。
    void this.delivery?.reconcile(sessionId, 'abort-idle')
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
      // 不在活跃进程表（已退出 / 未 spawn）：无可杀对象。菜单入口对 dead/idle
      // 历史 session 隐藏，此分支是「菜单渲染后 session 恰好退出」的竞态兑底。
      // [U3 修复] 早退也须置 userStopped 标记：用户点「强制退出」的意图与进程死活无关
      // （与 K1 同源）——无 client 时 pi 可能已自行 spawn 恢复链（restore replay turn），
      // 缺标记会让后续 restore 的收敛环不设防，被杀的旧执行复活。
      // [code-harden RT-4#1] 幂等成功仅限「无条目或占用已复位」：条目还在且 occupancy≠idle
      // 时，占用态已卡死且事件源已断（无进程可再产生 agent_settled）——按「幂等成功」返回
      // 是假成功（前端 isGenerating/turn 投影永久滞留），必须继续走 forceQuitSession 完整
      // 收敛链（stopped 终态 + full-reset + session.exited + removeEntry）。
      const session = this.svc.getSession(sessionId)
      const occ = session?.occupancy ?? IDLE_SESSION_OCCUPANCY
      const occupied = occ.turn !== 'idle' || occ.compacting || occ.bash
      if (!session || !occupied) {
        console.log(`[message-dispatcher] forceQuit: session ${sessionId} not active, nothing to kill (userStopped mark still set)`)
        userStoppedGate.markUserStopped(sessionId, 'user_force_quit')
        return
      }
      console.warn(`[message-dispatcher] forceQuit: session ${sessionId} has no live process but occupancy not idle (turn=${occ.turn}${occ.compacting ? ', compacting' : ''}${occ.bash ? ', bash' : ''}) — running convergence chain instead of idempotent success`)
      await this.forceQuitSession(sessionId, 'User forced quit', '用户强制退出，进程已终止。重新打开该 session 即可恢复（历史完整）。', 'user_force_quit')
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
   *
   * [code-harden RT-4#1] 失败语义：编排体 try/finally——detach / destroy / persist 失败
   * 降级为日志，不再阻断收敛；三步终态（full-reset / session.exited 广播 / removeEntry）
   * 在 finally 中必达（占位投影复位 + 前端 dead 标记 + 条目摘除），任一步异常只落日志 +
   * crash 台账（runDestroyStepIsolated，reason=destroy-chain-step-failed），不沿调用链上抛。
   * 本链刻意不含 respawn.schedule / config.sessions（用户手动强杀结构性不触发自动恢复，
   * 见 registerSessionExitHandler 注释——respawn 承诺只挂 onSessionExit 链）。
   */
  private async forceQuitSession(sessionId: string, outcomeReason: string, exitReason: string, source: ForceQuitSource): Promise<void> {
    userStoppedGate.markUserStopped(sessionId, source)
    try {
      // 先 detach 再 destroy——destroySession 会删 processes/clientToId 条目，
      // 之后再经 getSessionByClient 反查会拿 undefined。
      this.svc.detachSession(sessionId)
      await this.pm.destroySession(sessionId)
      // stopped 终态须在 removeSessionEntry 前写（persistSessionOutcome 内部按 id 查
      // sessions Map，条目删除后静默跳过）。
      this.svc.persistSessionOutcome(sessionId, 'stopped', outcomeReason)
    } catch (e: unknown) {
      // detach/destroy/persist 失败只降级日志：收敛（终态三步）必须继续。
      console.error(`[message-dispatcher] forceQuitSession pre-terminal steps failed (sessionId=${sessionId}):`, e)
    } finally {
      // occupancy #10（D2 迁移，forceQuit/abort 超时收敛腿）：进程被强杀后 agent_settled /
      // compaction_end 永不到达，'full-reset' 行三维全复位 + 三布尔派生同步复位（结构上不再有
      // 「只复位一边」）——session.exited 广播前发，且必须在 removeSessionEntry（内部
      // bus.clearSession）之前，否则帧送空集合。
      runDestroyStepIsolated('full-reset', sessionId, () => {
        const exiting = this.svc.getSession(sessionId)
        if (exiting) applySessionOccupancyTransition(exiting, this.messageBus, 'full-reset')
      })
      // session.exited 须在 removeSessionEntry 前发（其后 messageBus.clearSession 清空
      // 订阅者集合，再发等于空投，前端一条也收不到）。code=null：强杀场景退出码未知，
      // 与 shared 协议「被信号杀死无退出码」语义一致。前端 handleSessionExited 会把
      // reason 作为 error 消息插入聊天流 + toast（与 pi 崩溃路径同一入口）。
      runDestroyStepIsolated('session.exited', sessionId, () => {
        const exitedMsg = { type: 'session.exited' as const, payload: { sessionId, code: null, reason: exitReason } }
        this.messageBus?.publish(sessionId, exitedMsg)
      })
      runDestroyStepIsolated('removeSessionEntry', sessionId, () => {
        this.svc.removeSessionEntry(sessionId)
      })
    }
  }

  /**
   * 直接执行 bash 命令（pi bash RPC，不经 LLM turn）——[MF-1-10] 委托 BashDispatcher
   * （实现整体搬移至 bash-dispatcher.ts；公开签名与行为逐字保持，时序不变量见彼处）。
   */
  sendBash(
    sessionId: string,
    command: string,
    excludeFromContext?: boolean,
  ): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.bash.sendBash(sessionId, command, excludeFromContext)
  }

  /**
   * [W1 fix-chat-flow-order D2] 按 sessionId 定向 flush bash 待落列——[MF-1-10] 委托
   * BashDispatcher（session-service 经 EventInterpreter.onAgentSettled 调用，签名不变）。
   */
  flushPendingBashResults(sessionId: string): void {
    this.bash.flushPendingBashResults(sessionId)
  }

  /**
   * 取消进行中的 bash 执行（pi abort_bash）——[MF-1-10] 委托 BashDispatcher（sent 回执
   * 真实化语义保持，见彼处方法头）。
   */
  abortBash(sessionId: string): Promise<{ sent: boolean }> {
    return this.bash.abortBash(sessionId)
  }

  /**
   * abort 共享的「getClient → 空抛」骨架。报错串保持 abort 历史形态（无前缀，测试锚定文本）；
   * bash 通道（abortBash）的同款骨架随 MF-1-10 搬移至 BashDispatcher（报错串逐字一致）。
   */
  private getClientOrThrow(sessionId: string): IPiEngine {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`Session ${sessionId} not found`)
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

    // [RT-4#10] 预检与置位原子化：预检通过后立即写 'compacting-start'（原语义 = 只在 pi
    // compaction_start 事件回流后由 interpreter 置位，事件往返窗内第二个 compact 的预检
    // 仍读 false → 两连发双双通过 → 双 compaction 事件流）。事件回流时 interpreter 的
    // 'compacting-start' 经原语全等去重幂等（不双写）。RPC 为同步等待压缩完成（pi 0.84.4
    // agent-session.js:1468 compact() await 全程），finally 的 'compacting-end' 复位与
    // compaction_end 事件三路对称复位语义保持。
    if (active) {
      applySessionOccupancyTransition(active, this.messageBus, 'compacting-start')
    }

    // 事件驱动（M4）：不广播 session.compacting——由 interpreter 从 compaction_start 事件驱动
    // （置位例外见上方 [RT-4#10]：预检互斥窗口要求 dispatcher 侧先行）。dispatcher 做 RPC 触发 + 失败复位。
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
      // interpreter 未触发 compaction_end 导致 session 卡死。[RT-4#10] 置位移到预检后，本复位
      // 从「对 false 幂等无害」变为真实复位路径（成功路径与 compaction_end 事件幂等去重）。
      if (active) {
        // occupancy #6 兜底（D2 迁移，'compacting-end' 行）：transport 级失败时 compaction_end
        //（#6）不到达，compacting 维度在此镜像复位（派生 isCompacting=false；对未置位场景幂等无害）。
        applySessionOccupancyTransition(active, this.messageBus, 'compacting-end')
        // [MF-1-9] compacting 复位边沿：唤醒投递内核持有期等待者（兜底复位也是边沿源——
        // pi compaction_end 事件不可达时，这里是 compacting hold 释放的唯一信号）。
        this.delivery?.notifyHoldRelease(sessionId)
      }
    }
  }
}

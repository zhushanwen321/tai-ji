/**
 * 投递内核实现：createDelivery。
 *
 * 核心行为（design.md §3.3 D4/D8）：
 * - send() 入队 → dedupe → 合批窗口判定 → 立即投或窗口到期投
 * - flush() → busy gate（isIdle + hasPendingMessages 双条件，G4）→ port.send
 * - settled 边沿 → busy 复核通过 → flush；有订阅装配下 busy 只依赖边沿 + watch-dog（不退避强发）
 * - watch-dog 低频复核（D8 兜底层①：settled 事件丢失的恢复路径）
 * - port.send 失败 → 消息留在途、按 backoff 有限重试，达上限 settle rejected（D4 错误重试）
 * - 终态上报 per-message（ext-simplify-08 D1/B1）：onSettled 对批次内每条消息各回调
 *   一次，msg 为该条原始消息（非 composed 合批消息）；单消息批次行为不变
 * - sendChecked() 统一经投递循环：resolve 挂钩 port.send 受理结果（busy 时经
 *   streaming 受理入 pi 队列即回，以此确认可达）；首次受理失败即 reject（入口即拦）
 * - in-flight 防重：单 handle 至多一个 port.send 在途
 */

import { LruSet } from './lru.js'
import type {
  DeliveryConfig,
  DeliveryHandle,
  DeliveryIntent,
  DeliveryMessage,
  DeliveryPort,
  SendReceipt,
} from './types.js'

/**
 * U4 warn 出口注入（设计 docs/architecture/pi-boundary-reliability.md 附录 D §5 U4）：
 * 装配方接 extensionLogger 使投递失败警告落 `<dataDir>/logs/`（console.warn 走
 * stderr tee 不到日志盘——排查无痕）。通用包不硬依赖 xyz logger，故以可选注入
 * 挂载；正式化并入 types.ts 的 DeliveryConfig 属领地外变更，暂以交叉类型承载。
 */
export interface DeliveryWarnSink {
  /** 投递失败/异常警告出口。缺省 console.warn（前缀 `[session-delivery]`）。 */
  warn?: (msg: string, err?: unknown) => void
}

/** createDelivery 配置（DeliveryConfig + warn 出口注入）。 */
export type DeliveryConfigWithWarn = DeliveryConfig & DeliveryWarnSink

/** 默认配置（D4 策略默认值）。 */
const DEFAULT_CONFIG: Required<
  Omit<DeliveryConfig, 'mergeHoldActive' | 'dedupe' | 'onSettled'>
> = {
  intent: 'interrupt-at-turn-boundary',
  busyPolicy: 'retry-force',
  mergeWindowMs: 0,
  backoff: { ms: 100, max: 50 },
  watchdogMs: 30_000,
}

/** sendChecked 的挂账：resolve/reject 挂钩所属消息的 port.send 受理结果。 */
interface CheckedWaiter {
  msg: DeliveryMessage
  resolve: () => void
  reject: (err: unknown) => void
}

function isThenable(v: unknown): v is Promise<SendReceipt | void> {
  return !!v && typeof (v as Promise<SendReceipt | void>).then === 'function'
}

/**
 * 合批拼接（D4：调用方预格式化，内核只拼接）。
 * 多条以 "\n\n---\n\n" join；custom 批次的 details 包装为 { batch: true, items }，
 * items 元素 = 各消息的 details（custom 且有 details 时，notifier 的 record 即在
 * details 下，渲染器按 item 顶层 record 字段读）或 payload 本身（text / 无 details）。
 */
function buildBatchPayload(messages: DeliveryMessage[]): DeliveryMessage {
  if (messages.length === 1) return messages[0]!

  const contents = messages.map((m) => m.payload.content)
  const content = contents.join('\n\n---\n\n')

  // payload kind 取第一条的 kind（同批次应同 kind）
  const first = messages[0]!
  if (first.payload.kind === 'custom') {
    return {
      ...first,
      payload: {
        kind: 'custom',
        customType: first.payload.customType,
        content,
        display: first.payload.display,
        details: {
          batch: true,
          items: messages.map((m) =>
            m.payload.kind === 'custom' && m.payload.details !== undefined
              ? m.payload.details
              : m.payload,
          ),
        },
      },
    }
  }
  return {
    ...first,
    payload: { kind: 'text', content },
  }
}

/**
 * settle 属于 batch 的 checked waiter（原地更新 checkedPending）。
 * 成功（err undefined）：resolve；失败：reject 并返回被 reject 的消息集合
 * （这些消息不再参与错误重试——入口即拦语义，失败已同步交给调用方）。
 */
function settleChecked(
  batch: DeliveryMessage[],
  err: unknown,
  checkedPending: CheckedWaiter[],
): Set<DeliveryMessage> {
  const rejected = new Set<DeliveryMessage>()
  if (checkedPending.length === 0) return rejected
  const batchSet = new Set(batch)
  const kept: CheckedWaiter[] = []
  for (const w of checkedPending) {
    if (!batchSet.has(w.msg)) {
      kept.push(w)
      continue
    }
    if (err === undefined) {
      w.resolve()
    } else {
      w.reject(err)
      rejected.add(w.msg)
    }
  }
  checkedPending.length = 0
  checkedPending.push(...kept)
  return rejected
}

/**
 * 创建投递句柄。
 *
 * 约束：同 session 必须单例 handle（多 handle 并发投递竞态无保护）。
 * subscribeSettled 的退订语义由适配器负责兑现。
 */
export function createDelivery(
  port: DeliveryPort,
  config?: DeliveryConfigWithWarn,
): DeliveryHandle {
  // 合并配置
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    backoff: config?.backoff ?? DEFAULT_CONFIG.backoff,
  }

  // ─── 内部状态 ─────────────────────────────────────────────
  // @data-owner #15（docs/architecture/data-source-registry.md）：本队列是「已向发起方
  // 确认 queued 的待投递消息」的内存 outbox——非持久，runtime 重启即丢、错误重试耗尽
  // reject 仅在有 onSettled 记账腿的调用方（scheduler）可见。
  const queue: DeliveryMessage[] = []
  /** sendChecked 等待受理确认的挂账（消息在 queue 或 inflightBatch 中）。 */
  const checkedPending: CheckedWaiter[] = []
  /**
   * 在途批次：doSend/checked 直投从 queue 剥离后、终态（delivered/rejected）前持有。
   * port.send 失败时消息留在本数组按 backoff 重试（成功才真正离队，D4 错误重试）。
   */
  let inflightBatch: DeliveryMessage[] = []
  let inFlight = false // in-flight 防重：至多一个 port.send 在途（含错误重试期间）
  let sendAttempts = 0 // 当前在途批次的 port.send 尝试次数（错误重试计数）
  let mergeTimer: ReturnType<typeof setTimeout> | undefined
  let backoffTimer: ReturnType<typeof setTimeout> | undefined
  let watchdogTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let settledUnsub: (() => void) | undefined
  let missingKeyWarned = false // #12 dedupeKey 缺失提示按 handle 一次性

  // 去重
  const dedupSet = config?.dedupe ? new LruSet(config.dedupe.maxKeys) : null

  // ─── 合批窗口 timer ─────────────────────────────────────────
  // 拆 clear/arm 两半：合批路径用 resetMergeTimer（清旧 + 重设窗口）；非合批路径
  // 只 clear——立即投递无窗口语义，重设会留下一个到期触发 flush 的孤儿 timer
  // （park 策略下成为意外的「外部触发」，把本应等待的消息冲出）。
  function clearMergeTimer(): void {
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer)
      mergeTimer = undefined
    }
  }

  function armMergeTimer(): void {
    if (cfg.mergeWindowMs <= 0) return
    mergeTimer = setTimeout(() => {
      mergeTimer = undefined
      flush()
    }, cfg.mergeWindowMs)
  }

  /** 合批窗口重置：清旧 timer + 重设窗口（useMerge 路径专用）。 */
  function resetMergeTimer(): void {
    clearMergeTimer()
    armMergeTimer()
  }

  // ─── busy 判定（isIdle + hasPendingMessages 双条件，G4）────
  // 旧 scheduler gate 为 !isIdle() || hasPendingMessages()；内核单判 isIdle 会把
  // 「idle 但 pi 队列尚有消息未注入」误判为可投，提前投递与迁移前不等价。
  function isBusy(): boolean {
    if (!safeIsIdle()) return true
    try {
      return port.hasPendingMessages()
    } catch {
      // 探测异常（session 关闭等）→ 保守视为 busy 不投
      return true
    }
  }

  // ─── isIdle 安全调用（catch → 视为不可发送） ──────────────
  function safeIsIdle(): boolean {
    try {
      return port.isIdle()
    } catch {
      // session 已关闭等异常 → 视为不可发送
      return false
    }
  }

  // ─── settled 订阅管理 ──────────────────────────────────────
  function ensureSettledSub(): void {
    if (settledUnsub || !port.subscribeSettled) return
    settledUnsub = port.subscribeSettled(() => {
      if (disposed) return
      // settled 边沿 → busy 复核（isIdle 已先于事件复位，agent-session.js:327-336）→ flush
      if (!isBusy()) {
        flush()
      }
    })
  }

  function teardownSettledSub(): void {
    if (settledUnsub) {
      settledUnsub()
      settledUnsub = undefined
    }
  }

  // ─── watch-dog（D8 兜底层①：settled 事件丢失的恢复路径）───
  function startWatchdog(): void {
    if (watchdogTimer !== undefined) return
    if (!port.subscribeSettled) return // 无订阅装配不用 watch-dog（退化为退避强发）
    watchdogTimer = setInterval(() => {
      if (disposed || inFlight) return
      if (queue.length === 0) return
      if (!isBusy()) {
        flush()
      }
    }, cfg.watchdogMs)
  }

  function stopWatchdog(): void {
    if (watchdogTimer !== undefined) {
      clearInterval(watchdogTimer)
      watchdogTimer = undefined
    }
  }

  // ─── checked 挂账结算 ──────────────────────────────────────
  // settleChecked 见模块级（buildBatchPayload / settleChecked 为无状态纯函数）

  // ─── attemptSend：对 inflightBatch 执行 port.send ─────────
  function attemptSend(): void {
    const batch = inflightBatch
    const composed = buildBatchPayload(batch)
    const intent: DeliveryIntent = composed.intent ?? cfg.intent
    try {
      const result = port.send(composed, intent)
      if (isThenable(result)) {
        result.then(
          (receipt) => onSendReceipt(receipt),
          (err: unknown) => onSendFail(err),
        )
      } else {
        onSendReceipt(result)
      }
    } catch (err) {
      onSendFail(err)
    }
  }

  /**
   * 受理判定（U2 回执口径）：显式 `{accepted:false}` → 发送失败路径（错误重试 /
   * reject 链路）；void / `{accepted:true}` / 其他形态 = 受理成功（旧 port 兼容）。
   */
  function onSendReceipt(receipt: SendReceipt | void): void {
    if (receipt !== undefined && receipt.accepted === false) {
      onSendFail(new Error(receipt.reason ?? 'port.send rejected (accepted:false)'))
      return
    }
    onSendOk()
  }

  function onSendOk(): void {
    if (disposed) return
    const delivered = inflightBatch
    inFlight = false
    inflightBatch = []
    sendAttempts = 0
    settleChecked(delivered, undefined, checkedPending)
    // per-message 终态（ext-simplify-08 D1/B1）：批次内每条各回调一次，msg 为该条
    // 原始消息（composed 只带首条 identity，非首条收不到回调 = 合批记账断头）；
    // 回调内 dispose → 剩余条目不再回调（与 dispose 丢弃队列不触发 onSettled 契约一致）
    for (const m of delivered) {
      if (disposed) break
      cfg.onSettled?.(m, 'delivered')
    }
    pump()
  }

  function onSendFail(err: unknown): void {
    if (disposed) return
    sendAttempts++
    // 入口即拦：checked 消息首次受理失败即 reject，并从在途剔除（失败同步交给调用方，
    // 不做幽灵重试——调用方收到 reject 后自行决定重发）
    const rejected = settleChecked(inflightBatch, err, checkedPending)
    if (rejected.size > 0) {
      inflightBatch = inflightBatch.filter((m) => !rejected.has(m))
    }
    if (inflightBatch.length === 0) {
      // 全部为 checked 且已 reject：无需重试
      inFlight = false
      inflightBatch = []
      sendAttempts = 0
      warn('port.send failed', err)
      pump()
      return
    }
    if (sendAttempts > cfg.backoff.max) {
      // 达上限 → 终态 rejected（D4 错误重试：不无限静默积压）；置空前捕获批次，
      // 逐条 per-message 回调（口径同 onSendOk）
      const rejectedBatch = inflightBatch
      inFlight = false
      inflightBatch = []
      sendAttempts = 0
      warn('port.send failed after max retries', err)
      for (const m of rejectedBatch) {
        if (disposed) break
        cfg.onSettled?.(m, 'rejected')
      }
      pump()
      return
    }
    // 有限重试（同 backoff 参数）：消息留在 inflightBatch，保持 inFlight 防并发打断节奏
    if (sendAttempts === 1) warn('port.send failed, retrying with backoff', err)
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined
      if (disposed || !inFlight) return
      attemptSend()
    }, cfg.backoff.ms)
  }

  // ─── pump：在途结束后决定下一步（checked 优先，然后普通队列走 gate）──
  function pump(): void {
    if (disposed || inFlight) return
    if (checkedPending.length > 0) {
      // checked 优先直投：不经 busy gate——busy 时经 streaming 受理入 pi 队列即回
      // （探针 P1：rtt≈1ms），以此确认可达（#8 resolve = 已受理语义）
      const msgs: DeliveryMessage[] = []
      for (const w of checkedPending) {
        const idx = queue.indexOf(w.msg)
        if (idx !== -1) {
          queue.splice(idx, 1)
          msgs.push(w.msg)
        }
      }
      if (msgs.length > 0) {
        inflightBatch = msgs
        inFlight = true
        sendAttempts = 0
        attemptSend()
        return
      }
    }
    if (queue.length > 0) {
      scheduleFlush(0)
      return
    }
    if (checkedPending.length === 0) stopWatchdog() // 全空闲停表
  }

  // ─── doSend：普通队列出队投递 ─────────────────────────────
  function doSend(): void {
    if (disposed || queue.length === 0 || inFlight) return

    // 出队到在途批次：port.send 失败时留在 inflightBatch 重试（成功才真正离队）
    inFlight = true
    inflightBatch = queue.splice(0)
    sendAttempts = 0
    attemptSend()
  }

  // ─── scheduleFlush：busy gate + 退避（仅无订阅装配）───────
  function scheduleFlush(attempt: number): void {
    if (disposed || queue.length === 0) return

    // in-flight 防重（含错误重试在途：不打断其重试节奏，也不清其 timer）
    if (inFlight) return

    // park 策略：不主动重试，等外部触发
    if (cfg.busyPolicy === 'park' && attempt > 0) return

    // 清残留 gate 退避 timer（settled 回调 / flush 外部入口可能覆盖旧 schedule；
    // 错误重试 timer 不在此列——inFlight 时上面已提前 return）
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer)
      backoffTimer = undefined
    }

    // busy gate（isIdle + hasPendingMessages 双条件）
    if (isBusy() && attempt < cfg.backoff.max) {
      if (port.subscribeSettled) {
        // 有订阅装配：busy 消息由 settled 边沿驱动，退避强发不启动（与事件驱动
        // 竞速会提前注入正在进行的 run）；watch-dog 兜底 settled 丢失（D8）
        startWatchdog()
        return
      }
      // 无订阅装配：退避轮询，达上限强发（pi 队列兜底 drain，探针 P3'/P2）
      backoffTimer = setTimeout(() => {
        backoffTimer = undefined
        scheduleFlush(attempt + 1)
      }, cfg.backoff.ms)
      return
    }

    // idle 或达上限 → 发送
    doSend()
  }

  // ─── warn 辅助（U4 出口参数化）────────────────────────────
  // 注入优先（装配方接 extensionLogger 落盘）；缺省 console.warn 保持通用包
  // 零 logger 依赖（投递失败必须可见）。
  const warnSink: (msg: string, err?: unknown) => void =
    config?.warn ??
    ((msg: string, err?: unknown) => {
      console.warn(`[session-delivery] ${msg}`, err ?? '')
    })

  function warn(msg: string, err?: unknown): void {
    warnSink(msg, err)
  }

  // ─── dedupe 入口检查（send/sendChecked 共用）──────────────
  /** @returns true = 消息继续投递流程；false = 已见过被吞（调用方直接返回）。 */
  function passDedupe(msg: DeliveryMessage): boolean {
    if (!dedupSet) return true
    if (!msg.dedupeKey) {
      // 开 dedupe 时 key 必填（D4）：缺 key 不 throw（never-throw 原则），一次性提示
      // 后照常投递（该消息不参与去重）
      if (!missingKeyWarned) {
        missingKeyWarned = true
        warn('dedupe enabled but message has no dedupeKey; delivering without dedupe')
      }
      return true
    }
    if (dedupSet.has(msg.dedupeKey)) return false
    dedupSet.add(msg.dedupeKey)
    return true
  }

  // ─── 入口函数 ──────────────────────────────────────────────

  function send(msg: DeliveryMessage, opts?: { merge?: boolean }): void {
    if (disposed) return

    // 1. payload 能力 fail-fast（D9）
    if (!port.supportedPayloads.includes(msg.payload.kind)) {
      warn(`unsupported payload kind: ${msg.payload.kind}`)
      return
    }

    // 2. dedup
    if (!passDedupe(msg)) return

    // 3. 入队
    queue.push(msg)

    // 4. 合批窗口判定
    const useMerge =
      opts?.merge ?? (cfg.mergeWindowMs > 0 && cfg.mergeHoldActive != null && cfg.mergeHoldActive())

    if (useMerge) {
      // 走合批窗口：重置 timer
      resetMergeTimer()
      // 订阅 settled（等待边沿唤醒）
      ensureSettledSub()
      return
    }

    // 5. 立即投：无合批依赖。只清残留合批 timer（不重设——见 clearMergeTimer 注释）
    clearMergeTimer()
    ensureSettledSub() // 确保 settled 订阅
    scheduleFlush(0)
  }

  async function sendChecked(msg: DeliveryMessage): Promise<void> {
    if (disposed) throw new Error('delivery handle disposed')

    // payload 能力 fail-fast（D9）
    if (!port.supportedPayloads.includes(msg.payload.kind)) {
      throw new Error(`unsupported payload kind: ${msg.payload.kind}`)
    }

    // dedupe
    if (!passDedupe(msg)) return // 已见过，resolve

    // 入队（诊断口径含在途；投递由下方统一循环接管）
    queue.push(msg)
    ensureSettledSub()

    // 统一投递循环（#3/#8）：resolve 挂钩本消息的 port.send 受理结果。
    // 不经 busy gate——busy 时经 streaming 受理入 pi 队列即回（受理即确认可达，
    // 探针 P1 rtt≈1ms）；不带走合批窗口中的其他消息（单独成批）。
    return new Promise<void>((resolve, reject) => {
      checkedPending.push({ msg, resolve, reject })
      if (!inFlight) {
        const idx = queue.indexOf(msg)
        if (idx !== -1) queue.splice(idx, 1)
        inflightBatch = [msg]
        inFlight = true
        sendAttempts = 0
        attemptSend()
      }
      // inFlight：挂账等待，在途终态后 pump 优先直投本消息
    })
  }

  function flush(): void {
    if (disposed) return
    // 清合批 timer
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer)
      mergeTimer = undefined
    }
    scheduleFlush(0)
  }

  function depth(): number {
    // 未终态消息数：等待队列 + 在途（含错误重试中）
    return queue.length + inflightBatch.length
  }

  /**
   * 终态回调契约：dispose 丢弃 queue/inflight 消息但**不**触发 onSettled(_, 'rejected')
   * （sendChecked 挂账除外——显式 reject 兜底）。依赖 onSettled 做清理/对账的调用方须
   * 自行在 dispose 路径补记账（scheduler 场景由 resume 重放兜底）。
   */
  function dispose(): void {
    disposed = true

    // 清所有 timer
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer)
      mergeTimer = undefined
    }
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer)
      backoffTimer = undefined
    }
    stopWatchdog()
    teardownSettledSub()

    // 丢弃队列
    queue.length = 0
    inflightBatch = []
    inFlight = false
    // 挂起中的 sendChecked 不留永久 pending
    for (const w of checkedPending) {
      w.reject(new Error('delivery handle disposed'))
    }
    checkedPending.length = 0
    dedupSet?.clear()
  }

  return { send, sendChecked, flush, depth, dispose }
}

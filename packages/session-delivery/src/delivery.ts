/**
 * 投递所有权内核实现：createDelivery（v2）。
 *
 * 在 v1 投递循环（入队 → dedupe → 合批窗口 → busy gate → port.send → backoff
 * 重试 → settled 边沿/watchdog 驱动）之上升级为条目制所有权内核（设计
 * .tmp/tech-design/delivery-ownership-kernel.md §3 D9①②③⑤ / D5②③ / D3，单元 u1）。
 * 零 pi 依赖不变：确认/回收由适配器（runtime registry）调 handle 方法驱动。
 *
 * 五态状态机（D9①，types.ts 迁移表）+ 本文件登记的两处实施扩展：
 * - queued → in-flight：出站投递被受理（两阶段回执第一阶段，D2）
 * - in-flight → delivered：confirmDelivered（送达回执，D2）
 * - in-flight → queued：requeue（对账回收重投，D3）
 * - queued/failed → cancelled：cancel（本地移除 + tombstone / 用户 × 移除）
 * - in-flight → failed：重试耗尽（sendAttempts > backoff.max，v1 语义保留）
 * - failed → queued：requeue（用户重试/resync 单条重报）
 * - [扩展①] queued → delivered：confirmDelivered 也接受 queued 态——服务 reattach
 *   场景 rebuild 直确认重建（D3②：适配器扫描 transcript 判 delivered 后 send 重建
 *   + confirmDelivered 一步落终态），以及出站批次在途时送达回执先于受理回执到达
 *   的竞态形态（message_end 比 RPC resolve 快，事实优先）。
 * - [扩展②] cancel 对 in-flight 两段式：首次调用只标记待收回（条目留守 in-flight，
 *   返回 reclaim-requested，适配器驱动 clear_queue 收回）；适配器收回确认后再次
 *   cancel(id) 终结为 cancelled + tombstone。收回失败不再调 → 条目留守原态
 *   （§3.4「目标条目留守原态」）；若文本实际进了 transcript，confirmDelivered
 *   对已标记条目事实优先转 delivered（delivered 事实 > cancel 意图）。
 *
 * onSettled 记账口径（D9⑤ 升级）：
 * - 'delivered' = 送达口径：仅 confirmDelivered 驱动回调（受理只转 in-flight，
 *   不回调——受理 ≠ 送达的机制化落地）；per-message 契约（ext-simplify-08）在
 *   confirmDelivered 路径同样成立。
 * - 'rejected' = 重试耗尽通知（v1 时点不变，判定源 = sendAttempts > max，仅通知）。
 * - 显式例外：sendChecked 的同步 settle 维持受理口径不变——promise 在 port.send
 *   受理成功时点 resolve（session_manager send 的 {queued:true} 契约锚，D9⑤ 锁定），
 *   与 onSettled 送达口径正交。
 *
 * 双视图（D9②/D5③）：entriesFull() = 全量视图（活跃条目 + 全量 tombstone，对账/
 * 判重消费）；projection() = 投影视图（活跃全量 + delivered 最近 50 条完整条目，
 * cancelled 不投影；窗口恒为默认常量）。delivered 完整条目留存上限
 * = 默认投影窗口 50（tombstone 全量保留不受限——判重正确性不依赖展示窗口）。
 *
 * 判重 tombstone（D5②）：delivered 与 cancelled 都写 tombstone，runtime 存活期内
 * 全量保留、不设数量窗口；resync 重报/重建以显式 id 查活跃集与 tombstone 去重
 * （send/sendChecked 的 opts.id 命中即吞）。条目 id = opts.id ?? 内部生成；未传
 * id 的消息不参与幂等判重（v1「无 dedupe 配置不去重」语义保持）。
 *
 * 其余 v1 机制逐条保持：busy gate（isIdle + 内核在途内查双条件——hasPendingMessages
 * 自镜像四件套已按 msg-pipeline-debloat D2 拆除，busy 判定内查 active 表）、backoff
 * 有限重试、合批窗口、dedupe LRU、30s watchdog、dispose 语义（丢弃不触发
 * onSettled、checked 挂账 reject）。depth() 口径保持 v1 = 尚未受理的消息数
 * （受理转 in-flight 后不计；「在途未确认」数经 entriesFull() 全量视图消费）。
 */

import { LruSet } from './lru.js'
import type {
  DeliveryConfig,
  DeliveryEntry,
  DeliveryEntriesFull,
  DeliveryEntriesProjection,
  DeliveryEntryState,
  DeliveryHandle,
  DeliveryIntent,
  DeliveryLane,
  DeliveryMessage,
  DeliveryPayload,
  DeliveryPort,
  DeliveryTombstone,
  SendReceipt,
} from './types.js'

/**
 * U4 warn 出口注入（设计 docs/architecture/pi-boundary-reliability.md 附录 D §5 U4）：
 * 装配方接 extensionLogger 使投递失败警告落 `<dataDir>/logs/`（console.warn 走
 * stderr tee 不到日志盘——排查无痕）。通用包不硬依赖 taiji logger，故以可选注入
 * 挂载；正式化并入 types.ts 的 DeliveryConfig 属领地外变更，暂以交叉类型承载。
 */
export interface DeliveryWarnSink {
  /** 投递失败/异常警告出口。缺省 console.warn（前缀 `[session-delivery]`）。 */
  warn?: (msg: string, err?: unknown) => void
}

/** createDelivery 配置（DeliveryConfig + warn 出口注入）。 */
export type DeliveryConfigWithWarn = DeliveryConfig & DeliveryWarnSink

// ─── v2 对外类型（delivery.ts 领地内定义；types.ts 归 u-contracts 不动）─────

/** send/sendChecked 提交选项（v1 `{ merge? }` 的超集，向后兼容）。 */
export interface DeliverySubmitOptions {
  /** 合批窗口判定覆盖（v1 既有）。 */
  merge?: boolean
  /**
   * 客户端幂等 id（= 条目 id = 协议层 clientUuid，D2 裸标记身份源/D5② 判重锚）。
   * 显式提供时参与幂等判重：命中活跃条目或 tombstone 即吞（resync 重报/重放去重）。
   * 缺省内部生成、不参与判重。
   */
  id?: string
  /** 投递车道（D1）：适配器判定后传入记录；缺省 'direct'（既有调用方语义）。 */
  lane?: DeliveryLane
  /**
   * 送达回执锚申报（msg-pipeline-debloat D1 申报制）：提交方声明本条目的送达判定锚。
   * - 'marker'（缺省）= 出站文本尾附裸标记、送达以 message_end 回执命中为准
   *   （用户消息主通路语义）；受理后维持 in-flight 等回执。
   * - 'acceptance' = 无回执锚点条目（agent 通路：完成回流 / session_manager send /
   *   notifier 通知——出站文本原样不改），port.send 受理成功即落 delivered 终态
   *   （「受理 = 送达」是唯一可判事实，v1 记账口径 / D9⑤ 显式例外）。
   *
   * 缺省 'marker' 是刻意的保守取向：无标记提交点漏申报的代价 = 复发已知死锁形态
   * （in-flight 永挂、gate 恒关，有全链诊断可查，可见）；误申报 'acceptance' 的代价
   * = 静默丢送达确认语义（更隐蔽）。两害取可见者。新增无标记投递来源必须显式申报
   * 'acceptance' 并登记来源清单（ADR-0074 词条）。
   */
  receiptAnchor?: 'marker' | 'acceptance'
}

/**
 * send() 受理结果（b31-D6：失败双表面窄口收口）。调用方忽略返回值不受影响
 * （v1 句柄面 send 仍声明 void，结构兼容）。三分口径：
 * - accepted：已入队并进入投递流程（id = 条目 id，供调用方对账/判重锚定）
 * - swallowed：幂等吞（already-seen = 显式 id 命中活跃集/tombstone；duplicate-content
 *   = dedupeKey 内容级去重命中）——设计内去重，非失败
 * - rejected：拒收未入队（disposed = 句柄已销毁；unsupported-payload = 通路能力
 *   不含该 payload kind）——仅 warn 单表面 + 本返回值，无终态无 onSettled
 *
 * void 兼容口径（与 SendReceipt 的 U2 扩展位同构）：接口返回类型含 void——
 * v1 → v2 测试替身适配（runtime asHandleV2 直转发 v1 handle.send）返回 void =
 * 受理未知；内核本体实现恒返回具体结果，void 分支仅为替身/旧实现预留。
 */
export type DeliverySendResult =
  | { kind: 'accepted'; id: string }
  | { kind: 'swallowed'; reason: 'already-seen' | 'duplicate-content' }
  | { kind: 'rejected'; reason: 'disposed' | 'unsupported-payload' }

/** v2 句柄：v1 DeliveryHandle 的超集（结构兼容，既有消费者零改动）。 */
export interface DeliveryHandleV2 extends DeliveryHandle {
  /** 唯一常规入口（D4 入口收敛）；返回受理/吞/拒收口径（void = 受理未知，替身兼容）。 */
  send(msg: DeliveryMessage, opts?: DeliverySubmitOptions): DeliverySendResult | void
  sendChecked(msg: DeliveryMessage, opts?: DeliverySubmitOptions): Promise<void>
  /** 全量视图（D9②）：活跃条目（完整字段）+ 全部 tombstone。快照（防御性拷贝）。 */
  entriesFull(): DeliveryEntriesFull
  /** 投影视图（D9②/D5③）：活跃全量 + delivered 最近 50 条完整条目，cancelled 不投影。 */
  projection(): DeliveryEntriesProjection
  /**
   * 变更订阅（state topic 装配用）：任何条目创建/迁移/终态触发。返回退订函数。
   * 回调实现不应抛——异常由内核捕获并 warn，不影响其余订阅者与状态机。
   */
  onChange(cb: () => void): () => void
  /**
   * 送达回执驱动转 delivered（D9③）。接受 in-flight（正规路径）与 queued
   * （扩展①：rebuild 直确认 / 出站中回执先到）。幂等：未知/已终态 no-op。
   * @returns 是否发生了状态转移（诊断/测试用）。
   */
  confirmDelivered(id: string): boolean
  /**
   * 回收重置 queued 至队首（保持 ids 相对序，D3 own 处置/failed 重试）。
   * 只接受 in-flight/failed；queued 幂等跳过（已在队列）；cancelled/delivered
   * 拒绝（防复活纪律）。@returns 实际重排条数。
   */
  requeue(ids: readonly string[]): number
  /**
   * 撤销（D9③/§3.1 场景 D）：queued/failed 本地移除 + tombstone；in-flight 标记
   * 待收回（扩展②两段式）；已终态幂等返回既有 tombstone。
   */
  cancel(id: string): DeliveryCancelResult
  /** 全量取回文本（forceQuit，D9③）：条目清空 + 全部记 cancelled tombstone。 */
  drain(): DrainResult
}

/** cancel(id) 结果（D-3 偏差：cancelled 形态携带条目快照含 payload 全文供草稿恢复）。 */
export type DeliveryCancelResult =
  | { kind: 'cancelled'; entry: DeliveryEntry }
  | { kind: 'reclaim-requested'; entry: DeliveryEntry }
  | { kind: 'already-final'; tombstone: DeliveryTombstone }
  | { kind: 'not-found' }

/** drain() 返回：全部未终态条目的文本取回（Segment[] 快照切分归上层，ADR-0043）。 */
export type DrainResult = ReadonlyArray<{ id: string; payload: DeliveryPayload }>

/** 默认配置（D4 策略默认值）。 */
const DEFAULT_CONFIG: Required<
  Omit<DeliveryConfig, 'mergeHoldActive' | 'dedupe' | 'onSettled'>
> = {
  intent: 'interrupt-at-turn-boundary',
  mergeWindowMs: 0,
  backoff: { ms: 100, max: 50 },
  watchdogMs: 30_000,
}

/** 投影视图默认窗口（D5③）；同时是 delivered 完整条目留存上限（环形）。 */
const DEFAULT_DELIVERED_WINDOW = 50

/**
 * port.send 悬挂兜底超时（b31-D1，C-proc-19 控制面单请求粒度：秒级）。
 * port 契约（types.ts DeliveryPort.send）声明实现必须 settle；本兜底只覆盖适配器
 * 违约的极端形态——超时按发送失败收口（warn 留痕 + 错误重试链），inFlight 复位可达。
 * 已接受代价（与判重责任登记同源）：迟到原请求与重试可能构成重复投递，通道内判重
 * 由适配器/对端按裸标记负责。
 */
const PORT_SEND_SETTLE_TIMEOUT_MS = 60_000

/** sendChecked 的挂账：resolve/reject 挂钩所属条目的 port.send 受理结果。 */
interface CheckedWaiter {
  entry: KernelEntry
  resolve: () => void
  reject: (err: unknown) => void
}

/**
 * 内核条目：DeliveryEntry + 实现私有字段。msg 为原始消息引用（合批构造 /
 * onSettled 回调身份源）；cancelRequested 为 in-flight 撤销两段式的待收回标记；
 * receiptAnchor 为提交方申报的送达回执锚（D1 申报制，沿 opts.id/opts.lane 持久化
 * 先例直达内部字段——不进 DeliveryEntry 条目视图 DTO，投影面零扩散）。
 */
interface KernelEntry extends DeliveryEntry {
  msg: DeliveryMessage
  cancelRequested: boolean
  receiptAnchor: 'marker' | 'acceptance'
}

function isThenable(v: unknown): v is Promise<SendReceipt | void> {
  return !!v && typeof (v as Promise<SendReceipt | void>).then === 'function'
}

/**
 * 合批拼接（D4：调用方预格式化，内核只拼接）。
 * 多条以 "\n\n---\n\n" join；custom 批次的 details 包装为 { batch: true, items }，
 * items 元素 = 各消息的 details（custom 且有 details 时，notifier 的 record 即在
 * details 下，渲染器按 item 顶层 record 字段读）或 payload 本身（text / 无 details）。
 * 单条批次原样返回（payload 引用透传，TextPayload.images 保留，D9④）。
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
  // text 合批：images 透传拼接（各条保序 flat；D9④ 内核不解析、不剥离）
  const images = messages.flatMap((m) => (m.payload.kind === 'text' ? (m.payload.images ?? []) : []))
  return {
    ...first,
    payload:
      images.length > 0
        ? { kind: 'text', content, images }
        : { kind: 'text', content },
  }
}

/**
 * settle 属于 batch 的 checked waiter（原地更新 checkedPending）。
 * 成功（err undefined）：resolve；失败：reject 并返回被 reject 的条目集合
 * （这些条目不再参与错误重试——入口即拦语义，失败已同步交给调用方）。
 */
function settleChecked(
  batch: KernelEntry[],
  err: unknown,
  checkedPending: CheckedWaiter[],
): Set<KernelEntry> {
  const rejected = new Set<KernelEntry>()
  if (checkedPending.length === 0) return rejected
  const batchSet = new Set(batch)
  const kept: CheckedWaiter[] = []
  for (const w of checkedPending) {
    if (!batchSet.has(w.entry)) {
      kept.push(w)
      continue
    }
    if (err === undefined) {
      w.resolve()
    } else {
      w.reject(err)
      rejected.add(w.entry)
    }
  }
  checkedPending.length = 0
  checkedPending.push(...kept)
  return rejected
}

// ─── isIdle 安全调用（catch → 视为不可发送） ──────────────
// onFault：降级留痕钩子（b31-D3——静默降级必须可见；warn 频控由调用方裁决）
function safeIsIdle(port: DeliveryPort, onFault?: (err: unknown) => void): boolean {
  try {
    return port.isIdle()
  } catch (err) {
    // session 已关闭等异常 → 视为不可发送
    onFault?.(err)
    return false
  }
}

// ─── warn 辅助（U4 出口参数化）────────────────────────────
// 注入优先（装配方接 extensionLogger 落盘）；缺省 console.warn 保持通用包
// 零 logger 依赖（投递失败必须可见）。
function resolveWarnSink(config?: DeliveryConfigWithWarn): (msg: string, err?: unknown) => void {
  return (
    config?.warn ??
    ((msg: string, err?: unknown) => {
      console.warn(`[session-delivery] ${msg}`, err ?? '')
    })
  )
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
): DeliveryHandleV2 {
  // 合并配置
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    backoff: config?.backoff ?? DEFAULT_CONFIG.backoff,
  }

  // ─── 内部状态 ─────────────────────────────────────────────
  // @data-owner #15（docs/architecture/data-source-registry.md）：本条目集是「已向
  // 发起方确认 queued 的待投递消息」的内存 outbox——非持久，runtime 重启即丢
  // （磁盘 outbox 已被设计 §3.2 显式否决，renderer 断连 resync 重报覆盖恢复面）。
  // active 数组序 = 队列序（含 queued[含出站批次成员]/in-flight/failed 三类活跃条目）。
  const active: KernelEntry[] = []
  const activeIndex = new Map<string, KernelEntry>()
  /**
   * 判重 tombstone（D5②）：delivered/cancelled 轻量元数据，handle 存活期内全量
   * 保留、不设数量窗口（断连积压长队列的 resync 判重锚不丢；cancelled 防 resync
   * 复活）。dispose 时随 handle 释放（不跨 runtime 重启，reattach 判重锚回落
   * transcript 扫描——适配器职责）。
   */
  const tombstones = new Map<string, DeliveryTombstone>()
  /**
   * delivered 完整条目环形留存（投影视图源，D5③「最近 50 条完整条目」）。
   * 上限 = DEFAULT_DELIVERED_WINDOW；判重正确性不依赖它（tombstone 全量）。
   */
  const deliveredLog: KernelEntry[] = []
  /** sendChecked 等待受理确认的挂账（条目在 active，出站批次或等待 gate）。 */
  const checkedPending: CheckedWaiter[] = []
  /**
   * 出站批次：doSend/checked 直投从 active 锁定后、终态前持有引用。条目 state
   * 保持 queued（受理才转 in-flight，D2 两阶段）；port.send 失败时批次按 backoff
   * 重试（受理成功才转移，D4 错误重试）。
   */
  let inflightBatch: KernelEntry[] = []
  let inFlight = false // in-flight 防重：至多一个 port.send 在途（含错误重试期间）
  let sendAttempts = 0 // 当前出站批次的 port.send 尝试次数（错误重试计数）
  let mergeTimer: ReturnType<typeof setTimeout> | undefined
  let backoffTimer: ReturnType<typeof setTimeout> | undefined
  let hangTimer: ReturnType<typeof setTimeout> | undefined // port.send 悬挂兜底（b31-D1）
  let watchdogTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let settledUnsub: (() => void) | undefined
  let missingKeyWarned = false // #12 dedupeKey 缺失提示按 handle 一次性
  let probeFaultWarned = false // busy 探测异常降级提示按 handle 一次性（b31-D3，防退避循环刷屏）
  let idSeq = 0 // 内部条目 id 计数器（未显式传 id 时）

  // 去重（v1 内容级 dedupe 配置，与 v2 显式 id 幂等判重正交叠加）
  const dedupSet = config?.dedupe ? new LruSet(config.dedupe.maxKeys) : null

  // onChange 订阅（D9②，state topic 装配消费）
  const changeSubs = new Set<() => void>()

  function now(): number {
    return Date.now()
  }

  function genId(): string {
    idSeq += 1
    return `d-${idSeq}`
  }

  /** 条目快照（剥离实现私有字段，防外部可变引用泄漏）。payload 引用透传。 */
  function snapshot(e: KernelEntry): DeliveryEntry {
    return {
      id: e.id,
      state: e.state,
      lane: e.lane,
      payload: e.payload,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      sendAttempts: e.sendAttempts,
      ...(e.settledAt !== undefined ? { settledAt: e.settledAt } : {}),
    }
  }

  function notifyChange(): void {
    // 回调异常隔离（b31-D2）：一处订阅者 throw 不得中断其余订阅者与状态机
    for (const cb of changeSubs) {
      try {
        cb()
      } catch (err) {
        warn('onChange callback threw; isolated to keep notifying remaining subscribers', err)
      }
    }
  }

  /**
   * onSettled 回调异常隔离（b31-D2）：回调异常 ≠ 投递失败，捕获留痕后状态机照常
   * （状态迁移已先行落定，回调只负责通知面）。
   */
  function callOnSettled(msg: DeliveryMessage, outcome: 'delivered' | 'rejected'): void {
    try {
      cfg.onSettled?.(msg, outcome)
    } catch (err) {
      warn(`onSettled callback threw (outcome=${outcome}); isolated from delivery state machine`, err)
    }
  }

  /**
   * busy 探测降级留痕（b31-D3）：探测异常保守归 busy 属设计内降级，但零留痕违反
   * 红线。按 handle 一次性 warn——gate 退避 100ms 循环下逐次 warn 会刷屏（复用
   * missingKeyWarned 一次性模式）。
   */
  function warnProbeFault(err: unknown): void {
    if (probeFaultWarned) return
    probeFaultWarned = true
    warn('port busy probe (isIdle) threw; conservatively treating as busy', err)
  }

  /**
   * busy 判定（isIdle + 在途内查双条件，G4；msg-pipeline-debloat D2 拆除自镜像后
   * 内核自持事实）：!isIdle（pi 正忙）或 active 表存在 in-flight 条目（已受理未拿
   * 送达回执的投递在途）→ busy 不投。单判 isIdle 会把「idle 但在途投递未终态」
   * 误判为可投，提前堆叠与迁移前不等价。内查同表遍历先例 = depth()。
   */
  function isBusySafe(): boolean {
    if (!safeIsIdle(port, warnProbeFault)) return true
    return hasInFlightEntries()
  }

  /** 内核在途条目内查（D2）：active 表的 in-flight 成员存在性（O(n)，同 depth() 口径）。 */
  function hasInFlightEntries(): boolean {
    for (const e of active) if (e.state === 'in-flight') return true
    return false
  }

  /** 活跃条目是否仍在册（出站批/迟到回执守卫：已 cancel/drain/dispose 的条目不在）。 */
  function inRegistry(e: KernelEntry): boolean {
    return activeIndex.get(e.id) === e
  }

  function hasQueuedEntries(): boolean {
    for (const e of active) if (e.state === 'queued') return true
    return false
  }

  /** 终态落定：出活跃集 + 写 tombstone（D5②）。调用方负责 onSettled/通知语义。 */
  function finalizeEntry(e: KernelEntry, state: Extract<DeliveryEntryState, 'delivered' | 'cancelled'>): void {
    const idx = active.indexOf(e)
    if (idx !== -1) active.splice(idx, 1)
    activeIndex.delete(e.id)
    e.state = state
    const ts = now()
    e.updatedAt = ts
    e.settledAt = ts
    tombstones.set(e.id, { id: e.id, state, lane: e.lane, settledAt: ts })
    if (state === 'delivered') {
      deliveredLog.push(e)
      if (deliveredLog.length > DEFAULT_DELIVERED_WINDOW) deliveredLog.shift()
    }
    notifyChange()
  }

  /** 活跃条目移除（无 tombstone）：受拒 checked 条目（入口即拦，未进通道无判重语义）。 */
  function removeActive(e: KernelEntry): void {
    const idx = active.indexOf(e)
    if (idx !== -1) active.splice(idx, 1)
    activeIndex.delete(e.id)
  }

  /** cancel/drain 时 reject 该条目的 checked waiter（不留悬挂 promise）。 */
  function rejectWaitersOf(e: KernelEntry, err: unknown): void {
    for (let i = checkedPending.length - 1; i >= 0; i--) {
      if (checkedPending[i]!.entry === e) {
        checkedPending[i]!.reject(err)
        checkedPending.splice(i, 1)
      }
    }
  }

  // ─── 合批窗口 timer ─────────────────────────────────────────
  // 拆 clear/arm 两半：合批路径用 resetMergeTimer（清旧 + 重设窗口）；非合批路径
  // 只 clear——立即投递无窗口语义，重设会留下一个到期触发 flush 的孤儿 timer，
  // 成为意外的「外部触发」，把本应等待的消息提前冲出。
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

  /** gate 退避 timer 清理（b31-R3 复用收敛：与 stopWatchdog 同款 helper 三处复用）。 */
  function clearBackoffTimer(): void {
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer)
      backoffTimer = undefined
    }
  }

  /** port.send 悬挂兜底 timer 清理（随批次终态/drain/dispose 撤销兜底）。 */
  function clearHangTimer(): void {
    if (hangTimer !== undefined) {
      clearTimeout(hangTimer)
      hangTimer = undefined
    }
  }

  // ─── settled 订阅管理 ──────────────────────────────────────
  function ensureSettledSub(): void {
    if (settledUnsub || !port.subscribeSettled) return
    settledUnsub = port.subscribeSettled(() => {
      if (disposed) return
      // settled 边沿 → busy 复核（isIdle 已先于事件复位，agent-session.js:327-336）→ flush
      if (!isBusySafe()) {
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
      if (!hasQueuedEntries()) return
      if (!isBusySafe()) {
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

  // ─── attemptSend：对出站批次执行 port.send ────────────────
  function attemptSend(): void {
    const batch = inflightBatch
    const composed = buildBatchPayload(batch.map((e) => e.msg))
    const intent: DeliveryIntent = composed.intent ?? cfg.intent
    try {
      const result = port.send(composed, intent)
      if (isThenable(result)) {
        // 悬挂兜底（b31-D1）：port 契约声明实现必须 settle；适配器违约（promise 永不
        // settle）时 inFlight 防重永久占位、watchdog/pump 全被短路 → handle 停摆。
        // 超时按发送失败收口（warn 留痕 + 错误重试链），量级 = 控制面单请求秒级
        // （C-proc-19）。settled 单向闩：超时强制失败后迟到的原 settle 不得二次驱动
        // 状态机（重复投递代价已在 DeliveryPort.send 契约登记）。
        let settled = false
        clearHangTimer()
        hangTimer = setTimeout(() => {
          if (settled || disposed) return
          settled = true
          hangTimer = undefined
          warn(
            `port.send hung; force-failed after ${PORT_SEND_SETTLE_TIMEOUT_MS}ms ` +
              '(retries may duplicate-deliver; see DeliveryPort.send settle contract)',
          )
          onSendFail(new Error(`port.send promise did not settle within ${PORT_SEND_SETTLE_TIMEOUT_MS}ms`))
        }, PORT_SEND_SETTLE_TIMEOUT_MS)
        result.then(
          (receipt) => {
            if (settled) return
            settled = true
            clearHangTimer()
            onSendReceipt(receipt)
          },
          (err: unknown) => {
            if (settled) return
            settled = true
            clearHangTimer()
            onSendFail(err)
          },
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
    const batch = inflightBatch
    inFlight = false
    inflightBatch = []
    sendAttempts = 0
    // D9⑤ 显式例外：checked 的同步 settle 维持受理口径（受理成功即 resolve）
    settleChecked(batch, undefined, checkedPending)
    // 受理 → in-flight（两阶段回执第一阶段，D2）。'delivered' 的 onSettled 回调
    // 不在此触发（D9⑤ 送达口径：由 confirmDelivered 驱动）。
    // 批内条目可能已被 confirmDelivered（回执先到）/cancel（出站中撤销）先行
    // 终结或移出——按在册守卫跳过。
    let changed = false
    for (const e of batch) {
      if (disposed) break
      if (!inRegistry(e)) continue
      if (e.state !== 'queued') continue
      e.state = 'in-flight'
      e.updatedAt = now()
      changed = true
    }
    if (changed) notifyChange()
    // D1 申报制：acceptance 条目受理即落地——无回执锚点条目的「受理 = 送达」是唯一
    // 可判事实（提交方申报，内核零 pi 知识零正则），直接终态化（confirmDelivered 幂等，
    // 对已被先行终结的条目 no-op），不进 in-flight 等回执（永挂源构造性消除）。
    for (const e of batch) {
      if (disposed) break
      if (e.receiptAnchor === 'acceptance') confirmDelivered(e.id)
    }
    pump()
  }

  function onSendFail(err: unknown): void {
    if (disposed) return
    sendAttempts++
    for (const e of inflightBatch) e.sendAttempts = sendAttempts
    // 入口即拦：checked 条目首次受理失败即 reject，并从在途与内核移除（失败同步
    // 交给调用方，不做幽灵重试——调用方收到 reject 后自行决定重发；不产 tombstone，
    // 未进通道的消息无判重语义）
    const rejected = settleChecked(inflightBatch, err, checkedPending)
    if (rejected.size > 0) {
      inflightBatch = inflightBatch.filter((e) => !rejected.has(e))
      for (const e of rejected) removeActive(e)
      notifyChange()
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
      // 达上限 → 条目转 failed（D4 错误重试：不无限静默积压；留守 failed 至用户
      // 处置：requeue 重试 / cancel × 移除）。onSettled('rejected') 仅通知回调，
      // 非判定源（§3.4）；置空批后逐条 per-message 回调。
      const failedBatch = inflightBatch
      inFlight = false
      inflightBatch = []
      sendAttempts = 0
      warn('port.send failed after max retries', err)
      let changed = false
      for (const e of failedBatch) {
        if (disposed) break
        if (!inRegistry(e)) continue
        e.state = 'failed'
        const ts = now()
        e.updatedAt = ts
        e.settledAt = ts
        changed = true
        callOnSettled(e.msg, 'rejected')
      }
      if (changed) notifyChange()
      pump()
      return
    }
    // 有限重试（同 backoff 参数）：条目留守出站批次（state 仍 queued），保持
    // inFlight 防并发打断节奏
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
      const batch: KernelEntry[] = []
      for (const w of checkedPending) {
        if (inRegistry(w.entry) && w.entry.state === 'queued') batch.push(w.entry)
      }
      if (batch.length > 0) {
        inflightBatch = batch
        inFlight = true
        sendAttempts = 0
        attemptSend()
        return
      }
    }
    if (hasQueuedEntries()) {
      scheduleFlush(0)
      return
    }
    if (checkedPending.length === 0) stopWatchdog() // 全空闲停表
  }

  // ─── doSend：普通队列出站 ─────────────────────────────────
  function doSend(): void {
    if (disposed || inFlight) return

    // 锁定全部 queued 条目为出站批次：port.send 失败时留守重试（受理成功才转移）
    const batch = active.filter((e) => e.state === 'queued')
    if (batch.length === 0) return
    inFlight = true
    inflightBatch = batch
    sendAttempts = 0
    attemptSend()
  }

  // ─── scheduleFlush：busy gate + 退避（仅无订阅装配）───────
  function scheduleFlush(attempt: number): void {
    if (disposed || !hasQueuedEntries()) return

    // in-flight 防重（含错误重试在途：不打断其重试节奏，也不清其 timer）
    if (inFlight) return

    // 清残留 gate 退避 timer（settled 回调 / flush 外部入口可能覆盖旧 schedule；
    // 错误重试 timer 不在此列——inFlight 时上面已提前 return）
    clearBackoffTimer()

    // busy gate（isIdle + 内核在途内查双条件，D2）
    if (isBusySafe() && attempt < cfg.backoff.max) {
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
  // 出口解析见模块级 resolveWarnSink（注入优先，缺省 console.warn）。
  const warnSink = resolveWarnSink(config)

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

  // ─── v2 幂等判重（D5②：显式 id 命中活跃集或 tombstone 即吞）───
  function seenId(id: string | undefined): boolean {
    if (id === undefined) return false
    return activeIndex.has(id) || tombstones.has(id)
  }

  function createEntry(msg: DeliveryMessage, opts?: DeliverySubmitOptions): KernelEntry {
    const ts = now()
    const entry: KernelEntry = {
      id: opts?.id ?? genId(),
      state: 'queued',
      lane: opts?.lane ?? 'direct',
      payload: msg.payload,
      createdAt: ts,
      updatedAt: ts,
      sendAttempts: 0,
      msg,
      cancelRequested: false,
      receiptAnchor: opts?.receiptAnchor ?? 'marker',
    }
    active.push(entry)
    activeIndex.set(entry.id, entry)
    notifyChange()
    return entry
  }

  // ─── 入口函数 ──────────────────────────────────────────────

  function send(msg: DeliveryMessage, opts?: DeliverySubmitOptions): DeliverySendResult {
    if (disposed) {
      warn('send ignored: delivery handle disposed (caller should re-create the handle)')
      return { kind: 'rejected', reason: 'disposed' }
    }

    // 1. payload 能力 fail-fast（D9）
    if (!port.supportedPayloads.includes(msg.payload.kind)) {
      warn(`unsupported payload kind: ${msg.payload.kind}`)
      return { kind: 'rejected', reason: 'unsupported-payload' }
    }

    // 2. 显式 id 幂等判重（D5②：resync 重报已 delivered/cancelled 的 id 不重投）
    if (seenId(opts?.id)) {
      warn(`send swallowed by idempotency dedupe: id already seen (id=${opts?.id})`)
      return { kind: 'swallowed', reason: 'already-seen' }
    }

    // 3. dedup（v1 内容级，正交保留）
    if (!passDedupe(msg)) return { kind: 'swallowed', reason: 'duplicate-content' }

    // 4. 入条目（queued）
    const entry = createEntry(msg, opts)

    // 5. 合批窗口判定
    const useMerge =
      opts?.merge ?? (cfg.mergeWindowMs > 0 && cfg.mergeHoldActive != null && cfg.mergeHoldActive())

    if (useMerge) {
      // 走合批窗口：重置 timer
      resetMergeTimer()
      // 订阅 settled（等待边沿唤醒）
      ensureSettledSub()
      return { kind: 'accepted', id: entry.id }
    }

    // 6. 立即投：无合批依赖。只清残留合批 timer（不重设——见 clearMergeTimer 注释）
    clearMergeTimer()
    ensureSettledSub() // 确保 settled 订阅
    scheduleFlush(0)
    return { kind: 'accepted', id: entry.id }
  }

  async function sendChecked(msg: DeliveryMessage, opts?: DeliverySubmitOptions): Promise<void> {
    if (disposed) throw new Error('delivery handle disposed')

    // payload 能力 fail-fast（D9）
    if (!port.supportedPayloads.includes(msg.payload.kind)) {
      throw new Error(`unsupported payload kind: ${msg.payload.kind}`)
    }

    // 显式 id 幂等判重（已见过，resolve——与 dedupe 命中同语义；b31-D3 留痕）
    if (seenId(opts?.id)) {
      warn(`sendChecked swallowed by idempotency dedupe: id already seen (id=${opts?.id})`)
      return
    }

    // dedupe
    if (!passDedupe(msg)) return // 已见过，resolve

    // 入条目（诊断口径含在途；投递由下方统一循环接管）
    const entry = createEntry(msg, opts)
    ensureSettledSub()

    // 统一投递循环（#3/#8）：resolve 挂钩本条目的 port.send 受理结果（D9⑤ 受理
    // 口径锁定）。不经 busy gate——busy 时经 streaming 受理入 pi 队列即回（受理即
    // 确认可达，探针 P1 rtt≈1ms）；不带走合批窗口中的其他条目（单独成批）。
    return new Promise<void>((resolve, reject) => {
      checkedPending.push({ entry, resolve, reject })
      if (!inFlight) {
        inflightBatch = [entry]
        inFlight = true
        sendAttempts = 0
        attemptSend()
      }
      // inFlight：挂账等待，在途终态后 pump 优先直投本条目
    })
  }

  function flush(): void {
    if (disposed) return
    clearMergeTimer()
    scheduleFlush(0)
  }

  function depth(): number {
    // 口径保持 v1：尚未被底层通道受理的消息数（等待 gate + 出站批次含重试中）。
    // 已受理的 in-flight 条目不计（所有权已移交 pi 槽位，等回执）；
    // 「在途未确认」全量经 entriesFull() 消费（D9②）。
    let n = 0
    for (const e of active) if (e.state === 'queued') n++
    return n
  }

  // ─── v2 所有权 API（D9②③）────────────────────────────────

  function entriesFull(): DeliveryEntriesFull {
    // 全量视图（对账/判重消费）：活跃条目完整字段 + 全部 tombstone 元数据
    return {
      active: active.map(snapshot),
      tombstones: [...tombstones.values()].map((t) => ({ ...t })),
    }
  }

  function projection(): DeliveryEntriesProjection {
    // 投影视图（D5③）：活跃全量 + delivered 最近 50 条完整条目（deliveredLog 环形
    // 留存上限即 DEFAULT_DELIVERED_WINDOW，投影恒用默认常量）；cancelled 不投影
    // （cancel 即出活跃集且不进 deliveredLog，结构性满足）
    return { entries: [...active.map(snapshot), ...deliveredLog.map(snapshot)] }
  }

  function onChange(cb: () => void): () => void {
    changeSubs.add(cb)
    return () => {
      changeSubs.delete(cb)
    }
  }

  function confirmDelivered(id: string): boolean {
    if (disposed) {
      warn(`confirmDelivered ignored: delivery handle disposed (id=${id})`)
      return false
    }
    const e = activeIndex.get(id)
    if (!e) return false // 未知 id / 已终态（tombstone 在册）：幂等 no-op
    // 接受 in-flight（正规送达路径）与 queued（扩展①：rebuild 直确认 / 出站中
    // 回执先到的竞态——事实优先，delivered 事实 > cancel 意图，含已标记待收回条目）
    if (e.state !== 'queued' && e.state !== 'in-flight') return false
    finalizeEntry(e, 'delivered')
    // D9⑤：'delivered' 仅由送达回执（本调用）驱动回调；per-message 契约保持
    if (!disposed) callOnSettled(e.msg, 'delivered')
    return true
  }

  function requeue(ids: readonly string[]): number {
    if (disposed) {
      warn('requeue ignored: delivery handle disposed')
      return 0
    }
    if (ids.length === 0) return 0
    const found: KernelEntry[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const e = activeIndex.get(id)
      if (!e) continue
      // 只接受 in-flight（对账回收，D3 own）/ failed（用户重试/resync 重报）；
      // queued 幂等跳过（已在队列）；delivered/cancelled 拒绝（终态防复活）
      if (e.state !== 'in-flight' && e.state !== 'failed') continue
      found.push(e)
    }
    if (found.length === 0) return 0
    // 从原位摘除 → 按 ids 相对序插到队首（D3：保持原相对序重投）
    for (const e of found) {
      const idx = active.indexOf(e)
      if (idx !== -1) active.splice(idx, 1)
      e.state = 'queued'
      e.sendAttempts = 0
      e.updatedAt = now()
      e.settledAt = undefined
      e.cancelRequested = false // 重投即重新起跑，撤销标记不跨回收轮（cancel 需重新发起）
    }
    active.unshift(...found)
    notifyChange()
    // 回收重投：走 busy gate 复核（对账器多在 settled 边沿后调用；idle 则立即投）
    scheduleFlush(0)
    return found.length
  }

  function cancel(id: string): DeliveryCancelResult {
    if (disposed) {
      // disposed 后按 b31-D6 以 not-found 返回（判别联合不扩面，runtime 消费方零改动），
      // 真因经 warn 留痕（返回值语义失真 = 观测问题，不是状态问题）
      warn(`cancel ignored: delivery handle disposed (id=${id}, reported as not-found)`)
      return { kind: 'not-found' }
    }
    const e = activeIndex.get(id)
    if (!e) {
      const tb = tombstones.get(id)
      if (tb) return { kind: 'already-final', tombstone: { ...tb } }
      return { kind: 'not-found' }
    }
    if (e.state === 'in-flight') {
      // 两段式（扩展②）：首次 = 标记待收回（条目留守 in-flight，适配器驱动
      // clear_queue 收回）；已标记的再次调用 = 收回确认 → 终结 cancelled。
      if (!e.cancelRequested) {
        e.cancelRequested = true
        e.updatedAt = now()
        notifyChange()
        return { kind: 'reclaim-requested', entry: snapshot(e) }
      }
      rejectWaitersOf(e, new Error(`delivery cancelled: ${id}`))
      finalizeEntry(e, 'cancelled')
      return { kind: 'cancelled', entry: snapshot(e) }
    }
    // queued（含出站批次中）/failed：本地终结（× 移除 failed 同路径）
    rejectWaitersOf(e, new Error(`delivery cancelled: ${id}`))
    finalizeEntry(e, 'cancelled')
    return { kind: 'cancelled', entry: snapshot(e) }
  }

  function drain(): DrainResult {
    if (disposed) return []
    // 清调度 timer（合批/重试/gate 退避）+ 悬挂兜底；watchdog 随队列清空一并停
    clearMergeTimer()
    clearBackoffTimer()
    clearHangTimer()
    const drained = active.slice()
    active.length = 0
    activeIndex.clear()
    inflightBatch = []
    inFlight = false
    sendAttempts = 0
    const ts = now()
    const result = drained.map((e) => {
      // 全部记 cancelled tombstone：drain 后该 id 不应再被 resync 重报复活
      tombstones.set(e.id, { id: e.id, state: 'cancelled', lane: e.lane, settledAt: ts })
      return { id: e.id, payload: e.payload }
    })
    // 挂起中的 checked 不留永久 pending
    for (const w of checkedPending) {
      w.reject(new Error('delivery drained'))
    }
    checkedPending.length = 0
    stopWatchdog()
    if (drained.length > 0) notifyChange()
    return result
  }

  /**
   * 终态回调契约：dispose 丢弃 active/出站条目但**不**触发 onSettled(_, 'rejected')
   * （sendChecked 挂账除外——显式 reject 兜底）。依赖 onSettled 做清理/对账的调用方须
   * 自行在 dispose 路径补记账（scheduler 场景由 resume 重放兜底）。
   */
  function dispose(): void {
    disposed = true

    // 清所有 timer
    clearMergeTimer()
    clearBackoffTimer()
    clearHangTimer()
    stopWatchdog()
    teardownSettledSub()

    // 丢弃条目集（含 tombstone——随 handle 释放，不跨 runtime 重启，D5②）
    active.length = 0
    activeIndex.clear()
    tombstones.clear()
    deliveredLog.length = 0
    inflightBatch = []
    inFlight = false
    changeSubs.clear()
    // 挂起中的 sendChecked 不留永久 pending
    for (const w of checkedPending) {
      w.reject(new Error('delivery handle disposed'))
    }
    checkedPending.length = 0
    dedupSet?.clear()
  }

  return { send, sendChecked, flush, depth, entriesFull, projection, onChange, confirmDelivered, requeue, cancel, drain, dispose }
}

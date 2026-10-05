/**
 * 投递所有权内核实现：createDelivery（v2）。
 *
 * 在 v1 投递循环（入队 → dedupe → 合批窗口 → busy gate → port.send → settled 边沿
 * 驱动）之上升级为条目制所有权内核（设计 .tmp/tech-design/delivery-ownership-kernel.md
 * §3 D9①②③⑤ / D5②③ / D3，单元 u1）。零 pi 依赖不变：确认/回收由适配器（runtime
 * registry）调 handle 方法驱动。
 *
 * 五态状态机（D9①，types.ts 迁移表）+ 本文件登记的两处实施扩展：
 * - queued → in-flight：出站投递被受理（两阶段回执第一阶段，D2）
 * - in-flight → delivered：confirmDelivered（送达回执，D2）
 * - in-flight → queued：requeue（对账回收重投，D3）
 * - queued/failed → cancelled：cancel（本地移除 + tombstone / 用户 × 移除）
 * - in-flight → failed：断连事件驱动的未确认终局（failInFlight，ADR-0112）
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
 * - [扩展③] confirmAccepted 受理登记（分段 port 实现用，dmg-r1-4）：申报批内条目
 *   已由底层通道受理——queued → in-flight + 出批 + checked waiter 受理口径 resolve。
 *   合批分段中途失败时已登记段留守 in-flight（等回执/对账），仅未受理段走失败面。
 *
 * 失败语义（ADR-0112 首败即停，2026-10-05 用户裁决，backoff 自动重试链退役）：
 * port.send 失败（含 accepted:false）一次即收口——checked 条目 reject + 从内核移除；
 * 非 checked 条目 onSettled('rejected') 逐条显式上报 + 从内核移除。重试决策归消费方
 * （人看页面通知、agent 收失败回执），内核只做忠实投递与事实上报。
 *
 * onSettled 记账口径（D9⑤ 升级）：
 * - 'delivered' = 送达口径：仅 confirmDelivered 驱动回调（受理只转 in-flight，
 *   不回调——受理 ≠ 送达的机制化落地）；per-message 契约（ext-simplify-08）在
 *   confirmDelivered 路径同样成立——对每条消息各回调一次，msg 为该条原始消息
 *   （非 composed 合批消息），additive meta（notifyId 等）随原消息引用原样
 *   透传到回调，内核不读不改。
 * - 'rejected' = 失败终局通知（send 首败移除 / failInFlight 断连未确认，仅通知）。
 * - 显式例外：sendChecked 的同步 settle 维持受理口径不变——promise 在 port.send
 *   受理成功时点 resolve（session_manager send 的 {queued:true} 契约锚，D9⑤ 锁定），
 *   与 onSettled 送达口径正交。补充受理口径的第二 settle 路径（F1-11）：条目在
 *   port.send promise settle 之前已终局 delivered 时（handled 终局路径——适配器在
 *   port.send 实现内部先 confirmDelivered 再让 promise settle，finalizeEntry 同步
 *   摘批后 onSendOk 的 settleChecked 只 settle 当前批成员），受理确认随 confirmDelivered
 *   同步了结（resolveWaitersOf）——契约「受理成功即 resolve」对命令条目成立，
 *   waiter 不因 settle 时序倒挂滞留。
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
 * 自镜像四件套已按 msg-pipeline-debloat D2 拆除，busy 判定内查 active 表）、合批窗口、
 * settled 边沿驱动、dedupe LRU、dispose 语义（丢弃不触发 onSettled、checked 挂账
 * reject）。[ADR-0112 退役登记] backoff 自动重试链、port.send settle 挂死兜底
 * （60s）、watchdog 30s 定时复核、无订阅装配 busy 退避轮询——时间平抑/补偿类机制
 * 全部删除，busy 等待归 settled 边沿与外部触发。depth() 口径保持 v1 = 尚未受理的
 * 消息数（受理转 in-flight 后不计；「在途未确认」数经 entriesFull() 全量视图消费）。
 */

import { DeliveryReclaimError } from './errors.js'
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
  /**
   * 无标记条目标志（pi1-disposition-chat-flow D14⑥ 起源；技能/芯片通路并入后为
   * 「出站不注标条目」统一标志——命令 / 手打 skill 与 prompt 模板 / `<taiji-skill>`
   * 芯片注入文本）。true = 条目出站文本不带投递标记、终局凭据不走 message_end
   * 标记回执（pi disposition 响应 / 断连事件驱动，适配器职责）。内核两处行为：
   * - 组批隔离：与普通条目合批会被 buildBatchPayload 以 BATCH_SEP 拼接，pi 命令解析
   *   与适配器全文身份匹配对拼接文本必然失效——批内含无标记条目时只取队首一条单独
   *   成批（isolateUnmarkedEntry）。
   * - 首败即停（ADR-0112 统一语义后不再差异化，全条目同形态）。
   * 'acceptance' 锚条目（agent 通路）出站同样无标记但走合批、以受理即终态，不置
   * 本标志。
   */
  unmarked?: boolean
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
   * 送达回执驱动转 delivered（D9③）。接受 in-flight（正规送达路径）与 queued
   * （扩展①：rebuild 直确认 / 出站中回执先到）。幂等：未知/已终态 no-op。
   * @returns 是否发生了状态转移（诊断/测试用）。
   */
  confirmDelivered(id: string): boolean
  /**
   * 受理登记（[扩展③]，dmg-r1-4）：分段 port 实现申报「本条目已由底层通道受理」。
   * 只接受当前出站批内的 queued 条目（受理事实锚定于在途投递）；生效即 queued →
   * in-flight 转移 + 出批 + checked waiter 按受理口径 resolve（D9⑤）。幂等：非批内/
   * 已转移/未知 id 返回 false。合批分段中途失败时已登记段留守 in-flight（等回执/对账），
   * 仅未受理段走失败面——已进底层通道的文本不再误报「投递失败」。
   */
  confirmAccepted(id: string): boolean
  /**
   * 断连事件驱动的显式失败终局（ADR-0112 命令终局事件化的断连腿）：把全部 in-flight
   * 条目批量转 failed 终态（留守活跃集等用户处置：resync 重试 / cancel 移除），
   * 逐条 onSettled('rejected') 显式上报。queued 条目不触碰（未触达底层通道，随队列
   * 存活，重连后照常投递）。幂等：无 in-flight 条目返回 0。@returns 终态化条数。
   */
  failInFlight(reason: string): number
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
}

/** 投影视图默认窗口（D5③）；同时是 delivered 完整条目留存上限（环形）。 */
const DEFAULT_DELIVERED_WINDOW = 50

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
 * 先例直达内部字段——不进 DeliveryEntry 条目视图 DTO，投影面零扩散）；
 * unmarked 为无标记出站条目标志（命令/技能，组批隔离判定源；同一持久化先例，
 * 投影面零扩散）。
 */
interface KernelEntry extends DeliveryEntry {
  msg: DeliveryMessage
  cancelRequested: boolean
  receiptAnchor: 'marker' | 'acceptance'
  unmarked: boolean
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
 * 无标记条目组批隔离（pi1-disposition-chat-flow D2② 组批面；技能通路并入同一机制）：
 * 无标记条目不注标出站（出站文本 = 原文），与普通条目合批会被 buildBatchPayload 以
 * BATCH_SEP 拼为一条出站文本——pi 命令解析（首个空格前段剥斜杠逐字精确匹配）对拼接
 * 文本必然 miss，命令退化为普通文本开 LLM 回合（★2 同构缺陷复发，D2② 效果主张落空）；
 * 两条命令互拼同样 miss；适配器对无标记段的全文身份匹配同理失效。故批内含无标记条目
 * 时只取队首一条单独成批（单条 composed = 原文，适配器全文匹配回条目身份，disposition
 * 终局可达）；其余条目留守，随下一轮 pump/doSend 出站。代价：无标记条目插队到其前方
 * 普通条目之前出站（即与其前方的普通条目出站顺序倒置；两类条目不可共用一次
 * port.send，结构必然）；同类条目内 FIFO 保持。
 */
function isolateUnmarkedEntry(batch: KernelEntry[]): KernelEntry[] {
  const firstUnmarked = batch.find((e) => e.unmarked)
  return firstUnmarked !== undefined ? [firstUnmarked] : batch
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
   * 保持 queued（受理才转 in-flight，D2 两阶段）；port.send 失败按首败即停收口
   * （ADR-0112，批次成员从内核移除）。
   */
  let inflightBatch: KernelEntry[] = []
  let inFlight = false // in-flight 防重：至多一个 port.send 在途
  let mergeTimer: ReturnType<typeof setTimeout> | undefined
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
   * 红线。按 handle 一次性 warn（重复异常不刷屏，复用 missingKeyWarned 一次性模式）。
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
    // 终态同步摘出出站批次（dmg-r1-1）：终态条目不得随在途批次引用留存，否则迟到
    // 路径（旧批次引用等）会把已撤销/已送达文本随批次再次处理。原地 splice 保持
    // inFlight 在途 promise 闭包对批数组的引用一致（filter 重赋值会让旧引用复活成员）。
    const batchIdx = inflightBatch.indexOf(e)
    if (batchIdx !== -1) inflightBatch.splice(batchIdx, 1)
    const idx = active.indexOf(e)
    if (idx !== -1) active.splice(idx, 1)
    activeIndex.delete(e.id)
    e.state = state
    const ts = now()
    e.updatedAt = ts
    e.settledAt = ts
    tombstones.set(e.id, { id: e.id, state, lane: e.lane, settledAt: ts })
    if (state === 'delivered') {
      // F1-11：delivered 终局同步了结 checked waiter 的受理口径（resolveWaitersOf
      // 注释）——防止「confirmDelivered 先于 port.send promise settle」时序倒挂下
      // waiter 永挂（handled 终局恒定路径）。
      resolveWaitersOf(e)
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

  /**
   * confirmDelivered 时 resolve 该条目的 checked waiter（F1-11，与 rejectWaitersOf
   * 对称）：条目已终局 delivered 则受理确认随之了结——delivered 蕴含受理已发生，
   * promise 不可能再走失败 reject。在 finalizeEntry 的 delivered 分支统一驱动，
   * 覆盖全部终局路径（正规送达回执 / rebuild 直确认 / handled 终局适配器内先
   * confirm 后 settle 的时序倒挂形态）。
   */
  function resolveWaitersOf(e: KernelEntry): void {
    for (let i = checkedPending.length - 1; i >= 0; i--) {
      if (checkedPending[i]!.entry === e) {
        checkedPending[i]!.resolve()
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

  // ─── attemptSend：对出站批次执行 port.send ────────────────
  function attemptSend(): void {
    // 在册守卫重过滤（dmg-r1-1 兜底防线）：finalizeEntry 已同步摘出终态条目，此处
    // 对迟到路径（旧批次引用等）统一按在册过滤——已撤销条目不随批次重发；批次清空
    // 则按空收口（复位在途，不投任何文本）。此时不存在未 settle 的旧 port.send
    // promise（进入本函数的前提是上一 promise 已 settle 或首投），复位 inFlight 后
    // pump 启动新投递无防重竞态。
    if (inflightBatch.some((e) => !inRegistry(e))) {
      inflightBatch = inflightBatch.filter((e) => inRegistry(e))
    }
    if (inflightBatch.length === 0) {
      inFlight = false
      pump()
      return
    }
    const batch = inflightBatch
    const composed = buildBatchPayload(batch.map((e) => e.msg))
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
    const batch = inflightBatch
    inFlight = false
    inflightBatch = []
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

  /**
   * 发送失败收口（ADR-0112 首败即停，2026-10-05 用户裁决）：port.send 失败（含
   * accepted:false）一次即终——重试是补偿决策，前提是知道「重试是否安全」，该语义
   * 知识在消费方手里不在内核手里，内核只做事实上报：
   * - checked 条目：waiter reject（失败同步交调用方，agent 工具调用收到失败回执）；
   * - 非 checked 条目：onSettled('rejected') 逐条显式上报（失败通知面，消费方裁决
   *   重发）。
   * 全部失败条目从内核移除、不产 tombstone（未受理无判重语义——「失败 = 可能已执行」
   * 的命令条目重投会重复执行；重发裁决交知道语义的一方）。
   */
  function onSendFail(err: unknown): void {
    if (disposed) return
    const batch = inflightBatch
    inFlight = false
    inflightBatch = []
    warn('port.send failed (first-failure stop, no kernel retry)', err)
    const rejected = settleChecked(batch, err, checkedPending)
    let changed = false
    for (const e of batch) {
      if (!inRegistry(e)) continue
      if (rejected.has(e)) continue // checked 已随 reject 收口
      callOnSettled(e.msg, 'rejected')
    }
    for (const e of batch) {
      if (!inRegistry(e)) continue
      removeActive(e)
      changed = true
    }
    if (changed) notifyChange()
    pump()
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
        // 无标记条目组批隔离（D2②）：在途窗口（上一条 prompt RPC 往返 / 压缩等待）内连发的
        // 多条 checked 挂账经本处汇成一批——批内含无标记条目时只取队首一条单独出站，
        // 防裸命令/技能文本与普通条目被分隔符拼接为一条 composed（pi 命令解析必然 miss）。
        inflightBatch = isolateUnmarkedEntry(batch)
        inFlight = true
        attemptSend()
        return
      }
    }
    if (hasQueuedEntries()) {
      scheduleFlush()
      return
    }
    // 全空闲：无待收尾面（watchdog 定时复核腿已随 ADR-0112 退役）
  }

  // ─── doSend：普通队列出站 ─────────────────────────────────
  function doSend(): void {
    if (disposed || inFlight) return

    // 候选批 = 全部 queued 条目（port.send 失败按首败即停收口，受理成功才转移）；
    // 无标记条目组批隔离（D2②）：busy park 积累的队列中无标记条目与普通条目同批时
    // 只取队首一条单独出站（同 pump，防拼接文本使命令解析/身份匹配 miss），普通条目
    // 留守待下一轮。
    const batch = isolateUnmarkedEntry(active.filter((e) => e.state === 'queued'))
    if (batch.length === 0) return
    inFlight = true
    inflightBatch = batch
    attemptSend()
  }

  // ─── scheduleFlush：busy gate（settled 边沿驱动）──────────
  function scheduleFlush(): void {
    if (disposed || !hasQueuedEntries()) return

    // in-flight 防重（在途投递不打断）
    if (inFlight) return

    // busy gate（isIdle + 内核在途内查双条件，D2）：busy 即留守——settled 边沿
    // （agent 回合结束）驱动重投，无订阅装配由外部 flush/send 触发重投。
    // [ADR-0112 退役登记] 原「无订阅装配退避轮询 + 达上限强发」「watchdog 30s 定时
    // 复核」两条时间平抑腿已删除：本机链路边沿信号足够，轮询是补偿性猜测。
    if (isBusySafe()) return

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
      unmarked: opts?.unmarked ?? false,
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
    scheduleFlush()
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
    // 口径锁定；条目在 promise settle 前已终局 delivered 时由 confirmDelivered 的
    // resolveWaitersOf 提前了结——F1-11 handled 终局时序倒挂形态，见头注显式例外段）。
    // 不经 busy gate——busy 时经 streaming 受理入 pi 队列即回（受理即
    // 确认可达，探针 P1 rtt≈1ms）；不带走合批窗口中的其他条目（单独成批）。
    return new Promise<void>((resolve, reject) => {
      checkedPending.push({ entry, resolve, reject })
      if (!inFlight) {
        inflightBatch = [entry]
        inFlight = true
        attemptSend()
      }
      // inFlight：挂账等待，在途终态后 pump 优先直投本条目
    })
  }

  function flush(): void {
    if (disposed) return
    clearMergeTimer()
    scheduleFlush()
  }

  function depth(): number {
    // 口径保持 v1：尚未被底层通道受理的消息数（等待 gate + 出站批次在途）。
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

  function confirmAccepted(id: string): boolean {
    if (disposed) return false
    const e = activeIndex.get(id)
    if (!e || e.state !== 'queued') return false
    // 只接受当前出站批成员：受理事实锚定于在途投递——gate 等待中的 queued 条目
    // 未触达底层通道，登记即虚报受理（条目会以 in-flight 挂起且无回执可等）
    if (!inflightBatch.includes(e)) return false
    inflightBatch.splice(inflightBatch.indexOf(e), 1)
    e.state = 'in-flight'
    e.updatedAt = now()
    // 受理口径 settle（D9⑤）：checked waiter 收到受理确认即 resolve（受理 ≠ 送达，
    // 后续送达仍由 confirmDelivered 驱动 onSettled）
    settleChecked([e], undefined, checkedPending)
    notifyChange()
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
      // queued 幂等跳过（已在队列）；delivered/cancelled 拒绝（终态防复活）；
      // 撤销待收回（cancelRequested，dmg-r1-2）拒绝重排——重排会清撤销标记把用户
      // 已撤销的消息送回投递队列；少排的条目留守原态，调用方经返回数感知
      if (e.state !== 'in-flight' && e.state !== 'failed') continue
      if (e.cancelRequested) continue
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
    }
    active.unshift(...found)
    notifyChange()
    // 回收重投：走 busy gate 复核（对账器多在 settled 边沿后调用；idle 则立即投）
    scheduleFlush()
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
      rejectWaitersOf(e, new DeliveryReclaimError('cancelled', id))
      finalizeEntry(e, 'cancelled')
      return { kind: 'cancelled', entry: snapshot(e) }
    }
    // queued（含出站批次中）/failed：本地终结（× 移除 failed 同路径）
    rejectWaitersOf(e, new DeliveryReclaimError('cancelled', id))
    finalizeEntry(e, 'cancelled')
    return { kind: 'cancelled', entry: snapshot(e) }
  }

  /**
   * 断连事件驱动的显式失败终局（failInFlight，ADR-0112）：in-flight 条目批量转
   * failed（留守活跃集等用户处置：resync 重试 / cancel 移除），逐条 onSettled
   * ('rejected')。queued 条目不触碰；终态/未知条目跳过（幂等）。在途出站批次引用
   * 同步摘除终态成员（dmg-r1-1 同口径）。
   */
  function failInFlight(reason: string): number {
    if (disposed) return 0
    const ts = now()
    let count = 0
    for (const e of active) {
      if (e.state !== 'in-flight') continue
      const batchIdx = inflightBatch.indexOf(e)
      if (batchIdx !== -1) inflightBatch.splice(batchIdx, 1)
      e.state = 'failed'
      e.updatedAt = ts
      e.settledAt = ts
      e.sendAttempts = 1
      count++
      callOnSettled(e.msg, 'rejected')
    }
    if (count > 0) {
      warn(`failInFlight: ${count} in-flight entry(ies) marked failed (${reason})`)
      notifyChange()
    }
    return count
  }

  function drain(): DrainResult {
    if (disposed) return []
    // 清合批 timer（重试/gate 退避/悬挂兜底 timer 已随 ADR-0112 退役）
    clearMergeTimer()
    const drained = active.slice()
    active.length = 0
    activeIndex.clear()
    inflightBatch = []
    inFlight = false
    const ts = now()
    const result = drained.map((e) => {
      // 全部记 cancelled tombstone：drain 后该 id 不应再被 resync 重报复活
      tombstones.set(e.id, { id: e.id, state: 'cancelled', lane: e.lane, settledAt: ts })
      return { id: e.id, payload: e.payload }
    })
    // 挂起中的 checked 不留永久 pending
    for (const w of checkedPending) {
      w.reject(new DeliveryReclaimError('drained'))
    }
    checkedPending.length = 0
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

    // 清所有 timer（合批窗口为唯一存量 timer；重试/gate 退避/悬挂兜底/watchdog
    // 均已随 ADR-0112 退役）
    clearMergeTimer()
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

  return { send, sendChecked, flush, depth, entriesFull, projection, onChange, confirmDelivered, confirmAccepted, requeue, cancel, failInFlight, drain, dispose }
}

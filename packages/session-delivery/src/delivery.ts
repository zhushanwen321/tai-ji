/**
 * 投递所有权内核实现：createDelivery（v2）。
 *
 * 在 v1 投递循环之上升级为条目制所有权内核（v2 设计批次 D9①②③⑤ / D5②③ / D3，单元 u1——
 * 设计文档未入 git，裁决随本仓 commit 历史可溯）。零 pi 依赖不变：确认/回收由适配器（runtime
 * registry）调 handle 方法驱动。
 *
 * 五态状态机（D9①，types.ts 迁移表）+ 本文件登记的实施扩展：
 * - queued → in-flight：出站投递被受理（两阶段回执第一阶段，D2）
 * - in-flight → delivered：confirmDelivered（送达回执，D2）
 * - in-flight → queued：requeue（对账回收重投，D3）
 * - queued/failed → cancelled：cancel（本地移除 + tombstone / 用户 × 移除）
 * - in-flight → failed：断连事件驱动的未确认终局（failInFlight，ADR-0122）
 * - queued → failed：出站投递受理失败留守（onFailure='failed'，chat-flow-consistency
 *   第 11 条——与断连未确认同出路，等用户处置）
 * - failed → queued：requeue（用户重试/resync 单条重报）
 * - [扩展①] queued/failed → delivered：confirmDelivered 也接受 queued 与 failed
 *   态——queued 服务 reattach 场景 rebuild 直确认重建（D3②：适配器扫描 transcript
 *   判 delivered 后 send 重建 + confirmDelivered 一步落终态），以及出站批次在途时
 *   送达回执先于受理回执到达的竞态形态（message_end 比 RPC resolve 快，事实优先）；
 *   failed 服务第 11 条受理失败的歧义性终结——迟到的送达回执 / resync 的 transcript
 *   预检命中即确定性送达事实，行随事实消失。
 * - [扩展②] cancel 对 in-flight 两段式：首次调用只标记待收回（条目留守 in-flight，
 *   返回 reclaim-requested，适配器驱动 clear_queue 收回）；适配器收回确认后再次
 *   cancel(id) 终结为 cancelled + tombstone。收回失败不再调 → 条目留守原态
 *   （§3.4「目标条目留守原态」）；若文本实际进了 transcript，confirmDelivered
 *   对已标记条目事实优先转 delivered（delivered 事实 > cancel 意图）。
 * - [扩展③] confirmAccepted 受理登记（分段 port 实现用，dmg-r1-4）：申报批内条目
 *   已由底层通道受理——queued → in-flight + 出批 + checked waiter 受理口径 resolve。
 *   合批分段中途失败时已登记段留守 in-flight（等回执/对账），仅未受理段按失败处理。
 *
 * 失败语义（ADR-0122 首败即停，2026-10-05 用户裁决，backoff 自动重试链退役）：
 * port.send 失败（含 accepted:false）一次即收尾——处置按条目 onFailure 策略分流：
 * forget 条目 checked reject + 从内核移除；非 checked forget 条目 onSettled('rejected')
 * 逐条显式上报 + 从内核移除；failed 条目（chat-flow-consistency 第 11 条）转 failed
 * 终态留守（不自动重投，等用户处置：resync 重试 / cancel 撤销），checked waiter
 * reject 照常（受理口径通知与条目状态正交）。唯一例外：拒绝回执为 deferred 形态
 * （设计内等待，DeliveryDeferReason——如 port 合批提交窗 hold）不计首败，条目留守
 * 等投递端下一边沿重提（onSendDeferred）。重试决策归消费方（人看页面通知、agent
 * 收失败回执），内核只做忠实投递与事实上报。
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
 * 双视图（D9②/D5③）：entriesFull() = 全量视图（活跃条目 + 全量终局记录，对账/
 * 判重消费）；projection() = 派生视图（活跃全量 + delivered 最近 50 条完整条目，
 * cancelled 不进派生视图；窗口恒为默认常量）。delivered 完整条目留存上限
 * = 默认派生视图窗口 50（终局记录全量保留不受限——判重正确性不依赖展示窗口）。
 *
 * 判重（v3 统一：在途条目 → 内存已完结 id 索引 → 持久记录，设计 unified-delivery
 * §3.5.5）：resync 重报/重建以显式 id 查三级判重链去重（send/sendChecked 的 opts.id
 * 命中即吞）。一级 = 活跃集（activeIndex，含 queued/in-flight/failed）；二级 = 内存
 * 已完结 id 索引（terminalIndex：store.loadTerminalIds 启动播种 + 终局即时登记）；
 * 三级 = 持久记录（store.hasTerminal，索引 miss 的持久兜底）。v2 的 tombstone 独立
 * 判重机制与 DeliveryTombstone 类型退役；已撤销消息的防复活凭据 = 撤销时写持久
 * 终局（store.ack）。条目 id = opts.id ?? 内部生成；未传 id 的消息不参与幂等判重
 * （v1「无 dedupe 配置不去重」语义保持）。
 *
 * v3 增量（统一消息投递内核，设计 unified-delivery §3.5）：
 * - DeliveryStore 端口（config.store）：send/sendChecked 受理前先 persist（耐久承诺
 *   先于投递尝试；persist 抛错 = 承诺未落 → 拒收 rejected('persist-failed')，条目
 *   回滚不入队不投递）；终局 delivered / cancelled 后 ack（finalizeEntry / drain）；
 *   forget 失败条目 discard（无终局语义的记录无痕移除，防重启复活）。ack / 判重
 *   查询的 store 异常降级 warn 留痕、状态机照常（终局事实已发生 / 探测异常降级
 *   保守放行）；persist 异常 fail-fast 拒收（承诺语义）。
 * - 送达凭据三档（receiptAnchor）：'details-id' 与 'marker' / 'acceptance' 并列
 *   （ADR-0074 词条扩展）。details-id 条目受理后维持 in-flight 等回执（同 marker）；
 *   判定逻辑以可注入凭据检查函数（config.proofCheck）承载，调用点 =
 *   handle.confirmDeliveredByProof(id)——装配方在回执证据到达时调用，内核按条目
 *   凭据档位分派（非 details-id 条目一律拒绝，防误确认）。
 * - 失败保留策略（opts.onFailure：'forget' | 'retain' | 'failed'，缺省 custom=retain /
 *   text=forget）：retain 条目首败后内存态转回 queued 留守（下一 settled 边沿 /
 *   外部 flush 重入队，事件驱动无定时器；失败轮不主动重投——防 idle 同步失败循环），
 *   store 记录保留（重启经 loadUndelivered 重入队）；forget 条目维持现状首败即停；
 *   failed 条目转 failed 终态留守（无自动重投，等用户 resync 重试 / cancel 撤销——
 *   chat-flow-consistency 第 11 条）。sendChecked 挂起条目缺省/显式 retain 按 forget
 *   处置（同步失败回执契约与 retain 重投矛盾）；显式 failed 放行（reject 是受理口径
 *   通知，failed 留守是条目状态，不自动重投故无矛盾观测）。
 * - 受理即出站（v3，唯一出站形态）：受理后立即 port.send（忙闲门禁旁路——承重
 *   前提 = 底层唯一队列忙时不拒，适配层保证）；无合批窗口（队列唯一化后无组批
 *   时机，合批归 port 提交侧承载）；in-flight 防重保留（内核自身并发保护）；
 *   retain 失败留守条目经 settled 边沿 / 外部 flush 重投（事件驱动，无定时器）。
 *   v2 队列持有形态（busy gate 排队 + 合批窗口）已随队列持有分支退役删除。
 *
 * 其余 v1/v2 机制逐条保持：settled 边沿驱动（send / flush / 边沿统一出站触发）、
 * dedupe LRU、dispose 语义（丢弃不触发 onSettled、checked 挂起 reject）。
 * [ADR-0122 退役登记] backoff 自动重试链、port.send settle 挂死兜底
 * （60s）、watchdog 30s 定时复核、无订阅装配 busy 退避轮询——时间平抑/补偿类机制
 * 全部删除。depth() 口径保持 v1 = 尚未受理的
 * 消息数（受理转 in-flight 后不计；「在途未确认」数经 entriesFull() 全量视图消费）。
 */

import { DeliveryReclaimError } from './errors.js'
import { LruSet } from './lru.js'
import type {
  DeliveryConfig,
  DeliveryDeferReason,
  DeliveryEntry,
  DeliveryEntriesFull,
  DeliveryEntriesProjection,
  DeliveryEntryState,
  DeliveryFailurePolicy,
  DeliveryHandle,
  DeliveryIntent,
  DeliveryLane,
  DeliveryMessage,
  DeliveryPayload,
  DeliveryPort,
  DeliveryReceiptAnchor,
  DeliveryStore,
  DeliveryTerminalRecord,
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

/** send/sendChecked 提交选项。 */
export interface DeliverySubmitOptions {
  /**
   * 客户端幂等 id（= 条目 id = 协议层 clientUuid，D2 裸标记身份源/D5② 判重锚）。
   * 显式提供时参与幂等判重：命中活跃条目或 tombstone 即吞（resync 重报/重放去重）。
   * 缺省内部生成、不参与判重。
   */
  id?: string
  /** 投递路径（D1）：适配器判定后传入记录；缺省 'direct'（既有调用方语义）。 */
  lane?: DeliveryLane
  /**
   * 送达回执锚申报（msg-pipeline-debloat D1 申报制；v3 三档，ADR-0074 词条扩展）：
   * 提交方声明本条目的送达判定锚。
   * - 'marker'（缺省）= 出站文本尾附裸标记、送达以 message_end 回执命中为准
   *   （用户消息主通路语义）；受理后维持 in-flight 等回执。
   * - 'acceptance' = 无回执锚点条目（agent 通路：完成回流 / session_manager send /
   *   notifier 通知——出站文本原样不改），port.send 受理成功即落 delivered 终态
   *   （「受理 = 送达」是唯一可判事实，v1 记账口径 / D9⑤ 显式例外）。
   * - 'details-id'（v3）= 通知条目凭据（deliveryId 由注入端写入 details，业务字段
   *   保持原样）：送达判定 = 对话记录中出现 details 携带本条目 id 的通知条目；受理
   *   后维持 in-flight 等回执（同 'marker'），终局由装配方调 handle.confirmDeliveredByProof
   *   驱动（判定逻辑经 config.proofCheck 注入，内核零 pi 知识）。
   *
 * 缺省 'marker' 是刻意的保守取向：无标记提交点漏申报的代价 = 复发已知死锁形态
 * （in-flight 永挂——条目无人确认终态，有全链诊断可查，可见）；误申报 'acceptance' 的代价
   * = 静默丢送达确认语义（更隐蔽）。两害取可见者。新增无标记投递来源必须显式申报
   * 'acceptance' 或 'details-id' 并登记来源清单（ADR-0074 词条）。
   */
  receiptAnchor?: DeliveryReceiptAnchor
  /**
   * 失败保留策略（v3）：port.send 首败时本条目的处置（ADR-0122 无内核自动重试不变
   * ——retain 不是重试机制，是失败条目的留存策略）。
   * - 'forget' = 首败即停 + 显式上报后移除；store 已 persist 的记录同步 discard。
   * - 'retain' = 失败条目留守：内存态转回 queued 等下一 settled 边沿 / 外部 flush
   *   重入队；store 记录保留（重启经 loadUndelivered 重入队）。
   * - 'failed' = 受理失败转 failed 终态留守（chat-flow-consistency 第 11 条）：不自动
   *   重投、不 discard，等用户处置（resync 重试 / cancel 撤销），与断连 failInFlight
   *   的 failed 同态同出路。
   * 缺省按载荷类型：custom = 'retain' / text = 'forget'（§3.4 缺省值表：交互在席 vs
   * 无人值守）。sendChecked 挂起条目缺省/显式 retain 按 forget 处置（同步失败回执
   * 契约与 retain 重投矛盾；一次性 warn）；显式 failed 放行——waiter reject 是受理
   * 口径通知，failed 留守是条目状态，两者不矛盾（failed 不自动重投）。
   */
  onFailure?: DeliveryFailurePolicy
  /**
   * 无标记条目标志（pi1-disposition-chat-flow D14⑥ 起源；技能/芯片通路并入后为
   * 「出站不注标条目」统一标志——命令 / 手打 skill 与 prompt 模板 / `<taiji-skill>`
   * 芯片注入文本）。true = 条目出站文本不带投递标记、终局凭据不走 message_end
   * 标记回执（pi disposition 响应 / 断连事件驱动，适配器职责）。内核两处行为：
   * - 组批隔离：与普通条目合批会被 buildBatchPayload 以 BATCH_SEP 拼接，pi 命令解析
   *   与适配器全文身份匹配对拼接文本必然失效——批内含无标记条目时只取队首一条单独
   *   成批（isolateUnmarkedEntry）。
   * - 首败即停（ADR-0122 统一语义后不再差异化，全条目同形态）。
   * 'acceptance' 锚条目（agent 通路）出站同样无标记但走合批、以受理即终态，不置
   * 本标志。
   */
  unmarked?: boolean
}

/**
 * send() 受理结果（b31-D6：失败双表面窄口收尾）。调用方忽略返回值不受影响
 * （v1 句柄面 send 仍声明 void，结构兼容）。三分口径：
 * - accepted：已入队并进入投递流程（id = 条目 id，供调用方对账/判重锚定）
 * - swallowed：幂等吞（already-seen = 显式 id 命中活跃集/tombstone；duplicate-content
 *   = dedupeKey 内容级去重命中）——设计内去重，非失败
 * - rejected：拒收未入队（disposed = 句柄已销毁；unsupported-payload = 通路能力
 *   不含该 payload kind；persist-failed = store 受理前写入记录失败——耐久承诺未写入，
 *   v3 仅 config.store 装配时可达）——仅 warn 单表面 + 本返回值，无终态无 onSettled
 *
 * void 兼容口径（与 SendReceipt 的 U2 扩展位同构）：接口返回类型含 void——
 * v1 → v2 测试替身适配（runtime asHandleV2 直转发 v1 handle.send）返回 void =
 * 受理未知；内核本体实现恒返回具体结果，void 分支仅为替身/旧实现预留。
 */
export type DeliverySendResult =
  | { kind: 'accepted'; id: string }
  | { kind: 'swallowed'; reason: 'already-seen' | 'duplicate-content' }
  | { kind: 'rejected'; reason: 'disposed' | 'unsupported-payload' | 'persist-failed' }

/** v2 句柄：v1 DeliveryHandle 的超集（结构兼容，既有消费者零改动）。 */
export interface DeliveryHandleV2 extends DeliveryHandle {
  /** 唯一常规入口（D4 入口收敛）；返回受理/吞/拒收口径（void = 受理未知，替身兼容）。 */
  send(msg: DeliveryMessage, opts?: DeliverySubmitOptions): DeliverySendResult | void
  sendChecked(msg: DeliveryMessage, opts?: DeliverySubmitOptions): Promise<void>
  /** 全量视图（D9②）：活跃条目（完整字段）+ 全部 tombstone。快照（防御性拷贝）。 */
  entriesFull(): DeliveryEntriesFull
  /** 派生视图（D9②/D5③）：活跃全量 + delivered 最近 50 条完整条目，cancelled 不进派生视图。 */
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
   * 凭据检查驱动的送达确认（v3，'details-id' 凭据调用点）：仅对申报 'details-id'
   * 的条目生效——调 config.proofCheck(id)（对话记录中出现 details 携带本条目 id 的
   * 通知条目的判定，由装配方注入实现），true → confirmDelivered（终局化 + onSettled
   * 回调），false → 留守。非 details-id 条目（marker / acceptance 有各自判定通路）、
   * 未注入 proofCheck、proofCheck 抛错（降级 warn 视为未送达，保守放行型降级）时
   * 一律返回 false 不转移。装配方在回执证据到达（message_end 等）或重放扫描时对本
   * 批候选条目调用，内核保证凭据档位分派（误确认在结构上不可达）。
   * 幂等：未知/已终态 no-op。@returns 是否发生了状态转移。
   */
  confirmDeliveredByProof(id: string): boolean
  /**
   * 受理登记（[扩展③]，dmg-r1-4）：分段 port 实现申报「本条目已由底层通道受理」。
   * 只接受当前出站批内的 queued 条目（受理事实锚定于在途投递）；生效即 queued →
   * in-flight 转移 + 出批 + checked waiter 按受理口径 resolve（D9⑤）。幂等：非批内/
   * 已转移/未知 id 返回 false。合批分段中途失败时已登记段留守 in-flight（等回执/对账），
   * 仅未受理段按失败处理——已进底层通道的文本不再误报「投递失败」。
   */
  confirmAccepted(id: string): boolean
  /**
   * 断连事件驱动的显式失败终局（ADR-0122 命令终局事件化的断连路径）：把全部 in-flight
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
  /**
   * 原位替换条目内容（chat-flow-consistency D6 edit 原语）：语义 = 替换指定条目的 payload
   * 且**条目 id 与排队位置均不变**——上层只见「替换内容，位置保持」，收回-全部-保序重投是
   * registry 编排层组合 requeue 的内部细节，本原语不感知 pi。
   * 接受 queued（未触达底层通道，替换后出站即新文本；持有期排队的常态）/ failed（留守行
   * 编辑，替换后由调用方 requeue 重投）/ in-flight（registry 收回路径：clear_queue 已把
   * 文本收回后、requeue 重投前的窗口内替换）。拒绝：终态/未知 id（false）、queued 但已在
   * 出站批内（受理登记窗口——文本可能已进底层通道，替换会双投，调用方按悬空窗口处置）。
   * msg.payload 同步替换引用（onSettled per-message 契约的消费方拿到替换后内容）。
   */
  edit(id: string, payload: DeliveryPayload): boolean
  /** 全量取回文本（forceQuit，D9③）：条目清空 + 全部记 cancelled tombstone。 */
  drain(): DrainResult
}

/** cancel(id) 结果（D-3 偏差：cancelled 形态携带条目快照含 payload 全文供草稿恢复）。 */
export type DeliveryCancelResult =
  | { kind: 'cancelled'; entry: DeliveryEntry }
  | { kind: 'reclaim-requested'; entry: DeliveryEntry }
  | { kind: 'already-final'; tombstone: DeliveryTerminalRecord }
  | { kind: 'not-found' }

/** drain() 返回：全部未终态条目的文本取回（Segment[] 快照切分归上层，ADR-0043）。 */
export type DrainResult = ReadonlyArray<{ id: string; payload: DeliveryPayload }>

/** 默认配置（D4 策略默认值）。 */
const DEFAULT_CONFIG: Required<Omit<DeliveryConfig, 'dedupe' | 'onSettled' | 'store' | 'proofCheck'>> = {
  intent: 'interrupt-at-turn-boundary',
}

/** 派生视图默认窗口（D5③）；同时是 delivered 完整条目留存上限（环形）。 */
const DEFAULT_DELIVERED_WINDOW = 50

/** sendChecked 的挂起：resolve/reject 挂钩所属条目的 port.send 受理结果。 */
interface CheckedWaiter {
  entry: KernelEntry
  resolve: () => void
  reject: (err: unknown) => void
}

/**
 * 内核条目：DeliveryEntry + 实现私有字段。msg 为原始消息引用（合批构造 /
 * onSettled 回调身份源）；cancelRequested 为 in-flight 撤销两段式的待收回标记；
 * receiptAnchor 为提交方申报的送达凭据档位（D1 申报制 / v3 三档，沿 opts.id/opts.lane
 * 持久化先例直达内部字段——不进 DeliveryEntry 条目视图 DTO，派生视图零扩散）；
 * unmarked 为无标记出站条目标志（命令/技能，组批隔离判定源；同一持久化先例，
 * 派生视图零扩散）；onFailure 为失败保留策略（v3，创建时按载荷类型解析缺省后定型）。
 */
interface KernelEntry extends DeliveryEntry {
  msg: DeliveryMessage
  cancelRequested: boolean
  receiptAnchor: DeliveryReceiptAnchor
  unmarked: boolean
  onFailure: DeliveryFailurePolicy
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
   * 已完结 id 判重索引（v3，判重第二级）：terminalRecords 的 id 集合 + store 播种
   * （loadTerminalIds，启动 / 重放时构建——覆盖本 handle 生命周期之前的持久终局）+
   * 终局即时登记。判重链 = activeIndex（一级，在途）→ 本索引（二级）→
   * store.hasTerminal（三级，持久兜底）。
   */
  const terminalIndex = new Set<string>()
  /**
   * 终局记录表（entriesFull().tombstones 视图源 + cancel already-final 承载）：本
   * handle 生命周期内终局条目的完整元数据，handle 存活期内全量保留、不设数量窗口。
   * v2 的 tombstone 独立判重机制退役——本表不再参与判重（判重走 terminalIndex +
   * store 持久终局），只承载派生的视图数据。dispose 时随 handle 释放（不跨 runtime 重启，
   * 重启后的判重锚 = store.loadTerminalIds 播种）。
   */
  const terminalRecords = new Map<string, DeliveryTerminalRecord>()
  /** store 装配缺省一次性 warn 去重（checked+retain 覆写）。 */
  let checkedRetainWarned = false
  /**
   * delivered 完整条目环形留存（派生视图源，D5③「最近 50 条完整条目」）。
   * 上限 = DEFAULT_DELIVERED_WINDOW；判重正确性不依赖它（tombstone 全量）。
   */
  const deliveredLog: KernelEntry[] = []
  /** sendChecked 等待受理确认的挂起（条目在 active，出站批次或在途防重挂起）。 */
  const checkedPending: CheckedWaiter[] = []
  /**
   * 出站批次：doSend/checked 直投从 active 锁定后、终态前持有引用。条目 state
   * 保持 queued（受理才转 in-flight，D2 两阶段）；port.send 失败按首败即停收尾
   * （ADR-0122，批次成员从内核移除）。
   */
  let inflightBatch: KernelEntry[] = []
  let inFlight = false // in-flight 防重：至多一个 port.send 在途
  let disposed = false
  let settledUnsub: (() => void) | undefined
  let missingKeyWarned = false // #12 dedupeKey 缺失提示按 handle 一次性
  let idSeq = 0 // 内部条目 id 计数器（未显式传 id 时）

  // 去重（v1 内容级 dedupe 配置，与 v2 显式 id 幂等判重正交叠加）
  const dedupSet = config?.dedupe ? new LruSet(config.dedupe.maxKeys) : null

  // onChange 订阅（D9②，state topic 装配消费）
  const changeSubs = new Set<() => void>()

  // ─── v3 DeliveryStore 装配（设计 §3.5.1）───────────────────
  // 缺省 undefined = 无耐久层（v2 行为）；提供时构造期播种判重索引（启动 / 重放
  // 语义：把持久终局记录构建为内存索引，对齐账本 ackedIds 播种）。loadTerminalIds
  // 抛错不吞——装配错误 fail-fast 早暴露（与 persist 的承诺语义同侧）。
  const store: DeliveryStore | undefined = config?.store
  if (store) {
    for (const id of store.loadTerminalIds()) terminalIndex.add(id)
  }

  /**
   * 受理前写入记录（耐久承诺先于投递尝试）。抛错 = 承诺未写入 → 调用方拒收条目（send
   * 返回 persist-failed / sendChecked 同步 throw），不进入投递流程。
   * record = 条目创建时点的持久化派生数据（intent 按条目定型解析——重入队时按原档重报）。
   */
  function persistRecord(e: KernelEntry): void {
    if (!store) return
    store.persist({
      id: e.id,
      lane: e.lane,
      payload: e.payload,
      intent: e.msg.intent ?? cfg.intent,
      recordedAt: e.createdAt,
      receiptAnchor: e.receiptAnchor,
      unmarked: e.unmarked,
      meta: e.msg.meta,
    })
  }

  /** 终局写持久终局（finalizeEntry / drain 调用）。异常降级 warn——终局事实已发生，状态机不回滚。 */
  function ackStore(id: string): void {
    if (!store) return
    try {
      store.ack(id)
    } catch (err) {
      warn(`store.ack failed (terminal record not persisted; id=${id})`, err)
    }
  }

  /**
   * 判重第三级「查持久记录」（保守放行型降级）：store.hasTerminal 异常视为
   * miss + warn 留痕（探测降级保守放行——重投风险可见可查，不破坏 send 入口
   * never-throw 契约）。
   */
  function safeHasTerminal(id: string): boolean {
    if (!store) return false
    try {
      return store.hasTerminal(id)
    } catch (err) {
      warn(`store.hasTerminal threw; treating as not-terminal (id=${id})`, err)
      return false
    }
  }

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

  /** 活跃条目是否仍在册（出站批/迟到回执检查：已 cancel/drain/dispose 的条目不在）。 */
  function inRegistry(e: KernelEntry): boolean {
    return activeIndex.get(e.id) === e
  }

  function hasQueuedEntries(): boolean {
    for (const e of active) if (e.state === 'queued') return true
    return false
  }

  /** 终态落定：出活跃集 + 登记判重索引 + 写终局记录 + 持久终局（v3 判重统一）。调用方负责 onSettled/通知语义。 */
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
    // v3 判重统一（设计 §3.5.5）：终局即时登记内存索引 + 终局记录 + 持久终局
    // （已撤销消息的防复活凭据 = 撤销时写持久终局；store 未装配时索引 ≡ 记录表，
    // 行为与 v2 tombstones Map 逐字节等价）。
    terminalIndex.add(e.id)
    terminalRecords.set(e.id, { id: e.id, state, lane: e.lane, settledAt: ts })
    ackStore(e.id)
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

  // ─── settled 订阅管理 ──────────────────────────────────────
  function ensureSettledSub(): void {
    if (settledUnsub || !port.subscribeSettled) return
    settledUnsub = port.subscribeSettled(() => {
      if (disposed) return
      // settled 边沿 → flush（受理即出站，无忙闲复核）：retain 失败留守条目的
      // 「下一边沿重投」由本触发承载；无留守条目时 scheduleFlush 的
      // hasQueuedEntries 短路，边沿零成本。
      flush()
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
    // 在册检查重过滤（dmg-r1-1 兜底防线）：finalizeEntry 已同步摘出终态条目，此处
    // 对迟到路径（旧批次引用等）统一按在册过滤——已撤销条目不随批次重发；批次清空
    // 则按空收尾（复位在途，不投任何文本）。此时不存在未 settle 的旧 port.send
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
   * 受理判定（U2 回执口径）：拒绝分支按判别字段分流（MF-1-4）——`{ accepted: false,
   * deferred }` 为设计内等待（DeliveryDeferReason，F1-13）走 onSendDeferred 收尾
   * （暂不收，非失败）；`{ accepted: false, reason }` 走发送失败收尾（首败语义）；
   * void / `{ accepted: true }` = 受理成功（旧 port 兼容）。
   */
  function onSendReceipt(receipt: SendReceipt | void): void {
    if (receipt !== undefined && receipt.accepted === false) {
      if ('deferred' in receipt) {
        onSendDeferred(receipt.deferred)
        return
      }
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
    // 终结或移出——按在册检查跳过。
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
   * 发送失败收尾（ADR-0122 首败即停，2026-10-05 用户裁决）：port.send 失败（含
   * accepted:false，设计内等待 reason 除外——onSendDeferred）一次即终——重试是
   * 补偿决策，前提是知道「重试是否安全」，该语义
   * 知识在消费方手里不在内核手里，内核只做事实上报。失败处置按条目 onFailure
   * 策略分流（v3）：
   * - forget（缺省 text / checked 缺省·retain 归一）：checked 条目 waiter reject
   *   （失败同步交调用方，agent 工具调用收到失败回执）；非 checked 条目
   *   onSettled('rejected') 逐条显式上报（失败通知面，消费方裁决重发）。全部 forget
   *   失败条目从内核移除 + store 记录 discard（未受理无判重语义——「失败 = 可能已
   *   执行」的命令条目重投会重复执行；记录残留会让重启后 loadUndelivered 把已弃
   *   条目当未投递复活）。
   * - retain（缺省 custom）：失败条目留守——内存态转回 queued（下一 settled 边沿 /
   *   外部 flush 重入队，事件驱动无定时器），store 记录保留（重启经 loadUndelivered
   *   重入队）。失败轮不主动重投（见尾部 pump 抑制）。
   * - failed（chat-flow-consistency 第 11 条）：条目转 failed 终态留守（queued →
   *   failed 迁移；不自动重投，等用户 resync 重试 / cancel 撤销），store 记录保留
   *   （不 discard 不 ack——重启经 loadUndelivered 重放，重放带 transcript 判重防
   *   线）。checked waiter reject 照常（受理口径通知与条目状态正交——reject = 调用
   *   方已收失败回执，failed 留守 = 条目可见可处置，与断连 failInFlight 的 failed
   *   同态同出路：队列区一行 + 错误上报双呈现）。
   */
  function onSendFail(err: unknown): void {
    if (disposed) return
    const batch = inflightBatch
    inFlight = false
    inflightBatch = []
    warn('port.send failed (first-failure stop, no kernel retry)', err)
    const rejected = settleChecked(batch, err, checkedPending)
    let changed = false
    let retained = false
    for (const e of batch) {
      if (!inRegistry(e)) continue
      if (rejected.has(e)) continue // checked 的受理口径通知已随 reject 交付（failed 策略同）
      if (e.onFailure === 'retain') continue // 留守非终局——不发失败终局通知（见下）
      callOnSettled(e.msg, 'rejected')
    }
    const ts = now()
    for (const e of batch) {
      if (!inRegistry(e)) continue
      if (e.onFailure === 'retain') {
        // retain 留守：转回 queued 等下一边沿 / 重启重入队；store 记录保留（不
        // discard 不 ack——仍是未投递事实）。不 onSettled（终态未落，留守非终局；
        // 失败可见性走 warn 留痕）。
        e.state = 'queued'
        e.updatedAt = now()
        changed = true
        retained = true
        warn(`entry retained after failure (id=${e.id}); re-dispatch waits for next settled edge or external flush`)
        continue
      }
      if (e.onFailure === 'failed') {
        // failed 留守（第 11 条）：转 failed 终态（queued → failed 迁移），活跃集
        // 留守等用户处置（resync 重试 / cancel 移除）；store 记录保留——重启后经
        // loadUndelivered 重放，重放带 transcript 判重（已进 transcript 的条目只
        // 记账不重投）。失败上报：checked 已随 reject 交付；非 checked 走上方
        // onSettled('rejected') 逐条显式上报。
        e.state = 'failed'
        e.updatedAt = ts
        e.settledAt = ts
        changed = true
        warn(`entry kept as failed after rejection (id=${e.id}); awaiting user retry (resync) or cancel`)
        continue
      }
      store?.discard(e.id)
      removeActive(e)
      changed = true
    }
    if (changed) notifyChange()
    // 本轮含 retain 留守条目时不主动 pump：idle 下立即重投会形成「失败 → 重投 →
    // 失败」同步循环（首败即停红线的对偶面）。「下一边沿」语义 = 等 settled 边沿 /
    // 外部 flush / 新 send 触发（事件驱动）。failed 留守条目不参与 pump（无自动
    // 重投——requeue 只接受 in-flight/failed，重试入口 = 用户 resync 驱动）。
    if (!retained) pump()
  }

  /**
   * 设计内等待收尾（F1-13）：port.send 返回 `{ accepted: false, deferred }`（设计内
   * 等待，DeliveryDeferReason——如 port 合批提交窗的 'merge-commit-hold'：注入门禁
   * hold，窗口结束后投递端会 kernel.flush() 重提）时，条目从未被注入（host.sendMessage
   * 未调用），拒绝不是失败：不计首败——不 store.discard、不 removeActive、不
   * onSettled('rejected')、checked waiter 不 reject（受理未发生亦无首败），条目保持
   * active 在册（queued）等投递端下一边沿重新提交（port 合批窗提交 / 缓冲重放会
   * 重提）。本轮不主动 pump：提交窗未结束时重投必再次被 hold（同步循环，与 retain
   * 分支「失败轮不主动重投」同理）——重投触发由投递端的窗口结束 flush 承诺。
   */
  function onSendDeferred(reason: DeliveryDeferReason): void {
    if (disposed) return
    const batch = inflightBatch
    inFlight = false
    inflightBatch = []
    warn(
      `port.send deferred (designed-in wait, reason=${reason}); ${batch.length} entry(ies) stay queued for next dispatch edge`,
    )
  }

  // ─── pump：在途结束后决定下一步（checked 优先，然后普通队列）──
  function pump(): void {
    if (disposed || inFlight) return
    if (checkedPending.length > 0) {
      // checked 优先直投：受理即出站（busy 不拦——经 streaming 受理入 pi 队列即回，
      // 探针 P1：rtt≈1ms，以此确认可达（#8 resolve = 已受理语义））
      const batch: KernelEntry[] = []
      for (const w of checkedPending) {
        if (inRegistry(w.entry) && w.entry.state === 'queued') batch.push(w.entry)
      }
      if (batch.length > 0) {
        // 无标记条目组批隔离（D2②）：在途窗口（上一条 prompt RPC 往返 / 压缩等待）内连发的
        // 多条 checked 挂起经本处汇成一批——批内含无标记条目时只取队首一条单独出站，
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
    // 全空闲：无待收尾条目（watchdog 定时复核路径已随 ADR-0122 退役）
  }

  // ─── doSend：普通队列出站 ─────────────────────────────────
  function doSend(): void {
    if (disposed || inFlight) return

    // 候选批 = 全部 queued 条目（port.send 失败按首败即停收尾，受理成功才转移）；
    // 无标记条目组批隔离（D2②）：在途防重 / deferred / retain 积累的队列中无标记
    // 条目与普通条目同批时只取队首一条单独出站（同 pump，防拼接文本使命令解析/
    // 身份匹配 miss），普通条目留守待下一轮。
    const batch = isolateUnmarkedEntry(active.filter((e) => e.state === 'queued'))
    if (batch.length === 0) return
    inFlight = true
    inflightBatch = batch
    attemptSend()
  }

  // ─── scheduleFlush：出站驱动（受理即出站：受理后立即出站，无忙闲门禁）──
  function scheduleFlush(): void {
    if (disposed || !hasQueuedEntries()) return

    // in-flight 防重（在途投递不打断）——内核自身并发保护
    if (inFlight) return

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

  // ─── v3 幂等判重（三级：在途条目 → 内存已完结 id 索引 → 持久记录，设计 §3.5.5）───
  function seenId(id: string | undefined): boolean {
    if (id === undefined) return false
    if (activeIndex.has(id)) return true // 一级：在途（queued/in-flight/failed 活跃集）
    if (terminalIndex.has(id)) return true // 二级：内存索引（播种 + 终局即时登记）
    return safeHasTerminal(id) // 三级：持久记录（索引 miss 的持久兜底）
  }

  /** 失败保留策略缺省解析（§3.4 缺省值表：custom = retain / text = forget）。 */
  function resolveOnFailure(msg: DeliveryMessage, opts?: DeliverySubmitOptions): DeliveryFailurePolicy {
    return opts?.onFailure ?? (msg.payload.kind === 'custom' ? 'retain' : 'forget')
  }

  /**
   * 受理前写入记录 + 失败回滚（v3 耐久承诺先于投递尝试）。persist 抛错 = 承诺未写入 →
   * 条目回滚出活跃集（未受理未投递，无判重语义——同 forget 首败），调用方按各自
   * 入口契约上报（send 返回 rejected('persist-failed') / sendChecked 同步 throw）。
   * @returns true = 写入记录成功继续投递流程；false = 已回滚（调用方直接返回）。
   */
  function persistBeforeAccept(e: KernelEntry): boolean {
    try {
      persistRecord(e)
      return true
    } catch (err) {
      warn(`store.persist failed before accept; entry rejected (id=${e.id})`, err)
      removeActive(e)
      return false
    }
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
      msg,
      cancelRequested: false,
      receiptAnchor: opts?.receiptAnchor ?? 'marker',
      unmarked: opts?.unmarked ?? false,
      onFailure: resolveOnFailure(msg, opts),
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

    // 4. 入条目（queued）+ 受理前写入记录（v3 耐久承诺先于投递尝试；persist 失败 =
    //    承诺未写入 → 拒收，条目已回滚）
    const entry = createEntry(msg, opts)
    if (!persistBeforeAccept(entry)) {
      return { kind: 'rejected', reason: 'persist-failed' }
    }

    // 5. 立即投（受理即出站，无忙闲门禁、无合批窗口——队列唯一化后合批归 port
    //    提交侧承载；在途防重 / deferred / retain 积累的队列多条由 doSend 成批）
    ensureSettledSub() // 确保 settled 订阅（retain 留守条目的边沿重投触发）
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

    // v3：checked 挂起条目缺省/显式 retain 按 forget 归一——同步失败回执契约
    // （waiter reject = 调用方已收到失败）与 retain 的边沿自动重投矛盾（重投成功会
    // 产生「失败但送达」的矛盾观测）；一次性 warn 留痕。显式 'failed' 放行不归一：
    // reject 是受理口径通知，failed 留守是条目状态，两者不矛盾（failed 不自动重投，
    // 「失败但送达」观测不存在；第 11 条文本投递全走 sendChecked，归一即堵死留守）。
    if (opts?.onFailure === 'retain') {
      if (!checkedRetainWarned) {
        checkedRetainWarned = true
        warn('sendChecked ignores onFailure=retain (checked entries default to forget)')
      }
      opts = { ...opts, onFailure: 'forget' }
    }

    // 入条目（诊断口径含在途；投递由下方统一循环接管）+ 受理前写入记录（v3；persist
    // 失败 = 承诺未写入 → 同步 throw，条目已回滚）
    const entry = createEntry(msg, opts)
    if (!persistBeforeAccept(entry)) {
      throw new Error(`store.persist failed before accept (id=${entry.id})`)
    }
    ensureSettledSub()

    // 统一投递循环（#3/#8）：resolve 挂钩本条目的 port.send 受理结果（D9⑤ 受理
    // 口径锁定；条目在 promise settle 前已终局 delivered 时由 confirmDelivered 的
    // resolveWaitersOf 提前了结——F1-11 handled 终局时序倒挂形态，见头注显式例外段）。
    // 受理即出站（busy 不拦——经 streaming 受理入 pi 队列即回，受理即可达性确认，
    // 探针 P1 rtt≈1ms）；不带走队列中其他条目（单独成批）。
    return new Promise<void>((resolve, reject) => {
      checkedPending.push({ entry, resolve, reject })
      if (!inFlight) {
        inflightBatch = [entry]
        inFlight = true
        attemptSend()
      }
      // inFlight：挂起等待，在途终态后 pump 优先直投本条目
    })
  }

  function flush(): void {
    if (disposed) return
    scheduleFlush()
  }

  function depth(): number {
    // 口径保持 v1：尚未被底层通道受理的消息数（待投队列 + 出站批次在途）。
    // 已受理的 in-flight 条目不计（所有权已移交 pi 槽位，等回执）；
    // 「在途未确认」全量经 entriesFull() 消费（D9②）。
    let n = 0
    for (const e of active) if (e.state === 'queued') n++
    return n
  }

  // ─── v2 所有权 API（D9②③）────────────────────────────────

  function entriesFull(): DeliveryEntriesFull {
    // 全量视图（对账/判重消费）：活跃条目完整字段 + 全部终局记录（本 handle 生命
    // 周期内；重启前的已完结 id 经 store.loadTerminalIds 进判重索引，不进本视图）
    return {
      active: active.map(snapshot),
      tombstones: [...terminalRecords.values()].map((t) => ({ ...t })),
    }
  }

  function projection(): DeliveryEntriesProjection {
    // 派生视图（D5③）：活跃全量 + delivered 最近 50 条完整条目（deliveredLog 环形
    // 留存上限即 DEFAULT_DELIVERED_WINDOW，派生视图恒用默认常量）；cancelled 不进派生视图
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
    if (!e) return false // 未知 id / 已终态（终局记录在册）：幂等 no-op
    // 接受 in-flight（正规送达路径）、queued（扩展①：rebuild 直确认 / 出站中
    // 回执先到的竞态——事实优先，delivered 事实 > cancel 意图，含已标记待收回条目）
    // 与 failed（第 11 条：受理失败的歧义性——首败时文本可能已进 transcript 未及
    // 回执；迟到的送达回执 / resync 的 transcript 预检命中即确定性送达事实，终结
    // failed 猜测，行随事实消失）
    if (e.state !== 'queued' && e.state !== 'in-flight' && e.state !== 'failed') return false
    finalizeEntry(e, 'delivered')
    // D9⑤：'delivered' 仅由送达回执（本调用）驱动回调；per-message 契约保持
    if (!disposed) callOnSettled(e.msg, 'delivered')
    return true
  }

  function confirmDeliveredByProof(id: string): boolean {
    if (disposed) {
      warn(`confirmDeliveredByProof ignored: delivery handle disposed (id=${id})`)
      return false
    }
    const e = activeIndex.get(id)
    // 幂等：未知 / 已终态 no-op；凭据档位分派——只有申报 'details-id' 的条目走
    // 凭据检查（marker 走回执命中、acceptance 受理即终态，各有判定通路，误确认
    // 在结构上不可达）
    if (!e || e.receiptAnchor !== 'details-id') return false
    if (e.state !== 'queued' && e.state !== 'in-flight') return false
    if (!cfg.proofCheck) {
      warn(`details-id entry has no proofCheck injected; delivery unconfirmed (id=${id})`)
      return false
    }
    let proven: boolean
    try {
      proven = cfg.proofCheck(id)
    } catch (err) {
      // 凭据检查异常降级：视为未送达 + warn 留痕（保守放行型；条目留守等
      // 下一次证据驱动调用，不破坏状态机）
      warn(`proofCheck threw; treating as not-delivered (id=${id})`, err)
      return false
    }
    if (!proven) return false
    return confirmDelivered(id)
  }

  function confirmAccepted(id: string): boolean {
    if (disposed) return false
    const e = activeIndex.get(id)
    if (!e || e.state !== 'queued') return false
    // 只接受当前出站批成员：受理事实锚定于在途投递——未出站的 queued 条目（在途
    // 防重挂起 / deferred / retain 留守）未触达底层通道，登记即虚报受理（条目会以
    // in-flight 挂起且无回执可等）
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
      e.updatedAt = now()
      e.settledAt = undefined
    }
    active.unshift(...found)
    notifyChange()
    // 回收重投：受理即出站下重排后立即投（对账器多在 settled 边沿后调用）
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
      const tb = terminalRecords.get(id)
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
   * 原位替换条目内容（chat-flow-consistency D6 edit 原语，见接口注释）：id 与排队位置均
   * 不变，只换 payload。queued 且在出站批内拒绝（文本可能已进底层通道）——in-flight 是
   * registry 收回路径的合法形态（clear_queue 收回后、requeue 前），不看出站批。
   */
  function edit(id: string, payload: DeliveryPayload): boolean {
    if (disposed) return false
    const e = activeIndex.get(id)
    if (!e) return false
    if (e.state !== 'queued' && e.state !== 'in-flight' && e.state !== 'failed') return false
    // queued 且已在出站批（受理登记窗口，扩展③）：文本可能已进底层通道，替换会双投——
    // 拒绝，调用方（registry 编排）按悬空窗口降级（回执 unconfirmed）
    if (e.state === 'queued' && inflightBatch.includes(e)) return false
    e.payload = payload
    // msg 与条目 payload 单一真值：onSettled per-message 契约的消费方（通知 record 等）
    // 拿到的必须是替换后内容
    e.msg.payload = payload
    e.updatedAt = now()
    notifyChange()
    return true
  }

  /**
   * 断连事件驱动的显式失败终局（failInFlight，ADR-0122）：in-flight 条目批量转
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
    const drained = active.slice()
    active.length = 0
    activeIndex.clear()
    inflightBatch = []
    inFlight = false
    const ts = now()
    const result = drained.map((e) => {
      // 全部记 cancelled 终局：drain 后该 id 不应再被 resync 重报复活（v3：判重
      // 索引 + 终局记录 + 持久终局——防复活凭据在持久终局记录里）
      terminalIndex.add(e.id)
      terminalRecords.set(e.id, { id: e.id, state: 'cancelled', lane: e.lane, settledAt: ts })
      ackStore(e.id)
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
   * （sendChecked 挂起除外——显式 reject 兜底）。依赖 onSettled 做清理/对账的调用方须
   * 自行在 dispose 路径补记账（scheduler 场景由 resume 重放兜底）。
   */
  function dispose(): void {
    disposed = true

    teardownSettledSub()

    // 丢弃条目集（含终局记录与判重索引——随 handle 释放，不跨 runtime 重启；重启
    // 后的判重锚 = store.loadTerminalIds 播种，D5② / v3 判重统一）
    active.length = 0
    activeIndex.clear()
    terminalIndex.clear()
    terminalRecords.clear()
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

  return { send, sendChecked, flush, depth, entriesFull, projection, onChange, confirmDelivered, confirmDeliveredByProof, confirmAccepted, requeue, cancel, edit, failInFlight, drain, dispose }
}

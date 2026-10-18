/**
 * @zhushanwen/session-delivery 类型定义。
 *
 * 设计约束：
 * - 零 pi 依赖：不出现 steer/followUp/triggerTurn/streamingBehavior 等 pi 词汇
 * - 意图驱动：调用方声明 intent，内核处理与 session 运行状态的冲突
 * - 判别联合 payload：适配器声明 supportedPayloads 能力
 *
 * v2 增量（投递所有权内核，v2 设计批次——设计文档未入 git，裁决随本仓 commit
 * 历史可溯）：
 * 条目状态机/lane/条目双形态（活跃条目 + 终局记录）/entriesFull()+projection() 双视图；行为实现在
 * 本包 src/delivery.ts。lane 字面量中的 'steer' 是投递车道语义名（设计 §1.1 术语表
 * /D1），非 pi API 词汇——intent → 底层参数的翻译在适配器内部，本包只记录车道，
 * 零依赖纪律对 lane 不破例。
 *
 * v3 增量（统一消息投递内核，设计 .tmp/tech-design/unified-delivery.md §3.5，波 1
 * 纯增量零行为变化——装配不传新参数 = v2 行为逐字节不变）：
 * - DeliveryStore 持久化存储端口（persist / ack / discard / loadUndelivered /
 *   loadTerminalIds / hasTerminal）：耐久承诺先于投递尝试；终局写持久终局；判重
 *   第三级查持久记录。两个实现在两半区适配层（runtime 半区磁盘 outbox / port 半区
 *   session entries），本包零 fs 零 pi 知识。
 * - 送达凭据三档（DeliveryReceiptAnchor）：'marker' / 'acceptance' / 'details-id'
 *   （ADR-0074 词条扩展）；details-id 的判定逻辑以可注入的凭据检查函数
 *   （DeliveryProofCheck）形态承载在本内核。
 * - 失败保留策略（DeliveryFailurePolicy）：'forget' 首败即停 / 'retain' 留账重投，
 *   缺省按载荷类型 custom=retain / text=forget。
 * - 判重统一：v2 的 DeliveryTombstone 独立机制与类型退役，判重 = 在途条目 → 内存
 *   已完结 id 索引（loadTerminalIds 播种 + 终局即时登记）→ 持久记录（store.hasTerminal）。
 *   entriesFull() 的 tombstones 视图字段与结构保持（双视图消费方零改动），元素类型
 *   由 DeliveryTerminalRecord 承载。
 * - 受理即出站模式（DeliveryDispatchMode）：'on-accept' 旁路忙闲门禁与合批窗口；
 *   缺省 'queue-hold' = v2 队列持有行为不变。
 */

// ─── 投递意图 ───────────────────────────────────────────────

/** 投递意图（D3）：turn 边界抢占 / run 结束后注入，均含 idle 唤醒语义。 */
export type DeliveryIntent = 'interrupt-at-turn-boundary' | 'after-run'

// ─── 消息 payload ───────────────────────────────────────────

/**
 * 文本 payload（runtime 通路一期唯一支持）。
 * images（D9④）：可选图片附件（base64 data + mimeType，形态对齐协议层
 * 'message.send'.images；底层通道支持图片附件的契约旁证 = 设计 F9）。内核不解析、
 * 随出站投递透传，底层 wire 格式组装归 runtime 适配层——本包零依赖纪律不变。
 */
export interface TextPayload {
  kind: 'text'
  content: string
  images?: Array<{ data: string; mimeType: string }>
}

/** custom message payload（extension 通路支持）。 */
export interface CustomPayload {
  kind: 'custom'
  customType: string
  content: string
  display: boolean
  details?: unknown
}

/** 判别联合（D9）：envelope / payload 分离。 */
export type DeliveryPayload = TextPayload | CustomPayload

// ─── 消息 envelope ──────────────────────────────────────────

/**
 * envelope additive meta（notify-once 设计 D2：notifyId 穿 envelope）。
 *
 * 内核对 meta 零读取零加工——只随消息对象本身流转；per-message 终态回调（onSettled，
 * 见下方契约）收到的是**该条原始消息**，meta 因此原样到达回调（合批亦然：回调逐条
 * 收各自原始消息，非 composed 合批消息）。消费方（runtime 债权桥接）在 delivered 回调
 * 读 `msg.meta.notifyId` 完成 armed→injected 受理回执锚定。
 */
export interface DeliveryMeta {
  /** 通知债权幂等键（notify-once）：delivered 回执据此锚定受理事实。 */
  notifyId?: string
  [key: string]: unknown
}

/** 投递消息 envelope。 */
export interface DeliveryMessage {
  payload: DeliveryPayload
  /** 缺省回落 config.intent。 */
  intent?: DeliveryIntent
  /** 去重 key（开 dedupe 时必填）。 */
  dedupeKey?: string
  /** 持久性预留（一期仅 'in-memory'）。 */
  durability?: 'in-memory'
  /** additive meta：不参与内核策略，per-message 原样透传 onSettled（见 DeliveryMeta）。 */
  meta?: DeliveryMeta
}

// ─── 端口（注入运行时能力） ──────────────────────────────────

/**
 * port.send 的受理回执（U2 回执口径扩展位）。
 *
 * 受理 = 底层通道接受了消息（进入投递路径），**不等于送达事实**——送达判定由
 * 调用方按自身回执锚点确认（如扩展侧扫描 custom_message entry）。旧 port 实现
 * 返回 void 不受影响（void = 受理未知，按成功处理，与既有内核语义一致）。
 */
export interface SendReceipt {
  /** 受理结果。false = 底层显式拒绝（消息未进入任何通道，走错误重试路径）。 */
  accepted: boolean
  /** 拒绝原因（accepted:false 时携带，进 warn 日志与 reject 链）。 */
  reason?: string
}

/** 内核与外部世界的唯一接口（D2 端口注入）。 */
export interface DeliveryPort {
  /** 本通路支持的 payload kind（D9 fail-fast）。 */
  supportedPayloads: readonly DeliveryPayload['kind'][]
  /** 主 agent 是否空闲。 */
  isIdle(): boolean
  /**
   * 投递消息（intent → pi 参数的翻译在适配器内部）。
   * 返回受理回执（U2 扩展位）：显式 `{accepted:false}` = 受理失败（内核按发送失败
   * 处理）；void / `{accepted:true}` = 受理成功。旧实现返回 void 兼容。
   *
   * settle 契约：返回 promise 时实现必须 settle（resolve 或 reject）——悬挂的
   * promise 会让内核 in-flight 防重永久占位、通路停摆。信任边界内不设防
   * （ADR-0122 范围纪律）：本机操作无响应 = 底层已挂，内核不建墙钟兜底，
   * 处置 = 用户显式失败 + 重启应用。
   */
  send(msg: DeliveryMessage, intent: DeliveryIntent): Promise<SendReceipt | void> | SendReceipt | void
  /** agent_settled 边沿订阅（D8）。缺省时 busy 条目留守至外部 flush/send 触发。返回退订函数。 */
  subscribeSettled?(cb: () => void): () => void
}

// ─── 配置 ───────────────────────────────────────────────────

/**
 * 送达凭据三档（v3，ADR-0074 词条扩展；提交方申报制，缺省 'marker'）：
 * - 'marker'：出站文本尾附裸标记、送达以回执命中为准（文本车道主通路）。
 * - 'acceptance'：受理即送达——无回执锚点条目的「受理 = 送达」是唯一可判事实，
 *   port.send 受理成功即落 delivered 终态（v1 记账口径 / D9⑤ 显式例外）。
 * - 'details-id'（v3 新增）：通知条目送达判定 = 对话记录中出现 details 携带本条目
 *   id 的通知条目（deliveryId 由注入端附加，业务字段保持原样）。判定逻辑不在内核
 *   ——内核以可注入的凭据检查函数（DeliveryProofCheck）承载函数位与调用点
 *   （handle.confirmDeliveredByProof），对话记录读取由装配方实现（零 pi 知识）。
 *   申报 'details-id' 的条目受理后维持 in-flight 等回执（与 'marker' 同形态），
 *   由装配方在回执证据到达时调 confirmDeliveredByProof 驱动终局。
 */
export type DeliveryReceiptAnchor = 'marker' | 'acceptance' | 'details-id'

/**
 * 失败保留策略（v3）：port.send 失败（首败，ADR-0122 无内核自动重试）时条目的处置。
 * - 'forget'：首败即停 + 显式上报后从内核移除（runtime 文本车道现状；重试决策归
 *   消费方——人看页面通知可重发）。store 已 persist 的记录同步 discard（失败条目
 *   无判重语义，防重启后被 loadUndelivered 复活成死条目）。
 * - 'retain'：失败条目留守——内存态转回 queued 等下一 settled 边沿 / 外部 flush
 *   重入队（事件驱动，无定时器）；store 记录保留（不 ack 不 discard），重启后经
 *   loadUndelivered 重入队（通知车道无人值守语义，与账本现状同构）。
 *
 * 缺省按载荷类型：custom = 'retain' / text = 'forget'（§3.4 提交选项缺省值表：
 * 交互在席 vs 无人值守），提交方可显式覆写。sendChecked 挂起条目恒 'forget'（同步
 * 失败回执契约与 retain 重投矛盾——调用方已收到失败，重投会产生「失败但送达」的
 * 矛盾观测；显式申报 retain 时按 forget 处置并一次性 warn）。
 */
export type DeliveryFailurePolicy = 'forget' | 'retain'

/**
 * 送达凭据检查函数（v3，'details-id' 凭据的判定承载形态）：判定「对话记录中是否已
 * 存在 details 携带该 id 的通知条目」。由装配方注入实现（实现读对话记录——pi 半区
 * 扫 session entries；内核零 pi 零 fs 知识，只持有函数位与调用点）。同步判定：
 * 装配方内部缓存扫描结果时恒 O(1)；未注入时 details-id 条目无法确认送达（留守）。
 */
export type DeliveryProofCheck = (id: string) => boolean

/**
 * DeliveryStore 的持久记录（persist 的写入单元 / loadUndelivered 的读取单元）：
 * 重建投递所需的最小信息快照。字段是内核条目的持久化派生数据——重启重入队时装配方经
 * loadUndelivered 取回后按原 id / lane / receiptAnchor 重新提交（幂等判重锚不丢）。
 */
export interface DeliveryStoreRecord {
  /** 客户端幂等 id（= 条目 id）。 */
  id: string
  /** 投递车道（重入队时按原车道重报）。 */
  lane: DeliveryLane
  /** 载荷（原样）。 */
  payload: DeliveryPayload
  /** 期望注入时机（persist 时按 msg.intent ?? config.intent 解析定型）。 */
  intent: DeliveryIntent
  /** 记录写入时间（epoch ms）。 */
  recordedAt: number
  /** 送达凭据申报（重入队时保真重报）。 */
  receiptAnchor?: DeliveryReceiptAnchor
  /** 无标记出站条目标志（重入队时保真重报，组批隔离判定源）。 */
  unmarked?: boolean
  /** additive meta（原样透传债权等消费方字段，重入队时保真重报）。 */
  meta?: DeliveryMeta
}

/**
 * 持久化存储端口（v3，统一语言词条「持久化存储端口」）：内核与耐久面的唯一接口。
 * 两个实现在两半区适配层（本包零 fs 零 pi 知识）：runtime 半区 = 磁盘 outbox 文件
 * （文本车道，波 4 接线）；port 半区 = session entry 读写（通知车道，波 2 接线）。
 *
 * 内核行为契约（设计 §3.5.1）：
 * - persist：send 受理前调用（耐久承诺先于投递尝试，与账本 record 先于 deliver 同
 *   律）。persist 抛错 = 承诺未落 → 内核拒收该条目（send 返回 persist-failed /
 *   sendChecked 同步 throw），不进入投递流程。
 * - ack：终局 delivered / cancelled 后调用（写持久终局——已撤销消息的防复活凭据
 *   同样在持久终局记录里）。ack 抛错不回滚状态机（终局事实已发生），warn 留痕。
 * - discard：forget 失败条目的记录无痕移除（无终局无判重语义——区别于 ack，不进
 *   终局记录，防重启后 loadUndelivered 把已弃条目当未投递复活）。
 * - loadUndelivered：供重启 / 重放时重入队（装配方启动时取回未终局记录重新提交）。
 * - loadTerminalIds：启动 / 重放时构建已完结 id 内存索引（判重第二级的播种源，
 *   对齐账本 ackedIds 播种语义）。
 * - hasTerminal：判重第三级「查持久记录」的按 id 查询（内存索引 miss 时的持久
 *   兜底——宁可误吞不误重投）。实现方自负缓存（如读盘一次建 Set）。
 *
 * 同步签名纪律：persist / ack / discard / hasTerminal 在内核热路径上，同步语义使
 * 「承诺先于尝试」构造性成立（调用返回 = 动作已落）；loadUndelivered / loadTerminalIds
 * 在启动 / 重放路径，装配方在装配内核前同步加载即可。异步介质由实现方内部缓冲，
 * 不进端口签名。
 */
export interface DeliveryStore {
  /** 受理前写入记录（耐久承诺先于投递尝试）。抛错 = 承诺未写入，内核拒收。 */
  persist(record: DeliveryStoreRecord): void
  /** 终局（delivered / cancelled）后写持久终局（从待投差集移除、进终局记录）。 */
  ack(id: string): void
  /** forget 失败条目的记录无痕移除（无终局形态，区别于 ack）。 */
  discard(id: string): void
  /** 未终局记录全量（重启 / 重放重入队的读取源）。 */
  loadUndelivered(): readonly DeliveryStoreRecord[]
  /** 已完结 id 全量（启动 / 重放时构建内存索引的播种源）。 */
  loadTerminalIds(): readonly string[]
  /** 持久终局按 id 查询（判重第三级）。 */
  hasTerminal(id: string): boolean
}

/** 内核配置（D4 策略默认值）。 */
export interface DeliveryConfig {
  /** 默认意图：'interrupt-at-turn-boundary'（D3）。 */
  intent?: DeliveryIntent
  /** 合批窗口（ms）：0 = 关；>0 = 滑动窗口合批。 */
  mergeWindowMs?: number
  /** 合批依赖谓词（D4 must-fix #1）。true 时 send() 走合批窗口，false/缺省时立即投。
   *  禁止用 isIdle 代替。 */
  mergeHoldActive?: () => boolean
  /** 去重配置（条数 LRU）。 */
  dedupe?: { maxKeys: number }
  /**
   * 投递终态信号（D4）。per-message 契约（ext-simplify-08 D1/B1）：批次内每条消息
   * 各获一次终态回调，msg 为该条原始消息（非合批 composed 消息）——additive meta
   * （notifyId 等）随原消息一并到达回调；单消息批次行为
   * 不变。回调循环边界：回调内 dispose() 后本批剩余条目不再回调（与 dispose「丢弃
   * 队列不触发 onSettled」契约一致）；回调内再 send() 的新消息走标准 flush 管线
   * （空闲时可能在回调栈内立即投递）、不参与本批回调循环（契约完备性登记：当前
   * 消费方两种形态均零可达）。
   *
   * [D9⑤ 口径升级——送达口径] outcome 'delivered' 升级为**送达口径** = 已拿到送达回执
   * （两阶段回执第二阶段：消息已写入 durable 存储；D2），而非仅 port.send 受理
   * （受理 ≠ 送达——SendReceipt 注释口径的机制化落地）。**显式例外：sendChecked 的
   * 同步 settle 维持受理口径不变**——session_manager send 的「立即受理确认」契约
   * 锚定在受理时点，后移到送达会让 agent 工具调用阻塞至目标 session 当前 turn 结束
   * （steer 类车道可达数十秒）。本注释即接口口径权威声明。
   *
   * outcome 'rejected' = 失败终局通知（ADR-0122 首败即停：send 失败一次即移除条目并
   * 逐条回调；断连事件 failInFlight 转 failed 终态同样逐条回调）。重试决策归消费方，
   * 内核不建自动重试。
   *
   * 异常契约：实现不应抛——回调异常由内核捕获并 warn 留痕，不影响条目状态机与
   * 其余条目的回调（回调异常 ≠ 投递失败，不进失败重试链）。
   */
  onSettled?: (msg: DeliveryMessage, outcome: 'delivered' | 'rejected') => void
  /**
   * 持久化存储端口（v3）。缺省 undefined = 无耐久面（v2 行为：纯内存条目集）——
   * 既有 runtime 装配不传 = 逐字节不变（波 1 零行为变化锚）。提供时内核行为契约见
   * DeliveryStore（受理前 persist / 终局 ack / forget 失败 discard / 构造期
   * loadTerminalIds 播种判重索引）。
   */
  store?: DeliveryStore
  /**
   * 送达凭据检查函数（v3）：'details-id' 凭据条目的送达判定承载（见 DeliveryProofCheck）。
   * 缺省 undefined = details-id 条目无法经 confirmDeliveredByProof 确认（留守 in-flight）。
   */
  proofCheck?: DeliveryProofCheck
  /**
   * 出站运行模式（v3，受理即出站 / 队列持有的模式参数；设计 §3.5.6）：
   * - 'queue-hold'（缺省）= v2 队列持有行为：busy gate（isIdle + 在途内查）排队 +
   *   settled 边沿驱动 flush + 合批窗口出站。
   * - 'on-accept' = 受理即出站：受理后立即 port.send（忙闲门禁旁路——承重前提 =
   *   底层唯一队列忙时不拒，适配层保证）；合批窗口不用（队列唯一化后无组批时机，
   *   合批归 port 提交侧承载），config.mergeWindowMs>0 与提交方 merge:true 被忽略；
   *   in-flight 防重保留（内核自身并发保护，非忙闲门禁）；retain 失败留守条目仍经
   *   settled 边沿 / 外部 flush 重投。
   * runtime 装配不传 = v2 队列持有行为不变（波 1 只实现不接线）。
   */
  dispatchMode?: 'queue-hold' | 'on-accept'
}

// ─── Handle ──────────────────────────────────────────────────

/** 投递句柄（createDelivery 返回）。 */
export interface DeliveryHandle {
  /** 唯一常规入口（D4 入口收敛）；合批窗口 + 空闲零延迟立即投。 */
  send(msg: DeliveryMessage, opts?: { merge?: boolean }): void
  /** 入队 + 可达性同步确认。reject = 入队失败。 */
  sendChecked(msg: DeliveryMessage): Promise<void>
  /** 强制投递尝试（shutdown flush / 外部重触发 / settled 边沿内部复用）。 */
  flush(): void
  /** 队列深度（诊断/测试）。 */
  depth(): number
  /** 销毁（清空队列 + 清 timer + 退订 settled）。 */
  dispose(): void
}

// ─── 条目状态机（D9①，内核 v2）────────────────────────────────

/**
 * 投递车道（D1）。lane 在条目创建时由 runtime 内核适配层判定（读权威 occupancy
 * 派生视图 + 内核自身队列态，单一判定源）后记录，此后不变。三档为投递车道语义名
 * （设计 §1.1 术语表），非底层通道 API 词汇。
 */
export type DeliveryLane = 'direct' | 'steer' | 'queued'

/**
 * 条目状态机五态（D9①）。迁移规则（§3.4 错误规格表 / D3 / D10）：
 * - queued → in-flight：出站投递被受理（两阶段回执第一阶段，D2）
 * - in-flight → delivered：送达回执到达（message_end 标记命中 / 适配器确认，D2）
 * - in-flight → queued：对账回收重投（滞留收回，D3；cancel 部分收回的其余条目同路径）
 * - in-flight/queued → cancelled：用户撤销（delivery.cancel）
 * - in-flight → failed：断连事件驱动的未确认终局（failInFlight，ADR-0122——pi 连接
 *   断开时结果未知，显式失败交用户处置）
 * - failed → queued：用户重试（resync 单条重报）；failed → cancelled：用户移除
 * 帧派生视图四态差异：cancelled 不进 session.delivery 帧（D5③），协议侧帧 state 无此值。
 */
export type DeliveryEntryState = 'queued' | 'in-flight' | 'delivered' | 'failed' | 'cancelled'

/**
 * 活跃条目（D5①）：queued/in-flight/failed 三态全量保留完整字段（failed 至用户
 * 处置：重试/移除）。id 即客户端幂等 id（协议层 clientUuid，出站裸标记按它构造，D2），
 * 是 resync 判重与 reattach 收养判重的锚（D5②）。
 */
export interface DeliveryEntry {
  /** 客户端幂等 id（= 协议层 clientUuid；裸标记身份源 D2，判重锚 D5②）。 */
  id: string
  state: DeliveryEntryState
  /** 投递车道（创建时判定后记录，不变，D1）。 */
  lane: DeliveryLane
  /** 载荷（一期仅 text，DeliveryPayload 联合保留扩展位）。 */
  payload: DeliveryPayload
  /** 入队时间（epoch ms）。 */
  createdAt: number
  /** 最近一次状态迁移时间（epoch ms）。 */
  updatedAt: number
  /** 终态落定时间（epoch ms；delivered/failed/cancelled 时有值，tombstone 提取源）。 */
  settledAt?: number
}

/**
 * 终局记录（v3）：delivered 与 cancelled 的轻量元数据——条目离开系统的事实的内存
 * 派生数据。v2 的 DeliveryTombstone 独立判重机制与类型随 v3 退役（它像独立机制只因没有
 * 持久存储）：判重统一为「在途条目 → 内存已完结 id 索引（store.loadTerminalIds 播种
 * + 终局即时登记）→ 持久记录（store.hasTerminal）」三级（设计 §3.5.5），终态唯一
 * 事实源 = 投递日志（DeliveryStore 终局记录）；本类型只承载条目视图面——
 * entriesFull().tombstones 视图字段与结构保持不变（双视图消费方零改动，波 1 零行为
 * 变化锚），cancel 的 already-final 结果同样由它承载。
 *
 * 语义边界（pi1-disposition-chat-flow D1②）：终局语义 = 「离开系统的事实」——
 * handled 条目（pi 接管输入等受理即终局形态）复用送达确认原语写入，终态固定为
 * delivered。state 联合仅两值不变。
 */
export interface DeliveryTerminalRecord {
  id: string
  /** 仅两终态（活跃态不产终局记录）。 */
  state: Extract<DeliveryEntryState, 'delivered' | 'cancelled'>
  lane: DeliveryLane
  /** 终态落定时间（epoch ms）。 */
  settledAt: number
}

// ─── 条目双视图（D9②）──────────────────────────────────

/**
 * 全量视图（D9②）：对账器与判重消费。活跃条目（完整字段）+ 全部终局记录。
 * 消费方：Reconciler 判别在途集（runtime registry 侧）、resync 判重、reattach 收养判定。
 * 访问入口 = handle.entriesFull()（MF-1-13 拆名：与派生视图分开命名，误用编译期可查）。
 *
 * tombstones 字段口径（v3）：本 handle 生命周期内终局条目的完整记录（含 restart 前
 * 条目的判重不依赖它——重启前的已完结 id 由 store.loadTerminalIds 播种进判重索引，
 * 判重正确性不依赖本视图的全量性）。字段名与结构保持 v2 形态（双视图消费方零改动）。
 */
export interface DeliveryEntriesFull {
  active: readonly DeliveryEntry[]
  tombstones: readonly DeliveryTerminalRecord[]
}

/**
 * 派生视图（D9②/D5③）：session.delivery 帧装配用。活跃条目（queued/in-flight/failed）
 * 全量 + delivered 最近 50 条完整条目；稳态体积有界 ≤ 50 + 活跃条目数。
 * 装配（帧 DTO 转换）归 runtime transport 侧（u3a），内核只产出本视图。
 * 访问入口 = handle.projection()；派生视图窗口恒为默认常量 50，无参数位（与全量视图
 * entriesFull() 拆名为两个具名方法——双视图误用编译期即红，不靠注释纪律维持）。
 */
export interface DeliveryEntriesProjection {
  entries: readonly DeliveryEntry[]
}

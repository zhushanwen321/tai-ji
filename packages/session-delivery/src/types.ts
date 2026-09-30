/**
 * @zhushanwen/session-delivery 类型定义。
 *
 * 设计约束：
 * - 零 pi 依赖：不出现 steer/followUp/triggerTurn/streamingBehavior 等 pi 词汇
 * - 意图驱动：调用方声明 intent，内核处理与 session 运行状态的冲突
 * - 判别联合 payload：适配器声明 supportedPayloads 能力
 *
 * v2 增量（投递所有权内核，设计 .tmp/tech-design/delivery-ownership-kernel.md）：
 * 条目状态机/lane/条目双形态（活跃条目 + tombstone）/entriesFull()+projection() 双视图；行为实现在
 * 本包 src/delivery.ts。lane 字面量中的 'steer' 是投递车道语义名（设计 §1.1 术语表
 * /D1），非 pi API 词汇——intent → 底层参数的翻译在适配器内部，本包只记录车道，
 * 零依赖纪律对 lane 不破例。
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
   * promise 会让内核 in-flight 防重永久占位。内核侧按控制面单请求粒度设有界兜底
   * （默认 60s，C-proc-19）：超时按发送失败收口（warn 留痕 + 走错误重试链）。
   * 已接受代价：迟到的原请求在超时强制失败后仍可能到达底层通道，与重试构成重复
   * 投递；通道内判重由适配器/对端按裸标记（clientUuid）负责，内核不建第二套判重。
   */
  send(msg: DeliveryMessage, intent: DeliveryIntent): Promise<SendReceipt | void> | SendReceipt | void
  /** agent_settled 边沿订阅（D8）。缺省时内核退化退避轮询。返回退订函数。 */
  subscribeSettled?(cb: () => void): () => void
}

// ─── 配置 ───────────────────────────────────────────────────

/** 内核配置（D4 策略默认值）。 */
export interface DeliveryConfig {
  /** 默认意图：'interrupt-at-turn-boundary'（D3）。 */
  intent?: DeliveryIntent
  /** 合批窗口（ms）：0 = 关；>0 = 滑动窗口合批。 */
  mergeWindowMs?: number
  /** 合批依赖谓词（D4 must-fix #1）。true 时 send() 走合批窗口，false/缺省时立即投。
   *  禁止用 isIdle 代替。 */
  mergeHoldActive?: () => boolean
  /** 退避参数。 */
  backoff?: { ms: number; max: number }
  /** watch-dog 复核间隔（ms）。默认 30_000。 */
  watchdogMs?: number
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
   * 异常契约：实现不应抛——回调异常由内核捕获并 warn 留痕，不影响条目状态机与
   * 其余条目的回调（回调异常 ≠ 投递失败，不进错误重试链）。
   */
  onSettled?: (msg: DeliveryMessage, outcome: 'delivered' | 'rejected') => void
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
 * 投影 + 内核自身队列态，单一判定源）后记录，此后不变。三档为投递车道语义名
 * （设计 §1.1 术语表），非底层通道 API 词汇。
 */
export type DeliveryLane = 'direct' | 'steer' | 'queued'

/**
 * 条目状态机五态（D9①）。迁移规则（§3.4 错误规格表 / D3 / D10）：
 * - queued → in-flight：出站投递被受理（两阶段回执第一阶段，D2）
 * - in-flight → delivered：送达回执到达（message_end 标记命中 / 适配器确认，D2）
 * - in-flight → queued：对账回收重投（滞留收回，D3；cancel 部分收回的其余条目同路径）
 * - in-flight/queued → cancelled：用户撤销（delivery.cancel）
 * - in-flight → failed：重试耗尽（sendAttempts 超 backoff.max，既有上限语义保留）
 * - failed → queued：用户重试（resync 单条重报）；failed → cancelled：用户移除
 * 帧投影四态差异：cancelled 不进 session.delivery 帧（D5③），协议侧帧 state 无此值。
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
  /** 已尝试投递次数（重试耗尽判定源：sendAttempts > backoff.max → failed，§3.4）。 */
  sendAttempts: number
  /** 终态落定时间（epoch ms；delivered/failed/cancelled 时有值，tombstone 提取源）。 */
  settledAt?: number
}

/**
 * 终态判重记录 tombstone（D5②）：delivered 与 cancelled 的轻量元数据。runtime
 * 存活期内全量保留、**不设数量窗口**——断连前积压长队列的 resync 重报判重锚不丢；
 * cancelled tombstone 防「cancel 确认帧断连窗口丢失 → 已撤销消息被 resync 复活」。
 * 栖身 runtime 进程内存、不跨 runtime 重启；reattach 场景（判重表已清空）判重锚
 * 回落 transcript 全量标记扫描（D5②/§3.4）。
 */
export interface DeliveryTombstone {
  id: string
  /** 仅两终态（活跃态不产 tombstone）。 */
  state: Extract<DeliveryEntryState, 'delivered' | 'cancelled'>
  lane: DeliveryLane
  /** 终态落定时间（epoch ms）。 */
  settledAt: number
}

// ─── 条目双视图（D9②）──────────────────────────────────

/**
 * 全量视图（D9②）：对账器与判重消费。活跃条目（完整字段）+ 全部 tombstone 元数据。
 * 消费方：Reconciler 判别在途集（runtime registry 侧）、resync 判重、reattach 收养判定。
 * 访问入口 = handle.entriesFull()（MF-1-13 拆名：与投影视图分开命名，误用编译期可查）。
 */
export interface DeliveryEntriesFull {
  active: readonly DeliveryEntry[]
  tombstones: readonly DeliveryTombstone[]
}

/**
 * 投影视图（D9②/D5③）：session.delivery 帧装配用。活跃条目（queued/in-flight/failed）
 * 全量 + delivered 最近 50 条完整条目；稳态体积有界 ≤ 50 + 活跃条目数。
 * 装配（帧 DTO 转换）归 runtime transport 侧（u3a），内核只产出本视图。
 * 访问入口 = handle.projection()；投影窗口恒为默认常量 50，无参数位（与全量视图
 * entriesFull() 拆名为两个具名方法——双视图误用编译期即红，不靠注释纪律维持）。
 */
export interface DeliveryEntriesProjection {
  entries: readonly DeliveryEntry[]
}

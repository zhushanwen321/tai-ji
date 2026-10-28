/**
 * gen-stats.ts — Composer 生成指标（token 速度 + 缓存命中率 + TTFT 首字延迟）类型 SSOT
 *
 * 帧/RPC 协议（D4）：新帧 session.stats_update + 新 RPC session.getGenStats，
 * 登记位置在 protocol.ts（type→payload 映射 SSOT），形状经此处类型引用防漂移。
 *
 * null 编码纪律（D4，与 protocol.ts context.update 条目的 [HISTORICAL] 无值编码纪律同源）：
 * 全帧无值一律 null，禁止 ?? 0 编码——null = 无数据（无样本 / 样本被 bogus guard 丢弃 /
 * provider 未上报 cache 字段），0 = 真实测量值（output 极小 × duration 极长经 round 可合法
 * 得出 0 t/s；冷启动全 miss 可合法得出 0%）。UI 侧 null → 「—」；0 → 显示 0。
 */

/**
 * 单窗口的样本分布（5 个统计量，单位随宿主指标：速度 t/s / TTFT ms）。
 *
 * 为什么五个一起给（而不是只给一个「代表值」）：延迟与吞吐都是**重尾分布**，任何单一聚合量
 * 都会撒谎——均值被偶发慢请求拉飞（TTFT 曾因均值口径被否决，见 composer-genstats-ttft §6 方案 D），
 * 中位数掩盖最差体感，极值看不出集中趋势。五个量一起展示，用户才能同时读到「典型值」
 * （p50）与「最差情况」（p99/max），而不必在口径之间二选一。
 *
 * 各量口径（SSOT = runtime gen-stats-store summarizeDistribution）：
 *  - avg：算术平均（逐样本等权；与「窗口总量加权」的吞吐口径**不同**——窗口总量口径
 *    回答「这窗口一共跑了多快」，逐样本均值回答「典型一次请求多快」，两者分母不同，
 *    前者见 {@link GenStatsCacheRatio} 与旧字段注释）；
 *  - p50 / p99：最近秩（nearest-rank）百分位——样本量小于 100 时 p99 必然落到最大样本，
 *    与 max 并列显示是**如实呈现**（不插值、不外推，小样本不假装有精细分位）；
 *  - max / min：窗口内极值。
 *
 * 字段 null = 无数据（窗口内无该指标样本）；0 = 真实测量值。五字段同生共死
 * （同一批样本算出的，要么全 null 要么全有值）。
 */
export interface GenStatsDistribution {
  avg: number | null
  p50: number | null
  p99: number | null
  max: number | null
  min: number | null
}

/** token 生成速度聚合（单位 t/s）。
 *  current = **本会话**最近一次合法请求样本速度（output ÷ durationMs × 1000，归属会话当前模型；
 *  本会话无该模型样本恒 null，不回落模型全局值）；
 *  day / d7 / d30 = 该模型跨会话累计窗口内**逐样本速度的分布**（每个样本先算
 *  output ÷ durationMs × 1000，再对速度值求 {@link GenStatsDistribution}）。
 *
 *  [HISTORICAL] day/d7/d30 原为「窗口总量加权平均」（Σtokens ÷ Σduration × 1000）：该口径
 *  回答的是「这段窗口持续输出时的瞬时吞吐」，样本间按耗时分摊权重——长请求主导结果，
 *  单个极慢短请求几乎不可见。改为逐样本分布后，p99/max 才能暴露「偶尔卡一次」的体感。
 *  两口径**不可互换**：旧加权值等于「按时长加权的均值」，与新 avg（等权均值）在样本耗时
 *  不均时必然不等，此为口径变更而非 bug。
 *  字段 null = 无数据；0 = 真实测量值。 */
export interface GenStatsSpeed {
  current: number | null
  day: GenStatsDistribution
  d7: GenStatsDistribution
  d30: GenStatsDistribution
}

/** prompt 缓存命中率聚合（单位 %）。
 *  current = 本会话最近一次合法请求命中率（round(cacheRead ÷ promptTotal × 100)，
 *  promptTotal = input + cacheRead + cacheWrite；本会话无该模型样本恒 null，不回落模型全局值）；
 *  day = 该模型跨会话当日加权（ΣcacheRead ÷ ΣpromptTotal）。
 *  字段 null = 无缓存数据（非 cache 模型常态：provider 未上报 cache 字段 / promptTotal=0 / 无样本）；
 *  0 = 真实测量值（如缓存全 miss）。 */
export interface GenStatsCacheRatio {
  current: number | null
  day: number | null
  /**
   * current 显示 0% 时的**归因**（缓存命中率归因降噪，2026-09-19）：已知成因的 0 不再以裸
   * 0% 呈现，UI 改为渲染成因文案（详见 GenStatsCacheMiss）。仅在 runtime 判定出「已知成因」时
   * 存在——无法归因的真实 miss（如服务端淘汰）缺省，UI 照常显示 0%（仍是唯一保留 0% 的形态）。
   * 与 current 同生命周期：current 为 null（无样本 / 槽 modelKey 不匹配）时恒缺省。
   */
  currentMiss?: GenStatsCacheMiss
}

/**
 * current 0% 的归因（缓存命中率归因降噪，2026-09-19，SSOT）。
 *
 * 三值均为「预期内的 miss，非故障」——UI 以中性色呈现成因文案，不再用 danger 色的 0%：
 *  - cold-start      ：本会话首条缓存样本（会话首个请求 / 新会话，缓存尚未建立）；
 *  - idle-expiry     ：距上一次请求的空闲超过 provider 缓存 TTL（runtime 侧 5min 阈值，
 *                      对齐 pi cache-stats CACHE_TTL_MS），缓存已过期；idleMs 携带实际空闲；
 *  - context-rewrite ：上一次请求之后发生过成功 compaction——上下文被重写，
 *                      本次请求的 prompt 前缀整体变化、缓存必然重建。
 *
 * 缺省（无 currentMiss）= 不是「展示 0% 且可归因」的样本：正常命中 / 未知成因的真实 miss。
 * 未知成因的 0%（如 provider 服务端淘汰）**不做降噪**——那正是需要被看到的信号。
 */
export interface GenStatsCacheMiss {
  reason: 'cold-start' | 'idle-expiry' | 'context-rewrite'
  /** idle-expiry：距上一次请求的空闲毫秒数（≥ TTL 阈值）；仅该 reason 下存在 */
  idleMs?: number
}

/** TTFT（Time-To-First-Token）首字延迟聚合（单位 ms，「请求发出 → 首个输出 token 到达」延迟，
 *  composer-genstats-ttft）。与速度互补：速度窗口口径刻意排除 provider 首包延迟段，本指标补齐该段。
 *  current = **本会话**最近一次请求样本 ttftMs 原值（归属会话当前模型；本会话无该模型样本恒
 *  null，不回落模型全局值，同 speed/cacheRatio 的 current 语义）；
 *  day / d7 / d30 = 该模型跨会话当日/近 7 天/近 30 天的**逐样本分布**（{@link GenStatsDistribution}，
 *  round 整数 ms）。
 *
 *  [HISTORICAL] day/d7/d30 原仅给 p50 单值（刻意不用均值：TTFT 重尾，偶发慢请求拉飞均值）。
 *  单给 p50 的副作用是「中位数看起来正常、实际每 100 次有 1 次卡到几秒」完全不可见——
 *  现改为五量分布，均值仍在（供对照）但不再是唯一读法，p99/max 补齐尾部体感。
 *  字段 null = 无数据（无样本 / ttft 未结算——错误 turn、runtime 中途启动丢锚、image 等无内容
 *  流输出形态）；0 = 真实测量值。 */
export interface GenStatsTtft {
  current: number | null
  day: GenStatsDistribution
  d7: GenStatsDistribution
  d30: GenStatsDistribution
}

/** session.stats_update 帧 payload / session.getGenStats reply payload（同形，§3.3 D4）。
 *  显示语义 = 混合视角：current 字段为该 session 私有（本会话最近一次请求样本——同模型多
 *  session 的 current 各自独立，非串台）；day/d7/d30 为该模型跨会话全局聚合（同模型多
 *  session 聚合值相同是预期行为）。
 *  speed / ttft 的窗口字段是分布对象（{@link GenStatsDistribution}），cacheRatio 的 window
 *  字段仍是单值（加权命中率语义本身即总量口径，不分位）。 */
export interface GenStatsFrame {
  sessionId: string
  /** 速度聚合（t/s） */
  speed: GenStatsSpeed
  /** 缓存命中率聚合（%） */
  cacheRatio: GenStatsCacheRatio
  /** TTFT 首字延迟聚合（ms，composer-genstats-ttft） */
  ttft: GenStatsTtft
  /** 最近样本模型 id（浮层标题用）。回填规则（R5/MF8）：modelKey 解析成功恒回填
   *  （含该模型无记录的全 null 帧）；仅 modelKey 未解析（降级链④走尽）时缺省。 */
  model?: string
}

/**
 * gen-stats.ts — Composer 生成指标（token 速度 + 缓存命中率）类型 SSOT
 *
 * 帧/RPC 协议（D4）：新帧 session.stats_update + 新 RPC session.getGenStats，
 * 登记位置在 protocol.ts（type→payload 映射 SSOT），形状经此处类型引用防漂移。
 *
 * null 编码纪律（D4，与 protocol.ts context.update 条目的 [HISTORICAL] 无值编码纪律同源）：
 * 全帧无值一律 null，禁止 ?? 0 编码——null = 无数据（无样本 / 样本被 bogus guard 丢弃 /
 * provider 未上报 cache 字段），0 = 真实测量值（output 极小 × duration 极长经 round 可合法
 * 得出 0 t/s；冷启动全 miss 可合法得出 0%）。UI 侧 null → 「—」；0 → 显示 0。
 */

/** token 生成速度聚合（单位 t/s）。
 *  current = **本会话**最近一次合法请求样本速度（output ÷ durationMs × 1000，归属会话当前模型；
 *  本会话无该模型样本恒 null，不回落模型全局值）；
 *  day / d7 / d30 = 该模型跨会话累计的加权平均（Σtokens ÷ Σduration × 1000，非算术平均）。
 *  字段 null = 无数据；0 = 真实测量值。 */
export interface GenStatsSpeed {
  current: number | null
  day: number | null
  d7: number | null
  d30: number | null
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

/** session.stats_update 帧 payload / session.getGenStats reply payload（同形，§3.3 D4）。
 *  显示语义 = 混合视角：current 字段为该 session 私有（本会话最近一次请求样本——同模型多
 *  session 的 current 各自独立，非串台）；day/d7/d30 为该模型跨会话全局聚合（同模型多
 *  session 聚合值相同是预期行为）。 */
export interface GenStatsFrame {
  sessionId: string
  /** 速度聚合（t/s） */
  speed: GenStatsSpeed
  /** 缓存命中率聚合（%） */
  cacheRatio: GenStatsCacheRatio
  /** 最近样本模型 id（浮层标题用）。回填规则（R5/MF8）：modelKey 解析成功恒回填
   *  （含该模型无记录的全 null 帧）；仅 modelKey 未解析（降级链④走尽）时缺省。 */
  model?: string
}

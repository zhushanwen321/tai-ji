/**
 * gen-stats.ts — Composer 生成指标（token 速度 + 缓存命中率）类型 SSOT
 *
 * 设计文档 docs/design/composer-gen-stats.md §3.4（接口与数据模型，本文件三接口的唯一权威）。
 * 帧/RPC 协议决策见同文档 §3.3 D4：新帧 session.stats_update + 新 RPC session.getGenStats，
 * 登记位置在 protocol.ts（type→payload 映射 SSOT），形状经此处类型引用防漂移。
 *
 * null 编码纪律（§3.3 D4，与 protocol.ts context.update 条目的 [HISTORICAL] 无值编码纪律同源）：
 * 全帧无值一律 null，禁止 ?? 0 编码——null = 无数据（无样本 / 样本被 bogus guard 丢弃 /
 * provider 未上报 cache 字段），0 = 真实测量值（output 极小 × duration 极长经 round 可合法
 * 得出 0 t/s；冷启动全 miss 可合法得出 0%）。UI 侧 null → 「—」；0 → 显示 0。
 */

/** token 生成速度聚合（单位 t/s）。
 *  current = 当前模型全局最近一次 turn 样本速度（output ÷ durationMs × 1000）；
 *  day / d7 / d30 = 按模型累计的加权平均（Σtokens ÷ Σduration × 1000，非算术平均）。
 *  字段 null = 无数据；0 = 真实测量值。 */
export interface GenStatsSpeed {
  current: number | null
  day: number | null
  d7: number | null
  d30: number | null
}

/** prompt 缓存命中率聚合（单位 %）。
 *  current = 最近一次 turn 命中率（round(cacheRead ÷ promptTotal × 100)，
 *  promptTotal = input + cacheRead + cacheWrite）；day = 当日加权（ΣcacheRead ÷ ΣpromptTotal）。
 *  字段 null = 无缓存数据（非 cache 模型常态：provider 未上报 cache 字段 / promptTotal=0 / 无样本）；
 *  0 = 真实测量值（如缓存全 miss）。 */
export interface GenStatsCacheRatio {
  current: number | null
  day: number | null
}

/** session.stats_update 帧 payload / session.getGenStats reply payload（同形，§3.3 D4）。
 *  显示语义 = 模型视角（该 session 当前模型的生成指标，非 session 私有样本——
 *  同模型多 session 分区值相同是预期行为）。 */
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

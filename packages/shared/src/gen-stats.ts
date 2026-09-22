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
}

/** TTFT（Time-To-First-Token）首字延迟聚合（单位 ms，「请求发出 → 首个输出 token 到达」延迟，
 *  composer-genstats-ttft）。与速度互补：速度窗口口径刻意排除 provider 首包延迟段，本指标补齐该段。
 *  current = **本会话**最近一次请求样本 ttftMs 原值（归属会话当前模型；本会话无该模型样本恒
 *  null，不回落模型全局值，同 speed/cacheRatio 的 current 语义）；
 *  day / d7 / d30 = 该模型跨会话当日/近 7 天/近 30 天的 p50 中位数（round 整数 ms）——刻意不用
 *  均值：TTFT 重尾，偶发慢请求拉飞均值，speed 的加权均值口径不适用于延迟。
 *  字段 null = 无数据（无样本 / ttft 未结算——错误 turn、runtime 中途启动丢锚、image 等无内容
 *  流输出形态）；0 = 真实测量值。 */
export interface GenStatsTtft {
  current: number | null
  day: number | null
  d7: number | null
  d30: number | null
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
  /** TTFT 首字延迟聚合（ms，composer-genstats-ttft） */
  ttft: GenStatsTtft
  /** 最近样本模型 id（浮层标题用）。回填规则（R5/MF8）：modelKey 解析成功恒回填
   *  （含该模型无记录的全 null 帧）；仅 modelKey 未解析（降级链④走尽）时缺省。 */
  model?: string
}

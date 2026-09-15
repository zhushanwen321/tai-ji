/**
 * 用量统计共享类型（W1 数据层）
 *
 * UsageStatsService（runtime）扫描 session JSONL 后产出 UsageRow[]，
 * 经 WS RPC `usage.getStats` 传给 renderer。
 */

/** 单条用量指标（Token 五分类 + 费用 + 消息计数）。 */
export interface UsageMetrics {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** pi cost.total 逐条累加（D2 透传不重算）。 */
  costUSD: number
  /** assistant 消息条数；compaction 桶 = 压缩/摘要事件数（D1）。 */
  messages: number
}

/** 用量行 = 指标 + 四维分组键（day × provider × model × project）。 */
export interface UsageRow extends UsageMetrics {
  /** 'YYYY-MM-DD' 本机时区（D6，禁止 UTC 切日）。 */
  date: string
  /**
   * 主桶 = 真实 provider id；compaction/summaries 归 'compaction' 虚拟桶（D1）——
   * 桶内 model 归属来源 = smart-context 生成侧权威落盘的 details.model
   * （`${provider}/${id}`，scanner ③ 读取，非 string/空串诚实回退 'compaction'；
   * 落盘透传可靠性锚 docs/pi-semantics.json PS-28）。
   * rename-session 为 taiji 自有 ④ 分类虚拟桶（rename-session custom entry 落账 →
   * scanner ④；落盘形态锚 PS-29，非 pi 三分类口径）。
   */
  provider: string
  /**
   * 主桶 = `responseModel ?? model`（D10，裸 id）；compaction 桶 = details.model
   * （`${provider}/${id}` 复合串）权威优先、缺失诚实回退 'compaction'；rename-session
   * 桶 = custom entry data.model（复合串）守卫回退 'rename-session'。归属组
   * （compaction/rename）的 model 为复合串属归属语境刻意——与主桶组裸 id 形态并存
   * 是预期，展示层用 provider/model 分量渲染（usage-page-fixes §3.3 ⑤）。
   */
  model: string
  /** session entry cwd 的 basename；无 cwd → '(unknown)'。 */
  project: string
}

/** getStats 返回体。 */
export interface UsageStatsResult {
  rows: UsageRow[]
  /** epoch ms，页面「数据截至」标注。 */
  scannedAt: number
  /** 参与聚合的 session 文件数。 */
  sessionCount: number
  /** 解析失败行数（分片求和，D9）。 */
  skippedLines: number
}

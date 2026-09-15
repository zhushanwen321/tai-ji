import type { Segment } from './segments'

/**
 * SegmentsMetadataFile —— user message 结构化 segments 的 sidecar 存储。
 *
 * 发送 user message 时，taiji 把完整 Segment[]（含 image path/displayName、
 * file path/lineRange 等 pi 边界会丢失的元信息）存到
 * `<dataDir>/attachments/<sessionId>/segments.json`。重开 session 时 runtime 读取此文件，
 * 回填到对应 user message——两条回填链：直发链按 clientUuid（与 pi JSONL 的
 * taiji.client-msg-id custom entry 映射）；defer flush 链按 deferEntryId（提交文本尾的
 * 裸 uuid 确认标记，entry-tree-builder 编排层从原始 entry 提取后直查）。
 *
 * 不进 pi JSONL——Segment[] 含磁盘 path、displayName 等 taiji 私有字段，pi 不该承载。
 * 与 pi JSONL 解耦，可独立演进、独立清理。
 */
export interface SegmentsMetadataFile {
  version: 1
  entries: SegmentsMetadataEntry[]
}

export interface SegmentsMetadataEntry {
  /**
   * 客户端 user message UUID（chat store appendUser 生成的 u-<uuid>），直发链主键。
   * [defer segments 化] 改可选：defer flush 提交的条目无 appendUser 乐观气泡（入流由
   * pending 气泡承担），没有 u-uuid——只写 deferEntryId。两条 key 空间互斥：
   * clientUuid = u-<uuid> 形态（msg-id-mapper 对 clientUuid 的形态约定），deferEntryId =
   * 裸 uuid（crypto.randomUUID）。写入方按链路二选一，禁止同条目双写。
   */
  clientUuid?: string
  /**
   * [defer segments 化 / D-A1-2] defer flush 条目主键（裸 uuid = 队列条目 id，
   * submitQueuedEntry 提交时写入）。不复用 clientUuid 字段——msg-id-mapper 已约定
   * clientUuid 为 u-<uuid> 形态，复用会让同一字段两套写入方语义漂移。
   */
  deferEntryId?: string
  /** 完整结构化 segments（含 image/file/skill/text 等段）。 */
  segments: Segment[]
  /** 发送时间戳（Date.now()，审计/兜底匹配用）。 */
  timestamp: number
}

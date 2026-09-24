/**
 * orphan-draft —— landing 首发失败的孤立草稿暂存槽（robustness ③b / 设计 D4）。
 *
 * 场景：landing 首发提交（sendLandingFirstMessage）失败时 catch 需把 segments 恢复回输入框，
 * 但目标 Composer 可能已随 Landing 卸载消亡（create 飞行 1.6-4.4s 中用户点侧栏切 session 等）——
 * restore 写不进任何活实例（inputRef.value=null → ?. 静默 no-op）= 用户输入丢失。此时把
 * segments 整体（text + 全类 chip 段，含 image needsMigrate 标志）暂存到本槽，下次 landing
 * composer 挂载时 takeOrphanedDraft 取回恢复（composer-shell onMounted 接线）。
 *
 * 形态裁决（设计 D4）：模块级一次性内存槽（core 域 KV 单例先例 = last-used-model）。
 * - 刻意不进 DraftStore（ADR-0049 窄化为 deleteDraft；全量扩展收益与本槽重复）
 * - 刻意不持久化（进程重启丢弃可接受——本槽是复合失败场景（用户中途离开 ∧ 创建失败）的
 *   兜底，不是草稿持久化通道）
 * - 落 core 而非 dom-core restore.ts：包依赖方向是 dom-core→core（core 零跨包 import），
 *   写侧 send.ts 在 core，槽必须与写侧同包
 */
import type { Segment } from '@taiji/shared'

let orphanedDraft: Segment[] | null = null

/** 暂存孤立草稿（覆盖式：后写覆盖先写——同一时刻至多一份 landing 在途失败草稿）。 */
export function stashOrphanedDraft(segments: Segment[]): void {
  orphanedDraft = segments
}

/** 取回并清槽（一次性语义：取回后二次 take 为 null）。 */
export function takeOrphanedDraft(): Segment[] | null {
  const segments = orphanedDraft
  orphanedDraft = null
  return segments
}

/** 测试隔离用（同 last-used-model __reset* 先例）：清槽回初始态。 */
export function __resetOrphanedDraftForTesting(): void {
  orphanedDraft = null
}

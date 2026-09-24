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
 *
 * [D 显性耦合] 本槽的正确性依赖 **Landing 单挂载点不变量**（Landing.vue [不变式] 注释 +
 * landing.test 静态断言锁死唯一挂载点 = Panel.vue landing 分支）：take 消费点唯一
 * （composer-shell onMounted，仅 landing 消费），单写单读才保证「一次性取回」幂等。
 * 若未来出现多 landing 挂载点，本槽会变成跨实例草稿串扰源——必须先重新设计（多实例
 * 键化不在预造范围，YAGNI：多实例拓扑出现再说）。
 */
import type { Segment } from '@taiji/shared'

let orphanedDraft: Segment[] | null = null

/**
 * 暂存孤立草稿（覆盖式：后写覆盖先写——同一时刻至多一份 landing 在途失败草稿）。
 * 覆盖**未消费**槽时 console.warn：上一份草稿从未被 takeOrphanedDraft 取回就被顶掉，
 * 是泄漏/交叉污染信号（失败→restore 后未重发即离开 / 双写路径下旧意图草稿残留）——
 * 留痕供排障，不阻断（后写优先是既定语义）。
 */
export function stashOrphanedDraft(segments: Segment[]): void {
  if (orphanedDraft !== null) {
    console.warn('[orphan-draft] overwriting unconsumed orphaned draft (leak/cross-contamination signal)')
  }
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

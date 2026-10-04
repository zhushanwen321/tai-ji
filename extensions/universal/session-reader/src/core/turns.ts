import type { Entry } from '@zhushanwen/session-core'

/**
 * 一轮对话（design §3.5 算法 3 的分段产物，冻结接口）。
 *
 * - user turn：由 user message 开启，userEntry 指向该 user entry，isCompaction=false。
 * - compaction turn：由 compaction entry 开启（语义断点），无 userEntry，isCompaction=true。
 * - 前置 turn（preface）：首条 user/compaction 之前出现的 rule-4 entry
 *  （assistant / model_change / thinking_level_change / custom / branch_summary）无处并入时
 *   单独成 turn 0，无 userEntry，isCompaction=false。
 *
 * 分段与折叠分工：本函数把全部非 header/compaction/user 条目归入 turn（纯记录条目
 * 也成 turn）；outline 是否渲染行由 render.ts isConversationEntry 二次裁决——纯记录
 * 条目（无 message 字段，含 branch_summary）的 turn 不产 outline 行。两处对条目形态
 * 的认知以 pi dist 实装为同一事实源（entry 全集十类，见 render.ts 注释枚举）。
 */
export interface Turn {
  index: number
  startTime?: string
  /** 该 turn 全部 entry（含开启条 user/compaction + 后续并入条） */
  entries: Entry[]
  /** turn 起点；compaction turn 与前置 turn 无 userEntry */
  userEntry?: Entry
  isCompaction: boolean
}

/**
 * 按 design §3.5 算法 3 把 leaf 视图 entry 序列分段为 turn。
 *
 * 严格按优先级（先命中先生效）：
 * 1. `session` header → 忽略，不计 turn
 * 2. `compaction` → 关闭当前 turn，开新 turn（isCompaction=true，无 userEntry）
 * 3. `message` role=user → 关闭当前 turn，开新 turn（userEntry=user）
 * 4. 其余（assistant/toolResult/custom/model_change/thinking_level_change/branch_summary
 *    等一切非上述类型）→ 并入当前 turn
 * 5. branch 边界：entry.id ∉ leafSet → 直接跳过（归旁支，不计 leaf 视图 turn）
 *
 * 孤儿处理：rule-4 entry 在首条 user/compaction 之前出现（无 current turn）→ 单独成「前置」turn。
 * index 从 0 连续递增。空 entries（或 leafSet 全空）→ 返回 []。
 */
export function segmentTurns(entries: Entry[], leafSet: Set<string>): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  const closeCurrent = (): void => {
    if (current !== null) {
      turns.push(current)
      current = null
    }
  }

  for (const entry of entries) {
    // 规则 1：session header 忽略
    if (entry.type === 'session') continue
    // 规则 5：branch 边界——不在 leaf 视图，跳过
    if (!leafSet.has(entry.id)) continue

    if (entry.type === 'compaction') {
      // 规则 2：compaction 是语义断点，关闭当前并开新 compaction turn
      closeCurrent()
      current = {
        index: 0,
        entries: [entry],
        isCompaction: true,
      }
      if (entry.timestamp !== undefined) current.startTime = entry.timestamp
    } else if (
      entry.type === 'message' &&
      entry.message !== undefined &&
      entry.message.role === 'user'
    ) {
      // 规则 3：user 开启新 turn
      closeCurrent()
      current = {
        index: 0,
        entries: [entry],
        userEntry: entry,
        isCompaction: false,
      }
      if (entry.timestamp !== undefined) current.startTime = entry.timestamp
    } else {
      // 规则 4：并入当前 turn；无 current（孤儿前置）则单独成 preface turn
      if (current === null) {
        current = {
          index: 0,
          entries: [entry],
          isCompaction: false,
        }
        if (entry.timestamp !== undefined) current.startTime = entry.timestamp
      } else {
        current.entries.push(entry)
      }
    }
  }
  closeCurrent()

  // index 从 0 连续递增（分段过程中先占位 0，最后统一赋值）
  for (let i = 0; i < turns.length; i++) {
    turns[i].index = i
  }
  return turns
}

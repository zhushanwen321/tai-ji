/**
 * 过滤（A23，design §3.1 样例 3 + D8）：「仅当前 context」toggle + kind chips 分组。
 *
 * kind chips → 行 kind 映射 SSOT（§3.4 末段）：消息 = USER/ASSISTANT；工具 = TOOL/BASH；
 * 系统 = SYSTEM/NOTICE/COMPACTED/BRANCH；生命周期 = LIFECYCLE；边界 = SESSION/DATA/BOUNDARY。
 * MALFORMED 不属任何组（12 kind 之外的占位行）：chips 激活即隐藏（白名单语义），
 * 全部态（无 chips）可见——损坏行不静默丢失（§3.1 失败路径），但过滤是用户显式选择。
 */
import type { TraceRowKind } from './types'
import type { TraceRow } from './trace-rows'

/** kind chips 分组 key（§3.1 chip 标签的消息/工具/系统/生命周期/边界）。 */
export type TraceKindGroup = 'messages' | 'tools' | 'system' | 'lifecycle' | 'boundaries'

/** kind chips → 行 kind 映射 SSOT（UI chips 与 core 过滤共用，禁散落第二份）。 */
export const TRACE_KIND_GROUPS: Readonly<Record<TraceKindGroup, readonly TraceRowKind[]>> = {
  messages: ['USER', 'ASSISTANT'],
  tools: ['TOOL', 'BASH'],
  system: ['SYSTEM', 'NOTICE', 'COMPACTED', 'BRANCH'],
  lifecycle: ['LIFECYCLE'],
  boundaries: ['SESSION', 'DATA', 'BOUNDARY'],
}

/** 过滤态（D8 的子集：context toggle + kind chips；文本搜索归 UI 层）。 */
export interface TraceFilterState {
  /** 「仅当前 context」toggle：true = 隐藏影子化与不进 context 的行。 */
  contextOnly: boolean
  /** 激活的 chips 分组；空数组 = 不按 kind 过滤（全部态）。 */
  activeGroups: readonly TraceKindGroup[]
}

const DEFAULT_STATE: TraceFilterState = { contextOnly: false, activeGroups: [] }

/** 应用过滤态；不改输入数组（纯函数）。 */
export function filterTraceRows(
  rows: readonly TraceRow[],
  state: Partial<TraceFilterState> = {},
): TraceRow[] {
  const { contextOnly, activeGroups } = { ...DEFAULT_STATE, ...state }

  const kindAllowed: ReadonlySet<TraceRowKind> | null =
    activeGroups.length > 0
      ? new Set(activeGroups.flatMap((g) => TRACE_KIND_GROUPS[g] ?? []))
      : null

  return rows.filter((row) => {
    if (contextOnly && !row.inContext) return false
    if (kindAllowed !== null && !kindAllowed.has(row.kind)) return false
    return true
  })
}

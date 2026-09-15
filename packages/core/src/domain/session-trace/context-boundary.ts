/**
 * context 边界计算 + 影子化标记（A22 / 探针 P4）。
 *
 * 复刻 pi `buildContextEntries` + `buildSessionPath` + `sessionEntryToContextMessages`
 * 三个纯函数的语义（pi 0.84.1 源码 core/session-manager.ts:334/383/418，只读不改）。
 * 一致性由测试用同一 JSONL 双边核算（import pi dist 的真实现做对照）把关。
 *
 * 语义要点（design §1.1/§2.2-3）：
 * - 「当前 context」= buildContextEntries 输出中经 sessionEntryToContextMessages 转换
 *   非空的 entry：沿 leaf 路径取最后一条 compaction，context = [该 compaction 自身] +
 *   路径中 firstKeptEntryId（含）至 compaction 前的 entries + compaction 后全部；
 *   多次压缩只有最后一次生效。
 * - lifecycle（model_change/thinking_level_change/label/session_info/custom/session）
 *   天然不进 context（转换结果为 0 条消息）——即使在保留区也不进。
 * - 「影子化」= entry 在 leaf 路径上、类型可进 context（message/custom_message/
 *   branch_summary/compaction），但已被 compaction 排除在当前 context 外。
 *   不可进类型不影子化（它们本来就不进——design §3.4 注）。
 */
import type { TraceSessionEntry } from './types'

/** 复刻 pi sessionEntryToContextMessages 的「转换非空」判定（转换消息体本身不属本模块职责）。 */
export function convertsToContextMessages(entry: TraceSessionEntry): boolean {
  switch (entry.type) {
    case 'message':
      // message 无条件非空（content 为 null 的 user/assistant/toolResult 也返回修正后的 1 条）
      return true
    case 'custom_message':
      return true
    case 'branch_summary':
      // pi：`entry.type === "branch_summary" && entry.summary` —— 空 summary 转换为 0 条
      return Boolean((entry as { summary?: string }).summary)
    case 'compaction':
      return true
    default:
      return false
  }
}

/** context 边界计算结果。 */
export interface TraceContextBoundary {
  /** leaf 路径（root→leaf 顺序；复刻 buildSessionPath，不含 header——调用方须按 getEntries 语义传入）。 */
  path: TraceSessionEntry[]
  /** 当前 context 成员 entry id 集（buildContextEntries 输出 ∩ 转换非空）。 */
  contextEntryIds: Set<string>
  /** 影子化 entry id 集：在 path 上、可进类型、但不在当前 context。 */
  shadowedEntryIds: Set<string>
  /** 决定当前边界的最后一次 compaction（无压缩为 null）。 */
  lastCompaction: {
    id: string
    firstKeptEntryId: string
    /** 该 compaction 在 path 中的下标（边界标注定位用）。 */
    indexInPath: number
  } | null
}

/** 复刻 pi buildSessionPath（leafId 传 null → 空 path；undefined → 尾 entry fallback；miss → 尾 fallback）。 */
export function buildTraceSessionPath(
  entries: TraceSessionEntry[],
  leafId?: string | null,
): TraceSessionEntry[] {
  if (leafId === null) return []

  const index = new Map<string, TraceSessionEntry>()
  for (const entry of entries) {
    // 无 id entry 不可被引用（与 pi 的 undefined-key 条目不可达性等价），跳过注册
    if (entry.id !== undefined) index.set(entry.id, entry)
  }

  let leaf: TraceSessionEntry | undefined
  if (typeof leafId === 'string' && leafId) {
    leaf = index.get(leafId)
  }
  leaf ??= entries[entries.length - 1]
  if (!leaf) return []

  const path: TraceSessionEntry[] = []
  let current: TraceSessionEntry | undefined = leaf
  while (current !== undefined) {
    path.push(current)
    // pi：`current.parentId ? index.get(current.parentId) : undefined` —— falsy parentId（含缺失）终止回溯
    const parentId: string | null | undefined = current.parentId
    current = parentId ? index.get(parentId) : undefined
  }
  path.reverse()
  return path
}

/**
 * 计算 context 边界 + 影子化标记。
 *
 * @param entries 排除 header 的全部 entry（pi getEntries 语义；文件行序）
 * @param leafId leaf entry id（活跃 session 路径 A 由 RPC leafId 提供）；undefined = 尾部 fallback；null = 显式空路径
 */
export function computeTraceContextBoundary(
  entries: TraceSessionEntry[],
  leafId?: string | null,
): TraceContextBoundary {
  const path = buildTraceSessionPath(entries, leafId)

  // 复刻 buildContextEntries：找 path 上最后一条 compaction（顺序遍历后者覆盖前者）
  let lastCompaction: TraceSessionEntry | undefined
  let compactionIdx = -1
  for (let i = 0; i < path.length; i++) {
    if (path[i].type === 'compaction') {
      lastCompaction = path[i]
      compactionIdx = i
    }
  }

  if (lastCompaction === undefined || compactionIdx < 0) {
    // 无压缩：整个 path 即 context 候选
    return boundaryWithoutCompaction(path)
  }
  return boundaryWithCompaction(path, lastCompaction, compactionIdx)
}

/** 收集「有 id 且转换非空」的 entry → context 成员 id 集（无压缩/有压缩两径共用）。 */
function collectContextEntryIds(entries: TraceSessionEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.id !== undefined && convertsToContextMessages(entry)) ids.add(entry.id)
  }
  return ids
}

/** 影子化 = path 上可进类型但不在 context（含被二次压缩的旧 compaction / 旧保留头）。 */
function collectShadowedEntryIds(path: TraceSessionEntry[], contextIds: Set<string>): Set<string> {
  const shadowedIds = new Set<string>()
  for (const entry of path) {
    if (entry.id !== undefined && convertsToContextMessages(entry) && !contextIds.has(entry.id)) {
      shadowedIds.add(entry.id)
    }
  }
  return shadowedIds
}

/** 无压缩分径：整个 path 即 context 候选，无影子化。 */
function boundaryWithoutCompaction(path: TraceSessionEntry[]): TraceContextBoundary {
  return {
    path,
    contextEntryIds: collectContextEntryIds(path),
    shadowedEntryIds: new Set<string>(),
    lastCompaction: null,
  }
}

/**
 * 有压缩分径（单次/多次同径：多次压缩只有最后一次生效，故不按次数拆）。
 *
 * context = [compaction] + 保留区（firstKeptEntryId 含 → compaction 前）+ compaction 后全部。
 */
function boundaryWithCompaction(
  path: TraceSessionEntry[],
  lastCompaction: TraceSessionEntry,
  compactionIdx: number,
): TraceContextBoundary {
  const firstKeptEntryId = String(
    (lastCompaction as { firstKeptEntryId?: unknown }).firstKeptEntryId ?? '',
  )
  const candidates: TraceSessionEntry[] = [lastCompaction]
  let foundFirstKept = false
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i]
    if (entry.id !== undefined && entry.id === firstKeptEntryId) foundFirstKept = true
    if (foundFirstKept) candidates.push(entry)
  }
  candidates.push(...path.slice(compactionIdx + 1))

  // 影子化判定依赖 context 集合先算完（保留区/压缩后进 context，其余可进类型影子化）
  const contextIds = collectContextEntryIds(candidates)
  return {
    path,
    contextEntryIds: contextIds,
    shadowedEntryIds: collectShadowedEntryIds(path, contextIds),
    lastCompaction:
      lastCompaction.id !== undefined
        ? { id: lastCompaction.id, firstKeptEntryId, indexInPath: compactionIdx }
        : null,
  }
}

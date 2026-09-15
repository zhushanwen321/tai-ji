/**
 * streaming trace 窗口切片纯逻辑（chat 域 SSOT）。
 *
 * 数据模型：一个 turn 内可能有多条 assistant 消息（subagent 接力 / 多轮补写），
 * 每条 assistant 内部又含 thinking / toolCall / text 有序块（见 message-turns.expandAssistantBlocks）。
 * 渲染 trace 时需要把「跨 assistant 的所有块」拍平成一维时序，再按窗口策略决定哪些可见、
 * 哪些收编（compacted）、哪些是失败块（failed）独立计数。
 *
 * 三个输出语义（TraceWindowResult）：
 * - visible：按 flatIndex 升序的可见块（takeover=false 时由三类互斥块合并；takeover=true 时全量）
 * - compactedCount：被收编的「已完成过程块」数量（非 error、非进行中、非 text 的已定型块，
 *   超出窗口宽度 W 的靠前部分被折叠）。failed 块不计入此计数（见 failedCount）
 * - failedCount：被收编的 status==='error' 的 tool/agentgraph 块数量（失败重试独立计数，
 *   不污染 compactedCount）
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w6 chat 域绞杀模式（core SSOT）。
 * ui 包经 @taiji/core/domain/chat 子路径 import。
 */
import type { Message, ToolCall } from '@taiji/shared'
import { expandAssistantBlocks, type OrderedBlock } from './message-turns'

/**
 * 拍平后的渲染块单元。
 * - assistantId：所属 assistant 的 Message.id
 * - assistantStatus：所属 assistant 的 Message.status（MessageStatus，'streaming'|'complete'|'error'）
 * - block：原始有序块（复用 OrderedBlock，kind:'thinking'|'tool'|'text'|'agentgraph'）
 * - flatIndex：全 turn 内一维时序下标（从 0 全局递增，跨 assistant 连续）
 */
export interface FlatBlock {
  assistantId: string
  assistantStatus: Message['status']
  block: OrderedBlock
  flatIndex: number
}

/**
 * 窗口切片结果。
 * - visible：按 flatIndex 升序的可见块
 * - compactedCount：被收编的非 error 已定型过程块数（已完成过程块总数 − visible 内该类数）
 * - failedCount：被收编的 status==='error' 的 tool/agentgraph 块数（不在 visible 内的失败块）
 */
export interface TraceWindowResult {
  visible: FlatBlock[]
  compactedCount: number
  failedCount: number
}

/** 窗口宽度（已完成过程块保留条数）。导出供 window wave 使用。 */
export const W = 6

/**
 * 把多条 assistant Message 的内部块按 contentBlocks 真实时序解出后拍平为一维。
 *
 * 按 assistants 数组顺序遍历，对每个 assistant 调 expandAssistantBlocks(msg)（from './message-turns'），
 * 把返回的 OrderedBlock[] 拼接，每个 block 包装成 FlatBlock，flatIndex 从 0 全局递增（跨 assistant 连续）。
 * 空数组 → 返回 []。纯函数无副作用（不修改入参）。
 */
export function flattenTurnBlocks(assistants: Message[]): FlatBlock[] {
  const result: FlatBlock[] = []
  let flatIndex = 0
  for (const msg of assistants) {
    for (const block of expandAssistantBlocks(msg)) {
      result.push({
        assistantId: msg.id,
        assistantStatus: msg.status,
        block,
        flatIndex,
      })
      flatIndex += 1
    }
  }
  return result
}

/**
 * tool/agentgraph 块是否为失败块（status==='error'）。
 *
 * 注意拼写陷阱：ToolCall 完成态是 'completed'（过去式），Message 完成态是 'complete'（无 d），
 * 两者不一致；failed 判定统一用 ToolCall 的 status==='error'（非 'failed'，ToolCallStatus 无 'failed'）。
 * 铁证：message-turns.ts hasFailedTool 用 t.status === 'error'；shared/message.ts error 字段注释
 * 「与 status:'error' 同源」。
 */
function isFailedProcessBlock(block: OrderedBlock): boolean {
  return (
    (block.kind === 'tool' || block.kind === 'agentgraph') &&
    (block.ref as ToolCall).status === 'error'
  )
}

/**
 * 按窗口策略切片拍平后的块。
 *
 * takeover=true → visible=全部 blocks（按 flatIndex 升序），compactedCount=0，failedCount=0。
 * takeover=false → visible 收集三类互斥块后合并按 flatIndex 升序：
 *   ① 每个 assistant 的末位 text：按 assistantId 分组，各保留 flatIndex 最大的 text 块。多 assistant
 *      turn（ask-user 续写/compact 续写/subagent 接力）下每个 assistant 的最终回复默认可见；单 assistant
 *      内的过渡碎片只留末位（design §3.3 D2「只留最后一条」针对单 assistant 过渡碎片，不套用到多 assistant）
 *   ② 进行中块：对每个 assistantStatus==='streaming' 的 assistant（按 assistantId 分组），取其拍平块中
 *      最后一个 kind ∈ {thinking,tool,agentgraph} 的块（flatIndex 最大者）
 *   ③ 已完成过程块（压缩候选）：所有满足 kind!=='text' 且不在②集合内 且（kind==='thinking' 或
 *      tool/agentgraph 且 status!=='error'）的块；从这池子按 flatIndex 降序取前 windowSize 个
 *   三类按 flatIndex 标识去重后合并，最终按 flatIndex 升序输出。
 * compactedCount = ③候选池总数 − visible 内属于③的数量。
 * failedCount = 所有 tool/agentgraph 且 status==='error' 的块中不在 visible 内的数量。
 *   （若某 error tool 恰好是 streaming assistant 末尾块被②收入 visible，按「不在 visible 内」判定
 *   自然不计入 failedCount，无需特判。）
 * 空 blocks → { visible: [], compactedCount: 0, failedCount: 0 }。纯函数无副作用。
 */
/** ① 全 turn 末位 text（flatIndex 最大的 text 块，单个）——不按 assistant 分组。
 *  [2026-08-14 修正] 原「按 assistantId 分组各保留末位 text」针对多 assistant turn（ask-user/compact
 *  续写），但 pi tool 循环协议下每 message_start 新 assistant Message，单 agent 一个 turn 跑几十次
 *  循环产生几十个 assistant，按 assistant 分组会每 assistant 末位 text 都保留致 visible 爆炸（实测
 *  61 assistant → ①=12 text）。改为全 turn 最后 text：流式正文始终可见，历史 text 进③候选池可被窗口收编。
 *  多 assistant 续写场景的非末位回复经 takeover「展开全部」或历史 turn 查看。 */
function findLastText(blocks: FlatBlock[]): FlatBlock | undefined {
  let lastText: FlatBlock | undefined
  for (const fb of blocks) {
    if (fb.block.kind === 'text' && (!lastText || fb.flatIndex > lastText.flatIndex)) {
      lastText = fb
    }
  }
  return lastText
}

/** ② 进行中块：只保留全 turn 最后一个 streaming 块（flatIndex 最大的 streaming 非 text，单个）。
 *  [2026-08-14 修正] 原按 streaming assistant 分组每 assistant 各一个，但 pi tool 循环历史 assistant
 *  未正确 complete（上游 bug）致多 streaming assistant，②爆炸（实测 61 streaming → ②=61）。
 *  改为单个最后 streaming 块：只展示「当前正在进行的最新动作」。 */
function findLastInProgress(blocks: FlatBlock[]): FlatBlock | undefined {
  let lastInProgress: FlatBlock | undefined
  for (const fb of blocks) {
    if (
      fb.assistantStatus === 'streaming' &&
      fb.block.kind !== 'text' &&
      (!lastInProgress || fb.flatIndex > lastInProgress.flatIndex)
    ) {
      lastInProgress = fb
    }
  }
  return lastInProgress
}

/** ③ 已完成过程块（压缩候选）：kind!=='text' 且不在②内 且（thinking 或 tool/agentgraph 非 error）。 */
function collectCompletedProcessPool(blocks: FlatBlock[], inProgressSet: Set<number>): FlatBlock[] {
  const completedProcessPool: FlatBlock[] = []
  for (const fb of blocks) {
    if (fb.block.kind === 'text') continue
    if (inProgressSet.has(fb.flatIndex)) continue
    if (fb.block.kind === 'thinking' || !isFailedProcessBlock(fb.block)) {
      completedProcessPool.push(fb)
    }
  }
  return completedProcessPool
}

/** 合并①②③三类（按 flatIndex 去重），按 flatIndex 升序输出；mergedIds = 去重后的
 *  flatIndex 全集（compactedCount 的「属于 visible」判定用，与原 merged Map.has 同语义）。 */
function mergeVisibleBlocks(
  lastText: FlatBlock | undefined,
  lastInProgress: FlatBlock | undefined,
  windowed: FlatBlock[],
): { visible: FlatBlock[]; mergedIds: Set<number> } {
  const merged = new Map<number, FlatBlock>()
  if (lastText) merged.set(lastText.flatIndex, lastText)
  if (lastInProgress) merged.set(lastInProgress.flatIndex, lastInProgress)
  for (const fb of windowed) merged.set(fb.flatIndex, fb)
  const visible = [...merged.values()].sort((a, b) => a.flatIndex - b.flatIndex)
  return { visible, mergedIds: new Set(merged.keys()) }
}

/** failedCount = 所有 error tool/agentgraph 块中不在 visible 内的数量。 */
function countFailedOutsideVisible(blocks: FlatBlock[], visibleSet: Set<number>): number {
  let failedCount = 0
  for (const fb of blocks) {
    if (isFailedProcessBlock(fb.block) && !visibleSet.has(fb.flatIndex)) {
      failedCount += 1
    }
  }
  return failedCount
}

export function computeTraceWindow(
  blocks: FlatBlock[],
  opts: { windowSize: number; takeover: boolean },
): TraceWindowResult {
  if (blocks.length === 0) {
    return { visible: [], compactedCount: 0, failedCount: 0 }
  }

  // takeover=true：全量展开，计数归零（收编区为空）。
  if (opts.takeover) {
    return { visible: [...blocks], compactedCount: 0, failedCount: 0 }
  }

  const lastText = findLastText(blocks)
  const lastInProgress = findLastInProgress(blocks)
  const inProgressSet = new Set<number>(lastInProgress ? [lastInProgress.flatIndex] : [])
  const completedProcessPool = collectCompletedProcessPool(blocks, inProgressSet)

  // 按 flatIndex 降序取前 windowSize 个作为 visible 的③部分。
  const windowed = [...completedProcessPool]
    .sort((a, b) => b.flatIndex - a.flatIndex)
    .slice(0, opts.windowSize)

  const { visible, mergedIds } = mergeVisibleBlocks(lastText, lastInProgress, windowed)

  // compactedCount = ③候选池总数 − visible 内属于③的数量。
  const visibleInWindowed = windowed.filter((fb) => mergedIds.has(fb.flatIndex)).length
  const compactedCount = completedProcessPool.length - visibleInWindowed

  const failedCount = countFailedOutsideVisible(blocks, new Set(visible.map((fb) => fb.flatIndex)))

  return { visible, compactedCount, failedCount }
}

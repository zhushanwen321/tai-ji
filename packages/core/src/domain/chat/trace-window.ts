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
 *
 * 另含 groupConsecutiveBash（ui-signal-density §3.3 D1 增量）：连续 bash 折叠为组块的
 * 下游纯变换，接线点在 Turn.vue visibleBlocks 三分支汇合之后；不修改上方三函数的输入输出契约。
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

/** 窗口宽度（已完成过程块保留条数）。导出供 window wave 使用。
 *
 * 本常量无 ADR 依据（未登记进 docs/adr/）。ui-signal-density 第一批（候选 E）把它从 6 收窄到 4：
 * 收窄理由 = 工作回合（路径 B）首屏过程行从 ≤7 压到 ≤5（运行中口径，含 running 独立行），
 * 省 2 行——本设计全部改动里收益 / 成本比最高的一项（一个常量，窗口语义不变）。
 * 已接受代价 = 更多的已完成过程块并入 TraceCompactorRow 计数摘要（被收编块默认只剩计数，
 * 要看行内容须 takeover / 手动展开——恢复路径为既有机制）。
 * 重审触发条件 = 用户反馈「过程行不够看 / 要反复展开计数摘要才够用」，
 * 或 trace-window.test.ts 的收编断言需再次放宽。 */
export const W = 4

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

/**
 * bash 组块（ui-signal-density §3.3 D1 组块数据契约）：`groupConsecutiveBash` 输出的新序列单元，
 * 不是 FlatBlock（组块没有单一 flatIndex）。组身份 = 成员集合本身，成员增减是组内容变化。
 */
export interface BashGroupBlock {
  kind: 'bash-group'
  /** 组成员（连续 bash 的可见块，按 flatIndex 升序；组资格只看工具类型，running 也入组） */
  members: FlatBlock[]
  /** 组头聚合（三条计数口径，D1）：值在纯函数侧一次算好，渲染层零解析 */
  header: {
    /** ×N = 成员数（含 running） */
    count: number
    /** 共 Xs = 已完成成员耗时合计（endTime − startTime 之和；endTime 缺失的成员按 0 计；running 成员不计入——其 endTime 必缺失，天然按 0） */
    durationMs: number
    /** · 含 M 次失败 = 成员中 status==='error' 的数量（组内口径，与 TraceCompactorRow 的全局 failedCount 分账，V15⑦ 对账等式两项并列） */
    failedCount: number
  }
  /** 组内是否含 status==='running' 的成员（放接口顶层——它是渲染信号不是计数口径，不入 header）。
   *  渲染层据此给组头套执行态视觉：loader 图标 + accent 文字色（与其余执行中块同款）。 */
  hasRunning: boolean
  /** 段首锚定 key（run head，v8）：members[0] 在 flatBlocks 全序列中所属连续 bash 段的段首 flatIndex。
   *  只取首成员的段首入键（v9 契约缝①）；对窗口滑动（段首成员被收编出窗）与段尾延长（running 并入）
   *  两个生长方向都稳定——窗口滑动不改段首在 flatBlocks 里的位置、段尾延长也不改段首。 */
  headFlatIndex: number
}

/** Turn.vue visibleBlocks 三分支汇合后的渲染单元：普通块或 bash 组块 */
export type TraceRenderUnit = FlatBlock | BashGroupBlock

/** bash 工具块判定（组员候选 / 段首回查共用）：kind==='tool' 且 toolName==='bash'。 */
function isBashToolBlock(fb: FlatBlock): boolean {
  return fb.block.kind === 'tool' && (fb.block.ref as ToolCall).toolName === 'bash'
}

/** 单成员耗时（口径②）：endTime 缺失（end_not_received 等）按 0 计，负值钳 0。 */
function bashMemberDurationMs(fb: FlatBlock): number {
  const tool = fb.block.ref as ToolCall
  if (typeof tool.startTime !== 'number' || typeof tool.endTime !== 'number') return 0
  return Math.max(0, tool.endTime - tool.startTime)
}

/**
 * 段首回查（v8 key 规则）：从首成员在 flatBlocks 中的位置沿 flatIndex 递减方向扫描连续 bash 至段头。
 * 段 = flatBlocks 全序列中相邻连续的 bash 块（纯几何概念，不筛 status——error bash 也是段内 bash）。
 * 入参一致性不变量（v9 契约缝③）：flatBlocks 与 visible 同源同拍（Turn.vue 两者都从
 * props.turn.assistants 的 computed 派生、同一渲染拍计算），首成员必在 flatBlocks 中；
 * 防御缺省（调用方违约）回落成员自身 flatIndex，不 throw。
 */
function bashRunHeadIndex(firstMember: FlatBlock, flatBlocks: FlatBlock[]): number {
  let startIdx = -1
  for (let i = 0; i < flatBlocks.length; i++) {
    if (flatBlocks[i].flatIndex === firstMember.flatIndex) {
      startIdx = i
      break
    }
  }
  if (startIdx === -1) return firstMember.flatIndex
  let head = firstMember.flatIndex
  for (let i = startIdx - 1; i >= 0; i--) {
    if (!isBashToolBlock(flatBlocks[i])) break
    head = flatBlocks[i].flatIndex
  }
  return head
}

/** 组块构建：三条计数口径 + hasRunning 一次算好 + 段首锚定 key。 */
function buildBashGroup(members: FlatBlock[], flatBlocks: FlatBlock[]): BashGroupBlock {
  let durationMs = 0
  let failedCount = 0
  let hasRunning = false
  for (const m of members) {
    durationMs += bashMemberDurationMs(m)
    if ((m.block.ref as ToolCall).status === 'error') failedCount += 1
    if ((m.block.ref as ToolCall).status === 'running') hasRunning = true
  }
  return {
    kind: 'bash-group',
    members,
    header: { count: members.length, durationMs, failedCount },
    hasRunning,
    headFlatIndex: bashRunHeadIndex(members[0], flatBlocks),
  }
}

/** bash 组成组门槛（D1）：连续 ≥2 个 bash 才成组，单个保持独立行。 */
const MIN_BASH_GROUP_SIZE = 2

/**
 * bash 组块类型守卫：TraceRenderUnit 收窄用。FlatBlock 无 kind 字段（非判别属性齐全的联合），
 * `unit.kind` 直访在 TS 下非法，必须经 'kind' in 判定（ui Turn.vue 与测试共用本守卫）。
 */
export function isBashGroupBlock(unit: TraceRenderUnit): unit is BashGroupBlock {
  return 'kind' in unit && unit.kind === 'bash-group'
}

/**
 * 连续 bash 折叠（ui-signal-density §3.3 D1，本函数不修改任何入参、不碰既有三函数契约）。
 *
 * 输入是可见派生序列（Turn.vue visibleBlocks 三分支汇合后的 FlatBlock[]）+ 同源同拍的 flatBlocks
 * （段首回查用）。规则：
 * - 组资格只看工具类型、不看状态（D1 语义变更：running 与已完成一视同仁）：连续 ≥2 个 bash
 *   工具块即成段成组（含 running 成员，组头 hasRunning=true 时渲染层呈现执行态——loader +
 *   accent）；不成组清单（read/grep/glob/cat/ls/find/write/edit/
 *   todo_write/thinking/subagent/workflow/text…）一律保持独立行，且打断成组（用户裁决 R5）。
 * - error bash 入组为失败成员（header.failedCount 计数，组行尾「· 含 M 次失败」承载，
 *   V8 双路径）；error 块不在输入序列中时（路径 B 窗口被 ③池剔除）前后两段按假邻接合并
 *   （v9 契约缝②），该 error 由 TraceCompactorRow 的全局 failedCount 报告、不入组内 M。
 * - 组块排序位置 = members[0].flatIndex；输出保持输入序列原序（分段扫描后按原序组装）。
 * 空输入 → 返回 []。
 */
export function groupConsecutiveBash(visible: FlatBlock[], flatBlocks: FlatBlock[]): TraceRenderUnit[] {
  const n = visible.length

  // ① 分段扫描：段 = 连续 bash 工具块（组资格只看工具类型，running 与已完成一视同仁，
  //    与段首回查 bashRunHeadIndex 的「纯几何段」口径一致）。遇非 bash 即断段。
  //    segOf[k] = 可见下标 k 所属段号（-1 = 非 bash 独立块）。
  const segments: number[][] = []
  const segOf: number[] = new Array(n).fill(-1)
  let i = 0
  while (i < n) {
    if (!isBashToolBlock(visible[i])) {
      i += 1
      continue
    }
    const seg: number[] = []
    while (i < n && isBashToolBlock(visible[i])) {
      seg.push(i)
      segOf[i] = segments.length
      i += 1
    }
    segments.push(seg)
  }

  // ② 按原序组装：段长 ≥2 → 段首位置输出组块、段内其余下标由组块承载（跳过）；
  //    段长 <2 与非候选块 → 独立 FlatBlock 原样输出。
  const units: TraceRenderUnit[] = []
  for (let idx = 0; idx < n; idx++) {
    const segId = segOf[idx]
    if (segId === -1) {
      units.push(visible[idx])
      continue
    }
    const seg = segments[segId]
    if (seg.length >= MIN_BASH_GROUP_SIZE) {
      if (seg[0] === idx) units.push(buildBashGroup(seg.map((k) => visible[k]), flatBlocks))
      continue
    }
    units.push(visible[idx])
  }
  return units
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

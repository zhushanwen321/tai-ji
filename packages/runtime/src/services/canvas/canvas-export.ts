/**
 * CanvasService 导出产物渲染 —— 纯函数（state → Markdown 字符串）。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1) export action + D8；
 * 概念文档 §6.1（导出形态 SSOT）：方向规划文档 = 问题陈述与完成判据 / 分解结构总览 /
 * 方案选择与否决记录 / 执行清单；叶子需求卡 = 五要素（目标 / 上溯论证链 / 已排除方案
 * 及理由 / 关键论据引用 / 生效约束）。
 *
 * 落盘（exports/ 目录）在 canvas-service.ts 编排；本文件零 IO。调用前置：收敛门禁
 * 已在 mutate 校验段通过（export 内部同校验不变量 10，未收敛不会到达渲染）。
 */
import type { CanvasEdge, CanvasNode } from '@zhushanwen/extension-protocol'
import { nodeOf, type CanvasDomainState } from './canvas-foundation.js'

const EXPORT_TRUNCATE_MAX = 80

function truncate(s: string, max = EXPORT_TRUNCATE_MAX): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 反向主干上溯：nodeId → 根的路径（子→根序）。 */
function pathFromNodeToRoot(state: CanvasDomainState, nodeId: string): string[] {
  const path: string[] = []
  const visited = new Set<string>([nodeId])
  const queue = [nodeId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    path.push(cur)
    for (const e of state.edges) {
      if ((e.type === 'decompose' || e.type === 'resolve') && e.to === cur && !visited.has(e.from)) {
        visited.add(e.from)
        queue.push(e.from)
      }
    }
  }
  return path
}

function nodeLabel(state: CanvasDomainState, id: string): string {
  const n = nodeOf(state, id)
  return n ? `「${truncate(n.content)}」(${n.id})` : `(${id})`
}

// ── 方向规划文档 ──────────────────────────────────────────────

export function renderPlanningDoc(state: CanvasDomainState, generatedAt: string): string {
  const lines: string[] = []
  lines.push(`# 方向规划文档：${state.name}`)
  lines.push('')
  lines.push(`> 画布 ${state.canvasId} · 导出时间 ${generatedAt} · 规划已收敛（三门禁全绿）`)
  lines.push('')
  lines.push('## 1. 问题陈述与完成判据')
  lines.push('')
  lines.push(`**问题陈述**：${state.root.statement}`)
  lines.push('')
  lines.push('**完成判据**（可证伪）：')
  for (const c of state.root.criterias) lines.push(`- ${c}`)
  lines.push('')
  if (state.root.scopeExclusions.length > 0) {
    lines.push('**范围排除**：')
    for (const s of state.root.scopeExclusions) lines.push(`- ${s}`)
    lines.push('')
  }
  if (state.direction) {
    lines.push(`**生长方向**：${state.direction.direction === 'top-down' ? '自顶向下' : '自底向上'}（裁决理由：${state.direction.reason}）`)
    lines.push('')
  }
  lines.push('## 2. 分解结构总览')
  lines.push('')
  lines.push('```')
  renderTree(state, state.root.nodeId, '', lines)
  lines.push('```')
  lines.push('')
  lines.push('## 3. 方案选择与否决记录')
  lines.push('')
  renderSelectionSection(state, lines)
  lines.push('')
  lines.push('## 4. 执行清单')
  lines.push('')
  renderExecutionSection(state, lines)
  lines.push('')
  return lines.join('\n')
}

/** §3 方案选择与否决记录：每个 resolve 父问题一段（选定 / 已否决 / 未选定三态行）；
 * 无解边时输出占位行（段落占位由调用方标题承担，这里只产出行内容）。 */
function renderSelectionSection(state: CanvasDomainState, lines: string[]): void {
  // 先按 from 去重出唯一父问题集再逐问题成段：同一父问题挂 ≥2 条 resolve 边（多候选
  // 比较）时只产出一个段落，候选行各一条——不与注释「每个 resolve 父问题一段」相悖。
  const parentIds = new Set<string>()
  for (const e of state.edges) {
    if (e.type === 'resolve') parentIds.add(e.from)
  }
  if (parentIds.size === 0) {
    lines.push('（无解边——画布未进入方案比较阶段）')
    return
  }
  for (const parentId of parentIds) {
    lines.push(`### 问题 ${nodeLabel(state, parentId)}`)
    for (const candidate of state.edges.filter((x) => x.type === 'resolve' && x.from === parentId)) {
      renderSelectionCandidate(state, candidate.to, lines)
    }
  }
}

/** 单个候选方案行：selected（附对比理由）/ rejected（附否决与复活条件）/ 其余（生命周期）。 */
function renderSelectionCandidate(state: CanvasDomainState, optionId: string, lines: string[]): void {
  const option = nodeOf(state, optionId)
  if (!option) return
  if (option.selected) {
    lines.push(`- **已选定** ${nodeLabel(state, option.id)}${option.selectionReason ? `——对比理由：${option.selectionReason}` : ''}`)
  } else if (option.lifecycle === 'rejected') {
    lines.push(`- 已否决 ${nodeLabel(state, option.id)}——否决理由：${option.rejection?.reason ?? '（未留痕）'}${option.rejection?.reviveCondition ? `；复活条件：${option.rejection.reviveCondition}` : ''}`)
  } else {
    lines.push(`- 未选定 ${nodeLabel(state, option.id)}（${option.lifecycle}）`)
  }
}

/** §4 执行清单：dispatchable option 逐条（已派发指针 / 待派发）。 */
function renderExecutionSection(state: CanvasDomainState, lines: string[]): void {
  const leaves = state.nodes.filter((n) => n.type === 'option' && n.dispatchable === true)
  if (leaves.length === 0) {
    lines.push('（无执行叶子）')
    return
  }
  for (const leaf of leaves) {
    const dispatchNote = leaf.dispatch ? ` · 已派发 → ${leaf.dispatch.pointer}` : ' · 待派发'
    lines.push(`- ${nodeLabel(state, leaf.id)}${dispatchNote}`)
  }
}

function renderTree(state: CanvasDomainState, nodeId: string, indent: string, lines: string[]): void {
  const node = nodeOf(state, nodeId)
  if (!node) return
  const marks: string[] = [node.type]
  if (node.selected) marks.push('selected')
  if (node.dispatchable) marks.push('执行叶子')
  if (node.lifecycle !== 'draft') marks.push(node.lifecycle)
  lines.push(`${indent}- ${truncate(node.content)} [${marks.join(', ')}]`)
  for (const e of state.edges) {
    if (e.type === 'decompose' && e.from === nodeId) {
      renderTree(state, e.to, `${indent}  `, lines)
    }
  }
}

// ── 叶子需求卡（五要素，对接 tech-design-wf T1 Step 0 的防腐层）──

export function renderRequirementCard(state: CanvasDomainState, leafId: string, generatedAt: string): string {
  const lines: string[] = []
  const leaf = nodeOf(state, leafId)
  lines.push(`# 需求卡：${leaf ? truncate(leaf.content) : leafId}`)
  lines.push('')
  lines.push(`> 画布 ${state.canvasId}「${state.name}」 · 执行叶子 ${leafId} · 导出时间 ${generatedAt}`)
  lines.push('')

  // 要素 1：目标（叶子的问题陈述与完成判据）——叶子是选定方案，其目标 = 它 resolve 的父问题。
  const resolveEdge = state.edges.find((e) => e.type === 'resolve' && e.to === leafId)
  lines.push('## 1. 目标')
  lines.push('')
  renderCardGoal(state, leafId, leaf, resolveEdge, lines)
  lines.push('')

  // 要素 2：上溯论证链（根到该叶子的路径摘要）。
  lines.push('## 2. 上溯论证链')
  lines.push('')
  const path = pathFromNodeToRoot(state, leafId).reverse()
  lines.push(path.map((id) => nodeLabel(state, id)).join(' → '))
  lines.push('')

  // 要素 3：已排除方案及理由（该问题下的 rejected 候选——防止下游重新发明）。
  lines.push('## 3. 已排除方案及理由')
  lines.push('')
  renderCardRejected(state, leafId, resolveEdge, lines)
  lines.push('')

  // 要素 4：关键论据引用（支撑该选择的 fact 论据与核实状态）。
  lines.push('## 4. 关键论据引用')
  lines.push('')
  renderCardFacts(state, leafId, lines)
  lines.push('')

  // 要素 5：生效约束（作用于该叶子的约束清单）——constrain 边为第二版词表，MVP 无此边类型。
  lines.push('## 5. 生效约束')
  lines.push('')
  lines.push('（MVP 画布未启用 constrain 边类型，无生效约束记录）')
  lines.push('')
  return lines.join('\n')
}

/** 要素 1 正文：父问题陈述 + 选定理由 + 完成判据（各字段存在才出对应行）。 */
function renderCardGoal(
  state: CanvasDomainState,
  leafId: string,
  leaf: CanvasNode | undefined,
  resolveEdge: CanvasEdge | undefined,
  lines: string[],
): void {
  const parentQuestion = resolveEdge ? nodeOf(state, resolveEdge.from) : undefined
  if (parentQuestion) lines.push(`**问题陈述**：${parentQuestion.content}`)
  if (leaf?.selectionReason) lines.push(`**选定理由**：${leaf.selectionReason}`)
  if (leaf?.criterias && leaf.criterias.length > 0) {
    lines.push('')
    lines.push('**完成判据**（可证伪）：')
    for (const c of leaf.criterias) lines.push(`- ${c}`)
  }
}

/** 要素 3 正文：同一父问题下的 rejected 候选（否决理由 + 复活条件）；无则占位行。 */
function renderCardRejected(
  state: CanvasDomainState,
  leafId: string,
  resolveEdge: CanvasEdge | undefined,
  lines: string[],
): void {
  const siblings = state.edges.filter((e) => e.type === 'resolve' && e.from === (resolveEdge?.from ?? ''))
  const rejected = siblings
    .map((e) => nodeOf(state, e.to))
    .filter((n): n is CanvasNode => n !== undefined && n.id !== leafId && n.lifecycle === 'rejected')
  if (rejected.length === 0) {
    lines.push('（无否决候选）')
    return
  }
  for (const r of rejected) {
    lines.push(`- ${nodeLabel(state, r.id)}——否决理由：${r.rejection?.reason ?? '（未留痕）'}${r.rejection?.reviveCondition ? `；复活条件：${r.rejection.reviveCondition}` : ''}`)
  }
}

/** 要素 4 正文：argue 支撑该叶子的 fact 论据（核实状态）；无则占位行。 */
function renderCardFacts(state: CanvasDomainState, leafId: string, lines: string[]): void {
  const supporting = state.edges.filter((e) => {
    if (e.type !== 'argue' || e.to !== leafId) return false
    const arg = nodeOf(state, e.from)
    return arg?.polarity === 'support'
  })
  const facts = supporting
    .map((e) => nodeOf(state, e.from))
    .filter((n): n is CanvasNode => n !== undefined && n.materiality === 'fact')
  if (facts.length === 0) {
    lines.push('（无支撑该叶子的 fact 论据）')
    return
  }
  for (const f of facts) {
    lines.push(`- ${truncate(f.content)}（核实状态：${f.factVerified ? '已核实' : '未核实'}）`)
  }
}

/**
 * blueprint-match.ts —— 蓝图-实例匹配规则纯函数（workflow-visualization 设计 §3.3-D2）。
 *
 * 蓝图节点 = 调用点（静态，名称可为模板如 `reviewer-<维度>-a<n>-r<轮>`）；运行时实例 =
 * WorkflowAgentCall（agent-started 事件的投影）。匹配算法（D2 形式化）：
 * ① 两级「且」判据——先 phase（实例 phase 等于调用点归属 phase），再模板正则命中
 *   （节点 matchPattern，字面段精确 + 变量段通配）；② 多命中按「字面段总长降序」取
 *   更具体者；仍并列歧义 → 进未匹配分组并标注，不静默择一；③ 零命中实例同进未匹配
 *   分组，不静默丢弃；④ 同节点实例按 taskIndex 升序（WorkflowAgentCall.id = trace
 *   step 序号，与事件帧 taskIndex 同源）挂接为节点实例列表。
 *
 * 模板形态口径：templateName 字面段原样、变量段为 u1 解析器合成的 `${…}` 通配标记
 * （workflow-dag-parser.ts extractNameTemplate——设计 §3.1-3 示例的 `<...>` 尖括号
 * 形态仅为文档示意，产物以 u1 为准）；无字面段的全通配模板整段记 `*`。
 * 纯函数零 IO；正则编译失败（传输损坏等防御面）该节点按零命中处理，不拖垮整表。
 */
import type { WorkflowAgentCall, WorkflowDag, WorkflowDagNode } from '@taiji/shared'

/**
 * 模板字面段总长（具体性度量）：templateName 剥 `${…}` 变量段后的字符总长。字面段越长
 * 模板越具体（D2 多命中裁决依据）。变量段标记 = u1 解析器产物形态 `${…}`（合成标记，
 * 非源码原文——按精确串切分，不用状态机扫 `$`/`{`：字面段自身含 `${...}` 原文时不误吞）；
 * 整段 `*`（无字面段的全通配模板）字面总长为 0。
 */
export function templateLiteralLength(templateName: string): number {
  if (templateName === '*') return 0
  let length = 0
  for (const literal of templateName.split('${…}')) length += literal.length
  return length
}

/** 未挂接实例条目（零命中 / 歧义；D2⑥ 不静默丢弃——phase 分区下「未匹配实例」分组的数据源）。 */
export interface WorkflowUnmatchedInstance { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  call: WorkflowAgentCall
  /** 正则与 phase 判据合计命中调用点数（0 = 零命中）。 */
  hitCount: number
  /** true = 命中 ≥ 2 且字面段总长并列（歧义，D2③ 不静默择一）。 */
  ambiguous: boolean
}

export interface WorkflowInstanceMatchResult { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  /** nodeId → 挂接实例列表（taskIndex 升序；仅含成功挂接者，零命中/歧义进 unmatched）。 */
  byNode: Map<string, WorkflowAgentCall[]>
  /** 未挂接实例（事件流序；零命中 hitCount=0，歧义 ambiguous=true）。 */
  unmatched: WorkflowUnmatchedInstance[]
}

/**
 * D2 主匹配：实例归属判定（两级判据 + 多命中字面段长度降序 + 歧义/零命中进未匹配分组）。
 * dag.nodes 为空（零调用点 run——渲染层出单节点摘要卡）时全部实例进 unmatched。
 */
export function matchInstancesToNodes(
  dag: Pick<WorkflowDag, 'nodes'>,
  calls: readonly WorkflowAgentCall[],
): WorkflowInstanceMatchResult {
  const byNode = new Map<string, WorkflowAgentCall[]>()
  const unmatched: WorkflowUnmatchedInstance[] = []

  // 节点正则预编译（匹配失败按零命中处理，不中断整表）
  const compiled = dag.nodes.map((node) => {
    let regex: RegExp | null = null
    try {
      regex = new RegExp(node.matchPattern)
    } catch {
      regex = null
    }
    return { node, regex }
  })

  for (const call of calls) {
    // 判据①：phase 等值（实例 phase 缺失时无法过等值判据 → 未匹配分组，不猜缺省分区名——
    // 解析器缺省分区名属 u1 产物口径，渲染层不发明第二套）
    if (call.phase === undefined) {
      unmatched.push({ call, hitCount: 0, ambiguous: false })
      continue
    }
    const candidates = compiled.filter(({ node, regex }) => {
      if (node.phase !== call.phase) return false
      if (regex === null || call.agent === undefined) return false
      return regex.test(call.agent)
    })

    if (candidates.length === 0) {
      unmatched.push({ call, hitCount: 0, ambiguous: false })
      continue
    }

    // 判据②：多命中按字面段总长降序取更具体者；仍并列歧义 → 未匹配分组（标注命中数）
    let best: { node: WorkflowDagNode; literalLength: number } | undefined
    let bestCount = 0
    for (const { node } of candidates) {
      const literalLength = templateLiteralLength(node.templateName)
      if (best === undefined || literalLength > best.literalLength) {
        best = { node, literalLength }
        bestCount = 1
      } else if (literalLength === best.literalLength) {
        bestCount += 1
      }
    }

    if (best === undefined || bestCount > 1) {
      unmatched.push({ call, hitCount: candidates.length, ambiguous: true })
      continue
    }

    const list = byNode.get(best.node.id) ?? []
    list.push(call)
    byNode.set(best.node.id, list)
  }

  // 判据④：同节点实例按 taskIndex 升序（call.id = trace step 序号）
  for (const list of byNode.values()) {
    list.sort((a, b) => a.id - b.id)
  }
  return { byNode, unmatched }
}

/**
 * [M3b U7] 嵌套执行树构建（design m3 slice DM1/DM2/DM4 + IF3/IF5 + ES1-5）。
 *
 * 与 resolveFamily（core/family.ts，flat 家族）互补：buildExecutionTree 构建任意深度
 * subagent↔workflow-call 相互嵌套的执行树，精确父子链基于 parentRecordId（M3a 落盘镜像）。
 *
 * 核心思路：
 * - **subagent 后代**：parentRecordId 精确链挂载（undefined→顶层 main，==父.id→挂父下）。
 *   三级数据源优先级（DM4）：① manifest.parentRecordId ② identity.data.parentRecordId
 *   ③ 都缺→undefined（顶层/flat 回退）。旧机制 record 全 undefined→全挂 main（flat-fallback）。
 * - **workflow-call 后代**：指针递归——读 subagent node 的 sessionFile 的 workflow-state-link
 *   → calls[].sessionFile（每个 call 作子 node）→ 递归读 call session 的 workflow-state-link
 *   （嵌套 workflow）。复用 M2 resolveWorkflows/readRunSnapshot 容错（ES4）。
 * - **鲁棒性**：visited Set 防环（ES1，family.ts:209 seen Set 同构）+ MAX_DEPTH 截断（ES2），
 *   截断标 tree.truncated=true 不抛错，返回部分树。
 *
 * 分层（同 family/workflow）：本文件是 core 层，IO 经 discovery 层（listRecordManifests/
 * resolveWorkflows/readTailIdentity），core 层只做树构建与渲染逻辑。agentDir 作参数注入，
 * 零 pi 依赖，可完全单测。
 */

import { basename } from 'node:path'
import {
  listRecordManifests,
  readTailIdentity,
  extractSessionIdFromFilename,
  type RecordManifest,
} from '../discovery/subagents.js'
import { resolveWorkflows } from '../discovery/workflows.js'
import type { SessionRef, WorkflowRef } from './family.js'

// ============================================================
// 类型（DM1/DM2）
// ============================================================

/**
 * 执行树节点（DM1）。
 *
 * children 可同时含 subagent 后代（parentRecordId 链）与 workflow-call 后代（指针递归），
 * 任意深度相互嵌套。workflow-call 节点无 record manifest（call 复用 subagent session，P-wfreuse）。
 */
export interface ExecutionTreeNode {
  type: 'main' | 'subagent' | 'workflow-call'
  /** main/subagent 的 session id；workflow-call 的 call session id（文件名提取，GC 路径可能为空） */
  sessionId: string
  /** workflow-call 专属 runId（subagent/main 无） */
  runId?: string
  /** 节点 session.jsonl 绝对路径（深读入口；GC 后可能 undefined） */
  sessionFile?: string
  /** workflow-call 的 wf-state 文件绝对路径 */
  stateFile?: string
  /** 0=main，1=直接 subagent/直接 workflow call，2+=嵌套后代 */
  depth: number
  /** 全树共享的顶层 main session id（旧机制=直接父，版本探测区分） */
  rootSessionId: string
  /** 精确直接父 record id（depth=0 顶层 subagent / main 为 undefined） */
  parentRecordId?: string
  /** subagent 专属（manifest.agentName / identity.data.agent） */
  agentName?: string
  slug?: string
  task?: string
  /** 仅 details 可见，不进文本渲染（formatExecutionTreeText 渲染 status/slug/agentName/task，与 SubagentRef.model 同口径） */
  model?: string
  /** subagent 终态 completed/failed/running（manifest.status） */
  status?: string
  /** 递归子节点 */
  children: ExecutionTreeNode[]
}

/**
 * 执行树根（DM2）。
 *
 * sourceMode 让 LLM 知晓精度：precise（任意节点子树可精确切）/ flat-fallback（顶层全树
 * 可用，中间节点子树不精确）。truncated=true 时 LLM 应改用 recursive=false flat family 兜底。
 */
export interface ExecutionTree {
  root: ExecutionTreeNode
  totalNodes: number
  maxDepth: number
  truncated: boolean
  sourceMode: 'precise' | 'flat-fallback'
}

// ============================================================
// 常量
// ============================================================

/** 递归深度兜底（ES2，参考 pi PI_SUBAGENT_FORK_DEPTH 保守上限）。 */
const MAX_DEPTH = 20

/** task 文本渲染截断长度（IF5，防爆长 task 撑乱树形）。 */
const TASK_RENDER_LIMIT = 50

/** runId 渲染截断长度。 */
const RUNID_RENDER_LIMIT = 16
/** sessionId 渲染截断长度（与 tool-handler.ts formatXxxText 一致，uuid 前 8 位）。 */
const SESSION_ID_SLICE = 8

// ============================================================
// parentRecordId 三级数据源（DM4）
// ============================================================

/**
 * 解析单个 record 的 parentRecordId（DM4 优先级）。
 *
 * ① manifest.parentRecordId（M3a 落盘后新 record，最高优先级）
 * ② identity.data.parentRecordId（session jsonl 尾行，新版本 session-runner 才写）
 * ③ 都缺→undefined（顶层 subagent / flat 回退）
 *
 * ② 需读 sessionFile 尾行（IO），仅在 ① 缺时触发；当前本机旧数据 ① 全缺、② 采样也全缺，
 * 绝大多数走 ③（flat 回退），M3a 落地后新 record 走 ①。
 */
async function resolveParentRecordId(
  manifest: RecordManifest,
): Promise<{ parentRecordId: string | undefined }> {
  // ① manifest.parentRecordId
  if (manifest.parentRecordId !== undefined) {
    return { parentRecordId: manifest.parentRecordId }
  }
  // ② identity.data.parentRecordId（读 sessionFile 尾行；readTailIdentity 容错返 undefined）
  if (manifest.sessionFile) {
    const ident = await readTailIdentity(manifest.sessionFile)
    if (ident !== undefined) {
      return { parentRecordId: ident.parentRecordId }
    }
  }
  // ③ 都缺
  return { parentRecordId: undefined }
}

// ============================================================
// 版本探测 + 相关 record 收集（旧机制 rootSessionId 链）
// ============================================================

/**
 * 收集属于 rootSessionId 树的所有 record（ES3 旧机制兼容）。
 *
 * 新机制：所有同树 record 的 rootSessionId === 顶层 main（全树共享）。
 * 旧机制：record 的 rootSessionId === 直接父 subagent 的 session id（非 main）。
 *
 * BFS 从 rootSessionId 出发：每轮收 rootSessionId===当前节点 的 record，并把该 record 的
 * session id 入队（旧机制下，嵌套后代的 rootSessionId===父 session id）。新机制下 record 的
 * session id 不会是其他 record 的 rootSessionId（全=main），BFS 不扩散——兼容两种机制。
 *
 * 不丢弃任何相关 record（ES3 准则：旧数据必须兼容回退）。
 */
function collectRelatedRecords(
  rootSessionId: string,
  manifests: RecordManifest[],
): RecordManifest[] {
  const related: RecordManifest[] = []
  const visitedSid = new Set<string>([rootSessionId])
  const queue: string[] = [rootSessionId]

  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const m of manifests) {
      if (m.rootSessionId !== cur) continue
      if (visitedSid.has(m.id)) continue
      visitedSid.add(m.id)
      related.push(m)
      // 旧机制：m 的 session id 可能是其后代的 rootSessionId，入队继续 BFS
      const mSid = extractSessionIdFromFilename(basename(m.sessionFile))
      if (mSid !== '' && !visitedSid.has(mSid)) {
        visitedSid.add(mSid)
        queue.push(mSid)
      }
    }
  }
  return related
}

// ============================================================
// buildExecutionTree（IF3 核心）
// ============================================================

/** 建树过程的共享可变状态（避免递归函数参数爆炸，封装为 context）。 */
interface BuildContext {
  rootSessionId: string
  related: RecordManifest[]
  parentOf: Map<string, string | undefined>
  visitedRecord: Set<string>
  /**
   * 已作为树节点（main/subagent/workflow-call）展开的 sessionFile 集合。
   *
   * 双重职责：①避免 workflow-call 重复创建（同 call session 多次引用）；②环检测——call 循环里
   * 若 call.sessionFile 已在此集合（某祖先 node 的 session），说明指针成环，标 truncated 跳过（ES1）。
   * main/subagent node 在 attachWorkflowChildrenOfTree 入口 add；workflow-call node 在创建时 add。
   */
  expandedSessions: Set<string>
  truncated: boolean
  totalNodes: number
  maxDepth: number
}

/**
 * 挂载 subagent 后代（parentRecordId 精确链 + flat 回退）。
 *
 * 挂载条件（任一）：
 * - parentRecordId === nodeRecordId（精确链：node 是父 subagent record）
 * - node.type==='main' && parentRecordId===undefined（顶层 subagent：父是 main；含 flat 回退）
 *
 * 旧机制 record 全 parentRecordId===undefined → 全挂 main（flat-fallback 的体现）。
 * 递归挂载嵌套后代（visitedRecord 防环 ES1，MAX_DEPTH 截断 ES2）。
 */
async function attachSubagentChildren(
  ctx: BuildContext,
  node: ExecutionTreeNode,
  nodeRecordId: string | undefined,
): Promise<void> {
  for (const m of ctx.related) {
    const pid = ctx.parentOf.get(m.id)
    // 挂载条件：精确链 或 顶层（main + pid undefined）
    const isPreciseChild = pid !== undefined && pid === nodeRecordId
    const isTopLevel = node.type === 'main' && pid === undefined
    if (!isPreciseChild && !isTopLevel) continue
    // 环检测（ES1）：m 应挂此节点但已挂他处（坏数据多父/parentRecordId 环）→ 标 truncated 跳过
    if (ctx.visitedRecord.has(m.id)) {
      ctx.truncated = true
      continue
    }

    if (node.depth >= MAX_DEPTH) {
      ctx.truncated = true
      return // 该分支截断，不再挂子节点
    }

    ctx.visitedRecord.add(m.id)
    const sid = extractSessionIdFromFilename(basename(m.sessionFile)) || m.id
    const child: ExecutionTreeNode = {
      type: 'subagent',
      sessionId: sid,
      sessionFile: m.sessionFile,
      depth: node.depth + 1,
      rootSessionId: ctx.rootSessionId,
      parentRecordId: pid,
      agentName: m.agentName,
      slug: m.slug,
      task: m.task,
      model: m.model,
      status: m.status,
      children: [],
    }
    node.children.push(child)
    ctx.totalNodes++
    if (child.depth > ctx.maxDepth) ctx.maxDepth = child.depth
    // 递归挂该 subagent 的后代（parentRecordId 链）
    await attachSubagentChildren(ctx, child, m.id)
  }
}

/**
 * 挂载 workflow-call 后代（指针递归，IF3 TC2）。
 *
 * 读 node.sessionFile 的 workflow-state-link（resolveWorkflows）→ 每个 call 作 workflow-call
 * 子 node → 递归读 call session 的 workflow-state-link（嵌套 workflow）。
 *
 * workflow-call 不挂 subagent 后代（parentRecordId 总指向 subagent 链，TC-m3b-nested-tree
 * 确认 C 挂 A 不挂 B）。复用 resolveWorkflows/readRunSnapshot 容错（ES4，wf-state GC→calls=[]）。
 * expandedSessions 在 call 循环检测环（call.sessionFile 已是某祖先 node 的 session→指针成环，ES1）。
 */
async function attachWorkflowChildren(ctx: BuildContext, node: ExecutionTreeNode): Promise<void> {
  if (!node.sessionFile) return

  if (node.depth >= MAX_DEPTH) {
    ctx.truncated = true
    return
  }

  // resolveWorkflows 需 sessionIdToPath（node.sessionId → sessionFile）
  const sessionIdToPath = new Map<string, string>([[node.sessionId, node.sessionFile]])
  const pathToRef = new Map<string, SessionRef>()
  let workflows: WorkflowRef[]
  try {
    workflows = await resolveWorkflows(node.sessionId, sessionIdToPath, pathToRef)
  } catch {
    workflows = [] // resolveWorkflows 容错（ES4），异常时不中断树
  }

  // MF-1 跨集合去重：收集本节点已有的 subagent 直接子节点 sessionFile。call session 在新机制下
  // 同时被 parentRecordId 链（作 subagent 子节点）与 workflow 指针（作 workflow-call 子节点）命中，
  // 两套去重集合（visitedRecord record id 维度 / expandedSessions sessionFile 维度）键空间不同会双重挂载。
  // 仅对「同一父节点」去重——目标已是本节点 subagent 子节点时跳过 wf-call（非环，不标 truncated）；
  // 不同父节点的交叉引用（如环 A→B→A）不受影响，保留以触发环检测（设计 §4.1 场景 3「每个 call session 只出现一次」）。
  const subagentChildFiles = new Set<string>()
  for (const c of node.children) {
    if (c.type === 'subagent' && c.sessionFile) subagentChildFiles.add(c.sessionFile)
  }

  for (const wf of workflows) {
    for (const call of wf.calls) {
      // MF-1 dedup：目标 session 已是本节点 subagent 直接子节点 → 跳过（去重，非环）
      if (call.fileName && subagentChildFiles.has(call.fileName)) continue
      const callKey = call.fileName || `wf:${wf.runId}:${call.sessionId}`
      // 环检测（ES1）：call session 已是某祖先 node 的 session（指针成环/重复引用）→ 标 truncated 跳过
      if (ctx.expandedSessions.has(callKey)) {
        ctx.truncated = true
        continue
      }
      ctx.expandedSessions.add(callKey)

      if (node.depth + 1 > MAX_DEPTH) {
        ctx.truncated = true
        continue
      }

      const child: ExecutionTreeNode = {
        type: 'workflow-call',
        sessionId: call.sessionId,
        runId: wf.runId,
        stateFile: wf.stateFile,
        sessionFile: call.fileName,
        depth: node.depth + 1,
        rootSessionId: ctx.rootSessionId,
        children: [],
      }
      node.children.push(child)
      ctx.totalNodes++
      if (child.depth > ctx.maxDepth) ctx.maxDepth = child.depth
      // 递归读 call session 的 workflow-state-link（嵌套 workflow）
      await attachWorkflowChildren(ctx, child)
    }
  }
}

/**
 * 遍历整树（DFS）对每个 main/subagent node 挂 workflow-call 后代。
 *
 * workflow-call node 的 workflow（嵌套 workflow）在 attachWorkflowChildren 内已递归，此处不再
 * 对 workflow-call node 调用（避免重复）。复制 children 快照避免递归中数组变动影响迭代。
 */
async function attachWorkflowChildrenOfTree(
  ctx: BuildContext,
  node: ExecutionTreeNode,
): Promise<void> {
  if (node.type === 'main' || node.type === 'subagent') {
    if (node.sessionFile) ctx.expandedSessions.add(node.sessionFile)
    await attachWorkflowChildren(ctx, node)
  }
  const snapshot = [...node.children]
  for (const child of snapshot) {
    await attachWorkflowChildrenOfTree(ctx, child)
  }
}

/**
 * 从任意节点（main 或 subagent）构建嵌套执行树（IF3 + 设计 §5.5「任意节点子树可切」）。
 *
 * 两种 root 形态：
 * - **main root**（无 manifest 匹配 sessionFile）：按 rootSessionId 链收全树（版本探测 +
 *   旧机制兼容），root 节点 type='main'，attachSubagentChildren 从 undefined 挂顶层 subagent。
 *   mainSessionFile 参数（MF-1）：main session 自身发起的 workflow run 也要进树——main root
 *   节点填 sessionFile 后 attachWorkflowChildren 才能读到其 workflow-state-link（否则
 *   workflow-call 分支对无 sessionFile 节点直接 return，main 的 workflow run 永不入树）。
 * - **subagent root**（有 manifest 且 sessionFile 含 rootSessionId，MF-2）：root 节点 type='subagent'
 *   携带 manifest 元数据；复用其 rootSessionId（新机制=顶层 main）拉全树记录，再由
 *   attachSubagentChildren 按 parentRecordId 链只挂该 subagent 的后代（§5.5 决策五）。
 *
 * 流程：① listRecordManifests 扫所有 record；② 探测 root 形态 + collectRelatedRecords 收集；
 * ③ resolveParentRecordId 解析每节点 parentRecordId（DM4 三级）；④ subagent 后代按 parentRecordId
 * 精确链挂载；⑤ workflow-call 后代指针递归（resolveWorkflows）；⑥ visited Set 防环 + MAX_DEPTH 截断。
 *
 * 错误契约（ES1-5）全容错：环/深度超限截断标 truncated 不抛错；wf-state GC→children=[]；
 * 无后代→单节点树（totalNodes=1）。绝不丢弃 record。
 */
export async function buildExecutionTree(
  rootSessionId: string,
  agentDir: string,
  /** main session .jsonl 绝对路径（MF-1：main root 填 sessionFile 使 main 的 workflow run 可读）。 */
  mainSessionFile?: string,
): Promise<ExecutionTree> {
  const manifests = await listRecordManifests(agentDir)

  // MF-2：探测 root 是否为 subagent（有 manifest 且 sessionFile 文件名含 rootSessionId）。
  // subagent root 时按 parentRecordId 链切子树；main root 时按 rootSessionId 链收全树。
  const rootManifest = manifests.find(
    (m) => extractSessionIdFromFilename(basename(m.sessionFile)) === rootSessionId,
  )

  // ①② 收集相关 record：subagent root 复用其 rootSessionId（新机制=顶层 main）拉全树记录，
  // 再由 attachSubagentChildren 按 parentRecordId 链只挂该 subagent 的后代（§5.5）；
  // main root 直接用 rootSessionId 收全树。旧机制 subagent root 无精确链 → 单节点（已知局限，§10）。
  const collectRoot = rootManifest?.rootSessionId || rootSessionId
  const related = collectRelatedRecords(collectRoot, manifests)

  // ③ 解析每节点 parentRecordId（三级数据源）+ 探测 sourceMode
  const parentOf = new Map<string, string | undefined>()
  let hasPreciseLink = false
  for (const m of related) {
    const { parentRecordId } = await resolveParentRecordId(m)
    parentOf.set(m.id, parentRecordId)
    if (parentRecordId !== undefined) hasPreciseLink = true
  }
  // sourceMode（ES5）：无 record → precise（确定无后代）；有 record 但全无 parentRecordId →
  // flat-fallback（旧机制回退）；有任何精确链 → precise。
  const sourceMode: 'precise' | 'flat-fallback' =
    related.length > 0 && !hasPreciseLink ? 'flat-fallback' : 'precise'

  // ctx.rootSessionId：subagent root 用其 manifest.rootSessionId（顶层 main），使后代节点的
  // rootSessionId 字段仍指向全树共享的顶层 main（字段语义不变）。
  const ctxRootSessionId = rootManifest?.rootSessionId || rootSessionId
  const ctx: BuildContext = {
    rootSessionId: ctxRootSessionId,
    related,
    parentOf,
    visitedRecord: new Set<string>(),
    expandedSessions: new Set<string>(),
    truncated: false,
    totalNodes: 1, // 含 root
    maxDepth: 0,
  }

  // root 节点：subagent root → 携带 manifest 元数据的 subagent 节点（MF-2）；否则 main 节点
  let root: ExecutionTreeNode
  let rootRecordId: string | undefined
  if (rootManifest) {
    rootRecordId = rootManifest.id
    // 防 root 自身被当后代重挂（环/坏数据多父）
    ctx.visitedRecord.add(rootManifest.id)
    root = {
      type: 'subagent',
      sessionId: rootSessionId,
      sessionFile: rootManifest.sessionFile,
      depth: 0,
      rootSessionId: ctxRootSessionId,
      parentRecordId: parentOf.get(rootManifest.id),
      agentName: rootManifest.agentName,
      slug: rootManifest.slug,
      task: rootManifest.task,
      model: rootManifest.model,
      status: rootManifest.status,
      children: [],
    }
  } else {
    root = {
      type: 'main',
      sessionId: rootSessionId,
      // MF-1：main root 携带 sessionFile（调用方传入），否则 attachWorkflowChildren 对无
      // sessionFile 节点直接 return，main 自身发起的 workflow run 永远进不了执行树。
      sessionFile: mainSessionFile,
      depth: 0,
      rootSessionId,
      children: [],
    }
  }

  // 主流程：先挂 subagent 后代（parentRecordId 链，subagent root 从 rootRecordId 挂其后代），
  // 再遍历整树挂 workflow 后代
  await attachSubagentChildren(ctx, root, rootRecordId)
  await attachWorkflowChildrenOfTree(ctx, root)

  return {
    root,
    totalNodes: ctx.totalNodes,
    maxDepth: ctx.maxDepth,
    truncated: ctx.truncated,
    sourceMode,
  }
}

// ============================================================
// formatExecutionTreeText（IF5 渲染）
// ============================================================

/** 截断文本到 max 字符，超出加省略号。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/**
 * 渲染执行树为缩进树形文本（IF5）。
 *
 * 头部摘要（totalNodes/maxDepth/sourceMode/truncated）+ 树形（按 depth 缩进，每行 type/sessionId
 * 截断/status/task 摘要）+ 尾部 👉 节点 id 跳 outline/detail 深读。flat-fallback 时注明精度限制。
 */
export function formatExecutionTreeText(tree: ExecutionTree): string {
  const lines: string[] = []

  // 头部摘要
  const modeLabel =
    tree.sourceMode === 'precise'
      ? 'precise（parentRecordId 精确链）'
      : 'flat-fallback（旧机制扁平回退）'
  lines.push(
    `execution tree: ${tree.totalNodes} node(s) · maxDepth ${tree.maxDepth} · ${modeLabel}${
      tree.truncated ? ' · [truncated 环检测/深度截断]' : ''
    }`,
  )
  if (tree.sourceMode === 'flat-fallback') {
    lines.push('（旧机制数据：中间节点子树不可精确切，顶层全树可用）')
  }
  lines.push('')

  // 树形渲染
  const renderNode = (node: ExecutionTreeNode, indent: string): void => {
    const sidLabel = node.sessionId !== '' ? node.sessionId.slice(0, SESSION_ID_SLICE) : '(unknown)'
    const parts = [`${indent}${node.type} ${sidLabel}`]
    if (node.type === 'workflow-call' && node.runId) {
      parts.push(`run=${truncate(node.runId, RUNID_RENDER_LIMIT)}`)
    }
    if (node.status) parts.push(`[${node.status}]`)
    if (node.slug) parts.push(`slug=${node.slug}`)
    if (node.agentName) parts.push(`agent=${node.agentName}`)
    if (node.task) parts.push(`· ${truncate(node.task, TASK_RENDER_LIMIT)}`)
    lines.push(parts.join(' '))
    const childIndent = indent + '  '
    for (const c of node.children) renderNode(c, childIndent)
  }
  renderNode(tree.root, '')

  // 尾部指引（M0 resolveSessionId 已打通任意节点 id 深读入口）
  lines.push('')
  lines.push(
    `👉 树里任意节点 id 直接走 session_read {action:'outline'/'detail', session:'<nodeId>'} 深读`,
  )
  return lines.join('\n')
}

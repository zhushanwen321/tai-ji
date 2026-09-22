import type { Entry } from '@zhushanwen/session-core'

/**
 * 家族索引与解析（design §3.3 D-7）。
 *
 * M1 范围：纯逻辑层。buildFamilyIndex 接收已读入的 entry 数组（不做文件 IO），
 * 文件扫描/首行读取归 M2 discovery 层（roots.ts/find.ts/subagents.ts）。
 *
 * 占位约定（原「M2 回填补全」双阶段约定已随 enrichRefs 删除退役，ext-simplify-04 U4/E2
 * ——回填的 fileName/cwd 零文本读者；SessionRef 类型与 find 路径共享，find 侧两字段有
 * 真实消费者，字段本身保留）：
 * - SessionRef.fileName / subagent cwd：family 路径恒为占位空串（session header 推不出
 *   路径 / identity entry 无 cwd），不再回填
 * - SessionRef.mtime/sizeBytes：从 fileStats 取（M1 key=sessionId），取不到为 0
 * - SubagentRef.sessionId：identity entry 不含 subagent session 的 id → 占位用 entry.id
 *   （M2 buildFamilyFromFs 以 header.id 替换为真实 id）
 * - fileStats 的 key：sessionId（M2 实现沿用此 key，cleanedUp 按 sessionId 命中），逻辑通用
 *
 * 隔代关联规则（design §3.3 D-7 Q1）见 resolveFamily 注释。
 */

export interface SessionRef {
  sessionId: string
  fileName: string
  mtime: number
  sizeBytes: number
  cwd: string
  /** fork 文件指向来源的路径（来自 header 的 parentSession，原始文件路径字符串） */
  parentSession?: string
}

export interface SubagentRef extends SessionRef {
  rootSessionId: string
  slug: string
  /** identity 在但文件已被 30 天 TTL GC（design §3.3 D-7 边界 / 失败路径 F3） */
  cleanedUp?: boolean
  /** subagent 任务文本（manifest.task，P-fallback 时 identity.data.task；两者都无则 undefined） */
  task?: string
  /** agent 类型名（manifest.agentName，P-fallback 时 identity.data.agent；同语义异名） */
  agentName?: string
  /** 模型 id（仅 manifest 有；P-fallback 时 undefined）。仅 details 可见，不进文本渲染（D2②：展示面只取 status/agentName/task） */
  model?: string
  /** 终态 completed/failed/running（仅 manifest 有；P-fallback 时 undefined） */
  status?: string
  /** subagent session.jsonl 绝对路径（manifest.sessionFile 或 alive 文件 meta.path）。仅 details 可见，不进文本渲染 */
  sessionFile?: string
}

export interface WorkflowRef {
  runId: string
  stateFile: string
  calls: SessionRef[]
}

export interface Family {
  root: SessionRef
  /** fork 父链（root 往上，最近在前） */
  parents: SessionRef[]
  /** fork 直接子代 */
  forks: SessionRef[]
  /** 含隔代（design §3.3 D-7 Q1：对 fork 链每个节点查 subagentsByRoot 合并） */
  subagents: SubagentRef[]
  /** M1 恒返回 []，workflow 腿需读 workflow-state 文件（IO）归 M2 */
  workflows: WorkflowRef[]
}

export interface FamilyIndex {
  byId: Map<string, SessionRef>
  /**
   * 父 sessionId（经 parentSession 文件路径反查得到）→ 直接 fork 子代。
   * 注意 key 是 sessionId 不是文件路径：parentSession 是文件路径，buildFamilyIndex
   * 反查映射回父 sessionId 后建此表，供 resolveFamily 用 root.sessionId 直接查。
   */
  childrenOf: Map<string, SessionRef[]>
  /** rootSessionId → 该 root 直接发起的 subagent（隔代合并在 resolveFamily 跨链节点做） */
  subagentsByRoot: Map<string, SubagentRef[]>
  /** 建索引时的文件元信息快照，供 cleanedUp 判断（subagent 文件 GC 检测，design §3.3 D-7） */
  fileStats: Map<string, { mtime: number; size: number }>
}

// ---- zcode 节点（design session-reader-shared-core §3.3 D5-1）----

/**
 * zcode subagent 节点的判据输入视图（discovery 层 zcode-manifest.ts 枚举产出，
 * core 层零 IO 消费）。扁平化：dbPath 取自 manifest engineHandle.sessionRef.dbPath
 * （zcode 锚），dbFileExists 由 discovery 枚举时 statSync 预计算——stat 只查存在性
 * **不开库**（D5-1：静息态 CANTOPEN 会把活会话误判已 GC，且列表视图每节点开库的
 * 成本不该付；库内 session 已被 zcode GC 的情形由 read 路径 zcode_session_not_found
 * 权威承接，列表视图保持廉价是本判据的设计核心）。
 */
export interface ZcodeFamilyNode {
  /** record id（= sa-id，manifest 文件名 stem）。作 SubagentRef.sessionId（pi 孤儿链同款：entry.id = manifest.id） */
  id: string
  /** subagent 的发起 session id（subagentsByRoot 挂载键，与 pi identity.data.rootSessionId 同语义） */
  rootSessionId: string
  /** slug 标签（discovery 组装时已兜底 m.slug ?? m.agentName ?? ''，与 pi 孤儿链同款） */
  slug: string
  /** agent 类型名 */
  agentName?: string
  task?: string
  model?: string
  status?: string
  /** zcode 锚的库路径（engineHandle.sessionRef.dbPath；枚举谓词已保证非空 string） */
  dbPath: string
  /** 库文件存在性（discovery 枚举时 statSync 预计算；D5-1 第二判据的唯一输入） */
  dbFileExists: boolean
}

/**
 * zcode 节点 → subagentsByRoot（D5-1 判据落地）。
 *
 * 判据（两项、不开库）：**锚可解析 ∧ 库文件存在 → cleanedUp=false；缺一 → true**。
 * 「锚可解析」在枚举层已构造性成立（listZcodeManifests 谓词 = engine==='zcode' ∧
 * sessionRef 双键齐，未通过的记录不产出）——core 层只需消费 dbFileExists。
 *
 * 与 pi 节点**刻意不同构**（D5-1 显式声明）：pi 判据 = fileStats JSONL 文件存在性
 * （buildSubagentsByRoot 的 !fileStats.has(ident.id)）；zcode 节点住在 SQLite 库里、
 * 没有 JSONL 文件，「文件在不在」对它是无效判据。二者不互相回归。
 */
export function buildZcodeSubagentsByRoot(
  nodes: readonly ZcodeFamilyNode[],
): Map<string, SubagentRef[]> {
  const byRoot = new Map<string, SubagentRef[]>()
  for (const n of nodes) {
    const ref: SubagentRef = {
      // zcode 节点无 subagent session 文件，sessionId 用 record id（pi 孤儿链同款占位）
      sessionId: n.id,
      rootSessionId: n.rootSessionId,
      slug: n.slug,
      fileName: '', // 占位空串（family 路径不回填，与 pi 一致）
      mtime: 0, // 无 JSONL 文件可 stat，恒 0（占位约定，见文件头注释）
      sizeBytes: 0,
      cwd: '',
      // D5-1：锚可解析（枚举谓词已过）∧ 库文件存在 → false；缺一 → true（GC 语义）
      cleanedUp: !n.dbFileExists,
      task: n.task,
      agentName: n.agentName,
      model: n.model,
      status: n.status,
      // sessionFile 不设：zcode 无 session.jsonl（pi 孤儿保留 GC 路径，zcode 无路径可保留）
    }
    const list = byRoot.get(n.rootSessionId)
    if (list) list.push(ref)
    else byRoot.set(n.rootSessionId, [ref])
  }
  return byRoot
}

// ---- 类型守卫：从 unknown 的 entry.data 提取 subagent identity 字段 ----

/**
 * identity 尾行 data 结构（读取视图，DM-IdentityData）。
 *
 * 守卫只强制 rootSessionId+slug（m0 契约），其余富字段全 optional——由 buildFamilyFromFs
 * 按 manifest 主/P-fallback 回退路径组装时决定是否填入（manifest 主填全，P-fallback
 * 只填 task/agent/sessionFile，model/status 缺）。
 */
interface SubagentIdentityData {
  rootSessionId: string
  slug: string
  /** 任务文本（manifest.task 或 identity.data.task） */
  task?: string
  /**
   * agent 类型名（identity.data.agent）。
   * 同语义异名：manifest.agentName ↔ identity.data.agent。buildFamilyFromFs 组装
   * identity entry 时把 manifest.agentName 映射到 data.agent，此处统一读 data.agent
   * 填 SubagentRef.agentName，消费方无需感知来源差异。
   */
  agent?: string
  /** 模型 id（仅 manifest 主路径写入；P-fallback 无） */
  model?: string
  /** 终态（仅 manifest 主路径写入；P-fallback 无） */
  status?: string
  /** subagent session.jsonl 绝对路径 */
  sessionFile?: string
}

function isSubagentIdentityData(v: unknown): v is SubagentIdentityData {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  // 守卫放宽：只校验 rootSessionId+slug 必填（m0 契约），task/agent/model/status/sessionFile optional
  return typeof obj.rootSessionId === 'string' && typeof obj.slug === 'string'
}

/**
 * 把 parentSession（文件路径）反查回父 sessionId。
 *
 * parentSession 是 fork 文件首行 header 指向来源的**文件路径**（非 session id），
 * 文件名格式 `<timestamp>_<sessionId>.jsonl`，故路径字符串含父 sessionId。
 * 遍历已知 sessionId 做子串匹配反查。
 *
 * 假设 sessionId 互不为子串（pi 用 UUID，满足）；M2 可优化为 fileName→sessionId
 * 索引反查（O(1)），当前遍历 O(N)，家族索引文件数通常几十到几百，可接受。
 *（原「parentSession 直接是 sessionId」快路径已删除，ext-simplify-04 A4——生产数据
 * 恒为文件路径，该分支只服务测试 fixture 简化形态。）
 */
function resolveParentSessionId(
  parentSession: string | undefined,
  byId: Map<string, SessionRef>,
): string | null {
  if (!parentSession) return null
  for (const sid of byId.keys()) {
    if (parentSession.includes(sid)) return sid
  }
  return null
}

/** 阶段 1：headers → byId（SessionRef 组装，mtime/size 从 fileStats 取，取不到为 0）。 */
function buildById(
  headers: Entry[],
  fileStats: Map<string, { mtime: number; size: number }>,
): Map<string, SessionRef> {
  const byId = new Map<string, SessionRef>()
  for (const h of headers) {
    const stat = fileStats.get(h.id)
    const ref: SessionRef = {
      sessionId: h.id,
      fileName: '', // 占位空串：family 路径不回填（enrichRefs 已删除，ext-simplify-04 U4）
      mtime: stat?.mtime ?? 0,
      sizeBytes: stat?.size ?? 0,
      cwd: h.cwd ?? '',
    }
    if (h.parentSession) ref.parentSession = h.parentSession
    byId.set(h.id, ref)
  }
  return byId
}

/**
 * 阶段 2：childrenOf——parentSession（文件路径）→ 反查父 sessionId → key 用父 sessionId。
 * 反查不到父 → 无法建反查关系，跳过（不报错，design §2 容错）。
 */
function buildChildrenOf(
  headers: Entry[],
  byId: Map<string, SessionRef>,
): Map<string, SessionRef[]> {
  const childrenOf = new Map<string, SessionRef[]>()
  for (const h of headers) {
    if (!h.parentSession) continue
    const parentSid = resolveParentSessionId(h.parentSession, byId)
    if (parentSid === null) continue // 反查不到父 → 无法建反查关系，跳过
    const childRef = byId.get(h.id)
    if (!childRef) continue
    const list = childrenOf.get(parentSid) ?? []
    list.push(childRef)
    childrenOf.set(parentSid, list)
  }
  return childrenOf
}

/**
 * 阶段 3：subagentIdentities → subagentsByRoot。
 * 坏数据（缺 rootSessionId/slug）跳过，不报错（design §2 容错）。
 */
function buildSubagentsByRoot(
  subagentIdentities: Entry[],
  fileStats: Map<string, { mtime: number; size: number }>,
): Map<string, SubagentRef[]> {
  const subagentsByRoot = new Map<string, SubagentRef[]>()
  for (const ident of subagentIdentities) {
    if (!isSubagentIdentityData(ident.data)) continue // 坏数据（缺 rootSessionId/slug）跳过
    const stat = fileStats.get(ident.id)
    const ref: SubagentRef = {
      // M1 占位：identity entry 不含 subagent session 的 id，用 entry.id 顶替；
      // M2 discovery 读 subagent 文件首行 header.id 得到真实 subagent sessionId
      sessionId: ident.id,
      rootSessionId: ident.data.rootSessionId,
      slug: ident.data.slug,
      fileName: '', // M1 占位
      mtime: stat?.mtime ?? 0,
      sizeBytes: stat?.size ?? 0,
      cwd: '', // identity entry 无 cwd；family 路径不回填（enrichRefs 已删除，ext-simplify-04 U4）
      // fileStats key=sessionId（buildFamilyFromFs 以 header.id 写入），cleanedUp 按 sessionId 命中
      cleanedUp: !fileStats.has(ident.id),
      // U4 富字段：从 identity data 读（manifest 主/P-fallback 由 buildFamilyFromFs 组装时决定）
      task: ident.data.task,
      // 异名映射：identity.data.agent ↔ manifest.agentName（buildFamilyFromFs 组装时统一到 data.agent）
      agentName: ident.data.agent,
      model: ident.data.model,
      status: ident.data.status,
      sessionFile: ident.data.sessionFile,
    }
    const list = subagentsByRoot.get(ident.data.rootSessionId) ?? []
    list.push(ref)
    subagentsByRoot.set(ident.data.rootSessionId, list)
  }
  return subagentsByRoot
}

/**
 * 从已读入的 session headers + subagent identity entries 建家族索引（纯逻辑，无 IO）。
 *
 * - headers（type=session）→ byId + childrenOf（parentSession 文件路径反查父 sessionId）
 * - subagentIdentities（type=custom, customType=subagent-identity）→ subagentsByRoot
 * - fileStats 原样存入 index，供 cleanedUp 判断
 * - zcodeNodes（可选，U6）→ zcode subagent 节点并入 subagentsByRoot（D5-1 判据，
 *   与 pi 判据不同构；不传 = pi 行为逐字节不变——零涟漪）
 *
 * 坏数据容错：identity 缺 rootSessionId/slug 跳过；parentSession 反查不到父（父文件
 * 未被扫描到）该 entry 不进 childrenOf——均不报错，符合 pi 坏 session 容错（design §2）。
 */
export function buildFamilyIndex(
  headers: Entry[],
  subagentIdentities: Entry[],
  fileStats: Map<string, { mtime: number; size: number }>,
  zcodeNodes?: readonly ZcodeFamilyNode[],
): FamilyIndex {
  const byId = buildById(headers, fileStats)
  const childrenOf = buildChildrenOf(headers, byId)
  const subagentsByRoot = buildSubagentsByRoot(subagentIdentities, fileStats)
  if (zcodeNodes !== undefined && zcodeNodes.length > 0) {
    const zcodeByRoot = buildZcodeSubagentsByRoot(zcodeNodes)
    for (const [rootId, refs] of zcodeByRoot) {
      const existing = subagentsByRoot.get(rootId)
      if (existing) existing.push(...refs)
      else subagentsByRoot.set(rootId, refs)
    }
  }
  return { byId, childrenOf, subagentsByRoot, fileStats }
}

/**
 * 解析某 session 的家族。
 *
 * 隔代关联规则（design §3.3 D-7 Q1，核心）：subagent 的 rootSessionId 指向其**直接
 * 发起 session**，可能是 fork 链中间节点而非家族根。故不能只查 root 的 subagentsByRoot——
 * 会漏隔代 subagent（从家族根出发会漏掉挂在 fork 子代下的 subagent）。
 *
 * 实现：建好 fork 链后，对链上**每个**节点 id（root + 所有 parents + 直接 forks）
 * 查 subagentsByRoot，按 sessionId 去重合并。
 *
 * 范围限定：M1 的 chainIds 只含直接 forks（childrenOf[root]），不递归孙代——
 * 多层 fork 后代上的 subagent 递归关联不在 M1 范围（Q1 真实场景为单层 fork）。
 *
 * @throws session 不在 index.byId 时抛 Error
 */
export function resolveFamily(sessionId: string, index: FamilyIndex): Family {
  const root = index.byId.get(sessionId)
  if (!root) {
    throw new Error(
      `session not found in family index: "${sessionId}". ` +
        `Ensure buildFamilyIndex received this session's header entry (type=session, id="${sessionId}").`,
    )
  }

  // 2. fork 父链 parents（root 沿 parentSession 往上，最近在前）
  const parents: SessionRef[] = []
  {
    const seen = new Set<string>([root.sessionId]) // 环防御（坏数据 A→B→A）
    let cur: SessionRef = root
    while (cur.parentSession) {
      const parentSid = resolveParentSessionId(cur.parentSession, index.byId)
      if (parentSid === null) break // 反查不到父 → 链断
      const parentRef = index.byId.get(parentSid)
      if (!parentRef) break // 父不在 byId（未扫描到）→ 链断
      if (seen.has(parentSid)) break // 环防御
      seen.add(parentSid)
      parents.push(parentRef)
      cur = parentRef
    }
  }

  // 3. fork 直接子代
  const forks: SessionRef[] = index.childrenOf.get(root.sessionId) ?? []

  // 4. 隔代 subagent：对 fork 链每个节点 id 查 subagentsByRoot，按 sessionId 去重合并
  const chainIds = new Set<string>([root.sessionId])
  for (const p of parents) chainIds.add(p.sessionId)
  for (const f of forks) chainIds.add(f.sessionId)

  const subagents: SubagentRef[] = []
  const seenSubagent = new Set<string>()
  for (const sid of chainIds) {
    const subs = index.subagentsByRoot.get(sid)
    if (!subs) continue
    for (const s of subs) {
      if (seenSubagent.has(s.sessionId)) continue
      seenSubagent.add(s.sessionId)
      subagents.push(s)
    }
  }

  // 5. workflows：M1 恒 []，workflow 腿需读 workflow-state 文件（IO）归 M2
  const workflows: WorkflowRef[] = []

  return { root, parents, forks, subagents, workflows }
}

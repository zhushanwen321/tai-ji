import { readFile, readdir, open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { Entry } from '../core/parser.js'
import type { Family, SessionRef } from '../core/family.js'
import { buildFamilyIndex, resolveFamily } from '../core/family.js'
import { resolveSessionRoots, type SessionFileMeta } from './roots.js'
import { parseSessionHeader, readSessionHeaderFirstLine } from './session-header.js'
import { resolveWorkflows } from './workflows.js'

/**
 * [M2 discovery] 从文件系统构建某 session 的完整家族（IO 适配层）。
 *
 * 组合 M1 family 纯逻辑（buildFamilyIndex/resolveFamily）+ 真实文件读取。零 pi 依赖
 *（node:fs + 相对 import M1 core + M2 roots），同 roots/find，可完全单测。
 *
 * 关键衔接点（探查确认，详见各步骤注释）：
 * - identity 在 subagent 文件 **尾行**（非首行；design §3.3 D-7 "尾部"，实测 019fe635
 *   的 identity 在 71/71 行）。故 header 读首行、identity 读尾行，两次定长读。
 * - identity id 修正：M1 用 identity entry.id（=data.id 的 sa-xxx 占位）作 SubagentRef.sessionId。
 *   M2 用 subagent 文件首行 header.id（真实 session id）替换之，使 SubagentRef.sessionId
 *   是真实 id，Q1 隔代关联仍用 data.rootSessionId（不变）。
 * - cleanedUp：subagent 文件被 30 天 TTL GC 后，identity（在文件尾）一并消失。唯一残留痕迹
 *   是 records/<sa-id>.json manifest（终态 finalize 或 sync 批落标出口写入——subagent
 *   创建时不写，两写点均先于 30 天 GC 落盘，故 GC 后必残留）。manifest 是孤儿/
 *   cleanedUp 的来源（design §3.3 D-7 "records/*.json manifest 作孤儿补充"）。
 * - workflows：M1 resolveFamily 恒返回 []。M2 在此单独读目标 session 的 workflow-state-link
 *   custom entry → link.data.path（wf-state 文件绝对路径）→ 从文件尾向头找首个非空且
 *   JSON.parse 成功的行（最新快照，容错尾半截 JSON）取 calls。
 *
 * @throws sessionId 不在任意 main session header → Error（M3 tool-adapter 层转 F1 恢复指引）
 */
export async function buildFamilyFromFs(sessionId: string, agentDir: string): Promise<Family> {
  // ---- 0. record manifest 索引（U4：sessionFile → manifest，供 alive 扫描查富字段）----
  // manifest 主路径：alive 文件的 meta.path 命中索引 → 透 task/slug/model/status/sessionFile 全字段。
  // 索引未命中（场景 A：嵌套 subagent 的 manifest 不在当前 agentDir，11.5%）走 P-fallback 回退 identity。
  const manifests = await listRecordManifests(agentDir)
  const manifestBySessionFile = indexManifestsBySessionFile(manifests)

  // ---- 1-3. 逐阶段扫描（main → subagent → 孤儿 manifest），累积器显式传递 ----
  const scan: FamilyFsScan = {
    headers: [],
    identities: [],
    fileStats: new Map(),
    sessionIdToPath: new Map(),
    pathToRef: new Map(),
    aliveSubPaths: new Set(),
  }
  await collectMainSessions(agentDir, scan)
  await collectSubagentIdentities(agentDir, manifestBySessionFile, scan)
  appendOrphanIdentities(manifests, scan)

  // ---- 4-5. build index + resolve（sessionId 不在 byId → resolveFamily 抛 Error）----
  if (!scan.sessionIdToPath.has(sessionId)) {
    throw new Error(await formatSessionNotFound(sessionId, agentDir))
  }
  const index = buildFamilyIndex(scan.headers, scan.identities, scan.fileStats)
  const family = resolveFamily(sessionId, index)

  // ---- 6. workflows（enrichRefs 回填已删除，ext-simplify-04 U4/E2：fileName/cwd 占位
  //      零文本读者，family 路径维持 core 层占位空串；富字段的消费者 = formatFamilyText 展示）----
  family.workflows = await resolveWorkflows(sessionId, scan.sessionIdToPath, scan.pathToRef)

  return family
}

// ============================================================
// buildFamilyFromFs 扫描阶段 helpers（各阶段显式传入累积器，插入顺序 = 原实现顺序）
// ============================================================

/**
 * not-found 错误文案：列出实际扫描过的 main 候选根（U1 并入部分，design §6.1 自证能力
 * ——「没有这条 session」与「根配错了」必须可区分，错误信息携带发现层内部状态）。
 * 仅失败路径调用，额外一次 resolveSessionRoots 的扫描成本可接受；根过滤条件与
 * collectMainSessions 实扫集合一致（agentDir 信号包下未去重的 main 根）。
 */
async function formatSessionNotFound(sessionId: string, agentDir: string): Promise<string> {
  // subagents:'stat'——本路径只渲染 main 根行，subagent 根不做深扫（ext-simplify-04 A2：
  // 原默认 'scan' 白扫整个 subagent 根后 filter 丢弃）
  const mainRoots = (await resolveSessionRoots({ agentDir }, { subagents: 'stat' })).filter(
    (r) => r.source === 'main' && r.dedupedInto === undefined,
  )
  const lines = mainRoots.map((r) => {
    const state = r.exists ? `${r.fileCount} file(s)` : 'not exists'
    return `  - ${r.path} [${r.kind}] ${state}`
  })
  return (
    `session "${sessionId}" not found. Scanned ${mainRoots.length} main candidate root(s):\n` +
    `${lines.join('\n')}\n` +
    `No main session file whose first-line header id matches. ` +
    `Verify the sessionId or agentDir; for partial uuid, use findSessions first.`
  )
}

/** buildFamilyFromFs 各扫描阶段的共享累积器（主函数创建，各阶段 helper 显式传入并写入） */
interface FamilyFsScan {
  /** main session headers（buildFamilyIndex byId/childrenOf 素材） */
  headers: Entry[]
  /** subagent identity entries（步骤 2 富化 + 步骤 3 孤儿） */
  identities: Entry[]
  /** sessionId → { mtime, size }（buildFamilyIndex 存活判定素材） */
  fileStats: Map<string, { mtime: number; size: number }>
  /** sessionId → 真实文件路径，供 workflows 找目标文件 */
  sessionIdToPath: Map<string, string>
  /** path → 完整 SessionRef（含真实 cwd/fileName/mtime/size），供 workflow calls 反查 */
  pathToRef: Map<string, SessionRef>
  /** 已扫描到的 subagent 文件路径集合，供 manifest 孤儿判定（alive 则跳过 manifest） */
  aliveSubPaths: Set<string>
}

/** manifest 按 sessionFile 建索引（alive 文件的 meta.path 命中 → 走 manifest 主路径） */
function indexManifestsBySessionFile(manifests: RecordManifest[]): Map<string, RecordManifest> {
  const manifestBySessionFile = new Map<string, RecordManifest>()
  for (const m of manifests) manifestBySessionFile.set(m.sessionFile, m)
  return manifestBySessionFile
}

/** 步骤 1：main sessions —— 首行 header → headers + fileStats + 路径反查 */
async function collectMainSessions(agentDir: string, scan: FamilyFsScan): Promise<void> {
  // A3（ext-simplify-04）：直调 resolveSessionRoots + filter（原 listMainSessions 薄包装
  // 已删除）——agentDir 信号包下 main 源未去重根（[default]+[legacy]，被 [live] 去重的除外）的文件并集
  const mainMetas = (await resolveSessionRoots({ agentDir }))
    .filter((r) => r.source === 'main' && r.dedupedInto === undefined)
    .flatMap((r) => r.files)
  for (const meta of mainMetas) {
    const h = parseSessionHeader(await readSessionHeaderFirstLine(meta.path))
    if (!h) continue // 非 session/坏 header → 跳过（不入 byId）
    const entry: Entry = { type: 'session', id: h.id, parentId: null, cwd: h.cwd ?? '' }
    if (h.parentSession) entry.parentSession = h.parentSession
    scan.headers.push(entry)
    scan.fileStats.set(h.id, { mtime: meta.mtime, size: meta.size })
    scan.sessionIdToPath.set(h.id, meta.path)
    const ref: SessionRef = {
      sessionId: h.id,
      fileName: meta.path,
      mtime: meta.mtime,
      sizeBytes: meta.size,
      cwd: h.cwd ?? '',
    }
    if (h.parentSession) ref.parentSession = h.parentSession
    scan.pathToRef.set(meta.path, ref)
  }
}

/** identity data 组装（manifest 主，TC-u4-manifest-enrich）：透 task/slug/model/status/sessionFile 全字段 */
function manifestIdentityData(manifest: RecordManifest): Record<string, unknown> {
  return {
    rootSessionId: manifest.rootSessionId,
    slug: manifest.slug ?? '', // slug 兼容旧 manifest（缺→空串兜底，m0 契约）
    task: manifest.task,
    agent: manifest.agentName, // 同语义异名：manifest.agentName ↔ identity.data.agent
    model: manifest.model,
    status: manifest.status,
    sessionFile: manifest.sessionFile,
  }
}

/** identity data 组装（P-fallback，ES-p-fallback-no-manifest）：identity 回退取 task/slug/agent */
function fallbackIdentityData(
  meta: SessionFileMeta,
  ident: TailIdentity,
): Record<string, unknown> {
  return {
    rootSessionId: ident.rootSessionId,
    slug: ident.slug,
    task: ident.task,
    agent: ident.agent,
    // model/status 不可回退（identity 无，探针 15/15），留 undefined
    sessionFile: meta.path,
  }
}

/** 步骤 2：subagent sessions —— 首行 header（真实 id）+ manifest 主/identity 回退 → 富字段 identity */
async function collectSubagentIdentities(
  agentDir: string,
  manifestBySessionFile: Map<string, RecordManifest>,
  scan: FamilyFsScan,
): Promise<void> {
  // U4 数据流：manifest 命中透全字段；未命中 P-fallback 读尾行 identity 取 task/slug/agent
  //（model/status 不可回退，留 undefined）；无 manifest 无 identity（运行中/异常）跳过。
  // A3（ext-simplify-04）：直调 resolveSessionRoots（原 listSubagentSessions 薄包装已删除）
  //——agentDir 信号包下 [subagent] 根 = <agentDir>/subagents（常量推导，恒唯一）
  const subMetas =
    (await resolveSessionRoots({ agentDir })).find((r) => r.kind === 'subagent')?.files ?? []
  for (const meta of subMetas) {
    const h = parseSessionHeader(await readSessionHeaderFirstLine(meta.path))
    if (!h) continue // 非 session/坏 header → 无真实 session id，无法 id 修正，跳过
    const realId = h.id
    // header 可解析即视为 alive（MF-3）：identity 在文件尾行、完成时才写入，运行中的 subagent
    // 无 identity。若此处跳过，步骤 3 会把活文件（含其 manifest）当孤儿收编 → cleanedUp=true，
    // family 把活着的 subagent 显示成 [已清理]，真实 sessionId 永远无法关联。
    scan.aliveSubPaths.add(meta.path)

    // identity data 组装：manifest 主路径或 P-fallback identity 回退，二选一
    const manifest = manifestBySessionFile.get(meta.path)
    let data: Record<string, unknown>
    if (manifest) {
      data = manifestIdentityData(manifest)
    } else {
      // P-fallback（ES-p-fallback-no-manifest）：读尾行 identity 回退取 task/slug/agent
      const ident = await readTailIdentity(meta.path, meta.size)
      if (!ident) continue // 无 identity（ES-p-fallback-no-identity，运行中/异常）→ 跳过
      data = fallbackIdentityData(meta, ident)
    }
    // id 修正：entry.id 用真实 header.id 替换 sa-xxx 占位
    scan.identities.push({
      type: 'custom',
      id: realId,
      parentId: null,
      customType: 'subagent-identity',
      data,
    })
    scan.fileStats.set(realId, { mtime: meta.mtime, size: meta.size })
    scan.sessionIdToPath.set(realId, meta.path)
    scan.pathToRef.set(meta.path, {
      sessionId: realId,
      fileName: meta.path,
      mtime: meta.mtime,
      sizeBytes: meta.size,
      cwd: h.cwd ?? '',
    })
  }
}

/**
 * 步骤 3：records manifest → 孤儿（cleanedUp，ES-orphan-manifest）。
 * manifest 由终态 finalize / sync 批落标出口写入（创建时不写），.jsonl 被 GC 后仍
 * 残留。alive 的（sessionFile 已在步骤 2
 * 扫到）跳过；未扫到的 = 文件已 GC → 孤儿。用 manifest 完整富字段填 SubagentRef，
 * sessionFile 保留 manifest 的 GC 路径（不置空，供 LLM 知晓原位置），cleanedUp 由
 * buildFamilyIndex 的 !fileStats.has(ident.id) 判 true（ident.id=manifest.id 不在 fileStats）。
 */
function appendOrphanIdentities(manifests: RecordManifest[], scan: FamilyFsScan): void {
  for (const m of manifests) {
    if (scan.aliveSubPaths.has(m.sessionFile)) continue
    scan.identities.push({
      type: 'custom',
      id: m.id,
      parentId: null,
      customType: 'subagent-identity',
      data: {
        rootSessionId: m.rootSessionId,
        // 孤儿 slug 随文件 GC 丢失：优先 manifest.slug，回退 agentName（agent 类型名），再兜底空串
        slug: m.slug ?? m.agentName ?? '',
        task: m.task,
        agent: m.agentName, // 同语义异名映射
        model: m.model,
        status: m.status,
        sessionFile: m.sessionFile,
      },
    })
  }
}

// ============================================================
// 文件读取 helpers（定长 buffer，避免全文读：subagent 文件均 269KB、总量 ~923MB）
// 首行 header 读取/解析在 session-header.ts（D5 单源）；本文件仅保留尾行 identity 读取。
// ============================================================

/** 尾行 identity 读取 buffer 上限。identity 含完整 task 文本可达数 KB；实测 64KB 覆盖 3203/3430。 */
const TAIL_READ_BYTES = 65536

/** readTailIdentity 的成功返回形状（rootSessionId 必有，其余存在才带） */
type TailIdentity = {
  rootSessionId: string
  slug: string
  task?: string
  agent?: string
  parentRecordId?: string
}

/**
 * 读 subagent 文件尾部（最后 64KB）找 subagent-identity entry，返回 rootSessionId + slug + task + agent。
 *
 * identity 在文件尾行（探查确认；design §3.3 D-7 "尾部"）。用 lastIndexOf 定位最后一个
 * subagent-identity 标记（多次重写时取最新），提取该行边界内的 JSON 解析。identity 行
 * 超 64KB（极罕见，实测 1/3430）会截断 → 解析失败 → 返回 undefined（该 subagent 不收）。
 *
 * U4 扩展返回 task/agent（P-fallback 富化用）：从 identity.data.task / data.agent 提取，
 * 存在则带。model/status 在 identity 不存在（探针 15/15 无），P-fallback 时由调用方留 undefined。
 *
 * M3b 扩展（IF3 三级数据源 ②）：返回 parentRecordId（identity.data.parentRecordId，新版本
 * session-runner 才写；当前本机旧数据无此字段→undefined）。size 改 optional——buildFamilyFromFs
 * 传 size（已有 meta.size 省一次 stat），buildExecutionTree 不传 size（内部 stat 获取）。
 */
export async function readTailIdentity(
  path: string,
  size?: number,
): Promise<TailIdentity | undefined> {
  const resolvedSize = await resolveTailSize(path, size)
  if (resolvedSize === undefined) return undefined // 文件不存在/读失败 → undefined
  if (resolvedSize === 0) return undefined
  const text = await readTailText(path, resolvedSize)
  if (text === undefined) return undefined
  const line = extractTailIdentityLine(text, resolvedSize)
  if (line === undefined) return undefined
  return parseTailIdentityLine(line)
}

/** 尾读 size 解析：size 未传时内部 stat 获取（execution-tree.ts 复用时无 size）；stat 失败 → undefined */
async function resolveTailSize(path: string, size?: number): Promise<number | undefined> {
  if (size !== undefined) return size
  try {
    return (await stat(path)).size
  } catch {
    return undefined // 文件不存在/读失败 → undefined
  }
}

/** 读文件尾部 min(64KB, size) 字节为文本；打开/读取失败 → undefined */
async function readTailText(path: string, resolvedSize: number): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const len = Math.min(TAIL_READ_BYTES, resolvedSize)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, Math.max(0, resolvedSize - len))
    return buf.toString('utf8')
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * 从尾窗文本定位最后一个 subagent-identity 标记所在行（多次重写时取最新）。
 * 无标记 / 行首在读窗口外（identity 行 > 64KB，整行塞不下）→ undefined。
 */
function extractTailIdentityLine(text: string, resolvedSize: number): string | undefined {
  const idx = text.lastIndexOf('subagent-identity')
  if (idx < 0) return undefined
  const len = Math.min(TAIL_READ_BYTES, resolvedSize)
  // 行首若在读窗口外（identity 行 > 64KB，整行塞不下）→ 无法可靠解析，跳过
  const lineStartSearch = text.lastIndexOf('\n', idx)
  if (lineStartSearch < 0 && resolvedSize > len) return undefined
  const start = lineStartSearch < 0 ? 0 : lineStartSearch + 1
  let end = text.indexOf('\n', idx)
  if (end < 0) end = text.length
  return text.slice(start, end)
}

/** identity 行 → 富字段结果；JSON 损坏 / 缺 rootSessionId → undefined */
function parseTailIdentityLine(line: string): TailIdentity | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  const data = (raw as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined
  if (!data || typeof data.rootSessionId !== 'string') return undefined
  return {
    rootSessionId: data.rootSessionId,
    slug: typeof data.slug === 'string' ? data.slug : '',
    task: typeof data.task === 'string' ? data.task : undefined,
    agent: typeof data.agent === 'string' ? data.agent : undefined,
    parentRecordId:
      typeof data.parentRecordId === 'string' ? data.parentRecordId : undefined,
  }
}

// ============================================================
// records manifest（孤儿 / cleanedUp 来源）
// ============================================================

export interface RecordManifest {
  id: string
  rootSessionId: string
  agentName?: string
  /** subagent session.jsonl 绝对路径（manifest 写入时快照；文件 GC 后路径仍残留） */
  sessionFile: string
  /** subagent 任务文本（探针 20/20 全有；旧 manifest 缺→undefined） */
  task?: string
  /** slug 标签（探针 20/20 全有；旧 manifest 缺→undefined） */
  slug?: string
  /** 模型 id（探针 20/20 全有；旧 manifest 缺→undefined） */
  model?: string
  /** 终态 completed/failed/running（探针 20/20 全有；旧 manifest 缺→undefined） */
  status?: string
  /**
   * 直接父 subagent 的 record id（M3a 落盘镜像；depth=0 顶层 subagent 为 undefined）。
   *
   * session-reader 读侧镜像（IF2）：manifest 主路径透出，旧 manifest 缺此字段（undefined）。
   * isRecordManifest 校验不改（3 必填不变）。buildExecutionTree（core/execution-tree.ts）
   * 据此建精确父子链，三级数据源优先级 ①（DM4）。
   */
  parentRecordId?: string
}

function isRecordManifest(v: unknown): v is RecordManifest {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.rootSessionId === 'string' &&
    typeof o.sessionFile === 'string'
  )
}

/** 读单个 manifest 文件并校验；坏 manifest（JSON 损坏/缺必填字段）返回 undefined。 */
async function tryReadManifest(path: string): Promise<RecordManifest | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecordManifest(raw) ? raw : undefined
  } catch {
    return undefined // 坏 manifest 跳过，不中断整体扫描
  }
}

/**
 * 扫描 subagents/<cwdSlug>/records/*.json —— subagent 注册清单。
 * 每个 manifest 由终态 finalize 或 sync 批落标出口写入（创建时不写），持久存在即使
 * .jsonl 被 GC。坏 manifest（缺必填字段/JSON 损坏）跳过，不中断扫描。
 */
export async function listRecordManifests(agentDir: string): Promise<RecordManifest[]> {
  const root = join(agentDir, 'subagents')
  const out: RecordManifest[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限 → 静默返回
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile() && e.name.endsWith('.json') && basename(dir) === 'records') {
        const m = await tryReadManifest(full)
        if (m) out.push(m)
      }
    }
  }
  await walk(root)
  return out
}

// ============================================================
// 文件名 sessionId 提取（find.ts + discovery/workflows.ts 共用 helper）
// ============================================================
//
// workflow-state 发现链路（resolveWorkflows / extractCallSessionFiles /
// readRunSnapshot / sessionRefFromPath）已迁至 discovery/workflows.ts（w5 架构归位，
// SSOT §6.3 workflow 与 subagent 发现解耦）。本函数被 find.ts + workflows.ts 共用，
// 故留原位 export。

/** 从文件名（<timestamp>_<sessionId>.jsonl）提取 sessionId；非 uuid 特征返回空串。 */
export function extractSessionIdFromFilename(name: string): string {
  const noExt = name.replace(/\.jsonl.*$/, '')
  const idx = noExt.lastIndexOf('_')
  const candidate = idx >= 0 ? noExt.slice(idx + 1) : noExt
  return /^[0-9a-f-]{8,}$/i.test(candidate) ? candidate : ''
}

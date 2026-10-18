/**
 * SessionContentCascade — 删主会话的下挂内容事务性级联（单一清单入口）。
 *
 * 用户裁决（2026-10-12）：删主会话 = 事务性级联删除其下挂的一切内容。「偏事务性」=
 * 单一清单入口（本模块）、删前枚举完整、失败有汇总不留静默半态。
 *
 * 执行顺序（中断残留倾向 =「本体还在、下挂已清」的可恢复形态，而非孤儿下挂）：
 *   1. 引用并集判定：全池流式扫描 sessionsRoot 其余主会话文件的 subagent-record
 *      v2 条目（registered id ∪ settled id/sessionFile），fork 共享防护（E1 实锤：
 *      createForkedSessionFile 原样复制 record entries 且 settled.sessionFile 指向
 *      不变——fork 与源会话共享同一批子代理文件，rootSessionId 相等不是正确判据）。
 *   2. 删子代理文件族（仅引用并集清零的族，族内顺序 .jsonl → sidecars → manifest
 *      → .events → session-view）。
 *   3. 删 session-reader 导出物（<agentDir>/tmp/session-view-<sid>.md，A21）。
 *   4. 删后台任务 registry 目录（<agentDir>/base-tool-enhance/<sid>/，A23）——
 *      先 await 收殓（幂等双跑：removeSessionEntry 已 fire-and-forget 挂过一次，
 *      此处显式 await 收尾在途收殓，防删目录与终态写入竞态）再 rmSync。触发点
 *      天然收窄到真删除路径（restore 清场等 session 存活路径不经本模块，E8）。
 *   5. trash 主文件（rejection 原样上抛——G4：trash 失败必须让删除整体报失败，
 *      此时下挂已清、本体还在，重试删除即达终态）。
 *   6. 主文件 sidecars 清理（经 purgeMainSidecars 回调回到 session-lifecycle 的
 *      purgeSessionSidecars——infra 债务留在既有登记处，本模块不新增直引 infra）。
 *
 * 失败语义：每项删除 best-effort try/catch 但**失败必须汇总出声**（warn 逐项 +
 * 结束汇总计数），禁静默吞。枚举/并集扫描失败（读错误、坏行、oversize）=「引用
 * 状态不可知」≠「无引用」——保守放弃子代理族删除（宁保留，残留按裁决接受——
 * 无保留期扫描兜底，2026-10-12），与 collectAliveWorkflowRunReferences 的「缺席只延后删除」方向相反：
 * 那边缺席 → 观察期不删；这边缺席 → 若照删即误删共享文件，故必须反转。
 *
 * 已有级联（不重做，本模块之外）：主文件+sidecars / btw 线目录（closeAllForMain）/
 * artifacts-attachments-cache-images（purgeSessionSidecars）/ 终端 PTY
 * （terminal-service destroySessionPties）。
 *
 * btw 树豁免的成立前提：步骤 2 的引用并集扫描根只覆盖 sessionsRoot（sessions 树），
 * 不覆盖 btw 线树 `<piAgentDir>/btw/<encodeCwd>/<mainSid>/`（布局见 infra/pi/pi-paths.ts
 * getBtwRoot）。若 btw 线引用了子代理文件族，本模块的并集防护看不见该引用——不误删
 * 依赖一个模块外组合事实：deleteSession 尾部同批 closeAllForMain 杀线 + 删线目录
 * （session-lifecycle.ts，漏删线目录由启动孤儿补账 reconcileOrphanThreadDirs 兜底），
 * 即主删时 btw 线同批消亡、不存在「线仍存活引用子代理族而扫描看不见」的窗口。未来
 * btw 删除时序与主删解耦（closeAllForMain 移出 deleteSession 同批 / 异步延迟删线）时，
 * 扫描根必须扩为 sessions ∪ btw 两树，否则构成共享族误删风险。
 */

import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  RECORD_EVENTS_SUFFIX,
  SUBAGENT_RECORD_CUSTOM_TYPE,
  classifySubagentRecordEntryData,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from '@zhushanwen/subagent-core'
import { isEnoent } from '../../utils/errors.js'

/** subagent-record v2 条目的判别联合（barrel 未导出联合别名，按 kind 分支的两侧条目类型同源组装）。 */
type SubagentRecordEntry = SubagentRecordRegisteredEntryData | SubagentRecordSettledEntryData

/**
 * 子代理会话文件族 sidecar 扩展名名单——本名单是这些 sidecar 的唯一删除点
 * （删主会话级联；外部删除主文件场景接受残留，2026-10-12 裁决）。
 *
 * 现役/退场锚定（防名单与 subagent-core 写点漂移）：
 * - `.record-binding` = 现役绑定 sidecar，写点单一入口 subagent-core
 *   `state-marker.ts` 的 `RECORD_BINDING_SIDECAR_EXT`（该侧注释反向锚定本名单）；
 * - `.alive` = 现役操作租约，写点单一入口 subagent-core `alive-store.ts` 的
 *   `writeAliveMarker`；
 * - `.state` / `.finalized` / `.cancelled` = 写侧已退场的旧收条 sidecar（收条改由
 *   record 事件帧承载，state-marker.ts 头注），保留在名单清理升级前的旧产物残留。
 * 新增 sidecar 后缀时在 subagent-core 写点与本名单同步。
 */
const SUBAGENT_SESSION_SIDECAR_EXTS: readonly string[] = [
  '.record-binding',
  '.alive',
  '.state',
  '.cancelled',
  '.finalized',
]


/** session-reader 导出物目录（tool-handler.ts doExport 的 outDir：`<agentDir>/tmp`）。 */
const SESSION_VIEW_TMP_DIRNAME = 'tmp'

/** base-tool-enhance 后台任务 registry 根目录名（extension-protocol BASE_TOOL_ENHANCE_DIRNAME 同字面；目录级联删除只需根名）。 */
const BASE_TOOL_ENHANCE_DIRNAME = 'base-tool-enhance'

/**
 * record id 白名单：与 subagent-core record-events.ts 的 RECORD_ID_PATTERN 同式
 * （`[\w-]` + 长度 ≤128；该常量模块私有未导出）。record id 生产源 = sa-<uuid>，
 * 字符集 ⊆ 白名单；白名单排除 "." ".." 与路径分隔符，防主会话 JSONL 内被污染的
 * id 字段构造路径穿越。
 */
const RECORD_ID_PATTERN = /^[\w-]{1,128}$/

/** sessionId 目录名白名单（A23 目录名直接拼 join——RPC 来的 sid 先过穿越校验）。 */
const SESSION_ID_PATTERN = /^[\w-]{1,128}$/

// ── 输入 / 依赖 / 结果 ────────────────────────────────────────────────────────

export type SessionContentCascadeInput = {
  /** 被删主会话 id（A21/A23 文件名与目录名推导源）。 */
  sessionId: string
  /** 被删主会话 JSONL 绝对路径（子代理锚枚举源）。 */
  sessionFilePath: string
  /** pi agent 数据目录（subagents / tmp / base-tool-enhance 三族的根）。 */
  agentDir: string
  /** 主会话文件全池扫描根（`<agentDir>/sessions` 同布局：slug 子目录内 *.jsonl）。 */
  sessionsRoot: string
  /**
   * active 分支语义：true = 主文件已不存在时整体零动作（现行 purgeActiveSessionFile
   * 检查「外部已删则整体零动作」）；false = scanned 分支语义（主文件不存在仍清孤儿
   * sidecar，A21/A23 照清——session-view 与后台任务目录不依赖主文件内容）。
   */
  skipIfMainFileMissing: boolean
}

/** 依赖注入范围（全部可注入——测试 zero mock-module、零真实数据目录）。 */
export interface SessionContentCascadeDeps { // oe-exempt:20261012:framework:级联依赖注入范围（lifecycle 组装注入 + 测试 fake，DI 端口先立单实现常态）
  /** 主文件移入废纸篓（现行 sessionStore.trash；rejection 原样上抛，G4 语义）。 */
  trash: (filePath: string) => Promise<void>
  /** 主文件 sidecars 清理（session-lifecycle.purgeSessionSidecars 回调注入）。 */
  purgeMainSidecars: (filePath: string) => void
  /** A23 前置收殓（现行 reapSessionBackgroundTasks；幂等，双跑无害）。 */
  reapBackgroundTasks: (agentDir: string, sessionId: string) => Promise<unknown>
  /** 汇总出声通道（生产 console.warn；测试收集断言）。 */
  warn: (message: string) => void
}

export type SessionContentCascadeResult = {
  /** 主文件在级联开始时是否存在。 */
  mainFileExisted: boolean
  /** 引用并集扫描状态：skipped（主文件缺失未枚举）/ ok / failed（保守放弃子代理族）。 */
  referenceScan: 'skipped' | 'ok' | 'failed'
  /** 已删除的子代理文件族数（按 id 计）。 */
  subagentFamiliesDeleted: number
  /** 因被其他主会话引用而保留的子代理文件族数（fork 共享防护命中）。 */
  subagentFamiliesProtected: number
  /** 失败项描述（已逐项 warn，此处供调用方/测试核对）。 */
  failures: string[]
}

// ── 锚集合（被删主会话的子代理引用锚）─────────────────────────────────────────

/** 单个候选族：record id + 可选 settled sessionFile 锚（已过树内校验）。 */
type SubagentFamilyCandidate = {
  id: string
  sessionFile?: string
}

/** 引用并集：仍被其他主会话文件引用的 id 集 + sessionFile 集（resolve 归一后）。 */
type AliveReferenceUnion = {
  ids: Set<string>
  sessionFiles: Set<string>
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 删主会话的下挂内容级联（完整清单与执行顺序见文件头）。delete 真删除路径专用：
 * restore 清场 / forceQuit / pi 崩溃等 session 存活路径禁止接入（E8——存活 session
 * 的 session-view 导出物与后台任务 registry 必须原样存活）。
 */
export async function cascadeDeleteSessionContent(
  input: SessionContentCascadeInput,
  deps: SessionContentCascadeDeps,
): Promise<SessionContentCascadeResult> {
  const { sessionId, sessionFilePath, agentDir, sessionsRoot, skipIfMainFileMissing } = input
  const failures: string[] = []
  const mainFileExisted = existsSync(sessionFilePath)
  const result: SessionContentCascadeResult = {
    mainFileExisted,
    referenceScan: 'skipped',
    subagentFamiliesDeleted: 0,
    subagentFamiliesProtected: 0,
    failures,
  }
  if (!mainFileExisted && skipIfMainFileMissing) {
    return result // active 分支原语义：外部已删则整体零动作
  }

  if (mainFileExisted) {
    // 1. 枚举被删主会话的子代理锚（读主文件解析 subagent-record v2 entries）
    const candidates = collectSubagentFamilyCandidates(sessionFilePath, failures, deps.warn)
    // 2. 引用并集判定（fork 共享防护；扫描失败 = 引用状态不可知 → 全族保留）
    const union = collectAliveReferenceUnion(sessionsRoot, sessionFilePath, deps.warn)
    result.referenceScan = union === null ? 'failed' : 'ok'
    if (union === null) {
      const msg = `[session-content-cascade] reference union scan failed for ${sessionId}; ` +
        `keeping ALL subagent families (reference state unknown — never delete on unknown), ` +
        `residuals are accepted (no retention sweep by ruling 2026-10-12). Fix: inspect the sessions pool for unreadable/corrupt .jsonl files.`
      deps.warn(msg)
      failures.push('reference union scan failed (all subagent families kept)')
    } else {
      // 3. 删子代理文件族（.jsonl → sidecars → manifest → .events → session-view）
      deleteSubagentFamilies(candidates, union, { agentDir }, result, deps)
    }
  }

  // 4. A21：session-reader 导出物（主会话的；子代理的在各族内顺带删）
  removeSessionViewExport(join(agentDir, SESSION_VIEW_TMP_DIRNAME, `session-view-${sessionId}.md`), failures, deps.warn)

  // 5. A23：后台任务 registry 目录（先收殓后删目录——收尾在途收殓，防竞态）
  await removeBackgroundTaskRegistryDir(agentDir, sessionId, deps)

  // 6. trash 主文件（rejection 上抛：下挂已清、本体还在的可恢复形态）
  if (mainFileExisted) {
    await deps.trash(sessionFilePath)
  }

  // 7. 主文件 sidecars（scanned 分支主文件缺失时也照清孤儿 sidecar——原语义保持）
  deps.purgeMainSidecars(sessionFilePath)

  // 汇总出声（失败必出声；成功+有删除也留一行观测范围）
  if (failures.length > 0) {
    deps.warn(`[session-content-cascade] cascade finished with ${failures.length} failure(s) for session ${sessionId} ` +
      `(familiesDeleted=${result.subagentFamiliesDeleted} familiesProtected=${result.subagentFamiliesProtected}); ` +
      `failures: ${failures.join(' | ')}`)
  } else if (result.subagentFamiliesDeleted > 0 || result.subagentFamiliesProtected > 0) {
    deps.warn(`[session-content-cascade] cascade ok for session ${sessionId}: ` +
      `familiesDeleted=${result.subagentFamiliesDeleted} familiesProtected=${result.subagentFamiliesProtected} failures=0`)
  }
  return result
}

// ── 1. 被删主会话的子代理锚枚举 ────────────────────────────────────────────────

/**
 * 读被删主会话文件，解析 subagent-record v2 条目为候选族清单。
 *
 * 读通道 = scanRecordFamilyEntries 同款行预过滤流式扫描的收窄形态（本模块自持：
 * 并集扫描需要「坏行即保守失败」的更严语义，共用读骨架会继承「坏行跳过」的宁删
 * 方向）。枚举失败（读错误 / oversize）返回空清单 + failed 记录——后续子代理族
 * 删除自然 no-op（宁保留方向：枚举不出来 = 一个都不删）。
 */
function collectSubagentFamilyCandidates(
  sessionFilePath: string,
  failures: string[],
  warn: (message: string) => void,
): SubagentFamilyCandidate[] {
  let lines: string[]
  try {
    lines = readFileSync(sessionFilePath, 'utf8').split('\n')
  } catch (e: unknown) {
    const msg = `[session-content-cascade] session file unreadable, skipping subagent family enumeration (keep-all): ${sessionFilePath}`
    warn(`${msg}: ${toMessage(e)}`)
    failures.push(`session file unreadable: ${toMessage(e)}`)
    return []
  }
  const byId = new Map<string, SubagentFamilyCandidate>()
  for (const line of lines) {
    const entry = parseSubagentRecordLine(line)
    if (entry === null) continue
    byId.set(entry.id, entry)
  }
  return [...byId.values()]
}

/**
 * 单行 → subagent-record 候选（type/customType/classify 逐层检查；非命中返回 null）。
 * 坏 id / 坏 sessionFile（白名单外 / 树外）丢弃该项并 console.warn（不可信源字段，
 * 对齐 session-records.ts 的 sessionFile 树内校验先例）。
 */
function parseSubagentRecordLine(line: string): SubagentFamilyCandidate | null {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.includes(SUBAGENT_RECORD_CUSTOM_TYPE)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null // 被删主会话内的坏行：该行锚丢失 = 残留（宁保留），不失败
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as { type?: unknown; customType?: unknown; data?: unknown }
  if (rec.type !== 'custom' || rec.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return null
  const classification = classifySubagentRecordEntryData(rec.data)
  if (!classification.ok) return null
  const entry: SubagentRecordEntry = classification.entry
  if (typeof entry.id !== 'string' || !RECORD_ID_PATTERN.test(entry.id)) return null
  if (entry.kind === 'settled' && typeof entry.sessionFile === 'string' && isAbsolute(entry.sessionFile)) {
    return { id: entry.id, sessionFile: entry.sessionFile }
  }
  return { id: entry.id }
}

// ── 2. 引用并集判定（fork 共享防护）───────────────────────────────────────────

/**
 * 全池流式扫描 sessionsRoot 其余主会话文件的 subagent-record 引用并集。
 *
 * 形态参照 subagent-workflow extension 的 collectAliveWorkflowRunReferences（sessions
 * 根 + 全 slug 子目录 *.jsonl，逐行 JSON.parse），两处差异：
 * - 收集侧：那边 workflow-record 三代；这边 subagent-record v2（registered id /
 *   settled id+sessionFile）。
 * - 失败语义反转（文件头已述）：任何文件读失败 / 坏行 → 返回 null（引用状态不可知），
 *   调用方放弃全部子代理族删除。
 *
 * @returns null = 扫描失败（不可知）；并集 = 成功（可含空集）。
 */
function collectAliveReferenceUnion(
  sessionsRoot: string,
  excludedSessionFilePath: string,
  warn: (message: string) => void,
): AliveReferenceUnion | null {
  const union: AliveReferenceUnion = { ids: new Set(), sessionFiles: new Set() }
  let slugDirs: string[]
  try {
    slugDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => join(sessionsRoot, ent.name))
  } catch (e: unknown) {
    if (!isEnoent(e)) {
      warn(`[session-content-cascade] sessions root unreadable, reference union unknown: ${toMessage(e)}`)
      return null
    }
    return union // 从未落盘的合法空态
  }
  const excluded = resolve(excludedSessionFilePath)
  for (const dir of slugDirs) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch (e: unknown) {
      warn(`[session-content-cascade] slug dir unreadable, reference union unknown: ${dir} (${toMessage(e)})`)
      return null
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dir, file)
      if (resolve(filePath) === excluded) continue
      if (!scanFileIntoUnion(filePath, union, warn)) return null
    }
  }
  return union
}

/** 单文件引用收集（false = 该文件不可读/含坏行，引用状态不可知）。 */
function scanFileIntoUnion(filePath: string, union: AliveReferenceUnion, warn: (message: string) => void): boolean {
  let lines: string[]
  try {
    lines = readFileSync(filePath, 'utf8').split('\n')
  } catch (e: unknown) {
    warn(`[session-content-cascade] session file unreadable during reference scan, union unknown: ${filePath} (${toMessage(e)})`)
    return false
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.includes(SUBAGENT_RECORD_CUSTOM_TYPE)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 坏行可能是 subagent-record 条目（预过滤已命中子串）：引用状态不可知，保守失败
      warn(`[session-content-cascade] malformed line in ${filePath} inside a subagent-record candidate line; reference union unknown`)
      return false
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const rec = parsed as { type?: unknown; customType?: unknown; data?: unknown }
    if (rec.type !== 'custom' || rec.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) continue
    const classification = classifySubagentRecordEntryData(rec.data)
    if (!classification.ok) continue
    const entry: SubagentRecordEntry = classification.entry
    if (typeof entry.id === 'string') union.ids.add(entry.id)
    if (entry.kind === 'settled' && typeof entry.sessionFile === 'string') {
      union.sessionFiles.add(resolve(entry.sessionFile))
    }
  }
  return true
}

// ── 3. 子代理文件族删除 ───────────────────────────────────────────────────────

type SubagentFamilyDeleteContext = {
  agentDir: string
}

/**
 * 逐候选族删除（引用并集命中任一锚 → 整族保留：fork 复制完整条目对，id 与
 * sessionFile 同被引用，整族共享是 fork 的实际语义；半删会留 .jsonl 在 manifest
 * 消失的半态）。族内顺序 .jsonl → sidecars → manifest → .events → session-view。
 */
function deleteSubagentFamilies(
  candidates: SubagentFamilyCandidate[],
  union: AliveReferenceUnion,
  ctx: SubagentFamilyDeleteContext,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): void {
  for (const candidate of candidates) {
    // 不可信源字段终检（枚举侧已滤，此处防后续名单演化绕过）
    if (!RECORD_ID_PATTERN.test(candidate.id)) {
      result.failures.push(`subagent record id failed whitelist, family skipped: ${candidate.id}`)
      deps.warn(`[session-content-cascade] record id failed whitelist, family skipped: ${candidate.id}`)
      continue
    }
    const sessionFileOk = candidate.sessionFile !== undefined && isStrictlyUnder(join(ctx.agentDir, 'subagents'), candidate.sessionFile)
    if (candidate.sessionFile !== undefined && !sessionFileOk) {
      result.failures.push(`settled sessionFile escaped subagents root, family skipped: ${candidate.id}`)
      deps.warn(`[session-content-cascade] settled sessionFile escaped subagents root, family skipped (id=${candidate.id}): ${candidate.sessionFile}`)
      continue
    }
    // 引用并集保护（fork 共享防护：任一锚被引用 → 整族保留）
    const referenced = union.ids.has(candidate.id) ||
      (candidate.sessionFile !== undefined && union.sessionFiles.has(resolve(candidate.sessionFile)))
    if (referenced) {
      result.subagentFamiliesProtected++
      continue
    }
    deleteOneFamily(candidate, sessionFileOk ? candidate.sessionFile : undefined, ctx.agentDir, result, deps)
  }
}

/** 删单个候选族的全部文件（每项 best-effort，失败逐项入 failures 不中断族内其余项）。 */
function deleteOneFamily(
  candidate: SubagentFamilyCandidate,
  sessionFile: string | undefined,
  agentDir: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): void {
  const label = `subagent ${candidate.id}`
  if (sessionFile !== undefined) {
    removeFileBestEffort(sessionFile, label, result, deps)
    for (const ext of SUBAGENT_SESSION_SIDECAR_EXTS) {
      removeFileBestEffort(sessionFile + ext, label, result, deps)
    }
    // manifest 与 .events 与子会话文件同 enc 段（path-encoding.ts 布局不变量：
    // records 与 sessions 同 <enc> 段物理相邻）——由 sessionFile 推导，无漂移情形。
    const recordsDir = join(dirname(sessionFile), '..', 'records')
    removeFileBestEffort(join(recordsDir, `${candidate.id}.json`), label, result, deps)
    removeFileBestEffort(join(recordsDir, `${candidate.id}${RECORD_EVENTS_SUFFIX}`), label, result, deps)
  } else {
    // registered-only（无 settled 锚，多为主删除时仍在途的子代理）：按 id 在全部
    // enc 段定位（record id 全局唯一不撞段）。enc 段目录名 = encodeCwd(mainCwd)，
    // 直接枚举 subagents 根再拼 records/sessions 两个子目录。
    const encDirs = listEncSegmentDirs(join(agentDir, 'subagents'), result, deps)
    for (const encDir of encDirs) {
      const recordsDir = join(encDir, 'records')
      removeFileBestEffort(join(recordsDir, `${candidate.id}.json`), label, result, deps)
      removeFileBestEffort(join(recordsDir, `${candidate.id}${RECORD_EVENTS_SUFFIX}`), label, result, deps)
    }
    for (const encDir of encDirs) {
      const matched = listSubagentSessionFiles(join(encDir, 'sessions'), candidate.id, result, deps)
      for (const filePath of matched) {
        removeFileBestEffort(filePath, label, result, deps)
        for (const ext of SUBAGENT_SESSION_SIDECAR_EXTS) {
          removeFileBestEffort(filePath + ext, label, result, deps)
        }
      }
    }
  }
  // session-reader 导出物（子代理 sid 的导出视图与族同生命周期）
  removeFileBestEffort(join(agentDir, SESSION_VIEW_TMP_DIRNAME, `session-view-${candidate.id}.md`), label, result, deps)
  result.subagentFamiliesDeleted++
}

/**
 * 枚举 subagents 根下的全部 enc 段目录（目录名 = encodeCwd(mainCwd)，records /
 * sessions 两个子目录由调用方按布局拼接）。根不存在（从未有过子代理）返回空；
 * 单 enc 段枚举失败逐项入 failures（该段文件残留，宁保留），不中断其余段。
 */
function listEncSegmentDirs(
  kindRoot: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): string[] {
  let entries: string[]
  try {
    entries = readdirSync(kindRoot, { withFileTypes: true }).filter((ent) => ent.isDirectory()).map((ent) => ent.name)
  } catch (e: unknown) {
    if (!isEnoent(e)) {
      const msg = `enc segment enumeration failed for ${kindRoot}: ${toMessage(e)}`
      result.failures.push(msg)
      deps.warn(`[session-content-cascade] ${msg}`)
    }
    return []
  }
  return entries.map((name) => join(kindRoot, name))
}

/** sessions enc 段内按 id 后缀匹配子会话文件（文件名形态 `<ISO时间戳>_<saId>.jsonl`）。 */
function listSubagentSessionFiles(
  sessionsDir: string,
  id: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): string[] {
  const suffix = `_${id}.jsonl`
  try {
    return readdirSync(sessionsDir).filter((name) => name.endsWith(suffix)).map((name) => join(sessionsDir, name))
  } catch (e: unknown) {
    if (!isEnoent(e)) {
      const msg = `subagent sessions dir enumeration failed for ${sessionsDir}: ${toMessage(e)}`
      result.failures.push(msg)
      deps.warn(`[session-content-cascade] ${msg}`)
    }
    return []
  }
}

/** 单文件删除（ENOENT = 已不存在，幂等成功；其余失败逐项记录 + warn，不中断）。 */
function removeFileBestEffort(
  filePath: string,
  label: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): void {
  try {
    unlinkSync(filePath)
  } catch (e: unknown) {
    if (isEnoent(e)) return
    const msg = `failed to remove ${label} file ${filePath}: ${toMessage(e)}`
    result.failures.push(msg)
    deps.warn(`[session-content-cascade] ${msg}`)
  }
}

// ── 4/5. A21 导出物 + A23 后台任务目录 ────────────────────────────────────────

/** A21：session-reader 导出物删除（best-effort；不存在 = 幂等成功）。 */
function removeSessionViewExport(
  outPath: string,
  failures: string[],
  warn: (message: string) => void,
): void {
  try {
    unlinkSync(outPath)
  } catch (e: unknown) {
    if (isEnoent(e)) return
    const msg = `failed to remove session-view export ${outPath}: ${toMessage(e)}`
    failures.push(msg)
    warn(`[session-content-cascade] ${msg}`)
  }
}

/**
 * A23：后台任务 registry 目录删除（`<agentDir>/base-tool-enhance/<sessionId>/`）。
 * 先 await 收殓（removeSessionEntry 汇聚点已 fire-and-forget 过一次，此处幂等双跑
 * 收尾「杀进程 + 写 orphaned 终态」的在途执行——目录删除先于收殓完成会让终态写入
 * 撞已删目录），再整目录 rmSync（recursive + force，与既有目录级联同幂等形态）。
 * 收殓失败不阻断目录删除（进程已被杀，残留条目无属主；失败出声）。
 */
async function removeBackgroundTaskRegistryDir(
  agentDir: string,
  sessionId: string,
  deps: SessionContentCascadeDeps,
): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    const msg = `sessionId failed whitelist, background task registry dir skipped: ${JSON.stringify(sessionId)}`
    deps.warn(`[session-content-cascade] ${msg}`)
    return
  }
  try {
    await deps.reapBackgroundTasks(agentDir, sessionId)
  } catch (e: unknown) {
    deps.warn(`[session-content-cascade] background task reap failed before registry dir removal (sessionId=${sessionId}): ${toMessage(e)}`)
  }
  const dir = join(agentDir, BASE_TOOL_ENHANCE_DIRNAME, sessionId)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e: unknown) {
    deps.warn(`[session-content-cascade] failed to remove background task registry dir ${dir}: ${toMessage(e)}`)
  }
}

// ── 检查 helpers ──────────────────────────────────────────────────────────────

/** child 是否严格落在 parent 树内（resolve 归一 + 同前缀 + 非自身；session-records.ts 同式先例）。 */
function isStrictlyUnder(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  if (p === c || !isAbsolute(child)) return false
  return c.startsWith(p + sep)
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

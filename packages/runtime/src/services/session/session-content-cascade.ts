/**
 * SessionContentCascade — 删主会话的下挂内容事务性级联（单一清单入口）。
 *
 * 用户裁决（2026-10-12）：删主会话 = 事务性级联删除其下挂的一切内容。
 * session-store-layout-inversion D5（2026-10-17）删除链收敛为四段（本模块实装
 * ①③④；② tombstone 在 session-lifecycle.delete 编排侧，见该处注释）：
 *
 *   1. 收殓：reapBackgroundTasks 杀在途后台进程 + 写 orphaned 终态——**先于一切
 *      删除动作**（整树删除不得吞掉收殓，否则在途后台任务进程泄漏 + 终态悬挂）。
 *   2. 引用并集判定 + fork 引用转移回退段：全池流式扫描 sessionsRoot 其余主会话
 *      文件的 subagent-record v2 条目（registered id ∪ settled id/sessionFile），
 *      fork 共享防护（E1 实锤：createForkedSessionFile 原样复制 record entries
 *      且 settled.sessionFile 指向不变——fork 与源会话共享同一批子代理文件，
 *      rootSessionId 相等不是正确判据）。
 *   3. 整树软删：`<root>/<sid>/` 整棵树调 infra/system/trash 的 trashDirectory
 *      进废纸篓（mac）/ 递归删（非 mac 降级）——域 1 附件 / 2 产物 / 3 图片缓存 /
 *      4 插件 KV / 5 后台任务 / 6 导出 / 8 画布 / 9 subagent 文件族 / 11 会话日志
 *      全部随树回收，新域接入零删除链改动。
 *   4. pi 树内本体：主 jsonl trash（文件级废纸篓）+ sidecars 6 段硬删
 *      （meta/preset/project/handoff/agent/model + migrate 残留——pi 宿主管辖的
 *      小体量元数据，主 jsonl 已走废纸篓，sidecar 不随树）。
 *
 * 退役的旧逐域段（随整树软删收敛，D5 变更声明）：subagent 文件族清单删（旧布局
 * `<agentDir>/subagents/<enc>/` 段——新布局族文件在 session 树内）、A21
 * session-view 导出物（新落点 `<root>/<sid>/session-view.md` 在树内；子代理 sid
 * 的导出物落 `<root>/<子sid>/session-view.md` 自有树，删除主会话时的残留按 D6
 * 接受）、A23 后台任务 registry 目录（新落点 `<root>/<sid>/background-tasks/`
 * 在树内；**收殓调用本身保留**）。旧布局残留不回收 = D6 显式取舍（存量不迁移 +
 * 删除链退役）。
 *
 * fork 引用转移（D5 分支规则实装结论 = **回退**，2026-10-17 开工核实）：
 * 被引用文件的指针落点 = B 的主会话 jsonl 中 subagent-record v2 条目的
 * sessionFile 字段。三条核实结论：① 形态 = **绝对路径**（解析器 isAbsolute 硬过滤
 * 见 parseSubagentRecordLine；实盘条目样本同形态；引擎 sessionDir 恒为绝对路径）；
 * ② 改写落点 = pi 宿主主会话 jsonl 本体，直写触 P2/D7① 红线；③ pi 契约通道
 * （pi.appendEntry）只在 pi 宿主进程内可达（subagent-core record store 经 pi
 * handle 上报条目），runtime 删除编排无通道可改 B 的 jsonl。故按 D5 分支规则
 * **回退**：被引用文件保留 A 树 + 接受 A 树残留（残留语义与 D3 域 9 同口径）。
 * 实装形态 = 树删前把被引用族拷到树外暂存、整树软删后再拷回 A 树残留——B 的
 * 绝对路径引用自然可解析。残留的回收边界（显式声明）：A 树残留**不随 B 删除消解**
 * ——B 的删除编排只回收 B 自己的树（`<root>/<B>/`）与 pi 树内本体，被引用族物理落在
 * A 树内，跨树删除不在删除编排范围内（D6「删除编排只回收新树 + pi 树内本体」同口径）。
 * 残留与域 9 孤儿树同口径接受：只可能来自 fork 共享场景，无保留期扫描兜底，
 * 需要时人工从 A 残留目录取回。
 *
 * 失败语义：每项 best-effort try/catch 但**失败必须汇总出声**（warn 逐项 + 结束
 * 汇总计数），禁静默吞。枚举/并集扫描失败（读错误、坏行、oversize）=「引用
 * 状态不可知」≠「无引用」——保守保留全部子代理族（整棵 subagents/ 暂存回迁），
 * 与 collectAliveWorkflowRunReferences 的「缺席只延后删除」方向相反：那边缺席 →
 * 观察期不删；这边缺席 → 若照删即误删共享文件，故必须反转。整树 trash 与主文件
 * trash 的 rejection **原样上抛**（G4：trash 失败必须让删除整体报失败，此时树与
 * 本体都还在，重试删除即达终态）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  RECORD_EVENTS_SUFFIX,
  SUBAGENT_RECORD_CUSTOM_TYPE,
  classifySubagentRecordEntryData,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from '@zhushanwen/subagent-core'
import { isPiSessionId } from '@taiji/shared/paths'
import { isEnoent } from '../../utils/errors.js'

/** subagent-record v2 条目的判别联合（barrel 未导出联合别名，按 kind 分支的两侧条目类型同源组装）。 */
type SubagentRecordEntry = SubagentRecordRegisteredEntryData | SubagentRecordSettledEntryData

/**
 * 子代理会话文件族 sidecar 扩展名名单——本名单是这些 sidecar 的唯一删除面
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

/**
 * record id 白名单：与 subagent-core record-events.ts 的 RECORD_ID_PATTERN 同式
 * （`[\w-]` + 长度 ≤128；该常量模块私有未导出）。record id 生产源 = sa-<uuid>，
 * 字符集 ⊆ 白名单；白名单排除 "." ".." 与路径分隔符，防主会话 JSONL 内被污染的
 * id 字段构造路径穿越。
 */
const RECORD_ID_PATTERN = /^[\w-]{1,128}$/

/** fork 回退暂存目录名前缀（落在 session 存储树根一级；树内遍历规约按 isPiSessionId 结构性跳过）。 */
const STAGING_DIR_PREFIX = '.deletion-staging-'

// ── 输入 / 依赖 / 结果 ────────────────────────────────────────────────────────

export type SessionContentCascadeInput = {
  /** 被删主会话 id（树目录名 + 收殓入参）。 */
  sessionId: string
  /** 被删主会话 JSONL 绝对路径（子代理锚枚举源；pi 宿主树内本体）。 */
  sessionFilePath: string
  /** pi agent 数据目录（A23 收殓器入参）。 */
  agentDir: string
  /** 主会话文件全池扫描根（`<agentDir>/sessions` 同布局：slug 子目录内 *.jsonl）。 */
  sessionsRoot: string
  /**
   * session 存储树根（`<dataDir>/ext-sessions`）——整树软删目标 `<root>/<sid>/`
   * 的父目录，也是 fork 回退暂存目录的落点。
   */
  sessionStoreRoot: string
  /**
   * active 分支语义：true = 主文件已不存在时整体零动作（现行 purgeActiveSessionFile
   * 守卫「外部已删则整体零动作」）；false = scanned 分支语义（主文件不存在仍收殓
   * + 整树软删 + 清孤儿 sidecar——树与 sidecar 不依赖主文件内容）。
   */
  skipIfMainFileMissing: boolean
}

/** 依赖注入面（全部可注入——测试 zero mock-module、零真实数据目录）。 */
export interface SessionContentCascadeDeps { // oe-exempt:20261012:framework:级联依赖注入面（lifecycle 组装注入 + 测试 fake，DI 端口先立单实现常态）
  /** 主文件移入废纸篓（现行 sessionStore.trash；rejection 原样上抛，G4 语义）。 */
  trash: (filePath: string) => Promise<void>
  /**
   * 整树软删（`<root>/<sid>/` 目录级；infra/system/trash 的 trashDirectory——
   * mac 废纸篓 / 非 mac 递归删降级；rejection 原样上抛，G4 语义）。
   */
  trashSessionTree: (dirPath: string) => Promise<void>
  /** 主文件 sidecars 清理（session-lifecycle.purgeSessionSidecars 回调注入；pi 树内 6 段）。 */
  purgeMainSidecars: (filePath: string) => void
  /** A23 前置收殓（现行 reapSessionBackgroundTasks；幂等，双跑无害）。 */
  reapBackgroundTasks: (agentDir: string, sessionId: string) => Promise<unknown>
  /** 汇总出声通道（生产 console.warn；测试收集断言）。 */
  warn: (message: string) => void
}

export type SessionContentCascadeResult = {
  /** 主文件在级联开始时是否存在。 */
  mainFileExisted: boolean
  /** 引用判定状态：skipped（主文件缺失未枚举）/ ok / failed（主文件不可读致候选枚举失败或并集扫描失败——保守保留全部子代理族）。 */
  referenceScan: 'skipped' | 'ok' | 'failed'
  /** 整树软删是否执行（树存在且 trash 成功 → true）。 */
  sessionTreeTrashed: boolean
  /** fork 回退：被存活会话引用而保留在 A 树残留内的子代理文件族数。 */
  subagentFamiliesResidual: number
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
  const { sessionId, sessionFilePath, agentDir, sessionsRoot, sessionStoreRoot, skipIfMainFileMissing } = input
  const failures: string[] = []
  const mainFileExisted = existsSync(sessionFilePath)
  const result: SessionContentCascadeResult = {
    mainFileExisted,
    referenceScan: 'skipped',
    sessionTreeTrashed: false,
    subagentFamiliesResidual: 0,
    failures,
  }
  if (!mainFileExisted && skipIfMainFileMissing) {
    return result // active 分支原语义：外部已删则整体零动作
  }

  // 1. 收殓（先于一切删除动作——杀在途后台进程 + 写 orphaned 终态）
  await reapBackgroundTasksBeforeDelete(agentDir, sessionId, deps)

  // 2. 引用并集判定 + fork 回退暂存（主文件在场才枚举得出锚）
  let staging: StagedFamilies | null = null
  const subagentsDir = join(sessionStoreRoot, sessionId, 'subagents')
  if (mainFileExisted) {
    const enumeration = collectSubagentFamilyCandidates(sessionFilePath, failures, deps.warn)
    const union = collectAliveReferenceUnion(sessionsRoot, sessionFilePath, deps.warn)
    // 两个判定输入任一失败（主文件不可读致候选锚枚举失败 / 并集扫描失败）= 引用
    // 状态不可知（头注保守语义），都走 keep-all 保守分支。
    result.referenceScan = enumeration.failed || union === null ? 'failed' : 'ok'
    let planned: PlannedFamily[]
    if (enumeration.failed) {
      // 候选锚枚举不出来时无法按族定位文件——保守保留按目录整棵生效（planKeepWholeSubagentsDir）。
      const wholeDir = planKeepWholeSubagentsDir(subagentsDir)
      planned = wholeDir === null ? [] : [wholeDir]
      const keptNote = wholeDir === null
        ? 'no subagent family files exist in the session tree (nothing to keep; tree deleted as usual)'
        : `keeping ALL subagent family files (${wholeDir.files.length}) in the residual session tree ` +
          `(reference state unknown — never delete on unknown), residuals are accepted (no retention sweep by ruling 2026-10-12)`
      const msg = `[session-content-cascade] session file unreadable for ${sessionId}; subagent family enumeration failed. ${keptNote}. ` +
        `Fix: check the session file's readability, then retry the delete if needed: ${sessionFilePath}`
      deps.warn(msg)
      failures.push('session file unreadable (subagent family enumeration failed; reference state unknown)')
    } else if (union === null) {
      planned = planKeepAllFamilies(enumeration.candidates, subagentsDir, result, deps)
      const msg = `[session-content-cascade] reference union scan failed for ${sessionId}; ` +
        `keeping ALL subagent families in the residual session tree (reference state unknown — never delete on unknown), ` +
        `residuals are accepted (no retention sweep by ruling 2026-10-12). Fix: inspect the sessions pool for unreadable/corrupt .jsonl files.`
      deps.warn(msg)
      failures.push('reference union scan failed (all subagent families kept in residual tree)')
    } else {
      planned = planReferencedFamilies(enumeration.candidates, union, subagentsDir, result, deps)
    }
    staging = stageFamilies(planned, subagentsDir, sessionStoreRoot, sessionId, result, deps)
    result.subagentFamiliesResidual = staging?.families ?? 0
    if (result.subagentFamiliesResidual > 0) {
      const ids = planned.map((f) => f.id).join(',')
      deps.warn(`[session-content-cascade] fork fallback: kept ${result.subagentFamiliesResidual} referenced subagent famil${result.subagentFamiliesResidual === 1 ? 'y' : 'ies'} ` +
        `(${ids}) in the residual tree ${subagentsDir} (sessionId=${sessionId}). ` +
        `B's absolute sessionFile references stay resolvable; residuals accepted (D5 branch rule fallback — pi contract channel unavailable from the deletion path).`)
    }
  }

  // 3. 整树软删（`<root>/<sid>/` 目录级；树删成功后才把被引用族拷回残留）
  const treeDir = join(sessionStoreRoot, sessionId)
  if (!isPiSessionId(sessionId)) {
    const msg = `sessionId failed session-store whitelist, session tree soft-delete skipped: ${JSON.stringify(sessionId)}`
    deps.warn(`[session-content-cascade] ${msg}`)
    failures.push(msg)
  } else if (staging?.incomplete === true) {
    // 被引用族保全失败（暂存拷贝出错）= 引用状态不可知的同族情形——按「宁保留」方向
    // 整树不删（照删即误删 B 仍在引用的共享文件），原件未动故副本全弃。
    const msg = `referenced subagent family preservation failed (staging copy error); session tree kept intact ` +
      `(never delete when reference preservation is uncertain): ${treeDir}. ` +
      `Fix: check disk space / directory permissions under ${sessionStoreRoot}, then retry the delete.`
    deps.warn(`[session-content-cascade] ${msg} (sessionId=${sessionId})`)
    failures.push(msg)
    discardStaging(staging, null)
  } else if (existsSync(treeDir)) {
    let treeTrashSucceeded = false
    try {
      await deps.trashSessionTree(treeDir)
      treeTrashSucceeded = true
      result.sessionTreeTrashed = true
      // fork 回退：被引用族拷回 A 树残留（树已出废纸篓通道，目录需重建）
      restoreStagedFamilies(staging, result, deps)
    } finally {
      // 暂存区清除（拷贝形态：树删失败时 A 树原状未动，仅丢副本）。三分支：树删失败
      // = A 树原状未动、暂存副本全冗余 → 整目录清除；树删成功且全部回迁 → 整目录清除；
      // 树删成功但有回迁失败 → 只清已回迁副本——未回迁文件的唯一副本在暂存区，清了即
      // 数据丢失（残留占盘 vs 丢数据，取前者；失败项已入 failures 并指向暂存目录）。
      const keepUnrestored = treeTrashSucceeded && staging?.entries.every((e) => e.restored) !== true
      discardStaging(staging, keepUnrestored ? 'restored-only' : null)
    }
  } else {
    // 无树可删 → 被引用族不在树内（旧布局 / 从未落盘），无残留可保留
    discardStaging(staging, null)
  }

  // 4. pi 主文件 trash（rejection 上抛：树已删、本体还在的可恢复形态）
  if (mainFileExisted) {
    await deps.trash(sessionFilePath)
  }

  // 5. pi 树内 sidecars（scanned 分支主文件缺失时也照清孤儿 sidecar——原语义保持）
  deps.purgeMainSidecars(sessionFilePath)

  // 汇总出声（失败必出声；成功+有残留也留一行观测面）
  if (failures.length > 0) {
    deps.warn(`[session-content-cascade] cascade finished with ${failures.length} failure(s) for session ${sessionId} ` +
      `(treeTrashed=${result.sessionTreeTrashed} familiesResidual=${result.subagentFamiliesResidual}); ` +
      `failures: ${failures.join(' | ')}`)
  } else if (result.subagentFamiliesResidual > 0) {
    deps.warn(`[session-content-cascade] cascade ok for session ${sessionId}: ` +
      `treeTrashed=${result.sessionTreeTrashed} familiesResidual=${result.subagentFamiliesResidual} failures=0`)
  }
  return result
}

// ── 1. 收殓 ───────────────────────────────────────────────────────────────────

/**
 * A23 前置收殓（删树前的在途收口）。removeSessionEntry 汇聚点已 fire-and-forget
 * 过一次，此处幂等双跑收口「杀进程 + 写 orphaned 终态」的在途执行——整树软删先于
 * 收殓完成会让终态写入撞已删目录（在途后台任务进程泄漏 + 终态悬挂）。
 *
 * 收殓失败不阻断删除（进程已被杀，残留条目无属主；失败出声）。registry 目录本身
 * 随整树软删回收（新布局 `<root>/<sid>/background-tasks/`），此处不再单独删目录。
 */
async function reapBackgroundTasksBeforeDelete(
  agentDir: string,
  sessionId: string,
  deps: SessionContentCascadeDeps,
): Promise<void> {
  try {
    await deps.reapBackgroundTasks(agentDir, sessionId)
  } catch (e: unknown) {
    deps.warn(`[session-content-cascade] background task reap failed before session tree soft-delete (sessionId=${sessionId}): ${toMessage(e)}`)
  }
}

// ── 2a. 被删主会话的子代理锚枚举 ──────────────────────────────────────────────

/** 候选锚枚举结果：candidates = 解析出的族锚清单；failed = 主文件读失败（引用状态不可知）。 */
type SubagentFamilyEnumeration = {
  candidates: SubagentFamilyCandidate[]
  failed: boolean
}

/**
 * 读被删主会话文件，解析 subagent-record v2 条目为候选族清单。
 *
 * 读通道 = scanRecordFamilyEntries 同款行预过滤流式扫描的收窄形态（本模块自持：
 * 并集扫描需要「坏行即保守失败」的更严语义，共用读骨架会继承「坏行跳过」的宁删
 * 方向）。主文件读失败返回空清单 + failed = true——调用方置引用状态不可知，走
 * keep-all 保守分支（整棵 subagents/ 暂存回迁，头注保守语义：锚枚举不出来时无法
 * 按族定位文件，保留判定必须按目录整棵生效）。行内坏行不失败（该行锚丢失 = 残留，
 * 宁保留方向）。
 */
function collectSubagentFamilyCandidates(
  sessionFilePath: string,
  failures: string[],
  warn: (message: string) => void,
): SubagentFamilyEnumeration {
  let lines: string[]
  try {
    lines = readFileSync(sessionFilePath, 'utf8').split('\n')
  } catch (e: unknown) {
    const msg = `[session-content-cascade] session file unreadable, subagent family enumeration failed (reference state unknown): ${sessionFilePath}`
    warn(`${msg}: ${toMessage(e)}`)
    failures.push(`session file unreadable: ${toMessage(e)}`)
    return { candidates: [], failed: true }
  }
  const byId = new Map<string, SubagentFamilyCandidate>()
  for (const line of lines) {
    const entry = parseSubagentRecordLine(line)
    if (entry === null) continue
    byId.set(entry.id, entry)
  }
  return { candidates: [...byId.values()], failed: false }
}

/**
 * 单行 → subagent-record 候选（type/customType/classify 逐层守卫；非命中返回 null）。
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

// ── 2b. 引用并集判定（fork 共享防护）─────────────────────────────────────────

/**
 * 全池流式扫描 sessionsRoot 其余主会话文件的 subagent-record 引用并集。
 *
 * 扫描对象 = pi 会话文件池（`<agentDir>/sessions/<slug>/*.jsonl`）——布局不在本次
 * 反转范围（pi 宿主管辖），换根只影响并集命中后的**处置目标**（A 树内
 * subagents/ 路径，见 planReferencedFamilies / collectInTreeFamilyFiles）。
 *
 * 形态参照 subagent-workflow extension 的 collectAliveWorkflowRunReferences（sessions
 * 根 + 全 slug 子目录 *.jsonl，逐行 JSON.parse），两处差异：
 * - 收集面：那边 workflow-record 三代；这边 subagent-record v2（registered id /
 *   settled id+sessionFile）。
 * - 失败语义反转（文件头已述）：任何文件读失败 / 坏行 → 返回 null（引用状态不可知），
 *   调用方保留全部子代理族。
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

// ── 2c. fork 引用转移回退段（D5 分支规则：保留 A 树）──────────────────────────

/** 单个待保留族：record id + 树内文件清单（绝对路径）。 */
type PlannedFamily = {
  id: string
  files: string[]
}

/** 暂存区：树外目录 + 各族文件（相对 subagents/ 的路径保持一致，回迁时按它重建）。 */
type StagedFamilies = {
  dir: string
  /** 回迁映射：树内绝对路径 → 暂存内绝对路径；restored = 已拷回残留树。 */
  entries: Array<{ treePath: string; stagedPath: string; restored?: boolean }>
  /** 成功保全的族数（保留观测面）。 */
  families: number
  /** 任一文件保全失败 = true（引用保全不可信 → 整树不删，见主入口分支）。 */
  incomplete: boolean
}

/**
 * 规划「全部候选族保留」（引用并集扫描失败 = 引用状态不可知的保守方向）。
 * 无文件的族不纳入（nothing to preserve）。
 */
function planKeepAllFamilies(
  candidates: SubagentFamilyCandidate[],
  subagentsDir: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): PlannedFamily[] {
  const planned: PlannedFamily[] = []
  for (const candidate of candidates) {
    const files = collectInTreeFamilyFiles(subagentsDir, candidate, result, deps)
    if (files.length > 0) planned.push({ id: candidate.id, files })
  }
  return planned
}

/** 整棵目录保留的哨兵族 id（观测面用，非 record id——不经 RECORD_ID_PATTERN 校验通道）。 */
const WHOLE_SUBAGENTS_DIR_FAMILY_ID = '(whole subagents dir)'

/**
 * 规划「整棵 subagents/ 保留」（候选锚枚举失败 = 引用状态不可知的保守方向，头注
 * 声明的「整棵 subagents/ 暂存回迁」）：锚枚举不出来时无法按族定位文件，保留判定
 * 按目录整棵生效（与 planKeepAllFamilies 同向、枚举手段不同——递归全量列举，覆盖
 * sessions/ records/ model-switch/ 全部子目录）。
 *
 * 目录不存在 / 为空返回 null = 树内无 subagent 数据可保留，保守分支退化为零动作
 * （无数据可误删，树照删）。目录列举的非 ENOENT 读错误原样上抛（与
 * collectInTreeFamilyFiles 的 listDirFiles 同形态：上抛即删除整体失败，树与本体
 * 都还在，重试即达终态——G4 语义）。
 */
function planKeepWholeSubagentsDir(subagentsDir: string): PlannedFamily | null {
  const files = listAllFilesRecursively(subagentsDir)
  if (files.length === 0) return null
  return { id: WHOLE_SUBAGENTS_DIR_FAMILY_ID, files }
}

/**
 * 规划「被引用族保留」（fork 共享防护）：任一锚被其他主会话引用（id 或
 * sessionFile）→ 该族保留 A 树；未被引用 → 随整树软删回收。
 *
 * 树内校验换根到新布局：候选锚必须严格落在 `<root>/<sid>/subagents/` 内才纳入
 * （旧布局 `<agentDir>/subagents/<enc>/` 与越界构造值都不在整树删除面上——旧布局
 * 残留按 D6 接受，越界值无可保留内容）。
 */
function planReferencedFamilies(
  candidates: SubagentFamilyCandidate[],
  union: AliveReferenceUnion,
  subagentsDir: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): PlannedFamily[] {
  const planned: PlannedFamily[] = []
  for (const candidate of candidates) {
    // 不可信源字段终检（枚举侧已滤，此处防后续名单演化绕过）
    if (!RECORD_ID_PATTERN.test(candidate.id)) {
      result.failures.push(`subagent record id failed whitelist, family skipped: ${candidate.id}`)
      deps.warn(`[session-content-cascade] record id failed whitelist, family skipped: ${candidate.id}`)
      continue
    }
    // 引用并集保护（fork 共享防护：任一锚被引用 → 整族保留）
    const referenced = union.ids.has(candidate.id) ||
      (candidate.sessionFile !== undefined && union.sessionFiles.has(resolve(candidate.sessionFile)))
    if (!referenced) continue
    const files = collectInTreeFamilyFiles(subagentsDir, candidate, result, deps)
    if (files.length > 0) planned.push({ id: candidate.id, files })
  }
  return planned
}

/**
 * 枚举一个族在 A 树内的全部文件（新布局 `<root>/<sid>/subagents/`）：
 * - sessions/ 下 `<ts>_<id>.jsonl`（后缀匹配，覆盖 registered-only 无锚形态）+ 全 sidecars；
 * - records/ 下 `<id>.json` + `<id><RECORD_EVENTS_SUFFIX>`；
 * - settled 条目权威锚 sessionFile（树内校验后并入，与后缀扫描去重——条目可能
 *   指向非标准命名文件）。
 */
function collectInTreeFamilyFiles(
  subagentsDir: string,
  candidate: SubagentFamilyCandidate,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): string[] {
  const files = new Set<string>()
  const sessionsDir = join(subagentsDir, 'sessions')
  const recordsDir = join(subagentsDir, 'records')
  for (const name of listDirFiles(sessionsDir)) {
    if (!name.endsWith(`_${candidate.id}.jsonl`)) continue
    const sessionFile = join(sessionsDir, name)
    files.add(sessionFile)
    for (const ext of SUBAGENT_SESSION_SIDECAR_EXTS) {
      const sidecar = sessionFile + ext
      if (existsSync(sidecar)) files.add(sidecar)
    }
  }
  for (const name of [`${candidate.id}.json`, `${candidate.id}${RECORD_EVENTS_SUFFIX}`]) {
    const recordFile = join(recordsDir, name)
    if (existsSync(recordFile)) files.add(recordFile)
  }
  if (candidate.sessionFile !== undefined && !isStrictlyUnder(subagentsDir, candidate.sessionFile)) {
    // 树外锚（旧布局 / 构造值）：不在整树删除面上，无保留动作，仅留痕（不是失败——
    // 旧布局是合法存量形态，树内文件已由上方后缀扫描纳入）。
    deps.warn(`[session-content-cascade] settled sessionFile outside session tree subagents root, nothing to retain from the anchor (id=${candidate.id}): ${candidate.sessionFile}`)
  } else if (candidate.sessionFile !== undefined) {
    files.add(resolve(candidate.sessionFile))
    for (const ext of SUBAGENT_SESSION_SIDECAR_EXTS) {
      const sidecar = candidate.sessionFile + ext
      if (existsSync(sidecar)) files.add(resolve(sidecar))
    }
  }
  return [...files]
}

/** 目录文件名列举（ENOENT = 从未落盘的合法空态；其余读取失败上抛由调用方判）。 */
function listDirFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (e: unknown) {
    if (isEnoent(e)) return []
    throw e
  }
}

/** 目录树全量文件列举（递归；ENOENT = 从未落盘的合法空态跳过；其余读取失败上抛由调用方判）。 */
function listAllFilesRecursively(dir: string): string[] {
  const files: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (e: unknown) {
      if (isEnoent(e)) continue
      throw e
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) stack.push(entryPath)
      else if (entry.isFile()) files.push(entryPath)
    }
  }
  return files
}

/**
 * 拷出待保留族到树外暂存区（拷贝而非移动：树删失败时 A 树原状未动，仅丢副本，
 * 无回滚路径）。无待保留族返回 null（不建暂存目录）。
 *
 * 任一文件拷贝失败 → incomplete = true（调用方据此整树不删：引用保全不可信时照删
 * = 误删 B 仍在引用的共享文件）。
 */
function stageFamilies(
  planned: PlannedFamily[],
  subagentsDir: string,
  sessionStoreRoot: string,
  sessionId: string,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): StagedFamilies | null {
  if (planned.length === 0) return null
  const stagingDir = join(sessionStoreRoot, `${STAGING_DIR_PREFIX}${sessionId}-${process.pid}-${Date.now()}`)
  const staged: StagedFamilies = { dir: stagingDir, entries: [], families: 0, incomplete: false }
  for (const family of planned) {
    const before = staged.entries.length
    for (const file of family.files) {
      const rel = relative(subagentsDir, file)
      const dest = join(stagingDir, rel)
      try {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(file, dest)
        staged.entries.push({ treePath: file, stagedPath: dest })
      } catch (e: unknown) {
        staged.incomplete = true
        const msg = `failed to stage referenced subagent family file ${file}: ${toMessage(e)}`
        result.failures.push(msg)
        deps.warn(`[session-content-cascade] ${msg}`)
      }
    }
    if (staged.entries.length > before) staged.families += 1
  }
  if (staged.families === 0) {
    discardStaging(staged, null)
    return null
  }
  return staged
}

/**
 * 树删成功后把暂存族拷回 A 树残留（`<root>/<sid>/subagents/` 目录随树出废纸篓
 * 通道，需重建）。B 的绝对路径 sessionFile 引用因此保持可解析。
 *
 * 单项失败只记录 + warn（该文件的唯一副本留在暂存区，由 discardStaging 的
 * 'restored-only' 形态保住），不中断其余文件回迁。
 */
function restoreStagedFamilies(
  staging: StagedFamilies | null,
  result: SessionContentCascadeResult,
  deps: SessionContentCascadeDeps,
): void {
  if (staging === null) return
  for (const entry of staging.entries) {
    try {
      mkdirSync(dirname(entry.treePath), { recursive: true })
      copyFileSync(entry.stagedPath, entry.treePath)
      entry.restored = true
    } catch (e: unknown) {
      const msg = `failed to restore referenced subagent family file into residual tree ${entry.treePath} ` +
        `(the staged copy is kept at ${entry.stagedPath}): ${toMessage(e)}`
      result.failures.push(msg)
      deps.warn(`[session-content-cascade] ${msg}`)
    }
  }
}

/**
 * 清除暂存区（best-effort：残留仅占盘，不影响删除主链）。
 *
 * @param mode null = 整目录清除（原件未动 / 已全部回迁）；'restored-only' = 只清已回迁
 *   副本，未回迁文件与其目录保留——那是它们的唯一副本，清了即数据丢失。
 */
function discardStaging(staging: StagedFamilies | null, mode: null | 'restored-only'): void {
  if (staging === null) return
  try {
    if (mode === null) {
      rmSync(staging.dir, { recursive: true, force: true })
      return
    }
    for (const entry of staging.entries) {
      if (entry.restored !== true) continue
      rmSync(entry.stagedPath, { force: true })
    }
  } catch {
    void 0 // 暂存区清除失败仅占盘，best-effort（删除主链已完成）
  }
}

// ── 守卫 helpers ──────────────────────────────────────────────────────────────

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

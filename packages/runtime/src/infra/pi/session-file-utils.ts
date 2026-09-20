/**
 * Session 文件工具函数
 *
 * 提供 session .jsonl 文件的解析、创建、重命名、扫描等操作。
 * 从 pi-config-bridge.ts 提取以控制文件行数（pi-config-bridge 已删除）。
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { parseJsonl, readTailEntries } from '../../utils/jsonl.js'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
// 逆序分块读工具（u4b 交付物，D5 共享 IO 形态）。infra → services 依赖倒挂豁免（同
// session-lifecycle.ts 的 R3 ports 倒挂惯例）：D5③ 消费方在本文件（infra/pi），共享
// 工具落点在 u4b 领地（services/session）；工具零业务依赖，无循环引用。
import { forEachReversedLineChunk } from '../../utils/history-reverse-read.js'
import { join, dirname, basename } from 'node:path'
import { getSessionsDir } from './pi-paths.js'
// sidecar IO 骨架 + 扫描缓存治理状态（叶子模块）：骨架原属本文件，model sidecar 家族
// 拆出后为消除 ⇄ 循环引用下沉；本文件 import 供 preset/project/agent 家族与缓存治理
// 调用点使用，并 re-export 维持原导出路径（消费方 import 路径零改动）。
import {
  invalidateScanDirCache,
  lookupScanDirCache,
  persistBindingSidecar,
  readBindingSidecar,
  refreshScanDirCache,
  sessionMetaCache,
  type PersistBindingSidecarOpts,
} from './session-binding-sidecar-io.js'
export { invalidateScanDirCache, persistBindingSidecar, readBindingSidecar } from './session-binding-sidecar-io.js'
// 残留清扫家族已拆出至 './session-residue-cleanup.ts'（max-lines 预算，先例同上）：
// 本文件 isScannableSessionFile 消费 TMP_RESIDUE_MARKERS（候选侧过滤），cleanup* 两函数
// 经 re-export 维持原导出路径（消费方 import 路径零改动）。
import { TMP_RESIDUE_MARKERS } from './session-residue-cleanup.js'
export { cleanupMigrateResidues, cleanupTmpMigrateResidue, TMP_RESIDUE_MARKERS } from './session-residue-cleanup.js'

// ── 类型定义 ─────────────────────────────────────────────────

export interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
  /** 父 session 血缘键（fork 出的 session header 指回源文件/源 sessionId）。 */
  parentSession?: string
  /** fork 锚点 entry id（截断点）。 */
  forkEntryId?: string
}

// ── 解析工具 ─────────────────────────────────────────────────

/**
 * parseSessionHeader 的头部读块大小（4KB）。
 *
 * session header（type:"session"，含 cwd/parentSession/forkEntryId）固定在 JSONL 首行，
 * 4KB 覆盖正常 header（cwd 长路径 + 路径型字段）。JSONL 行内无换行：块内无换行且未读满
 * （文件本身 < 4KB 的单行文件）按无首行终止处理；块读满仍无换行（首行 > 4KB）回退
 * 全量读取首行——旧 readFileSync 全量读实现可解析任意长度首行，单纯截断会让超长首行
 * JSON.parse 失败 → session 从侧栏消失（W20 review Fix-4 等价性修复）。
 */
const HEADER_READ_CHUNK_BYTES = 4096

/** LF（'\n'）字节值——JSONL 行终止符，Buffer.indexOf 用字节比较。 */
const NEWLINE_BYTE = 0x0a

/**
 * 解析 session JSONL 首行的 session header。
 *
 * wave:perf-w20 微项 9：只读文件头部一小块（而非 readFileSync 全量读再 split('\n')[0]）。
 * header 固定在首行，长 session 文件（数 MB）全量读只为取第一行是纯浪费；扫描器对每个
 * 候选文件调一次本函数，节省随文件数线性放大。
 */
export function parseSessionHeader(filePath: string): SessionHeader | null {
  const firstLine = readFirstJsonlLine(filePath)
  if (firstLine === null) return null
  try {
    const entry = JSON.parse(firstLine) as Record<string, unknown>
    if (!isSessionHeaderEntry(entry)) return null
    // id/cwd/timestamp 与 parentSession/forkEntryId 同款 typeof 守卫条件赋值（缺就不设，
    // 运行时语义与原裸断言一致——缺失字段读出 undefined）。SessionHeader 必有字段声明是
    // 「正常 session 均有」的乐观约定（见 isSessionHeaderEntry 注释），宽收窄差在返回
    // 类型边界单点 as 收口（替代原先 3 处字段级裸断言）；接口放宽会级联 ScannedSessionMeta
    // 与 port 委托，不做。
    return {
      ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
      parentSession: typeof entry.parentSession === 'string' ? entry.parentSession : undefined,
      forkEntryId: typeof entry.forkEntryId === 'string' ? entry.forkEntryId : undefined,
    } as SessionHeader
  } catch {
    return null
  }
}

/** type=session 首行的运行时守卫（id/cwd/timestamp 结构字段宽松：旧 session 可缺）。 */
function isSessionHeaderEntry(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).type === 'session'
}

/**
 * 读取 session JSONL 首行原文（trace 路径 A 补 header 用，design D4：RPC get_entries 不含 header）。
 *
 * 与 parseSessionHeader 共用首行读块（4KB 块 + 超长首行回退全量）；区别在本函数返回**原文**
 * 而非解析后的窄字段——trace 的 SESSION 行 inspector 需要 header 完整 JSON（含 version
 * 等未建模字段），解析归调用方（session-trace 模块，用 core parse 容错语义）。
 *
 * @returns 首行文本；文件不存在 / 打开读取失败 / 空文件 → null（不抛）
 */
export function readFirstJsonlLine(filePath: string): string | null {
  try {
    const fd = openSync(filePath, 'r')
    let head: Buffer
    let bytesRead = 0
    try {
      const chunk = Buffer.alloc(HEADER_READ_CHUNK_BYTES)
      bytesRead = readSync(fd, chunk, 0, chunk.length, 0)
      head = chunk.subarray(0, bytesRead)
    } finally {
      closeSync(fd)
    }
    const nlIndex = head.indexOf(NEWLINE_BYTE)
    let firstLine: string
    if (nlIndex !== -1) {
      firstLine = head.subarray(0, nlIndex).toString('utf-8')
    } else if (bytesRead >= HEADER_READ_CHUNK_BYTES) {
      // 首行 > 4KB（4KB 块读满仍未见换行）：回退全量读取首行，与旧 readFileSync 全量读
      // 实现严格等价（W20 review Fix-4——超长首行可解析，session 不从侧栏消失）。
      // readFileSync 失败由外层 catch 返回 null，与打开/读取失败同错误面。
      const content = readFileSync(filePath, 'utf-8')
      const contentNl = content.indexOf('\n')
      firstLine = contentNl === -1 ? content : content.slice(0, contentNl)
    } else {
      // 文件本身 < 4KB 且无换行（单行 JSONL）：head 即全量内容
      firstLine = head.toString('utf-8')
    }
    return firstLine || null
  } catch {
    return null
  }
}

/**
 * 读取 sidecar `.meta.json` 的 session_end 完整元数据（trace BOUNDARY 行用，ADR 0042）。
 *
 * 与 extractSessionOutcome（只取 outcome 枚举）的区别：返回完整 meta（outcome/reason/
 * timestamp），供 trace 行展示「原始记录」；同时校验 outcome 合法性（W-Runtime4 同款，
 * sidecar 可能损坏/被篡改）。sidecar 不存在 / JSON 损坏 / outcome 非法 → null（不抛）。
 */
export interface SessionEndSidecarMeta {
  type: 'session_end'
  outcome: SessionOutcome
  reason?: string
  timestamp?: string
}

export function readSessionEndMeta(filePath: string): SessionEndSidecarMeta | null {
  const sidecarPath = filePath + '.meta.json'
  try {
    const meta = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>
    if (!meta || typeof meta.outcome !== 'string' || !VALID_SESSION_OUTCOMES.includes(meta.outcome as SessionOutcome)) {
      return null
    }
    return {
      type: 'session_end',
      outcome: meta.outcome as SessionOutcome,
      ...(typeof meta.reason === 'string' ? { reason: meta.reason } : {}),
      ...(typeof meta.timestamp === 'string' ? { timestamp: meta.timestamp } : {}),
    }
  } catch {
    return null
  }
}

/**
 * 从 .jsonl 文件提取最后一个 session_info 的 name 字段。
 * pi 的 session 会 append 多条 session_info，取最后一条作为当前名称。
 *
 * W2 尾读优化：先尾读（readTailEntries）找尾部最后一条 session_info。
 * pi 对 session_info 的持久化是 append（[HISTORICAL] taiji 侧同名直写函数已于 W11
 * 删除，append 语义现仅指 pi 自身的落盘行为），晚期 rename 的 session_info 在尾部可命中。
 * 未命中（INVAR-tail-2 SR1）→ fallback 全量读——早期命名 + 长对话追加会把最后一条
 * session_info 推到文件头部，尾窗找不到，必须 fallback 保证正确性（不丢名字）。
 */
export function extractSessionName(filePath: string): string | null {
  return findLastEntryField(filePath,
    (e) => e.type === 'session_info' && typeof e.name === 'string',
    (e) => e.name as string,
  )
}

// ── session 终态 entry（W4，ADR 0042）─────────────────────────

/**
 * session 结束时的终态类型（W4，ADR 0042 + W1 sidecar 方案）。
 * runtime 在 3 个终态点写 session_end 到 sidecar `.meta.json`（不写 JSONL），scanner
 * 据此派生终态，让前端侧栏无需预加载历史即可显示 done/error/stopped。
 */
export type SessionOutcome = 'done' | 'error' | 'stopped'

/**
 * W-Runtime4：合法的 outcome 值集合（与 SessionOutcome 类型同步）。
 * extractSessionOutcome 读 sidecar/JSONL 时校验值合法性——文件内容可能损坏/被篡改，
 * 不校验直接断言会把无效值当合法终态返回，污染 session 状态。
 */
const VALID_SESSION_OUTCOMES = ['done', 'error', 'stopped'] as const

/**
 * 将 session 终态持久化到 sidecar `.meta.json`（W4，ADR 0042 + W1 sidecar 方案）。
 *
 * 与 JSONL 同目录写 `.meta.json`（存 session_end 元数据），不污染 JSONL——pi 的
 * _persist 永远只写 message/session_info，runtime 的终态独立存 sidecar，避免「pi
 * 忽略未知 type」的隐式约定。
 *
 * [规则 #6] 文件不存在时**绝不创建 sidecar**（与 pi 0.80.3 _persist 的 openSync("wx") 竞态）。
 * 进程崩溃（SIGKILL/OOM）可能来不及执行，这类 session 读不到终态 → scanner 回退 idle。
 *
 * @param filePath session JSONL 绝对路径（sidecar = filePath + '.meta.json'）
 * @param outcome 终态：done（正常完成）/ error（LLM 出错）/ stopped（用户 abort/进程崩溃）
 * @param reason 可选人类可读原因（error 的 errorMessage / stopped 的 abort reason）
 */
export function persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口 / 首 turn 前崩溃）：绝不创建文件，直接跳过。
    return
  }
  const meta = { type: 'session_end', outcome, reason, timestamp: new Date().toISOString() }
  try {
    // 原子写（tmpfile + rename）：与 sidecar 家族各写点一致，防止并发读读到半写的 sidecar。
    // （[HISTORICAL] 原注释参照 patchSessionCwd——该直写函数已随 W11 删除。）
    atomicWrite(filePath + '.meta.json', JSON.stringify(meta), `meta-${Date.now()}`)
    // W2-2：sidecar 写入后主动失效该文件的 meta 缓存。
    // scanSessionMeta 缓存键只含 JSONL 的 (mtimeMs, size)，sidecar 变更不会让 JSONL 的 stat 变化，
    // 导致命中缓存返回旧 outcome（如 session 被 abort/崩溃 → persistSessionEnd 写 stopped 到 sidecar，
    // 但 JSONL 未变 → 下次 scan 命中缓存 → 返回 stale outcome=null，侧栏显示 idle 而非 stopped）。
    // 删除缓存条目后，下次 scan 重新读 sidecar 拿到新 outcome。
    sessionMetaCache.delete(filePath)
    // 目录级 TTL 缓存一并失效。注意这是每 turn 写点（agent_end → handleTurnEndSideEffects 无条件
    // 调用；终态去重仅 onSessionExit 路径），失效后活跃会话每 turn 触发一次全量重扫——量级可控
    // （sessionMetaCache 命中时仅 readdir + per-file stat，50 session 约 1-2ms），一致性优先于微优化
    // （不失效则终态/outcome 变化迟到一个 TTL 窗口；opt-out 方案已在 sidecar-binding-sync 设计文档
    // 决策 2 论证并否决）。
    invalidateScanDirCache()
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistSessionEnd failed: ${filePath}`, e)
  }
}

/**
 * 计算 session preset sidecar 路径（S-RT-3）。
 *
 * 统一管理 `<sessionFile>.preset.json` 的路径拼接（原 persistPresetBinding/readPresetBinding
 * 各自硬编码 `filePath + '.preset.json'`）。提取为 helper 后：
 *   - 单点维护后缀（未来若改命名规则只改这里）
 *   - 调用方语义清晰（presetSidecarPath(filePath) 比 filePath + '.preset.json' 更自解释）
 *
 * 注意：与 `.meta.json`（session 终态 sidecar）并列但独立，由 metaSidecarPath 风格的
 * 专用 helper 各自管理（meta sidecar 当前内联在 persistSessionEnd/extractSessionOutcome，
 * 属 session-lifecycle 范围，本文件不重构）。
 */
export function presetSidecarPath(filePath: string): string {
  return filePath + '.preset.json'
}

/**
 * 计算 session agent binding sidecar 路径（agent-managed-session）。
 * `<sessionFile>.agent.json`：session 的 agent 绑定信息（spawnSource + parentAgentSessionId）。
 * 与 preset/meta/project/handoff sidecar 并列独立，由专用 helper 管理。
 */
export function agentSidecarPath(filePath: string): string {
  return filePath + '.agent.json'
}

/**
 * 计算 session project 归属 sidecar 路径（D14 语义修正，2026-08-04）。
 * `<sessionFile>.project.json`：session 归属的 project id（与 preset/meta sidecar 并列独立）。
 */
export function projectSidecarPath(filePath: string): string {
  return filePath + '.project.json'
}

// persistBindingSidecar / readBindingSidecar 公共骨架已迁 './session-binding-sidecar-io.ts'
// （model sidecar 家族拆出后为消除 ⇄ 循环引用下沉；骨架私有闭包 sessionMetaCache /
// scanDirCache 家族一并迁入，全仓唯一实例不变）。本文件经 re-export 维持原导出路径，
// preset/project/agent 家族（下方 persistProjectBinding / persistAgentBinding /
// persistPresetBinding）与 read* 调用点零改动。

/**
 * 将 session 归属 project 持久化到 sidecar `.project.json`（D14：Project 直接关联 Session）。
 *
 * session create 成功 / 手动归类（session.setProject）时调用。归属是 session 级数据，
 * 跟 session 走（删除 session 归属自动消失，fork 继承父归属）。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**（与 persistPresetBinding 同守则）：
 * pi 延迟写入窗口内 existsSync=false → 静默跳过；active session 归属经内存态兑底
 *（ManagedSession.projectId），不阻断主流程。例外：create 路径经 opts.skipJsonlExistsGuard
 * 放行（session 由本进程刚创建必然真实，见 PersistBindingSidecarOpts）。
 *
 * @param filePath session JSONL 绝对路径（sidecar = projectSidecarPath(filePath)）
 * @param projectId 归属 project id（空串 = 归回默认项目，删除已存在的绑定 sidecar）
 * @param opts 可选行为开关（skipJsonlExistsGuard 仅限 create 路径）
 */
export function persistProjectBinding(filePath: string, projectId: string, opts?: PersistBindingSidecarOpts): void {
  if (!filePath) return
  // 空 projectId（归回默认项目）= 删除绑定 sidecar。readProjectBinding 以 sidecar 为权威（无 sidecar
  // 兑底 undefined → 展示层归入默认项目），若只 return 不删，已存在的 .project.json 会继续生效——
  // 重启后 session 归属回退到旧命名项目（review MF-2 回归）。删除不创建文件，不违反规则 #6，
  // 因此不依赖 JSONL 存在性，放在公共写入（其 existsSync 守卫）之前执行。
  if (!projectId) {
    const sidecarPath = projectSidecarPath(filePath)
    try {
      if (existsSync(sidecarPath)) {
        unlinkSync(sidecarPath)
        // 与写入分支同失效处理：缓存键只含 JSONL 的 (mtimeMs, size)，sidecar 删除不变 JSONL stat，
        // 不删缓存会命中旧 projectId（扫描读回已删除的归属）。
        sessionMetaCache.delete(filePath)
        // 目录级 TTL 缓存同失效（设计文档缺陷 B 删除方向镜像）：移出项目后紧跟的列表广播若命中
        // pre-delete 快照，session 会在 1s 内弹回项目视图——与写入方向对称的用户可见现象。
        invalidateScanDirCache()
      }
    // eslint-disable-next-line taste/no-silent-catch -- file delete: failure must not crash caller
    } catch (e) {
      console.error(`[session-file-utils] persistProjectBinding: failed to delete sidecar: ${sidecarPath}`, e)
    }
    return
  }
  persistBindingSidecar(filePath, projectSidecarPath, { projectId, version: 1 as const }, 'project', opts)
}

/**
 * 从 `.project.json` sidecar 读取 session 归属 project id。
 *
 * scanSessionMeta 第五读：与 launchPresetId 同批次提取，结果合并进 ScannedSessionMeta.projectId，
 * 享受 sessionMetaCache 缓存（禁止在 scannedToSummary 独立读文件）。
 *
 * @returns projectId 字符串；sidecar 不存在/损坏/projectId 非字符串 → undefined
 */
// export（import-session r3-S5 连带改动）：导入管线的 readback 步骤消费——
// persistProjectBinding 对写失败是吞错 best-effort，导入后 readback 校验
// sidecar 实际落盘内容，不符则 RPC 返回 warning 降级（D1；此前去 export 是
// 防误用为公共 API，现有了明确的外部调用方，恢复导出）。
export function readProjectBinding(filePath: string): string | undefined {
  return readBindingSidecar(projectSidecarPath(filePath), (binding) => {
    // 类型守卫：projectId 必须是字符串（sidecar 是文件，内容可能损坏/被篡改）
    const b = binding as Record<string, unknown> | undefined
    return b && typeof b.projectId === 'string' ? b.projectId : undefined
  })
}

/**
 * 将 agent binding 持久化到 sidecar `.agent.json`（agent-managed-session）。
 *
 * session 由 agent spawn 时记录 spawnSource（如 'agent'）和 parentAgentSessionId。
 * 与 `.preset.json` / `.project.json` 同模式：独立 sidecar 文件，不污染 JSONL。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**（与 persistPresetBinding 同守则）：
 * pi 延迟写入窗口内 existsSync=false → 静默跳过。例外：create 路径经 opts.skipJsonlExistsGuard
 * 放行（session 由本进程刚创建必然真实，见 PersistBindingSidecarOpts）。
 *
 * @param filePath session JSONL 绝对路径（sidecar = agentSidecarPath(filePath)）
 * @param spawnSource session 来源标记（如 'agent'）
 * @param parentAgentSessionId 父 agent session id
 * @param opts 可选行为开关（skipJsonlExistsGuard 仅限 create 路径）
 */
export function persistAgentBinding(
  filePath: string,
  spawnSource: 'user' | 'agent',
  parentAgentSessionId: string | undefined,
  opts?: PersistBindingSidecarOpts,
): void {
  // 显式传 true 对齐默认失效语义（骨架默认开后本参数冗余，保留作自文档）：spawnSource 的
  // 消费方是列表扫描（SessionScanner.listAll → scanPiSessions force:false），binding 写入
  // 紧跟 session 创建后的列表广播刷新，1s TTL 窗口内命中 pre-binding 快照会让 agent 标记
  // 迟到一个窗口。delete/fork/rename 同理由 runtime 自写后显式失效（invalidateScanDirCache 注释）。
  persistBindingSidecar(
    filePath,
    agentSidecarPath,
    { spawnSource, parentAgentSessionId, version: 1 as const },
    'agent',
    { invalidateScanDir: true, ...opts },
  )
}

/**
 * 从 `.agent.json` sidecar 读取 agent binding。
 *
 * scanSessionMeta 第六读：与 project/preset 同批次提取，结果合并进
 * ScannedSessionMeta.spawnSource / parentAgentSessionId，享受 sessionMetaCache 缓存。
 *
 * 降级路径（A4 验收）：
 * - sidecar 不存在 → undefined
 * - JSON 损坏 → undefined
 * - spawnSource 非法（非字符串）→ undefined
 *
 * @returns { spawnSource, parentAgentSessionId }；sidecar 不存在/损坏/字段非法 → undefined
 */
export function readAgentBinding(filePath: string): { spawnSource: 'user' | 'agent'; parentAgentSessionId: string | undefined } | undefined {
  return readBindingSidecar(agentSidecarPath(filePath), (binding) => {
    // 类型守卫：spawnSource 必须是合法枚举值（sidecar 是文件，内容可能损坏/被篡改——
    // 非法值降级 undefined，A4 语义）；parentAgentSessionId 可选（异常路径下 spawnSource
    // 单独成立即持久化——#15，badge 只依赖 spawnSource）
    const b = binding as Record<string, unknown> | undefined
    if (b && (b.spawnSource === 'user' || b.spawnSource === 'agent')) {
      return {
        spawnSource: b.spawnSource,
        parentAgentSessionId: typeof b.parentAgentSessionId === 'string' ? b.parentAgentSessionId : undefined,
      }
    }
    return undefined
  })
}

/**
 * 将 launch preset 绑定持久化到 sidecar `.preset.json`（设计文档 §4）。
 *
 * session create 成功后调用，记录该 session 启动时使用的 preset id。与 `.meta.json`
 * （终态语义）分离：preset 是 launch 配置（create 时写），session_end 是终态（结束时写），
 * 生命周期不同故独立文件，避免互相覆盖。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**（与 persistSessionEnd 一致）：
 * pi 延迟写入窗口内 existsSync=false → 静默跳过（ES-RL-1）。active session 即使磁盘无文件
 * 也经 SessionScanner.listAll 合并内存 Map 显示，preset 绑定丢失仅影响 fork/restore 的
 * preset 继承，不阻断主流程。例外：create 路径经 opts.skipJsonlExistsGuard 放行（V9-④
 * 根修——create 窗口是本写点唯一时机，错过则重启后 preset 绑定永久回退 builtin:full；
 * session 由本进程刚创建必然真实，sidecar 不触碰 .jsonl 本体，见 PersistBindingSidecarOpts）。
 *
 * @param filePath session JSONL 绝对路径（sidecar = presetSidecarPath(filePath)）
 * @param presetId launch preset id（如 'builtin:full'）
 * @param opts 可选行为开关（skipJsonlExistsGuard 仅限 create 路径）
 */
export function persistPresetBinding(filePath: string, presetId: string, opts?: PersistBindingSidecarOpts): void {
  persistBindingSidecar(filePath, presetSidecarPath, { presetId, version: 1 as const }, 'preset', opts)
}

/**
 * 从 `.preset.json` sidecar 读取 launch preset 绑定（设计文档 §4）。
 *
 * scanSessionMeta 第四读：与 name/outcome/handedOffTo 同批次提取，结果合并进
 * ScannedSessionMeta.launchPresetId，享受 sessionMetaCache 缓存（禁止在 scannedToSummary
 * 独立读文件，session-scanner.ts:67-69 注释）。
 *
 * @returns presetId 字符串；sidecar 不存在/损坏/presetId 非字符串 → undefined
 */
export function readPresetBinding(filePath: string): string | undefined {
  return readBindingSidecar(presetSidecarPath(filePath), (binding) => {
    // 类型守卫：presetId 必须是字符串（sidecar 是文件，内容可能损坏/被篡改）
    const b = binding as Record<string, unknown> | undefined
    return b && typeof b.presetId === 'string' ? b.presetId : undefined
  })
}

/**
 * 从 .jsonl 文件提取最后一条 session_end 的 outcome（W4，ADR 0042）。
 *
 * W2 尾读优化：先尾读找尾部最后一条 session_end。persistSessionEnd 是 session 结束时
 * 最后写入的 entry → session_end 始终在文件最尾部 → 尾读几乎必中。
 * 未命中（理论可能：session_end 后又有别的 runtime 写入）→ fallback 全量读兜底。
 *
 * @returns 终态 outcome；文件无 session_end entry（历史 session / 未结束）返回 null
 */
export function extractSessionOutcome(filePath: string): SessionOutcome | null {
  // 优先读 sidecar（W1 sidecar 元数据方案）
  const sidecarPath = filePath + '.meta.json'
  try {
    const raw = readFileSync(sidecarPath, 'utf-8')
    const meta = JSON.parse(raw)
    if (meta && typeof meta.outcome === 'string') {
      // W-Runtime4：校验 outcome 值合法性——sidecar 是文件，内容可能损坏/被篡改，
      // 不校验直接断言会把无效值（如 typo、旧版残留）当合法终态返回，污染 session 状态。
      if (VALID_SESSION_OUTCOMES.includes(meta.outcome as SessionOutcome)) {
        return meta.outcome as SessionOutcome
      }
      // outcome 非法：sidecar 损坏/篡改，与 sidecar 不存在等价 → fallthrough 到 JSONL 兜底。
      // （原来此处直接 return null，会丢失 JSONL 中可能存在的合法 session_end 终态。）
    }
  } catch { void 0 /* no sidecar or invalid → fallback to JSONL */ }

  // fallback: 从 JSONL 读（历史 session / 无 sidecar / sidecar outcome 非法时的兼容路径）
  // findLastEntryField 的 predicate 只校验了 typeof，未校验值合法性——
  // JSONL 历史数据可能含未知 outcome 字符串（旧版本/手写），同样需校验。
  return findLastEntryField(filePath,
    (e) => e.type === 'session_end' && typeof e.outcome === 'string'
      && VALID_SESSION_OUTCOMES.includes(e.outcome as SessionOutcome),
    (e) => e.outcome as SessionOutcome,
  )
}

/**
 * 尾读 → stat 预检分流 → 倒序分块/全量倒序单遍扫描骨架（findLastEntryField 与
 * extractLatestModelFromJsonl 共用）。visit 返回 true = 收集齐，停止扫描。
 *
 * 1. readTailEntries 尾读尾部块（offset=max(0,size-32KB)）
 * 2. 尾读未命中/未收集齐（INVAR-tail-2 SR1）→ statSync 大小预检分流：
 *    - ≤ READ_PRECHECK_MAX_BYTES（小文件）：保留原全量 readFileSync + parseJsonl 倒序找
 *      fallback（行为逐字节不变——目标可能在文件头部，如早期命名推出的 session_info）
 *    - > READ_PRECHECK_MAX_BYTES（D5③，crash-resilience §3.3）：**删除全量读 fallback**，
 *      改 forEachReversedLineChunk 逆序分块扫（总读取量 ≤ 阈值），从尾向前找命中即止——
 *      消除「每次 pi 退出（extractSessionOutcome）未命中尾窗就全量同步读巨文件」的
 *      退出侧内存尖峰恶性循环。上限内未命中（目标在更深历史区）返回未命中：消费方
 *      （extractSessionOutcome/extractSessionName/extractLatestModelFromJsonl）对未命中
 *      的既有降级语义保持，非正确性回退
 *
 * 错误对等（INVAR-tail-7）：ENOENT/EACCES/JSON parse 错误与原实现一致不抛，直接返回，
 * 由调用方按各自未命中默认值（null / undefined）处理。
 */
function scanJsonlFromTail(filePath: string, visit: (entry: Record<string, unknown>) => boolean): void {
  // 尾读阶段
  const tailEntries = readTailEntries(filePath)
  if (tailEntries !== null && scanEntriesReversed(tailEntries, visit)) return
  // D5③ 预检分流：超阈值禁全量读（原 fallback 的 readFileSync 全量同步读是崩溃收尾
  // 路径上的内存尖峰触发器），改逆序分块扫命中即止。
  let size = -1
  try {
    size = statSync(filePath).size
  } catch {
    return // 文件不存在/不可读：与原 readFileSync 抛错 → catch 等价（INVAR-tail-7）
  }
  if (size > READ_PRECHECK_MAX_BYTES) {
    forEachReversedLineChunk(filePath, { maxTotalBytes: READ_PRECHECK_MAX_BYTES }, (chunk) => {
      // 块内倒序（文件尾方向优先）——「最后一条」= 更靠近文件尾的命中行
      for (let i = chunk.lines.length - 1; i >= 0; i--) {
        const line = chunk.lines[i]
        const trimmed = line.trim()
        if (!trimmed) continue
        let entry: unknown
        try {
          entry = JSON.parse(trimmed)
        } catch {
          continue // 损坏行跳过（parseJsonl 同语义；含块边界 UTF-8 残缺的污染行——见工具注释）
        }
        if (typeof entry === 'object' && entry !== null && visit(entry as Record<string, unknown>)) {
          return false // 命中即止（当前块内更早行不再交付）
        }
      }
    })
    return
  }
  // ≤阈值：原全量读 fallback 保留（INVAR-tail-2: 尾读未命中，目标可能在文件头部）
  try {
    scanEntriesReversed(parseJsonl(readFileSync(filePath, 'utf-8')), visit)
  } catch {
    return
  }
}

/**
 * 尾读 + 预检分流 + 逆序分块读，倒序找最后一条匹配 entry 的字段值（W2 共用骨架 + D5③）。
 *
 * 骨架（尾读 32KB → stat 预检分流 → ≤READ_PRECHECK_MAX_BYTES 全量倒序 / 超阈值
 * forEachReversedLineChunk 逆序分块）见 scanJsonlFromTail；本条只承载「首个命中即止」
 * 终止条件与未命中返回 null。
 *
 * 全程未命中 → null；错误对等（INVAR-tail-7）见 scanJsonlFromTail。
 */
function findLastEntryField<R>(
  filePath: string,
  predicate: (e: Record<string, unknown>) => boolean,
  extract: (e: Record<string, unknown>) => R,
): R | null {
  const found: R[] = []
  scanJsonlFromTail(filePath, (entry) => {
    if (!predicate(entry)) return false
    found.push(extract(entry))
    return true
  })
  return found.length > 0 ? found[0] : null
}

// ── session 模型信息反向读（缓存治理批 3 U7，sidecar model 家族退役第一步）──

/**
 * pi 默认思考等级（pi 实装 dist/core/session-manager.js getSessionContextSettings 的
 * thinkingLevel 初始值，0.84.4 实锚）。JSONL 无任何 thinking_level_change entry 时，
 * 会话恢复后 pi 的实际生效值即此——反向读缺省对齐，显示与 pi 同源（G3）。
 */
const PI_DEFAULT_THINKING_LEVEL = 'off'

/**
 * provider/id 拼接为 'provider/modelId' 格式（model binding 的 modelId 形态，与
 * restore-seeding readEffectiveModelFromState 对 get_state 读回值的拼法同构）。
 * 字段非法（非 string / 空串）→ null：该 entry 视为不携带模型信息，扫描继续向前。
 */
function modelIdPairOf(provider: unknown, id: unknown): string | null {
  if (typeof provider === 'string' && provider !== '' && typeof id === 'string' && id !== '') {
    return `${provider}/${id}`
  }
  return null
}

/**
 * 单 entry 的模型信息提取（extractLatestModelFromJsonl 的解析语义落点）。
 *
 * 对齐 pi 实装 getSessionContextSettings（dist/core/session-manager.js:148-160，0.84.4 实锚）：
 * - model_change entry：provider / modelId 是 entry 顶级平铺字段（pi 唯一显式 setModel 写点）
 * - assistant message entry：entry.type === 'message' 且 message.role === 'assistant'，
 *   取 message.provider + message.model
 */
function modelEntryValueOf(entry: Record<string, unknown>): string | null {
  if (entry.type === 'model_change') {
    return modelIdPairOf(entry.provider, entry.modelId)
  }
  if (entry.type === 'message') {
    const msg = entry.message
    if (typeof msg === 'object' && msg !== null) {
      const m = msg as Record<string, unknown>
      if (m.role === 'assistant') {
        return modelIdPairOf(m.provider, m.model)
      }
    }
  }
  return null
}

/**
 * entry 数组倒序扫（文件尾方向优先），逐个交给 collect；collect 返回 true（收集齐）即止。
 * 返回是否提前止（true = 两个维度都在手）。
 */
function scanEntriesReversed(entries: unknown[], collect: (e: Record<string, unknown>) => boolean): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (typeof entry === 'object' && entry !== null && collect(entry as Record<string, unknown>)) {
      return true
    }
  }
  return false
}

/**
 * 反向读 session JSONL 提取最近生效的模型绑定（scanSessionMeta 第七读的数据源：U7 起由
 * `.model.json` sidecar 切换为 JSONL 真源，U8 随 sidecar 模块退役改为本模块直调）。
 *
 * 解析语义对齐 pi 实装 getSessionContextSettings（见 modelEntryValueOf）；pi 恢复是沿当前
 * 分支正序取最后一条（后写覆盖前写），反向读「从尾向前第一条」与之等价。modelId 与
 * thinkingLevel 是 pi 侧两个独立跟踪的变量（单条 entry 只更新其一），各取物理尾方向第一条。
 *
 * 复用 scanJsonlFromTail 骨架（尾读 32KB → stat 预检分流 → ≤READ_PRECHECK_MAX_BYTES 全量
 * 倒序 / 超阈值 forEachReversedLineChunk 逆序分块，总读取量 ≤ 32MB 上限）：单值「命中即止」
 * 签名承载不了双维度独立收集（只命中 model 即止会漏掉更早区域的 thinking_level_change；
 * 分两次调用则尾读/分流成本 ×2）——经 visit 回调按同骨架单遍扫描，两维度都在手才提前止。
 * 混合分支文件取物理尾第一条（§3.3.3 已知语义边界 1，显示用途与现状 sidecar 等价或更好）。
 *
 * 失效语义（数据流图 2 方案 A 成立的关键）：缓存键 = JSONL (mtimeMs, size)，pi append 后
 * 必 miss → 重扫——反向读成本只在文件变化时发生一次。损坏行跳过继续扫（findLastEntryField
 * 分块路径同语义）；全程无模型信息 → undefined（与「sidecar 不存在」现状语义一致）。
 * thinkingLevel 无 entry → 返回 pi 默认 'off'（PI_DEFAULT_THINKING_LEVEL 注释）。
 *
 * @returns { modelId, thinkingLevel }；无 model_change /
 *          assistant entry（含文件不存在/损坏）→ undefined
 */
export function extractLatestModelFromJsonl(filePath: string): { modelId: string; thinkingLevel: string } | undefined {
  // 数组式单点对象承载命中值（闭包内赋值，规避 TS 对外层局部变量的 CFA 收窄误报）
  const hits: { modelId: string | null; thinkingLevel: string | null } = { modelId: null, thinkingLevel: null }
  const collect = (entry: Record<string, unknown>): boolean => {
    if (hits.modelId === null) {
      const modelId = modelEntryValueOf(entry)
      if (modelId !== null) hits.modelId = modelId
    }
    if (hits.thinkingLevel === null
      && entry.type === 'thinking_level_change'
      && typeof entry.thinkingLevel === 'string') {
      hits.thinkingLevel = entry.thinkingLevel
    }
    return hits.modelId !== null && hits.thinkingLevel !== null
  }

  // 单遍骨架扫描（scanJsonlFromTail）：model_change / assistant / thinking_level_change
  // 都是 pi append 落盘，活跃会话的最近生效值大概率在尾部 32KB 窗口内；双维度集齐即
  // 提前止（尾读阶段命中即不走 stat 分流）。
  scanJsonlFromTail(filePath, collect)
  // 组装：无模型信息 → undefined；thinkingLevel 无 entry → pi 默认 'off'
  if (hits.modelId === null) return undefined
  return { modelId: hits.modelId, thinkingLevel: hits.thinkingLevel ?? PI_DEFAULT_THINKING_LEVEL }
}

// ── 文件操作 ─────────────────────────────────────────────────

// [HISTORICAL] ensureSessionFile 已删除（2026-07-04）。
// 原实现用 openSync(wx) 提前创建 session 文件（含 session+session_info 两行），
// 理由是「pi 延迟写入期间 scanPiSessions 找不到该 session」。但这与 pi 0.80.3
// SessionManager._persist 的 openSync("wx") 冲突 → EEXIST → pi 抛 error → session 卡死。
// 现在依赖 SessionScanner.listAll 合并内存 active session（this.sessions Map），
// 即使磁盘无文件也显示；重启后内存清空，未 flush 的空 session 丢失是合理行为。

// [HISTORICAL] persistSessionName 已删除（W11，数据源治理——绝对写规则全线生效）。
// 原实现 openSync('a') 向 session JSONL 直写 session_info entry（W1 前活跃 + 非活跃
// rename 共用；W1 起仅剩非活跃分支调用）。W11 后 rename 全路径经 pi：活跃分支走既有
// pi 进程 set_session_name RPC，非活跃分支经 process-manager.withEphemeralPi 短命
// 附着同一 RPC——session JSONL 的唯一写方是 pi（pi 对已 flush 文件的 appendSessionInfo
// 立即 appendFileSync 落盘，session-manager.ts _persist）。
// [HISTORICAL] 规则 #6 历史包袱：更早的实现（ensureSessionFile 同期）用 openSync(wx)
// 提前建文件，与 pi _persist 的 openSync("wx") 冲突 → EEXIST → session 永久卡死，
// 后改为「文件不存在时跳过」守卫——该守卫语义已由 sidecar 家族
// （persistSessionEnd/persistPresetBinding/persistProjectBinding/persistHandoffSidecar）继承。

/**
 * 将 handoff 标记持久化到 sidecar `.handoff.json`（FR-5，W11 迁移——D3b 裁决）。
 *
 * 源 session 交接给新 session 后记录交接目标 id。extractHandedOff 读回；scanner
 * scanSessionMeta 提取后填入 ScannedSessionMeta.handedOffTo，供前端识别「该 session
 * 已交接，可在 UI 标记/跳转新 session」。
 *
 * [W11 迁移] 原实现 openSync('a') 向 session JSONL 直写 `handoff_marker` entry——
 * 活跃交接时源 pi 进程在场，taiji 与 pi 是同文件双写方（违反绝对写规则）。迁 sidecar
 * 后 handedOffTo 是 taiji 自有语义（pi 无 handoff 概念），与 `.meta.json` 家族同构。
 *
 * [规则 #6] JSONL 文件不存在时**绝不创建 sidecar**（与 persistSessionEnd 同守卫）：
 * pi 延迟写入窗口内 existsSync=false → console.warn + 静默跳过。
 * 写后双层缓存失效（sessionMetaCache + scanDirCache，与 persistBindingSidecar 骨架收敛为同一
 * 纪律）：文件级缓存键只含 JSONL 的 mtime/size，sidecar 变更不变 JSONL stat → 不失效命中旧值；
 * 目录级 TTL 不失效则 handedOffTo（消费方同样是列表扫描）迟到一个广播窗口。
 *
 * @param filePath 源 session JSONL 绝对路径（sidecar = filePath + '.handoff.json'）
 * @param newSessionId 交接目标的新 session id
 */
export function persistHandoffSidecar(filePath: string, newSessionId: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    console.warn(`[session-file-utils] persistHandoffSidecar: file does not exist, skipping (pi delayed write window): ${filePath}`)
    return
  }
  const marker = { type: 'handoff_marker', handedOffTo: newSessionId, version: 1 as const, timestamp: new Date().toISOString() }
  try {
    // 原子写（tmpfile + rename）：与 persistSessionEnd 一致，防止并发读读到半写的 sidecar。
    atomicWrite(filePath + '.handoff.json', JSON.stringify(marker), `handoff-${Date.now()}`)
    // sidecar 写入后主动失效 sessionMetaCache（对齐 persistSessionEnd：缓存键只含
    // JSONL 的 (mtimeMs, size)，sidecar 变更不变 JSONL stat → 命中缓存返回旧值）。
    sessionMetaCache.delete(filePath)
    // 目录级 TTL 缓存一并失效（本写点自维护、不经 persistBindingSidecar 骨架，但按决策 2
    // 收敛为同一纪律：handedOffTo 消费方是列表扫描，不失效则广播迟到一个 TTL 窗口）。
    invalidateScanDirCache()
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistHandoffSidecar failed: ${filePath}`, e)
  }
}

/**
 * 从 session 提取交接目标 id（FR-5，W11 起优先读 sidecar）。
 *
 * 1. 优先读 sidecar `.handoff.json`（W11 后的权威写点）。
 * 2. sidecar 未命中 → fallback 仅尾读旧 JSONL `handoff_marker` entry（存量 session
 *    兼容——W11 前写入的 marker 永在文件尾部窗口 32KB 内；handoff 是一次性标记，
 *    写入后无后继写方把它推出尾窗）。
 *
 * [NOTE 不复用 findLastEntryField] fallback 刻意保持「仅尾读」——findLastEntryField
 * 尾读未命中会 fallback 全量读（readFileSync + parseJsonl），那会打破 scanSessionMeta
 * 的三读合一预算（W3 AC-merge-1）。旧 marker 总在文件最尾部，尾读必中。返回类型
 * `undefined`（非 null）匹配 ScannedSessionMeta.handedOffTo 的可选字段语义。
 *
 * @returns 交接目标的新 session id；无标记（未交接）返回 undefined
 */
export function extractHandedOff(filePath: string): string | undefined {
  // 优先读 sidecar（W11 后权威写点；对齐 extractSessionOutcome 的 sidecar-first 结构）
  try {
    const raw = readFileSync(filePath + '.handoff.json', 'utf-8')
    const marker = JSON.parse(raw)
    // 类型守卫：handedOffTo 必须是字符串（sidecar 是文件，内容可能损坏/被篡改）
    if (marker && typeof marker.handedOffTo === 'string') {
      return marker.handedOffTo
    }
    // handedOffTo 非字符串：sidecar 损坏，与 sidecar 不存在等价 → fallthrough 尾读兜底。
  } catch { void 0 /* no sidecar or invalid → fallback to legacy JSONL marker */ }

  // fallback：存量旧 session 的 JSONL `handoff_marker` 尾读（W11 前写入的兼容路径）
  const tailEntries = readTailEntries(filePath)
  if (tailEntries !== null) {
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      const entry = tailEntries[i]
      if (typeof entry === 'object' && entry !== null
        && (entry as Record<string, unknown>).type === 'handoff_marker'
        && typeof (entry as Record<string, unknown>).handedOffTo === 'string') {
        return (entry as Record<string, unknown>).handedOffTo as string
      }
    }
  }
  return undefined
}

// [HISTORICAL] patchSessionCwd 已删除（W11，数据源治理——绝对写规则全线生效）。
// 原实现读源 JSONL → 改首行 session header 的 cwd 字段 → atomicWrite 整文件重写源文件
// （restoreSession 在 pi spawn 前调用：session cwd 已被删除时降级 homedir，防 pi
// switch_session 因 cwd 不存在失败）。W11 后 cwd fallback 改在 tmp 拷贝上应用；
// W1（restore-fork-attach-fix）tmp 管线整体删除，fallback 并入 F3 归一化管线：
// stripSessionEndEntries + applyHeaderCwdFallback 的变换产物经下方
// normalizeSessionFileInPlace 原地 rename-over 落回原文件（header cwd 降级值持久化
// 在原文件内；「header 永久保持旧 cwd」的旧声明已被取代，登记表 §4 例外③已更新）。

/**
 * restore-time 会话文件原地归一化（restore-fork-attach-fix W1 F3，登记表 §4 ⑨ 合法形态）。
 *
 * 用途：legacy 会话文件（含 session_end 行 / header cwd 死路径）restore 时的一次性
 * 变换落盘。调用方（restoreSession）已完成纯字符串变换（stripSessionEndEntries /
 * applyHeaderCwdFallback），本 helper 负责把变换产物写同目录临时名
 * `<原名>.tmp-migrate-<时间戳>.jsonl` → `renameSync` 原子覆盖原文件。
 *
 * 为什么必须原地 rename-over 而非写新文件：pi 的 switch_session 永久重绑读写目标
 * （pi-mono session-manager.ts setSessionFile 把传入路径存为永久 sessionFile，_persist
 * 每轮 appendFileSync 该路径），附着目标必须是原路径本身；且路径不变使按路径关联的
 * sidecar 四后缀派生 / fork 血缘 parentSession 指针 / scanner 关联全部无需迁移。
 *
 * 合法边界（登记表 §4 ⑨）：仅 inactive 文件（restoreSession 开头已销毁同 id 会话）；
 * 变换白名单 = strip session_end / header cwd fallback；每文件最多一次（归一化产物
 * 无 session_end 且 cwd 已修活 → 下次 restore 走 F2 直附着零改写，幂等收敛）。
 * 同目录 rename 是 POSIX 原子操作，无中间态可见；rename 前崩溃残留的
 * `.tmp-migrate-*.jsonl` 由 scanPiSessionsFromDisk 按文件名显式排除
 * （isScannableSessionFile——scanner 按内容识别 session 不按文件名，不过滤会产生
 * 同 sessionId 双条目，见该函数注释）；残留清理由三处机制承接（见
 * cleanupMigrateResidues）：rename 失败本函数回滚删除 + 附着前清扫 + delete 链清扫。
 *
 * @param filePath    原 session JSONL 绝对路径（内容被原子覆盖，路径不变）
 * @param transformed 变换后的完整 JSONL 文本
 *
 * [R1 豁免形态约束 + 拆分登记] 字符串版保持独立直写形态（写语句与本函数内 tmpPath
 * 单跳赋值链同函数 = R1 直写检查 exempt_tmp_migrate_target 可判定）；大文件的流式
 * 变体拆至 './session-file-streaming.ts'（max-lines 预算 + 一个概念一个模块），两版
 * tmp 命名 / rename-over / 回滚 / scanner 排除语义同源。
 */
export function normalizeSessionFileInPlace(filePath: string, transformed: string): void {
  // 临时名形态 = basename + '.tmp-migrate-' + 时间戳 + '.jsonl'（登记表 §4 ⑨；
  // R1 检查的豁免锚点 = '.tmp-migrate-' 字面量后缀，经写目标单跳赋值链回溯判定）
  const tmpPath = join(dirname(filePath), basename(filePath) + '.tmp-migrate-' + Date.now() + '.jsonl')
  writeFileSync(tmpPath, transformed, 'utf-8')
  try {
    renameSync(tmpPath, filePath)
  } catch (e) {
    // rename 失败回滚（差距复审 suggestion 6）：删除刚写的临时文件不留孤儿——原文件
    // 未被触碰仍完整，重试归一化即可；回滚删除自身失败（极端：目录权限突变）时仅
    // 残留一个被 scanner 排除的孤儿，附着前清扫 / delete 链清扫兜底。
    try { unlinkSync(tmpPath) } catch { void 0 }
    throw e
  }
}

// ── Session 扫描 ─────────────────────────────────────────────

/**
 * model binding 的扫描字段声明（ScannedSessionMeta extends 收编）。
 *
 * [缓存治理批 3 U8] 原 session-model-sidecar.ts 随 sidecar model 家族整体退役（W6 写点
 * 删除后无消费方），字段声明迁回本文件与 ScannedSessionMeta 同文件；字段本身保留——
 * 值源 = extractLatestModelFromJsonl 反向读 JSONL 真源（非 sidecar）。
 */
export interface ModelBindingFields {
  /**
   * 该 session 生效的模型 id。反向读 session JSONL（model_change / assistant
   * entry 最近一条，JSONL 真源），'provider/modelId' 格式。undefined 表示无模型信息
   * （历史 session path 上无任何模型 entry / 文件不存在）。
   */
  modelId?: string
  /**
   * 该 session 生效的思考等级。反向读 session JSONL（thinking_level_change
   * 最近一条）；无 entry 时为 pi 默认 'off'。undefined 表示无模型信息（随 modelId）。
   */
  thinkingLevel?: string
}

/** scanPiSessions 返回的单条 session 元信息（持久化会话扫描结果）。 */
export interface ScannedSessionMeta extends ModelBindingFields {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  /** W3 三读合一：outcome 随 meta 一起提取，scannedToSummary 直接取不再独立读文件（消除第 3 次全量读）。 */
  outcome: SessionOutcome | null
  lastModified: number
  size: number
  /** 父 session 血缘键（FR-3，从 header 提取）。 */
  parentSession?: string
  /** fork 锚点 entry id（FR-3，从 header 提取）。 */
  forkEntryId?: string
  /** handoff 目标 session id（FR-5，从 JSONL handoff_marker 尾读）。 */
  handedOffTo?: string
  /**
   * 该 session 启动时绑定的 launch preset id（从 .preset.json sidecar 读，设计文档 §4）。
   * undefined 表示无 sidecar（历史 session / create 时未绑定 preset）。
   */
  launchPresetId?: string
  /**
   * 归属 project id（从 .project.json sidecar 读，D14 语义修正 2026-08-04）。
   * undefined = 未归类（展示层归入默认项目 proj-default 兑底）。
   */
  projectId?: string
  /**
   * session 来源标记（从 .agent.json sidecar 读，agent-managed-session）。
   * 'agent' 表示由 agent spawn 创建；readAgentBinding 守卫收窄枚举（非法值降级 undefined）。
   * undefined = 非 agent 管理的普通 session。
   */
  spawnSource?: 'user' | 'agent'
  /**
   * 父 agent session id（从 .agent.json sidecar 读，agent-managed-session）。
   * 记录 spawn 该 session 的父 agent session。undefined = 非 agent 管理的普通 session。
   */
  parentAgentSessionId?: string
  // modelId / thinkingLevel 字段声明 = 上方 ModelBindingFields（本接口 extends 收编，
  // 值源为 extractLatestModelFromJsonl 反向读）；BindingFieldKey 的 OptionalKeys 派生对
  // extends 字段照常生效，session-binding-fields.ts 注册表不受影响。
}

// 绑定字段注册表已抽出至 './session-binding-fields.ts'（BINDING_FIELDS / hydrateBindingMeta /
// CREATE_DERIVED_CALLERS 单一权威源，sidecar-binding-sync 设计文档；抽出原因：本文件
// 聚焦 sidecar 文件 IO 与缓存治理，lint max-lines 预算留给 IO 逻辑）。

// sessionMetaCache（W3 文件级 mtime+size 缓存，含 INVAR-cache 与 KNOWN-LIMIT 完整说明）
// 与 CachedSessionMeta 类型已迁 './session-binding-sidecar-io.ts'（persistBindingSidecar
// 骨架的私有闭包，随骨架下沉；经上方 import 的 Map 引用操作，全仓唯一实例不变）。
// 下方两个治理函数留本文件维持原导出路径（测试与 session-store 直接消费）。

/** 仅供测试重置缓存用（生产不调）。 */
export function _resetSessionMetaCacheForTest(): void {
  sessionMetaCache.clear()
}

/** 删除 session 时调用，清理 sessionMetaCache 中的 stale 条目（避免无界增长）。 */
export function invalidateSessionMetaCache(filePath: string): void {
  sessionMetaCache.delete(filePath)
}

// [SSOT 指针] 新增绑定字段必经此处填充 ScannedSessionMeta——必须同步在
// session-binding-fields.ts 的 BINDING_FIELDS 注册表登记（漏登记=编译错），
// 回填入口适用性（hydrateBindingMeta 四入口矩阵）与 create 派生调用方清单均在该模块维护。
/**
 * 扫描降级计数（RT-3#1，F5 留痕）：坏 header（id/cwd 缺失/空串）丢弃的条目数——
 * scanPiSessionsFromDisk 按轮汇总打点，让「侧栏少了会话」可归因。
 */
interface ScanDegradedStats {
  badHeader: number
}

/**
 * 单个 session 文件的元数据提取（三读合一 + 缓存）。
 *
 * 1. statSync 拿 mtimeMs + size，查缓存 (path, mtimeMs, size)
 * 2. 命中（INVAR-cache-3）→ 返回缓存 meta（零文件读取）
 * 3. miss → parseSessionHeader + extractSessionName + extractSessionOutcome 一次提取全部 → 写缓存
 *
 * 三读合一（FR-three-read-merge）：原 scanPiSessions 调 parseSessionHeader（全量读首行）
 * + extractSessionName（尾读），scannedToSummary 再调 extractSessionOutcome（第 3 次全量读）。
 * 现统一在此一次提取，scannedToSummary 从 meta.outcome 取（INVAR-merge-2）。
 *
 * 文件删除/不可读（INVAR-cache-4）→ 清该 key 返回 null。
 *
 * RT-3#1：header 缺 id/cwd（非空字符串）→ fail-fast 返回 null + warn 带路径 + 计入
 * degraded.badHeader。id/cwd 是消费链硬依赖（scannedToSummary 的 basename(cwd)、按
 * cwd 分组键、restore 按 id 定位）——此前 parseSessionHeader 条件赋值不设字段、
 * `as SessionHeader` 收口，异常发生在**消费**阶段（basename(undefined) TypeError），
 * 扫描侧 catch 拦不住，一个坏文件毒死整个侧栏。出口收口对齐 import 侧
 * parseHeaderFromFirstLine 的「id/cwd 均非空字符串才收录」同款清单（外部文件不修
 * 本体，删/修文件后自动恢复收录）。与「非 session 文件」同不缓存（下次仍尝试）。
 */
function scanSessionMeta(filePath: string, degraded?: ScanDegradedStats): ScannedSessionMeta | null {
  let fstat
  try {
    fstat = statSync(filePath)
  } catch {
    // 文件不存在/不可读：清 stale 缓存条目（INVAR-cache-4），返回 null
    sessionMetaCache.delete(filePath)
    return null
  }

  const cached = sessionMetaCache.get(filePath)
  // INVAR-cache-2: 键含 (mtimeMs, size)，任一变 → miss
  if (cached && cached.mtimeMs === fstat.mtimeMs && cached.size === fstat.size) {
    return cached.meta // INVAR-cache-3: 命中，逐字节一致
  }

  // miss：三读合一提取全部元数据
  const header = parseSessionHeader(filePath)
  if (!header) {
    // 非 session 文件（首行不是 session header）：不缓存（下次仍尝试，开销小）
    return null
  }
  if (typeof header.id !== 'string' || header.id === '' || typeof header.cwd !== 'string' || header.cwd === '') {
    if (degraded) degraded.badHeader++
    console.warn(`[session-file-utils] session header missing/empty id or cwd, file skipped: ${filePath}`)
    return null
  }
  const name = extractSessionName(filePath)
  const outcome = extractSessionOutcome(filePath)
  const handedOffTo = extractHandedOff(filePath)
  // 第四读：preset binding sidecar（设计文档 §4），与 name/outcome/handedOffTo 同批次
  // 提取，结果合并进 meta.launchPresetId，享受 sessionMetaCache 缓存。
  const launchPresetId = readPresetBinding(filePath)
  // 第五读：project binding sidecar（D14 语义修正），同批次提取进 meta.projectId。
  const projectId = readProjectBinding(filePath)
  // 第六读：agent binding sidecar（agent-managed-session），同批次提取进 meta.spawnSource / parentAgentSessionId。
  const agentBinding = readAgentBinding(filePath)
  const meta: ScannedSessionMeta = {
    id: header.id,
    filePath,
    cwd: header.cwd,
    timestamp: header.timestamp,
    name,
    outcome,
    lastModified: fstat.mtimeMs,
    size: fstat.size,
    parentSession: header.parentSession,
    forkEntryId: header.forkEntryId,
    handedOffTo,
    launchPresetId,
    projectId,
    spawnSource: agentBinding?.spawnSource,
    parentAgentSessionId: agentBinding?.parentAgentSessionId,
    // 第七读：model binding（extractLatestModelFromJsonl 同模块直调——U8 起 sidecar
    // 模块已退役，值源 = 反向读 JSONL 真源）。无模型信息时返回 undefined，对象展开
    // 零字段，与逐字段 `?.` 赋 undefined 等价。
    ...extractLatestModelFromJsonl(filePath),
  }
  sessionMetaCache.set(filePath, { mtimeMs: fstat.mtimeMs, size: fstat.size, meta })
  return meta
}

/**
 * wave:perf-w26（D9-1）：sessions 目录列举层 TTL 缓存有效期（1s）。
 *
 * 列表构建消费方（SessionScanner.listAll → listPersistedSessions，侧栏列表）在 TTL 窗口内
 * 直接命中缓存快照（零 readdirSync/statSync）。1s 保证 pi 落盘新 session 文件后秒级出现在
 * 列表（pi 延迟写入：首个 assistant 前不落盘，列表本就无法更早发现，TTL 过期即重扫）。
 *
 * 正确性敏感的**单 session 路径解析消费方**（getHistoryTailFromFile / getSubagentHistory /
 * getSubagents / getWorkflows / findScannedSession 等）必须传 force 旁路——pi 是外部进程
 * 写文件，不在显式失效覆盖内，若走 TTL 缓存，刚落盘 session 的查找会在窗口内静默返回
 * 空（05-scan-caching D9-1 审查修正，plan M-3）。
 */
export const SCAN_DIR_TTL_MS = 1000

/** scanPiSessions 的分层选项（wave:perf-w26 D9-1 消费方分层）。 */
export interface ScanSessionsOptions {
  /**
   * 单 session 路径解析消费方传 true：绕过目录 TTL 缓存强制刷新（正确性优先，
   * 刚落盘 session 在 TTL 窗口内也必须解析到）。
   */
  force?: boolean
}

// scanDirCache / scanDirLastNow / ScanDirCacheEntry / invalidateScanDirCache 已迁
// './session-binding-sidecar-io.ts'（persistBindingSidecar 骨架的私有闭包随迁；let 可变
// 绑定不可跨模块赋值，scanPiSessions 的缓存读写经 lookupScanDirCache /
// refreshScanDirCache 函数对）。invalidateScanDirCache 经上方 re-export 维持原导出路径
// （session-store / import-service / 测试直接消费）。

/**
 * 扫描 pi 的 sessions 目录（按 cwd 分组的子目录结构）。
 * 返回扁平化的 session 列表。
 *
 * W3：scanSessionMeta 三读合一 + 缓存。每文件 miss 时 1 次提取 header+name+outcome，
 * hit 时零读取（仅 statSync）。
 *
 * wave:perf-w26（D9-1）：目录列举层 1s TTL 缓存——默认（列表构建消费方）窗口内返回
 * 缓存快照；opts.force=true（路径解析消费方）绕过缓存强制刷新。
 */
export function scanPiSessions(opts?: ScanSessionsOptions): ScannedSessionMeta[] {
  const dir = getSessionsDir()
  const now = Date.now()
  // TTL 命中/时钟回拨检测/快照写回归属于 './session-binding-sidecar-io.ts'（lookup 内含
  // 回拨防护：now 落到上次观测之前 → 缓存不可信强制 miss，并以回拨后的时钟重建基准；
  // 观测基准在命中判断前无条件更新，与原内联实现时序一致）。
  const snapshot = lookupScanDirCache(dir, now, opts?.force === true)
  if (snapshot !== null) {
    // 浅拷贝数组：消费者可安全 sort/splice，不污染缓存本体（meta 元素引用与
    // sessionMetaCache 共享，现状已是只读契约）。
    return [...snapshot]
  }
  const results = scanPiSessionsFromDisk(dir)
  // force 刷新同样写缓存：随后 1s 内的列表构建消费方零 IO 读到最新视图。
  refreshScanDirCache(dir, now, SCAN_DIR_TTL_MS, results)
  return [...results]
}

/**
 * 判断目录项文件名是否为 scan 应收录的 session JSONL。
 *
 * 除 `.jsonl` 后缀外，显式排除崩溃残留标记家族（W1 F1 修复 + import-session D1/r2-S1
 * 扩展）：restore-time 归一化（normalizeSessionFileInPlace）在写临时名与 rename 之间
 * 崩溃时会残留 `<原名>.tmp-migrate-<ts>.jsonl`；导入复制（tmp+rename，D1）同形态残留
 * `<原名>.tmp-import-<ts>.jsonl` 于 sessions 目录。scanner 按内容（首行 session header）
 * 识别 session、不按文件名——残留文件内容是合法 session（同 sessionId），不过滤会产生
 * 同 id 双条目，且残留 mtime 更新、排序在前，findScannedSession 会命中残留路径 →
 * restore 附着错位文件。文件名过滤把「残留无害」从声明变成机制保证（候选侧与清扫侧
 * 同规则，TMP_RESIDUE_MARKERS）。
 */
export function isScannableSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') && !TMP_RESIDUE_MARKERS.some((marker) => name.includes(marker))
}

function scanPiSessionsFromDisk(sessionsDir: string): ScannedSessionMeta[] {
  if (!existsSync(sessionsDir)) return []

  const results: ScannedSessionMeta[] = []
  // RT-3#1：坏 header 丢弃计数（degraded 显形）——scanSessionMeta 出口 fail-fast 计入，
  // 扫描轮末汇总打点，单条坏文件「侧栏少一条」可归因（与 F5 留痕族先例同形）。
  const degraded: ScanDegradedStats = { badHeader: 0 }

  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch (e) {
    // L8: sessions 目录存在但不可读（权限/IO 故障）时，readdirSync 抛 EACCES 等异常。
    // 原实现未保护会冒泡为进程级未捕获异常，此处降级为返回空数组（scan 容忍失败）。
    console.error(`[session-file-utils] scanPiSessions: failed to read sessions dir: ${sessionsDir}`, e)
    return []
  }

  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry)
    let stat
    try {
      stat = statSync(entryPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      try {
        // 文件名过滤（isScannableSessionFile）：排除 .tmp-migrate- 归一化崩溃残留
        const files = readdirSync(entryPath).filter(isScannableSessionFile)
        for (const file of files) {
          const filePath = join(entryPath, file)
          try {
            const meta = scanSessionMeta(filePath, degraded)
            if (meta) results.push(meta)
          // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entries
          } catch {
            // skip
          }
        }
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session subdirectory
      } catch {
        // skip unreadable dir
      }
    } else if (isScannableSessionFile(entry)) {
      try {
        const meta = scanSessionMeta(entryPath, degraded)
        if (meta) results.push(meta)
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entry
      } catch {
        // skip
      }
    }
  }

  if (degraded.badHeader > 0) {
    console.warn(
      `[session-file-utils] scanPiSessions: ${degraded.badHeader} session file(s) dropped due to bad header (missing/empty id or cwd) — check files above; fixing or removing the file restores it to the list`,
    )
  }

  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}

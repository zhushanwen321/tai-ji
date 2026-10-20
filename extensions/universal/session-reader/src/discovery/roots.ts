import { readdir, stat, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  resolveArchiveDir,
  scanArchiveLedgers,
  type ArchiveLedgerEntry,
} from './archive-ledger.js'

/**
 * M2 discovery 发现层：文件系统扫描（design §3.3 D-5 首行扫描策略的文件定位部分）。
 *
 * agentDir 注入：本模块所有函数接收 `agentDir: string` 参数，**不调用** `getAgentDir()`
 *（pi SDK，调用留到 M3 tool-adapter 层）。故本模块零 pi 依赖，仅 node:fs + 相对
 * import M1 core，可完全单测。
 *
 * U1（design 2026-09-10 §6.1/§7B）：新增 `resolveSessionRoots(signals)` —— 信号包 →
 * 带来源标签的候选根列表，逐根扫描、按 realpath 去重（同路径只扫一次，保留最高优先级
 * kind 标签）。B 收缩（design §6.13）：布局对齐后无 `[env]` 信号，`[default]` 为主根。
 * 旧签名 `listMainSessions`/`listSubagentSessions` 薄包装已删除（ext-simplify-04 U4/A3：
 * 内部即「resolveSessionRoots + filter」恒等式，包内原唯一消费者 subagents.ts 改直调；
 * npm 深 import 移除按 minor breaking 在 CHANGELOG 登记）。
 */

// ============================================================
// 候选根契约（U1 foundation：后续 doctor / find / family 共享）
// ============================================================

/** 发现层信号包（index.ts 采集，全部可降级；本模块只消费不采集） */
export interface SessionRootSignals {
  /** pi agent 数据目录（两宿主均成立；B 后 taiji = `<dataDir>/agent`） */
  agentDir: string
  /**
   * 宿主已解析的 live session 目录（`ctx.sessionManager.getSessionDir()`，§6.1 信号 1）。
   * 缺失/undefined 时走三根降级（`[default]`+`[legacy]`+`[subagent]`，§7B 要点 2）。
   */
  liveSessionDir?: string
}

/** 候选根来源标签；kind 优先级 live > default > legacy > subagent > archive（§6.1 信号序 + D7 追加） */
export type SessionRootKind = 'live' | 'default' | 'legacy' | 'subagent' | 'archive'

/** main 源 = 主 session 根（live/default/legacy/archive）；subagent 源 = subagent 会话根 */
export type SessionRootSource = 'main' | 'subagent'

/** 候选根（含扫描结果）。去重后每 kind 至多一个根，kind 即 doctor 表行键。 */
export interface SessionRoot {
  kind: SessionRootKind
  /** 规范化后的绝对路径（`[live]` 已剥 encodeCwd 层） */
  path: string
  source: SessionRootSource
  /** 目录是否存在（不存在的根仍列出——doctor 表「存在」列与三根降级可见性需要） */
  exists: boolean
  /** 扫描所得 .jsonl 数（= files.length）；未扫描（被去重）时 undefined */
  fileCount?: number
  /** 本根 scanJsonlRecursive 耗时 ms；未扫描时 undefined */
  scanMs?: number
  /** 扫描所得文件列表（design §7B 要点 8「本就在返回值里」）；未扫描时空数组 */
  files: SessionFileMeta[]
  /**
   * 归档根（kind='archive'）专属：簿记收集器产出（D7 独立收集契约——收
   * `.archive.json` 不收 `.jsonl`，故 files 恒空、fileCount = 簿记数）。
   * 其余根不挂此字段。
   */
  archiveEntries?: ArchiveLedgerEntry[]
  /**
   * realpath 与更高优先级根同路径 → 指向保留根的 kind，本根未扫描（doctor 渲染
   * 「与 N 同路径，已去重」注记的依据，§7B 要点 4）。
   */
  dedupedInto?: SessionRootKind
}

/** 各根固定子目录名（常量推导，不来自信号——§6.1 信号 5） */
const SESSIONS_DIRNAME = 'sessions'
const SUBAGENTS_DIRNAME = 'subagents'

/**
 * taiji session 存储树根段（`<dataDir>/ext-sessions/`）。
 *
 * session-reader 是 extension 不 import @taiji/shared——本常量是 shared
 * `SESSION_STORE_DIR_SEGMENT` 的同字面镜像，dataDir 推导先例 = `dirname(agentDir)`
 * 基址（布局 B `agentDir = <dataDir>/agent`；同 tool-handler doExport 导出落点）。
 * 字面量一致性由对拍机检锚点 `scripts/check-artifact-dir-formula-sync.mjs`（域 9
 * session-reader discovery 断言位）锁定，树根段改名时 shared 与此处同批改。
 */
const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

/**
 * 存储树分区目录名合法性正则（镜像 shared `PI_SESSION_ID_PATTERN`，同域规则：首尾
 * 字母数字，中间允许 [A-Za-z0-9._-]；禁 `:`——btw 虚拟 id 必拒）。对拍机检锚点同上。
 *
 * [session-store-layout-inversion] 存储树扫描（subagent 根 / records manifest）以
 * 此过滤 `<root>/` 一级目录——既是剪枝也是路径注入防线（目录名即 sessionId）。
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/**
 * session 存储树根目录（`<dataDir>/ext-sessions/`，dataDir = dirname(agentDir)）。
 *
 * 新布局全部 session 维度衍生数据的统一落点（布局权威 = shared getSessionStoreDir，
 * 本函数是 extension 侧镜像推导）；旧布局 `<agentDir>/subagents` 不再读写（设计裁决
 * D6：旧布局存量原位保留、不可见）。
 */
export function resolveSessionStoreRoot(agentDir: string): string {
  return join(dirname(agentDir), SESSION_STORE_DIR_SEGMENT)
}

/** 存储树某根会话分区的 subagent 域目录（`<root>/<rootSessionId>/subagents/`）。 */
export function resolveStoreSubagentsDir(agentDir: string, rootSessionId: string): string {
  return join(resolveSessionStoreRoot(agentDir), rootSessionId, SUBAGENTS_DIRNAME)
}

/** subagent 会话 jsonl 目录（`<root>/<rootSessionId>/subagents/sessions/`）。 */
export function resolveStoreSubagentSessionsDir(agentDir: string, rootSessionId: string): string {
  return join(resolveStoreSubagentsDir(agentDir, rootSessionId), 'sessions')
}

/** ExecutionRecord manifest 目录（`<root>/<rootSessionId>/subagents/records/`）。 */
export function resolveStoreSubagentRecordsDir(agentDir: string, rootSessionId: string): string {
  return join(resolveStoreSubagentsDir(agentDir, rootSessionId), 'records')
}

/**
 * 枚举存储树 `<root>/` 一级合法会话分区目录名（isPiSessionId 过滤，见
 * PI_SESSION_ID_PATTERN 注释）。根不存在/无权限 → 空数组，不抛错。
 */
export async function listSessionStorePartitions(storeRoot: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(storeRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && PI_SESSION_ID_PATTERN.test(e.name))
    .map((e) => e.name)
}

/**
 * `[live]` 规范化（§6.1/§7B 要点 3）：`getSessionDir()` 在纯 pi 返回按 cwd 编码的子目录
 *（`<agentDir>/sessions/--Users-x--`），在 taiji 覆盖态返回根本身。判据：basename
 * 匹配 encodeCwd 形态（`--` 开头 `--` 结尾）则取 dirname，否则取自身。
 */
export function normalizeLiveSessionDir(liveSessionDir: string): string {
  const base = basename(liveSessionDir)
  return base.startsWith('--') && base.endsWith('--')
    ? dirname(liveSessionDir)
    : liveSessionDir
}

/**
 * 从信号包推导候选根（未扫描骨架），数组序 = 优先级序（§6.1）。
 * `[subagent]` 恒在（常量推导）；`[live]` 仅在信号存在时出现；`[archive]` 恒在
 * 骨架中（D7 第五根，纳入与否由 resolveSessionRoots 按「存在才扫」判定）。
 */
function sessionRootSpecs(signals: SessionRootSignals): SessionRoot[] {
  // 空 agentDir 防御：派生式会退化为 cwd 相对路径（'sessions'/'./sessions'），可能扫到
  // 进程 cwd 下的无关目录——宁缺毋错（§11.14 空 agentDir 自举由宿主层兜底）
  if (signals.agentDir.length === 0) return []
  const specs: SessionRoot[] = []
  if (signals.liveSessionDir !== undefined && signals.liveSessionDir.length > 0) {
    specs.push(spec('live', 'main', normalizeLiveSessionDir(signals.liveSessionDir)))
  }
  specs.push(spec('default', 'main', join(signals.agentDir, SESSIONS_DIRNAME)))
  specs.push(spec('legacy', 'main', join(dirname(signals.agentDir), SESSIONS_DIRNAME)))
  // [session-store-layout-inversion] subagent 根 = 存储树根（`<dataDir>/ext-sessions`），
  // 扫描在 sid 分区内定向探 subagents/sessions/（scanStoreSubagentJsonl）；旧布局
  // `<agentDir>/subagents` 不再读（设计裁决 D6：存量原位保留、不可见）。
  specs.push(spec('subagent', 'subagent', resolveSessionStoreRoot(signals.agentDir)))
  // [session-archive D7] 第五根 = 归档根（`<agentDir>/archive`，镜像 sessions 平级布局）。
  // 收集契约与四根不同：不收 .jsonl、收 .archive.json 簿记（见 resolveSessionRoots
  // 分流与 scanArchiveLedgers）；source=main（归档对象是主 session）。
  specs.push(spec('archive', 'main', resolveArchiveDir(signals.agentDir)))
  return specs
}

function spec(kind: SessionRootKind, source: SessionRootSource, path: string): SessionRoot {
  return { kind, source, path, exists: false, files: [] }
}

/** realpath 解析失败（目录不存在等）→ 回退字面路径作去重键（同字面路径仍可去重） */
async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const SKIP_DIRS_NONE = new Set<string>()

// ============================================================
// 扫描 options（u8 追加：doctor「同一数据源两处渲染，不重复实现探测」§6.3——
// doctor 经 options 驱动 subagent 根不扫。原 u8 的进程内缓存注入点已删除
// （ext-simplify-04 U3）：每次调用实扫，本模块不再持有任何缓存语义）
// ============================================================

/** resolveSessionRoots 扫描行为选项（全部可选，缺省 = 既有行为零变化） */
export interface SessionRootScanOptions {
  /**
   * subagent 根扫描模式：`'scan'`（默认，现行为——递归扫出文件数）| `'stat'`
   *（doctor 默认形态与 not-found 文案 §6.3——只做存在性检查，fileCount/scanMs
   * 恒 undefined）。subagent 根在纯 pi 下可达数千文件，doctor 可能被反复询问。
   */
  subagents?: 'scan' | 'stat'
}

/**
 * 解析候选根并逐根扫描（design 2026-09-10 §6.1 候选根探测 / §7B 要点 3/4/6）。
 *
 * 优先级 live > default > legacy > subagent > archive；按 realpath 去重：同路径多信号
 * 只扫一次，保留最高优先级 kind 标签，被去重的根以 `dedupedInto` 标注（不产生
 * fileCount/scanMs）。逐根扫描：main 源整树递归（跳 workflow-state）；subagent 源 =
 * 存储树定向扫描（[session-store-layout-inversion] 单新根，见 scanStoreSubagentJsonl）；
 * archive 源 = 簿记收集器（[session-archive D7] 收 .archive.json 不收 .jsonl，
 * **存在才纳入**——目录不存在时该根不进返回列表，对无归档目录的环境零行为变化）。
 * 单根失败（不存在/无权限）→ 空结果继续，不抛错（沿用 listXxxSessions 契约）。
 *
 * options（u8 追加，全部缺省安全）：`subagents:'stat'` 让 subagent 根只做存在性检查。
 * 无缓存——每次调用实扫（原 u8 cache 注入点已删除，ext-simplify-04 U3；find/F1
 * 自检行计数与 doctor 表计数同取本次实扫，§7B 要点 8）。
 */
export async function resolveSessionRoots(
  signals: SessionRootSignals,
  options?: SessionRootScanOptions,
): Promise<SessionRoot[]> {
  const subagentMode = options?.subagents ?? 'scan'
  const out: SessionRoot[] = []
  const byRealPath = new Map<string, SessionRoot>()
  for (const candidate of sessionRootSpecs(signals)) {
    if (candidate.kind === 'archive') {
      // [session-archive D7] 存在才纳入：目录不存在 → 整根不进返回（备注「目录存在即
      // 纳入」的逆向——非 taiji/纯 pi 用户无 archive 目录，doctor 表与 F1 自检行零变化）
      if (!(await pathExists(candidate.path))) continue
      const key = await safeRealpath(candidate.path)
      const kept = byRealPath.get(key)
      if (kept) {
        // 同 realpath：不扫描，标注归属（与普通根 kept 检查同构——archive kind 优先级
        // 最低，归档目录与更高优先级根同路径时只保留一根，doctor 表不重复计数；
        // 漏此检查会既出重复根、又以本根覆盖 byRealPath 致后续根 dedupedInto 失效）
        out.push({ ...candidate, exists: true, dedupedInto: kept.kind })
        continue
      }
      const t0 = performance.now()
      const archiveEntries = await scanArchiveLedgers(candidate.path)
      const scanMs = performance.now() - t0
      // 归档根不走 scanJsonlRecursive（.jsonl 不收）：files 恒空，fileCount = 簿记数
      const root: SessionRoot = {
        ...candidate,
        exists: true,
        fileCount: archiveEntries.length,
        scanMs,
        files: [],
        archiveEntries,
      }
      byRealPath.set(key, root)
      out.push(root)
      continue
    }
    const key = await safeRealpath(candidate.path)
    const kept = byRealPath.get(key)
    if (kept) {
      // 同 realpath：不扫描，标注归属（exists 与保留根同目录，必然一致）
      out.push({ ...candidate, exists: kept.exists, dedupedInto: kept.kind })
      continue
    }
    if (candidate.source === 'subagent' && subagentMode === 'stat') {
      // doctor 默认形态 / not-found 文案（§6.3）：只列路径与可扫性，不产文件数
      out.push({ ...candidate, exists: await pathExists(candidate.path) })
      continue
    }
    // subagent 源 = 存储树定向扫描（sid 分区剪枝，见 scanStoreSubagentJsonl）；
    // main 源维持整树递归（跳 workflow-state）
    const t0 = performance.now()
    const files =
      candidate.source === 'subagent'
        ? await scanStoreSubagentJsonl(candidate.path)
        : await scanJsonlRecursive(candidate.path, SKIP_DIRS_MAIN)
    const scanMs = performance.now() - t0
    const exists = await pathExists(candidate.path)
    const root: SessionRoot = {
      ...candidate,
      exists,
      fileCount: files.length,
      scanMs,
      files,
    }
    byRealPath.set(key, root)
    out.push(root)
  }
  return out
}

export interface SessionFileMeta {
  /** 绝对路径 */
  path: string
  mtime: number
  size: number
}

/**
 * main sessions 扫描时整体跳过的子目录名。
 * `workflow-state` 目录存放 workflow 运行状态文件（wf-*.jsonl，首行 `{"v":"wf-run-v1"|"wf-run-v2"...}`，
 * 版本随 subagent-workflow 快照格式演进，读取侧 v1/v2 兼容），非 session 文件——属 family 路径
 * 独立处理（design §3.3 D-7），扫描 main sessions 时排除，
 * 否则会把 wf 文件误收为 session（且 find.ts 读其首行 header 时会因 type≠session 被丢弃，
 * 在此排除可避免这批无效首行扫描）。
 */
const SKIP_DIRS_MAIN = new Set(['workflow-state'])

/**
 * 文件名是否为待收的 session .jsonl。
 * `.jsonl.finalized` 不以 `.jsonl` 结尾，故 `endsWith('.jsonl')` 天然排除之
 *（design §3.3 D-7 Q2：finalized 是已完成态快照副本，与 .jsonl 同 base name 并存，不收）。
 */
function isSessionJsonl(name: string): boolean {
  return name.endsWith('.jsonl')
}

/**
 * 存储树 subagent 根定向扫描（[session-store-layout-inversion] 读侧单新根）：
 * 只探 `<root>/<rootSessionId>/subagents/sessions/` 固定位置。`<root>/` 一级只进
 * isPiSessionId 形态目录（剪枝：不进 logs/attachments 等大目录，也挡非分区名目录）；
 * 每 sid 分区内 records/ model-switch/ 不扫（会话文件域独立）。sessions/ 内部维持
 * 递归 + stat（复用 scanJsonlRecursive，`.finalized` 天然排除）。存储树根或分区目录
 * 不存在/无权限 → 空结果，不抛错（listXxxSessions 契约）。
 */
async function scanStoreSubagentJsonl(storeRoot: string): Promise<SessionFileMeta[]> {
  const results: SessionFileMeta[] = []
  for (const sid of await listSessionStorePartitions(storeRoot)) {
    results.push(
      ...(await scanJsonlRecursive(join(storeRoot, sid, SUBAGENTS_DIRNAME, 'sessions'), SKIP_DIRS_NONE)),
    )
  }
  return results
}

/**
 * 递归扫描 rootDir 下所有 .jsonl 文件（排除 .finalized），返回绝对路径 + mtime + size。
 * `skipDirs` 命名的目录整体跳过。目录不存在/无权限 → 返回空数组，不抛错（design §2 坏路径容错）。
 */
async function scanJsonlRecursive(
  rootDir: string,
  skipDirs: Set<string>,
): Promise<SessionFileMeta[]> {
  const results: SessionFileMeta[] = []

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限 → 静默返回（容错，listXxxSessions 契约要求不抛错）
    }
    for (const entry of entries) {
      const full = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && isSessionJsonl(entry.name)) {
        try {
          const s = await stat(full)
          results.push({ path: full, mtime: s.mtimeMs, size: s.size })
        } catch (err) {
          // 文件并发删除等致 stat 失败 → 跳过（不中断整体扫描）；
          // 本模块零 pi 依赖（无 logger 可用），不留 void err 以外的语句
          void err
        }
      }
    }
  }

  await walk(rootDir)
  return results
}


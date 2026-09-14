import { readdir, stat, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'

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
  /** pi agent 数据目录（两宿主均成立；B 后 xyz-agent = `<dataDir>/agent`） */
  agentDir: string
  /**
   * 宿主已解析的 live session 目录（`ctx.sessionManager.getSessionDir()`，§6.1 信号 1）。
   * 缺失/undefined 时走三根降级（`[default]`+`[legacy]`+`[subagent]`，§7B 要点 2）。
   */
  liveSessionDir?: string
}

/** 候选根来源标签；kind 优先级 live > default > legacy > subagent（§6.1 信号序） */
export type SessionRootKind = 'live' | 'default' | 'legacy' | 'subagent'

/** main 源 = 主 session 根（live/default/legacy）；subagent 源 = subagent 会话根 */
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
   * realpath 与更高优先级根同路径 → 指向保留根的 kind，本根未扫描（doctor 渲染
   * 「与 N 同路径，已去重」注记的依据，§7B 要点 4）。
   */
  dedupedInto?: SessionRootKind
}

/** 各根固定子目录名（常量推导，不来自信号——§6.1 信号 5） */
const SESSIONS_DIRNAME = 'sessions'
const SUBAGENTS_DIRNAME = 'subagents'

/**
 * `[live]` 规范化（§6.1/§7B 要点 3）：`getSessionDir()` 在纯 pi 返回按 cwd 编码的子目录
 *（`<agentDir>/sessions/--Users-x--`），在 xyz-agent 覆盖态返回根本身。判据：basename
 * 匹配 encodeCwd 形态（`--` 开头 `--` 结尾，实证见 `~/.pi/agent/sessions/` 全部子目录
 * 与 real-data.ts）则取 dirname，否则取自身。
 */
export function normalizeLiveSessionDir(liveSessionDir: string): string {
  const base = basename(liveSessionDir)
  return base.startsWith('--') && base.endsWith('--')
    ? dirname(liveSessionDir)
    : liveSessionDir
}

/**
 * 从信号包推导候选根（未扫描骨架），数组序 = 优先级序（§6.1）。
 * `[subagent]` 恒在（常量推导）；`[live]` 仅在信号存在时出现。
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
  specs.push(spec('subagent', 'subagent', join(signals.agentDir, SUBAGENTS_DIRNAME)))
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
// doctor 经 options 驱动 subagent 根不扫。原 u8 的进程内缓存注入面已删除
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
 * 优先级 live > default > legacy > subagent；按 realpath 去重：同路径多信号只扫一次，
 * 保留最高优先级 kind 标签，被去重的根以 `dedupedInto` 标注（不产生 fileCount/scanMs）。
 * 逐根复用 scanJsonlRecursive（main 源跳 workflow-state；subagent 源不跳）。单根失败
 * （不存在/无权限）→ 空结果继续，不抛错（沿用 listXxxSessions 契约）。
 *
 * options（u8 追加，全部缺省安全）：`subagents:'stat'` 让 subagent 根只做存在性检查。
 * 无缓存——每次调用实扫（原 u8 cache 注入面已删除，ext-simplify-04 U3；find/F1
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
    const skipDirs = candidate.source === 'main' ? SKIP_DIRS_MAIN : SKIP_DIRS_NONE
    const t0 = performance.now()
    const files = await scanJsonlRecursive(candidate.path, skipDirs)
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
 * 版本随 subagent-workflow 快照格式演进，读取侧 v1/v2 兼容），非 session 文件——属 family 腿
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


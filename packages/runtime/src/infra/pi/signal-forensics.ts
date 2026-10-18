/**
 * 受管 pi 进程死亡信号取证（crash-forensics-and-watchdog §3.3 D10 的归因延伸面）。
 *
 * 背景（2026-10-13 01a132f3 事故）：该 session 的 pi 进程于 01:51:49.322Z 与兄弟
 * session 01a132f0 的 pi 在**同一毫秒**收到外部 SIGTERM，pi 的 rpc-mode 信号处理器
 * （pi-coding-agent@1.0.0 dist/modes/rpc/rpc-mode.js:283：`shutdown(signal === "SIGHUP"
 * ? 129 : 143, signal)`，语义登记 PS-80 @ docs/pi-semantics.json，探针
 * pi-semantics-signal-exit-codes.test.ts 守漂移）以 exit 143 优雅退出。D10 的机器面快照只回答「死状 + 同秒连坐」，
 * 「谁发的信号」缺归因面——且三条确定性路线全部被封：
 *   ① macOS 不为普通 kill(2) 记系统日志（崩溃处理器 log show 关联只捞到 mDNS STOP）；
 *   ② EndpointSecurity 的 AUE_kill 审计需 Apple 特批 entitlement（第三方不可得）；
 *   ③ Darwin ptrace 无 PTRACE_GETSIGINFO（信号投递 stop 拿不到 siginfo.si_pid）。
 * 故本模块取「最佳努力 + 强指纹」路线，把不可确定的归因变成可机器复核的候选集：
 *
 * ① 滚动进程表环（ProcessTableRing，process-table-ring.ts）：受管 pi 存活期间以固定间隔（默认 1.5s）采样
 *    全进程表（`ps -axo pid=,ppid=,command=`），有界环缓冲（默认 40 样本 ≈ 60s 历史）。
 *    采样 fire-and-forget best-effort：ps 失败跳过本次（连续失败仅计数不刷屏），
 *    上一次采样未回不重叠（防 ps 卡死时定时器堆积）。
 * ② 死亡即时转储（captureSignalForensics）：exit_converge（非 intentional destroy
 *    的意外退出）时同步取环内死亡前窗口样本 + 异步取一帧新快照，diff 出两类候选：
 *    - vanished：死亡前窗口内在场、死亡时新快照中已消失——短命发送方（kill 脚本 /
 *      pkill 一次性 shell）的强指纹；
 *    - suspiciousPresent：仍存活且命令行命中启发式（kill 族工具 / 引用 pi 二进制或
 *      --mode rpc / 交互 shell）——常驻发送方（终端里手敲 kill）。
 *    对头部候选补采 `ps -p <pid> -o lstart=`（进程启动时刻）：启动时刻贴近死亡
 *    时刻 = 强信号（先起进程再下手）。
 * ③ 落盘双写：crash journal `signal-forensics` 事件（schema 扩展值，含 ≤2KB digest +
 *    detailPath）+ 全量记录 JSONL 追加到 `<dataDir>/logs/signal-forensics-<date>-
 *    <sid>.jsonl`（logger.ts cleanExpiredLogs 同前缀白名单覆盖，保留期清理自动接管）。
 *
 * 原理性极限（显式声明，不伪装确定性）：环间隔内生灭 <1.5s 的短命发送方可能两次
 * 采样都不在场而漏采；候选集是给人/评估器复核的线索而非定罪证据。fail-safe 方向
 * 是「可能漏、不错杀」——本模块只读进程表，不向任何进程发信号。
 *
 * 调用链：process-manager exit handler（exit_converge 分支）→ reportPiExitSignalForensics
 * （fire-and-forget，全路径不抛——观测增强不得影响 exit 主链的 rejectAll / exitCallbacks；
 * logger 未初始化时结构性 no-op，对齐 crash-correlation 的 isPiCrashLogEnabled 门）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CrashJournalEvent, CrashJournalWriter } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { getCrashJournal } from '../crash-journal.js'
import { isPiCrashLogEnabled } from '../logger.js'
// 采样原语（ps 解析 + 滚动环）独立文件：signal-forensics 只消费环，不含 OS 枚举细节
import { listAllProcesses, parseProcessTable, ProcessTableRing, readProcessStartTime, type ProcessRow, type RingSample } from './process-table-ring.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量（禁裸字面量；env 可调，0 = 关闭对应机制）
// ─────────────────────────────────────────────────────────────────────────────

/** 死亡归因窗口（ms）：窗口内出现过的进程才进候选集。 */
const DEFAULT_WINDOW_MS = 30_000
/** vanished 桶记录上限（macOS 上 30s 窗口消失的进程可能上百，封顶防记录膨胀）。 */
const MAX_VANISHED_RECORDS = 50
/** suspiciousPresent 桶记录上限（启发式命中集，封顶防刷屏）。 */
const MAX_PRESENT_RECORDS = 20
/** lstart 补采的候选数上限（每个候选一次 ps 调用，并行但有界）。 */
const MAX_LSTART_PROBES = 10
/** detailDigest 硬上限（schema 契约 ≤2KB）。 */
const DIGEST_MAX_CHARS = 2_000
/** digest 内命令行截断长度。 */
const DIGEST_COMMAND_MAX_CHARS = 100
/** detail 文件内命令行截断长度（全量记录，比 digest 宽）。 */
const RECORD_COMMAND_MAX_CHARS = 300
/** digest 内每桶保留的头部候选数。 */
const DIGEST_TOP_N = 3
/** digest 降级形态的命令行截断长度。 */
const DIGEST_COMPACT_CMD_MAX_CHARS = 60
/** 毫秒 → 秒换算（uptimeSec 持久化）。 */
const MS_PER_SECOND = 1_000
/** sessionId 文件名安全化最大长度（对齐 logger.ts createPiSessionLog 同规则）。 */
const SESSION_ID_MAX_LENGTH = 64
/** ISO 日期前缀长度（'2026-10-13'）。 */
const ISO_DATE_LENGTH = 10
/** init/launchd 的 pid（候选排除项：信号发送方不可能是它）。 */
const INIT_PID = 1

// ─────────────────────────────────────────────────────────────────────────────
// 退出码 → 信号名映射（128+n 约定；n 取 Darwin/macOS 信号编号——TaiJi 主平台。
// Linux 上 SIGTERM/SIGKILL/SIGINT/SIGHUP/SIGQUIT/SIGILL/SIGABRT/SIGFPE/SIGBUS/
// SIGSEGV 的编号与 Darwin 一致，差异仅在 SIGEMT/SIGSYS/SIGURG 等少见的中间号，
// 对本模块关注的信号族无影响）。
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable no-magic-numbers -- 128+n 信号约定：表内数值即数据本体（Darwin 信号编号），
   逐行 disable 会淹没表本身；跨平台差异见上方注释。 */
const SIGNAL_BY_EXIT_CODE = new Map<number, string>([
  [129, 'SIGHUP'],
  [130, 'SIGINT'],
  [131, 'SIGQUIT'],
  [132, 'SIGILL'],
  [133, 'SIGTRAP'],
  [134, 'SIGABRT'],
  [136, 'SIGFPE'],
  [137, 'SIGKILL'],
  [138, 'SIGBUS'],
  [139, 'SIGSEGV'],
  [140, 'SIGSYS'],
  [143, 'SIGTERM'],
  [152, 'SIGXCPU'],
  [153, 'SIGXFSZ'],
])
/* eslint-enable no-magic-numbers */

/** 退出码 → 信号名推测；非信号约定码（含 0/1/null）返回 null（不知道 ≠ 瞎猜）。 */
export function guessSignalFromExitCode(exitCode: number | null | undefined): string | null {
  if (exitCode == null) return null
  return SIGNAL_BY_EXIT_CODE.get(exitCode) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// 候选发送方分类（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

/** 候选可疑度分层（排序键；kill-tool 最可疑）。 */
export type SuspicionTier = 'kill-tool' | 'pi-reference' | 'shell' | 'other'

/** 分层排序权重（升序 = 更可疑在前）。 */
const TIER_RANK: Record<SuspicionTier, number> = {
  'kill-tool': 0,
  'pi-reference': 1,
  shell: 2,
  other: 3,
}

/** kill 族工具（pkill/killall/kill，词边界 + 路径段边界，禁子串误命中）。 */
const KILL_TOOL_RE = /(^|[\s/])(pkill|killall|kill)(\s|$)/
/** 引用 pi 可执行/形态（ supervisor 脚本、包装 shell 的强指纹）。 */
const PI_REFERENCE_RE = /pi-darwin-arm64|pi-coding-agent|--mode\s+rpc/
/** 交互 shell（终端手敲 kill 的常见载体；路径段边界防误命中）。 */
const SHELL_RE = /(^|\/)(zsh|bash|dash|fish|tcsh|csh)(\s|$)/

/** 命令行 → 可疑度分层。 */
export function commandTier(command: string): SuspicionTier {
  if (KILL_TOOL_RE.test(command)) return 'kill-tool'
  if (PI_REFERENCE_RE.test(command)) return 'pi-reference'
  if (SHELL_RE.test(command)) return 'shell'
  return 'other'
}

/** 候选发送方记录（ring 观测 + fresh 快照 diff + lstart 补采的三源合并）。 */
export interface SenderCandidate { // oe-exempt:20261014:framework:候选发送方数据模型（crash journal digest 与测试共用的单一数据契约，非投机抽象）
  pid: number
  ppid: number
  command: string
  /**
   * 环内首次见到该 pid 的时刻（epoch ms）；null = 环内从未采样到——仅见于死亡
   * 即时快照（最后两次采样之间 ~1.5s 内新起的进程，贴近死亡的强指纹）。
   */
  firstSeenAt: number | null
  /** 环内最后见到该 pid 的时刻（epoch ms）；null 语义同 firstSeenAt。 */
  lastSeenAt: number | null
  /** true = 死亡前窗口内在场、死亡时新快照中已消失（短命发送方强指纹）。 */
  vanished: boolean
  tier: SuspicionTier
  /** ps lstart 解析出的进程启动时刻（epoch ms）；null = 未采到。 */
  startedAt: number | null
}

/** 兄弟受管 pi 的死亡时刻存活状态（连坐视图：同秒死亡 vs 独死）。 */
export interface SiblingPiStatus { // oe-exempt:20261014:framework:兄弟 pi 连坐视图数据模型（取证记录单一数据契约）
  pid: number
  aliveAtDeath: boolean
}

export interface ClassifyInput { // oe-exempt:20261014:framework:归因分类函数输入契约（DI 面：环 + 双快照注入，单实现常态）
  ring: ProcessTableRing
  /** 死亡即时新快照；null = 采集失败（两桶皆不可判，note 声明）。 */
  freshRows: ProcessRow[] | null
  deathAt: number
  /** runtime 自身 pid（排除项：自己不是自己的发送方）。 */
  ownPid: number
  /** 死亡 pi 自身 pid（排除项）。 */
  deadPid?: number | null
  /** 其他受管 pi 的 pid（连坐视图）。 */
  managedPids?: readonly number[]
  /** 归因窗口（ms）；缺省 DEFAULT_WINDOW_MS。 */
  windowMs?: number
}

export interface ClassifyResult { // oe-exempt:20261014:framework:归因分类结果数据模型（记录落盘链路单一数据契约）
  windowFromAt: number
  /** 本次归因实际使用的窗口宽度（ms；输入回带，供记录落盘）。 */
  windowMs: number
  samplesInWindow: number
  /** 窗口内在场、死亡时已消失的进程（短命发送方指纹；按可疑度 + 末见时刻排序，已封顶）。 */
  vanished: SenderCandidate[]
  /** 仍存活且命中启发式的进程（常驻发送方候选；已封顶）。 */
  suspiciousPresent: SenderCandidate[]
  /** 兄弟受管 pi 的存活视图。 */
  siblings: SiblingPiStatus[]
  /** 新快照是否可用（false 时两桶为空、diff 结论不可下）。 */
  freshSnapshotAvailable: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// classifySenders 的内聚步骤（私有 helper；主函数只做编排——排除集/窗口 seen map/
// fresh 快照索引/连坐视图/候选分流/排序各有单一职责，行为与拆分前逐分支等价）。
// ─────────────────────────────────────────────────────────────────────────────

/** 窗口 seen map 条目：首见/末见时刻 + 末见命令行（进程可能被 pid 复用，末见命令行为准）。 */
interface WindowSeenEntry {
  row: ProcessRow
  firstSeenAt: number
  lastSeenAt: number
}

/** 排除集：INIT_PID / runtime 自身 / 死亡 pi 自身——它们不可能是信号发送方。 */
function buildExcludedPids(ownPid: number, deadPid: number | null | undefined): Set<number> {
  const excluded = new Set<number>([INIT_PID, ownPid])
  if (deadPid != null) excluded.add(deadPid)
  return excluded
}

/** 窗口内出现过的 pid → 首见/末见时刻 + 末见命令行（末样本的命令行为准）。 */
function buildWindowSeenMap(
  windowSamples: readonly RingSample[],
  excluded: ReadonlySet<number>,
): Map<number, WindowSeenEntry> {
  const seen = new Map<number, WindowSeenEntry>()
  for (const sample of windowSamples) {
    for (const row of sample.rows.values()) {
      if (excluded.has(row.pid)) continue
      const prev = seen.get(row.pid)
      if (prev === undefined) {
        seen.set(row.pid, { row, firstSeenAt: sample.at, lastSeenAt: sample.at })
      } else {
        prev.lastSeenAt = Math.max(prev.lastSeenAt, sample.at)
        prev.row = row
      }
    }
  }
  return seen
}

/** 死亡即时快照 → pid → 行 映射（null 透传 = 快照采集失败，调用方降级）。 */
function buildFreshRowMap(freshRows: ProcessRow[] | null): Map<number, ProcessRow> | null {
  return freshRows === null ? null : new Map(freshRows.map(r => [r.pid, r]))
}

/** 兄弟受管 pi 的死亡时刻存活视图（连坐视图；快照缺失时无法确认存活，一律记死亡）。 */
function buildSiblingStatuses(
  managedPids: readonly number[] | undefined,
  excluded: ReadonlySet<number>,
  freshMap: ReadonlyMap<number, ProcessRow> | null,
): SiblingPiStatus[] {
  return (managedPids ?? [])
    .filter(pid => !excluded.has(pid))
    .map(pid => ({ pid, aliveAtDeath: freshMap?.has(pid) ?? false }))
}

/** 候选分流中间态（ring diff 与 fresh-only 两路汇合后统一排序封顶）。 */
interface CandidateBuckets {
  vanished: SenderCandidate[]
  presentAll: SenderCandidate[]
}

/** 环窗口 diff：窗口在场进程按死亡时存活与否分流（vanished 全收；present 见桶注释）。 */
function classifyRingSeenCandidates(
  seen: ReadonlyMap<number, WindowSeenEntry>,
  freshMap: ReadonlyMap<number, ProcessRow>,
  managedSet: ReadonlySet<number>,
): CandidateBuckets {
  const buckets: CandidateBuckets = { vanished: [], presentAll: [] }
  for (const [pid, info] of seen) {
    const alive = freshMap.has(pid)
    const candidate: SenderCandidate = {
      pid,
      ppid: info.row.ppid,
      command: info.row.command,
      firstSeenAt: info.firstSeenAt,
      lastSeenAt: info.lastSeenAt,
      vanished: !alive,
      tier: commandTier(info.row.command),
      startedAt: null,
    }
    if (alive) {
      // present 桶只收启发式命中（'other' 太噪；但 'other' 消失仍进 vanished 桶）；
      // 受管 pi 不进 present（见 classifySenders 的 managedSet 注释）
      if (candidate.tier !== 'other' && !managedSet.has(pid)) buckets.presentAll.push(candidate)
    } else {
      buckets.vanished.push(candidate)
    }
  }
  return buckets
}

/**
 * fresh-only 候选：死亡即时快照在场、环内窗口从未采样到——两次采样间隔（~intervalMs）
 * 内新起的进程，贴近死亡的强指纹，进 present 桶（环观测字段为 null，不伪装）。
 */
function collectFreshOnlyPresent(
  freshMap: ReadonlyMap<number, ProcessRow>,
  seen: ReadonlyMap<number, WindowSeenEntry>,
  excluded: ReadonlySet<number>,
  managedSet: ReadonlySet<number>,
): SenderCandidate[] {
  const freshOnly: SenderCandidate[] = []
  for (const freshRow of freshMap.values()) {
    if (seen.has(freshRow.pid) || excluded.has(freshRow.pid) || managedSet.has(freshRow.pid)) continue
    const tier = commandTier(freshRow.command)
    if (tier === 'other') continue
    freshOnly.push({
      pid: freshRow.pid,
      ppid: freshRow.ppid,
      command: freshRow.command,
      firstSeenAt: null,
      lastSeenAt: null,
      vanished: false,
      tier,
      startedAt: null,
    })
  }
  return freshOnly
}

/** 候选排序：tier 权重升序 → lastSeenAt 降序（越晚死前活动越可疑）。 */
function compareBySuspicion(a: SenderCandidate, b: SenderCandidate): number {
  return TIER_RANK[a.tier] - TIER_RANK[b.tier]
    || (b.lastSeenAt ?? -1) - (a.lastSeenAt ?? -1)
}

/**
 * 从环历史 + 死亡即时快照 diff 出候选发送方（纯函数，无 I/O）。
 *
 * 判定规则：
 * - 排除集：runtime 自身 pid、死亡 pi 自身 pid、INIT_PID（pid 1 不可能是发送方）；
 * - 受管 pi（managedPids）不进 present 候选（runtime 自己的子进程不是发送方，
 *   其存活状态由 siblings 连坐视图承载），但保留参与 vanished——兄弟 pi 同秒
 *   消失正是连坐证据；
 * - vanished = 窗口内任一样本在场 ∧ 新快照不在场；
 * - suspiciousPresent = 新快照在场 ∧ 命令行 tier ≠ 'other'（'other' 太噪，不进 present 桶；
 *   但 'other' 若消失了仍进 vanished 桶——生灭本身就是信息）；含 fresh-only pid
 *   （环内未采样到、仅见于死亡即时快照的最后 ~1.5s 内新进程）；
 * - 排序：tier 权重升序 → lastSeenAt 降序（越晚死前活动越可疑）；
 * - 封顶：vanished ≤ MAX_VANISHED_RECORDS，present ≤ MAX_PRESENT_RECORDS。
 */
export function classifySenders(input: ClassifyInput): ClassifyResult {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS
  const windowFromAt = input.deathAt - windowMs
  const windowSamples = input.ring.samplesInWindow(windowFromAt, input.deathAt)

  const excluded = buildExcludedPids(input.ownPid, input.deadPid)
  // 受管 pi 集合：连坐视图（siblings）单独覆盖，不进 present 候选——runtime 自己的
  // 子进程不是发送方；但**不**排除出 vanished：兄弟 pi 同秒消失正是连坐证据。
  const managedSet = new Set<number>(input.managedPids ?? [])
  const seen = buildWindowSeenMap(windowSamples, excluded)
  const freshMap = buildFreshRowMap(input.freshRows)
  const siblings = buildSiblingStatuses(input.managedPids, excluded, freshMap)

  if (freshMap === null) {
    return {
      windowFromAt,
      windowMs,
      samplesInWindow: windowSamples.length,
      vanished: [],
      suspiciousPresent: [],
      siblings,
      freshSnapshotAvailable: false,
    }
  }

  const { vanished, presentAll } = classifyRingSeenCandidates(seen, freshMap, managedSet)
  presentAll.push(...collectFreshOnlyPresent(freshMap, seen, excluded, managedSet))

  return {
    windowFromAt,
    windowMs,
    samplesInWindow: windowSamples.length,
    vanished: vanished.sort(compareBySuspicion).slice(0, MAX_VANISHED_RECORDS),
    suspiciousPresent: presentAll.sort(compareBySuspicion).slice(0, MAX_PRESENT_RECORDS),
    siblings,
    freshSnapshotAvailable: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 记录组装与落盘
// ─────────────────────────────────────────────────────────────────────────────

/** 一次死亡信号取证的全量记录（JSONL 一行；schema journal 事件是它的 ≤2KB 摘要）。 */
export interface SignalForensicsRecord { // oe-exempt:20261014:framework:取证记录数据模型（journal 事件 + JSONL 双写共用的单一数据契约）
  /** 记录时刻（ISO 8601 UTC）。 */
  ts: string
  sessionId: string
  /** 死亡 pi 的 pid；null = 未知（client 未暴露 pid 的形态）。 */
  deadPid: number | null
  exitCode: number | null
  /** exitCode 的信号名推测（128+n 约定）；非信号码为 null。 */
  signalGuess: string | null
  uptimeMs: number | null
  runtimePid: number
  windowMs: number
  samplesInWindow: number
  freshSnapshotAvailable: boolean
  vanishedSenders: SenderCandidate[]
  suspiciousPresent: SenderCandidate[]
  siblingPis: SiblingPiStatus[]
  /** 人读结论注记（覆盖 fresh 不可用 / 无 vanished 等形态）。 */
  note: string
}

/** 记录组装（纯函数；now 可注入）。 */
export function buildForensicsRecord(input: {
  sessionId: string
  deadPid: number | null
  exitCode: number | null
  uptimeMs: number | null
  ownPid: number
  classified: ClassifyResult
  now?: () => number
}): SignalForensicsRecord {
  const now = input.now ?? Date.now
  const { classified } = input
  let note: string
  if (!classified.freshSnapshotAvailable) {
    note = 'fresh process snapshot unavailable (ps failed) — vanished/present classification skipped; '
      + 'ring history alone cannot classify senders'
  } else if (classified.vanished.length > 0) {
    note = 'vanished candidates existed within the pre-death window and are gone at death — '
      + 'short-lived sender fingerprint; macOS does not log kill(2), so this is best-effort '
      + 'correlation for review, not proof'
  } else {
    note = 'no vanished processes in the pre-death window; if the sender outlived the ring '
      + 'interval and is still alive, check suspiciousPresent'
  }
  return {
    ts: new Date(now()).toISOString(),
    sessionId: input.sessionId,
    deadPid: input.deadPid,
    exitCode: input.exitCode,
    signalGuess: guessSignalFromExitCode(input.exitCode),
    uptimeMs: input.uptimeMs,
    runtimePid: input.ownPid,
    windowMs: classified.windowMs,
    samplesInWindow: classified.samplesInWindow,
    freshSnapshotAvailable: classified.freshSnapshotAvailable,
    vanishedSenders: truncateCandidates(classified.vanished),
    suspiciousPresent: truncateCandidates(classified.suspiciousPresent),
    siblingPis: classified.siblings,
    note,
  }
}

/** 命令行截断（记录落盘用，防极端长 argv 膨胀文件）。 */
function truncateCommand(command: string, max: number): string {
  return command.length <= max ? command : `${command.slice(0, max)}…[+${command.length - max} chars]`
}

/** 记录落盘前对候选命令行的统一截断（全量记录比 digest 宽，但仍需有界）。 */
function truncateCandidates(candidates: SenderCandidate[]): SenderCandidate[] {
  return candidates.map(c => ({ ...c, command: truncateCommand(c.command, RECORD_COMMAND_MAX_CHARS) }))
}

/**
 * journal digest（≤2KB 硬上限，schema 契约）。三级降级保可解析性优先：
 * 全量 → 压 cmd 长度 → 只留计数；任一级仍超限再硬截断（极少触发）。
 */
export function buildDigest(record: SignalForensicsRecord): string {
  const summarize = (candidates: SenderCandidate[], cmdMax: number, limit: number) =>
    candidates.slice(0, limit).map(c => ({
      pid: c.pid,
      cmd: truncateCommand(c.command, cmdMax),
      tier: c.tier,
      startedAt: c.startedAt,
    }))

  const full = JSON.stringify({
    signalGuess: record.signalGuess,
    exitCode: record.exitCode,
    deadPid: record.deadPid,
    uptimeMs: record.uptimeMs,
    samplesInWindow: record.samplesInWindow,
    freshSnapshotAvailable: record.freshSnapshotAvailable,
    vanishedCount: record.vanishedSenders.length,
    topVanished: summarize(record.vanishedSenders, DIGEST_COMMAND_MAX_CHARS, DIGEST_TOP_N),
    topPresent: summarize(record.suspiciousPresent, DIGEST_COMMAND_MAX_CHARS, DIGEST_TOP_N),
    siblings: record.siblingPis,
    note: record.note,
  })
  if (full.length <= DIGEST_MAX_CHARS) return full

  const compact = JSON.stringify({
    signalGuess: record.signalGuess,
    exitCode: record.exitCode,
    deadPid: record.deadPid,
    freshSnapshotAvailable: record.freshSnapshotAvailable,
    vanishedCount: record.vanishedSenders.length,
    presentCount: record.suspiciousPresent.length,
    topVanished: summarize(record.vanishedSenders, DIGEST_COMPACT_CMD_MAX_CHARS, 1),
  })
  if (compact.length <= DIGEST_MAX_CHARS) return compact

  const countsOnly = JSON.stringify({
    signalGuess: record.signalGuess,
    exitCode: record.exitCode,
    deadPid: record.deadPid,
    freshSnapshotAvailable: record.freshSnapshotAvailable,
    vanishedCount: record.vanishedSenders.length,
    presentCount: record.suspiciousPresent.length,
    truncated: true,
  })
  return countsOnly.length <= DIGEST_MAX_CHARS
    ? countsOnly
    : `${countsOnly.slice(0, DIGEST_MAX_CHARS - 1)}…`
}

/**
 * 全量记录落盘（append JSONL，每行一次死亡事件）。
 *
 * 文件：`<dataDir>/logs/signal-forensics-<date>-<sid>.jsonl`——signal-forensics- 前缀
 * 已登记进 logger.ts cleanExpiredLogs 白名单（D6-⑦：有写入就有清理），保留期清理自动
 * 接管，无需自建轮转。best-effort：任何失败（磁盘满/权限）返回 null，不向调用链抛错。
 *
 * @returns detailPath（相对 dataDir，供 journal detailPath 字段）；失败返回 null。
 */
export function writeForensicsDetailFile(record: SignalForensicsRecord): string | null {
  try {
    const logsDir = join(getDataDir(), 'logs')
    mkdirSync(logsDir, { recursive: true })
    const date = record.ts.slice(0, ISO_DATE_LENGTH)
    // 文件名安全化与 logger.ts createPiSessionLog 同规则；空清洗结果回落 'nosid'
    const safeSid = record.sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, SESSION_ID_MAX_LENGTH) || 'nosid'
    const fileName = `signal-forensics-${date}-${safeSid}.jsonl`
    appendFileSync(join(logsDir, fileName), `${JSON.stringify(record)}\n`)
    return `logs/${fileName}`
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编排：死亡即时转储 + 生产入口
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureInput {
  sessionId: string
  deadPid: number | null
  exitCode: number | null
  uptimeMs?: number | null
  /** 其他受管 pi 的 pid（连坐视图）。 */
  managedPids?: readonly number[]
}

export interface CaptureDeps { // oe-exempt:20261014:framework:采集依赖注入面（环 + pid 注入，测试替身用，单实现常态）
  ring: ProcessTableRing
  /** runtime 自身 pid。 */
  ownPid: number
  /** 死亡即时进程枚举（测试替身可注入）。 */
  listProcesses: () => Promise<string>
  /** lstart 补采（可选；不注入则 startedAt 恒 null）。 */
  readProcessStartTime?: (pid: number) => Promise<number | null>
  /** journal writer（可选；不注入则只写 detail 文件）。 */
  journal?: CrashJournalWriter
  /** detail 文件写入（可选；不注入则不落全量记录）。 */
  writeDetailFile?: (record: SignalForensicsRecord) => string | null
  now?: () => number
  windowMs?: number
}

export interface CaptureResult { // oe-exempt:20261014:framework:采集结果数据模型（记录 + detailPath 双写链路单一数据契约）
  record: SignalForensicsRecord
  detailPath: string | null
  journalAppended: boolean
}

/**
 * 一次死亡信号取证编排：取环历史（同步）→ 新快照（异步 best-effort）→ 分类 →
 * lstart 补采 → 组记录 → journal 事件 + detail 文件双写。
 *
 * 本函数自身可抛（调用方 orchestration 错误）；生产入口 reportPiExitSignalForensics
 * 全路径捕获。新快照失败不抛（降级为 freshSnapshotAvailable=false 的记录）。
 */
export async function captureSignalForensics(
  input: CaptureInput,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const now = deps.now ?? Date.now
  const deathAt = now()

  // 新快照（异步）：失败降级 null——「没采到 ≠ 没发生」，record.note 显式声明
  let freshRows: ProcessRow[] | null = null
  try {
    freshRows = parseProcessTable(await deps.listProcesses())
  } catch {
    freshRows = null
  }

  const classified = classifySenders({
    ring: deps.ring,
    freshRows,
    deathAt,
    ownPid: deps.ownPid,
    deadPid: input.deadPid,
    managedPids: input.managedPids ?? [],
    windowMs: deps.windowMs,
  })

  // lstart 补采（独立数据源并行 best-effort，有界）：allSettled 允许部分降级——
  // 单个候选的 ps 失败只留 startedAt=null，不拖垮整批归因。
  if (deps.readProcessStartTime) {
    const probes = [...classified.vanished, ...classified.suspiciousPresent]
      .slice(0, MAX_LSTART_PROBES)
    await Promise.allSettled(probes.map(async candidate => {
      try {
        candidate.startedAt = await deps.readProcessStartTime!(candidate.pid)
      } catch {
        // 注入探针抛错的降级：真实实现永不 reject（ps 失败 resolve null），此处仅为
        // 测试替身/未来改动的纵深防御——单候选失败不污染其他候选与主链。
        candidate.startedAt = null
      }
    }))
  }

  const record = buildForensicsRecord({
    sessionId: input.sessionId,
    deadPid: input.deadPid,
    exitCode: input.exitCode,
    uptimeMs: input.uptimeMs ?? null,
    ownPid: deps.ownPid,
    classified,
    now,
  })

  const detailPath = deps.writeDetailFile?.(record) ?? null

  let journalAppended = false
  if (deps.journal) {
    const event: CrashJournalEvent = {
      layer: 'pi',
      event: 'signal-forensics',
      sessionId: input.sessionId,
      // 扩展字段登记清单（schema CrashJournalEvent）：pid/ppid/exitCode/uptimeSec/detailPath
      pid: input.deadPid,
      ppid: deps.ownPid,
      exitCode: input.exitCode,
      uptimeSec: input.uptimeMs != null ? Math.round(input.uptimeMs / MS_PER_SECOND) : null,
      detailDigest: buildDigest(record),
      detailPath,
    }
    deps.journal.append(event)
    journalAppended = true
  }

  return { record, detailPath, journalAppended }
}

export interface ExitForensicsInput extends CaptureInput { // oe-exempt:20261014:framework:exit_converge 接线点输入契约（DI 面，单实现常态）
  /** 进程表环（ProcessManager 持有实例）。 */
  ring: ProcessTableRing
}

/**
 * 生产入口：受管 pi 意外退出（exit_converge）时的信号取证。
 *
 * - logger 未初始化（单元测试/no-op 态）时结构性 no-op——无落点不采样，对齐
 *   crash-correlation 的 isPiCrashLogEnabled 门（D10 同款先例）；
 * - fire-and-forget：调用方在 exit 主链上（rejectAll / exitCallbacks 收敛），取证
 *   全路径吞错仅 console 出声（console 已被 logger patch，tee 进 runtime 主日志）；
 * - 环 disabled（interval=0）时仍执行：退化为「死亡即时快照」单帧归因（无历史 diff）。
 */
export function reportPiExitSignalForensics(input: ExitForensicsInput): void {
  if (!isPiCrashLogEnabled()) return
  void (async () => {
    try {
      const result = await captureSignalForensics(input, {
        ring: input.ring,
        ownPid: process.pid,
        listProcesses: listAllProcesses,
        readProcessStartTime,
        journal: getCrashJournal(),
        writeDetailFile: writeForensicsDetailFile,
      })
      console.log(
        `[signal-forensics] captured for session ${input.sessionId} `
        + `(exit=${input.exitCode}, signalGuess=${result.record.signalGuess ?? 'n/a'}): `
        + `vanished=${result.record.vanishedSenders.length} `
        + `suspiciousPresent=${result.record.suspiciousPresent.length} `
        + `detail=${result.detailPath ?? 'none'}`,
      )
    } catch (e) {
      // best-effort 降级策略：取证是 exit 主链外的观测增强，失败仅 console 出声
      // （console 已被 logger patch，tee 进 runtime 主日志）供事后排查，不重抛——
      // 重抛会击穿 exitCallbacks 收敛链（persist stopped / occupancy reset / session.exited）。
      console.error('[signal-forensics] capture failed:', e)
    }
  })()
}

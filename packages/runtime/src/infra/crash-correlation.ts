/**
 * 崩溃时刻机器面关联取证（crash-forensics-and-watchdog §3.3 D10，crash-correlation）。
 *
 * 背景（2026-09-20 连坐崩溃实证，session 01a0b9ff 四次 SIGTERM 死亡归因）：pi 以 exit
 * code 143 死亡时，runtime 侧只见「自己的子进程退了」，而真凶是机器上另一个进程按模式
 * 扫杀所有 taiji 形态的 pi（跨数据目录、跨进程树连坐）。归因证据散在 macOS 统一日志
 * （runningboardd 的 `[anon<Electron>(501):pid] termination reported by proc_exit`、
 * mDNSResponder 的 pi-darwin 连接 STOP 行）与进程表快照里——本模块在崩溃时刻把它们
 * 自动采下来，落进既有 pi-crash log（writePiCrashLog append 语义，logger.ts）与
 * crash journal 扩展字段，人查与机查（trigger-evaluator #16 E2 型连坐）都无需再手工
 * 重放取证。
 *
 * 两个采集器（调用点 rpc-client.writeCrashLogIfNeeded / session-service pi-crash 台账行）：
 * ① 同步机器面 pi 快照（`ps -axo pid=,ppid=,command=` 过滤 pi-darwin-arm64 行，~10ms）——
 *    回答「我死的时候机器上还有哪些同族 pi 活着、各自 ppid 归属谁」；
 * ② 异步统一日志关联采样（`log show` 崩溃时刻 ±5s 窗口，darwin-only，fire-and-forget）——
 *    提取同秒死亡的兄弟 pi、同窗退出的 Electron 进程、launchd signaled service 行。
 *
 * 采样门（真实生产语义，非测试钩子）：crash log sink 未初始化（logger no-op 态）时
 * 两个采集器都无落点，采样本身就是无意义功——①②统一以 isPiCrashLogEnabled() 为门，
 * 单元测试环境（logger 未初始化）结构性惰性，生产恒采集。
 *
 * best-effort 契约（对齐 crash-resilience §3.3 D6-④）：采集任何失败（ps 缺失 / log show
 * 超时 / 输出超限）都不向上抛——调用方在 exit 主流程上，观测增强不得影响 rejectAll /
 * exitCallbacks 通知链；失败以显式 `unavailable: <原因>` 行落盘（「不知道 ≠ 没打点」）。
 *
 * 平台边界：②仅 darwin（`log show` 不存在于 Linux/Windows，静默跳过）；①ps 形态
 * macOS/Linux 通用（`列名=` 抑制表头，与 reap-orphan-pi.parsePsOutput 同款解析）。
 */
import { execFile, execFileSync } from 'node:child_process'
import { isPiCrashLogEnabled } from './logger.js'

// ── ① 机器面 pi 快照 ─────────────────────────────────────────────────────────

/** taiji 形态 pi 的二进制名（打包版 /Applications/TaiJi.app/.../pi/ 与 dev
 *  apps/electron/resources/pi/ 下同名；用户 npm 安装的裸 `pi` 不匹配——本模块只关心
 *  taiji 家族的连坐面）。 */
export const MACHINE_PI_BIN_MARKER = 'pi-darwin-arm64'

/** ps 单行解析结果（`ps -axo pid=,ppid=,command=` 的一行）。 */
export interface MachinePiRow {
  pid: number
  ppid: number
  /** command 列原始文本（argv 空白连接，个别环境可能保留引号形态）。 */
  command: string
}

/** ps 枚举超时：全量进程表是毫秒级本地操作，10s 只是无 ps/假死兜底（reap-orphan-pi 同值）。 */
const PS_TIMEOUT_MS = 10_000

/** 快照 section 内单行 command 截断长度（超长 argv 以 … 收尾，保 grep 可读性）。 */
const SNAPSHOT_CMD_MAX_CHARS = 240

/** 快照 section 最多落盘的进程行数（machine 全表 pi 不会多，防御性上限）。 */
const SNAPSHOT_MAX_ROWS = 16

/** journal 扩展字段 machinePiDigest 的总长上限（对齐 detailDigest 的 KB 级内嵌口径）。 */
export const MACHINE_PI_DIGEST_MAX_CHARS = 1024

/** digest 内单行 command 截断长度（比快照 section 更紧——digest 预算 1KB 要装多行）。 */
const MACHINE_PI_DIGEST_CMD_MAX_CHARS = 120

/** 截断尾标（省略号字符；截断预算含它自身宽度）。 */
const ELLIPSIS = '…'

/** 字节换算基数（对齐 crash-journal.ts 既有 BYTES_PER_KB 惯例，禁裸 1024）。 */
const BYTES_PER_KB = 1024

/** log show 输出缓冲上限 MB（超限 execFile 直接 reject，走 unavailable 降级）。 */
const UNIFIED_LOG_MAX_BUFFER_MB = 32

/** 时间字段的两位数字补齐宽度（YYYY-MM-DD HH:MM:SS 格式约定）。 */
const DATETIME_PAD_WIDTH = 2

/**
 * 解析 ps 输出并过滤出 taiji 家族 pi 行（纯函数）。
 * 非数字 pid/ppid 的行（空行、异常输出）跳过——fail-open 只影响覆盖面不影响精确性。
 */
export function parseMachinePiRows(psStdout: string): MachinePiRow[] {
  const rows: MachinePiRow[] = []
  for (const line of psStdout.split('\n')) {
    if (!line.includes(MACHINE_PI_BIN_MARKER)) continue
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return rows
}

function truncateMiddle(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - ELLIPSIS.length) + ELLIPSIS
}

/**
 * 渲染机器面 pi 快照 section（纯函数，多行，每行 `[machine-pi-snapshot]` 前缀——
 * 与 `[runtime-context]` 同款 grep 可提取形态）。rows 为空也显式落 `aliveCount=0`
 * （「死时机器上没有同族 pi 存活」本身是连坐归因的关键证据）。
 */
export function formatMachinePiSnapshotSection(
  rows: readonly MachinePiRow[],
  selfPid: number | null,
  capturedAtIso: string,
): string {
  const lines = [
    `[machine-pi-snapshot] capturedAt=${capturedAtIso} selfPid=${selfPid ?? 'null'} aliveCount=${rows.length}`,
  ]
  for (const row of rows.slice(0, SNAPSHOT_MAX_ROWS)) {
    lines.push(`[machine-pi-snapshot] pid=${row.pid} ppid=${row.ppid} cmd=${truncateMiddle(row.command, SNAPSHOT_CMD_MAX_CHARS)}`)
  }
  if (rows.length > SNAPSHOT_MAX_ROWS) {
    lines.push(`[machine-pi-snapshot] truncated=true (+${rows.length - SNAPSHOT_MAX_ROWS} rows omitted)`)
  }
  return lines.join('\n')
}

/**
 * journal 扩展字段 machinePiDigest 的紧凑摘要（纯函数，≤1KB，行形态 `alive=N; [pid/ppid] cmd…`）。
 *
 * 装不下的行从尾部丢弃并保留 `+N more` 尾注（截断永不吞掉 more 语义——alive=N 与 omitted
 * 数是归因锚点，单行 command 可截断但计数不可丢）。
 */
export function formatMachinePiDigest(rows: readonly MachinePiRow[]): string {
  const head = `alive=${rows.length}`
  let used = head.length
  const parts: string[] = []
  let included = 0
  for (const r of rows) {
    const part = `; [${r.pid}/${r.ppid}] ${truncateMiddle(r.command, MACHINE_PI_DIGEST_CMD_MAX_CHARS)}`
    if (used + part.length > MACHINE_PI_DIGEST_MAX_CHARS) break
    parts.push(part)
    used += part.length
    included++
  }
  const omitted = rows.length - included
  const tail = omitted > 0 ? `; +${omitted} more` : ''
  return (head + parts.join('') + tail).slice(0, MACHINE_PI_DIGEST_MAX_CHARS)
}

type RunPs = (args: readonly string[]) => string

const defaultRunPs: RunPs = (args) =>
  execFileSync('ps', [...args], { encoding: 'utf-8', timeout: PS_TIMEOUT_MS })

/** 采集活着的 taiji 家族 pi 行（内部步：不抛，失败返回空数组并附原因由上层渲染）。 */
function listMachinePiRows(runPs: RunPs): MachinePiRow[] {
  return parseMachinePiRows(runPs(['-axo', 'pid=,ppid=,command=']))
}

/**
 * 崩溃 log 用的机器面 pi 快照 section（同步，~10ms）。
 *
 * 采样门：crash log sink 未启用（isPiCrashLogEnabled false）时返回 ''——无落点不采样。
 * ps 失败时返回显式 unavailable 行（不静默空串——区分「没采」与「采到空」）。
 * 调用点：rpc-client.writeCrashLogIfNeeded（异常退出分支）。
 */
export function captureMachinePiSnapshotSection(selfPid: number | null, runPs: RunPs = defaultRunPs): string {
  if (!isPiCrashLogEnabled()) return ''
  try {
    const rows = listMachinePiRows(runPs)
    return formatMachinePiSnapshotSection(rows, selfPid, new Date().toISOString())
  } catch (e) {
    return `[machine-pi-snapshot] capturedAt=${new Date().toISOString()} unavailable: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * crash journal 扩展字段 machinePiDigest 用的紧凑摘要（同步 best-effort）。
 * 失败返回 ''（journal 字段全可空语义，「不知道 ≠ 没打点」；与 section 不同，journal
 * 无 per-field 备注位，空串即「未采到」）。调用点：session-service pi-crash 台账行。
 * 注意：调用时刻 pi 已死，rows 只含幸存同族进程（死亡者自身不可见，死亡证据在
 * exitCode/detailDigest 与统一日志采样里）。
 */
export function captureMachinePiDigest(runPs: RunPs = defaultRunPs): string {
  try {
    return formatMachinePiDigest(listMachinePiRows(runPs))
  } catch {
    return ''
  }
}

// ── ② 统一日志关联采样（darwin-only）────────────────────────────────────────

/** 采样窗口：崩溃时刻前后各 5s（同秒连坐形态的证据窗，覆盖调度抖动）。 */
export const UNIFIED_LOG_WINDOW_MS = 5_000

/** `log show` 超时：10s 窗口扫描通常 1-3s，超时视为本轮采样失败（fire-and-forget 不重试）。 */
export const UNIFIED_LOG_TIMEOUT_MS = 10_000

/** 落盘上限：最多保留 60 行匹配行（超出截断并标注——防御异常嘈杂窗口撑爆 crash log）。 */
export const UNIFIED_LOG_MAX_LINES = 60

/** Electron 进程退出行（runningboardd `termination reported by proc_exit` 形态）。 */
const ELECTRON_EXIT_LINE_RE = /<Electron>\(\d+\):\d+\] termination reported by proc_exit/

/**
 * 从 `log show --style compact` 输出提取关联行（纯函数）。
 * 三类证据：pi-darwin 进程相关（Resolved / mDNS STOP / termination）、Electron 进程
 * 退出、launchd signaled service（信号投递）。行过滤在代码侧做（谓词只粗筛进程源，
 * 收窄谓词会漏形态，粗筛嘈杂行在此精确丢弃）。
 */
export function extractCorrelationLines(logShowStdout: string): { lines: string[]; truncated: boolean } {
  const matched = logShowStdout.split('\n').filter((line) => {
    if (line.includes(MACHINE_PI_BIN_MARKER)) return true
    if (ELECTRON_EXIT_LINE_RE.test(line)) return true
    if (line.includes('signaled service')) return true
    return false
  })
  return {
    lines: matched.slice(0, UNIFIED_LOG_MAX_LINES),
    truncated: matched.length > UNIFIED_LOG_MAX_LINES,
  }
}

/**
 * 渲染统一日志关联 section（纯函数）。matched=0 也显式落盘——「证据窗内无同秒死亡/
 * Electron 退出」本身排除一类凶手假设，是阴性证据。
 */
export function formatUnifiedLogCorrelationSection(
  lines: readonly string[],
  truncated: boolean,
  windowStartIso: string,
  windowEndIso: string,
): string {
  const header = [
    `[unified-log-correlation] window=${windowStartIso}..${windowEndIso} source=log show (darwin)`,
    `[unified-log-correlation] matched=${lines.length} truncated=${truncated}`,
  ]
  const body = lines.map((line) => `[unified-log-correlation] ${line}`)
  if (truncated) {
    body.push(`[unified-log-correlation] truncated=true (kept first ${UNIFIED_LOG_MAX_LINES} matched lines)`)
  }
  return [...header, ...body].join('\n')
}

/**
 * `log show` 时间参数格式：本地时区 naive 形态 `YYYY-MM-DD HH:MM:SS`（log show 按本地
 * 时区解释 naive 输入；这是本机实测可靠的形态，勿改 ISO——UTC naive 会被当本地时间
 * 偏移 8h）。纯函数便于测试。
 */
export function formatLogShowTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(DATETIME_PAD_WIDTH, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** log show 谓词：粗筛三个证据进程源（行级精确过滤在 extractCorrelationLines）。 */
export const UNIFIED_LOG_PREDICATE =
  '(process == "runningboardd" OR process == "mDNSResponder" OR process == "launchd") AND ' +
  '(eventMessage CONTAINS "pi-darwin-arm64" OR eventMessage CONTAINS "proc_exit" OR eventMessage CONTAINS "signaled service")'

export function buildLogShowArgs(crashTsMs: number): string[] {
  return [
    '--start', formatLogShowTime(crashTsMs - UNIFIED_LOG_WINDOW_MS),
    '--end', formatLogShowTime(crashTsMs + UNIFIED_LOG_WINDOW_MS),
    '--style', 'compact',
    '--predicate', UNIFIED_LOG_PREDICATE,
  ]
}

type RunLogShow = (args: readonly string[]) => Promise<string>

const defaultRunLogShow: RunLogShow = (args) =>
  new Promise((resolve, reject) => {
    execFile('log', [...args], { timeout: UNIFIED_LOG_TIMEOUT_MS, maxBuffer: UNIFIED_LOG_MAX_BUFFER_MB * BYTES_PER_KB * BYTES_PER_KB, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })

export interface CollectDeps {
  /** log show 执行器（测试注入假实现；缺省真实 execFile）。 */
  runLogShow?: RunLogShow
  /** 采样门（缺省 logger.isPiCrashLogEnabled；测试可注入）。 */
  sinkEnabled?: () => boolean
  /** 平台判定（缺省 process.platform === 'darwin'；测试可注入）。 */
  isDarwin?: () => boolean
  now?: () => number
}

/**
 * 统一日志关联采样（异步，fire-and-forget，永 reject 不出——内部全捕获）。
 *
 * 返回值：'' = 未采样（非 darwin / crash log sink 未启用——调用方跳过补写）；
 * 非空 = 待补写进 pi-crash log 的 section（匹配行或显式 unavailable 行）。
 * 调用点：rpc-client.writeCrashLogIfNeeded 尾部 `void ...then(补写)`。
 */
export async function collectUnifiedLogCorrelation(crashTsMs: number, deps: CollectDeps = {}): Promise<string> {
  const isDarwin = deps.isDarwin ?? (() => process.platform === 'darwin')
  const sinkEnabled = deps.sinkEnabled ?? isPiCrashLogEnabled
  if (!isDarwin() || !sinkEnabled()) return ''
  const startIso = new Date(crashTsMs - UNIFIED_LOG_WINDOW_MS).toISOString()
  const endIso = new Date(crashTsMs + UNIFIED_LOG_WINDOW_MS).toISOString()
  try {
    const stdout = await (deps.runLogShow ?? defaultRunLogShow)(buildLogShowArgs(crashTsMs))
    const { lines, truncated } = extractCorrelationLines(stdout)
    return formatUnifiedLogCorrelationSection(lines, truncated, startIso, endIso)
  } catch (e) {
    return formatUnifiedLogCorrelationSection(
      [`unavailable: ${e instanceof Error ? e.message : String(e)}`],
      false,
      startIso,
      endIso,
    )
  }
}

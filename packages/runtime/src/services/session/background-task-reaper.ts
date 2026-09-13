/**
 * 后台任务收殓器（runtime 侧，双触发面 D2——docs/architecture/file-lock-unification-
 * and-reaper-sink.md §2.3 目标态数据流 / §3.2 D2 决策表 / §3.3 挂点论证）。
 *
 * 职责（G2 职责归位）：孤儿后台任务的收殓由 pi 生命周期的所有者（runtime）执行，
 * extension 不再做全局扫描/全局锁。判定逻辑移植自 extensions/universal/
 * base-tool-enhance/src/reaper.ts（移植时逐段对照：三分支判定 + isPidAlive/
 * getProcessStartTimeSec + pid 复用防御 + registry 损坏隔离 + 错误防御），实现
 * 独立于 extension 源码——契约类型一律取 @xyz-agent/extension-protocol
 * background-task.ts（跨层 SSOT），写 registry 用统一锁 sync 版（utils/file-lock.ts
 * withFileLockSync，与 extension 写侧互斥同一把 lockfile `<registry.json>.lock`）。
 *
 * 两个入口（对应设计 §2.3 双触发面）：
 *  - reapSessionBackgroundTasks(agentDir, sessionId)：触发面 A——挂 session-service
 *    removeSessionEntry 汇聚点（「该 session 的 pi 确认死亡」的精确时点，覆盖主动删/
 *    进程退出/forceQuit/restore 清场），fire-and-forget 不阻塞销毁收敛链。
 *  - reapAllSessionsBackgroundTasks(agentDir)：触发面 B——挂 startup-background-init
 *    启动期全量兜底扫描（硬序在孤儿 pi 收殓 reapOrphanPiProcesses 完成后执行，时序
 *    论证见设计 §2.3：若扫描先行，扫描时遗留 pi 尚活被分支①跳过，+5s 被杀后其
 *    detached 任务才孤儿化且此后无事件触达，漏收一个 app 周期），顺带 rmdir stale
 *    的 reaper.lock 残留目录（D2 落地后该锁不再产生，不做迁移脚本，设计 §3.3）。
 *
 * 三分支判定（移植 reaper.ts 文件头 §3.5 原文语义）：
 *  ①属主活跳过——ownerPiPid 进程仍活 → 跳过（活进程的合法任务；宁漏杀勿误杀，
 *    桌面端并行 session 的合法任务靠此防线豁免；kill(pid,0) 判活，ESRCH=死/EPERM=活。
 *    extension 版的显式 `ownerPiPid === process.pid` 防御在本侧被 isPidAlive 蕴含
 *    ——kill(自身 pid,0) 恒成功，故不重复分支）
 *  ②孤儿补杀——属主已死 && 任务 pid 活 → 先过 pid 复用防御（start time 与登记值
 *    比对）→ kill 进程树 → 写 orphaned 终态
 *  ③终态收尾——属主已死 && 任务 pid 死 → 不补杀，仅转 orphaned 终态（ESRCH 无歧义，
 *    无需 start-time 校验——校验只服务「判活防复用」）
 * killing 条目同 running 处置（属主死 → 一并按孤儿处理，bash_kill 已发令但属主死前
 * 没等到轮询边沿，补杀幂等无害）；exited/orphaned 终态跳过——二次扫描幂等 no-op 的
 * 构造性来源。
 *
 * pid 复用防御（移植 §3.6）：判「任务 pid 存活」时校验进程 start time 与条目登记值
 * （epoch 秒，ps -o lstart= 解析）；缺登记值（旧条目）走 startedAt 秒级降级校验
 * （登记发生在 spawn 之后，原进程 start time 必然 ≤ floor(startedAt/1000)）；无法取
 * start time（Windows 无 ps / ps 失败）保守跳过整个处置——宁延迟勿误杀。
 *
 * 错误防御：registry 解析失败/版本不匹配 → 重命名 .corrupt 保留现场 + 按空表继续
 * + warn（对齐 extension 写侧 readRegistry 行为：固定名优先、占用时带时间戳，不覆盖
 * 前一份现场；「空表重建」由后续写入自然完成）；单条目处置异常 warn 后跳过（幂等，
 * 下个事件重试）；单目录扫描失败 warn 后不中断整体扫描。
 *
 * 为什么入口是 async 而核心全同步：核心含 spawnSync ps（单条 5s 超时上限）与同步
 * 文件锁 busy-wait，而触发面 A 的调用链（removeSessionEntry）是同步销毁收敛链——
 * 入口经 setImmediate 延后一拍执行同步核心，调用方 void + catch 即为真 fire-and-forget
 * （既不 await 结果，也不占用销毁链所在的当前事件循环拍）。
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BACKGROUND_TASK_REGISTRY_FILENAME,
  BACKGROUND_TASK_REGISTRY_VERSION,
  BASE_TOOL_ENHANCE_DIRNAME,
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isActiveBackgroundTaskState,
  isBackgroundTaskRegistryEntry,
  isTerminalBackgroundTaskState,
  type BackgroundTaskRegistryEntry,
} from '@xyz-agent/extension-protocol'
import { DEFAULT_STALE_MS, withFileLockSync } from '../../utils/file-lock.js'

const LOG_TAG = '[bg-task-reaper]'

/** ps 调用超时：卡死的 ps 不拖垮收殓（超时按取不到处理 → 保守跳过）。 */
const PS_TIMEOUT_MS = 5_000
/** 毫秒 → 秒（epoch 秒换算；勿与 startedAt 的毫秒混用）。 */
const MS_PER_SECOND = 1_000

/**
 * 旧 reaper 全局锁的 lockfile 目录名（mkdir 形态，落 <baseDir>/reaper.lock）。
 * 扫描时须按名排除（否则会对锁目录做一次无谓的 registry 读取并计入 scannedDirs）；
 * 触发面 B 顺带清理其 stale 残留（见文件头「锁残留清理」）。
 */
const REAPER_LOCK_DIRNAME = 'reaper.lock'

// ──────────────────────── pid 探测 / 处置原语（移植 kill-tree.ts / reaper.ts） ────────────────────────

/**
 * pid 判活：kill(pid, 0) 不发信号只做存在性/权限校验。
 * ESRCH = 已死（含被 reap 后）；EPERM = 进程存在但属其他用户，仍视为活。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 杀整棵进程树（同步）：POSIX 杀进程组 kill(-pid)（base-tool-enhance 后台任务
 * detached spawn 自成进程组，pgid = pid）；进程组杀不到（组长已死）回退单 pid +
 * pgrep -P 递归清理残留子进程（先杀孙辈再杀子辈，防孙辈在父死后被 reparent 逃逸
 * 枚举）。Windows taskkill /F /T。幂等：目标已死静默成功。
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    killProcessTreeWindows(pid)
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch (err) {
    // best-effort 降级：组长已死（进程组不复存在）时走单 pid + 子孙递归兜底
    console.debug(`${LOG_TAG} process group kill missed, falling back to single pid + descendants:`, err instanceof Error ? err.message : err)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    // best-effort：目标已死（kill 幂等语义），仅留诊断
    console.debug(`${LOG_TAG} single pid kill missed (already dead?):`, err instanceof Error ? err.message : err)
  }
  killDescendantsRecursive(pid)
}

function killProcessTreeWindows(pid: number): void {
  try {
    const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    if (result.error) throw result.error
  } catch (err) {
    // best-effort：taskkill 失败（进程已死/权限）仅留诊断——收殓路径不因处置失败中断
    console.debug(`${LOG_TAG} taskkill failed:`, err instanceof Error ? err.message : err)
  }
}

/** pgrep -P 递归杀子孙进程（组长已死、进程组不复存在时的残留清理）。 */
function killDescendantsRecursive(pid: number): void {
  let stdout: string
  try {
    const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    if (result.error || result.status !== 0 || !result.stdout) return
    stdout = result.stdout
  } catch (err) {
    // best-effort：pgrep 不可用/失败时放弃子孙枚举（残留子进程交下个收殓周期）
    console.debug(`${LOG_TAG} descendant enumeration failed:`, err instanceof Error ? err.message : err)
    return
  }
  for (const line of stdout.split('\n')) {
    const childPid = Number.parseInt(line.trim(), 10)
    if (Number.isInteger(childPid) && childPid > 0) {
      killDescendantsRecursive(childPid)
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (err) {
        // best-effort：已死（kill 幂等语义），仅留诊断
        console.debug(`${LOG_TAG} descendant kill missed (already dead?):`, err instanceof Error ? err.message : err)
      }
    }
  }
}

/**
 * 取进程 start time（epoch 秒）。ps -o lstart= 跨 macOS/Linux（= 号去表头；Linux
 * /proc/<pid>/stat 精度更高但 macOS 无 /proc，统一 ps 保跨平台一致）。
 * 返回 undefined：进程不存在 / ps 不可用（Windows）/ 输出不可解析——调用方一律按
 * 「无法校验 → 保守跳过」处理。
 */
export function getProcessStartTimeSec(pid: number): number | undefined {
  let result: SpawnSyncReturns<string>
  try {
    result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    })
  } catch {
    return undefined
  }
  if (result.error || result.status !== 0 || !result.stdout) return undefined
  // lstart 形如 "Mon Aug 25 14:23:45 2026"（本地时区），Date.parse 按本地时区解释
  const ms = Date.parse(result.stdout.trim())
  return Number.isNaN(ms) ? undefined : Math.floor(ms / MS_PER_SECOND)
}

/**
 * pid 身份判据（§3.6「宁不杀勿误杀」的唯一判定点，移植 reaper.ts 同名函数）。
 * true = 当前占用该 pid 的进程 start time 与登记值匹配，可安全 kill。
 *  - 有登记 start time（spawn 时 ps 读取成功）→ 精确比较（同单位 epoch 秒）
 *  - 缺登记 start time（旧条目 / ps 不可用平台登记）→ startedAtMs 秒级降级：
 *    登记发生在 spawn 之后（进程先启动、条目后登记），原进程 start time 必然
 *    ≤ floor(startedAtMs/1000)（floor 单调性，零误跳）
 */
export function pidStartMatchesRegistered(
  actualStartSec: number,
  registeredStartSec: number | undefined,
  startedAtMs: number,
): boolean {
  return registeredStartSec !== undefined
    ? actualStartSec === registeredStartSec
    : actualStartSec <= Math.floor(startedAtMs / MS_PER_SECOND)
}

/** 读条目 start time 字段（epoch 秒）。运行时 guard：typeof + 有限性，防脏数据混入比较。 */
function readPidStartTimeSec(entry: BackgroundTaskRegistryEntry): number | undefined {
  const registered = entry.pidStartTime
  return typeof registered === 'number' && Number.isFinite(registered) ? registered : undefined
}

// ──────────────────────── registry 读写（移植 extension background/registry.ts 语义） ────────────────────────

/**
 * registry.json 目录布局（契约 SSOT）：<agentDir>/base-tool-enhance/<sessionId>/registry.json。
 * [u-runtime-svc 提炼导出] BackgroundTaskService（services/background-task/）与收殓器共用
 * 同一布局推导，禁止两处各写路径拼接（漂移面）。
 */
export function getSessionRegistryPath(agentDir: string, sessionId: string): string {
  return join(agentDir, BASE_TOOL_ENHANCE_DIRNAME, sessionId, BACKGROUND_TASK_REGISTRY_FILENAME)
}

// tmp 随机段参数（extension 写侧 uniqueTmpPath 同款：36 进制随机串，跳过 "0." 前缀）
const TMP_RADIX = 36
const TMP_SLICE_START = 2
const TMP_SLICE_END = 10
/** registry 序列化缩进（契约：JSON indent 2 + 尾部换行）。 */
const JSON_INDENT = 2

/** 校验并归一化 registry 文件内容；形状非法返回 undefined（走 corrupt 隔离路径）。 */
function parseRegistryContent(raw: string): BackgroundTaskRegistryEntry[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { version, entries } = parsed as Record<string, unknown>
  if (version !== BACKGROUND_TASK_REGISTRY_VERSION || !Array.isArray(entries)) return undefined
  // 单条脏数据丢弃、不报废全表（对齐写侧 isValidRegistryEntry 语义，契约 guard 复用）
  return entries.filter(isBackgroundTaskRegistryEntry)
}

/** .corrupt 落点：固定名优先；已存在则带时间戳，不覆盖前一份现场（对齐写侧）。 */
function corruptPathFor(registryPath: string): string {
  const base = `${registryPath}.corrupt`
  return existsSync(base) ? `${base}-${Date.now()}` : base
}

/**
 * 读取 registry 全量条目 + 损坏标记（[u-runtime-svc 提炼导出]：UI 读侧需要区分
 * 「真的空表」与「损坏被隔离的空表」（D1 corrupt 语义：空表 + 错误标记，不 throw）——
 * 收殓器不消费该差异，经 readRegistryEntries 薄壳保持原行为不变）。
 *
 * 文件不存在 / 读失败 → 空表 + corrupted:false（常态/降级，非损坏）；解析失败 →
 * 重命名 .corrupt 保留现场 + warn + 空表 + corrupted:true（「空表重建」由后续写入
 * 自然完成，不立即写空文件）。
 */
export function readRegistryEntriesWithStatus(
  registryPath: string,
): { entries: BackgroundTaskRegistryEntry[]; corrupted: boolean } {
  if (!existsSync(registryPath)) return { entries: [], corrupted: false }
  let raw: string
  try {
    raw = readFileSync(registryPath, 'utf8')
  } catch (err) {
    // best-effort 降级：读失败（权限等）按空表继续——收殓不因 registry 问题崩溃
    console.warn(`${LOG_TAG} registry read failed, treating as empty: ${registryPath}`, err instanceof Error ? err.message : err)
    return { entries: [], corrupted: false }
  }
  const parsed = parseRegistryContent(raw)
  if (parsed === undefined) {
    const corruptPath = corruptPathFor(registryPath)
    try {
      renameSync(registryPath, corruptPath)
      console.warn(`${LOG_TAG} registry corrupted, quarantined to ${corruptPath} and continuing with empty table: ${registryPath}`)
    } catch (err) {
      // best-effort 降级：隔离 rename 失败（目录只读等）原文件保留原位，仍按空表继续
      console.warn(`${LOG_TAG} registry corrupted and quarantine rename failed, continuing with empty table in place: ${registryPath}`, err instanceof Error ? err.message : err)
    }
    return { entries: [], corrupted: true }
  }
  return { entries: parsed, corrupted: false }
}

/**
 * 读取 registry 全量条目。文件不存在 / 读失败 / 解析失败均返回空表（收殓不因
 * registry 问题崩溃）；解析失败时重命名 .corrupt 保留现场 + warn + 按空表继续
 * （「空表重建」由后续写入自然完成，不立即写空文件）。
 */
export function readRegistryEntries(registryPath: string): BackgroundTaskRegistryEntry[] {
  return readRegistryEntriesWithStatus(registryPath).entries
}

/**
 * 原子写：tmp（pid+随机段唯一化防并发碰撞）+ rename（POSIX/Windows 均原子）；失败清理 tmp。
 * [u-runtime-svc 提炼导出] 与 services/background-task/registry-write.ts 共用同一原子写协议。
 */
export function atomicWriteRegistry(registryPath: string, content: string): void {
  mkdirSync(dirname(registryPath), { recursive: true })
  const tmpPath = `${registryPath}.tmp_${process.pid}_${Math.random().toString(TMP_RADIX).slice(TMP_SLICE_START, TMP_SLICE_END)}`
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, registryPath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch (cleanupErr) {
      // best-effort：tmp 清理失败不掩盖原错误，仅留诊断
      console.warn(`${LOG_TAG} registry tmp cleanup failed: ${tmpPath}`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr)
    }
    throw err
  }
}

/**
 * 写 orphaned 终态（锁内版，[u-runtime-svc 提炼导出]）：调用方已持 `<registry.json>.lock`
 * 时使用（D6 分支③「判活重查置于锁内重读之后」要求「重读 → 判活 → 写」全在同一锁临界
 * 区，防 stale 条目覆盖 poller 已写的新鲜终态——嵌套取锁必然 ELOCKED，故必须有无锁变体）。
 * 锁内 RMW：读全量 → 同 id 覆盖 → 终态 LRU 裁剪 → 原子写——与 extension 写侧
 * writeRegistryEntry 语义对齐。reason 不写：reason 枚举（natural/timeout/killed/process-exit）
 * 属 exited 语义，orphaned 的成因（属主强杀遗留）不在枚举内，保持缺省而非造词。
 * fs 错误向上抛（带锁壳 writeOrphanedTerminal 捕获降级，锁内调用方自捕 → 分支⑤语义）。
 */
export function writeOrphanedTerminalLocked(registryPath: string, entry: BackgroundTaskRegistryEntry): void {
  const merged = new Map(readRegistryEntries(registryPath).map((e) => [e.taskId, e] as const))
  const endedAt = Date.now()
  merged.set(entry.taskId, { ...entry, state: 'orphaned', endedAt, durationMs: endedAt - entry.startedAt })
  const all = [...merged.values()]
  const terminal = all
    .filter((e) => isTerminalBackgroundTaskState(e.state))
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
  const excess = terminal.length - MAX_TERMINAL_REGISTRY_ENTRIES
  for (let i = 0; i < excess; i++) merged.delete(terminal[i].taskId)
  atomicWriteRegistry(registryPath, `${JSON.stringify({ version: BACKGROUND_TASK_REGISTRY_VERSION, entries: [...merged.values()] }, null, JSON_INDENT)}\n`)
}

/**
 * 写 orphaned 终态（分支②③共用；统一锁 sync 版内 RMW，见 writeOrphanedTerminalLocked）。
 * 失败返回 false——条目停留 running，下个收殓事件重试（幂等闭环，无静默丢失）。
 */
export function writeOrphanedTerminal(registryPath: string, entry: BackgroundTaskRegistryEntry): boolean {
  try {
    withFileLockSync(registryPath, () => writeOrphanedTerminalLocked(registryPath, entry))
    return true
  } catch (err) {
    // best-effort 降级：写失败（锁预算耗尽等）条目停留 running，下个收殓事件重试——
    // 幂等闭环（补杀分支进程已死，下轮走③收尾），无静默丢失
    console.warn(`${LOG_TAG} registry orphaned-terminal write failed; entry stays as-is (next reap event will retry): ${registryPath} taskId=${entry.taskId}`, err instanceof Error ? err.message : err)
    return false
  }
}

// ──────────────────────── 三分支判定主体 ────────────────────────

/** 单轮收殓统计（日志 + 测试断言面；写失败/保守跳过单独计数保持守恒）。 */
export interface BackgroundTaskReapResult {
  /** 扫描的 sessionId 目录数（含无 registry / 无活跃条目的目录）。 */
  scannedDirs: number
  /** 分支①跳过：属主活。 */
  ownerAliveSkipped: number
  /** 分支②补杀成功：kill 已发令 + orphaned 终态写入。 */
  killedOrphans: number
  /** 分支③终态收尾成功：未补杀，仅转 orphaned。 */
  finalizedOrphans: number
  /** 保守跳过：start time 无法获取 / 复用嫌疑不匹配 / 条目处置异常 / 终态写失败。 */
  conservativelySkipped: number
  /** 触发面 B 顺带清理的 stale reaper.lock 残留目录数（触发面 A 恒 0）。 */
  staleLocksRemoved: number
}

/** 测试接缝：pid 探测/处置原语可注入（对齐 reap-orphan-pi 全依赖注入惯例，零真实进程可测）。 */
export interface BackgroundTaskReapDeps {
  /** pid 判活。默认真实 process.kill(pid, 0)。 */
  isPidAlive?: (pid: number) => boolean
  /** 进程树处置。默认真实 kill(-pid)/kill(pid) 实现。 */
  killProcessTree?: (pid: number) => void
  /** 进程 start time 获取（epoch 秒）。默认真实 ps。 */
  getProcessStartTimeSec?: (pid: number) => number | undefined
}

interface ResolvedReapDeps {
  isPidAlive: (pid: number) => boolean
  killProcessTree: (pid: number) => void
  getProcessStartTimeSec: (pid: number) => number | undefined
}

function resolveDeps(deps?: BackgroundTaskReapDeps): ResolvedReapDeps {
  return {
    isPidAlive: deps?.isPidAlive ?? isPidAlive,
    killProcessTree: deps?.killProcessTree ?? killProcessTree,
    getProcessStartTimeSec: deps?.getProcessStartTimeSec ?? getProcessStartTimeSec,
  }
}

function emptyResult(): BackgroundTaskReapResult {
  return { scannedDirs: 0, ownerAliveSkipped: 0, killedOrphans: 0, finalizedOrphans: 0, conservativelySkipped: 0, staleLocksRemoved: 0 }
}

/** 三分支判定主体（①②③与文件头逐条对应）。 */
function reapEntrySync(
  entry: BackgroundTaskRegistryEntry,
  registryPath: string,
  deps: ResolvedReapDeps,
  result: BackgroundTaskReapResult,
): void {
  // ①属主判定：ownerPiPid 仍活 = 活进程的合法任务，永不介入（挂死任务归属主自己的
  // bash_kill / 用户职责）
  if (deps.isPidAlive(entry.ownerPiPid)) {
    result.ownerAliveSkipped++
    return
  }

  // 属主已死 → 孤儿身份成立，按任务 pid 死活分流
  if (!deps.isPidAlive(entry.pid)) {
    // ③终态收尾：任务 pid 已死但条目仍 running/killing（graceful 收殓的 registry
    // 写入没写完/写不进的遗留）→ 不补杀，仅转终态 orphaned。ESRCH 无歧义，无需
    // start-time 校验（校验只服务「判活防复用」）
    if (writeOrphanedTerminal(registryPath, entry)) result.finalizedOrphans++
    else result.conservativelySkipped++
    return
  }

  // 任务 pid 存活 → ②孤儿补杀前先过 pid 复用防御
  const actualStartSec = deps.getProcessStartTimeSec(entry.pid)
  if (actualStartSec === undefined) {
    // 无法取 start time（Windows 无 ps / ps 失败 / 输出不可解析）→ 保守跳过整个
    // 处置：不补杀（可能误杀复用 pid 上的无辜进程）也不转终态（条目停留 running，
    // 下个收殓事件重试）。宁延迟勿误杀
    result.conservativelySkipped++
    console.warn(`${LOG_TAG} cannot read pid start time, conservatively skipping entry: taskId=${entry.taskId} pid=${entry.pid} ownerPiPid=${entry.ownerPiPid}`)
    return
  }
  const registeredStartSec = readPidStartTimeSec(entry)
  if (!pidStartMatchesRegistered(actualStartSec, registeredStartSec, entry.startedAt)) {
    // start time 与登记值不匹配 = pid 已被系统复用，当前占用者是无关新进程 → 视为
    // 已死：不误杀，也不转终态（任务真实死活未知，交下一周期）
    result.conservativelySkipped++
    console.warn(`${LOG_TAG} pid start time mismatch (likely pid reuse), skipping entry: taskId=${entry.taskId} pid=${entry.pid} actualStartSec=${actualStartSec} registeredStartSec=${registeredStartSec}`)
    return
  }

  // ②孤儿补杀：属主已死 + 原进程身份成立（pid 活 + start time 匹配）
  deps.killProcessTree(entry.pid)
  console.warn(`${LOG_TAG} orphan task killed: taskId=${entry.taskId} pid=${entry.pid} ownerPiPid=${entry.ownerPiPid} command=${entry.command}`)
  if (writeOrphanedTerminal(registryPath, entry)) result.killedOrphans++
  else result.conservativelySkipped++
}

/** 处置单个 session 目录的 registry：终态跳过，活跃条目逐条判定；单条异常 warn 跳过。 */
function reapSessionDirSync(sessionDir: string, deps: ResolvedReapDeps, result: BackgroundTaskReapResult): void {
  const registryPath = join(sessionDir, BACKGROUND_TASK_REGISTRY_FILENAME)
  const entries = readRegistryEntries(registryPath)
  for (const entry of entries) {
    if (!isActiveBackgroundTaskState(entry.state)) continue
    try {
      reapEntrySync(entry, registryPath, deps, result)
    } catch (err) {
      // 单条目处置异常 warn 后跳过（幂等，下个事件重试）——不中断其余条目
      result.conservativelySkipped++
      console.warn(`${LOG_TAG} entry reap failed, skipping entry: taskId=${entry.taskId}`, err instanceof Error ? err.message : err)
    }
  }
}

/** 触发面 A 核心：处置指定 session 的 registry（该目录不存在 = 从未有过后台任务，常态）。 */
function reapOneSessionSync(agentDir: string, sessionId: string, deps: ResolvedReapDeps): BackgroundTaskReapResult {
  const result = emptyResult()
  const sessionDir = dirname(getSessionRegistryPath(agentDir, sessionId))
  if (!existsSync(sessionDir)) return result
  result.scannedDirs = 1
  try {
    reapSessionDirSync(sessionDir, deps, result)
  } catch (err) {
    // best-effort：目录级双保险（readRegistryEntries 已内建损坏防御，此处兜意外 fs
    // 错误）——本轮放弃该目录，条目停留原状，下个收殓事件重试
    console.warn(`${LOG_TAG} session dir reap failed, skipping dir: ${sessionId}`, err instanceof Error ? err.message : err)
  }
  return result
}

/** 触发面 B 核心：扫全部 session 目录 + 清理 stale reaper.lock 残留。 */
function reapAllSessionsSync(agentDir: string, deps: ResolvedReapDeps): BackgroundTaskReapResult {
  const result = emptyResult()
  const baseDir = join(agentDir, BASE_TOOL_ENHANCE_DIRNAME)
  let dirents: Dirent[]
  try {
    dirents = readdirSync(baseDir, { withFileTypes: true })
  } catch (err) {
    // baseDir 不存在（从未有过后台任务）是常态，不告警；读失败（权限等）warn 后放弃本轮
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`${LOG_TAG} base dir unreadable, skipping this scan: ${baseDir}`, err instanceof Error ? err.message : err)
    }
    return result
  }
  removeStaleReaperLock(baseDir, result)
  for (const dirent of dirents) {
    // reaper.lock 目录与 .DS_Store 等非 session 目录跳过
    if (!dirent.isDirectory() || dirent.name === REAPER_LOCK_DIRNAME) continue
    result.scannedDirs++
    try {
      reapSessionDirSync(join(baseDir, dirent.name), deps, result)
    } catch (err) {
      // 错误容忍：单目录失败跳过 + warn，不中断整体扫描
      console.warn(`${LOG_TAG} session dir scan failed, skipping dir: ${dirent.name}`, err instanceof Error ? err.message : err)
    }
  }
  return result
}

/**
 * 清理 stale 的 reaper.lock 残留目录（旧 extension reaper 的全局锁实体，D2 落地后
 * 不再产生）。stale 判据沿用统一锁 DEFAULT_STALE_MS（30s）：mtime 超过即视为持锁者
 * 已死（与 withFileLockSync 的 stale 夺取同口径）；fresh 的锁目录可能是共存旧包的
 * 在途临界区，不动。rmdir 只对空目录生效——残留非锁内容（ENOTEMPTY）warn 后留给
 * 下次启动。
 */
function removeStaleReaperLock(baseDir: string, result: BackgroundTaskReapResult): void {
  const lockDir = join(baseDir, REAPER_LOCK_DIRNAME)
  try {
    const st = statSync(lockDir)
    if (!st.isDirectory()) return
    if (Date.now() - st.mtimeMs <= DEFAULT_STALE_MS) return
    rmdirSync(lockDir)
    result.staleLocksRemoved++
    console.log(`${LOG_TAG} removed stale reaper.lock residue: ${lockDir}`)
  } catch (err) {
    // best-effort：ENOENT（无残留）静默；其余失败（ENOTEMPTY 残留内容/权限）留给下次启动
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    console.warn(`${LOG_TAG} stale reaper.lock removal failed, leaving it for next startup: ${lockDir}`, err instanceof Error ? err.message : err)
  }
}

// ──────────────────────── 入口（双触发面） ────────────────────────

/** setImmediate 延后一拍：同步核心（spawnSync ps / 同步锁 busy-wait）不占用调用方当前事件循环拍。 */
function deferToNextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 有实际收殓动作时的汇总日志（S4a/S4b「runtime 日志有收殓记录」的观测面）。 */
function logReapSummary(scope: string, result: BackgroundTaskReapResult): void {
  if (result.killedOrphans > 0 || result.finalizedOrphans > 0 || result.staleLocksRemoved > 0) {
    console.log(`${LOG_TAG} ${scope}: killed=${result.killedOrphans} finalized=${result.finalizedOrphans} ownerAliveSkipped=${result.ownerAliveSkipped} conservativelySkipped=${result.conservativelySkipped} staleLocksRemoved=${result.staleLocksRemoved}`)
  }
}

/**
 * 触发面 A：收殓指定 session 的后台任务（挂 session-service removeSessionEntry
 * 汇聚点，fire-and-forget）。幂等：终态条目跳过 + 属主活跳过，二次收殓天然 no-op。
 */
export async function reapSessionBackgroundTasks(
  agentDir: string,
  sessionId: string,
  deps?: BackgroundTaskReapDeps,
): Promise<BackgroundTaskReapResult> {
  await deferToNextTick()
  const result = reapOneSessionSync(agentDir, sessionId, resolveDeps(deps))
  logReapSummary(`session reap (sessionId=${sessionId})`, result)
  return result
}

/**
 * 触发面 B：启动期全量兜底扫描（挂 startup-background-init，硬序在
 * reapOrphanPiProcesses 完成后执行）——覆盖触发面 A 够不到的三类：上次运行崩溃/
 * SIGKILL 遗留孤儿（本次运行无销毁事件）、启动期孤儿 pi 收殓所杀 pi 的 detached
 * 任务（不在 SessionService Map，依赖硬序）、从未激活即被删的 session。
 */
export async function reapAllSessionsBackgroundTasks(
  agentDir: string,
  deps?: BackgroundTaskReapDeps,
): Promise<BackgroundTaskReapResult> {
  await deferToNextTick()
  const result = reapAllSessionsSync(agentDir, resolveDeps(deps))
  logReapSummary('startup full scan', result)
  return result
}

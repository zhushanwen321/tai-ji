/**
 * 后台任务收殓器（runtime 侧，双触发面 D2——docs/design/file-lock-unification-and-
 * reaper-sink.md §2.3 目标态数据流 / §3.2 D2 决策表 / §3.3 挂点论证）。
 *
 * 职责（G2 职责归位）：孤儿后台任务的收殓由 pi 生命周期的所有者（runtime）执行，
 * extension 不再做全局扫描/全局锁。判定逻辑移植自 extensions/universal/
 * base-tool-enhance/src/reaper.ts（三分支判定 + pid 复用防御 + registry 损坏隔离 +
 * 错误防御）；行为原语自 ext-simplify-13 起统一取 @xyz-agent/extension-protocol
 * 子出口 `background-task`（pid 探测/处置原语 + registry 文件原语，跨端与 extension
 * 侧单一实现——此前各持一份逐字同构副本靠注释对齐，tail 签名已实际漂移），本文件
 * 只保留编排层：三分支判定、双触发面、统一锁 sync 版锁壳（utils/file-lock.ts
 * withFileLockSync，与 extension 写侧互斥同一把 lockfile `<registry.json>.lock`）、
 * 写失败降级决策；protocol 原语的日志通道经 onLog/onFallback 回调注入 console 适配
 * （本文件 LOG_TAG 形态，与既有日志语义等价）。
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

import { existsSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BACKGROUND_TASK_REGISTRY_FILENAME,
  BASE_TOOL_ENHANCE_DIRNAME,
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isActiveBackgroundTaskState,
  type BackgroundTaskRegistryEntry,
} from '@xyz-agent/extension-protocol'
import {
  atomicWriteRegistry,
  getProcessStartTimeSec,
  isPidAlive,
  killProcessTree,
  pidStartMatchesRegistered,
  readRegistry,
  serializeRegistryFile,
  trimTerminalEntries,
  type ProcessFallbackLogger,
  type RegistryFileLogFn,
} from '../../utils/protocol-background-task.js'
import { DEFAULT_STALE_MS, withFileLockSync } from '../../utils/file-lock.js'

const LOG_TAG = '[bg-task-reaper]'

/** 进程原语回退路径诊断的 console 适配（protocol onFallback → runtime console 通道）。 */
const processFallbackLog: ProcessFallbackLogger = (step, err) =>
  console.debug(`${LOG_TAG} ${step}:`, err instanceof Error ? err.message : err)

/** registry 文件原语诊断的 console 适配（protocol onLog → runtime console 通道；corrupt 隔离 warn 是排障生命线，必接）。 */
const registryLog: RegistryFileLogFn = (level, event, detail) =>
  (level === 'warn' ? console.warn : console.debug)(`${LOG_TAG} ${event}`, detail)

/**
 * 旧 reaper 全局锁的 lockfile 目录名（mkdir 形态，落 <baseDir>/reaper.lock）。
 * 扫描时须按名排除（否则会对锁目录做一次无谓的 registry 读取并计入 scannedDirs）；
 * 触发面 B 顺带清理其 stale 残留（见文件头「锁残留清理」）。
 */
const REAPER_LOCK_DIRNAME = 'reaper.lock'

/**
 * registry.json 目录布局（契约 SSOT）：<agentDir>/base-tool-enhance/<sessionId>/registry.json。
 * [u-runtime-svc 提炼导出] BackgroundTaskService（services/background-task/）与收殓器共用
 * 同一布局推导，禁止两处各写路径拼接（漂移面）。
 */
export function getSessionRegistryPath(agentDir: string, sessionId: string): string {
  return join(agentDir, BASE_TOOL_ENHANCE_DIRNAME, sessionId, BACKGROUND_TASK_REGISTRY_FILENAME)
}

/**
 * 读取 registry 全量条目 + 损坏标记（[u-runtime-svc 提炼导出]：UI 读侧需要区分
 * 「真的空表」与「损坏被隔离的空表」（D1 corrupt 语义：空表 + 错误标记，不 throw）——
 * 收殓器不消费该差异，经 readRegistryEntries 薄壳保持原行为不变）。薄壳委托 protocol
 * readRegistry（解析防御 + corrupt 隔离单一实现），日志经 registryLog 注入 console。
 */
export function readRegistryEntriesWithStatus(
  registryPath: string,
): { entries: BackgroundTaskRegistryEntry[]; corrupted: boolean } {
  return readRegistry(registryPath, registryLog)
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
 * 写 orphaned 终态（锁内版，[u-runtime-svc 提炼导出]）：调用方已持 `<registry.json>.lock`
 * 时使用（D6 分支③「判活重查置于锁内重读之后」要求「重读 → 判活 → 写」全在同一锁临界
 * 区，防 stale 条目覆盖 poller 已写的新鲜终态——嵌套取锁必然 ELOCKED，故必须有无锁变体）。
 * 锁内 RMW：读全量 → 同 id 覆盖 → 终态 LRU 裁剪（protocol trimTerminalEntries 纯函数）→
 * 原子写（protocol atomicWriteRegistry + serializeRegistryFile，字节契约单点）——与
 * extension 写侧 writeRegistryEntry 语义对齐。reason 不写：reason 枚举（natural/timeout/
 * killed/process-exit）属 exited 语义，orphaned 的成因（属主强杀遗留）不在枚举内，保持
 * 缺省而非造词。fs 错误向上抛（带锁壳 writeOrphanedTerminal 捕获降级，锁内调用方自捕
 * → 分支⑤语义）。
 */
export function writeOrphanedTerminalLocked(registryPath: string, entry: BackgroundTaskRegistryEntry): void {
  const merged = new Map(readRegistryEntries(registryPath).map((e) => [e.taskId, e] as const))
  const endedAt = Date.now()
  merged.set(entry.taskId, { ...entry, state: 'orphaned', endedAt, durationMs: endedAt - entry.startedAt })
  const kept = trimTerminalEntries([...merged.values()], MAX_TERMINAL_REGISTRY_ENTRIES)
  atomicWriteRegistry(registryPath, serializeRegistryFile(kept), registryLog)
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
  /** pid 判活。默认真实 process.kill(pid, 0)（protocol 原语）。 */
  isPidAlive?: (pid: number) => boolean
  /** 进程树处置。默认真实 kill(-pid)/kill(pid) 实现（protocol 原语，回退诊断经 console 适配）。 */
  killProcessTree?: (pid: number) => void
  /** 进程 start time 获取（epoch 秒）。默认真实 ps（protocol 原语）。 */
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
    // 默认实现包一层 onFallback 注入：回退路径诊断落 console（与原本地实现日志语义等价）
    killProcessTree: deps?.killProcessTree ?? ((pid: number) => killProcessTree(pid, processFallbackLog)),
    getProcessStartTimeSec: deps?.getProcessStartTimeSec ?? getProcessStartTimeSec,
  }
}

function emptyResult(): BackgroundTaskReapResult {
  return { scannedDirs: 0, ownerAliveSkipped: 0, killedOrphans: 0, finalizedOrphans: 0, conservativelySkipped: 0, staleLocksRemoved: 0 }
}

/** 读条目 start time 字段（epoch 秒）。运行时 guard：typeof + 有限性，防脏数据混入比较。 */
function readPidStartTimeSec(entry: BackgroundTaskRegistryEntry): number | undefined {
  const registered = entry.pidStartTime
  return typeof registered === 'number' && Number.isFinite(registered) ? registered : undefined
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

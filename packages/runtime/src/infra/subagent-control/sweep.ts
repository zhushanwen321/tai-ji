/**
 * subagent-control 跨代残留清理（M3，设计 relay-spawn-transport §3.3 D7「启动残留
 * socket 清理 + 孤儿引擎收割」）。
 *
 * 跨代清理的语义边界（D7 刻意收窄）：
 * - socket：扫 `subagent-*.sock` 全族（不是只探当前 pid 路径）+ 旧 relay `relay-*.sock`
 *   残片族（S-13：relay 实现已退役，残片唯一剩余交互 = 本处收割）；connect 探活，死
 *   文件 unlink、活文件 warn（另一活实例在听，不动它）。
 * - 引擎 pid 文件：owner runtime 活着 → 跳过（它在管）；owner 死 → **立即收割**（不采
 *   用 mirror mtime 活跃度分级——runtime 死后 mirror 不再更新，判据恒过期；D7 明确
 *   退役该分级）。owner 判活带 pid 复用防护（条目 65）：pid 存活之外比对登记的 owner
 *   start time（pid + start time 二元组判「同一 pid 还是原进程」）——不匹配 = pid 已
 *   被无关进程复用、原 owner 已死，照常收割；不可核实（旧格式登记无该字段 / start
 *   time 取不到）= 保守判活跳过，不清存量登记。引擎侧 pid 复用防护保留（「宁不杀勿
 *   误杀」）：进程 start time 晚于
 *   spawn 登记 = pid 已被无关进程复用，只删记录不杀；start time 取不到（Windows/
 *   ps 不可用）= 无法验证身份 → 同样保守跳过击杀并保留记录（m-rt-3）。
 * - `.pid.tmp-*` 残片（原子写中途中断产物）：无 owner 判活语义，直接清（写者 =
 *   本实例的在途原子写除外——sweep 与 spawn 并发窗口内不误删自己的 tmp）。
 * - 旧 relay `relay-children/*.pid` 残片（S-13）：判定链复用引擎收割（relay 记录无
 *   runtimePid owner 字段 → owner 恒判死）；不可解析/字段畸形直接删（残片无恢复
 *   价值——族已退役无未来读者，与活协议的「保留待人工核实」是真差异）。
 * - kill 失败语义（m-rt-4）：kill 信号无同步成功回执——发出后做有界存活复核，
 *   确认已死才删 pid 文件；仍存活则保留记录 + warn，下次启动再扫。
 * - 不引入周期性巡检：启动 sweep + 事件驱动（连接关闭/exit）足够（ADR-0122）。
 */
import * as net from 'node:net'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  isPidAlive,
  killProcessTree,
  getProcessStartTimeSec,
  pidStartMatchesRegistered,
} from '../../utils/protocol-background-task.js'
import { logger } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'
import { getControlEnginesDir, getControlRunDir, getLegacyRelayChildrenDir } from './paths.js'

/** socket 探活窗口（控制面单请求秒级量级；超时按死文件处置）。 */
const SOCKET_PROBE_TIMEOUT_MS = 1_000

/**
 * 启动残留 socket 清理。skipPath = 本实例即将 listen 的路径（不探不删——listen 前的
 * 定向探活由 probeListenPathBeforeBind 承接）。扫描面 = control 族 `subagent-*.sock` +
 * 旧 relay 族 `relay-*.sock` 残片（relay 族无本实例路径，不涉及 skip）。
 * 失败 best-effort：单项失败不阻塞启动（残留文件下次启动再扫）。
 */
export async function sweepStaleControlSockets(dataDir: string, skipPath: string): Promise<void> {
  const runDir = getControlRunDir(dataDir)
  let files: string[]
  try {
    files = readdirSync(runDir)
  } catch {
    return // 目录不存在（首启）= 无残留
  }
  for (const file of files) {
    const isControlSocket = file.startsWith('subagent-') && file.endsWith('.sock')
    const isLegacyRelaySocket = file.startsWith('relay-') && file.endsWith('.sock')
    if (!isControlSocket && !isLegacyRelaySocket) continue
    const socketPath = join(runDir, file)
    if (isControlSocket && socketPath === skipPath) continue
    const alive = await probeSocketAlive(socketPath)
    if (alive) {
      logger.warn(`[subagent-control] stale socket ${socketPath} is held by a live runtime instance, keeping it`)
      continue
    }
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath)
      logger.info(`[subagent-control] removed stale control socket ${socketPath}`)
    } catch (e) {
      // best-effort 降级：单项清理失败不阻塞启动（残留文件下次启动再扫）
      logger.warn(`[subagent-control] failed to remove stale socket ${socketPath}: ${toErrorMessage(e)}`)
    }
  }
}

/**
 * listen 前对即将 bind 的 socket 路径定向探活（S-9）：启动 sweep 刻意跳过本实例路径
 * （skipPath），留下「前代崩溃残片 + OS 复用同 pid → bind 撞 EADDRINUSE 致命」的窗口。
 * 补一道前置探活：
 * - 文件不存在 → no-op（常态，直接 bind）；
 * - connect 连得通 → 路径被活跃 server 占用（实例冲突 / pid 复用撞活实例）→ 抛致命
 *   冲突附恢复指引（比裸 EADDRINUSE 可读；由组合根 fail-fast）；
 * - connect 连不通 → 死残片（前代崩溃产物）→ unlink 后正常 bind。
 * unlink 失败不拦截 listen：让 bind 自己报 EADDRINUSE（原 pid 复用 fail-fast 语义保留，
 * 本探活只是其前置补强）。
 */
export async function probeListenPathBeforeBind(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return
  if (await probeSocketAlive(socketPath)) {
    throw new Error(
      `[subagent-control] socket path ${socketPath} is occupied by a live listener `
      + '(another runtime instance on this data dir, or a pid-reuse collision). '
      + 'Recovery: stop the other taiji runtime using this data dir, then restart.',
    )
  }
  try {
    unlinkSync(socketPath)
    logger.info(`[subagent-control] removed dead socket residue before listen ${socketPath}`)
  } catch (e) {
    // best-effort 降级：unlink 失败留给 listen 报 EADDRINUSE（fail-fast 语义不在这层吞掉）
    logger.warn(`[subagent-control] failed to remove dead socket residue ${socketPath}: ${toErrorMessage(e)}`)
  }
}

function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath })
    let settled = false
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      probe.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => finish(false), SOCKET_PROBE_TIMEOUT_MS)
    probe.once('connect', () => finish(true))
    probe.once('error', () => finish(false))
  })
}

/** 引擎 pid 文件登记形状（spawn 后原子写；畸形文件保留待人工核实，不静默销账）。 */
type EnginePidFileRecord = {
  pid?: unknown
  spawnedAt?: unknown
  runtimePid?: unknown
  /** 登记时 owner runtime 进程的 start time（epoch 秒；条目 65 身份比对依据，旧格式无此字段）。 */
  runtimePidStartSec?: unknown
  instanceId?: unknown
}

/**
 * pid 原子写残片形态（`<...>.pid.tmp-<writerPid>-<hex>`，writeEnginePidFileAtomically
 * 中断产物）。返回写者 pid；不匹配该形态返回 null。
 */
const PID_TMP_FRAGMENT_RE = /\.pid\.tmp-(\d+)-[0-9a-f]+$/

function pidTmpFragmentWriterPid(file: string): number | null {
  const m = PID_TMP_FRAGMENT_RE.exec(file)
  return m === null ? null : Number(m[1])
}

/** sweep 依赖注入槽（测试观察杀链调用与 pid 身份判据；生产全部走缺省实现）。 */
export type OrphanSweepDeps = {
  isPidAlive?: (pid: number) => boolean
  killProcessTree?: (pid: number, onFallback?: (step: string, err: unknown) => void) => void
  getProcessStartTimeSec?: (pid: number) => number | undefined
  /** kill 后存活复核的轮询上界（ms；回收层有界兜底，测试可注入小值）。 */
  killConfirmTimeoutMs?: number
}

/** kill 后存活复核轮询间隔（确认动作的事实查询，不是时间推测对账）。 */
const KILL_CONFIRM_POLL_MS = 10
/** kill 后存活复核的缺省上界（回收层有界兜底；确认已死立即返回）。 */
const KILL_CONFIRM_DEFAULT_TIMEOUT_MS = 500

/** sweep 主循环解析一次、逐 pid 文件复用的运行期依赖（生产 = 缺省实现，测试注入）。 */
type OrphanSweepRuntime = {
  alive: (pid: number) => boolean
  kill: (pid: number, onFallback?: (step: string, err: unknown) => void) => void
  readStartTime: (pid: number) => number | undefined
  confirmTimeoutMs: number
}

/**
 * 启动孤儿引擎收割：owner runtime 死亡的引擎组立即收割（按进程组终止连带其 pi 子进程），
 * owner 活着的条目属另一活实例在管、不碰。同目录的 `.pid.tmp-*` 原子写中断残片一并
 * 清（无 owner 判活语义；写者 = 本实例的在途原子写跳过——sweep 异步跑不误删自己的 tmp）。
 *
 * 失败语义（m-rt-4）：kill 是 fire-and-forget 信号，没有同步成功回执——这里在发出
 * kill 后做一次有界存活复核，确认已死才删 pid 文件；仍存活（taskkill 失败/权限不足）
 * 则保留记录 + warn，供下次启动再扫（删文件会把杀不掉的孤儿从兜底视野永久销账）。
 */
export async function sweepOrphanEnginePids(dataDir: string, deps: OrphanSweepDeps = {}): Promise<void> {
  const rt = buildOrphanSweepRuntime(deps)
  const enginesDir = getControlEnginesDir(dataDir)
  let files: string[]
  try {
    files = readdirSync(enginesDir)
  } catch {
    return // 目录不存在 = 无残留
  }
  for (const file of files) {
    const tmpWriter = pidTmpFragmentWriterPid(file)
    if (tmpWriter !== null) {
      if (tmpWriter !== process.pid) {
        removeQuietly(join(enginesDir, file))
        logger.info(`[subagent-control] removed pid-file tmp fragment ${join(enginesDir, file)}`)
      }
      continue
    }
    if (!file.endsWith('.pid')) continue
    await sweepOneOrphanPidFile(join(enginesDir, file), rt)
  }
}

/** sweep 运行期依赖装配（sweepOrphanEnginePids / sweepLegacyRelayChildren 共用）。 */
function buildOrphanSweepRuntime(deps: OrphanSweepDeps): OrphanSweepRuntime {
  return {
    alive: deps.isPidAlive ?? isPidAlive,
    kill: deps.killProcessTree ?? killProcessTree,
    readStartTime: deps.getProcessStartTimeSec ?? getProcessStartTimeSec,
    confirmTimeoutMs: deps.killConfirmTimeoutMs ?? KILL_CONFIRM_DEFAULT_TIMEOUT_MS,
  }
}

/**
 * 旧 relay 子进程 pid 文件收割（S-13）：relay 实现已整体退役（u-m3-delete），这些文件
 * 不再有写方——唯一剩余语义 = 升级前旧 runtime 崩溃留下的孤儿残片。判定链复用
 * sweepOneOrphanPidFile 的引擎收割（relay 记录无 runtimePid owner 字段 → owner 恒判死
 * → pid 死删档 / pid 复用只删不杀 / 身份核实后按进程组终止，pid 复用防护同款保留）；差异 =
 * 不可解析或 pid/spawnedAt 字段畸形的文件直接删（旧 relay 自身语义：残片无恢复价值，
 * 族已退役无未来读者——与活协议「保留待人工核实」是真差异）。
 */
export async function sweepLegacyRelayChildren(dataDir: string, deps: OrphanSweepDeps = {}): Promise<void> {
  const rt = buildOrphanSweepRuntime(deps)
  const childrenDir = getLegacyRelayChildrenDir(dataDir)
  let files: string[]
  try {
    files = readdirSync(childrenDir)
  } catch {
    return // 目录不存在 = 无残片
  }
  for (const file of files) {
    if (!file.endsWith('.pid')) continue
    await sweepOneLegacyRelayPidFile(join(childrenDir, file), rt)
  }
}

/** 单条旧 relay pid 残片的预检（形状合格转引擎收割链；畸形直接删）。 */
async function sweepOneLegacyRelayPidFile(pidFile: string, rt: OrphanSweepRuntime): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(pidFile, 'utf-8'))
  } catch (e) {
    logger.warn(`[subagent-control] removed unreadable legacy relay pid file ${pidFile}: ${toErrorMessage(e)}`)
    removeQuietly(pidFile)
    return
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as EnginePidFileRecord) : null
  if (record === null || numericField(record.pid) === null || numericField(record.spawnedAt) === null) {
    logger.warn(`[subagent-control] removed malformed legacy relay pid file ${pidFile} (pid/spawnedAt not numeric)`)
    removeQuietly(pidFile)
    return
  }
  await sweepOneOrphanPidFile(pidFile, rt)
}

/** 单条 pid 文件的收割裁决（主循环逐文件调用；每条记录的处理在返回前完成）。 */
async function sweepOneOrphanPidFile(pidFile: string, rt: OrphanSweepRuntime): Promise<void> {
  const record = readEnginePidRecord(pidFile)
  if (record === null) return
  // owner runtime 活着 = 另一活实例在管（本机单实例守卫正常时不应发生，双保险跳过）。
  if (ownerRuntimeAlive(pidFile, record, rt)) return
  const enginePid = numericField(record.pid)
  if (enginePid === null || !rt.alive(enginePid)) {
    removeQuietly(pidFile)
    return
  }
  if (!identityVerified(pidFile, enginePid, record, rt)) return
  await reapVerifiedOrphan(pidFile, enginePid, rt)
}

/** pid 文件读取。不可解析 = 无法得知引擎 pid（原子写上线前的旧残片/外部损坏）——不能
 * 静默删档，保留 + warn 交人工核实；后续 sweep 会继续提示。 */
function readEnginePidRecord(pidFile: string): EnginePidFileRecord | null {
  try {
    return JSON.parse(readFileSync(pidFile, 'utf-8')) as EnginePidFileRecord
  } catch (e) {
    logger.warn(`[subagent-control] unreadable pid file kept (cannot attribute engine pid) ${pidFile}: ${toErrorMessage(e)}`)
    return null
  }
}

/** JSON 数值字段收窄（非 number / 缺失 → null）。 */
function numericField(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * owner runtime 存活判定（条目 65 加固）：pid 存活之外比对登记的 owner start time
 * （pid + start time 二元组）——不匹配 = pid 已被无关进程复用、原 owner 已死 → 判死
 * 进入收割链，消除「owner 死后 pid 复用 → 误判活着 → 残留永存」。不可核实一律保守
 * 判活跳过（「宁不杀勿误杀」，m-rt-3 同款语义）：旧格式登记无 runtimePidStartSec /
 * sweep 侧 start time 取不到（Windows/ps 不可用）。instanceId 一致性校验（m-rt-5）：
 * 当前写点与 runtimePid 同值，读取它至少能识别记录错配（写入方/版本漂移）。
 */
function ownerRuntimeAlive(
  pidFile: string,
  record: EnginePidFileRecord,
  rt: OrphanSweepRuntime,
): boolean {
  const runtimePid = numericField(record.runtimePid)
  if (runtimePid === null || !rt.alive(runtimePid)) return false
  if (!ownerPidIsOriginal(pidFile, record, runtimePid, rt)) return false
  const instanceId = typeof record.instanceId === 'string' ? record.instanceId : null
  if (instanceId !== null && instanceId !== String(runtimePid)) {
    logger.warn(
      `[subagent-control] pid file ${basename(pidFile)} instanceId=${instanceId} does not match `
      + `runtimePid=${String(runtimePid)}; owner identity unverifiable, keeping the record and skipping`,
    )
  }
  return true
}

/**
 * owner pid 身份比对：登记了 runtimePidStartSec（新格式）时，pid 占用者的实际 start
 * time 与登记值不匹配 = pid 已被无关进程复用（原 owner 必死——pid 复用前提是原进程
 * 已退出）→ false。登记值缺失（旧格式 / 登记侧 ps 取不到）或实际值取不到（Windows/
 * ps 失败）= 无法核实身份 → true（保守判活，绝不清活 owner 的登记）。
 */
function ownerPidIsOriginal(
  pidFile: string,
  record: EnginePidFileRecord,
  runtimePid: number,
  rt: OrphanSweepRuntime,
): boolean {
  const registeredStartSec = numericField(record.runtimePidStartSec)
  if (registeredStartSec === null) return true // 旧格式登记：不可核实 → 维持按 pid 存活判定
  const actualStartSec = rt.readStartTime(runtimePid)
  if (actualStartSec === undefined) {
    logger.warn(
      `[subagent-control] cannot verify owner runtime pid ${String(runtimePid)} start time `
      + `(ps unavailable); assuming alive and keeping ${basename(pidFile)} (conservative)`,
    )
    return true
  }
  if (actualStartSec !== registeredStartSec) {
    logger.warn(
      `[subagent-control] owner runtime pid ${String(runtimePid)} reused (start time mismatch: `
      + `registered=${String(registeredStartSec)} actual=${String(actualStartSec)}); `
      + `original owner dead, reaping ${basename(pidFile)}`,
    )
    return false
  }
  return true
}

/**
 * pid 复用防护（「宁不杀勿误杀」）：无法取得 start time（Windows 无 ps / ps 超时）
 * 或登记缺失 spawnedAt = 无法验证身份，保守跳过击杀并保留 pid 文件 + warn（m-rt-3）。
 * Windows 的主死亡链是引擎 stdin EOF 自灭，sweep 只是兜底——宁漏杀勿误杀无关进程树。
 * pid 已被复用（start 晚于登记）只删记录不杀。返回 true = 身份已核实，可进入收割。
 */
function identityVerified(
  pidFile: string,
  enginePid: number,
  record: EnginePidFileRecord,
  rt: OrphanSweepRuntime,
): boolean {
  const spawnedAt = numericField(record.spawnedAt)
  if (spawnedAt === null) {
    logger.warn(
      `[subagent-control] pid file ${basename(pidFile)} has no spawnedAt; cannot verify pid `
      + `${String(enginePid)} identity, keeping the record and skipping kill (conservative)`,
    )
    return false
  }
  const startSec = rt.readStartTime(enginePid)
  if (startSec === undefined) {
    logger.warn(
      `[subagent-control] cannot verify pid ${String(enginePid)} start time (ps unavailable); `
      + `keeping ${basename(pidFile)} and skipping kill (conservative)`,
    )
    return false
  }
  if (!pidStartMatchesRegistered(startSec, undefined, spawnedAt)) {
    logger.warn(`[subagent-control] pid ${String(enginePid)} reused (started after registration), not killing — ${basename(pidFile)}`)
    removeQuietly(pidFile)
    return false
  }
  return true
}

/** 按进程组终止已核实身份的孤儿引擎 + 有界存活复核：确认已死才删档；杀链失败（权限/系统错误）
 * 保留记录下次再扫。 */
async function reapVerifiedOrphan(pidFile: string, enginePid: number, rt: OrphanSweepRuntime): Promise<void> {
  logger.warn(`[subagent-control] reaping orphan engine group pid=${String(enginePid)} (${basename(pidFile)}; owner runtime dead)`)
  rt.kill(enginePid, (step, err) => {
    logger.debug(`[subagent-control] orphan kill fallback (${step}) pid=${String(enginePid)}: ${toErrorMessage(err)}`)
  })
  if (await waitForProcessDeath(enginePid, rt.confirmTimeoutMs, rt.alive)) {
    removeQuietly(pidFile)
  } else {
    logger.warn(
      `[subagent-control] orphan engine pid=${String(enginePid)} still alive after kill; `
      + `keeping ${basename(pidFile)} for the next sweep`,
    )
  }
}

/** 轮询 pid 存活直到死亡或超时（事实查询；回收层有界兜底，成功杀灭后立即返回）。 */
async function waitForProcessDeath(
  pid: number,
  timeoutMs: number,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, KILL_CONFIRM_POLL_MS))
  }
  return true
}

function removeQuietly(pidFile: string): void {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile)
  } catch (e) {
    // best-effort 降级：pid 文件删除失败不升级（记录残留不影响判活语义）
    logger.warn(`[subagent-control] pid file remove failed ${pidFile}: ${toErrorMessage(e)}`)
  }
}

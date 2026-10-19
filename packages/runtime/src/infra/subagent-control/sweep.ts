/**
 * subagent-control 跨代残留清理（M3，设计 relay-spawn-transport §3.3 D7「启动残留
 * socket 清理 + 孤儿引擎收割」）。
 *
 * 跨代清理的语义边界（D7 刻意收窄）：
 * - socket：扫 `subagent-*.sock` 全族（不是只探当前 pid 路径）；connect 探活，死文件
 *   unlink、活文件 warn（另一活实例在听，不动它）。
 * - 引擎 pid 文件：owner runtime 活着 → 跳过（它在管）；owner 死 → **立即收割**（不采
 *   用 mirror mtime 活跃度分级——runtime 死后 mirror 不再更新，判据恒过期；D7 明确
 *   退役该分级）。pid 复用防护保留（「宁不杀勿误杀」）：进程 start time 晚于
 *   spawn 登记 = pid 已被无关进程复用，只删记录不杀；start time 取不到（Windows/
 *   ps 不可用）= 无法验证身份 → 同样保守跳过击杀并保留记录（m-rt-3）。
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
import { getControlEnginesDir, getControlRunDir } from './paths.js'

/** socket 探活窗口（控制面单请求秒级量级；超时按死文件处置）。 */
const SOCKET_PROBE_TIMEOUT_MS = 1_000

/**
 * 启动残留 socket 清理。skipPath = 本实例即将 listen 的路径（不探不删）。
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
    if (!file.startsWith('subagent-') || !file.endsWith('.sock')) continue
    const socketPath = join(runDir, file)
    if (socketPath === skipPath) continue
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
  instanceId?: unknown
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
 * 启动孤儿引擎收割：owner runtime 死亡的引擎组立即收割（组杀连带其 pi 子进程），
 * owner 活着的条目属另一活实例在管、不碰。
 *
 * 失败语义（m-rt-4）：kill 是 fire-and-forget 信号，没有同步成功回执——这里在发出
 * kill 后做一次有界存活复核，确认已死才删 pid 文件；仍存活（taskkill 失败/权限不足）
 * 则保留记录 + warn，供下次启动再扫（删文件会把杀不掉的孤儿从兜底视野永久销账）。
 */
export async function sweepOrphanEnginePids(dataDir: string, deps: OrphanSweepDeps = {}): Promise<void> {
  const rt: OrphanSweepRuntime = {
    alive: deps.isPidAlive ?? isPidAlive,
    kill: deps.killProcessTree ?? killProcessTree,
    readStartTime: deps.getProcessStartTimeSec ?? getProcessStartTimeSec,
    confirmTimeoutMs: deps.killConfirmTimeoutMs ?? KILL_CONFIRM_DEFAULT_TIMEOUT_MS,
  }
  const enginesDir = getControlEnginesDir(dataDir)
  let files: string[]
  try {
    files = readdirSync(enginesDir)
  } catch {
    return // 目录不存在 = 无残留
  }
  for (const file of files) {
    if (!file.endsWith('.pid')) continue
    await sweepOneOrphanPidFile(join(enginesDir, file), rt)
  }
}

/** 单条 pid 文件的收割裁决（主循环逐文件调用；每条记录的处理在返回前完成）。 */
async function sweepOneOrphanPidFile(pidFile: string, rt: OrphanSweepRuntime): Promise<void> {
  const record = readEnginePidRecord(pidFile)
  if (record === null) return
  // owner runtime 活着 = 另一活实例在管（本机单实例守卫正常时不应发生，双保险跳过）。
  if (ownerRuntimeAlive(pidFile, record, rt.alive)) return
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
 * owner runtime 存活判定。instanceId 一致性校验（m-rt-5）：当前写点与 runtimePid 同值，
 * 读取它至少能识别记录错配（写入方/版本漂移）；身份真正独立化（boot id + 可核对记录）
 * 是后续项。
 */
function ownerRuntimeAlive(
  pidFile: string,
  record: EnginePidFileRecord,
  alive: (pid: number) => boolean,
): boolean {
  const runtimePid = numericField(record.runtimePid)
  if (runtimePid === null || !alive(runtimePid)) return false
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

/** 组杀已核实身份的孤儿引擎 + 有界存活复核：确认已死才删档；杀链失败（权限/系统错误）
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

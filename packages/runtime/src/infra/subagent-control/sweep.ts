/**
 * subagent-control 跨代残留清理（M3，设计 relay-spawn-transport §3.3 D7「启动残留
 * socket 清理 + 孤儿引擎收割」）。
 *
 * 与 relay sweep 的语义分野（D7 刻意收窄）：
 * - socket：扫 `subagent-*.sock` 全族（不是只探当前 pid 路径）；connect 探活，死文件
 *   unlink、活文件 warn（另一活实例在听，不动它）。
 * - 引擎 pid 文件：owner runtime 活着 → 跳过（它在管）；owner 死 → **立即收割**（不再
 *   沿用 relay 的 mirror mtime 活跃度分级——runtime 死后 mirror 不再更新，判据恒过期；
 *   D7 明确退役该分级）。pid 复用防护保留（「宁不杀勿误杀」）：进程 start time 晚于
 *   spawn 登记 = pid 已被无关进程复用，只删记录不杀。
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
import { getControlEnginesDir, getControlRunDir, getControlSocketPath } from './paths.js'

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
      console.warn(`[subagent-control] stale socket ${socketPath} is held by a live runtime instance, keeping it`)
      continue
    }
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath)
      console.log(`[subagent-control] removed stale control socket ${socketPath}`)
    } catch (e) {
      console.warn(`[subagent-control] failed to remove stale socket ${socketPath}:`, e)
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

/** 引擎 pid 文件登记形状（spawn 后原子写；畸形文件按 stale 删除）。 */
type EnginePidFileRecord = {
  pid?: unknown
  spawnedAt?: unknown
  runtimePid?: unknown
}

/**
 * 启动孤儿引擎收割：owner runtime 死亡的引擎组立即收割（组杀连带其 pi 子进程），
 * owner 活着的条目属另一活实例在管、不碰。fire-and-forget：失败保留 pid 文件供下次
 * 启动再扫（删文件会把杀不掉的孤儿从兜底视野永久销账）。
 */
export async function sweepOrphanEnginePids(dataDir: string): Promise<void> {
  const enginesDir = getControlEnginesDir(dataDir)
  let files: string[]
  try {
    files = readdirSync(enginesDir)
  } catch {
    return // 目录不存在 = 无残留
  }
  for (const file of files) {
    if (!file.endsWith('.pid')) continue
    const pidFile = join(enginesDir, file)
    let record: EnginePidFileRecord
    try {
      record = JSON.parse(readFileSync(pidFile, 'utf-8')) as EnginePidFileRecord
    } catch (e) {
      console.warn(`[subagent-control] stale pid file removed (unreadable) ${pidFile}:`, e)
      removeQuietly(pidFile)
      continue
    }
    const enginePid = typeof record.pid === 'number' ? record.pid : null
    const runtimePid = typeof record.runtimePid === 'number' ? record.runtimePid : null
    const spawnedAt = typeof record.spawnedAt === 'number' ? record.spawnedAt : null
    // owner runtime 活着 = 另一活实例在管（本机单实例守卫正常时不应发生，双保险跳过）
    if (runtimePid !== null && isPidAlive(runtimePid)) continue
    if (enginePid === null || !isPidAlive(enginePid)) {
      removeQuietly(pidFile)
      continue
    }
    // pid 复用防护：现持有者启动晚于 spawn 登记 = 无关进程，只删过期记录不杀
    if (spawnedAt !== null) {
      const startSec = getProcessStartTimeSec(enginePid)
      if (startSec !== undefined && !pidStartMatchesRegistered(startSec, undefined, spawnedAt)) {
        console.warn(`[subagent-control] pid ${String(enginePid)} reused (started after registration), not killing — ${basename(pidFile)}`)
        removeQuietly(pidFile)
        continue
      }
    }
    console.warn(`[subagent-control] reaping orphan engine group pid=${String(enginePid)} (${basename(pidFile)}; owner runtime dead)`)
    killProcessTree(enginePid, (step, err) => {
      console.debug(`[subagent-control] orphan kill fallback (${step}) pid=${String(enginePid)}:`, err)
    })
    removeQuietly(pidFile)
  }
}

function removeQuietly(pidFile: string): void {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile)
  } catch (e) {
    console.warn(`[subagent-control] pid file remove failed ${pidFile}:`, e)
  }
}

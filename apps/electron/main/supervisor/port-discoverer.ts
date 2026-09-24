/**
 * 端口探测 + 本实例残留 runtime 收割。
 * Windows 仅使用 netstat/tasklist/taskkill；Unix 保留 lsof/ps/信号逻辑。
 *
 * 清杀身份门禁（只杀自己的残留，绝不按端口清杀陌生进程）：dev 端口段按 worktree 名
 * hash 派生，槽位有限必然存在跨实例碰撞——碰撞实例的活 runtime 与本实例共享端口段。
 * 唯一合法清杀目标 = 本数据目录 runtime-instance.json 登记的、仍存活且进程指纹吻合的
 * 残留 runtime（前一次 main 崩溃遗留的孤儿）。扫描中遇到的其他占用者一律跳过：
 * 无身份门禁的「按端口清杀」会误杀碰撞实例并触发其崩溃自动重启反杀，形成互杀循环
 * （runtime 被杀 = 全部活跃 subagent 连坐）。
 *
 * 清杀决策必须落 main log（mainLogger.warn）：清杀动作只打 console 时不落盘，
 * 「谁 SIGTERM 了谁」在排障时不可考。mainLogger 未 init（单测）时 no-op，行为不变。
 */
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BASE_PORT, MAX_PORT } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { mainLogger } from '../logs/main-logger.js'
import { isPortInUse } from './health-checker.js'
import { getDescendantPids, killProcessTree } from './process-control.js'
import { terminateWindowsProcessTree } from './windows-process.js'

export const PORT_RANGE_SIZE = 10
export const PORT_RETRY_MS = 300
export const KILL_WAIT_MS = 200
export const SAFE_KILL_NAMES = /(?:^|[\/\\])(?:node|node\.exe|pi|pi\.exe|pi-windows-x64\.exe|tsx|tsx\.exe|electron|electron\.exe|taiji|taiji\.exe|bash|bash\.exe|sh|sh\.exe|zsh|zsh\.exe)$/i

/** runtime 自登记文件名（single-instance-guard 写入，位于数据目录根，0600）。 */
const RUNTIME_INSTANCE_FILE = 'runtime-instance.json'
/** runtime 进程 cmdline 指纹：dev（tsx 跑源码）与打包（dist bundle）两种形态都显式注入该参数。 */
const RUNTIME_CMDLINE_MARKER = '--builtin-plugins-dir='
/** 残留 runtime SIGTERM → SIGKILL 的宽限上界（控制面秒级，对齐 STOP_TIMEOUT_MS 量级）。 */
export const RECLAIM_TERM_GRACE_MS = 2000
const RECLAIM_POLL_MS = 50
/** kill decision 日志里 cmdline 摘要截断长度。 */
const LOG_CMDLINE_MAX = 200
/** 端口占用者描述里单进程详情截断长度。 */
const OCCUPANT_DETAIL_MAX = 160

export function getPortOffset(): number {
  const raw = parseInt(process.env.TAIJI_AGENT_PORT_OFFSET ?? '0', 10) || 0
  return Math.max(0, Math.min(raw, MAX_PORT - BASE_PORT))
}

export function getPortRange(): { start: number; end: number } {
  const offset = getPortOffset()
  return { start: BASE_PORT + offset, end: BASE_PORT + offset + PORT_RANGE_SIZE }
}

const NETSTAT_MIN_COLUMNS = 5

export function parseWindowsListeningPids(output: string, port: number): number[] {
  const pids = new Set<number>()
  for (const rawLine of output.split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/)
    if (columns.length < NETSTAT_MIN_COLUMNS || columns[0].toUpperCase() !== 'TCP' || columns[3].toUpperCase() !== 'LISTENING') continue
    const localAddress = columns[1]
    const separator = localAddress.lastIndexOf(':')
    if (separator < 0 || Number(localAddress.slice(separator + 1)) !== port) continue
    const pid = Number(columns[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

function getWindowsProcessName(pid: number): string {
  try {
    const output = execFileSync(
      'tasklist.exe',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    ).trim()
    if (!output || output.startsWith('INFO:')) return ''
    const match = output.match(/^"([^"]+)"/)
    const name = match?.[1] ?? ''
    return name.replace(/\s*\*32$/i, '')
  } catch {
    return ''
  }
}

export type PlatformProvider = () => NodeJS.Platform

const getProcessPlatform: PlatformProvider = () => process.platform

export function isSafeToKill(pid: number, platform: PlatformProvider = getProcessPlatform): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  if (platform() === 'win32') return SAFE_KILL_NAMES.test(getWindowsProcessName(pid))
  try {
    const name = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`, {
      encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return Boolean(name) && SAFE_KILL_NAMES.test(name)
  } catch {
    return false
  }
}

function getWindowsListeningPids(port: number): number[] {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    return parseWindowsListeningPids(output, port)
  } catch (error) {
    console.warn(`[runtime] netstat failed while checking port ${port}:`, error instanceof Error ? error.message : String(error))
    return []
  }
}

function getUnixListeningPids(port: number): number[] {
  try {
    const output = execSync(`lsof -n -P -i :${port} 2>/dev/null | grep LISTEN | awk '{print $2}' || true`, {
      encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output.trim().split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/** 读本数据目录的 runtime 自登记。文件缺失/损坏 = 无身份锚点（首次启动/旧版实例），按无残留处理——文件非权威。 */
function readOwnInstanceRecord(dataDir: string): { pid: number; port: number; startedAt: string } | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, RUNTIME_INSTANCE_FILE), 'utf-8')) as { pid?: unknown; port?: unknown; startedAt?: unknown }
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid < 1) return null
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1) return null
    return { pid: raw.pid, port: raw.port, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '' }
  } catch {
    return null
  }
}

/** pid 存活判定：kill(pid, 0) 空信号探测（EPERM = 存在但无权限，也算活）。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 进程完整 cmdline（Unix；ps 探测失败 = 空串，按身份不符处理）。 */
function getProcessCmdline(pid: number): string {
  try {
    return execSync(`ps -p ${pid} -ww -o command= 2>/dev/null || true`, {
      encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * 身份门禁：pid 是否本实例登记的残留 runtime。四重门禁全过才可杀——
 * ① pid 来自本数据目录的 runtime-instance.json（同数据目录单实例锁保证唯一归属）；
 * ② pid 存活；③ 进程名在 SAFE_KILL_NAMES 白名单（pid 复用第一道防线）；
 * ④ Unix 上 cmdline 带 runtime 指纹且 --port 与登记值一致（pid 复用第二道防线；
 *    Windows 无 ps command= 通道缺此道，门禁强度依赖 ①③）。
 */
function isOwnStaleRuntimePid(record: { pid: number; port: number }, platform: NodeJS.Platform): boolean {
  if (record.pid === process.pid) return false
  if (!isSafeToKill(record.pid)) return false
  if (platform === 'win32') return true
  const cmdline = getProcessCmdline(record.pid)
  return cmdline.includes(RUNTIME_CMDLINE_MARKER) && cmdline.includes(`--port=${record.port}`)
}

/**
 * 收割本实例残留 runtime（前一次 main 崩溃遗留的孤儿）：SIGTERM → 宽限 → SIGKILL 进程树。
 * 后代 pid 必须在 SIGTERM 前预记录——runtime 退出后 pi 的 PPID 变 1，事后查不到
 * （对齐 stopRuntimeProcess 时序）。
 * @returns 是否实际收割了进程
 */
export async function reclaimOwnStaleRuntime(termGraceMs: number = RECLAIM_TERM_GRACE_MS): Promise<boolean> {
  const record = readOwnInstanceRecord(getDataDir())
  if (!record || !isPidAlive(record.pid)) return false
  const platform = process.platform
  if (!isOwnStaleRuntimePid(record, platform)) {
    mainLogger.warn('[port-cleanup] instance record pid alive but identity gate failed, not killing', {
      action: 'reclaim_identity_gate_failed',
      target: { pid: record.pid, port: record.port },
      reason: 'process name/cmdline does not match this instance runtime fingerprint (possible pid reuse); foreign process left untouched',
    })
    return false
  }
  const descendants = platform === 'win32' ? [] : getDescendantPids(record.pid)
  mainLogger.warn('[port-cleanup] kill decision', {
    action: 'kill_stale_own_runtime',
    target: { pid: record.pid, port: record.port, descendantCount: descendants.length },
    identity: { source: RUNTIME_INSTANCE_FILE, startedAt: record.startedAt, cmdline: getProcessCmdline(record.pid).slice(0, LOG_CMDLINE_MAX) },
    reason: 'runtime-instance.json of this data dir names a live runtime orphaned by a previous main crash; reclaiming before port scan',
  })
  if (platform === 'win32') {
    terminateWindowsProcessTree(record.pid)
    return true
  }
  try { process.kill(record.pid, 'SIGTERM') } catch { return true }
  const deadline = Date.now() + termGraceMs
  while (Date.now() < deadline && isPidAlive(record.pid)) {
    await sleep(Math.min(RECLAIM_POLL_MS, termGraceMs))
  }
  if (isPidAlive(record.pid)) {
    killProcessTree(record.pid, descendants)
    return true
  }
  // root 已退出：SIGTERM 预记录后代（runtime 死后其 pi 子树失去管理者；多数情况
  // runtime 优雅退出已自行收割，此处 best-effort 补刀，残活由启动期 orphan sweep 兜底）
  for (const pid of descendants) {
    // eslint-disable-next-line taste/no-silent-catch -- descendant may have exited with runtime
    try { process.kill(pid, 'SIGTERM') } catch { /* 已随 runtime 退出 */ }
  }
  return true
}

/** 端口占用者描述（排障用：pid + 进程名/cmdline 摘要，查询失败降级为占位符）。 */
function describePortOccupant(port: number, platform: NodeJS.Platform): string {
  const pids = platform === 'win32' ? getWindowsListeningPids(port) : getUnixListeningPids(port)
  if (pids.length === 0) return `port ${port}: <listener query failed>`
  return pids.map((pid) => {
    const detail = platform === 'win32' ? getWindowsProcessName(pid) : getProcessCmdline(pid)
    return `port ${port} pid ${pid} (${detail.slice(0, OCCUPANT_DETAIL_MAX) || '<query failed>'})`
  }).join('; ')
}

/**
 * 在端口段内找可用端口。
 *
 * 清杀语义：扫描前先按身份门禁收割本实例残留 runtime；扫描中遇到的占用者一律跳过
 * 不清杀——它们要么是端口段碰撞的其他实例活 runtime，要么是无关进程。全段占用时
 * 抛错并列出占用者与恢复动作（错误信息必须可操作）。
 * @param retryMs 收割后的端口释放等待（ms）。仅测试注入小值压缩串行等待，缺省行为不变。
 */
export async function findAvailablePort(retryMs: number = PORT_RETRY_MS): Promise<number> {
  const { start, end } = getPortRange()
  const platform = process.platform
  if (await reclaimOwnStaleRuntime()) await sleep(retryMs)
  const occupants: string[] = []
  for (let port = start; port <= end; port++) {
    if (!await isPortInUse(port)) return port
    const detail = describePortOccupant(port, platform)
    mainLogger.warn(`[port-cleanup] port ${port} occupied by non-owned process, skipping (identity gate): ${detail}`)
    occupants.push(detail)
  }
  throw new Error([
    `No available port in range ${start}-${end}: all occupied by processes that are not this instance's stale runtime (identity-gated cleanup left them untouched).`,
    ...occupants.map(line => `  - ${line}`),
    `  Fix: stop the occupying instance/process, or set TAIJI_AGENT_PORT_OFFSET to move this instance's port segment.`,
  ].join('\n'))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

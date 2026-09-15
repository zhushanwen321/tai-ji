/**
 * 端口探测 + stale 进程清理。
 * Windows 仅使用 netstat/tasklist/taskkill；Unix 保留 lsof/ps/信号逻辑。
 */
import { execFileSync, execSync } from 'node:child_process'
import { BASE_PORT, MAX_PORT } from '@taiji/shared'
import { isPortInUse } from './health-checker.js'
import { terminateWindowsProcessTree } from './windows-process.js'

export const PORT_RANGE_SIZE = 10
export const PORT_RETRY_MS = 300
export const KILL_WAIT_MS = 200
export const SAFE_KILL_NAMES = /(?:^|[\/\\])(?:node|node\.exe|pi|pi\.exe|pi-windows-x64\.exe|tsx|tsx\.exe|electron|electron\.exe|taiji|taiji\.exe|bash|bash\.exe|sh|sh\.exe|zsh|zsh\.exe)$/i

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

function isWindowsPidListeningOnPort(pid: number, port: number): boolean {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    return parseWindowsListeningPids(output, port).includes(pid)
  } catch {
    return false
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

export function killStaleProcessOnPort(port: number, platform: PlatformProvider = getProcessPlatform): void {
  const currentPlatform = platform()
  const pids = currentPlatform === 'win32' ? getWindowsListeningPids(port) : getUnixListeningPids(port)
  for (const pid of pids) {
    if (!isSafeToKill(pid, () => currentPlatform)) {
      console.warn(`[runtime] Port ${port} occupied by PID ${pid} but process name not in allowlist, skipping kill`)
      continue
    }
    console.log(`[runtime] Killing stale process ${pid} on port ${port}`)
    if (currentPlatform === 'win32') {
      if (!isWindowsPidListeningOnPort(pid, port)) {
        console.warn(`[runtime] Port ${port} PID ${pid} changed before kill, skipping`)
        continue
      }
      terminateWindowsProcessTree(pid)
      continue
    }
    // eslint-disable-next-line taste/no-silent-catch -- process may have exited after discovery
    try { process.kill(pid, 'SIGTERM') } catch { /* process may have exited */ }
    setTimeout(() => {
      // eslint-disable-next-line taste/no-silent-catch -- process may have exited after SIGTERM
      try { process.kill(pid, 'SIGKILL') } catch { /* process may have exited */ }
    }, KILL_WAIT_MS)
  }
}

/**
 * 在端口段内找可用端口；占用时清 stale 进程后按 retryMs 间隔复查。
 * @param retryMs 清理/候选间的复查等待（ms）。生产默认 PORT_RETRY_MS（300ms，等 stale 进程
 *   释放端口）；仅测试注入小值压缩串行等待，缺省行为不变。
 */
export async function findAvailablePort(retryMs: number = PORT_RETRY_MS): Promise<number> {
  const { start, end } = getPortRange()
  let cleanedAny = false
  for (let port = start; port <= end; port++) {
    if (!await isPortInUse(port)) {
      if (cleanedAny) await sleep(retryMs)
      return port
    }
    console.warn(`[runtime] Port ${port} in use, cleaning up stale process`)
    killStaleProcessOnPort(port)
    cleanedAny = true
    await sleep(retryMs)
    if (!await isPortInUse(port)) return port
  }
  throw new Error(`No available port in range ${start}-${end}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

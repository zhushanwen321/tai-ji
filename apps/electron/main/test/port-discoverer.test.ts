import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))
const healthMocks = vi.hoisted(() => ({ isPortInUse: vi.fn() }))
const windowsMocks = vi.hoisted(() => ({ terminateWindowsProcessTree: vi.fn() }))
const processControlMocks = vi.hoisted(() => ({
  getDescendantPids: vi.fn((): number[] => []),
  killProcessTree: vi.fn(),
}))
const pathsMocks = vi.hoisted(() => ({ getDataDir: vi.fn((): string => '') }))

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('../supervisor/health-checker.js', () => healthMocks)
vi.mock('../supervisor/windows-process.js', () => windowsMocks)
vi.mock('../supervisor/process-control.js', () => processControlMocks)
vi.mock('@taiji/shared/paths', () => pathsMocks)

import { BASE_PORT } from '@taiji/shared'
import {
  findAvailablePort,
  isSafeToKill,
  parseWindowsListeningPids,
  reclaimOwnStaleRuntime,
} from '../supervisor/port-discoverer.js'

const WINDOWS_PLATFORM = () => 'win32' as const

describe('Windows port discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses only TCP LISTENING rows for the exact port and deduplicates PIDs', () => {
    const output = [
      '  TCP    0.0.0.0:3310       0.0.0.0:0       LISTENING       101',
      '  TCP    [::]:3310          0.0.0.0:0       LISTENING       101',
      '  TCP    127.0.0.1:13310    0.0.0.0:0       LISTENING       202',
      '  TCP    127.0.0.1:3310     127.0.0.1:50000 ESTABLISHED     303',
      '  UDP    0.0.0.0:3310       *:*                            404',
    ].join('\r\n')
    expect(parseWindowsListeningPids(output, 3310)).toEqual([101])
  })

  it('returns no PIDs for empty or unrelated output', () => {
    expect(parseWindowsListeningPids('', 3310)).toEqual([])
    expect(parseWindowsListeningPids('TCP 0.0.0.0:3311 0.0.0.0:0 LISTENING 7', 3310)).toEqual([])
  })

  it('refuses invalid and current PIDs before querying process names', () => {
    expect(isSafeToKill(0)).toBe(false)
    expect(isSafeToKill(process.pid)).toBe(false)
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled()
  })

  it('allowlists Windows process names via tasklist', () => {
    childProcessMocks.execFileSync.mockReturnValue('"node.exe","101","Console","1","20,000 K"')
    expect(isSafeToKill(101, WINDOWS_PLATFORM)).toBe(true)
    childProcessMocks.execFileSync.mockReturnValue('"postgres.exe","101","Services","0","20,000 K"')
    expect(isSafeToKill(101, WINDOWS_PLATFORM)).toBe(false)
  })
})

const tmpDirs: string[] = []

describe('reclaimOwnStaleRuntime（身份门禁：只杀本数据目录登记的残留 runtime）', () => {
  const OWN_PID = 4242
  const INSTANCE_FILE = 'runtime-instance.json'
  let dataDir: string
  let deadPids: Set<number>
  let killCalls: Array<{ pid: number; signal?: string | number }>
  let killSpy: ReturnType<typeof vi.spyOn>

  // ps 输出按命令区分：isSafeToKill 用 `-o comm=`，getProcessCmdline 用 `-ww -o command=`
  //（'comm=' 不是 'command=' 的子串——后者 comm 后跟 'a'，可安全按子串分流）。
  const mockPs = (comm: string, command: string): void => {
    childProcessMocks.execSync.mockImplementation((cmd: string) => {
      if (cmd.includes('-o comm=')) return comm
      if (cmd.includes('-o command=')) return command
      if (cmd.includes('lsof')) return ''
      return ''
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    dataDir = mkdtempSync(join(tmpdir(), 'port-reclaim-'))
    tmpDirs.push(dataDir)
    pathsMocks.getDataDir.mockReturnValue(dataDir)
    deadPids = new Set<number>()
    killCalls = []
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal })
      if ((signal ?? 0) === 0) {
        if (deadPids.has(pid)) {
          const err = new Error('esrch') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        }
        return true
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') deadPids.add(pid)
      return true
    }) as never)
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  const writeInstanceFile = (pid: number, port: number): void => {
    writeFileSync(join(dataDir, INSTANCE_FILE), JSON.stringify({ pid, port, startedAt: '2026-09-24T00:00:00.000Z' }))
  }

  it('无登记文件（首次启动/旧版实例）→ 不杀任何进程', async () => {
    mockPs('node', 'node whatever')
    await expect(reclaimOwnStaleRuntime(1)).resolves.toBe(false)
    expect(killCalls.filter((c) => c.signal && c.signal !== 0)).toEqual([])
    expect(processControlMocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('登记 pid 已死 → 不杀任何进程', async () => {
    writeInstanceFile(OWN_PID, 3310)
    deadPids.add(OWN_PID)
    await expect(reclaimOwnStaleRuntime(1)).resolves.toBe(false)
    expect(killCalls.filter((c) => c.signal && c.signal !== 0)).toEqual([])
  })

  it('存活但 cmdline 无 runtime 指纹（pid 复用/异主进程）→ 身份门禁拒绝，不杀', async () => {
    writeInstanceFile(OWN_PID, 3310)
    mockPs('node', 'node /some/other/server.mjs --port=3310')
    await expect(reclaimOwnStaleRuntime(1)).resolves.toBe(false)
    expect(killCalls.filter((c) => c.signal && c.signal !== 0)).toEqual([])
    expect(processControlMocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('登记 pid 命中残留 runtime → SIGTERM 前预录后代，root+后代全部 SIGTERM', async () => {
    writeInstanceFile(OWN_PID, 3310)
    mockPs('node', `node tsx index.ts --port=3310 --builtin-plugins-dir=/x`)
    processControlMocks.getDescendantPids.mockReturnValue([11, 22])
    await expect(reclaimOwnStaleRuntime(1)).resolves.toBe(true)
    const signals = killCalls.filter((c) => c.signal && c.signal !== 0)
    // 预录后代先于（或同批）SIGTERM root；后代与 root 都收到 SIGTERM
    expect(signals.map((c) => c.pid).sort((a, b) => a - b)).toEqual([11, 22, OWN_PID])
    expect(processControlMocks.getDescendantPids).toHaveBeenCalledWith(OWN_PID)
    expect(processControlMocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('SIGTERM 宽限内不退出 → SIGKILL 进程树兜底', async () => {
    writeInstanceFile(OWN_PID, 3310)
    mockPs('node', `node tsx index.ts --port=3310 --builtin-plugins-dir=/x`)
    processControlMocks.getDescendantPids.mockReturnValue([11])
    // SIGTERM 不标记死亡（顽固进程）
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal })
      if ((signal ?? 0) === 0) return true
      return true
    }) as never)
    await expect(reclaimOwnStaleRuntime(1)).resolves.toBe(true)
    expect(processControlMocks.killProcessTree).toHaveBeenCalledWith(OWN_PID, [11])
  })

  it('Windows：tasklist 白名单命中 → taskkill 树杀，不读 cmdline', async () => {
    writeInstanceFile(OWN_PID, 3310)
    childProcessMocks.execFileSync.mockReturnValue('"node.exe","4242","Console","1","20,000 K"')
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await expect(reclaimOwnStaleRuntime(1)).resolves.toBe(true)
      expect(windowsMocks.terminateWindowsProcessTree).toHaveBeenCalledWith(OWN_PID)
      expect(killCalls.filter((c) => c.signal === 'SIGTERM')).toEqual([])
    } finally {
      platformSpy.mockRestore()
    }
  })
})

describe('findAvailablePort（先收割自身残留，占用者一律跳过）', () => {
  let dataDir: string
  let deadPids: Set<number>

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TAIJI_AGENT_PORT_OFFSET
    dataDir = mkdtempSync(join(tmpdir(), 'port-find-'))
    tmpDirs.push(dataDir)
    pathsMocks.getDataDir.mockReturnValue(dataDir)
    deadPids = new Set<number>()
    // isPidAlive 走真实 process.kill 会探到宿主进程空间的无关 pid——钉死为本测试可控语义
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if ((signal ?? 0) === 0) {
        if (deadPids.has(pid)) {
          const err = new Error('esrch') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        }
        return true
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') deadPids.add(pid)
      return true
    }) as never)
    childProcessMocks.execSync.mockImplementation((cmd: string) => {
      if (cmd.includes('lsof')) return ''
      return ''
    })
  })

  afterAll(() => {
    vi.restoreAllMocks()
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('returns the first port when it is unoccupied', async () => {
    healthMocks.isPortInUse.mockResolvedValue(false)
    await expect(findAvailablePort()).resolves.toBe(BASE_PORT)
  })

  it('身份不符的占用端口被跳过（不清杀），落到段内下一个空闲端口', async () => {
    healthMocks.isPortInUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(findAvailablePort(1)).resolves.toBe(BASE_PORT + 1)
    expect(processControlMocks.killProcessTree).not.toHaveBeenCalled()
    expect(processControlMocks.getDescendantPids).not.toHaveBeenCalled()
  })

  it('收割本实例残留后端口释放 → 返回该端口', async () => {
    writeFileSync(join(dataDir, 'runtime-instance.json'), JSON.stringify({ pid: 4242, port: BASE_PORT, startedAt: 'x' }))
    childProcessMocks.execSync.mockImplementation((cmd: string) => {
      if (cmd.includes('-o comm=')) return 'node'
      if (cmd.includes('-o command=')) return `node tsx index.ts --port=${BASE_PORT} --builtin-plugins-dir=/x`
      return ''
    })
    healthMocks.isPortInUse.mockResolvedValue(false)
    await expect(findAvailablePort(1)).resolves.toBe(BASE_PORT)
  })

  it('fails after every candidate remains occupied，错误信息含占用者与恢复动作', async () => {
    childProcessMocks.execSync.mockImplementation((cmd: string) => {
      if (cmd.includes('lsof')) return '  777\n'
      if (cmd.includes('-o command=')) return 'node /other/instance/server.js --port=3311'
      return 'node'
    })
    healthMocks.isPortInUse.mockResolvedValue(true)
    // retryMs 注入 1ms：无收割路径不再产生串行等待，保留参数兼容
    let caught: Error | undefined
    try {
      await findAvailablePort(1)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toContain(`No available port in range ${BASE_PORT}-${BASE_PORT + 10}`)
    expect(caught?.message).toContain('pid 777')
    expect(caught?.message).toContain('TAIJI_AGENT_PORT_OFFSET')
  })
})

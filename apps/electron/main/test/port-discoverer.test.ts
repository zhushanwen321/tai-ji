import { beforeEach, describe, expect, it, vi } from 'vitest'

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))
const healthMocks = vi.hoisted(() => ({ isPortInUse: vi.fn() }))
const windowsMocks = vi.hoisted(() => ({ terminateWindowsProcessTree: vi.fn() }))

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('../supervisor/health-checker.js', () => healthMocks)
vi.mock('../supervisor/windows-process.js', () => windowsMocks)

import { BASE_PORT } from '@taiji/shared'
import {
  findAvailablePort,
  isSafeToKill,
  killStaleProcessOnPort,
  parseWindowsListeningPids,
} from '../supervisor/port-discoverer.js'

const WINDOWS_PLATFORM = () => 'win32' as const
const WINDOWS_NETSTAT_ROW = 'TCP 0.0.0.0:3310 0.0.0.0:0 LISTENING 101'

describe('Windows port discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses only TCP LISTENING rows for the exact port and deduplicates PIDs', () => {
    const output = [
      '  TCP    0.0.0.0:3310       0.0.0.0:0       LISTENING       101',
      '  TCP    [::]:3310          [::]:0          LISTENING       101',
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

  it('uses tasklist allowlist and terminates after confirming the PID still owns the port', () => {
    childProcessMocks.execFileSync
      .mockReturnValueOnce(WINDOWS_NETSTAT_ROW)
      .mockReturnValueOnce('"node.exe","101","Console","1","20,000 K"')
      .mockReturnValueOnce(WINDOWS_NETSTAT_ROW)

    killStaleProcessOnPort(3310, WINDOWS_PLATFORM)

    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      'tasklist.exe',
      ['/FI', 'PID eq 101', '/FO', 'CSV', '/NH'],
      expect.objectContaining({ windowsHide: true }),
    )
    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      3,
      'netstat.exe',
      ['-ano', '-p', 'tcp'],
      expect.objectContaining({ windowsHide: true }),
    )
    expect(windowsMocks.terminateWindowsProcessTree).toHaveBeenCalledOnce()
    expect(windowsMocks.terminateWindowsProcessTree).toHaveBeenCalledWith(101)
  })

  it('does not terminate a process outside the tasklist allowlist', () => {
    childProcessMocks.execFileSync
      .mockReturnValueOnce(WINDOWS_NETSTAT_ROW)
      .mockReturnValueOnce('"postgres.exe","101","Services","0","20,000 K"')

    killStaleProcessOnPort(3310, WINDOWS_PLATFORM)

    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2)
    expect(windowsMocks.terminateWindowsProcessTree).not.toHaveBeenCalled()
  })

  it('does not terminate when the PID no longer owns the port before kill', () => {
    childProcessMocks.execFileSync
      .mockReturnValueOnce(WINDOWS_NETSTAT_ROW)
      .mockReturnValueOnce('"node.exe","101","Console","1","20,000 K"')
      .mockReturnValueOnce('TCP 0.0.0.0:3310 0.0.0.0:0 LISTENING 202')

    killStaleProcessOnPort(3310, WINDOWS_PLATFORM)

    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(3)
    expect(windowsMocks.terminateWindowsProcessTree).not.toHaveBeenCalled()
  })

  it('does not throw when Windows process queries fail', () => {
    childProcessMocks.execFileSync.mockImplementation(() => { throw new Error('query failed') })
    expect(() => killStaleProcessOnPort(3310, WINDOWS_PLATFORM)).not.toThrow()
    expect(windowsMocks.terminateWindowsProcessTree).not.toHaveBeenCalled()
  })
})

describe('findAvailablePort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TAIJI_AGENT_PORT_OFFSET
  })

  it('returns the first port when it is unoccupied', async () => {
    healthMocks.isPortInUse.mockResolvedValue(false)
    await expect(findAvailablePort()).resolves.toBe(BASE_PORT)
  })

  it('fails after every candidate remains occupied', async () => {
    healthMocks.isPortInUse.mockResolvedValue(true)
    // retryMs 注入 1ms：11 候选全占用时串行复查等待 11×300ms（生产默认）→ 测试压缩，无超时兜底必要
    await expect(findAvailablePort(1)).rejects.toThrow(`No available port in range ${BASE_PORT}-${BASE_PORT + 10}`)
  })
})

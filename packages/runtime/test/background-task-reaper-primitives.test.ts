/**
 * 后台任务收殓器 registry/fs 错误分支测试（test/background-task-reaper.test.ts 的补充面，
 * 覆盖其依赖注入 mock 所绕过的真实实现路径）。
 *
 * 覆盖（编排层断言，经真实入口 reapSessionBackgroundTasks / reapAllSessionsBackgroundTasks
 * 触发）：registry 读失败按空表继续 / corrupt 隔离 rename 失败原文件保留原位 / 终态写
 * tmp 落盘失败条目停留 running / rename 失败且 tmp 清理双诊断 / ②补杀分支终态写失败 /
 * 触发面 A 目录级异常 / 触发面 B baseDir 读失败（非 ENOENT warn）/ 单目录扫描异常跳过 /
 * stale reaper.lock 残留非空（ENOTEMPTY）。
 *
 * pid 探测/处置原语（isPidAlive / killProcessTree / getProcessStartTimeSec /
 * pidStartMatchesRegistered）自 ext-simplify-13 起下沉 protocol 子出口
 * `background-task`（本仓单一实现），其直接实现面测试由 protocol 包
 * background-task-process.test.ts 同构覆盖，此处不再保留副本；registry 文件原语
 * （readRegistry / atomicWriteRegistry）下沉 protocol background-task-registry-file.ts
 * 后，本文件的错误注入断言经 vi.mock('node:fs') 对 protocol 模块同样生效（模块级 mock），
 * 编排层降级语义（计数守恒 / 条目停留原状 / warn 落日志）在此锁定。
 *
 * Mock 边界（对齐 test/scan-pi-sessions-cache.test.ts 惯例——ESM 下 vi.spyOn(node:fs)
 * 不可用，node:fs 用 importOriginal 部分 mock，默认全数委托真实实现，用例内按路径
 * 条件注入失败）。
 *
 * 运行：cd packages/runtime && npx vitest run test/background-task-reaper-primitives.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'
import {
  reapSessionBackgroundTasks,
  reapAllSessionsBackgroundTasks,
  type BackgroundTaskReapDeps,
  type BackgroundTaskReapResult,
} from '../src/services/session/background-task-reaper.js'

// ── node:fs 部分 mock：错误分支注入接缝（默认委托真实实现）──
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  actual: null as unknown as typeof import('node:fs'),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMock.actual = actual
  // 工厂内即设默认委托：被测模块图（含 load 期）任何 fs 调用都先拿到真实行为
  fsMock.existsSync.mockImplementation(actual.existsSync)
  fsMock.readFileSync.mockImplementation(actual.readFileSync)
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync)
  fsMock.renameSync.mockImplementation(actual.renameSync)
  fsMock.unlinkSync.mockImplementation(actual.unlinkSync)
  fsMock.readdirSync.mockImplementation(actual.readdirSync)
  return {
    ...actual,
    existsSync: fsMock.existsSync,
    readFileSync: fsMock.readFileSync,
    writeFileSync: fsMock.writeFileSync,
    renameSync: fsMock.renameSync,
    unlinkSync: fsMock.unlinkSync,
    readdirSync: fsMock.readdirSync,
  }
})

/** 本次测试创建的 tmp 目录（afterEach 统一清理）。 */
const tmpAgentDirs: string[] = []

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-task-reaper-primitives-'))
  tmpAgentDirs.push(dir)
  return dir
}

/** fs mock 复位为全数委托真实实现（用例内覆写后的双保险复位）。 */
function delegateFsToReal(): void {
  const a = fsMock.actual
  fsMock.existsSync.mockImplementation(a.existsSync)
  fsMock.readFileSync.mockImplementation(a.readFileSync)
  fsMock.writeFileSync.mockImplementation(a.writeFileSync)
  fsMock.renameSync.mockImplementation(a.renameSync)
  fsMock.unlinkSync.mockImplementation(a.unlinkSync)
  fsMock.readdirSync.mockImplementation(a.readdirSync)
}

beforeEach(() => {
  // mockClear 只清 calls/results 不清 implementation：默认委托不受影响
  vi.clearAllMocks()
  delegateFsToReal()
})

afterEach(() => {
  delegateFsToReal()
  for (const dir of tmpAgentDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function errnoLike(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

// ── fixture helper（与 test/background-task-reaper.test.ts 同形，此处独立维护最小面）──

interface DepsFixture {
  alivePids: Set<number>
  startTimes: Map<number, number>
  killCalls: number[]
  deps: BackgroundTaskReapDeps
}

function makeDeps(): DepsFixture {
  const alivePids = new Set<number>()
  const startTimes = new Map<number, number>()
  const killCalls: number[] = []
  return {
    alivePids,
    startTimes,
    killCalls,
    deps: {
      isPidAlive: (pid) => alivePids.has(pid),
      killProcessTree: (pid) => { killCalls.push(pid) },
      getProcessStartTimeSec: (pid) => startTimes.get(pid),
    },
  }
}

function makeEntry(overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: 'bt-1',
    pid: 1111,
    command: 'sleep 300',
    outputFile: '/tmp/bt-out.log',
    startedAt: 1_700_000_000_000,
    state: 'running',
    ownerPiPid: 2222,
    sessionId: 's1',
    ...overrides,
  }
}

function registryPathOf(agentDir: string, sessionId: string): string {
  return join(agentDir, 'base-tool-enhance', sessionId, 'registry.json')
}

function writeRegistryFile(agentDir: string, sessionId: string, entries: unknown[], version = 1): string {
  const p = registryPathOf(agentDir, sessionId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify({ version, entries }, null, 2)}\n`)
  return p
}

function zeroResult(): BackgroundTaskReapResult {
  return { scannedDirs: 0, ownerAliveSkipped: 0, killedOrphans: 0, finalizedOrphans: 0, conservativelySkipped: 0, staleLocksRemoved: 0 }
}

// ── registry / fs 错误分支（真实入口 + 条件失败注入）─────────────────────────

describe('registry 读写错误分支（收殓不因 fs 问题崩溃）', () => {
  it('registry 读失败（EACCES）→ 按空表继续 + warn，结果全零', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      const p = writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.readFileSync.mockImplementation((path: unknown, enc?: unknown) => {
        if (path === p) throw errnoLike('EACCES', 'permission denied')
        return fsMock.actual.readFileSync(path as string, enc as 'utf8')
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
      // protocol readRegistry 经 onLog 注入 console 适配：事件文案 + detail 对象（path/err）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry read failed, treating as empty'),
        expect.objectContaining({ path: p, err: expect.anything() }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('corrupt 隔离 rename 失败（目录只读等）→ 原文件保留原位 + warn，仍按空表继续', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      const p = writeRegistryFile(agentDir, 's1', [makeEntry()])
      writeFileSync(p, '{not valid json', 'utf8')
      fsMock.renameSync.mockImplementation((from: unknown, to: unknown) => {
        if (from === p) throw errnoLike('EACCES', 'read-only file system')
        return fsMock.actual.renameSync(from as string, to as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
      // 隔离失败：现场保留原位（不覆盖、不丢失）
      expect(fsMock.actual.existsSync(p)).toBe(true)
      expect(fsMock.actual.readFileSync(p, 'utf8')).toBe('{not valid json')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry corrupted and quarantine rename failed, continuing with empty table in place'),
        expect.objectContaining({ path: p, err: expect.anything() }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('终态写 tmp 落盘失败 → 条目停留 running + conservativelySkipped（下个收殓事件重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()]) // 属主死 + 任务死 → ③ 收尾写失败
      fsMock.writeFileSync.mockImplementation((path: unknown, data: unknown) => {
        if (String(path).includes('.tmp_')) throw errnoLike('EACCES', 'disk full')
        return fsMock.actual.writeFileSync(path as string, data as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry orphaned-terminal write failed; entry stays as-is'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('终态写 rename 失败且 tmp 清理也失败 → 双诊断均落日志、写失败仍正确上报', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.renameSync.mockImplementation((from: unknown, to: unknown) => {
        if (String(from).includes('.tmp_')) throw errnoLike('EACCES', 'read-only file system')
        return fsMock.actual.renameSync(from as string, to as string)
      })
      fsMock.unlinkSync.mockImplementation((path: unknown) => {
        if (String(path).includes('.tmp_')) throw errnoLike('EPERM', 'unlink denied')
        return fsMock.actual.unlinkSync(path as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result.conservativelySkipped).toBe(1)
      // tmp 清理失败不掩盖原错误：两条 warn 都在（tmp cleanup + orphaned-terminal write failed）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry tmp cleanup failed'),
        expect.objectContaining({ tmpPath: expect.stringContaining('.tmp_'), err: expect.anything() }),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registry orphaned-terminal write failed; entry stays as-is'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('②补杀分支终态写失败 → kill 已发令但计数 conservativelySkipped（killedOrphans 守恒）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const fixture = makeDeps()
      fixture.alivePids.add(1111)
      fixture.startTimes.set(1111, 123_456)
      writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })])
      fsMock.writeFileSync.mockImplementation((path: unknown, data: unknown) => {
        if (String(path).includes('.tmp_')) throw errnoLike('EACCES', 'disk full')
        return fsMock.actual.writeFileSync(path as string, data as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', fixture.deps)

      expect(fixture.killCalls).toEqual([1111]) // kill 已发令
      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── 触发面 A/B 目录级错误跳过 ─────────────────────────

describe('目录级错误跳过（warn 后不中断、不外抛）', () => {
  it('触发面 A：registry 探测本身抛错（existsSync 异常）→ 目录级 catch 兜底，结果正常返回', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.existsSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith('registry.json')) throw errnoLike('EACCES', 'stat denied')
        return fsMock.actual.existsSync(path as string)
      })

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session dir reap failed, skipping dir: s1'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('触发面 B：baseDir 读失败（非 ENOENT，如 EACCES）→ warn 放弃本轮、全零结果', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      fsMock.readdirSync.mockImplementation(() => {
        throw errnoLike('EACCES', 'permission denied')
      })

      const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

      expect(result).toEqual(zeroResult())
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('base dir unreadable, skipping this scan'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('触发面 B：单目录扫描异常 → warn 跳过该目录，不中断其余目录扫描', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      writeRegistryFile(agentDir, 's1', [makeEntry()])
      writeRegistryFile(agentDir, 's2', [makeEntry()])
      fsMock.existsSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith('registry.json')) throw errnoLike('EACCES', 'stat denied')
        return fsMock.actual.existsSync(path as string)
      })

      const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

      // 两个目录都已计入扫描且都被跳过（错误容忍：不中断整体）
      expect(result).toEqual({ ...zeroResult(), scannedDirs: 2 })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session dir scan failed, skipping dir: s1'), expect.any(String))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session dir scan failed, skipping dir: s2'), expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('stale reaper.lock 残留目录非空（ENOTEMPTY）→ warn 留给下次启动，staleLocksRemoved 不计', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const { deps } = makeDeps()
      const lockDir = join(agentDir, 'base-tool-enhance', 'reaper.lock')
      mkdirSync(lockDir, { recursive: true })
      writeFileSync(join(lockDir, 'leftover'), 'x', 'utf8')
      const stale = new Date(Date.now() - 60_000)
      utimesSync(lockDir, stale, stale)

      const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

      expect(result.staleLocksRemoved).toBe(0)
      expect(fsMock.actual.existsSync(lockDir)).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('stale reaper.lock removal failed, leaving it for next startup'),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

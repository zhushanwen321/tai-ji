/**
 * RpcClient 崩溃关联取证接线测试（crash-forensics-and-watchdog §3.3 D10）。
 *
 * 锁定（writeCrashLogIfNeeded → appendCrashCorrelationEvidence）：
 * - 异常退出（code=143，SIGTERM 形态）：既有 crash log 照写 + 机器面 pi 快照 section
 *   紧随补写（append 语义第二次调用）+ 统一日志关联采样被触发并在完成后补写第三段。
 * - 主动 kill（_killing=true）：不触发任何关联取证（与 crash log 同门）。
 * - 快照采集抛错：不向上抛（best-effort），既有 crash log 不受影响。
 *
 * 策略：沿用 rpc-client-observability.test.ts 的 mock 骨架（node:child_process +
 * logger 模块）；crash-correlation 模块整体 mock（spy 记录调用、返回 fixture section），
 * 采样门置 true 验证接线本身——门与采集器的自身行为在 crash-correlation.test.ts 锁定。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-crash-correlation.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcClient } from '../rpc-client.js'
const clientOpts = { startupDelayMs: 0 } as const

// ── Mocks ────────────────────────────────────────────────────────

interface CrashLogCall {
  sessionId: string | undefined
  content: string
}
const crashLogCalls = vi.hoisted((): CrashLogCall[] => [])

const captureSpy = vi.hoisted(() => vi.fn())
const collectSpy = vi.hoisted(() => vi.fn())

type DataHandler = (data: Buffer) => void

function makeFakeStream() {
  const dataHandlers: DataHandler[] = []
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandlers.push(handler as DataHandler)
    }),
    resume: vi.fn(),
    destroy: vi.fn(),
    reset(): void {
      dataHandlers.length = 0
    },
    emitData(text: string): void {
      for (const h of [...dataHandlers]) h(Buffer.from(text, 'utf8'))
    },
  }
}

const stdoutStream = makeFakeStream()
const stderrStream = makeFakeStream()
let procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: stdoutStream,
  stderr: stderrStream,
  stdin: { write: vi.fn(() => true), on: vi.fn(), once: vi.fn() },
  kill: vi.fn((_signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => {
      if (procExitHandlers.length === 0) return
      const handlers = procExitHandlers
      procExitHandlers = []
      handlers.forEach((h) => h(0))
    })
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
}))

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../../logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  // 采样门置 true：验证接线本身（门与采集器行为在 crash-correlation.test.ts 锁定）
  isPiCrashLogEnabled: () => true,
  writePiCrashLog: (sessionId: string | undefined, content: string) => {
    crashLogCalls.push({ sessionId, content })
  },
}))

vi.mock('../../crash-correlation.js', () => ({
  // 委托给 spy：per-test 的 mockImplementation/mockReturnValue 才能生效；
  // 快照/关联 fixture 以形态等价替身验证接线（真实现渲染在 crash-correlation.test.ts 锁定）
  captureMachinePiSnapshotSection: (...args: readonly unknown[]) => captureSpy(...args),
  collectUnifiedLogCorrelation: (...args: readonly unknown[]) => collectSpy(...args),
}))

// ── Helpers ──────────────────────────────────────────────────────

function emitProcExit(code: number | null = null): void {
  for (const h of [...procExitHandlers]) h(code)
}

/** 微任务 + 宏任务各让一拍：collect 的 Promise.then 链补写落地 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function startClient(options: Record<string, unknown> = {}): Promise<RpcClient> {
  const { RpcClient } = await import('../rpc-client.js')
  const client = new RpcClient({ ...clientOpts, cwd: '/project', sessionId: 'sid-cc-1', ...options })
  await client.start()
  return client
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient 崩溃关联取证接线（D10）', () => {
  beforeEach(() => {
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    stdoutStream.reset()
    stderrStream.reset()
    crashLogCalls.length = 0
    captureSpy.mockClear()
    collectSpy.mockClear()
    captureSpy.mockImplementation(() => '[machine-pi-snapshot] capturedAt=FIXTURE selfPid=12345 aliveCount=2')
    collectSpy.mockImplementation(() => Promise.resolve('[unified-log-correlation] matched=1 truncated=false'))
  })

  it('异常退出（code=143）：crash log 照写 + 快照 section 补写 + 关联采样触发', async () => {
    const client = await startClient()
    stderrStream.emitData('line-1: boot ok\n')
    emitProcExit(143)
    await flushAsync()

    // 三段：①既有 crash log（header + stderr）②快照 section ③关联 section
    expect(crashLogCalls).toHaveLength(3)
    expect(crashLogCalls[0]!.content).toContain('pi crashed with code 143')
    expect(crashLogCalls[0]!.sessionId).toBe('sid-cc-1')
    expect(crashLogCalls[1]!.content).toContain('[machine-pi-snapshot] capturedAt=FIXTURE')
    expect(crashLogCalls[1]!.sessionId).toBe('sid-cc-1')
    expect(crashLogCalls[2]!.content).toContain('[unified-log-correlation] matched=1')
    expect(crashLogCalls[2]!.sessionId).toBe('sid-cc-1')

    // 快照以 runtime selfPid 采集（进程表归属判定锚点）
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(captureSpy.mock.calls[0]![0]).toBe(process.pid)
    // 采样以崩溃时刻为窗心
    expect(collectSpy).toHaveBeenCalledTimes(1)
    const collectTs = collectSpy.mock.calls[0]![0] as number
    expect(Math.abs(Date.now() - collectTs)).toBeLessThan(5_000)
    void client
  })

  it('主动 kill 流程（_killing=true）：不触发任何关联取证', async () => {
    const client = await startClient()
    const killPromise = client.kill()
    emitProcExit(143)
    await killPromise
    await flushAsync()

    expect(crashLogCalls).toHaveLength(0)
    expect(captureSpy).not.toHaveBeenCalled()
    expect(collectSpy).not.toHaveBeenCalled()
  })

  it('快照采集抛错：不影响既有 crash log 与采样触发（best-effort）', async () => {
    captureSpy.mockImplementation(() => {
      throw new Error('ps exploded')
    })
    const client = await startClient()
    expect(() => emitProcExit(143)).not.toThrow()
    await flushAsync()

    // ①crash log 照写 ②快照抛错被吞（无第二次调用落盘）③采样照常触发
    expect(crashLogCalls).toHaveLength(2)
    expect(crashLogCalls[0]!.content).toContain('pi crashed with code 143')
    expect(collectSpy).toHaveBeenCalledTimes(1)
    void client
  })

  it('采样返回空串（门关闭/非 darwin）：不补写第三段', async () => {
    collectSpy.mockReturnValue(Promise.resolve(''))
    const client = await startClient()
    emitProcExit(143)
    await flushAsync()

    expect(crashLogCalls).toHaveLength(2)
    expect(collectSpy).toHaveBeenCalledTimes(1)
    void client
  })
})

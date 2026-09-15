/**
 * D1 台账 session 生命周期事件接线测试（crash-forensics-and-watchdog §3.3 D1，实施单元 u1d1）。
 *
 * 锁定（验收条款①②③）：
 * - 抑制语义：用户主动删走 destroySession 先删进程表 → exit handler 反查无条目静默返回，
 *   不经 onSessionExit 链——shutdown（杀链发起处）/ deleted（removeSessionEntry 汇聚点）
 *   两事件仍产生，crash 永不产生（挂点选择正确性的构造性证明）；
 * - 异常退出：crash 事件含 sessionId + exitCode + 非空 detailDigest（stderr 尾部摘要），
 *   且异常退收殓腿经 removeSessionEntry 产生 deleted；
 * - 计划内终止记 shutdown（reason=planned）不记 crash（#16 归因保护）。
 *
 * 组合：真 ProcessManager（mock node:child_process 的 fakeProc）+ 真 SessionService（轻量
 * deps 桩，session-service-ensure-active.test.ts makeEnv 同款）——「destroySession 先删 Map
 * 的路径」用 lifecycle.delete 真链触发，不做单点函数直调。
 *
 * 真实 IO（不 mock crash-journal writer）：写删目标全部位于 mkdtempSync 自建 tmp（fs-guard
 * 白名单），断言前 writer.close() 取确定性 flush 点；递归删除带 maxRetries+retryDelay
 * （pre-commit flake 卫生检查硬要求）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/crash-journal-session-lifecycle-events.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent } from '@taiji/shared'
import { SessionService } from '../services/session/session-service.js'
import { ProcessManager } from '../infra/pi/process-manager.js'
import { closeCrashJournal, initCrashJournal } from '../infra/crash-journal.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'

// ── Mocks（process-manager-exit.test.ts 同构）──────────────────────

const procExitHandlers: Array<(code: number | null) => void> = []
const procStderrDataHandlers: Array<(chunk: Buffer) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: {
    on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
      if (event === 'data') procStderrDataHandlers.push(handler)
      return fakeProc.stderr
    }),
  },
  stdin: { write: vi.fn(() => true), once: vi.fn() },
  // 模拟真实进程：SIGTERM 后异步死亡（信号致死 → exit code null），kill() 快速收口。
  kill: vi.fn((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      queueMicrotask(() => {
        for (const h of [...procExitHandlers]) h(null)
      })
    }
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => fakeProc,
    execSync: () => {
      throw new Error('execSync mocked: not found')
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // findPiExecutable 探测全不命中 → 'pi' fallback（hermetic）；真实 fs 保留供 tmp 读写
  return { ...actual, existsSync: () => false, readdirSync: () => [] }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../infra/logger.js', () => ({
  // crash-journal 的写失败上报走 logger.warn——mock 对象必须在场（factory 覆盖整个模块导出）
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  writePiCrashLog: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────

function emitProcExit(code: number | null): void {
  for (const h of [...procExitHandlers]) h(code)
}

function emitStderr(text: string): void {
  for (const h of [...procStderrDataHandlers]) h(Buffer.from(text))
}

let dataDir: string

/** 真台账 + 真进程管理器 + 真 SessionService 的组合环境（makeEnv 同款轻量 deps）。 */
async function makeEnv() {
  initCrashJournal(dataDir)
  const pm = new ProcessManager('/mock/project-root')
  const broker = { broadcast: vi.fn((_: ServerMessage) => {}) } as unknown as IMessageBroker
  const svc = new SessionService(
    pm as unknown as IProcessManager,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/mock/project-root',
    {} as never,
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    {
      scanSessions: vi.fn(() => []),
      extractSessionOutcome: vi.fn(() => null),
      persistSessionEnd: vi.fn(),
      invalidateScanCache: vi.fn(),
      refreshAll: vi.fn(),
      invalidateMetaCache: vi.fn(),
    } as never,
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as never,
    {} as never,
  )
  return { pm, svc }
}

/**
 * close 后读台账并逐行 parse（任何半行都会抛）。不用 existsSync 判存在——本文件把
 * existsSync mock 成恒 false（findPiExecutable hermetic 前提），readFileSync ENOENT
 * 容错才不被 mock 干扰。
 */
async function readJournal(): Promise<CrashJournalEvent[]> {
  await closeCrashJournal()
  const file = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as CrashJournalEvent)
}

// ── Tests ────────────────────────────────────────────────────────

describe('D1 台账 session 生命周期事件接线（u1d1）', () => {
  afterEach(async () => {
    await closeCrashJournal().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('验收①③ 抑制语义：lifecycle.delete（destroySession 先删 Map）产生 shutdown+deleted，exit handler 静默不产生 crash', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'crash-journal-u1d1-del-'))
    const { pm, svc } = await makeEnv()

    await pm.createSession('sid-del', '/project')
    await svc.initializeManagedSession('sid-del', {} as unknown as IPiEngine, '/project', 'label')
    expect(pm.hasClient('sid-del')).toBe(true)

    // 主动删真链：lifecycle.delete → pm.destroySession（先删 Map 再 kill）→ removeSessionEntry
    await svc.delete('sid-del')
    await Promise.resolve() // 排空 kill mock 的 queueMicrotask（信号致死的 exit 事件）
    emitProcExit(null) // 迟到的重复 exit——反查无条目，必须静默

    const events = await readJournal()

    // shutdown 来自杀链发起处（destroySession），reason=planned
    const shutdowns = events.filter((e) => e.event === 'shutdown')
    expect(shutdowns).toHaveLength(1)
    expect(shutdowns[0]).toMatchObject({ layer: 'pi', event: 'shutdown', reason: 'planned', sessionId: 'sid-del' })

    // deleted 来自 removeSessionEntry 汇聚点（主动删腿）
    const deleteds = events.filter((e) => e.event === 'deleted')
    expect(deleteds).toHaveLength(1)
    expect(deleteds[0]).toMatchObject({ layer: 'pi', event: 'deleted', sessionId: 'sid-del' })

    // 抑制语义核心断言：exit handler 静默路径不产生 crash（挂 exit handler 事件面即错）
    expect(events.some((e) => e.event === 'crash')).toBe(false)
  })

  it('验收② 异常退出：crash 事件含 sessionId+exitCode+非空 detailDigest（stderr 尾部摘要），deleted 收殓腿在场', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'crash-journal-u1d1-crash-'))
    const { pm, svc } = await makeEnv()

    await pm.createSession('sid-crash', '/project')
    await svc.initializeManagedSession('sid-crash', {} as unknown as IPiEngine, '/project', 'label')

    // 5s 后自动 respawn 的 restore 内核 mock（真实实现会磁盘扫描，测试只关心事件面）
    vi.spyOn(svc, 'restoreSession').mockResolvedValue({ id: 'sid-crash' } as never)

    // 崩溃现场：先有 stderr 输出，再异常退出（code 1）
    emitStderr('TypeError: Cannot read properties of undefined')
    emitStderr('at AgentSession.run (agent-session.js:1)')
    emitProcExit(1)

    const events = await readJournal()

    const crashes = events.filter((e) => e.event === 'crash')
    expect(crashes).toHaveLength(1)
    const crash = crashes[0]
    expect(crash.layer).toBe('pi')
    expect(crash.sessionId).toBe('sid-crash')
    expect(crash.exitCode).toBe(1)
    expect(crash.detailDigest).toBeTruthy()
    expect(crash.detailDigest).toContain('TypeError: Cannot read properties of undefined')

    // 异常退收殓腿：onSessionExit 链 → removeSessionEntry 汇聚点产生 deleted
    expect(events.filter((e) => e.event === 'deleted').map((e) => e.sessionId)).toEqual(['sid-crash'])

    // 计划内杀链未发生：无 shutdown 行
    expect(events.some((e) => e.event === 'shutdown')).toBe(false)
  })

  it('destroyAll：逐 session 经 destroySession 杀链发起处各产生一条 shutdown', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'crash-journal-u1d1-destroy-all-'))
    const { pm } = await makeEnv()

    await pm.createSession('sid-a', '/project')
    await pm.createSession('sid-b', '/project')
    await pm.destroyAll()
    await Promise.resolve()

    const events = await readJournal()
    expect(events.filter((e) => e.event === 'shutdown').map((e) => e.sessionId).sort()).toEqual(['sid-a', 'sid-b'])
    expect(events.every((e) => e.event !== 'crash')).toBe(true)
  })

  it('detailDigest ≤2KB：超长 stderr 截断为尾部摘要（防漏设计①）', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'crash-journal-u1d1-digest-'))
    const { pm, svc } = await makeEnv()

    await pm.createSession('sid-big', '/project')
    await svc.initializeManagedSession('sid-big', {} as unknown as IPiEngine, '/project', 'label')
    vi.spyOn(svc, 'restoreSession').mockResolvedValue({} as never)

    emitStderr('x'.repeat(5000))
    emitProcExit(1)

    const events = await readJournal()
    const crash = events.find((e) => e.event === 'crash')
    expect(crash?.detailDigest).toBeTruthy()
    expect((crash?.detailDigest ?? '').length).toBeLessThanOrEqual(2048)
  })
})

/**
 * session.restore 幂等短路（D5②）+ restore-abort / delete 清理（D4）单测
 * （session-dead-structural-fixes，实施计划 u2 验收条款④）。
 *
 * 覆盖映射：
 * - D5②：client 已活跃且未退出时 restoreSession 短路复用返回现有 summary——不清场
 *   （无 detach/destroy）、不重开（无 createSession）、等价 ensureActive 既有分支；
 * - 短路条件边界：client exited（死进程）不命中 → 走全流程重开；
 * - D4：forceQuit 置标记后 restoreSession 全流程 → 返回前 client.abort 被调用 +
 *   收敛环启动（fake timers 静默窗满清标记）；abort 失败 → forceQuitFallback 强杀收敛；
 * - D4 清理路径：delete 清 userStopped 标记。
 *
 * mock 策略：session-pool-restoresession.test.ts 同款 infra mock（不 spawn 真实 pi；
 * jsonl fixture 落 tmpdir 自建自删，符合 runtime fs-guard 白名单）。
 * 运行：cd packages/runtime && npx vitest run test/session-restore-shortcircuit.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// ── Mock infra（与 session-pool-restoresession.test.ts 同款分工）──

const mockScannedSessions: Array<{
  id: string
  filePath: string
  cwd: string
  name: string | null
  lastModified: number
  timestamp: string
  size: number
}> = []

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
    refreshAll: () => {},
  }
})
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => mockScannedSessions }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/sessions',
    getPiAgentDir: () => '/mock/taiji/agent',
  }
})
vi.mock('../src/infra/system/trash.js', () => ({
  trash: vi.fn().mockResolvedValue(undefined),
}))

const attachMock = vi.fn()
const detachMock = vi.fn()
vi.mock('../src/infra/pi/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
    constructor(_sessionId: string, _send: (msg: unknown) => void) { void _sessionId; void _send }
    attach = attachMock
    detach = detachMock
  },
}))

const createSessionMock = vi.fn()
const getClientMock = vi.fn()
const onSessionExitMock = vi.fn()
vi.mock('../src/infra/pi/process-manager.js', () => ({
  ProcessManager: class MockProcessManager {
    createSession = createSessionMock
    getClient = getClientMock
    hasClient = vi.fn().mockReturnValue(false)
    destroySession = vi.fn().mockResolvedValue(undefined)
    destroyAll = vi.fn().mockResolvedValue(undefined)
    onSessionExit = onSessionExitMock
    rekey = vi.fn()
    getSessionIdByClient = vi.fn()
    withEphemeralPi = vi.fn()
  },
}))

// ── Import after mocks ──────────────────────────────────────────

import { SessionService, userStoppedMarkStore } from '../src/services/session/session-service.js'
import { WARMUP_SLOT_SESSION_ID } from '../src/services/session/warmup-pi-slot.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import type { IMessageBroker, IEventAdapter } from '../src/interfaces.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { IPiEngine } from '../src/services/ports/pi-engine.js'

const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

let tmpRoot = ''

function addScannedSession(id: string, cwd = tmpdir()) {
  const filePath = join(tmpRoot, `${id}.jsonl`)
  writeFileSync(filePath, JSON.stringify({ type: 'session', id, cwd, timestamp: new Date().toISOString() }))
  const entry = { id, filePath, cwd, name: null, lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0 }
  mockScannedSessions.push(entry)
  return entry
}

/** Minimal RpcClient-like mock（exited 字段驱动 D5② 短路判定）。 */
function makeMockClient(overrides: Partial<{ exited: boolean }> = {}): IPiEngine & { exited: boolean } {
  return {
    exited: overrides.exited ?? false,
    onEvent: vi.fn().mockReturnValue(vi.fn()),
    switchSession: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPiEngine & { exited: boolean }
}

function createService(): SessionService {
  const noopBroker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
  const adapterFactory = (_sessionId: string, _interceptor: unknown): IEventAdapter => ({
    attach: attachMock,
    detach: detachMock,
  })
  const mockPm = {
    createSession: createSessionMock,
    getClient: getClientMock,
    hasClient: vi.fn().mockReturnValue(false),
    destroySession: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    onSessionExit: onSessionExitMock,
    rekey: vi.fn(),
    getSessionIdByClient: vi.fn(),
  }
  return new SessionService(
    mockPm as never,
    noopBroker,
    adapterFactory,
    '/tmp',
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as never,
    new PiConfigStore(),
    new PiSessionStore(),
    noopGitInfoReader,
    {} as never,
  )
}

describe('D5②：session.restore 幂等短路复用', () => {
  let service: SessionService

  beforeEach(() => {
    vi.clearAllMocks()
    mockScannedSessions.length = 0
    tmpRoot = mkdtempSync(join(tmpdir(), 'restore-shortcircuit-'))
    service = createService()
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  it('client 已活跃且未退出：短路复用现有 summary，不清场（零 detach/destroy）不重开（零 createSession）', async () => {
    const id = 'shortcircuit-id'
    const activeClient = makeMockClient({ exited: false })
    await service.initializeManagedSession(id, activeClient, '/repo', 'label')
    attachMock.mockClear()
    detachMock.mockClear()
    getClientMock.mockReturnValue(activeClient) // ensureActive 同款判定：existing && !exited

    const summary = await service.restoreSession(id)

    expect(summary.id).toBe(id)
    expect(createSessionMock).not.toHaveBeenCalled() // 不重开
    expect(detachMock).not.toHaveBeenCalled() // 不清场
  })

  it('client exited（死进程纵深防御形态）：不命中短路，走全流程清场重开', async () => {
    const id = 'exited-client-id'
    const deadClient = makeMockClient({ exited: true })
    await service.initializeManagedSession(id, deadClient, '/repo', 'label')
    const freshClient = makeMockClient()
    createSessionMock.mockResolvedValue(freshClient)
    addScannedSession(id, '/repo')
    getClientMock.mockReturnValue(deadClient)

    const summary = await service.restoreSession(id)

    expect(summary.id).toBe(id)
    // 全流程重开（目标会话恰 1 次）+ 槽空消费触发的补位 spawn（WARMUP_SLOT_SESSION_ID，
    // §3.3-2 消费驱动补位，fire-and-forget 不阻塞 restore 返回值）
    const callsBySession = createSessionMock.mock.calls.map((c) => c[0])
    expect(callsBySession.filter((s) => s === id)).toHaveLength(1)
    expect(callsBySession).toContain(WARMUP_SLOT_SESSION_ID)
    expect(freshClient.switchSession).toHaveBeenCalledWith(mockScannedSessions[0].filePath)
  })

  it('client 不在进程表（forceQuit 后 dead session 点击场景）：不命中短路，全流程 restore', async () => {
    const id = 'dead-session-id'
    getClientMock.mockReturnValue(undefined) // 进程表中无 client
    const freshClient = makeMockClient()
    createSessionMock.mockResolvedValue(freshClient)
    addScannedSession(id, '/repo')

    const summary = await service.restoreSession(id)
    expect(summary.id).toBe(id)
    const callsBySession = createSessionMock.mock.calls.map((c) => c[0])
    expect(callsBySession.filter((s) => s === id)).toHaveLength(1) // 目标会话恰 1 次（补位 spawn 另计）
    expect(callsBySession).toContain(WARMUP_SLOT_SESSION_ID) // 槽空消费 → 补位 spawn（§3.3-2）
  })
})

describe('warmup slot 附着失败回退（session-cold-switch-perf §3.1 失败路径）', () => {
  let service: SessionService

  beforeEach(() => {
    vi.clearAllMocks()
    mockScannedSessions.length = 0
    tmpRoot = mkdtempSync(join(tmpdir(), 'restore-attach-fallback-'))
    service = createService()
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  it('槽命中（探活通过）但 switch_session 附着失败 → 回退现状 spawn 链完成 restore（最坏 = 现状）', async () => {
    // ① 首次 restore：槽空 → 现状 spawn（firstClient）+ 消费驱动补位（slotClient 落槽）
    const id1 = 'warm-attach-seed-id'
    const id2 = 'warm-attach-target-id'
    addScannedSession(id1, tmpRoot) // cwd 用真实存在的 tmpRoot：两次消费参数签名一致（§3.3-5 presetId+cwd）
    addScannedSession(id2, tmpRoot)
    getClientMock.mockReturnValue(undefined)
    const firstClient = makeMockClient()
    const slotClient = makeMockClient()
    // 槽进程半死形态：探活通过（exited=false + pid 可收信号；借测试进程自身 pid）但
    // switch_session 抛错
    ;(slotClient as unknown as { pid: number }).pid = process.pid
    slotClient.switchSession = vi.fn().mockRejectedValue(new Error('attach failed on warmup slot process'))
    createSessionMock.mockImplementation(async (sessionId: string) =>
      sessionId === WARMUP_SLOT_SESSION_ID ? slotClient : firstClient)
    await service.restoreSession(id1)
    // 等补位 spawn 落槽（fire-and-forget；落定信号 = 槽 id 的 createSession 调用已发生）
    await vi.waitFor(() => expect(createSessionMock).toHaveBeenCalledWith(WARMUP_SLOT_SESSION_ID, expect.anything(), expect.anything()))

    // ② 同签名会话冷切：槽命中 → 附着失败 → 回退 spawn 链（respawnClient）完成附着
    const respawnClient = makeMockClient()
    createSessionMock.mockClear()
    createSessionMock.mockImplementation(async (sessionId: string) =>
      sessionId === WARMUP_SLOT_SESSION_ID ? slotClient : respawnClient)
    const summary = await service.restoreSession(id2)

    expect(summary.id).toBe(id2) // 切换成功（回退链兜住，不更糟）
    expect(slotClient.switchSession).toHaveBeenCalledTimes(1) // 槽进程附着尝试过（失败）
    expect(respawnClient.switchSession).toHaveBeenCalledWith(mockScannedSessions[1].filePath) // 回退 spawn 完成附着
    const callsBySession = createSessionMock.mock.calls.map((c) => c[0])
    expect(callsBySession.filter((s) => s === id2)).toHaveLength(1) // 回退 spawn 恰一次
  })
})

describe('D4：restore-abort（标记检测）', () => {
  let service: SessionService

  beforeEach(() => {
    vi.clearAllMocks()
    mockScannedSessions.length = 0
    tmpRoot = mkdtempSync(join(tmpdir(), 'restore-abort-'))
    service = createService()
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  it('forceQuit 置标记后 restore：返回前 client.abort 被调用，标记保留（无自动收敛，待显式投递消费）', async () => {
    const id = 'restore-abort-id'
    // ① K1 置标记（client 在进程表 → forceQuit 完整收敛链）
    const dyingClient = makeMockClient()
    getClientMock.mockReturnValue(dyingClient)
    await service.forceQuit(id)
    expect(userStoppedMarkStore.hasUserStoppedMark(id)).toBe(true)

    // ② 用户点击 dead session：client 不在进程表 → 全流程 restore
    getClientMock.mockReturnValue(undefined)
    const freshClient = makeMockClient()
    createSessionMock.mockResolvedValue(freshClient)
    addScannedSession(id, '/repo')

    await service.restoreSession(id)

    // D4 核心：restore 返回前 abort（掐 session_start 钩子补投的 replay turn）
    expect(freshClient.abort).toHaveBeenCalledTimes(1)
    // 标记保留：拦截存续到用户下一次显式投递（ADR-0122 事件顺序契约，原静默窗自动
    // 收敛已删）
    expect(userStoppedMarkStore.hasUserStoppedMark(id)).toBe(true)
  })

  it('无标记的普通 restore（pi 崩溃等非用户意图）：不 abort（notify replay 照常补投）', async () => {
    const id = 'no-mark-id'
    getClientMock.mockReturnValue(undefined)
    const freshClient = makeMockClient()
    createSessionMock.mockResolvedValue(freshClient)
    addScannedSession(id, '/repo')

    await service.restoreSession(id)
    expect(freshClient.abort).not.toHaveBeenCalled()
    expect(userStoppedMarkStore.hasUserStoppedMark(id)).toBe(false)
  })

  it('restore-abort 失败（RPC 断链）：fallback forceQuit 强杀收敛，标记不视为已消费', async () => {
    const id = 'abort-fail-id'
    userStoppedMarkStore.markUserStopped(id, 'abort_timeout')

    getClientMock.mockReturnValue(undefined)
    const failingClient = {
      ...makeMockClient(),
      switchSession: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockRejectedValue(new Error('EPIPE')),
    }
    createSessionMock.mockResolvedValue(failingClient)
    addScannedSession(id, '/repo')

    await service.restoreSession(id)

    expect(failingClient.abort).toHaveBeenCalledTimes(1)
    // fallback = dispatcher.forceQuit：client 不在进程表 → 幂等成功返回（进程已死无需杀），
    // 标记保留（收敛环未完成，下次 restore 重试）
    expect(userStoppedMarkStore.hasUserStoppedMark(id)).toBe(true)
  })
})

describe('D4：delete 清理 userStopped 标记', () => {
  let service: SessionService

  beforeEach(() => {
    vi.clearAllMocks()
    mockScannedSessions.length = 0
    tmpRoot = mkdtempSync(join(tmpdir(), 'delete-mark-'))
    service = createService()
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    userStoppedMarkStore.clearAllUserStoppedMarks()
  })

  it('delete（非 active 分支）→ 标记随 session 一起清理', async () => {
    const id = 'delete-mark-id'
    const entry = addScannedSession(id, '/repo')
    userStoppedMarkStore.markUserStopped(id, 'user_force_quit')

    await service.delete(id)

    expect(userStoppedMarkStore.hasUserStoppedMark(id)).toBe(false)
    void entry
  })

  it('destroyAll → 全量清理（shutdown 路径）', async () => {
    userStoppedMarkStore.markUserStopped('a', 'user_force_quit')
    userStoppedMarkStore.markUserStopped('b', 'abort_timeout')
    await service.destroyAll()
    expect(userStoppedMarkStore.hasUserStoppedMark('a')).toBe(false)
    expect(userStoppedMarkStore.hasUserStoppedMark('b')).toBe(false)
  })
})

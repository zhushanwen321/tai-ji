/**
 * session-lifecycle 合并测试（F1/F2 失败路径验收 + deleteByCwd folder 维度批量删除）。
 *
 * 来源（分节注释见内）：
 * - session-lifecycle（原主文件：F1/F2 失败路径）
 * - session-lifecycle-deletebycwd（W1 deleteByCwd 批量删除）
 *
 * 背景：session 创建时 cwd 可能不存在（worktree 清理/手动删目录）或为空/非法字符。
 * 本测试验证：
 * - F1: cwd 不存在 → 降级 homedir + console.warn 通知
 * - F2: cwd 为空字符串/非法字符时 service 层拦截 + store 层兜底
 * - W1: deleteByCwd 串行删除 + 部分失败聚合 + force 旁路 TTL
 *
 * Mock 边界：svc/pm/configStore/sessionStore/workspaceService 注入 mock，
 * fs.existsSync 用 vi.mock 模拟（透传其余导出），真实逻辑在 session-lifecycle.ts 执行。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { homedir } from 'node:os'

// Mock fs.existsSync 以控制 cwd 存在性检查
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    existsSync: vi.fn((path: string) => {
      // 默认行为：除特定测试场景外，路径存在
      return original.existsSync(path)
    }),
  }
})

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore, ScannedSessionMeta } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { SessionSummary, BatchDeleteResult } from '@taiji/shared'
import { existsSync } from 'node:fs'

// ── Mock 协作者 ────────────────────────────────────────────────────

interface MockClient {
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  setSessionName: MockInstance<(name: string) => Promise<unknown>>
}

function makeClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
      sessionId: 'pi-session-1',
      sessionFile: '/tmp/session.jsonl',
    }),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    setSessionName: vi.fn<(name: string) => Promise<unknown>>().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeSessionView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 'sid-1',
    cwd: '/repo',
    label: 'test-session',
    modelId: 'p/m',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}

function makeEnv() {
  const clientMap = new Map<string, MockClient>()
  const sessionMap = new Map<string, IManagedSessionView>()

  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1,
    })),
    findScannedSession: vi.fn(() => undefined),
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 消费方实际用到的全部），无强转
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn(() => undefined),
    hasClient: vi.fn(() => false),
    rekey: vi.fn((oldId: string, newId: string) => {
      const c = clientMap.get(oldId)
      if (c) { clientMap.delete(oldId); clientMap.set(newId, c) }
    }),
    onSessionExit: vi.fn(() => {}),
    destroyAll: vi.fn(async () => {}),
    withEphemeralPi: vi.fn(async <T>(_sessionFile: string, fn: (c: IPiEngine) => Promise<T>) =>
      fn(makeClient() as unknown as IPiEngine)),
  } as unknown as IProcessManager

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
  } as unknown as ISessionStore

  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)

  return {
    lifecycle, svc, pm, sessionStore, clientMap, sessionMap,
    mountActive: (id: string, client: MockClient, session?: IManagedSessionView) => {
      clientMap.set(id, client)
      sessionMap.set(id, session ?? makeSessionView({ id }))
    },
  }
}

type Env = ReturnType<typeof makeEnv>

// ── Tests ─────────────────────────────────────────────────────────

describe('SessionLifecycle · F1/F2 失败路径', () => {
  let env: Env
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let existsSyncMock: MockInstance<(path: string) => boolean>

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    env = makeEnv()
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    existsSyncMock = vi.mocked(existsSync)
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    setMigrationGate(Promise.resolve())
  })

  // ── F1: cwd 不存在 → 降级 homedir + toast ─────────────────────────
  describe('F1: cwd 不存在时降级 homedir + toast 通知用户', () => {
    it('cwd 不存在时降级到 homedir，session.cwd 等于 homedir', async () => {
      const nonExistentCwd = '/tmp/non-existent-dir-taiji-test'
      // 模拟 cwd 不存在
      existsSyncMock.mockImplementation((path: string) => {
        if (path === nonExistentCwd) return false
        return true
      })

      const summary = await env.lifecycle.create(nonExistentCwd, 'test-session')

      // session.cwd 应降级到 homedir
      expect(summary.cwd).toBe(homedir())
      // 应输出警告日志（前端据此判断是否 toast）
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('create cwd does not exist'),
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(nonExistentCwd),
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('falling back to home'),
      )
    })

    it('cwd 不存在时仍调用 pm.createSession 传入降级后的 cwd', async () => {
      const nonExistentCwd = '/tmp/non-existent-dir-taiji-test-2'
      existsSyncMock.mockImplementation((path: string) => {
        if (path === nonExistentCwd) return false
        return true
      })

      await env.lifecycle.create(nonExistentCwd, 'test-session')

      // pm.createSession 应被调用，且 cwd 为 homedir
      expect(env.pm.createSession).toHaveBeenCalledWith(
        expect.any(String), // tempId
        homedir(),           // 降级后的 cwd
        expect.any(Object),  // options
      )
    })

    it('cwd 不存在时注册进 Map 的 session.cwd 为降级后的 cwd', async () => {
      const nonExistentCwd = '/tmp/non-existent-dir-taiji-test-3'
      existsSyncMock.mockImplementation((path: string) => {
        if (path === nonExistentCwd) return false
        return true
      })

      await env.lifecycle.create(nonExistentCwd, 'test-session')

      // S3 迁移：断言观察点从 svc.initializeManagedSession 传参（cwd 第 3 参）随迁为真
      // registerSession 的注册结果（Map 记录字段），断言语义不变——cwd 降级后进入 session。
      const ids = Array.from(env.lifecycle.keys())
      expect(ids.length).toBe(1)
      expect(env.lifecycle.get(ids[0]!)?.cwd).toBe(homedir())
    })
  })

  // ── F2: cwd 为空字符串/非法字符时 service 层拦截 + store 层兜底 ─────
  describe('F2: cwd 为空字符串/非法字符时 service 层拦截 + store 层兜底', () => {
    it('cwd 为空字符串时降级到 homedir', async () => {
      const emptyCwd = ''
      // 空字符串的 existsSync 行为：在 Node.js 中 existsSync('') 返回 false
      existsSyncMock.mockImplementation((path: string) => {
        if (path === emptyCwd) return false
        return true
      })

      const summary = await env.lifecycle.create(emptyCwd, 'test-session')

      // session.cwd 应降级到 homedir
      expect(summary.cwd).toBe(homedir())
      // 应输出警告日志
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('create cwd does not exist'),
      )
    })

    it('cwd 为 undefined 时使用 process.cwd()，若不存在则降级', async () => {
      // 不传 cwd，使用默认值 process.cwd()
      const originalCwd = process.cwd()
      // 模拟 process.cwd() 返回的路径不存在
      existsSyncMock.mockImplementation((path: string) => {
        if (path === originalCwd) return false
        return true
      })

      const summary = await env.lifecycle.create(undefined, 'test-session')

      // session.cwd 应降级到 homedir
      expect(summary.cwd).toBe(homedir())
      // 应输出警告日志，包含原始 cwd
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('create cwd does not exist'),
      )
    })

    it('cwd 存在时不降级，保持原值', async () => {
      const validCwd = '/tmp/valid-dir-taiji-test'
      existsSyncMock.mockImplementation((path: string) => {
        if (path === validCwd) return true
        return true
      })

      const summary = await env.lifecycle.create(validCwd, 'test-session')

      // session.cwd 应保持原值
      expect(summary.cwd).toBe(validCwd)
      // 不应输出降级警告
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('falling back to home'),
      )
    })

    it('cwd 降级时 label 仍基于降级后的 cwd 的 basename', async () => {
      const nonExistentCwd = '/tmp/non-existent-dir-for-label-test'
      existsSyncMock.mockImplementation((path: string) => {
        if (path === nonExistentCwd) return false
        return true
      })

      // 不传 label，应使用 basename(cwd) 作为默认 label
      const summary = await env.lifecycle.create(nonExistentCwd)

      // label 应基于降级后 cwd 的 basename（homedir 的 basename）
      // homedir() 通常返回 /Users/username 或 /home/username
      const expectedLabel = homedir().split('/').pop() ?? 'home'
      expect(summary.label).toBe(expectedLabel)
    })
  })
})

// ════════════════ 来源: session-lifecycle-deletebycwd.test.ts ════════════════

/**
 * 构造 lifecycle + delete spy + 注入 mock。
 * delete spy 默认 resolve（成功）；用例可按 id 判定 reject 模拟部分失败。
 */
function makeDeleteByCwdHarness(deleteImpl?: (id: string) => Promise<void>) {
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const pm = {} as unknown as IProcessManager
  const configStore = {} as unknown as IConfigStore
  const sessionStore = {
    scanSessions: vi.fn((): ScannedSessionMeta[] => []),
    refreshAll: vi.fn(),
  } as unknown as ISessionStore
  // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法），无强转；deleteByCwd 只真实消费
  // getActiveSummaries（delete 被下方 spy 覆盖，不走其余成员），空 vi.fn 仅为满足接口侧
  const svc: ILifecycleSessionOps = {
    getActiveSummaries: vi.fn((): SessionSummary[] => []),
    toSummary: vi.fn(),
    findScannedSession: vi.fn(),
    getSkillPaths: vi.fn(),
    getExtensionPaths: vi.fn(),
    getReplaceSystemPrompt: vi.fn(),
    getLaunchPresetOptions: vi.fn(),
    fetchAndBroadcastContext: vi.fn(),
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
  }

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspace, registerDeps)
  // spyOn 实例方法 delete，覆盖真实文件/trash/unlink 路径，专注 deleteByCwd 聚合逻辑。
  const deleteSpy = vi.spyOn(lifecycle, 'delete').mockImplementation(
    deleteImpl ?? (async () => {}),
  )
  return { lifecycle, svc, sessionStore, deleteSpy }
}

describe('W1: SessionLifecycle.deleteByCwd — folder 维度批量删除', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1TC1 串行删除 + 部分失败聚合', async () => {
    // scanSessions: s1/s2（persisted）；getActiveSummaries: s3（active，未 flush 的边界场景）
    const { lifecycle, svc, sessionStore, deleteSpy } = makeDeleteByCwdHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', cwd: '/p', filePath: '/p/s1.jsonl' } as ScannedSessionMeta,
      { id: 's2', cwd: '/p', filePath: '/p/s2.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p' } as SessionSummary,
    ])
    // Set 插入顺序：先 active 的 s3，再 scan 的 s1/s2 → 循环顺序 s3, s1, s2
    deleteSpy.mockImplementation(async (id: string) => {
      if (id === 's2') throw new Error('EPERM')
    })

    const result: BatchDeleteResult = await lifecycle.deleteByCwd('/p')

    // 失败聚合（不中断循环）
    expect(result.cwd).toBe('/p')
    expect(result.failed).toEqual([{ sessionId: 's2', error: 'EPERM' }])
    // deleted 含 s1/s3（不依赖顺序）
    expect(result.deleted).toHaveLength(2)
    expect(result.deleted).toEqual(expect.arrayContaining(['s1', 's3']))
    expect(result.deleted).not.toContain('s2')
    // delete 被调 3 次（每个 session 一次，失败的也调）
    expect(deleteSpy).toHaveBeenCalledTimes(3)
  })

  it('W1TC2 空 folder 幂等', async () => {
    const { lifecycle, sessionStore, svc, deleteSpy } = makeDeleteByCwdHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'x', cwd: '/other', filePath: '/other/x.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd('/empty')

    expect(result).toEqual({ cwd: '/empty', deleted: [], failed: [] })
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('W1TC3 active + scanned 去重', async () => {
    // s3 同时出现在 active（getActiveSummaries）和 persisted（scanSessions）→ Set 去重为 1 个
    const { lifecycle, svc, sessionStore, deleteSpy } = makeDeleteByCwdHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p', filePath: '/p/s3.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p' } as SessionSummary,
    ])

    const result = await lifecycle.deleteByCwd('/p')

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledWith('s3')
    expect(result).toEqual({ cwd: '/p', deleted: ['s3'], failed: [] })
  })

  it('W11：header cwd 为死路径的 session，deleteByCwd(死路径) 命中（真实历史值匹配）', async () => {
    // W11（patchSessionCwd 迁 tmp 管线）后的扫描侧消费边界：源文件 header 永久保持
    // 死路径 cwd（pi append 不重写 header），deleteByCwd 按扫描条目的真实历史 cwd 命中——
    // 旧方案（restore 时 patch 成 home）下 deleteByCwd(死路径) 不会命中。此用例锁定
    // 「按真实历史值删除」的接受行为（plan W11 步骤 5 / 验收 4 扫描侧断言）。
    const deadCwd = '/gone/worktree-abc'
    const { lifecycle, svc, sessionStore, deleteSpy } = makeDeleteByCwdHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'dead-cwd-1', cwd: deadCwd, filePath: '/gone/worktree-abc/dead-cwd-1.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd(deadCwd)

    expect(deleteSpy).toHaveBeenCalledWith('dead-cwd-1')
    expect(result.deleted).toEqual(['dead-cwd-1'])
    // deleteByCwd(home) 不再命中该 session（home 是旧方案的修补值，死路径才是真实历史值）
    deleteSpy.mockClear()
    const byHome = await lifecycle.deleteByCwd(homedir())
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(byHome.deleted).toEqual([])
  })

  it('W1TC1b 全部 reject → deleted=[] 且 failed 含全部，循环不中断', async () => {
    // setup：folder('/p') 下 2 session（s1, s2），delete spy 对两者都 mockRejectedValue
    const { lifecycle, svc, sessionStore, deleteSpy } = makeDeleteByCwdHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', cwd: '/p', filePath: '/p/s1.jsonl' } as ScannedSessionMeta,
      { id: 's2', cwd: '/p', filePath: '/p/s2.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])
    deleteSpy.mockRejectedValue(new Error('EPERM'))

    const result: BatchDeleteResult = await lifecycle.deleteByCwd('/p')

    // 全失败：deleted=[]，failed 包含全部 session（continue 语义，第一个失败不阻断第二个）
    expect(result.cwd).toBe('/p')
    expect(result.deleted).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed).toEqual([
      { sessionId: 's1', error: 'EPERM' },
      { sessionId: 's2', error: 'EPERM' },
    ])
    // delete 被调 2 次（每个 session 一次，第一个失败不阻断第二个）
    expect(deleteSpy).toHaveBeenCalledTimes(2)
  })

  it('W1TC4 持久化枚举走 force 旁路 TTL——TTL 窗口内刚落盘 session 不漏删', async () => {
    // 回归防护（W26 审查修正）：deleteByCwd 是写语义彻底清理，scanSessions 必须传
    // { force: true } 绕过目录 TTL 快照——快照漏掉刚落盘 session → 漏删；快照含已删条目
    // → delete 内 findScannedSession 找不到 → Session not found → 误报 failed。
    const { lifecycle, svc, sessionStore, deleteSpy } = makeDeleteByCwdHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's-fresh', cwd: '/p', filePath: '/p/s-fresh.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd('/p')

    // 枚举必须走 force（若回退 TTL 快照，本用例语义即破坏——漏删/误报）
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
    // 刚落盘 session 被枚举并删除，无 failed 误报
    expect(deleteSpy).toHaveBeenCalledWith('s-fresh')
    expect(result).toEqual({ cwd: '/p', deleted: ['s-fresh'], failed: [] })
  })
})

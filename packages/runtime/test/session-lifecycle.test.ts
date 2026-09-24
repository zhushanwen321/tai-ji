/**
 * session-lifecycle.test.ts — F1/F2 失败路径验收测试。
 *
 * 背景：session 创建时 cwd 可能不存在（worktree 清理/手动删目录）或为空/非法字符。
 * 本测试验证：
 * - F1: cwd 不存在 → 降级 homedir + console.warn 通知
 * - F2: cwd 为空字符串/非法字符时 service 层拦截 + store 层兜底
 *
 * Mock 边界：svc/pm/configStore/sessionStore/workspaceService 注入 mock，
 * fs.existsSync 用 vi.mock 模拟，真实逻辑在 session-lifecycle.ts 执行。
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
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { SessionSummary } from '@taiji/shared'
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
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
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
      lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn(() => undefined),
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
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

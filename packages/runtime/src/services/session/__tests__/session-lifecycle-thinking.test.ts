/**
 * SessionLifecycle thinking 值域校验测试（W2 值域 SSOT 派生，A-03 回归）。
 *
 * 锁定三条语义：
 * - VALID_THINKING_LEVELS = shared PI_THINKING_LEVELS 全集（7 值含 'max'）——
 *   'max' 必须通过校验并透传到 spawn 参数（A-03：曾缺 max 被 silent drop，
 *   composer 最高档实际永不生效）。
 * - 全集任一值经 create → pm.createSession options.thinkingLevel 原样透传。
 * - 非法值 warn 后丢弃（不透传 thinkingLevel 字段）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-thinking.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView } from '../types.js'
import type { SessionSummary } from '@taiji/shared'

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

function makeEnv() {
  // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView) => makeSummary(s.id)),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    getActiveSummaries: vi.fn(() => []),
  }
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'sess-1', sessionFile: undefined })),
    setSessionName: vi.fn(async () => undefined),
  }
  // 独立持有 createSession 的 vi.fn 引用：pm 整体 cast 成 IProcessManager 后 .mock 属性
  // 类型不可见，断言需经此引用读取 spawn 参数。
  const createSession = vi.fn(async (_id: string, _cwd: string, _opts?: unknown) => client)
  const pm = {
    createSession,
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
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
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, createSession, lifecycle }
}

beforeEach(() => {
  vi.clearAllMocks()
  setMigrationGate(Promise.resolve())
})

afterEach(() => {
  setMigrationGate(Promise.resolve())
})

describe('thinking 值域校验（W2 A-03：max 全通）', () => {
  it('create + thinkingOverride="max" → spawn 参数 thinkingLevel === "max"（核心回归）', async () => {
    const { lifecycle, createSession } = makeEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w2-think-max-'))
    await lifecycle.create(cwd, 't', { thinkingOverride: 'max' })
    const options = createSession.mock.calls[0][2] as { thinkingLevel?: string }
    expect(options.thinkingLevel).toBe('max')
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    '全集值 "%s" 都透传（VALID_THINKING_LEVELS = shared PI_THINKING_LEVELS）',
    async (level) => {
      const { lifecycle, createSession } = makeEnv()
      const cwd = mkdtempSync(join(tmpdir(), `w2-think-${level}-`))
      await lifecycle.create(cwd, 't', { thinkingOverride: level })
      const options = createSession.mock.calls[0][2] as { thinkingLevel?: string }
      expect(options.thinkingLevel).toBe(level)
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  )

  it('preset resolution.thinkingLevel="max"（无 override）也透传', async () => {
    const { lifecycle, createSession, svc } = makeEnv()
    svc.getLaunchPresetOptions = vi.fn(async () => ({
      toolArgs: {}, flags: {}, thinkingLevel: 'max',
    })) as never
    const cwd = mkdtempSync(join(tmpdir(), 'w2-think-preset-'))
    await lifecycle.create(cwd, 't', { presetId: 'builtin:full' })
    const options = createSession.mock.calls[0][2] as { thinkingLevel?: string }
    expect(options.thinkingLevel).toBe('max')
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('非法值 warn 后丢弃（spawn 参数无 thinkingLevel 字段）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { lifecycle, createSession } = makeEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w2-think-bogus-'))
    await lifecycle.create(cwd, 't', { thinkingOverride: 'ultra' })
    const options = createSession.mock.calls[0][2] as { thinkingLevel?: string }
    expect(options.thinkingLevel).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ultra'))
    warnSpy.mockRestore()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('Landing override 优先于 preset 字段（C-RL-6）：override=max preset=high → max', async () => {
    const { lifecycle, createSession, svc } = makeEnv()
    svc.getLaunchPresetOptions = vi.fn(async () => ({
      toolArgs: {}, flags: {}, thinkingLevel: 'high',
    })) as never
    const cwd = mkdtempSync(join(tmpdir(), 'w2-think-prio-'))
    await lifecycle.create(cwd, 't', { presetId: 'builtin:full', thinkingOverride: 'max' })
    const options = createSession.mock.calls[0][2] as { thinkingLevel?: string }
    expect(options.thinkingLevel).toBe('max')
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
})

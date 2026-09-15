/**
 * W5: session-lifecycle create cwd 降级到 homedir 时不污染最近工作区列表。
 *
 * 背景：用户选失效 cwd → create 内部 existsSync 降级 homedir（D-008）→
 * 旧代码无条件 record(sessionCwd)，把 homedir 写入「最近工作区」列表。
 * homedir 不是真实工作区，不该出现在列表里。
 *
 * 修复：当 requestedCwd !== sessionCwd（降级发生）时跳过 record。
 *
 * Mock 策略：vi.mock('node:fs') 控制 existsSync 降级；其余依赖全注入 mock。
 *
 * 运行：npx vitest run test/session-lifecycle-w5.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'

// existsSync 由本测试控制，决定是否触发 homedir 降级
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  // createForkedSessionFile / getSessionsDir 可能间接用到，给空实现
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'

function makeMocks() {
  const recordFn = vi.fn()
  const workspace = { record: recordFn } as unknown as WorkspaceService

  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-s1', sessionFile: '/tmp/pi.jsonl' })),
    prompt: vi.fn(async () => ({})),
  } as unknown as IPiEngine

  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => {}),
  } as unknown as IProcessManager

  // S3 迁移：注册走真 registerSession——sessionCwd（可能已降级）原样存入注册记录的 cwd；
  // toSummary 透传记录 cwd，保证 summary.cwd 反映真实降级结果（原 stub initializeManagedSession
  // 回写 session.cwd 的等价观察链）。
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, cwd: s.cwd, label: 'repo', status: 'idle', lastActiveAt: 1,
      modelId: 'test-model', tokenCount: 0,
    })),
    // S3-W2：创建入口收敛点（lifecycle 三处 return 前调用）
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
    getLaunchPresetOptions: vi.fn(async () => undefined),
    findScannedSession: vi.fn(() => undefined),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    getActiveSummaries: vi.fn(() => []),
  }

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = { refreshAll: vi.fn() } as unknown as ISessionStore

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspace, registerDeps)
  return { lifecycle, recordFn, pm }
}

describe('W5: session-lifecycle create record 调用（homedir 过滤归位 service 层）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('cwd 未降级（existsSync=true）→ workspaceService.record 被调用，参数为 cwd', async () => {
    fsMock.existsSync.mockReturnValue(true)
    const { lifecycle, recordFn } = makeMocks()
    await lifecycle.create('/my/repo', 'repo')
    expect(recordFn).toHaveBeenCalledTimes(1)
    expect(recordFn).toHaveBeenCalledWith('/my/repo')
  })

  it('cwd 降级到 homedir（existsSync=false）→ workspaceService.record 仍被调用，参数为 homedir（过滤由 service 层负责）', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const { lifecycle, recordFn } = makeMocks()
    await lifecycle.create('/deleted/path', 'deleted')
    // [方案A] lifecycle 无条件 record（传降级后的 homedir），service 层的 homedir 守卫负责过滤
    expect(recordFn).toHaveBeenCalledTimes(1)
    expect(recordFn).toHaveBeenCalledWith(homedir())
  })

  it('cwd 降级到 homedir → session.cwd 仍是 homedir（降级逻辑本身不变）', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const { lifecycle } = makeMocks()
    const summary = await lifecycle.create('/deleted/path', 'deleted')
    expect(summary.cwd).toBe(homedir())
  })

  it('hidden session → record 不被调用（既有不变式，回归防护）', async () => {
    fsMock.existsSync.mockReturnValue(true)
    const { lifecycle, recordFn } = makeMocks()
    await lifecycle.create('/repo', 'repo', { hidden: true })
    expect(recordFn).not.toHaveBeenCalled()
  })
})

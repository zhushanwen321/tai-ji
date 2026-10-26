/**
 * W3 surface 落地——SessionLifecycle 注册链（设计 §3.3.4 四处载体之 registerSession
 * 尾参 + CreateOptions.surface 管道）+ §5-W3 完成判据④（runtime 层 create 后回读
 * 注册表记录 surface==='sidebar'）+ §7 验收项 13（W5 :649 判据切换三态断言）。
 *
 * 锁定：
 * - registerSession 尾部可选参数 surface（缺省 'sidebar'）写入 sessions Map 记录
 *   （ISessionRegistry.get 回读）——W5 hidden 形参删除后为第 6 参；
 * - create 链路管道：内部 CreateOptions.surface 经 registerCreateSession 透传——
 *   createNew(cwd, label, { surface:'btw' }) 的记录 surface==='btw'（W5 :649 判据
 *   切换与验收项 13 的取数来源）；
 * - §5-W3 ④：createNew(cwd, label)（生产主路径，不传 surface）的记录 surface
 *   缺省 'sidebar'；
 * - initializeManagedSession 兼容委托透传（btw 直注册链第三处签名）。
 * - §7 验收项 13：:649 切 `surface === 'sidebar'`（读注册后记录）后三态断言——
 *   {surface:'btw'} 不记录 / {surface:'sidebar'} 记录 / 不传 surface 仍记录。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-surface.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionSummary } from '@taiji/shared'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

function makeRegisterEnv() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn(),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(
    svc, {} as unknown as IProcessManager, configStore,
    {} as unknown as ISessionStore, {} as unknown as WorkspaceService, registerDeps,
  )
  return { lifecycle, client: {} as unknown as import('../../ports/pi-engine.js').IPiEngine }
}

/** create 链路环境（全协作者 mock + 真 registerSession 编排；fs 落点 = mkdtemp tmp）。 */
function makeCreateEnv() {
  let seq = 0
  const setSessionName = vi.fn(async (_name: string) => ({ success: true }))
  const pm = {
    createSession: vi.fn(async () => {
      seq += 1
      const sid = `pi-sid-${seq}`
      return {
        exited: false,
        getState: vi.fn(async () => ({ sessionId: sid, sessionFile: '/tmp/s.jsonl' })),
        setSessionName,
      }
    }),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    toSummary: vi.fn((s: { id: string; label: string; cwd: string }): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active' as const, lastActiveAt: 1,
    })),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const configStore = { getDefaultModel: vi.fn(() => 'prov/model') } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, workspaceService }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('W3 surface 落地：registerSession 尾部参数（不动既有位置参数顺序）', () => {
  it('缺省 surface → 记录 surface=sidebar（主会话默认态）', async () => {
    const { lifecycle, client } = makeRegisterEnv()
    const session = await lifecycle.registerSession('s-default', client, '/repo', 't')
    expect(session.surface).toBe('sidebar')
    // ISessionRegistry 只读侧回读（W5 :649 判据切换后的取数形态预演）
    expect(lifecycle.get('s-default')?.surface).toBe('sidebar')
  })

  it('显式传 btw → 记录 surface=btw', async () => {
    const { lifecycle, client } = makeRegisterEnv()
    const session = await lifecycle.registerSession(
      'line-1', client, '/repo', 't', '/repo/line-1.jsonl',
      undefined, undefined, undefined, undefined, undefined, 'btw',
    )
    expect(session.surface).toBe('btw')
    expect(lifecycle.get('line-1')).toMatchObject({ surface: 'btw' })
  })

  it('既有 10 位置参数调用形态不受影响（W5 hidden 形参删除后尾部缺省 = sidebar）', async () => {
    const { lifecycle, client } = makeRegisterEnv()
    const session = await lifecycle.registerSession(
      's-legacy', client, '/repo', 't', '/repo/s.jsonl',
      'parent-1', 'entry-9', 'ov/m1', { modelId: 'x/y', thinkingLevel: 'high' }, ['/ext/a.js'],
    )
    expect(session).toMatchObject({
      id: 's-legacy', parentSession: 'parent-1', forkEntryId: 'entry-9',
      modelId: 'x/y', thinkingLevel: 'high', surface: 'sidebar',
    })
  })
})

describe('W3 create 链路 surface 管道（§5-W3 完成判据④）', () => {
  it('createNew(cwd, label)（生产主路径不传 surface）→ 注册表记录 surface=sidebar', async () => {
    const { lifecycle } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w3-surface-create-'))

    const summary = await lifecycle.create(cwd, 't')

    expect(summary.id).toMatch(/^pi-sid-/)
    // §5-W3 ④：runtime 层 create 后回读注册表记录断言 surface === 'sidebar'
    expect(lifecycle.get(summary.id)?.surface).toBe('sidebar')
  })

  it('createNew(cwd, label, { surface: "btw" }) → 管道透传到注册表记录（W5 :649 取数来源）', async () => {
    const { lifecycle } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w3-surface-btw-'))

    const summary = await lifecycle.create(cwd, 't', { surface: 'btw' })

    expect(lifecycle.get(summary.id)?.surface).toBe('btw')
  })

  it('验收项 13 三态：createNew 工作区历史判据（:649 切 surface === "sidebar" 后）', async () => {
    const { lifecycle, workspaceService } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w5-workspace-history-'))

    // ① surface:'btw' → 不记录工作区历史（btw 线 cwd = 主会话 cwd，记录会污染最近工作区列表）
    await lifecycle.create(cwd, 't', { surface: 'btw' })
    expect(workspaceService.record).not.toHaveBeenCalled()

    // ② surface:'sidebar' → 记录
    await lifecycle.create(cwd, 't2', { surface: 'sidebar' })
    expect(workspaceService.record).toHaveBeenCalledWith(cwd)

    // ③ 不传 surface（生产主路径）→ 仍记录（防「谓词改读 options 后生产路径静默停记」）
    vi.mocked(workspaceService.record).mockClear()
    await lifecycle.create(cwd, 't3')
    expect(workspaceService.record).toHaveBeenCalledWith(cwd)
  })

  it('判据取数来源 = 注册后记录（lifecycle.get(id).surface），不读 options', async () => {
    const { lifecycle, workspaceService } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w5-workspace-source-'))

    // 注册后记录由 registerSession 管道保证有值：create 缺省 'sidebar' → 记录工作区历史。
    // 若误改为读 options?.surface，本用例（生产主路径不传 options.surface）会静默停记。
    const summary = await lifecycle.create(cwd, 't')
    expect(lifecycle.get(summary.id)?.surface).toBe('sidebar')
    expect(workspaceService.record).toHaveBeenCalledWith(cwd)
  })
})

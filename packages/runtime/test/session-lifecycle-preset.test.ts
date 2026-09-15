/**
 * session-lifecycle preset 集成单测（wave3）。
 *
 * 覆盖 create/restore/fork/delete 四处与 launch preset 的集成：
 * - create：presetId 解析 + options 映射 + persistPresetBinding + Landing Chip 优先级 + undefined fallback
 * - restore：target.launchPresetId 读取 + builtin:full 兜底 + sidecar 不清理
 * - fork：source.launchPresetId 继承 + forkedFilePath 写新 sidecar
 * - delete：清理 .preset.json sidecar
 *
 * 复用 session-lifecycle-w5.test.ts 的 svc/pm/sessionStore mock 范式。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// vi.mock node:fs：fork/restore 用 readFileSync/writeFileSync/unlinkSync/existsSync
// statSync（u4c D5⑤ 预检引入）：返回小 size 使 normalizeInactiveSessionFileIfNeeded
// 走原全量路径（readFileSync mock），本文件只关心 preset 逻辑，归一化行为维持旧形态
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  readFileSync: vi.fn(() => '{"type":"session","id":"s1"}\n'),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 100, mtimeMs: 0 })),
}))

vi.mock('node:fs/promises', () => ({
  unlink: vi.fn(async () => {}),
}))

vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: vi.fn(async () => ({
    filePath: '/tmp/forked.jsonl',
    sessionId: 'forked-id',
  })),
}))

vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: () => '/tmp/sessions',
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
import type { PresetResolution } from '../src/services/preset-service.js'

function makeResolution(overrides: Partial<PresetResolution> = {}): PresetResolution {
  return {
    extensionPaths: ['/ext/builtin.js'],
    skillPaths: [],
    toolArgs: { tools: ['read', 'grep'] },
    flags: { noSkills: false, noContextFiles: false },
    modelOverride: undefined,
    thinkingLevel: undefined,
    ...overrides,
  }
}

function makeMocks(opts: {
  resolution?: PresetResolution | undefined
  launchPresetOptionsImpl?: (presetId: string, cwd: string) => Promise<PresetResolution | undefined>
} = {}) {
  const recordFn = vi.fn()
  const workspace = { record: recordFn } as unknown as WorkspaceService

  // [W2 语义变更] mock getState 的 sessionFile 跟随最近一次 switchSession 实参——真实 pi
  // 行为（switch_session 后 get_state.sessionFile 即写目标，ADR-0063 I1）；未 switch 过时
  // 保持原固定值（create 路径 pi 新 session 延迟写入窗口的 mock 语义，tc1-tc4 依赖）。
  // session-lifecycle 的 attach 断言依赖该语义（原固定假路径会被判 I1 分裂）。
  let lastSwitchTarget: string | undefined
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-s1', sessionFile: lastSwitchTarget ?? '/tmp/pi.jsonl' })),
    switchSession: vi.fn(async (p: string) => { lastSwitchTarget = p }),
    prompt: vi.fn(async () => ({})),
  } as unknown as IPiEngine

  const createSessionMock = vi.fn(async (_id: string, _cwd: string, _options?: Record<string, unknown>) => client)
  const pm = {
    createSession: createSessionMock,
    rekey: vi.fn(),
    destroySession: vi.fn(async () => {}),
    // D5② 短路预检读点（session-dead-structural-fixes）：undefined = 无 client → 不短路 → 全流程。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager

  const session = { id: 'pi-s1', cwd: '/repo', sessionFilePath: '/tmp/pi.jsonl' } as IManagedSessionView

  const defaultLaunchImpl = opts.launchPresetOptionsImpl ?? (async (presetId: string) => {
    void presetId
    return opts.resolution
  })

  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => ['/default/ext']),
    getSkillPaths: vi.fn(() => ['/default/skill']),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(defaultLaunchImpl),
    toSummary: vi.fn((): SessionSummary => ({
      id: session.id, cwd: session.cwd, label: 'repo', status: 'idle', lastActiveAt: 1,
      modelId: 'test-model', tokenCount: 0,
    })),
    // S3-W2：创建入口收敛点（lifecycle 三处 return 前调用）
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
    getActiveSummaries: vi.fn(() => []),
  }

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const persistPresetBindingFn = vi.fn()
  const sessionStore = {
    refreshAll: vi.fn(),
    // W26（D9-1）：delete/fork/rename 路径新增目录 TTL 缓存失效调用点（ISessionStore 接口新成员）
    invalidateScanCache: vi.fn(),
    persistPresetBinding: persistPresetBindingFn,
    trash: vi.fn(),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspace, registerDeps)
  return { lifecycle, recordFn, createSessionMock, session, svc, persistPresetBindingFn, sessionStore }
}

describe('session-lifecycle preset integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.existsSync.mockReturnValue(true)
  })

  // ── create ──

  it('tc1: create 带 presetId → createSession options 含 preset 字段 + persistPresetBinding 调用', async () => {
    const resolution = makeResolution({
      toolArgs: { tools: ['read', 'grep'] },
      flags: { noSkills: true, noContextFiles: true },
      modelOverride: 'preset-model',
    })
    const { lifecycle, createSessionMock, persistPresetBindingFn, svc } = makeMocks({ resolution })

    await lifecycle.create('/repo', 'label', { presetId: 'builtin:readonly' })

    expect(svc.getLaunchPresetOptions).toHaveBeenCalledWith('builtin:readonly', '/repo')
    expect(createSessionMock).toHaveBeenCalledTimes(1)
    const opts = createSessionMock.mock.calls[0]![2]!
    expect(opts.tools).toEqual(['read', 'grep'])
    expect(opts.noSkills).toBe(true)
    expect(opts.noContextFiles).toBe(true)
    expect(opts.model).toBe('preset-model')
    expect(opts.extensionPaths).toEqual(['/ext/builtin.js'])
    // persistPresetBinding 写 sidecar（V9-④ 根修：create 路径携 skipJsonlExistsGuard 放行守卫）
    expect(persistPresetBindingFn).toHaveBeenCalledWith('/tmp/pi.jsonl', 'builtin:readonly', { skipJsonlExistsGuard: true })
  })

  it('tc2: create 无 presetId → fallback 现有逻辑，不调 getLaunchPresetOptions', async () => {
    const { lifecycle, createSessionMock, persistPresetBindingFn, svc } = makeMocks()

    await lifecycle.create('/repo', 'label')

    expect(svc.getLaunchPresetOptions).not.toHaveBeenCalled()
    expect(persistPresetBindingFn).not.toHaveBeenCalled()
    const opts = createSessionMock.mock.calls[0]![2]!
    expect(opts.extensionPaths).toEqual(['/default/ext'])
    expect(opts.skillPaths).toEqual(['/default/skill'])
    // 不含 preset 字段
    expect(opts.tools).toBeUndefined()
    expect(opts.noSkills).toBeUndefined()
  })

  it('tc3: create Landing Chip 优先级：modelOverride/thinkingOverride 覆盖 preset 字段（C-RL-6）', async () => {
    const resolution = makeResolution({
      modelOverride: 'preset-model',
      thinkingLevel: 'medium',
    })
    const { lifecycle, createSessionMock } = makeMocks({ resolution })

    await lifecycle.create('/repo', 'label', {
      presetId: 'p1',
      modelOverride: 'landing-model',
      thinkingOverride: 'high',
    })

    const opts = createSessionMock.mock.calls[0]![2]!
    // Landing 传入赢过 preset 字段
    expect(opts.model).toBe('landing-model')
    expect(opts.thinkingLevel).toBe('high')
  })

  it('tc4: create getLaunchPresetOptions 返回 undefined → fallback 现有逻辑，不抛错', async () => {
    const { lifecycle, createSessionMock, persistPresetBindingFn, svc } = makeMocks({
      launchPresetOptionsImpl: async () => undefined,
    })

    await lifecycle.create('/repo', 'label', { presetId: 'deleted-preset' })

    expect(svc.getLaunchPresetOptions).toHaveBeenCalledWith('deleted-preset', '/repo')
    const opts = createSessionMock.mock.calls[0]![2]!
    // fallback 到 svc 默认
    expect(opts.extensionPaths).toEqual(['/default/ext'])
    expect(opts.skillPaths).toEqual(['/default/skill'])
    expect(opts.tools).toBeUndefined()
    // presetId 传入值仍写 sidecar（create 路径放行守卫，同 tc1）
    expect(persistPresetBindingFn).toHaveBeenCalledWith('/tmp/pi.jsonl', 'deleted-preset', { skipJsonlExistsGuard: true })
  })

  // ── restoreSession ──

  it('tc5: restoreSession 用 target.launchPresetId 读 preset 覆盖 options，sidecar 不清理', async () => {
    const resolution = makeResolution({ toolArgs: { excludeTools: ['bash'] } })
    const { lifecycle, createSessionMock, svc, sessionStore } = makeMocks({ resolution })
    const unlinkMock = (await import('node:fs')).unlinkSync as unknown as ReturnType<typeof vi.fn>
    unlinkMock.mockClear()

    // findScannedSession 返回带 launchPresetId 的 target
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1', filePath: '/tmp/s1.jsonl', cwd: '/repo', name: 's1',
      launchPresetId: 'builtin:readonly',
    })

    await lifecycle.restoreSession('s1')

    expect(svc.getLaunchPresetOptions).toHaveBeenCalledWith('builtin:readonly', '/repo')
    const opts = createSessionMock.mock.calls[0]![2]!
    expect(opts.excludeTools).toEqual(['bash'])
    // .preset.json sidecar 不被 unlink（preset 是 launch 配置不是终态）
    const presetUnlinks = unlinkMock.mock.calls.filter(c => String(c[0]).endsWith('.preset.json'))
    expect(presetUnlinks).toHaveLength(0)
  })

  it('tc6: restoreSession target.launchPresetId undefined → builtin:full 兜底（FR-10）', async () => {
    const { lifecycle, svc } = makeMocks({ resolution: makeResolution() })

    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1', filePath: '/tmp/s1.jsonl', cwd: '/repo', name: 's1',
      launchPresetId: undefined,
    })

    await lifecycle.restoreSession('s1')

    expect(svc.getLaunchPresetOptions).toHaveBeenCalledWith('builtin:full', '/repo')
  })

  // ── forkSession ──

  it('tc7: forkSession 继承 source.launchPresetId + forkedFilePath 写新 sidecar', async () => {
    const resolution = makeResolution({ toolArgs: { noTools: true } })
    const { lifecycle, createSessionMock, svc, persistPresetBindingFn } = makeMocks({ resolution })

    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'src', filePath: '/tmp/src.jsonl', cwd: '/repo', name: 'src',
      launchPresetId: 'builtin:readonly',
    })

    await lifecycle.forkSession('src', 'entry1', false, 'forked')

    expect(svc.getLaunchPresetOptions).toHaveBeenCalledWith('builtin:readonly', '/repo')
    const opts = createSessionMock.mock.calls[0]![2]!
    expect(opts.noTools).toBe(true)
    // forkedFilePath 写新 sidecar
    expect(persistPresetBindingFn).toHaveBeenCalledWith('/tmp/forked.jsonl', 'builtin:readonly')
  })

  // ── delete ──

  it('tc8: delete 清理 .preset.json sidecar（active + 非 active 两路径）', async () => {
    const { lifecycle, sessionStore } = makeMocks()
    const unlinkMock = (await import('node:fs')).unlinkSync as unknown as ReturnType<typeof vi.fn>
    unlinkMock.mockClear()

    // active 路径：session 存在（S3 迁移：delete 判定读 lifecycle 自持 Map——真
    // registerSession 注册 s1，不再 stub svc.getSession）
    const { svc } = makeMocks()
    const lifecycle2 = new SessionLifecycle(
      svc,
      { destroySession: vi.fn(async () => {}) } as unknown as IProcessManager,
      { getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })) } as unknown as IConfigStore,
      sessionStore,
      { record: vi.fn() } as unknown as WorkspaceService,
      {
        adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
        getMessageBus: () => null,
        broadcastGlobal: () => {},
        notifyMessageComplete: () => {},
      },
    )
    await lifecycle2.registerSession('s1', {} as unknown as IPiEngine, '/repo', 's1', '/tmp/s1.jsonl')

    await lifecycle2.delete('s1')

    // .preset.json 被 unlink
    const presetUnlink = unlinkMock.mock.calls.find(c => String(c[0]).endsWith('.preset.json'))
    expect(presetUnlink).toBeDefined()

    // 非 active 路径
    unlinkMock.mockClear()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's2', filePath: '/tmp/s2.jsonl', cwd: '/repo',
    })

    await lifecycle2.delete('s2')

    const presetUnlink2 = unlinkMock.mock.calls.find(c => String(c[0]).endsWith('.preset.json'))
    expect(presetUnlink2).toBeDefined()
  })
})

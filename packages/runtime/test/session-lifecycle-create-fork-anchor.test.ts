/**
 * session-lifecycle create / forkSession 特征锚定测试（复杂度债务偿还 W3 批）。
 *
 * 背景：create（原 cyclo 50）与 forkSession（原 cyclo 32）按处理阶段提取模块内私有
 * helper（行为保持重构）。本文件锚定重构涉及的高危分支——错误文案、safeDestroy 目标、
 * sidecar 落盘守卫（pi 延迟写入窗口零触碰 session 文件）、rekey、persistLabel、
 * fork 继承优先级——保证提取前后行为逐字节一致。
 *
 * 【时序锚定】create 绝不创建/触碰 pi session 文件本体（[HISTORICAL] EEXIST 事故，
 * 见 session-lifecycle.ts persistCreateBindings 头注释）：pi 异常未返回 sessionFile
 * （undefined）时全部 sidecar persist 零调用。V9-④ 根修（2026-09-08）：pi 延迟写入
 * 窗口（路径有值、.jsonl 未 flush）preset/project/agent 三绑定以 skipJsonlExistsGuard
 * 放行守卫直接落盘（create 是 preset/agent 的唯一持久化时机），model 写点语义不变
 *（A5b）。
 *
 * Mock 策略：fs / session-fork / session-file-utils(persistModelBinding) / pi-paths 全
 * vi.mock（无真实文件 IO）；svc/pm/configStore/sessionStore 注入 vi.fn mock。
 * 复用 session-lifecycle-preset.test.ts 的 mock 范式。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-create-fork-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  unlink: vi.fn(async () => {}),
}))

// session-fork：createForkedSessionFile + resolveEntryIdByTimestamp 双双可观察
const forkMock = vi.hoisted(() => ({
  createForkedSessionFile: vi.fn(async () => ({
    filePath: '/fake/sessions/forked.jsonl',
    sessionId: 'forked-id',
  })),
  resolveEntryIdByTimestamp: vi.fn(async () => 'resolved-entry-1'),
}))
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: forkMock.createForkedSessionFile,
  resolveEntryIdByTimestamp: forkMock.resolveEntryIdByTimestamp,
}))

// persistModelBinding 锚定 session-file-utils 路径 mock（与生产 import 锚点一致）
const sidecarMock = vi.hoisted(() => ({
  persistModelBinding: vi.fn(),
  cleanupMigrateResidues: vi.fn(),
}))
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    persistModelBinding: sidecarMock.persistModelBinding,
    cleanupMigrateResidues: sidecarMock.cleanupMigrateResidues,
  }
})

vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: () => '/fake/sessions',
}))

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'
import type { PresetResolution } from '../src/services/preset-service.js'

interface ClientOverrides {
  getState?: () => Promise<Record<string, unknown> | undefined>
  setSessionName?: (name: string) => Promise<unknown>
}

function makeEnv(opts: {
  /** createSession 产出的 client 形态（每次调用新建，clientMap 收集） */
  clientOverrides?: ClientOverrides
  /** registerSession 装配依赖 adapterFactory 抛错（触发 create 的 M3 catch） */
  adapterFactoryThrows?: boolean
  resolution?: PresetResolution | undefined
} = {}) {
  const clientMap = new Map<string, Record<string, unknown>>()
  // [W2 语义] 最近一次 switchSession 实参（真实 pi 行为：switch_session 永久重绑写目标）
  const lastSwitchTarget = { value: undefined as string | undefined }
  const makeClient = (): Record<string, unknown> => ({
    // getState 的 sessionFile 跟随最近一次 switchSession 实参——未切换过 = spawn 初值
    getState: vi.fn(opts.clientOverrides?.getState ?? (async () => ({
      sessionId: 'pi-s1',
      sessionFile: lastSwitchTarget.value ?? '/tmp/pi.jsonl',
    }))),
    switchSession: vi.fn(async (p: string) => { lastSwitchTarget.value = p }),
    setSessionName: vi.fn(opts.clientOverrides?.setSessionName ?? (async () => undefined)),
    prompt: vi.fn(async () => ({})),
  })

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => {}),
  } as unknown as IProcessManager

  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => opts.resolution),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active', lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
    })),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
  } as unknown as ISessionStore

  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => {
      if (opts.adapterFactoryThrows) throw new Error('init failed')
      return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
    },
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, svc, pm, sessionStore, workspaceService, clientMap, lastSwitchTarget }
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMock.existsSync.mockReturnValue(true)
  setMigrationGate(Promise.resolve())
})

describe('create 特征锚定（复杂度债务偿还 W3）', () => {
  it('A1: getState 抛错 → 「Failed to get session state from pi: <原因>」+ safeDestroy(tempId) + 不通知创建', async () => {
    const { lifecycle, pm, svc } = makeEnv({
      clientOverrides: { getState: async () => { throw new Error('rpc boom') } },
    })

    await expect(lifecycle.create('/repo', 'label')).rejects.toThrow('Failed to get session state from pi: rpc boom')
    // safeDestroy 目标是内部 tempId（错误发生在 rekey 之前，pi id 'pi-s1' 不可达）
    expect(pm.destroySession).toHaveBeenCalledTimes(1)
    expect(pm.destroySession).not.toHaveBeenCalledWith('pi-s1')
    // 错误路径不触发创建收敛点
    expect(svc.notifySessionCreated).not.toHaveBeenCalled()
  })

  it('A2: pi 未返回 sessionId → 「pi did not return a session ID」+ safeDestroy(tempId)', async () => {
    const { lifecycle, pm } = makeEnv({
      clientOverrides: { getState: async () => ({ sessionId: '', sessionFile: undefined }) },
    })

    await expect(lifecycle.create('/repo', 'label')).rejects.toThrow('pi did not return a session ID')
    expect(pm.destroySession).toHaveBeenCalledTimes(1)
  })

  it('A3: registerSession 失败（adapterFactory 抛错）→ 原错误 rethrow + safeDestroy 用 pi 真实 id（M3 僵尸进程防护）', async () => {
    const { lifecycle, pm } = makeEnv({ adapterFactoryThrows: true })

    await expect(lifecycle.create('/repo', 'label')).rejects.toThrow('init failed')
    // 清理目标是真实 pi id（已 rekey），不是 tempId
    expect(pm.destroySession).toHaveBeenCalledWith('pi-s1')
  })

  it('A4: pi 异常未返回 sessionFile（undefined）→ 全部 sidecar persist 零调用（无路径可落盘）', async () => {
    const { lifecycle, sessionStore } = makeEnv({
      clientOverrides: { getState: async () => ({ sessionId: 'pi-s1', sessionFile: undefined }) },
    })

    await lifecycle.create('/repo', 'label', {
      presetId: 'preset-1',
      projectId: 'proj-1',
      spawnSource: 'agent',
      parentAgentSessionId: 'pa-1',
    })

    // 时序锚定：sessionFilePath undefined（pi 异常）→ 第一层守卫跳过所有 sidecar 写点。
    // 注意与 pi 延迟写入窗口区分：窗口内路径有值、文件未 flush，V9-④ 根修后 preset/
    // project/agent 照常落盘（skipJsonlExistsGuard 放行，见 A5b）；本用例是「无路径」
    // 的异常时序，两层守卫（truthy 检查）语义保持。
    expect(sessionStore.persistPresetBinding).not.toHaveBeenCalled()
    expect(sessionStore.persistProjectBinding).not.toHaveBeenCalled()
    expect(sessionStore.persistAgentBinding).not.toHaveBeenCalled()
    expect(sidecarMock.persistModelBinding).not.toHaveBeenCalled()
    // 内存链路照常：refreshAll（scan 合并兜底）与创建通知不缺位
    expect(sessionStore.refreshAll).toHaveBeenCalled()
  })

  it('A5: sessionFile 已落盘 + projectId/spawnSource → persistProjectBinding / persistAgentBinding 精确传参', async () => {
    const { lifecycle, sessionStore } = makeEnv()

    await lifecycle.create('/repo', 'label', {
      projectId: 'proj-1',
      spawnSource: 'agent',
      parentAgentSessionId: 'pa-1',
    })

    expect(sessionStore.persistProjectBinding).toHaveBeenCalledWith('/tmp/pi.jsonl', 'proj-1', { skipJsonlExistsGuard: true })
    expect(sessionStore.persistAgentBinding).toHaveBeenCalledWith('/tmp/pi.jsonl', 'agent', 'pa-1', { skipJsonlExistsGuard: true })
  })

  it('A5b: V9-④ 根修——create 路径（sessionFilePath 有值）三绑定 persist 携 skipJsonlExistsGuard 放行 existsSync 守卫', async () => {
    const { lifecycle, sessionStore } = makeEnv()

    await lifecycle.create('/repo', 'label', {
      presetId: 'preset-1',
      projectId: 'proj-1',
      spawnSource: 'agent',
      parentAgentSessionId: 'pa-1',
    })

    // pi 延迟写入窗口（.jsonl 未 flush）：create 写点是 preset/agent 的唯一持久化时机
    //（无 turn-end 补偿），必须以 trusted create 语义放行守卫直接落盘，否则重启后
    // preset 绑定永久回退 builtin:full / agent badge 丢失。
    expect(sessionStore.persistPresetBinding).toHaveBeenCalledWith('/tmp/pi.jsonl', 'preset-1', { skipJsonlExistsGuard: true })
    expect(sessionStore.persistProjectBinding).toHaveBeenCalledWith('/tmp/pi.jsonl', 'proj-1', { skipJsonlExistsGuard: true })
    expect(sessionStore.persistAgentBinding).toHaveBeenCalledWith('/tmp/pi.jsonl', 'agent', 'pa-1', { skipJsonlExistsGuard: true })
    // model 写点不带 flag（有 turn-end tryPersistModelBinding 补偿，语义不变）；
    // 无 resolution / 无读回时生效值 undefined → `?? ''` 归一为空串
    expect(sidecarMock.persistModelBinding).toHaveBeenCalledWith('/tmp/pi.jsonl', '', '')
  })

  it('A6: persistLabel=true → setSessionName RPC 持久化；缺省（display-only 派生名）不调 RPC', async () => {
    const { lifecycle, clientMap } = makeEnv()

    await lifecycle.create('/repo', 'derived-preview', { persistLabel: true })
    // clientMap 键是 create 时的 tempId（rekey 只改 pm 内部键）——取唯一 client 断言
    const clientAfter = [...clientMap.values()][0] as { setSessionName: ReturnType<typeof vi.fn> }
    expect(clientAfter.setSessionName).toHaveBeenCalledWith('derived-preview')

    const env2 = makeEnv()
    await env2.lifecycle.create('/repo', 'derived-preview-2')
    const client2 = [...env2.clientMap.values()][0] as { setSessionName: ReturnType<typeof vi.fn> }
    expect(client2.setSessionName).not.toHaveBeenCalled()
  })

  it('A7: pi 真实 id ≠ tempId → pm.rekey(tempId, piId)（进程句柄重绑）', async () => {
    const { lifecycle, pm } = makeEnv({
      clientOverrides: { getState: async () => ({ sessionId: 'pi-real-1', sessionFile: undefined }) },
    })

    await lifecycle.create('/repo', 'label')
    expect(pm.rekey).toHaveBeenCalledTimes(1)
    const [oldId, newId] = (pm.rekey as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(newId).toBe('pi-real-1')
    expect(oldId).not.toBe('pi-real-1') // oldId 是内部 tempId（uuid 形态）
    // 注册进 Map 的键是真实 pi id
    expect(lifecycle.has('pi-real-1')).toBe(true)
  })
})

describe('forkSession 特征锚定（复杂度债务偿还 W3）', () => {
  function mockSource(svc: ILifecycleSessionOps, overrides: Record<string, unknown> = {}): void {
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'src', filePath: '/fake/src.jsonl', cwd: '/repo', name: 'src', launchPresetId: undefined,
      ...overrides,
    })
  }

  it('A8: fromPiEntryId 缺失 → 按 timestamp+role 解析（resolveEntryIdByTimestamp 收源文件路径与匹配参数）', async () => {
    const { lifecycle, svc, pm } = makeEnv()
    mockSource(svc)

    await lifecycle.forkSession('src', undefined, true, 'forked', {
      fromMessageTimestamp: 1723500000000,
      fromMessageRole: 'user',
    })

    expect(forkMock.resolveEntryIdByTimestamp).toHaveBeenCalledWith('/fake/src.jsonl', 1723500000000, 'user')
    // 解析出的 entryId 作为 fork 锚点贯穿 createForkedSessionFile（实参与 resolveEntryId 返回值一致）
    const forkArgs = forkMock.createForkedSessionFile.mock.calls[0] as unknown[]
    expect(forkArgs[1]).toBe('resolved-entry-1')
    expect(forkArgs[4]).toBe('resolved-entry-1')
    expect(pm.createSession).toHaveBeenCalledTimes(1)
  })

  it('A9: C-RL-6 优先级——options.modelOverride 覆盖 preset.modelOverride（Landing Chip > preset）', async () => {
    const resolution = {
      extensionPaths: [], skillPaths: [], toolArgs: {}, flags: {},
      modelOverride: 'preset-model', thinkingLevel: undefined,
    } as unknown as PresetResolution
    const { lifecycle, svc, pm } = makeEnv({ resolution })
    mockSource(svc)

    await lifecycle.forkSession('src', 'entry1', true, 'forked', { modelOverride: 'landing-model' })
    let opts = (pm.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>
    expect(opts.model).toBe('landing-model')

    // 无 override → 仅继承源 preset（旧行为）
    const env2 = makeEnv({ resolution })
    mockSource(env2.svc)
    await env2.lifecycle.forkSession('src', 'entry1', true, 'forked')
    opts = (env2.pm.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>
    expect(opts.model).toBe('preset-model')
  })

  it('A10: projectId 继承优先级——active 内存态 > 扫描 sidecar 值（W-RT-5 同模式）', async () => {
    const { lifecycle, svc, sessionStore } = makeEnv()
    mockSource(svc, { projectId: 'sidecar-proj' })
    // 源 session active 且内存态带 projectId（延迟写入窗口的内存兑底形态）
    await lifecycle.registerSession('src', {} as unknown as IPiEngine, '/repo', 'src')
    const record = lifecycle.get('src') as unknown as { projectId?: string }
    record.projectId = 'mem-proj'

    await lifecycle.forkSession('src', 'entry1', true, 'forked')
    expect(sessionStore.persistProjectBinding).toHaveBeenCalledWith('/fake/sessions/forked.jsonl', 'mem-proj')

    // 无 active（源未注册）→ fallback 扫描 sidecar 值
    const env2 = makeEnv()
    mockSource(env2.svc, { projectId: 'sidecar-proj' })
    await env2.lifecycle.forkSession('src', 'entry1', true, 'forked')
    expect(env2.sessionStore.persistProjectBinding).toHaveBeenCalledWith('/fake/sessions/forked.jsonl', 'sidecar-proj')
  })

  // ── D6 源生效值继承档（state-truth-sync C5 / ⛔ 探针 P4）──
  // 链 = `staging override > 源 session 当前生效值 > 源 preset > 全局默认`。
  // 源真值读取 = 活跃内存实例 meta > sidecar .model.json 扫描值（resolveForkSourceEffectiveBinding）。
  describe('D6 源生效值继承档（P4 三类源 + 继承档序）', () => {
    /** fork 一次并取 pi createSession options（第三参）。 */
    async function forkOnce(
      env: ReturnType<typeof makeEnv>,
      options?: { modelOverride?: string; thinkingOverride?: string },
    ): Promise<Record<string, unknown>> {
      await env.lifecycle.forkSession('src', 'entry1', true, 'forked', options)
      expect(env.pm.createSession).toHaveBeenCalledTimes(1)
      return (env.pm.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>
    }

    /** 注册活跃源实例并直写生效值（switchModel/setThinkingLevel 直写内存实例的形态）。 */
    async function registerActiveSource(
      env: ReturnType<typeof makeEnv>,
      meta: { modelId?: string; thinkingLevel?: string },
    ): Promise<void> {
      await env.lifecycle.registerSession('src', {} as unknown as IPiEngine, '/repo', 'src')
      const record = env.lifecycle.get('src') as unknown as { modelId?: string; thinkingLevel?: string }
      record.modelId = meta.modelId
      record.thinkingLevel = meta.thinkingLevel
    }

    it('P4① 活跃源（内存实例有 meta）→ 继承 modelId + thinkingLevel（spawn options + sidecar + hydrate 三面）', async () => {
      const env = makeEnv()
      mockSource(env.svc)
      await registerActiveSource(env, { modelId: 'mem/flash', thinkingLevel: 'high' })

      const opts = await forkOnce(env)

      // pi spawn options（override 档产物）
      expect(opts.model).toBe('mem/flash')
      expect(opts.thinkingLevel).toBe('high')
      // 目标 5 hydrate 持久化：sidecar .model.json 写点（attachForkedFile）+ 新 session meta
      //（registerSession modelOverride 播种，与 staging override 路径同构）
      expect(sidecarMock.persistModelBinding).toHaveBeenCalledWith('/fake/sessions/forked.jsonl', 'mem/flash', 'high')
      expect(env.lifecycle.get('forked-id')?.modelId).toBe('mem/flash')
      expect((env.lifecycle.get('forked-id') as unknown as { thinkingLevel?: string }).thinkingLevel).toBe('high')
    })

    it('P4② pi 已退出源（sidecar .model.json 存在且新鲜）→ 继承 sidecar 值', async () => {
      const env = makeEnv()
      // 无内存实例（源 pi 已退出/未恢复），source 来自 findScannedSession（含 .model.json 值）
      mockSource(env.svc, { modelId: 'side/flash', thinkingLevel: 'medium' })

      const opts = await forkOnce(env)

      expect(opts.model).toBe('side/flash')
      expect(opts.thinkingLevel).toBe('medium')
      expect(sidecarMock.persistModelBinding).toHaveBeenCalledWith('/fake/sessions/forked.jsonl', 'side/flash', 'medium')
    })

    it('P4③ 「切模→死→直接 fork」陈旧窗口源（sidecar 是旧值）→ 读到的就是旧值（D6 已接受代价，不修不挡）', async () => {
      // 场景：源切到 side/flash 后 pi 死亡（未 restore），sidecar 仍停留切模前旧值——
      // fork 不触发源 restore 自愈，读到旧值即继承旧值（残留风险 P4 声明内行为；
      // 恢复路径 = fork 后 chip 改选。严格优于现状：现状恒落 preset/默认档）
      const env = makeEnv()
      mockSource(env.svc, { modelId: 'stale/model', thinkingLevel: 'low' })

      const opts = await forkOnce(env)

      expect(opts.model).toBe('stale/model')
      expect(opts.thinkingLevel).toBe('low')
    })

    it('E9: 源真值不可读（无 sidecar 且实例不在内存）→ 回落源 preset 档（现行为，不劣化）', async () => {
      const resolution = {
        extensionPaths: [], skillPaths: [], toolArgs: {}, flags: {},
        modelOverride: 'preset-model', thinkingLevel: 'low',
      } as unknown as PresetResolution
      const env = makeEnv({ resolution })
      mockSource(env.svc) // 无 modelId/thinkingLevel（老会话无 sidecar）

      const opts = await forkOnce(env)

      expect(opts.model).toBe('preset-model')
      expect(opts.thinkingLevel).toBe('low')
    })

    it('档序: staging override > 源生效值——fork-ask 暂存值优先（ADR-0056 行为不变）', async () => {
      const env = makeEnv()
      mockSource(env.svc, { modelId: 'side/flash', thinkingLevel: 'high' })

      const opts = await forkOnce(env, { modelOverride: 'staging/m', thinkingOverride: 'low' })

      expect(opts.model).toBe('staging/m')
      expect(opts.thinkingLevel).toBe('low')
    })

    it('空串归一: 活跃实例 modelId 空串占位（restore 播种形态）不吞档——字段级回落 sidecar 扫描值', async () => {
      const env = makeEnv()
      mockSource(env.svc, { modelId: 'side/flash', thinkingLevel: 'medium' })
      await registerActiveSource(env, { modelId: '', thinkingLevel: undefined })

      const opts = await forkOnce(env)

      // ''/undefined 不得以 nullish 检查漏网短路吞掉 sidecar 档（nonEmptyStr 归一）
      expect(opts.model).toBe('side/flash')
      expect(opts.thinkingLevel).toBe('medium')
    })
  })
})

/**
 * session-lifecycle：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - session-lifecycle.test.ts
 *   - session-artifact-cascade.test.ts
 *   - session-lifecycle-rename-inactive.test.ts
 *   - session-lifecycle-thinking.test.ts
 *   - session-lifecycle-w11.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/session/__tests__/session-lifecycle.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, SessionSummary } from '@taiji/shared'
import { getSessionArtifactsDir } from '@taiji/shared/paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IConfigStore } from '../../ports/config.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import { CREATE_IDEMPOTENCY_MAX_ENTRIES, CREATE_IDEMPOTENCY_TTL_MS, CreateIdempotencyRegistry } from '../create-idempotency.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js'
import type { IManagedSessionView, ScannedSession } from '../types.js'


// ════════════════ 来源(主产物): session-lifecycle.test.ts ════════════════
/**
 * SessionLifecycle 合并测试（create 幂等 / label 持久化分流 / registerSession 三件套 /
 * surface 落地管道）。
 *
 * 来源（分节注释见内）：
 * - session-lifecycle-create-idempotency（create clientUuid 幂等 + CreateIdempotencyRegistry）
 * - session-lifecycle-create-label（create label 持久化分流 A'）
 * - session-lifecycle-register（registerSession 三件套 S3 写点归位）
 * - session-lifecycle-surface（W3 surface 落地 + §5-W3 完成判据④）
 *
 * 簇内其余成员（restore-seeding / item13-w5-behavior / deletebycwd / test 根
 * session-lifecycle）未并入：见 round5-g 执行报告复筛记录。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle.test.ts
 */

beforeEach(() => {
  vi.clearAllMocks()
})

// ════════════════ 来源: session-lifecycle-create-idempotency.test.ts ════════════════

/** 构造最小 create 环境：每次 spawn 产唯一 pi session id（建号数经 id 集合断言）。 */
function makeIdempotencyCreateEnv(opts?: { failGetStateOnce?: boolean }) {
  let seq = 0
  let failNextGetState = opts?.failGetStateOnce ?? false
  const setSessionName = vi.fn(async (_name: string) => ({ success: true }))
  const pm = {
    createSession: vi.fn(async () => {
      seq += 1
      const sid = `pi-sid-${seq}`
      return {
        exited: false,
        getState: vi.fn(async () => {
          if (failNextGetState) {
            failNextGetState = false
            throw new Error('get_state boom')
          }
          return { sessionId: sid, sessionFile: '/tmp/s.jsonl' }
        }),
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
      id: s.id, label: s.label, cwd: s.cwd, status: 'active' as const,
      lastActiveAt: 1,
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
  return { lifecycle, pm }
}

/** 供 registry 单元用的可辨识 summary。 */
function summaryOf(id: string): SessionSummary {
  return {
    id, label: 'L', cwd: '/w', status: 'idle',
    lastActiveAt: 1,
  }
}

describe('create clientUuid 幂等（发现 B，SessionLifecycle 集成）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('① 顺序重试：同 uuid 两次 create → 同一 session，只 spawn 一次、只建一号', async () => {
    const { lifecycle, pm } = makeIdempotencyCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'cidem-seq-'))

    const s1 = await lifecycle.create(cwd, 'L', { clientUuid: 'u-seq-1' })
    const s2 = await lifecycle.create(cwd, 'L', { clientUuid: 'u-seq-1' })

    expect(pm.createSession).toHaveBeenCalledTimes(1)
    expect(s2.id).toBe(s1.id)
    // 只建一号：sessions Map 恰含唯一 id（无重复/幽灵条目）
    expect([...lifecycle.keys()]).toEqual([s1.id])
  })

  it('① 并发 in-flight：同 uuid 双发 → 共用同一在途创建，只 spawn 一次', async () => {
    const { lifecycle, pm } = makeIdempotencyCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'cidem-conc-'))

    const [a, b] = await Promise.all([
      lifecycle.create(cwd, 'L', { clientUuid: 'u-conc-1' }),
      lifecycle.create(cwd, 'L', { clientUuid: 'u-conc-1' }),
    ])

    expect(pm.createSession).toHaveBeenCalledTimes(1)
    expect(a.id).toBe(b.id)
    expect([...lifecycle.keys()]).toEqual([a.id])
  })

  it('② 不同 uuid / 无 uuid → 各自独立创建（回归：uuid 缺省行为与旧版一致）', async () => {
    const { lifecycle, pm } = makeIdempotencyCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'cidem-distinct-'))

    const a = await lifecycle.create(cwd, 'L', { clientUuid: 'u-a' })
    const b = await lifecycle.create(cwd, 'L', { clientUuid: 'u-b' })
    const c = await lifecycle.create(cwd, 'L')
    const d = await lifecycle.create(cwd, 'L')

    expect(pm.createSession).toHaveBeenCalledTimes(4)
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4)
    expect([...lifecycle.keys()]).toHaveLength(4)
  })

  it('③ TTL 过期后同 uuid 再来 → 新建（回收策略生效）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { lifecycle, pm } = makeIdempotencyCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'cidem-ttl-'))

    const s1 = await lifecycle.create(cwd, 'L', { clientUuid: 'u-ttl-1' })
    // TTL 内重试仍复用（保留期生效的另一半）
    const reused = await lifecycle.create(cwd, 'L', { clientUuid: 'u-ttl-1' })
    expect(reused.id).toBe(s1.id)
    expect(pm.createSession).toHaveBeenCalledTimes(1)

    // 越过 TTL（惰性 sweep 在下一次 run 触发）
    vi.setSystemTime(Date.now() + CREATE_IDEMPOTENCY_TTL_MS + 1_000)
    const s2 = await lifecycle.create(cwd, 'L', { clientUuid: 'u-ttl-1' })

    expect(pm.createSession).toHaveBeenCalledTimes(2)
    expect(s2.id).not.toBe(s1.id)
  })

  it('补：create 失败即清登记——同 uuid 重试重新创建（失败不缓存）', async () => {
    const { lifecycle, pm } = makeIdempotencyCreateEnv({ failGetStateOnce: true })
    const cwd = mkdtempSync(join(tmpdir(), 'cidem-fail-'))

    await expect(lifecycle.create(cwd, 'L', { clientUuid: 'u-fail-1' })).rejects.toThrow(
      'Failed to get session state from pi',
    )
    // 失败分支 safeDestroy 清场（错误清理路径，M3/readBackCreateState 契约）
    expect(pm.destroySession).toHaveBeenCalledTimes(1)

    const s = await lifecycle.create(cwd, 'L', { clientUuid: 'u-fail-1' })
    expect(pm.createSession).toHaveBeenCalledTimes(2)
    expect(s.id).toBe('pi-sid-2')
    expect([...lifecycle.keys()]).toEqual(['pi-sid-2'])
  })
})

describe('CreateIdempotencyRegistry 回收策略（登记清单有界）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('in-flight 共用同一 Promise（exec 恰一次），落定后 TTL 内复用', async () => {
    const registry = new CreateIdempotencyRegistry()
    let resolveExec!: (s: SessionSummary) => void
    const exec = vi.fn(
      () => new Promise<SessionSummary>((resolve) => { resolveExec = resolve }),
    )

    const p1 = registry.run('k1', exec)
    const p2 = registry.run('k1', exec)
    expect(exec).toHaveBeenCalledTimes(1)
    resolveExec(summaryOf('s1'))
    // 同一 Promise 实例（不只是等值结果）
    expect(p2).toBe(p1)
    await expect(p1).resolves.toEqual(summaryOf('s1'))
    expect(registry.size).toBe(1)
  })

  it('失败即清：reject 后登记移除，同 key 重试执行新创建', async () => {
    const registry = new CreateIdempotencyRegistry()
    const failing = vi.fn(() => Promise.reject(new Error('spawn boom')))

    await expect(registry.run('k2', failing)).rejects.toThrow('spawn boom')
    expect(registry.size).toBe(0)

    const ok = vi.fn(() => Promise.resolve(summaryOf('s2')))
    await expect(registry.run('k2', ok)).resolves.toEqual(summaryOf('s2'))
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期清扫：成功记录超 TTL 后下次 run 重新执行（惰性回收）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const registry = new CreateIdempotencyRegistry()
    const exec = vi.fn(() => Promise.resolve(summaryOf('s3')))

    await registry.run('k3', exec)
    expect(registry.size).toBe(1)

    vi.setSystemTime(Date.now() + CREATE_IDEMPOTENCY_TTL_MS + 1)
    await registry.run('k3', exec)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(registry.size).toBe(1)
  })

  it('容量上限：超 MAX_ENTRIES 驱逐最老（Map 插入序），被驱逐 key 重试退化为新建', async () => {
    const registry = new CreateIdempotencyRegistry()
    const exec = vi.fn(() => Promise.resolve(summaryOf('s')))

    for (let i = 0; i < CREATE_IDEMPOTENCY_MAX_ENTRIES + 1; i++) {
      await registry.run(`k-${i}`, exec)
    }
    expect(registry.size).toBe(CREATE_IDEMPOTENCY_MAX_ENTRIES)

    // 最老（k-0）已被驱逐 → 重新执行；最新（k-MAX）仍在 → 命中缓存不再执行
    const callsBefore = exec.mock.calls.length
    await registry.run('k-0', exec)
    expect(exec.mock.calls.length).toBe(callsBefore + 1)
    await registry.run(`k-${CREATE_IDEMPOTENCY_MAX_ENTRIES}`, exec)
    expect(exec.mock.calls.length).toBe(callsBefore + 1)
  })
})

// ════════════════ 来源: session-lifecycle-create-label.test.ts ════════════════

/** 构造最小 create 环境：pi client 只需 getState/setSessionName，svc mock 全链路。 */
function makeLabelCreateEnv() {
  const setSessionName = vi.fn(async (_name: string) => ({ success: true }))
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-sid-1', sessionFile: '/tmp/s.jsonl' })),
    setSessionName,
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  // S2 ISP 化：结构性满足 lifecycle 窄接口，无强转；getExtensionPaths 改 async /
  // toSummary 补必填字段系消强转后暴露的形状修复。S3 写点归位：注册走真
  // registerSession（svc.initializeManagedSession 已从接口移除）。
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    toSummary: vi.fn(() => ({
      id: 'pi-sid-1', label: 'L', cwd: '/w', status: 'active' as const,
      lastActiveAt: 1, modelId: 'prov/model', tokenCount: 0,
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

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, setSessionName }
}

describe('SessionLifecycle.create label 持久化分流（A\')', () => {
  it('A\' 核心：默认（前端派生预览名）不调 setSessionName，预览名只进内存 label（display-only）', async () => {
    const { lifecycle, setSessionName } = makeLabelCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-create-'))

    await lifecycle.create(cwd, '修复登录bu…')

    // 持久化零调用——pi 内存 sessionName 保持空，auto-rename 防覆盖检查照常通过
    expect(setSessionName).not.toHaveBeenCalled()
    // display 不回归：内存 session.label 仍是预览名（侧栏当前会话显示不变）。
    // S3 迁移：断言观察点从 svc.initializeManagedSession 传参随迁为真 registerSession
    // 的注册结果（Map 记录字段），断言语义不变。
    const session = lifecycle.get('pi-sid-1')
    expect(session?.label).toBe('修复登录bu…')
    expect(session?.cwd).toBe(cwd)
    expect(session?.sessionFilePath).toBe('/tmp/s.jsonl')
  })

  it('persistLabel=true（handoff/agent-managed 语义名）→ setSessionName(label) 恰调一次', async () => {
    const { lifecycle, setSessionName } = makeLabelCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-persist-'))

    await lifecycle.create(cwd, 'handoff from src', { persistLabel: true })

    expect(setSessionName).toHaveBeenCalledTimes(1)
    expect(setSessionName).toHaveBeenCalledWith('handoff from src')
  })

  it('persistLabel=true 但 label undefined → no-op（agent 未传 label 的 managed session）', async () => {
    const { lifecycle, setSessionName } = makeLabelCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-nolabel-'))

    await lifecycle.create(cwd, undefined, { persistLabel: true })

    expect(setSessionName).not.toHaveBeenCalled()
  })

  it('setSessionName RPC reject → 不阻断 create（best-effort 降级，label 留内存显示）', async () => {
    const { lifecycle, setSessionName } = makeLabelCreateEnv()
    setSessionName.mockRejectedValueOnce(new Error('rpc down'))
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-rpcfail-'))

    const summary = await lifecycle.create(cwd, 'handoff from src', { persistLabel: true })

    expect(setSessionName).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ id: 'pi-sid-1' })
  })
})

// ════════════════ 来源: session-lifecycle-register.test.ts ════════════════

function makeRegisterTestEnv() {
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
  const pm = {} as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {} as unknown as ISessionStore
  const workspaceService = {} as unknown as WorkspaceService

  const attach = vi.fn()
  const detach = vi.fn()
  let capturedSend: ((msg: ServerMessage) => void) | undefined
  const adapterFactory = vi.fn((_id: string, send: (msg: ServerMessage) => void) => {
    capturedSend = send
    return { attach, detach } as unknown as IEventAdapter
  })
  const busPublish = vi.fn()
  const broadcastGlobal = vi.fn()
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory,
    getMessageBus: () => ({ publish: busPublish }) as never,
    broadcastGlobal,
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return {
    lifecycle, svc, configStore, attach, detach, adapterFactory,
    busPublish, broadcastGlobal,
    getSend: () => capturedSend,
    client: {} as unknown as IPiEngine,
  }
}

describe('SessionLifecycle.registerSession（S3 写点归位）', () => {
  it('注册成功：构造完整 session 记录（含 adapter 句柄 + modelOverride 优先）并返回', async () => {
    const env = makeRegisterTestEnv()
    const session = await env.lifecycle.registerSession(
      's1', env.client, '/repo', '测试', '/repo/s1.jsonl', 'parent-1', 'entry-9', 'ov/m1',
    )
    expect(session).toMatchObject({
      id: 's1', cwd: '/repo', label: '测试', modelId: 'ov/m1',
      sessionFilePath: '/repo/s1.jsonl', surface: 'sidebar',
      parentSession: 'parent-1', forkEntryId: 'entry-9',
    })
    expect(session.adapter).toBeDefined()
    // adapter 经 adapterFactory 装配并 attach（#8 G1：cwd 透传工厂）
    expect(env.adapterFactory).toHaveBeenCalledWith('s1', expect.any(Function), '/repo')
    expect(env.attach).toHaveBeenCalledWith(env.client)
  })

  it('注册成功：无 modelOverride 时 fallback configStore 默认模型', async () => {
    const env = makeRegisterTestEnv()
    const session = await env.lifecycle.registerSession('s2', env.client, '/repo', 't')
    expect(session.modelId).toBe('p/m')
  })

  it('Map 写入：ISessionRegistry 只读侧（get/has/keys/values）可见新条目', async () => {
    const env = makeRegisterTestEnv()
    await env.lifecycle.registerSession('s3', env.client, '/repo', 't')
    expect(env.lifecycle.has('s3')).toBe(true)
    expect(env.lifecycle.get('s3')?.id).toBe('s3')
    expect(Array.from(env.lifecycle.keys())).toEqual(['s3'])
    expect(Array.from(env.lifecycle.values()).map((s) => s.id)).toEqual(['s3'])
  })

  it('onSessionRegistered 同步直发：sessions.set 先于扇出，无 microtask 延迟', async () => {
    const env = makeRegisterTestEnv()
    let visibleDuringEmit: boolean | undefined
    env.lifecycle.onSessionRegistered((id) => {
      // 订阅者执行时 Map 条目已写入（set → emit 顺序）且未延迟到微任务
      visibleDuringEmit = env.lifecycle.has(id)
    })
    // 刻意不 await：同步直发 = registerSession 返回的 promise 落定前扇出已完成
    const pending = env.lifecycle.registerSession('s4', env.client, '/repo', 't')
    expect(visibleDuringEmit).toBe(true)
    await pending
  })

  it('onSessionRegistered 多订阅者按注册顺序扇出', async () => {
    const env = makeRegisterTestEnv()
    const order: string[] = []
    env.lifecycle.onSessionRegistered(() => { order.push('first') })
    env.lifecycle.onSessionRegistered(() => { order.push('second') })
    await env.lifecycle.registerSession('s5', env.client, '/repo', 't')
    expect(order).toEqual(['first', 'second'])
  })

  it('扇出异常直接传播：订阅者 throw → registerSession reject，中断后续订阅者，Map 条目已写入', async () => {
    const env = makeRegisterTestEnv()
    env.lifecycle.onSessionRegistered(() => { throw new Error('subscriber boom') })
    const after = vi.fn()
    env.lifecycle.onSessionRegistered(after)

    await expect(env.lifecycle.registerSession('s6', env.client, '/repo', 't')).rejects.toThrow('subscriber boom')

    // 不设异常隔离：第一个订阅者异常中断后续（顺序调用语义，与迁移前 Facade 体内
    // registerReplicatedStates → ensureRecordEntriesCache 顺序调用等价）
    expect(after).not.toHaveBeenCalled()
    // sessions.set 先于扇出（迁移前行为：内联注册序列抛错时 Map 已写入）
    expect(env.lifecycle.has('s6')).toBe(true)
  })

  it('send 闭包窄依赖：带 sid payload 走 bus publish，无 sid 走 broadcastGlobal 兜底', async () => {
    const env = makeRegisterTestEnv()
    await env.lifecycle.registerSession('s7', env.client, '/repo', 't')
    const send = env.getSend()
    expect(send).toBeDefined()

    const withSid: ServerMessage = { type: 'message.delta', payload: { sessionId: 's7' } } as unknown as ServerMessage
    send!(withSid)
    expect(env.busPublish).toHaveBeenCalledWith('s7', withSid)
    // send 闭包自身不触达 broadcastGlobal（带 sid 走 publish）。注：registerSession 汇聚点
    // 原 session.surfaces 全局广播（W4a 判别器通道）已随 W4b 收编按协议收缩删除——
    // 抑制类判别改读 session.list {surface:'btw'} 拉取缓存（设计 §5-W4b 四步之③）。
    expect(env.broadcastGlobal.mock.calls).toEqual([])

    const noSid: ServerMessage = { type: 'message.delta', payload: {} } as unknown as ServerMessage
    send!(noSid)
    expect(env.broadcastGlobal).toHaveBeenCalledWith(noSid)
  })

  it('removeEntry 纯删除：Map 条目消失，不触发任何订阅/通知', async () => {
    const env = makeRegisterTestEnv()
    const registered = vi.fn()
    env.lifecycle.onSessionRegistered(registered)
    await env.lifecycle.registerSession('s9', env.client, '/repo', 't')
    registered.mockClear()

    env.lifecycle.removeEntry('s9')

    expect(env.lifecycle.has('s9')).toBe(false)
    expect(env.svc.removeSessionEntry).not.toHaveBeenCalled() // 销毁 9 步编排不经此处
    expect(registered).not.toHaveBeenCalled() // 纯删除不发事件（设计 D2② 第 ② 步）
  })

  it('clear 纯清空（destroyAll shutdown 路径）：不触发订阅、不触发 dispose 通知', async () => {
    const env = makeRegisterTestEnv()
    const registered = vi.fn()
    env.lifecycle.onSessionRegistered(registered)
    await env.lifecycle.registerSession('s10', env.client, '/repo', 't')
    await env.lifecycle.registerSession('s11', env.client, '/repo', 't')
    registered.mockClear()

    env.lifecycle.clear()

    expect(Array.from(env.lifecycle.keys())).toEqual([])
    expect(registered).not.toHaveBeenCalled()
  })
})

// ════════════════ 来源: session-lifecycle-surface.test.ts ════════════════

function makeSurfaceRegisterEnv() {
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
function makeSurfaceCreateEnv() {
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

describe('W3 surface 落地：registerSession 尾部参数（不动既有位置参数顺序）', () => {
  it('缺省 surface → 记录 surface=sidebar（主会话默认态）', async () => {
    const { lifecycle, client } = makeSurfaceRegisterEnv()
    const session = await lifecycle.registerSession('s-default', client, '/repo', 't')
    expect(session.surface).toBe('sidebar')
    // ISessionRegistry 只读侧回读（W5 :649 判据切换后的取数形态预演）
    expect(lifecycle.get('s-default')?.surface).toBe('sidebar')
  })

  it('显式传 btw → 记录 surface=btw', async () => {
    const { lifecycle, client } = makeSurfaceRegisterEnv()
    const session = await lifecycle.registerSession(
      'line-1', client, '/repo', 't', '/repo/line-1.jsonl',
      undefined, undefined, undefined, undefined, undefined, 'btw',
    )
    expect(session.surface).toBe('btw')
    expect(lifecycle.get('line-1')).toMatchObject({ surface: 'btw' })
  })

  it('既有 10 位置参数调用形态不受影响（W5 hidden 形参删除后尾部缺省 = sidebar）', async () => {
    const { lifecycle, client } = makeSurfaceRegisterEnv()
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
    const { lifecycle } = makeSurfaceCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w3-surface-create-'))

    const summary = await lifecycle.create(cwd, 't')

    expect(summary.id).toMatch(/^pi-sid-/)
    // §5-W3 ④：runtime 层 create 后回读注册表记录断言 surface === 'sidebar'
    expect(lifecycle.get(summary.id)?.surface).toBe('sidebar')
  })

  it('createNew(cwd, label, { surface: "btw" }) → 管道透传到注册表记录（W5 :649 取数来源）', async () => {
    const { lifecycle } = makeSurfaceCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w3-surface-btw-'))

    const summary = await lifecycle.create(cwd, 't', { surface: 'btw' })

    expect(lifecycle.get(summary.id)?.surface).toBe('btw')
  })

  it('验收项 13 三态：createNew 工作区历史判据（:649 切 surface === "sidebar" 后）', async () => {
    const { lifecycle, workspaceService } = makeSurfaceCreateEnv()
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
    const { lifecycle, workspaceService } = makeSurfaceCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'w5-workspace-source-'))

    // 注册后记录由 registerSession 管道保证有值：create 缺省 'sidebar' → 记录工作区历史。
    // 若误改为读 options?.surface，本用例（生产主路径不传 options.surface）会静默停记。
    const summary = await lifecycle.create(cwd, 't')
    expect(lifecycle.get(summary.id)?.surface).toBe('sidebar')
    expect(workspaceService.record).toHaveBeenCalledWith(cwd)
  })
})

// ════════════════ 来源: session-artifact-cascade.test.ts ════════════════
describe('session-artifact-cascade', () => {
  /**
   * 删会话产物目录随整树回收单测（chat-html-support §6.7 D7 回收① / §8.2 S8⑥）。
   *
   * 锁定：`SessionLifecycle.delete`（scanned 分支）删除后，产物目录
   * `<root>/<sessionId>/artifacts/`（session 存储树域 2，shared `getSessionArtifactsDir`
   * 公式推导）随整树软删（trashSessionTree）不再存在于数据目录；重复删除幂等不抛。
   *
   * 形态对齐 `src/__tests__/session-file-utils-sidecar.test.ts` 的 delete 驱动 harness
   * （trash mock，真实驱动生命周期删链）。产物目录经 shared 公式推导落在 globalSetup
   * 固定的 tmp 数据目录内（仓规测试红线：禁触碰真实数据目录）。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-artifact-cascade.test.ts
   */

  /** 唯一 sessionId（文件名形态 `<sid>.jsonl`，解析值 = 全名 → 产物目录名可预期）。 */
  function uniqueSid(): string {
    return 'artifactcascade' + Math.random().toString(36).slice(2, 10)
  }

  function makeLifecycle(sid: string, filePath: string, cwd: string): SessionLifecycle {
    const svc = {
      findScannedSession: vi.fn(() => ({
        id: sid,
        filePath,
        cwd,
        timestamp: new Date().toISOString(),
        name: 'test',
        outcome: null,
        lastModified: Date.now(),
        size: 100,
      })),
      removeSessionEntry: vi.fn(),
    } as unknown as ILifecycleSessionOps
    const sessionStore = {
      trash: vi.fn(async () => {}),
      // 整树软删 port（D5）：mock 以 rmSync 模拟「目录移入废纸篓」的盘上终态——本测试锚定
      // 「删会话后产物目录不在盘上」；trash 落点语义（废纸篓可恢复）归 infra trash 通道自身覆盖。
      trashDirectory: vi.fn(async (dirPath: string) => {
        rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }),
      invalidateMetaCache: vi.fn(),
      invalidateScanCache: vi.fn(),
      refreshAll: vi.fn(),
    } as unknown as ISessionStore
    const registerDeps = {
      adapterFactory: vi.fn(),
      getMessageBus: vi.fn(() => null),
      broadcastGlobal: vi.fn(),
    } as unknown as ISessionRegisterDeps
    return new SessionLifecycle(
      svc,
      {} as unknown as IProcessManager,
      {} as unknown as IConfigStore,
      sessionStore,
      {} as unknown as WorkspaceService,
      registerDeps,
    )
  }

  /**
   * 级联删除用例骨架：建 tmp 会话文件 + （seedArtifactDir 时）产物目录树 → 断言种子在位 →
   * 驱动 `SessionLifecycle.delete` → 用例断言 → finally 双清理（workDir + 产物目录）。
   * 产物目录经 shared 公式推导（globalSetup 固定的 tmp 数据目录内，不触真实数据目录）。
   */
  async function withCascadeFixture(
    seedArtifactDir: boolean,
    run: (ctx: { sid: string; filePath: string; artifactDir: string; lifecycle: SessionLifecycle }) => Promise<void>,
  ): Promise<void> {
    const sid = uniqueSid()
    const workDir = mkdtempSync(join(tmpdir(), 'taiji-artifact-cascade-'))
    const filePath = join(workDir, `${sid}.jsonl`)
    writeFileSync(filePath, '{"type":"session"}\n')
    const artifactDir = getSessionArtifactsDir(sid)
    if (seedArtifactDir) {
      mkdirSync(join(artifactDir, 'assets'), { recursive: true })
      writeFileSync(join(artifactDir, 'report.html'), '<html/>')
      writeFileSync(join(artifactDir, 'assets', 'app.js'), 'console.log(1)')
      expect(existsSync(artifactDir)).toBe(true)
    }

    try {
      const lifecycle = makeLifecycle(sid, filePath, workDir)
      await run({ sid, filePath, artifactDir, lifecycle })
    } finally {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(artifactDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  describe('SessionLifecycle.delete —— 产物目录随整树回收', () => {
    it('删会话 → 存储树内 `<root>/<sid>/artifacts/` 消失（随整树软删）', async () => {
      await withCascadeFixture(true, async ({ sid, artifactDir, lifecycle }) => {
        await lifecycle.delete(sid)
        expect(existsSync(artifactDir)).toBe(false)
      })
    })

    it('重复删除幂等：产物目录已不存在时 delete 不抛', async () => {
      await withCascadeFixture(false, async ({ sid, artifactDir, lifecycle }) => {
        await lifecycle.delete(sid) // 首次：目录本就不存在（幂等 no-op）
        await lifecycle.delete(sid) // 再次：仍不抛
        expect(existsSync(artifactDir)).toBe(false)
      })
    })
  })
});

// ════════════════ 来源: session-lifecycle-rename-inactive.test.ts ════════════════
describe('session-lifecycle-rename-inactive', () => {
  /**
   * SessionLifecycle.renameSession 非活跃分支（p1p4-closure W1：D3 未命中 throw +
   * findings #4 死 cwd 降级）测试。
   *
   * Mock 策略沿用 session-lifecycle-gate.test.ts 的 makeEnv 形态：svc/pm/sessionStore
   * 全 mock，直接 new SessionLifecycle。pm.withEphemeralPi mock 在「附着瞬间」（fn 执行前）
   * 读目标文件——归一化（若有）必须已发生在附着前，据此断言附着时看到的文件状态。
   * 真实 spawn/RPC 行为归 process-manager-ephemeral.test.ts 与 P1 行为级验收，此处锁
   * renameSession 的编排契约：
   * - 未命中（findScannedSession undefined）→ reject，错误含 sessionId 与恢复指引（D3）
   * - 死 cwd fixture → 附着前归一化：header cwd → homedir、session_end strip、路径不变
   * - 正常 fixture（cwd 活、无 session_end）→ 零变换：附着时字节与 mtime 不变
   *
   * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-rename-inactive.test.ts
   */

  /**
   * 构造最小 lifecycle 环境（renameSession 非活跃分支路径）：svc 只需
   * findScannedSession；pm 只需 withEphemeralPi（附着瞬间读文件供断言）。
   */
  function makeEnv(scanned?: ScannedSession) {
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费方），无强转。
    // 本测试路径只真实消费 findScannedSession，其余空 vi.fn 仅为满足接口侧
    const svc: ILifecycleSessionOps = {
      findScannedSession: vi.fn(() => scanned ?? undefined),
      toSummary: vi.fn(),
      getSkillPaths: vi.fn(),
      getExtensionPaths: vi.fn(),
      getReplaceSystemPrompt: vi.fn(),
      getLaunchPresetOptions: vi.fn(),
      fetchAndBroadcastContext: vi.fn(),
      removeSessionEntry: vi.fn(),
      notifySessionCreated: vi.fn(),
      getActiveSummaries: vi.fn(),
    }
    const setSessionName = vi.fn(async (_name: string) => ({ success: true }))
    let attachedContent: string | null = null
    const withEphemeralPi = vi.fn(async (sessionFile: string, fn: (client: unknown) => Promise<unknown>) => {
      // 附着瞬间快照：归一化（若发生）必须已落盘，此处看到的即 pi 将附着的文件状态
      attachedContent = readFileSync(sessionFile, 'utf-8')
      return fn({ setSessionName })
    })
    const pm = { withEphemeralPi } as unknown as IProcessManager
    const configStore = {} as unknown as IConfigStore
    const sessionStore = {
      refreshAll: vi.fn(),
      invalidateScanCache: vi.fn(),
    } as unknown as ISessionStore
    const workspaceService = {} as unknown as WorkspaceService

    // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
    // 装配依赖注入 fake adapterFactory。
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
      getMessageBus: () => null,
      broadcastGlobal: () => {},
    }

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
    return { svc, lifecycle, withEphemeralPi, setSessionName, getAttachedContent: () => attachedContent }
  }

  /** 写最小 session JSONL fixture（header + 一条 user message，可选尾部 session_end 行）。 */
  function writeFixture(dir: string, cwd: string, opts?: { sessionEnd?: boolean }): string {
    const filePath = join(dir, 's-rename.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 's-rename', timestamp: '2026-08-19T01:00:00.000Z', cwd }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-19T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    ]
    if (opts?.sessionEnd) {
      lines.push(JSON.stringify({ type: 'session_end', timestamp: '2026-08-19T01:00:02.000Z' }))
    }
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  function makeScanned(cwd: string, filePath: string): ScannedSession {
    return { id: 's-rename', cwd, filePath, name: null, launchPresetId: undefined } as ScannedSession
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('SessionLifecycle.renameSession 非活跃分支（p1p4-closure W1）', () => {
    it('D3：findScannedSession 未命中 → reject，错误含 sessionId 字面值与恢复指引，不附着', async () => {
      const { lifecycle, withEphemeralPi } = makeEnv()

      await expect(lifecycle.renameSession('s-missing', 'new-name'))
        .rejects.toThrow(/s-missing/)
      await expect(lifecycle.renameSession('s-missing', 'new-name'))
        .rejects.toThrow(/refresh the sidebar and verify the session still exists/)
      expect(withEphemeralPi).not.toHaveBeenCalled()
    })

    it('findings #4：死 cwd fixture → 附着前归一化（header cwd → homedir、session_end strip），附着原路径且无新文件，setSessionName 被调', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'w1-rename-deadcwd-'))
      // 死 cwd：不 mkdir 的子路径（模拟 worktree 清理后残留 header）
      const deadCwd = join(dir, 'gone-worktree')
      const filePath = writeFixture(dir, deadCwd, { sessionEnd: true })
      const beforeFiles = readdirSync(dir).sort()
      const { lifecycle, withEphemeralPi, setSessionName, getAttachedContent } = makeEnv(makeScanned(deadCwd, filePath))

      await lifecycle.renameSession('s-rename', 'renamed-name')

      // 附着瞬间（归一化后）文件状态：header cwd 归一化为 homedir、session_end 已剔除、正文保留
      const attached = getAttachedContent()
      expect(attached).not.toBeNull()
      const header = JSON.parse((attached as string).split('\n')[0])
      expect(header.cwd).toBe(homedir())
      expect(attached).not.toContain('session_end')
      expect(attached).toContain('"u1"')
      // 附着目标 = 原文件路径；目录内无新文件产生（tmp-migrate 临时名已被 rename-over 消费）
      expect(withEphemeralPi).toHaveBeenCalledTimes(1)
      expect(withEphemeralPi.mock.calls[0][0]).toBe(filePath)
      expect(readdirSync(dir).sort()).toEqual(beforeFiles)
      // mock 链路等价断言：RPC 以新名在附着的 client 上执行
      expect(setSessionName).toHaveBeenCalledTimes(1)
      expect(setSessionName).toHaveBeenCalledWith('renamed-name')
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('正常 fixture（cwd 活、无 session_end）→ 零变换：附着时与完成后文件字节、mtime 均不变', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'w1-rename-normal-'))
      const filePath = writeFixture(dir, dir)
      const before = readFileSync(filePath)
      const beforeMtime = statSync(filePath).mtimeMs
      const { lifecycle, setSessionName, getAttachedContent } = makeEnv(makeScanned(dir, filePath))

      await lifecycle.renameSession('s-rename', 'renamed-name')

      // 附着瞬间零变换：pi 将附着的文件与 fixture 字节一致
      expect(getAttachedContent()).toBe(before.toString('utf-8'))
      // 完成后仍未被改写（无归一化写盘、mock 链路不写文件）
      expect(readFileSync(filePath).equals(before)).toBe(true)
      expect(statSync(filePath).mtimeMs).toBe(beforeMtime)
      expect(setSessionName).toHaveBeenCalledTimes(1)
      expect(setSessionName).toHaveBeenCalledWith('renamed-name')
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
  })
});

// ════════════════ 来源: session-lifecycle-thinking.test.ts ════════════════
describe('session-lifecycle-thinking', () => {
  /**
   * SessionLifecycle thinking 值域校验测试（W2 值域 SSOT 派生，A-03 回归）。
   *
   * 锁定三条语义：
   * - VALID_THINKING_LEVELS = shared PI_THINKING_LEVELS 全集（7 值含 'max'）——
   *   'max' 必须通过校验并透传到 spawn 参数（A-03：曾缺 max 被 silent drop，
   *   composer 最高档实际永不生效）。
   * - 全集任一值经 create → pm.createSession options.thinkingLevel 原样透传。
   * - 非法值 warn 后丢弃（不透传 thinkingLevel 字段）——pi 对非法 --thinking 不报错
   *   （仅 warning diagnostic 后照常以缺省档启动），非法档位必须在宿主入口层拦下。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-thinking.test.ts
   */

  function makeSummary(id: string): SessionSummary {
    return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now() }
  }

  function makeEnv() {
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费方），无强转
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

    it('非法值 warn 后丢弃（spawn 参数无 thinkingLevel 字段；pi 不报错故必须在宿主拦）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { lifecycle, createSession } = makeEnv()
        const cwd = mkdtempSync(join(tmpdir(), 'w2-think-bogus-'))
        await lifecycle.create(cwd, 't', { thinkingOverride: 'ultra' })
        const options = createSession.mock.calls[0][2] as { thinkingLevel?: string }
        expect(options.thinkingLevel).toBeUndefined()
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ultra'))
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      } finally {
        warnSpy.mockRestore()
      }
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
});

// ════════════════ 来源: session-lifecycle-w11.test.ts ════════════════
describe('session-lifecycle-w11', () => {
  /**
   * SessionLifecycle.restoreSession 的 cwd fallback 落点测试（W11 引入，W1 语义变更）。
   *
   * [W1 语义变更：直附着正式文件]（restore-fork-attach-fix）：原「读源文件 → strip →
   * 对 tmp 首行 header 应用 fallback → 写 $TMPDIR → switchSession(tmp) → unlink tmp」
   * 管线已整体删除——pi switch_session 永久重绑读写目标（pi-mono session-manager.ts
   * setSessionFile），附着 tmp 后每轮写按路径重建的 tmp 孤儿文件，原会话文件永不更新。
   *
   * 现行语义（F2/F3 分流）：
   * - cwd 活 + 无 session_end 行（F2）：switchSession 直接收 target.filePath，源文件零写
   * - cwd 死路径（F3）：spawn cwd 降级 homedir + 原文件被原地归一化——首行 header.cwd
   *   持久化为 homedir（W11「源文件 header 永久保持旧 cwd」声明已被 W1 取代）
   * - cwd 死 + 含 session_end 行（F3）：strip 与 cwd fallback 两种变换都发生在原文件上
   *
   * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-w11.test.ts
   */


  function makeSummary(id: string): SessionSummary {
    return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now() }
  }

  /** switchSession mock：记录 pi 实际收到的附着路径（W1 后 = 原文件路径本身）。 */
  function makeEnv() {
    const switchCalls: string[] = []
    const client = {
      getState: vi.fn(async () => ({ sessionId: 's-1' })),
      switchSession: vi.fn(async (sessionPath: string) => {
        switchCalls.push(sessionPath)
      }),
    }
    // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
    // 装配依赖注入 fake adapterFactory。
    const svc: ILifecycleSessionOps = {
      getExtensionPaths: vi.fn(async () => [] as string[]),
      getSkillPaths: vi.fn(() => [] as string[]),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      getLaunchPresetOptions: vi.fn(async () => undefined),
      toSummary: vi.fn(() => makeSummary('s-restore')),
      findScannedSession: vi.fn(() => undefined),
      removeSessionEntry: vi.fn(),
      fetchAndBroadcastContext: vi.fn(async () => undefined),
      notifySessionCreated: vi.fn(),
      // S2 ISP 化：结构性满足 lifecycle 窄接口（S3 后 10 方法 = 消费方实际用到的全部），无强转
      getActiveSummaries: vi.fn(() => []),
    }
    const pm = {
      createSession: vi.fn(async () => client),
      destroySession: vi.fn(async () => undefined),
      // D5② 短路预检读点（session-dead-structural-fixes）：undefined = 无 client → 不短路 → 全流程。
      getClient: vi.fn(() => undefined),
    } as unknown as IProcessManager
    const configStore = {
      getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
    } as unknown as IConfigStore
    const sessionStore = {
      refreshAll: vi.fn(),
      invalidateScanCache: vi.fn(),
    } as unknown as ISessionStore
    const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
      getMessageBus: () => null,
      broadcastGlobal: () => {},
    }

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
    return { lifecycle, svc, pm, switchCalls }
  }

  /** 构造一个含 session header + 消息 entry 的 JSONL 文本。 */
  function makeJsonl(cwd: string, opts: { sessionEnd?: boolean } = {}): string {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 's-restore', timestamp: '2026-08-16T01:00:00.000Z', cwd }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    ]
    if (opts.sessionEnd) {
      lines.push(JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2026-08-16T01:00:02.000Z' }))
    }
    return lines.join('\n') + '\n'
  }

  describe('restoreSession cwd fallback 落点（W11 → W1 直附着正式文件）', () => {
    let dir: string
    let env: ReturnType<typeof makeEnv>
    let filePath: string

    beforeEach(() => {
      vi.clearAllMocks()
      setMigrationGate(Promise.resolve())
      env = makeEnv()
      dir = mkdtempSync(join(tmpdir(), 'w11-restore-'))
      filePath = join(dir, 'session.jsonl')
    })

    afterEach(() => {
      setMigrationGate(Promise.resolve())
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    function mountTarget(cwd: string): void {
      const target: ScannedSession = {
        id: 's-restore', cwd, filePath, name: 'restored', launchPresetId: undefined,
      } as ScannedSession
      ;(env.svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(target)
    }

    it('死路径 cwd（F3）：spawn cwd 降级 homedir，原文件 header.cwd 被归一化为 homedir', async () => {
      const deadCwd = join(dir, 'deleted-worktree')
      writeFileSync(filePath, makeJsonl(deadCwd))
      mountTarget(deadCwd)

      await env.lifecycle.restoreSession('s-restore')

      // spawn cwd 降级 homedir（C8：cwdFellBack 时 spawn cwd = homedir）
      expect(env.pm.createSession).toHaveBeenCalledWith('s-restore', homedir(), expect.anything())
      // pi 附着原路径（W1 语义变更：不再附着 $TMPDIR tmp 文件）
      expect(env.switchCalls).toEqual([filePath])
      // [W1 语义变更] 原文件被 F3 归一化原地覆盖：header.cwd 持久化为 homedir
      const after = readFileSync(filePath, 'utf-8')
      const header = JSON.parse(after.split('\n')[0]!)
      expect(header.cwd).toBe(homedir())
      // 消息 entry 保留
      expect(after).toContain('"u1"')
      // 目录无 .tmp-migrate- 临时名残留（rename 已原子完成）
      expect(readdirSync(dir).filter(f => f.includes('.tmp-migrate-'))).toEqual([])
    })

    it('活路径 cwd（F2）：header.cwd 保持原值，源文件零写（与迁移前一致）', async () => {
      const liveCwd = dir
      const original = makeJsonl(liveCwd)
      writeFileSync(filePath, original)
      mountTarget(liveCwd)

      await env.lifecycle.restoreSession('s-restore')

      expect(env.pm.createSession).toHaveBeenCalledWith('s-restore', liveCwd, expect.anything())
      expect(env.switchCalls).toEqual([filePath])
      expect(readFileSync(filePath, 'utf-8')).toBe(original)
    })

    it('死路径 cwd + 历史含 session_end 行（F3）：strip 与 cwd fallback 组合生效', async () => {
      const deadCwd = join(dir, 'another-deleted')
      writeFileSync(filePath, makeJsonl(deadCwd, { sessionEnd: true }))
      mountTarget(deadCwd)

      await env.lifecycle.restoreSession('s-restore')

      const after = readFileSync(filePath, 'utf-8')
      // session_end 行被 strip（防 pi _buildIndex 树索引污染，W9 动机经 W1 复核保留）
      expect(after).not.toContain('session_end')
      // 首行 header cwd 已降级并持久化在原文件
      const header = JSON.parse(after.split('\n')[0]!)
      expect(header.cwd).toBe(homedir())
      // 消息 entry 保留
      expect(after).toContain('"u1"')
      expect(env.switchCalls).toEqual([filePath])
    })
  })
});

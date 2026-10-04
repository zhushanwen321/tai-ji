/**
 * create 幂等化（发现 B）直接测试：SessionLifecycle.create 的 clientUuid 去重 +
 * CreateIdempotencyRegistry 回收策略。
 *
 * 发现 B（P1）：客户端放弃 ≠ 服务端放弃——create 请求已发出、runtime 正在 spawn pi
 * （冷启动/hang 可超过 RPC_BACKSTOP_TIMEOUT_MS≈65s）时，客户端 backstop 超时/WS 断连
 * reject 并让用户重试，但 runtime 照常建号 → 重试产生重复 session + config.sessions
 * 幻影空壳。本文件锁定修复契约：
 * - ① 同 clientUuid 两次 create（顺序重试 / 并发 in-flight）→ 同一 session，只 spawn 一次、只建一号
 * - ② 不同 uuid / 无 uuid → 各自独立创建（回归：uuid 缺省行为与旧版一致）
 * - ③ TTL 过期后同 uuid 再来 → 新建（回收策略生效）
 * - 补：create 失败即清登记（失败不缓存，同 uuid 重试可重建）
 * - 补：登记面有界（容量上限驱逐最老）
 *
 * 装置：session-lifecycle-create-label.test.ts makeCreateEnv 同款（全协作者 mock +
 * 真 registerSession 编排），唯一差异 = getState 按 spawn 序返回唯一 session id
 * （spawn 次数/建号数可断言）。fs 落点 = mkdtemp tmp（fs-guard 白名单）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-create-idempotency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionSummary } from '@taiji/shared'
import { SessionLifecycle } from '../session-lifecycle.js'
import {
  CreateIdempotencyRegistry,
  CREATE_IDEMPOTENCY_TTL_MS,
  CREATE_IDEMPOTENCY_MAX_ENTRIES,
} from '../create-idempotency.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

/** 构造最小 create 环境：每次 spawn 产唯一 pi session id（建号数经 id 集合断言）。 */
function makeCreateEnv(opts?: { failGetStateOnce?: boolean }) {
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
    lastActiveAt: 1, modelId: 'prov/model', tokenCount: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('create clientUuid 幂等（发现 B，SessionLifecycle 集成）', () => {
  it('① 顺序重试：同 uuid 两次 create → 同一 session，只 spawn 一次、只建一号', async () => {
    const { lifecycle, pm } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'cidem-seq-'))

    const s1 = await lifecycle.create(cwd, 'L', { clientUuid: 'u-seq-1' })
    const s2 = await lifecycle.create(cwd, 'L', { clientUuid: 'u-seq-1' })

    expect(pm.createSession).toHaveBeenCalledTimes(1)
    expect(s2.id).toBe(s1.id)
    // 只建一号：sessions Map 恰含唯一 id（无重复/幽灵条目）
    expect([...lifecycle.keys()]).toEqual([s1.id])
  })

  it('① 并发 in-flight：同 uuid 双发 → 共用同一在途创建，只 spawn 一次', async () => {
    const { lifecycle, pm } = makeCreateEnv()
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
    const { lifecycle, pm } = makeCreateEnv()
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
    const { lifecycle, pm } = makeCreateEnv()
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
    const { lifecycle, pm } = makeCreateEnv({ failGetStateOnce: true })
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

describe('CreateIdempotencyRegistry 回收策略（登记面有界）', () => {
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

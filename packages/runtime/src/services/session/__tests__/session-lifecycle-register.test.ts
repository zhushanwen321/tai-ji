/**
 * SessionLifecycle.registerSession 直接测试（S3 写点归位，设计 D2②/P4）。
 *
 * registerSession（原 Facade.initializeManagedSession 迁入）的三件套锁定：
 * - 注册成功：session 对象构造（含 adapter 句柄）+ sessions Map 写入（Registry 只读面可见）
 * - onSessionRegistered **同步直发**：sessions.set 先于扇出、无 microtask 延迟
 *   （禁异步 bus/microtask 的设计约束在此可证伪）
 * - 扇出异常直接传播（不设隔离——与迁移前 Facade 体内顺序调用等价），异常中断后续
 *   订阅者且 Map 条目已写入（迁移前 registerReplicatedStates 抛错时 sessions.set 已发生）
 * - send 闭包窄依赖：带 sid payload → bus publish；无 sid → broadcastGlobal 兜底；
 *   message.complete → notifyMessageComplete（wave:perf-w09 D1-2 单通道语义随迁）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-register.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IPiEngine } from '../../ports/pi-engine.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IEventAdapter } from '../../../interfaces.js'

function makeEnv() {
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
  const notifyMessageComplete = vi.fn()
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory,
    getMessageBus: () => ({ publish: busPublish }) as never,
    broadcastGlobal,
    notifyMessageComplete,
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return {
    lifecycle, svc, configStore, attach, detach, adapterFactory,
    busPublish, broadcastGlobal, notifyMessageComplete,
    getSend: () => capturedSend,
    client: {} as unknown as IPiEngine,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionLifecycle.registerSession（S3 写点归位）', () => {
  it('注册成功：构造完整 session 记录（含 adapter 句柄 + modelOverride 优先）并返回', async () => {
    const env = makeEnv()
    const session = await env.lifecycle.registerSession(
      's1', env.client, '/repo', '测试', '/repo/s1.jsonl', true, 'parent-1', 'entry-9', 'ov/m1',
    )
    expect(session).toMatchObject({
      id: 's1', cwd: '/repo', label: '测试', modelId: 'ov/m1',
      sessionFilePath: '/repo/s1.jsonl', hidden: true,
      parentSession: 'parent-1', forkEntryId: 'entry-9',
      isGenerating: false, isCompacting: false, isBashRunning: false,
    })
    expect(session.adapter).toBeDefined()
    // adapter 经 adapterFactory 装配并 attach（#8 G1：cwd 透传工厂）
    expect(env.adapterFactory).toHaveBeenCalledWith('s1', expect.any(Function), '/repo')
    expect(env.attach).toHaveBeenCalledWith(env.client)
  })

  it('注册成功：无 modelOverride 时 fallback configStore 默认模型', async () => {
    const env = makeEnv()
    const session = await env.lifecycle.registerSession('s2', env.client, '/repo', 't')
    expect(session.modelId).toBe('p/m')
  })

  it('Map 写入：ISessionRegistry 只读面（get/has/keys/values）可见新条目', async () => {
    const env = makeEnv()
    await env.lifecycle.registerSession('s3', env.client, '/repo', 't')
    expect(env.lifecycle.has('s3')).toBe(true)
    expect(env.lifecycle.get('s3')?.id).toBe('s3')
    expect(Array.from(env.lifecycle.keys())).toEqual(['s3'])
    expect(Array.from(env.lifecycle.values()).map((s) => s.id)).toEqual(['s3'])
  })

  it('onSessionRegistered 同步直发：sessions.set 先于扇出，无 microtask 延迟', async () => {
    const env = makeEnv()
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
    const env = makeEnv()
    const order: string[] = []
    env.lifecycle.onSessionRegistered(() => { order.push('first') })
    env.lifecycle.onSessionRegistered(() => { order.push('second') })
    await env.lifecycle.registerSession('s5', env.client, '/repo', 't')
    expect(order).toEqual(['first', 'second'])
  })

  it('扇出异常直接传播：订阅者 throw → registerSession reject，中断后续订阅者，Map 条目已写入', async () => {
    const env = makeEnv()
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
    const env = makeEnv()
    await env.lifecycle.registerSession('s7', env.client, '/repo', 't')
    const send = env.getSend()
    expect(send).toBeDefined()

    const withSid: ServerMessage = { type: 'message.delta', payload: { sessionId: 's7' } } as unknown as ServerMessage
    send!(withSid)
    expect(env.busPublish).toHaveBeenCalledWith('s7', withSid)
    expect(env.broadcastGlobal).not.toHaveBeenCalled()

    const noSid: ServerMessage = { type: 'message.delta', payload: {} } as unknown as ServerMessage
    send!(noSid)
    expect(env.broadcastGlobal).toHaveBeenCalledWith(noSid)
  })

  it('send 闭包窄依赖：message.complete 且带 sid 时触发 notifyMessageComplete', async () => {
    const env = makeEnv()
    await env.lifecycle.registerSession('s8', env.client, '/repo', 't')
    const send = env.getSend()!
    send({ type: 'message.complete', payload: { sessionId: 's8' } } as unknown as ServerMessage)
    expect(env.notifyMessageComplete).toHaveBeenCalledWith('s8')
    // 非 message.complete 不触发
    send({ type: 'message.delta', payload: { sessionId: 's8' } } as unknown as ServerMessage)
    expect(env.notifyMessageComplete).toHaveBeenCalledTimes(1)
  })

  it('removeEntry 纯删除：Map 条目消失，不触发任何订阅/通知', async () => {
    const env = makeEnv()
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
    const env = makeEnv()
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

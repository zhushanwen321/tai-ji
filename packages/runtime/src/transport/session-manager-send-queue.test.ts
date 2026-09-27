/**
 * sd-u5（session-manager send 排队）单元验收测试。
 *
 * 覆盖 A1-A6 验收（describe 名含验收 id，cw 名字级比对）：
 * - A1: busy 时入队而非拒绝（真内核 + mock kernel port 材料）
 * - A2: sendChecked 失败同步返回 error + hint
 * - A3: sessionId 单例注册表（同 id 复用 handle）
 * - A4: handleCreate 初始 prompt 直投（不走内核队列，失败照旧 throw 走外层 catch）
 * - A5: D7 置位副作用（isGenerating/lastActiveAt/workspaceService.record 在 port.send 成功后发生）
 * - A6: plugin-service 两路径仍走 dispatcher 不变（D7 声明的防误改锁）
 *
 * 内核用真实 @zhushanwen/session-delivery（A1/A5 依赖 busy 排队与 settled 边沿的真实
 * 语义）；SessionService / pi client / workspace 为 mock。内核 timer 依赖 vitest fake timers。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/session-manager-send-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SessionManagerHandler } from './session-manager-handler.js'
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../services/session/event-interpreter.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import type { ISessionService } from '../interfaces.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { DeliveryHandle } from '@zhushanwen/session-delivery'
import type { SessionSummary } from '@taiji/shared'

// ─── harness：真 registry + 真 handler，材料层全 mock ─────────────────────

interface HarnessView {
  id: string
  cwd: string
  lastActiveAt: number
  isGenerating: boolean
  isCompacting: boolean
  isBashRunning: boolean
}

/** 调用顺序记录（A5 断言 D7 副作用发生顺序的权威） */
type CallLog = string[]

function makeHarness(overrides: {
  view?: Partial<HarnessView>
  createResult?: Partial<SessionSummary>
  ensureActiveError?: Error
  recordWorkspaceError?: Error
} = {}) {
  const calls: CallLog = []
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => {
      calls.push('prompt')
      return {}
    }),
  }
  const view: HarnessView = {
    id: 's1',
    cwd: '/test/workspace',
    lastActiveAt: 1_000,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    ...overrides.view,
  }
  const settledCbs: Array<(sid: string) => void> = []
  const registry = createSessionDeliveryRegistry({
    getSession: (sid) => (sid === view.id ? (view as unknown as IManagedSessionView) : undefined),
    ensureActive: async (sid: string) => {
      calls.push(`ensureActive:${sid}`)
      if (overrides.ensureActiveError) throw overrides.ensureActiveError
      return client as unknown as never
    },
    subscribeAgentSettled: (cb) => {
      settledCbs.push(cb)
      return () => {}
    },
    recordWorkspace: (cwd: string) => {
      calls.push(`record:${cwd}`)
      if (overrides.recordWorkspaceError) throw overrides.recordWorkspaceError
    },
    getMessageBus: () => null,
  })
  const sendExtensionUiResponse = vi.fn()
  const sessionService = {
    create: vi.fn().mockResolvedValue({
      id: 'child-1',
      label: 'child',
      cwd: '/test/workspace',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'm/x',
      tokenCount: 0,
      ...overrides.createResult,
    }),
    sendMessage: vi.fn(),
    getHistory: vi.fn(),
    // 归属校验材料：s1 是发起方 parent-1 的 managed child（真实路径 getSummary 返回
    // toSummary 透传的 spawnSource/parentAgentSessionId）
    getSummary: vi.fn().mockImplementation((sid: string) =>
      sid === 's1'
        ? { id: 's1', status: 'active', spawnSource: 'agent', parentAgentSessionId: 'parent-1' }
        : undefined,
    ),
    listPersistedSessions: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
  } as unknown as ISessionService
  const handler = new SessionManagerHandler({
    sessionService,
    delivery: registry,
    sendExtensionUiResponse,
    broadcastSessionList: vi.fn(),
  })
  /** 触发 agent_settled 边沿（模拟组合根多播分发到本 session） */
  const emitSettled = (sid = view.id): void => {
    for (const cb of settledCbs) cb(sid)
  }
  return { handler, registry, client, view, sendExtensionUiResponse, sessionService, calls, emitSettled }
}

/** 解析 handler 回写 pi 的 respond JSON（唯一一条） */
function readRespond(h: ReturnType<typeof makeHarness>): Record<string, unknown> {
  expect(h.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
  return JSON.parse(h.sendExtensionUiResponse.mock.calls[0][2] as string) as Record<string, unknown>
}

/** flush microtask 链（deliverText: await ensureActive → await prompt → 置位） */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** 切换 view busy/idle（经转移原语派生，isIdle 读同源标志；u3c 单写原语收口——fixture 直写禁令对测试同样生效） */
function setBusy(h: ReturnType<typeof makeHarness>, busy: boolean): void {
  applySessionOccupancyTransition(h.view, null, busy ? 'generating' : 'idle')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── A1: busy 排队路径 ────────────────────────────────────────────────────

describe('A1-busy-queue-vitest: handleSend busy 时入队而非拒绝', () => {
  it('目标 busy → respond {queued: true} 且立即经 steer 受理入 pi 队列（受理即可达确认）', async () => {
    const h = makeHarness({ view: { isGenerating: true } })

    await h.handler.handle('req-1', 'parent-1', 'send', { sessionId: 's1', prompt: 'hello' })

    const respond = readRespond(h)
    expect(respond).toEqual({ queued: true })
    // 不再出现旧拒绝形状
    expect(respond.blocked).toBeUndefined()
    expect(respond.rejected).toBeUndefined()
    // busy 分支也触达 port.send（内核 #8：受理即可达性确认，pi streaming 受理即回），
    // intent 默认 interrupt-at-turn-boundary → streamingBehavior='steer'，消息入 pi 队列
    expect(h.client.prompt).toHaveBeenCalledWith('hello', undefined, 'steer')
    expect(h.registry.getOrCreateDelivery('s1').depth()).toBe(0)
    // 不再走 dispatcher 的 busy 预检拒绝路径
    expect(h.sessionService.sendMessage).not.toHaveBeenCalled()
  })

  it('普通 send busy 入队后 settled 边沿 + idle 复核 → flush 以 steer 注入 turn 边界', async () => {
    const h = makeHarness({ view: { isGenerating: true } })
    // 普通 send()（非 sendChecked）：busy 时入内核队列，由 settled 边沿驱动（D8 主路径）
    const handle = h.registry.getOrCreateDelivery('s1')
    handle.send({ payload: { kind: 'text', content: 'steered' } })
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(handle.depth()).toBe(1)

    // run 结束：settled 事件到达 + busy 复核通过（同一写者先复位标志）
    setBusy(h, false)
    h.emitSettled()
    await flushMicrotasks()

    // intent 默认 interrupt-at-turn-boundary → pi streamingBehavior='steer'
    expect(h.client.prompt).toHaveBeenCalledWith('steered', undefined, 'steer')
    expect(h.registry.getOrCreateDelivery('s1').depth()).toBe(0)
  })

  it('isCompacting / isBashRunning 同样视为 busy（三者互斥判定）', async () => {
    for (const flag of ['isCompacting', 'isBashRunning'] as const) {
      const h = makeHarness({ view: { [flag]: true } as Partial<HarnessView> })
      // 普通 send() 验证内核 gate：三种标志任一为 true 都判 busy，不立即投
      const handle = h.registry.getOrCreateDelivery('s1')
      handle.send({ payload: { kind: 'text', content: 'm' } })
      expect(handle.depth()).toBe(1)
      expect(h.client.prompt).not.toHaveBeenCalled()
    }
  })
})

// ─── A2: 错误路径 hint ────────────────────────────────────────────────────

describe('A2-error-hint-vitest: sendChecked 失败同步返回 error + hint', () => {
  it('ensureActive 抛错（pi 进程不可达）→ respond 含 error 与固定 hint', async () => {
    const h = makeHarness({ ensureActiveError: new Error('pi process died') })

    await h.handler.handle('req-1', 'parent-1', 'send', { sessionId: 's1', prompt: 'hello' })

    const respond = readRespond(h)
    expect(respond.error).toBe('pi process died')
    expect(respond.hint).toBe(
      'target session unreachable; retry send_to_session after checking get_session_status',
    )
  })

  it('失败消息不留在队列（同步确认语义：reject 即出队）', async () => {
    const h = makeHarness({ ensureActiveError: new Error('boom') })
    await h.handler.handle('req-1', 'parent-1', 'send', { sessionId: 's1', prompt: 'hello' })
    expect(h.registry.getOrCreateDelivery('s1').depth()).toBe(0)
  })
})

// ─── A3: sessionId 单例注册表 ─────────────────────────────────────────────

describe('A3-singleton-registry-vitest: 同 sessionId 复用同一 delivery handle', () => {
  it('同 sessionId 两次 getOrCreateDelivery 返回同一引用', () => {
    const h = makeHarness()
    const a = h.registry.getOrCreateDelivery('s1')
    const b = h.registry.getOrCreateDelivery('s1')
    expect(b).toBe(a)
  })

  it('不同 sessionId 各自独立 handle；factory 只在首次调用一次', () => {
    const h = makeHarness()
    const factory = vi.fn(
      (): DeliveryHandle => ({
        send: vi.fn(),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(),
        dispose: vi.fn(),
      }),
    )
    const a = h.registry.getOrCreateDelivery('sid-a', factory)
    h.registry.getOrCreateDelivery('sid-a', factory)
    expect(factory).toHaveBeenCalledTimes(1)
    const b = h.registry.getOrCreateDelivery('sid-b', factory)
    expect(b).not.toBe(a)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('dispose(sessionId) 后再取是新 handle（旧队列随 dispose 丢弃）', () => {
    // busy 前提：idle 时 send() 会立即投递出队，depth 恒 0——busy 才能观察队列滞留
    const h = makeHarness({ view: { isGenerating: true } })
    const a = h.registry.getOrCreateDelivery('s1')
    a.send({ payload: { kind: 'text', content: 'queued' } })
    expect(a.depth()).toBe(1)

    h.registry.dispose('s1')
    expect(a.depth()).toBe(0)

    const b = h.registry.getOrCreateDelivery('s1')
    expect(b).not.toBe(a)
  })
})

// ─── A4: handleCreate 初始 prompt 直投 ────────────────────────────────────

describe('A4-create-prompt-vitest: handleCreate 初始 prompt 直投不走内核队列', () => {
  it('create 带 prompt → port 同款 ensureActive+prompt 直发（无 streamingBehavior）', async () => {
    const h = makeHarness()

    await h.handler.handle('req-1', 'parent-1', 'create', { cwd: '/test', label: 'c', prompt: 'init prompt' })

    expect(h.sessionService.create).toHaveBeenCalled()
    // 直投：ensureActive + prompt（第三参 undefined——新 session 必 idle，无竞态不需要 steer 兜底）
    expect(h.client.prompt).toHaveBeenCalledWith('init prompt', undefined, undefined)
    // 不走 dispatcher 链路
    expect(h.sessionService.sendMessage).not.toHaveBeenCalled()
    const respond = readRespond(h)
    expect(respond).toEqual(expect.objectContaining({ sessionId: 'child-1', status: 'created' }))
  })

  it('create 不带 prompt → 不触发任何投递', async () => {
    const h = makeHarness()
    await h.handler.handle('req-1', 'parent-1', 'create', { cwd: '/test', label: 'c' })
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(readRespond(h)).toEqual(expect.objectContaining({ sessionId: 'child-1' }))
  })

  it('直投失败 → 照旧 throw 走外层 catch：respond 附 sessionId + use send_to_session hint', async () => {
    const h = makeHarness({ ensureActiveError: new Error('restore failed') })

    await h.handler.handle('req-1', 'parent-1', 'create', { cwd: '/test', prompt: 'init' })

    // create+send 原子性契约：错误对象携带 sessionId（外层 catch 组装恢复路径）
    const respond = readRespond(h)
    expect(respond.error).toBe('restore failed')
    expect(respond.sessionId).toBe('child-1')
    expect(respond.hint).toBe('use send_to_session to retry')
  })
})

// ─── A5: D7 置位副作用 ────────────────────────────────────────────────────

describe('A5-d7-sideeffects-vitest: D7 保留的置位副作用在 port.send 成功后发生', () => {
  it('投递前不置位；prompt 受理成功后 isGenerating/lastActiveAt/record 一并发生', async () => {
    const h = makeHarness()
    const before = h.view.lastActiveAt
    const handle = h.registry.getOrCreateDelivery('s1')

    await handle.sendChecked({ payload: { kind: 'text', content: 'x' } })

    // sendChecked await 返回 = port.send 链完成 → 三项副作用已发生
    expect(h.view.isGenerating).toBe(true)
    expect(h.view.lastActiveAt).toBeGreaterThanOrEqual(before)
    expect(h.calls).toEqual(expect.arrayContaining(['record:/test/workspace']))
    // 顺序：ensureActive → prompt → record（副作用后于 prompt 受理）
    expect(h.calls.indexOf('prompt')).toBeLessThan(h.calls.indexOf('record:/test/workspace'))
  })

  it('busy 投递（settled flush 路径）成功后同样置位', async () => {
    const h = makeHarness({ view: { isGenerating: true } })
    // 普通 send() 走内核 busy 排队 → settled 边沿 flush（settled 路径的置位守卫）
    const handle = h.registry.getOrCreateDelivery('s1')
    handle.send({ payload: { kind: 'text', content: 'q' } })
    expect(h.view.isGenerating).toBe(true) // busy 本态

    // settled → idle 复核（写者复位标志）→ flush 投递 → 重新置位
    setBusy(h, false)
    h.emitSettled()
    await flushMicrotasks()
    expect(h.view.isGenerating).toBe(true)
    expect(h.view.lastActiveAt).toBeGreaterThan(1_000)
  })

  it('workspaceService.record 抛错为 best-effort：置位不回退、投递不算失败', async () => {
    const h = makeHarness({ recordWorkspaceError: new Error('record boom') })
    const handle = h.registry.getOrCreateDelivery('s1')

    await expect(handle.sendChecked({ payload: { kind: 'text', content: 'x' } })).resolves.toBeUndefined()
    expect(h.view.isGenerating).toBe(true)
  })

  it('prompt 失败不置位（成功后置位语义的否定面）', async () => {
    const h = makeHarness()
    h.client.prompt.mockRejectedValue(new Error('pi reject'))
    const handle = h.registry.getOrCreateDelivery('s1')

    await expect(handle.sendChecked({ payload: { kind: 'text', content: 'x' } })).rejects.toThrow('pi reject')
    expect(h.view.isGenerating).toBe(false)
    expect(h.calls).not.toContain('record:/test/workspace')
  })
})

// ─── A6: plugin-service 两路径保持 dispatcher 现状 ─────────────────────────

describe('A6-plugin-paths-vitest: plugin-service 两路径仍走 dispatcher 不变', () => {
  // process.cwd() 定位（runtime 源码树禁 ESM 定位原语——CJS bundle 约束，pre-commit 强制；
  // vitest 从 packages/runtime 运行，与 session-manager-handler.test.ts 的先例一致）
  const sessionApiPath = resolve(process.cwd(), 'src/services/plugin-service/api/session-api.ts')
  const pluginRpcSetupPath = resolve(process.cwd(), 'src/services/plugin-service/plugin-rpc-setup.ts')

  it('session-api.ts 的 plugin.sessions.sendMessage 仍经 deps.sendMessage（dispatcher 路径）', () => {
    const src = readFileSync(sessionApiPath, 'utf-8')
    expect(src).toContain("registerMethod('plugin.sessions.sendMessage'")
    expect(src).toContain('await deps.sendMessage(sessionId, role, content)')
    // 未切 delivery（D7 声明：plugin 路径保持现状，含 busy 拒绝语义）
    expect(src).not.toContain('getOrCreateDelivery')
    expect(src).not.toContain('sendChecked')
  })

  it('plugin-rpc-setup.ts 的 sendMessage 实现仍经 sessionService.sendMessage（dispatcher）', () => {
    const src = readFileSync(pluginRpcSetupPath, 'utf-8')
    expect(src).toContain('await deps.sessionService.sendMessage(sessionId, content)')
    expect(src).not.toContain('getOrCreateDelivery')
    expect(src).not.toContain('sendChecked')
  })
})

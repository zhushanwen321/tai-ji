/**
 * config.sessions 补发频度护栏（remote-use-mobile-v2 §6.3 fallback）。
 *
 * 背景：未读信号（移动壳客户端 diff lastActiveAt 推进 / status 翻转）以既有 config.sessions
 * 整表广播为唯一触发源，fallback 在两个既有写点补发广播——①prompt 受理（deliverOne 尾部
 * markSessionActive 后，session-delivery-registry.ts）②回合终态（handleTurnEndSideEffects
 * 的 persistSessionOutcome 后，session-state-projection.ts）。频度契约（P0-20 护栏）：
 * 每 prompt + 每回合终态各恰好一帧，事件边界去重、无定时器合帧、消息活动不逐帧重播。
 *
 * 覆盖：
 * - 写点①：每次投递受理恰好一次广播；两次受理 = 两次；受理后的 pi 消息事件链零广播。
 * - 写点②：回合终态恰好一次广播；willRetry（attempt 级中间失败）不广播（回合未结束，
 *   终态边沿未发生）。
 * - deps 缺席 = no-op：既有测试装配（未注入 broadcastSessionList）两条链路零变化不炸。
 *
 * mock 层（零 pi 进程零 token）；装配形态对齐 delivery-outbox-crash-recovery.test.ts
 * （真 registry + MockPiClient）与 session-state-projection.test.ts（projection 直测 env）。
 * 真实进程层回归归 e2e-map E2E-DELIVERY-01/02。
 * 运行：cd packages/runtime && npx vitest run broadcast-session-list-fanout
 */
import { describe, expect, it, vi } from 'vitest'
import { createSessionDeliveryRegistry, type SessionDeliveryDeps } from '../session-delivery-registry.js'
import { SessionStateProjection, type SessionStateProjectionDeps } from '../session-state-projection.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'

/** 短轮询等待（谓词命中即返；超时 2s 显式失败，防静默悬挂）。 */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > 2_000) throw new Error(`until timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** MockPiClient：registry 消费的 IPiEngine 窄接口替身（prompt 立即受理）。 */
class MockPiClient {
  eventListener: ((event: unknown) => void) | undefined

  async prompt(): Promise<unknown> {
    return { data: {} }
  }

  async getEntries(): Promise<unknown> {
    return { data: { entries: [] } }
  }

  async getCommands(): Promise<unknown[]> {
    return []
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListener = listener
    return () => {}
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return { steering: [], followUp: [] }
  }
}

function makeView(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/tmp/fake-cwd',
    label: id,
    modelId: 'test-model',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
  }
}

/** 写点①装配：单 session registry + 广播 spy。 */
function makeDeliveryEnv() {
  const views = new Map<string, IManagedSessionView>()
  const client = new MockPiClient()
  const broadcastSessionList = vi.fn()
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => views.get(sid),
    ensureActive: async () => client as unknown as IPiEngine,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: () => {},
    getMessageBus: () => null,
    broadcastSessionList,
  }
  views.set('s1', makeView('s1'))
  const registry = createSessionDeliveryRegistry(deps)
  return { registry, broadcastSessionList, client }
}

describe('§6.3 fallback 写点①：prompt 受理每帧一播、消息活动零重播', () => {
  it('两条 prompt 受理 = 恰好两次广播（每 prompt 一帧）', async () => {
    const { registry, broadcastSessionList } = makeDeliveryEnv()
    registry.submit('s1', { content: 'first prompt' })
    await until(() => broadcastSessionList.mock.calls.length >= 1, 'first accept broadcast')
    expect(broadcastSessionList).toHaveBeenCalledTimes(1)
    registry.submit('s1', { content: 'second prompt' })
    await until(() => broadcastSessionList.mock.calls.length >= 2, 'second accept broadcast')
    expect(broadcastSessionList).toHaveBeenCalledTimes(2)
    registry.disposeAll()
  })

  it('受理后的 pi 消息事件链不触发广播（无逐帧重播）', async () => {
    const { registry, broadcastSessionList, client } = makeDeliveryEnv()
    registry.submit('s1', { content: 'streaming prompt' })
    await until(() => broadcastSessionList.mock.calls.length >= 1, 'accept broadcast')
    // 模拟回合推进的 pi 事件流（流式开始/增量/回执/回合结束）：事件链（watchClient 订阅侧）
    // 无任何 config.sessions 补发点——广播只发生在受理与终态两个事件边界。
    client.eventListener?.({ type: 'message_start', message: { role: 'assistant', content: [] } })
    client.eventListener?.({ type: 'message_update', message: { role: 'assistant', content: [] } })
    client.eventListener?.({ type: 'message_end', message: { role: 'assistant', content: [] } })
    client.eventListener?.({ type: 'agent_end', stopReason: 'turnEnd' })
    // microtask 排空后仍停在受理那一帧
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(broadcastSessionList).toHaveBeenCalledTimes(1)
    registry.disposeAll()
  })

  it('deps 缺席 broadcastSessionList = no-op（既有装配零变化）', async () => {
    const views = new Map<string, IManagedSessionView>()
    views.set('s1', makeView('s1'))
    const deps: SessionDeliveryDeps = {
      getSession: (sid) => views.get(sid),
      ensureActive: async () => new MockPiClient() as unknown as IPiEngine,
      subscribeAgentSettled: () => () => {},
      recordWorkspace: () => {},
      getMessageBus: () => null,
    }
    const registry = createSessionDeliveryRegistry(deps)
    registry.submit('s1', { content: 'legacy assembly' })
    await until(() => registry.entries('s1')?.active.every((e) => e.state === 'in-flight') ?? false, 'in-flight')
    registry.disposeAll()
  })
})

/** 写点②装配：projection 直测 env（形态对齐 session-state-projection.test.ts）。 */
function makeProjectionEnv() {
  const sessions = new Map<string, IManagedSessionView>([['s1', makeView('s1')]])
  const broadcastSessionList = vi.fn()
  const deps: SessionStateProjectionDeps = {
    pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
    getSession: (sessionId) => sessions.get(sessionId),
    hasSession: (sessionId) => sessions.has(sessionId),
    getMessageBus: () => new MessageBus(),
    fetchContext: vi.fn(async () => null),
    persistSessionOutcome: vi.fn(),
    tryPersistProjectBinding: vi.fn(),
    broadcastSessionList,
  }
  return { projection: new SessionStateProjection(deps), broadcastSessionList, deps }
}

describe('§6.3 fallback 写点②：回合终态每帧一播、attempt 级失败不播', () => {
  it('回合终态（willRetry 缺省）恰好一次广播；新回合终态再一帧', () => {
    const { projection, broadcastSessionList } = makeProjectionEnv()
    projection.handleTurnEndSideEffects('s1')
    expect(broadcastSessionList).toHaveBeenCalledTimes(1)
    projection.handleTurnEndSideEffects('s1', 'error')
    expect(broadcastSessionList).toHaveBeenCalledTimes(2)
  })

  it('willRetry=true（attempt 级中间失败）不写终态也不广播', () => {
    const { projection, broadcastSessionList, deps } = makeProjectionEnv()
    projection.handleTurnEndSideEffects('s1', 'error', true)
    expect(broadcastSessionList).not.toHaveBeenCalled()
    expect(deps.persistSessionOutcome).not.toHaveBeenCalled()
  })

  it('deps 缺席 broadcastSessionList = no-op（既有装配零变化）', () => {
    const sessions = new Map<string, IManagedSessionView>([['s1', makeView('s1')]])
    const deps: SessionStateProjectionDeps = {
      pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
      getSession: (sessionId) => sessions.get(sessionId),
      hasSession: (sessionId) => sessions.has(sessionId),
      getMessageBus: () => new MessageBus(),
      fetchContext: vi.fn(async () => null),
      persistSessionOutcome: vi.fn(),
      tryPersistProjectBinding: vi.fn(),
    }
    const projection = new SessionStateProjection(deps)
    expect(() => projection.handleTurnEndSideEffects('s1')).not.toThrow()
  })
})

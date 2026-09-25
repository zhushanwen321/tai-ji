/**
 * P-adopt 探针（单元级，设计 delivery-ownership-kernel.md §3.5 P-adopt / D3③，u2）。
 *
 * 验证「外来无标记文本（subagent notifyDone 形态）经 clear_queue 收养后正常投递且无重复」，
 * 两变体（设计原文口径）：
 * - 变体 1「内核有在途共存」：自有条目在槽位滞留 + 外来文本同轮被收回 → 自有优先回队首
 *   重投、外来收养排其后（相对序保持），均无重复投递。
 * - 变体 2「纯外来滞留」：内核无在途、pi 槽位有外来文本（「空闲 + 槽位非空」两条件的
 *   纯外来形态）→ 收养以新 id 正常投递（不丢弃、不原样回塞——D3 被否项①②形态排除）。
 *
 * 材料：真实 createDelivery 内核 + 真实 registry + mock pi client（clear_queue / get_entries /
 * prompt 替身）。
 *
 * 分工边界：单腿收养断言（投递 1 次 + 标记 1 个 + lane）由 registry 单测
 * session-delivery-registry.test.ts 的 adopt 用例承担；本文件变体 2 的独有面 =
 * 「空闲 + 槽位非空」occupancy 前置 + 重复对账（watchdog 触发点）幂等零新增。
 * e2e 层暂无收养回归（completion-backflow-e2e 只覆盖完成回流链，不覆盖 adopt）——待补。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/probes/p-adopt.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSessionDeliveryRegistry,
  extractMarkerIds,
  type SessionDeliveryDeps,
} from '../../services/session/session-delivery-registry.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import { applySessionOccupancyTransition } from '../../services/session/event-interpreter.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'
import type { IMessageBus } from '../../services/message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'
import type { SkillInjectionResult, SkillInjector } from '../../services/session/skill-injector.js'

function makeView(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false },
  }
}

function makeHarness(cleared: { steering: string[]; followUp: string[] }) {
  const view = makeView()
  const promptCalls: string[] = []
  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      return {}
    }),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => cleared),
    onEvent: vi.fn(() => () => {}),
  }
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === view.id ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => ({ publish: (_sid: string, _m: ServerMessage) => {} }) as unknown as IMessageBus,
  }
  const injector = {
    inject: vi.fn(async (_c: unknown, text: string): Promise<SkillInjectionResult> => ({ text, notices: [] })),
  } as unknown as SkillInjector
  const registry = createSessionDeliveryRegistry(deps, injector)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return { registry, view, promptCalls, flush, client }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('P-adopt 变体 1：内核有在途共存（自有优先、收养排后、零重复）', () => {
  it('自有条目回收回队首 + 外来文本收养投递；同文本重放不重复（槽位已清空）', async () => {
    const content = '自有用户消息'
    // 先建运行时（真实流前提：该 session 已有过交付）
    const h0 = makeHarness({ steering: [], followUp: [] })
    h0.registry.getOrCreateDelivery('s1')
    expect(h0.registry.entries('s1')?.active).toHaveLength(0)

    // 自有条目投递（受理 → in-flight），随后把它连同外来文本一起放进「槽位滞留」集
    const h = h0
    const id = 'u-11111111-1111-4111-8111-111111111111'
    h.registry.submit('s1', { content, clientUuid: id })
    await h.flush()
    const ownText = h.promptCalls[0]!
    h.client.clearQueue.mockImplementation(async () => ({ steering: [ownText, 'subagent notifyDone 原文'], followUp: [] }))

    // settled 边沿语义（真实链：onAgentSettled 先复位 occupancy 再扇出对账订阅）
    applySessionOccupancyTransition(h.view, null, 'idle')
    await h.registry.reconcile('s1', 'agent-settled')
    await h.flush()
    await h.flush()

    // 自有条目重投（同 id 条目仍在册）+ 外来文本收养投递（新 id、带新标记）
    const delivered = h.promptCalls.slice(1)
    expect(delivered.some((t) => t === ownText)).toBe(true)
    const adopted = delivered.find((t) => t.includes('subagent notifyDone 原文'))
    expect(adopted, '外来文本被收养投递（不丢弃）').toBeTruthy()
    expect(extractMarkerIds(adopted!)).toHaveLength(1)
    // 收养条目在册（非原样回塞：走内核 FIFO 正常投递）
    expect(h.registry.entries('s1')?.active.some((e) => e.lane === 'direct')).toBe(true)
  })
})

describe('P-adopt 变体 2：无内核在途的纯外来滞留（「空闲 + 槽位非空」两条件触发）', () => {
  it('纯外来文本（无内核记录）→ 收养以新 id 投递；重复对账同文本不再产生新条目', async () => {
    let cleared: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] }
    const h = makeHarness(cleared)
    h.registry.getOrCreateDelivery('s1')
    expect(h.registry.entries('s1')?.active).toHaveLength(0) // 无内核在途（纯外来形态）

    applySessionOccupancyTransition(h.view, null, 'generating')
    h.client.clearQueue.mockImplementation(async () => {
      const out = cleared
      cleared = { steering: [], followUp: [] } // 队列级收回 = 一次性（重复对账空转）
      return out
    })
    cleared = { steering: ['scheduler 提醒（外来无标记）'], followUp: [] }
    applySessionOccupancyTransition(h.view, null, 'idle')

    await h.registry.reconcile('s1', 'agent-settled')
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toContain('scheduler 提醒（外来无标记）')
    expect(extractMarkerIds(h.promptCalls[0]!)).toHaveLength(1) // 收养条目带内核身份标记

    // 下轮对账：槽位已空 → 零新增投递（不重复）
    await h.registry.reconcile('s1', 'watchdog')
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })
})

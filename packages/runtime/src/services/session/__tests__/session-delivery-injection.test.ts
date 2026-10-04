/**
 * A2（adversarial-review-fixes MF-C）：deliverText 挂 skill 注入的行为测试。
 *
 * 锁定三件事：① deliverText（sendDirect / 内核 send 两消费入口）在
 * client.prompt 之前经 injector.inject；② notice 在 prompt 成功之后发布
 * （时机契约与 dispatcher 同款）；③ prompt 失败 notice 不发、纯文本 no-op。
 * 真内核（@zhushanwen/session-delivery）+ mock 材料（client/deps/injector spy）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-delivery-injection.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { createSessionDeliveryRegistry } from '../session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../event-interpreter.js'
import type { SkillInjector, SkillInjectionResult } from '../skill-injector.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IManagedSessionView } from '../types.js'

/** 最小装置：真 registry + mock client/deps + 可编程 spy 注入器。 */
function makeHarness(injectorResult?: Partial<SkillInjectionResult>) {
  const calls: string[] = []
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => {
      calls.push('prompt')
      return {}
    }),
  }
  const view = {
    id: 's1',
    cwd: '/test/workspace',
    lastActiveAt: 1_000,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
  }
  const publish = vi.fn((_sid: string, msg: { type: string }) => {
    calls.push(`publish:${msg.type}`)
  })
  const inject = vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
    text: `<<injected:${text}>>`,
    notices: [],
    ...injectorResult,
  }))
  const injector = { inject } as unknown as SkillInjector
  const settledCbs: Array<(sid: string) => void> = []
  const registry = createSessionDeliveryRegistry(
    {
      getSession: (sid) => (sid === view.id ? (view as unknown as IManagedSessionView) : undefined),
      ensureActive: async (sid) => {
        calls.push(`ensureActive:${sid}`)
        return client as unknown as never
      },
      subscribeAgentSettled: (cb) => {
        settledCbs.push(cb)
        return () => {}
      },
      recordWorkspace: () => {},
      getMessageBus: () => ({ publish } as unknown as IMessageBus),
    },
    injector,
  )
  const emitSettled = (sid = view.id): void => {
    for (const cb of settledCbs) cb(sid)
  }
  return { registry, client, view, publish, inject, calls, emitSettled }
}

describe('A2-MF-C：deliverText 挂 skill 注入', () => {
  it('sendDirect：prompt 之前注入原始内容，notice 在 prompt 之后（顺序契约）', async () => {
    const notices = [{ reason: 'skill_missing' as const, skills: ['ghost'] }]
    const h = makeHarness({ notices })
    await h.registry.sendDirect('s1', '首条消息')
    // 注入收到原始内容（prompt 之前）
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][1]).toBe('首条消息')
    // prompt 收到注入产物（三参形态：images undefined + streamingBehavior undefined）
    expect(h.client.prompt).toHaveBeenCalledWith('<<injected:首条消息>>', undefined, undefined)
    // 顺序：ensureActive → occupancy 'dispatching' 置位帧（[RT-4#10] 前移至 prompt 之前，
    // RPC 往返窗内预检/回收豁免不再呈 idle）→ prompt → notice（发送成功后才发布）。
    // prompt 后的置位重复调用被原语全等去重（不再广播第二帧）。
    expect(h.calls).toEqual(['ensureActive:s1', 'publish:session.occupancy', 'prompt', 'publish:session.skillNotice'])
    const noticeMsg = h.publish.mock.calls.find(([, msg]) => (msg as { type: string }).type === 'session.skillNotice')
    expect(noticeMsg![0]).toBe('s1')
    expect((noticeMsg![1] as unknown as { payload: { reason: string; skills: string[] } }).payload)
      .toEqual({ sessionId: 's1', reason: 'skill_missing', skills: ['ghost'] })
  })

  it('[RT-4#10] 置位先于 prompt：prompt 执行时点 occupancy 已 dispatching（RPC 往返窗内状态不再回退）', async () => {
    const h = makeHarness()
    let occupancyAtPrompt: { turn?: string; isGenerating?: boolean } | null = null
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // prompt mock 执行时点读取 session 视图：前移置位后此处必须已是 dispatching
      occupancyAtPrompt = {
        turn: (h.view as unknown as { occupancy?: { turn: string } }).occupancy?.turn,
        isGenerating: h.view.isGenerating,
      }
      return {}
    })
    await h.registry.sendDirect('s1', '内容')
    // prompt 执行时点：dispatching 已写入（旧实现此点仍是 idle——置位在 prompt 之后）
    expect(occupancyAtPrompt).toEqual({ turn: 'dispatching', isGenerating: true })
  })

  it('[RT-4#10] prompt 失败按拒绝分型收口终态（不卡 dispatching）：processing 拒绝 → generating', async () => {
    const h = makeHarness()
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('prompt failed: Cannot ... Agent is already processing'),
    )
    await expect(h.registry.sendDirect('s1', 'x')).rejects.toThrow('Agent is already processing')
    // 'reject-processing' 行：isGenerating=true + turn='generating'（pi 有 turn 在跑的权威信号）
    expect(h.view.isGenerating).toBe(true)
    expect((h.view as unknown as { occupancy?: { turn: string } }).occupancy?.turn).toBe('generating')
  })

  it('[RT-4#10] prompt 失败按拒绝分型收口终态：非 busy 真失败 → idle（不卡 dispatching）', async () => {
    const h = makeHarness()
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EPIPE gone'))
    await expect(h.registry.sendDirect('s1', 'x')).rejects.toThrow('EPIPE gone')
    // 'reject-other' 行：turn 没跑起来 → idle
    expect(h.view.isGenerating).toBe(false)
    expect((h.view as unknown as { occupancy?: { turn: string } }).occupancy?.turn).toBe('idle')
  })

  it('内核 send 入口（session_manager send / completion-backflow 消费方）：同款注入', async () => {
    const h = makeHarness()
    await h.registry.getOrCreateDelivery('s1').sendChecked({ payload: { kind: 'text', content: 'agent 构造' } })
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][1]).toBe('agent 构造')
    expect(h.client.prompt).toHaveBeenCalledWith('<<injected:agent 构造>>', undefined, 'steer')
  })

  it('busy 入队 → settled flush 的投递同样经注入（queued 路径不旁路）', async () => {
    const h = makeHarness()
    // busy 置位/复位经转移原语（u3c 单写原语收口；publish null 与改前直写一致零广播）
    applySessionOccupancyTransition(h.view, null, 'generating')
    const handle = h.registry.getOrCreateDelivery('s1')
    handle.send({ payload: { kind: 'text', content: '排队的消息' } })
    expect(h.inject).not.toHaveBeenCalled() // busy 期只入队，未注入
    expect(handle.depth()).toBe(1)
    // idle 边沿（settled + 标志复位）→ flush：此刻才注入 + prompt
    applySessionOccupancyTransition(h.view, null, 'idle')
    h.emitSettled()
    await vi.waitFor(() => expect(handle.depth()).toBe(0))
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][1]).toBe('排队的消息')
    expect(h.client.prompt).toHaveBeenCalledWith('<<injected:排队的消息>>', undefined, 'steer')
  })

  it('prompt 失败：notice 不发布（发送成功后时机契约的否定面）', async () => {
    const h = makeHarness({ notices: [{ reason: 'skill_missing', skills: ['ghost'] }] })
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pi reject'))
    await expect(h.registry.sendDirect('s1', 'x')).rejects.toThrow('pi reject')
    // skillNotice 零发布（notice 时机契约否定面不变）；[RT-4#10] occupancy 帧例外——
    // 前移置位 + 失败收口会产生 dispatching/idle 两帧（合法投影，不属于 notice 否定面）
    expect(h.publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.skillNotice')).toHaveLength(0)
  })

  it('notices 为空：不发布 skillNotice（no-op 零噪音）；真注入器纯文本 no-op 原文通过', async () => {
    const h = makeHarness()
    await h.registry.sendDirect('s1', '纯文本')
    // skillNotice 零发布；occupancy 帧是 D2 挂点迁移后的合法投影输出（'dispatching'），
    // 不在本断言否定面内（顺序契约用例已单独锁定）
    expect(h.publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.skillNotice')).toHaveLength(0)
    // 真 SkillInjector：无标记在 parseSkillMarkers 短路，不触达映射源与任何 RPC
    //（映射源若被读取即翻红——stub 计数断言在下方）
    const { createSessionDeliveryRegistry: createReal } = await import('../session-delivery-registry.js')
    const { SkillInjector } = await import('../skill-injector.js')
    let sourceReads = 0
    const realClient = { prompt: vi.fn(async () => ({})) }
    const real = createReal(
      {
        getSession: () => h.view as unknown as IManagedSessionView,
        ensureActive: async () => realClient as unknown as never,
        subscribeAgentSettled: () => () => {},
        recordWorkspace: () => {},
        getMessageBus: () => null,
      },
      // [A1 接线] D7 切源后 SkillInjector 构造必传映射源（空扫描 stub：本用例只走
      // 无标记 no-op 短路，读取计数恒 0）
      new SkillInjector({
        getGlobalSkills: () => {
          sourceReads++
          return []
        },
        getProjectSkills: async () => {
          sourceReads++
          return []
        },
      }),
    )
    await real.sendDirect('s1', '纯文本无标记')
    expect(sourceReads).toBe(0)
    expect(realClient.prompt).toHaveBeenCalledWith('纯文本无标记', undefined, undefined)
  })
})

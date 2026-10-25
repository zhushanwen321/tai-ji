/**
 * delivery.peek / delivery.edit 编排测试（chat-flow-consistency D6 + design-queue-delivery
 * Q3 分支表 + A11 反向场景）：
 *
 * - peek：活跃条目全文 + 无条目 undefined（WS 层转 found:false）
 * - edit queued（压缩持有期）：直接内核替换无收回，解除持有后出站 = 新文本（带原身份标记）
 * - edit in-flight（收回命中）：clear_queue 收回 → 替换 → own 保序重投（edited:true）
 * - edit in-flight（收回未命中 + transcript 命中）→ delivered（真已注入）
 * - edit in-flight（收回未命中 + transcript miss）→ unconfirmed（悬空窗口，用户裁决第四值）
 * - edit 终态基线：cancelled → cancelled；delivered → delivered；未知 id → not-found
 * - edit failed（E7 留守行）：替换 + requeue 编辑即重发（出站 = 新文本）
 * - A11 反向场景：同条目连续 edit × N + 混合撤销重试 + 断连（queued 不触碰）重连后队列
 *   集合全等（内容 = 最后一次编辑、相对序不变、无重复终态行）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-delivery-edit.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionDeliveryRegistry } from '../session-delivery-registry.js'
import { markerLiteral } from '@taiji/shared'
import type { SkillInjector } from '../skill-injector.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

const A = 'u-9c1e2b3a-1111-4222-8333-444455556666'
const B = 'u-9c1e2b3a-1111-4222-8333-444455556667'
const C = 'u-9c1e2b3a-1111-4222-8333-444455556668'
const bare = (id: string): string => id.replace(/^u-/, '')

interface EditHarnessOptions { // oe-exempt:20261024:test:U6 测试装配体入参（单文件 harness，非生产抽象）
  /** get_entries 的 transcript entries（confirm 分支凭据）。 */
  entries?: unknown[]
  /** clearQueue 返回（收回集；缺省空集）。 */
  cleared?: { steering: string[]; followUp: string[] }
}

function makeEditHarness(opts: EditHarnessOptions = {}) {
  const view = {
    id: 's1',
    cwd: '/test/workspace',
    lastActiveAt: 1_000,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    occupancy: { turn: 'idle' as string, compacting: false, bash: false },
  } as unknown as IManagedSessionView
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => ({}) as never),
    getCommands: vi.fn(async () => [] as never),
    getEntries: vi.fn(async () => ({ data: { entries: opts.entries ?? [] } }) as never),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] }) as never),
    onEvent: vi.fn(() => () => {}),
  }
  const injector = { inject: vi.fn(async (_c: unknown, text: string) => ({ text, notices: [] })) } as unknown as SkillInjector
  const registry = createSessionDeliveryRegistry(
    {
      getSession: (sid) => (sid === 's1' ? view : undefined),
      ensureActive: async () => client as unknown as IPiEngine,
      subscribeAgentSettled: () => () => {},
      recordWorkspace: () => {},
      getMessageBus: () => ({ publish: vi.fn() } as unknown as IMessageBus),
    },
    injector,
  )
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 60; i += 1) await Promise.resolve()
  }
  return { registry, client, view, flush }
}

/** 出站文本构造（模拟 pi 槽位收回文本：submit 出站同形——原文 + 尾附裸标记）。 */
function slotText(content: string, id: string): string {
  return `${content}\n${markerLiteral(bare(id))}`
}

/** transcript user entry 构造（transcriptHasMarker 的读取形态）。 */
function transcriptEntry(content: string): unknown {
  return { type: 'message', message: { role: 'user', content } }
}

describe('delivery.peek / delivery.edit 编排（chat-flow-consistency D6）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('peek：活跃条目返回全文；未知 id 返回 undefined', async () => {
    const h = makeEditHarness()
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '排队原文', clientUuid: A })
    await h.flush()

    const peeked = h.registry.peek('s1', A)
    expect(peeked?.found).toBe(true)
    expect(peeked?.content).toContain('排队原文')
    expect(peeked?.content).not.toBe(undefined)
    expect(h.registry.peek('s1', 'u-none')).toBeUndefined()
    h.registry.dispose('s1')
  })

  it('edit queued（出站批内挂起 = 持有期常态）：内核拒绝替换 → unconfirmed（跌落收回路径收场）', async () => {
    const h = makeEditHarness()
    ;(h.view.occupancy as { compacting: boolean }).compacting = true
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '持有原文', clientUuid: A })
    await h.flush()
    expect(h.client.prompt).not.toHaveBeenCalled() // 持有期未出站（port.send 挂起中）

    // 挂起中文本已在 attemptSend 同步段定格：替换结构上不可达 → unconfirmed
    //（修改内容按普通新消息发出由前端降级通路承载；原条目按定格文本照常投递不丢）
    const outcome = await h.registry.edit('s1', A, { content: '持有新文' })
    expect(outcome).toEqual({ edited: false, reason: 'unconfirmed' })

    // 解除持有 → 原文本照常出站（内容不丢；原身份标记）。唤醒链时序：wake 后先 flush
    // 让 holdEdgeTick 的 setTimeout 排程（fake timers 冻结的微任务先行），再跑计时器
    ;(h.view.occupancy as { compacting: boolean }).compacting = false
    h.registry.notifyHoldRelease('s1')
    await h.flush()
    vi.runAllTimers()
    await h.flush()
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    const outbound = h.client.prompt.mock.calls[0]![0] as string
    expect(outbound.startsWith('持有原文\n')).toBe(true)
    expect(outbound.endsWith(markerLiteral(bare(A)))).toBe(true)
    h.registry.dispose('s1')
  })

  it('edit in-flight（收回命中）：替换 + own 重投（edited:true，出站 = 新文本）', async () => {
    const h = makeEditHarness()
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '在途原文', clientUuid: A })
    await h.flush()
    expect(h.client.prompt).toHaveBeenCalledTimes(1)

    h.client.clearQueue.mockImplementation(async () => ({ steering: [slotText('在途原文', A)], followUp: [] }) as never)
    const outcome = await h.registry.edit('s1', A, { content: '在途新文' })
    expect(outcome).toEqual({ edited: true })
    // 收回-重投：prompt 第二次调用 = 新文本带原 id 标记
    expect(h.client.prompt).toHaveBeenCalledTimes(2)
    const redelivered = h.client.prompt.mock.calls[1]![0] as string
    expect(redelivered.startsWith('在途新文\n')).toBe(true)
    expect(redelivered.endsWith(markerLiteral(bare(A)))).toBe(true)
    h.registry.dispose('s1')
  })

  it('edit in-flight（收回未命中 + transcript 命中）→ delivered；再 edit 短路 delivered', async () => {
    const h = makeEditHarness({ entries: [transcriptEntry(slotText('已注入原文', A))] })
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '已注入原文', clientUuid: A })
    await h.flush()

    // 收回集为空（文本已进 transcript 不在槽位）
    const outcome = await h.registry.edit('s1', A, { content: '迟到的编辑' })
    expect(outcome).toEqual({ edited: false, reason: 'delivered' })
    const again = await h.registry.edit('s1', A, { content: '再编一次' })
    expect(again).toEqual({ edited: false, reason: 'delivered' }) // 终态基线短路
    h.registry.dispose('s1')
  })

  it('edit in-flight（收回未命中 + transcript miss）→ unconfirmed（悬空窗口第四值）', async () => {
    const h = makeEditHarness()
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '悬空原文', clientUuid: A })
    await h.flush()
    // clearQueue 收空（文本不在槽位）+ transcript 无标记（getEntries 默认空）= 悬空窗口
    const outcome = await h.registry.edit('s1', A, { content: '悬空新文' })
    expect(outcome).toEqual({ edited: false, reason: 'unconfirmed' })
    h.registry.dispose('s1')
  })

  it('edit 终态基线：cancelled → cancelled；未知 id → not-found', async () => {
    const h = makeEditHarness()
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '待撤销', clientUuid: A })
    await h.flush()
    // drain = 全量取消终结（forceQuit 收尾形态）：全部条目记 cancelled tombstone
    h.registry.drain('s1')
    expect(h.registry.entries('s1')!.tombstones[0]).toMatchObject({ id: A, state: 'cancelled' })

    expect(await h.registry.edit('s1', A, { content: 'x' })).toEqual({ edited: false, reason: 'cancelled' })
    expect(await h.registry.edit('s1', 'u-none', { content: 'x' })).toEqual({ edited: false, reason: 'not-found' })
    expect(await h.registry.edit('s1', B, { content: 'x' })).toEqual({ edited: false, reason: 'not-found' }) // 从未存在
    h.registry.dispose('s1')
  })

  it('edit failed（E7 留守行）：替换 + 编辑即重发（出站 = 新文本）；随后 cancel 可撤', async () => {
    const h = makeEditHarness()
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: '失败原文', clientUuid: A })
    await h.flush()
    h.registry.onPiDisconnected('s1') // 在途条目批量转 failed（断连未确认留守）
    expect(h.registry.entries('s1')!.active.find((e) => e.id === A)?.state).toBe('failed')

    const outcome = await h.registry.edit('s1', A, { content: '失败新文' })
    expect(outcome).toEqual({ edited: true })
    await h.flush() // 编辑即重发的出站链（requeue+flush → port.send async）落槽
    expect(h.client.prompt).toHaveBeenCalledTimes(2)
    const redelivered = h.client.prompt.mock.calls[1]![0] as string
    expect(redelivered.startsWith('失败新文\n')).toBe(true)
    expect(redelivered.endsWith(markerLiteral(bare(A)))).toBe(true)
    h.registry.dispose('s1')
  })

  it('A11 反向场景：连续 edit × N + 混合撤销重试 + 断连重连后队列集合全等', async () => {
    const h = makeEditHarness()
    // pi 槽位镜像 mock：prompt 调用即入槽（重投 refill）、clear_queue 全收清槽（收回-重投
    // 的真实往返语义——edit/cancel 的收回集与重投闭环都跑在它上面）
    const slots: string[] = []
    h.client.prompt.mockImplementation(async (text: unknown) => {
      slots.push(text as string)
      return {} as never
    })
    h.client.clearQueue.mockImplementation(async () => {
      const drained = slots.splice(0, slots.length)
      return { steering: drained, followUp: [] } as never
    })
    h.registry.getOrCreateDelivery('s1')
    h.registry.submit('s1', { content: 'A0', clientUuid: A })
    h.registry.submit('s1', { content: 'B0', clientUuid: B })
    h.registry.submit('s1', { content: 'C0', clientUuid: C })
    await h.flush()
    expect(slots).toEqual([slotText('A0', A), slotText('B0', B), slotText('C0', C)])

    // 同条目连续 edit × 3（每次收回-替换-全量保序重投，最后一次胜出；每次 edit 后
    // flush 让重投落槽——edit 应答在 disposeCleared 触发重投时返回，落槽是后续微任务）
    expect((await h.registry.edit('s1', B, { content: 'B1' })).edited).toBe(true)
    await h.flush()
    expect((await h.registry.edit('s1', B, { content: 'B2' })).edited).toBe(true)
    await h.flush()
    expect((await h.registry.edit('s1', B, { content: 'B3' })).edited).toBe(true)
    await h.flush()
    expect(slots).toEqual([slotText('A0', A), slotText('B3', B), slotText('C0', C)])

    // 混合撤销（A in-flight → 收回路径，B/C 保持相对序重投）
    const cancelReply = await h.registry.cancel('s1', A)
    expect(cancelReply.cancelled).toBe(true)
    expect(cancelReply.content).toContain('A0')
    await h.flush()
    expect(slots).toEqual([slotText('B3', B), slotText('C0', C)])

    // 断连（in-flight 的 B/C 转 failed 留守）——pi 进程死亡 = 槽位内存随亡（镜像清空）；
    // 重连后 resync 重试（按传入序保序重投）
    h.registry.onPiDisconnected('s1')
    slots.length = 0
    expect(h.registry.entries('s1')!.active.map((e) => e.state)).toEqual(['failed', 'failed'])
    const deduped = await h.registry.resync('s1', [B, C])
    expect(deduped).toEqual([])
    await h.flush()
    expect(slots).toEqual([slotText('B3', B), slotText('C0', C)])

    // 队列集合全等：条目集、内容（B = 最后一次编辑）、相对序、终态行（仅 A cancelled 一行）
    const active = h.registry.entries('s1')!.active
    expect(active.map((e) => e.id)).toEqual([B, C])
    expect(active.find((e) => e.id === B)!.payload.content).toBe(slotText('B3', B))
    expect(active.find((e) => e.id === C)!.payload.content).toBe(slotText('C0', C))
    const tombstones = h.registry.entries('s1')!.tombstones
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]).toMatchObject({ id: A, state: 'cancelled' })
    h.registry.dispose('s1')
  })
})

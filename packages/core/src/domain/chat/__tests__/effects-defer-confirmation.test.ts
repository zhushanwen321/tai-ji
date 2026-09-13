/**
 * message_end(user) 三分支处理序 ①——defer 分区 FIFO 文本匹配单测（session-occupancy
 * u4a / docs/design/session-occupancy-send-closure.md（已删除，git 可追溯）D5.3）。
 *
 * 覆盖（impl-plan u4a-p2-core 验收条款 ①-⑤）：
 * - ① defer 命中转态出队（confirmDelivery）+ send 条目计数回收 + 帧消费终止（不走②③）
 * - ① steer 条目命中不动计数（steer 条目不挂占位，decrement 只归 send 条目）
 * - ① 未命中 → 逐级下落 ②（inflight 纯计数）/ ③（腿 2 includes）——现状链行为不变
 * - 同文本碰撞数量守恒：帧数 = 落盘实体数，每帧恰被 ①/②/③ 之一消费一次（D5.3 第 3 点）
 * - removeQueuedTextFromSnapshot 幂等（设计 §5 待验证点）：对「快照中不存在的实例」
 *   no-op 不抛错、快照不变（含无快照 / 无维度 / 其他文本三形态）
 * - provider 未注册 = defer 分区缺席 → 与现状逐字节一致（既有 registry 测试零改动
 *   通过的机理证明）
 *
 * 与 effects.test.ts（腿 2 现状锁定）互不重叠：本文件只测 ① 分支与其下落路径，
 * 现有 registry 测试零改动通过本身即 ②③ 零改动的证据。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/effects-defer-confirmation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  dispatchMessageEvent,
} from '../effects/registry'
import {
  setCompactQueueProviderForEffects,
  resetCompactQueueProviderForEffectsForTest,
} from '../effects/user-delivery'
import type { MessageEffectContext } from '../effect-types'
import type { CompactQueueLike, CompactQueueEntrySnapshot } from '../useChat'
import type { Message, Segment, ServerMessage } from '@xyz-agent/shared'

const SID = 's-defer'

/** 真实计数语义的 inflight（区别于纯 mock——命中回收断言读数值，非调用记录） */
function makeCtx(): MessageEffectContext & { inflightOf: () => number } {
  const inflight = new Map<string, number>()
  return {
    messages: ref(new Map([[SID, shallowRef([] as Message[])]])),
    retryStates: ref(new Map()),
    queueStates: ref(new Map()),
    applyFileChanges: vi.fn(),
    markChangeSetsSuperseded: vi.fn(),
    finalizeSession: vi.fn(),
    clearPendingSend: vi.fn(),
    armStreamingTimer: vi.fn(),
    takePrematureTimeoutIds: vi.fn((_sid: string) => new Set<string>() as ReadonlySet<string>),
    clearPrematureTimeoutIds: vi.fn(),
    drainN: vi.fn(() => [] as Segment[][]),
    reconcilePending: vi.fn(),
    appendUser: vi.fn(),
    applyEntryFrame: vi.fn(),
    getInflight: (sid: string) => inflight.get(sid) ?? 0,
    incrementInflight: (sid: string, n = 1) => {
      inflight.set(sid, (inflight.get(sid) ?? 0) + n)
    },
    decrementInflight: (sid: string, n = 1) => {
      const next = Math.max(0, (inflight.get(sid) ?? 0) - n)
      if (next === 0) inflight.delete(sid)
      else inflight.set(sid, next)
    },
    clearInflight: (sid: string) => {
      inflight.delete(sid)
    },
    inflightOf: () => inflight.get(SID) ?? 0,
  }
}

/** defer 队列 mock（CompactQueueLike 完整契约：peek 副本 + confirmDelivery 真出队记账） */
function makeQueue(initial: CompactQueueEntrySnapshot[] = []): CompactQueueLike & {
  confirmed: () => string[]
  entries: () => CompactQueueEntrySnapshot[]
  failConfirmIds: Set<string>
} {
  let entries = [...initial]
  const confirmed: string[] = []
  const failConfirmIds = new Set<string>()
  return {
    flush: vi.fn(async () => true),
    enqueue: vi.fn((_sid: string, text: string) => {
      const e: CompactQueueEntrySnapshot = { id: `q-${confirmed.length}-${text}`, text }
      entries.push(e)
      return e
    }),
    peek: vi.fn((_sid: string) => entries.map((m) => ({ ...m }))),
    hasPending: vi.fn((_sid: string) => entries.length > 0),
    confirmDelivery: vi.fn((sid: string, id: string) => {
      if (failConfirmIds.has(id)) return false
      const idx = entries.findIndex((m) => m.id === id)
      if (idx === -1) return false
      entries = entries.filter((m) => m.id !== id)
      confirmed.push(id)
      return true
    }),
    confirmed: () => [...confirmed],
    entries: () => entries.map((m) => ({ ...m })),
    failConfirmIds,
  }
}

function msg(text: string): ServerMessage {
  return {
    type: 'message.message_end',
    payload: {
      sessionId: SID,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
      },
    },
  } as ServerMessage
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetCompactQueueProviderForEffectsForTest()
})

afterEach(() => {
  // 防跨用例泄漏：provider 若在某用例注册且未覆盖，会带进下一文件的 provider 相关断言
  resetCompactQueueProviderForEffectsForTest()
})

describe('message_end(user) 三分支 ①：defer 分区 FIFO 命中（session-occupancy u4a / D5.3）', () => {
  it('AC1: 命中 send 条目 → confirmDelivery 出队 + decrementInflight 回收占位 + 帧终止（不走②③）', () => {
    const queue = makeQueue([{ id: 'q1', text: '排队消息', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    // u4b flush 提交挂占位的模拟（P2 后由 flush 编排挂；core 机制只负责命中回收）
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg('排队消息'))

    // 转态 + 出队在队列实现侧执行（确认回调以正确 id 调用且出队生效）
    expect(queue.confirmDelivery).toHaveBeenCalledWith(SID, 'q1')
    expect(queue.confirmed()).toEqual(['q1'])
    expect(queue.entries()).toEqual([])
    // send 条目占位回收：1 → 0
    expect(ctx.inflightOf()).toBe(0)
    // 帧消费终止：不再走 ②（此处已归零）与 ③（drainN/appendUser 未触）
    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
    // 快照无同文本实例 → 剔除 no-op（queueStates 本就为空，不因剔除产生条目）
    expect(ctx.queueStates.value.has(SID)).toBe(false)
    // 权威 reducer 喂入无条件保留（① 只是 overlay 侧消费裁决，不阻断权威帧）
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
  })

  it('AC2: 命中 steer 条目 → confirmDelivery 出队但计数不动（steer 不挂占位）+ 剔快照一个实例', () => {
    const queue = makeQueue([{ id: 'q2', text: 'S', mode: 'steer' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    // 在途直发的占位（≠本条目）——命中 steer 条目不得错抵它
    ctx.incrementInflight(SID, 2)
    // steer 条目的 pi 侧镜像快照：steering 数组含同文本
    ctx.queueStates.value = new Map([[SID, { steering: ['S'] }]])

    dispatchMessageEvent(ctx, SID, msg('S'))

    expect(queue.confirmed()).toEqual(['q2'])
    // steer 条目不动计数：在途占位保持 2（真实计数语义断言，decrementInflight 未触）
    expect(ctx.inflightOf()).toBe(2)
    // 快照剔一个实例：唯一实例被剔 → 维度空 → 条目删除（queueStates 不积累空形态，
    // 对齐既有剔后语义 registry.ts removeQueuedTextFromSnapshot）
    expect(ctx.queueStates.value.has(SID)).toBe(false)
    // 帧消费终止
    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })

  it('AC4a: ① 未命中（无同文本条目）→ 下落 ②：inflight>0 纯计数 decrement（现状零改动）', () => {
    const queue = makeQueue([{ id: 'q3', text: 'other', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg('T'))

    // ① 未命中：确认回调不触
    expect(queue.confirmDelivery).not.toHaveBeenCalled()
    // ② 现状：decrement + return（不落 ③）
    expect(ctx.inflightOf()).toBe(0)
    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })

  it('AC4b: ① 未命中 → 下落 ③：腿 2 includes 消费（drainN + appendUser + 剔快照，现状零改动）', () => {
    const queue = makeQueue([{ id: 'q4', text: 'queued text', mode: 'steer' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { steering: ['T'] }]])
    const segs: Segment[] = [{ type: 'text', text: 'T' }]
    vi.mocked(ctx.drainN).mockReturnValue([segs])

    dispatchMessageEvent(ctx, SID, msg('T'))

    expect(queue.confirmDelivery).not.toHaveBeenCalled()
    // ③ 腿 2 现状路径逐点一致（与 effects.test.ts 同款断言；消费后不加 inflight——
    // 真实计数守恒：本帧是自己的确认帧，快照剔空删条目）
    expect(ctx.drainN).toHaveBeenCalledWith(SID, 'steer', 1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
    expect(ctx.queueStates.value.has(SID)).toBe(false)
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC7: 未提交条目（mode undefined）不参与匹配——同文本帧落 ③ 腿 2，条目留队不误出队', () => {
    // 未提交条目不可能产生投递确认帧；若被同文本他帧误配出队 = 永不被投递却标记
    // 已投递（G2 必达破坏）——mode undefined 天然排除（u4a 实现决策，见接口注释）
    const queue = makeQueue([{ id: 'q5', text: 'T' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { steering: ['T'] }]])
    const segs: Segment[] = [{ type: 'text', text: 'T' }]
    vi.mocked(ctx.drainN).mockReturnValue([segs])

    dispatchMessageEvent(ctx, SID, msg('T'))

    expect(queue.confirmDelivery).not.toHaveBeenCalled()
    expect(queue.entries()).toEqual([{ id: 'q5', text: 'T' }]) // 留队，等 flush 投递
    // 落 ③ 现状链正常消费
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
  })

  it("AC4c: 同文本碰撞数量守恒——两帧 'A' 各被 ① 消费一次（FIFO 最早优先），帧数=出队数=快照剔除数", () => {
    // D5.3 第 3 点守恒声明：归属可能互换，但每帧恰被 ①/②/③ 之一消费一次，
    // defer 队列 / queueStates / pendingBuffer 三方按「① 命中即剔一个快照实例」守恒
    const queue = makeQueue([
      { id: 'q1', text: 'A', mode: 'send' },
      { id: 'q2', text: 'A', mode: 'steer' },
    ])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1) // send 条目（q1）的占位
    ctx.queueStates.value = new Map([[SID, { steering: ['A', 'A'] }]])

    // 帧 1：命中最早条目 q1（send）→ 回收占位 1→0 + 剔一个快照实例
    dispatchMessageEvent(ctx, SID, msg('A'))
    expect(queue.confirmed()).toEqual(['q1'])
    expect(ctx.inflightOf()).toBe(0)
    expect(ctx.queueStates.value.get(SID)).toEqual({ steering: ['A'] })

    // 帧 2：命中 q2（steer）→ 不动计数（0 保持，无 decrement）+ 剔到快照空（条目删除）
    dispatchMessageEvent(ctx, SID, msg('A'))
    expect(queue.confirmed()).toEqual(['q1', 'q2'])
    expect(ctx.inflightOf()).toBe(0)
    expect(ctx.queueStates.value.has(SID)).toBe(false)

    // 守恒：2 帧 = 2 次确认出队 = 2 个快照实例剔除；无帧漏到 ②③（appendUser/drainN 未触）
    expect(queue.confirmDelivery).toHaveBeenCalledTimes(2)
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(ctx.drainN).not.toHaveBeenCalled()
  })

  it('AC8: confirmDelivery false（匹配作废）→ 不剔快照不动计数，帧落 ② 现状链不丢', () => {
    const queue = makeQueue([{ id: 'q6', text: 'T', mode: 'send' }])
    queue.failConfirmIds.add('q6') // 同步单线程下防御性不可达路径的契约锁定
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)
    ctx.queueStates.value = new Map([[SID, { steering: ['T'] }]])

    dispatchMessageEvent(ctx, SID, msg('T'))

    expect(queue.confirmDelivery).toHaveBeenCalledWith(SID, 'q6')
    // 匹配作废：快照/计数保持原状，帧由 ② 消费（decrement + return）
    expect(ctx.queueStates.value.get(SID)).toEqual({ steering: ['T'] })
    expect(ctx.inflightOf()).toBe(0)
    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })
})

describe('message_end(user) 三分支 ①a：标记 id 身份匹配（簇 A2 / C-data-08 去文本化）', () => {
  // 条目 id 与 pi 落盘一致用 uuid v4 形态（enqueue 侧 crypto.randomUUID() 的真实形态，
  // DEFER_FLUSH_MARKER_RE 只锚定 uuid 形态标记）
  const ENTRY_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('A2-MF: skill-injector 改写后（落盘文本 ≠ 队列原文）标记 id 仍命中出队——旧文本匹配在此永不命中（红态锚点）', () => {
    // must-fix 场景重现：条目原文含 <xyz-skill>，flush 提交文本尾附加确认标记，runtime
    // skill-injector 展开改写 → pi 落盘/message_end 帧 = 「展开后文本 + 标记」≠ 队列原文。
    // 改造前唯一判据「帧文本 === 条目原文」在此恒 false → 条目永不出队气泡永久卡死；
    // ①a 按标记 id（身份非内容）命中。
    const queuedText = '<xyz-skill name="review"/> 帮我审查'
    const injectedText = `<skill name="review" location="/skills/review">...展开内容...</skill>\n\n帮我审查\n<!--xyz:msg:${ENTRY_ID}-->`
    const queue = makeQueue([{ id: ENTRY_ID, text: queuedText, mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg(injectedText))

    // ①a 身份命中：出队 + 占位回收 + 帧终止（改写文本不再是出队障碍）
    expect(queue.confirmDelivery).toHaveBeenCalledWith(SID, ENTRY_ID)
    expect(queue.entries()).toEqual([])
    expect(ctx.inflightOf()).toBe(0)
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })

  it('A2-PRIO: 帧文本 = 原文 + 标记（无改写）→ ①a 优先命中；文本等值（①b）不再必要', () => {
    // ①b 全文等值对「原文+标记」形态恒 false（标记改变文本），命中只能来自 ①a——
    // 锁定标记通道独立成立，不依赖兜底
    const queue = makeQueue([{ id: ENTRY_ID, text: 'm1', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg(`m1\n<!--xyz:msg:${ENTRY_ID}-->`))

    expect(queue.confirmed()).toEqual([ENTRY_ID])
    expect(ctx.inflightOf()).toBe(0)
  })

  it('A2-STEER: steer 条目带标记改写场景 → ①a 命中出队且不动计数（与 send 同一身份通道）', () => {
    const queue = makeQueue([{ id: ENTRY_ID, text: 'S原文', mode: 'steer' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 2) // 他条目占位——steer 命中不得错抵
    ctx.queueStates.value = new Map([[SID, { steering: ['S改写后\n<!--xyz:msg:' + ENTRY_ID + '-->'] }]])

    dispatchMessageEvent(ctx, SID, msg(`S改写后\n<!--xyz:msg:${ENTRY_ID}-->`))

    expect(queue.confirmed()).toEqual([ENTRY_ID])
    expect(ctx.inflightOf()).toBe(2)
    // 快照剔一个带标记实例（steering 维度镜像含标记形态）→ 剔空删条目
    expect(ctx.queueStates.value.has(SID)).toBe(false)
  })

  it('A2-IDMUTEX: u- 前缀标记（msg-id-mapper 族）不命中裸 uuid 正则——id 空间互斥的回归锁定', () => {
    // 正常 submitSegments 消息带 u-<uuid> 标记（input hook 剥除后正常消息不可能带，
    // 此用例锁正则互斥性：u- 形态帧不被误配进 defer ①a）
    const queue = makeQueue([{ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', text: 'T', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg('T\n<!--xyz:msg:u-3f2504e0-4f89-41d3-9a0c-0305e82c3302-->'))

    // ①a 不命中（u- 形态非裸 uuid）；①b 全文比对也不命中（帧文本带标记 ≠ 原文）
    // → 落 ② 计数消费，条目留队
    expect(queue.confirmDelivery).not.toHaveBeenCalled()
    expect(ctx.inflightOf()).toBe(0)
    expect(queue.entries()).toHaveLength(1)
  })

  it('A2-FALLBACK: 帧文本无标记且等于条目原文 → ①b 文本等值兜底仍命中（既有判据保留）', () => {
    // 标记被 BeforeSend hook 剥除但文本未改写的形态：降级兜底保持改造前语义
    const queue = makeQueue([{ id: ENTRY_ID, text: 'm1', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg('m1'))

    expect(queue.confirmed()).toEqual([ENTRY_ID])
    expect(ctx.inflightOf()).toBe(0)
  })

  // ── [defer segments 化 / D-A1-4] ①b 匹配源改 submitText——富内容条目 draft ≠ 序列化文本 ──

  it('D1-SUBMITTEXT: 富内容条目（submitText ≠ draft text）——帧文本 = submitText 时 ①b 命中，= draft 时不命中', () => {
    // 富内容条目：draft（气泡展示文本）≠ submitText（segmentsToPrompt 序列化产物）。
    // pi 落盘的是序列化文本（image 裸路径等）——①b 比较源必须是 submitText；
    // 若按改造前的 text 比对，帧与条目永失配（气泡永久 pending）。
    const draft = '帮我看下这个报错'
    const submitText = '帮我看下这个报错\n/tmp/shot.png'
    const queue = makeQueue([{ id: ENTRY_ID, text: draft, submitText, mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    // 帧 1：draft 文本（未序列化形态）不命中 ①b——落 ② 计数消费，条目留队
    dispatchMessageEvent(ctx, SID, msg(draft))
    expect(queue.confirmDelivery).not.toHaveBeenCalled()

    // 帧 2：序列化文本（= pi 实际落盘形态）命中 ①b → 出队
    dispatchMessageEvent(ctx, SID, msg(submitText))
    expect(queue.confirmed()).toEqual([ENTRY_ID])
  })

  it('D1-SUBMITTEXT-FALLBACK: submitText 未写（旧形态）→ ①b 回退 text 比对（兼容防御）', () => {
    const queue = makeQueue([{ id: ENTRY_ID, text: 'm1', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)

    dispatchMessageEvent(ctx, SID, msg('m1'))

    expect(queue.confirmed()).toEqual([ENTRY_ID])
  })

  it('D1-MODEXCL: submitText 命中也要求 mode 已写（未提交条目不参与 ①b——G2 必达守恒）', () => {
    const queue = makeQueue([{ id: ENTRY_ID, text: 'draft', submitText: 'serialized' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()

    dispatchMessageEvent(ctx, SID, msg('serialized'))

    expect(queue.confirmDelivery).not.toHaveBeenCalled()
    expect(queue.entries()).toHaveLength(1)
  })
})

describe('provider 未注册 = defer 分区缺席（现状逐字节一致的机理证明）', () => {
  it('AC5a: 无 provider → inflight>0 帧走 ② decrement（与改造前一致）', () => {
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1)
    dispatchMessageEvent(ctx, SID, msg('T'))
    expect(ctx.inflightOf()).toBe(0)
    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })

  it('AC5b: 无 provider → includes 命中帧走 ③ 腿 2（与改造前一致）', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { steering: ['T', 'T'] }]])
    const segs: Segment[] = [{ type: 'text', text: 'T' }]
    vi.mocked(ctx.drainN).mockReturnValue([segs])
    dispatchMessageEvent(ctx, SID, msg('T'))
    expect(ctx.drainN).toHaveBeenCalledWith(SID, 'steer', 1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs)
    expect(ctx.queueStates.value.get(SID)).toEqual({ steering: ['T'] })
  })

  it('AC3: steer 条目命中不动计数的隔离性——在途占位只被自己的确认帧回收', () => {
    // 正向验证 AC2 的反面：send 条目占位只在其自身确认帧到达时回收；
    // steer 条目帧不消耗任何配额（计数无身份，靠 mode 区分——D5.3 被否④的修正）
    const queue = makeQueue([
      { id: 'q7', text: 'first', mode: 'send' },
      { id: 'q8', text: 'second', mode: 'steer' },
    ])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.incrementInflight(SID, 1) // q7（send）占位；q8（steer）无占位

    dispatchMessageEvent(ctx, SID, msg('second')) // steer 条目帧先到
    expect(ctx.inflightOf()).toBe(1) // 不回收 send 占位
    expect(queue.confirmed()).toEqual(['q8'])

    dispatchMessageEvent(ctx, SID, msg('first')) // send 条目帧后到
    expect(ctx.inflightOf()).toBe(0) // 占位由自己的帧回收
    expect(queue.confirmed()).toEqual(['q8', 'q7'])
  })
})

describe('removeQueuedTextFromSnapshot 幂等（设计 §5 待验证点，经 ① 剔除路径断言）', () => {
  /**
   * 逐行结论（registry.ts removeQueuedTextFromSnapshot）：
   * 1. `if (!prev || !arr) return` —— 无快照 / 无该维度数组：no-op；
   * 2. `if (idx === -1) return` —— includes 不命中（实例不存在）：no-op；
   * 3. 命中时 `filter` 不可变写 + 剔空删维度 / 全空删条目（对齐 queue_update 空帧语义）。
   * includes→filter 模式对「快照中不存在的实例」天然幂等：不命中即早退，无副作用。
   * 以下三用例锁定三形态：无快照、有快照无该文本、命中剔除后重复剔除。
   */
  it('ID1: ① 命中但快照无该文本（他文本条目）→ no-op 不抛错、快照原样（含条目不误删）', () => {
    const queue = makeQueue([{ id: 'q9', text: 'T', mode: 'send' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { steering: ['X'], followUp: ['Y'] }]])

    expect(() => dispatchMessageEvent(ctx, SID, msg('T'))).not.toThrow()
    expect(ctx.queueStates.value.get(SID)).toEqual({ steering: ['X'], followUp: ['Y'] })
  })

  it('ID2: ① 命中且无任何快照 → 剔除 no-op 不抛错（断连清快照场景）', () => {
    const queue = makeQueue([{ id: 'q10', text: 'T', mode: 'steer' }])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()

    expect(() => dispatchMessageEvent(ctx, SID, msg('T'))).not.toThrow()
    expect(ctx.queueStates.value.has(SID)).toBe(false)
  })

  it('ID3: 同文本重复剔除幂等——首帧剔空后，快照停留形态不被二次消费破坏', () => {
    // 快照 ['A','A'] 两帧 'A'：逐帧各剔一个实例，第二次剔除时首个实例已不存在（idx=-1
    // 早退）——剔除动作重复执行结果一致（幂等），终态与「每实例恰剔一次」相同
    const queue = makeQueue([
      { id: 'q11', text: 'A', mode: 'send' },
      { id: 'q12', text: 'A', mode: 'steer' },
    ])
    setCompactQueueProviderForEffects(() => queue)
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { steering: ['A', 'A'] }]])

    dispatchMessageEvent(ctx, SID, msg('A'))
    dispatchMessageEvent(ctx, SID, msg('A'))

    // 快照不再含 'A'（两实例各剔一次），且条目随剔空删除（不积累空形态，AC4c 守恒同款）
    expect(ctx.queueStates.value.has(SID)).toBe(false)
    expect(ctx.appendUser).not.toHaveBeenCalled()
  })
})

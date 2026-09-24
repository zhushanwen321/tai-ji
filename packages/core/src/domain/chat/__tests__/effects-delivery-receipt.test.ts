/**
 * message_end(user) 送达回执 + session.delivery 投影单测（投递所有权内核 u3b / D2① 泛化 +
 * D7 单一数据源）。
 *
 * 前身：effects-defer-confirmation.test.ts（defer 分区 FIFO 文本匹配 + provider 注入）——
 * defer 队列状态机已整体退役（设计 §3.1 删除面），确认通道升级为「内核裸标记 id 匹配投影
 * 条目」（C-data-08 修订方向：id 是身份不是内容），git 可追溯。
 *
 * 覆盖：
 * - ①a 标记回执：命中投影条目 → 投影转 delivered + morph 段按序入流（捕获过才入）+
 *   inflight 占位回收 + 帧消费终止（不走 ②）
 * - 双形态匹配契约桥：裸 uuid（期望形态）/ u-<uuid> 原文都命中（跨 u1 契约错配消除面）
 * - direct 车道回执：无 morph 段 → 不重复入流，仅占位回收
 * - 未命中下落 ②：无标记 / 标记不命中投影 → 纯计数兜底（现状链）
 * - 幂等：已 delivered 条目二次回执不重复消费
 * - [消息撤回 U8] 回执入流保号：两分支（① morph 段 / ② 外来纯文本降级）appendUser
 *   第三参均传原 clientUuid——重建气泡沿用提交 id（live 窗口撤回定位锚）
 * - 投影生命周期：replaceDeliveryProjection 整体替换 / 空帧删键 / captureMorphSegments
 *   一次性消费
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/effects-delivery-receipt.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import {
  dispatchMessageEvent,
} from '../effects/registry'
import {
  replaceDeliveryProjection,
  getDeliveryProjection,
  captureMorphSegments,
  resetDeliveryProjectionForTest,
} from '../effects/user-delivery'
import type { MessageEffectContext } from '../effect-types'
import type { DeliveryFrameEntry } from '../api-port'
import type { Message, Segment } from '@taiji/shared'
import { userEndFrame } from './helpers/fixtures'

const SID = 's-delivery'
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const CLIENT_UUID = `u-${UUID}`

/**
 * 真实计数语义的 inflight（区别于纯 mock——命中回收断言读数值，非调用记录）。
 * incrementInflight 已随 ctx 成员收口删除（增量归 store 方法面）——测试预置计数走
 * 本闭包的 addInflight 直写 Map，与 store.incrementInflight 增量语义等价。
 */
function makeCtx(): MessageEffectContext & { inflightOf: () => number; addInflight: (n?: number) => void } {
  const inflight = new Map<string, number>()
  return {
    messages: ref(new Map([[SID, shallowRef([] as Message[])]])),
    retryStates: ref(new Map()),
    applyFileChanges: vi.fn(),
    markChangeSetsSuperseded: vi.fn(),
    finalizeSession: vi.fn(),
    clearPendingSend: vi.fn(),
    appendUser: vi.fn(),
    applyEntryFrame: vi.fn(),
    getInflight: (sid: string) => inflight.get(sid) ?? 0,
    decrementInflight: (sid: string, n = 1) => {
      const next = Math.max(0, (inflight.get(sid) ?? 0) - n)
      if (next === 0) inflight.delete(sid)
      else inflight.set(sid, next)
    },
    clearInflight: (sid: string) => {
      inflight.delete(sid)
    },
    inflightOf: () => inflight.get(SID) ?? 0,
    addInflight: (n = 1) => {
      inflight.set(SID, (inflight.get(SID) ?? 0) + n)
    },
  }
}

function entry(over: Partial<DeliveryFrameEntry> = {}): DeliveryFrameEntry {
  return { clientUuid: CLIENT_UUID, preview: 'hi', state: 'in-flight', lane: 'steer', ...over }
}

beforeEach(() => {
  resetDeliveryProjectionForTest()
})

describe('session.delivery 投影生命周期（D7 单一数据源）', () => {
  it('replaceDeliveryProjection 整体替换（last-value）+ 空帧删键（不积累空形态）', () => {
    replaceDeliveryProjection(SID, [entry()])
    expect(getDeliveryProjection(SID)).toHaveLength(1)
    replaceDeliveryProjection(SID, [entry({ clientUuid: 'u-1', state: 'queued', lane: 'queued' })])
    expect(getDeliveryProjection(SID).map((e) => e.clientUuid)).toEqual(['u-1'])
    // 空帧（cancelled 全退场 / 队列清空形态）→ 删键
    replaceDeliveryProjection(SID, [])
    expect(getDeliveryProjection(SID)).toHaveLength(0)
  })
})

describe('message_end(user) 送达回执（u3b / D2① 泛化，C-data-08 修订方向）', () => {
  it('AC1: 标记命中 steer 条目 → 投影转 delivered + morph 段按序入流 + 占位回收 + 帧终止', () => {
    const segs: Segment[] = [{ type: 'text', text: '排队消息' }]
    replaceDeliveryProjection(SID, [entry()])
    captureMorphSegments(SID, CLIENT_UUID, segs)
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, '排队消息', UUID))

    // 投影转 delivered（队列区随帧隐去；u3c 渲染消费）
    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    // morph 段按原 segments 入流（overlay-only 插入点；气泡已 morph 移除后恢复为正常气泡）
    // [消息撤回 U8] 分支①保号：第三参传原 clientUuid——重建气泡沿用提交 id（撤回定位锚）
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs, CLIENT_UUID)
    // 占位回收：1 → 0（本帧即确认帧，② 不再重复扣）
    expect(ctx.inflightOf()).toBe(0)
    // 帧消费终止：权威 reducer 喂入无条件保留（调用方在 ① 之前执行）
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
  })

  it('AC2: u-<uuid> 原文形态标记同样命中（跨 u1 契约错配消除面，双形态收口）', () => {
    replaceDeliveryProjection(SID, [entry()])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi', CLIENT_UUID))

    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC3: direct 条目回执 → 无 morph 段不重复入流（气泡原位保持），仅投影转态 + 占位回收', () => {
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi', UUID))

    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC4: 无标记帧（外来直发形态）→ 下落 ② 纯计数兜底，投影不动', () => {
    replaceDeliveryProjection(SID, [entry()])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'plain text'))

    expect(getDeliveryProjection(SID)[0]?.state).toBe('in-flight')
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC5: 标记不命中投影（帧缺失/异 session 形态）→ 下落 ②，不误配', () => {
    replaceDeliveryProjection(SID, [entry({ clientUuid: 'u-other' })])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi', UUID))

    expect(getDeliveryProjection(SID)[0]?.state).toBe('in-flight')
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC6: 幂等——已 delivered 条目的重复回执不再消费（不二次入流不重复扣计数）', () => {
    replaceDeliveryProjection(SID, [entry()])
    captureMorphSegments(SID, CLIENT_UUID, [{ type: 'text', text: '排队消息' }])
    const ctx = makeCtx()
    ctx.addInflight(2)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, '排队消息', UUID))
    // 第二次同标记帧（重复事件形态）：条目已 delivered → ① 不命中 → 落 ② 纯计数
    dispatchMessageEvent(ctx, SID, userEndFrame(SID, '排队消息', UUID))

    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.inflightOf()).toBe(0) // 1（① 回收）+ 1（② 兜底扣）
  })

  it('AC7: inflight == 0 且无命中 → 帧静默终止（② 早退，无副作用）', () => {
    replaceDeliveryProjection(SID, [entry()])
    const ctx = makeCtx()

    expect(() => dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi'))).not.toThrow()
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(getDeliveryProjection(SID)[0]?.state).toBe('in-flight')
  })
})

describe('captureMorphSegments（morph 段暂存，送达回执消费）', () => {
  it('重复捕获以最后一次为准；消费一次性（回执后二次回执无段可入）', () => {
    replaceDeliveryProjection(SID, [entry()])
    captureMorphSegments(SID, CLIENT_UUID, [{ type: 'text', text: '第一版' }])
    captureMorphSegments(SID, CLIENT_UUID, [{ type: 'text', text: '第二版' }])
    const ctx = makeCtx()

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi', UUID))

    expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '第二版' }], CLIENT_UUID)
  })
})

// ── [消息撤回 U8] 回执入流保号（两分支重建气泡沿用原 id）──────────────────────

describe('送达回执入流保号（消息撤回 U8：重建气泡沿用原 clientUuid）', () => {
  it('分支②外来纯文本降级入流：无 morph 段无本地气泡的 steer 条目 → appendUser 收到原 clientUuid', () => {
    // 外来条目（session_manager send / 收养形态）：内核投影有条目、无本地乐观气泡、
    // 未捕获 morph 段 → 显示责任由 ② 纯文本降级分支承接，且保号传条目 clientUuid
    replaceDeliveryProjection(SID, [entry()])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, '外来消息', UUID))

    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    // 保号：第三参 = 内核条目 clientUuid（外来形态可能为裸 uuid，照保——见 store.appendUser 注释）
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '外来消息' }], CLIENT_UUID)
    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
  })

  it('分支②外来条目为内核裸 uuid 形态：照保原 id（保号语义优先于 u- 形态约束）', () => {
    const bareUuid = '5b1a6c2e-8d34-4f07-b1c5-92d7e83c4402'
    replaceDeliveryProjection(SID, [entry({ clientUuid: bareUuid })])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, userEndFrame(SID, '裸 uuid 条目', bareUuid))

    expect(ctx.appendUser).toHaveBeenCalledWith(
      SID,
      [{ type: 'text', text: '裸 uuid 条目' }],
      bareUuid,
    )
  })
})

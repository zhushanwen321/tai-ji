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
 * - direct 车道回执：发送端有本地同 id 气泡 → 不重复入流（防双插由 hasLocalBubble
 *   承接，D4），仅占位回收；观看端无气泡 direct 消息入流补显（V17，锚
 *   effects/__tests__/user-delivery.test.ts）
 * - 未命中下落 ②：无标记 / 标记不命中投影 → 纯计数兜底（现状链）
 * - 幂等：已 delivered 条目二次回执不重复消费
 * - [dmg-r1-5] 多标记帧整批消费（splitComposed 放弃拆分 → 整条多标记文本一次进
 *   transcript）：全部标记逐一消费投影条目（对齐 runtime confirmByMessageEnd 全量提取）
 *   ——morph 段逐条目入流 / 全无段帧整帧文本降级一次（同帧互斥防重复）/ 粘贴标记不命中
 *   即跳过 / 同 id 重复标记拒重
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
  getDeliveryProjectionRef,
  captureMorphSegments,
  resetDeliveryProjectionForTest,
} from '../effects/user-delivery'
import type { MessageEffectContext } from '../effect-types'
import type { DeliveryFrameEntry } from '../api-port'
import type { Message, Segment, ServerMessage } from '@taiji/shared'
import { userEndFrame } from './helpers/fixtures'

// getDeliveryProjection 快照读口已随过度设计审计候选 1 删除——测试断言经响应式读口组装同款快照。
const getDeliveryProjection = (sid: string): readonly DeliveryFrameEntry[] =>
  getDeliveryProjectionRef().value.get(sid) ?? []

const SID = 's-delivery'
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const CLIENT_UUID = `u-${UUID}`

/**
 * 真实计数语义的 inflight（区别于纯 mock——命中回收断言读数值，非调用记录）。
 * incrementInflight 已随 ctx 成员收口删除（增量归 store 方法面）——测试预置计数走
 * 本闭包的 addInflight 直写 Map，与 store.incrementInflight 增量语义等价。
 */
function makeCtx(localMessages: Message[] = []): MessageEffectContext & { inflightOf: () => number; addInflight: (n?: number) => void } {
  const inflight = new Map<string, number>()
  return {
    messages: ref(new Map([[SID, shallowRef(localMessages)]])),
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

  it('AC3: direct 条目回执 → 无 morph 段且本地有同 id 气泡不重复入流（D4 后防双插由 id 判定承接，气泡原位保持）', () => {
    // [D4 修订] 修前本用例锁定「direct 车道整体豁免」（无气泡也不入流）；D4
    //（remote-use-shell-unification）后 direct 豁免由 hasLocalBubble 精确承接——观看端
    // foreign 无气泡 → 入流补显（直调侧谓词锚见 effects/__tests__/user-delivery.test.ts
    // D4-AC1/AC4），本用例改为发送端形态（本地有同 id 乐观气泡），经全 handler 链锁定
    // 防双插 + 回执侧照常（投影转态 + 占位回收与入流判定正交）。
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const ctx = makeCtx([{ id: CLIENT_UUID, role: 'user', content: [{ type: 'text', text: 'hi' }], status: 'complete', timestamp: 0 }])
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

// ── [dmg-r1-5] 多标记帧整批消费（splitComposed 放弃拆分 → 整条多标记文本一次进 transcript）──

/**
 * 多标记帧（内核合批放弃拆分的整批投递形态）：BATCH_SEP（'\n\n---\n\n'）连接各条目
 * 文本 + 各自尾标记。entry 形态与 helpers.userEndFrame 同构（多标记变体本地构造——
 * helpers 头注释「本地版有语义差异时保留各文件实现」纪律，不动共享 fixture）。
 */
function composedEndFrame(sid: string, parts: { text: string; marker: string }[]): ServerMessage {
  const fullText = parts
    .map(({ text, marker }) => `${text}\n<!--taiji:msg:${marker}-->`)
    .join('\n\n---\n\n')
  return {
    type: 'message.message_end',
    payload: {
      sessionId: sid,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: fullText }], timestamp: 0 },
      },
    },
  } as ServerMessage
}

const UUID_B = '6e9f8a3c-1b25-4d6e-8c47-a9f0d2b35e18'
const CLIENT_UUID_B = `u-${UUID_B}`

describe('多标记帧整批消费（dmg-r1-5：整批投递回执不再只消费尾标记）', () => {
  it('AC8: 两条目均有 morph 段 → 全部按段各自入流 + 投影全转 delivered + inflight 批量扣减', () => {
    const segsA: Segment[] = [{ type: 'text', text: '排队消息 A' }]
    const segsB: Segment[] = [{ type: 'text', text: '排队消息 B' }]
    replaceDeliveryProjection(SID, [entry(), entry({ clientUuid: CLIENT_UUID_B })])
    captureMorphSegments(SID, CLIENT_UUID, segsA)
    captureMorphSegments(SID, CLIENT_UUID_B, segsB)
    const ctx = makeCtx()
    ctx.addInflight(2)

    dispatchMessageEvent(ctx, SID, composedEndFrame(SID, [
      { text: '排队消息 A', marker: UUID },
      { text: '排队消息 B', marker: UUID_B },
    ]))

    // 其余条目不再等不到消费：两段各自按原 segments 入流（保号各传原 clientUuid）
    expect(ctx.appendUser).toHaveBeenCalledTimes(2)
    expect(ctx.appendUser).toHaveBeenNthCalledWith(1, SID, segsA, CLIENT_UUID)
    expect(ctx.appendUser).toHaveBeenNthCalledWith(2, SID, segsB, CLIENT_UUID_B)
    // 投影全转 delivered（修前仅尾标记条目转态，其余滞留至 TTL/下一帧快照覆盖）
    expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered', 'delivered'])
    // 批量确认扣减：命中 2 条 = 扣 2（每条乐观气泡挂 1）
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC9: 全无段多标记帧（外来合批形态）→ 整帧剥标记文本降级入流一次，保号挂首个降级条目', () => {
    replaceDeliveryProjection(SID, [entry(), entry({ clientUuid: CLIENT_UUID_B })])
    const ctx = makeCtx()
    ctx.addInflight(2)

    dispatchMessageEvent(ctx, SID, composedEndFrame(SID, [
      { text: '外来消息 A', marker: UUID },
      { text: '外来消息 B', marker: UUID_B },
    ]))

    // 整帧文本涵盖全部条目内容，逐条目入流同一整帧文本会重复——按帧只入流一次。
    // 剥净全部标记（DEFER_FLUSH_MARKER_RE_GLOBAL 全量剥除），标记原占位的换行保留
    // （条目尾标记前的 \n + BATCH_SEP 前导 \n 叠加为三连换行），trimEnd 只收尾部
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.appendUser).toHaveBeenCalledWith(
      SID,
      [{ type: 'text', text: '外来消息 A\n\n\n---\n\n外来消息 B' }],
      CLIENT_UUID,
    )
    expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered', 'delivered'])
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC10: 防误配保留——多标记帧中粘贴形态标记不命中投影即跳过，命中的条目正常消费', () => {
    const segsA: Segment[] = [{ type: 'text', text: '排队消息 A' }]
    replaceDeliveryProjection(SID, [entry()])
    captureMorphSegments(SID, CLIENT_UUID, segsA)
    const ctx = makeCtx()
    ctx.addInflight(1)

    // 第二个标记（UUID_B）无对应投影条目 = 正文自带粘贴标记形态：跳过不误配
    dispatchMessageEvent(ctx, SID, composedEndFrame(SID, [
      { text: '排队消息 A', marker: UUID },
      { text: '粘贴的尾巴', marker: UUID_B },
    ]))

    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, segsA, CLIENT_UUID)
    expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered'])
    expect(ctx.inflightOf()).toBe(0)
  })

  it('AC11: 同帧重复同 id 标记拒重——只消费一次，不重复扣 inflight', () => {
    replaceDeliveryProjection(SID, [entry()])
    const ctx = makeCtx()
    ctx.addInflight(1)

    dispatchMessageEvent(ctx, SID, composedEndFrame(SID, [
      { text: 'hi', marker: UUID },
      { text: '再次提及', marker: UUID },
    ]))

    // 同 id 第二次出现不再命中（consumedIds 拒重）：无段 → 整帧文本降级一次
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered'])
    expect(ctx.inflightOf()).toBe(0)
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

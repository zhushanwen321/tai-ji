/**
 * confirmKernelDeliveryOnMessageEnd ② 降级入流豁免条件直接单测（D4——remote-use-shell-unification）。
 *
 * 修前该函数零直接测试（间接覆盖在 domain/chat/__tests__/effects-delivery-receipt.test.ts，
 * 经 dispatchMessageEvent 走全 handler 链）；本文件直接 import 函数，聚焦 ② 降级入流的
 * 豁免谓词分叉：
 * - 修前：`lane !== 'direct' && foreign`（direct 车道整体豁免——S4 缺陷：观看端 direct
 *   外来消息无人负责显示，切走切回才补显）
 * - 修后（D4）：`foreign && 无本地同 id 气泡`——foreign 判定本身含 hasLocalBubble 否定
 *   （`segments === undefined && !hasLocalBubble(...)`），故谓词收敛为 `foreign`：发送端
 *   direct 有本地气泡 → foreign=false 不入流（防双插语义不变）；观看端 foreign 无气泡 →
 *   入流补显（G4/V17 修复目标）。
 *
 * 与间接覆盖的分工：effects-delivery-receipt.test.ts 护帧消费主链（回执匹配/保号/整批）；
 * 本文件护「两端行为分叉」谓词语义（V16 桌面不变面 + V17 改变面的单测锚）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/effects/__tests__/user-delivery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import {
  confirmKernelDeliveryOnMessageEnd,
  replaceDeliveryProjection,
  getDeliveryProjectionRef,
  resetDeliveryProjectionForTest,
} from '../user-delivery'
import type { MessageEffectContext } from '../../effect-types'
import type { DeliveryFrameEntry } from '../../api-port'
import type { PiMessageEntry } from '../../apply-entry'
import type { Message, Segment } from '@taiji/shared'

const SID = 's-d4'
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const CLIENT_UUID = `u-${UUID}`

const getDeliveryProjection = (sid: string): readonly DeliveryFrameEntry[] =>
  getDeliveryProjectionRef().value.get(sid) ?? []

/** 真实计数语义的 inflight（读写真实 Map——命中回收断言读数值，范式同 effects-delivery-receipt）。 */
function makeCtx(
  localMessages: Message[] = [],
): MessageEffectContext & { inflightOf: () => number; addInflight: (n?: number) => void } {
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
  return { clientUuid: CLIENT_UUID, preview: 'hi', state: 'in-flight', lane: 'direct', ...over }
}

/** 发送端本地乐观气泡（appendUser 保号契约：气泡 id = 内核条目 clientUuid，hasLocalBubble 按 id 匹配）。 */
function localBubble(id: string): Message {
  return { id, role: 'user', content: [{ type: 'text', text: '本地乐观气泡' }], status: 'complete', timestamp: 0 }
}

/** message_end(user) 帧 entry（形态同 helpers.userEndFrame 的 payload.entry，本地版直接喂函数）。 */
function userEndEntry(text: string, marker: string): PiMessageEntry {
  return {
    type: 'message',
    id: 'e1',
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: `${text}\n<!--taiji:msg:${marker}-->` }], timestamp: 0 },
  }
}

beforeEach(() => {
  resetDeliveryProjectionForTest()
})

describe('D4 foreign 入流豁免精确化（remote-use-shell-unification D4：V17 改变面 + V16 不变面）', () => {
  it('D4-AC1: 观看端 foreign 无本地气泡的 direct 车道消息 → 入流补显（修前 direct 整体豁免不显示，S4 修复主体）', () => {
    // 场景：双端同看会话，A 端 direct 车道发消息（session_manager 注入同形态），B 端
    // 无本地乐观气泡无 morph 段 → 降级入流剥标记纯文本（显示责任承接，不静默丢显示）
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const ctx = makeCtx()
    ctx.addInflight(1)

    const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('外来消息', UUID))

    expect(consumed).toBe(true)
    const expected: Segment[] = [{ type: 'text', text: '外来消息' }]
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, expected, CLIENT_UUID)
    // 回执消费照常：投影转 delivered + 占位回收（入流豁免不影响回执侧）
    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    expect(ctx.inflightOf()).toBe(0)
  })

  it('D4-AC2: foreign 无本地气泡的 steer 车道消息照旧入流（既有语义不变锚，V16 不变面）', () => {
    replaceDeliveryProjection(SID, [entry({ lane: 'steer' })])
    const ctx = makeCtx()
    ctx.addInflight(1)

    const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('外来消息', UUID))

    expect(consumed).toBe(true)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '外来消息' }], CLIENT_UUID)
    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    expect(ctx.inflightOf()).toBe(0)
  })

  it('D4-AC3: 发送端 direct 有本地同 id 气泡 → 不入流（防双插语义不变，气泡原位保持）', () => {
    // 场景：本端发送（direct 车道），乐观气泡已入流（id = clientUuid 保号同源）——
    // hasLocalBubble 命中 → foreign=false → 降级入流豁免（修前由 lane 豁免、修后由 id 判定承接）
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const ctx = makeCtx([localBubble(CLIENT_UUID)])
    ctx.addInflight(1)

    const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('hi', UUID))

    expect(consumed).toBe(true)
    expect(ctx.appendUser).not.toHaveBeenCalled()
    // 回执侧照常执行：投影转态 + 占位回收与入流判定正交（发送端回执语义不变）
    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    expect(ctx.inflightOf()).toBe(0)
  })

  it('D4-AC4: direct 车道两端行为分叉对拍——同帧形态，观看端入流补显 vs 发送端不入流', () => {
    const watcher = makeCtx([]) // 观看端：无本地气泡
    const sender = makeCtx([localBubble(CLIENT_UUID)]) // 发送端：乐观气泡已入流
    watcher.addInflight(1)
    sender.addInflight(1)

    // 投影是模块级单例：两次调用各自重置条目（watcher 消费会转 delivered，sender
    // 若共用已转态条目则回执不命中、分叉对拍退化为消费 miss——须重置后再投同形态帧）
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const watcherConsumed = confirmKernelDeliveryOnMessageEnd(watcher, SID, userEndEntry('外来消息', UUID))
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const senderConsumed = confirmKernelDeliveryOnMessageEnd(sender, SID, userEndEntry('外来消息', UUID))

    // 帧消费终止判定两端一致（回执命中），分叉只在入流
    expect(watcherConsumed).toBe(true)
    expect(senderConsumed).toBe(true)
    expect(watcher.appendUser).toHaveBeenCalledTimes(1)
    expect(watcher.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '外来消息' }], CLIENT_UUID)
    expect(sender.appendUser).not.toHaveBeenCalled()
    expect(watcher.inflightOf()).toBe(0)
    expect(sender.inflightOf()).toBe(0)
  })

  it('D4-AC5: 分区有气泡但 id 不同 → 仍判 foreign 入流（hasLocalBubble 按同 id 精确匹配，非「分区非空即发送端」）', () => {
    replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
    const ctx = makeCtx([localBubble('u-some-other-id')])
    ctx.addInflight(1)

    const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('外来消息', UUID))

    expect(consumed).toBe(true)
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '外来消息' }], CLIENT_UUID)
  })

  it('D4-AC6: foreign 判定取值时机在 ② 入流前（appendUser 不反噬同帧后续条目的 foreign 判定）', () => {
    // 多标记帧：首个降级条目 appendUser 后，后续条目的 hasLocalBubble 若读同一分区
    // 会被自己刚写入的气泡污染——判定在收集阶段一次性完成（appendUser 前取值），
    // 本用例锚定该时序不被谓词重写破坏
    const UUID_B = '6e9f8a3c-1b25-4d6e-8c47-a9f0d2b35e18'
    const CLIENT_UUID_B = `u-${UUID_B}`
    replaceDeliveryProjection(SID, [entry(), entry({ clientUuid: CLIENT_UUID_B })])
    const ctx = makeCtx()
    ctx.addInflight(2)

    const fullText = `外来消息 A\n<!--taiji:msg:${UUID}-->\n\n---\n\n外来消息 B\n<!--taiji:msg:${UUID_B}-->`
    const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: fullText }], timestamp: 0 },
    })

    // 整帧只入流一次（首个降级条目保号），第二个条目不因首条入流而行为漂移
    expect(consumed).toBe(true)
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered', 'delivered'])
    expect(ctx.inflightOf()).toBe(0)
  })

  it('D4-AC7: 内核收养条目 m- 形态回执 → 观看端 foreign 入流保号收养 id（2026-10-03 D3 A8 归因修复——shared 标记身份段不认 m- 形态时，回执在消费端构造性 miss、观看端 live 无人入流，live ≠ reload）', () => {
    // 场景（探针实证）：外部 message.send 不带 clientUuid → registry 收养生成 m-<token>-<n>
    // → 回显文本尾标记 <!--taiji:msg:m-...-->，投影条目 clientUuid = m- 形态。前端标记
    // 身份段收编 m- 分支后（MSG_ID_ADOPTED_SEGMENT），① 命中条目 → 无本地气泡 → foreign
    // 降级入流，保号传收养 id 本体（e.clientUuid === bareId 分支）。
    const ADOPTED = 'm-mustgqln-3'
    replaceDeliveryProjection(SID, [entry({ clientUuid: ADOPTED, lane: 'direct' })])
    const ctx = makeCtx()
    ctx.addInflight(1)

    const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('外部注入消息', ADOPTED))

    expect(consumed).toBe(true)
    const expected: Segment[] = [{ type: 'text', text: '外部注入消息' }]
    expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    expect(ctx.appendUser).toHaveBeenCalledWith(SID, expected, ADOPTED)
    expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    expect(ctx.inflightOf()).toBe(0)
  })
})

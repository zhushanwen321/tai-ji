// effect-types.test.ts —— core C18 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/chat/effect-types.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/bash-effects.test.ts（12 用例，skip 0）
//   - src/domain/chat/__tests__/effects-delivery-receipt.test.ts（20 用例，skip 0）
//   - src/domain/chat/effects/__tests__/user-delivery.test.ts（7 用例，skip 0）

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type ShallowRef, shallowRef, ref } from 'vue'
import { type Message, type PiEntry, type Segment, type ServerMessage } from '@taiji/shared'
import { bashStartEffect, bashResultEffect, bashAbortedEffect, getExecutingBash, markBashError, findLastStreamingBashIndex } from '../bash-effects'
import { applyEntry, createInitialChatViewState, type PiMessageEntry } from '../apply-entry'
import { commitMessages, type MessagesRef } from '../mutations'
import { type MessageEffectContext, type MessageEffectHandler } from '../effect-types'
import { dispatchMessageEvent } from '../effects/registry'
import { replaceDeliveryProjection, getDeliveryProjectionRef, captureMorphSegments, resetDeliveryProjectionForTest, confirmKernelDeliveryOnMessageEnd } from '../effects/user-delivery'
import { type DeliveryFrameEntry } from '../api-port'
import { userEndFrame } from './helpers/fixtures'

// ======== 来源：bash-effects.test.ts ========
describe("bash-effects", () => {
  /** 测试用 ctx：messages ref（渲染 overlay）+ applyEntryFrame（真实 reducer 喂入，镜像 store 实现）。 */
  function createTestCtx() {
    const messages: MessagesRef = shallowRef(new Map<string, ShallowRef<Message[]>>())
    const entryStates = new Map<string, ReturnType<typeof createInitialChatViewState>>()
    const applyEntryFrame = (sid: string, entry: PiEntry): void => {
      entryStates.set(sid, applyEntry(entryStates.get(sid) ?? createInitialChatViewState(), entry))
    }
    const ctx = {
      messages,
      applyEntryFrame,
    } as unknown as MessageEffectContext
    return { ctx, messages, entryStates }
  }

  function dispatch(handler: MessageEffectHandler, ctx: MessageEffectContext, sid: string, payload: Record<string, unknown>): void {
    handler(ctx, sid, payload)
  }

  function bashResultPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: 's1',
      command: 'ls -la',
      output: 'file1\nfile2',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 1724000000000,
      ...extra,
    }
  }

  describe('bashStartEffect：ephemeral 执行态（不建消息项）', () => {
    it('bashStart 不创建 messages 数组项，executingBash 置位（命令 + 开始时刻）', () => {
      const { ctx, messages } = createTestCtx()
      dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 1', excludeFromContext: false, timestamp: 1234 })

      expect(messages.value.get('s1')?.value ?? []).toHaveLength(0)
      expect(getExecutingBash('s1')).toEqual({ command: 'sleep 1', startedAt: 1234 })
    })

    it('executingBash 按 session 分区（Map 分区范式：互不串扰）', () => {
      const { ctx } = createTestCtx()
      dispatch(bashStartEffect, ctx, 'sA', { command: 'cmd-a', excludeFromContext: false })
      dispatch(bashStartEffect, ctx, 'sB', { command: 'cmd-b', excludeFromContext: false })

      expect(getExecutingBash('sA')?.command).toBe('cmd-a')
      expect(getExecutingBash('sB')?.command).toBe('cmd-b')
    })
  })

  describe('bashResultEffect：bashExecution entry 化（reducer 唯一入流通道）', () => {
    it('使用者可见：ref 末尾出现 complete 态 bashExecution system 消息（命令/输出/exitCode 正确）', () => {
      const { ctx, messages } = createTestCtx()
      dispatch(bashStartEffect, ctx, 's1', { command: 'ls -la', excludeFromContext: false, timestamp: 1 })
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload())

      const list = messages.value.get('s1')?.value ?? []
      expect(list).toHaveLength(1)
      const m = list[0]
      expect(m.role).toBe('system')
      expect(m.status).toBe('complete')
      expect(m.bashExecution?.command).toBe('ls -la')
      expect(m.bashExecution?.output).toBe('file1\nfile2')
      expect(m.bashExecution?.exitCode).toBe(0)
      expect(m.bashExecution?.timestamp).toBe(1724000000000)
    })

    it('构建者：entry 形态对齐 apply-entry bashExecution case（role/command/exitCode/exclude + ISO timestamp），经 applyEntryFrame 喂 reducer state', () => {
      const { ctx, entryStates } = createTestCtx()
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ excludeFromContext: true, fullOutputPath: '/tmp/out.txt' }))

      // reducer state 与 ref 同步产出（applyEntryFrame 喂入 + overlay 派生视图同 entry）
      const state = entryStates.get('s1')
      expect(state).toBeDefined()
      expect(state!.messages).toHaveLength(1)
      const reduced = state!.messages[0]
      expect(reduced.role).toBe('system')
      expect(reduced.bashExecution).toMatchObject({
        command: 'ls -la',
        output: 'file1\nfile2',
        exitCode: 0,
        excludeFromContext: true,
        fullOutputPath: '/tmp/out.txt',
      })
    })

    it('探针①语义：excludeFromContext bash 与普通 bash 同路径 entry 化（不 liveOnly、不丢弃）', () => {
      const { ctx, messages, entryStates } = createTestCtx()
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ excludeFromContext: true }))

      const ref = messages.value.get('s1')?.value ?? []
      expect(ref).toHaveLength(1)
      expect(ref[0].bashExecution?.excludeFromContext).toBe(true)
      expect(entryStates.get('s1')!.messages).toHaveLength(1)
    })

    it('executingBash 清除（与 bashStart 置位成对）', () => {
      const { ctx } = createTestCtx()
      dispatch(bashStartEffect, ctx, 's1', { command: 'ls', excludeFromContext: false })
      expect(getExecutingBash('s1')).toBeDefined()
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload())
      expect(getExecutingBash('s1')).toBeUndefined()
    })

    it('bashAborted 帧端到端（abortBash 兜底终态，wire 形态 { sessionId, timestamp }）：只清执行态，不产 entry（UI 中止态，无空命令卡片）', () => {
      const { ctx, messages, entryStates } = createTestCtx()
      dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 999', excludeFromContext: false })
      // wire 载荷与 runtime BashDispatcher.abortBash 广播形态逐字段一致（shared
      // ServerMessageMap['message.bashAborted']）——产生侧锁在 runtime
      // message-dispatcher-bash.test.ts T8/T8b，本侧按同一 shared 契约消费；
      // UI 中止态 = ActivityStrip 瞬时执行行消失（renderer MessageStream-bash.test.ts 锁）。
      dispatch(bashAbortedEffect, ctx, 's1', { sessionId: 's1', timestamp: 1724000000001 })

      expect(messages.value.get('s1')?.value ?? []).toHaveLength(0)
      expect(entryStates.get('s1')).toBeUndefined()
      expect(getExecutingBash('s1')).toBeUndefined()
    })

    it('D4-3 边界：真实 cancelled bashResult（command 非空）照常 entry 化——哨兵形态判别删除后不误吞真实 abort 结果', () => {
      const { ctx, messages } = createTestCtx()
      dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 5', excludeFromContext: false })
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ command: 'sleep 5', output: '部分输出', exitCode: null, cancelled: true }))

      const list = messages.value.get('s1')?.value ?? []
      expect(list).toHaveLength(1)
      expect(list[0].bashExecution?.command).toBe('sleep 5')
      expect(list[0].bashExecution?.cancelled).toBe(true)
      expect(getExecutingBash('s1')).toBeUndefined()
    })

    it('错误兜底帧（RPC 失败 "[bash error] ..."，cancelled:false）照常 entry 化', () => {
      const { ctx, messages } = createTestCtx()
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ output: '[bash error] timeout', exitCode: null }))

      const list = messages.value.get('s1')?.value ?? []
      expect(list).toHaveLength(1)
      expect(list[0].bashExecution?.output).toBe('[bash error] timeout')
      expect(list[0].bashExecution?.exitCode).toBeNull()
    })

    it('顺序：两次 bashResult 依帧序追加（延迟 flush 与立即发布同一 handler）', () => {
      const { ctx, messages } = createTestCtx()
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ command: 'first', timestamp: 1 }))
      dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ command: 'second', output: 'b', timestamp: 2 }))

      const list = messages.value.get('s1')?.value ?? []
      expect(list.map((m) => m.bashExecution?.command)).toEqual(['first', 'second'])
    })
  })

  describe('markBashError：错误路径兜底清执行态', () => {
    it('清 executingBash（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）', () => {
      const { ctx, messages } = createTestCtx()
      dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 999', excludeFromContext: false })
      expect(getExecutingBash('s1')).toBeDefined()

      markBashError(messages, 's1', 'abort failed')
      expect(getExecutingBash('s1')).toBeUndefined()
    })
  })

  describe('findLastStreamingBashIndex（契约保留：markBashError / 手动种子场景）', () => {
    it('命中最后一条 streaming bash，无则 -1', () => {
      const mk = (status: Message['status']): Message => ({
        id: 'bash-x',
        role: 'system',
        content: '',
        status,
        bashExecution: { command: 'c', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 0 },
      } as Message)
      expect(findLastStreamingBashIndex([])).toBe(-1)
      expect(findLastStreamingBashIndex([mk('complete')])).toBe(-1)
      expect(findLastStreamingBashIndex([mk('streaming'), mk('complete'), mk('streaming')])).toBe(2)
    })
  })
});

// ======== 来源：effects-delivery-receipt.test.ts ========
describe("effects-delivery-receipt", () => {
  // getDeliveryProjection 快照读口已随过度设计审计候选 1 删除——测试断言经响应式读口组装同款快照。
  const getDeliveryProjection = (sid: string): readonly DeliveryFrameEntry[] =>
    getDeliveryProjectionRef().value.get(sid) ?? []

  const SID = 's-delivery'
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const CLIENT_UUID = `u-${UUID}`

  /**
 * 真实计数语义的 inflight（区别于纯 mock——命中回收断言读数值，非调用记录）。
 * incrementInflight 已随 ctx 成员收敛删除（增量归 store 方法侧）——测试预置计数走
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

  describe('session.delivery 派生视图生命周期（D7 单一数据源）', () => {
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
    it('AC1: 标记命中 steer 条目 → 派生视图转 delivered + morph 段按序入流 + 占位回收 + 帧终止', () => {
      const segs: Segment[] = [{ type: 'text', text: '排队消息' }]
      replaceDeliveryProjection(SID, [entry()])
      captureMorphSegments(SID, CLIENT_UUID, segs)
      const ctx = makeCtx()
      ctx.addInflight(1)

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '排队消息', UUID))

      // 派生视图转 delivered（队列区随帧隐去；u3c 渲染消费）
      expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
      // morph 段按原 segments 入流（overlay-only 插入点；气泡已 morph 移除后恢复为正常气泡）
      // [消息撤回 U8] 分支①保留原 id：第三参传原 clientUuid——重建气泡沿用提交 id（撤回定位锚）
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      expect(ctx.appendUser).toHaveBeenCalledWith(SID, segs, CLIENT_UUID)
      // 占位回收：1 → 0（本帧即确认帧，② 不再重复扣）
      expect(ctx.inflightOf()).toBe(0)
      // 帧消费终止：权威 reducer 喂入无条件保留（调用方在 ① 之前执行）
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    })

    it('AC2: u-<uuid> 原文形态标记同样命中（跨 u1 契约错配消除面，双形态收敛）', () => {
      replaceDeliveryProjection(SID, [entry()])
      const ctx = makeCtx()
      ctx.addInflight(1)

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi', CLIENT_UUID))

      expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
      expect(ctx.inflightOf()).toBe(0)
    })

    it('AC3: direct 条目回执 → 无 morph 段且本地有同 id 气泡不重复入流（D4 后防双插由 id 判定承接，气泡原位保持）', () => {
      // [D4 修订] 修前本用例锁定「direct 投递路径整体豁免」（无气泡也不入流）；D4
      //（remote-use-shell-unification）后 direct 豁免由 hasLocalBubble 精确承接——观看端
      // foreign 无气泡 → 入流补显（直调侧谓词锚见 effects/__tests__/user-delivery.test.ts
      // D4-AC1/AC4），本用例改为发送端形态（本地有同 id 乐观气泡），经全 handler 链锁定
      // 防双插 + 回执侧照常（派生视图转态 + 占位回收与入流判定正交）。
      replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
      const ctx = makeCtx([{ id: CLIENT_UUID, role: 'user', content: [{ type: 'text', text: 'hi' }], status: 'complete', timestamp: 0 }])
      ctx.addInflight(1)

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'hi', UUID))

      expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
      expect(ctx.appendUser).not.toHaveBeenCalled()
      expect(ctx.inflightOf()).toBe(0)
    })

    it('AC4: 无标记帧（外来直发形态）→ 下落 ② 纯计数兜底，派生视图不动', () => {
      replaceDeliveryProjection(SID, [entry()])
      const ctx = makeCtx()
      ctx.addInflight(1)

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, 'plain text'))

      expect(getDeliveryProjection(SID)[0]?.state).toBe('in-flight')
      expect(ctx.appendUser).not.toHaveBeenCalled()
      expect(ctx.inflightOf()).toBe(0)
    })

    it('AC5: 标记不命中派生视图（帧缺失/异 session 形态）→ 下落 ②，不误配', () => {
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

    it('AC7: inflight == 0 且无命中 → 外来直发入流（③ overlay 投影：canvas 回推等 runtime 注入通知的实时显示，A3 缺口修复）', () => {
      replaceDeliveryProjection(SID, [entry()])
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '[画布事件通知] 用户选定方案'))

      // 入流：messages 新增 user 消息（overlay 投影；修前该形态静默丢弃、仅切回会话重放可见）
      const list = ctx.messages.value.get(SID)?.value ?? []
      expect(list).toHaveLength(1)
      expect(list[0]?.role).toBe('user')
      // 权威喂入：reducer buffer 收到同一 entry（applyEntryFrameWithOverlay 内部）
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      // 不走 appendUser（那是 ① 回执 morph 段的专用通道）
      expect(ctx.appendUser).not.toHaveBeenCalled()
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
    it('AC8: 两条目均有 morph 段 → 全部按段各自入流 + 派生视图全转 delivered + inflight 批量扣减', () => {
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

      // 其余条目不再等不到消费：两段各自按原 segments 入流（保留原 id 各传原 clientUuid）
      expect(ctx.appendUser).toHaveBeenCalledTimes(2)
      expect(ctx.appendUser).toHaveBeenNthCalledWith(1, SID, segsA, CLIENT_UUID)
      expect(ctx.appendUser).toHaveBeenNthCalledWith(2, SID, segsB, CLIENT_UUID_B)
      // 派生视图全转 delivered（修前仅尾标记条目转态，其余滞留至 TTL/下一帧快照覆盖）
      expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered', 'delivered'])
      // 批量确认扣减：命中 2 条 = 扣 2（每条乐观气泡挂 1）
      expect(ctx.inflightOf()).toBe(0)
    })

    it('AC9: 全无段多标记帧（外来合批形态）→ 整帧剥标记文本降级入流一次，保留原 id号挂首个降级条目', () => {
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

    it('AC10: 防误配保留——多标记帧中粘贴形态标记不命中派生视图即跳过，命中的条目正常消费', () => {
      const segsA: Segment[] = [{ type: 'text', text: '排队消息 A' }]
      replaceDeliveryProjection(SID, [entry()])
      captureMorphSegments(SID, CLIENT_UUID, segsA)
      const ctx = makeCtx()
      ctx.addInflight(1)

      // 第二个标记（UUID_B）无对应派生视图条目 = 正文自带粘贴标记形态：跳过不误配
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

  // ── [消息撤回 U8] 回执入流保留原 id（两分支重建气泡沿用原 id）──────────────────────

  describe('送达回执入流保留原 id（消息撤回 U8：重建气泡沿用原 clientUuid）', () => {
    it('分支②外来纯文本降级入流：无 morph 段无本地气泡的 steer 条目 → appendUser 收到原 clientUuid', () => {
      // 外来条目（session_manager send / 收养形态）：内核派生视图有条目、无本地乐观气泡、
      // 未捕获 morph 段 → 显示责任由 ② 纯文本降级分支承接，且保留原 id 传条目 clientUuid
      replaceDeliveryProjection(SID, [entry()])
      const ctx = makeCtx()
      ctx.addInflight(1)

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '外来消息', UUID))

      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      // 保留原 id：第三参 = 内核条目 clientUuid（外来形态可能为裸 uuid，照保——见 store.appendUser 注释）
      expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '外来消息' }], CLIENT_UUID)
      expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
    })

    it('分支②外来条目为内核裸 uuid 形态：照保原 id（保留原 id 语义优先于 u- 形态约束）', () => {
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

  // ── ③ 守卫降级（rpc-direct-send-user-bubble：标记未命中派生视图 + 无记账的显示承接）──

  describe('③ 守卫降级：派生视图缺条目 + 无记账的 message_end(user) 不再静默丢弃', () => {
    it('AC-D1: 协议直发形态（派生视图无条目 + inflight=0）→ 降级入流剥标记原文（修前静默消费 = live 缺失）', () => {
      // 派生视图刻意不置条目（订阅 sync 早退窗口 / 补齐时序缺口形态）；协议直发无乐观气泡
      // 无 inflight 记账——③ 分支修前 hasKernelDeliveryMarker 命中即静默，消息不入流。
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '直发消息', UUID))

      // 降级入流：appendUser 收到剥标记纯文本（乐观气泡等价形态，status complete 由 appendUser 契约产出）
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '直发消息' }], UUID)
      // 权威喂 reducer 照常（调用方无条件承担，不受 ③ 分支影响）
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    })

    it('AC-D2: 降级入流后派生视图补齐 + 迟到重复回执（同 id 第二帧）→ 不双显（去重防插）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '直发消息', UUID))
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)

      // 派生视图补齐（条目已 delivered——内核回执先于帧序到达 renderer 的补齐形态）
      replaceDeliveryProjection(SID, [{ clientUuid: CLIENT_UUID, preview: '直发消息', state: 'delivered', lane: 'direct' }])
      // 迟到重复回执帧（E5c 同款）：① 因 state=delivered 不命中 → 落 ③ → 已显示集合命中 → 静默
      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '直发消息', UUID))

      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(2)
    })

    it('AC-D3: ① 命中的 m- 收养条目降级入流后迟到重复回执 → 不双显（修前 hasLocalBubble 双形态 miss 会双插）', () => {
      // m- 收养形态气泡 id 无 u- 前缀：迟到回执经 ③ 的气泡双形态判定（裸 / u-）构造性 miss，
      // ① 命中入流落点的已显示登记补齐该缺口
      const ADOPTED = 'm-mustgqln-3'
      replaceDeliveryProjection(SID, [{ clientUuid: ADOPTED, preview: '收养消息', state: 'in-flight', lane: 'direct' }])
      const ctx = makeCtx()
      ctx.addInflight(1)

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '收养消息', ADOPTED))
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)

      // 内核回执先至：条目转 delivered；随后迟到重复回执帧
      replaceDeliveryProjection(SID, [{ clientUuid: ADOPTED, preview: '收养消息', state: 'delivered', lane: 'direct' }])
      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '收养消息', ADOPTED))

      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    })

    it('AC-D4: 多标记帧降级入流一次（挂首个未显示 id），全部标记登记已显示集合', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, composedEndFrame(SID, [
        { text: '整批 A', marker: UUID },
        { text: '整批 B', marker: UUID_B },
      ]))

      // 整帧文本一次入流（同 ① 降级分支的整帧互斥语义），挂首个未显示 id。
      // 剥除口径 = DEFER_FLUSH_MARKER_RE_GLOBAL 只剥标记本体（前导换行保留，trimEnd 只剥尾部）
      // ——与 ① 降级分支同一变换，合批分隔前的标记换行残留是既有语义（AC-D1 单标记帧无此差异）。
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      expect(ctx.appendUser).toHaveBeenCalledWith(SID, [{ type: 'text', text: '整批 A\n\n\n---\n\n整批 B' }], UUID)
      // 迟到重复回执（任一标记）不再二次入流
      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '整批 B', UUID_B))
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
    })

    it('AC-D5: 发送端已有同 id 乐观气泡（composer 路径形态）→ ③ 保持静默防双插（现状语义不变）', () => {
      const ctx = makeCtx([{ id: CLIENT_UUID, role: 'user', content: [{ type: 'text', text: 'hi' }], status: 'complete', timestamp: 0 }])

      dispatchMessageEvent(ctx, SID, userEndFrame(SID, '直发消息', UUID))

      expect(ctx.appendUser).not.toHaveBeenCalled()
    })
  })
});

// ======== 来源：user-delivery.test.ts ========
describe("user-delivery", () => {
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

  /** 发送端本地乐观气泡（appendUser 保留原 id 契约：气泡 id = 内核条目 clientUuid，hasLocalBubble 按 id 匹配）。 */
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

  describe('D4 foreign 入流豁免精确化（remote-use-shell-unification D4：V17 改变项 + V16 不变项）', () => {
    it('D4-AC1: 观看端 foreign 无本地气泡的 direct 投递路径消息 → 入流补显（修前 direct 整体豁免不显示，S4 修复主体）', () => {
      // 场景：双端同看会话，A 端 direct 投递路径发消息（session_manager 注入同形态），B 端
      // 无本地乐观气泡无 morph 段 → 降级入流剥标记纯文本（显示责任承接，不静默丢显示）
      replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
      const ctx = makeCtx()
      ctx.addInflight(1)

      const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('外来消息', UUID))

      expect(consumed).toBe(true)
      const expected: Segment[] = [{ type: 'text', text: '外来消息' }]
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      expect(ctx.appendUser).toHaveBeenCalledWith(SID, expected, CLIENT_UUID)
      // 回执消费照常：派生视图转 delivered + 占位回收（入流豁免不影响回执侧）
      expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
      expect(ctx.inflightOf()).toBe(0)
    })

    it('D4-AC2: foreign 无本地气泡的 steer 投递路径消息照旧入流（既有语义不变锚，V16 不变项）', () => {
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
      // 场景：本端发送（direct 投递路径），乐观气泡已入流（id = clientUuid 保留原 id 同源）——
      // hasLocalBubble 命中 → foreign=false → 降级入流豁免（修前由 lane 豁免、修后由 id 判定承接）
      replaceDeliveryProjection(SID, [entry({ lane: 'direct' })])
      const ctx = makeCtx([localBubble(CLIENT_UUID)])
      ctx.addInflight(1)

      const consumed = confirmKernelDeliveryOnMessageEnd(ctx, SID, userEndEntry('hi', UUID))

      expect(consumed).toBe(true)
      expect(ctx.appendUser).not.toHaveBeenCalled()
      // 回执侧照常执行：派生视图转态 + 占位回收与入流判定正交（发送端回执语义不变）
      expect(getDeliveryProjection(SID)[0]?.state).toBe('delivered')
      expect(ctx.inflightOf()).toBe(0)
    })

    it('D4-AC4: direct 投递路径两端行为分叉对拍——同帧形态，观看端入流补显 vs 发送端不入流', () => {
      const watcher = makeCtx([]) // 观看端：无本地气泡
      const sender = makeCtx([localBubble(CLIENT_UUID)]) // 发送端：乐观气泡已入流
      watcher.addInflight(1)
      sender.addInflight(1)

      // 派生视图是模块级单例：两次调用各自重置条目（watcher 消费会转 delivered，sender
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

      // 整帧只入流一次（首个降级条目保留原 id），第二个条目不因首条入流而行为漂移
      expect(consumed).toBe(true)
      expect(ctx.appendUser).toHaveBeenCalledTimes(1)
      expect(getDeliveryProjection(SID).map((e) => e.state)).toEqual(['delivered', 'delivered'])
      expect(ctx.inflightOf()).toBe(0)
    })

    it('D4-AC7: 内核收养条目 m- 形态回执 → 观看端 foreign 入流保留原 id 收养 id（2026-10-03 D3 A8 归因修复——shared 标记身份段不认 m- 形态时，回执在消费端构造性 miss、观看端 live 无人入流，live ≠ reload）', () => {
      // 场景（探针实证）：外部 message.send 不带 clientUuid → registry 收养生成 m-<token>-<n>
      // → 回显文本尾标记 <!--taiji:msg:m-...-->，派生视图条目 clientUuid = m- 形态。前端标记
      // 身份段收编 m- 分支后（MSG_ID_ADOPTED_SEGMENT），① 命中条目 → 无本地气泡 → foreign
      // 降级入流，保留原 id 传收养 id 本体（e.clientUuid === bareId 分支）。
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
});

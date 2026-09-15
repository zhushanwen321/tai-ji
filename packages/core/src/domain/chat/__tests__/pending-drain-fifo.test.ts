/**
 * [W14] pendingBuffer 计数 FIFO 核心回归（data-source-governance P2.2，D1 表末行 + D6）。
 *
 * 背景：pi 入队存 skill 展开后文本 ≠ 提交原文（pi agent-session _expandSkillCommand /
 * expandPromptTemplate 先于入队），投递定位的文本相等匹配在该场景必挂（消息永久丢失）。
 * 本 wave 改计数 FIFO：queue_update 差集（countDrained）算出被投递条数 N → drainN 按条数取。
 *
 * 三组核心回归用例（plan W14 步骤 3 / 验收 4）：
 * - 组1：相同文本多次提交（['A','A'] drain 1 条）取最早一条（countDrained 注释中的 TC）
 * - 组2：展开后文本 ≠ 提交原文时仍按条数取出（本 wave 核心回归——文本匹配必挂场景）
 * - 组3：深度对账——pendingBuffer 与 pendingMessageCount 偏差 1（模拟扩展注入例外）
 *   → 下一次 queue_update 到达后偏差收敛（D6 残余风险边界的行为规格）
 * - 组4：buffer > 深度（队列被外部清空）的僵尸——[steer-bubble u2/D4] 投递侧不再裁，
 *   改由 G-023 时点（message_start(assistant)）清残量
 * - 组6/组7：[steer-bubble u2/D4] 投递侧不裁剪回归——drain 后 buffer 残量保留到
 *   message_end（腿 2 includes 兜底消费回填 segments）
 *
 * 端到端：真 createChatStore + applyMessageEvent（真 registry dispatch 链，非 ctx mock）。
 * 纯数据层（fake timers 不需要——queue_update 路径不挂 timer）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/pending-drain-fifo.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { effectScope, toRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { textToSegments, segmentsToText, type Segment, type ServerMessage } from '@taiji/shared'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** 引用断言 helper：pendingBuffer 是深响应式 ref，buffer 内取出的 segments 是 reactive
 *  Proxy——toRaw 解回 raw 引用后与 push 时传入的原始数组做 Object.is 比较（FIFO「取最早」
 *  的精确判据：同文本两条内容相等，只有引用可区分入队先后）。 */
function rawContent(content: unknown): Segment[] {
  return toRaw(content as Segment[])
}

describe('W14 pendingBuffer 计数 FIFO（queue_update 差集驱动，D6）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }
  const sid = 's-w14'

  /** 广播一帧 queue_update（payload 默认带 sessionId；steering/followUp 为 pi 队列全量数组） */
  function queueUpdate(payload: Record<string, unknown>): void {
    const msg = { type: 'message.queue_update', payload: { sessionId: sid, ...payload } } as ServerMessage
    sut.store.applyMessageEvent(sid, msg)
  }

  /** 读该 session 的 pendingBuffer 暂存条数（深度对账断言用） */
  function bufferLen(): number {
    return sut.store.pendingBuffer.value.get(sid)?.length ?? 0
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    sut = makeStore()
  })
  afterEach(() => sut.dispose())

  it('组1: 相同文本多次提交（["A","A"] drain 1 条）→ 取最早一条（FIFO）', () => {
    const segFirst: Segment[] = textToSegments('A')
    const segSecond: Segment[] = textToSegments('A')
    sut.store.pushPending(sid, segFirst, 'steer')
    sut.store.pushPending(sid, segSecond, 'steer')

    // pi 入队后广播全量数组（两条同文本）
    queueUpdate({ steering: ['A', 'A'], pendingMessageCount: 2 })
    // pi 投递 1 条：数组 ['A']——countDrained(['A','A'], ['A']) 差集条数 N=1
    queueUpdate({ steering: ['A'], pendingMessageCount: 1 })

    // 取最早一条：引用断言（drainN 返回入队最早的 segments 原引用，appendUser 原样进对话流）
    const msgs = sut.store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    expect(rawContent(msgs[0].content)).toBe(segFirst)
    // 第二条仍在暂存（等下一次 drain）
    expect(bufferLen()).toBe(1)

    // 第二次 drain：数组清空 → N=1 → 取剩下那条
    queueUpdate({ steering: [], pendingMessageCount: 0 })
    const msgs2 = sut.store.getMessages(sid)
    expect(msgs2).toHaveLength(2)
    expect(rawContent(msgs2[1].content)).toBe(segSecond)
    expect(bufferLen()).toBe(0)
  })

  it('组2（核心回归）: skill 展开后文本 ≠ 提交原文 → 仍按条数取出（文本匹配必挂场景）', () => {
    // 提交原文（skill 命令形式）
    const original: Segment[] = textToSegments('/deploy --prod')
    sut.store.pushPending(sid, original, 'steer')

    // pi 入队存展开后文本（与原文完全不同）→ queue_update 全量数组是展开文本
    const expanded = 'skill deploy 展开：先检查环境，再执行 prod 部署流程……（全文与 /deploy --prod 无任何文本相等关系）'
    queueUpdate({ steering: [expanded], pendingMessageCount: 1 })

    // pi 投递（数组清空）：countDrained 差集 N=1 → drainN 按条数取，不看文本
    queueUpdate({ steering: [], pendingMessageCount: 0 })

    // 旧文本匹配在此场景 drainPending 匹配失败 → 消息永久丢失（父文档 #6 失联即丢）；
    // 计数 FIFO 必过：原文 segments 原样进对话流
    const msgs = sut.store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    expect(rawContent(msgs[0].content)).toBe(original)
    expect(segmentsToText(rawContent(msgs[0].content))).toBe('/deploy --prod')
    expect(bufferLen()).toBe(0)
  })

  it('组3: 深度对账——扩展注入偏差 1 → 下一次 queue_update 到达后偏差收敛', () => {
    sut.store.pushPending(sid, textToSegments('renderer one'), 'steer')
    sut.store.pushPending(sid, textToSegments('renderer two'), 'steer')

    // 帧1：pi 队列 3 条 = renderer 2 条 + 扩展 deliverAs 注入 1 条（renderer 未提交，
    // pendingBuffer 无此条）→ 偏差存在：buffer(2) < 深度(3)。D6 已知例外：无法凭空补
    // segments，接受有界偏差（不裁剪、不误删 renderer 暂存）。
    queueUpdate({ steering: ['renderer one', 'renderer two', 'EXT injected'], pendingMessageCount: 3 })
    expect(bufferLen()).toBe(2)

    // 帧2（下一次 queue_update）：pi 清空队列全部投递 → countDrained 差集 N=3，
    // drainN(sid, 'steer', 3) 取尽即止（buffer 只有 2 条）
    queueUpdate({ steering: [], pendingMessageCount: 0 })

    // renderer 两条按入队顺序进对话流（不是 3 条——扩展条无前端暂存，由 pi 侧自己投递）
    const msgs = sut.store.getMessages(sid)
    expect(msgs).toHaveLength(2)
    expect(segmentsToText(msgs[0].content as Segment[])).toBe('renderer one')
    expect(segmentsToText(msgs[1].content as Segment[])).toBe('renderer two')
    // 偏差收敛：drain 后 pendingBuffer 长度 === 帧内深度（0 === 0）
    expect(bufferLen()).toBe(0)
  })

  it('组4: [steer-bubble u2/D4] 僵尸——queue_update 投递侧不裁，G-023 时点（message_start(assistant)）清残量', () => {
    const segStay: Segment[] = textToSegments('will stay')
    sut.store.pushPending(sid, segStay, 'steer')
    sut.store.pushPending(sid, textToSegments('zombie'), 'steer')

    // 帧1：首帧数组只 1 条（深度 1 < buffer 2，模拟 pi 队列内容被外部清掉一条——
    // 僵尸暂存永不被投递且污染后续 FIFO 计数）。[u2/D4] 投递侧 reconcilePending 裁剪
    // 已移除——buffer 残量保留（旧行为在此处裁到 1，会吃掉腿 2 还没回填的 segments）
    queueUpdate({ steering: ['will stay'], pendingMessageCount: 1 })
    expect(bufferLen()).toBe(2)

    // G-023（message_start(assistant)）：快照深度 1 → 保留快照（F4 条件清）+
    // 僵尸清理裁残量到深度 1（保留最早的，与 FIFO 取出顺序一致）
    sut.store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } } as ServerMessage)
    const buf = sut.store.pendingBuffer.value.get(sid) ?? []
    expect(buf).toHaveLength(1)
    expect(buf[0].text).toBe('will stay')
    expect(toRaw(buf[0].segments)).toBe(segStay)
    // 快照保留（深度 1 > 0，F4）——其投递时腿 1 prev 在场
    expect(sut.store.getQueueState(sid)).toEqual({ steering: ['will stay'] })

    // 帧2：投递 → 取出唯一暂存，结构归零
    queueUpdate({ steering: [], pendingMessageCount: 0 })
    const users = sut.store.getMessages(sid).filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(rawContent(users[0].content)).toBe(segStay)
    expect(bufferLen()).toBe(0)
  })

  it('组5: queue_update 全量数组照常写 queueStates（QueueBubble 显示行为不变）', () => {
    queueUpdate({ steering: ['queued text'], pendingMessageCount: 1 })
    expect(sut.store.getQueueState(sid)?.steering).toEqual(['queued text'])

    queueUpdate({ steering: [], pendingMessageCount: 0 })
    // 空数组 = 无内容 → queueStates 清除（QueueBubble 消失）
    expect(sut.store.getQueueState(sid)).toBeUndefined()
  })

  // ── [steer-bubble u2 / D4] 投递侧不裁剪回归：buffer 在两腿间存活到 message_end ──

  /** 广播一帧 message_end(user)（payload.entry 为 event-adapter 重构形态，content parts 数组） */
  function userEnd(text: string): ServerMessage {
    return {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
        },
      },
    } as ServerMessage
  }

  it('组6: [u2/D4] prev 缺失的 drain 空帧不再裁空 buffer（F3 不可逆丢失回归）', () => {
    const seg: Segment[] = textToSegments('A')
    sut.store.pushPending(sid, seg, 'steer')

    // F3 断连场景：入队帧被 ring 冲掉 → 前端快照空，收到的第一帧就是 drain 后空帧
    //（prev 缺失 → 腿 1 不插入）。旧行为：同帧 reconcilePending(sid, 0) 把 buffer [A]
    // 裁空——暂存 segments 永久删除（不可逆放大器）；新行为：残量保留（等重连快照
    // 重建后腿 1 消费，或 message_end 到达时腿 2 includes 兜底消费，见组7）
    queueUpdate({ steering: [], pendingMessageCount: 0 })

    expect(sut.store.getMessages(sid).filter((m) => m.role === 'user')).toHaveLength(0)
    expect(bufferLen()).toBe(1)
  })

  it('组7: [u2/D4+D2] buffer 残量保留到 message_end——快照重建后腿 2 消费回填 segments（非纯文本降级）', () => {
    const seg: Segment[] = textToSegments('A')
    sut.store.pushPending(sid, seg, 'steer')
    // 组6 前置：空帧（prev 缺失）不裁，buffer 残量存活
    queueUpdate({ steering: [], pendingMessageCount: 0 })
    // 重连 ring 回放入队帧 → queueStates 快照重建（prev 无 → 不触发 drain 差集）
    queueUpdate({ steering: ['A'], pendingMessageCount: 1 })
    expect(sut.store.getQueueState(sid)).toEqual({ steering: ['A'] })

    // message_end(user) 到达：腿 1 未消费（inflight 0）→ includes 命中 ['A'] →
    // drainN 消费 buffer 残量 → segments 原引用入流（G2：投递侧不裁剪保证 segments
    // 存活到此刻——若被裁空，此处只剩帧内文本纯文本降级）
    sut.store.applyMessageEvent(sid, userEnd('A'))

    const users = sut.store.getMessages(sid).filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(rawContent(users[0].content)).toBe(seg)
    expect(bufferLen()).toBe(0)
    // 消费后快照剔实例 → steering 剔空 → 条目删除（对齐空帧语义）
    expect(sut.store.getQueueState(sid)).toBeUndefined()
  })
})

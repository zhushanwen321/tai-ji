/**
 * P-isolation 探针（btw-question 运行时断言探针表，M2-b 验收④）——两线并发流式，
 * MessageBus 分区无串扰。
 *
 * 口径：fixture/mock 轨（真 MessageBus + 内存 BusClient，零 pi 零 token，凭证无关）。
 * 覆盖 runtime 侧分区收口点 = MessageBus.publish 的定向推送（per-session 订阅集合 +
 * per-session seq/ring/stateSnapshot）——renderer chatStore 分区回放半边归 M2-c
 * （文件→applyEntry 回放等价），两侧合起来构成 P-isolation 全断言。
 *
 * 断言面（双通道：transient 直传 + stream 入 ring——分区语义与帧类型无关，载体选型见下）：
 * 1. 两线（btw vid）并发交错流式 100 帧（transient `message.text_delta`）：各自订阅者
 *    只收自己的帧（sessionId + 内容标记双零泄漏）；无关会话订阅者零帧；
 * 2. stream 类帧（`message.stream_error`，payload {sessionId,content} 精确契约）5+3：
 *    per-session seq 1..N 单调无缺口（分区独立计数）+ ring 快照（重放面）只含本线帧；
 * 3. transient 不入 ring（重放面分区：迟到订阅者拿不到 transient 快照，分区构造性成立）；
 * 4. btw.list 状态广播（handler 广播面）按 mainSid 分区：各主会话订阅者只收自己的
 *    全量线列表，stateSnapshot('btw') 恢复面同样分区。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/btw-p-isolation.test.ts
 */
import { describe, it, expect } from 'vitest'
import { MessageBus } from '../../services/message-bus/message-bus.js'
import type { BusClient } from '../../services/message-bus/types.js'
import type { ServerMessage } from '@taiji/shared'

/** 内存 BusClient（types.ts 文档形态：{ readyState: 1, send }），帧原文累积。 */
function makeClient() {
  const received: string[] = []
  const client: BusClient = {
    readyState: 1,
    send: (data: string) => { received.push(data) },
  }
  return {
    client,
    frames: (): ServerMessage[] => received.map(raw => JSON.parse(raw) as ServerMessage),
  }
}

/** payload 索引访问收窄（文本_delta 未契约化具名字段——Record 形状经索引读取）。 */
function payload(m: ServerMessage): Record<string, unknown> {
  return m.payload as Record<string, unknown>
}

function sidOf(m: ServerMessage): unknown {
  return payload(m).sessionId
}

/** transient 直传帧载体（分区语义与帧类型无关；payload 形状任意 Record）。 */
const transientDelta = (sessionId: string, i: number): ServerMessage => ({
  type: 'message.text_delta',
  payload: { sessionId, content: `${sessionId}#${i}` },
})

/** stream 类帧载体（入 ring + 分配 seq；payload {sessionId,content} 精确契约）。 */
const streamFrame = (sessionId: string, i: number): ServerMessage => ({
  type: 'message.stream_error',
  payload: { sessionId, content: `${sessionId}#${i}` },
})

const VID_A = 'btw:thread-alpha'
const VID_B = 'btw:thread-beta'
const VID_C = 'btw:thread-gamma'

describe('P-isolation：两线并发流式分区无串扰（runtime MessageBus 半边，fixture 轨）', () => {
  it('并发交错 100+100 帧（transient 直传面）：各自订阅者零串扰 + 无关会话零帧', async () => {
    const bus = new MessageBus()
    const a = makeClient()
    const b = makeClient()
    const c = makeClient()
    bus.subscribe(VID_A, a.client)
    bus.subscribe(VID_B, b.client)
    bus.subscribe(VID_C, c.client)

    // 微任务让步制造真实交错（两路发布并发推进，而非先 A 后 B 的顺序写）
    const stream = async (vid: string, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        bus.publish(vid, transientDelta(vid, i))
        if (i % 16 === 0) await Promise.resolve()
      }
    }
    await Promise.all([stream(VID_A, 100), stream(VID_B, 100)])

    const fa = a.frames()
    const fb = b.frames()
    expect(fa).toHaveLength(100)
    expect(fb).toHaveLength(100)

    // 分区断言①：sessionId 恒为订阅方自己
    expect(fa.every(m => sidOf(m) === VID_A)).toBe(true)
    expect(fb.every(m => sidOf(m) === VID_B)).toBe(true)
    // 分区断言②：内容标记零泄漏（对方 vid 的标记不出现在本方任何帧）
    expect(fa.some(m => JSON.stringify(m).includes(VID_B))).toBe(false)
    expect(fb.some(m => JSON.stringify(m).includes(VID_A))).toBe(false)
    // 分区断言③：transient 不分配 seq（直传语义）——两线均无 seq 字段
    expect(fa.every(m => m.seq === undefined)).toBe(true)
    expect(fb.every(m => m.seq === undefined)).toBe(true)
    // 分区断言④：无关会话订阅者收不到任何线的帧
    expect(c.frames()).toHaveLength(0)
  })

  it('stream 类帧并发分区：per-session seq 1..N 独立计数无缺口 + ring 快照只含本线帧', async () => {
    const bus = new MessageBus()
    const a = makeClient()
    const b = makeClient()
    bus.subscribe(VID_A, a.client)
    bus.subscribe(VID_B, b.client)

    const stream = async (vid: string, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        bus.publish(vid, streamFrame(vid, i))
        if (i % 4 === 0) await Promise.resolve()
      }
    }
    await Promise.all([stream(VID_A, 5), stream(VID_B, 5)])

    const fa = a.frames()
    const fb = b.frames()
    expect(fa).toHaveLength(5)
    expect(fb).toHaveLength(5)
    // per-session seq 独立计数、单调无缺口（1..5），分区互不推高对方水位
    expect(fa.map(m => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(fb.map(m => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(fa.every(m => sidOf(m) === VID_A)).toBe(true)
    expect(fb.every(m => sidOf(m) === VID_B)).toBe(true)

    // ring 快照（重放面）同分区：迟到订阅者只回放本线帧，lastSeq 为本线水位
    const late = makeClient()
    const sub = bus.subscribe(VID_A, late.client)
    expect(sub.snapshot).toHaveLength(5)
    expect(sub.snapshot.every(m => sidOf(m) === VID_A)).toBe(true)
    expect(sub.snapshot.some(m => JSON.stringify(m).includes(VID_B))).toBe(false)
    expect(sub.stateSnapshot).toHaveLength(0) // stream 类不写 state 快照
    expect(sub.lastSeq).toBe(5)
  })

  it('transient 不入 ring：只发 transient 的会话，迟到订阅者快照为空（重放面分区构造性成立）', () => {
    const bus = new MessageBus()
    bus.publish(VID_A, transientDelta(VID_A, 0))
    bus.publish(VID_A, transientDelta(VID_A, 1))

    const late = makeClient()
    const sub = bus.subscribe(VID_A, late.client)
    expect(sub.snapshot).toHaveLength(0)
    expect(sub.lastSeq).toBe(0)
  })

  it('btw.list 状态广播按 mainSid 分区：live 面只收本主会话，stateSnapshot 恢复面同样分区', () => {
    const bus = new MessageBus()
    const mainA = 'main-sid-a'
    const mainB = 'main-sid-b'
    const liveA = makeClient()
    bus.subscribe(mainA, liveA.client)

    bus.publish(mainA, { type: 'btw.list', id: 'push_1', payload: { mainSid: mainA, threads: [{ vid: 'btw:t1' }] } })
    bus.publish(mainB, { type: 'btw.list', id: 'push_2', payload: { mainSid: mainB, threads: [{ vid: 'btw:t2' }] } })

    // live 面：A 只收到 mainA 的线列表，B 的广播不外溢
    const gotA = liveA.frames()
    expect(gotA).toHaveLength(1)
    expect(gotA[0]?.type).toBe('btw.list')
    expect(payload(gotA[0]!).mainSid).toBe(mainA)

    // 恢复面：mainB 迟到订阅经 stateSnapshot('btw') 只拿到自己的全量线列表
    const lateB = makeClient()
    const subB = bus.subscribe(mainB, lateB.client)
    const stateFrames = subB.stateSnapshot.filter(m => m.type === 'btw.list')
    expect(stateFrames).toHaveLength(1)
    expect(payload(stateFrames[0]!).mainSid).toBe(mainB)
    expect(payload(stateFrames[0]!).threads).toEqual([{ vid: 'btw:t2' }])
    expect(lateB.frames()).toHaveLength(0) // state 类不补发 live
  })
})

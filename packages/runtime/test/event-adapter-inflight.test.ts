/**
 * EventAdapter subagent 在途上报旁路单测（u7b，设计权威源 docs/design/
 * crash-forensics-and-watchdog.md §3.3 D5「extension 聚合上报」+「缺席与丢失的语义收敛」④）。
 *
 * 覆盖（u7b 验收）：
 * - 合法帧 → 在途镜像绝对计数覆盖 + resolve INFLIGHT_REPORT_ACK（第三参
 *   'select'，rpc-client 对 select 走 value 序列化，pi 侧 reporter 靠它判「已送达」）；
 * - **无任何前端广播副作用**：marker 帧不进翻译（interpret 零调用），且直调 translate()
 *   也返回空（守卫分支）——[HISTORICAL] 广播会让前端渲染无人应答的弹窗导致 pending 泄漏；
 * - 坏帧三态（非 JSON / 未知 schema / 缺 sessionId）→ 静默丢弃（不镜像不 ack 不抛），
 *   通道保持存活（后续合法帧照常生效）；
 * - 非 marker 帧（普通 select / marker title 但非 select method）→ 旁路不吞，既有 UI 翻译不变；
 * - 无 ack 能力 / ack 抛错的 client → 不干扰事件流，镜像仍更新。
 *
 * 运行：cd packages/runtime && npx vitest run test/event-adapter-inflight.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventAdapter, translate } from '../src/infra/pi/event-adapter.js'
import { inflightMirror } from '../src/services/session/inflight-mirror.js'
import { SUBAGENT_INFLIGHT_MARKER, INFLIGHT_REPORT_ACK } from '@xyz-agent/extension-protocol'
import type { PiEvent } from '../src/infra/pi/pi-protocol.js'
import type { PiEventListener } from '../src/services/ports/pi-engine.js'

const SID = 'sess-inflight-1'

/** marker 通道帧形态（pi rpc-mode select：{method:'select', id, title, options}）。 */
function makeFrame(title: string | undefined, options: unknown[], id = 'req-inflight-1'): PiEvent {
  return { type: 'extension_ui_request', method: 'select', id, title, options } as PiEvent
}

/** 合法上报载荷（sessionId 在场 = 可归属；kind 字段已删——2026-09-13 oe-audit）。 */
function reportPayload(inFlight: number, sessionId: string = SID): string {
  return JSON.stringify({ inFlight, sessionId, emittedAt: 1_700_000_000_000 })
}

/**
 * 挂一个 EventAdapter 到假 client（capture listener）。withAck=false 模拟旧形态 client
 * （无 sendExtensionUiResponse 能力——port 可选成员的现实缺省）。
 */
function attachAdapter(opts: { withAck?: boolean } = {}) {
  const interpret = vi.fn()
  const adapter = new EventAdapter(SID, interpret)
  const ack = vi.fn()
  const unsub = vi.fn()
  let listener: PiEventListener = () => {}
  const onEvent = vi.fn((l: PiEventListener) => { listener = l; return unsub })
  if (opts.withAck === false) {
    adapter.attach({ onEvent })
  } else {
    adapter.attach({ onEvent, sendExtensionUiResponse: ack })
  }
  return { adapter, interpret, listener: listener as unknown as (event: unknown) => void, ack, unsub }
}

beforeEach(() => {
  inflightMirror.dropSession(SID)
})

describe('event-adapter: subagent 在途帧旁路（D5）', () => {
  it('合法初始帧（count=0）→ 镜像条目 + ack，零前端广播（interpret 零调用）', () => {
    const { interpret, listener, ack } = attachAdapter()
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(0)], 'req-ack-1'))

    // 镜像：hasEverReported=true + inFlight=0（「在场且无在途」已证事实 → errs 不再触发）
    const entry = inflightMirror.query(SID)
    expect(entry).toEqual({ injected: false, hasEverReported: true, inFlight: 0 })
    expect(inflightMirror.errsShape(SID)).toBeNull()

    // ack：resolve INFLIGHT_REPORT_ACK（第三参 select → rpc-client 序列化为 value 字符串）
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith('req-ack-1', INFLIGHT_REPORT_ACK, 'select')

    // 无任何前端广播副作用（帧不进翻译 → interpret 不被调用）
    expect(interpret).not.toHaveBeenCalled()
  })

  it('合法后续帧 → 绝对计数覆盖镜像（非增量）', () => {
    const { interpret, listener, ack } = attachAdapter()
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(3)]))
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(1)], 'req-ack-2'))
    expect(inflightMirror.query(SID)?.inFlight).toBe(1)
    expect(ack).toHaveBeenCalledTimes(2)
    expect(interpret).not.toHaveBeenCalled()
  })

  it('translate() 直调 marker 帧 → 空输出（守卫分支：绝不广播前端）', () => {
    const events = translate(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(0)]), SID)
    expect(events).toEqual([])
    // 不产任何 message / extension-ui 事件（无广播、无弹窗、无 pending）
    expect(events.some(e => e.kind === 'message' || e.kind === 'extension-ui')).toBe(false)
  })

  it('同一帧经 translate 不写镜像（守卫纯化：镜像只由 EventAdapter 旁路写）', () => {
    translate(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(5)]), SID)
    expect(inflightMirror.query(SID)).toBeUndefined()
  })
})

describe('event-adapter: 坏帧静默丢弃（不抛不镜像不 ack）', () => {
  it.each([
    ['payload 非 JSON', ['{not json']],
    ['options 为空', []],
    ['payload 非对象', ['42']],
    ['inFlight 为负', [JSON.stringify({ inFlight: -1, sessionId: SID, emittedAt: 1 })]],
    ['inFlight 非整数', [JSON.stringify({ inFlight: 1.5, sessionId: SID, emittedAt: 1 })]],
    ['缺 emittedAt', [JSON.stringify({ inFlight: 0, sessionId: SID })]],
  ])('%s → 静默丢弃', (_label, options) => {
    const { interpret, listener, ack } = attachAdapter()
    expect(() => listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, options))).not.toThrow()
    expect(inflightMirror.query(SID)).toBeUndefined()
    expect(ack).not.toHaveBeenCalled()
    expect(interpret).not.toHaveBeenCalled()
  })

  it('sessionId 缺席/空串 → 丢弃整帧（u7a 契约：无法归属不镜像；不 ack 待重试）', () => {
    const { interpret, listener, ack } = attachAdapter()
    // 缺席：JSON 无 sessionId 键（注意不能用默认参 undefined——默认参会回落 SID）
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [JSON.stringify({ inFlight: 2, emittedAt: 1 })], 'req-absent'))
    // 空串
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [JSON.stringify({ inFlight: 2, sessionId: '', emittedAt: 1 })], 'req-empty'))
    expect(inflightMirror.query(SID)).toBeUndefined()
    expect(ack).not.toHaveBeenCalled()
    expect(interpret).not.toHaveBeenCalled()
  })

  it('坏帧后通道保持存活：后续合法帧照常写镜像 + ack', () => {
    const { interpret, listener, ack } = attachAdapter()
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, ['{not json'], 'req-bad'))
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(2)], 'req-good'))
    expect(inflightMirror.query(SID)?.inFlight).toBe(2)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith('req-good', INFLIGHT_REPORT_ACK, 'select')
    expect(interpret).not.toHaveBeenCalled()
  })
})

describe('event-adapter: 旁路不误伤既有 UI 通道', () => {
  it('普通 select（无 marker）→ 旁路不吞，extension-ui + message 照常翻译', () => {
    const { interpret, listener } = attachAdapter()
    listener(makeFrame('Pick one', ['a', 'b'], 'req-plain'))
    expect(interpret).toHaveBeenCalledTimes(1)
    const kinds = (interpret.mock.calls[0][0] as Array<{ kind: string }>).map(e => e.kind)
    expect(kinds).toContain('extension-ui')
    expect(kinds).toContain('message')
  })

  it('marker title 但 method 非 select → 不识别为在途帧（不写镜像），UI 翻译不变', () => {
    const { interpret, listener } = attachAdapter()
    const frame = { type: 'extension_ui_request', method: 'input', id: 'req-input', title: SUBAGENT_INFLIGHT_MARKER, options: [reportPayload(1)] }
    listener(frame)
    expect(inflightMirror.query(SID)).toBeUndefined()
    expect(interpret).toHaveBeenCalledTimes(1)
  })
})

describe('event-adapter: ack 通道缺省/异常不干扰事件流', () => {
  it('client 无 sendExtensionUiResponse（port 可选成员缺省）→ 不抛，镜像仍更新', () => {
    const { interpret, listener } = attachAdapter({ withAck: false })
    expect(() => listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(4)]))).not.toThrow()
    expect(inflightMirror.query(SID)?.inFlight).toBe(4)
    expect(interpret).not.toHaveBeenCalled()
  })

  it('ack 发送抛错 → 旁路吞掉不外泄（镜像已写），后续事件照常处理', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter(SID, interpret)
    let listener: (event: unknown) => void = () => {}
    adapter.attach({
      onEvent: (l: PiEventListener) => { listener = l as unknown as (event: unknown) => void; return () => {} },
      sendExtensionUiResponse: () => { throw new Error('pipe dead') },
    })
    expect(() => listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(1)]))).not.toThrow()
    expect(inflightMirror.query(SID)?.inFlight).toBe(1)
    // 事件流存活：后续普通 select 照常翻译
    listener(makeFrame('Pick one', ['a']))
    expect(interpret).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * EventAdapter SUBAGENT_JOURNAL_MARKER 旁路测试（event-push-channel）。
 *
 * 覆盖（照 plan-review marker / inflight 测试形态，全部 mock 零真实 pi）：
 * - translate 守卫分支：marker 帧恒零产出（不进任何前端广播——第二道防线）；
 * - attach 旁路：合法报告 → journal-report-router 送达 sink（连接归属 sessionId）
 *   → 应用成功回 JOURNAL_REPORT_ACK（生效回执 D7）；
 * - 路由无消费方（sink 拒绝 / 未注册）→ 帧消费但不 ack（写侧按 D5 失败折叠）；
 * - 坏载荷（非 JSON / 形状非法 / sessionId 缺席）→ 帧消费但不 ack，不抛不进翻译；
 * - 旁路永不干扰事件流：marker 帧后的普通事件照常 interpret。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-journal-marker.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

import { EventAdapter, translate } from '../event-adapter.js'
import type { PiEventClient } from '../event-adapter.js'
import { SUBAGENT_JOURNAL_MARKER, JOURNAL_REPORT_ACK } from '@zhushanwen/extension-protocol'
import type { SubagentJournalReport } from '@zhushanwen/extension-protocol'
import type { PiExtensionUiRequestEvent } from '../pi-protocol.js'
import { setJournalReportSink } from '../../../services/session/journal-report-router.js'

const SID = 'sess-journal-1'

function selectEvent(overrides: Partial<PiExtensionUiRequestEvent> = {}): PiExtensionUiRequestEvent {
  return { type: 'extension_ui_request', method: 'select', id: 'req-1', ...overrides }
}

function reportFrame(report: SubagentJournalReport, id = 'req-1'): PiExtensionUiRequestEvent {
  return selectEvent({ title: SUBAGENT_JOURNAL_MARKER, id, options: [JSON.stringify(report)] })
}

function validReport(): SubagentJournalReport {
  return {
    domain: 'run',
    fileKey: 'wf-1',
    events: [{ type: 'run-created', ts: 1000, seq: 1 }],
    sessionId: SID,
    emittedAt: 42,
  }
}

/** 可控 sink（记录路由调用，应答由用例裁决）。 */
function makeSink(result = true) {
  const calls: Array<{ sessionId: string; report: SubagentJournalReport }> = []
  setJournalReportSink({
    applyJournalReport: (sessionId, report) => {
      calls.push({ sessionId, report })
      return result
    },
  })
  return calls
}

afterEach(() => {
  setJournalReportSink(null)
})

/** 构造带可控回包通道的 adapter + client（照 rt2-hardening 形态）。 */
function makeAdapter() {
  const interpret = vi.fn()
  const responses: Array<{ id: string; response: unknown }> = []
  const client: PiEventClient = {
    onEvent: (listener) => {
      ;(client as unknown as { listener: (e: unknown) => void }).listener = listener
      return () => undefined
    },
    sendExtensionUiResponse: (id, response) => {
      responses.push({ id, response })
    },
  }
  const adapter = new EventAdapter(SID, interpret)
  adapter.attach(client)
  const emit = (event: unknown): void => (client as unknown as { listener: (e: unknown) => void }).listener(event)
  return { adapter, interpret, responses, emit }
}

describe('translate 守卫分支（marker 帧恒零产出）', () => {
  it('journal marker 帧零产出（不进任何前端广播）', () => {
    const events = translate(
      selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: [JSON.stringify(validReport())] }) as unknown as Parameters<typeof translate>[0],
      SID,
    )
    expect(events).toHaveLength(0)
  })
})

describe('attach 旁路（路由 + 生效回执）', () => {
  it('合法报告 → sink 以连接 sessionId 路由 → 回 JOURNAL_REPORT_ACK（D7 生效回执）', () => {
    const calls = makeSink(true)
    const { interpret, responses, emit } = makeAdapter()

    emit(reportFrame(validReport()))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe(SID)
    expect(calls[0]!.report.domain).toBe('run')
    expect(calls[0]!.report.fileKey).toBe('wf-1')
    expect(responses).toEqual([{ id: 'req-1', response: JOURNAL_REPORT_ACK }])
    expect(interpret).not.toHaveBeenCalled() // marker 帧不进翻译/编排
  })

  it('sink 拒绝（投影未就绪返回 false）→ 帧消费但不 ack（写侧按 D5 失败折叠）', () => {
    makeSink(false)
    const { responses, emit } = makeAdapter()

    emit(reportFrame(validReport()))
    expect(responses).toHaveLength(0)
  })

  it('sink 未注册 → 帧消费但不 ack、不抛', () => {
    setJournalReportSink(null)
    const { responses, emit, interpret } = makeAdapter()

    expect(() => emit(reportFrame(validReport()))).not.toThrow()
    expect(responses).toHaveLength(0)
    expect(interpret).not.toHaveBeenCalled()
  })
})

describe('坏载荷防御（不抛不 ack 不进翻译）', () => {
  it('非 JSON payload → 消费（返回即吞掉）但不 ack', () => {
    makeSink(true)
    const { responses, emit } = makeAdapter()

    emit(selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: ['not-json'] }))
    expect(responses).toHaveLength(0)
  })

  it('形状非法（domain 词表外 / events 缺失）→ 消费但不 ack', () => {
    makeSink(true)
    const { responses, emit } = makeAdapter()

    emit(selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: [JSON.stringify({ domain: 'bogus', fileKey: 'x', events: [], emittedAt: 1 })] }))
    emit(selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: [JSON.stringify({ domain: 'run', fileKey: 'wf-1', emittedAt: 1 })] }))
    expect(responses).toHaveLength(0)
  })

  it('sessionId 缺席 → 无法归属，整帧丢弃（消费但不 ack，不路由）', () => {
    const calls = makeSink(true)
    const { responses, emit } = makeAdapter()

    const frame = validReport()
    delete (frame as { sessionId?: string }).sessionId
    emit(reportFrame(frame))
    expect(calls).toHaveLength(0)
    expect(responses).toHaveLength(0)
  })
})

describe('旁路不干扰事件流', () => {
  it('marker 帧后的普通事件照常 interpret（隔离边界内零传染）', () => {
    makeSink(true)
    const { interpret, emit } = makeAdapter()

    emit(reportFrame(validReport()))
    emit({ type: 'agent_start' })

    expect(interpret).toHaveBeenCalledTimes(1)
  })
})

/**
 * EventAdapter marker 检测合并测试（cluster runtime-C06：8 文件簇复筛后 7 文件折叠）。
 *
 * 复筛剔除：event-interpreter-watchdog（被测对象是 EventInterpreter 的 ping watchdog，
 * adapter/protocol 仅为其构造输入的依赖——「共同绑定必须是被测业务模块」口径不符，
 * 保留独立文件 test/event-interpreter-watchdog.test.ts）。
 *
 * 来源（分节注释见内）：
 * - event-adapter-permission-title / -plan-review-marker / -ui-form-marker（marker 路由）
 * - event-adapter-rt2-hardening（translate 隔离显形）/ subagent-directive（live/reload 链路）
 * - event-adapter-gui（GUI marker）/ event-adapter-schedule-create（第 4 marker 分支）
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-markers.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventAdapter, translate } from '../event-adapter.js'
import { rebuildHistoryFromEntries } from '../entry-tree-builder.js'
import { EventInterpreter } from '../../../services/session/event-interpreter.js'
import {
  PERMISSION_APPROVAL_TITLE,
  ASK_USER_MARKER,
  PLAN_REVIEW_MARKER,
  PLAN_SELF_REVIEW_MAX_BYTES,
  SUBAGENT_INFLIGHT_MARKER,
  UI_FORM_MARKER,
  SCHEDULE_CREATE_MARKER,
  GUI_WIDGET_MARKER,
} from '@zhushanwen/extension-protocol'
import type { ScheduleDraft } from '@zhushanwen/extension-protocol'
import { parseSubagentDirective, SUBAGENT_DIRECTIVE_CUSTOM_TYPE } from '@taiji/shared'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../../../services/session/types.js'
import type {
  PiEvent,
  PiMessageEndEvent,
  PiMessageStartEvent,
  PiSessionEntry,
  PiSessionCustomMessageEntry,
  PiExtensionUiRequestEvent,
  PiToolExecutionUpdateEvent,
} from '../pi-protocol.js'

// ════════════════ 来源: event-adapter-permission-title.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter permission 审批 title 判定测试（chat-flow-consistency U9 / S4；常量单源化对拍）。
// 覆盖（照 plan-review-marker 检测测试形态，全部 mock 零真实 pi）：
// - title 首行 = PERMISSION_APPROVAL_TITLE 的 select → extension-ui kind + 广播帧双落
// permission: true 键（侧栏等待可见性判定键，planReview: true 同构先例）
// - 多行 title 首行命中 → 仍命中（判定按首行精确匹配，title 可多行——与 pi-permission
// approval.ts formatTitle 多行构造对拍）
// - 普通 select（非 permission title）不带 permission 标记（plain dialog 形态不变）
// - title 仅含 PERMISSION_APPROVAL_TITLE 子串但首行不等 → 不命中（精确匹配，非子串匹配）
// 对拍纪律：本测试与 extensions/universal/permission approval.test.ts 引用同一符号
// PERMISSION_APPROVAL_TITLE（值锁定在 extension-protocol markers.test.ts）——写侧改
// 文案而读侧未同步时，本测试红灯（修复前是双端手抄，静默失联零报错）。
// /

const SID_PERM = 'sess-permission-title-1'

function selectEvent(overrides: Partial<PiExtensionUiRequestEvent> = {}): PiExtensionUiRequestEvent {
  return { type: 'extension_ui_request', method: 'select', id: 'req-1', ...overrides }
}

/** 从 translate 结果取 message kind 事件的 payload（extension.ui_request 广播帧）。 */
function broadcastPayload(events: PiTranslatedEvent[]): Record<string, unknown> | undefined {
  const frame = events.find((e) => e.kind === 'message')
  if (!frame || frame.kind !== 'message') return undefined
  return frame.message.payload as Record<string, unknown>
}

describe('EventAdapter permission 审批 title 判定（常量单源化对拍）', () => {
  it('title 首行 = PERMISSION_APPROVAL_TITLE → extension-ui + 广播帧双落 permission:true', () => {
    const events = translate(
      selectEvent({ title: PERMISSION_APPROVAL_TITLE, options: ['Approve (once)', 'Deny'] }),
      SID_PERM,
    )

    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.method).toBe('select')
    expect(uiEvent.payload['permission']).toBe(true)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['permission']).toBe(true)
    expect(payload?.['sessionId']).toBe(SID_PERM)
    expect(payload?.['requestId']).toBe('req-1')
  })

  it('多行 title 首行命中 → 仍落 permission:true（判定按首行，与 formatTitle 多行构造对拍）', () => {
    const multiLineTitle = `${PERMISSION_APPROVAL_TITLE}\nTool: bash\nCommand: rm -rf /tmp\nReason: no allow rule`
    const payload = broadcastPayload(
      translate(selectEvent({ title: multiLineTitle, options: ['Approve (once)', 'Deny'] }), SID_PERM),
    )
    expect(payload?.['permission']).toBe(true)
  })

  it('普通 select（非 permission title）不带 permission 标记（plain dialog 形态不变）', () => {
    const payload = broadcastPayload(translate(selectEvent({ title: 'Pick one', options: ['a', 'b'] }), SID_PERM))
    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('permission')
    expect(payload?.['title']).toBe('Pick one')
  })

  it('title 首行含 PERMISSION_APPROVAL_TITLE 子串但不等 → 不命中（精确匹配，非子串匹配）', () => {
    const payload = broadcastPayload(
      translate(
        selectEvent({ title: `prefix ${PERMISSION_APPROVAL_TITLE}`, options: ['a', 'b'] }),
        SID_PERM,
      ),
    )
    expect(payload).not.toHaveProperty('permission')
  })
})

// ════════════════ 来源: event-adapter-plan-review-marker.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter PLAN_REVIEW_MARKER 检测路由测试（plan 模式重设计 D5，u1-rpc 领地补配项）。
// 覆盖（照 ask-user 检测测试形态，全部 mock 零真实 pi）：
// - title=PLAN_REVIEW_MARKER 的 select 事件 → 成对产出 extension-ui kind + extension.ui_request
// 广播帧，payload 含 planReview: true 标记（与 askUser: true 同构分流）；docs 不透传进帧
// （审批条文档清单由 usePlanState 派生视图链 session.planState 承载，死字段 planReviewDocs 已删）
// - 普通 select（无 marker）不带 planReview 标记（plain dialog 分支形态不变）
// - marker 命中但 payload 非法（非 JSON）→ 降级普通 select（payload 无 planReview，
// 与 ask-user 检测失败降级同构边界）
// - selfReview 透传（D9③）：marker select 帧携带 selfReview（仅这一个有界字段加员，docs
// 不透传纪律保留）；边界形态：缺席/非 string 不落键、空串原样过、超限不截不拒（截断在
// 扩展写侧——canonical = packages/extension-protocol/src/extensions/plan/review-contract.ts 的 truncateSelfReview）
// - 既有 marker 路由无回归：ASK_USER_MARKER 富交互分流照常（form:true 统一表单帧）；
// SUBAGENT_INFLIGHT_MARKER 唯一不广播例外照常（translate 检查分支零产出）
// /

const SID_PLAN = 'sess-plan-review-1'

/** 从 translate 结果取 message kind 事件的 payload（extension.ui_request 广播帧）。 */
describe('EventAdapter PLAN_REVIEW_MARKER 检测路由（D5）', () => {
  it('title=PLAN_REVIEW_MARKER + docs payload → 广播 extension.ui_request 含 planReview:true；docs 不透传（planState 派生视图链承载）', () => {
    const docs = [{ fileName: 'design.md', absPath: '/repo/.taiji-harness/slug/design.md', sourceSkill: 'tech-design', version: 1 }]
    const events = translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs })] }),
      SID_PLAN,
    )

    // 成对产出：extension-ui kind（interpreter 挂起跟踪）+ message kind（前端广播帧）
    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.method).toBe('select')
    expect(uiEvent.requestId).toBe('req-1')
    expect(uiEvent.sessionId).toBe(SID_PLAN)
    expect(uiEvent.payload['planReview']).toBe(true)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['planReview']).toBe(true)
    // 死字段已删：帧不携带 docs（前端审批条文档清单读 session.planState，不读本帧）
    expect(payload).not.toHaveProperty('planReviewDocs')
    expect(payload?.['sessionId']).toBe(SID_PLAN)
    expect(payload?.['requestId']).toBe('req-1')
  })

  it('普通 select（无 marker）不带 planReview 标记（plain dialog 分支形态不变）', () => {
    const events = translate(selectEvent({ title: 'Pick one', options: ['a', 'b'] }), SID_PLAN)
    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['planReview']).toBeUndefined()
    expect(payload?.['askUser']).toBeUndefined()
    // plain dialog 形态：title/options 原样透传
    expect(payload?.['title']).toBe('Pick one')
    expect(payload?.['options']).toEqual(['a', 'b'])
  })

  it('marker 命中但 payload 非法（非 JSON）→ 降级普通 select，payload 无 planReview', () => {
    const events = translate(selectEvent({ title: PLAN_REVIEW_MARKER, options: ['not-json'] }), SID_PLAN)
    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['planReview']).toBeUndefined()
    // 降级 = plain dialog 形态（title 透传原样，前端 C4 未识别 marker title 是检测失败的
    // 边界场景——与 ask-user 检测失败降级同构）
    expect(payload?.['title']).toBe(PLAN_REVIEW_MARKER)
  })

  it('docs 缺失（合法 JSON 但无 docs 字段）→ 降级普通 select', () => {
    const events = translate(selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ other: 1 })] }), SID_PLAN)
    const payload = broadcastPayload(events)
    expect(payload?.['planReview']).toBeUndefined()
  })

  it('selfReview 透传（D9③）：marker select 帧携带 selfReview（extension-ui + 广播帧双落键，docs 仍不透传）', () => {
    const docs = [{ fileName: 'design.md', absPath: '/repo/.taiji-harness/slug/design.md', sourceSkill: 'tech-design', version: 1 }]
    const selfReview = '已对照需求逐条核对：覆盖 3/3，无未验证假设。'
    const events = translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs, selfReview })] }),
      SID_PLAN,
    )
    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.payload['selfReview']).toBe(selfReview)
    const payload = broadcastPayload(events)
    expect(payload?.['selfReview']).toBe(selfReview)
    // docs 不透传纪律保留（仅 selfReview 一个字段加员）
    expect(payload).not.toHaveProperty('docs')
    expect(payload).not.toHaveProperty('planReviewDocs')
  })

  it('selfReview 边界（缺席/非 string/空串）：缺席（旧扩展）与非 string 不落键；空串原样透传（非空硬门在扩展 tool 层）', () => {
    const docs: unknown[] = []
    const absent = broadcastPayload(translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs })] }),
      SID_PLAN,
    ))
    expect(absent).toBeDefined()
    expect(absent).not.toHaveProperty('selfReview')
    // 协议错配防御式不落键（帧上永不出现非法类型值，同 expectTurn 严格 typeof 检查纪律）
    const nonString = broadcastPayload(translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs, selfReview: 42 })] }),
      SID_PLAN,
    ))
    expect(nonString).not.toHaveProperty('selfReview')
    // 空串在 string 值域内：透传层不判语义，原样过（防照抄/非空门在扩展写侧）
    const empty = broadcastPayload(translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs, selfReview: '' })] }),
      SID_PLAN,
    ))
    expect(empty?.['selfReview']).toBe('')
  })

  it('selfReview 超限（> PLAN_SELF_REVIEW_MAX_BYTES）：透传层不截不拒原样过（有界性由写侧单点截断保证，D9③）', () => {
    const overLimit = 'x'.repeat(PLAN_SELF_REVIEW_MAX_BYTES + 1)
    const payload = broadcastPayload(translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs: [], selfReview: overLimit })] }),
      SID_PLAN,
    ))
    expect(payload?.['selfReview']).toBe(overLimit)
  })
})

describe('EventAdapter 既有 marker 路由无回归（plan-review 加员后）', () => {
  it('ASK_USER_MARKER 富交互分流照常（form:true 统一表单帧 + type 推断映射，无 planReview 串扰）', () => {
    const questions = [{ question: '选择方案?', options: ['A', 'B'] }]
    const events = translate(
      selectEvent({ title: ASK_USER_MARKER, options: [JSON.stringify({ questions, allowCancel: true })] }),
      SID_PLAN,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBe(true)
    expect(payload?.['formQuestions']).toEqual([
      { type: 'choice', question: '选择方案?', options: ['A', 'B'] },
    ])
    expect(payload?.['planReview']).toBeUndefined()
  })

  it('SUBAGENT_INFLIGHT_MARKER 唯一不广播例外照常（translate 检查分支零产出）', () => {
    const events = translate(
      selectEvent({ title: SUBAGENT_INFLIGHT_MARKER, options: [JSON.stringify({ report: {} })] }),
      SID_PLAN,
    )
    expect(events).toHaveLength(0)
  })
})

// ════════════════ 来源: event-adapter-rt2-hardening.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter RT-2 批次加固测试（code-harden 审计批次 4 Wave 1，RT-2 组 #3a/#7）。
// 锁定：
// - #3a translate 隔离：attach 内 translate 与 interpret 同处隔离边界——pi 字段漂移致
// handler 直读炸掉（tool_execution_update.partialResult.content 数组形态缺位：条目为
// null/undefined，normalizeWithTailCap 直读 c.type 抛 TypeError）时，失败在 adapter 内
// 显形为 message.stream_warn（MF-1-13：非终结性 system 提示，前端不调 finalizeSession、
// session 保持 streaming——pi 流继续，turn 可能照常成功；stream_error 会被
// registry 无条件归为 error 终态）并留 [ADAPTER-FAIL] 日志，流继续（后续好帧
// 照常翻译）。修复前 translate 在 try 外：异常逃逸进 rpc-client 的 stdout parse
// catch 被误记「parse error」，本帧对第二 listener 整帧丢失且无用户可见失败。
// 同一失败原因只显形一次（漂移按帧复发，逐帧提示刷屏）。
// - #7 未知 extension_ui_request method：不再静默 noop——console.warn 留痕（pi 升级
// 新增 method 尤其阻塞式时无痕丢弃会让 pi 侧 Promise 永挂）。已知落点 setTitle
// （宿主不实现的 fire-and-forget，预决策只补类型与 warn）。
// 失败载体 = 活体 handler tool_execution_update（event-adapter attach 注释点名的漂移
// 炸点；原载体 queue_update 已退役为 NULL_EVENTS no-op，不再经过任何 handler）。
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息；attach 路径用
// 最小 fake client（onEvent 捕获 listener）驱动。
// /

/** 最小 fake client：捕获 attach 注册的 listener，测试经 emit 驱动。 */
function fakeClient() {
  let listener: ((event: unknown) => void) | null = null
  return {
    onEvent: vi.fn((cb: (event: unknown) => void) => {
      listener = cb
      return () => { listener = null }
    }),
    emit(event: unknown): void {
      if (!listener) throw new Error('listener not attached')
      listener(event)
    },
  }
}

/** 从 interpret 收到的批次中取出唯一 message（断言前收窄 kind 联合）。 */
function soleMessage(events: PiTranslatedEvent[]): { type: string; payload: Record<string, unknown> } {
  expect(events).toHaveLength(1)
  const [ev] = events
  if (!ev || ev.kind !== 'message') {
    throw new Error(`expected single message event, got: ${JSON.stringify(ev)}`)
  }
  return ev.message as { type: string; payload: Record<string, unknown> }
}

/** 坏帧构造：partialResult.content 数组内条目形态漂移（normalizeWithTailCap 直读炸点）。 */
function updateEvent(contentItems: unknown[]): PiToolExecutionUpdateEvent {
  return {
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'bash',
    partialResult: { content: contentItems },
  }
}

describe('EventAdapter RT-2 加固：translate 隔离显形（#3a）', () => {
  it('translate 抛错 → [ADAPTER-FAIL] 日志 + message.stream_warn 非终结显形（MF-1-13）', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter('s1', interpret)
    const client = fakeClient()
    adapter.attach(client)

    // 注意：断言须在 mockRestore 之前（restore 清空 mock.calls——先例 fs-guard.test.ts 同款时序）
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let adapterFailLogged = false
    try {
      // 触发点：handleToolExecutionUpdate → normalizeWithTailCap 的 content 条目直读
      //（pi 字段漂移致数组内混入 null 条目）
      // 修复前此 emit 同步抛出（translate 在 try 外），interpret 收不到任何事件
      client.emit(updateEvent([null]))
      adapterFailLogged = errSpy.mock.calls.some((c) => String(c[0]).includes('[ADAPTER-FAIL]'))
    } finally {
      errSpy.mockRestore()
    }

    expect(interpret).toHaveBeenCalledTimes(1)
    const msg = soleMessage(interpret.mock.calls[0][0] as PiTranslatedEvent[])
    // MF-1-13 锁定：非终结 stream_warn（不是 stream_error——registry 对后者无条件
    // finalizeSession，会把 pi 实际成功的 turn 收成 error 终态），payload 无 kind 字段
    expect(msg.type).toBe('message.stream_warn')
    expect(msg.payload.sessionId).toBe('s1')
    expect('kind' in msg.payload).toBe(false)
    expect(String(msg.payload.content)).toContain('事件翻译失败')
    expect(adapterFailLogged).toBe(true)
  })

  it('坏帧后流继续：后续合法帧照常翻译（订阅存活）', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter('s1', interpret)
    const client = fakeClient()
    adapter.attach(client)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    client.emit(updateEvent([null]))
    errSpy.mockRestore()

    // 第二帧（合法）正常产出 tool_execution_update 广播帧
    client.emit({
      type: 'tool_execution_update',
      toolCallId: 't2',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'hi' }] },
    })

    expect(interpret).toHaveBeenCalledTimes(2)
    const msg = soleMessage(interpret.mock.calls[1][0] as PiTranslatedEvent[])
    expect(msg.type).toBe('message.tool_call_update')
    expect(msg.payload.toolCallId).toBe('t2')
    expect(msg.payload.output).toBe('hi')
  })

  it('同一失败原因去重显形一次，相异原因各显形一次（MF-1-13）', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter('s1', interpret)
    const client = fakeClient()
    adapter.attach(client)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 同一原因连发两帧（漂移按帧复发的真实形态）：只显形一次
      client.emit(updateEvent([null]))
      client.emit(updateEvent([null]))
      // 相异原因：undefined 条目（与 null 条目的 TypeError 文本不同，去重按错误文本分键）
      client.emit(updateEvent([undefined]))
    } finally {
      errSpy.mockRestore()
    }

    // 两帧同因 → 第二帧静默（日志仍每帧照记）；第三帧异因 → 新 stream_warn
    expect(interpret).toHaveBeenCalledTimes(2)
    const first = soleMessage(interpret.mock.calls[0][0] as PiTranslatedEvent[])
    const second = soleMessage(interpret.mock.calls[1][0] as PiTranslatedEvent[])
    expect(first.type).toBe('message.stream_warn')
    expect(second.type).toBe('message.stream_warn')
    expect(String(first.payload.content)).not.toBe(String(second.payload.content))
  })
})

describe('EventAdapter RT-2 加固：未知 ui method warn（#7）', () => {
  it('setTitle（宿主不实现的 fire-and-forget）→ warn 留痕 + noop，不抛错', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let events: PiTranslatedEvent[]
    try {
      events = translate(
        { type: 'extension_ui_request', id: 'r1', method: 'setTitle', title: 'T' } as unknown as PiExtensionUiRequestEvent,
        's1',
      )
      // 断言在 mockRestore 之前（restore 清空 mock.calls）
      expect(warnSpy).toHaveBeenCalledWith('[EventAdapter] Unhandled extension_ui_request method:', 'setTitle')
    } finally {
      warnSpy.mockRestore()
    }
    expect(events).toEqual([{ kind: 'noop' }])
  })

  it('union 内方法（set_editor_text）不走 unknown 分支（穷举修复的运行时对照）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = translate(
        { type: 'extension_ui_request', id: 'r2', method: 'set_editor_text', text: 'abc' } as unknown as PiExtensionUiRequestEvent,
        's1',
      )
      const msg = soleMessage(events)
      expect(msg.type).toBe('extension:setEditorText')
      expect(msg.payload).toEqual({ sessionId: 's1', text: 'abc' })
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('Unhandled extension_ui_request')),
      ).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ════════════════ 来源: event-adapter-ui-form-marker.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter UI_FORM_MARKER 检测路由测试（ui-presentation-protocol u2）。
// 覆盖（照 plan-review / ask-user 检测测试形态，全部 mock 零真实 pi）：
// - title=UI_FORM_MARKER 的 select 事件 → 成对产出 extension-ui kind + extension.dialog
// 广播帧，payload 含 form:true 标记 + formQuestions（检查过滤后的合法项）+ allowCancel
// - 消费端检查失败策略（设计 D2 末条，与 ask-user 整体判否不同）：isFormQuestion 逐项过滤，
// 混合数组仅保留合法项；全不合法 / 非 JSON / formQuestions 非数组 → 降级普通 select
// - kind 双事件断言：extension-ui kind（watchdog 暂停 + server 跟踪 + pending 缓存的编排
// 入口，interpreter 路由 onExtensionUIRequest）+ message kind（前端广播帧）成对且字段一致
// - 既有 marker 分支无回归（legacy 归一上移：ASK_USER / SCHEDULE_CREATE 分支同样产出
// form:true 统一表单帧——askUser 源 type 推断映射、scheduleCreate 源保留键分流应答形状）
// - expectTurn 条件落键（form-submit-busy-convergence D1 段 3 单点透传）：options 显式
// false → 帧含 expectTurn:false；缺省 / 非 boolean → 帧无该键（类型检查）
// /

const SID_UIFORM = 'sess-ui-form-1'

/** 从 translate 结果取 message kind 事件的 payload（extension.ui_request 广播帧）。 */
/** 三类型合法问题集（choice / text / schedule 各一，全可选字段覆盖验证保真） */
function makeValidQuestions(): unknown[] {
  return [
    { type: 'choice', header: 'db', question: '选哪个数据库?', context: '迁移目标', options: [{ label: 'PG', description: '成熟' }, { label: 'MySQL' }], multi: true, allowOther: false },
    { type: 'text', header: 'note', question: '备注什么?' },
    { type: 'schedule', header: 'task', question: '确认定时任务', initial: { kind: 'once', schedule: '0 30 9 20 9 *', prompt: '跑一次备份', models: ['glm-5'] } },
  ]
}

describe('EventAdapter UI_FORM_MARKER 检测路由（u2）', () => {
  it('合法 formQuestions → 双事件：extension-ui kind + 广播帧，form:true + 合法项透传 + allowCancel 保真', () => {
    const questions = makeValidQuestions()
    const events = translate(
      selectEvent({ id: 'req-form', title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: questions, allowCancel: false })] }),
      SID_UIFORM,
    )

    // 成对产出：extension-ui kind（interpreter 挂起跟踪 + pending 缓存编排入口）+ message kind（前端广播帧）
    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.method).toBe('select')
    expect(uiEvent.requestId).toBe('req-form')
    expect(uiEvent.sessionId).toBe(SID_UIFORM)
    expect(uiEvent.payload['form']).toBe(true)
    expect(uiEvent.payload['formQuestions']).toEqual(questions)
    expect(uiEvent.payload['allowCancel']).toBe(false)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['form']).toBe(true)
    expect(payload?.['formQuestions']).toEqual(questions)
    expect(payload?.['allowCancel']).toBe(false)
    expect(payload?.['sessionId']).toBe(SID_UIFORM)
    expect(payload?.['requestId']).toBe('req-form')
    expect(payload?.['dialogKind']).toBe('select')
    // 与 ask-user 分支同构：不传 title/options（避免前端把 JSON payload 当下拉选项/标题）
    expect(payload?.['title']).toBeUndefined()
    expect(payload?.['options']).toBeUndefined()
    // 与既有富交互字段互不串扰
    expect(payload?.['askUser']).toBeUndefined()
    expect(payload?.['askUserQuestions']).toBeUndefined()
    expect(payload?.['scheduleCreate']).toBeUndefined()
    expect(payload?.['scheduleDraft']).toBeUndefined()
  })

  it('allowCancel 缺省 → 默认 true（与 askUserInteract 现状一致）', () => {
    const events = translate(
      selectEvent({ title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: [{ type: 'text', question: 'q' }] })] }),
      SID_UIFORM,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['allowCancel']).toBe(true)
  })

  it('expectTurn 显式 false → 条件落键：extension-ui kind 与广播帧 payload 均含 expectTurn:false', () => {
    const events = translate(
      selectEvent({ id: 'req-et-false', title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: [{ type: 'text', question: 'q' }], expectTurn: false })] }),
      SID_UIFORM,
    )
    // 双事件一致（沿既有逐字段断言形态）：extension-ui kind 与前端广播帧同键
    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.payload['expectTurn']).toBe(false)

    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBe(true)
    expect(payload?.['expectTurn']).toBe(false)
    // 与既有键互不串扰
    expect(payload?.['allowCancel']).toBe(true)
    expect(payload?.['formQuestions']).toEqual([{ type: 'text', question: 'q' }])
  })

  it('expectTurn 缺省 → 帧 payload 无该键（undefined 省键：存量断言与 pending {...r,...r.payload} 解包无需适配）', () => {
    const payload = broadcastPayload(selectTranslate(JSON.stringify({ formQuestions: [{ type: 'text', question: 'q' }] })))
    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('expectTurn')
  })

  it('expectTurn 非 boolean（字符串 "false"）→ 不入帧（类型检查，与 renderer 侧 typeof === "boolean" 检查对齐）', () => {
    const payload = broadcastPayload(
      selectTranslate(JSON.stringify({ formQuestions: [{ type: 'text', question: 'q' }], expectTurn: 'false' })),
    )
    // form 帧照常产出，仅该键被检查拦截
    expect(payload?.['form']).toBe(true)
    expect(payload).not.toHaveProperty('expectTurn')
  })

  it('混合数组仅保留合法项（逐项过滤，不合法项剔除且合法项顺序保持）', () => {
    const validChoice = { type: 'choice', question: '合法单选', options: [{ label: 'A' }] }
    const invalidNoQuestion = { type: 'choice', options: [{ label: 'B' }] } // 缺 question
    const validText = { type: 'text', question: '合法文本' }
    const invalidBadOptions = { type: 'choice', question: 'options 非法', options: 'not-array' }
    const events = translate(
      selectEvent({
        title: UI_FORM_MARKER,
        options: [JSON.stringify({ formQuestions: [validChoice, invalidNoQuestion, validText, invalidBadOptions] })],
      }),
      SID_UIFORM,
    )

    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBe(true)
    // 仅两项合法项保留，顺序与原数组一致
    expect(payload?.['formQuestions']).toEqual([validChoice, validText])
  })

  it('全不合法（合法 JSON 但每项都过不了 isFormQuestion）→ 降级普通 select', () => {
    const badPayload = JSON.stringify({ formQuestions: [{ type: 'choice', question: 'x', options: 42 }, 'not-a-question'] })
    const events = selectTranslate(badPayload)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['formQuestions']).toBeUndefined()
    // 降级 = plain dialog 形态：title/options 原样透传（options 经 .map(String)，前端 band 渲染）
    expect(payload?.['title']).toBe(UI_FORM_MARKER)
    expect(payload?.['options']).toEqual([badPayload])
    // 降级路径仍产 extension-ui kind（plain dialog 路径同款，select 挂起语义不丢）
    const uiEvent = events.find((e) => e.kind === 'extension-ui')
    expect(uiEvent).toBeDefined()
  })

  it('非 JSON payload → 降级普通 select', () => {
    const events = translate(selectEvent({ title: UI_FORM_MARKER, options: ['not-json{'] }), SID_UIFORM)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['options']).toEqual(['not-json{'])
  })

  it('formQuestions 非数组（合法 JSON 但字段形态错）→ 降级普通 select', () => {
    const events = selectTranslate(JSON.stringify({ formQuestions: { type: 'text', question: 'q' } }))
    expect(broadcastPayload(events)?.['form']).toBeUndefined()
  })

  it('formQuestions 空数组 → 降级普通 select（逐项过滤后合法项为 0）', () => {
    const events = selectTranslate(JSON.stringify({ formQuestions: [] }))
    expect(broadcastPayload(events)?.['form']).toBeUndefined()
  })

  it('confirm + title 碰巧是 marker（method≠select）→ 不进 marker 分支', () => {
    const events = translate(
      {
        type: 'extension_ui_request',
        method: 'confirm',
        id: 'req-confirm',
        title: UI_FORM_MARKER,
        message: 'sure?',
        options: [JSON.stringify({ formQuestions: makeValidQuestions() })],
      } as PiExtensionUiRequestEvent,
      SID_UIFORM,
    )

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['dialogKind']).toBe('confirm')
    expect(payload?.['form']).toBeUndefined()
  })

  it('普通 select（title 非 marker）→ 无 form 字段（不误伤普通下拉）', () => {
    const events = translate(selectEvent({ title: 'Pick a color', options: ['red', 'green'] }), SID_UIFORM)
    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['options']).toEqual(['red', 'green'])
  })

  /** 辅助：marker title + 指定 payload 字符串翻译 */
  function selectTranslate(payloadJson: string): PiTranslatedEvent[] {
    return translate(selectEvent({ title: UI_FORM_MARKER, options: [payloadJson] }), SID_UIFORM)
  }
})

describe('EventAdapter form 帧的 pending 缓存编排入口（interpreter 路由）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  it('extension-ui kind 经 interpreter 路由 onExtensionUIRequest（server 跟踪 + pending 缓存的编排入口）', () => {
    const onExtensionUIRequest = vi.fn()
    const interpreter = new EventInterpreter(SID_UIFORM, { send, onExtensionUIRequest })

    const questions = makeValidQuestions()
    const events = translate(
      selectEvent({ id: 'req-pending', title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: questions })] }),
      SID_UIFORM,
    )
    interpreter.interpret(events)

    // onExtensionUIRequest 是 server 侧 trackRequest + pending 缓存的编排入口：
    // 携带完整 form payload（form/formQuestions/allowCancel），切回 session 后可经
    // extension.getPendingRequests 恢复
    expect(onExtensionUIRequest).toHaveBeenCalledTimes(1)
    const [requestId, sessionId, method, payload] = onExtensionUIRequest.mock.calls[0]
    expect(requestId).toBe('req-pending')
    expect(sessionId).toBe(SID_UIFORM)
    expect(method).toBe('select')
    expect(payload).toMatchObject({ form: true, allowCancel: true })
    expect(payload.formQuestions).toEqual(questions)

    // 广播帧同步送出（message kind 经 interpreter send）
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('extension.dialog')
  })
})

// ── 既有 marker 分支回归（legacy→form 归一上移 runtime：marker 命中即产 form 帧）──────────

describe('EventAdapter 既有 marker 分支回归（legacy 归一上移后）', () => {
  it('ASK_USER_MARKER → form:true 统一表单帧：questions 经 type 推断映射（有 options → choice、multiSelect → multi）', () => {
    const questions = [
      { header: 'db', question: '选哪个?', multiSelect: true, options: [{ label: 'PG' }] },
      { header: 'note', question: '备注?', context: 'ctx' },
    ]
    const events = translate(
      selectEvent({ title: ASK_USER_MARKER, options: [JSON.stringify({ questions, allowCancel: true })] }),
      SID_UIFORM,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBe(true)
    expect(payload?.['formQuestions']).toEqual([
      { type: 'choice', header: 'db', question: '选哪个?', options: [{ label: 'PG' }], multi: true },
      { type: 'text', header: 'note', question: '备注?', context: 'ctx' },
    ])
    // legacy 键不再透传（归一在 runtime 单点完成，renderer 只消费 view-ready 帧）
    expect(payload?.['askUser']).toBeUndefined()
    expect(payload?.['askUserQuestions']).toBeUndefined()
    expect(payload?.['allowCancel']).toBe(true)
  })

  it('ASK_USER_MARKER 非 boolean allowCancel（MF-1-14）→ 收窄回 true，不穿透类型标注', () => {
    const questions = [{ question: '备注?' }]
    // 旧版扩展序列化出字符串形态（?? 只挡 null/undefined，挡不住非 boolean 串）
    const events = translate(
      selectEvent({ title: ASK_USER_MARKER, options: [JSON.stringify({ questions, allowCancel: 'no' })] }),
      SID_UIFORM,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['allowCancel']).toBe(true)
  })

  it('UI_FORM_MARKER 非 boolean allowCancel（MF-1-14）→ 收窄回 true（与 ask-user 分支同款检查）', () => {
    const questions = [{ type: 'text', question: '备注?' }]
    const events = translate(
      selectEvent({ title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: questions, allowCancel: 0 })] }),
      SID_UIFORM,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['allowCancel']).toBe(true)
  })

  it('SCHEDULE_CREATE_MARKER → form:true + 源键保留（scheduleCreate/scheduleDraft——FormOverlay 按挂载源分流应答形状）', () => {
    const draft = { kind: 'once', schedule: '0 0 9 19 9 *', prompt: '提醒我喝水', models: ['m1'] }
    const events = translate(
      selectEvent({ title: SCHEDULE_CREATE_MARKER, options: [JSON.stringify(draft)] }),
      SID_UIFORM,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBe(true)
    expect(payload?.['scheduleCreate']).toBe(true)
    expect(payload?.['scheduleDraft']).toEqual(draft)
    // scheduler 源不走 questions 面（FormOverlay 按 draft 分流）
    expect(payload?.['formQuestions']).toBeUndefined()
  })
})

// ════════════════ 来源: subagent-directive.test.ts ════════════════
// ---- 原文件头注释 ----
// subagent-directive 双链路测试（composer-symbol-system §3.3.3a，U2c-runtime）。
// 锁定三条不变量：
// 1. live 链路：pi message_end{role:'custom', customType:'subagent-directive'} → 附加
// subagent.directive 广播（字段齐全、带 sessionId）；message_start 不产（pi sendMessage
// 对同一 message 双发 start+end，挂 start 会双广播）；非 directive custom 消息零影响（回归）。
// 2. reload 链路：JSONL 含 subagent-directive custom_message entry → rebuildHistoryFromEntries
// 产出的聊天流含定向消息项（custom system message + display:true 覆写）；旧 session 零变化。
// 3. live ≡ reload（关键规则 9）：同一 entry 数据喂两条链路，广播 payload 字段与 reload
// 消息项经 parseSubagentDirective 解析的字段相等（共享构造单点）。
// translate / rebuildHistoryFromEntries 均为纯函数，直接调用断言。
// /

const SID_DIRECTIVE = 'sess-directive-1'

/** 定向消息的权威 entry 数据（extension 经 pi.sendMessage 落盘形态，commit 21578c74f 实测）。 */
const DIRECTIVE_MESSAGE = {
  role: 'custom',
  customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
  content: '刚才的测试结果再展开讲讲',
  display: false,
  details: { subagentId: 'sub-abc-1', slug: 'build-api', direction: 'user' },
  timestamp: 1755900000000,
}

/** 构造 pi message_end 事件（message 体可定制，模拟 pi emit 的 wire 形态）。 */
function messageEnd(message: Record<string, unknown>): PiMessageEndEvent {
  return { type: 'message_end', message } as unknown as PiMessageEndEvent
}

/** 构造 pi message_start 事件。 */
function messageStart(message: Record<string, unknown>): PiMessageStartEvent {
  return { type: 'message_start', message } as unknown as PiMessageStartEvent
}

/** 从 translate 产出中筛出 WS 消息（剥掉 trace-trigger 等非 message 中间事件）。 */
function wireMessages(events: PiTranslatedEvent[]): ServerMessage[] {
  return events.filter((e): e is Extract<PiTranslatedEvent, { kind: 'message' }> => e.kind === 'message')
    .map((e) => e.message)
}

/** 构造 subagent-directive custom_message entry（pi session JSONL 持久化形态）。 */
function makeDirectiveEntry(overrides?: { details?: unknown; content?: unknown }): PiSessionCustomMessageEntry {
  return {
    type: 'custom_message',
    id: 'dir00001',
    parentId: null,
    timestamp: '2026-08-24T10:00:00.000Z',
    customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
    content: (overrides?.content ?? DIRECTIVE_MESSAGE.content) as string,
    display: false,
    details: (overrides?.details ?? DIRECTIVE_MESSAGE.details) as Record<string, unknown>,
  }
}

// ── 1. live 链路（event-adapter）──────────────────────────────────────

describe('subagent-directive live 链路（event-adapter）', () => {
  it('message_end{custom, subagent-directive} → 附加 subagent.directive 广播（字段齐全 + sessionId）', () => {
    const messages = wireMessages(translate(messageEnd(DIRECTIVE_MESSAGE), SID_DIRECTIVE))

    // 既有 message.message_end 帧保持不变（generic 通路，customStart 已喂 reducer，此帧被
    // registry 端 custom 去双计跳过——不因新增广播改变）
    expect(messages.filter((m) => m.type === 'message.message_end')).toHaveLength(1)
    // ★ 新增定向广播
    const directive = messages.filter((m) => m.type === 'subagent.directive')
    expect(directive).toHaveLength(1)
    expect(directive[0]!.payload).toEqual({
      sessionId: SID_DIRECTIVE,
      subagentId: 'sub-abc-1',
      slug: 'build-api',
      direction: 'user',
      text: '刚才的测试结果再展开讲讲',
    })
  })

  it('message_start{custom, subagent-directive} → 仅 message.customStart，不产 subagent.directive（pi 双发防双广播）', () => {
    const messages = wireMessages(translate(messageStart(DIRECTIVE_MESSAGE), SID_DIRECTIVE))

    // generic customStart 通路不变（display:false → 前端不可见，可见气泡归 message_end 侧广播）
    const customStart = messages.filter((m) => m.type === 'message.customStart')
    expect(customStart).toHaveLength(1)
    // ★ 定向广播唯一产出点是 message_end——start 侧产出即为双广播 bug
    expect(messages.filter((m) => m.type === 'subagent.directive')).toHaveLength(0)
  })

  it('message_end{custom, 非 subagent-directive} → 无 subagent.directive（现状行为回归）', () => {
    const messages = wireMessages(translate(messageEnd({
      role: 'custom',
      customType: 'subagent-bg-notify',
      content: 'Subagent done',
      display: true,
      details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000 },
      timestamp: 1755900000000,
    }), SID_DIRECTIVE))

    expect(messages.filter((m) => m.type === 'message.message_end')).toHaveLength(1)
    expect(messages.filter((m) => m.type === 'subagent.directive')).toHaveLength(0)
  })

  it('message_end{subagent-directive, details 畸形} → 降级不广播（generic 通路不受影响）', () => {
    const cases: Array<{ name: string; details: unknown }> = [
      { name: '缺 slug', details: { subagentId: 'sub-1', direction: 'user' } },
      { name: 'direction 非 user', details: { subagentId: 'sub-1', slug: 's', direction: 'assistant' } },
      { name: 'subagentId 类型错', details: { subagentId: 123, slug: 's', direction: 'user' } },
      { name: 'details 为 null', details: null },
    ]
    for (const c of cases) {
      const messages = wireMessages(translate(messageEnd({
        ...DIRECTIVE_MESSAGE,
        details: c.details,
      }), SID_DIRECTIVE))
      expect(messages.filter((m) => m.type === 'subagent.directive'), c.name).toHaveLength(0)
      expect(messages.filter((m) => m.type === 'message.message_end'), c.name).toHaveLength(1)
    }
  })
})

// ── 2. reload 链路（entry-tree-builder ← mapSessionEntries）──────────

describe('subagent-directive reload 链路（rebuildHistoryFromEntries）', () => {
  it('JSONL 含 subagent-directive entry → 聊天流含定向消息项（形态 + 顺序 + display 覆写）', () => {
    const entries: PiSessionEntry[] = [
      {
        type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-24T09:59:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '派个 subagent' }], timestamp: 1755899940000 },
      },
      makeDirectiveEntry(),
      {
        type: 'message', id: 'm2', parentId: null, timestamp: '2026-08-24T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 1755900060000 },
      },
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(定向) + assistant，顺序保留（关键规则 9：重开后定向气泡仍在原位）
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    const directive = messages[1]!
    // ★ U2b 渲染契约：custom system message 承载定向数据（customType 判别 + content=text +
    // details={subagentId,slug,direction} + display:true 覆写——false 是 pi TUI 语义）
    expect(directive.customType).toBe(SUBAGENT_DIRECTIVE_CUSTOM_TYPE)
    expect(directive.content).toBe('刚才的测试结果再展开讲讲')
    expect(directive.details).toEqual({ subagentId: 'sub-abc-1', slug: 'build-api', direction: 'user' })
    expect(directive.display).toBe(true)
    expect(directive.status).toBe('complete')
  })

  it('旧 session（无 subagent-directive entry）→ 零变化（bg-notify display 覆写不受影响）', () => {
    const entries: PiSessionEntry[] = [
      {
        type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-24T09:59:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '跑个后台任务' }], timestamp: 1755899940000 },
      },
      {
        type: 'custom_message', id: 'cm1', parentId: null, timestamp: '2026-08-24T10:00:00.000Z',
        customType: 'subagent-bg-notify',
        content: 'Subagent done',
        display: true, // pi 可能持久化 true——完成通知类覆写 false（既有行为）
        details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000 },
      },
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system'])
    // 完成通知类 display 覆写 false（既有 SSOT 行为不回归）
    expect(messages[1]!.customType).toBe('subagent-bg-notify')
    expect(messages[1]!.display).toBe(false)
  })

  it('details 畸形的 subagent-directive entry → display 透传不覆写（隐藏，与 live 降级对称），不崩溃', () => {
    const entries: PiSessionEntry[] = [makeDirectiveEntry({ details: { subagentId: 'sub-1' } })]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    expect(messages[0]!.customType).toBe(SUBAGENT_DIRECTIVE_CUSTOM_TYPE)
    // 畸形 → 不覆写，extension 落的 false 透传 → 前端隐藏（两链路对畸形数据一致不可见）
    expect(messages[0]!.display).toBe(false)
  })
})

// ── 3. live ≡ reload 双链路一致性（关键规则 9）───────────────────────

describe('subagent-directive live ≡ reload 字段一致性', () => {
  it('同一 entry 数据喂两条链路 → 广播 payload 与 reload 消息项 parse 结果字段相等', () => {
    // live：pi message_end 事件（extension sendMessage 后 pi emit 的 wire 形态）
    const liveMessages = wireMessages(translate(messageEnd(DIRECTIVE_MESSAGE), SID_DIRECTIVE))
    // 类型谓词收窄到 ServerMessage<'subagent.directive'>——payload 字段编译期即受
    // ServerMessageMap 契约校验（D5 收益），无需运行时字段存在性防御
    const broadcast = liveMessages.find(
      (m): m is ServerMessage<'subagent.directive'> => m.type === 'subagent.directive',
    )

    // reload：同一条消息在 session JSONL 的持久化形态（custom_message entry）
    const { messages } = rebuildHistoryFromEntries([makeDirectiveEntry()], null)
    const directiveMsg = messages.find((m) => m.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE)

    expect(broadcast).toBeDefined()
    expect(directiveMsg).toBeDefined()
    const { subagentId, slug, direction, text, sessionId } = broadcast!.payload
    // ★ reload 消息项（content + details）经同一解析器还原出的定向数据 = 广播去掉 sessionId 的字段
    const reloadParsed = parseSubagentDirective(directiveMsg!.content, directiveMsg!.details)
    expect(reloadParsed).toEqual({ subagentId, slug, direction, text })
    // 广播必带 sessionId（架构约定 #7）
    expect(sessionId).toBe(SID_DIRECTIVE)
  })

  it('pi sendMessage 时序模拟：message_start → message_end 只产一次定向广播', () => {
    // pi sendMessage 无 triggerTurn 的真实事件序（0.84.1 dist agent-session.js:1093-1096）：
    // append entry 后连发 message_start + message_end（同一 message 对象）
    const startMessages = wireMessages(translate(messageStart(DIRECTIVE_MESSAGE), SID_DIRECTIVE))
    const endMessages = wireMessages(translate(messageEnd(DIRECTIVE_MESSAGE), SID_DIRECTIVE))

    const total = [...startMessages, ...endMessages].filter((m) => m.type === 'subagent.directive')
    // ★ 全事件流恰好一条定向广播（挂 message_end 单点 + start 不产，双发源头防双计）
    expect(total).toHaveLength(1)
  })
})

// 显式引用 PiEvent 联合（translate 入参契约——与 event-adapter-delta.test.ts 同款收窄用法）
type _PiEventCheck = PiEvent

// ════════════════ 来源: event-adapter-gui.test.ts ════════════════
// ---- 原文件头注释 ----
// Extension GUI 协议 — event-adapter 测试
// 验证：
// - setWidget marker 检测：NUL marker 编码的 GuiComponent JSON 解码为 extension:widgetGui 帧
// - handleToolExecutionUpdate：提取 partialResult.details 而非整体对象
// - handleToolExecutionEnd：outputRaw 提取（含 ANSI 不经 stripAnsi）
// /

// ── 辅助：构造 pi setWidget 事件 ──
function makeSetWidgetEvent(widgetKey: string, widgetLines: unknown[]): PiEvent {
  return {
    type: 'extension_ui_request',
    method: 'setWidget',
    widgetKey,
    widgetLines,
  } as PiEvent
}

// ── 辅助：构造 pi tool_execution_update 事件 ──
function makeToolUpdateEvent(toolCallId: string, partialResult: unknown): PiEvent {
  return {
    type: 'tool_execution_update',
    toolCallId,
    toolName: 'test_tool',
    partialResult,
  } as PiEvent
}

// ── 辅助：构造 pi tool_execution_end 事件 ──
function makeToolEndEvent(toolCallId: string, result: unknown): PiEvent {
  return {
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'test_tool',
    result,
    isError: false,
  } as PiEvent
}

describe('event-adapter: setWidget GUI marker 检测', () => {
  it('NUL marker 编码的 GuiComponent → extension:widgetGui 帧', () => {
    const guiComponent = { type: 'stats-line', props: { items: [{ value: '3 turns' }] } }
    const encoded = [GUI_WIDGET_MARKER + JSON.stringify(guiComponent)]
    const event = makeSetWidgetEvent('todo', encoded)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widgetGui')
    expect(msg!.message.payload.widgetKey).toBe('todo')
    // gui 字段应是解析后的 GuiComponent 对象
    const gui = msg!.message.payload.gui as { type: string; props: { items: unknown[] } }
    expect(gui.type).toBe('stats-line')
    expect(gui.props.items).toHaveLength(1)
  })

  it('v1.1 信封（GuiRenderResult：v + component + meta）→ 解包 gui + meta 透传', () => {
    const envelope = {
      v: 1,
      component: { type: 'list-tree', props: { numbered: true, items: [{ label: 'a', depth: 0 }] } },
      meta: { title: 'Todo', status: 'running', progress: { current: 1, total: 3 } },
    }
    const event = makeSetWidgetEvent('todo', [GUI_WIDGET_MARKER + JSON.stringify(envelope)])

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widgetGui')
    const gui = msg!.message.payload.gui as { type: string }
    // gui 是解包后的 component（非信封本身）
    expect(gui.type).toBe('list-tree')
    expect(msg!.message.payload.meta).toEqual({
      title: 'Todo',
      status: 'running',
      progress: { current: 1, total: 3 },
    })
  })

  it('v1.1 信封无 meta → payload 不带 meta 键', () => {
    const envelope = { v: 1, component: { type: 'stats-line', props: { items: [] } } }
    const event = makeSetWidgetEvent('goal', [GUI_WIDGET_MARKER + JSON.stringify(envelope)])
    const results = translate(event, 'sess-1')
    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined
    expect(msg).toBeDefined()
    expect('meta' in msg!.message.payload).toBe(false)
  })

  it('普通文本 widgetLines → 走原 stripAnsi 路径 extension:widget', () => {
    const event = makeSetWidgetEvent('todo', ['\x1b[32mDone\x1b[0m', 'Next: work'])

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widget')
    expect(msg!.message.payload.widgetKey).toBe('todo')
    // stripAnsi 后的纯文本行
    expect(msg!.message.payload.lines).toEqual(['Done', 'Next: work'])
  })

  it('marker 但 JSON 解析失败 → 降级 stripAnsi 路径', () => {
    const badJson = [GUI_WIDGET_MARKER + '{invalid json}']
    const event = makeSetWidgetEvent('todo', badJson)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    // 降级到普通 widget（不崩溃）
    expect(msg!.message.type).toBe('extension:widget')
  })

  it('marker JSON 合法但非 GuiComponent 形状（缺 type/props）→ 降级 stripAnsi 路径', () => {
    // 合法 JSON 但不是 GuiComponent（无 type 字符串 + props 对象）
    const badShape = [GUI_WIDGET_MARKER + JSON.stringify({ foo: 'bar', type: 42 })]
    const event = makeSetWidgetEvent('todo', badShape)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension:widget')
  })
})

describe('event-adapter: handleToolExecutionUpdate details 提取', () => {
  it('partialResult 含 details.__gui__ → detail 提取 details 内容', () => {
    const partialResult = {
      details: {
        __gui__: { v: 1, component: { type: 'card', props: { body: [] } } },
        progress: 50,
      },
      content: 'working...',
    }
    const event = makeToolUpdateEvent('tc-1', partialResult)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('message.tool_call_update')
    const detail = msg!.message.payload.detail as Record<string, unknown>
    // detail 应该提取了 partialResult.details（含 __gui__），而非整个 partialResult
    expect(detail.__gui__).toBeDefined()
    expect(detail.progress).toBe(50)
    // detail 不应包含 content（那是 partialResult 顶层的字段）
    expect(detail.content).toBeUndefined()
  })

  it('partialResult 无 details → fallback 用整个对象', () => {
    // subagent 的 progress 形态：partialResult 本身就是扁平的进度对象
    const partialResult = { currentTool: 'bash', turnCount: 3 }
    const event = makeToolUpdateEvent('tc-1', partialResult)

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    const detail = msg!.message.payload.detail as Record<string, unknown>
    expect(detail.currentTool).toBe('bash')
    expect(detail.turnCount).toBe(3)
  })

  it('partialResult 为字符串 → detail 为字符串', () => {
    const event = makeToolUpdateEvent('tc-1', 'loading...')

    const results = translate(event, 'sess-1')

    const msg = results.find(r => r.kind === 'message') as
      { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined

    expect(msg).toBeDefined()
    expect(msg!.message.payload.detail).toBe('loading...')
  })
})

describe('event-adapter: handleToolExecutionEnd outputRaw', () => {
  it('result.content 含 ANSI → outputRaw 保留原始 ANSI', () => {
    const result = {
      content: [{ type: 'text', text: '\x1b[32msuccess\x1b[0m' }],
      details: { __gui__: { v: 1, component: { type: 'stats-line', props: { items: [] } } } },
    }
    const event = makeToolEndEvent('tc-1', result)

    const results = translate(event, 'sess-1')

    const tcEnd = results.find(r => r.kind === 'tool-call-end') as
      PiTranslatedEvent & { kind: 'tool-call-end'; output: string; outputRaw?: string; details?: Record<string, unknown> }

    expect(tcEnd).toBeDefined()
    // output 已 stripAnsi
    expect(tcEnd.output).toBe('success')
    // outputRaw 保留原始 ANSI
    expect(tcEnd.outputRaw).toBe('\x1b[32msuccess\x1b[0m')
    // details 透传
    expect(tcEnd.details?.__gui__).toBeDefined()
  })
})

// ── 富交互：guiInteract marker 检测 + 普通 select options 透传（U6-U8）──

/** 辅助：构造 pi extension_ui_request{method:'select'} 事件 */
function makeSelectEvent(title: string, options: unknown[], id = 'req-x'): PiEvent {
  return {
    type: 'extension_ui_request',
    method: 'select',
    id,
    title,
    options,
  } as PiEvent
}

/** 辅助：从 translate 结果中提取 message 事件 */
function findMessage(results: PiTranslatedEvent[]):
  { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined {
  return results.find(r => r.kind === 'message') as
    { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined
}

/** 辅助：从 translate 结果中提取 extension-ui kind 事件 */
function findExtensionUi(results: PiTranslatedEvent[]): PiTranslatedEvent | undefined {
  return results.find(r => r.kind === 'extension-ui')
}

describe('event-adapter: ask-user ASK_USER_MARKER 检测 (U6-U8)', () => {
  it('U6: title=marker + options[0] 合法 JSON → form 统一表单帧（type 推断映射）+ extension-ui kind 事件', () => {
    const questions = [{ header: 'db', question: '选哪个?', options: [{ label: 'PG' }] }]
    const payload = JSON.stringify({ questions, allowCancel: false })
    const event = makeSelectEvent(ASK_USER_MARKER, [payload], 'req-askuser')

    const results = translate(event, 'sess-1')

    // extension-ui kind 事件必须存在（timeout-manager 据此注册 5min 超时）
    const extUi = findExtensionUi(results)
    expect(extUi).toBeDefined()

    // message 帧：extension.dialog + form=true + formQuestions（legacy 归一上移 runtime）
    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.dialog')
    expect(msg!.message.payload.form).toBe(true)
    expect(msg!.message.payload.dialogKind).toBe('select')
    expect(msg!.message.payload.requestId).toBe('req-askuser')
    expect(msg!.message.payload.formQuestions).toEqual([
      { type: 'choice', header: 'db', question: '选哪个?', options: [{ label: 'PG' }] },
    ])
    expect(msg!.message.payload.allowCancel).toBe(false)
    // ask-user 分支不传 options（避免前端把 JSON payload 当下拉选项）
    expect(msg!.message.payload.options).toBeUndefined()
    // legacy 键不再透传（归一在 runtime 单点完成）
    expect(msg!.message.payload.askUser).toBeUndefined()
    expect(msg!.message.payload.askUserQuestions).toBeUndefined()
    // 与 schedule-create 源键互不串扰
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
  })

  it('U7: 普通 select（title≠marker）→ options 透传 string[]（.map(String)，不拍扁）', () => {
    // pi select 真实格式：string[]，不是 {label,value} 对象数组
    const event = makeSelectEvent('Pick a color', ['red', 'green', 'blue'], 'req-normal')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.dialog')
    expect(msg!.message.payload.dialogKind).toBe('select')
    expect(msg!.message.payload.title).toBe('Pick a color')
    // options 透传 string[]，不是 undefined[]（旧 .map(o=>o.label) bug）
    expect(msg!.message.payload.options).toEqual(['red', 'green', 'blue'])
    // 非 marker → 无 askUser 字段
    expect(msg!.message.payload.askUser).toBeUndefined()
  })

  it.each([
    ['options[0] 非法 JSON', ['not-valid-json{'], 'req-bad'],
    ['options 为空数组', [], 'req-empty'],
  ] as Array<[string, unknown[], string]>)('U8: title=marker 但 %s → 降级普通 select', (_desc, options, requestId) => {
    const event = makeSelectEvent(ASK_USER_MARKER, options, requestId)

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.dialog')
    expect(msg!.message.payload.dialogKind).toBe('select')
    // 降级为普通 select（无 askUser/askUserQuestions 字段）
    expect(msg!.message.payload.askUser).toBeUndefined()
    // 与 schedule-create 源键互不串扰
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    // options 经 .map(String) 透传（空数组 → []）
    expect(msg!.message.payload.options).toEqual(options)
  })

  it('U8: title=marker 且 JSON 合法但 questions 为空数组 → 降级普通 select', () => {
    // S1 加固：空数组 [] 是 truthy，旧代码 if(questions) 会透传空 questions。
    // 修复后要求 .length > 0，否则降级。
    const payload = JSON.stringify({ questions: [], allowCancel: true })
    const event = makeSelectEvent(ASK_USER_MARKER, [payload], 'req-empty-q')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.askUser).toBeUndefined()
  })

  it('U6: confirm/input/editor 不受 marker 检测影响（method≠select 不进 marker 分支）', () => {
    const event = {
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-confirm',
      title: ASK_USER_MARKER,  // title 碰巧是 marker，但 method 不是 select
      message: 'sure?',
    } as PiEvent

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.dialogKind).toBe('confirm')
    expect(msg!.message.payload.askUser).toBeUndefined()
  })
})

// ── W2 特征锚定补充（自 event-adapter-widget-notify.test.ts 并入）──────────────
// setWidget 的 subagent-stream 前缀短路、notify level 映射（error/缺省 info）、
// 未知 method → noop 兜底——handleExtensionUIRequest 按 method 分发提取后此前无覆盖的分支。

/** 构造 pi extension_ui_request 事件（wire 局部形态，测试只需 type + method 字段） */
function makeUiRequest(fields: Record<string, unknown>): PiEvent {
  return { type: 'extension_ui_request', ...fields } as PiEvent
}

describe('event-adapter: setWidget subagent-stream 前缀短路（路径 A-1）', () => {
  it('widgetKey=subagent-stream-<recordId> → kind:subagent-stream + lines 全 String 化', () => {
    const event = makeUiRequest({
      method: 'setWidget',
      widgetKey: 'subagent-stream-rec-42',
      widgetLines: ['line one', 2],
    })

    const results = translate(event, 'sess-1')

    expect(results).toHaveLength(1)
    const stream = results[0] as Extract<PiTranslatedEvent, { kind: 'subagent-stream' }>
    expect(stream.kind).toBe('subagent-stream')
    expect(stream.sessionId).toBe('sess-1')
    expect(stream.recordId).toBe('rec-42')
    expect(stream.lines).toEqual(['line one', '2'])
  })

  it('widgetLines 空 → lines 为 undefined（非空数组才映射）', () => {
    const event = makeUiRequest({
      method: 'setWidget',
      widgetKey: 'subagent-stream-rec-7',
      widgetLines: [],
    })

    const results = translate(event, 'sess-1')

    expect(results).toHaveLength(1)
    const stream = results[0] as Extract<PiTranslatedEvent, { kind: 'subagent-stream' }>
    expect(stream.recordId).toBe('rec-7')
    expect(stream.lines).toBeUndefined()
  })
})

describe('event-adapter: notify level 映射补全（error / 缺省 info）', () => {
  it('notifyType=error → level:error', () => {
    const event = makeUiRequest({ method: 'notify', message: 'boom', notifyType: 'error' })
    const results = translate(event, 'sess-1')

    expect(results).toHaveLength(1)
    const msg = results[0] as Extract<PiTranslatedEvent, { kind: 'message' }>
    expect(msg.message.type).toBe('extension:notify')
    expect(msg.message.payload).toEqual({ sessionId: 'sess-1', message: 'boom', level: 'error' })
  })

  it('notifyType 缺省 → level:info；message 缺省 → 空串', () => {
    const event = makeUiRequest({ method: 'notify' })
    const results = translate(event, 'sess-1')

    const msg = results[0] as Extract<PiTranslatedEvent, { kind: 'message' }>
    expect(msg.message.payload).toEqual({ sessionId: 'sess-1', message: '', level: 'info' })
  })
})

describe('event-adapter: extension_ui_request 未知 method → noop 兜底', () => {
  it('method 不在已知集合且非 interactive → 单个 noop，无任何 WS 帧', () => {
    const results = translate(makeUiRequest({ method: 'totally_unknown' }), 'sess-1')

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ kind: 'noop' })
  })
})

// ════════════════ 来源: event-adapter-schedule-create.test.ts ════════════════
// ---- 原文件头注释 ----
// event-adapter 第 4 marker 分支：schedule 创建确认（SCHEDULE_CREATE_MARKER）翻译测试。
// 设计 scheduler-create-confirm-modal §3.4 / U5 验收：
// - 合法 draft → 翻译为 extension.dialog 帧（scheduleCreate: true + scheduleDraft 字段保真）
// + extension-ui kind 事件（watchdog 暂停 + pending 跟踪，S4）
// - 检测失败（非合法 JSON / draft 缺字段）→ 降级普通 select（S2 同款兜底）
// 既有 marker 分支（SESSION_MANAGER / BRIDGE / ASK_USER）的覆盖：
// - SESSION_MANAGER → src/__tests__/session-manager-e2e-probe.test.ts（marker 翻译 + 枚举检查）
// - BRIDGE → test/bridge-marker-channel.test.ts（四 method it.each + malformed 三态）
// - ASK_USER → test/event-adapter-gui.test.ts（U6 合法表单 + U8 降级）
// /

/** 辅助：构造合法 ScheduleDraft（含全部可选字段，验证字段保真） */
function makeFullDraft(): ScheduleDraft {
  return {
    kind: 'recurring',
    schedule: '0 9 * * 1-5',
    model: 'deepseek-flash',
    prompt: '总结昨天的工作进展',
    name: 'daily-summary',
    expires: '7d',
    models: ['deepseek-flash', 'glm-5'],
    currentModel: 'glm-5',
  }
}

describe('event-adapter: schedule-create SCHEDULE_CREATE_MARKER 检测（第 4 marker 分支）', () => {
  it('合法 draft → 帧 scheduleCreate=true + scheduleDraft 字段保真 + extension-ui kind 事件', () => {
    const draft = makeFullDraft()
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [JSON.stringify(draft)], 'req-sched')

    const results = translate(event, 'sess-1')

    // extension-ui kind 事件必须存在（EventInterpreter 暂停 watchdog + pending 跟踪，S4）
    const extUi = findExtensionUi(results)
    expect(extUi).toBeDefined()

    // message 帧：extension.dialog + form=true（legacy 归一上移）+ scheduleCreate=true + scheduleDraft 透传
    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.dialog')
    expect(msg!.message.payload.form).toBe(true)
    expect(msg!.message.payload.scheduleCreate).toBe(true)
    expect(msg!.message.payload.dialogKind).toBe('select')
    expect(msg!.message.payload.requestId).toBe('req-sched')
    expect(msg!.message.payload.sessionId).toBe('sess-1')
    // scheduleDraft 字段保真（深比较全字段，含可选字段）
    expect(msg!.message.payload.scheduleDraft).toEqual(draft)
    // 与 ask-user 分支同构：不传 title/options（避免前端把 JSON payload 当下拉选项/标题）
    expect(msg!.message.payload.options).toBeUndefined()
    expect(msg!.message.payload.title).toBeUndefined()
    // 与 ask-user 字段互不串扰
    expect(msg!.message.payload.askUser).toBeUndefined()
    expect(msg!.message.payload.askUserQuestions).toBeUndefined()
  })

  it('最小合法 draft（仅必填字段）→ 翻译成功，可选字段缺省透传 undefined 不在场', () => {
    const draft: ScheduleDraft = { kind: 'once', schedule: '0 0 9 19 9 *', prompt: '提醒我喝水', models: ['m1'] }
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [JSON.stringify(draft)], 'req-min')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBe(true)
    expect(msg!.message.payload.scheduleDraft).toEqual(draft)
  })

  it('once 模式 draft（schedule 为折叠 cron）→ 字段保真透传', () => {
    const draft: ScheduleDraft = {
      kind: 'once',
      schedule: '30 14 20 9 *',
      prompt: '跑一次数据备份',
      models: ['glm-5'],
      currentModel: 'glm-5',
    }
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [JSON.stringify(draft)], 'req-once')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleDraft).toEqual(draft)
  })

  it('title=marker 但 options[0] 非法 JSON → 降级普通 select（无 scheduleCreate/scheduleDraft）', () => {
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, ['not-valid-json{'], 'req-bad')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.dialog')
    expect(msg!.message.payload.dialogKind).toBe('select')
    // 降级为普通 select（无 schedule-create 专有字段）
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
    // options 经 .map(String) 透传（普通 select 路径行为）
    expect(msg!.message.payload.options).toEqual(['not-valid-json{'])
    // 降级路径不产 extension-ui kind 差异：普通 select 同样产 extension-ui kind（plain dialog 路径）
    expect(findExtensionUi(results)).toBeDefined()
  })

  it('JSON 合法但 draft 缺必填字段（缺 prompt）→ 降级普通 select', () => {
    const badDraft = JSON.stringify({ kind: 'recurring', schedule: '0 9 * * *', models: ['m1'] })
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [badDraft], 'req-missing')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
    expect(msg!.message.payload.options).toEqual([badDraft])
  })

  it('JSON 合法但 draft models 非字符串数组 → 降级普通 select', () => {
    const badDraft = JSON.stringify({ kind: 'once', schedule: '0 0 9 19 9 *', prompt: 'x', models: 'glm-5' })
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [badDraft], 'req-bad-models')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })

  it('JSON 合法但 draft kind 非法值 → 降级普通 select', () => {
    const badDraft = JSON.stringify({ kind: 'daily', schedule: '0 9 * * *', prompt: 'x', models: [] })
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [badDraft], 'req-bad-kind')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })

  it('title=marker 但 options 为空数组 → 降级普通 select', () => {
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [], 'req-empty')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
  })

  it('confirm + title 碰巧是 marker（method≠select）→ 不进 marker 分支', () => {
    const event = {
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-confirm',
      title: SCHEDULE_CREATE_MARKER,
      message: 'sure?',
    } as PiEvent

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.dialogKind).toBe('confirm')
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })

  it('普通 select（title 非 marker）→ 无 scheduleCreate 字段（不误伤普通下拉）', () => {
    const event = makeSelectEvent('Pick a color', ['red', 'green'], 'req-plain')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.options).toEqual(['red', 'green'])
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
  })
})

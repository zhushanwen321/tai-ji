/**
 * watchdog 重构 TDD 红灯测试：EventInterpreter ping 探测机制（ADR-0047）。
 *
 * [背景] 旧 watchdog 用「事件静默时长」检测 pi 卡死，在 ask_user 等待用户期间误杀
 * （extension-ui 的 pauseWatchdog 被同批 [extension-ui, message] 双事件中 message 触发的
 * resetWatchdog 抹掉）。新机制改用「ping get_state 进程健康探测」：
 *   - turn 进行中每 60s 发一次 get_state（pingPi 回调）
 *   - 连续 3 次失败（180s）→ 判定真卡死 → onSilentAbort
 *   - 连续 2 次失败（120s）→ 广播 message.stream_warn 一次（提示性，不中断）
 *   - ping 中途成功 → 清零失败计数 + warned 标志
 *   - turn 间（agent_end 后）不探测
 *   - onSilentAbort 触发后 ping 循环立即停止
 *
 * [红灯说明] 本测试针对尚未实现的 ping 机制。当前 EventInterpreter 仍是旧的「事件静默 +
 * pause/reset 状态机」（SILENT_WARN_MS / pauseWatchdog / resetWatchdog 等），且
 * EventInterpreterOptions 没有 pingPi 字段。故：
 *   - 构造 pingPi/onSilentAbort 依赖新字段（用 as 强转绕过类型缺失，使测试能编译）
 *   - 旧实现没有 ping 循环，pingPi 永不被调用 → AC-1/2/6/8/9 的 ping 计数断言全 fail
 *   - AC-4 旧实现 extension-ui 会 pauseWatchdog（新机制应不再 pause）→ pause 行为断言 fail
 * dev 阶段实现 ping 机制后转绿。
 *
 * [防 bug 硬要求] AC-1/AC-4 必须用真实 translate() 输出做输入（构造 pi 原始
 * extension_ui_request 事件，调 translate 拿到真实的 [extension-ui, message] 双事件数组），
 * 禁止手搓 {kind:'extension-ui'} 单事件 helper——本次 bug 根因就是 WD6 手搓单事件漏测
 * 「pause 被同批 message 的 reset 抹掉」的链路。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
// SR6（SSOT）：ping 阈值常量从源码 import，测试跟随源码调参，不本地重复定义（避免漂移）
import {
  PING_INTERVAL_MS,
  PING_WARN_FAIL_COUNT,
} from '../src/services/session/event-interpreter.js'
import { translate } from '../src/infra/pi/event-adapter.js'
import { ASK_USER_MARKER } from '@taiji/extension-protocol'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'
import type { PiExtensionUiRequestEvent } from '../src/infra/pi/pi-protocol.js'

/**
 * 构造 ask_user 的真实双事件输入（用 translate() 翻译 pi 原始 extension_ui_request 事件）。
 *
 * 这是本次 bug 的关键防回归：真实 EventAdapter 对 ask_user select 产出
 * [{kind:'extension-ui',...}, {kind:'message', message:{type:'extension.ui_request',...}}]
 * 双事件。旧 WD6 手搓单事件 helper 漏测「extension-ui pause 被同批 message reset 抹掉」。
 * 这里调真实 translate()，确保测试输入与生产翻译器输出契约一致。
 */
function buildAskUserEvents(sessionId: string): PiTranslatedEvent[] {
  const questions = [
    {
      question: '选择部署环境？',
      header: '部署环境',
      options: [
        { label: 'dev', value: 'dev', description: '开发环境' },
        { label: 'prod', value: 'prod', description: '生产环境' },
      ],
    },
  ]
  const piEvent = {
    type: 'extension_ui_request',
    id: 'req-ask-1',
    method: 'select',
    title: ASK_USER_MARKER,
    options: [JSON.stringify({ questions, allowCancel: true })],
  } as unknown as PiExtensionUiRequestEvent
  // translate 返回 [extension-ui, message] 双事件数组（与生产 EventAdapter 输出契约一致）
  return translate(piEvent, sessionId)
}

/** 构造一个 turn-start 事件（assistant turn 开始，启动 ping 探测循环）。 */
function turnStart(messageId = 'a-msg-1'): PiTranslatedEvent {
  return { kind: 'turn-start', messageId }
}

/** 构造一个 text_delta message 事件（pi 仍在产出）。 */
function textDelta(sessionId: string): PiTranslatedEvent {
  return {
    kind: 'message',
    message: { type: 'message.text_delta', payload: { sessionId, delta: 'x' } },
  }
}

/** 构造一个 agent_end turn-end 事件（turn 正常结束，停止 ping 探测）。 */
function turnEnd(sessionId: string, stopReason = 'end_turn'): PiTranslatedEvent {
  return {
    kind: 'turn-end',
    message: {
      type: 'message.complete',
      payload: { sessionId, stopReason },
    },
    stopReason,
  }
}

describe('EventInterpreter · watchdog ping 探测机制（ADR-0047）', () => {
  const sessionId = 'sid-ping'

  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void
  let pingPi: ReturnType<typeof vi.fn>
  let onSilentAbort: ReturnType<typeof vi.fn>
  let onExtensionUIRequest: ReturnType<typeof vi.fn>
  let interpreter: EventInterpreter

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    send = (msg) => { sent.push(msg) }
    // pingPi 是 seam：控制 resolve/reject 模拟 pi 健康/卡死。默认 resolve（健康）。
    pingPi = vi.fn().mockResolvedValue({})
    onSilentAbort = vi.fn()
    onExtensionUIRequest = vi.fn()
    // pingPi / onSilentAbort / onExtensionUIRequest 是新机制 seam。当前 EventInterpreterOptions
    // 尚无 pingPi 字段，用 as 强转绕过类型缺失，使测试能在「字段未实现」状态下编译。
    interpreter = new EventInterpreter(sessionId, {
      send,
      pingPi,
      onSilentAbort,
      onExtensionUIRequest,
    } as unknown as ConstructorParameters<typeof EventInterpreter>[1])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 取出 sent 中的 message.stream_warn 帧（AC-8 ping 连续 2 次失败时的 WARN 广播）。 */
  function findStreamWarn(): ServerMessage | undefined {
    return sent.find((m) => m.type === 'message.stream_warn')
  }

  // ── AC-1：ask_user 等待期间 ping 持续响应，180s 内不触发 onSilentAbort ───────
  it('AC-1: ask_user 等待用户期间（pi 阻塞在 select）ping 持续响应，180s 内不触发 onSilentAbort', async () => {
    interpreter.interpret([turnStart()])
    // 喂真实 translate() 输出的 ask_user 双事件（pi 阻塞在 select 等用户响应）
    interpreter.interpret(buildAskUserEvents(sessionId))

    // 推进 180s（ping 间隔 60s，应触发约 3 次 ping），pingPi 全部 resolve（pi 健康）
    await vi.advanceTimersByTimeAsync(180_000)

    // ping 被调用（pi 在 ask_user 等待期间事件循环仍活，能响应 get_state）
    expect(pingPi).toHaveBeenCalled()
    // 健康响应 → 不触发 onSilentAbort（核心：ask_user 等待 ≠ 卡死）
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── AC-2：pi 真卡死（ping 连续 3 次超时）→ 180s 后触发 onSilentAbort ───────
  it('AC-2: pi 真卡死（ping 连续 3 次失败）→ 180s 后触发 onSilentAbort', async () => {
    pingPi.mockRejectedValue(new Error('ping timeout')) // 模拟 pi 卡死，ping 全部超时

    interpreter.interpret([turnStart()])
    // 推进 180s（ping 间隔 60s × 3 次 = 连续 3 次失败）
    await vi.advanceTimersByTimeAsync(180_000)

    // 连续 3 次失败 → 判定真卡死 → onSilentAbort
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
    expect(onSilentAbort).toHaveBeenCalledWith(expect.objectContaining({ sessionId }))
  })

  // ── AC-3：turn 间（agent_end 后）不发起 ping 探测 ──────────────────────────
  it('AC-3: agent_end 后（turn 间）推进 180s → pingPi 不被调用（turn 间不探测）', async () => {
    interpreter.interpret([turnStart()])
    interpreter.interpret([turnEnd(sessionId)]) // turn 结束 → 停止 ping 探测

    // turn 间推进 180s，不应发起任何 ping
    await vi.advanceTimersByTimeAsync(180_000)

    expect(pingPi).not.toHaveBeenCalled()
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── AC-4：extension-ui 不再 pause，但仍通知 server 缓存 pending 请求 ────────
  it('AC-4: ask_user 双事件不再 pause watchdog，onExtensionUIRequest 仍触发（server 缓存 pending 请求）', () => {
    const events = buildAskUserEvents(sessionId)
    // 验证测试输入本身是真实双事件（防 helper 退化）
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('extension-ui')
    expect(events[1].kind).toBe('message')

    interpreter.interpret([turnStart()])
    interpreter.interpret(events)

    // onExtensionUIRequest 必须被调用（server.registerExtensionTimeout 缓存 pending 请求，
    // 超时回退路径依赖它）。新机制保留此通知，只是不再 pauseWatchdog。
    expect(onExtensionUIRequest).toHaveBeenCalledTimes(1)
    expect(onExtensionUIRequest).toHaveBeenCalledWith(
      'req-ask-1',
      sessionId,
      'select',
      expect.objectContaining({ askUser: true, sessionId }),
    )
  })

  // ── AC-6：prompt 后未收到 message_start，推进 180s 且 ping 连续 3 次失败 → abort ─
  it('AC-6: turn-start 后未收到 message_start，推进 180s 且 ping 连续 3 次失败 → 触发 onSilentAbort（盲区覆盖）', async () => {
    pingPi.mockRejectedValue(new Error('ping timeout'))

    // 模拟「prompt 已发送、turn-start 已到、但 pi 卡在 message_start 之前」盲区：
    // turn-start 启动 ping 循环，但无后续 message_start / text_delta 事件
    interpreter.interpret([turnStart()])

    // 推进 180s，ping 连续 3 次失败 → 判定卡死
    await vi.advanceTimersByTimeAsync(180_000)

    expect(onSilentAbort).toHaveBeenCalledTimes(1)
  })

  // ── AC-7：onSilentAbort 后 ping 循环立即停止，之后再推进时间不再 ping 也不重复 abort ─
  it('AC-7: onSilentAbort 触发后 ping 循环立即停止，再推进 180s 不再调 pingPi 也不重复 abort', async () => {
    pingPi.mockRejectedValue(new Error('ping timeout'))

    interpreter.interpret([turnStart()])
    // 推进到首次 abort（180s，连续 3 次失败）
    await vi.advanceTimersByTimeAsync(180_000)
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
    const pingCountAfterAbort = pingPi.mock.calls.length

    // 再推进 180s（abort 后），ping 循环应已停止：不新增 ping 调用、不重复 abort
    await vi.advanceTimersByTimeAsync(180_000)

    expect(pingPi.mock.calls.length).toBe(pingCountAfterAbort)
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
  })

  // ── AC-8：ping 连续失败 2 次 WARN，第 3 次 abort，中途成功清零 ────────────────
  it('AC-8: ping 连续失败 2 次（120s）广播 message.stream_warn 一次；第 3 次失败触发 onSilentAbort', async () => {
    pingPi.mockRejectedValue(new Error('ping timeout'))

    interpreter.interpret([turnStart()])

    // 推进 120s（ping 间隔 60s × 2 次 = 连续 2 次失败）→ 广播 WARN 一次
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * PING_WARN_FAIL_COUNT)
    const warnAfter2Fails = findStreamWarn()
    expect(warnAfter2Fails).toBeDefined()
    expect(warnAfter2Fails!.type).toBe('message.stream_warn')
    expect(onSilentAbort).not.toHaveBeenCalled() // 尚未到 abort（2 < 3）

    // 再推进 60s（第 3 次失败，累计 180s）→ 触发 onSilentAbort
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(onSilentAbort).toHaveBeenCalledTimes(1)

    // WARN 只广播一次（不重复）
    expect(sent.filter((m) => m.type === 'message.stream_warn')).toHaveLength(1)
  })

  it('AC-8b: ping 中途成功 → 清零失败计数与 warned 标志（再连续失败需重新累积 2 次才 WARN）', async () => {
    let callCount = 0
    pingPi.mockImplementation(() => {
      callCount++
      // 第 1 次失败、第 2 次成功、之后全失败
      return callCount === 1
        ? Promise.reject(new Error('timeout'))
        : callCount === 2
          ? Promise.resolve({})
          : Promise.reject(new Error('timeout'))
    })

    interpreter.interpret([turnStart()])

    // 推进 60s（第 1 次失败）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(findStreamWarn()).toBeUndefined() // 1 次失败不 WARN

    // 推进 60s（第 2 次成功 → 清零失败计数 + warned）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(findStreamWarn()).toBeUndefined()

    // 再推进 60s（第 3 次失败，但因上次成功已清零，这是新一轮的第 1 次失败）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(findStreamWarn()).toBeUndefined() // 清零后重新累积，1 次失败不 WARN
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  // ── AC-9：client 未就绪时 pingPi 回调返回 undefined，计为失败但不抛错 ────────
  it('AC-9: pingPi 回调返回 undefined（client 未就绪）→ 计为失败但不抛错，连续 3 次仍触发 onSilentAbort', async () => {
    // AC-9：client 未就绪时 pingPi 回调返回 undefined（非 reject）。新机制应把
    // undefined 视为失败（拿不到 state = 不可判定健康），但不抛错（不能因 client 偶发未就绪
    // 让 interpret 批次崩溃）。连续 3 次 undefined 仍累积到 abort。
    pingPi.mockResolvedValue(undefined)

    interpreter.interpret([turnStart()])
    await vi.advanceTimersByTimeAsync(180_000)

    // 不抛错（测试本身不 throw 即证明）+ 连续 3 次 undefined 计为失败 → abort
    expect(onSilentAbort).toHaveBeenCalledTimes(1)
  })

  it('AC-9b: pingPi 回调返回 undefined 期间中途返回有效 state → 清零失败计数（不误 abort）', async () => {
    let callCount = 0
    pingPi.mockImplementation(() => {
      callCount++
      // 1 失败(undefined) → 2 成功({}) → 3 失败(undefined) → 4 失败(undefined)
      return callCount === 1 || callCount >= 3
        ? Promise.resolve(undefined)
        : Promise.resolve({})
    })

    interpreter.interpret([turnStart()])
    // 推进 240s（4 次 ping）。因第 2 次成功清零，第 3/4 次失败只累积 2 次，不达 abort（3 次）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 4)

    expect(onSilentAbort).not.toHaveBeenCalled() // 中途成功清零，未连续 3 次失败
  })
})

/**
 * @zhushanwen/session-delivery 测试共享 mock 工厂。
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type {
  DeliveryIntent,
  DeliveryMessage,
  DeliveryPort,
} from '../src/types.js'

export function makeMockPort(
  overrides?: Partial<DeliveryPort>,
): DeliveryPort & {
  sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[]
  idle: boolean
  pendingMessages: boolean
  supportedPayloads: readonly ('text' | 'custom')[]
} {
  const sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[] = []
  let idle = true
  let pendingMessages = false
  const supportedPayloads: ('text' | 'custom')[] = ['text', 'custom']

  const port = {
    sendCalls,
    get idle() { return idle },
    set idle(v: boolean) { idle = v },
    get pendingMessages() { return pendingMessages },
    set pendingMessages(v: boolean) { pendingMessages = v },
    get supportedPayloads() { return overrides?.supportedPayloads ?? supportedPayloads },
    isIdle: () => overrides?.isIdle?.() ?? idle,
    hasPendingMessages: () => overrides?.hasPendingMessages?.() ?? pendingMessages,
    send: vi.fn((msg: DeliveryMessage, intent: DeliveryIntent) => {
      sendCalls.push({ msg, intent })
      return overrides?.send?.(msg, intent) ?? undefined
    }),
    ...(overrides?.subscribeSettled !== undefined && { subscribeSettled: overrides.subscribeSettled }),
  }

  return port
}

export function textMsg(content: string, opts?: Partial<DeliveryMessage>): DeliveryMessage {
  return {
    payload: { kind: 'text', content },
    ...opts,
  }
}

export function customMsg(
  customType: string,
  content: string,
  opts?: Partial<DeliveryMessage>,
): DeliveryMessage {
  return {
    payload: { kind: 'custom', customType, content, display: true },
    ...opts,
  }
}

/**
 * busy-park 合批测试脚手架（对齐 scheduler 真实装配：不配 mergeWindowMs，合批来自
 * busy park 队列积累 + settled 边沿 flush 整队出队）。port 初始 busy（idle 经
 * setIdle 翻转），subscribeSettled 捕获 settled 边沿回调（退订置空），fireSettled
 * 在翻转 idle 后手动触发边沿。
 */
/** makeBusyParkPort 返回：port + idle 翻转 + settled 边沿触发。 */
export interface BusyParkPortHandle {
  port: ReturnType<typeof makeMockPort>
  setIdle: (v: boolean) => void
  fireSettled: () => void
}

export function makeBusyParkPort(): BusyParkPortHandle {
  let idle = false
  let settledCb: (() => void) | undefined
  const port = makeMockPort({
    isIdle: () => idle,
    subscribeSettled: (cb) => {
      settledCb = cb
      return () => {
        settledCb = undefined
      }
    },
  })
  return {
    port,
    setIdle: (v: boolean) => {
      idle = v
    },
    fireSettled: () => {
      settledCb!()
    },
  }
}

/**
 * per-message settled 断言：第 index 次终态回调的 msg 为该条原始消息引用
 * （非 clone、非 composed 合批消息）。
 */
export function expectSettledMsg(
  onSettled: ReturnType<typeof vi.fn>,
  index: number,
  msg: DeliveryMessage,
): void {
  expect(onSettled.mock.calls[index]![0]).toBe(msg)
}

/**
 * fake timers + 静音 console.warn 的标准装具（合批/重试路径测试用：fake timers 供
 * 退避推进，静音 warn 防预期的发送失败刷屏）。在 describe 体内调用一次即可；
 * afterEach 先 restoreAllMocks 再 useRealTimers（与 envelope-meta 套件同款收尾序）。
 */
export function setupFakeTimersSilencedWarn(): void {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
}

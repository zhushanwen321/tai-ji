/**
 * @zhushanwen/session-delivery 测试共享 mock 工厂。
 */
import { vi } from 'vitest'
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

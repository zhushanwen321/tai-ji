/**
 * @zhushanwen/session-delivery 测试共享 mock 工厂。
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type {
  DeliveryIntent,
  DeliveryMessage,
  DeliveryPort,
  DeliveryStore,
  DeliveryStoreRecord,
} from '../src/types.js'

export function makeMockPort(
  overrides?: Partial<DeliveryPort>,
): DeliveryPort & {
  sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[]
  idle: boolean
  supportedPayloads: readonly ('text' | 'custom')[]
} {
  const sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[] = []
  let idle = true
  const supportedPayloads: ('text' | 'custom')[] = ['text', 'custom']

  const port = {
    sendCalls,
    get idle() { return idle },
    set idle(v: boolean) { idle = v },
    get supportedPayloads() { return overrides?.supportedPayloads ?? supportedPayloads },
    isIdle: () => overrides?.isIdle?.() ?? idle,
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

// ─── v3 DeliveryStore 内存假实现（store 契约 / 判重三级 / onFailure 留账测试用）───

/**
 * DeliveryStore 内存假实现：undelivered（Map，待投差集）+ terminals（Set，终局
 * 记录）两视图 + 方法调用计数（判重三级顺序断言：一级命中时三级查询计数不增）。
 * persist 幂等覆盖：同 id 重 persist 覆盖原记录（重启重报形态）。
 */
export class MemoryDeliveryStore implements DeliveryStore {
  readonly undelivered = new Map<string, DeliveryStoreRecord>()
  readonly terminals = new Set<string>()
  /** 方法调用计数（时序 / 三级顺序断言用）。 */
  readonly calls = { persist: 0, ack: 0, discard: 0, loadUndelivered: 0, loadTerminalIds: 0, hasTerminal: 0 }
  /** persist 到达序（persist 先于投递尝试的时序断言用）。 */
  readonly persistOrder: string[] = []

  persist(record: DeliveryStoreRecord): void {
    this.calls.persist++
    this.persistOrder.push(record.id)
    this.undelivered.set(record.id, record)
  }

  ack(id: string): void {
    this.calls.ack++
    this.undelivered.delete(id)
    this.terminals.add(id)
  }

  discard(id: string): void {
    this.calls.discard++
    this.undelivered.delete(id)
  }

  loadUndelivered(): readonly DeliveryStoreRecord[] {
    this.calls.loadUndelivered++
    return [...this.undelivered.values()]
  }

  loadTerminalIds(): readonly string[] {
    this.calls.loadTerminalIds++
    return [...this.terminals]
  }

  hasTerminal(id: string): boolean {
    this.calls.hasTerminal++
    return this.terminals.has(id)
  }
}

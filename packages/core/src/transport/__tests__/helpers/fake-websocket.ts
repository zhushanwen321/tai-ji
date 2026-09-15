// createFakeWebSocket —— 可编程 WebSocketLike 测试替身（F3）。
//
// 用途：invariants 测试经 providePlatform 注入 webSocket.create → 返回本 fake，
// 测试通过 trigger* 手动驱动 ws-client 的状态机/退避逻辑，不依赖真实网络。
//
// 行为对齐原生 WebSocket：
// - triggerOpen：readyState → OPEN 后调 onopen
// - triggerClose：readyState → CLOSED 后调 onclose
// - triggerMessage：原样透传 data 给 onmessage
// - close()：置 CLOSED + 计数（不自动触发 onclose——由 ws-client 摘回调后调用，见 disconnect）
import type { WebSocketLike } from '../../../platform/port'
import { WS_READY_STATE } from '../../../platform/port'

export interface FakeWebSocket extends WebSocketLike {
  /** 手动触发 open（readyState→OPEN 后调 onopen） */
  triggerOpen(): void
  /** 手动触发 close（readyState→CLOSED 后调 onclose） */
  triggerClose(): void
  /** 手动触发 message（透传 data 给 onmessage） */
  triggerMessage(data: unknown): void
  /** 手动触发 error（透传 err 给 onerror） */
  triggerError(err?: unknown): void
  /** 直接设置 readyState（用于构造非法/中间态） */
  setReadyState(rs: number): void
  /** send 调用记录（断言发送内容） */
  readonly sent: string[]
  /** close() 调用次数 */
  closeCalls: number
}

export function createFakeWebSocket(): FakeWebSocket {
  let readyState: number = WS_READY_STATE.CONNECTING
  const sent: string[] = []
  let closeCalls = 0

  const fake: FakeWebSocket = {
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    get readyState() {
      return readyState
    },
    send(data: string): void {
      sent.push(data)
    },
    close(): void {
      closeCalls++
      readyState = WS_READY_STATE.CLOSED
    },
    triggerOpen(): void {
      readyState = WS_READY_STATE.OPEN
      fake.onopen?.()
    },
    triggerClose(): void {
      readyState = WS_READY_STATE.CLOSED
      fake.onclose?.()
    },
    triggerMessage(data: unknown): void {
      fake.onmessage?.({ data })
    },
    triggerError(err?: unknown): void {
      fake.onerror?.(err)
    },
    setReadyState(rs: number): void {
      readyState = rs
    },
    get sent() {
      return sent
    },
    get closeCalls() {
      return closeCalls
    },
  }
  return fake
}

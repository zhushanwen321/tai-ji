// MobilePlatformAdapter —— §9 PlatformPort 三端口实现（mobile 壳侧）。
//
// 实现 core P0 已导出的 PlatformPort 接口（kind/storage/webSocket 三字段），
// kind='mobile'。对接 core/src/platform/port.ts 的 providePlatform/getPlatform 注入点。
//
// pre-P0/P1 stub 形态：
//   - storage：内存 Map（进程重启丢），get 不存在 key 返回 null（对齐 core KVStorage 契约）
//   - webSocket：create(url) 返回不建立真实连接的 mock 对象（D2 远程 deferred）
//
// ipc 不在 PlatformPort（mobile 无 electron 主进程，桌面独占能力；electronAPI 实际
// 访问点在 renderer 壳 lib/ipc.ts）。
//
// TODO(P1): websocket 对接 core transport（P1 ws-client 迁入 core 后，mobile D2
// 远程连接落地时，create 返回真实 WebSocket 实例或远程代理）。
//
// 设计依据：renderer-package-topology.md §9、slice plan IF2。

import type { KVStorage, PlatformPort, WebSocketFactory, WebSocketLike } from '@xyz-agent/core'

// InMemoryStorage —— KVStorage 内存实现（get 不存在 key 返回 null，非抛错）。
// 对齐 core KVStorage 契约。进程生命周期内有效，重启丢失（mobile 壳无持久化需求
// 的场景用它；持久化属后续 D2 远程 + P0 PlatformPort storage 正式实现后）。
class InMemoryStorage implements KVStorage {
  private readonly map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

// createMockWebSocket —— 返回不建连的 WebSocketLike stub（D2 远程 deferred）。
// readyState=CLOSED(3)，send/close 为 noop，四回调为 null（调用方按需赋值）。
// 让 core ws-client 若调 webSocket.create(url) 不崩，但看到立即关闭态。
function createMockWebSocket(): WebSocketLike {
  return {
    readyState: 3, // CLOSED（WHATWG 对齐，core WS_READY_STATE.CLOSED）
    send: () => {
      // noop —— mock 不建连，send 丢弃
    },
    close: () => {
      // noop
    },
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  }
}

// MobileWebSocketFactory —— WebSocketFactory 的 mobile stub 实现。
class MobileWebSocketFactory implements WebSocketFactory {
  create(_url: string): WebSocketLike {
    // _url 前缀下划线：mock 不消费 url（D2 远程落地后才建连）
    return createMockWebSocket()
  }
}

// createMobilePlatformAdapter —— 构造 mobile 壳的 PlatformPort 实例。
// bootstrap 时调 providePlatform(createMobilePlatformAdapter()) 注入 core。
export function createMobilePlatformAdapter(): PlatformPort {
  return {
    kind: 'mobile',
    storage: new InMemoryStorage(),
    webSocket: new MobileWebSocketFactory(),
  }
}

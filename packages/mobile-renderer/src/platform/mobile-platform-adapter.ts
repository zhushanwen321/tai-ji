// MobilePlatformAdapter —— PlatformPort 三端口 mobile 实装（remote-use D10 真实化）。
//
// 实现 core P0 已导出的 PlatformPort 接口（kind/storage/webSocket 三字段），kind='mobile'。
// 对接 core/src/platform/port.ts 的 providePlatform/getPlatform 注入点。
//
// real 实装（替换 pre-P0 stub）：
//   - storage：localStorage 桥接（KVStorage 异步签名按契约保持——localStorage 为同步 API，
//     以 Promise 包装；持久化支撑 D4「remote token 验身后落盘」= G3 免重扫的物理载体）
//   - webSocket：原生 WebSocket 包装为 WebSocketLike（core ws-client 经 platform 端口建连，
//     A8。原生实例的回调字段签名带事件对象（onmessage 收 MessageEvent 等），与 WebSocketLike
//     的无参 / 纯 data 形态不结构兼容，故经适配壳中转：ws-client 的回调赋值落在壳字段，
//     由壳转接到原生实例——两侧签名差异在此单点吸收）
//
// ipc 不在 PlatformPort（mobile 无 electron 主进程，桌面独占能力；electronAPI 实际
// 访问点在 renderer 壳 lib/ipc.ts）。
//
// 设计依据：renderer-package-topology.md §9（移动壳拓扑与平台端口契约）、远程访问连接派生 D4（profile 三分支）/移动壳真实化 D10（adapter 真实化）。

import type { KVStorage, PlatformPort, WebSocketFactory, WebSocketLike } from '@taiji/core'

// LocalStorageKV —— KVStorage 的 localStorage 桥接实现。
// KVStorage 契约为异步签名（Promise 返回），localStorage 为同步 API——按契约包 Promise。
// get 不存在 key 返回 null（localStorage.getItem 天然语义，非抛错）。
// set/remove 写失败降级（console.warn、不 reject）：Safari 隐私模式等环境 setItem 抛
// QuotaExceededError，直抛会沿调用链炸 token 落盘处置（handleAuthSuccess 经 connection-view
// void 调用 = unhandled rejection）。降级后的凭据语义：本次会话内存可用（连接凭据已在
// use-connection 模块态持有，WS 重连复用不回读 storage），刷新后落 token 输入视图
// （storage 缺失 → resolve 三分支 need-input → runtime 拒绝 → token 输入视图，connection-profile D4）。
class LocalStorageKV implements KVStorage {
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(key)
  }

  async set(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value)
    } catch (e) {
      // 降级策略（best-effort 持久化）：写失败不向上传播——Safari 隐私模式 setItem 抛
      // QuotaExceededError，直抛会沿调用链炸 token 落盘处置（降级后凭据语义见类注释）。
      console.warn(`[mobile-platform] localStorage.setItem failed (key=${key}), persist skipped:`, e)
    }
  }

  async remove(key: string): Promise<void> {
    try {
      localStorage.removeItem(key)
    } catch (e) {
      // 降级策略（best-effort 持久化）：清除失败不向上传播（与 set 同一面；残留键下次
      // 验身失败路径会重试清除），warn 留排障依据。
      console.warn(`[mobile-platform] localStorage.removeItem failed (key=${key}):`, e)
    }
  }
}

// NativeWebSocketAdapter —— 原生 WebSocket 的 WebSocketLike 适配壳。
// 回调经自有字段中转（壳侧无参 / 纯 data 形态 → 原生实例的事件对象形态）；readyState 直读
// 原生实例（WHATWG 数字常量，core WS_READY_STATE 对齐）。
class NativeWebSocketAdapter implements WebSocketLike {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((err: unknown) => void) | null = null

  private readonly native: WebSocket

  constructor(url: string) {
    this.native = new WebSocket(url)
    this.native.onopen = () => this.onopen?.()
    this.native.onclose = () => this.onclose?.()
    this.native.onmessage = (ev: MessageEvent) => this.onmessage?.({ data: ev.data })
    this.native.onerror = (ev: Event) => this.onerror?.(ev)
  }

  get readyState(): number {
    return this.native.readyState
  }

  send(data: string): void {
    this.native.send(data)
  }

  close(): void {
    this.native.close()
  }
}

// MobileWebSocketFactory —— WebSocketFactory 的原生实装（浏览器全局 WebSocket）。
class MobileWebSocketFactory implements WebSocketFactory {
  create(url: string): WebSocketLike {
    return new NativeWebSocketAdapter(url)
  }
}

// createMobilePlatformAdapter —— 构造 mobile 壳的 PlatformPort 实例。
// bootstrap 时调 providePlatform(createMobilePlatformAdapter()) 注入 core。
export function createMobilePlatformAdapter(): PlatformPort {
  return {
    kind: 'mobile',
    storage: new LocalStorageKV(),
    webSocket: new MobileWebSocketFactory(),
  }
}

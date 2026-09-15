/**
 * useConnection 装配点回归测试（§10.2 D-1 迁移）。
 *
 * 逻辑测试已随迁移移入 core（core/src/transport/__tests__/use-connection-*.test.ts，
 * 经注入端口断言）。本测试锁定 renderer 装配层独有的真实链路：
 *
 * 1. 装配点模块加载即 setConnectionPorts 注入（不显式注入也能连——防「忘了注入」回归）
 * 2. visibility 端口实现（真实 DOM：document.visibilityState + visibilitychange 监听）——
 *    这是 core 无法测试的壳层 DOM 胶水，W4 重连行为依赖它
 * 3. env 端口（VITE_MOCK → isMock 真值链路：mock 模式 connect mock://）
 *
 * mock 策略：不 mock ws-client（避免 vitest 相对路径 mock 与 alias 解析的不一致），
 * 改经 providePlatform 注入 fake webSocket factory（对齐 core ws-client.invariants
 * 测试范式）——走真实 core ws-client + core use-connection + 装配点端口的全链路。
 * VITE_MOCK=true（vitest 配置默认）→ 装配点 env.isMock=true → init 走 mock 分支。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useConnection-assembly.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  providePlatform,
  disconnect,
  WS_READY_STATE,
  type WebSocketLike,
} from '@taiji/core'

const mockHolder = vi.hoisted(() => ({
  createCalls: [] as string[],
}))

/** fake webSocket factory：登记 create 调用 + 同步模拟连接成功（onopen 微任务触发） */
function installTestPlatform(): void {
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: (url: string) => {
        mockHolder.createCalls.push(url)
        const socket: WebSocketLike = {
          readyState: WS_READY_STATE.OPEN,
          send: () => {},
          close: () => {},
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null,
        }
        // ws-client create 返回后才赋 onopen（connect 内赋值），微任务触发模拟连接成功
        queueMicrotask(() => socket.onopen?.())
        return socket
      },
    },
    ipc: null,
  })
}

// 装配点模块加载即执行 setConnectionPorts（不显式注入——测试依赖真实注入链）
import { useConnection } from '@/composables/useConnection'

describe('useConnection 装配点（§10.2 D-1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHolder.createCalls = []
    installTestPlatform()
    // happy-dom 默认 visible；显式设置保证断言环境一致
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    // 清模块级单例（listener/watch/initialised），避免跨用例泄漏
    teardownConnection()
  })

  function teardownConnection(): void {
    try {
      const { teardown } = useConnection()
      teardown()
    } catch {
      // teardown 幂等，失败忽略
    }
  }

  it('模块加载即完成端口注入：init 走真实链路建立连接（mock 模式 connect mock://）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(mockHolder.createCalls).toContain('mock://localhost')
    teardown()
  })

  it('visibility 端口接真实 DOM：切回可见（visible）且未连接 → 主动重连', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 模拟标签页后台时连接掉了（真实 ws-client disconnect → state=disconnected）
    disconnect()
    mockHolder.createCalls = []

    // 真实 DOM 事件 → 装配点 visibility 端口 → core 重连守卫放行 → connect
    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockHolder.createCalls.length).toBeGreaterThan(0)
    teardown()
  })

  it('visibility 端口接真实 DOM：已 connected 时切回前台 → 不重连', async () => {
    const { init, teardown } = useConnection()
    await init()
    // fake socket 已同步 onopen → state=connected

    mockHolder.createCalls = []

    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockHolder.createCalls).toHaveLength(0)
    teardown()
  })

  it('teardown 卸载 visibility 监听：卸载后 visibilitychange 不再触发重连', async () => {
    const { init, teardown } = useConnection()
    await init()

    disconnect()
    mockHolder.createCalls = []
    teardown()

    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockHolder.createCalls).toHaveLength(0)
  })
})

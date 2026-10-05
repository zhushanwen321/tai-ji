// connected 边沿当前会话对账接线（remote-use U9 / A6）。
//
// 锁定壳层接线这一件事：App.vue 的 isConnected 翻 true 时，对当前活跃会话经
// useSession 实例方法出口（app-runtime.refreshHistory）触发重连对账。设计明示该形态
// 真机层无独立可观测锚点（对账执行与否不产生可区分 UI 呈现，V9 证明力边界声明），
// 防线必须落在本接线单测——漏接形态（watch 未调出口）下 V9 真机会因「更早轮次无人
// 触碰」假通过。
//
// 对账编排本体（窗口归一 + 图片落盘随行 + 未 hydrate no-op + 失败静默）在
// core use-session-refresh-history.test.ts 覆盖（真实 chat store 终端效果断言）；
// 本文件只锁接线：mock app-runtime 出口 spy，App.vue 全真实挂载。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from '../App.vue'
import { i18n } from '../i18n'
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'
import { activeSessionId, sessionStore } from '../shell/app-runtime'

const { mockLoadSessions, mockRefreshHistory } = vi.hoisted(() => ({
  mockLoadSessions: vi.fn().mockResolvedValue(undefined),
  mockRefreshHistory: vi.fn().mockResolvedValue(undefined),
}))

// 仅替换对账/列表拉取两个出口（断言目标 + 无连接环境下消除真实 RPC 尝试），
// 其余导出（activeSessionId/sessionStore/useChatInstance 等）保持真实实例——
// App.vue 消费的响应式源与生产同源，防「mock 掉响应式源导致 watch 不触发」的假断言
vi.mock('../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/app-runtime')>()
  return { ...actual, loadSessions: mockLoadSessions, refreshHistory: mockRefreshHistory }
})

function mountApp() {
  return mount(App, { global: { plugins: [i18n] } })
}

describe('connected 边沿当前会话对账（U9/A6 接线）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    mockLoadSessions.mockClear()
    mockRefreshHistory.mockClear()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = true
    activeSessionId.value = null
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = true
    activeSessionId.value = null
    sessionStore.setActiveId(null)
  })

  it('isConnected 翻 true：refreshHistory 经出口以当前活跃会话调用（接线主体——漏接即 V9 假通过）', async () => {
    sessionStore.setActiveId('u9-rc-sid')
    wrapper = mountApp()
    expect(mockRefreshHistory).not.toHaveBeenCalled()

    shellConnectionState.value = 'connected'
    await nextTick()

    expect(mockRefreshHistory).toHaveBeenCalledTimes(1)
    expect(mockRefreshHistory).toHaveBeenCalledWith('u9-rc-sid')
    // 列表拉取同边沿照常（既有行为不回归）
    expect(mockLoadSessions).toHaveBeenCalledTimes(1)
  })

  it('断连再重连（reconnecting → connected 边沿）：对账再次执行（V9 重连对账时序）', async () => {
    sessionStore.setActiveId('u9-rc-sid')
    wrapper = mountApp()

    shellConnectionState.value = 'connected'
    await nextTick()
    expect(mockRefreshHistory).toHaveBeenCalledTimes(1)

    // 瞬时断连落 'connecting'（connection-view watch：非 connected/failed/token-input 一律
    // connecting，BM5 布局保持），恢复后边沿再次触发对账
    shellConnectionState.value = 'connecting'
    await nextTick()
    shellConnectionState.value = 'connected'
    await nextTick()

    expect(mockRefreshHistory).toHaveBeenCalledTimes(2)
    expect(mockRefreshHistory).toHaveBeenLastCalledWith('u9-rc-sid')
  })

  it('无活跃会话翻 connected：refreshHistory 不被调（出口以活跃会话为参，壳层空值守卫）', async () => {
    wrapper = mountApp()

    shellConnectionState.value = 'connected'
    await nextTick()

    expect(mockLoadSessions).toHaveBeenCalledTimes(1)
    expect(mockRefreshHistory).not.toHaveBeenCalled()
  })

  it('非边沿（connected 持续）：不重复对账（watch 边沿语义，非轮询）', async () => {
    sessionStore.setActiveId('u9-rc-sid')
    wrapper = mountApp()

    shellConnectionState.value = 'connected'
    await nextTick()
    await nextTick()
    await nextTick()

    expect(mockRefreshHistory).toHaveBeenCalledTimes(1)
  })
})

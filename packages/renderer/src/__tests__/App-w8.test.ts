/**
 * W8: App.vue 连接建立时调 useSidebar.onConnected（统一入口）。
 *
 * 背景：workspaceStore.load() 只在 initApp 调一次，appBootstrapped 守卫阻止重连后重跑 initApp。
 * WS 断连重连后（runtime 可能重启重载磁盘新记录，或另一窗口写入），前端 records 停留 stale。
 *
 * 修复：onConnected 在 useSidebar 内用模块级 hasConnectedBefore 区分首次 vs 重连（见 useSidebar
 * 单测验证该逻辑）。App.vue 只负责 watch connectionState 并调 onConnected——本测试钉住这层调用契约。
 *
 * Mock 策略：vi.mock useConnection（返回可控 state ref），vi.mock useSidebar（捕获 onConnected 调用），
 * vi.mock AppShell/ToastContainer（避免渲染依赖树）。
 *
 * 运行：npx vitest run src/__tests__/App-w8.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

// 可控的 connectionState（外部修改触发 App.vue 的 watch）
const connectionState = ref<'disconnected' | 'connected'>('disconnected')

const mocks = vi.hoisted(() => ({
  onConnected: vi.fn(async () => {}),
  init: vi.fn(async () => {}),
  teardown: vi.fn(),
  retryRuntime: vi.fn(async () => {}),
}))

vi.mock('@/composables/useConnection', () => ({
  useConnection: () => ({
    state: connectionState,
    init: mocks.init,
    teardown: mocks.teardown,
    retryRuntime: mocks.retryRuntime,
  }),
}))

vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ onConnected: mocks.onConnected }),
}))

// stub 掉重组件，避免渲染 AppShell/ToastContainer 的依赖树
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))

// 捕获全局 effect 注册 spy（W2：断言 App setup 顶层调用了 bindForkNoticeEffect/bindHandoffEffect/bindSessionStreamSync）。
// vi.hoisted 保证在 vi.mock 工厂执行前就绪（mock 工厂引用闭包内的 spy）。
const effectSpies = vi.hoisted(() => ({
  bindForkNoticeEffect: vi.fn(),
  bindHandoffEffect: vi.fn(),
  bindSessionStreamSync: vi.fn(),
  installInboundFrameGuard: vi.fn(),
  uninstallInboundFrameGuard: vi.fn(),
}))
// stub fork-notice 全局效果（App setup 调用，依赖 pinia/session store）；spy 捕获调用次数
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({
  bindForkNoticeEffect: (...args: unknown[]) => {
    effectSpies.bindForkNoticeEffect(...args)
  },
}))
// stub handoff 全局效果（App setup 调用，同 fork-notice 依赖 pinia/session store）；spy 捕获调用次数
vi.mock('@/composables/effects/useHandoffEffect', () => ({
  bindHandoffEffect: (...args: unknown[]) => {
    effectSpies.bindHandoffEffect(...args)
  },
}))
// stub session-stream-sync 全局效果（App setup 调用，同 fork-notice/handoff 依赖 pinia/session store）；spy 捕获调用次数
vi.mock('@/composables/effects/useSessionStreamSync', () => ({
  bindSessionStreamSync: (...args: unknown[]) => {
    effectSpies.bindSessionStreamSync(...args)
  },
}))

// stub 入站守卫装配（u-init P0 接线：App setup 顶层 install + onBeforeUnmount uninstall）。
// 真实 composable 依赖 active pinia（usePanelStore），本文件不装 pinia——stub 保用例隔离，
// 接线契约由 spy 断言（真实链路见 Panel.inbound-frame-notice.test.ts）。
vi.mock('@/composables/useInboundFrameGuard', () => ({
  installInboundFrameGuard: (...args: unknown[]) => {
    effectSpies.installInboundFrameGuard(...args)
  },
  uninstallInboundFrameGuard: (...args: unknown[]) => {
    effectSpies.uninstallInboundFrameGuard(...args)
  },
}))

import { mount } from '@vue/test-utils'
import App from '@/App.vue'

describe('W8: App.vue 连接建立调 onConnected', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    connectionState.value = 'disconnected'
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('connected → onConnected 被调用 1 次', async () => {
    wrapper = mount(App)
    // [W2] App setup 顶层注册了全局 effect（fork-notice + handoff + session-stream-sync），各调用 1 次。
    // mount 触发 setup，断言对称（三个 bind effect 都已挂载，与 bindForkNoticeEffect 范式一致）。
    expect(effectSpies.bindForkNoticeEffect).toHaveBeenCalledTimes(1)
    expect(effectSpies.bindHandoffEffect).toHaveBeenCalledTimes(1)
    expect(effectSpies.bindSessionStreamSync).toHaveBeenCalledTimes(1)
    // u-init P0 接线：入站帧守卫在 App setup 顶层安装（同区装配），否则 core 丢帧回调
    // 无人消费、终止阀提示永不出现（接线缺失 = 生产链路零调用）
    expect(effectSpies.installInboundFrameGuard).toHaveBeenCalledTimes(1)
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.onConnected).toHaveBeenCalledTimes(1)
  })

  it('u-init: App 卸载解绑入站帧守卫（install/uninstall 配对，HMR 重挂不残留）', () => {
    wrapper = mount(App)
    expect(effectSpies.uninstallInboundFrameGuard).not.toHaveBeenCalled()
    wrapper.unmount()
    wrapper = null
    expect(effectSpies.uninstallInboundFrameGuard).toHaveBeenCalledTimes(1)
  })

  it('断连→重连 connected → onConnected 再次被调用（刷新由 onConnected 内部判断）', async () => {
    wrapper = mount(App)
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    connectionState.value = 'disconnected'
    await new Promise((r) => setTimeout(r, 0))
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    // onConnected 被调两次（首次 + 重连），内部逻辑区分由 useSidebar 单测验证
    expect(mocks.onConnected).toHaveBeenCalledTimes(2)
  })

  it('非 connected 状态不触发 onConnected', async () => {
    wrapper = mount(App)
    connectionState.value = 'disconnected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.onConnected).not.toHaveBeenCalled()
  })
})

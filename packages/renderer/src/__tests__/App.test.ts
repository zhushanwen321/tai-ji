/**
 * App.vue 组件壳单测合并文件（round6 测试提速，同被测对象簇）。
 *
 * 本文件由以下两文件原样搬运合并（describe/it 名零改动，mock 脚手架两源同款去重共享）：
 * - src/__tests__/App-w8.test.ts（连接建立调 useSidebar.onConnected + 全局 effect 接线。
 *   W8 语义（承恢复前工作区注释的最新口径）：onConnected 在 useSidebar 内收敛为启动编排
 *   触发壳（首连 initApp；connection-datasync-ssot §6.4 起重连数据刷新由 core 域同步器
 *   边沿承载）。App.vue 只负责 watch connectionState 并调 onConnected——钉住这层调用契约）
 * - src/__tests__/App-runtime-start-error.test.ts（RD-3#2 runtime 启动失败真因可见性 +
 *   内存压力提示条 surface 注册）
 *
 * 合并说明：
 * - 两源 mock 面同款（useConnection/useSidebar/AppShell/ToastContainer/effects/
 *   useInboundFrameGuard/usePermissionRequest），runtime-start-error 另有 '@/lib/ipc'
 *   importOriginal 保留式覆写（仅三个捕获点）——W8 节不进入 failed 态、不消费被覆写
 *   导出，合并后行为不变（实测绿灯）。
 * - connectionState 取两源类型超集（disconnected/connected/failed）。
 * - usePermissionRequest mock 取 runtime 源版本（含 initPermissionRequest 导出，超集）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/App.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { dispatchGlobal } from '@taiji/core/transport/api'
import {
  isModalSurfaceOpen,
  openShieldingSurfaces,
  resetModalSurfaceRegistry,
} from '@/composables/features/app/modal-surface-registry'
import { _resetMemoryPressureForTest } from '@/composables/useMemoryPressure'

// 可控的 connectionState（App.vue 的 watch / 分支渲染数据源；外部修改触发 watch）
const connectionState = ref<'disconnected' | 'connected' | 'failed'>('failed')

const mocks = vi.hoisted(() => ({
  onConnected: vi.fn(async () => {}),
  init: vi.fn(async () => {}),
  teardown: vi.fn(),
  retryRuntime: vi.fn(async () => {}),
}))

// RD-3#2 IPC 捕获点（vi.mock 工厂引用闭包，vi.hoisted 保证先于工厂执行就绪）
const ipcHolder = vi.hoisted(() => {
  return {
    runtimeErrorCb: null as ((err: { message: string }) => void) | null,
    unsubscribe: vi.fn(() => {}),
    pullResolve: null as ((v: string | null) => void) | null,
    reportRendererLog: vi.fn(() => Promise.resolve()),
  }
})

// 仅覆写三个捕获点，其余导出保留真实实现（无 electronAPI 环境 = 无 IPC 降级，安全）
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return {
    ...actual,
    onRuntimeError: (cb: (err: { message: string }) => void) => {
      ipcHolder.runtimeErrorCb = cb
      return ipcHolder.unsubscribe
    },
    getRuntimeStartError: () =>
      new Promise<string | null>((resolve) => {
        ipcHolder.pullResolve = resolve
      }),
    reportRendererLog: ipcHolder.reportRendererLog,
  }
})

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

// stub 掉重组件与依赖 pinia/session store 的全局 effect（保用例隔离）
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))

// App.vue setup 调 usePermissionRequest()（permission 全局弹窗状态）——真实实现要求
// main.ts 先 initPermissionRequest（controller 模块级，测试环境无 init）→ 直接 throw。
// mock 最小 state（对齐 App.vue 消费方 pluginId/permissions/pending/error），init no-op。
vi.mock('@/composables/shell/usePermissionRequest', () => ({
  usePermissionRequest: () => ({ pluginId: '', permissions: [], pending: false, error: null }),
  initPermissionRequest: vi.fn(),
}))

const effectSpies = vi.hoisted(() => ({
  bindForkNoticeEffect: vi.fn(),
  bindHandoffEffect: vi.fn(),
  bindSessionStreamSync: vi.fn(),
  installInboundFrameGuard: vi.fn(),
  uninstallInboundFrameGuard: vi.fn(),
}))
// stub fork-notice / handoff / session-stream-sync 全局效果（App setup 调用，依赖
// pinia/session store）；spy 捕获调用次数（W2 对称断言）。
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({
  bindForkNoticeEffect: (...args: unknown[]) => {
    effectSpies.bindForkNoticeEffect(...args)
  },
}))
vi.mock('@/composables/effects/useHandoffEffect', () => ({
  bindHandoffEffect: (...args: unknown[]) => {
    effectSpies.bindHandoffEffect(...args)
  },
}))
vi.mock('@/composables/effects/useSessionStreamSync', () => ({
  bindSessionStreamSync: (...args: unknown[]) => {
    effectSpies.bindSessionStreamSync(...args)
  },
}))
// stub 入站检查装配（u-init P0 接线：App setup 顶层 install + onBeforeUnmount uninstall）。
// 真实 composable 依赖 active pinia（usePanelStore），stub 保用例隔离，接线契约由 spy 断言。
vi.mock('@/composables/useInboundFrameGuard', () => ({
  installInboundFrameGuard: (...args: unknown[]) => {
    effectSpies.installInboundFrameGuard(...args)
  },
  uninstallInboundFrameGuard: (...args: unknown[]) => {
    effectSpies.uninstallInboundFrameGuard(...args)
  },
}))

import { mount, type VueWrapper } from '@vue/test-utils'
import App from '@/App.vue'

/** 通用 failed 兜底文案（i18n 全局 setup 从 zh-CN locale 取词） */
const GENERIC_FAILED_TEXT = 'runtime 不可用，重试多次仍失败'

function mountFailedScreen(): VueWrapper {
  connectionState.value = 'failed'
  return mount(App)
}

function pushRuntimeError(message: string): void {
  expect(ipcHolder.runtimeErrorCb).not.toBeNull()
  ipcHolder.runtimeErrorCb!({ message })
}

// ══════════════ 源: src/__tests__/App-w8.test.ts ══════════════

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
    // u-init P0 接线：入站帧检查在 App setup 顶层安装（同区装配），否则 core 丢帧回调
    // 无人消费、终止阀提示永不出现（接线缺失 = 生产链路零调用）
    expect(effectSpies.installInboundFrameGuard).toHaveBeenCalledTimes(1)
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.onConnected).toHaveBeenCalledTimes(1)
  })

  it('u-init: App 卸载解绑入站帧检查（install/uninstall 配对，HMR 重挂不残留）', () => {
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

// ══════════════ 源: src/__tests__/App-runtime-start-error.test.ts ══════════════

describe('RD-3#2：连接屏显示 runtime 启动失败真因', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ipcHolder.runtimeErrorCb = null
    ipcHolder.pullResolve = null
    connectionState.value = 'failed'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('无事件（推送未到、拉取 null）→ failed 屏只有通用兜底文案，无真因行', async () => {
    wrapper = mountFailedScreen()
    await flushPromises()
    // 拉取兜底返回 null（无已知失败）
    ipcHolder.pullResolve!(null)
    await flushPromises()

    expect(wrapper.text()).toContain(GENERIC_FAILED_TEXT)
    expect(wrapper.find('[data-testid="runtime-error-cause"]').exists()).toBe(false)
  })

  it('推送到达 → failed 屏渲染真实 message（通用文案保留），并写入登记清单（source=runtime-start-failed）', async () => {
    wrapper = mountFailedScreen()
    // 拉取兜底保持 pending（模拟推送先于拉取返回的场景不成立时的自然挂起）
    pushRuntimeError('Runtime binary not found: taiji-runtime')
    await flushPromises()

    const cause = wrapper.find('[data-testid="runtime-error-cause"]')
    expect(cause.exists()).toBe(true)
    // 用户可见 DOM 断言：真实 message 原文 + i18n 前缀（zh-CN「原因：」）
    expect(cause.text()).toContain('Runtime binary not found: taiji-runtime')
    expect(cause.text()).toContain('原因：')
    // 通用兜底文案保留（真因是补充显示，不替换）
    expect(wrapper.text()).toContain(GENERIC_FAILED_TEXT)
    // 登记清单：经 error-reporter → renderer-log 通道上报
    expect(ipcHolder.reportRendererLog).toHaveBeenCalledTimes(1)
    expect(ipcHolder.reportRendererLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'runtime-start-failed',
        message: 'Runtime binary not found: taiji-runtime',
      }),
    )
  })

  it('拉取兜底（推送早于订阅安装已丢的 boot 竞态）→ failed 屏同样渲染真因 + 写入登记清单', async () => {
    wrapper = mountFailedScreen()
    ipcHolder.pullResolve!('EADDRINUSE: port 3310 already occupied')
    await flushPromises()

    const cause = wrapper.find('[data-testid="runtime-error-cause"]')
    expect(cause.exists()).toBe(true)
    expect(cause.text()).toContain('EADDRINUSE: port 3310 already occupied')
    expect(ipcHolder.reportRendererLog).toHaveBeenCalledTimes(1)
    expect(ipcHolder.reportRendererLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'runtime-start-failed',
        message: 'EADDRINUSE: port 3310 already occupied',
      }),
    )
  })

  it('同因去重：推送与拉取兜底先后到达同一 message → 登记清单只上报一次', async () => {
    wrapper = mountFailedScreen()
    pushRuntimeError('spawn ENOENT')
    await flushPromises()
    ipcHolder.pullResolve!('spawn ENOENT')
    await flushPromises()

    expect(ipcHolder.reportRendererLog).toHaveBeenCalledTimes(1)
  })

  it('App 卸载退订 onRuntimeError（与 setup 安装配对，HMR/测试重挂不残留）', async () => {
    wrapper = mountFailedScreen()
    expect(ipcHolder.runtimeErrorCb).not.toBeNull()
    expect(ipcHolder.unsubscribe).not.toHaveBeenCalled()

    wrapper.unmount()
    wrapper = null
    expect(ipcHolder.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('connected 即清真因：connected → 再次 failed 后不再显示陈旧原因', async () => {
    wrapper = mountFailedScreen()
    pushRuntimeError('stale cause')
    await flushPromises()
    expect(wrapper.find('[data-testid="runtime-error-cause"]').exists()).toBe(true)

    // 重试成功连上 → connected 清真因
    connectionState.value = 'connected'
    await flushPromises()
    // 再次进入 failed（如后续崩溃重启用尽）→ 陈旧真因不再显示，通用兜底仍在
    connectionState.value = 'failed'
    await flushPromises()

    expect(wrapper.find('[data-testid="runtime-error-cause"]').exists()).toBe(false)
    expect(wrapper.text()).toContain(GENERIC_FAILED_TEXT)
  })
})

describe('内存压力提示条 surface 注册（§6.7 view 遮蔽族，App.vue 内联块的注册读点）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ipcHolder.runtimeErrorCb = null
    ipcHolder.pullResolve = null
    connectionState.value = 'failed'
    resetModalSurfaceRegistry()
    _resetMemoryPressureForTest()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    _resetMemoryPressureForTest()
  })

  function mountApp(): VueWrapper {
    connectionState.value = 'failed'
    return mount(App)
  }

  const WARN_PAYLOAD = {
    level: 'warn' as const,
    heapUsed: 8,
    heapSizeLimit: 10,
    usedPercent: 80,
    warnPercent: 70,
    criticalPercent: 85,
  }

  it('挂载即注册（关态在册）：level normal → isOpen=false，不入 view 遮蔽报告', async () => {
    wrapper = mountApp()
    await flushPromises()
    ipcHolder.pullResolve!(null)
    await flushPromises()

    expect(isModalSurfaceOpen('memory-pressure-bar'), '常驻挂载即注册，读点直读 level 状态本体').toBe(false)
    expect(openShieldingSurfaces()).toEqual([])
  })

  it('warn 广播 → isOpen 翻转：条渲染前 rect 读点 null（不带 rect 上报），渲染后 rect 实测成键', async () => {
    wrapper = mountApp()
    await flushPromises()
    ipcHolder.pullResolve!(null)
    await flushPromises()

    dispatchGlobal({ type: 'watchdog:memoryPressure', payload: WARN_PAYLOAD })
    const before = openShieldingSurfaces()
    expect(before, 'isOpen 状态本体直读（不依赖 DOM 渲染时机）').toEqual([
      { id: 'memory-pressure-bar', mode: 'intersecting' },
    ])

    await nextTick()
    expect(wrapper.find('[data-testid="memory-pressure-bar"]').exists()).toBe(true)
    const after = openShieldingSurfaces()
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe('memory-pressure-bar')
    expect(after[0]!.rect, 'rect 读提示条根元素实测').toBeDefined()
  })
})

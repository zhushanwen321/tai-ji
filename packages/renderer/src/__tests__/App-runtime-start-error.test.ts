/**
 * RD-3#2：runtime 启动失败真因可见性（连接屏 DOM 断言）。
 *
 * 背景：main supervisor startAndNotify 失败（binary 缺失/端口占用等）发 runtime-error
 * { message } 推送，此前全仓零消费——启动失败真因永不可见，用户只能在 ~60s 后看到通用
 * failed 文案。修复后 App.vue（failed 屏所在组件）订阅 onRuntimeError + 拉取兜底：
 * - 推送/拉取到达 → failed 屏渲染真实 message（通用 failed 文案保留为兜底）；
 * - 真因经 error-reporter（renderer-log 通道，source='runtime-start-failed'）落台账；
 * - 同因去重（推送与拉取兜底双通道不重复上报）；
 * - 无事件 → 只显示既有通用 failed（回归锚）；
 * - App 卸载退订（与 setup 安装配对）；
 * - connected 即清（陈旧真因不再出现在后续 failed 屏）。
 *
 * 状态转移（置 failed 短路徒劳重连）在 core use-connection，由 core
 * __tests__/use-connection-runtime-start-error.test.ts 覆盖。
 *
 * Mock 策略：App-w8 同款组件桩 + '@/lib/ipc' importOriginal 保留真实导出（无 electronAPI
 * 测试环境下其余导出走无 IPC 降级路径），仅覆写 onRuntimeError / getRuntimeStartError /
 * reportRendererLog 三个捕获点。i18n t() 由全局 setup 提供（zh-CN 取词）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/App-runtime-start-error.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'

// 可控的 connectionState（App.vue 的 watch / 分支渲染数据源）
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

// stub 掉重组件与依赖 pinia/session store 的全局 effect（App-w8 同款，保用例隔离）
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))

const effectSpies = vi.hoisted(() => ({
  bindForkNoticeEffect: vi.fn(),
  bindHandoffEffect: vi.fn(),
  bindSessionStreamSync: vi.fn(),
  installInboundFrameGuard: vi.fn(),
  uninstallInboundFrameGuard: vi.fn(),
}))
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

  it('推送到达 → failed 屏渲染真实 message（通用文案保留），并落台账（source=runtime-start-failed）', async () => {
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
    // 台账：经 error-reporter → renderer-log 通道上报
    expect(ipcHolder.reportRendererLog).toHaveBeenCalledTimes(1)
    expect(ipcHolder.reportRendererLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'runtime-start-failed',
        message: 'Runtime binary not found: taiji-runtime',
      }),
    )
  })

  it('拉取兜底（推送早于订阅安装已丢的 boot 竞态）→ failed 屏同样渲染真因 + 落台账', async () => {
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

  it('同因去重：推送与拉取兜底先后到达同一 message → 台账只上报一次', async () => {
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

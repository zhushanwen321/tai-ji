/**
 * UpdateCheckCard / UpdatePage / UpdateButton 测试共享的 update controller 装配单源。
 *
 * 组件测试统一消费真实控制器：createAppUpdateController({ ipc: createMemoryAppUpdateIpc() })
 * （同 composables/useAppUpdate*.test.ts 形态）：state 恒为 UpdateAppState 全 6 字段真形状，
 * 动作断言走内存 adapter 的 vi.fn，state 摆置用 Object.assign 直改 controller.state
 * （B1：全部 state 断言对象必须是真实控制器产出的 state）。
 *
 * 注入方式（六个组件测试文件同构）：
 *   vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())
 * 工厂经 vi.importActual 保留真实模块导出，只重写 useAppUpdate 单例入口返回 harness
 * 控制器的消费面。注意本 helper 禁止顶层 import 被 mock 的路径：vi.mock 工厂在测试文件的
 * helper import 绑定初始化前就会因该 import 被触发（TDZ），故 controller 的创建收进 async
 * 工厂内（vi.importActual 取真实 createAppUpdateController，此时尚在模块 setup 阶段，早于
 * 任何 beforeEach，resetCardUpdateHarness 前必然就绪）。
 *
 * vitest 按测试文件隔离模块图：harness 在每个测试文件内是独立单例（beforeEach 经
 * resetCardUpdateHarness 复位，与原 vi.hoisted 文件内单例语义一致）。
 */
import { vi } from 'vitest'
import type { LatestReleaseInfo } from '@taiji/shared'
import type { AppUpdateControllerInternal } from '@/composables/features/settings/useAppUpdate'
import type { UpdateAppState } from '@/composables/features/settings/use-app-update-state'
import { createMemoryAppUpdateIpc } from './update-ipc-mock'
import type { MemoryAppUpdateIpc } from './update-ipc-mock'

/** 内存 ipc + 真实 controller 的文件级装配（state 摆置与 ipc 断言统一经此取用） */
export interface CardUpdateHarness {
  ipc: MemoryAppUpdateIpc
  controller: AppUpdateControllerInternal
}

let harness: CardUpdateHarness | null = null

/** 取本测试文件的 controller 装配（由 useAppUpdateCardModule 工厂创建，见模块头注释时序说明） */
export function getCardUpdateHarness(): CardUpdateHarness {
  if (!harness) {
    throw new Error(
      'update-card-mock: harness not initialized — vi.mock(\'@/composables/features/settings/useAppUpdate\', () => useAppUpdateCardModule()) must run first (module setup phase).',
    )
  }
  return harness
}

/** UpdateAppState 缺省态（全 6 字段，含 errorSuggestion） */
const IDLE_STATE: UpdateAppState = {
  state: 'idle',
  latestRelease: null,
  errorMessage: '',
  errorSuggestion: '',
  percent: 0,
  releaseNotesHtml: '',
}

/** 构造测试用 LatestReleaseInfo（真实契约 shape，composables/useAppUpdate.test.ts 同款） */
export function makeCardRelease(version: string): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://example.com/release',
    assets: {},
  }
}

/**
 * 复位 harness：state 归 idle 缺省 + ipc vi.fn 清调用记录并重设默认 resolve 值
 * （各用例按需 mockResolvedValue 覆盖）。controller.flags（errorHandled/pendingRestored）
 * 不复位：组件测试不经 fireError/restore 链置位它们，且 AppUpdateController 不暴露
 * container——需要操纵 flags 的用例走 composables 侧 per-beforeEach 新建控制器形态。
 */
export function resetCardUpdateHarness(): void {
  const { ipc, controller } = getCardUpdateHarness()
  Object.assign(controller.state, IDLE_STATE)
  ipc.checkForUpdate.mockReset()
  ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
  ipc.updateDownload.mockReset()
  ipc.updateDownload.mockResolvedValue({ downloaded: true })
  ipc.updateInstall.mockReset()
  ipc.updateInstall.mockResolvedValue({ triggerRestart: true })
  ipc.openUpdateFallbackUrl.mockReset()
  ipc.openUpdateFallbackUrl.mockResolvedValue(undefined)
  ipc.getPreloaded.mockReset()
  ipc.getPreloaded.mockResolvedValue(null)
  ipc.getPendingUpdate.mockReset()
  ipc.getPendingUpdate.mockResolvedValue(null)
  ipc.getLaunchResult.mockReset()
  ipc.getLaunchResult.mockResolvedValue(null)
  ipc.getUpdateSettings.mockReset()
  ipc.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
}

/** '@/composables/features/settings/useAppUpdate' mock 工厂（真实 controller 面替换单例入口） */
export async function useAppUpdateCardModule() {
  const actual = await vi.importActual<
    typeof import('@/composables/features/settings/useAppUpdate')
  >('@/composables/features/settings/useAppUpdate')
  if (!harness) {
    const ipc = createMemoryAppUpdateIpc()
    harness = { ipc, controller: actual.createAppUpdateController({ ipc }) }
  }
  return {
    ...actual,
    useAppUpdate: () => {
      const { controller } = getCardUpdateHarness()
      return {
        state: controller.state,
        checkForUpdate: controller.checkForUpdate,
        performDownload: controller.performDownload,
        performInstall: controller.performInstall,
        openFallbackUrl: controller.openFallbackUrl,
        initAutoCheck: controller.initAutoCheck,
      }
    },
  }
}

/** '@/api/domains/settings' 捕获层单例（update-page / update-page-source 同构面；beforeEach 逐键重置）。
 *  该 mock 是登记的设计形态（u18/裁决 4-B：settings 域 Electron IPC 的稳定 vi.mock 目标），保留。 */
export const settingsMock = {
  getProxyConfig: vi.fn(() => Promise.resolve({ mode: 'system', httpProxy: '', httpsProxy: '' })),
  setProxyConfig: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() => Promise.resolve({ success: true, message: '' })),
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  setUpdateSettings: vi.fn(() => Promise.resolve()),
}

/** '@/composables/useToast' 捕获层单例（update-page / update-page-source 同构面） */
export const toastMock = {
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}

/** '@/api/domains/settings' mock 工厂（转发 settingsMock 单例） */
export function settingsApiModule() {
  return {
    getProxyConfig: settingsMock.getProxyConfig,
    setProxyConfig: settingsMock.setProxyConfig,
    testProxy: settingsMock.testProxy,
    getUpdateSettings: settingsMock.getUpdateSettings,
    setUpdateSettings: settingsMock.setUpdateSettings,
  }
}

/** '@/composables/useToast' mock 工厂（转发 toastMock 单例） */
export function toastMockModule() {
  return {
    useToast: () => toastMock,
  }
}

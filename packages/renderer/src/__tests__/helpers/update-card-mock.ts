/**
 * UpdateCheckCard / UpdatePage 测试共享 mock 单例（Wave C r2-01 useAppUpdate + settings 脚手架收敛）。
 *
 * settings/update-page.test.ts、update-page-source.test.ts、system-page-update.test.ts
 * 三文件曾逐字复制 UpdateCheckCard 的 mock 脚手架：testState 单例、动作 mock 四连、
 * useAppUpdate composable 工厂、settings domain + toast 捕获层。收敛到本 helper 单源；
 * vi.mock 注册留在测试文件（mock 是文件作用域，工厂经顶层 import 转发本 helper 导出——
 * 同 sidebar-mount.ts 先例）。
 *
 * vitest 按测试文件隔离模块图：各单例在每个测试文件内是独立实例（文件内 beforeEach
 * 重置与断言共享同一批 vi.fn，与原 vi.hoisted 文件内单例语义一致）。
 *
 * 变体保留未收敛（非逐字同构，收敛需改 mock 面）：
 * - update-page-source.test.ts 的 useAppUpdate 工厂（performDownload/performInstall/
 *   openFallbackUrl 内联 vi.fn，不经单例）
 * - composables/useAppUpdate.test.ts / .pending / .manual-channel / .visibility 四文件的
 *   hoisted 块（键集合 / 泛型签名 / 回调捕获机制互异）
 * - components/UpdateButton.test.ts 与 .w3-acceptance 的 testState（shape 不同）
 */
import { reactive } from 'vue'
import { vi } from 'vitest'
import type { UpdateState } from '@xyz-agent/shared'

/** UpdateCheckCard 消费的 useAppUpdate 单例 state（测试经 Object.assign 改写驱动分支渲染）。 */
export const cardTestState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string; releaseNotes: string } | null,
  errorMessage: '',
  percent: 0,
  releaseNotesHtml: '',
})

/** 动作 mock 四连（update-page / system-page-update 全量消费；source 仅消费 checkForUpdate）。 */
export const checkForUpdateMock = vi.fn(() => Promise.resolve())
export const performDownloadMock = vi.fn(() => Promise.resolve())
export const performInstallMock = vi.fn(() => Promise.resolve())
export const openFallbackUrlMock = vi.fn(() => Promise.resolve())

/** '@/composables/features/settings/useAppUpdate' mock 工厂（update-page / system-page-update 同构面）。 */
export function useAppUpdateCardModule() {
  return {
    useAppUpdate: () => ({
      state: cardTestState,
      checkForUpdate: checkForUpdateMock,
      performDownload: performDownloadMock,
      performInstall: performInstallMock,
      openFallbackUrl: openFallbackUrlMock,
      initAutoCheck: vi.fn(),
      restorePendingUpdate: vi.fn(),
      restorePreloadedUpdate: vi.fn(),
    }),
  }
}

/** '@/api/domains/settings' 捕获层单例（update-page / update-page-source 同构面；beforeEach 逐键重置）。 */
export const settingsMock = {
  getProxyConfig: vi.fn(() => Promise.resolve({ mode: 'system', httpProxy: '', httpsProxy: '' })),
  setProxyConfig: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() => Promise.resolve({ success: true, message: '' })),
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  setUpdateSettings: vi.fn(() => Promise.resolve()),
}

/** '@/composables/useToast' 捕获层单例（update-page / update-page-source 同构面）。 */
export const toastMock = {
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}

/** '@/api/domains/settings' mock 工厂（转发 settingsMock 单例）。 */
export function settingsApiModule() {
  return {
    getProxyConfig: settingsMock.getProxyConfig,
    setProxyConfig: settingsMock.setProxyConfig,
    testProxy: settingsMock.testProxy,
    getUpdateSettings: settingsMock.getUpdateSettings,
    setUpdateSettings: settingsMock.setUpdateSettings,
  }
}

/** '@/composables/useToast' mock 工厂（转发 toastMock 单例）。 */
export function toastMockModule() {
  return {
    useToast: () => toastMock,
  }
}

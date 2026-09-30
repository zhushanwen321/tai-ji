/**
 * ExtensionPage 测试共享 harness（settings/extension-page.test.ts 与
 * settings/extension-page-mandatory.test.ts 两文件逐字重复段单源；范式同
 * terminal-config-harness.ts——vi.mock 注册留在测试文件，工厂经顶层 import 转发本
 * helper 导出）。
 *
 * 收敛内容：extension 门面捕获单例（11 个可断言 mock，toggle reply 携带权威扩展快照
 * 类型）+ '@/api' mock 工厂（project 域底盘复用 api-facade-mock 的
 * apiProjectMock 单源）+ SettingsTransport seam 桩逐名映射（[C3]）+ beforeEach 生命周期。
 *
 * 时序约束：vi.mock('@/api', () => extensionApiModule()) 的工厂在 '@/api' 首次被
 * import 时才执行，此时本 helper 模块已初始化——测试文件须把本 helper 的 import 放在
 * 任何会拉入 '@/api' 的 import（组件/@/composables）之前（TDZ，同 terminal-config-harness）。
 *
 * vitest 按测试文件隔离模块图：捕获单例在每个测试文件内独立。
 */
import { beforeEach, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ExtensionItem } from '@taiji/core'
import { provideSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import { makeSettingsTransportStub } from './settings-transport-stub'
import { apiProjectMock } from './api-facade-mock'

/** extension 门面捕获单例形状（toggle reply 类型 = transport 契约的权威快照） */
export interface ExtensionApiMock { // oe-exempt:20260930:test:测试 mock 的字段契约形状，捕获单例的类型标注唯一消费方是本文件工厂
  upgrade: Mock
  setAutoUpgrade: Mock
  fetchRecommended: Mock
  onExtensions: Mock
  toggle: Mock<() => Promise<{ extensions: ExtensionItem[] }>>
  install: Mock
  installDir: Mock
  installGitRepository: Mock
  cancelInstall: Mock
  finishInstall: Mock
  uninstall: Mock
}

/** extension 门面捕获单例（乐观更新测试经 mockImplementationOnce / mockRejectedValueOnce
 *  接管 toggle / setAutoUpgrade；默认 impl 全部 resolve） */
export const extensionApiMock: ExtensionApiMock = {
  upgrade: vi.fn(() => Promise.resolve()),
  setAutoUpgrade: vi.fn(() => Promise.resolve()),
  fetchRecommended: vi.fn(() => Promise.resolve([])),
  onExtensions: vi.fn(() => () => {}),
  toggle: vi.fn((): Promise<{ extensions: ExtensionItem[] }> => Promise.resolve({ extensions: [] })),
  install: vi.fn(() => Promise.resolve()),
  installDir: vi.fn(() => Promise.resolve()),
  installGitRepository: vi.fn(() => Promise.resolve()),
  cancelInstall: vi.fn(() => Promise.resolve()),
  finishInstall: vi.fn(() => Promise.resolve()),
  uninstall: vi.fn(() => Promise.resolve()),
}

/** '@/api' mock 工厂：extension 门面经 extension / default.extension 双键转发捕获单例 +
 *  project 底盘（挂载期加载）+ config.detectSources 惰性桩 */
export function extensionApiModule() {
  return {
    project: apiProjectMock(),
    extension: extensionApiMock,
    default: { extension: extensionApiMock },
    config: { detectSources: async () => [] },
  }
}

/** [C3] extension 域调用经 SettingsTransport seam 桩注入（旧名→seam 域前缀名逐名映射） */
function wireExtensionTransport(): void {
  provideSettingsTransport(makeSettingsTransportStub({
    fetchRecommendedExtensions: extensionApiMock.fetchRecommended,
    toggleExtension: extensionApiMock.toggle,
    installExtension: extensionApiMock.install,
    installExtensionDir: extensionApiMock.installDir,
    installExtensionGitRepository: extensionApiMock.installGitRepository,
    finishExtensionInstall: extensionApiMock.finishInstall,
    cancelExtensionInstall: extensionApiMock.cancelInstall,
    uninstallExtension: extensionApiMock.uninstall,
    upgradeExtension: extensionApiMock.upgrade,
    setExtensionAutoUpgrade: extensionApiMock.setAutoUpgrade,
    onExtensions: extensionApiMock.onExtensions,
  }))
}

/** ExtensionPage 测试 beforeEach 接线：pinia 重置 + 全 mock 计数清零 + 全局 toasts 清空 +
 *  seam 桩注入。消费文件顶层调用一次；wrapper 卸载归测试文件 afterEach（wrapper 槽在文件内）。 */
export function setupExtensionPageTest(): void {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // 清空全局 toasts（useToast 是模块级单例，跨用例共享）
    const { toasts } = useToast()
    toasts.value = []
    wireExtensionTransport()
  })
}

/** afterEach 卸载 wrapper 并清空 body（teleport 残留清理；wrapper 槽归测试文件所有） */
export function teardownExtensionPage(wrapper: { unmount(): void } | null): void {
  wrapper?.unmount()
  document.body.innerHTML = ''
}

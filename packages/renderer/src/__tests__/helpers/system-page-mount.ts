/**
 * SystemPage 集成测试共享 helper（system-page-rename-model / system-page-smart-context）。
 *
 * 提取两测试文件重复的构造样板：
 *  - settings API mock 集（auto-rename 6 + smart-context 5 函数）与 '@taiji/core/transport/api/domains/settings'
 *    mock 模块工厂（含 getSystem/updateSystem 空实现——stores/settings → '@/api' → mock/index
 *    转发引用 real 域导出，工厂缺导出会在模块加载时抛 "No export defined"）。
 *  - useToast / useCommandStore / lib/ipc 三组模块 mock 工厂。
 *  - settings store fixture（providers/models 注入）+ SystemPage mount 编排。
 *
 * vi.mock 调用本身留在测试文件（hoisting：mock 注册须在测试文件顶部，工厂体引用本
 * helper 导出）；断言与用例特定 mock 覆写（mockResolvedValue）留在原测试文件。
 */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { vi } from 'vitest'
import type { ProviderInfo, ModelInfo } from '@taiji/shared'
import { getSettingsStore, type SystemSettings } from '@taiji/core'

/** settings API mock 集（两测试共用形态；默认值经 resetSettingsApiMocks 统一注入）。 */
export function createSettingsApiMocks() {
  return {
    getAutoRenameEnabled: vi.fn(),
    setAutoRenameEnabled: vi.fn(),
    getRenameModel: vi.fn(),
    setRenameModel: vi.fn(),
    getRenameMode: vi.fn(),
    setRenameMode: vi.fn(),
    getSmartContextConfig: vi.fn(),
    setSmartContextEnabled: vi.fn(),
    setSmartContextCompactModel: vi.fn(),
    setSmartContextThresholds: vi.fn(),
    setSmartContextExcludedModels: vi.fn(),
    // 消费方：SystemAutoRenameSection / SystemSmartContextSection（SystemPage mount 时消费，缺导出即 "No export defined"）
  }
}

export type SettingsApiMocks = ReturnType<typeof createSettingsApiMocks>

/** settings API mock 单例——mock 模块工厂与测试断言共享同一批 vi.fn 实例。 */
export const settingsApiMocks = createSettingsApiMocks()

/** '@taiji/core/transport/api/domains/settings' 的 mock 模块工厂（引用 settingsApiMocks 单例）。 */
export function settingsApiModule() {
  return {
    ...settingsApiMocks,
    // 本测试不消费 getSystem/updateSystem，给空实现避免 mock/index 转发抛错
    getSystem: vi.fn(() => Promise.resolve({})),
    updateSystem: vi.fn(() => Promise.resolve()),
  }
}

/** '@/composables/useToast' 的 mock 模块工厂（隔离 toast 全局副作用）。 */
export function toastModule() {
  return {
    useToast: () => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  }
}

/** '@/composables/features/command/useCommandStore' 的 mock 模块工厂。
 *  SystemShortcutSection 需要该 store；ref 暴露响应式属性（storeToRefs 兼容）。 */
export function commandStoreModule() {
  return {
    useCommandStore: () => ({
      appCommands: ref([]),
      shortcutOverrides: ref({}),
      setShortcutOverride: vi.fn(),
      registerApp: vi.fn(),
    }),
  }
}

/** '@/lib/ipc' 的 mock 模块工厂：listSystemSounds（SystemSoundSection onMounted）+
 *  onUpdateProgress/onUpdateError（UpdateCheckCard → useAppUpdate 订阅；缺导出 mount 崩）。 */
export function ipcModule() {
  return {
    listSystemSounds: vi.fn(() => Promise.resolve({ sounds: [] })),
    onUpdateProgress: vi.fn(() => () => {}),
    onUpdateError: vi.fn(() => () => {}),
  }
}

/** 最小 SystemSettings fixture。 */
export function systemFixture(): SystemSettings {
  return {
    locale: 'zh-CN',
    theme: 'dark',
    themePreset: 'cold-blue',
    fontSize: 'medium',
    completionSound: true,
  }
}

/** 有凭证 provider fixture（模型挂在 providers[].models —— extension 模型配置候选的正确数据源）。 */
export function authedProvider(): ProviderInfo {
  return { id: 'p1', name: 'Prov One', apiKeySet: true, status: 'connected', models: [{ id: 'm1', name: 'Model One' }] }
}

/** 无凭证 provider fixture（apiKeySet=false，其模型不应出现在下拉）。 */
export function unauthedProvider(): ProviderInfo {
  return { id: 'p2', name: 'Prov Two', apiKeySet: false, status: 'not_configured', models: [{ id: 'm2', name: 'Model Two' }] }
}

/** 聚合模型 fixture（scoped 过滤后形态，仅含白名单内 m1）。注入用于守卫：
 *  useAuthedModelGroups 改为 providers 派生后，下拉候选必须不受 store.models 内容影响。 */
export function modelFixtures(): ModelInfo[] {
  return [
    { id: 'm1', name: 'Model One', providerId: 'p1', providerName: 'Prov One' },
  ]
}

/** smart-context 默认提醒阈值档（绝对 token 数，与 extension DEFAULT_REMINDER_THRESHOLDS 一致）。 */
const SMART_CONTEXT_DEFAULT_THRESHOLDS = [400_000, 500_000, 600_000] as const

/** smart-context 默认配置 fixture（与 extension 默认值一致）。 */
export function smartContextFixture(excludedModels: string[] = []): {
  enabled: boolean
  compactModel: string
  reminderThresholds: number[]
  excludedModels: string[]
} {
  return { enabled: true, compactModel: '', reminderThresholds: [...SMART_CONTEXT_DEFAULT_THRESHOLDS], excludedModels }
}

/** 注入非空 providers/models 到 settings store 单例（模块级 store 的 ref，直接写 .value）。 */
export function seedStore(): void {
  const store = getSettingsStore()
  store.providers.value = [authedProvider(), unauthedProvider()]
  store.models.value = modelFixtures()
}

/** mount SystemPage（集成入口）并完成异步加载。unmount 由调用方 afterEach 负责。
 *  SystemPage 动态 import：helper 若顶层静态 import 会经 vitest mock-hoist 提前评估，
 *  在 vi.mock 工厂执行前触发被 mock 模块加载（TDZ 崩），动态 import 把加载推迟到用例内。 */
export async function mountSystemPage(): Promise<ReturnType<typeof mount>> {
  const { default: SystemPage } = await import('@/components/settings/system/SystemPage.vue')
  const wrapper = mount(SystemPage, {
    props: { system: systemFixture() },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

/** beforeEach 统一重置 + 默认解析值（auto-rename 开 + rename-model 未设置 + rename-mode 默认 + smart-context 全默认）。
 *  用例特定覆写在各自文件 beforeEach 之后 mockResolvedValue 覆写。 */
export function resetSettingsApiMocks(m: SettingsApiMocks): void {
  for (const fn of Object.values(m)) fn.mockReset()
  m.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
  m.setAutoRenameEnabled.mockResolvedValue({ enabled: true })
  m.getRenameModel.mockResolvedValue({ model: '' })
  m.setRenameModel.mockResolvedValue({ model: '' })
  m.getRenameMode.mockResolvedValue({ mode: 'first-stop' })
  m.setRenameMode.mockResolvedValue({ mode: 'first-stop' })
  m.getSmartContextConfig.mockResolvedValue(smartContextFixture())
  m.setSmartContextCompactModel.mockResolvedValue({ model: '' })
  m.setSmartContextThresholds.mockResolvedValue({ thresholds: [...SMART_CONTEXT_DEFAULT_THRESHOLDS] })
  m.setSmartContextExcludedModels.mockResolvedValue({ models: [] })
}

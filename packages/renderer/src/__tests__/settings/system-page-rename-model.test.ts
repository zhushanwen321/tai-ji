/**
 * SystemPage · 重命名模型 Select 测试（SystemAutoRenameSection 子组件）。
 *
 * mount 分两级：首屏冒烟走 mountSystemPage 全页集成入口（容器编排回归锚 + 全页级联加载
 * 的用户可见断言）；交互断言用例走 mountSystemSection 直挂 SystemAutoRenameSection——
 * 全页集成树（6 Section + UpdateCheckCard 等）的编译成本对单 Section 交互断言是纯浪费，
 * 且被测断言对象（setting-rename-model trigger 与其下拉选项）都落在该 Section 内。
 *
 * 覆盖：
 *  - 首屏冒烟：DOM 含 rename-model Select trigger（data-testid=setting-rename-model）。
 *  - 初始值：getRenameModel 返回 "p1/m1"（在可选列表）→ trigger 显示模型名；
 *    返回不在列表的 ref → trigger 显示该 ref + （不可用）。
 *  - 凭证过滤：apiKeySet=false 的 provider 的模型不出现在 option 文案中。
 *  - 选择交互：打开下拉点选模型 option → setRenameModel 以 "provider/modelId" 被调。
 *  - 联动：auto-rename 开 → trigger 可用；关 → trigger disabled。
 *
 * mock 策略：mock 工厂 / fixtures / mount 编排经 __tests__/helpers/system-page-mount
 *  共享（与 system-page-smart-context.test.ts 的公共样板提取）；vi.mock 注册留在本文件
 *  （hoisting 约束），用例断言与特定覆写保留在各自 describe。
 *  settings store 经 provideSettingsStore(createSettingsStore()) 每用例注入全新实例
 *  （providers/models 是 ref，测试直接写 .value 注入 fixture，无跨用例残留）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/system-page-rename-model.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { provideSettingsStore, createSettingsStore } from '@taiji/core'
import {
  settingsApiMocks,
  provideSettingsApiMocks,
  toastModule,
  commandStoreModule,
  ipcModule,
  resetSettingsApiMocks,
  mountSystemPage,
  mountSystemSection,
  seedStore,
} from '../helpers/system-page-mount'

// [C3] settings API mock 经 SettingsTransport seam 注入（provideSettingsApiMocks，见 beforeEach）
vi.mock('@/composables/useToast', () => toastModule())
vi.mock('@/composables/features/command/useCommandStore', () => commandStoreModule())
vi.mock('@/lib/ipc', () => ipcModule())

// SystemPage 集成 mount 本身重（单跑首例 ~1.1s）；全量并发 CPU 争抢下默认 5s 超时偶发击穿
//（Gate A R4②）。mount 慢是集成测试固有成本而非挂起，放宽本文件超时作资源竞争容差。
vi.setConfig({ testTimeout: 20_000 })

// 工厂引用 helper 单例（seam 桩与断言共享同一 mock fn 实例）
const settingsMock = settingsApiMocks

let wrapper: Awaited<ReturnType<typeof mountSystemPage>> | null = null

/** mount SystemPage（集成入口）并完成异步加载。 */
async function mountPage(): Promise<void> {
  wrapper = await mountSystemPage()
}

/** 直挂 SystemAutoRenameSection（交互断言用例；依赖面裁剪依据见文件头 mount 分级说明）。 */
async function mountSection(): Promise<void> {
  wrapper = await mountSystemSection(() => import('@/components/settings/system/SystemAutoRenameSection.vue'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  resetSettingsApiMocks(settingsMock)
  provideSettingsApiMocks()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SystemPage 重命名模型 Select', () => {
  it('mount 后 DOM 含 rename-model Select trigger', async () => {
    await mountPage()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.exists()).toBe(true)
  })

  it('getRenameModel 返回可选列表内的 ref 时 trigger 显示模型名', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: 'p1/m1' })
    seedStore()
    await mountSection()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.text()).toContain('Model One')
  })

  it('ref 不在可选列表时 trigger 显示该 ref + （不可用）', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: 'gone/model-x' })
    seedStore()
    await mountSection()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.text()).toContain('gone/model-x')
    expect(trigger.text()).toContain('（不可用）')
  })

  it('未设置时 trigger 显示「跟随会话模型」', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: '' })
    seedStore()
    await mountSection()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.text()).toContain('跟随会话模型')
  })

  it('auto-rename 关闭时 trigger disabled，开启时可用', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
    await mountSection()
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(trigger.attributes('disabled')).toBeDefined()

    // 二段挂载前先卸载首段（直挂不 attachTo，残留实例的 watcher 不跨段存活）
    wrapper!.unmount()
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
    seedStore()
    await mountSection()
    const enabledTrigger = wrapper!.find('[data-testid="setting-rename-model"]')
    expect(enabledTrigger.attributes('disabled')).toBeUndefined()
  })

  it('下拉 option 只含已配凭证 provider 的模型；点选后 setRenameModel 收到 "p1/m1"', async () => {
    seedStore()
    await mountSection()

    // reka-ui SelectContent 仅在 open 时挂载（SelectPortal teleport 到 body）。
    // SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch
    // （同 provider-edit-modal.test.ts 的交互模式）。
    const trigger = wrapper!.find('[data-testid="setting-rename-model"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const options = document.body.querySelectorAll('[role="option"]')
    const labels = Array.from(options).map((el) => el.textContent ?? '')
    // 有凭证 provider 的模型在列；无凭证 provider 的模型被过滤
    expect(labels).toContain('Model One')
    expect(labels).not.toContain('Model Two')
    expect(labels).toContain('跟随会话模型')

    // 点选 Model One → setRenameModel 收到 "providerId/modelId" 复合串
    const target = Array.from(options).find((el) => (el.textContent ?? '').includes('Model One'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setRenameModel).toHaveBeenCalledWith('p1/m1')
  })
})

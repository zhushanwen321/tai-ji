/**
 * SystemPage · 智能上下文压缩 Section 测试（SystemSmartContextSection，经 SystemPage 入口 mount）。
 *
 * 覆盖：
 *  - 首屏冒烟：DOM 含 switch / model Select / 3 档阈值 input / 排除容器（用户可见断言）。
 *  - 初始值：getSmartContextConfig 返回全量 → Switch 开 + 阈值 input 显示 K 值（400/500/600）。
 *  - 开关交互：切 Switch → setSmartContextEnabled 以 false 被调。
 *  - 模型下拉：选项来自 settingsStore.models 且只含 apiKeySet provider 的模型；
 *    首项「跟随当前会话模型」；点选 → setSmartContextCompactModel 以 "provider/modelId" 被调。
 *  - 阈值换算：input 改为 300（K）→ change → setSmartContextThresholds 收到绝对数 300000。
 *  - 排除 tag：getSmartContextConfig 返回 excludedModels → tag 文本渲染；点 × → 列表移除项被传。
 *
 * mock 策略：mock 工厂 / fixtures / mount 编排经 __tests__/helpers/system-page-mount
 *  共享（与 system-page-rename-model.test.ts 的公共样板提取）；vi.mock 注册留在本文件
 *  （hoisting 约束），用例断言与特定覆写保留在各自 describe。
 *  settings store 用 @taiji/core 的 getSettingsStore() 单例，beforeEach 经
 *  __resetSettingsStoreForTesting 重置避免跨用例残留。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/system-page-smart-context.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { __resetSettingsStoreForTesting } from '@taiji/core'
import {
  settingsApiMocks,
  settingsApiModule,
  toastModule,
  commandStoreModule,
  ipcModule,
  resetSettingsApiMocks,
  mountSystemPage,
  seedStore,
  smartContextFixture,
} from '../helpers/system-page-mount'

vi.mock('@taiji/core/transport/api/domains/settings', () => settingsApiModule())
vi.mock('@/composables/useToast', () => toastModule())
vi.mock('@/composables/features/command/useCommandStore', () => commandStoreModule())
vi.mock('@/lib/ipc', () => ipcModule())

// SystemPage 集成 mount 重组件树，插桩/全量套件负载下超 5s 默认预算（空载单跑秒级过）
// ——预算放宽对齐兄弟文件 system-page-rename-model.test.ts 的 20s 形态
vi.setConfig({ testTimeout: 20_000 })

// 工厂引用 helper 单例（mock 模块与断言共享同一 mock fn 实例）
const settingsMock = settingsApiMocks

let wrapper: Awaited<ReturnType<typeof mountSystemPage>> | null = null

/** mount SystemPage（集成入口）并完成异步加载。 */
async function mountPage(): Promise<void> {
  wrapper = await mountSystemPage()
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  resetSettingsApiMocks(settingsMock)
  // 本文件默认值覆写：切 Switch 用例断言传参 false，响应也用 false 保持一致形态
  settingsMock.setSmartContextEnabled.mockResolvedValue({ enabled: false })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SystemSmartContextSection 智能上下文压缩', () => {
  it('mount 后 DOM 含 switch / model Select / 3 档阈值 input / 排除容器', async () => {
    await mountPage()
    expect(wrapper!.find('[data-testid="setting-smart-context-switch"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-model"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-threshold-1"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-threshold-2"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-threshold-3"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="setting-smart-context-excluded"]').exists()).toBe(true)
  })

  it('初始值：Switch 开 + 阈值 input 显示 K 值（400/500/600）', async () => {
    await mountPage()
    const sw = wrapper!.find('[data-testid="setting-smart-context-switch"]')
    expect(sw.attributes('data-state')).toBe('checked')
    const t1 = wrapper!.find('[data-testid="setting-smart-context-threshold-1"]').element as HTMLInputElement
    const t3 = wrapper!.find('[data-testid="setting-smart-context-threshold-3"]').element as HTMLInputElement
    expect(t1.value).toBe('400')
    expect(t3.value).toBe('600')
  })

  it('enabled=false 时 Switch 为关且阈值 input disabled', async () => {
    settingsMock.getSmartContextConfig.mockResolvedValue({ ...smartContextFixture(), enabled: false })
    await mountPage()
    const sw = wrapper!.find('[data-testid="setting-smart-context-switch"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    const t1 = wrapper!.find('[data-testid="setting-smart-context-threshold-1"]')
    expect(t1.attributes('disabled')).toBeDefined()
  })

  it('切换 Switch 触发 setSmartContextEnabled(false)', async () => {
    await mountPage()
    const sw = wrapper!.find('[data-testid="setting-smart-context-switch"]')
    // reka-ui Switch 通过 click 切换并 emit update:model-value
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setSmartContextEnabled).toHaveBeenCalledTimes(1)
    expect(settingsMock.setSmartContextEnabled).toHaveBeenCalledWith(false)
  })

  it('模型下拉：只列已配凭证 provider 的模型，首项跟随当前会话模型；点选后 setSmartContextCompactModel 收到 "p1/m1"', async () => {
    seedStore()
    await mountPage()

    // reka-ui SelectContent 仅在 open 时挂载（SelectPortal teleport 到 body）。
    // SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch。
    const trigger = wrapper!.find('[data-testid="setting-smart-context-model"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()

    const options = document.body.querySelectorAll('[role="option"]')
    const labels = Array.from(options).map((el) => el.textContent ?? '')
    // 有凭证 provider 的模型在列；无凭证 provider 的模型被过滤；首项「跟随当前会话模型」
    expect(labels).toContain('Model One')
    expect(labels).not.toContain('Model Two')
    expect(labels.some((l) => l.includes('跟随当前会话模型'))).toBe(true)

    // 点选 Model One → setSmartContextCompactModel 收到 "providerId/modelId" 复合串
    const target = Array.from(options).find((el) => (el.textContent ?? '').includes('Model One'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setSmartContextCompactModel).toHaveBeenCalledWith('p1/m1')
  })

  it('阈值输入保存换算：第 1 档改为 300(K) → setSmartContextThresholds 收到 300000 绝对数', async () => {
    await mountPage()
    const t1 = wrapper!.find('[data-testid="setting-smart-context-threshold-1"]')
    ;(t1.element as HTMLInputElement).value = '300'
    await t1.trigger('input')
    await t1.trigger('change')
    await flushPromises()
    expect(settingsMock.setSmartContextThresholds).toHaveBeenCalledWith([300_000, 500_000, 600_000])
  })

  it('排除模型 tag 渲染 + 点 × 移除后 setSmartContextExcludedModels 收到剩余列表', async () => {
    seedStore()
    settingsMock.getSmartContextConfig.mockResolvedValue(
      smartContextFixture(['p1/m1', 'p2/m2']),
    )
    await mountPage()

    const excluded = wrapper!.find('[data-testid="setting-smart-context-excluded"]')
    // tag 文本渲染（用户可见）
    expect(excluded.text()).toContain('p1/m1')
    expect(excluded.text()).toContain('p2/m2')

    // 点第一个 tag 的 × → 移除 p1/m1
    const removeBtn = excluded.findAll('button')[0]
    expect(removeBtn).toBeTruthy()
    await removeBtn.trigger('click')
    await flushPromises()
    expect(settingsMock.setSmartContextExcludedModels).toHaveBeenCalledWith(['p2/m2'])
  })

  it('添加 Select 点选模型后 setSmartContextExcludedModels 收到追加列表', async () => {
    seedStore()
    await mountPage()

    // 打开「添加模型」Select（排除容器内的 SelectTrigger）
    const addTrigger = wrapper!
      .find('[data-testid="setting-smart-context-excluded"]')
      .find('[role="combobox"]')
    expect(addTrigger.exists()).toBe(true)
    const el = addTrigger.element as HTMLElement
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.click()
    await flushPromises()

    // 已配凭证且未排除的模型可选项（排除占位项 value=__add__ disabled 不响应点选）
    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
    const labels = options.map((o) => o.textContent ?? '')
    expect(labels).toContain('Model One')
    expect(labels).not.toContain('Model Two')

    const target = options.find((o) => (o.textContent ?? '').includes('Model One'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
    expect(settingsMock.setSmartContextExcludedModels).toHaveBeenCalledWith(['p1/m1'])
  })

  it('RD-4#8：getSmartContextConfig 读取失败 → 常驻提示 + Switch 禁用（不把默认值当已存值）', async () => {
    settingsMock.getSmartContextConfig.mockRejectedValue(new Error('ws down'))
    await mountPage()
    // 顶部常驻提示 + 重试入口
    expect(wrapper!.find('[data-testid="smart-context-load-error"]').exists()).toBe(true)
    expect(wrapper!.text()).toContain('读取失败')
    // Switch 禁用（loadError 时不可操作，禁止把默认「开」当已存值落盘）
    const swEl = wrapper!.find('[data-testid="setting-smart-context-switch"]').element as HTMLButtonElement
    expect(swEl.disabled).toBe(true)
  })

  it('RD-4#8：重试成功后清除提示 + Switch 恢复可用', async () => {
    settingsMock.getSmartContextConfig.mockRejectedValueOnce(new Error('ws down'))
    await mountPage()
    expect(wrapper!.find('[data-testid="smart-context-load-error"]').exists()).toBe(true)

    // 重试：mock 改成功（resetSettingsApiMocks 的默认 resolved 值）
    settingsMock.getSmartContextConfig.mockResolvedValue(smartContextFixture())
    await wrapper!.find('[data-testid="smart-context-load-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper!.find('[data-testid="smart-context-load-error"]').exists()).toBe(false)
    const swEl = wrapper!.find('[data-testid="setting-smart-context-switch"]').element as HTMLButtonElement
    expect(swEl.disabled).toBe(false)
  })
})

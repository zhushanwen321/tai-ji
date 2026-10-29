/**
 * settings 页合并产物（round 5-G S4）：三文件同产物，环境全默认（happy-dom）。
 *
 * 并入来源（基名）：
 *  - system-page-smart-context（SystemSmartContextSection 智能上下文压缩，10 例）
 *  - update-page（UpdatePage 全功能区，26 例）
 *  - rename-session-page（RenameSessionPage 三视角，20 例）
 *
 * 「z 基线 ↔ 登记表全等对账」不在本文件：那是全仓源码扫描（单次 ~530ms，随仓库规模增长），
 * 不验证运行时行为，已由 `scripts/check-z-surface-baseline.mjs` 承接。
 *
 * mock 注册（产物内统一，每模块一条；原 helper system-page-test-setup / update-page-mocks
 * 各自的注册不 import，避免同模块重复注册）：
 *  - '@/composables/useToast' → update-card-mock 的 toastMockModule 单例形态（update-page
 *    节断言 toastMock；smart-context/rename 节原 toastModule 工厂为每调用新 fn 的隔离形态，
 *    两节不断言 toast 实例身份，单例形态兼容）
 *  - '@/composables/features/command/useCommandStore' → commandStoreModule（SystemShortcutSection）
 *  - '@/lib/ipc' → ipcModule 窄替换（listSystemSounds/onUpdateProgress/onUpdateError）
 *  - '@/api/domains/settings' → 保留式改造：spread 全门面 + 仅覆写 update-page 节消费的
 *    5 键（转发 settingsMock 单例）。原 update-page 为 5 键窄替换；合并后 SystemPage 全树
 *    （rename 节 mountPage 用例）的 SystemSoundSection 消费 listSystemSounds，窄替换会让
 *    其 undefined——spread 后恢复真实转发（该域模块为 @/lib/ipc 的 1:1 转发层，
 *    listSystemSounds 落到 ipcModule mock 返回空清单，与原 rename 独立文件行为等价）
 *  - '@/composables/features/settings/useAppUpdate' → useAppUpdateCardModule（原本即保留式）
 *
 * setupSystemPageTest 生命周期在产物内写局部变体（函数体复制自 system-page-test-setup，
 * 不 import 该 helper——其 import 即注册 3 条 vi.mock，与产物内注册重复）。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=settings TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/settings/settings-page-bundle.test.ts（本文件登记在 domain-map.json settings 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type { Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { provideSettingsStore, createSettingsStore } from '@taiji/core'
import {
  settingsApiMocks,
  provideSettingsApiMocks,
  resetSettingsApiMocks,
  mountSystemPage,
  mountSystemSection,
  seedStore,
  smartContextFixture,
  commandStoreModule,
  ipcModule,
} from '../helpers/system-page-mount'
import {
  getCardUpdateHarness,
  settingsMock as updateSettingsMock,
  toastMock,
  toastMockModule,
  settingsApiModule,
  useAppUpdateCardModule,
} from '../helpers/update-card-mock'
import { mountUpdatePage, setupUpdatePageLifecycle } from '../helpers/update-page-mount'
import { openRekaDropdown, pickRekaOption } from '../helpers/reka-select-harness'

vi.mock('@/composables/useToast', () => toastMockModule())
vi.mock('@/composables/features/command/useCommandStore', () => commandStoreModule())
vi.mock('@/lib/ipc', () => ipcModule())
vi.mock('@/api/domains/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/domains/settings')>()
  return { ...actual, ...settingsApiModule() }
})
vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())

/**
 * SystemPage 集成节 setup 工厂（system-page-test-setup 的产物内局部变体，mock 注册已上移
 * 产物顶部）。beforeEach：pinia + settings store 全新实例 + settings API mock 重置 + seam
 * 注入；afterEach：wrapper 卸载 + body 清理。
 */
function setupSystemPageTest(sectionLoader: () => Promise<{ default: Component }>) {
  let wrapper: Awaited<ReturnType<typeof mountSystemPage>> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    provideSettingsStore(createSettingsStore())
    resetSettingsApiMocks(settingsApiMocks)
    provideSettingsApiMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  return {
    settingsMock: settingsApiMocks,
    async mountPage(): Promise<void> {
      wrapper = await mountSystemPage()
    },
    async mountSection(): Promise<void> {
      wrapper = await mountSystemSection(sectionLoader)
    },
    pageWrapper(): Awaited<ReturnType<typeof mountSystemPage>> | null {
      return wrapper
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：system-page-smart-context（SystemSmartContextSection，原文件顶层 hook 下沉节内）
// ─────────────────────────────────────────────────────────────────────────────

describe('SystemSmartContextSection 智能上下文压缩', () => {
  // 工厂引用 helper 单例（seam 桩与断言共享同一 mock fn 实例）
  const loadSmartContextSection = () =>
    import('@/components/settings/system/SystemSmartContextSection.vue')
  const { settingsMock, mountSection, pageWrapper } = setupSystemPageTest(loadSmartContextSection)

  // Section 模块图预热一次（h 类整治）：依赖链（@taiji/ui GroupCard / @taiji/core transport /
  // useAuthedModelGroups 等）装载成本落节级 beforeAll，首条用例只付 mount 成本。vi.mock
  // 注册在产物 import 期完成、先于本 hook，动态 import 保持 TDZ 安全。
  beforeAll(loadSmartContextSection)

  beforeEach(() => {
    // 本节默认值覆写：切 Switch 用例断言传参 false，响应也用 false 保持一致形态
    //（setup 的 beforeEach 先注册先执行 reset + seam 注入，本覆写在其后生效）
    settingsMock.setSmartContextEnabled.mockResolvedValue({ enabled: false })
  })

  it('mount 后 DOM 含 switch / model Select / 3 档阈值 input / 排除容器', async () => {
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="setting-smart-context-switch"]').exists()).toBe(true)
    expect(pageWrapper()!.find('[data-testid="setting-smart-context-model"]').exists()).toBe(true)
    expect(pageWrapper()!.find('[data-testid="setting-smart-context-threshold-1"]').exists()).toBe(true)
    expect(pageWrapper()!.find('[data-testid="setting-smart-context-threshold-2"]').exists()).toBe(true)
    expect(pageWrapper()!.find('[data-testid="setting-smart-context-threshold-3"]').exists()).toBe(true)
    expect(pageWrapper()!.find('[data-testid="setting-smart-context-excluded"]').exists()).toBe(true)
  })

  it('初始值：Switch 开 + 阈值 input 显示 K 值（400/500/600）', async () => {
    await mountSection()
    const sw = pageWrapper()!.find('[data-testid="setting-smart-context-switch"]')
    expect(sw.attributes('data-state')).toBe('checked')
    const t1 = pageWrapper()!.find('[data-testid="setting-smart-context-threshold-1"]').element as HTMLInputElement
    const t3 = pageWrapper()!.find('[data-testid="setting-smart-context-threshold-3"]').element as HTMLInputElement
    expect(t1.value).toBe('400')
    expect(t3.value).toBe('600')
  })

  it('enabled=false 时 Switch 为关且阈值 input disabled', async () => {
    settingsMock.getSmartContextConfig.mockResolvedValue({ ...smartContextFixture(), enabled: false })
    await mountSection()
    const sw = pageWrapper()!.find('[data-testid="setting-smart-context-switch"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    const t1 = pageWrapper()!.find('[data-testid="setting-smart-context-threshold-1"]')
    expect(t1.attributes('disabled')).toBeDefined()
  })

  it('切换 Switch 触发 setSmartContextEnabled(false)', async () => {
    await mountSection()
    const sw = pageWrapper()!.find('[data-testid="setting-smart-context-switch"]')
    // reka-ui Switch 通过 click 切换并 emit update:model-value
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setSmartContextEnabled).toHaveBeenCalledTimes(1)
    expect(settingsMock.setSmartContextEnabled).toHaveBeenCalledWith(false)
  })

  it('模型下拉：只列已配凭证 provider 的模型，首项跟随当前会话模型；点选后 setSmartContextCompactModel 收到 "p1/m1"', async () => {
    seedStore()
    await mountSection()

    // reka-ui SelectContent 仅在 open 时挂载（SelectPortal teleport 到 body）。
    // SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch。
    const trigger = pageWrapper()!.find('[data-testid="setting-smart-context-model"]').element as HTMLElement
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
    await mountSection()
    const t1 = pageWrapper()!.find('[data-testid="setting-smart-context-threshold-1"]')
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
    await mountSection()

    const excluded = pageWrapper()!.find('[data-testid="setting-smart-context-excluded"]')
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
    await mountSection()

    // 打开「添加模型」Select（排除容器内的 SelectTrigger）
    const addTrigger = pageWrapper()!
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
    await mountSection()
    // 顶部常驻提示 + 重试入口
    expect(pageWrapper()!.find('[data-testid="smart-context-load-error"]').exists()).toBe(true)
    expect(pageWrapper()!.text()).toContain('读取失败')
    // Switch 禁用（loadError 时不可操作，禁止把默认「开」当已存值落盘）
    const swEl = pageWrapper()!.find('[data-testid="setting-smart-context-switch"]').element as HTMLButtonElement
    expect(swEl.disabled).toBe(true)
  })

  it('RD-4#8：重试成功后清除提示 + Switch 恢复可用', async () => {
    settingsMock.getSmartContextConfig.mockRejectedValueOnce(new Error('ws down'))
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="smart-context-load-error"]').exists()).toBe(true)

    // 重试：mock 改成功（resetSettingsApiMocks 的默认 resolved 值）
    settingsMock.getSmartContextConfig.mockResolvedValue(smartContextFixture())
    await pageWrapper()!.find('[data-testid="smart-context-load-retry"]').trigger('click')
    await flushPromises()

    expect(pageWrapper()!.find('[data-testid="smart-context-load-error"]').exists()).toBe(false)
    const swEl = pageWrapper()!.find('[data-testid="setting-smart-context-switch"]').element as HTMLButtonElement
    expect(swEl.disabled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：update-page（UpdatePage 全功能区；原文件顶层 lifecycle hook 下沉包裹层内）
// ─────────────────────────────────────────────────────────────────────────────

describe('UpdatePage（update-page 合并节）', () => {
  // __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub（'0.0.0-test'）
  const settingsMock = updateSettingsMock

  // 脚手架（beforeAll 预热一份全树装载 + beforeEach 重置/默认值 + afterEach 卸载清 body）
  // 单源在 helpers/update-page-mount.ts；在包裹层内调用使 hook 只作用于本节。
  setupUpdatePageLifecycle()

  // ── 用例骨架 helper（节内重复段单源；断言随骨架保留，用例只留差异覆写与专属断言）──

  type PageWrapper = Awaited<ReturnType<typeof mountUpdatePage>>

  /** 以 autoUpdate=true 挂载并断言开关初始为开（回填/开→关切换用例的公共基线） */
  async function mountWithAutoUpdateOn(): Promise<PageWrapper> {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
    return wrapper
  }

  /** 挂载 + 断言开关初始为关 + 点击切换 + flush（persist 结果断言用例的公共前缀） */
  async function mountAndToggleFromOff(): Promise<PageWrapper> {
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    await sw.trigger('click')
    await flushPromises()
    return wrapper
  }

  /** 以 getUpdateSettings reject('ipc down') 挂载并断言常驻 loadError 显形（load 失败契约用例共用） */
  async function mountWithUpdateLoadError(): Promise<PageWrapper> {
    settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down'))
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
    return wrapper
  }

  /** 挂载 → 点「测试代理」→ flush → 返回结果块（testProxy 结果渲染用例共用；按钮与结果块存在
   *  断言随骨架保留） */
  async function mountAndTestProxy(): Promise<DOMWrapper<Element>> {
    const wrapper = await mountUpdatePage()
    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    expect(testButton.exists()).toBe(true)
    await testButton.trigger('click')
    await flushPromises()
    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)
    return result
  }

  /** 打开 select-update-source 的下拉，返回全部 option（reka 交互序列单源在 helpers/reka-select-harness.ts） */
  async function openSourceDropdown(wrapper: VueWrapper): Promise<HTMLElement[]> {
    return openRekaDropdown(wrapper.find('[data-testid="select-update-source"]').element)
  }

  /** 在 select-update-source 的下拉中点选指定文案的 option（reka 交互序列同上单源） */
  async function pickOption(label: string, wrapper: VueWrapper): Promise<void> {
    await pickRekaOption(wrapper.find('[data-testid="select-update-source"]').element, label)
  }

  describe('UpdatePage 自动更新卡', () => {
    it('首屏渲染：DOM 含自动更新开关 + 当前版本 pill + 检查更新按钮', async () => {
      const wrapper = await mountUpdatePage()
      // 自动更新开关存在
      const sw = wrapper.find('[data-testid="switch-auto-update"]')
      expect(sw.exists()).toBe(true)
      // 当前版本 pill 存在（[w3] demo 版本行形态：pill 只含版本号，渠道文案在同行 desc）
      const pill = wrapper.find('[data-testid="current-version-pill"]')
      expect(pill.exists()).toBe(true)
      expect(pill.text()).toContain('v0.0.0-test')
      expect(wrapper.text()).toContain('stable 渠道')
      // UpdateCheckCard 内嵌渲染（检查更新状态机在自动更新卡内）
      expect(wrapper.find('[data-testid="settings-update-check"]').exists()).toBe(true)
    })

    it('加载回填：getUpdateSettings.autoUpdate true → 开关为开', async () => {
      await mountWithAutoUpdateOn()
    })

    it('加载回填：getUpdateSettings.autoUpdate false → 开关为关', async () => {
      settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
      const wrapper = await mountUpdatePage()
      const sw = wrapper.find('[data-testid="switch-auto-update"]')
      expect(sw.attributes('data-state')).toBe('unchecked')
    })

    it('切换开关：click 调 setUpdateSettings({ autoUpdate: true }) 并更新开关状态', async () => {
      // reka-ui Switch 通过 click 切换并 emit update:model-value
      const wrapper = await mountAndToggleFromOff()
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: true })
      // 持久化成功后开关状态更新
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
    })

    it('切换开关：开 → 关 调 setUpdateSettings({ autoUpdate: false })', async () => {
      const wrapper = await mountWithAutoUpdateOn()
      await wrapper.find('[data-testid="switch-auto-update"]').trigger('click')
      await flushPromises()
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: false })
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
    })

    it('持久化失败：开关保持原值 + toast error（不抛错）', async () => {
      settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
      // 切换触发持久化 → 失败 → 控件保持 unchecked
      const wrapper = await mountAndToggleFromOff()
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
      expect(toastMock.error).toHaveBeenCalledTimes(1)
      // module 统一失败反馈：saveFailed toast 透传 IPC 错误文案（{reason} 插值）
      expect(toastMock.error).toHaveBeenCalledWith('保存失败：write failed')
      // 失败回滚路径无成功反馈（saved toast 仅在写成功出现）
      expect(toastMock.info).not.toHaveBeenCalled()
    })

    it('预下载开关回填不回归：preDownload true → switch-pre-download 为开', async () => {
      settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: true, autoUpdate: false })
      const wrapper = await mountUpdatePage()
      const sw = wrapper.find('[data-testid="switch-pre-download"]')
      expect(sw.exists()).toBe(true)
      expect(sw.attributes('data-state')).toBe('checked')
    })

    it('切换成功反馈：写成功后出现 saved toast（setting-field module 统一形态）', async () => {
      const wrapper = await mountUpdatePage()
      await wrapper.find('[data-testid="switch-auto-update"]').trigger('click')
      await flushPromises()
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
      expect(toastMock.info).toHaveBeenCalledWith('更新设置已保存')
    })
  })

  // ── load 失败契约（RD-4#8，样板 = subagent-engine-section.test.ts）：失败默认值不冒充已存值 ──
  describe('UpdatePage load 失败契约（RD-4#8）', () => {
    it('getUpdateSettings reject → loadError 常驻提示 + 可落盘控件禁用 + 默认值不发写请求', async () => {
      const wrapper = await mountWithUpdateLoadError()
      // 常驻提示 + 重试入口
      expect(wrapper.text()).toContain('读取失败，显示的是默认值')
      expect(wrapper.find('[data-testid="update-page-load-retry"]').exists()).toBe(true)
      // 可落盘控件禁用（Switch disabled attribute + Select disabled prop + 保存按钮）
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="switch-pre-download"]').attributes('disabled')).toBeDefined()
      expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(true)
      expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeDefined()
      // 禁用态下 click 不发写请求（默认值明确不可操作）
      await wrapper.find('[data-testid="switch-auto-update"]').trigger('click')
      await flushPromises()
      expect(settingsMock.setUpdateSettings).not.toHaveBeenCalled()
    })

    it('getProxyConfig reject → 同样归并置 loadError（组级 loadAll 任一失败即置位）', async () => {
      settingsMock.getProxyConfig.mockRejectedValue(new Error('proxy read failed'))
      const wrapper = await mountUpdatePage()
      expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeDefined()
    })

    it('RD-4#8：重试成功 → loadError 清除 + 控件恢复 + 权威值回填', async () => {
      const wrapper = await mountWithUpdateLoadError()

      // 重试：mock 改成功，权威值 autoUpdate=true
      settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
      await wrapper.find('[data-testid="update-page-load-retry"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeUndefined()
      // 权威值回填：开关从占位 false 前进到已存 true
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
    })

    it('RD-4#8：重试仍失败 → loadError 保持 + 控件保持禁用', async () => {
      const wrapper = await mountWithUpdateLoadError()

      settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down again'))
      await wrapper.find('[data-testid="update-page-load-retry"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeDefined()
    })
  })

  // ── 原 UpdatePage.w3-acceptance.test.ts 并入（同 SUT 异功能区：testProxy 结果两行渲染；
  //    W3-A6 验收，mock 形态对齐本文件 settingsMock，UpdateCheckCard 经 useAppUpdate mock 走真实组件）──
  describe('testProxy 测试代理结果渲染（W3-A6）', () => {
    it('测试失败时显示两行（message + suggestion）', async () => {
      settingsMock.testProxy.mockResolvedValue({
        success: false,
        message: '无法连接代理 (EHOSTUNREACH)',
        suggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络',
      })

      const result = await mountAndTestProxy()

      const text = result.text()
      // 第一行：错误摘要
      expect(text).toContain('代理连接失败: 无法连接代理 (EHOSTUNREACH)')
      // 第二行：恢复指引
      expect(text).toContain('macOS 未授予「本地网络」权限')
    })

    it('测试成功时只显示成功消息（不显示 suggestion）', async () => {
      settingsMock.testProxy.mockResolvedValue({ success: true })

      const result = await mountAndTestProxy()

      expect(result.text()).toContain('代理连接成功')
      expect(result.text()).not.toContain('macOS')
    })

    it('测试失败无 suggestion 时只显示一行', async () => {
      settingsMock.testProxy.mockResolvedValue({
        success: false,
        message: 'fetch failed',
      })

      const result = await mountAndTestProxy()

      expect(result.text()).toContain('代理连接失败: fetch failed')
    })
  })

  describe('UpdatePage 预下载开关与代理表单保存（setting-field 编排）', () => {
    it('预下载开关：点 switch → setUpdateSettings({ preDownload: true }) 立即持久化', async () => {
      const wrapper = await mountUpdatePage()
      expect(settingsMock.getUpdateSettings).toHaveBeenCalled()

      const sw = wrapper.find('[data-testid="switch-pre-download"]')
      expect(sw.exists()).toBe(true)
      await sw.trigger('click')
      await flushPromises()

      expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
    })

    it('代理表单保存（system 模式直存）：点保存 → setProxyConfig 整体写回 + 成功 toast', async () => {
      const wrapper = await mountUpdatePage()

      await wrapper.find('[data-testid="btn-save-proxy"]').trigger('click')
      await flushPromises()

      expect(settingsMock.setProxyConfig).toHaveBeenCalledTimes(1)
      expect(settingsMock.setProxyConfig).toHaveBeenCalledWith({
        mode: 'system',
        httpProxy: undefined,
        httpsProxy: undefined,
      })
      // createExplicitSave 成功 toast（settings.update.saved = 「代理配置已保存」）
      expect(toastMock.info).toHaveBeenCalledWith('代理配置已保存')
    })

    it('代理保存失败：setProxyConfig reject → error toast 透传 RPC 错误文案（onError 路径）', async () => {
      settingsMock.setProxyConfig.mockRejectedValue(new Error('proxy down'))
      const wrapper = await mountUpdatePage()

      await wrapper.find('[data-testid="btn-save-proxy"]').trigger('click')
      await flushPromises()

      expect(toastMock.error).toHaveBeenCalledTimes(1)
      // onError 文案 = settings.update.saveFailed 插值（半角冒号，locale 原文）
      expect(toastMock.error).toHaveBeenCalledWith('保存失败: proxy down')
    })
  })

  describe('UpdatePage 更新来源三选控件', () => {
    it('testid 存在：DOM 含 select-update-source trigger', async () => {
      const wrapper = await mountUpdatePage()
      expect(wrapper.find('[data-testid="select-update-source"]').exists()).toBe(true)
    })

    it('三选项渲染：下拉 option 含「自动（推荐）」「GitHub」「GitCode」', async () => {
      const wrapper = await mountUpdatePage()
      const options = await openSourceDropdown(wrapper)
      const labels = options.map((el) => el.textContent ?? '')
      expect(labels).toContain('自动（推荐）')
      expect(labels).toContain('GitHub')
      expect(labels).toContain('GitCode')
      expect(labels).toHaveLength(3)
    })

    it('加载回填：updateSource=gitcode → trigger 显示 GitCode', async () => {
      settingsMock.getUpdateSettings.mockResolvedValue({
        preDownload: false,
        autoUpdate: false,
        updateSource: 'gitcode',
      })
      const wrapper = await mountUpdatePage()
      expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('GitCode')
    })

    it('加载回填：updateSource 缺失（旧 settings 文件）→ 缺省显示「自动（推荐）」', async () => {
      settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
      const wrapper = await mountUpdatePage()
      expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('自动（推荐）')
    })

    it('切换持久化：点选 GitHub → setUpdateSettings({ updateSource: "github" }) + trigger 显示 GitHub', async () => {
      const wrapper = await mountUpdatePage()
      await pickOption('GitHub', wrapper)
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'github' })
      // 持久化成功后 trigger 显示更新
      expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('GitHub')
    })

    it('切换持久化：点选 GitCode → setUpdateSettings({ updateSource: "gitcode" })', async () => {
      const wrapper = await mountUpdatePage()
      await pickOption('GitCode', wrapper)
      expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'gitcode' })
    })

    it('切换后不触发 force 检查：checkForUpdate 不被调用（D3：生效以缓存 TTL 为界）', async () => {
      const wrapper = await mountUpdatePage()
      await pickOption('GitHub', wrapper)
      expect(getCardUpdateHarness().ipc.checkForUpdate).not.toHaveBeenCalled()
    })

    it('持久化失败：trigger 保持原选项 + toast error（不抛错）', async () => {
      settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
      const wrapper = await mountUpdatePage()
      await pickOption('GitHub', wrapper)
      // 失败回滚：trigger 仍显示初始选项「自动（推荐）」
      expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('自动（推荐）')
      expect(toastMock.error).toHaveBeenCalledTimes(1)
      // module 统一失败反馈：saveFailed toast 透传 IPC 错误文案（{reason} 插值）
      expect(toastMock.error).toHaveBeenCalledWith('保存失败：write failed')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：rename-session-page（RenameSessionPage 三视角；原文件顶层 hook 下沉包裹层内）
// ─────────────────────────────────────────────────────────────────────────────

describe('RenameSessionPage（rename-session-page 合并节）', () => {
  const { settingsMock, mountPage, mountSection, pageWrapper } = setupSystemPageTest(
    () => import('@/components/settings/rename-session/RenameSessionPage.vue'),
  )

  // SystemPage 模块图预热一次（h 类整治）：全树（7 Section + 头部）编译装载成本落节级
  // beforeAll，下方唯一的 mountPage 用例不再吸收装载成本。该用例不能改 mountSection 直挂：
  // 断言对象是 SystemPage 编排 DOM 的否定形态（已迁出区块不出现），直挂 RenameSessionPage
  // 时其根节点即携带 rename-session-page testid，否定断言恒假；且 mountSection 不 attach 到
  // body，document.body.querySelector 形态断言会沦为恒真空转。vi.mock 注册在产物 import 期
  // 完成、先于本 hook，动态 import 保持 TDZ 安全（同 system-page-mount.mountSystemPage）。
  beforeAll(() => import('@/components/settings/system/SystemPage.vue'))

  /** 打开 reka Select 下拉（SelectTrigger pointerdown 开启，portal 挂 body；同 provider-edit-modal 模式）。 */
  async function openSelect(testid: string): Promise<HTMLElement[]> {
    const trigger = pageWrapper()!.find(`[data-testid="${testid}"]`).element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()
    return Array.from(document.body.querySelectorAll('[role="option"]'))
  }

  /** 点选下拉中含指定文案的 option。 */
  async function pickOption(labels: HTMLElement[], text: string): Promise<void> {
    const target = labels.find((el) => (el.textContent ?? '').includes(text))
    expect(target, `option containing "${text}" should exist`).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
  }

  /** 指令计数用例共用：custom 风格（空指令）挂载，返回页面 wrapper。 */
  async function mountCustomInstructionPage(): Promise<NonNullable<ReturnType<typeof pageWrapper>>> {
    settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '', corrupted: false })
    await mountSection()
    return pageWrapper()!
  }

  /**
   * 指令计数用例共用骨架：写入文本 → 断言计数文案、警示样式与保存键禁用态
   * （overLimit = 码点数超 2000 的期望形态）。
   */
  async function assertCharCountState(
    w: NonNullable<ReturnType<typeof pageWrapper>>,
    text: string,
    expectedCount: string,
    overLimit: boolean,
  ): Promise<void> {
    await w.find('[data-testid="rename-instruction-input"]').setValue(text)
    expect(w.find('[data-testid="rename-instruction-charcount"]').text()).toContain(expectedCount)
    if (overLimit) {
      expect(w.find('[data-testid="rename-instruction-charcount"]').classes()).toContain('text-warn')
      expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeDefined()
    } else {
      expect(w.find('[data-testid="rename-instruction-charcount"]').classes()).not.toContain('text-warn')
      expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeUndefined()
    }
  }

  beforeEach(() => {
    seedStore()
  })

  describe('RenameSessionPage 首屏冒烟（迁移回归锚）', () => {
    it('SystemPage 编排下不再渲染自动重命名区块（已迁独立页），页头含新页入口不在此层断言', async () => {
      await mountPage()
      expect(document.body.querySelector('[data-testid="setting-auto-rename-session"]')).toBeNull()
      expect(document.body.querySelector('[data-testid="rename-session-page"]')).toBeNull()
    })
  })

  describe('RenameSessionPage 直挂', () => {
    it('冒烟：开关 checked + 触发模式/模型/最大长度/风格/textarea 均渲染（用户可见 DOM）', async () => {
      await mountSection()
      const w = pageWrapper()!
      expect(w.find('[data-testid="rename-enabled-switch"]').attributes('data-state')).toBe('checked') // Switch on 态（开关默认开）
      expect(w.find('[data-testid="rename-trigger-mode"]').exists()).toBe(true)
      expect(w.find('[data-testid="rename-title-model"]').exists()).toBe(true)
      expect(w.find('[data-testid="rename-max-length"]').exists()).toBe(true)
      expect(w.find('[data-testid="rename-prompt-style"]').exists()).toBe(true)
      expect(w.find('[data-testid="rename-instruction-input"]').exists()).toBe(true)
      expect(w.text()).toContain('会话重命名')
    })

    it('触发模式下拉只含两档（agent-tool 从 GUI 移除，底层工具保留不受此影响）', async () => {
      await mountSection()
      const labels = await openSelect('rename-trigger-mode')
      const texts = labels.map((el) => el.textContent ?? '')
      expect(texts).toContain('首次请求时')
      expect(texts).toContain('首轮回复完成')
      expect(texts.join('|')).not.toContain('agent 自主命名')
    })

    it('getRenameMode 回填 first-prompt → trigger 显示「首次请求时」；点选 first-stop 调 setRenameMode', async () => {
      settingsMock.getRenameMode.mockResolvedValue({ mode: 'first-prompt' })
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-trigger-mode"]').text()).toContain('首次请求时')

      const labels = await openSelect('rename-trigger-mode')
      await pickOption(labels, '首轮回复完成')
      expect(settingsMock.setRenameMode).toHaveBeenCalledWith('first-stop')
    })

    it('模型 ref 在可选列表 → trigger 显示模型名；stale ref → 显示 ref +（不可用）', async () => {
      settingsMock.getRenameModel.mockResolvedValue({ model: 'p1/m1' })
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('Model One')

      pageWrapper()!.unmount()
      settingsMock.getRenameModel.mockResolvedValue({ model: 'gone/model-x' })
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('gone/model-x')
      expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('（不可用）')
    })

    it('未设置模型 → trigger 显示「跟随会话模型」', async () => {
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('跟随会话模型')
    })

    it('auto-rename 关 → 模型 trigger disabled；开 → 可用', async () => {
      settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-title-model"]').attributes('disabled')).toBeDefined()

      pageWrapper()!.unmount()
      settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-title-model"]').attributes('disabled')).toBeUndefined()
    })

    it('模型下拉只列已配凭证模型；点选 Model One → setRenameModel 收 "p1/m1"（迁移用例）', async () => {
      await mountSection()
      const labels = await openSelect('rename-title-model')
      const texts = labels.map((el) => el.textContent ?? '')
      expect(texts).toContain('Model One')
      expect(texts.join('|')).not.toContain('Model Two') // 无凭证 provider 过滤
      expect(texts).toContain('跟随会话模型')

      await pickOption(labels, 'Model One')
      expect(settingsMock.setRenameModel).toHaveBeenCalledWith('p1/m1')
    })

    it('最大长度默认 50；点选 80 → setRenameMaxLength(80)', async () => {
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-max-length"]').text()).toContain('50')

      const labels = await openSelect('rename-max-length')
      await pickOption(labels, '80')
      expect(settingsMock.setRenameMaxLength).toHaveBeenCalledWith(80)
    })
  })

  describe('标题提示词卡（风格 + 自定义指令 + 显式保存）', () => {
    it('默认 slug：textarea 只读预览内置模板，三键禁用（快照干净）', async () => {
      await mountSection()
      const w = pageWrapper()!
      const ta = w.find('[data-testid="rename-instruction-input"]')
      expect(ta.attributes('disabled')).toBeDefined()
      expect(ta.element.value).toContain('slug 式标题')
      for (const id of ['rename-prompt-discard', 'rename-prompt-reset', 'rename-prompt-save']) {
        expect(w.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
      }
    })

    it('custom 回填：textarea 可编辑显示已存指令；示例行随风格切换', async () => {
      settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '生成不超过 12 字的中文标题', corrupted: false })
      await mountSection()
      const w = pageWrapper()!
      const ta = w.find('[data-testid="rename-instruction-input"]')
      expect(ta.attributes('disabled')).toBeUndefined()
      expect(ta.element.value).toBe('生成不超过 12 字的中文标题')
      expect(w.find('[data-testid="rename-style-example"]').text()).toContain('—') // custom 无固定示例

      // 切到 emoji：textarea 变只读预览，示例行显示 emoji 形态（用户可见反馈）
      const labels = await openSelect('rename-prompt-style')
      await pickOption(labels, 'Emoji 点缀')
      expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeDefined()
      expect(w.find('[data-testid="rename-style-example"]').text()).toContain('🔧')
    })

    it('编辑 → 三键启用 → 保存调 setRenamePrompt(custom, 文本) + 快照归零（按钮回禁用）', async () => {
      await mountSection()
      const w = pageWrapper()!
      // 切到 custom（style 变更即 dirty）
      const styles = await openSelect('rename-prompt-style')
      await pickOption(styles, '自定义…')
      expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeUndefined()

      // 编辑指令
      await w.find('[data-testid="rename-instruction-input"]').setValue('新指令文本')
      expect(w.find('[data-testid="rename-prompt-discard"]').attributes('disabled')).toBeUndefined()

      await w.find('[data-testid="rename-prompt-save"]').trigger('click')
      await flushPromises()
      expect(settingsMock.setRenamePrompt).toHaveBeenCalledWith('custom', '新指令文本')
      // 保存后快照刷新 → 三键回禁用
      for (const id of ['rename-prompt-discard', 'rename-prompt-reset', 'rename-prompt-save']) {
        expect(w.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
      }
    })

    it('放弃：还原已存快照（dirty 归零，不调 set）', async () => {
      settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '已存指令', corrupted: false })
      await mountSection()
      const w = pageWrapper()!
      await w.find('[data-testid="rename-instruction-input"]').setValue('改了一半')
      await w.find('[data-testid="rename-prompt-discard"]').trigger('click')
      await flushPromises()
      expect((w.find('[data-testid="rename-instruction-input"]').element as HTMLTextAreaElement).value).toBe('已存指令')
      expect(settingsMock.setRenamePrompt).not.toHaveBeenCalled()
    })

    it('恢复默认：slug + 空草稿（编辑态不写盘，保存才生效）', async () => {
      settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '自定义指令', corrupted: false })
      await mountSection()
      const w = pageWrapper()!
      // 先编辑制造 dirty（reset 键 dirty 才可用，与 save/discard 同门控）
      await w.find('[data-testid="rename-instruction-input"]').setValue('改了一半')
      await w.find('[data-testid="rename-prompt-reset"]').trigger('click')
      await flushPromises()
      // 风格回 slug → textarea 只读显示内置预览；保存键仍启用（dirty，等待用户确认）
      expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeDefined()
      expect(w.find('[data-testid="rename-instruction-input"]').element.value).toContain('slug 式标题')
      expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeUndefined()
      expect(settingsMock.setRenamePrompt).not.toHaveBeenCalled()

      await w.find('[data-testid="rename-prompt-save"]').trigger('click')
      await flushPromises()
      expect(settingsMock.setRenamePrompt).toHaveBeenCalledWith('slug', '自定义指令') // 非 custom 保存透传快照原值（保留自定义文本）
    })

    it('超长指令：计数警示 + 保存禁用（2000 上限）', async () => {
      const w = await mountCustomInstructionPage()
      await assertCharCountState(w, 'a'.repeat(2001), '2001/2000', true)
    })

    it('emoji 按码点计数（与 runtime/extension 口径对齐）：1001 个 emoji 可保存、计数为码点数', async () => {
      const w = await mountCustomInstructionPage()
      // 1001 个 emoji 的 UTF-16 .length = 2002（旧口径误判超限），码点数 1001 ≤ 2000 → 可保存
      await assertCharCountState(w, '🔧'.repeat(1001), '1001/2000', false)
      await w.find('[data-testid="rename-prompt-save"]').trigger('click')
      await flushPromises()
      expect(settingsMock.setRenamePrompt).toHaveBeenCalledWith('custom', '🔧'.repeat(1001))
    })

    it('emoji 码点上限：2001 个 emoji（码点数超 2000）计数警示 + 保存禁用', async () => {
      const w = await mountCustomInstructionPage()
      await assertCharCountState(w, '🔧'.repeat(2001), '2001/2000', true)
    })

    it('getRenamePrompt 读失败：横幅可见 + 卡 2 风格/textarea/保存禁用；重试成功后恢复并回填快照', async () => {
      settingsMock.getRenamePrompt.mockRejectedValue(new Error('rpc down'))
      await mountSection()
      const w = pageWrapper()!
      expect(w.find('[data-testid="rename-load-error"]').exists()).toBe(true)
      expect(w.find('[data-testid="rename-prompt-style"]').attributes('disabled')).toBeDefined()
      expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeDefined()
      expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeDefined()

      settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '已存指令', corrupted: false })
      await w.find('[data-testid="rename-load-retry"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="rename-load-error"]').exists()).toBe(false)
      expect((w.find('[data-testid="rename-instruction-input"]').element as HTMLTextAreaElement).value).toBe('已存指令')
      expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeUndefined()
    })

    it('corrupted：提示条渲染', async () => {
      settingsMock.getRenamePrompt.mockResolvedValue({ style: 'slug', instruction: '', corrupted: true })
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-prompt-corrupted"]').exists()).toBe(true)
    })

    it('参考折叠区：展开后展示内置 slug 模板 + 固定 system 骨架', async () => {
      await mountSection()
      expect(pageWrapper()!.find('[data-testid="rename-prompt-ref-content"]').exists()).toBe(false)
      await pageWrapper()!.find('[data-testid="rename-prompt-ref-toggle"]').trigger('click')
      await flushPromises()
      const content = pageWrapper()!.find('[data-testid="rename-prompt-ref-content"]').text()
      expect(content).toContain('slug 式标题')
      expect(content).toContain('只输出标题文本')
    })
  })
})

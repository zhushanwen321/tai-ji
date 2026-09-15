/**
 * SystemPromptPage 渲染与交互测试（TDD 红灯阶段）。
 *
 * 覆盖：
 *  - 渲染 gate：SettingsModal 切换到「系统提示词」菜单后，页面关键 testid 全部存在。
 *  - 替换卡警告文案可见。
 *  - 保存流：修改替换区 → 开开关 → 点保存 → setSystemPrompt 被调用。
 *  - 失败反馈：setSystemPrompt reject → 出现 error toast。
 *  - 放弃/恢复默认：dirty 才可用，discard 还原已保存快照、reset 清空关开关。
 *  - corrupted：getSystemPrompt 返回 corrupted=true → 页内出现损坏提示。
 *
 * mock 策略：
 *  - vi.mock('@/api') 提供 config.getSystemPrompt / setSystemPrompt，
 *    以及 SettingsModal/store 需要的 config.listProviders / setSkillDirs / setAgentDirs。
 *  - vi.mock('@/i18n') 仅 stub setLocale，保留 t 行为（菜单 key 未翻译时回退 key）。
 *  - Dialog / DialogContent 走 reka-ui teleport 到 body，查询走 document.body。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/system-prompt-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useToast } from '@/composables/useToast'

interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}

function defaultConfig(): SystemPromptConfig {
  return {
    version: 1,
    replace: { enabled: false, prompt: '' },
    append: { enabled: false, prompt: '' },
  }
}

const configMock = vi.hoisted(() => ({
  getSystemPrompt: vi.fn(() => Promise.resolve({ config: defaultConfig(), corrupted: false })),
  setSystemPrompt: vi.fn((cfg: SystemPromptConfig) => Promise.resolve({ config: cfg, corrupted: false })),
  listProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  // SettingsModal → ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(() => Promise.resolve({ refreshed: [], failed: [] })),
  setSkillDirs: vi.fn(() => Promise.resolve()),
  setAgentDirs: vi.fn(() => Promise.resolve()),
  // wave-oauth：SettingsModal → ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
}))

const settingsMock = vi.hoisted(() => ({
  getSystem: vi.fn(() => Promise.resolve({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
  updateSystem: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: configMock,
  settings: settingsMock,
}))

vi.mock('@/i18n', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  setLocale: vi.fn(),
}))

import SettingsModal from '@/components/settings/SettingsModal.vue'

let wrapper: ReturnType<typeof mount> | null = null

/** 在 teleport 目标 document.body 中查找元素并包装成 DOMWrapper */
function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  expect(node).toBeTruthy()
  return new DOMWrapper(node!)
}

/** 检查 document.body 中是否存在指定 data-testid 的元素 */
function hasTestId(id: string): boolean {
  return document.body.querySelector(`[data-testid="${id}"]`) !== null
}

beforeEach(() => {
  setActivePinia(createPinia())
  const { toasts } = useToast()
  toasts.value = []
  configMock.getSystemPrompt.mockClear()
  configMock.setSystemPrompt.mockClear()
  configMock.listProviders.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/**
 * 打开 SettingsModal 并切换到「系统提示词」菜单。
 * 用 nav 按钮顺序定位（systemPrompt 是第 5 个菜单项，index 4），不依赖 textContent。
 */
async function openSystemPromptPage(): Promise<void> {
  wrapper = mount(SettingsModal, {
    props: { open: true },
    attachTo: document.body,
  })
  await flushPromises()

  // 用 data-testid 定位（menus 已标注 settings-nav-${id}），不依赖 nav button 索引——
  // 索引定位会因 nav 内新增非菜单按钮（如顶部退出按钮）而整体偏移，脆弱。
  const systemPromptBtn = document.body.querySelector('[data-testid="settings-nav-system-prompt"]')
  expect(systemPromptBtn).toBeTruthy()
  systemPromptBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

describe('SystemPromptPage 渲染 gate', () => {
  it('切换到系统提示词菜单后，页面所有关键 testid 存在于 DOM', async () => {
    await openSystemPromptPage()

    const requiredIds = [
      'system-prompt-page',
      'system-prompt-replace-switch',
      'system-prompt-replace-input',
      'system-prompt-replace-save',
      'system-prompt-append-switch',
      'system-prompt-append-input',
      'system-prompt-append-save',
    ]
    for (const id of requiredIds) {
      expect(hasTestId(id)).toBe(true)
    }
  })

  it('替换卡警告文案可见', async () => {
    await openSystemPromptPage()
    const page = document.body.querySelector('[data-testid="system-prompt-page"]')
    expect(page).toBeTruthy()
    expect(page!.textContent).toContain('新建会话')
  })
})

describe('SystemPromptPage 保存交互', () => {
  it('修改替换区并保存后调用 setSystemPrompt 并反馈成功 toast', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: defaultConfig(),
      corrupted: false,
    })
    configMock.setSystemPrompt.mockResolvedValueOnce({
      config: {
        version: 1,
        replace: { enabled: true, prompt: '自定义系统提示词' },
        append: { enabled: false, prompt: '' },
      },
      corrupted: false,
    })

    await openSystemPromptPage()

    // 开启替换开关
    await $('[data-testid="system-prompt-replace-switch"]').trigger('click')
    // 在替换 textarea 输入文本
    await $('[data-testid="system-prompt-replace-input"]').setValue('自定义系统提示词')
    // 点击保存
    await $('[data-testid="system-prompt-replace-save"]').trigger('click')
    await flushPromises()

    expect(configMock.setSystemPrompt).toHaveBeenCalledTimes(1)
    const payload = configMock.setSystemPrompt.mock.calls[0]![0] as SystemPromptConfig
    expect(payload.replace.enabled).toBe(true)
    expect(payload.replace.prompt).toBe('自定义系统提示词')

    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'info')).toBe(true)
  })

  it('setSystemPrompt 失败时显示 error toast', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: defaultConfig(),
      corrupted: false,
    })
    configMock.setSystemPrompt.mockRejectedValueOnce(new Error('保存失败'))

    await openSystemPromptPage()

    await $('[data-testid="system-prompt-replace-switch"]').trigger('click')
    await $('[data-testid="system-prompt-replace-input"]').setValue('任意文本')
    await $('[data-testid="system-prompt-replace-save"]').trigger('click')
    await flushPromises()

    expect(configMock.setSystemPrompt).toHaveBeenCalledTimes(1)
    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('保存失败'))).toBe(true)
  })

  it('修改后点「放弃」还原已保存快照，编辑态回退且保存按钮禁用', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: {
        version: 1,
        replace: { enabled: true, prompt: '已保存的提示词' },
        append: { enabled: false, prompt: '' },
      },
      corrupted: false,
    })

    await openSystemPromptPage()

    // 编辑态：修改 textarea 文本 → dirty → 放弃按钮可用
    await $('[data-testid="system-prompt-replace-input"]').setValue('未保存的修改')
    const discardBtn = $('[data-testid="system-prompt-replace-discard"]')
    expect(discardBtn.attributes('disabled')).toBeUndefined()

    // 放弃 → textarea 还原为快照值、放弃按钮禁用（dirty 归零）
    await discardBtn.trigger('click')
    await flushPromises()

    const input = $('[data-testid="system-prompt-replace-input"]')
    expect((input.element as HTMLTextAreaElement).value).toBe('已保存的提示词')
    expect($('[data-testid="system-prompt-replace-discard"]').attributes('disabled')).toBeDefined()
    expect(configMock.setSystemPrompt).not.toHaveBeenCalled()
  })

  it('替换卡「恢复默认」清空文本并关开关（编辑态，需保存生效）', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: {
        version: 1,
        replace: { enabled: true, prompt: '已保存的提示词' },
        append: { enabled: false, prompt: '' },
      },
      corrupted: false,
    })

    await openSystemPromptPage()

    // 开启状态下文本非空 → dirty 由 enabled 翻转产生（enabled 未变时需先改文本）
    await $('[data-testid="system-prompt-replace-input"]').setValue('临时改动')
    await $('[data-testid="system-prompt-replace-reset"]').trigger('click')
    await flushPromises()

    const input = $('[data-testid="system-prompt-replace-input"]')
    expect((input.element as HTMLTextAreaElement).value).toBe('')
    expect((input.element as HTMLTextAreaElement).disabled).toBe(true) // 开关已关，textarea 禁用
    expect(configMock.setSystemPrompt).not.toHaveBeenCalled()
  })
})

describe('SystemPromptPage corrupted 提示', () => {
  it('getSystemPrompt 返回 corrupted=true 时页内出现损坏提示', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: defaultConfig(),
      corrupted: true,
    })

    await openSystemPromptPage()

    const page = document.body.querySelector('[data-testid="system-prompt-page"]')
    expect(page).toBeTruthy()
    const text = page!.textContent ?? ''
    expect(text.includes('已损坏') || text.includes('回退默认') || text.includes('损坏')).toBe(true)
  })
})

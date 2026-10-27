import { expectCorruptedHint, expectErrorToastSaved } from '../helpers/settings-page-asserts';
import { $, hasTestId, openSettingsModalPage, setupSystemPromptPageHarness, systemPromptApiModule, systemPromptConfigMock as configMock, systemPromptDefaultConfig as defaultConfig, systemPromptI18nModule, type SystemPromptConfig } from '../helpers/system-prompt-page-harness';
import SettingsModal from '@/components/settings/SettingsModal.vue';
import { useToast } from '@/composables/useToast';
import { DEFAULT_PI_SYSTEM_PROMPT, DEFAULT_PI_SYSTEM_PROMPT_VERSION } from '@taiji/shared';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← default-prompt-reference.test.ts
// ======================================================================

vi.mock('@/api', () => systemPromptApiModule())
vi.mock('@/i18n', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  setLocale: vi.fn(),
}))

// beforeEach 重置（pinia / toast / 捕获单例计数 / transport 桩）+ afterEach 卸载清 body +
// SettingsModal 挂载切菜单单源在 helpers/system-prompt-page-harness
setupSystemPromptPageHarness()

async function openSystemPromptPage(): Promise<void> {
  await openSettingsModalPage(SettingsModal, 'system-prompt')
}

describe('DEFAULT_PI_SYSTEM_PROMPT 常量', () => {
  it('导出非空字符串，含 pi 核心身份描述', () => {
    expect(typeof DEFAULT_PI_SYSTEM_PROMPT).toBe('string')
    expect(DEFAULT_PI_SYSTEM_PROMPT.length).toBeGreaterThan(100)
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('coding assistant')
  })

  it('DEFAULT_PI_SYSTEM_PROMPT_VERSION 标注 pi 版本', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('默认提示词参考区', () => {
  it('页面含折叠 toggle 按钮（默认折叠，参考区内容不可见）', async () => {
    await openSystemPromptPage()
    expect(hasTestId('system-prompt-default-toggle')).toBe(true)
    // 默认折叠：content 不在 DOM 或不可见
    expect(hasTestId('system-prompt-default-content')).toBe(false)
  })

  it('点击 toggle 展开后，参考区显示默认提示词内容', async () => {
    await openSystemPromptPage()
    await $('[data-testid="system-prompt-default-toggle"]').trigger('click')
    await flushPromises()
    expect(hasTestId('system-prompt-default-content')).toBe(true)
    const content = $('[data-testid="system-prompt-default-content"]')
    expect(content.element.textContent).toContain('coding assistant')
  })

  it('参考区含说明文案（动态段不受影响）', async () => {
    await openSystemPromptPage()
    await $('[data-testid="system-prompt-default-toggle"]').trigger('click')
    await flushPromises()
    const page = document.body.querySelector('[data-testid="system-prompt-page"]')
    expect(page).toBeTruthy()
    const text = page!.textContent ?? ''
    expect(text.includes('动态段') || text.includes('不受影响') || text.includes('AGENTS')).toBe(true)
  })

  it('展开后含复制按钮（testid 存在）', async () => {
    await openSystemPromptPage()
    await $('[data-testid="system-prompt-default-toggle"]').trigger('click')
    await flushPromises()
    expect(hasTestId('system-prompt-default-copy')).toBe(true)
  })
})

// ======================================================================
// ← system-prompt-page.test.ts
// ======================================================================

// 合并产物：@/api + @/i18n vi.mock 与 harness 脚手架只注册一次（上方首段），
// 二次注册会叠两套 beforeEach/afterEach（双 teardown 清 body 后 unmount 抛错）。

/** 打开 SettingsModal 并切换到「系统提示词」菜单（挂载/切换编排单源在 helpers/system-prompt-page-harness.ts） */
async function openSystemPromptPage_m2(): Promise<void> {
  await openSettingsModalPage(SettingsModal, 'system-prompt')
}

/** 点保存 → flush → 断言 setSystemPrompt 恰好一次，返回首调 payload（替换/追加卡共用） */
async function saveAndGetPayload(selector: string): Promise<SystemPromptConfig> {
  await $(selector).trigger('click')
  await flushPromises()
  expect(configMock.setSystemPrompt).toHaveBeenCalledTimes(1)
  return configMock.setSystemPrompt.mock.calls[0]![0] as SystemPromptConfig
}

/** 预置「已保存替换提示词」的已存态 stub（放弃/恢复默认两用例的公共基线） */
function stubSavedReplacePrompt(): void {
  configMock.getSystemPrompt.mockResolvedValueOnce({
    config: {
      version: 1,
      replace: { enabled: true, prompt: '已保存的提示词' },
      append: { enabled: false, prompt: '' },
    },
    corrupted: false,
  })
}

describe('SystemPromptPage 渲染 gate', () => {
  it('切换到系统提示词菜单后，页面所有关键 testid 存在于 DOM', async () => {
    await openSystemPromptPage_m2()

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
    await openSystemPromptPage_m2()
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

    await openSystemPromptPage_m2()

    // 开启替换开关
    await $('[data-testid="system-prompt-replace-switch"]').trigger('click')
    // 在替换 textarea 输入文本
    await $('[data-testid="system-prompt-replace-input"]').setValue('自定义系统提示词')
    // 点击保存
    const payload = await saveAndGetPayload('[data-testid="system-prompt-replace-save"]')
    expect(payload.replace.enabled).toBe(true)
    expect(payload.replace.prompt).toBe('自定义系统提示词')

    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'info')).toBe(true)
  })

  it('修改追加区并保存后调用 setSystemPrompt（payload 含 append 段，两卡共用同一保存动作）', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: defaultConfig(),
      corrupted: false,
    })
    configMock.setSystemPrompt.mockResolvedValueOnce({
      config: {
        version: 1,
        replace: { enabled: false, prompt: '' },
        append: { enabled: true, prompt: '追加段落内容' },
      },
      corrupted: false,
    })

    await openSystemPromptPage_m2()

    // 开启追加开关 + 输入追加文本 + 点追加卡保存按钮（与替换卡共用同一 createExplicitSave 动作）
    await $('[data-testid="system-prompt-append-switch"]').trigger('click')
    await $('[data-testid="system-prompt-append-input"]').setValue('追加段落内容')
    const payload = await saveAndGetPayload('[data-testid="system-prompt-append-save"]')
    expect(payload.append.enabled).toBe(true)
    expect(payload.append.prompt).toBe('追加段落内容')

    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'info')).toBe(true)
  })

  it('setSystemPrompt 失败时显示 error toast', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({
      config: defaultConfig(),
      corrupted: false,
    })
    configMock.setSystemPrompt.mockRejectedValueOnce(new Error('保存失败'))

    await openSystemPromptPage_m2()

    await $('[data-testid="system-prompt-replace-switch"]').trigger('click')
    await $('[data-testid="system-prompt-replace-input"]').setValue('任意文本')
    await saveAndGetPayload('[data-testid="system-prompt-replace-save"]')
    expectErrorToastSaved('保存失败')
  })

  it('RD-4#7：保存 in-flight 期间保存按钮禁用（saving 检查，防 65s 窗口重复点击并发覆盖）', async () => {
    configMock.getSystemPrompt.mockResolvedValueOnce({ config: defaultConfig(), corrupted: false })
    let resolveSave!: (v: { config: SystemPromptConfig; corrupted: boolean }) => void
    configMock.setSystemPrompt.mockImplementationOnce(
      () => new Promise((r) => { resolveSave = r }),
    )

    await openSystemPromptPage_m2()

    await $('[data-testid="system-prompt-replace-switch"]').trigger('click')
    await $('[data-testid="system-prompt-replace-input"]').setValue('自定义提示词')
    await saveAndGetPayload('[data-testid="system-prompt-replace-save"]')
    // in-flight：保存按钮禁用（!replaceDirty || saving）
    expect(($('[data-testid="system-prompt-replace-save"]').element as HTMLButtonElement).disabled).toBe(true)

    resolveSave({ config: defaultConfig(), corrupted: false })
    await flushPromises()
    expect(configMock.setSystemPrompt).toHaveBeenCalledTimes(1)
  })

  it('修改后点「放弃」还原已保存快照，编辑态回退且保存按钮禁用', async () => {
    stubSavedReplacePrompt()

    await openSystemPromptPage_m2()

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
    stubSavedReplacePrompt()

    await openSystemPromptPage_m2()

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

    await openSystemPromptPage_m2()

    expectCorruptedHint('system-prompt-page')
  })
})

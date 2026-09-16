/**
 * ProviderPage 导入入口测试（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * 覆盖：
 * - T10：mount ProviderPage（空 providers），断言 import-providers-menu 渲染
 * - T10b：点击菜单项 → previewImportProviders 被调 + 对话框打开
 * - T10c：完整 apply 流程（选源 → 预览 → 勾选默认项 → 确认 → applyImportProviders 被调 → 对话框关闭 + success toast）
 * - T10d：preview transport reject（Promise.reject）→ importState 回 idle，菜单按钮重新可点
 * - T10e：apply transport reject（Promise.reject）→ importState 回 previewing，对话框仍开允许重试
 * - T10f：apply envelope error（{ error: {...} }）→ importState 回 previewing，对话框仍开 + error 区域显示
 * - T10g：apply 结果带 quotaAutoEnabled（单条）→ 额度自动开启 toast 含 provider name
 * - T10h：多条 quotaAutoEnabled → 聚合 count toast；未标记条目不额外提示
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 config 门面替成可控 mock（listProviders 空 providers 结果 + previewImportProviders fixture）
 *  - createPinia + setActivePinia 让 useSettingsStore/useQuotaStore 正常初始化
 *  - useToast 是模块级单例，通过 useToast() 取 toasts.value 断言
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/__tests__/ProviderPage-import.spec.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderImportPreview } from '@taiji/shared'

/** preview fixture（1 个正常 provider，conflict='none' → 默认勾选） */
const PREVIEW: ProviderImportPreview = {
  source: 'claude',
  providers: [
    {
      id: 'openai', name: 'OpenAI', protocol: 'openai-completions', modelCount: 3,
      apiKeyExtracted: true, credentialType: 'plaintext', conflict: 'none', warnings: [],
    },
  ],
}

/** mock config 门面：previewImportProviders 返 fixture，applyImportProviders 返空结果 */
const configMock = vi.hoisted(() => ({
  // 门面签名 { providers, scopedModels }（settings-lifecycle 解构消费）；裸数组解构得 undefined
  listProviders: vi.fn(() => Promise.resolve({ providers: [], scopedModels: undefined })),
  // ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(() => Promise.resolve({ refreshed: [], failed: [] })),
  previewImportProviders: vi.fn(() => Promise.resolve({ importId: 'imp-1', preview: PREVIEW })),
  applyImportProviders: vi.fn(() => Promise.resolve({
    result: { source: 'claude', imported: [{ id: 'openai', name: 'OpenAI', status: 'imported' }], failedCount: 0 },
  })),
  // wave-oauth：ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({
  config: configMock,
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { useToast } from '@/composables/useToast'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // 清空全局 toasts（useToast 模块级单例，跨用例共享）
  useToast().toasts.value = []
  configMock.previewImportProviders.mockReset()
  configMock.applyImportProviders.mockReset()
  // 恢复默认成功返回值（mockReset 清空了实现）
  configMock.previewImportProviders.mockImplementation(() =>
    Promise.resolve({ importId: 'imp-1', preview: PREVIEW }),
  )
  configMock.applyImportProviders.mockImplementation(() =>
    Promise.resolve({
      result: {
        source: 'claude',
        imported: [{ id: 'openai', name: 'OpenAI', status: 'imported' }],
        failedCount: 0,
      },
    }),
  )
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/**
 * 辅助：展开 import-providers-menu 并点击 claude 源项，触发 preview 流程。
 * 调用前需已 mount + flushPromises。
 */
async function selectClaudeSource(): Promise<void> {
  const trigger = wrapper!.find('[data-testid="import-providers-menu"]')
  await trigger.trigger('click')
  await flushPromises()
  const claudeItem = document.querySelector('[data-testid="import-source-claude"]') as HTMLElement | null
  expect(claudeItem).toBeTruthy()
  claudeItem!.click()
  await flushPromises()
}

describe('ProviderPage 导入入口', () => {
  it('T10: 空 providers 时 import-providers-menu 渲染', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="import-providers-menu"]').exists()).toBe(true)
  })

  it('T10b: 点击菜单项 claude → previewImportProviders 被调 + 对话框打开', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    // previewImportProviders 以 'claude' 被调
    expect(configMock.previewImportProviders).toHaveBeenCalledWith('claude')
    // 对话框渲染：preview-provider-item（fixture 1 项）
    const items = document.querySelectorAll('[data-testid="preview-provider-item"]')
    expect(items.length).toBe(1)
  })

  it('T10c: 完整 apply 流程 — 勾选默认项 → 确认 → applyImportProviders 被调 → 对话框关闭 + success toast', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    // 默认勾选 conflict='none' 的 openai，直接点确认
    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    // applyImportProviders 以 ('imp-1', ['openai']) 被调
    expect(configMock.applyImportProviders).toHaveBeenCalledWith('imp-1', ['openai'])
    // 对话框内容消失（importState 回 idle → open=false）
    expect(document.querySelectorAll('[data-testid="preview-provider-item"]').length).toBe(0)
    // success toast 渲染（导入 1 个）
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'info' && t.message.includes('1'))).toBe(true)
  })

  it('T10d: preview transport reject (Promise.reject) → importState 回 idle，菜单按钮重新可点', async () => {
    configMock.previewImportProviders.mockImplementationOnce(() =>
      Promise.reject(new Error('timeout')),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    // reject 被 catch：importState 回 idle，对话框未渲染
    expect(document.querySelectorAll('[data-testid="preview-provider-item"]').length).toBe(0)
    // error toast 渲染
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'error' && t.message === 'timeout')).toBe(true)
  })

  it('T10e: apply transport reject (Promise.reject) → importState 回 previewing，对话框仍开允许重试', async () => {
    configMock.applyImportProviders.mockImplementationOnce(() =>
      Promise.reject(new Error('ws closed')),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    // reject 被 catch：importState 回 previewing（非 idle），对话框仍开。
    // 错误内联区域渲染（DialogContent 走 Teleport，preview-error 在 body 即证明 dialog open）
    const errorEl = document.body.querySelector('[data-testid="preview-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toContain('ws closed')
    // error toast 渲染
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'error' && t.message === 'ws closed')).toBe(true)
  })

  it('T10f: apply envelope error ({ error: {...} }) → importState 回 previewing，对话框仍开 + error 区域显示', async () => {
    configMock.applyImportProviders.mockImplementationOnce(() =>
      Promise.resolve({ error: { code: 'PREVIEW_EXPIRED', message: 'preview 已过期，请重新检测' } }),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    // envelope error：importState 回 previewing（非 idle），对话框仍开。
    // 错误内联区域渲染含消息（DialogContent 走 Teleport，preview-error 在 body 即证明 dialog open）
    const errorEl = document.body.querySelector('[data-testid="preview-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toContain('preview 已过期')
  })

  it('T10g: apply 结果带 quotaAutoEnabled（单条）→ 额度自动开启 toast 含 provider name', async () => {
    configMock.applyImportProviders.mockImplementationOnce(() =>
      Promise.resolve({
        result: {
          source: 'claude',
          imported: [{ id: 'openai', name: 'OpenAI', status: 'imported', quotaAutoEnabled: true }],
          failedCount: 0,
        },
      }),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    // 用户可见 DOM 断言：额度自动开启 toast（quotaAutoEnabledOne 含 name；
    // success toast 只含 count 不含 name，其余凭据形态 toast 对 plaintext 不触发）
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'info' && t.message.includes('OpenAI'))).toBe(true)
  })

  it('T10h: 多条 quotaAutoEnabled → 聚合 count toast；未标记条目不额外提示', async () => {
    configMock.applyImportProviders.mockImplementationOnce(() =>
      Promise.resolve({
        result: {
          source: 'claude',
          imported: [
            { id: 'a', name: 'Alpha', status: 'imported', quotaAutoEnabled: true },
            { id: 'b', name: 'Beta', status: 'imported', quotaAutoEnabled: true },
            { id: 'c', name: 'Gamma', status: 'imported' },
          ],
          failedCount: 0,
        },
      }),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    // 聚合 toast 含 count=2（quotaAutoEnabledMany）；success toast 含 3，不含 2；
    // 未标记的 Gamma 不出现专属提示
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'info' && t.message.includes('2'))).toBe(true)
    expect(toasts.some((t) => t.type === 'info' && t.message.includes('Gamma'))).toBe(false)
  })
})

/**
 * Provider 导入预览对话框——孤儿凭据组 2 渲染测试（sa3 F1 · B.6）。
 *
 * 覆盖 8 用例：
 *  - t1-t2：组 2 渲染（标题/内置模板徽章/凭据形式/底部常驻提示）+ 展开内置 model 列表
 *  - t3：勾选孤儿凭据 → confirm emit 含孤儿 providerId（默认勾选）
 *  - t4：组 2 六态徽章全分支可渲染（plaintext/env/env-bundle/oauth/command/missing）
 *  - t5：组 1 env-bundle 新徽章分支（credentialType==='env-bundle' 的 UI 分支补齐）
 *  - t6：凭据形式占位串（$VAR / OAuth token / !Command / API Key，不含 key 明文）
 *  - t7：未匹配孤儿凭据不进组 2（顶层 warnings 横幅渲染，B.6「无法匹配内置模板，跳过」）
 *  - t8：组 1 + 组 2 混合渲染（两组标题同时存在）
 *
 * mock 策略（对齐 provider-builtin-ui.test.ts）：
 *  - vue-i18n 由 vitest-i18n-setup.ts 全局 mock（t() 从 zh-CN locale 取值）
 *  - reka-ui Dialog 经 Portal teleport 到 document.body：mount attachTo body 后，
 *    portal 内容用 document.body.querySelector 查询；事件用原生 HTMLElement.click()
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/provider-import-preview.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderImportPreview, ProviderPreviewItem, ProviderPreviewOrphanItem } from '@taiji/shared'

import { ProviderImportPreviewDialog } from '@taiji/ui/features/settings'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** body 内元素点击（portal 内容触发 Vue @click） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

/** 构造组 1 项（models.json provider）。 */
function g1(overrides: Partial<ProviderPreviewItem> = {}): ProviderPreviewItem {
  return {
    id: 'zhipu',
    name: 'zhipu',
    protocol: 'openai-completions',
    modelCount: 2,
    apiKeyExtracted: true,
    credentialType: 'plaintext',
    conflict: 'none',
    warnings: [],
    ...overrides,
  }
}

/** 构造组 2 项（孤儿凭据）。 */
function g2(overrides: Partial<ProviderPreviewOrphanItem> = {}): ProviderPreviewOrphanItem {
  return {
    providerId: 'openai',
    name: 'OpenAI',
    credentialType: 'plaintext',
    builtinTemplateMatched: true,
    modelCount: 38,
    modelNames: ['gpt-4', 'gpt-4o', 'gpt-5'],
    apiKeyExtracted: true,
    warnings: [],
    ...overrides,
  }
}

function previewWith(orphans: ProviderPreviewOrphanItem[], providers: ProviderPreviewItem[] = [g1()]): ProviderImportPreview {
  return { source: 'pi', providers, orphanCredentials: orphans }
}

async function mountDialog(preview: ProviderImportPreview): Promise<void> {
  wrapper = mount(ProviderImportPreviewDialog, {
    props: { open: true, preview },
    attachTo: document.body,
  })
  await flushPromises()
}

describe('ProviderImportPreviewDialog · orphan credentials group (sa3 F1)', () => {
  it('t1: 组 2 渲染——标题 + 内置模板徽章 + 凭据形式 + 底部常驻提示', async () => {
    await mountDialog(previewWith([g2()]))

    // 组 2 标题
    const group2 = document.body.querySelector('[data-testid="group-2-title"]')
    expect(group2).toBeTruthy()
    expect(group2!.textContent).toContain('额外凭据')
    // 孤儿凭据项 + 内置模板徽章
    const item = document.body.querySelector('[data-testid="preview-orphan-item"]')
    expect(item).toBeTruthy()
    expect(item!.textContent).toContain('OpenAI')
    expect(document.body.querySelector('[data-testid="orphan-builtin-badge"]')).toBeTruthy()
    // 底部常驻提示（auth.json 不含模型信息）
    const hint = document.body.querySelector('[data-testid="orphan-bottom-hint"]')
    expect(hint).toBeTruthy()
    expect(hint!.textContent).toContain('auth.json 不含模型信息')
    // 统计含孤儿凭据数
    expect(document.body.textContent).toContain('1 个额外凭据')
  })

  it('t2: 展开内置 model 列表——chevron 点击 → model 名 + 模型数 + 模型来源说明', async () => {
    await mountDialog(previewWith([g2()]))

    // 初始未展开
    expect(document.body.querySelector('[data-testid="orphan-models-expand"]')).toBeNull()
    clickBody('[data-testid="orphan-expand-toggle"]')
    await flushPromises()

    const expand = document.body.querySelector('[data-testid="orphan-models-expand"]')
    expect(expand).toBeTruthy()
    expect(expand!.textContent).toContain('38 个内置模型')
    // model 名列表
    expect(expand!.textContent).toContain('gpt-4')
    expect(expand!.textContent).toContain('gpt-5')
    // 模型来源说明（B.6）
    expect(expand!.textContent).toContain('pi-ai 内置 catalog')
  })

  it('t3: 孤儿凭据默认勾选 → confirm emit 的 selectedIds 含孤儿 providerId', async () => {
    wrapper = mount(ProviderImportPreviewDialog, {
      props: { open: true, preview: previewWith([g2({ providerId: 'anthropic', name: 'Anthropic' })]) },
      attachTo: document.body,
    })
    await flushPromises()

    clickBody('[data-testid="confirm-import-btn"]')
    await flushPromises()

    // 组 1 默认勾选项（zhipu）+ 孤儿默认勾选项（anthropic）
    const emitted = wrapper!.emitted('confirm')
    expect(emitted).toBeTruthy()
    const ids = emitted![0][0] as string[]
    expect(ids).toContain('anthropic')
    expect(ids).toContain('zhipu')
  })

  it('t4: 组 2 六态徽章全分支可渲染（plaintext/env/env-bundle/oauth/command/missing）', async () => {
    const orphans = [
      g2({ providerId: 'a', name: 'A', credentialType: 'plaintext' }),
      g2({ providerId: 'b', name: 'B', credentialType: 'env', envVarName: 'MY_VAR' }),
      g2({ providerId: 'c', name: 'C', credentialType: 'env-bundle', apiKeyExtracted: false }),
      g2({ providerId: 'd', name: 'D', credentialType: 'oauth', apiKeyExtracted: false }),
      g2({ providerId: 'e', name: 'E', credentialType: 'command' }),
      g2({ providerId: 'f', name: 'F', credentialType: 'missing', apiKeyExtracted: false }),
    ]
    await mountDialog(previewWith(orphans))

    const testids = [
      'orphan-badge-plaintext',
      'orphan-badge-env',
      'orphan-badge-env-bundle',
      'orphan-badge-oauth',
      'orphan-badge-command',
      'orphan-badge-missing',
    ]
    for (const tid of testids) {
      expect(document.body.querySelector(`[data-testid="${tid}"]`)).toBeTruthy()
    }
    // env-bundle 徽章文案（新态）
    const envBundleBadge = document.body.querySelector('[data-testid="orphan-badge-env-bundle"]')
    expect(envBundleBadge!.textContent).toContain('Env 包')
  })

  it('t5: 组 1 env-bundle 新徽章分支（六态补齐）', async () => {
    const providers = [
      g1({ id: 'deepseek', name: 'deepseek', credentialType: 'env-bundle', apiKeyExtracted: false }),
      g1({ id: 'copilot', name: 'copilot', credentialType: 'oauth', apiKeyExtracted: false }),
    ]
    await mountDialog(previewWith([], providers))

    expect(document.body.querySelector('[data-testid="credential-badge-env-bundle"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-badge-oauth"]')).toBeTruthy()
  })

  it('t6: 凭据形式占位串——$VAR / OAuth token / !Command / API Key（不含 key 明文）', async () => {
    const orphans = [
      g2({ providerId: 'envp', name: 'EnvP', credentialType: 'env', envVarName: 'OPENAI_API_KEY' }),
      g2({ providerId: 'oau', name: 'Oau', credentialType: 'oauth', apiKeyExtracted: false }),
      g2({ providerId: 'cmd', name: 'Cmd', credentialType: 'command' }),
      g2({ providerId: 'plain', name: 'Plain', credentialType: 'plaintext' }),
    ]
    await mountDialog(previewWith(orphans))

    const bodyText = document.body.textContent!
    // $VAR 占位（env 态具体变量名）
    expect(bodyText).toContain('$OPENAI_API_KEY')
    expect(bodyText).not.toContain('sk-') // 占位串，无 key 明文
    // OAuth token / !Command / API Key 形式占位
    expect(bodyText).toContain('OAuth token')
    expect(bodyText).toContain('!Command')
    expect(bodyText).toContain('API Key')
  })

  it('t7: 未匹配孤儿凭据不进组 2（runtime 侧已进 preview.warnings，UI 顶层横幅展示跳过提示）', async () => {
    const preview: ProviderImportPreview = {
      source: 'pi',
      providers: [g1()],
      warnings: ['credential unknown-provider-taiji: no built-in template match, skipped'],
    }
    await mountDialog(preview)

    // 无组 2（未匹配项不进 orphanCredentials）
    expect(document.body.querySelector('[data-testid="orphan-group"]')).toBeNull()
    // 顶层警告横幅含跳过提示（B.6）
    const banner = document.body.querySelector('[data-testid="preview-top-warnings"]')
    expect(banner).toBeTruthy()
    expect(banner!.textContent).toContain('no built-in template match')
  })

  it('t8: 组 1 + 组 2 混合渲染——两组标题同时存在，组 1 项不受影响', async () => {
    await mountDialog(previewWith([g2()], [g1({ id: 'deepseek', name: 'deepseek', modelCount: 2 })]))

    expect(document.body.querySelector('[data-testid="group-1-title"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="group-2-title"]')).toBeTruthy()
    // 组 1 项正常渲染
    const g1Items = document.body.querySelectorAll('[data-testid="preview-provider-item"]')
    expect(g1Items.length).toBe(1)
    expect(g1Items[0].textContent).toContain('deepseek')
    // 组 2 项
    expect(document.body.querySelectorAll('[data-testid="preview-orphan-item"]').length).toBe(1)
  })
})

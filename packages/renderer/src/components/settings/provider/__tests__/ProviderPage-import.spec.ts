/**
 * Provider 设置页测试（单文件多源合并：2 个源文件，共同装载 vue + shared + settings 域全树）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——2 文件各自装载同批依赖；合并后全簇
 * 用例共享一份装载（约省 0.3s）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - wool-retirement.test.ts（退役羊毛提供方残留扫描，纯文件系统检查）
 *  - ProviderPage-import.spec.ts（ProviderPage 挂载与来源选择）
 *
 * 合并说明：
 *  - @/api mock（config 域部分工厂）仅 ProviderPage-import 节 SUT 消费；wool 节为纯
 *    node:fs/path 静态扫描，不触任何被 mock 模块
 *  - useToast 无 mock（ProviderPage-import 节 hooks 清真实 toasts 数组）
 *  - ProviderPage-import 的顶层 hooks（pinia 重建 / transport 桩注入 / toasts 清零）
 *    幂等，并集为公共 hooks
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/provider/__tests__/ProviderPage-import.spec.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderImportPreview } from '@taiji/shared'

// 工厂绑定 import 必须先于组件 import 求值：ProviderPage 模块图加载 '@/api' 时 vi.mock
// 工厂立即执行，晚于组件 import 的工厂绑定仍在 TDZ（vi.hoisted 同族坑）。
import { subscriptionStubs } from '@/__tests__/helpers/settings-modal-api-mock'
import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { useToast } from '@/composables/useToast'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub'

// ── vi.mock 并集（同模块同工厂已去重）──
// 来源：ProviderPage-import.spec.ts

vi.mock('@/api', () => ({
  config: {
    ...configMock,
    // 订阅成员族单源（键缺导出即 TypeError 崩 mount）：wave-oauth 的 4 个 auth.* 订阅
    // + P2 的 onDefaultsWithSource（默认 pill + 默认修复 toast）
    ...subscriptionStubs([
      'onAuthDeviceCode', 'onAuthAuthUrl', 'onAuthSuccess', 'onAuthError', 'onDefaultsWithSource',
    ]),
  },
}))

// ── 公共 hooks（各源文件顶层 hook 原样并集）──
// 来源：ProviderPage-import.spec.ts
beforeEach(() => {
  setActivePinia(createPinia())
  // [C3] config 门面调用经 SettingsTransport seam 桩注入（同名直映）
  provideSettingsTransport(makeSettingsTransportStub(configMock))
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
// 来源：ProviderPage-import.spec.ts

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// ══════════ 来源：wool-retirement.test.ts（原同目录，已并入本文件） ══════════

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/renderer/src/components/settings/provider/__tests__ → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../../../../../..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

const RETIRED_PATHS = [
  'packages/renderer/src/components/settings/provider/WoolWizard',
  'packages/renderer/src/components/settings/provider/WoolWizard/WoolWizard.vue',
  'packages/renderer/src/components/settings/provider/WoolWizard/WoolEntryCard.vue',
  'packages/renderer/src/components/settings/provider/__tests__/WoolWizard.test.ts',
  'packages/renderer/src/composables/features/settings/useWool.ts',
  'packages/renderer/src/composables/features/settings/useWoolEntries.ts',
  'packages/renderer/src/composables/features/settings/useWoolWizard.ts',
  'packages/renderer/src/composables/features/settings/__tests__/useWool.test.ts',
  'packages/renderer/src/i18n/locales/zh-CN/wool.ts',
  'packages/renderer/src/i18n/locales/en-US/wool.ts',
]

/** 可执行形态的残留引用模式（注释提法不命中） */
const REFERENCE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'import WoolWizard', re: /from\s+['"][^'"]*WoolWizard(?:\/[^'"]*)?['"]/ },
  { label: 'dynamic import WoolWizard', re: /import\(\s*['"][^'"]*WoolWizard[^'"]*['"]\s*\)/ },
  { label: 'import useWool*', re: /from\s+['"][^'"]*\/useWool(?:Entries|Wizard)?(?:\.js)?['"]/ },
  { label: 'WoolWizard tag', re: /<WoolWizard[\s/>]/ },
  { label: 'Wool 子组件 tag', re: /<(?:WoolEntryCard|WoolFamilyCards|WoolOauthFlow|WoolExtractFlow|WoolStepRow)[\s/>]/ },
  { label: 'wool i18n key', re: /\bt\(\s*['"]wool\./ },
]

const SCAN_EXTS = ['.ts', '.vue', '.mts', '.js']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'coverage', '.git'])

function collectSourceFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      collectSourceFiles(abs, out)
      continue
    }
    if (SCAN_EXTS.some((ext) => name.endsWith(ext))) out.push(abs)
  }
}

describe('羊毛旧界面退役（U6 零残留引用）', () => {
  it('退役载体不在盘上', () => {
    for (const rel of RETIRED_PATHS) {
      expect(existsSync(join(REPO_ROOT, rel)), `应已删除：${rel}`).toBe(false)
    }
  })

  it('全仓源码零引用（import / 动态 import / 模板标签 / wool.* i18n key）', () => {
    const files: string[] = []
    const pkgNames = readdirSync(PACKAGES_DIR).filter((n) => statSync(join(PACKAGES_DIR, n)).isDirectory())
    for (const pkg of pkgNames) {
      for (const sub of ['src', 'test']) {
        const dir = join(PACKAGES_DIR, pkg, sub)
        if (existsSync(dir)) collectSourceFiles(dir, files)
      }
    }
    // 其余一级源码目录（非 packages）
    for (const top of ['apps', 'e2e', 'extensions', 'scripts']) {
      const dir = join(REPO_ROOT, top)
      if (existsSync(dir)) collectSourceFiles(dir, files)
    }
    // 扫描规模下限自查（防「零文件扫描 → 全绿」的假阳性）
    expect(files.length).toBeGreaterThan(500)

    const hits: string[] = []
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8')
      for (const { label, re } of REFERENCE_PATTERNS) {
        if (re.test(text)) hits.push(`${label}: ${abs.slice(REPO_ROOT.length + 1)}`)
      }
    }
    expect(hits).toEqual([])
  })
})

// ══════════ 来源：packages/renderer/src/components/settings/provider/__tests__/ProviderPage-import.spec.ts ══════════

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
}))

let wrapper: ReturnType<typeof mount> | null = null


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
    // deferred reject：先断言 in-flight 态 trigger disabled（正向对照），再放行 reject 验证恢复
    let rejectPreview!: (e: Error) => void
    configMock.previewImportProviders.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectPreview = reject }),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    await selectClaudeSource()

    // preview 进行中（loading-preview）：菜单 trigger disabled（:disabled="importState !== 'idle'" 透传）
    const trigger = wrapper.find('[data-testid="import-providers-menu"]')
    expect(trigger.attributes('disabled')).toBeDefined()

    // reject 被 catch：importState 回 idle，对话框未渲染
    rejectPreview(new Error('timeout'))
    await flushPromises()
    expect(document.querySelectorAll('[data-testid="preview-provider-item"]').length).toBe(0)
    // error toast 渲染
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'error' && t.message === 'timeout')).toBe(true)

    // 「回 idle」恢复语义（与「卡在 previewing 空数据」可区分）：
    // ① trigger 解除 disabled
    expect(trigger.attributes('disabled')).toBeUndefined()
    // ② 二次点击 trigger → 候选列表重新展开（菜单按钮重新可点）
    await trigger.trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="import-source-claude"]')).toBeTruthy()
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

  it('RD-4#12: apply 有失败项 → 保留 preview（弹窗不关，用户可回查失败条目）+ failedCount toast', async () => {
    configMock.applyImportProviders.mockImplementationOnce(() =>
      Promise.resolve({
        result: {
          source: 'claude',
          imported: [
            { id: 'openai', name: 'OpenAI', status: 'imported' },
            { id: 'anthropic', name: 'Anthropic', status: 'failed', reason: 'network' },
          ],
          failedCount: 1,
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

    // RD-4#12：有失败项 → 不 resetImportState，preview 保留（弹窗不关，preview-provider-item 仍渲染）。
    // 此前成功后立刻清空 preview，用户无法回查失败条目。
    expect(document.querySelectorAll('[data-testid="preview-provider-item"]').length).toBeGreaterThan(0)
    // failedCount>0 → error toast（reportImportSuccess 既有行为）
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('RD-4#10: refreshProviderCatalogs 有 failed 项 → Picker 头部「目录可能过期」提示', async () => {
    configMock.refreshProviderCatalogs.mockResolvedValueOnce({
      refreshed: [],
      failed: [{ providerId: 'openai', reason: 'timeout' }],
    })
    wrapper = mount(ProviderPage, { props: { providers: [] } })
    await flushPromises()

    // 协议侧 providerCatalogsRefreshed.failed 非空 → catalogsStale 置位 → 头部提示显形
    expect(wrapper.find('[data-testid="provider-catalogs-stale"]').exists()).toBe(true)
  })

  it('RD-4#10: refreshProviderCatalogs reject → 同样标「目录可能过期」（离线不无痕迹）', async () => {
    configMock.refreshProviderCatalogs.mockRejectedValueOnce(new Error('ws closed'))
    wrapper = mount(ProviderPage, { props: { providers: [] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-catalogs-stale"]').exists()).toBe(true)
  })
})

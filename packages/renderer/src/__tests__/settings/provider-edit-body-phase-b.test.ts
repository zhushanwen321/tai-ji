/**
 * ProviderEditBody 契约 v2 + ProviderImportPreviewDialog 单文件合并
 * （round5-d 分区 4 簇 4-5 相容子集）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——两文件同域（provider 设置导入/
 * 编辑）、同装载 @taiji/ui features/settings 全树，单文件共享一份装载。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - provider-edit-body-phase-b.test.ts（契约 v2 接线：readiness/enabled/saveAndTest，主体）
 *  - provider-import-preview.test.ts（孤儿凭据组 2 渲染 sa3 F1 · B.6）
 *
 * 冲突处理（试点模式）：
 *  - 两文件顶层 hook 同构（pinia 重建 + wrapper 卸载 + body 清），幂等并集为
 *    文件级公共 hook 一份，共享一个模块级 wrapper 槽（两节用例互不重叠使用）
 *  - 主体的 quota 域 mock（全 vi.fn 带温和默认 impl）为文件级——import-preview
 *    节的 ProviderImportPreviewDialog 为纯展示对话框，不消费 quota 域，零泄漏
 *  - 主体的 beforeEach 大量 provide（platform/settingsStore/transport）对
 *    import-preview 节无害（Dialog 不消费注入槽）
 *
 * 簇注：同簇的 ProviderPage / settings-resource-page / system-diagnostics-section
 * 不并入——ProviderPage 的 '@/api' config 域 mock、settings-resource 的
 * '@/api/domains/settings' 窄 mock、system-diagnostics 的 '@/lib/ipc' 窄 mock
 * 与 useToast mock 相互泄漏进对方组件树的路径无法静态排除。三文件保持原样。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/provider-edit-body-phase-b.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@taiji/shared'
import { QUOTA_PRESETS } from '@taiji/shared'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  type SettingsTransport,
  type Translate,
  type QuotaConfigureFactoryInputs,
  provideSettingsStore,
  createSettingsStore,
} from '@taiji/core'
import {
  ProviderEditBody,
  ProviderImportPreviewDialog,
  SETTINGS_TOAST_KEY,
  QUOTA_CONFIGURE_FACTORY_KEY,
} from '@taiji/ui/features/settings'
import { useQuotaConfigure } from '@/composables/features/settings/useQuotaConfigure'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import { clickBody } from '../helpers/body-portal-harness'
import type { ProviderImportPreview, ProviderPreviewItem, ProviderPreviewOrphanItem } from '@taiji/shared'
import { inMemoryStorage } from '../helpers/platform-storage-stub'

// [C3] useQuotaConfigure 经 SettingsTransport seam 消费 quota RPC——本域模块 mock 作为 seam 桩
// 函数源（getCachedQuota / configureQuota / refreshQuota 逐名映射，见 makeTransport）。
vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  fetchQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  refreshQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  configure: vi.fn(async () => ({ ok: true })),
}))

// ── 契约 v2 接线 fixture（U5-t2：真实 useQuotaConfigure 驱动 DOM）──

/** cookie 类 + 未保存 cookie：matchQuotaPreset 命中 mimo → readiness 缺 cookie（按钮应置灰） */
const MIMO_NO_COOKIE_P: ProviderInfo = {
  id: 'xiaomi-mimo',
  name: 'Xiaomi MiMo',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'custom',
  baseUrl: 'https://platform.xiaomimimo.com',
  models: [{ id: 'mimo-v2', name: 'MiMo V2' }],
  quota: { fetcher: 'mimo', enabled: true },
}

/** api-key 类且 provider 侧有凭据：matchQuotaPreset 命中 zhipu → readiness 齐备（按钮可点） */
const ZHIPU_READY_P: ProviderInfo = {
  id: 'zhipu',
  name: 'Zhipu GLM',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  baseUrl: 'https://open.bigmodel.cn/api',
  models: [{ id: 'glm-4', name: 'GLM-4.6', source: 'builtin' }],
  quota: { fetcher: 'zhipu', enabled: true },
}

/** api-key 类但 provider 侧无凭据：matchQuotaPreset 命中 zhipu → 凭证警示区可见（§7.4 两套文案） */
const ZHIPU_NO_KEY_P: ProviderInfo = {
  id: 'zhipu-nokey',
  name: 'Zhipu GLM',
  api: 'openai-completions',
  apiKeySet: false,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  baseUrl: 'https://open.bigmodel.cn/api',
  models: [{ id: 'glm-4', name: 'GLM-4.6', source: 'builtin' }],
  quota: { fetcher: 'zhipu', enabled: true },
}

// ── transport stub（save 路径 spy）──

const setProviderSpy = vi.fn(async () => undefined)

/** [C3] 共享 seam 桩工厂（全方法侧中性默认）+ 本文件 spy/映射（保存 spy + quota RPC）。 */
function makeTransport(): SettingsTransport {
  return makeSettingsTransportStub({
    setProvider: setProviderSpy,
    getCachedQuota: quotaApi.getCached,
    refreshQuota: quotaApi.refreshQuota,
    configureQuota: quotaApi.configure,
  })
}

// in-memory KVStorage 桩单源在 helpers/platform-storage-stub（providePlatform storage 形状）

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  // W3c 后 quota presets 数据源 = runtime 下发的合并视图（store 默认空数组）；测试无 runtime，
  // 灌编译期基线等价（基线正是无远程覆盖时的合并视图原样）
  const settingsStore = createSettingsStore()
  settingsStore.setQuotaPresets([...QUOTA_PRESETS])
  provideSettingsStore(settingsStore)
  providePlatform({
    kind: 'mock',
    storage: inMemoryStorage(),
    webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
  })
  provideSettingsTransport(makeTransport())
  setProviderSpy.mockClear()
  vi.mocked(quotaApi.configure).mockClear()
  vi.mocked(quotaApi.refreshQuota).mockClear()
  vi.mocked(quotaApi.getCached).mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount ProviderEditBody（注入 quota 工厂 + toast；attachTo 供 Dialog teleport 查询） */
function mountBody(provider: ProviderInfo, props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderEditBody, {
    props: { provider, oauthPresent: false, oauthSupported: true, ...props },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY]: useToast(),
        // 壳层同款包装：业务输入归 ProviderEditBody 物化点，t 由包装函数注入
        [QUOTA_CONFIGURE_FACTORY_KEY]: (inputs: QuotaConfigureFactoryInputs) =>
          useQuotaConfigure({ ...inputs, t: i18n.global.t as Translate }),
      },
    },
  })
}

// ══ 契约 v2 真实接线（U5-t2：注入真实 useQuotaConfigure，断言 DOM 与 RPC payload）══════════

/**
 * 覆盖设计条款（coding-plan-quota-config-ux §7.2 / D1 / D2 / D3 / D4）：
 * - D1：readiness 置灰随草稿实时变化（「填参数时立刻知道还差什么」）
 * - D4：拨开关只构造 { providerId, enabled }，零网络副作用（不偷偷落盘草稿、不发查询）
 * - D2：单按钮「保存并测试」= 先落盘（configure）再查询（refresh），顺序可证
 * - D3：凭证来源切换进 payload（credentialSource 恒传），专属 Key 草稿进 apiKey
 *
 * 三视角：用户可见 DOM（按钮 disabled / 字段级提示文案）+ RPC spy 白盒佐证。
 * 渲染器 i18n 未 mock（vitest-i18n-setup 真实 zh-CN）→ 文案断言中文，同时验证 21 个新 key 真实存在。
 */
describe('契约 v2 接线：readiness / setEnabled / saveAndTest（真实 composable）', () => {
  const SAVE_TEST = '[data-testid="quota-save-test-btn"]'

  /** 当前按钮的 disabled 态（用户可见形态） */
  function saveDisabled(): boolean {
    return wrapper!.find<HTMLButtonElement>(SAVE_TEST).element.disabled
  }

  it('D1：cookie 类未保存 cookie → 按钮置灰且提示「这里必须填」；输入草稿后按钮变亮、提示消失', async () => {
    wrapper = mountBody(MIMO_NO_COOKIE_P)
    await flushPromises()

    // 首屏：类型已选（mimo 命中 preset）→ 参数区渲染，但缺 cookie → 按钮不可点
    expect(wrapper.find(SAVE_TEST).exists()).toBe(true)
    expect(saveDisabled()).toBe(true)
    const hint = wrapper.find('[data-testid="quota-missing-cookie"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('这里必须填')

    // 用户粘贴 cookie（草稿）→ readiness 重算 → 置灰解除、字段提示消失（不需要先点按钮才报错）
    await wrapper.find('[data-testid="quota-cookie-input"]').setValue('raw-cookie-draft')
    await flushPromises()
    expect(saveDisabled()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
  })

  it('D4：拨开关 → configure 只收 { providerId, enabled }（草稿键一律缺省），且不发任何查询', async () => {
    const configureSpy = vi.mocked(quotaApi.configure)
    const refreshSpy = vi.mocked(quotaApi.refreshQuota)
    wrapper = mountBody(ZHIPU_READY_P)
    await flushPromises()

    // 开局（quota.enabled=true）只读缓存，不发 refresh
    expect(refreshSpy).not.toHaveBeenCalled()

    const sw = wrapper.find('[data-testid="quota-enabled-switch"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    await flushPromises()

    expect(configureSpy).toHaveBeenCalledTimes(1)
    const payload = configureSpy.mock.calls[0]![0] as Record<string, unknown>
    // 单键落盘：多出 fetcher / credentialSource / 凭证键即「拨开关偷偷落盘草稿」
    expect(Object.keys(payload).sort()).toEqual(['enabled', 'providerId'])
    expect(payload.providerId).toBe('zhipu')
    expect(payload.enabled).toBe(false)
    // D4 边界：开关零网络副作用
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('D2：点「保存并测试」→ 完整草稿 payload 落盘，成功后再 refresh（先落盘再查询，顺序可证）', async () => {
    const configureSpy = vi.mocked(quotaApi.configure)
    const refreshSpy = vi.mocked(quotaApi.refreshQuota)
    wrapper = mountBody(ZHIPU_READY_P)
    await flushPromises()

    expect(saveDisabled()).toBe(false)
    await wrapper.find(SAVE_TEST).trigger('click')
    await flushPromises()

    expect(configureSpy).toHaveBeenCalledTimes(1)
    const payload = configureSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.providerId).toBe('zhipu')
    expect(payload.enabled).toBe(true)
    expect(payload.fetcher).toBe('zhipu')
    // D3：来源恒传（幂等显式化磁盘字段）
    expect(payload.credentialSource).toBe('provider')
    // 未填的敏感字段不传值（cookie/apiKey undefined = 保留既存；workspace 非资源维度不传）
    expect(payload.workspace).toBeUndefined()
    expect(payload.apiKey).toBeUndefined()

    // 硬约束：runtime 从落盘读凭据 → configure 必须先于 refresh
    expect(refreshSpy).toHaveBeenCalledWith('zhipu')
    expect(configureSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      refreshSpy.mock.invocationCallOrder[0]!,
    )
  })

  it('D3：切「用专属 Key」并填 Key → payload.credentialSource=exclusive + apiKey=草稿（UI 说的就是 runtime 用的）', async () => {
    const configureSpy = vi.mocked(quotaApi.configure)
    wrapper = mountBody(ZHIPU_READY_P)
    await flushPromises()

    // 切来源 → 专属 Key 块出现，未填 Key 时按钮置灰（readiness 同步）
    await wrapper.find('[data-testid="quota-source-exclusive-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
    expect(saveDisabled()).toBe(true)

    await wrapper.find('[data-testid="quota-apikey-input"]').setValue('sk-exclusive-draft')
    await flushPromises()
    expect(saveDisabled()).toBe(false)

    await wrapper.find(SAVE_TEST).trigger('click')
    await flushPromises()

    const payload = configureSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.credentialSource).toBe('exclusive')
    expect(payload.apiKey).toBe('sk-exclusive-draft')
  })

  it('§7.4 跨区块时序：provider 表单填 API Key（未保存）→ 警示从「还没有」切「已填写，保存后即可查询」', async () => {
    wrapper = mountBody(ZHIPU_NO_KEY_P)
    await flushPromises()

    // 首屏：来源=provider 且 provider 侧无凭据 → 「还没有可用的 API Key」警示 + 按钮置灰
    const warn = () => wrapper!.find('[data-testid="quota-provider-credential-warning"]')
    expect(warn().exists()).toBe(true)
    expect(warn().text()).toContain('还没有可用的 API Key')
    expect(saveDisabled()).toBe(true)

    // 表单里填 Key（尚未保存 provider）→ carry-in 槽位（providerApiKeyDraft）驱动文案切换：
    // 用户可见差异 =「按钮灰但屏幕上明明填了 Key」的矛盾消除（指引先保存 provider）
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-draft-key')
    await flushPromises()
    expect(warn().text()).toContain('已填写 API Key，保存 provider 配置后即可查询')
    expect(warn().text()).not.toContain('还没有可用的 API Key')
    expect(saveDisabled()).toBe(true) // runtime 仍读不到（provider 未保存），齐备性不变

    // 草稿清空（删除已输入内容）→ 文案退回「还没有」
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('')
    await flushPromises()
    expect(warn().text()).toContain('还没有可用的 API Key')
  })
})


// ══════════ 来源：provider-import-preview.test.ts（孤儿凭据组 2 渲染；顶层 hook 已并入
//             文件级公共 hook，wrapper 槽共享主体声明） ══════════

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

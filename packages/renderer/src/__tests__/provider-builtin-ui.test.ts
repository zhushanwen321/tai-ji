/**
 * 簇 1-2 合并产物（round5-f U1，主文件 provider-builtin-ui）。
 *
 * 来源（基名）：
 *   - provider-builtin-ui.test.ts（主文件，13 例）
 *   - components/UpdateButton.test.ts（15 例）
 *   - composables/mermaid.test.ts（5 例）
 *   - components/UpdateButton.w3-acceptance.test.ts（3 例）
 *   - components/ActivityStrip.test.ts（3 例）
 *   - composables/find/find-bar.test.ts（5 例）
 *
 * 改造登记（保留式 mock，模板参照 command-popover-landing 先例）：
 *   - '@/api' 原窄替换（仅 config + default 两键）改为 spread actual 全门面 +
 *     仅覆写 config（configWithAuth 含 auth.* 订阅捕获集）；actual 无 default
 *     出口，防御性 default 键按原意图保留为「spread + config 覆写」形态。
 *
 * 剔出：components/sidebar-crud-error-handling.test.ts（2 例，单文件保留）——
 * 其 '@/composables/useToast' 窄替换 mock 与主文件节的真实 toasts 断言互斥、
 * 其 '@taiji/core/transport/api' 三键窄替换与 spread 后的真实 @/api 门面互斥，
 * 双硬冲突不适用保留式，剔出守恒（期望数 46 → 44）。
 *
 * 合并纪律：describe/it 名零改动；各节原文件级钩子下沉包裹层 describe；
 * UpdateButton 两节的 __APP_VERSION__ stubGlobal 由模块级移入各自节内
 * beforeEach（值分别保持 0.0.0-test / 0.9.7，组件渲染期读取，语义不变）；
 * ActivityStrip 节排最后（其 ResizeObserver stub 不外泄进更早执行的他节）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { BuiltinProviderTemplate } from '@taiji/shared'

// @/api mock：ProviderPage onMounted 调 listBuiltinProviders（默认空数组，集成用例
// mockResolvedValueOnce 覆盖为模板）；setProvider 桩供保存链路断言。
const configMock = vi.hoisted(() => ({
  listBuiltinProviders: vi.fn(async () => [] as BuiltinProviderTemplate[]),
  // ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
  setProvider: vi.fn(async () => ({})),
  // apikey 自动启用链路（useApiKeyAutoEnable）：写 enabledModels 白名单
  toggleProviderEnabled: vi.fn(async () => {}),
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => ({ providers: [] })),
  deleteProvider: vi.fn(async () => {}),
  // MF-1：QuickSetup 打开前查 auth.json OAuth 凭据（默认无）
  hasOAuth: vi.fn(async () => false),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
}))

// wave-oauth：useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）。
// 组件 import 必须排在本装配与 vi.mock 注册之后：vite-node 按源码顺序执行 import，
// 组件链首次拉入 '@/api' 即触发 mock 工厂，装配晚于工厂执行即 TDZ。
import { authEventCbs } from './helpers/oauth-auth-events-mock'

const configWithAuth = { ...configMock, ...authEventCbs() }

// [U1 保留式改造] 原窄替换 { config, default: { config } } → spread 全门面 + 仅覆写 config
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    config: configWithAuth,
    // 防御性 default 键（actual 无 default 出口），其余域经 spread 回真实
    default: { ...actual, config: configWithAuth },
  }
})

// UpdateButton 两节共用：真实控制器注入（helpers/update-card-mock.ts）
import { getCardUpdateHarness, makeCardRelease, resetCardUpdateHarness, setCardUpdateState, useAppUpdateCardModule } from '@/__tests__/helpers/update-card-mock'

vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())

// ActivityStrip 节状态源 mock：组件消费方仅三读口（occupancy 派生视图 turn / compacting / reason）
const chatState = vi.hoisted(() => ({
  turn: 'idle' as 'idle' | 'dispatching' | 'generating' | 'settling',
  compacting: false,
  reason: undefined as string | undefined,
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    sessionPhase: () => ({ turn: chatState.turn, compacting: chatState.compacting, bash: false }),
    isCompacting: () => chatState.compacting,
    getCompactingReason: () => chatState.reason,
  }),
}))

import { ProviderQuickSetup as QuickSetup } from '@taiji/ui/features/settings'
import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { useToast } from '@/composables/useToast'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from './helpers/settings-transport-stub'
import { clickBody, setBodyInput, pointerBody } from './helpers/body-portal-harness'
import UpdateButton from '@/components/sidebar/UpdateButton.vue'
import { MermaidRenderer } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import FindBar from '@/components/find/FindBar.vue'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'
import ActivityStrip from '@/components/panel/message-stream/ActivityStrip.vue'

/* ════════ 来源：provider-builtin-ui.test.ts（主文件） ════════ */

describe('provider-builtin-ui', () => {
  // ── fixture：4 个内置 provider 模板 ──
  const TEMPLATES: BuiltinProviderTemplate[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      authMode: 'api_key',
      envVars: ['OPENAI_API_KEY'],
      oauthSupported: false,
      modelCount: 5,
      models: [
        { id: 'gpt-4.1', name: 'GPT-4.1', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'], contextWindow: 1000000 },
        { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'], contextWindow: 1000000 },
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      authMode: 'both',
      envVars: ['ANTHROPIC_API_KEY'],
      oauthSupported: true,
      modelCount: 3,
      models: [
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', reasoning: false, input: ['text', 'image'], contextWindow: 200000 },
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
      ],
    },
    {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v2',
      authMode: 'oauth',
      envVars: [],
      oauthSupported: true,
      modelCount: 2,
      models: [],
    },
    {
      id: 'google-vertex',
      name: 'Google Vertex AI',
      api: 'google-vertex',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      authMode: 'ambient',
      envVars: [],
      oauthSupported: false,
      modelCount: 6,
      models: [],
    },
  ]

  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    // 集成链路用例需从零计数断言 setProvider/toggleProviderEnabled 调用次数
    configMock.setProvider.mockClear()
    configMock.toggleProviderEnabled.mockClear()
    // [C3] config 门面调用经 SettingsTransport seam 桩注入（同名直映，含 auth.* 订阅捕获集）
    provideSettingsTransport(makeSettingsTransportStub(configWithAuth))
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  describe('ProviderQuickSetup', () => {
    it('t4b F3 默认凭据模式：envVars 非空默认环境变量（env select 可见，无需手动切）', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[0], open: true }, // openai, envVars=[OPENAI_API_KEY]
        attachTo: document.body,
      })
      await flushPromises()
      // 默认 env（F3）：环境变量 select 渲染，明文输入框不渲染
      expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeTruthy()
      expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
    })

    it('t4c F3 默认凭据模式：envVars 为空回退明文', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[3], open: true }, // google-vertex（ambient，envVars=[]）
        attachTo: document.body,
      })
      await flushPromises()
      // ambient：无凭据输入区，显示云凭证说明
      expect(document.body.querySelector('[data-testid="credential-ambient"]')).toBeTruthy()
      expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
      expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeNull()
    })

    it('t6b F4 自定义环境变量：下拉选「自定义变量名」→ 输入框出现 → 保存 apiKey=$自定义名', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[0], open: true }, // openai
        attachTo: document.body,
      })
      await flushPromises()
      // 打开 Select 选「自定义变量名」（reka Select 由 pointerdown 打开）
      pointerBody('[data-testid="credential-envvar-select"]', 'pointerdown')
      await flushPromises()
      const customItem = Array.from(document.body.querySelectorAll('[role="option"]')).find(
        (el) => el.textContent === '自定义变量名…',
      ) as HTMLElement | undefined
      expect(customItem).toBeTruthy()
      await flushPromises()
      // 选中项由 pointerup 触发（SelectItem handleSelectCustomEvent）
      const opt = customItem as HTMLElement & {
        hasPointerCapture?: (id: number) => boolean
        releasePointerCapture?: (id: number) => void
      }
      if (typeof opt.hasPointerCapture !== 'function') opt.hasPointerCapture = () => false
      if (typeof opt.releasePointerCapture !== 'function') opt.releasePointerCapture = () => {}
      customItem!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
      await flushPromises()
      // 自定义输入框出现
      const customInput = document.body.querySelector<HTMLInputElement>('[data-testid="credential-envvar-custom"]')
      expect(customInput).toBeTruthy()
      setBodyInput('[data-testid="credential-envvar-custom"]', 'MY_OPENAI_KEY')
      await flushPromises()
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()
      const emitted = wrapper.emitted('save')
      expect(emitted).toBeTruthy()
      const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
      expect(payload.data.apiKey).toBe('$MY_OPENAI_KEY')
    })

    it('t9 F1 ambient 模板：无 key 输入、保存可用、payload 不塞 apiKey', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[3], open: true }, // google-vertex
        attachTo: document.body,
      })
      await flushPromises()
      expect(document.body.querySelector('[data-testid="credential-ambient"]')).toBeTruthy()
      const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
      expect(save!.disabled).toBe(false)
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()
      const emitted = wrapper.emitted('save')
      expect(emitted).toBeTruthy()
      const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
      expect(payload.providerId).toBe('google-vertex')
      // ambient 不塞 apiKey
      expect(payload.data.apiKey).toBeUndefined()
      // 防线⑥：只写凭据相关字段（name + authMethod）——模板 baseUrl/api 是快照 artifact 不回传，无 models
      expect(payload.data.name).toBe('Google Vertex AI')
      expect('baseUrl' in payload.data).toBe(false)
      expect('api' in payload.data).toBe(false)
      expect(payload.data.models).toBeUndefined()
    })

    it('t12 MF-1 env 模式自定义变量为空 → 保存禁用（不产生 apiKey:"" 清 OAuth）', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[0], open: true }, // openai, envVars=[OPENAI_API_KEY]
        attachTo: document.body,
      })
      await flushPromises()
      // 默认 env 模式：选「自定义变量名」但留空
      pointerBody('[data-testid="credential-envvar-select"]', 'pointerdown')
      await flushPromises()
      const customItem = Array.from(document.body.querySelectorAll('[role="option"]')).find(
        (el) => el.textContent === '自定义变量名…',
      ) as HTMLElement | undefined
      expect(customItem).toBeTruthy()
      const opt = customItem as HTMLElement & {
        hasPointerCapture?: (id: number) => boolean
        releasePointerCapture?: (id: number) => void
      }
      if (typeof opt.hasPointerCapture !== 'function') opt.hasPointerCapture = () => false
      if (typeof opt.releasePointerCapture !== 'function') opt.releasePointerCapture = () => {}
      customItem!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
      await flushPromises()
      expect(document.body.querySelector('[data-testid="credential-envvar-custom"]')).toBeTruthy()
      // 留空 → 保存禁用；填入变量名 → 恢复可用（渲染 gate：按钮 disabled 态 DOM 断言）
      const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
      expect(save!.disabled).toBe(true)
      setBodyInput('[data-testid="credential-envvar-custom"]', 'MY_OPENAI_KEY')
      await flushPromises()
      expect(save!.disabled).toBe(false)
    })

    it('t13 MF-1 已存 OAuth 配置重开：existingAuthMethod=oauth → 默认恢复 OAuth 选项，保存 payload 无 apiKey', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[1], open: true, existingAuthMethod: 'oauth', oauthAuthorized: true }, // anthropic 已 OAuth
        attachTo: document.body,
      })
      await flushPromises()
      // 默认恢复 OAuth 已授权态（非 env 默认），保存可用
      expect(document.body.querySelector('[data-testid="oauth-authorized"]')).toBeTruthy()
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()
      const emitted = wrapper.emitted('save')
      expect(emitted).toBeTruthy()
      const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
      expect(payload.providerId).toBe('anthropic')
      expect(payload.data.authMethod).toBe('oauth')
      // 不塞 apiKey → config-service 不触发 I9 清理，auth.json OAuth 凭据保留
      expect(payload.data.apiKey).toBeUndefined()
    })

    // ── S-1：resolveInitialAuthMethod 恢复分支覆盖（MF-1 主路径修复的既有回退语义不破坏）──

    it('s1b 已存 api_key 配置重开：默认恢复明文选项', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[0], open: true, existingAuthMethod: 'api_key' },
        attachTo: document.body,
      })
      await flushPromises()
      expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeTruthy()
      expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeNull()
    })

    it('s1d 恢复分支不适用时回退默认：oauth 标注但模板仅 api_key 模式（openai）→ 默认 env', async () => {
      wrapper = mount(QuickSetup, {
        props: { template: TEMPLATES[0], open: true, existingAuthMethod: 'oauth' },
        attachTo: document.body,
      })
      await flushPromises()
      expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeTruthy()
      expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
    })
  })

  // ── ProviderPage 保存集成链路（sa4 Major #3）──

  /**
   * 完整旅程：选模板 → 填 key → 保存 → config.setProvider 被调 + payload 正确 + toast + UI 收尾。
   * toast 是模块级单例（useToast 的 toasts ref），直接读取断言（App 级 ToastContainer 不在测试树内）。
   */
  describe('ProviderPage 内置模板保存链路', () => {
    afterEach(() => {
      // 清理模块级 toast 单例，避免泄漏到其它用例
      useToast().toasts.value = []
    })

    it('t10 选模板 → 切明文填 key → 保存 → setProvider payload 正确（无 models）+ toast + Dialog 关闭', async () => {
      configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
      wrapper = mount(ProviderPage, {
        props: { providers: [] },
        attachTo: document.body,
      })
      await flushPromises()

      // 1. 入口：点「添加供应商」→ 菜单「从内置模板」→ 选 openai（onMounted 拉取 mock 模板）
      clickBody('[data-testid="provider-template-picker"]')
      await flushPromises()
      clickBody('[data-testid="add-menu-builtin"]')
      await flushPromises()
      clickBody('[data-testid="provider-template-openai"]')
      await flushPromises()

      // 2. QuickSetup Dialog 渲染（含 openai 元信息）
      const dialog = document.body.querySelector('[data-testid="provider-quick-setup"]')
      expect(dialog).toBeTruthy()
      expect(dialog!.textContent).toContain('OpenAI')
      expect(dialog!.textContent).toContain('https://api.openai.com/v1')

      // 3. 切明文模式填 key（openai envVars 非空默认 env，需手动切；wave-quick-setup-c：auth-option-*）
      clickBody('[data-testid="auth-option-plaintext"]')
      await flushPromises()
      setBodyInput('[data-testid="credential-apikey-input"]', 'sk-taiji-123')
      await flushPromises()
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()

      // 4. config.setProvider 被调用且 payload 正确（防线⑥：catalog 模板导入只写凭据相关字段）
      expect(configMock.setProvider).toHaveBeenCalledTimes(1)
      expect(configMock.setProvider).toHaveBeenCalledWith('openai', {
        name: 'OpenAI',
        apiKey: 'sk-taiji-123',
        authMethod: 'api_key',
      })
      const payload = configMock.setProvider.mock.calls[0]![1] as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(['apiKey', 'authMethod', 'name'])
      expect(payload.models).toBeUndefined()

      // 5. 成功 toast（i18n toastSuccess = 已添加 {name}）
      expect(useToast().toasts.value.some((t) => t.type === 'info' && t.message.includes('已添加 OpenAI'))).toBe(true)

      // 6. UI 收尾：QuickSetup Dialog 从 body 消失（selectedTemplate 清空 → v-if 卸载）
      expect(document.body.querySelector('[data-testid="provider-quick-setup"]')).toBeNull()
    })

    it('t10b 保存失败 → toast error + Dialog 保持打开（可重试）', async () => {
      configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
      configMock.setProvider.mockRejectedValueOnce(new Error('boom'))
      wrapper = mount(ProviderPage, {
        props: { providers: [] },
        attachTo: document.body,
      })
      await flushPromises()

      clickBody('[data-testid="provider-template-picker"]')
      await flushPromises()
      clickBody('[data-testid="add-menu-builtin"]')
      await flushPromises()
      clickBody('[data-testid="provider-template-anthropic"]')
      await flushPromises()

      // anthropic envVars 非空默认 env 模式，直接保存（不填 key 也能过 env 模式）
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()

      // setProvider 失败 → error toast + Dialog 不关闭
      expect(configMock.setProvider).toHaveBeenCalledTimes(1)
      expect(useToast().toasts.value.some((t) => t.type === 'error' && t.message.includes('boom'))).toBe(true)
      expect(document.body.querySelector('[data-testid="provider-quick-setup"]')).toBeTruthy()
    })

    it('t10c QuickSetup 重配已禁用的 apikey provider → 保存即自动启用（toggleProviderEnabled + toast）', async () => {
      configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
      wrapper = mount(ProviderPage, {
        props: {
          providers: [{
            id: 'openai',
            name: 'OpenAI',
            apiKeySet: true,
            status: 'connected',
            enabled: false, // 被禁用但凭据就绪——自动启用目标形态（setProvider 编辑分支不动白名单的缺口）
            models: [],
          }],
        },
        attachTo: document.body,
      })
      await flushPromises()

      clickBody('[data-testid="provider-template-picker"]')
      await flushPromises()
      clickBody('[data-testid="add-menu-builtin"]')
      await flushPromises()
      clickBody('[data-testid="provider-template-openai"]')
      await flushPromises()

      // 切明文模式填新 key（openai envVars 非空默认 env，需手动切）
      clickBody('[data-testid="auth-option-plaintext"]')
      await flushPromises()
      setBodyInput('[data-testid="credential-apikey-input"]', 'sk-new-456')
      await flushPromises()
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()

      // apikey 保存 → 未启用的 provider 自动启用（写 enabledModels 白名单）+ 提示 toast
      expect(configMock.setProvider).toHaveBeenCalledWith('openai', expect.objectContaining({ apiKey: 'sk-new-456' }))
      expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('openai', true)
      expect(useToast().toasts.value.some((t) => t.type === 'info' && t.message.includes('已自动启用 OpenAI'))).toBe(true)
    })

    it('t10d OAuth 形态保存（不携带 apiKey）→ 不自动启用', async () => {
      configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
      configMock.hasOAuth.mockResolvedValueOnce(true) // anthropic 已授权（oauth radio 可保存）
      wrapper = mount(ProviderPage, {
        props: {
          providers: [{
            id: 'anthropic',
            name: 'Anthropic',
            apiKeySet: true,
            status: 'connected',
            enabled: false,
            models: [],
          }],
        },
        attachTo: document.body,
      })
      await flushPromises()

      clickBody('[data-testid="provider-template-picker"]')
      await flushPromises()
      clickBody('[data-testid="add-menu-builtin"]')
      await flushPromises()
      clickBody('[data-testid="provider-template-anthropic"]')
      await flushPromises()

      // oauth radio（已授权可直接保存，payload 无 apiKey）
      clickBody('[data-testid="auth-option-oauth"]')
      await flushPromises()
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()

      // OAuth 保存不触发自动启用（范围外：仅 apikey 模式生效）
      expect(configMock.setProvider).toHaveBeenCalledWith('anthropic', expect.objectContaining({ authMethod: 'oauth' }))
      expect(configMock.toggleProviderEnabled).not.toHaveBeenCalled()
    })

    it('t14 MF-1 残余路径：auth.json 已有 OAuth 但 models.json 无条目（未保存即关闭的授权）→ 重开默认 OAuth radio + 已授权态，保存 payload 无 apiKey', async () => {
      configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
      configMock.hasOAuth.mockResolvedValueOnce(true) // auth.json 有 anthropic OAuth（从未保存过 → providers=[]，existingAuthMethod=undefined）
      wrapper = mount(ProviderPage, {
        props: { providers: [] },
        attachTo: document.body,
      })
      await flushPromises()

      // 选 anthropic 模板（both 模式 + envVars 非空——正是「默认 env radio 盲保存清 OAuth」的危险场景）
      clickBody('[data-testid="provider-template-picker"]')
      await flushPromises()
      clickBody('[data-testid="add-menu-builtin"]')
      await flushPromises()
      clickBody('[data-testid="provider-template-anthropic"]')
      await flushPromises()

      // 默认恢复 OAuth radio（非 env 盲保存）：已授权态可见 + 保存可用（hasOAuth → oauthAuthorized）
      expect(document.body.querySelector('[data-testid="oauth-authorized"]')).toBeTruthy()
      expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeNull()
      const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
      expect(save!.disabled).toBe(false)

      // 保存 → 无 apiKey → config-service 不触发 I9 清理，auth.json OAuth 凭据保留
      // 防线⑥：payload 只含 name/authMethod（模板 baseUrl/api 快照 artifact 不回传）
      clickBody('[data-testid="provider-quick-setup-save"]')
      await flushPromises()
      expect(configMock.setProvider).toHaveBeenCalledWith('anthropic', {
        name: 'Anthropic',
        authMethod: 'oauth',
      })
      const payload = configMock.setProvider.mock.calls[0]![1] as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(['authMethod', 'name'])
    })
  })
})

/* ════════ 来源：components/UpdateButton.test.ts ════════ */

describe('UpdateButton', () => {
  beforeEach(() => {
    // __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
    vi.stubGlobal('__APP_VERSION__', '0.0.0-test')
    resetCardUpdateHarness()
  })

  describe('UpdateButton', () => {
    it('W4TC6d：idle 不渲染（v-if 排除）', () => {
      setCardUpdateState({ state: 'idle' })
      const wrapper = mount(UpdateButton)
      expect(wrapper.find('[data-testid="update-button"]').exists()).toBe(false)
    })

    it('W4TC6d：checking 也不渲染', () => {
      setCardUpdateState({ state: 'checking' })
      const wrapper = mount(UpdateButton)
      expect(wrapper.find('[data-testid="update-button"]').exists()).toBe(false)
    })

    it('W4TC6：available 渲染红点角标 + releaseNotesHtml 已注入（ref 有值）', async () => {
      const notesHtml = '<h2>新特性</h2>'
      setCardUpdateState({
        state: 'available',
        releaseNotesHtml: notesHtml,
      })
      const wrapper = mount(UpdateButton)
      const available = wrapper.find('[data-testid="update-available"]')
      expect(available.exists()).toBe(true)
      // 红点角标存在
      expect(wrapper.find('[data-testid="update-badge"]').exists()).toBe(true)
    })

    it('W4TC9：available click 触发 performDownload', async () => {
      // latestRelease 前置：controller.performDownload 无 release 短路不调 ipc（真实检查语义）
      setCardUpdateState({ state: 'available', latestRelease: makeCardRelease('0.9.0') })
      const wrapper = mount(UpdateButton)
      await wrapper.find('[data-testid="update-available"]').trigger('click')
      expect(getCardUpdateHarness().ipc.updateDownload).toHaveBeenCalledTimes(1)
      expect(getCardUpdateHarness().ipc.updateDownload).toHaveBeenCalledWith('0.9.0')
    })

    it('W4TC7：downloading 渲染 spinner + 进度条 + 百分比文案', () => {
      setCardUpdateState({ state: 'downloading', percent: 42 })
      const wrapper = mount(UpdateButton)
      const progress = wrapper.find('[data-testid="update-progress"]')
      expect(progress.exists()).toBe(true)
      // 百分比文案
      expect(progress.text()).toContain('42%')
      // 进度条子条 width 样式（:style 绑定渲染进 HTML style 属性）
      const bar = progress.find('.bg-accent')
      expect(bar.exists()).toBe(true)
      expect(bar.html()).toContain('width: 42%')
    })

    it('W4TC6b：restarting 渲染 CheckCircle2 + 文案', () => {
      setCardUpdateState({ state: 'restarting' })
      const wrapper = mount(UpdateButton)
      const restarting = wrapper.find('[data-testid="update-restarting"]')
      expect(restarting.exists()).toBe(true)
      // zh-CN 文案（vitest-i18n-setup 从 zh-CN/sidebar 取值）
      expect(restarting.text()).toContain('即将重启')
    })

    it('W4TC6c：error 渲染 AlertCircle + 错误文案', () => {
      setCardUpdateState({ state: 'error', errorMessage: '校验失败' })
      const wrapper = mount(UpdateButton)
      const errorEl = wrapper.find('[data-testid="update-error"]')
      expect(errorEl.exists()).toBe(true)
      expect(errorEl.text()).toContain('升级失败')
    })

    it('W4TC8：unsupported 渲染「前往下载」按钮，click 触发 openExternal', async () => {
      // 摆 latestRelease：真实链 available → main 推送 unsupported 错误时 release 数据保留，
      // controller.openFallbackUrl 前置 latestRelease 提供 htmlUrl（无 release 时短路不调 ipc）
      setCardUpdateState({ state: 'unsupported', latestRelease: makeCardRelease('0.9.0') })
      const wrapper = mount(UpdateButton)
      const unsupported = wrapper.find('[data-testid="update-unsupported"]')
      expect(unsupported.exists()).toBe(true)
      expect(unsupported.text()).toContain('前往下载')

      await unsupported.trigger('click')
      expect(getCardUpdateHarness().ipc.openExternal).toHaveBeenCalledTimes(1)
      expect(getCardUpdateHarness().ipc.openExternal).toHaveBeenCalledWith('https://example.com/release')
    })

    it('replacing 渲染 spinner + 「替换中」文案', () => {
      setCardUpdateState({ state: 'replacing' })
      const wrapper = mount(UpdateButton)
      const replacing = wrapper.find('[data-testid="update-replacing"]')
      expect(replacing.exists()).toBe(true)
      expect(replacing.text()).toContain('替换中')
    })

    // ── W3 downloaded 分支 + 确认 Dialog + error 重试 ──
    // Dialog/HoverCard content 经 Teleport 挂到 document.body；用例末尾 wrapper.unmount()
    // 让 Vue 同步移除 teleport 节点，避免污染后续用例的 document.body.querySelector。
    // 禁止用 document.body.innerHTML='' 强删——会破坏 Vue 内部 vnode 引用，触发 unmount 崩溃。

    /** W3 downloaded 确认 Dialog 用例公共前置：进 downloaded 态 + mount + 点开确认 Dialog */
    async function mountDownloadedDialog() {
      setCardUpdateState({ state: 'downloaded', latestRelease: makeCardRelease('0.9.0') })
      const wrapper = mount(UpdateButton)
      await wrapper.find('[data-testid="update-downloaded"]').trigger('click')
      await nextTick()
      return wrapper
    }

    /** 点击确认安装按钮（Dialog content 经 Teleport 挂到 document.body，wrapper.find 不可见） */
    async function clickConfirmInstall(): Promise<void> {
      const confirmBtn = document.body.querySelector('[data-testid="update-confirm-install"]') as HTMLButtonElement | null
      expect(confirmBtn).not.toBeNull()
      confirmBtn!.click()
      await flushPromises()
    }

    it('W3TC1：downloaded 渲染 CheckCircle2 + 行内短文案「重启」，title 保留完整语义', () => {
      setCardUpdateState({ state: 'downloaded', latestRelease: makeCardRelease('0.9.0') })
      const wrapper = mount(UpdateButton)
      const downloaded = wrapper.find('[data-testid="update-downloaded"]')
      expect(downloaded.exists()).toBe(true)
      // 行内短文案（sidebar 单行宽度契约，2026-10-21 裁决）；完整语义在 title
      expect(downloaded.text()).toContain('重启')
      expect(downloaded.attributes('title')).toContain('已下载，重启安装')
    })

    it('W3TC2：downloaded click 弹确认 Dialog', async () => {
      const wrapper = await mountDownloadedDialog()
      // Dialog content 经 DialogPortal(Teleport) 挂到 document.body，wrapper.find 不可见
      const confirmBtn = document.body.querySelector('[data-testid="update-confirm-install"]')
      expect(confirmBtn).not.toBeNull()
      expect(document.body.textContent).toContain('重启并安装更新')
      wrapper.unmount()
    })

    it('W3TC3：确认安装调 performInstall', async () => {
      const wrapper = await mountDownloadedDialog()
      await clickConfirmInstall()
      expect(getCardUpdateHarness().ipc.updateInstall).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('W3TC4：稍后关闭 Dialog 不调 install', async () => {
      const wrapper = await mountDownloadedDialog()
      // installLater 按钮（靠文案定位，与 confirm-install 区分）
      const laterBtn = Array.from(document.body.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('稍后再说'))
      expect(laterBtn).toBeTruthy()
      laterBtn!.click()
      await nextTick()
      await flushPromises()
      expect(getCardUpdateHarness().ipc.updateInstall).not.toHaveBeenCalled()
      // Dialog 关闭：确认安装按钮不再可见（reka-ui Presence 卸载 content）
      expect(document.body.querySelector('[data-testid="update-confirm-install"]')).toBeNull()
      wrapper.unmount()
    })

    /**
     * W3 error 态 hover 用例公共前置：fake timers + 进 error 态 + mount + hover 打开卡片。
     * reka-ui HoverCard openDelay 默认 700ms，fake timer 推进 800ms 触发 open；
     * setCardUpdateState 必须先于 mount（组件读 state 决定渲染分支）。调用方负责
     * finally 里 wrapper.unmount() + vi.useRealTimers()。
     */
    async function mountErrorHover() {
      vi.useFakeTimers()
      setCardUpdateState({ state: 'error', errorMessage: '校验失败' })
      const wrapper = mount(UpdateButton)
      await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
      vi.advanceTimersByTime(800)
      await nextTick()
      return wrapper
    }

    it('W3TC5：error 态 hover 后显重试按钮', async () => {
      const wrapper = await mountErrorHover()
      try {
        const retry = document.body.querySelector('[data-testid="update-retry"]')
        expect(retry).not.toBeNull()
      } finally {
        wrapper.unmount()
        vi.useRealTimers()
      }
    })

    it('W3TC6：点 retry 回 available 态', async () => {
      const wrapper = await mountErrorHover()
      try {
        const retry = document.body.querySelector('[data-testid="update-retry"]') as HTMLButtonElement | null
        expect(retry).not.toBeNull()
        retry!.click()
        await nextTick()
        // onRetry 设 state.state='available'；controller.state 与组件 state 同一引用
        expect(getCardUpdateHarness().controller.state.state).toBe('available')
      } finally {
        wrapper.unmount()
        vi.useRealTimers()
      }
    })
  })
})

/* ════════ 来源：composables/mermaid.test.ts ════════ */

describe('MermaidRenderer 节', () => {
  // renderMermaid 经 deps 注入：mock 返回可控 svg
  const mockRenderMermaid = vi.fn()

  const SAMPLE_SVG = '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'

  function mountMermaid(source: string) {
    return mount(MermaidRenderer, {
      props: { source },
      global: { provide: mockChatProvide({ renderMermaid: mockRenderMermaid }) },
    })
  }

  beforeEach(() => {
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  })

  describe('MermaidRenderer（W5）', () => {
    beforeEach(() => {
      mockRenderMermaid.mockReset()
      mockRenderMermaid.mockResolvedValue({ svg: SAMPLE_SVG })
    })

    it('U14: dark 主题挂载 → renderMermaid 调用 + SVG 注入 DOM', async () => {
      const wrapper = mountMermaid('graph TD;A-->B')
      await nextTick()
      await nextTick() // 等 doRender 的 await resolve
      expect(mockRenderMermaid).toHaveBeenCalledWith('graph TD;A-->B', 'dark')
      // SVG 注入 inline 容器（.md-mermaid__inline）
      expect(wrapper.find('.md-mermaid__inline').html()).toContain('<svg')
    })

    it('U15: 主题切换 → 重新 renderMermaid（新主题）', async () => {
      const wrapper = mountMermaid('graph TD;A-->B')
      await nextTick()
      await nextTick()
      expect(mockRenderMermaid).toHaveBeenLastCalledWith(expect.any(String), 'dark')
      // 模拟主题切到 light：设置 <html data-theme>（ui getCurrentTheme 纯 DOM 读取）
      document.documentElement.setAttribute('data-theme', 'light')
      await nextTick()
      await nextTick()
      expect(mockRenderMermaid).toHaveBeenLastCalledWith(expect.any(String), 'light')
      document.documentElement.removeAttribute('data-theme')
    })

    it('U12: 渲染失败 → 显示「渲染失败」+ 源码可复制', async () => {
      mockRenderMermaid.mockRejectedValue(new Error('parse error'))
      const wrapper = mountMermaid('invalid mermaid')
      await nextTick()
      await nextTick()
      expect(wrapper.find('.md-mermaid__error').exists()).toBe(true)
      // 错误态文案取自 i18n key panel.mermaid.renderFailed = '图表渲染失败'
      expect(wrapper.text()).toContain('图表渲染失败')
      // 「查看源码」按钮存在（默认折叠，源码未展开时不可见）
      const toggleBtn = wrapper.findAll('button').find((b) => b.text().includes('查看源码'))
      expect(toggleBtn).toBeDefined()
      // 点开折叠看源码
      await toggleBtn!.trigger('click')
      await nextTick()
      expect(wrapper.text()).toContain('invalid mermaid')
    })

    it('U16: 全屏 Dialog 打开 + zoom-in → zoomLabel 增大', async () => {
      const wrapper = mountMermaid('graph TD;A-->B')
      await nextTick()
      await nextTick()
      // 点 inline 图打开全屏
      await wrapper.find('.md-mermaid__inline').trigger('click')
      await nextTick()
      await nextTick()
      // Dialog 经 DialogPortal teleport 到 body → 用 document.body 查找
      const body = document.body
      const labelEl = body.querySelector('.font-mono.text-\\[length\\:var\\(--text-xs\\)\\]') as HTMLElement
      expect(labelEl).toBeTruthy()
      const before = parseInt(labelEl.textContent ?? '0', 10)
      // 点 zoom-in（title="放大"）
      const zoomInBtn = Array.from(body.querySelectorAll('button')).find(
        (b) => b.getAttribute('title') === '放大',
      ) as HTMLButtonElement
      expect(zoomInBtn).toBeTruthy()
      zoomInBtn.click()
      await nextTick()
      const after = parseInt(labelEl.textContent ?? '0', 10)
      expect(after).toBeGreaterThan(before)
    })

    it('U17: 全屏 fit → zoomLabel 回到适配值', async () => {
      const wrapper = mountMermaid('graph TD;A-->B')
      await nextTick()
      await nextTick()
      await wrapper.find('.md-mermaid__inline').trigger('click')
      await nextTick()
      await nextTick()
      const body = document.body
      const labelEl = body.querySelector('.font-mono.text-\\[length\\:var\\(--text-xs\\)\\]') as HTMLElement
      // 先 zoom-in 放大
      const zoomInBtn = Array.from(body.querySelectorAll('button')).find(
        (b) => b.getAttribute('title') === '放大',
      ) as HTMLButtonElement
      zoomInBtn.click()
      await nextTick()
      const zoomed = parseInt(labelEl.textContent ?? '0', 10)
      // 点 fit 适配
      const fitBtn = Array.from(body.querySelectorAll('button')).find(
        (b) => b.getAttribute('title') === '适应窗口',
      ) as HTMLButtonElement
      fitBtn.click()
      await nextTick()
      const fitVal = parseInt(labelEl.textContent ?? '0', 10)
      expect(fitVal).toBeLessThanOrEqual(zoomed)
    })
  })
})

/* ════════ 来源：components/UpdateButton.w3-acceptance.test.ts ════════ */

describe('UpdateButton.w3-acceptance', () => {
  beforeEach(() => {
    // __APP_VERSION__：本节验收断言版本过渡信息含 v0.9.7（原文件模块级 stub 值）
    vi.stubGlobal('__APP_VERSION__', '0.9.7')
    resetCardUpdateHarness()
  })

  describe('W3-A4-update-button-error-overlay-vitest', () => {
    it('W3-A4-update-button-error-overlay-vitest: error 浮层显示 message + suggestion 两段', async () => {
      vi.useFakeTimers()
      setCardUpdateState({
        state: 'error',
        errorMessage: '无法连接代理 (EHOSTUNREACH)',
        errorSuggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络',
      })
      const wrapper = mount(UpdateButton)
      try {
        // 触发 hover 打开 HoverCard
        await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
        vi.advanceTimersByTime(800)
        await nextTick()

        // HoverCard content 经 Teleport 挂到 document.body
        const content = document.body.querySelector('.w-\\[280px\\]')
        expect(content).not.toBeNull()

        // 验证两段式显示：message + suggestion
        const text = content!.textContent ?? ''
        expect(text).toContain('无法连接代理 (EHOSTUNREACH)')
        expect(text).toContain('macOS 未授予「本地网络」权限')
      } finally {
        wrapper.unmount()
        vi.useRealTimers()
      }
    })

    it('W3-A4-update-button-error-overlay-vitest: 无 suggestion 时只显示 message', async () => {
      vi.useFakeTimers()
      setCardUpdateState({
        state: 'error',
        errorMessage: '网络连接失败',
        errorSuggestion: '',
      })
      const wrapper = mount(UpdateButton)
      try {
        await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
        vi.advanceTimersByTime(800)
        await nextTick()

        const content = document.body.querySelector('.w-\\[280px\\]')
        expect(content).not.toBeNull()

        const text = content!.textContent ?? ''
        expect(text).toContain('网络连接失败')
      } finally {
        wrapper.unmount()
        vi.useRealTimers()
      }
    })
  })

  describe('W3-A5-hover-version-vitest', () => {
    it('W3-A5-hover-version-vitest: hover 卡片标题显示版本号', async () => {
      vi.useFakeTimers()
      setCardUpdateState({
        state: 'available',
        latestRelease: makeCardRelease('0.9.9'),
        releaseNotesHtml: '<p>Release notes</p>',
      })
      const wrapper = mount(UpdateButton)
      try {
        // 触发 hover 打开 HoverCard
        await wrapper.find('[data-testid="update-available"]').trigger('pointerenter')
        vi.advanceTimersByTime(800)
        await nextTick()

        // HoverCard content 经 Teleport 挂到 document.body
        const content = document.body.querySelector('.release-notes-content')
        expect(content).not.toBeNull()

        // 验证标题包含版本号
        const text = content!.textContent ?? ''
        expect(text).toContain('v0.9.9')
        // 验证版本过渡信息
        expect(text).toContain('v0.9.7')
        expect(text).toContain('v0.9.9')
      } finally {
        wrapper.unmount()
        vi.useRealTimers()
      }
    })
  })
})

/* ════════ 来源：composables/find/find-bar.test.ts ════════ */

describe('FindBar 节', () => {
  // 原文件用 enableAutoUnmount——它会卸载全局跟踪的全部残留 wrapper（含前序节
  // 未卸载实例，DOM 已被节级清理破坏，nextSibling null 崩）。改为节内手动登记
  // 本节 wrapper，卸载顺序与原文件等价（先卸载、后 find.close + body 清理）。
  const find = useFindInSurface()
  const barWrappers: ReturnType<typeof mount>[] = []

  function mountBar(): ReturnType<typeof mount> {
    const wrapper = mount(FindBar, { props: { surfaceKind: 'right-drawer' }, attachTo: document.body })
    barWrappers.push(wrapper)
    return wrapper
  }

  afterEach(() => {
    for (const w of barWrappers.splice(0)) w.unmount()
    find.close()
    document.body.innerHTML = ''
  })

  describe('FindBar 渲染', () => {
    it('find 关着：不渲染（根 v-if = 开着且开着的是本表面）', () => {
      const wrapper = mountBar()
      expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(false)
    })

    it('开着：渲染输入框 + 0/0 计数 + 导航/关闭按钮（无命中时导航禁用）', async () => {
      const wrapper = mountBar()
      find.open('right-drawer')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="find-bar-input"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="find-bar-count"]').text()).toBe('0/0')
      expect((wrapper.find('[data-testid="find-bar-prev"]').element as HTMLButtonElement).disabled).toBe(true)
      expect((wrapper.find('[data-testid="find-bar-next"]').element as HTMLButtonElement).disabled).toBe(true)
      expect(wrapper.find('[data-testid="find-bar-close"]').exists()).toBe(true)
    })

    it('输入即搜：v-model 写 query → 单例 search 流转出命中计数', async () => {
      const host = document.createElement('div')
      host.setAttribute('data-find-surface', 'right-drawer')
      host.innerHTML = '<p>foo bar</p>'
      document.body.appendChild(host)

      const wrapper = mountBar()
      find.open('right-drawer')
      await wrapper.vm.$nextTick()
      await wrapper.find('input').setValue('foo')
      expect(find.hitCount.value).toBe(1)
      expect(wrapper.find('[data-testid="find-bar-count"]').text()).toBe('1/1')
    })

    it('换表面：本实例因 kind 不匹配隐藏（防双实例同显），新 kind 实例可见', async () => {
      const wrapper = mountBar() // surfaceKind = right-drawer
      find.open('right-drawer')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(true)

      find.open('overlay')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(false)
    })

    it('输入框内按 Esc：关查找（组件内消费，stopPropagation 不冒泡到 window）', async () => {
      const wrapper = mountBar()
      find.open('right-drawer')
      await wrapper.vm.$nextTick()
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      let reachedWindow = false
      const winListener = (): void => { reachedWindow = true }
      window.addEventListener('keydown', winListener)
      try {
        await wrapper.find('input').element.dispatchEvent(esc)
        await wrapper.vm.$nextTick()
      } finally {
        window.removeEventListener('keydown', winListener)
      }
      expect(find.isOpen.value).toBe(false)
      expect(reachedWindow, 'Esc 不冒泡到 window（orchestrator 不会重复消费）').toBe(false)
    })
  })
})

/* ════════ 来源：components/ActivityStrip.test.ts（殿后：ResizeObserver stub 不外泄） ════════ */

// happy-dom 不提供真实 ResizeObserver 布局测量（useConstantHeightAssert dev 断言需要）
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function mountStrip(props: Record<string, unknown> = {}) {
  return mount(ActivityStrip, {
    props: { sessionId: 's-strip-test', ...props },
    attachTo: document.body,
  })
}

describe('ActivityStrip subagentThinking 行渲染（u3-thinking / §6.3）', () => {
  beforeEach(() => {
    chatState.turn = 'idle'
    chatState.compacting = false
    chatState.reason = undefined
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  })

  it('subagentThinking=false（默认）→ 无 thinking 行', () => {
    const wrapper = mountStrip()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('subagentThinking=true → thinking 行出现（文案复用 dispatching key「思考中…」）', () => {
    const wrapper = mountStrip({ subagentThinking: true })
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-text-thinking"]').text()).toContain('思考中')
    wrapper.unmount()
  })

  it('subagentThinking=true 且 turn=dispatching → 仍只有一行，且归三点等待行（demo 裁决 3A：dispatching 优先）', () => {
    chatState.turn = 'dispatching'
    const wrapper = mountStrip({ subagentThinking: true })
    const rows = wrapper.findAll('[data-testid^="activity-strip-row-"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes('data-testid')).toBe('activity-strip-row-waiting')
    wrapper.unmount()
  })
})

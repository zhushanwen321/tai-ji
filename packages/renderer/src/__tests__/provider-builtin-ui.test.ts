/**
 * 内置 Provider 模板 UI 渲染测试（wave 3 · builtin-provider-ui）。
 *
 * 覆盖用例：
 *  - t1-t3 ProviderTemplatePicker：菜单→Dialog 两级结构下列表渲染 / 搜索过滤 / 选中 emit select
 *  - t4-t9 ProviderQuickSetup：信息+凭据渲染 / 明文保存构造 SetProviderData / $ENV 保存 apiKey=$VAR / 自定义变量 / OAuth / ambient / 模型列表
 *  - t7/t11 ProviderPage 首屏冒烟：入口含「添加供应商」菜单（与「从其他 Agent 导入」并列）
 *
 * mock 策略：
 *  - vue-i18n 由 vitest-i18n-setup.ts 全局 mock（t() 从 zh-CN locale 取值）
 *  - @/api 仅 t7 需要（ProviderPage onMounted 调 listBuiltinProviders）
 *
 * reka-ui Popover/Dialog 经 Portal teleport 到 document.body：mount attachTo body 后，
 * portal 内容用 document.body.querySelector 查询；事件用原生 HTMLElement.click()
 * （Vue @click 监听原生 click event，bubbles 生效）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/provider-builtin-ui.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BuiltinProviderTemplate } from '@taiji/shared'

import { ProviderTemplatePicker as Picker, ProviderQuickSetup as QuickSetup } from '@taiji/ui/features/settings'
import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { useToast } from '@/composables/useToast'

// t7 需 mock @/api：listBuiltinProviders 返回空数组（不阻塞页面），setProvider 桩。
// vi.mock 被 vitest 提升到 import 之前，保证 ProviderPage import 时 @/api 已 mock。
const configMock = vi.hoisted(() => ({
  listBuiltinProviders: vi.fn(async () => [] as BuiltinProviderTemplate[]),
  // ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
  setProvider: vi.fn(async () => {}),
  // apikey 自动启用链路（useApiKeyAutoEnable）：写 enabledModels 白名单
  toggleProviderEnabled: vi.fn(async () => {}),
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => ({ providers: [] })),
  deleteProvider: vi.fn(async () => {}),
  // wave-oauth：ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  // MF-1：QuickSetup 打开前查 auth.json OAuth 凭据（默认无）
  hasOAuth: vi.fn(async () => false),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
}))
vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

// ── fixture：3 个内置 provider 模板 ──
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

/** body 内 input 赋值 + 派发 input 事件（v-model 更新） */
function setBodyInput(selector: string, value: string): void {
  const el = document.body.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`body input 未找到: ${selector}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * reka Select 交互：打开/选中依赖 pointerdown/pointerup（click 不触发）。
 * happy-dom 缺 pointer capture API（SelectTrigger onPointerdown 直接调 target.hasPointerCapture），
 * 派发前 polyfill 到元素上。
 */
function pointerBody(selector: string, type: 'pointerdown' | 'pointerup'): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  const anyEl = el as HTMLElement & {
    hasPointerCapture?: (id: number) => boolean
    releasePointerCapture?: (id: number) => void
  }
  if (typeof anyEl.hasPointerCapture !== 'function') anyEl.hasPointerCapture = () => false
  if (typeof anyEl.releasePointerCapture !== 'function') anyEl.releasePointerCapture = () => {}
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }))
}

// ── t1-t3 ProviderTemplatePicker ──

describe('ProviderTemplatePicker', () => {
  it('t1 渲染 provider 列表（打开 Popover 后每项含 name + authMode 徽章）', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    // F2：点 trigger 先进入菜单视图，再点「从内置模板」进入选择器
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    // 选择器网格内的卡片（wave-picker-b 重写后 item 在 Dialog grid 内，非 Popover 顶层）
    const grid = document.body.querySelector<HTMLElement>('[data-testid="provider-template-grid"]')
    expect(grid).toBeTruthy()
    const items = grid!.querySelectorAll<HTMLElement>('[data-testid^="provider-template-"]')
    expect(items.length).toBe(4)
    // 含 name + authMode 徽章文案（API Key / OAuth）
    expect(document.body.textContent).toContain('OpenAI')
    expect(document.body.textContent).toContain('Anthropic')
  })

  it('t1b F2 入口菜单：打开后默认显示「从内置模板（推荐）+ 自定义」两条目，内置模板默认高亮', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeTruthy()
    // 内置模板条目带「推荐」标识 + 高亮底色（bg-surface-2）
    const builtin = document.body.querySelector<HTMLElement>('[data-testid="add-menu-builtin"]')
    expect(builtin!.textContent).toContain('推荐')
    expect(builtin!.className).toContain('bg-surface-2')
    // 此时不显示选择器搜索框（二级视图未进入）
    expect(document.body.querySelector('[data-testid="provider-template-search"]')).toBeNull()
  })

  it('t1c F2 菜单「自定义」条目 → emit custom 并关闭 Popover', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-custom"]')
    await flushPromises()
    expect(wrapper.emitted('custom')).toBeTruthy()
    // 关闭后选择器隐藏
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeNull()
  })

  it('t1d F5 列表项渲染首字母色块（语义色类，非硬编码颜色）', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    // 首个 provider 的色块：首字母 + 品牌色（brand-colors.ts 16 色表经 inline style 绑定，wave-picker-b 起非语义 Tailwind 类）
    const item = document.body.querySelector<HTMLElement>('[data-testid="provider-template-openai"]')
    const avatar = item!.querySelector('.size-7')
    expect(avatar).toBeTruthy()
    expect(avatar!.textContent).toBe('O')
    expect(avatar!.getAttribute('style')).toMatch(/background-color/)
  })

  it('t2 搜索过滤：输入 openai 后只显示 id 含 openai 的项', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    setBodyInput('[data-testid="provider-template-search"]', 'openai')
    await flushPromises()
    const grid = document.body.querySelector<HTMLElement>('[data-testid="provider-template-grid"]')
    const items = grid!.querySelectorAll<HTMLElement>('[data-testid^="provider-template-"]')
    // openai + openai-codex（id 含 openai），anthropic 不含
    expect(items.length).toBe(2)
  })

  it('t3 选中项 emit select 并关闭 Popover', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-openai"]')
    await flushPromises()
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toStrictEqual(TEMPLATES[0])
    // sa4 Major #2 剩余：选中后 Popover 立即关闭，选择器内容从 body 消失
    expect(document.body.querySelector('[data-testid="provider-template-search"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="provider-template-openai"]')).toBeNull()
  })
})

// ── t4-t6 ProviderQuickSetup ──

describe('ProviderQuickSetup', () => {
  it('t4 渲染 template 元信息（name/baseUrl/api）+ 凭据区 + 取消/保存按钮', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('Anthropic')
    expect(bodyText).toContain('https://api.anthropic.com')
    expect(bodyText).toContain('anthropic-messages')
    // 凭据方式 radio 选项存在（wave-quick-setup-c 重写：credential-mode-* → auth-option-*）
    expect(document.body.querySelector('[data-testid="auth-option-plaintext"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="auth-option-env"]')).toBeTruthy()
    // 保存按钮存在
    expect(document.body.querySelector('[data-testid="provider-quick-setup-save"]')).toBeTruthy()
  })

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

  it('t5 明文模式保存：emit save payload.data.apiKey=明文 + name=template.name（方案 B 占位无 models）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    // 默认 env 模式（F3），先切明文（wave-quick-setup-c：radio 选项 testid 为 auth-option-*）
    clickBody('[data-testid="auth-option-plaintext"]')
    await flushPromises()
    setBodyInput('[data-testid="credential-apikey-input"]', 'sk-xxx')
    await flushPromises()
    // 渲染 gate：明文输入框存在且输入生效（DOM 断言）
    const keyInput = document.body.querySelector<HTMLInputElement>('[data-testid="credential-apikey-input"]')
    expect(keyInput).toBeTruthy()
    expect(keyInput!.value).toBe('sk-xxx')
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.providerId).toBe('anthropic')
    expect(payload.data.apiKey).toBe('sk-xxx')
    expect(payload.data.name).toBe('Anthropic')
    // 方案 B 占位：不写 models
    expect(payload.data.models).toBeUndefined()
  })

  it('t6 $ENV 模式保存：apiKey=$OPENAI_API_KEY（envVar 默认预填 envVars[0]，且默认即 env 模式）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true }, // openai, envVars=[OPENAI_API_KEY]
      attachTo: document.body,
    })
    await flushPromises()
    // 渲染 gate：默认 env 模式 select 渲染（DOM 断言）
    expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeTruthy()
    // F3：默认 env 模式，直接保存
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.providerId).toBe('openai')
    expect(payload.data.apiKey).toBe('$OPENAI_API_KEY')
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

  it('t8 F1 oauth-only 模板：无 key 输入、仅 OAuth 选项、保存禁用', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[2], open: true }, // openai-codex
      attachTo: document.body,
    })
    await flushPromises()
    // wave-quick-setup-c：oauth-only 模板渲染 OAuth radio 选项（credential-oauth-only 已废弃）
    expect(document.body.querySelector('[data-testid="auth-option-oauth"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="auth-option-plaintext"]')).toBeNull()
    const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
    expect(save!.disabled).toBe(true)
  })

  it('t8b F1 oauth-only 模板：保存不可触发（无 save emit）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[2], open: true }, // openai-codex
      attachTo: document.body,
    })
    await flushPromises()
    // 渲染 gate：OAuth 选项可见 + 保存按钮 disabled（DOM 断言）
    expect(document.body.querySelector('[data-testid="auth-option-oauth"]')).toBeTruthy()
    const saveBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
    expect(saveBtn).toBeTruthy()
    expect(saveBtn!.disabled).toBe(true)
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    expect(wrapper.emitted('save')).toBeFalsy()
  })

  it('t8c F1 both 模板：OAuth 选项存在，选中后显示登录按钮（oauth-login-button）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="auth-option-oauth"]')).toBeTruthy()
    // 选中 OAuth 选项 → body 展开显示登录按钮（oauthAuthorized 未回写时为登录态）
    clickBody('[data-testid="auth-option-oauth"]')
    await flushPromises()
    const loginBtn = document.body.querySelector('[data-testid="oauth-login-button"]')
    expect(loginBtn).toBeTruthy()
    expect(loginBtn!.textContent).toContain('登录')
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

  it('t9b F7b 信息区显示内置模型列表（template.models chips）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic, models 3 条
      attachTo: document.body,
    })
    await flushPromises()
    // wave-quick-setup-c：信息块 builtin-models 渲染 template.models 的 id chips
    const modelsBlock = document.body.querySelector('[data-testid="builtin-models"]')
    expect(modelsBlock).toBeTruthy()
    expect(modelsBlock!.textContent).toContain('claude-3-5-sonnet')
    expect(modelsBlock!.textContent).toContain('claude-3-7-sonnet')
    expect(modelsBlock!.textContent).toContain('claude-sonnet-4')
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

  it('s1a 已存 env_var 配置重开：默认恢复 env 选项（非 plaintext）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true, existingAuthMethod: 'env_var' }, // openai envVars=[OPENAI_API_KEY]
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
  })

  it('s1b 已存 api_key 配置重开：默认恢复明文选项', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true, existingAuthMethod: 'api_key' },
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeNull()
  })

  it('s1c 已存 ambient 配置重开：默认恢复云凭证选项', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[3], open: true, existingAuthMethod: 'ambient' }, // google-vertex
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="credential-ambient"]')).toBeTruthy()
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

// ── t7 ProviderPage 首屏冒烟 ──

describe('ProviderPage 入口', () => {
  it('t7 首屏渲染含「添加供应商」入口按钮（data-testid=provider-template-picker）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()
    expect(
      wrapper.find('[data-testid="provider-template-picker"]').exists(),
    ).toBe(true)
    // 并列的「从其他 Agent 导入」入口仍在
    expect(
      wrapper.find('[data-testid="import-providers-menu"]').exists(),
    ).toBe(true)
  })

  it('t11 F2 入口聚合：点「添加供应商」→ 菜单含内置模板/自定义 → 点自定义走 createAndExpand 原流程', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()
    // 点 trigger 打开菜单
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeTruthy()
    // 点「自定义」→ 原流程：新建合成行并展开就地编辑体
    clickBody('[data-testid="add-menu-custom"]')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
  })
})

// ── ProviderPage 保存集成链路（sa4 Major #3）──

/**
 * 完整旅程：选模板 → 填 key → 保存 → config.setProvider 被调 + payload 正确 + toast + UI 收尾。
 * ProviderPage 接线：onTemplateSelect 开 QuickSetup → QuickSetup emit('save') →
 * onQuickSetupSave 调 config.setProvider → 成功关 Dialog + toast.info。
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

    // 4. config.setProvider 被调用且 payload 正确（防线⑥：catalog 模板导入只写凭据相关字段
    //    name/apiKey/authMethod——模板 baseUrl/api 是快照 artifact 不回传，无 models）
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

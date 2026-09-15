/**
 * ProviderQuickSetup 组件单测（wave-quick-setup-c）。
 *
 * 覆盖验收标准：
 * ① 认证 radio 四选一按 authMode 条件渲染（api_key/both/oauth/ambient）
 * ② 内置信息块：推荐 env var 行 + 模型列表 code 标签
 * ③ env 检测态（envCheck props → ✓/⚠）
 * ④ OAuth 流：登录按钮 → emit oauth-login；oauthAuthorized → 已授权态
 * ⑤ footer hint 四态动态文案
 * ⑥ onSave 构造 SetProviderData 填 authMethod（I6）
 *
 * 测试模式：reka Dialog 经 Portal teleport 到 document.body（同 OAuthDialog.test.ts）。
 * i18n mock 返回 key。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderQuickSetup from '../provider/ProviderQuickSetup.vue'
import type { BuiltinProviderTemplate } from '@taiji/shared'

function tpl(overrides: Partial<BuiltinProviderTemplate>): BuiltinProviderTemplate {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    authMode: 'api_key',
    envVars: ['TEST_API_KEY'],
    oauthSupported: false,
    modelCount: 3,
    models: [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
      { id: 'model-c', name: 'Model C' },
    ],
    ...overrides,
  } as BuiltinProviderTemplate
}

interface MountOverrides {
  template?: BuiltinProviderTemplate
  envCheck?: Record<string, boolean>
  oauthAuthorized?: boolean
}

async function mountSetup(overrides: MountOverrides = {}) {
  const wrapper = mount(ProviderQuickSetup, {
    props: {
      template: tpl({}),
      open: true,
      envCheck: undefined,
      oauthAuthorized: false,
      ...overrides,
    },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

function query(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

describe('认证 radio 条件渲染（TC1）', () => {
  it('api_key：明文 + 环境变量 两个 radio', async () => {
    const w = await mountSetup()
    expect(query('[data-testid="auth-option-plaintext"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-env"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-oauth"]')).toBeNull()
    expect(query('[data-testid="auth-option-ambient"]')).toBeNull()
    w.unmount()
  })

  it('both：明文 + 环境变量 + OAuth 三个 radio（OAuth 可点）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', oauthName: 'Claude Pro' }) })
    expect(query('[data-testid="auth-option-plaintext"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-env"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-oauth"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-ambient"]')).toBeNull()
    w.unmount()
  })

  it('oauth：仅 OAuth 一个 radio（openai-codex）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'oauth', envVars: [] }) })
    expect(query('[data-testid="auth-option-oauth"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-plaintext"]')).toBeNull()
    expect(query('[data-testid="auth-option-env"]')).toBeNull()
    w.unmount()
  })

  it('ambient：仅云凭证一个 radio（google-vertex）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'ambient', envVars: [] }) })
    expect(query('[data-testid="auth-option-ambient"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-plaintext"]')).toBeNull()
    expect(query('[data-testid="auth-option-oauth"]')).toBeNull()
    w.unmount()
  })
})

describe('初始认证方式默认回退（resolveInitialAuthMethod 默认链）', () => {
  it('api_key 模式且无 envVars → 默认明文（plaintext 兜底，不落 env）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'api_key', envVars: [] }) })
    // 默认即明文态：输入框直接可见，env select 不存在
    expect(query('[data-testid="credential-apikey-input"]')).toBeTruthy()
    expect(query('[data-testid="credential-envvar-select"]')).toBeNull()
    expect(query('[data-testid="footer-hint"]')!.textContent).toContain('footerHintPlaintext')
    w.unmount()
  })
})

describe('内置信息块（TC2）', () => {
  it('推荐环境变量行 + 模型列表 code 标签', async () => {
    const w = await mountSetup({ template: tpl({ envVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' }) })
    const envVarRow = query('[data-testid="builtin-envvar"]')
    expect(envVarRow).toBeTruthy()
    expect(envVarRow!.textContent).toContain('OPENAI_API_KEY')
    const models = query('[data-testid="builtin-models"]')
    expect(models!.textContent).toContain('model-a')
    expect(models!.textContent).toContain('model-c')
    w.unmount()
  })
})

/**
 * M4：模板卡协议/端点展示来自模型集聚合（设计 catalog-provider-field-authority §3.3 D5）。
 * 模板 provider 级 api/baseUrl 是构建期 artifact（取 models[0].api 冒充 provider 协议、
 * `provider.baseUrl ?? ''`）——直接展示会把 artifact 泄漏到 settings 第一步入口。
 */
describe('模板卡协议/端点聚合展示（M4/D5）', () => {
  it('单协议 + 单端点：展示该协议与该端点（不使用 provider 级 artifact 字段）', async () => {
    const w = await mountSetup({
      template: tpl({
        // artifact 字段与模型集不一致（历史快照即如此）——展示必须以模型集为准
        api: 'anthropic-messages',
        baseUrl: 'https://artifact.example',
        models: [
          { id: 'm1', name: 'M1', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', reasoning: true, input: ['text'], contextWindow: 200_000 },
          { id: 'm2', name: 'M2', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', reasoning: true, input: ['text'], contextWindow: 200_000 },
        ],
      }),
    })

    expect(query('[data-testid="builtin-api"]')!.textContent).toContain('openai-completions')
    expect(query('[data-testid="builtin-baseurl"]')!.textContent).toContain('https://api.deepseek.com')
    // artifact 不再展示
    expect(query('[data-testid="builtin-api"]')!.textContent).not.toContain('anthropic-messages')
    expect(query('[data-testid="builtin-baseurl"]')!.textContent).not.toContain('https://artifact.example')
    w.unmount()
  })

  it('混合协议/混合端点：展示「按模型分发」而非第一个模型的 artifact', async () => {
    const w = await mountSetup({
      template: tpl({
        api: 'anthropic-messages',
        baseUrl: 'https://artifact.example',
        models: [
          { id: 'm1', name: 'M1', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go', reasoning: true, input: ['text'], contextWindow: 200_000 },
          { id: 'm2', name: 'M2', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', reasoning: true, input: ['text'], contextWindow: 200_000 },
        ],
      }),
    })

    expect(query('[data-testid="builtin-api"]')!.textContent).toContain('settings.providerEdit.apiMixed')
    expect(query('[data-testid="builtin-baseurl"]')!.textContent).toContain('settings.providerEdit.apiMixed')
    w.unmount()
  })

  it('模型集无协议/无端点信息：协议显示空值占位、端点显示「内置目录未提供」', async () => {
    const w = await mountSetup({
      template: tpl({ models: [{ id: 'm1', name: 'M1', reasoning: false, input: ['text'], contextWindow: 8192 }] }),
    })

    expect(query('[data-testid="builtin-api"]')!.textContent).toContain('settings.provider.builtinTemplate.emptyValue')
    expect(query('[data-testid="builtin-baseurl"]')!.textContent).toContain('settings.providerEdit.endpointNotProvided')
    w.unmount()
  })
})

describe('env 检测态（TC3）', () => {
  it('envCheck true → ✓ 检测到文案；false → ⚠ 未设置文案', async () => {
    const w = await mountSetup({ envCheck: { TEST_API_KEY: true } })
    // 默认选中 env 模式（envVars 非空），检测态行出现
    const detected = query('[data-testid="env-detected"]')
    expect(detected).toBeTruthy()
    expect(detected!.textContent).toContain('envDetected')
    w.unmount()
  })

  it('envCheck false → 未设置文案', async () => {
    const w = await mountSetup({ envCheck: { TEST_API_KEY: false } })
    const detected = query('[data-testid="env-detected"]')
    expect(detected).toBeTruthy()
    expect(detected!.textContent).toContain('envNotSet')
    w.unmount()
  })

  it('envCheck 未传入（undefined）→ 不显示检测态', async () => {
    const w = await mountSetup()
    expect(query('[data-testid="env-detected"]')).toBeNull()
    w.unmount()
  })
})

describe('OAuth 流（TC4）', () => {
  it('点登录按钮 → emit oauth-login', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', oauthName: 'Claude Pro' }) })
    // 切到 OAuth radio
    const oauthOption = query('[data-testid="auth-option-oauth"]')!
    ;(oauthOption as HTMLElement).click()
    await flushPromises()
    const loginBtn = query('[data-testid="oauth-login-button"]')!
    expect(loginBtn).toBeTruthy()
    ;(loginBtn as HTMLElement).click()
    const events = w.emitted('oauth-login')
    expect(events).toBeTruthy()
    expect(events!.length).toBe(1)
    w.unmount()
  })

  it('oauthAuthorized=true → 已授权态（不再显示登录按钮）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', oauthName: 'Claude Pro' }), oauthAuthorized: true })
    const oauthOption = query('[data-testid="auth-option-oauth"]')!
    ;(oauthOption as HTMLElement).click()
    await flushPromises()
    expect(query('[data-testid="oauth-authorized"]')).toBeTruthy()
    expect(query('[data-testid="oauth-login-button"]')).toBeNull()
    w.unmount()
  })
})

describe('footer hint（TC5）', () => {
  it('四态动态文案随认证方式变化', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', envVars: ['ANTHROPIC_API_KEY'] }) })
    const hint = query('[data-testid="footer-hint"]')!
    // 默认 env → env hint
    expect(hint.textContent).toContain('footerHintEnv')
    // 明文
    ;(query('[data-testid="auth-option-plaintext"]')! as HTMLElement).click()
    await flushPromises()
    expect(hint.textContent).toContain('footerHintPlaintext')
    // OAuth
    ;(query('[data-testid="auth-option-oauth"]')! as HTMLElement).click()
    await flushPromises()
    expect(hint.textContent).toContain('footerHintOauth')
    w.unmount()
  })
})

describe('onSave authMethod（TC6，I6 契约）', () => {
  it('明文 → authMethod=api_key + apiKey 明文', async () => {
    const w = await mountSetup()
    ;(query('[data-testid="auth-option-plaintext"]')! as HTMLElement).click()
    await flushPromises()
    const input = query('[data-testid="credential-apikey-input"]') as HTMLInputElement
    input.value = 'sk-abc'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { providerId: string; data: { apiKey?: string; authMethod?: string } }
    expect(save.data.authMethod).toBe('api_key')
    expect(save.data.apiKey).toBe('sk-abc')
    w.unmount()
  })

  it('env → authMethod=env_var + apiKey=$VAR', async () => {
    const w = await mountSetup({ template: tpl({ envVars: ['OPENAI_API_KEY'] }) })
    // 默认 env 模式
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { data: { apiKey?: string; authMethod?: string } }
    expect(save.data.authMethod).toBe('env_var')
    expect(save.data.apiKey).toBe('$OPENAI_API_KEY')
    w.unmount()
  })

  it('oauth（已授权）→ authMethod=oauth，不带 apiKey', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'oauth', envVars: [] }), oauthAuthorized: true })
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { data: { apiKey?: string; authMethod?: string } }
    expect(save.data.authMethod).toBe('oauth')
    expect(save.data.apiKey).toBeUndefined()
    w.unmount()
  })

  it('OAuth 未授权 → 保存禁用', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'oauth', envVars: [] }), oauthAuthorized: false })
    const saveBtn = query('[data-testid="provider-quick-setup-save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    w.unmount()
  })

  it('防线⑥：模板 api/baseUrl 不落 payload（快照 artifact 不写 override；api 是从未生效的死键）', async () => {
    const w = await mountSetup({
      template: tpl({ api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1' }),
    })
    ;(query('[data-testid="auth-option-plaintext"]')! as HTMLElement).click()
    await flushPromises()
    const input = query('[data-testid="credential-apikey-input"]') as HTMLInputElement
    input.value = 'sk-abc'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { data: Record<string, unknown> }
    expect('baseUrl' in save.data).toBe(false)
    expect('api' in save.data).toBe(false)
    // catalog 模板导入只写凭据相关字段（name 仍是 provider 标识，保留）
    expect(save.data.authMethod).toBe('api_key')
    expect(save.data.apiKey).toBe('sk-abc')
    w.unmount()
  })
})

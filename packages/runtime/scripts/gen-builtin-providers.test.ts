// OAuth config 提取 fixture 测试：用 node_modules 里真实 oauth provider 源码断言
// extractOAuthConfig 的提取结果（clientId/flow/endpoints/scopes/callbackPort）。
// 直接读真实文件而非内嵌节选 —— pi-ai 升级后源码变化会破坏断言，正是本测试的回归守卫职责。
// 测试框架 vitest（禁 node:test / tsx --test）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractOAuthConfig, generateBuiltinProviders, OAUTH_DIR } from './gen-builtin-providers.mjs'

// pi-ai 1.0.0 oauth provider 全集（openai 走 oauth、radius 1.0.0 起进静态 catalog）
const OAUTH_IDS = ['anthropic', 'github-copilot', 'kimi-coding', 'xai', 'openai-codex', 'openrouter', 'openai', 'radius']

function readRealSource(id: string): string {
  return readFileSync(join(OAUTH_DIR, `${id}.js`), 'utf-8')
}

describe('extractOAuthConfig（真实 pi-ai 源码 fixture）', () => {
  it('anthropic: base64 clientId 解码 + flow=callback + CALLBACK_PORT 常量 53692', () => {
    const cfg = extractOAuthConfig('anthropic', readRealSource('anthropic'))
    expect(cfg.clientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(cfg.noClientId).toBe(false)
    expect(cfg.flow).toBe('callback')
    expect(cfg.callbackPort).toBe(53692)
    expect(cfg.endpoints.authorize).toBe('https://claude.ai/oauth/authorize')
    expect(cfg.endpoints.token).toBe('https://platform.claude.com/v1/oauth/token')
    expect(cfg.endpoints.deviceCode).toBeUndefined()
    expect(cfg.scopes).toEqual(
      expect.arrayContaining(['org:create_api_key', 'user:profile', 'user:file_upload']),
    )
  })

  it('github-copilot: base64 clientId 解码 + flow=device + 函数内模板端点（domain 默认 github.com）+ body scope', () => {
    const cfg = extractOAuthConfig('github-copilot', readRealSource('github-copilot'))
    expect(cfg.clientId).toBe('Iv1.b507a08c87ecfe98')
    expect(cfg.flow).toBe('device')
    expect(cfg.endpoints.deviceCode).toBe('https://github.com/login/device/code')
    expect(cfg.endpoints.token).toBe('https://github.com/login/oauth/access_token')
    expect(cfg.endpoints.authorize).toBeUndefined()
    expect(cfg.scopes).toEqual(['read:user'])
    expect(cfg.callbackPort).toBeUndefined()
  })

  it('kimi-coding: 明文 clientId + flow=device + oauthHost 模板端点（DEFAULT_OAUTH_HOST）+ 无 scopes', () => {
    const cfg = extractOAuthConfig('kimi-coding', readRealSource('kimi-coding'))
    expect(cfg.clientId).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
    expect(cfg.flow).toBe('device')
    expect(cfg.endpoints.deviceCode).toBe('https://auth.kimi.com/api/oauth/device_authorization')
    expect(cfg.endpoints.token).toBe('https://auth.kimi.com/api/oauth/token')
    expect(cfg.scopes).toEqual([])
    expect(cfg.callbackPort).toBeUndefined()
  })

  it('xai: XAI_CLIENT_ID 常量名特例 + flow=device + XAI_* 端点常量', () => {
    const cfg = extractOAuthConfig('xai', readRealSource('xai'))
    expect(cfg.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828')
    expect(cfg.flow).toBe('device')
    expect(cfg.endpoints.deviceCode).toBe('https://auth.x.ai/oauth2/device/code')
    expect(cfg.endpoints.token).toBe('https://auth.x.ai/oauth2/token')
    expect(cfg.scopes).toEqual(
      expect.arrayContaining(['openid', 'profile', 'offline_access', 'grok-cli:access']),
    )
    expect(cfg.callbackPort).toBeUndefined()
  })

  it('openai-codex: flow=both + callbackPort=1455 走 REDIRECT_URI fallback（无 CALLBACK_PORT 常量）', () => {
    const cfg = extractOAuthConfig('openai-codex', readRealSource('openai-codex'))
    expect(cfg.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(cfg.flow).toBe('both')
    // 无 CALLBACK_PORT 常量 → ② 级 REDIRECT_URI localhost:1455 fallback
    expect(cfg.callbackPort).toBe(1455)
    // AUTH_BASE_URL 模板字面量解析
    expect(cfg.endpoints.authorize).toBe('https://auth.openai.com/oauth/authorize')
    expect(cfg.endpoints.token).toBe('https://auth.openai.com/oauth/token')
    expect(cfg.endpoints.deviceCode).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
    expect(cfg.endpoints.verify).toBe('https://auth.openai.com/codex/device')
    expect(cfg.scopes).toEqual(expect.arrayContaining(['openid', 'profile', 'offline_access']))
  })

  it('openrouter: 无 clientId（noClientId 标志）+ flow=callback + 动态端口无 callbackPort', () => {
    const cfg = extractOAuthConfig('openrouter', readRealSource('openrouter'))
    expect(cfg.clientId).toBe('')
    expect(cfg.noClientId).toBe(true)
    expect(cfg.flow).toBe('callback')
    // listen(0) 动态端口 → 无固定 callbackPort
    expect(cfg.callbackPort).toBeUndefined()
    expect(cfg.endpoints.authorize).toBe('https://openrouter.ai/auth')
    expect(cfg.endpoints.token).toBe('https://openrouter.ai/api/v1/auth/keys')
  })

  it('openai: DYNAMIC_CLIENT_ID（1.0.0 登录时动态注册）+ flow=callback + CALLBACK_PORT 1455 + 模板 SCOPE 展开', () => {
    const cfg = extractOAuthConfig('openai', readRealSource('openai-chatgpt'))
    expect(cfg.clientId).toBe('dynamic_agent_client')
    expect(cfg.flow).toBe('callback')
    expect(cfg.callbackPort).toBe(1455)
    expect(cfg.endpoints.authorize).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(cfg.endpoints.token).toBe('https://auth.openai.com/api/accounts/oauth/token')
    // 模板字面量 SCOPE 展开（${DIRECT_TOKEN_SCOPE} 同文件常量内联）——scopes 提取器 1.0.0 形态锚
    expect(cfg.scopes).toEqual(
      expect.arrayContaining(['openid', 'resource.invoke', 'chatgpt.tokens.use.direct']),
    )
  })

  it('radius: OAUTH_CLIENT_ID/OAUTH_SCOPE 常量名（1.0.0）+ flow=device + 端点空（gateway 运行时发现）', () => {
    const cfg = extractOAuthConfig('radius', readRealSource('radius'))
    expect(cfg.clientId).toBe('pi-gateway')
    expect(cfg.flow).toBe('device')
    // 端点从 gateway 运行时发现（loadRadiusOAuthDiscovery），静态提取为空是预期降级
    expect(cfg.endpoints).toEqual({})
    // OAUTH_ 前缀常量名形态——scopes 提取器 1.0.0 形态锚
    expect(cfg.scopes).toEqual(['gateway', 'offline_access'])
    expect(cfg.callbackPort).toBe(1456)
  })

  it('提取失败 fixture：oauth provider 缺 clientId（非登记的无 clientId provider）→ throw', () => {
    const fakeNoClientId = `
const AUTHORIZE_URL = "https://example.com/oauth/authorize";
const TOKEN_URL = "https://example.com/oauth/token";
const REDIRECT_URI = "http://localhost:9999/callback";
`
    expect(() => extractOAuthConfig('fake-oauth', fakeNoClientId)).toThrow(/clientId/)
  })

  it('提取失败 fixture：无法判定 flow（无 device 也无 callback 特征）→ throw', () => {
    const fakeNoFlow = `
const CLIENT_ID = "abc-123";
const SOME_URL = "https://example.com";
`
    expect(() => extractOAuthConfig('fake-oauth', fakeNoFlow)).toThrow(/flow/)
  })
})

describe('generateBuiltinProviders 集成（oauthConfig 挂载）', () => {
  const providers = generateBuiltinProviders()

  it('oauth provider 全集（pi-ai 1.0.0 为 8 个）均带 oauthConfig 且 flow 正确', () => {
    for (const id of OAUTH_IDS) {
      const p = providers.find((x) => x.id === id)
      expect(p, `${id} 应在 catalog`).toBeDefined()
      expect(p.oauthConfig, `${id} 应提取 oauthConfig`).toBeDefined()
      expect(p.oauthConfig.flow, `${id} flow`).toBeDefined()
    }
  })

  it('非 oauth provider 无 oauthConfig（deepseek 为 api_key 纯通道反例）', () => {
    const deepseek = providers.find((p) => p.id === 'deepseek')
    expect(deepseek.oauthConfig).toBeUndefined()
  })
})

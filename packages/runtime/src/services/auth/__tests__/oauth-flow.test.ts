/**
 * OAuth flow 编排单测（mock fetch，覆盖各 provider 协议分支）。
 *
 * 覆盖：xai 标准 device（缺 expires_in 默认 3600s + 5min skew）/ kimi 无 skew /
 * github-copilot 两段式（epoch 秒 expires）/ openai-codex 非标 device（device_auth_id
 * → authorization_code 二次 exchange）/ anthropic callback（PKCE + state）/ openrouter
 * callback（无 clientId + 永久 key）/ 事件钩子 / abort 取消。
 *
 * callback 分支用真实 http server（端口 0 动态），只 mock token 端点 fetch。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BuiltinOAuthConfig } from '@xyz-agent/shared'
import { runOAuthLogin, type OAuthFlowHooks } from '../oauth-flow.js'

const POLL_TUNING = { minIntervalMs: 5, slowDownIncrementMs: 5 } as const // 轮询节奏注入：免真实睡眠（否则 device flow 每用例真睡 1-2s）

// 每个测试开头重设（模块加载与测试执行间隔在设备/回调等待后可达数秒，断言 expires 需相对测试起点）
let now = Date.now()

// ── 各 provider 的 oauthConfig（形状对齐 builtin-providers.json）──

const XAI_CONFIG: BuiltinOAuthConfig = {
  clientId: 'xai-client',
  flow: 'device',
  endpoints: {
    token: 'https://auth.x.ai/oauth2/token',
    deviceCode: 'https://auth.x.ai/oauth2/device/code',
  },
  scopes: ['openid', 'profile', 'offline_access'],
}

const KIMI_CONFIG: BuiltinOAuthConfig = {
  clientId: 'kimi-client',
  flow: 'device',
  endpoints: {
    token: 'https://auth.kimi.com/api/oauth/token',
    deviceCode: 'https://auth.kimi.com/api/oauth/device_authorization',
  },
  scopes: [],
}

const COPILOT_CONFIG: BuiltinOAuthConfig = {
  clientId: 'Iv1.copilot',
  flow: 'device',
  endpoints: {
    token: 'https://github.com/login/oauth/access_token',
    deviceCode: 'https://github.com/login/device/code',
  },
  scopes: ['read:user'],
}

const OPENAI_CODEX_CONFIG: BuiltinOAuthConfig = {
  clientId: 'app_codex',
  flow: 'both',
  endpoints: {
    token: 'https://auth.openai.com/oauth/token',
    deviceCode: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    verify: 'https://auth.openai.com/codex/device',
  },
  scopes: ['openid', 'offline_access'],
}

const ANTHROPIC_CONFIG: BuiltinOAuthConfig = {
  clientId: 'anthropic-client',
  flow: 'callback',
  endpoints: {
    authorize: 'https://claude.ai/oauth/authorize',
    token: 'https://platform.claude.com/v1/oauth/token',
  },
  scopes: ['org:create_api_key', 'user:profile'],
}

const OPENROUTER_CONFIG: BuiltinOAuthConfig = {
  clientId: '',
  noClientId: true,
  flow: 'callback',
  endpoints: {
    authorize: 'https://openrouter.ai/auth',
    token: 'https://openrouter.ai/api/v1/auth/keys',
  },
  scopes: [],
}

// ── fetch mock 工具 ─────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

let fetchCalls: FetchCall[] = []

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => jsonResponse({})

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  fetchImpl = impl
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init)))
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  const raw = call.init?.body
  if (raw instanceof URLSearchParams) return Object.fromEntries(raw)
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>
  return {}
}

function bodyTextOf(call: FetchCall): string {
  const raw = call.init?.body
  return raw instanceof URLSearchParams ? raw.toString() : String(raw ?? '')
}

beforeEach(() => {
  now = Date.now()
  fetchCalls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runOAuthLogin — 标准 device flow', () => {
  it('xai：device 起始 → 轮询 pending → token complete；expires 含 5min skew + 缺 expires_in 默认 3600s', async () => {
    let polled = 0
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        // xai 特判：请求体带 referrer:"pi"
        expect(body.referrer).toBe('pi')
        expect(body.client_id).toBe('xai-client')
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 0.05, expires_in: 1800,
        })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        if (polled++ === 0) {
          expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
          expect(body.device_code).toBe('dc-1')
          return jsonResponse({ error: 'authorization_pending' }, 400)
        }
        // 无 expires_in：走 defaultExpiresIn 3600s
        return jsonResponse({ access_token: 'at-xai', refresh_token: 'rt-xai' })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const flow = runOAuthLogin('xai', XAI_CONFIG, hooks, new AbortController().signal, POLL_TUNING)

    // 首次轮询需要 advance：waitBeforeFirstPoll 等一个 interval。测试里让第一次 fetch 直接返回 pending
    const credential = await flow

    expect(credential.type).toBe('oauth')
    expect(credential.access).toBe('at-xai')
    expect(credential.refresh).toBe('rt-xai')
    // expires = 实际运行 now + 3600s - 5min skew ≈ now + 3300s（容差覆盖 waitBeforeFirstPoll）
    expect(Math.abs(credential.expires - (now + 3_300 * 1_000))).toBeLessThan(5_000)
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      interval: 0.05,
    }))
  })

  it('kimi：无 skew（expires = now + expires_in*1000）', async () => {
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return jsonResponse({
          device_code: 'dc-k', user_code: 'KIMI-CODE',
          verification_uri: 'https://auth.kimi.com/activate',
          verification_uri_complete: 'https://auth.kimi.com/activate?code=KIMI-CODE',
          interval: 0.05, expires_in: 900,
        })
      }
      if (url === 'https://auth.kimi.com/api/oauth/token') {
        return jsonResponse({ access_token: 'at-kimi', refresh_token: 'rt-kimi', expires_in: 120 })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const credential = await runOAuthLogin('kimi-coding', KIMI_CONFIG, hooks, new AbortController().signal, POLL_TUNING)

    expect(credential.access).toBe('at-kimi')
    // 无 skew：实际运行 now + 120s（容差覆盖 waitBeforeFirstPoll）
    expect(Math.abs(credential.expires - (now + 120 * 1_000))).toBeLessThan(5_000)
    // verificationUriComplete 优先于 verificationUri
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      verificationUri: 'https://auth.kimi.com/activate?code=KIMI-CODE',
    }))
  })

  it('slow_down → interval 递增后继续轮询成功', async () => {
    let polled = 0
    mockFetch(async (url, init) => {
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 0.05, expires_in: 1800,
        })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        if (polled++ === 0) return jsonResponse({ error: 'slow_down', interval: 1 }, 400)
        return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      }
      return jsonResponse({}, 404)
    })
    const credential = await runOAuthLogin('xai', XAI_CONFIG, {}, new AbortController().signal, POLL_TUNING)
    expect(credential.access).toBe('at')
  })

  it('expired_token → flow 失败并带可读错误', async () => {
    mockFetch(async (url) => {
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 0.05, expires_in: 1800,
        })
      }
      return jsonResponse({ error: 'expired_token' }, 400)
    })
    await expect(runOAuthLogin('xai', XAI_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('OAuth device code expired')
  })
})

describe('runOAuthLogin — github-copilot 两段式', () => {
  it('第一段换 GitHub token → 第二段换 Copilot token（expires_at epoch 秒）', async () => {
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url === 'https://github.com/login/device/code') {
        expect(headers['User-Agent']).toBe('GitHubCopilotChat/0.35.0')
        expect(body.client_id).toBe('Iv1.copilot')
        expect(body.scope).toBe('read:user')
        return jsonResponse({
          device_code: 'dc-gh', user_code: 'GH-CODE',
          verification_uri: 'https://github.com/login/device', interval: 0.05, expires_in: 900,
        })
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        expect(headers['User-Agent']).toBe('GitHubCopilotChat/0.35.0')
        expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
        return jsonResponse({ access_token: 'github-token' })
      }
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        expect(headers.Authorization).toBe('Bearer github-token')
        // expires_at 是 epoch 秒
        return jsonResponse({ token: 'copilot-token', expires_at: Math.floor((now + 30 * 60 * 1_000) / 1_000) })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const credential = await runOAuthLogin('github-copilot', COPILOT_CONFIG, hooks, new AbortController().signal, POLL_TUNING)

    expect(credential.access).toBe('copilot-token')
    // refresh 存 GitHub token（pi 侧 refresh 用它换新 copilot token）
    expect(credential.refresh).toBe('github-token')
    // expires = expires_at*1000 - 5min skew（容差覆盖轮询等待）
    expect(Math.abs(credential.expires - (now + 25 * 60 * 1_000))).toBeLessThan(5_000)
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'GH-CODE' }))
  })
})

describe('runOAuthLogin — openai-codex 非标 device 协议', () => {
  it('device_auth_id → 轮询返回 authorization_code → 二次 exchange 正式 token', async () => {
    let polled = 0
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        // 起始是 JSON POST
        expect(init?.method).toBe('POST')
        expect(body.client_id).toBe('app_codex')
        return jsonResponse({ device_auth_id: 'da-1', user_code: 'CODEX-CODE', interval: '1' })
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        if (polled++ === 0) {
          // 403 = 未完成授权（非标语义：pending）
          return jsonResponse({ error: { code: 'deviceauth_authorization_pending' } }, 403)
        }
        // 完成：返回 authorization_code + code_verifier（非直接 token）
        expect(body.device_auth_id).toBe('da-1')
        expect(body.user_code).toBe('CODEX-CODE')
        return jsonResponse({ authorization_code: 'authz-code', code_verifier: 'verifier-x' })
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        // 二次 exchange：form 编码 + redirect_uri 派生自 deviceCode 端点 origin
        const form = bodyTextOf({ url, init })
        expect(form).toContain('grant_type=authorization_code')
        expect(form).toContain('code=authz-code')
        expect(form).toContain('code_verifier=verifier-x')
        expect(form).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback')
        return jsonResponse({ access_token: 'at-codex', refresh_token: 'rt-codex', expires_in: 3600 })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const credential = await runOAuthLogin('openai-codex', OPENAI_CODEX_CONFIG, hooks, new AbortController().signal, POLL_TUNING)

    expect(credential.access).toBe('at-codex')
    expect(credential.refresh).toBe('rt-codex')
    // 无 skew：实际运行 now + 3600s（容差覆盖轮询等待）
    expect(Math.abs(credential.expires - (now + 3_600 * 1_000))).toBeLessThan(5_000)
    // verify 端点作为 verificationUri
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      userCode: 'CODEX-CODE',
      verificationUri: 'https://auth.openai.com/codex/device',
    }))
  })
})

describe('runOAuthLogin — callback flow', () => {
  it('anthropic：真实回调服务器收 code → JSON token exchange（含 state/PKCE 参数）', async () => {
    // 只 mock token 端点；回调请求走真实 fetch（本地 http server）
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://platform.claude.com/v1/oauth/token') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.grant_type).toBe('authorization_code')
        expect(body.client_id).toBe('anthropic-client')
        expect(body.code).toBe('authz-123')
        expect(typeof body.code_verifier).toBe('string')
        // state 独立随机（不复用 PKCE verifier——code+verifier 同现于明文 loopback URL 有泄露风险）
        expect(body.state).not.toBe(body.code_verifier)
        expect(typeof body.state).toBe('string')
        expect(body.redirect_uri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
        return jsonResponse({ access_token: 'at-an', refresh_token: 'rt-an', expires_in: 7200 })
      }
      return realFetch(url, init)
    }))

    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('anthropic', ANTHROPIC_CONFIG, hooks, new AbortController().signal, POLL_TUNING)

    // 等 server 起来拿到授权 URL，然后模拟浏览器回调
    // onAuthUrl 在 server listen 后同步触发（startCallbackServer await 完成后才调 hooks）
    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    expect(url.searchParams.get('client_id')).toBe('anthropic-client')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    const state = url.searchParams.get('state') as string
    const redirectUri = url.searchParams.get('redirect_uri') as string
    const callbackPort = new URL(redirectUri).port

    // 模拟浏览器回调
    const res = await fetch(`http://127.0.0.1:${callbackPort}/callback?code=authz-123&state=${state}`)
    expect(res.status).toBe(200)

    const credential = await flow
    expect(credential.access).toBe('at-an')
    // 5min skew：实际运行 now + 7200s - 300s（容差覆盖 server 启动）
    expect(Math.abs(credential.expires - (now + 7_200_000 - 5 * 60 * 1_000))).toBeLessThan(5_000)
  })

  it('openrouter：无 clientId，动态端口回调，token 端点返回永久 key（MAX_SAFE_INTEGER）', async () => {
    // 只 mock token 端点；回调请求走真实 fetch（本地 http server）
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://openrouter.ai/api/v1/auth/keys') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.code).toBe('or-code')
        expect(body.code_verifier).toBeTruthy()
        expect(body.code_challenge_method).toBe('S256')
        return jsonResponse({ key: 'sk-orv2-permanent' })
      }
      return realFetch(url, init)
    }))

    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('openrouter', OPENROUTER_CONFIG, hooks, new AbortController().signal, POLL_TUNING)

    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    // authorize 只带 callback_url + challenge（无 client_id/scope/state）
    expect(url.searchParams.has('client_id')).toBe(false)
    expect(url.searchParams.get('callback_url')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//)

    const callbackUrl = url.searchParams.get('callback_url') as string
    const res = await fetch(`${callbackUrl}?code=or-code`)
    expect(res.status).toBe(200)

    const credential = await flow
    expect(credential.access).toBe('sk-orv2-permanent')
    expect(credential.refresh).toBe('')
    expect(credential.expires).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('abort 取消：进行中 callback flow 立即中断，不抛未捕获错误', async () => {
    mockFetch(async () => jsonResponse({}, 404))
    const controller = new AbortController()
    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('openrouter', OPENROUTER_CONFIG, hooks, controller.signal, POLL_TUNING)

    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    controller.abort()
    await expect(flow).rejects.toThrow('Login cancelled')
  })
})

describe('runOAuthLogin — device 起始端点失败（MF-2）', () => {
  it('xai：device-code 起始端点 4xx → 失败并带 HTTP 状态', async () => {
    mockFetch(async (url) => {
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({ error: 'invalid_client' }, 400)
      }
      return jsonResponse({}, 404)
    })
    await expect(runOAuthLogin('xai', XAI_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('OAuth device authorization failed (HTTP 400)')
  })

  it('copilot：device-code 起始端点 4xx → 失败并带 HTTP 状态', async () => {
    mockFetch(async (url) => {
      if (url === 'https://github.com/login/device/code') {
        return jsonResponse({ error: 'invalid_request' }, 422)
      }
      return jsonResponse({}, 404)
    })
    await expect(runOAuthLogin('github-copilot', COPILOT_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('OAuth device authorization failed (HTTP 422)')
  })

  it('codex：device-code 起始端点 4xx → 失败并带 HTTP 状态', async () => {
    mockFetch(async (url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return jsonResponse({ error: 'invalid_client' }, 400)
      }
      return jsonResponse({}, 404)
    })
    await expect(runOAuthLogin('openai-codex', OPENAI_CODEX_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('OAuth device authorization failed (HTTP 400)')
  })
})

describe('runOAuthLogin — token exchange 错误路径（MF-1）', () => {
  it('anthropic：callback exchange 端点 500 → 失败并带 HTTP 状态', async () => {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://platform.claude.com/v1/oauth/token') {
        return jsonResponse({}, 500)
      }
      return realFetch(url, init)
    }))
    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('anthropic', ANTHROPIC_CONFIG, hooks, new AbortController().signal, POLL_TUNING)
    // 先挂 rejection handler：exchange 在 callback 到达后立即 reject，早于下方 await fetch 返回，
    // 不先挂 handler 会被 Node 报为 unhandled rejection
    const assertion = expect(flow).rejects.toThrow('OAuth token exchange failed (HTTP 500)')
    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    const state = url.searchParams.get('state') as string
    const callbackPort = new URL(url.searchParams.get('redirect_uri') as string).port
    await fetch(`http://127.0.0.1:${callbackPort}/callback?code=authz-123&state=${state}`)
    await assertion
  })

  it('openrouter：key exchange 端点 500 → 失败并带 HTTP 状态', async () => {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://openrouter.ai/api/v1/auth/keys') {
        return jsonResponse({}, 500)
      }
      return realFetch(url, init)
    }))
    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('openrouter', OPENROUTER_CONFIG, hooks, new AbortController().signal, POLL_TUNING)
    // 先挂 rejection handler（同 anthropic：exchange 在 callback 到达后立即 reject）
    const assertion = expect(flow).rejects.toThrow('OAuth key exchange failed (HTTP 500)')
    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    const callbackUrl = url.searchParams.get('callback_url') as string
    await fetch(`${callbackUrl}?code=or-code`)
    await assertion
  })

  it('openai-codex：二次 exchange 端点 500 → 失败并带 HTTP 状态', async () => {
    mockFetch(async (url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return jsonResponse({ device_auth_id: 'da-1', user_code: 'CODEX-CODE', interval: '1' })
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return jsonResponse({ authorization_code: 'authz-code', code_verifier: 'verifier-x' })
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return jsonResponse({}, 500)
      }
      return jsonResponse({}, 404)
    })
    await expect(runOAuthLogin('openai-codex', OPENAI_CODEX_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('OAuth token exchange failed (HTTP 500)')
  })

  it('copilot：Copilot token exchange 端点 500 → 失败并带 HTTP 状态', async () => {
    mockFetch(async (url) => {
      if (url === 'https://github.com/login/device/code') {
        return jsonResponse({
          device_code: 'dc-gh', user_code: 'GH-CODE',
          verification_uri: 'https://github.com/login/device', interval: 0.05, expires_in: 900,
        })
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'github-token' })
      }
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        return jsonResponse({}, 500)
      }
      return jsonResponse({}, 404)
    })
    await expect(runOAuthLogin('github-copilot', COPILOT_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('Copilot token exchange failed (HTTP 500)')
  })

  it('exchange 阶段 abort：token 端点挂起时 abort signal 立即中断（验证 signal 串联）', async () => {
    // 注入挂起 fetch：永不 resolve，仅 signal abort 时 reject（验证 signal 串联到 exchange fetch）。
    // 30s 超时用 AbortSignal.timeout 不受 vi fake timer 控制，用挂起 fetch + 手动 abort 替代验证串联
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://platform.claude.com/v1/oauth/token') {
        return new Promise<Response>((_, reject) => {
          const sig = init?.signal as AbortSignal | undefined
          if (sig?.aborted) reject(new Error('aborted'))
          else sig?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return realFetch(url, init)
    }))

    const controller = new AbortController()
    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('anthropic', ANTHROPIC_CONFIG, hooks, controller.signal, POLL_TUNING)
    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    const state = url.searchParams.get('state') as string
    const callbackPort = new URL(url.searchParams.get('redirect_uri') as string).port
    // 触发 exchange（callback 到达 → exchange 发起，挂起）；给 exchange 一点时间发起后再 abort
    await fetch(`http://127.0.0.1:${callbackPort}/callback?code=authz-123&state=${state}`)
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    await expect(flow).rejects.toThrow()
  })
})

describe('runOAuthLogin — device poll 错误处理（MF-3）', () => {
  it('device poll fetch 抛错（网络错误/超时 abort）转结构化 failed，不穿透成裸 throw', async () => {
    mockFetch(async (url) => {
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 0.05, expires_in: 1800,
        })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        // 模拟网络层 fetch 抛错（DNS/连接重置）——验证 poll catch 转结构化 failed
        throw new TypeError('fetch failed')
      }
      return jsonResponse({}, 404)
    })
    await expect(runOAuthLogin('xai', XAI_CONFIG, {}, new AbortController().signal, POLL_TUNING))
      .rejects.toThrow('OAuth device token request timed out')
  })
})

/**
 * A2 集成自检（代替真实平台验收）：fixture auth.json + 真实 AuthService/AuthStorage +
 * 真实 fetcher 注册表（不 mock quota-providers），仅 mock 全局 fetch 的 HTTP 响应。
 *
 * 验证链路完整：凭证从 auth.json 取到（经 AuthService.getCredential 通道）→
 * 请求携带该凭证（header 断言）→ 401 失败 reason='unauthorized' 透传到查询结果与 getCached。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run test/services/quota-auth-chain.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaService } from '../../src/services/quota-service.js'
import { TaijiProviderStore } from '../../src/services/provider-extras-store.js'
import { AuthStorage } from '../../src/services/auth/auth-storage.js'
import { AuthService } from '../../src/services/auth/auth-service.js'
import { ProviderCredentialResolver } from '../../src/services/auth/provider-credential-resolver.js'
import { setModelsPath } from '../../src/infra/pi/pi-provider-store.js'
import { PiConfigStore } from '../../src/infra/pi/pi-config-store.js'

let dir: string
let agentDir: string
let authJsonPath: string
let extrasStore: TaijiProviderStore
let authService: AuthService
const mockFetch = vi.fn()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quota-auth-chain-'))
  agentDir = join(dir, 'agent')
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  // models.json：无 kimi-coding / zai-coding-cn 条目 → api-key 形态的 models.json 来源必 miss，
  // 凭证只能来自 auth.json（证明断链修复）
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: { 'other-provider': { apiKey: 'other-key', baseUrl: 'https://other.example.com' } },
  }, null, 2))
  authJsonPath = join(agentDir, 'auth.json')
  extrasStore = new TaijiProviderStore(join(agentDir, 'config', 'providers.json'))
  authService = new AuthService({
    authStorage: new AuthStorage(authJsonPath),
    getOAuthConfig: () => undefined,
    broadcast: () => {},
    nextPushId: () => '1',
    clearApiKey: () => {},
  })
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 写 fixture auth.json（AuthService.get 经 AuthStorage 读同一文件格式）。 */
function writeAuthJson(credentials: Record<string, unknown>): void {
  writeFileSync(authJsonPath, JSON.stringify(credentials, null, 2), 'utf-8')
}

/**
 * 组合根同款注入（M2fg 恒注入形态）：api-key 段经 ProviderCredentialResolver（authService +
 * authStorage + configStore 三依赖，index.ts 同款）；oauth 段仍经 getAuthCredential
 * （AuthService.getCredential，直读现值不 refresh——D6）。
 */
function makeService(): QuotaService {
  const resolver = new ProviderCredentialResolver({
    authService,
    authStorage: new AuthStorage(authJsonPath),
    configStore: new PiConfigStore(),
  })
  return new QuotaService({
    dataDir: dir,
    providerExtrasStore: extrasStore,
    getProviderInfo: (id) => (id === 'kimi-coding' || id === 'zai-coding-cn'
      ? { name: id, quota: { fetcher: id === 'kimi-coding' ? 'kimi-coding' : 'zhipu' } }
      : undefined),
    getAuthCredential: (providerId) => authService.getCredential(providerId),
    providerCredentialResolver: resolver,
  })
}

describe('A2 集成自检 — auth.json oauth 凭证 + kimi + 401 → unauthorized 全链路', () => {
  it('凭证取自 auth.json oauth.access → 请求带 Bearer → 401 失败 reason 透传', async () => {
    // fixture auth.json：fake oauth credential（模拟 kimi-coding oauth 登录态）
    writeAuthJson({
      'kimi-coding': {
        type: 'oauth',
        access: 'fake-oauth-access',
        refresh: 'fake-refresh',
        expires: Date.now() + 3_600_000,
      },
    })
    // 启用 kimi-coding 套餐（providers.json quota 绑定）
    await extrasStore.modify('kimi-coding', () => ({
      quota: { fetcher: 'kimi-coding', enabled: true },
    }))
    const svc = makeService()

    // fetch mock：401（模拟 token 过期）
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await svc.refresh('kimi-coding')

    // ① 凭证从 auth.json 取到并携带：Bearer fake-oauth-access（唯一可能来源是 auth.json oauth）
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const headers = new Headers(mockFetch.mock.calls[0][1].headers)
    expect(headers.get('authorization')).toBe('Bearer fake-oauth-access')

    // ② 失败 reason 透传：data=null 失败态 + reason=unauthorized（D6：不自动 refresh）
    expect(result.data).toBeNull()
    expect(result.reason).toBe('unauthorized')

    // ③ getCached 携带 reason（无旧缓存 → data=null；「查看上次成功数据」数据结构就绪）
    const cached = svc.getCached('kimi-coding')
    expect(cached.data).toBeNull()
    expect(cached.reason).toBe('unauthorized')
  })
})

describe('A2 集成自检 — auth.json api_key 凭证 + zhipu（场景 A 断链修复）', () => {
  it('凭证取自 auth.json api_key.key → 请求带裸 authorization（无 Bearer）→ 查询成功', async () => {
    // fixture auth.json：fake api_key credential（M5-01 catalog 凭证形态）
    writeAuthJson({
      'zai-coding-cn': { type: 'api_key', key: 'auth-json-api-key' },
    })
    await extrasStore.modify('zai-coding-cn', () => ({
      quota: { fetcher: 'zhipu', enabled: true },
    }))
    const svc = makeService()

    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', percentage: 40 }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await svc.refresh('zai-coding-cn')

    // 凭证从 auth.json 取到：zhipu 裸 authorization 头（无 Bearer 前缀）
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const headers = new Headers(mockFetch.mock.calls[0][1].headers)
    expect(headers.get('authorization')).toBe('auth-json-api-key')

    // 修复前该链路断开（凭证 null → 静默返回缓存不发请求）；修复后真实发出并成功
    expect(result.data?.label).toBe('Z.ai-Max')
    expect(result.data?.wins[0]?.pct).toBe(40)
    expect(result.reason).toBeUndefined()
  })
})

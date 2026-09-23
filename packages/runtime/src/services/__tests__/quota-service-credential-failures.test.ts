/**
 * QuotaService 凭据失败分流测试（code-harden RT-7#4 / RT-7#7）。
 *
 * 覆盖：
 * - RT-7#4：resolver 返回 unsupported（command / unresolved-env）→ 查询失败
 *   reason='credential-unsupported'，fetchQuota **不被调用**（禁止以形态标记串作
 *   Bearer 下发外部请求）
 * - RT-7#7：resolver 读盘抛错（io）→ reason='credential-unavailable'（与 no-credential
 * 分流），warn 落日志；secret 文件读盘失败（目录占位 → EISDIR）同归
 * credential-unavailable
 * - 对照组：resolver 全 miss → no-credential（既有语义不变）
 *
 * 测试框架：vitest。策略：注入假 api-key fetcher（调用计数断言「未发请求」）+
 * 可编程 resolver 替身，与 quota-service-workspace.test.ts 同模式。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/quota-service-credential-failures.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderQuotaFetcher, QuotaFetchOutcome } from '@taiji/shared'
import type { IProviderCredentialResolver, ResolvedProviderCredential } from '../ports/provider-credential-resolver.js'
import { QuotaService } from '../quota-service.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
import { QUOTA_FETCHERS } from '../quota-providers/index.js'
import { logger } from '../../infra/logger.js'

vi.mock('../../infra/pi/pi-provider-store.js', () => ({
  getProviderConfig: vi.fn(() => undefined),
}))
vi.mock('../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** 可编程 resolver 替身：resolveProviderCredential 的返回值由用例注入。 */
let nextResolved: Promise<ResolvedProviderCredential | undefined> = Promise.resolve(undefined)
const stubResolver: IProviderCredentialResolver = {
  hasProviderCredential: () => false,
  listCredentialBackedProviderIds: () => new Set<string>(),
  resolveProviderCredential: () => nextResolved,
}

let dir: string
let extrasStore: TaijiProviderStore
let fetchCalls: number

/** 调用计数版假 fetcher（auth=['api-key']：provider 源走 resolver 链路）。 */
const fakeApiKeyFetcher: ProviderQuotaFetcher = {
  id: 'fake-apikey-fetcher',
  auth: ['api-key'],
  async fetchQuota(): Promise<QuotaFetchOutcome> {
    fetchCalls += 1
    return { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
  },
}

function makeService(): QuotaService {
  return new QuotaService({
    dataDir: dir,
    providerExtrasStore: extrasStore,
    providerExists: () => true,
    getProviderInfo: () => ({ quota: { fetcher: 'fake-apikey-fetcher' } }),
    providerCredentialResolver: stubResolver,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quota-service-cred-fail-'))
  extrasStore = new TaijiProviderStore(join(dir, 'config', 'providers.json'))
  QUOTA_FETCHERS.set(fakeApiKeyFetcher.id, fakeApiKeyFetcher)
  fetchCalls = 0
  nextResolved = Promise.resolve(undefined)
})

afterEach(() => {
  QUOTA_FETCHERS.delete(fakeApiKeyFetcher.id)
  vi.clearAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('RT-7#4：unsupported 凭据形态在发请求前拦截', () => {
  it('resolver 返回 { unsupported: "command" } → credential-unsupported，fetchQuota 零调用', async () => {
    nextResolved = Promise.resolve({ unsupported: 'command' })
    const svc = makeService()

    const result = await svc.refresh('p1')

    expect(result.data).toBeNull()
    expect(result.reason).toBe('credential-unsupported')
    expect(fetchCalls).toBe(0)
  })

  it('resolver 返回 { unsupported: "unresolved-env" } → 同拦（不降级不发请求）', async () => {
    nextResolved = Promise.resolve({ unsupported: 'unresolved-env' })
    const svc = makeService()

    const result = await svc.refresh('p1')

    expect(result.reason).toBe('credential-unsupported')
    expect(fetchCalls).toBe(0)
  })
})

describe('RT-7#7：io 失败与无凭据分流', () => {
  it('resolver 抛错（auth.json/models.json 读盘失败）→ credential-unavailable（非 no-credential）+ warn', async () => {
    nextResolved = Promise.reject(new Error('EBUSY: resource locked, auth.json'))
    const svc = makeService()

    const result = await svc.refresh('p1')

    expect(result.data).toBeNull()
    expect(result.reason).toBe('credential-unavailable')
    expect(fetchCalls).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      '[quota] failed to resolve provider credential (auth.json / models.json)',
      expect.objectContaining({ providerId: 'p1' }),
    )
  })

  it('cookie secret 文件读盘失败（EISDIR）→ credential-unavailable，warn 带文件路径', async () => {
    const cookieFetcher: ProviderQuotaFetcher = {
      id: 'fake-cookie-io-fetcher',
      auth: ['cookie'],
      async fetchQuota(): Promise<QuotaFetchOutcome> {
        fetchCalls += 1
        return { ok: false, reason: 'network' }
      },
    }
    QUOTA_FETCHERS.set(cookieFetcher.id, cookieFetcher)
    try {
      const svc = new QuotaService({
        dataDir: dir,
        providerExtrasStore: extrasStore,
        providerExists: () => true,
        getProviderInfo: () => ({ quota: { fetcher: cookieFetcher.id } }),
        providerCredentialResolver: stubResolver,
      })
      // 目录占位 secrets/<pid>-cookie.txt：existsSync=true、readFileSync 抛 EISDIR
      mkdirSync(join(dir, 'secrets', 'p1-cookie.txt'), { recursive: true })

      const result = await svc.refresh('p1')

      expect(result.reason).toBe('credential-unavailable')
      expect(fetchCalls).toBe(0)
      expect(logger.warn).toHaveBeenCalledWith(
        '[quota] failed to read secret file',
        expect.objectContaining({ filePath: join(dir, 'secrets', 'p1-cookie.txt') }),
      )
    } finally {
      QUOTA_FETCHERS.delete(cookieFetcher.id)
    }
  })

  it('对照组：resolver 全 miss → no-credential（既有语义保持）', async () => {
    nextResolved = Promise.resolve(undefined)
    const svc = makeService()

    const result = await svc.refresh('p1')

    expect(result.data).toBeNull()
    expect(result.reason).toBe('no-credential')
    expect(fetchCalls).toBe(0)
  })
})

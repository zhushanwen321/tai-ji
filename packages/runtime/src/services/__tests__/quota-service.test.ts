/**
 * quota-service：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - quota-service-credential-failures.test.ts
 *   - quota-service-workspace.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/__tests__/quota-service.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderQuotaFetcher, QuotaFetchOutcome, QuotaFetcherConfig } from '@taiji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../infra/logger.js'
import type { IProviderCredentialResolver, ResolvedProviderCredential } from '../ports/provider-credential-resolver.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
import { getQuotaFetcher } from '../quota-providers/index.js'
import { QuotaService } from '../quota-service.js'

// ── quota-providers 桩（两节共用：工厂提升为文件级，注册表随行提升到本层；各节用例动态 put/delete）──
const fakeFetchers = new Map<string, ProviderQuotaFetcher>()

vi.mock('../quota-providers/index.js', () => ({
  getQuotaFetcher: vi.fn((id: string) => fakeFetchers.get(id) ?? null),
  listQuotaPresets: vi.fn(() => []),
}))


// ════════════════ 来源: quota-service-credential-failures.test.ts ════════════════
describe('quota-service-credential-failures', () => {
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
  // W3 迁移：QUOTA_FETCHERS 可变注册表退役（基线 ⊕ 远程合并视图只读）——fake fetcher
  // 注入改走模块 mock（getQuotaFetcher 按注册表返回，测试用例动态 put/delete）


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
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
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
    fakeFetchers.set(fakeApiKeyFetcher.id, fakeApiKeyFetcher)
    fetchCalls = 0
    nextResolved = Promise.resolve(undefined)
  })

  afterEach(() => {
    fakeFetchers.delete(fakeApiKeyFetcher.id)
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
      fakeFetchers.set(cookieFetcher.id, cookieFetcher)
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
        fakeFetchers.delete(cookieFetcher.id)
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
});

// ════════════════ 来源: quota-service-workspace.test.ts ════════════════
describe('quota-service-workspace', () => {
  /**
   * QuotaService workspace 配置读写与注入测试（timeout-audit-hygiene-batch D1-1~D1-4）。
   *
   * 覆盖：
   * - configure：workspace 完整 URL / 裸 wrk_ id 归一化落盘（P1-1）；非法输入 fail-fast 不落盘；
   *   空串 = 清除；未传 = 继承既有值（三态语义）
   * - doFetch：providers.json 读出的 workspace 经 QuotaFetcherConfig.workspaceUrl 注入 fetcher
   * - not_configured 透传：fetcher 报 not_configured 时失败态原样透传（data=null + reason）
   *
   * 测试框架：vitest。策略：真实文件系统（临时目录）+ 注入假 fetcher（URL 注入点断言），
   * 与 provider-write-side-switch.test.ts 同模式。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/__tests__/quota-service-workspace.test.ts
   */
  // W3 迁移：QUOTA_FETCHERS 可变注册表退役（基线 ⊕ 远程合并视图只读）——fake fetcher
  // 注入改走模块 mock（getQuotaFetcher 按注册表返回，测试用例动态 put/delete）


  vi.mock('../../infra/pi/pi-provider-store.js', () => ({
    getProviderConfig: vi.fn(() => undefined),
  }))
  // logger 落盘隔离（不依赖真实 dataDir）
  vi.mock('../../infra/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }))

  /**
   * 恒注入形态的 resolver 替身（M2fg：QuotaService 构造必需）。本文件 fetcher 均为
   * cookie 形态，resolver 不参与 cookie 段——miss 形态即可。
   */
  const stubResolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: async () => undefined,
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
  }

  let dir: string
  let agentDir: string
  let extrasStore: TaijiProviderStore

  /** 记录注入点的假 fetcher（auth=['cookie']，与 opencode 同形态）。 */
  let lastConfig: QuotaFetcherConfig | undefined
  let nextOutcome: QuotaFetchOutcome = { ok: false, reason: 'not_configured' }

  const fakeFetcher: ProviderQuotaFetcher = {
    id: 'fake-cookie-fetcher',
    auth: ['cookie'],
    async fetchQuota(_credential, _kind, config) {
      lastConfig = config
      return nextOutcome
    },
  }

  function readQuotaRaw(): Record<string, unknown> | undefined {
    return extrasStore.getExtrasSync('p1')?.quota as Record<string, unknown> | undefined
  }

  function makeService(): QuotaService {
    return new QuotaService({
      dataDir: dir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      // fetcher 路由：getFetcherForProvider 读 ProviderInfo.quota.fetcher（非 extrasStore），
      // 测试统一注入指向假 fetcher
      getProviderInfo: () => ({ quota: { fetcher: 'fake-cookie-fetcher' } }),
      providerCredentialResolver: stubResolver,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quota-service-workspace-'))
    agentDir = join(dir, 'agent')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir
    extrasStore = new TaijiProviderStore(join(agentDir, 'config', 'providers.json'))
    fakeFetchers.set(fakeFetcher.id, fakeFetcher)
    lastConfig = undefined
    nextOutcome = { ok: false, reason: 'not_configured' }
  })

  afterEach(() => {
    fakeFetchers.delete(fakeFetcher.id)
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('QuotaService.configure · workspace 三态（D1-1/P1-1）', () => {
    it('完整 URL 归一化为规范 URL 落盘', async () => {
      const svc = makeService()
      const result = await svc.configure({ providerId: 'p1', enabled: true, workspace: 'https://opencode.ai/workspace/wrk_abc/go' })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.workspace).toBe('https://opencode.ai/workspace/wrk_abc/go')
    })

    it('裸 wrk_ id 归一化为规范 URL 落盘（P1-1 两形态）', async () => {
      const svc = makeService()
      const result = await svc.configure({ providerId: 'p1', enabled: true, workspace: 'wrk_bareid9' })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.workspace).toBe('https://opencode.ai/workspace/wrk_bareid9/go')
    })

    it('非法输入 → ok:false 不落盘（fail-fast，不写半成品配置）', async () => {
      const svc = makeService()
      const result = await svc.configure({ providerId: 'p1', enabled: true, workspace: 'https://evil.example.com/workspace/wrk_abc/go' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('opencode.ai')
      // 清除之外的非法输入不落任何 workspace
      expect(readQuotaRaw()?.workspace).toBeUndefined()
    })

    it('空字符串 = 清除（quota 块无 workspace 字段，恢复未配置态）', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, workspace: 'wrk_abc' })
      expect(readQuotaRaw()?.workspace).toBe('https://opencode.ai/workspace/wrk_abc/go')

      const cleared = await svc.configure({ providerId: 'p1', enabled: true, workspace: '  ' })
      expect(cleared).toEqual({ ok: true })
      expect(readQuotaRaw()?.workspace).toBeUndefined()
    })

    it('未传 workspace（undefined）= 继承既有值不被清掉', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'fake-cookie-fetcher', workspace: 'wrk_keep77' })
      // 只改 enabled 不传 workspace
      await svc.configure({ providerId: 'p1', enabled: false })
      expect(readQuotaRaw()?.workspace).toBe('https://opencode.ai/workspace/wrk_keep77/go')
      expect(readQuotaRaw()?.enabled).toBe(false)
    })

    it('fetcher=opendesign 时裸 workspace id 按 opendesign 规则归一化（分流）', async () => {
      const svc = makeService()
      const result = await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opendesign',
        workspace: 'userownws01',
      })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.workspace).toBe(
        'https://amr-api.open-design.ai/api/v1/workspaces/userownws01/billing/coding-plan-usage',
      )
    })

    it('同 input 在无 fetcher 上下文时按缺省 opencode 规则拒绝（分流不改缺省行为）', async () => {
      const svc = makeService()
      const result = await svc.configure({ providerId: 'p1', enabled: true, workspace: 'userownws01' })
      expect(result.ok).toBe(false)
      expect(readQuotaRaw()?.workspace).toBeUndefined()
    })

    it('payload 不传 fetcher 时按既存配置的 fetcher 分流（部分更新）', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opendesign' })
      const result = await svc.configure({ providerId: 'p1', enabled: true, workspace: 'secondws02' })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.workspace).toBe(
        'https://amr-api.open-design.ai/api/v1/workspaces/secondws02/billing/coding-plan-usage',
      )
    })
  })

  describe('QuotaService.configure · cookie 入站归一化（SG-10，wire 不信任）', () => {
    const cookiePath = (): string => join(dir, 'secrets', 'p1-cookie.txt')

    it('合法输入归一化后落盘（空白伪影 / Cookie: 头名被剥）', async () => {
      const svc = makeService()
      const result = await svc.configure({ providerId: 'p1', enabled: true, cookie: 'Cookie:  a = 1 ;  b = 2 ' })

      expect(result).toEqual({ ok: true })
      expect(readFileSync(cookiePath(), 'utf-8')).toBe('a=1; b=2')
    })

    it('非空输入归一化后为空 → fail-fast（不落盘、不误报成功）', async () => {
      const svc = makeService()
      const result = await svc.configure({ providerId: 'p1', enabled: true, cookie: '\tName\tValue\tauth\txyz' })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('格式无效')
      expect(existsSync(cookiePath())).toBe(false)
    })

    it('空串 = 清除（合法态，不误判格式错误）', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'a=1' })

      expect(await svc.configure({ providerId: 'p1', enabled: true, cookie: '' })).toEqual({ ok: true })
      expect(existsSync(cookiePath())).toBe(false)
    })
  })

  describe('QuotaService.doFetch · workspace 注入与 not_configured 透传（D1-2/D1-3）', () => {
    it('providers.json 读出的 workspace 经 config.workspaceUrl 注入 fetcher', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'fake-cookie-fetcher', workspace: 'wrk_inject1' })
      // 写 cookie 凭证（cookie 文件）保证 resolveCredential 命中
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123' })

      nextOutcome = { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
      const result = await svc.refresh('p1')

      expect(result.data).toEqual({ label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] })
      expect(lastConfig?.workspaceUrl).toBe('https://opencode.ai/workspace/wrk_inject1/go')
    })

    it('未配置 workspace → 注入 undefined，fetcher 报 not_configured 原样透传（D1-3）', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123', fetcher: 'fake-cookie-fetcher' })

      const result = await svc.refresh('p1')

      expect(result.data).toBeNull()
      expect(result.reason).toBe('not_configured')
      expect(lastConfig?.workspaceUrl).toBeUndefined()
    })

    it('fetcher 报 not_configured 不写缓存（getCached 携带 reason 供 UI 失败态）', async () => {
      const svc = makeService()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123', fetcher: 'fake-cookie-fetcher' })
      await svc.refresh('p1')

      const cached = svc.getCached('p1')
      expect(cached.data).toBeNull()
      expect(cached.reason).toBe('not_configured')
    })
  })
});

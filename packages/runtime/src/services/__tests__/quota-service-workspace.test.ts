/**
 * QuotaService workspace 配置读写与注入测试（timeout-audit-hygiene-batch D1-1~D1-4）。
 *
 * 覆盖：
 * - configure：workspace 完整 URL / 裸 wrk_ id 归一化落盘（P1-1）；非法输入 fail-fast 不落盘；
 *   空串 = 清除；未传 = 继承既有值（三态语义）
 * - doFetch：providers.json 读出的 workspace 经 QuotaFetcherConfig.workspaceUrl 注入 fetcher
 * - not_configured 透传：fetcher 报 not_configured 时失败态原样透传（data=null + reason）
 *
 * 测试框架：vitest。策略：真实文件系统（临时目录）+ 注入假 fetcher（URL 注入面断言），
 * 与 provider-write-side-switch.test.ts 同模式。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/quota-service-workspace.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderQuotaFetcher, QuotaFetcherConfig, QuotaFetchOutcome } from '@taiji/shared'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import { QuotaService } from '../quota-service.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
import { QUOTA_FETCHERS } from '../quota-providers/index.js'

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
}

let dir: string
let agentDir: string
let extrasStore: TaijiProviderStore

/** 记录注入面的假 fetcher（auth=['cookie']，与 opencode 同形态）。 */
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
  QUOTA_FETCHERS.set(fakeFetcher.id, fakeFetcher)
  lastConfig = undefined
  nextOutcome = { ok: false, reason: 'not_configured' }
})

afterEach(() => {
  QUOTA_FETCHERS.delete(fakeFetcher.id)
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
})

describe('QuotaService.doFetch · workspace 注入与 not_configured 透传（D1-2/D1-3）', () => {
  it('providers.json 读出的 workspace 经 config.workspaceUrl 注入 fetcher', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'fake-cookie-fetcher', workspace: 'wrk_inject1' })
    // 写 cookie 凭证（cookie 文件）保证 resolveCredential 命中
    await svc.configure({ providerId: 'p1', enabled: true, cookie: 'cookie-value' })

    nextOutcome = { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
    const result = await svc.refresh('p1')

    expect(result.data).toEqual({ label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] })
    expect(lastConfig?.workspaceUrl).toBe('https://opencode.ai/workspace/wrk_inject1/go')
  })

  it('未配置 workspace → 注入 undefined，fetcher 报 not_configured 原样透传（D1-3）', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, cookie: 'cookie-value', fetcher: 'fake-cookie-fetcher' })

    const result = await svc.refresh('p1')

    expect(result.data).toBeNull()
    expect(result.reason).toBe('not_configured')
    expect(lastConfig?.workspaceUrl).toBeUndefined()
  })

  it('fetcher 报 not_configured 不写缓存（getCached 携带 reason 供 UI 失败态）', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, cookie: 'cookie-value', fetcher: 'fake-cookie-fetcher' })
    await svc.refresh('p1')

    const cached = svc.getCached('p1')
    expect(cached.data).toBeNull()
    expect(cached.reason).toBe('not_configured')
  })
})

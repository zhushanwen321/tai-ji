/**
 * QuotaService 用户维度参数（quotaParams）配置读写与注入测试
 * （timeout-audit-hygiene-batch D1-1~D1-4 起源；2026-10 workspace 单字段泛化为 params）。
 *
 * 覆盖：
 * - configure：params 逐键按 preset 声明的 param spec 归一化落盘（opencode-workspace /
 *   opendesign-workspace 分流；未知键 raw 透传）；非法输入 fail-fast 不落盘；
 *   null/空串 = 清除该键；键缺省 = 继承既有值（逐键三态语义）
 * - doFetch：providers.json 读出的 params 经 QuotaFetcherConfig.quotaParams 注入 fetcher；
 *   旧版 workspace 单字段读侧映射为 params.workspaceUrl（泛化前持久化数据兼容）
 * - not_configured 透传：fetcher 报 not_configured 时失败态原样透传（data=null + reason）
 *
 * 测试框架：vitest。策略：真实文件系统（临时目录）+ 注入假 fetcher（URL 注入点断言），
 * 与 provider-write-side-switch.test.ts 同模式。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/quota-service-workspace.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderQuotaFetcher, QuotaFetcherConfig, QuotaFetchOutcome, QuotaPreset } from '@taiji/shared'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import { QuotaService } from '../quota-service.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
// W3 迁移：QUOTA_FETCHERS 可变注册表退役（基线 ⊕ 远程合并视图只读）——fake fetcher
// 注入改走模块 mock（getQuotaFetcher 按注册表返回，测试用例动态 put/delete）
import { getQuotaFetcher } from '../quota-providers/index.js'

const fakeFetchers = new Map<string, ProviderQuotaFetcher>()

// param spec 驱动归一化：listQuotaPresets 提供 opencode-go / opendesign 两家的 spec
// （与 shared QUOTA_PRESETS 同形态——service 只读 .fetcher 与 .params[].key/.normalize）
const PARAM_PRESETS: QuotaPreset[] = [
  {
    fetcher: 'opencode-go',
    label: 'OpenCode Go',
    auth: ['cookie'],
    match: {},
    params: [{ key: 'workspaceUrl', normalize: 'opencode-workspace' }],
  },
  {
    fetcher: 'opendesign',
    label: 'OpenDesign Coding Plan',
    auth: ['cookie'],
    match: {},
    params: [{ key: 'workspaceUrl', normalize: 'opendesign-workspace' }],
  },
]

vi.mock('../quota-providers/index.js', () => ({
  getQuotaFetcher: vi.fn((id: string) => fakeFetchers.get(id) ?? null),
  listQuotaPresets: vi.fn(() => PARAM_PRESETS),
}))

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
  dir = mkdtempSync(join(tmpdir(), 'quota-service-params-'))
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

describe('QuotaService.configure · params 逐键归一化（D1-1/P1-1，2026-10 泛化）', () => {
  it('完整 URL 归一化为规范 URL 落盘（opencode spec 分流）', async () => {
    const svc = makeService()
    const result = await svc.configure({
      providerId: 'p1',
      enabled: true,
      fetcher: 'opencode-go',
      params: { workspaceUrl: 'https://opencode.ai/workspace/wrk_abc/go' },
    })
    expect(result).toEqual({ ok: true })
    expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_abc/go' })
  })

  it('裸 wrk_ id 归一化为规范 URL 落盘（P1-1 两形态）', async () => {
    const svc = makeService()
    const result = await svc.configure({
      providerId: 'p1',
      enabled: true,
      fetcher: 'opencode-go',
      params: { workspaceUrl: 'wrk_bareid9' },
    })
    expect(result).toEqual({ ok: true })
    expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_bareid9/go' })
  })

  it('非法输入 → ok:false 不落盘（fail-fast，不写半成品配置；host 白名单安全边界）', async () => {
    const svc = makeService()
    const result = await svc.configure({
      providerId: 'p1',
      enabled: true,
      fetcher: 'opencode-go',
      params: { workspaceUrl: 'https://evil.example.com/workspace/wrk_abc/go' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('opencode.ai')
    // 清除之外的非法输入不落任何 params
    expect(readQuotaRaw()?.params).toBeUndefined()
  })

  it('null / 空串 = 清除该键（quota.params 无该键，恢复未配置态）', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opencode-go', params: { workspaceUrl: 'wrk_abc' } })
    expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_abc/go' })

    const cleared = await svc.configure({ providerId: 'p1', enabled: true, params: { workspaceUrl: '  ' } })
    expect(cleared).toEqual({ ok: true })
    expect(readQuotaRaw()?.params).toBeUndefined()
  })

  it('未传 params（undefined）= 继承既有值不被清掉（逐键三态）', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opencode-go', params: { workspaceUrl: 'wrk_keep77' } })
    // 只改 enabled 不传 params
    await svc.configure({ providerId: 'p1', enabled: false })
    expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_keep77/go' })
    expect(readQuotaRaw()?.enabled).toBe(false)
  })

  it('fetcher=opendesign 时裸 workspace id 按 opendesign 规则归一化（spec 分流）', async () => {
    const svc = makeService()
    const result = await svc.configure({
      providerId: 'p1',
      enabled: true,
      fetcher: 'opendesign',
      params: { workspaceUrl: 'userownws01' },
    })
    expect(result).toEqual({ ok: true })
    expect(readQuotaRaw()?.params).toEqual({
      workspaceUrl: 'https://amr-api.open-design.ai/api/v1/workspaces/userownws01/billing/coding-plan-usage',
    })
  })

  it('preset 未声明的键（远程 preset 先行 / 自定义参数）按 raw 透传——不阻断保存', async () => {
    const svc = makeService()
    const result = await svc.configure({
      providerId: 'p1',
      enabled: true,
      fetcher: 'opencode-go',
      params: { workspaceUrl: 'wrk_x1', orgId: 'org-123' },
    })
    expect(result).toEqual({ ok: true })
    expect(readQuotaRaw()?.params).toEqual({
      workspaceUrl: 'https://opencode.ai/workspace/wrk_x1/go',
      orgId: 'org-123',
    })
  })

  it('payload 不传 fetcher 时按既存配置的 fetcher 分流（部分更新）', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opendesign' })
    const result = await svc.configure({ providerId: 'p1', enabled: true, params: { workspaceUrl: 'secondws02' } })
    expect(result).toEqual({ ok: true })
    expect(readQuotaRaw()?.params).toEqual({
      workspaceUrl: 'https://amr-api.open-design.ai/api/v1/workspaces/secondws02/billing/coding-plan-usage',
    })
  })

  it('多键部分更新：只动传入键，其余键继承（逐键合并不是整表替换）', async () => {
    const svc = makeService()
    await svc.configure({
      providerId: 'p1',
      enabled: true,
      fetcher: 'opencode-go',
      params: { workspaceUrl: 'wrk_multi1', orgId: 'org-keep' },
    })
    await svc.configure({ providerId: 'p1', enabled: true, params: { workspaceUrl: 'wrk_multi2' } })
    expect(readQuotaRaw()?.params).toEqual({
      workspaceUrl: 'https://opencode.ai/workspace/wrk_multi2/go',
      orgId: 'org-keep',
    })
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

describe('QuotaService.doFetch · params 注入与 not_configured 透传（D1-2/D1-3）', () => {
  it('providers.json 读出的 params 经 config.quotaParams 注入 fetcher', async () => {
    const svc = makeService()
    // fetcher=opencode-go 走 preset spec 归一化（裸 wrk_ id → 规范 URL 落盘）
    await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opencode-go', params: { workspaceUrl: 'wrk_inject1' } })
    // 写 cookie 凭证（cookie 文件）保证 resolveCredential 命中
    await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123' })

    nextOutcome = { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
    const result = await svc.refresh('p1')

    expect(result.data).toEqual({ label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] })
    expect(lastConfig?.quotaParams).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_inject1/go' })
  })

  it('未配置 params → 注入 undefined，fetcher 报 not_configured 原样透传（D1-3）', async () => {
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123', fetcher: 'fake-cookie-fetcher' })

    const result = await svc.refresh('p1')

    expect(result.data).toBeNull()
    expect(result.reason).toBe('not_configured')
    expect(lastConfig?.quotaParams).toBeUndefined()
  })

  it('旧版 workspace 单字段（泛化前持久化）读侧映射为 params.workspaceUrl 注入', async () => {
    // 直接以旧版磁盘形态写入 providers.json（quota.workspace 单字符串，无 params 键）
    writeFileSync(
      join(agentDir, 'config', 'providers.json'),
      JSON.stringify({
        version: 1,
        providers: {
          p1: {
            quota: { fetcher: 'fake-cookie-fetcher', enabled: true, workspace: 'https://opencode.ai/workspace/wrk_legacy1/go' },
          },
        },
      }),
    )
    const svc = makeService()
    await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123' })

    nextOutcome = { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
    await svc.refresh('p1')

    expect(lastConfig?.quotaParams).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_legacy1/go' })
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

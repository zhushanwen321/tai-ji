/**
 * QuotaService 单测。
 *
 * 最初的聚焦点：偏差 #B（providerId→fetcher 映射）+ 偏差 #C（refresh 绕过 throttle）。
 *   任务 1 回归防护：providerId 是用户自定义 id（如 'my-zhipu'），不是 fetcher id（'zhipu'）——
 *   必须经 getProviderInfo → matchQuotaPreset 路由到正确 fetcher，旧实现用 === 导致静默失败。
 *   任务 3 回归防护：refresh 绕过 10s throttle，测试查询每次都发真实请求。
 *
 * 后续随 §7.3 runtime 改动落地，文件已扩到覆盖 no-credential 显式失败、cookie 空串清除、
 * 按 credentialSource 解析凭证（D3，含 exclusive 不回退其它 auth 形态）、删除与写入顺序 /
 * 半提交、finishFetch 五出口与在途写回守卫、失败路径节流、clearProviderState 等。
 * **当期覆盖面以各 describe 列表为准**（条目随改动增删，此处不逐条罗列，避免与用例脱节）。
 *
 * 运行：cd packages/runtime && npx vitest run test/services/quota-service.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaService } from '../../src/services/quota-service.js'
import type { ProviderInfoLike } from '../../src/services/quota-service.js'
import { TaijiProviderStore } from '../../src/services/provider-extras-store.js'
import type { IProviderCredentialResolver } from '../../src/services/ports/provider-credential-resolver.js'

// vi.hoisted 提升变量到 vi.mock factory 可访问的位置（factory 会被 hoist 到文件顶部）
// [A2-1] fetcher 接口数组化：authType 单值 → auth 数组；fetchQuota(credential, kind)
// kimi-coding 用独立 mock 实例：「手动 fetcher 优先于 preset 匹配」用例需要区分
// 「命中 kimi-coding 而非 zhipu」的可证伪信号（共享同一 mock 时优先级退化无法检出）
const { mockFetchQuota, kimiMockFetchQuota, oauthOnlyMockFetchQuota, mockFetchers } = vi.hoisted(() => {
  const mockFetchQuota = vi.fn()
  const kimiMockFetchQuota = vi.fn()
  // 纯 oauth fetcher（auth 不含 api-key）：支撑「exclusive 对不适用形态不生效」用例
  // （§7 残留 11，UI/runtime 共用 supportsExclusiveCredential 判据）
  const oauthOnlyMockFetchQuota = vi.fn()
  const mockFetchers = new Map([
    ['zhipu', { id: 'zhipu', auth: ['api-key'] as const, fetchQuota: mockFetchQuota }],
    ['kimi-coding', { id: 'kimi-coding', auth: ['api-key', 'oauth'] as const, fetchQuota: kimiMockFetchQuota }],
    ['mimo', { id: 'mimo', auth: ['cookie'] as const, fetchQuota: mockFetchQuota }],
    ['oauth-only', { id: 'oauth-only', auth: ['oauth'] as const, fetchQuota: oauthOnlyMockFetchQuota }],
  ])
  return { mockFetchQuota, kimiMockFetchQuota, oauthOnlyMockFetchQuota, mockFetchers }
})

// ── mock QUOTA_FETCHERS：注入可控 fetcher，不依赖真实 HTTP ──
vi.mock('../../src/services/quota-providers/index.js', () => ({
  QUOTA_FETCHERS: mockFetchers,
}))

// ── mock pi-provider-store：模拟 quota 配置持久化 ──（凭据读取已收口 resolver，M2fg）
vi.mock('../../src/infra/pi/pi-provider-store.js', () => ({
  getProviderConfig: vi.fn(() => undefined),
  upsertProvider: vi.fn(() => ({})),
}))

import { getProviderConfig, upsertProvider } from '../../src/infra/pi/pi-provider-store.js'

/**
 * 恒注入形态的 resolver 替身（M2fg：QuotaService 构造必需，降级内联链已删除）。
 * 默认按 id 命中 `key-for-<id>`（models.json 源）——对齐旧 getApiKeyForProvider mock 的
 * 「models.json 通道有值」基线；miss 场景传 `() => undefined`。
 */
function makeResolver(
  resolve: (providerId: string) => { key: string; source: 'auth.json' | 'models.json' } | undefined
    = (id: string) => ({ key: `key-for-${id}`, source: 'models.json' as const }),
): IProviderCredentialResolver {
  return {
    hasProviderCredential: vi.fn(() => false),
    listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
    resolveProviderCredential: vi.fn(async (id: string) => resolve(id)),
  }
}

let tmpDir: string
let extrasStore: TaijiProviderStore
let extrasPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-svc-'))
  extrasPath = join(tmpDir, 'agent', 'config', 'providers.json')
  extrasStore = new TaijiProviderStore(extrasPath)
  vi.clearAllMocks()
  vi.mocked(getProviderConfig).mockImplementation(() => undefined)
  vi.mocked(upsertProvider).mockImplementation(() => ({}))
  mockFetchQuota.mockReset()
  kimiMockFetchQuota.mockReset()
  oauthOnlyMockFetchQuota.mockReset()
})

/** 读 providers.json 单 provider 断言用（文件不存在返回 undefined = 无扩展数据）。 */
function readExtras(providerId: string): Record<string, unknown> | undefined {
  if (!existsSync(extrasPath)) return undefined
  return (JSON.parse(readFileSync(extrasPath, 'utf-8')).providers as Record<string, Record<string, unknown>>)[providerId]
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('QuotaService — 偏差 #B: providerId→fetcher 映射', () => {
  it('providerId 不等于 fetcher id 时，经 getProviderInfo→matchQuotaPreset 路由到正确 fetcher', async () => {
    // 用户自定义 provider id='my-glm'，baseUrl 命中 zhipu preset
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: (id) =>
        id === 'my-glm'
          ? { baseUrl: 'https://open.bigmodel.cn/api', name: '智谱 GLM' }
          : undefined,
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('my-glm')

    // 旧实现用 QUOTA_PRESETS.find(p => p.fetcher === providerId) 会匹配失败 → 静默返回缓存
    // 新实现经 matchQuotaPreset 命中 zhipu，调到 mock fetcher
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
    // api-key 凭证经 resolver 按 providerId 解析（key-for-my-glm），kind 按来源形态传递
    expect(mockFetchQuota).toHaveBeenCalledWith('key-for-my-glm', 'api-key', { workspaceUrl: undefined })
  })

  it('name 关键字匹配：provider name 含 zhipu 命中 zhipu preset', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ name: 'Zhipu BigModel' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('custom-id')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('getProviderInfo 未注入时 fallback：providerId 直接查 fetchers（兼容恰好等于 fetcher id）', async () => {
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir})
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('zhipu')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('getProviderInfo 返回的 baseUrl/name 都不命中 preset → 不调 fetcher（静默降级缓存）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://unknown.example.com', name: 'unknown' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: false, reason: 'network' })

    await svc.fetch('weird-id')

    expect(mockFetchQuota).not.toHaveBeenCalled()
  })
})

describe('QuotaService — 偏差 #C: refresh 绕过 throttle', () => {
  it('refresh 绕过 10s throttle，连续调用都触发 fetcher', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.refresh('zhipu')
    await svc.refresh('zhipu')

    // 两次都触发（refresh 不检查 lastFetchTime）
    expect(mockFetchQuota).toHaveBeenCalledTimes(2)
  })

  it('fetch 受 throttle：10s 内第二次 fetch 不触发 fetcher（返回缓存）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('zhipu')
    await svc.fetch('zhipu')

    // fetch 第二次被 throttle 拦截
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })
})

describe('QuotaService — 手动选择 fetcher（任务 1）', () => {
  it('quota.fetcher 手动指定时优先于 matchQuotaPreset', async () => {
    // baseUrl 命中 zhipu preset，但用户手动指定用 kimi-coding fetcher
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        name: '智谱 GLM',
        quota: { fetcher: 'kimi-coding' },
      }),
    })
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    const result = await svc.fetch('my-glm')

    // 走手动指定的 kimi-coding（独立 mock 实例）而非 baseUrl 匹配的 zhipu；
    // zhipu 的 mock 未被调用 = 优先级退化回 preset 匹配时可证伪
    expect(kimiMockFetchQuota).toHaveBeenCalledTimes(1)
    expect(kimiMockFetchQuota).toHaveBeenCalledWith('key-for-my-glm', 'api-key', { workspaceUrl: undefined })
    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data?.label).toBe('kimi')
  })

  it('quota.fetcher 指定了一个不存在的 id 时 fallback 到 matchQuotaPreset', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        quota: { fetcher: 'nonexistent-fetcher' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('my-glm')

    // 手动指定的 id 不存在 → fallback 到自动匹配的 zhipu
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('quota.fetcher 手动指定后不再依赖 baseUrl/name（空 baseUrl 也能命中）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://my-reverse-proxy.example.com',
        name: 'my-proxy',
        quota: { fetcher: 'zhipu' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('my-proxy')

    // baseUrl 是自建反代（不命中任何 preset），但手动指定了 zhipu → 仍命中
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })
})

describe('QuotaService — configure 持久化（任务 4，A1-5 写侧切换：落 config/providers.json）', () => {
  it('configure 持久化 fetcher/enabled 到 providers.json，不再写 models.json', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
      apiKey: 'k',
    }))
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    const result = await svc.configure({ providerId: 'my-glm', enabled: true, fetcher: 'zhipu' })

    expect(result.ok).toBe(true)
    expect(readExtras('my-glm')).toEqual({ quota: { fetcher: 'zhipu', enabled: true } })
    // A1-5：quota 不再经 upsertProvider 写 models.json（寄生字段禁复活）
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure 未传 fetcher 时保留既有 quota.fetcher（providers.json 无条目回退 models.json 旧值）', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      quota: { fetcher: 'kimi-coding', enabled: false },
    }))
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    await svc.configure({ providerId: 'my-glm', enabled: true })

    expect(readExtras('my-glm')).toEqual({ quota: { fetcher: 'kimi-coding', enabled: true } })
  })

  it('configure provider 不存在时返回 ok=false', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => undefined)
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    const result = await svc.configure({ providerId: 'nonexistent', enabled: true, fetcher: 'zhipu' })

    expect(result.ok).toBe(false)
    expect(upsertProvider).not.toHaveBeenCalled()
    // §7.3 改动 2：存在性检查移进 modify 回调后，modify 的锁前 ensureFileExists 会物化
    // 空的 providers.json（原检查在 modify 之前完全不触文件）——文件被物化但**无该
    // provider 条目**（回调抛 ProviderGoneError → 写入被跳过，僵尸条目未产生）
    expect(existsSync(extrasPath)).toBe(true)
    expect(readExtras('nonexistent')).toBeUndefined()
  })

  it('persist 失败（extrasStore.modify reject）→ ok=false + "failed to persist quota config"，secrets 不被触碰', async () => {
    // round-1 review MUST_FIX #2 + §7.3 改动 2 顺序重排：persistQuotaConfig 的 modify
    // catch 分支——persist 失败时 secrets 物理写入尚未执行（secrets 段在 persist 之后），
    // cookie 文件不应被创建；configure 必须报错而不是静默吞掉
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://xiaomimimo.com',
    }))
    const modifySpy = vi.spyOn(extrasStore, 'modify').mockRejectedValue(new Error('EACCES: disk full'))
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    const result = await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: 'session=abc123', fetcher: 'mimo' })

    expect(result).toEqual({ ok: false, error: 'failed to persist quota config' })
    expect(modifySpy).toHaveBeenCalledTimes(1)
    // 顺序重排（原断言方向：cookie 文件已落盘、持久化失败不回滚已写 secret）：secrets 段
    // 在 persist 之后，persist 失败 → cookie 文件与 secrets 目录均不被创建——凭证不再
    // 先于配置落盘，也就不存在「文件不可回滚」的坏状态
    expect(existsSync(join(tmpDir, 'secrets', 'mimo-id-cookie.txt'))).toBe(false)
    // providers.json 未物化（modify 被 spy 替换，锁前 ensureFileExists 未执行），
    // models.json 也不写（寄生字段禁复活）
    expect(existsSync(extrasPath)).toBe(false)
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure cookie 类写入 cookie 文件 + 标记 cookieSet', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://xiaomimimo.com',
    }))
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    const result = await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: 'session=abc123', fetcher: 'mimo' })

    expect(result.ok).toBe(true)
    expect(readExtras('mimo-id')).toEqual({ quota: { fetcher: 'mimo', enabled: true, cookieSet: true } })
    expect(upsertProvider).not.toHaveBeenCalled()
  })
})

// ── [S4] code review 补充测试：健壮性回归防护（W5/W7/W6/getCredential fallback/apiKey 清除）──

describe('QuotaService — W5: refresh 不污染 fetch 的 throttle', () => {
  it('refresh 不更新 lastFetchTime（force 路径不污染后续 fetch 的 throttle 判定）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    // 先 refresh（force）：不更新 lastFetchTime
    await svc.refresh('zhipu')
    // 紧接着 fetch：若 refresh 污染了 lastFetchTime，此刻 elapsed≈0 < 10s 会被拦 → 调 1 次
    // W5 修复后 refresh 不设 lastFetchTime → fetch 不被拦，正常发 → 调 2 次
    await svc.fetch('zhipu')

    expect(mockFetchQuota).toHaveBeenCalledTimes(2)
  })
})

describe('QuotaService — W7: refresh 与 fetch pending 互不复用', () => {
  it('refresh 命中并发 fetch 的 pending 时不会返回非 force 结果（pending key 带 force 维度）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 用一个可手动 resolve 的 promise 模拟「fetch 先发起、未 resolve 时 refresh 并发到达」
    let resolveFetch!: (v: { ok: true; data: { label: string; wins: never[] } }) => void
    mockFetchQuota.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r as typeof resolveFetch
      }),
    )
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu-force', wins: [] as never } })

    // fetch（normal）先发起，进入 pending（key=zhipu:normal），尚未 resolve
    const fetchP = svc.fetch('zhipu')
    // refresh（force）并发达，pending key=zhipu:force ≠ zhipu:normal → 不复用，独立发第二个请求
    const refreshP = svc.refresh('zhipu')

    // [A2-2] 凭证解析链含 await（getAuthCredential）——fetchQuota 调用延后一个微任务，
    // 等一拍再断言（旧实现同步解析凭证，调用零延迟）
    await new Promise((r) => setImmediate(r))
    // 两个 pending 各自发起了一次 fetcher 调用（互不复用 = W7 修复后的行为）
    expect(mockFetchQuota).toHaveBeenCalledTimes(2)

    resolveFetch({ ok: true, data: { label: 'zhipu-normal', wins: [] as never } })
    await Promise.all([fetchP, refreshP])
  })
})

describe('QuotaService — getCredential fallback: api-key 类无专属 key 时经 resolver（M2fg 恒注入）', () => {
  it('secrets 目录无专属 API Key 文件时，fallback 到 resolver 解析的 provider 凭据', async () => {
    // secrets 目录未写入任何 <id>-apikey.txt → getCredential 走 resolver（auth.json → models.json）
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver((id) => ({ key: `provider-key-${id}`, source: 'models.json' })),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    // 无专属 key → fallback 用 resolver 解析的 provider 凭据（'provider-key-glm-id'）
    expect(mockFetchQuota).toHaveBeenCalledWith('provider-key-glm-id', 'api-key', { workspaceUrl: undefined })
  })

  it('secrets 目录有专属 API Key 文件时优先用专属 key（不 fallback）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      // §7.3 改动 2 顺序重排后 configure 的 secrets 写入以 persist 成功为前提，
      // providerExists 必须注入（生产恒注入聚合层判定；未注入的默认回退走 models.json，
      // 本文件 mock 返回 undefined 会让 persist 失败、secrets 不写）
      providerExists: () => true,
      // §7.3 改动 3：api-key 按 credentialSource 分支——apiKeySet=true 且未显式设置
      // credentialSource 时，resolveQuotaCredentialSource 推断 'exclusive'（历史数据形态，
      // 对齐生产 getProviderInfo 从 providers.json 读 quota 的注入形态）
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { apiKeySet: true } }),
    })
    // 先写入专属 key 文件
    await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', apiKey: 'quota-exclusive-key' })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    // 有专属 key → 用专属 key（'quota-exclusive-key'），不走 fallback
    expect(mockFetchQuota).toHaveBeenCalledWith('quota-exclusive-key', 'api-key', { workspaceUrl: undefined })
  })
})

describe('QuotaService — W4 + apiKey 清除路径', () => {
  it('configure 传 apiKey="" 时删除专属 key 文件 + 标记 apiKeySet=false（落 providers.json）', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
    }))
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    // 先写入专属 key，再清除
    await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', apiKey: 'some-key' })
    const keyPath = join(tmpDir, 'secrets', 'glm-id-apikey.txt')
    expect(existsSync(keyPath)).toBe(true)

    // 清除：传 apiKey=''
    const result = await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', apiKey: '' })

    expect(result.ok).toBe(true)
    expect(existsSync(keyPath)).toBe(false)
    expect(readExtras('glm-id')).toEqual({ quota: { fetcher: 'zhipu', enabled: true, apiKeySet: false } })
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('configure 写入的 secret 文件权限为 0o600（仅属主可读写）', async () => {
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://bigmodel.cn',
    }))
    const svc = new QuotaService({ providerCredentialResolver: makeResolver(), dataDir: tmpDir, providerExtrasStore: extrasStore})

    await svc.configure({ providerId: 'glm-id', enabled: true, cookie: 'cookie-val' })

    const cookiePath = join(tmpDir, 'secrets', 'glm-id-cookie.txt')
    const mode = statSync(cookiePath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('QuotaService — W6: 不同 providerId 并发 update 不丢数据', () => {
  it('并发 fetch 两个不同 provider 后，两者缓存都在（写串行化不丢）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: (id) =>
        id === 'p-a'
          ? { baseUrl: 'https://bigmodel.cn' }
          : id === 'p-b'
            ? { name: 'Zhipu BigModel' }
            : undefined,
    })

    mockFetchQuota.mockImplementation(async () => ({
      ok: true,
      data: {
        label: 'zhipu',
        wins: [
          { pct: 10, resetSec: 100 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ] as never,
      },
    }))

    // 并发 fetch 两个 provider → cache.update 内部串到写链，互不覆盖
    await Promise.all([svc.fetch('p-a'), svc.fetch('p-b')])

    // 等一拍让 writeChain flush（update 外层同步返回，内部 writeChain 异步链 flush）
    await new Promise((r) => setImmediate(r))

    const a = svc.getCached('p-a')
    const b = svc.getCached('p-b')
    // 两个 provider 缓存都应存在（若 update 无串行化，后写者会覆盖前者的整文件快照 → 丢一个）
    expect(a.data).not.toBeNull()
    expect(b.data).not.toBeNull()
  })
})

// ── [A2-2] 凭证解析链（三形态；auth.json/models.json 两段经 resolver，M2fg 收口）──

describe('QuotaService — A2-2: api-key 形态优先级（secrets > resolver 两段）', () => {
  it('secrets 专属 key 与 resolver 命中并存时优先 secrets（resolver 不被调用）', async () => {
    const resolver = makeResolver()
    const svc = new QuotaService({
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      // §7.3 改动 2 顺序重排：secrets 写入以 persist 成功为前提，需注入存在性判定
      providerExists: () => true,
      // §7.3 改动 3：来源为 exclusive（apiKeySet=true 推断）才读专属 key 文件
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { apiKeySet: true } }),
      providerCredentialResolver: resolver,
    })
    await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', apiKey: 'secrets-key' })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('secrets-key', 'api-key', { workspaceUrl: undefined })
    expect(vi.mocked(resolver.resolveProviderCredential)).not.toHaveBeenCalled()
  })
})

describe('QuotaService — A2-2: oauth 形态与 kimi 双形态降级', () => {
  it('auth.json 只有 oauth 凭证时，api-key 形态不误用 oauth 凭证（继续走 resolver 两段）', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://api.kimi.com',
        quota: { fetcher: 'kimi-coding' },
      }),
      getAuthCredential: async () => ({
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'r',
        expires: Date.now() + 3_600_000,
      }),
      providerCredentialResolver: makeResolver(),
    })
    // resolver 命中 api-key 形态（key-for-<id>）→ 应先于 oauth 形态
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    await svc.fetch('kimi-id')

    // auth 数组序 ['api-key','oauth']：api-key 形态有凭证（models.json）则用 api-key，
    // oauth 凭证不回灌 api-key 形态（形态语义隔离）
    expect(kimiMockFetchQuota).toHaveBeenCalledWith('key-for-kimi-id', 'api-key', { workspaceUrl: undefined })
  })

  it('kimi 场景：无 api-key 凭证（来源 provider，resolver miss——§7.3 改动 3 跳过专属 key 文件）但有 oauth 凭证 → 按数组序降级用 oauth', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://api.kimi.com',
        quota: { fetcher: 'kimi-coding' },
      }),
      getAuthCredential: async () => ({
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'r',
        expires: Date.now() + 3_600_000,
      }),
      providerCredentialResolver: makeResolver(() => undefined),
    })
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    await svc.fetch('kimi-id')

    // api-key 形态全 miss → 数组序下一形态 oauth，凭证取 access，kind='oauth'
    expect(kimiMockFetchQuota).toHaveBeenCalledTimes(1)
    expect(kimiMockFetchQuota).toHaveBeenCalledWith('oauth-access-token', 'oauth', { workspaceUrl: undefined })
  })

  it('cookie 类 fetcher：凭证从 secrets cookie 文件读，kind=cookie', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      // §7.3 改动 2 顺序重排：secrets 写入以 persist 成功为前提，需注入存在性判定
      providerExists: () => true,
      getProviderInfo: () => ({
        baseUrl: 'https://platform.xiaomimimo.com',
        quota: { fetcher: 'mimo' },
      }),
      getAuthCredential: async () => ({ type: 'api_key', key: 'auth-json-key' }),
      providerCredentialResolver: makeResolver(),
    })
    // 写入 cookie 文件（secrets 来源）
    await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: 'session=abc', fetcher: 'mimo' })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'mimo', wins: [] as never } })

    await svc.fetch('mimo-id')

    // cookie 形态只认 secrets cookie 文件（auth.json api_key 不参与），kind='cookie'
    expect(mockFetchQuota).toHaveBeenCalledWith('session=abc', 'cookie', { workspaceUrl: undefined })
  })

  it('api-key/oauth 形态全 miss（fetcher.auth 不含 cookie）→ 不发请求，显式失败 no-credential', async () => {
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      getAuthCredential: async () => undefined,
      providerCredentialResolver: makeResolver(() => undefined),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    const result = await svc.fetch('glm-id')

    // §7.3 改动 1：凭证缺失从「静默返回缓存」变为显式失败（reason=no-credential，
    // lastFailure 落内存供 getCached 透传），仍不发请求
    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
    expect(result.reason).toBe('no-credential')
  })
})

/**
 * M2b：链 1 迁移到 resolver（设计 D3 收口）。
 *
 * 语义边界：secrets 专属额度 key 是 Coding Plan 私有语义，仍优先且不并入 resolver；
 * 其后的 auth.json / models.json 两段统一走 resolver async 版。
 */
describe('QuotaService — M2b 链 1: 凭据两段经 resolver（secrets 首段保留）', () => {
  /** 固定返回值形态的 resolver 替身（与顶层 makeResolver 的按 id 回调形态区分）。 */
  function makeResultResolver(result: { key: string; source: 'auth.json' | 'models.json' } | undefined) {
    return {
      hasProviderCredential: vi.fn(() => false),
      listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
      resolveProviderCredential: vi.fn(async () => result),
    } as unknown as IProviderCredentialResolver
  }

  it('secrets 专属 key 仍优先，不被 resolver 覆盖（resolver 不被调用）', async () => {
    const resolver = makeResultResolver({ key: 'resolver-key', source: 'auth.json' })
    const svc = new QuotaService({
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      // §7.3 改动 2 顺序重排：secrets 写入以 persist 成功为前提，需注入存在性判定
      providerExists: () => true,
      // §7.3 改动 3：来源为 exclusive（apiKeySet=true 推断）才读专属 key 文件
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { apiKeySet: true } }),
      providerCredentialResolver: resolver,
    })
    await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', apiKey: 'secrets-key' })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('secrets-key', 'api-key', { workspaceUrl: undefined })
    expect(vi.mocked(resolver.resolveProviderCredential)).not.toHaveBeenCalled()
  })

  it('无 secrets key 时 auth.json 段经 resolver 命中（场景 A 断链修复）', async () => {
    const resolver = makeResultResolver({ key: 'auth-json-key', source: 'auth.json' })
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      providerCredentialResolver: resolver,
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(vi.mocked(resolver.resolveProviderCredential)).toHaveBeenCalledWith('glm-id')
    expect(mockFetchQuota).toHaveBeenCalledWith('auth-json-key', 'api-key', { workspaceUrl: undefined })
  })

  it('resolver 落到 models.json 源时同样命中', async () => {
    const resolver = makeResultResolver({ key: 'models-json-key', source: 'models.json' })
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      providerCredentialResolver: resolver,
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('models-json-key', 'api-key', { workspaceUrl: undefined })
  })

  it('resolver 未命中 → api-key 形态无凭证，不发请求（zhipu 仅 api-key 形态）', async () => {
    const resolver = makeResultResolver(undefined)
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      providerCredentialResolver: resolver,
    })

    const result = await svc.fetch('glm-id')

    expect(vi.mocked(resolver.resolveProviderCredential)).toHaveBeenCalledWith('glm-id')
    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
  })

  it('resolver 读取异常 → 降级无凭据（不向上抛出）', async () => {
    const resolver = {
      hasProviderCredential: vi.fn(() => false),
      listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
      resolveProviderCredential: vi.fn(async () => { throw new Error('auth.json locked') }),
    } as unknown as IProviderCredentialResolver
    const svc = new QuotaService({
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      providerCredentialResolver: resolver,
    })

    const result = await svc.fetch('glm-id')

    expect(result.data).toBeNull()
    expect(mockFetchQuota).not.toHaveBeenCalled()
  })
})

// ── [A2-4] 失败 reason 透传 ──
describe('QuotaService — A2-4: 失败 reason 透传与清除', () => {
  it('查询失败（unauthorized）→ 结果 data=null + reason；getCached 携带旧缓存数据 + reason', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 预置旧缓存：先成功 fetch 一次
    mockFetchQuota.mockResolvedValueOnce({
      ok: true,
      data: {
        label: 'zhipu',
        wins: [{ pct: 30, resetSec: 50 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never,
      },
    })
    await svc.fetch('glm-id')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush

    // 第二次查询（refresh 绕过 10s throttle——fetch 会被 throttle 拦截返回缓存，测不到失败路径）：401 失败
    mockFetchQuota.mockResolvedValueOnce({ ok: false, reason: 'unauthorized' })
    const result = await svc.refresh('glm-id')

    // 失败态：data=null（旧缓存不作为当前数据展示），reason 透传，lastFetchAt=上次成功时间
    expect(result.data).toBeNull()
    expect(result.reason).toBe('unauthorized')
    expect(result.lastFetchAt).not.toBeNull()

    // getCached：旧缓存数据保留内存（供「查看上次成功数据」）+ reason 透传
    const cached = svc.getCached('glm-id')
    expect(cached.data?.label).toBe('zhipu')
    expect(cached.reason).toBe('unauthorized')
  })

  it('成功后清除 reason（getCached 不再携带失败标记）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    mockFetchQuota.mockResolvedValueOnce({ ok: false, reason: 'network' })
    await svc.fetch('glm-id')
    expect(svc.getCached('glm-id').reason).toBe('network')

    // refresh 强制重查（绕过 throttle）成功 → reason 清除
    mockFetchQuota.mockResolvedValueOnce({
      ok: true,
      data: { label: 'zhipu', wins: [{ pct: 10, resetSec: 5 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never },
    })
    const result = await svc.refresh('glm-id')
    expect(result.data).not.toBeNull()
    expect(result.reason).toBeUndefined()
    expect(svc.getCached('glm-id').reason).toBeUndefined()
  })

  it('无旧缓存时失败：data=null + lastFetchAt=null + reason', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: false, reason: 'no-subscription' })

    const result = await svc.fetch('glm-id')

    expect(result).toEqual({ data: null, lastFetchAt: null, reason: 'no-subscription' })
  })
})

describe('QuotaService — fetcher 抛异常时防御兜底 [A2-1 契约不 throw，逃逸兜底]', () => {
  it('fetcher 抛异常时降级为 network 失败态（不 reject，不返回旧缓存数据）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    // 预置旧缓存：先成功 fetch 一次
    mockFetchQuota.mockResolvedValueOnce({
      ok: true,
      data: {
        label: 'zhipu',
        wins: [{ pct: 30, resetSec: 50 }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] as never,
      },
    })
    await svc.fetch('glm-id')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush

    // 第二次查询（refresh 绕过 throttle）：fetcher 抛异常（契约外逃逸）
    mockFetchQuota.mockRejectedValueOnce(new Error('network down'))
    const result = await svc.refresh('glm-id')

    // 不 reject，降级 network 失败态（data=null + reason=network）
    expect(result.data).toBeNull()
    expect(result.reason).toBe('network')
    // 旧缓存仍可经 getCached 查看（内存保留）
    expect(svc.getCached('glm-id').data?.label).toBe('zhipu')
  })

  it('fetcher 抛异常且无旧缓存时返回空失败态（lastFetchAt=null）', async () => {
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockRejectedValue(new Error('always fails'))

    const result = await svc.fetch('glm-id')

    expect(result).toEqual({ data: null, lastFetchAt: null, reason: 'network' })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// U2 新增行为用例（设计 coding-plan-quota-config-ux §7.5「quota-service.test.ts 新增」行
// + §7.3 改动 1/2/3/4/6 行为规格）。
//
// 背景：U2-t1 只更新了既有 36 用例的断言方向，零新增；本文件所属设计清单要求的新行为
// （no-credential / cookie 空串清除与失败语义 / 按 credentialSource 解析凭证 /
// lastFailure 清理 / credentialSource 落盘继承链 / 在途 fetch 写回守卫 / 失败路径节流不断）
// 全部由本节补齐。每条用例的断言都落在调用方可见面（返回 data/reason、getCached、
// providers.json 落盘结果、secrets 文件系统状态），而非内部私有字段。
// ══════════════════════════════════════════════════════════════════════════

describe('QuotaService — U2①: no-credential 显式失败（§7.5 清单 / 改动 1）', () => {
  it('api-key 类 provider 无任何可用凭证 → 显式失败 no-credential，lastFailure 经 getCached 可见', async () => {
    // 防的回归：改动 1 之前凭证缺失是 `return this.getCached(providerId)`——静默返回
    // 缓存（无请求、无日志、无 reason），浮层/编辑体表现为 idle 或「暂无额度数据」，
    // 用户看不到「没凭证」这个唯一可行动的原因。
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => undefined),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    const result = await svc.fetch('glm-id')

    // 不发请求（无凭证）——但仍要「显式失败」而不是「看起来成功」
    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
    expect(result.reason).toBe('no-credential')
    // 调用方（浮层 getCached / 编辑体 loadCached）拿到同一真相：reason 可见
    expect(svc.getCached('glm-id').data).toBeNull()
    expect(svc.getCached('glm-id').reason).toBe('no-credential')
  })

  it('有旧缓存时凭证消失 → 不再静默返回旧缓存；显式失败 + 旧数据仍可经 getCached 查看', async () => {
    // 防的回归：这是改动 1 的「行为变更点」最尖锐的形态——先成功缓存一行，凭证随后
    // 消失（被外部删除/切换来源），旧实现会把旧行当成功结果返回（UI 显示过期数据却
    // 无任何失败信号）；新实现必须显式失败，同时保留旧数据供「查看上次成功数据」。
    let cred: { key: string; source: 'models.json' } | undefined = { key: 'provider-key', source: 'models.json' }
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => cred),
      dataDir: tmpDir,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
    })

    mockFetchQuota.mockResolvedValueOnce({ ok: true, data: { label: 'zhipu', wins: [] as never } })
    await svc.fetch('glm-id')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush
    expect(svc.getCached('glm-id').data?.label).toBe('zhipu')

    // 凭证消失后强制重查（refresh 绕过 throttle）
    cred = undefined
    const result = await svc.refresh('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledTimes(1) // 只有第一次成功请求，第二次未发
    expect(result.data).toBeNull() // 旧缓存不作为当前数据返回
    expect(result.reason).toBe('no-credential')
    expect(result.lastFetchAt).not.toBeNull() // 失败态标注上次成功时间
    expect(svc.getCached('glm-id').data?.label).toBe('zhipu') // 旧缓存保留内存
    expect(svc.getCached('glm-id').reason).toBe('no-credential')
  })
})

describe('QuotaService — U2②: cookie 空串 = 清除（§7.5 清单 / 改动 2）', () => {
  it('cookie 空串：目标文件存在则删除 + cookieSet=false；文件不存在时幂等成功', async () => {
    // 防的回归：旧实现 writeCookieSecret(pid, '') 会物化一个空文件且置 cookieSet=true，
    // 而读取端 readSecret 把空内容当 null → 「标记说已配置、实际没有」的幽灵态。
    vi.mocked(getProviderConfig).mockImplementation(() => ({
      name: 'test',
      baseUrl: 'https://xiaomimimo.com',
    }))
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
    })
    const cookiePath = join(tmpDir, 'secrets', 'mimo-id-cookie.txt')

    await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: 'session=abc123', fetcher: 'mimo' })
    expect(existsSync(cookiePath)).toBe(true)

    const result = await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: '' })

    expect(result.ok).toBe(true)
    expect(existsSync(cookiePath)).toBe(false) // 空串 = 物理删除
    expect(readExtras('mimo-id')?.quota).toEqual({ fetcher: 'mimo', enabled: true, cookieSet: false })

    // 幂等（设计原文「文件不存在视为成功，不先 existsSync 预检——预检本身是 TOCTOU」）：
    // 文件已不存在时再传空串仍成功，且标记维持 false
    const again = await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: '' })
    expect(again.ok).toBe(true)
    expect(readExtras('mimo-id')?.quota).toEqual({ fetcher: 'mimo', enabled: true, cookieSet: false })
  })

  it('cookie 空串清除时物理删除失败 → configure 整体返回 error（半提交：persist 已落 cookieSet=false）', async () => {
    // 防的回归：清除分支若吞掉 unlink 失败（旧 writeApiKeySecret 只 logger.debug 后仍返回
    // 已清除），会留下「标记 false + 文件仍在」的反向幽灵——exclusive/provider 读侧仍可能
    // 读到已作废的凭证。设计 §7.3 改动 2 要求删除失败返回 error 使 configure 整体失败。
    //
    // 失败注入点：用「同名目录」占据 cookie 文件路径——unlinkSync(目录) 抛 EPERM（非
    // ENOENT，removeSecretFile 不会误判为幂等成功）。比 chmod 只读目录更稳（root 会绕过）。
    const secretsDir = join(tmpDir, 'secrets')
    mkdirSync(secretsDir, { recursive: true })
    const cookiePath = join(secretsDir, 'mimo-id-cookie.txt')
    mkdirSync(cookiePath)

    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
    })

    const result = await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: '', fetcher: 'mimo' })

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
    // 半提交方向（设计 §7.3 改动 2 显式登记）：persist 在 secrets 物理操作之前，已提交
    // 清除标记；调用方拿到失败信号即知情，重试一次自愈
    expect(readExtras('mimo-id')?.quota).toEqual({ fetcher: 'mimo', enabled: true, cookieSet: false })
    expect(existsSync(cookiePath)).toBe(true)
  })

  it('半提交（persist 成功 + secrets 段失败）时清理已发生：fetcher 变更的旧缓存行与失败原因不得残留', async () => {
    // 防的回归：清理块被放回 secrets 早退之后（半提交路径漏清，改动 4 失效）——persist
    // 已提交新 fetcher，而缓存行与失败原因仍属旧类型，浮层/编辑体会把旧平台数据以新类型
    // 标签展示，正是改动 4 要消除的现象。secrets 段失败不回滚 persist（设计 §7.3 登记的
    // 半提交方向），所以清理必须锚定 persist 成功本身，且排在 secrets 物理写入之前。
    // 失败注入点沿用上方半提交用例的手法：用同名目录占据 cookie 文件路径——第三段写入时
    // 对目录 writeFileSync 抛 EISDIR（非 ENOENT，writeCookieSecret 不会误判为成功）。
    const cookiePath = join(tmpDir, 'secrets', 'p-cookie.txt')
    let cred: { key: string; source: 'models.json' } | undefined = { key: 'provider-key', source: 'models.json' }
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => cred),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { fetcher: 'zhipu' } }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    // ① 旧类型（zhipu）先落一行成功缓存
    await svc.fetch('p')
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush（与 U2① 同款）
    expect(svc.getCached('p').data?.label).toBe('zhipu')

    // ② 制造失败原因：凭证消失 → refresh 显式 no-credential（旧缓存行保留内存）
    cred = undefined
    await svc.refresh('p')
    expect(svc.getCached('p').reason).toBe('no-credential')
    expect(svc.getCached('p').data?.label).toBe('zhipu')

    // ③ 让第三段必失败（recursive 顺带建出 secrets 目录，ensureSecretsDir 直接放行）
    mkdirSync(cookiePath, { recursive: true })

    // ④ 换类型（zhipu → mimo）并传 cookie → secrets 段写入失败，configure 整体失败
    const result = await svc.configure({ providerId: 'p', enabled: true, fetcher: 'mimo', cookie: 'x' })

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
    // 半提交方向：persist 已提交新 fetcher/cookieSet（secrets 段失败不回滚）
    expect(readExtras('p')?.quota).toMatchObject({ fetcher: 'mimo', enabled: true, cookieSet: true })

    // ⑤ 清理已在 secrets 段失败之前完成：失败原因与旧类型缓存行都不残留
    expect(svc.getCached('p').reason).toBeUndefined()
    await new Promise((r) => setImmediate(r)) // 等 writeChain flush removeEntry 的磁盘删除
    expect(svc.getCached('p').data).toBeNull()
  })

  it('校验失败（workspace 非法）时 secrets 未被删除：先校验计算 → persist → 成功后才写/删 secrets', async () => {
    // 防的回归：旧顺序是「写/删 secrets → 归一化 workspace → persist」，后两步任一失败时
    // 凭证已被物理删除而 providers.json 未更新（renderer 只回滚本地 fetcherId），文件不可
    // 回滚。重排后：workspace 非法在 persist 之前 fail-fast，secrets 零触碰。
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
    })
    const cookiePath = join(tmpDir, 'secrets', 'mimo-id-cookie.txt')
    await svc.configure({ providerId: 'mimo-id', enabled: true, cookie: 'session=abc', fetcher: 'mimo' })
    expect(existsSync(cookiePath)).toBe(true)

    // 同时传 cookie=''（清除）与非法 workspace：若 secrets 段先执行，文件会被删掉
    const result = await svc.configure({
      providerId: 'mimo-id',
      enabled: true,
      fetcher: 'mimo',
      cookie: '',
      workspace: 'https://evil.example.com',
    })

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(existsSync(cookiePath)).toBe(true) // 校验失败未触碰 secrets
  })
})

describe('QuotaService — U2③: 按 credentialSource 解析凭证（§7.5 清单 / 改动 3）', () => {
  it("source=exclusive：只读专属 Key 文件，缺失即 no-credential 不回退（resolver 不被调用）", async () => {
    // 防的回归：exclusive 来源下若继续回退 auth.json/models.json，就是 §3.2 失败模式 D
    // 「显示用 A、实际用 B」——配置声明了「用专属 Key」而 Key 不在，必须报出来。
    const resolver = makeResolver() // 默认会给 key-for-<id>：模拟 provider 凭据源有值
    const svc = new QuotaService({
      providerCredentialResolver: resolver,
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        quota: { fetcher: 'zhipu', credentialSource: 'exclusive' },
      }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    // 专属 Key 文件不存在 → 即使 resolver 有凭据也不回退
    const miss = await svc.fetch('glm-id')
    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(miss.data).toBeNull()
    expect(miss.reason).toBe('no-credential')
    expect(vi.mocked(resolver.resolveProviderCredential)).not.toHaveBeenCalled()

    // 写入专属 Key 后读专属值（refresh 绕过上一次失败查询写入的 throttle 锚点）
    await svc.configure({
      providerId: 'glm-id',
      enabled: true,
      fetcher: 'zhipu',
      credentialSource: 'exclusive',
      apiKey: 'exclusive-key',
    })
    await svc.refresh('glm-id')

    expect(mockFetchQuota).toHaveBeenCalledWith('exclusive-key', 'api-key', { workspaceUrl: undefined })
    expect(vi.mocked(resolver.resolveProviderCredential)).not.toHaveBeenCalled()
  })

  it('kimi-coding（auth 含 api-key+oauth）+ source=exclusive + 专属 Key 文件缺失 → 不回退 OAuth，落 no-credential', async () => {
    // 防的回归（D3 / §7.3 改动 3 的收窄）：getCredential 的 api-key 分支只做到「exclusive 时
    // 不读 provider 凭据段」，但 resolveCredential 若继续遍历 auth 数组，kimi-coding 紧随的
    // 'oauth' 形态会从 auth.json 读到 OAuth 登录态并**查询成功**——UI 分段控件显示「用专属
    // Key」而 runtime 实际用 provider 的 OAuth，正是 D3 要消灭的「显示用 A、实际用 B」
    // （§3.2 失败模式 D）。三个独立可证伪信号：失败原因、fetchQuota 未被调用、OAuth 读取
    // 替身未被调用（后者不依赖 fetcher 路由，直接证明「根本没走到 oauth 形态」）。
    const oauthReader = vi.fn(async () => ({
      type: 'oauth' as const,
      access: 'oauth-access-token',
      refresh: 'r',
      expires: Date.now() + 3_600_000,
    }))
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(), // provider 凭据段有值：也不得被用到
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      // 生产 ProviderInfo 组装的 quota 即来自 providers.json 落盘值 — 收窄依据的磁盘真相
      getProviderInfo: () => ({
        baseUrl: 'https://api.kimi.com',
        name: 'Kimi Coding',
        quota: readExtras('kimi-id')?.quota as ProviderInfoLike['quota'],
      }),
      getAuthCredential: oauthReader,
    })
    // 幽灵标记态：标记说「用专属 Key」但文件不在（persist→文件写入窗口 / 手工删文件）。
    // 前置态直接经 extrasStore.modify 落盘（不经 configure），让「文件缺失」独立于被测 persist 逻辑。
    await extrasStore.modify('kimi-id', () => ({
      quota: { fetcher: 'kimi-coding', enabled: true, credentialSource: 'exclusive', apiKeySet: true },
    }))
    expect(existsSync(join(tmpDir, 'secrets', 'kimi-id-apikey.txt'))).toBe(false)
    // 若发生回退，这条 mock 会让查询「成功」——正是要消灭的假成功，故红信号不止 reason
    kimiMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'kimi', wins: [] as never } })

    const result = await svc.fetch('kimi-id')

    expect(kimiMockFetchQuota).not.toHaveBeenCalled()
    expect(oauthReader).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
    expect(result.reason).toBe('no-credential')
  })

  it("source=exclusive 但 fetcher.auth 不含 api-key（['oauth']）→ 不走专属 Key 路径，按 auth 数组序解析", async () => {
    // 防的回归（§7 残留 11）：UI 与 runtime 必须共用 supportsExclusiveCredential 判据。
    // 若 runtime 把 exclusive 无条件当成「只用 api-key 形态」，纯 oauth fetcher 会
    // getCredential('api-key') → 读不存在的专属 Key 文件 → no-credential；而 UI 对同一
    // fetcher 根本不渲染「用专属 Key」控件、readiness 按 provider 凭据放行——两端判据背离。
    // 可证伪信号：fetchQuota 以 kind='oauth' 收到 OAuth 现值（而非 not called / no-credential）。
    const oauthReader = vi.fn(async () => ({
      type: 'oauth' as const,
      access: 'oauth-access-token',
      refresh: 'r',
      expires: Date.now() + 3_600_000,
    }))
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => undefined), // api-key 形态无 provider 凭据：不影响本路径
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({
        baseUrl: 'https://oauth-only.example',
        quota: { fetcher: 'oauth-only', credentialSource: 'exclusive' },
      }),
      getAuthCredential: oauthReader,
    })
    oauthOnlyMockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'oauth-only', wins: [] as never } })

    const result = await svc.fetch('oauth-p')

    expect(oauthReader).toHaveBeenCalledWith('oauth-p')
    expect(oauthOnlyMockFetchQuota).toHaveBeenCalledWith('oauth-access-token', 'oauth', {
      workspaceUrl: undefined,
    })
    expect(result.data).not.toBeNull()
  })

  it('source=provider：完全跳过专属 Key 文件（文件仍在但不被读），经 resolver 解析', async () => {
    // 防的回归：provider 来源下若仍读专属 Key 文件，用户「切到 Provider 凭据」后实际仍在
    // 用旧专属 Key（失败模式 D 的另一半）。切换只改标记、不删文件（D3 可逆性）——所以
    // 文件存在是刻意的，可证伪信号是 fetchQuota 收到的凭据不是 'exclusive-key'。
    const resolver = makeResolver((id) => ({ key: `provider-key-${id}`, source: 'models.json' }))
    const svc = new QuotaService({
      providerCredentialResolver: resolver,
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        quota: { fetcher: 'zhipu', credentialSource: 'provider' },
      }),
    })
    const keyPath = join(tmpDir, 'secrets', 'glm-id-apikey.txt')

    await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', apiKey: 'exclusive-key' })
    expect(existsSync(keyPath)).toBe(true)
    await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu', credentialSource: 'provider' })
    expect(readExtras('glm-id')?.quota).toEqual({
      fetcher: 'zhipu',
      enabled: true,
      apiKeySet: true,
      credentialSource: 'provider',
    })

    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })
    await svc.fetch('glm-id')

    expect(vi.mocked(resolver.resolveProviderCredential)).toHaveBeenCalledWith('glm-id')
    expect(mockFetchQuota).toHaveBeenCalledWith('provider-key-glm-id', 'api-key', { workspaceUrl: undefined })
    expect(existsSync(keyPath)).toBe(true) // 来源切换不删文件（可逆）
  })

  it('source=provider 且 resolver 抛异常 → 降级 no-credential（不逃逸成 RPC 无响应）', async () => {
    // 防的回归：改动 3 的 try/catch 降级若被删，resolver 异常会逃出 doFetch（它不在
    // doFetch 的 try 内）→ quota.fetch RPC 无响应 → 退化为 backstop 超时，比
    // no-credential 难诊断得多。
    const resolver = {
      hasProviderCredential: vi.fn(() => false),
      listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
      resolveProviderCredential: vi.fn(async () => {
        throw new Error('auth.json locked')
      }),
    } as unknown as IProviderCredentialResolver
    const svc = new QuotaService({
      providerCredentialResolver: resolver,
      dataDir: tmpDir,
      getProviderInfo: () => ({
        baseUrl: 'https://bigmodel.cn',
        quota: { fetcher: 'zhipu', credentialSource: 'provider' },
      }),
    })

    const result = await svc.fetch('glm-id')

    expect(mockFetchQuota).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
    expect(result.reason).toBe('no-credential')
    expect(svc.getCached('glm-id').reason).toBe('no-credential')
  })
})

describe('QuotaService — U2④: configure 成功后清理 lastFailure（§7.5 清单 / 改动 4）', () => {
  it('configure 成功清除该 provider 的失败标记，再次失败重新记录（清理不是永久屏蔽）', async () => {
    // 防的回归：配置已改变，上一次失败原因不再适用——不清的话用户重开编辑体/浮层仍看到
    // 旧失败态（reason 陈旧）。同时必须验证「清理 ≠ 屏蔽」：下一次真实失败要重新记录。
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => undefined),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { fetcher: 'zhipu' } }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    await svc.fetch('glm-id')
    expect(svc.getCached('glm-id').reason).toBe('no-credential')

    const cfg = await svc.configure({ providerId: 'glm-id', enabled: true, fetcher: 'zhipu' })
    expect(cfg.ok).toBe(true)
    expect(svc.getCached('glm-id').reason).toBeUndefined()

    // 下一次失败重新记录（refresh 绕过 throttle 锚点）
    await svc.refresh('glm-id')
    expect(svc.getCached('glm-id').reason).toBe('no-credential')
  })
})

describe('QuotaService — U2⑤: credentialSource 落盘继承链（§7.5 分段验收 M1 形式 / 改动 6）', () => {
  it('带 credentialSource 的 payload 直调 configure → providers.json 落盘该字段', async () => {
    // M1 结束时 renderer 仍是旧实现、不传 credentialSource，「一次保存并测试后读 providers.json」
    // 在 M1 跑不出来（假阴性）；设计 §7.5 分段验收改为 runtime 单测直调 configure 断言落盘。
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
    })

    const result = await svc.configure({
      providerId: 'my-glm',
      enabled: true,
      fetcher: 'zhipu',
      credentialSource: 'exclusive',
    })

    expect(result.ok).toBe(true)
    const quota = readExtras('my-glm')?.quota as Record<string, unknown> | undefined
    expect(quota?.credentialSource).toBe('exclusive')
    expect(quota?.fetcher).toBe('zhipu')
    expect(quota?.enabled).toBe(true)
  })

  it('setEnabled 式 payload（其余键缺省）：既存显式 credentialSource 不被覆盖、未设置值不被物化成推断值（继承链）', async () => {
    // 这里防两个不同的 mutation，各有自己的可证伪基线（不可互相替代）：
    // ① 丢继承链——persist 写成 `credentialSource: payload.credentialSource`：setEnabled 式
    //    payload 的 payload.credentialSource 是 undefined，JSON.stringify 丢键，拨一次开关
    //    就把既存显式值抹掉。场景 A/B 拦截。
    // ② 写侧推断物化——persist 写成 `payload.credentialSource ?? resolveQuotaCredentialSource(...)`。
    //    注意 resolveQuotaCredentialSource 是**显式值优先**（`quota?.credentialSource ?? …`），
    //    而 `incoming ?? …` 只在 incoming 为 undefined 时触发：因此它**不会覆盖显式值**，
    //    「把显式 'exclusive' 覆盖成推断值」的反例不可达（场景 B 对 ② 不会变红）。真实危害是
    //    把未设置的字段物化成推断值——setEnabled 式缺省 payload 静默在磁盘写入用户从未选择过
    //    的来源（违反 D4「开关只写 enabled」与「键缺省 = 继承既存」），且此后该 provider 不再
    //    跟随推断：专属 Key 被清后 apiKeySet 变 false，读侧本应回落 provider，冻结的显式值会
    //    让查询走向 no-credential。场景 C 拦截。
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
    })

    // 场景 A（拦截 ①）：显式 exclusive（无专属 Key 标记）→ setEnabled 后仍 exclusive
    await svc.configure({ providerId: 'p-a', enabled: true, fetcher: 'zhipu', credentialSource: 'exclusive' })
    const cfgA = await svc.configure({ providerId: 'p-a', enabled: false })
    expect(cfgA.ok).toBe(true)
    const quotaA = readExtras('p-a')?.quota as Record<string, unknown> | undefined
    expect(quotaA?.credentialSource).toBe('exclusive')
    expect(quotaA?.fetcher).toBe('zhipu')
    expect(quotaA?.enabled).toBe(false)

    // 场景 B（拦截 ①）：显式 provider + apiKeySet=true → setEnabled 后仍 provider。
    // 注意本条对 ② 不变红——② 的 resolve 显式值优先，仍返回 'provider'（理由见上）。
    await svc.configure({
      providerId: 'p-b',
      enabled: true,
      fetcher: 'zhipu',
      apiKey: 'exclusive-key',
      credentialSource: 'provider',
    })
    await svc.configure({ providerId: 'p-b', enabled: false })
    const quotaB = readExtras('p-b')?.quota as Record<string, unknown> | undefined
    expect(quotaB?.credentialSource).toBe('provider')
    expect(quotaB?.apiKeySet).toBe(true)
    expect(quotaB?.fetcher).toBe('zhipu')
    expect(quotaB?.enabled).toBe(false)

    // 场景 C（拦截 ②，唯一可证伪基线）：磁盘未设置 credentialSource + apiKeySet=true →
    // setEnabled 后仍**不含** credentialSource 键（保持「未设置」= 继承既存，而非物化成
    // 用户没选过的 'exclusive'）。写侧若调 resolveQuotaCredentialSource(current) 补默认：
    // apiKeySet=true → 物化成 'exclusive' → 键出现 → 本条红。
    // 前置态直接经 extrasStore.modify 落盘（不经 configure）：让「初始即未设置」这一前提
    // 独立于被测 persist 逻辑——否则 mutation 会先在种子步骤写坏前提，证伪落在前置断言上而
    // 非本条真正要守的 setEnabled 断言（种子的 apiKeySet 值语义同 configure 落盘结果）。
    await extrasStore.modify('p-c', () => ({ quota: { fetcher: 'zhipu', enabled: true, apiKeySet: true } }))
    const quotaCBefore = readExtras('p-c')?.quota as Record<string, unknown> | undefined
    expect(quotaCBefore?.apiKeySet).toBe(true)
    expect('credentialSource' in (quotaCBefore ?? {})).toBe(false) // 前置：初始即未设置

    const cfgC = await svc.configure({ providerId: 'p-c', enabled: false })
    expect(cfgC.ok).toBe(true)
    const quotaC = readExtras('p-c')?.quota as Record<string, unknown> | undefined
    expect('credentialSource' in (quotaC ?? {})).toBe(false)
    expect(quotaC?.apiKeySet).toBe(true)
    expect(quotaC?.fetcher).toBe('zhipu')
    expect(quotaC?.enabled).toBe(false)
  })
})

describe('QuotaService — U2⑥: 在途 fetch 写回守卫（§7.5 清单 / 改动 4）', () => {
  it('fetch 在途期间 configure 换类型：旧 fetch 落地不回写缓存/lastFetchTime，返回当前 getCached 真相，新类型首个 fetch 不被 throttle 压制', async () => {
    // 防的回归（writeChain 只保证已发生的写互不交错，管不住在途落地这一扇门）：
    // hover 在途（旧类型、旧凭据已在内存）→ 设置页换类型 → removeEntry 删旧行 →
    // 旧 fetch 迟到落地 → 若失守：① cache.update 把旧类型行写回（以新类型标签展示）；
    // ② lastFetchTime 被盖住 → 新类型首个 hover 在 10s 内被 throttle 压制，返回已清空的
    // getCached（「暂无额度数据」持续 ≤10s）；③ RPC 返回手工空对象而非当前真相。
    const info: { baseUrl: string; quota: { fetcher: string } } = {
      baseUrl: 'https://bigmodel.cn',
      quota: { fetcher: 'zhipu' },
    }
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => info,
    })

    // 旧类型（zhipu）fetch 在途：手动控制 resolve 时刻
    let resolveOld!: (v: { ok: true; data: { label: string; wins: never[] } }) => void
    mockFetchQuota.mockReturnValueOnce(
      new Promise((r) => {
        resolveOld = r as typeof resolveOld
      }),
    )
    const oldFetchP = svc.fetch('p')
    await new Promise((r) => setImmediate(r)) // 凭证解析含 await，等一拍再确认已进入 fetchQuota
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)

    // 在途期间「保存并测试」换类型：persist 新 fetcher（生产 getProviderInfo 直读 providers.json，
    // 测试里用可变 holder 模拟落盘后的可见性）+ 清旧缓存条目
    info.quota = { fetcher: 'kimi-coding' }
    const cfg = await svc.configure({ providerId: 'p', enabled: true, fetcher: 'kimi-coding' })
    expect(cfg.ok).toBe(true)

    // 新类型先落地一次（写入新行）——旧 fetch 迟到时才存在「被旧行覆盖」的对象
    kimiMockFetchQuota.mockResolvedValueOnce({ ok: true, data: { label: 'kimi-new', wins: [] as never } })
    await svc.refresh('p')
    await new Promise((r) => setImmediate(r))
    expect(svc.getCached('p').data?.label).toBe('kimi-new')

    // 旧类型 fetch 迟到落地：守卫丢弃其全部写
    resolveOld({ ok: true, data: { label: 'zhipu-stale', wins: [] as never } })
    const oldResult = await oldFetchP

    expect(svc.getCached('p').data?.label).toBe('kimi-new') // 旧行未回写（失守时会被 zhipu-stale 覆盖）
    expect(svc.getCached('p').reason).toBeUndefined()
    expect(oldResult.data?.label).toBe('kimi-new') // RPC 返回当前 getCached 真相，不是旧行
    expect(oldResult.reason).toBeUndefined()

    // 守卫同时不写 lastFetchTime（写点已迁到完成时刻）：新类型首个 hover fetch 不被压制。
    // 若 lastFetchTime 仍写在发起处，这里 elapsed≈0 < 10s 会直接返回缓存、kimi fetcher 不再被调。
    kimiMockFetchQuota.mockResolvedValueOnce({ ok: true, data: { label: 'kimi-second', wins: [] as never } })
    const hover = await svc.fetch('p')
    expect(kimiMockFetchQuota).toHaveBeenCalledTimes(2)
    expect(hover.data?.label).toBe('kimi-second')
  })
})

describe('QuotaService — U2⑦: 失败路径的节流不断（§7.5 清单 / 改动 4 出口覆盖）', () => {
  it('fetchFailed 后 10s 内第二次 hover 不发真实请求（lastFetchTime 写点迁移后失败出口同等覆盖）', async () => {
    // 防的回归：既有 throttle 测试只断言成功路径；lastFetchTime 写点从「doFetch 开头」
    // 迁到「守卫后的完成时刻」时，若只放在成功出口旁，持续失败的 provider（凭证缺失 /
    // unauthorized）每次 hover 都发真实请求并落一条 warn——请求与日志速率失去上界
    // （表 A #13「每次一条 warn」的速率前提正是一次性开头写的覆盖全部出口）。
    vi.useFakeTimers()
    try {
      const svc = new QuotaService({
        providerCredentialResolver: makeResolver(),
        dataDir: tmpDir,
        getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn' }),
      })
      mockFetchQuota.mockResolvedValue({ ok: false, reason: 'unauthorized' })

      const first = await svc.fetch('glm-id')
      expect(first.data).toBeNull()
      expect(first.reason).toBe('unauthorized')
      expect(mockFetchQuota).toHaveBeenCalledTimes(1)

      // 10s 窗口内第二次 hover：被节流，零真实请求（失败也节流）
      await vi.advanceTimersByTimeAsync(5_000)
      const second = await svc.fetch('glm-id')
      expect(mockFetchQuota).toHaveBeenCalledTimes(1)
      expect(second.data).toBeNull()
      expect(second.reason).toBe('unauthorized')
      expect(svc.getCached('glm-id').reason).toBe('unauthorized')

      // 窗口过后恢复真实请求（节流不是永久压制）
      await vi.advanceTimersByTimeAsync(6_000)
      mockFetchQuota.mockResolvedValueOnce({ ok: true, data: { label: 'zhipu', wins: [] as never } })
      const third = await svc.fetch('glm-id')
      expect(mockFetchQuota).toHaveBeenCalledTimes(2)
      expect(third.data?.label).toBe('zhipu')
      expect(svc.getCached('glm-id').reason).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── D12 改动 5 出口覆盖：clearProviderState 直调（provider 删除链 quota 副产物清理）──
//
// 防的回归：组合根回填漏挂 / clearProviderState 静默失效（只有 S14 能发现）——
// provider-config-helper 的 D12 用例注入的是替身 cleaner，只验证「排序 + warn-only」
// 不变量；真实副作用（删两个 secrets 文件 / 清 lastFailure 与 lastFetchTime / 删缓存
// 条目）与失败分支不在其覆盖内，本组直调被测方法补齐。
describe('QuotaService — D12: clearProviderState 直调（provider 删除链 quota 副产物清理）', () => {
  it('成功路径：删两个 secrets 文件 + 清 lastFailure / lastFetchTime / 缓存条目', async () => {
    // 防的回归：组合根回填漏挂 / clearProviderState 静默失效（只有 S14 能发现）
    let cred: { key: string; source: 'models.json' } | undefined = { key: 'provider-key', source: 'models.json' }
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => cred),
      dataDir: tmpDir,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { fetcher: 'zhipu' } }),
    })
    const cookiePath = join(tmpDir, 'secrets', 'glm-del-cookie.txt')
    const keyPath = join(tmpDir, 'secrets', 'glm-del-apikey.txt')
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    // ① 经 configure 物化两个 secrets 文件（credentialSource=provider：api-key 形态走
    //    resolver 而非专属 key 文件，下一步才能制造 no-credential 失败标记）
    await svc.configure({
      providerId: 'glm-del',
      enabled: true,
      fetcher: 'zhipu',
      apiKey: 'exclusive-key',
      cookie: 'session=abc',
      credentialSource: 'provider',
    })
    expect(existsSync(cookiePath)).toBe(true)
    expect(existsSync(keyPath)).toBe(true)

    // ② 落一条成功缓存 + lastFetchTime（本次 fetch 会被节流观测复用为前置态）
    await svc.fetch('glm-del')
    expect(svc.getCached('glm-del').data?.label).toBe('zhipu')

    // ③ 制造失败标记（resolver miss → 显式 no-credential；失败不清缓存行，两条内存态同时存在）
    cred = undefined
    await svc.refresh('glm-del')
    expect(svc.getCached('glm-del').reason).toBe('no-credential')

    // ④ 被测：删除链在 extras 条目确认清除后调用的 quota 副产物清理
    await svc.clearProviderState('glm-del')

    // 物理副作用：两个 secrets 文件都消失
    expect(existsSync(cookiePath)).toBe(false)
    expect(existsSync(keyPath)).toBe(false)
    // lastFailure 清空（getCached 不再透传 reason）
    expect(svc.getCached('glm-del').reason).toBeUndefined()
    // cache.removeEntry 经 writeChain 落盘：等一拍后内存镜像与磁盘同为「无条目」
    await new Promise((r) => setImmediate(r))
    expect(svc.getCached('glm-del').data).toBeNull()
    expect(svc.getCached('glm-del').lastFetchAt).toBeNull()

    // lastFetchTime 清空（私有字段不可直读，用 throttle 行为观测）：未清时 10s 窗口内的
    // fetch 被节流直接返回缓存、fetcher 零调用；清掉后立即发真实请求 → 恰好 1 次。
    cred = { key: 'provider-key', source: 'models.json' }
    mockFetchQuota.mockClear()
    await svc.fetch('glm-del')
    expect(mockFetchQuota).toHaveBeenCalledTimes(1)
  })

  it('幂等：provider 无 secrets 文件 / 无内存条目时调用不抛错，且不物化缓存文件', async () => {
    // 防的回归：组合根回填漏挂 / clearProviderState 静默失效（只有 S14 能发现）
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(),
      dataDir: tmpDir,
      providerExists: () => true,
    })

    // 连调两次：ENOENT 视为成功、removeEntry 无条目跳过写盘（不物化 quota-cache.json）
    await expect(svc.clearProviderState('ghost')).resolves.toBeUndefined()
    await expect(svc.clearProviderState('ghost')).resolves.toBeUndefined()
    await new Promise((r) => setImmediate(r))
    expect(existsSync(join(tmpDir, 'quota-cache.json'))).toBe(false)
    expect(svc.getCached('ghost').data).toBeNull()
  })

  it('secrets 删除失败（同名目录占位 → 非 ENOENT）不抛错，内存态与缓存仍被清', async () => {
    // 防的回归：组合根回填漏挂 / clearProviderState 静默失效（只有 S14 能发现）。
    // 失败注入沿用本文件既有「同名目录占位」手法（unlinkSync(目录) 抛 EPERM/EISDIR 而非
    // ENOENT，不会被 removeSecretFile 误判为幂等成功）。清理链只 warn 不抛是契约的一部分：
    // cleanDeleteTail 的 catch 是唯一拦截点，删除主流程能否存活取决于本方法不逃逸异常。
    const cookiePath = join(tmpDir, 'secrets', 'glm-del-cookie.txt')
    mkdirSync(cookiePath, { recursive: true })

    let cred: { key: string; source: 'models.json' } | undefined = { key: 'provider-key', source: 'models.json' }
    const svc = new QuotaService({
      providerCredentialResolver: makeResolver(() => cred),
      dataDir: tmpDir,
      providerExists: () => true,
      getProviderInfo: () => ({ baseUrl: 'https://bigmodel.cn', quota: { fetcher: 'zhipu' } }),
    })
    mockFetchQuota.mockResolvedValue({ ok: true, data: { label: 'zhipu', wins: [] as never } })

    // 前置态：一条成功缓存 + 一条失败标记（apiKeySet 未置 ⇒ 推断 'provider'，resolver miss 即失败）
    await svc.fetch('glm-del')
    cred = undefined
    await svc.refresh('glm-del')
    expect(svc.getCached('glm-del').reason).toBe('no-credential')

    await expect(svc.clearProviderState('glm-del')).resolves.toBeUndefined()

    // cookie 路径的删除失败（目录占位仍在）；api-key 路径无文件 = 幂等成功
    expect(existsSync(cookiePath)).toBe(true)
    // 一个路径失败不阻断其余清理：内存态与缓存照清（provider 已删，标记失去消费方）
    expect(svc.getCached('glm-del').reason).toBeUndefined()
    await new Promise((r) => setImmediate(r))
    expect(svc.getCached('glm-del').data).toBeNull()
  })
})

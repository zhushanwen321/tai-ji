/**
 * ConfigService（provider catalog / remote quota fetchers 拉取触发点 / terminal config）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - config-service-catalog.test.ts
 * - config-service-remote-quota-fetchers.test.ts
 * - terminal-config.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/__tests__/config-service.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalConfig, BuiltinProviderTemplate } from '@taiji/shared'
import snapshot from '../../generated/builtin-providers.json'
import type { AuthStorage, CredentialWriter } from '../auth/auth-storage.js'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import { listQuotaPresets } from '../quota-providers/index.js'

describe('config-service-catalog', () => {
/**
 * setProvider catalog 分支测试（M5-01，P0 修复验证）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-catalog.test.ts
 *
 * 策略：**不 mock provider-catalog**——isCatalogProvider 走真实实现（builtin-providers.json
 * 判定）。补 config-service.test.ts 的测试盲区（该文件 vi.mock 把 isCatalogProvider 恒置
 * false，catalog 分支从未被真实路径覆盖，setProvider 的 apiKey 双写 bug 因此漏网）。
 *
 * A1-4 收敛：catalog apiKey 写入经 credentialWriter（AuthService.saveCredential 的窄
 * 接口），不再直接持有 authStorage.set——断言对象同步切换。
 */
type AuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>

function makeStore() {
  return {
    // 无既有 models.json 条目（catalog 定义来自 pi 内置 catalog，条目只是可选 override）——
    // 用于验证防线③「不物化**新**空壳」：apiKey 归 auth.json 后 models.json 无条目可写
    getProviderConfig: vi.fn(() => undefined),
    upsertProvider: vi.fn(() => ({})),
    // 无既有条目 → existingConfig === undefined → setProvider 末尾走白名单检查（新建语义）
    ensureProviderInWhitelist: vi.fn(),
    removeProvider: vi.fn(() => ({ removed: true })),
    cleanEnabledModelsResidue: vi.fn(),
  } as unknown as IConfigStore & { upsertProvider: ReturnType<typeof vi.fn> }
}

function makeAuth(): AuthPick {
  return {
    listCredentialIds: vi.fn(() => []),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as AuthPick
}

function makeCredentialWriter(): CredentialWriter & { saveCredential: ReturnType<typeof vi.fn> } {
  return { saveCredential: vi.fn().mockResolvedValue(undefined) }
}

describe('M5-01: setProvider catalog 分支（真实 isCatalogProvider，不 mock）', () => {
  it('catalog provider（anthropic）保存 apiKey → 只写 auth.json，不物化 models.json 条目', async () => {
    const store = makeStore()
    const auth = makeAuth()
    const writer = makeCredentialWriter()
    const svc = new ConfigService('/tmp/project', store, auth)
    svc.setCredentialWriter(writer)

    await svc.setProvider('anthropic', { apiKey: 'sk-secret' })

    // catalog 凭据归 auth.json（pi-alignment 决策 1）；A1-4 收敛后经 credentialWriter
    expect(writer.saveCredential).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-secret' })
    // 防线③（不物化新空壳）：models.json 无既有条目 + apiKey 归 auth.json → 不产生条目
    // （凭据只归 auth.json 0600，不写 0644 明文 models.json；G5 迁移的安全动机）
    expect(store.upsertProvider).not.toHaveBeenCalled()
  })

  it('catalog provider 不传 apiKey（只改 baseUrl）→ 不写 auth.json，merged 无 apiKey', () => {
    const store = makeStore()
    const auth = makeAuth()
    const writer = makeCredentialWriter()
    const svc = new ConfigService('/tmp/project', store, auth)
    svc.setCredentialWriter(writer)

    svc.setProvider('anthropic', { baseUrl: 'https://proxy.example.com' })

    expect(writer.saveCredential).not.toHaveBeenCalled()
    const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
    expect('apiKey' in merged).toBe(false)
  })

  it('custom provider（my-custom）保存 apiKey → merged 含 apiKey（回归：custom 分支仍写 models.json + I9 清 auth.json oauth）', async () => {
    const store = makeStore()
    const auth = makeAuth()
    const writer = makeCredentialWriter()
    const svc = new ConfigService('/tmp/project', store, auth)
    svc.setCredentialWriter(writer)

    // RT-7#3：custom 分支 auth.json 清理 await 化（resolver 源优先级 auth.json 在前，
    // 清理未落盘会残留旧 oauth）——upsert 在清理完成后才发生，断言需 await
    await svc.setProvider('my-custom', { apiKey: 'sk-x' })

    // custom 凭据写 models.json（apiKey 字段），auth.json 反而要清（I9 清理①）
    expect(writer.saveCredential).not.toHaveBeenCalled()
    expect(auth.remove).toHaveBeenCalledWith('my-custom')
    const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
    expect(merged.apiKey).toBe('sk-x')
  })

  it('catalog provider + 未注入 credentialWriter → 不抛错，不物化 models.json 条目（凭据无处安放宁丢不写错位）', () => {
    const store = makeStore()
    const svc = new ConfigService('/tmp/project', store)

    expect(() => svc.setProvider('anthropic', { apiKey: 'sk-secret' })).not.toThrow()
    expect(store.upsertProvider).not.toHaveBeenCalled()
  })

  it('MF-1：catalog provider 保存 apiKey 时 await 落盘后才 upsertProvider（防 stale 广播）', async () => {
    // 复现生产缺陷：fire-and-forget 时 setProvider 同步返回，handler 立即 broadcastProviderList
    // 裸读 auth.json——withFileLock 尚未落盘 → catalog 瞬时显示 not_configured。修复（await）后
    // 写返回时凭据已落盘。构造带延迟的写，验证 await 完成后才生效。
    let setDone = false
    const writer = {
      saveCredential: vi.fn(async (_id: string, _cred: unknown) => {
        await new Promise(r => setTimeout(r, 5))
        setDone = true
      }),
    }
    const store = makeStore()
    const svc = new ConfigService('/tmp/project', store, makeAuth())
    svc.setCredentialWriter(writer)

    await svc.setProvider('anthropic', { apiKey: 'sk-secret' })

    // await 返回时写已完成（fire-and-forget 会因 5ms 延迟未完成）
    expect(setDone).toBe(true)
    expect(writer.saveCredential).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-secret' })
  })

  it('MF-1：catalog provider 保存 apiKey 时写 auth.json 失败 → setProvider reject（不静默吞凭据丢失）', async () => {
    // 复现生产缺陷：fire-and-forget + .catch(warn) 时写失败只 warn，apiKey 既未进 auth.json
    // 又已从 models.json 删 → 用户收成功但凭据丢失无错误出口。修复（await 无 catch）后失败直接 reject。
    const writer = {
      saveCredential: vi.fn().mockRejectedValueOnce(new Error('disk full')),
    }
    const store = makeStore()
    const svc = new ConfigService('/tmp/project', store, makeAuth())
    svc.setCredentialWriter(writer)

    await expect(svc.setProvider('anthropic', { apiKey: 'sk-secret' })).rejects.toThrow('disk full')
    // 失败时 upsertProvider 不应被调用（原子失败，不残留半写入的 models.json）
    expect(store.upsertProvider).not.toHaveBeenCalled()
  })
})
})

describe('config-service-remote-quota-fetchers', () => {
/**
 * ConfigService.refreshRemoteProviders 域 2（quota-fetchers）拉取触发点单测。
 *
 * 回归锚点：quota-fetchers 远程域曾只有读侧（quota-providers/index.ts 的 loadRemoteConfig）
 * 没有拉取触发点——`<getDataDir()>/remote-config/quota-fetchers.json` 的唯一写方是
 * persistCache，只由 refreshRemoteConfig 触达，而全仓生产调用点恒为域 1
 * （remote-provider-sync.ts 的 DOMAIN='builtin-providers'）→ 该缓存文件永不被写入，
 * 远程 presets/fetcher 热更新端到端不可达（设计 .tmp/tech-design/remote-config-and-quota.md
 * §5.3 验收项「改远程 JSON 修一个字段映射错误，push 后不升级应用，额度查询恢复正确」无法达成）。
 *
 * 本文件锁定：refreshRemoteProviders() 一次调用同时触发两个域拉取，且域 2 落盘缓存被
 * listQuotaPresets() 读侧消费（读侧零改动即吃到新数据）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-remote-quota-fetchers.test.ts
 *
 * 策略同 remote-config-fetch.test.ts：TAIJI_AGENT_DATA_DIR stub 到临时目录 + fetch 全局
 * mock（按 URL 路由两域响应体）。不 resetModules——config-service 与 quota-providers 经
 * 同一 remote-config-fetch 模块实例共享 cacheSnapshots，正是生产形态。
 */
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'csrq-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 域 1 合法响应体（sync 链会先拉它；extrasStore 未注入 → 拉完即早退，不触写盘）。 */
const PROVIDERS_BODY = { version: 1, providers: [] }

/** 域 2 合法响应体：presets 段整体替换基线（isQuotaPreset 逐元素校验形状）。 */
const QUOTA_BODY = {
  version: 1,
  presets: [
    {
      fetcher: 'zhipu-glm-coding',
      label: 'Zhipu Coding Plan（远程热更新）',
      auth: ['api-key'],
      match: { baseUrlPattern: 'bigmodel.cn' },
    },
  ],
}

function quotaCachePath(): string {
  return join(dataDir, 'remote-config', 'quota-fetchers.json')
}

function providersCachePath(): string {
  return join(dataDir, 'remote-config', 'builtin-providers.json')
}

/** fetch mock 按 URL 路由两域响应体；返回 spy 供断言「域 2 确实发了网络请求」。 */
function mockFetchByDomain() {
  const fn = vi.fn(async (url: unknown) => {
    const href = String(url)
    const body = href.endsWith('/quota-fetchers.json') ? QUOTA_BODY : PROVIDERS_BODY
    return {
      ok: true,
      status: 200,
      json: async () => body,
      body: null,
      headers: { get: () => null },
    }
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function makeService(): ConfigService {
  // refreshRemoteProviders 只经 syncRemoteProviderModels 消费 configStore，且 extrasStore
  // 未注入时 sync 在拉取后即早退——configStore 传最小 mock 即可（方法不被调用）。
  return new ConfigService('/tmp/project', {} as unknown as IConfigStore)
}

describe('ConfigService.refreshRemoteProviders — 域 2（quota-fetchers）拉取触发点', () => {
  it('t1: 一次调用同时触发两域拉取（域 2 请求 URL 命中 quota-fetchers.json）', async () => {
    const fetchSpy = mockFetchByDomain()
    await makeService().refreshRemoteProviders()

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.endsWith('/configs/remote/quota-fetchers.json'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/configs/remote/builtin-providers.json'))).toBe(true)
  })

  it('t2: 域 2 缓存文件被写入（persistCache 落盘，含 checkedAt 元数据）', async () => {
    mockFetchByDomain()
    expect(existsSync(quotaCachePath())).toBe(false)

    await makeService().refreshRemoteProviders()

    expect(existsSync(quotaCachePath())).toBe(true)
    const persisted = JSON.parse(readFileSync(quotaCachePath(), 'utf-8')) as {
      version: number
      checkedAt: number
      data: unknown
    }
    expect(persisted.version).toBe(1)
    expect(typeof persisted.checkedAt).toBe('number')
    expect(persisted.data).toEqual(QUOTA_BODY)
  })

  it('t3: 读侧 listQuotaPresets() 吃到远程 presets（整体替换基线，无需任何下游动作）', async () => {
    mockFetchByDomain()
    await makeService().refreshRemoteProviders()

    const presets = listQuotaPresets()
    expect(presets).toHaveLength(1)
    expect(presets[0]?.fetcher).toBe('zhipu-glm-coding')
    expect(presets[0]?.label).toBe('Zhipu Coding Plan（远程热更新）')
    expect(presets[0]?.match.baseUrlPattern).toBe('bigmodel.cn')
  })

  it('t4: 域 2 拉取失败（网络错误）→ 不抛错、不落盘、读侧回落基线（fail-safe 链内建）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))

    await expect(makeService().refreshRemoteProviders()).resolves.toEqual({ updatedProviders: [] })

    expect(existsSync(quotaCachePath())).toBe(false)
    // 无缓存 → 回落编译期基线 QUOTA_PRESETS（非空，非远程那条）
    const presets = listQuotaPresets()
    expect(presets.length).toBeGreaterThan(0)
    expect(presets.some((p) => p.fetcher === 'zhipu-glm-coding')).toBe(false)
  })

  it('t5: 域 2 guard 拒绝（坏 presets 形状）→ 整体拒用不落盘，读侧回落基线', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/quota-fetchers.json')
        ? { version: 1, presets: [{ fetcher: '', label: 'x', auth: ['api-key'], match: {} }] }
        : PROVIDERS_BODY),
      body: null,
      headers: { get: () => null },
    })))

    await expect(makeService().refreshRemoteProviders()).resolves.toEqual({ updatedProviders: [] })

    expect(existsSync(quotaCachePath())).toBe(false)
    expect(listQuotaPresets().some((p) => p.fetcher === 'zhipu-glm-coding')).toBe(false)
  })

  it('t6: 域 1 与域 2 落盘互不干扰（两缓存文件各自独立写入）', async () => {
    mockFetchByDomain()
    await makeService().refreshRemoteProviders()

    expect(existsSync(providersCachePath())).toBe(true)
    expect(existsSync(quotaCachePath())).toBe(true)
    expect(JSON.parse(readFileSync(providersCachePath(), 'utf-8')).data).toEqual(PROVIDERS_BODY)
    expect(JSON.parse(readFileSync(quotaCachePath(), 'utf-8')).data).toEqual(QUOTA_BODY)
  })
})
})

describe('terminal-config', () => {
/**
 * TerminalConfig（Phase 6 settings）单元测试。
 *
 * 覆盖 ConfigService.getTerminalConfig / setTerminalConfig 的读写 + 校验语义，
 * 复刻 system-prompt config 的测试范式（真实 tmpdir + 最小 IConfigStore mock）。
 *
 * ConfigService 通过注入的 this.configStore.getConfigDir() 定位配置目录，
 * 故 mock 只需让 getConfigDir() 返回每个用例独立的 tmpdir（文件系统真实读写，
 * 不需 TAIJI_AGENT_DATA_DIR 环境变量，隔离更干净）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/terminal-config.test.ts
 */
/** 默认配置（与 defaultTerminalConfig 对齐，测试断言用）。 */
const DEFAULT_CONFIG: TerminalConfig = {
  version: 1,
  shell: '',
  shellArgs: [],
  fontSize: 14,
  fontFamily: '',
  scrollback: 5000,
  cursorStyle: 'block',
  bell: true,
}

/** 构造最小 IConfigStore mock——只让 getConfigDir() 指向给定目录。 */
function createMockConfigStore(dir: string): IConfigStore {
  // 其余方法用例不触达，cast as IConfigStore 省去全量桩（仅 ConfigService 终端相关方法被调）。
  return { getConfigDir: () => dir } as unknown as IConfigStore
}

describe('ConfigService terminal config (Phase 6)', () => {
  let dir: string
  let service: ConfigService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terminal-cfg-'))
    service = new ConfigService(dir, createMockConfigStore(dir))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── getTerminalConfig ────────────────────────────────────────────

  it('TC-1: 文件不存在 → 返回默认配置 corrupted=false', () => {
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('TC-2: 文件损坏（非法 JSON）→ 返回默认配置 corrupted=true', () => {
    writeFileSync(join(dir, 'terminal.json'), '{ not valid json,,,', 'utf-8')
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(true)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('TC-3: 字段缺失 → merge 填默认值 corrupted=false', () => {
    // 空对象：所有字段都缺，merge 后应全等于默认（仅 version 被覆盖测试用）
    writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ version: 2 }), 'utf-8')
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual({ ...DEFAULT_CONFIG, version: 2 })
  })

  it('TC-4: 完整合法文件 → 原样返回 corrupted=false', () => {
    const full: TerminalConfig = {
      version: 3,
      shell: '/bin/zsh',
      shellArgs: ['-l', '-e'],
      fontSize: 16,
      fontFamily: 'Fira Code',
      scrollback: 10000,
      cursorStyle: 'underline',
      bell: false,
    }
    writeFileSync(join(dir, 'terminal.json'), JSON.stringify(full), 'utf-8')
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual(full)
  })

  // ── setTerminalConfig 校验 ──────────────────────────────────────

  it('TC-5: fontSize 超范围 → ok:false + 不写盘', () => {
    const tooSmall: TerminalConfig = { ...DEFAULT_CONFIG, fontSize: 1 }
    const result = service.setTerminalConfig(tooSmall)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/fontSize out of range/)
    // 不写盘
    expect(existsSync(join(dir, 'terminal.json'))).toBe(false)
  })

  it('TC-6: 正常写入 → ok:true + 文件内容正确', () => {
    const valid: TerminalConfig = {
      ...DEFAULT_CONFIG,
      shell: '/bin/fish',
      shellArgs: ['--login'],
      fontSize: 18,
      scrollback: 8000,
      cursorStyle: 'bar',
    }
    const result = service.setTerminalConfig(valid)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()

    // 文件内容 = 写入的 config（JSON 解析后逐字段比对）
    const written = JSON.parse(readFileSync(join(dir, 'terminal.json'), 'utf-8'))
    expect(written).toEqual(valid)

    // 回读一致（getTerminalConfig 不损坏）
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual(valid)
  })

  it('TC-7: 无效 cursorStyle → ok:false', () => {
    const invalid = { ...DEFAULT_CONFIG, cursorStyle: 'invalid' as TerminalConfig['cursorStyle'] }
    const result = service.setTerminalConfig(invalid)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid cursorStyle/)
  })
})
})

// ── 以下 4 节（12 例）由主会话从 HEAD 原文并回：A 组改写本产物时删除了既有的
// listBuiltinProviders / auth 清理 / checkEnvVars / getScopedModels describe 且未并入，
// 包级守恒对拍缺 12 例。不带 HEAD 版的 vi.mock('../provider-catalog')（本产物 M5-01 节
// 依赖真实 isCatalogProvider，文件级 mock 会打坏它；这 12 例自身不依赖该 mock）。

// listBuiltinProviders 不触 ConfigStore（纯函数 import JSON），传空对象即可实例化（构造只存引用）。
const service = new ConfigService('/tmp/project', {} as unknown as IConfigStore)

describe('ConfigService.listBuiltinProviders', () => {
  const providers: BuiltinProviderTemplate[] = service.listBuiltinProviders()

  // 派生视图层契约 = 「生成 JSON 完整透出 + 形状检查」。值契约（42/openai both/radius 在册/
  // google-vertex M-1）的归属边界在 gen 提取器（scripts/__tests__/gen-builtin-providers.test.ts），
  // 此处不再复制第二份手写基线数字（gen t10 注释登记过「手写基线第三份数据失守」教训）。
  it('t1: 派生视图与生成快照结构等价（完整透出，无丢失无改写）', () => {
    expect(providers.length).toBeGreaterThan(0)
    expect(providers).toEqual(snapshot.providers)
  })

  it('t5: provider 级派生视图形状契约（本层独有信号：models.length===modelCount 对账 + 损坏检查不误触发）', () => {
    for (const p of providers) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(['api_key', 'oauth', 'both', 'ambient']).toContain(p.authMode)
      expect(Array.isArray(p.envVars)).toBe(true)
      expect(typeof p.oauthSupported).toBe('boolean')
      expect(typeof p.modelCount).toBe('number')
      expect(Array.isArray(p.models)).toBe(true)
      // 条目数对账是派生视图层独有的完整性信号（快照等价已保证其余字段）
      expect(p.models.length).toBe(p.modelCount)
    }
  })
})

describe('ConfigService auth 清理（I9 清理① + I8，T6）', () => {
  function makeSvc(authStorage?: Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>) {
    const mockStore = {
      getProviderConfig: vi.fn(() => ({ name: 'anthropic' })),
      upsertProvider: vi.fn(() => ({})),
      removeProvider: vi.fn(() => ({ removed: true })),
      // M5-05：deleteProvider 现调 cleanEnabledModelsResidue（决策 4 不变式），mock 必须提供
      cleanEnabledModelsResidue: vi.fn(),
    } as unknown as IConfigStore
    const svc = new ConfigService('/tmp/project', mockStore, authStorage as unknown as Pick<AuthStorage, 'set' | 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>)
    return { svc, mockStore, authStorage }
  }

  it('setProvider 保存 apiKey → 清 auth.json oauth（both provider 切凭据源，幂等）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { apiKey: 'sk-test' })
    expect(authStorage.remove).toHaveBeenCalledWith('anthropic')
  })

  it('setProvider 未传 apiKey（只改 baseUrl）→ 不清 auth.json', () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { baseUrl: 'https://proxy.example.com' })
    expect(authStorage.remove).not.toHaveBeenCalled()
  })

  it('setProvider apiKey 为空串（env 空自定义变量）→ 不清 auth.json（MF-1：防误删 OAuth 凭据）', () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { apiKey: '', authMethod: 'env_var' })
    expect(authStorage.remove).not.toHaveBeenCalled()
  })

  it('deleteProvider → 清 auth.json（I8：OAuth token 强绑定凭据，删除时同步清）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    await svc.deleteProvider('anthropic')
    expect(authStorage.remove).toHaveBeenCalledWith('anthropic')
  })

  it('deleteProvider → 清 enabledModels 残留（M5-05，决策 4 不变式，对齐 removeProviderByKind）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc, mockStore } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    await svc.deleteProvider('anthropic')
    expect(mockStore.cleanEnabledModelsResidue).toHaveBeenCalledWith('anthropic')
  })

  it('未注入 authStorage（测试/无 OAuth 场景）→ 两处清理 no-op 不抛错', () => {
    const { svc } = makeSvc()
    expect(() => svc.setProvider('anthropic', { apiKey: 'sk-x' })).not.toThrow()
    expect(() => svc.deleteProvider('anthropic')).not.toThrow()
  })
})

describe('ConfigService.checkEnvVars（I3，wave-env-check TC2）', () => {
  const KEEP: Record<string, string | undefined> = {}
  for (const name of ['CHECK_ENV_A', 'CHECK_ENV_EMPTY', 'CHECK_ENV_B']) {
    KEEP[name] = process.env[name]
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(KEEP)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('已设置（非空）→ true；未设置 / 空串 → false', () => {
    process.env.CHECK_ENV_A = 'sk-abc'
    process.env.CHECK_ENV_EMPTY = ''
    delete process.env.CHECK_ENV_B

    const result = service.checkEnvVars(['CHECK_ENV_A', 'CHECK_ENV_EMPTY', 'CHECK_ENV_B'])
    expect(result).toEqual({ CHECK_ENV_A: true, CHECK_ENV_EMPTY: false, CHECK_ENV_B: false })
  })

  it('names 去重（重复名字只查一次，结果一致）', () => {
    process.env.CHECK_ENV_A = 'x'
    const result = service.checkEnvVars(['CHECK_ENV_A', 'CHECK_ENV_A'])
    expect(Object.keys(result)).toEqual(['CHECK_ENV_A'])
    expect(result.CHECK_ENV_A).toBe(true)
  })

  it('空数组 → 空结果（不抛错）', () => {
    expect(service.checkEnvVars([])).toEqual({})
  })
})

// [2026-09 测试舰队审查 r2-24] 以下三节已删（与专文重复，专文覆盖更硬）：
// - 'authMethod 透传与推断' setProvider 写侧 → provider-write-side-switch.test.ts
//   'authMethod 写 providers.json，models.json 不落 authMethod'（真实落盘断言）
// - 'listProviders 回填 authMethod' 读侧 → provider-read-source-switch.test.ts
//   A1-3（providers.json 标注 + $/非空/空 推断）
// - 'status 派生与 models 合并' → config-service-listproviders.test.ts TC5/TC7
//   （connected/not_configured 双源 + custom models 兜底）

describe('ConfigService.getScopedModels（A8 恒注入检查）', () => {
  it('未注入 providerExtrasStore → 抛带恢复指引 Error（不静默返回 []，与 write 侧 modifyScopedModels 对称）', () => {
    // 构造参数缺省 providerExtrasStore（生产组合根恒注入，此形态只出现在测试/装配遗漏）
    const svc = new ConfigService('/tmp/project', {} as unknown as IConfigStore)
    expect(() => svc.getScopedModels()).toThrow(
      /providerExtrasStore 未注入.*恢复：在组合根构造 ConfigService 时注入 providerExtrasStore/,
    )
  })
})

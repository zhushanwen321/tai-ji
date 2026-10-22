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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { listQuotaPresets } from '../quota-providers/index.js'
import type { IConfigStore } from '../ports/config.js'

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
      label: '智谱 GLM Coding Plan（远程热更新）',
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
    expect(presets[0]?.label).toBe('智谱 GLM Coding Plan（远程热更新）')
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

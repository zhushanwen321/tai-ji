import { PiConfigStore } from '../../infra/pi/pi-config-store.js';
import { setModelsPath } from '../../infra/pi/pi-provider-store.js';
import { invalidateSettingsCache, setSettingsPath } from '../../infra/pi/pi-settings-store.js';
import { ConfigService } from '../config-service.js';
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js';
import type { SetProviderInput } from '../provider-config-helper.js';
import { TaijiProviderStore } from '../provider-extras-store.js';
import { QuotaService } from '../quota-service.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


let dir: string

let agentDir: string

let configStore: PiConfigStore

let svc: ConfigService


function writeModelsJson(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}


/**
 * models.json 落盘形态的最小断言窄化（JSON.parse 边界不裸 any，下游字段保持类型检查；
 * 只声明本测试断言用到的字段，非法值路径经 reject 不落盘、不会读到这些类型之外的数据）。
 */
interface WrittenModel {
  name?: string
  reasoning?: boolean
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: unknown }
  headers?: Record<string, string>
  /** W2 补充用例断言用（模型合并分支：input 过滤 / thinkingLevelMap 删除） */
  input?: unknown[]
  thinkingLevelMap?: Record<string, unknown>
}


interface WrittenProvider {
  name?: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  authHeader?: boolean
  models?: WrittenModel[]
}


interface WrittenModelsJson {
  providers: Record<string, WrittenProvider>
}


function readModelsJson(): WrittenModelsJson {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')) as WrittenModelsJson
}


/** 读回指定 provider 的首个模型条目（本测试写入路径保证存在，缺失即断言前置失败） */
function readModel(providerId: string): WrittenModel {
  const model = readModelsJson().providers[providerId]?.models?.[0]
  if (!model) throw new Error(`models.json "${providerId}" 缺少模型条目（断言前置失败）`)
  return model
}


function modelsJsonRaw(): string {
  return readFileSync(join(agentDir, 'models.json'), 'utf-8')
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-write-fields', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-write-fields-'))
  agentDir = join(dir, 'agent')
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  configStore = new PiConfigStore()
  svc = new ConfigService('/tmp/project', configStore)
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('B-4a：headers/authHeader 写入 models.json provider 条目（断链修复）', () => {
  it('传 headers + authHeader → 落盘且值正确', async () => {
    await svc.setProvider('my-proxy', {
      name: 'My Proxy',
      baseUrl: 'https://proxy.example.com',
      headers: { 'X-Custom': 'abc', Authorization: 'Bearer tok' },
      authHeader: true,
    })
    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({ 'X-Custom': 'abc', Authorization: 'Bearer tok' })
    expect(entry.authHeader).toBe(true)
  })

  it('不传（undefined）→ 既有值保留（不覆盖）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      headers: { 'X-Keep': 'me' },
      authHeader: true,
    })
    // 后续保存不带 headers/authHeader（前端编辑其它字段时的形态）
    await svc.setProvider('my-proxy', { name: 'Renamed' })
    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({ 'X-Keep': 'me' })
    expect(entry.authHeader).toBe(true)
    expect(entry.name).toBe('Renamed')
  })

  it('headers 传空对象 {} → 清空（undefined=不变 / {}=清空的两态语义）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      headers: { 'X-Old': 'v1' },
      authHeader: true,
    })
    await svc.setProvider('my-proxy', { headers: {} })
    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({})
  })

  it('authHeader 显式 false → 覆盖既有 true（boolean 不能用 truthiness 判定）', async () => {
    await svc.setProvider('my-proxy', { baseUrl: 'https://proxy.example.com', authHeader: true })
    await svc.setProvider('my-proxy', { authHeader: false })
    expect(readModelsJson().providers['my-proxy'].authHeader).toBe(false)
  })

  it('headers 非法（数组 / value 非 string）→ reject 且 models.json 不被写坏', async () => {
    writeModelsJson({ 'my-proxy': { baseUrl: 'https://proxy.example.com' } })
    const before = modelsJsonRaw()

    await expect(svc.setProvider('my-proxy', { headers: ['X-Bad'] as unknown as Record<string, string> }))
      .rejects.toThrow(/Invalid headers for provider "my-proxy"/)
    await expect(svc.setProvider('my-proxy', { headers: { 'X-Num': 123 as unknown as string } }))
      .rejects.toThrow(/value of "X-Num" must be a string/)

    expect(modelsJsonRaw()).toBe(before)
  })

  it('authHeader 非法（非 boolean）→ reject 且不落盘', async () => {
    writeModelsJson({ 'my-proxy': { baseUrl: 'https://proxy.example.com' } })
    const before = modelsJsonRaw()

    await expect(svc.setProvider('my-proxy', { authHeader: 'yes' as unknown as boolean }))
      .rejects.toThrow(/authHeader for provider "my-proxy": must be a boolean/)

    expect(modelsJsonRaw()).toBe(before)
  })

  it('headers 含 __proto__/constructor key → 清洗后落盘（prototype-pollution 防护）', async () => {
    const malicious: Record<string, string> = JSON.parse('{"__proto__":{"polluted":"x"},"constructor":{"y":"z"},"X-Safe":"ok"}')
    await svc.setProvider('my-proxy', { baseUrl: 'https://proxy.example.com', headers: malicious })

    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({ 'X-Safe': 'ok' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
describe('B-4b：模型写入白名单 reasoning/maxTokens/cost/headers', () => {
  it('四字段落盘且值正确（cost 含 tiers 可选透传）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [{
        id: 'my-model',
        name: 'My Model',
        reasoning: true,
        maxTokens: 8192,
        cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
        headers: { 'X-Model-Header': 'v' },
      }],
    })
    const model = readModel('my-proxy')
    expect(model.reasoning).toBe(true)
    expect(model.maxTokens).toBe(8192)
    expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 })
    expect(model.headers).toEqual({ 'X-Model-Header': 'v' })
  })

  it('cost tiers 存在时透传', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [{
        id: 'my-model',
        cost: {
          input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75,
          tiers: [{ inputTokensAbove: 200000, input: 6, output: 30, cacheRead: 1.2, cacheWrite: 7.5 }],
        },
      }],
    })
    const model = readModel('my-proxy')
    // cost 未落盘时 ?. 得 undefined ≠ 预期数组，断言语义不变
    expect(model.cost?.tiers).toEqual([{ inputTokensAbove: 200000, input: 6, output: 30, cacheRead: 1.2, cacheWrite: 7.5 }])
  })

  it('未传的字段沿用盘上既有值（base spread 兜底，undefined=不变）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [{ id: 'my-model', maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }],
    })
    // 编辑保存：回传同 id 只改 name（前端编辑名称场景），其余字段不回传
    await svc.setProvider('my-proxy', {
      models: [{ id: 'my-model', name: 'Renamed Model' }],
    })
    const model = readModel('my-proxy')
    expect(model.name).toBe('Renamed Model')
    expect(model.maxTokens).toBe(4096)
    expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 })
  })

  it('非法值 → reject 且 models.json 不被写坏（不静默丢弃）', async () => {
    writeModelsJson({ 'my-proxy': { baseUrl: 'https://proxy.example.com' } })
    const before = modelsJsonRaw()

    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', maxTokens: -1 }],
    })).rejects.toThrow(/Invalid maxTokens for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', maxTokens: 1.5 }],
    })).rejects.toThrow(/Invalid maxTokens for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', reasoning: 'yes' as unknown as boolean }],
    })).rejects.toThrow(/Invalid reasoning for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', cost: { input: 'x' } as unknown as { input: number } }],
    })).rejects.toThrow(/Invalid cost for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      // pi ModelCostSchema 四字段必填：缺字段写入会让 pi 拒载整个 models.json
      models: [{ id: 'm1', cost: { input: 1 } }],
    })).rejects.toThrow(/Invalid cost for model "m1".*"output"/)
    // round-1 review MUST_FIX #3：sanitizeModelCost 两个 throw 检查——
    // cost 非对象（传入整体非法形状）/ tiers 非数组（可选字段存在时类型错）
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', cost: 'x' as unknown as Record<string, unknown> }],
    })).rejects.toThrow(/Invalid cost for model "m1": expected an object with input\/output\/cacheRead\/cacheWrite numbers/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, tiers: 'no' as unknown as Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> } }],
    })).rejects.toThrow(/Invalid cost for model "m1": "tiers" must be an array/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', headers: ['bad'] as unknown as Record<string, string> }],
    })).rejects.toThrow(/Invalid headers for model "m1"/)

    expect(modelsJsonRaw()).toBe(before)
  })
})
// ── W2 重构特征锚定补充（模型合并提取 helper 后的分支缺口）──

describe('模型合并分支缺口（input 过滤 / thinkingLevelMap 删除 / compat 删除与清洗）', () => {
  it('input 非法值剔除（只保留 text/image），合法值保留', async () => {
    await svc.setProvider('my-proxy', {
      models: [{ id: 'm1', input: ['text', 'voice', 'image', 42] as unknown as Array<'text' | 'image'> }],
    })
    const model = readModel('my-proxy')
    expect(model.input).toEqual(['text', 'image'])
  })

  it('thinkingLevelMap 显式 undefined + 盘上有旧值 → 删除该字段', async () => {
    await svc.setProvider('my-proxy', {
      models: [{ id: 'm1', thinkingLevelMap: { reasoning: 'high' } }],
    })
    expect(readModel('my-proxy').thinkingLevelMap).toEqual({ reasoning: 'high' })

    // 前端 buildMap 全 passthrough 回 undefined → 删除（不再继承盘上旧值）
    await svc.setProvider('my-proxy', {
      models: [{ id: 'm1' }],
    })
    const model = readModelsJson().providers['my-proxy']?.models?.[0] as Record<string, unknown> | undefined
    expect(model).toBeDefined()
    expect('thinkingLevelMap' in (model as Record<string, unknown>)).toBe(false)
  })

  it('compat 显式 undefined + 盘上有旧值 → 删除该字段（clearAll 语义）', async () => {
    await svc.setProvider('my-proxy', {
      models: [{ id: 'm1', compat: { keep: 'v1' } }],
    })
    expect((readModel('my-proxy') as Record<string, unknown>).compat).toEqual({ keep: 'v1' })

    await svc.setProvider('my-proxy', {
      models: [{ id: 'm1' }],
    })
    const model = readModelsJson().providers['my-proxy']?.models?.[0] as Record<string, unknown> | undefined
    expect(model).toBeDefined()
    expect('compat' in (model as Record<string, unknown>)).toBe(false)
  })

  it('compat 清洗：__proto__/prototype/constructor key 与 undefined value 剔除', async () => {
    const malicious = JSON.parse('{"__proto__":{"bad":"x"},"constructor":{"y":1},"keep":"v"}') as Record<string, unknown>
    // JSON.parse 不产 undefined value，显式补一个 undefined value 键
    malicious.drop = undefined
    await svc.setProvider('my-proxy', {
      models: [{ id: 'm1', compat: malicious }],
    })
    const model = readModel('my-proxy') as Record<string, unknown>
    expect(model.compat).toEqual({ keep: 'v' })
    expect(({} as Record<string, unknown>).bad).toBeUndefined()
  })

  it('id 缺省/空串/纯空白 → 该模型整条丢弃（防线② 模型级，不产生 id:"" 条目）', async () => {
    // baseUrl 在场保证条目仍非空壳、upsert 真发生（否则 skipUpsert 不落盘，读不到文件态）
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [
        { name: 'No Id Model' } as unknown as { id: string },
        { id: '   ', name: 'Blank Id' },
      ],
    })
    const models = readModelsJson().providers['my-proxy']?.models ?? []
    expect(models).toHaveLength(0)
    expect(models.some(m => (m as Record<string, unknown>).id === '')).toBe(false)
  })
})
/**
 * M1b：写侧防线②③ 端到端（设计 §4 验收场景 1 的单元级形态——P0 毒化链拆除）。
 * 真实 models.json + 真实 PiConfigStore：断言「一次 catalog 保存不会把空串写进文件、
 * 同文件其他 custom provider 的原值不受影响」。
 */
describe('M1b：写侧防线②③ 端到端（P0 毒化链拆除）', () => {
  it('已导入 catalog 保存空串 baseUrl → 条目无空串 baseUrl 键；同文件 custom 的 apiKey 原样保留', async () => {
    writeModelsJson({
      // 已导入的 catalog override：带历史 artifact baseUrl（非空）
      'opencode-go': { name: 'OpenCode Go', baseUrl: 'https://artifact.example/v1' },
      // 同文件的 custom provider（带凭据）——防御线必须不波及它
      'my-proxy': { name: 'My Proxy', baseUrl: 'https://proxy.example.com', apiKey: 'sk-keep' },
    })

    // 编辑体保存形态：catalog 回传空串 baseUrl（清除网关）+ 一条无关 headers 修改
    await svc.setProvider('opencode-go', { baseUrl: '', headers: { 'X-Custom': 'v' } })

    const raw = modelsJsonRaw()
    expect(raw).not.toContain('"baseUrl": ""')
    const providers = readModelsJson().providers
    expect(providers['opencode-go']).toBeDefined()
    expect('baseUrl' in (providers['opencode-go'] as Record<string, unknown>)).toBe(false)
    expect(providers['my-proxy']?.apiKey).toBe('sk-keep')
  })
})
});

// ======================================================================
// ← provider-write-side-switch.test.ts
// ======================================================================

/** 恒注入形态的 resolver 替身（M2fg：QuotaService 构造必需；configure 路径不消费凭据）。 */
const stubResolver: IProviderCredentialResolver = {
  hasProviderCredential: () => false,
  listCredentialBackedProviderIds: () => new Set<string>(),
  resolveProviderCredential: async () => undefined,
  resolveProviderApiKeyRaw: async () => undefined,
  resolveProviderBaseUrl: () => undefined,
}


let dir_m2: string

let agentDir_m2: string

let extrasPath: string

let extrasStore: TaijiProviderStore

let configStore_m2: PiConfigStore


function writeModelsJson_m2(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir_m2, 'models.json'), JSON.stringify({ providers }, null, 2))
}


function readModelsRaw(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(agentDir_m2, 'models.json'), 'utf-8')).providers
}


function readExtrasRaw(): Record<string, unknown> {
  // 文件不存在 = 空扩展数据（TaijiProviderStore 读路径不物化文件）
  if (!existsSync(extrasPath)) return {}
  return JSON.parse(readFileSync(extrasPath, 'utf-8')).providers
}


function makeQuotaService(providerExists: (id: string) => boolean): QuotaService {
  return new QuotaService({ dataDir: dir_m2, providerExtrasStore: extrasStore, providerExists, providerCredentialResolver: stubResolver })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-write-side-switch', () => {
beforeEach(() => {
  dir_m2 = mkdtempSync(join(tmpdir(), 'provider-write-side-switch-'))
  agentDir_m2 = join(dir_m2, 'agent')
  mkdirSync(join(agentDir_m2, 'config'), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir_m2
  setModelsPath(join(agentDir_m2, 'models.json'))
  setSettingsPath(join(agentDir_m2, 'settings.json'))
  invalidateSettingsCache()
  extrasPath = join(agentDir_m2, 'config', 'providers.json')
  extrasStore = new TaijiProviderStore(extrasPath)
  configStore_m2 = new PiConfigStore()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('QuotaService.configure 写侧切换（A1-5 路径 1）', () => {
  it('configure 成功：providers.json 更新 quota（enabled/fetcher），models.json 无 quota 字段', async () => {
    writeModelsJson_m2({
      'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'sk-x' },
    })
    const svc = makeQuotaService(() => true)

    const result = await svc.configure({ providerId: 'zai-coding-cn', enabled: true, fetcher: 'zhipu' })

    expect(result).toEqual({ ok: true })
    expect(readExtrasRaw()['zai-coding-cn']).toEqual({
      quota: { fetcher: 'zhipu', enabled: true },
    })
    // models.json 不落 quota（寄生字段禁复活）
    expect(readModelsRaw()['zai-coding-cn']?.quota).toBeUndefined()
    expect(existsSync(extrasPath)).toBe(true)
  })

  it('场景 E：models.json 无条目但聚合层存在（oauth-only catalog provider）→ configure 成功', async () => {
    writeModelsJson_m2({}) // models.json 完全无该 provider
    const svc = makeQuotaService(id => id === 'kimi-coding')

    const result = await svc.configure({ providerId: 'kimi-coding', enabled: true })

    expect(result).toEqual({ ok: true })
    expect(readExtrasRaw()['kimi-coding']).toEqual({ quota: { enabled: true } })
  })

  it('聚合层不存在的 provider → 拒绝（ok:false，不落盘）', async () => {
    const svc = makeQuotaService(() => false)
    const result = await svc.configure({ providerId: 'nonexistent', enabled: true })
    expect(result.ok).toBe(false)
    // §7.3 改动 2：存在性检查移进 modify 回调后，modify 的锁前 ensureFileExists 会物化
    // 空的 providers.json（原检查在 modify 之前完全不触文件）——文件被物化但**无该
    // provider 条目**（回调抛 ProviderGoneError → 写入被跳过，僵尸条目未产生）
    expect(existsSync(extrasPath)).toBe(true)
    expect(readExtrasRaw()['nonexistent']).toBeUndefined()
  })

  it('fetcher 未传时继承既有值：providers.json 已有 fetcher 优先', async () => {
    writeModelsJson_m2({
      p1: { baseUrl: 'https://x.example.com', quota: { fetcher: 'legacy-kimi', enabled: false } },
    })
    await extrasStore.modify('p1', () => ({ quota: { fetcher: 'zhipu', enabled: false } }))
    const svc = makeQuotaService(() => true)

    await svc.configure({ providerId: 'p1', enabled: true }) // fetcher 未传

    // providers.json 的 zhipu 优先，models.json 旧值 legacy-kimi 不复活
    expect(readExtrasRaw()['p1']).toEqual({ quota: { fetcher: 'zhipu', enabled: true } })
  })

  it('fetcher 未传时继承既有值：providers.json 无条目回退 models.json 旧 quota（迁移失败窗口）', async () => {
    writeModelsJson_m2({
      p1: {
        baseUrl: 'https://x.example.com',
        quota: { fetcher: 'legacy-kimi', enabled: false, cookieSet: true },
      },
    })
    const svc = makeQuotaService(() => true)

    await svc.configure({ providerId: 'p1', enabled: true }) // fetcher 未传

    expect(readExtrasRaw()['p1']).toEqual({
      quota: { fetcher: 'legacy-kimi', enabled: true, cookieSet: true },
    })
  })

  it('注入 getProviderConfig 通道（arch-boundary S2 port 化）时 legacy quota 兜底经注入读，不碰 infra 模块函数', async () => {
    // models.json 物理写入一个 legacy quota；注入通道返回哨兵 fetcher——若兜底读的是
    // 注入通道，继承 from-injection；若仍直读 infra（getProviderConfig 模块函数，
    // 读真实 models.json），继承 from-models-json。断言锁定生产装配路径走注入。
    writeModelsJson_m2({
      p1: { baseUrl: 'https://x.example.com', quota: { fetcher: 'from-models-json', enabled: false } },
    })
    const svc = new QuotaService({
      dataDir: dir_m2,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderConfig: (id) =>
        id === 'p1' ? { quota: { fetcher: 'from-injection', enabled: false } } : undefined,
      providerCredentialResolver: stubResolver,
    })

    await svc.configure({ providerId: 'p1', enabled: true }) // fetcher 未传 → readQuotaFallback 兜底

    expect(readExtrasRaw()['p1']).toEqual({
      quota: { fetcher: 'from-injection', enabled: true },
    })
  })

  it('未注入 providerExtrasStore → 持久化失败返回（宁失败不写错位）', async () => {
    writeModelsJson_m2({ p1: { baseUrl: 'https://x.example.com' } })
    const svc = new QuotaService({ dataDir: dir_m2, providerExists: () => true, providerCredentialResolver: stubResolver })

    const result = await svc.configure({ providerId: 'p1', enabled: true })

    expect(result.ok).toBe(false)
    expect(existsSync(extrasPath)).toBe(false)
  })
})
describe('setProvider 写侧切换（A1-5 路径 2/3）', () => {
  function makeSvc(): ConfigService {
    return new ConfigService('/tmp/project', configStore_m2, undefined, extrasStore)
  }

  it('authMethod 写 providers.json，models.json 不落 authMethod（路径 2）', async () => {
    writeModelsJson_m2({})
    const svc = makeSvc()

    await svc.setProvider('my-custom', {
      apiKey: 'sk-x',
      authMethod: 'api_key',
      baseUrl: 'https://x.example.com',
      models: [{ id: 'm1', name: 'M1' }],
    })

    const providers = readModelsRaw()
    expect(providers['my-custom']?.authMethod).toBeUndefined()
    // 其余写入（apiKey/baseUrl/models）不变——models.json 保留 pi 原生语义字段
    expect(providers['my-custom']).toEqual({
      apiKey: 'sk-x',
      baseUrl: 'https://x.example.com',
      models: [{ id: 'm1', name: 'M1' }],
    })
    expect(readExtrasRaw()['my-custom']).toEqual({ authMethod: 'api_key' })
  })

  it('二次保存更新 authMethod：providers.json 覆写、models.json 始终干净', async () => {
    writeModelsJson_m2({})
    const svc = makeSvc()

    await svc.setProvider('my-custom', { apiKey: 'sk-x', authMethod: 'api_key', baseUrl: 'https://x.example.com' })
    await svc.setProvider('my-custom', { authMethod: 'oauth' })

    expect(readExtrasRaw()['my-custom']).toEqual({ authMethod: 'oauth' })
    expect(readModelsRaw()['my-custom']?.authMethod).toBeUndefined()
  })

  it('setProvider 不传 authMethod → providers.json 既有 authMethod 保留（modify 只覆写该字段）', async () => {
    writeModelsJson_m2({ p1: { baseUrl: 'https://x.example.com' } })
    await extrasStore.modify('p1', () => ({ authMethod: 'api_key' }))
    const svc = makeSvc()

    await svc.setProvider('p1', { name: 'Renamed' })

    expect(readExtrasRaw()['p1']).toEqual({ authMethod: 'api_key' })
  })

  it('防复活（路径 3）：调用方恶意传 quota → models.json 与 providers.json 均不落 quota', async () => {
    writeModelsJson_m2({})
    const svc = makeSvc()

    // quota 字段已从 SetProviderInput 类型删除——cast 模拟绕过类型的恶意调用方
    const malicious = {
      apiKey: 'sk-x',
      baseUrl: 'https://x.example.com',
      quota: { fetcher: 'zhipu', enabled: true },
    } as unknown as SetProviderInput
    await svc.setProvider('evil', malicious)

    expect(readModelsRaw()['evil']?.quota).toBeUndefined()
    expect(readExtrasRaw()['evil']).toBeUndefined()
  })

  it('未注入 extrasStore 时 authMethod 丢弃 + 不抛错（宁丢不写错位）', async () => {
    writeModelsJson_m2({})
    const svc = new ConfigService('/tmp/project', configStore_m2, undefined, undefined)

    await svc.setProvider('my-custom', {
      apiKey: 'sk-x',
      authMethod: 'api_key',
      baseUrl: 'https://x.example.com',
    })

    expect(readModelsRaw()['my-custom']?.authMethod).toBeUndefined()
    expect(existsSync(extrasPath)).toBe(false)
  })
})
describe('setProvider 写侧切换（G3 残留：models[].enabled → providers.json modelStates）', () => {
  function makeSvc(): ConfigService {
    return new ConfigService('/tmp/project', configStore_m2, undefined, extrasStore)
  }

  it('model enabled 写 providers.json modelStates，models.json 不再落 enabled 字段', async () => {
    writeModelsJson_m2({
      'my-custom': { apiKey: 'sk-x', baseUrl: 'https://x.example.com' },
    })
    const svc = makeSvc()

    await svc.setProvider('my-custom', {
      models: [
        { id: 'm1', name: 'M1', enabled: false },
        { id: 'm2', name: 'M2' }, // 未传 enabled：不产生 modelStates 条目
      ],
    })

    // models.json：models[].enabled 不再序列化（pi schema 外寄生字段）
    const models = readModelsRaw()['my-custom']?.models as Array<Record<string, unknown>>
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({ id: 'm1', name: 'M1' })
    expect(models[1]).toEqual({ id: 'm2', name: 'M2' })
    // providers.json：modelStates 记录启停（仅含显式传 enabled 的条目）
    expect(readExtrasRaw()['my-custom']).toEqual({
      modelStates: { m1: { enabled: false } },
    })
  })

  it('base 残留的旧 enabled（迁移失败窗口数据）写入时一并剥除', async () => {
    writeModelsJson_m2({
      p1: {
        baseUrl: 'https://x.example.com',
        models: [{ id: 'm1', name: 'M1', enabled: true }], // 旧寄生数据
      },
    })
    const svc = makeSvc()

    // 回传不带 enabled：base spread 会把旧 enabled 带进 model 对象——G3 修复后 delete 剥除
    await svc.setProvider('p1', { models: [{ id: 'm1', name: 'M1' }] })

    const models = readModelsRaw().p1?.models as Array<Record<string, unknown>>
    expect(models[0]).toEqual({ id: 'm1', name: 'M1' })
    // 未显式传 enabled → 不写 modelStates（旧值也不搬运——读侧双读兜底仍能读到旧数据）
    expect(readExtrasRaw().p1).toBeUndefined()
  })

  it('modelStates RMW 合并（S2 语义）：authMethod 等其他字段保留；custom provider 的 payload 即全集，未回传的 model 条目剔除', async () => {
    writeModelsJson_m2({ p1: { baseUrl: 'https://x.example.com' } })
    await extrasStore.modify('p1', () => ({
      authMethod: 'api_key',
      modelStates: { 'deleted-model': { enabled: false }, m1: { enabled: true } },
    }))
    const svc = makeSvc()

    // 回传不含 deleted-model（编辑体已删该模型）→ 其 modelStates 残留须剔除（S2 修复，
    // 旧实现 {...current, ...updates} 合并导致残留、同 id 重加旧 disabled 复活）
    await svc.setProvider('p1', { models: [{ id: 'm1', name: 'M1', enabled: false }] })

    expect(readExtrasRaw().p1).toEqual({
      authMethod: 'api_key',
      modelStates: { m1: { enabled: false } },
    })
    expect(readModelsRaw().p1?.authMethod).toBeUndefined()
  })

  it('未注入 extrasStore 时 model enabled 丢弃 + 不抛错（宁丢不写错位，与 authMethod 对称）', async () => {
    writeModelsJson_m2({})
    const svc = new ConfigService('/tmp/project', configStore_m2, undefined, undefined)

    await svc.setProvider('my-custom', {
      apiKey: 'sk-x',
      baseUrl: 'https://x.example.com',
      models: [{ id: 'm1', name: 'M1', enabled: false }],
    })

    const models = readModelsRaw()['my-custom']?.models as Array<Record<string, unknown>>
    expect(models[0]).toEqual({ id: 'm1', name: 'M1' })
    expect(existsSync(extrasPath)).toBe(false)
  })
})
});

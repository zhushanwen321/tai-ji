/**
 * B-4a/B-4b setProvider 写入字段测试（provider-config-quota-architecture design §5 Phase B-4）。
 *
 * B-4a：headers/authHeader（pi ProviderConfigSchema 内字段）写入 models.json provider 条目
 * ——修复 design §2.1 场景 D 的写入断链（前端已发送、runtime 不写）。
 * B-4b：模型写入白名单补 reasoning/maxTokens/cost/headers（pi ModelDefinitionSchema 内字段），
 * 非法值 throw 不静默丢弃。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-write-fields.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 provider-read-source-switch.test.ts 同模式——落盘断言读回真实 models.json（而非 mock
 * upsertProvider 入参），「不落盘」断言比较校验失败后文件内容与写入前逐字一致。
 * 用 custom provider（my-proxy）隔离 catalog apiKey 剥离分支的干扰。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'

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
    // round-1 review MUST_FIX #3：sanitizeModelCost 两个 throw 守卫——
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

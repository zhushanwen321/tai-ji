/**
 * A1-5 写侧切换测试：quota.configure 与 setProvider 改写 config/providers.json，
 * models.json 不再落寄生字段（验收 3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-write-side-switch.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 legacy-provider-migration-step2.test.ts 同模式。物理读两个文件断言终态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaService } from '../quota-service.js'
import { ConfigService } from '../config-service.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
import type { SetProviderInput } from '../provider-config-helper.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'

/** 恒注入形态的 resolver 替身（M2fg：QuotaService 构造必需；configure 路径不消费凭据）。 */
const stubResolver: IProviderCredentialResolver = {
  hasProviderCredential: () => false,
  listCredentialBackedProviderIds: () => new Set<string>(),
  resolveProviderCredential: async () => undefined,
}

let dir: string
let agentDir: string
let extrasPath: string
let extrasStore: TaijiProviderStore
let configStore: PiConfigStore

function writeModelsJson(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function readModelsRaw(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')).providers
}

function readExtrasRaw(): Record<string, unknown> {
  // 文件不存在 = 空扩展数据（TaijiProviderStore 读路径不物化文件）
  if (!existsSync(extrasPath)) return {}
  return JSON.parse(readFileSync(extrasPath, 'utf-8')).providers
}

function makeQuotaService(providerExists: (id: string) => boolean): QuotaService {
  return new QuotaService({ dataDir: dir, providerExtrasStore: extrasStore, providerExists, providerCredentialResolver: stubResolver })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-write-side-switch-'))
  agentDir = join(dir, 'agent')
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  extrasPath = join(agentDir, 'config', 'providers.json')
  extrasStore = new TaijiProviderStore(extrasPath)
  configStore = new PiConfigStore()
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('QuotaService.configure 写侧切换（A1-5 路径 1）', () => {
  it('configure 成功：providers.json 更新 quota（enabled/fetcher），models.json 无 quota 字段', async () => {
    writeModelsJson({
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
    writeModelsJson({}) // models.json 完全无该 provider
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
    writeModelsJson({
      p1: { baseUrl: 'https://x.example.com', quota: { fetcher: 'legacy-kimi', enabled: false } },
    })
    await extrasStore.modify('p1', () => ({ quota: { fetcher: 'zhipu', enabled: false } }))
    const svc = makeQuotaService(() => true)

    await svc.configure({ providerId: 'p1', enabled: true }) // fetcher 未传

    // providers.json 的 zhipu 优先，models.json 旧值 legacy-kimi 不复活
    expect(readExtrasRaw()['p1']).toEqual({ quota: { fetcher: 'zhipu', enabled: true } })
  })

  it('fetcher 未传时继承既有值：providers.json 无条目回退 models.json 旧 quota（迁移失败窗口）', async () => {
    writeModelsJson({
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
    writeModelsJson({
      p1: { baseUrl: 'https://x.example.com', quota: { fetcher: 'from-models-json', enabled: false } },
    })
    const svc = new QuotaService({
      dataDir: dir,
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
    writeModelsJson({ p1: { baseUrl: 'https://x.example.com' } })
    const svc = new QuotaService({ dataDir: dir, providerExists: () => true, providerCredentialResolver: stubResolver })

    const result = await svc.configure({ providerId: 'p1', enabled: true })

    expect(result.ok).toBe(false)
    expect(existsSync(extrasPath)).toBe(false)
  })
})

describe('setProvider 写侧切换（A1-5 路径 2/3）', () => {
  function makeSvc(): ConfigService {
    return new ConfigService('/tmp/project', configStore, undefined, extrasStore)
  }

  it('authMethod 写 providers.json，models.json 不落 authMethod（路径 2）', async () => {
    writeModelsJson({})
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
    writeModelsJson({})
    const svc = makeSvc()

    await svc.setProvider('my-custom', { apiKey: 'sk-x', authMethod: 'api_key', baseUrl: 'https://x.example.com' })
    await svc.setProvider('my-custom', { authMethod: 'oauth' })

    expect(readExtrasRaw()['my-custom']).toEqual({ authMethod: 'oauth' })
    expect(readModelsRaw()['my-custom']?.authMethod).toBeUndefined()
  })

  it('setProvider 不传 authMethod → providers.json 既有 authMethod 保留（modify 只覆写该字段）', async () => {
    writeModelsJson({ p1: { baseUrl: 'https://x.example.com' } })
    await extrasStore.modify('p1', () => ({ authMethod: 'api_key' }))
    const svc = makeSvc()

    await svc.setProvider('p1', { name: 'Renamed' })

    expect(readExtrasRaw()['p1']).toEqual({ authMethod: 'api_key' })
  })

  it('防复活（路径 3）：调用方恶意传 quota → models.json 与 providers.json 均不落 quota', async () => {
    writeModelsJson({})
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
    writeModelsJson({})
    const svc = new ConfigService('/tmp/project', configStore, undefined, undefined)

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
    return new ConfigService('/tmp/project', configStore, undefined, extrasStore)
  }

  it('model enabled 写 providers.json modelStates，models.json 不再落 enabled 字段', async () => {
    writeModelsJson({
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
    writeModelsJson({
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
    writeModelsJson({ p1: { baseUrl: 'https://x.example.com' } })
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
    writeModelsJson({})
    const svc = new ConfigService('/tmp/project', configStore, undefined, undefined)

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

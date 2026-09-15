/**
 * 删除链 extras 清理（S1）+ setProvider modelStates 残留清理（S2）回归测试。
 *
 * 对应 round 1 review（business-logic）suggestion：
 * - S1：deleteProvider / removeProviderByKind 不清 providers.json extras → custom provider
 *   删除后 quota/modelStates/authMethod 永久残留、catalog「移除」（语义=清用户侧状态）后
 *   quota.enabled 仍 true、同 id 重建静默继承旧配置。修复：删除链调 extrasStore.delete。
 * - S2：setProvider modelStates 只合并不清理 → 删除自定义模型后条目残留、同 id 重加旧
 *   disabled 复活。修复：按保留集合重建（custom = payload 全集；catalog = payload ∪ builtin）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-extras-cleanup.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 provider-write-side-switch.test.ts 同模式。物理读 models.json / providers.json 断言终态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
import { deleteProvider } from '../provider-config-helper.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'

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

/** 恒注入形态的 resolver 替身（D3/M2fg：removeProviderByKind 经 resolver() 守卫强制要求；
 * 本文件用例不关心凭据解析，空集语义 = 无凭据，与生产「无凭据 provider」一致）。 */
const stubResolver: IProviderCredentialResolver = {
  hasProviderCredential: () => false,
  listCredentialBackedProviderIds: () => new Set<string>(),
  resolveProviderCredential: async () => undefined,
}

function makeSvc(): ConfigService {
  return new ConfigService('/tmp/project', configStore, undefined, extrasStore, undefined, stubResolver)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-extras-cleanup-'))
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

// ══ S1: 删除链清 providers.json extras ═══════════════════════════════════════

describe('S1: deleteProvider / removeProviderByKind 清 providers.json extras（M5-05 清残留）', () => {
  it('deleteProvider(custom)：models.json 条目与 providers.json extras（authMethod/quota/modelStates）一并清除', async () => {
    writeModelsJson({
      'my-custom': { apiKey: 'sk-old', baseUrl: 'https://old.example.com' },
      keeper: { apiKey: 'sk-k', baseUrl: 'https://k.example.com' },
    })
    await extrasStore.modify('my-custom', () => ({
      authMethod: 'oauth',
      quota: { enabled: true, fetcher: 'zhipu' },
      modelStates: { m1: { enabled: false } },
    }))
    await extrasStore.modify('keeper', () => ({ authMethod: 'api_key' }))
    const svc = makeSvc()

    const ret = await svc.deleteProvider('my-custom')

    expect(ret.removed).toBe(true)
    expect(readModelsRaw()['my-custom']).toBeUndefined()
    // 修复核心断言：extras 条目不残留（旧实现 deleteProvider 不触碰 providers.json）
    expect(readExtrasRaw()['my-custom']).toBeUndefined()
    // 其他 provider 的 extras 不受影响（delete 单条目）
    expect(readExtrasRaw()['keeper']).toEqual({ authMethod: 'api_key' })
  })

  it('同 id 重建不复活旧配置：删除后重新 setProvider 同 id，旧 quota/authMethod/modelStates 不继承', async () => {
    writeModelsJson({
      'my-custom': { apiKey: 'sk-old', baseUrl: 'https://old.example.com' },
    })
    await extrasStore.modify('my-custom', () => ({
      authMethod: 'oauth',
      quota: { enabled: true, fetcher: 'zhipu' },
      modelStates: { m1: { enabled: false } },
    }))
    const svc = makeSvc()

    await svc.deleteProvider('my-custom')
    await svc.setProvider('my-custom', { apiKey: 'sk-new', baseUrl: 'https://new.example.com' })

    // 新条目只含本次写入语义：不传 authMethod/models → providers.json 不落旧标注/启停/quota
    expect(readExtrasRaw()['my-custom']).toBeUndefined()
    expect(readModelsRaw()['my-custom']).toEqual({
      apiKey: 'sk-new',
      baseUrl: 'https://new.example.com',
    })
  })

  it('removeProviderByKind(catalog)「移除=清用户状态」：quota.enabled 残留一并清除', async () => {
    writeModelsJson({
      openai: { baseUrl: 'https://ovr.example.com' }, // catalog override 条目
    })
    await extrasStore.modify('openai', () => ({ quota: { enabled: true, fetcher: 'zhipu' } }))
    const svc = makeSvc()

    const ret = await svc.removeProviderByKind('openai', 'catalog')

    expect(ret.removed).toBe(true)
    // 修复核心断言：quota.enabled=true 残留会让额度链路继续对无凭证 provider 发查询
    expect(readExtrasRaw()['openai']).toBeUndefined()
  })

  it('removeProviderByKind(custom)：extras 条目清除', async () => {
    writeModelsJson({
      'my-custom': { apiKey: 'sk-old', baseUrl: 'https://old.example.com' },
    })
    await extrasStore.modify('my-custom', () => ({ modelStates: { m1: { enabled: false } } }))
    const svc = makeSvc()

    await svc.removeProviderByKind('my-custom', 'custom')

    expect(readModelsRaw()['my-custom']).toBeUndefined()
    expect(readExtrasRaw()['my-custom']).toBeUndefined()
  })

  it('幂等：providers.json 不存在（无任何 extras）时 deleteProvider 不物化文件、不抛错', async () => {
    writeModelsJson({ 'my-custom': { apiKey: 'sk-old' } })
    const svc = makeSvc()

    await expect(svc.deleteProvider('my-custom')).resolves.toEqual({ removed: true })
    expect(existsSync(extrasPath)).toBe(false)
  })

  it('extras 清理失败不阻断删除主流程（cleanProviderExtras try-catch warn，与 cleanAuthCredential 同语义）', async () => {
    writeModelsJson({ 'my-custom': { apiKey: 'sk-old' } })
    // cleanScopedModelsResidue 也 resolve：本用例聚焦 extras.delete 失败路径
    // （scoped 清理（scoped-model）不 mock reject，避免两个失败源混淆断言）
    const failingExtras = {
      delete: vi.fn().mockRejectedValue(new Error('disk full')),
      cleanScopedModelsResidue: vi.fn().mockResolvedValue(undefined),
    }

    const ret = await deleteProvider(configStore, undefined, failingExtras, 'my-custom')

    // 条目删除（主语义）已完成并正常返回；extras 清理失败仅 warn
    expect(ret.removed).toBe(true)
    expect(readModelsRaw()['my-custom']).toBeUndefined()
    expect(failingExtras.delete).toHaveBeenCalledWith('my-custom')
  })
})

// ══ S2: setProvider modelStates 残留清理 ═══════════════════════════════════════

describe('S2: setProvider modelStates 按保留集合清理（custom=payload 全集 / catalog=∪builtin）', () => {
  it('custom：删除自定义模型后其 modelStates 条目剔除（payload 即全集）', async () => {
    writeModelsJson({ p1: { apiKey: 'sk-x', baseUrl: 'https://x.example.com' } })
    await extrasStore.modify('p1', () => ({
      modelStates: { m1: { enabled: true }, m2: { enabled: false } },
    }))
    const svc = makeSvc()

    // 第二次保存回传不含 m2（编辑体已删）→ m2 的 disabled 状态须剔除
    await svc.setProvider('p1', { models: [{ id: 'm1', name: 'M1', enabled: true }] })

    expect(readExtrasRaw().p1).toEqual({ modelStates: { m1: { enabled: true } } })
  })

  it('custom：删除后同 id 重加模型不复活旧 disabled 状态（用户以为新模型被莫名禁用的根因）', async () => {
    writeModelsJson({ p1: { apiKey: 'sk-x', baseUrl: 'https://x.example.com' } })
    await extrasStore.modify('p1', () => ({ modelStates: { m2: { enabled: false } } }))
    const svc = makeSvc()

    // 保存不含 m2（模型被删）→ 再重加 m2 且不显式传 enabled（新建默认启用语义）
    await svc.setProvider('p1', { models: [{ id: 'm1', name: 'M1', enabled: true }] })
    await svc.setProvider('p1', { models: [{ id: 'm1', enabled: true }, { id: 'm2', name: 'M2' }] })

    // m2 无状态条目（= 默认启用）；旧 disabled 不复活
    expect(readExtrasRaw().p1).toEqual({ modelStates: { m1: { enabled: true } } })
  })

  it('catalog：builtin 模型启停保留（payload 只含 override 条目，B-2 后 builtin id 不在 payload）', async () => {
    // openai 是 builtin catalog provider；gpt-4o 是其 builtin 模型 id（启停是合法状态）
    writeModelsJson({
      openai: { baseUrl: 'https://ovr.example.com', models: [{ id: 'my-ovr', name: 'OVR' }] },
    })
    await extrasStore.modify('openai', () => ({
      modelStates: { 'gpt-4o': { enabled: false }, 'my-ovr': { enabled: true } },
    }))
    const svc = makeSvc()

    await svc.setProvider('openai', { models: [{ id: 'my-ovr', name: 'OVR v2', enabled: false }] })

    // builtin gpt-4o 的启停保留（不被 override-only payload 清掉）；my-ovr 被覆写
    expect(readExtrasRaw().openai).toEqual({
      modelStates: { 'gpt-4o': { enabled: false }, 'my-ovr': { enabled: false } },
    })
  })

  it('catalog：删除 override 模型后其 modelStates 剔除，builtin 启停仍保留', async () => {
    writeModelsJson({
      openai: { baseUrl: 'https://ovr.example.com', models: [{ id: 'my-ovr', name: 'OVR' }] },
    })
    await extrasStore.modify('openai', () => ({
      modelStates: { 'gpt-4o': { enabled: false }, 'my-ovr': { enabled: true } },
    }))
    const svc = makeSvc()

    // 换一批 override（my-ovr 被删除、换成 ovr-2）→ my-ovr 剔除、gpt-4o 保留
    await svc.setProvider('openai', { models: [{ id: 'ovr-2', name: 'OVR2', enabled: true }] })

    expect(readExtrasRaw().openai).toEqual({
      modelStates: { 'gpt-4o': { enabled: false }, 'ovr-2': { enabled: true } },
    })
  })
})

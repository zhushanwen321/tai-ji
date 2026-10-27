import builtinData from '../../generated/builtin-providers.json';
import { ExtensionResolver } from '../../infra/installers/extension-resolver.js';
import { ModelConnectionTester } from '../../infra/model-connection-tester.js';
import { PiConfigStore } from '../../infra/pi/pi-config-store.js';
import { getModelsPath } from '../../infra/pi/pi-paths.js';
import { clearEnabledModels, ensureProviderInWhitelist, refreshModels, setEnabledModels, setModelsPath, type PiModelsConfig, writeModels } from '../../infra/pi/pi-provider-store.js';
import { getActiveSettingsPath, invalidateSettingsCache, setSettingsPath } from '../../infra/pi/pi-settings-store.js';
import { SettingsMessageHandler, type SettingsHandlerContext } from '../../transport/settings-message-handler.js';
import { AuthStorage } from '../auth/auth-storage.js';
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js';
import { ConfigService } from '../config-service.js';
import { ExtensionService } from '../extension-service.js';
import { mergeRetryConfig, resolveRetryConfig, validateRetryConfigForWrite } from '../llm-retry-config-helper.js';
import piAuthFixture from '../migration/parsers/__tests__/fixtures/pi-auth.json';
import piModelsFixture from '../migration/parsers/__tests__/fixtures/pi-models.json';
import { _resetCacheForTest } from '../migration/preview-cache.js';
import { applyImport, previewImport } from '../migration/provider-importer.js';
import { ConfigModelsConfig, type ConfigProviderConfig, type IConfigStore } from '../ports/config.js';
import type { IExtensionSettings } from '../ports/extension-settings.js';
import type { IInstaller } from '../ports/installer.js';
import { LlmRetryConfigSnapshot, type ILlmRetrySettings } from '../ports/llm-retry-settings.js';
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js';
import { deriveEnabled } from '../provider-catalog.js';
import { deleteProvider } from '../provider-config-helper.js';
import { TaijiProviderStore, type ProviderExtrasFile } from '../provider-extras-store.js';
import { ProviderImportPreview, ProviderImportResult, SourceDetectResult, type ClientMessage, type LlmRetryConfig } from '@taiji/shared';
import { existsSync, mkdirSync, mkdtemp, mkdtempSync, readFileSync, readdirSync, rm, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← provider-extras-cleanup.test.ts
// ======================================================================

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


/** 恒注入形态的 resolver 替身（D3/M2fg：removeProviderByKind 经 resolver() 检查强制要求；
 * 本文件用例不关心凭据解析，空集语义 = 无凭据，与生产「无凭据 provider」一致）。 */
const stubResolver: IProviderCredentialResolver = {
  hasProviderCredential: () => false,
  listCredentialBackedProviderIds: () => new Set<string>(),
  resolveProviderCredential: async () => undefined,
  resolveProviderApiKeyRaw: async () => undefined,
  resolveProviderBaseUrl: () => undefined,
}


function makeSvc(): ConfigService {
  return new ConfigService('/tmp/project', configStore, undefined, extrasStore, undefined, stubResolver)
}



let dir_m2: string


let file: string


let store: TaijiProviderStore

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-extras-store', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-extras-cleanup', () => {
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
// ══ S3: setProvider remoteSource 落 providers.json extras（remote-config 域 1）════════════════════════════════════════

describe('S3: setProvider remoteSource 标记落盘（QuickSetup 从 taiji 清单创建时回传）', () => {
  it('payload 回传 remoteSource → extras.remoteSource 落盘；重保存不回传不丢标记', async () => {
    writeModelsJson({ 'relay-provider': { apiKey: 'sk-a', baseUrl: 'https://relay.example.com' } })
    const svc = makeSvc()

    await svc.setProvider('relay-provider', { apiKey: 'sk-a', remoteSource: 'taiji-relay' })
    expect(readExtrasRaw()['relay-provider']).toMatchObject({ remoteSource: 'taiji-relay' })

    // 重保存不回传 = 不动（语义同 persistAuthMethod：既有标记保留，远程模型热更新判据不丢）
    await svc.setProvider('relay-provider', { apiKey: 'sk-b' })
    expect(readExtrasRaw()['relay-provider']).toMatchObject({ remoteSource: 'taiji-relay' })
  })

  it('extrasStore 未注入 + 回传 remoteSource → warn 丢弃（宁丢不写错位，生产恒注入）', async () => {
    writeModelsJson({ 'relay-provider': { apiKey: 'sk-a' } })
    const svc = new ConfigService('/tmp/project', configStore, undefined, undefined, undefined, stubResolver)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await svc.setProvider('relay-provider', { apiKey: 'sk-a', remoteSource: 'taiji-relay' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('remoteSource dropped for relay-provider'))
    warn.mockRestore()
    expect(readExtrasRaw()).toEqual({})
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-extras-store', () => {
beforeEach(() => {
  dir_m2 = mkdtempSync(join(tmpdir(), 'provider-extras-store-'))
  mkdirSync(join(dir_m2, 'config'), { recursive: true })
  file = join(dir_m2, 'config', 'providers.json')
  store = new TaijiProviderStore(file)
})
afterEach(() => {
  rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('TaijiProviderStore', () => {
  it('文件不存在时 readAll 返回空对象且不物化文件（读路径无副作用）', async () => {
    expect(store.readAllSync()).toEqual({})
    expect(existsSync(file)).toBe(false)
  })

  it('文件不存在时 getExtras 返回 undefined', async () => {
    expect(store.getExtrasSync('zai-coding-cn')).toBeUndefined()
  })

  it('modify 写入后 getExtras/readAll 读回完整数据（含 cookieSet/apiKeySet/modelStates）', async () => {
    await store.modify('zai-coding-cn', () => ({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    }))
    expect(store.getExtrasSync('zai-coding-cn')).toEqual({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    })
    const all = store.readAllSync()
    expect(Object.keys(all)).toEqual(['zai-coding-cn'])
  })

  it('modify 不同 provider 互不覆盖', async () => {
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    await store.modify('b', () => ({ authMethod: 'oauth' }))
    expect((store.getExtrasSync('a'))?.authMethod).toBe('api_key')
    expect((store.getExtrasSync('b'))?.authMethod).toBe('oauth')
  })

  it('并发 modify 同 provider：最终状态一致无交错（proper-lockfile 串行化 RMW）', async () => {
    // 并发用例注入小退避下限：锁竞争重试等待从 100ms 级压到 5ms 级（生产默认 100 不变）；
    // 并发语义断言（串行化、无交错）不受退避时长影响
    const store = new TaijiProviderStore(file, { lockMinRetryTimeoutMs: 5 })
    // 两个 Promise 同时写同 provider 的不同字段，各自基于 current 增量更新——
    // 锁保证后者在锁内重读到前者的结果，两字段都保留（无交错半写）
    await Promise.all([
      store.modify('shared', current => ({ ...current, authMethod: 'api_key' })),
      store.modify('shared', current => ({ ...current, quota: { enabled: true } })),
    ])
    expect(store.getExtrasSync('shared')).toEqual({
      authMethod: 'api_key',
      quota: { enabled: true },
    })
    // 加大并发压力：10 个并发 modify 各写一个 modelState 条目，全部保留
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.modify('chaos', current => ({
          ...current,
          modelStates: { ...current?.modelStates, [`m${i}`]: { enabled: i % 2 === 0 } },
        })),
      ),
    )
    expect(Object.keys((store.getExtrasSync('chaos'))?.modelStates ?? {})).toHaveLength(10)
  })

  it('并发 modify 不同 provider：全部保留', async () => {
    const store = new TaijiProviderStore(file, { lockMinRetryTimeoutMs: 5 })
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.modify(`p${i}`, () => ({ quota: { enabled: true, fetcher: `f${i}` } })),
      ),
    )
    const all = store.readAllSync()
    expect(Object.keys(all)).toHaveLength(10)
    expect(all.p3?.quota?.fetcher).toBe('f3')
  })

  it('delete 删除条目且幂等；文件不存在时不物化 providers.json', async () => {
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    await store.delete('a')
    expect(store.getExtrasSync('a')).toBeUndefined()

    // 幂等：条目已不存在再删不抛错、不写盘
    await store.delete('a')
    await store.delete('never-existed')
    expect(store.getExtrasSync('a')).toBeUndefined()

    // 文件不存在时 delete 不物化（对齐 AuthStorage.remove 语义）
    const freshDir = mkdtempSync(join(tmpdir(), 'provider-extras-store-fresh-'))
    try {
      const freshFile = join(freshDir, 'config', 'providers.json')
      await new TaijiProviderStore(freshFile).delete('x')
      expect(existsSync(freshFile)).toBe(false)
    } finally {
      rmSync(freshDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('损坏容错：非法 JSON → readAll 返回空 + 备份为 providers.json.corrupt-<ts>', async () => {
    writeFileSync(file, '{ not valid json', 'utf-8')
    expect(store.readAllSync()).toEqual({})
    // 备份文件生成（quarantine 是 rename 语义：坏文件移走，原位置恢复可写）
    const corruptions = readdirSync(join(dir_m2, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))
    expect(corruptions).toHaveLength(1)
    // 隔离后原文件已移走，后续 modify 正常重建
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    expect(store.getExtrasSync('a')).toMatchObject({ authMethod: 'api_key' })
  })

  it('损坏容错：version 非 1（未来格式）→ 按空配置 + 隔离备份', async () => {
    writeFileSync(file, JSON.stringify({ version: 2, providers: { x: { authMethod: 'api_key' } } }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    const corruptions = readdirSync(join(dir_m2, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))
    expect(corruptions).toHaveLength(1)
  })

  it('损坏容错：结构不匹配（providers 非对象）→ 按空配置 + 隔离备份', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, providers: 'not-an-object' }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir_m2, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('损坏容错：providers 为 null → 按空配置 + 隔离备份（typeof null === "object" 不得穿透校验）', async () => {
    // round 1 review must-fix #5：null 穿透校验会让 readAll 返回 providers:null，
    // 消费方对 null 赋值直接 TypeError 且无隔离自愈
    writeFileSync(file, JSON.stringify({ version: 1, providers: null }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir_m2, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('损坏容错：providers 为数组 → 按空配置 + 隔离备份 + 后续 modify 可写回（typeof [] === "object" 不得穿透校验）', async () => {
    // round 2 review must-fix：数组形态穿透校验后 readAllSync 返回数组，modify 表面成功
    // 但 JSON.stringify 丢弃数组上的字符串键属性 → 写盘静默丢失、文件永久停留损坏形态
    writeFileSync(file, JSON.stringify({ version: 1, providers: [] }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir_m2, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
    // 隔离（rename）后原位置恢复可写，modify 正常重建且读回一致
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    expect(store.getExtrasSync('a')).toMatchObject({ authMethod: 'api_key' })
  })

  it('损坏容错：条目级 null（providers 含 null 值）→ 按空配置 + 隔离备份', async () => {
    // round 2 review suggestion：{"foo": null} 穿透后 getExtrasSync('foo') 返回 null，
    // 与签名 ProviderExtras | undefined 失实，消费方 !== undefined 判定被 null 欺骗
    writeFileSync(file, JSON.stringify({ version: 1, providers: { foo: null, bar: { authMethod: 'api_key' } } }), 'utf-8')
    expect(store.readAllSync()).toEqual({})
    expect(readdirSync(join(dir_m2, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('空文件内容按空配置处理（不触发隔离）', async () => {
    writeFileSync(file, '', 'utf-8')
    // 空串 JSON.parse 抛错 → 走隔离路径？——JSON.parse('') throws → 隔离 + 空。
    // 语义上空文件等同未初始化，隔离后按空继续（与 AuthStorage 空文件按空不同：
    // providers.json 是 taiji 自有文件（原子写保证非空），空文件只可能来自外部干预，隔离留证）
    expect(store.readAllSync()).toEqual({})
  })

  describe('A1 读写往返（scopedModels）', () => {
    it('modifyScopedModels 写入 → getScopedModels 读回一致', async () => {
      const models = ['openai/gpt-4o', 'anthropic/claude-opus-4-5', 'deepseek/deepseek-v3']
      await store.modifyScopedModels(() => models)
      expect(store.getScopedModelsSync()).toEqual(models)
    })

    it('字段缺失时 getScopedModels 返回 []（文件不存在）', () => {
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('字段缺失时 getScopedModels 返回 []（providers.json 存在但无 scopedModels 字段）', async () => {
      await store.modify('a', () => ({ authMethod: 'api_key' }))
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('modifyScopedModels 读取闭包参数为当前值', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      const result = await store.modifyScopedModels((cur) => [...cur, 'anthropic/claude-sonnet-4'])
      expect(result).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
    })
  })

  describe('A2 非法容错（scopedModels）', () => {
    it('非数组 scopedModels → getScopedModels 返回 []、providers 域不受影响', async () => {
      // 手写 providers.json：scopedModels 为字符串（非法），providers 有有效数据
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { 'openai': { authMethod: 'api_key' } },
        scopedModels: 'not-an-array',
      }, null, 2), 'utf-8')
      expect(store.getScopedModelsSync()).toEqual([])
      expect(store.readAllSync()).toEqual({ 'openai': { authMethod: 'api_key' } })
    })

    it('非数组 scopedModels（number）→ getScopedModels 返回 []', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {},
        scopedModels: 42,
      }, null, 2), 'utf-8')
      expect(store.getScopedModelsSync()).toEqual([])
    })

    it('含非法条目（不含/分隔符）→ 过滤掉非法条目并 log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(file, JSON.stringify({
          version: 1,
          providers: {},
          scopedModels: ['openai/gpt-4o', 'invalid-no-slash', 'anthropic/claude-sonnet-4'],
        }, null, 2), 'utf-8')
        expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: invalid entry format (expected provider/modelId):',
          'invalid-no-slash',
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('含非 string 条目 → 过滤掉并 log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(file, JSON.stringify({
          version: 1,
          providers: {},
          scopedModels: ['openai/gpt-4o', 123, null, 'anthropic/claude-sonnet-4'],
        }, null, 2), 'utf-8')
        expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: non-string entry filtered out:',
          123,
        )
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] scopedModels: non-string entry filtered out:',
          null,
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('scopedModels 非法时 providers 域数据完全不受影响', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {
          'openai': { authMethod: 'api_key', modelStates: { 'gpt-4o': { enabled: true } } },
          'anthropic': { authMethod: 'oauth' },
        },
        scopedModels: { not: 'array' },
      }, null, 2), 'utf-8')
      expect(store.readAllSync()).toEqual({
        'openai': { authMethod: 'api_key', modelStates: { 'gpt-4o': { enabled: true } } },
        'anthropic': { authMethod: 'oauth' },
      })
    })
  })

  describe('A3 去重保序（读侧 sanitize 收敛，写侧不改写）', () => {
    it('写入 [] 后文件中 scopedModels 字段保留为空数组', async () => {
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o'])

      await store.modifyScopedModels(() => [])
      expect(store.getScopedModelsSync()).toEqual([])

      // 验证文件中 scopedModels 字段保留（非 undefined/缺失）
      const { readFileSync: rf } = await import('node:fs')
      const raw = JSON.parse(rf(file, 'utf-8'))
      expect(raw.scopedModels).toEqual([])
      // key 存在于 JSON 中
      expect('scopedModels' in raw).toBe(true)
    })

    it('写入含重复条目时读取去重保序（读侧 sanitize 首见保留，防 aggregateModels 输出重复模型）', async () => {
      const models = ['openai/gpt-4o', 'openai/gpt-4o', 'anthropic/claude-sonnet-4']
      await store.modifyScopedModels(() => models)
      // 写侧不去重（文件原样保留写入值），读侧唯一入口 sanitizeScopedModels 去重
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
    })
  })

  describe('A4 与 per-provider modify 串行安全', () => {
    it('交错调用 modifyScopedModels 与 modify 同一文件，无丢更新', async () => {
      const store = new TaijiProviderStore(file, { lockMinRetryTimeoutMs: 5 })
      // 先写入初始数据
      await store.modifyScopedModels(() => ['openai/gpt-4o'])
      await store.modify('openai', () => ({ authMethod: 'api_key' }))

      // 并发交错调用：scopedModels 写入 + per-provider 写入
      await Promise.all([
        store.modifyScopedModels((cur) => [...cur, 'anthropic/claude-sonnet-4']),
        store.modify('anthropic', () => ({ authMethod: 'oauth' })),
      ])

      // 两者都成功保留
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
      expect(store.getExtrasSync('openai')).toEqual({ authMethod: 'api_key' })
      expect(store.getExtrasSync('anthropic')).toEqual({ authMethod: 'oauth' })
    })

    it('高并发交错：多次 modifyScopedModels + 多次 modify，最终状态一致', async () => {
      const store = new TaijiProviderStore(file, { lockMinRetryTimeoutMs: 5 })
      // 20 个并发操作：10 个 modifyScopedModels 追加 + 10 个 modify 写入不同 provider
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) =>
          store.modifyScopedModels((cur) => [...cur, `provider-${i}/model-${i}`]),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          store.modify(`provider-${i}`, () => ({ authMethod: 'api_key' as const })),
        ),
      ])

      // scopedModels 有 10 个条目（顺序可能因并发而变，但数量正确）
      const scoped = store.getScopedModelsSync()
      expect(scoped).toHaveLength(10)
      expect(scoped.every(m => /^provider-\d+\/model-\d+$/.test(m))).toBe(true)

      // 10 个 provider 的 extras 都保留
      for (let i = 0; i < 10; i++) {
        expect(store.getExtrasSync(`provider-${i}`)).toEqual({ authMethod: 'api_key' })
      }
    })

    it('先 modify 后 modifyScopedModels 基于最新文件读取', async () => {
      await store.modify('openai', () => ({ authMethod: 'api_key' }))
      await store.modifyScopedModels(() => ['openai/gpt-4o'])

      // 再次 modify 不会丢失 scopedModels
      await store.modify('openai', (cur) => ({ ...cur, quota: { enabled: true } }))
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o'])
      expect(store.getExtrasSync('openai')).toEqual({ authMethod: 'api_key', quota: { enabled: true } })
    })
  })

  describe('crash 残留自愈（round 1 review SUGGESTION）', () => {
    // 残留形态依据 proper-lockfile 4.1.2 实装（node_modules/proper-lockfile/lib/lockfile.js）：
    // - 锁「文件」实为 mkdir 创建的目录，持有进程 crash 未 release 时残留 `.lock` 目录；
    //   stale 判定 = 锁目录 mtime 早于 now - stale(30s) → 后来者接管（rmdir 后重新 mkdir），
    //   不触发 onCompromised（该回调仅在「自己持锁期间」update 定时器（stale/2=15s）发现
    //   mtime 失效时触发——单测的锁持有窗口是同步代码，无法插入 15s 定时器推进，
    //   模拟需 15s 真实等待或重构注入 lockfile 依赖，性价比不成立，故不覆盖该分支）。
    // - atomicWrite 崩溃在 rename 前残留 tmp（RT-3#9 起默认 tmp 名含 pid+序号，名字唯一）
    //   → 后续写入不再「覆写消费」旧 tmp（固定名时代的伪自愈）；孤儿 tmp 是惰性垃圾，
    //   绝不污染正式文件读写，回收归启动期清扫家族（本用例锁定数据完好这一安全属性）。
    it('残留 tmp + 过期 .lock 目录 → readAll 数据完好、modify 自愈正常、lock 残留清理', async () => {
      writeFileSync(file, JSON.stringify({ version: 1, providers: { legacy: { authMethod: 'api_key' } } }, null, 2), 'utf-8')
      // atomicWrite 崩溃在 rename 前：半写 tmp 残留（内容必须是外部半写垃圾，不得污染正式文件）。
      // 用真实孤儿形态（pid+序号名）模拟；另留一个旧版固定 `.tmp` 形态（历史残留）。
      writeFileSync(`${file}.tmp_${process.pid}-7`, '{"version":1,"providers":{"half-written":{}}}', 'utf-8')
      writeFileSync(`${file}.tmp`, '{"version":1,"providers":{"legacy-fixed-name":{}}}', 'utf-8')
      // proper-lockfile 持有进程 crash：.lock 目录残留，mtime 回拨 60s（> stale 30s 阈值）
      mkdirSync(`${file}.lock`)
      const staleTime = new Date(Date.now() - 60_000)
      utimesSync(`${file}.lock`, staleTime, staleTime)

      // 读路径不持锁：既有数据完好（tmp 半写内容未泄漏进正式文件）
      expect(store.readAllSync()).toEqual({ legacy: { authMethod: 'api_key' } })

      // 写路径：过期锁被接管删除后正常 RMW
      await store.modify('new-entry', () => ({ quota: { enabled: true } }))

      expect(store.getExtrasSync('legacy')).toEqual({ authMethod: 'api_key' })
      expect(store.getExtrasSync('new-entry')).toEqual({ quota: { enabled: true } })
      // 残留物清理：.lock 目录被 unlock rmdir；孤儿 tmp 不入正式文件（数据断言已覆盖），
      // 亦不被本次写消费（名字唯一）——仍留盘等待启动期回收家族
      expect(existsSync(`${file}.lock`)).toBe(false)
      expect(JSON.parse(readFileSync(file, 'utf-8')).providers['half-written']).toBeUndefined()
    })

    it('unlock 失败（持锁期间 .lock 目录被外部替换为普通文件）→ warn 可观测、modify 结果仍返回', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const result = await store.modify('a', () => {
          // fn 在锁内同步执行：此处模拟外部篡改，release 的 rmdir 将以 ENOTDIR 失败
          //（rmdir 只忽略 ENOENT，其余错误上抛 → withFileLock 的 catch → warn 分支）
          rmdirSync(`${file}.lock`)
          writeFileSync(`${file}.lock`, 'tampered', 'utf-8')
          return { authMethod: 'api_key' }
        })
        expect(result).toEqual({ authMethod: 'api_key' })
        expect(warnSpy).toHaveBeenCalledWith(
          '[provider-extras-store] release lock failed (continuing, lock may be compromised):',
          expect.any(Error),
        )
      } finally {
        warnSpy.mockRestore()
      }
    })
  })
})
});
});

// ======================================================================
// ← config-bundle.test.ts
// ======================================================================

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as Parameters<SettingsMessageHandler['handleSettingsMessage']>[1]
}


/**
 * 构造仅满足 config.detectSources case 所需的最小 ctx。
 * 其余字段用 vi.fn() 占位以满足类型（handleSettingsMessage 只在 detectSources 分支用到 reply/configService）。
 */
function mockContext(detectSourcesResult: SourceDetectResult[]): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
    configService: {
      detectSources: vi.fn(() => detectSourcesResult),
    } as unknown as SettingsHandlerContext['configService'],
    sessionService: {} as SettingsHandlerContext['sessionService'],
    modelService: {} as SettingsHandlerContext['modelService'],
    skillRegistry: {} as SettingsHandlerContext['skillRegistry'],
    projectRoot: '/tmp/project',
    nextPushId: vi.fn(() => 'push-1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: new ModelConnectionTester(),
  } as unknown as SettingsHandlerContext
}


function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


// ======================================================================
// ← src/services/__tests__/config-provider-import.test.ts
// ======================================================================

// ── mock helpers ─────────────────────────────────────────────

function mockWs_m2() {
  return { send: vi.fn(), readyState: 1 } as unknown as Parameters<SettingsMessageHandler['handleSettingsMessage']>[1]
}


/**
 * 构造满足 preview/apply case 所需的最小 ctx。
 * previewImportProviders / applyImportProviders 是 vi.fn()，各 test 用 mockReturnValue 覆盖返回值。
 */
function mockContext_m2(): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
    configService: {
      previewImportProviders: vi.fn(),
      // applyImportProviders 后 handler 调 getDefaultModel（重选 default + 广播 config.defaults），mock 补全
      getDefaultModel: vi.fn(() => null),
      applyImportProviders: vi.fn(),
      // D9：导入成功后 handler fire-and-forget 调 refreshProviderCatalogs（完成后二次广播），
      // mock 缺失会 TypeError 拖垮 handler 成功分支
      refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [] }),
    } as unknown as SettingsHandlerContext['configService'],
    sessionService: {} as SettingsHandlerContext['sessionService'],
    modelService: {} as SettingsHandlerContext['modelService'],
    skillRegistry: {} as SettingsHandlerContext['skillRegistry'],
    projectRoot: '/tmp/project',
    nextPushId: vi.fn(() => 'push-1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: new ModelConnectionTester(),
  } as unknown as SettingsHandlerContext
}


function msg_m2(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


// ======================================================================
// ← src/services/__tests__/config-service-catalog-overlay.test.ts
// ======================================================================

const GENERATED_AT = (builtinData as { catalogGeneratedAt?: number }).catalogGeneratedAt ?? 0


let dataDir: string


function makeService(opts: { models?: ConfigModelsConfig['providers']; authIds?: string[] } = {}): ConfigService {
  const store = {
    readModels: vi.fn(() => ({ providers: opts.models ?? {} })),
    getEnabledModels: vi.fn(() => []),
  } as unknown as IConfigStore
  const auth = {
    listCredentialIds: vi.fn(() => opts.authIds ?? []),
    hasCredentialSync: vi.fn(() => true),
  } as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>
  // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（同源于上方 auth/store mock）
  const resolver = new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: auth,
    configStore: store,
  })
  return new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
}


function writeOwnCache(entries: unknown): void {
  writeFileSync(join(dataDir, 'provider-catalog-overlay.json'), JSON.stringify({ version: 1, entries }))
}


// ======================================================================
// ← src/services/__tests__/extension-load-dedupe.test.ts
// ======================================================================

// 测试包名必须是非 builtin 包：builtin（mandatory-extensions.json SSOT）中的 infrastructure
// 级（pi-session-reader 等 3 包）不可禁（disabled 记录无效、强加载），「受管版 disabled 占位」
// 语义只适用于 user/feature 级扩展。pi-vision 不在 builtin 清单。
const EXT_NAME = '@zhushanwen/pi-vision'


/** 写一个有效 pi extension 的 package.json（keywords 含 pi-package）。 */
function writeExtensionPkg(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      keywords: ['pi-package'],
      peerDependencies: { 'pi-coding-agent': '^0.82.0' },
    }),
    'utf-8',
  )
}


/** 构造 discovery 目录下的扩展（复刻 ~/.pi/agent/extensions 平铺布局：子目录 = 一个扩展）。 */
function writeDiscoveryExtension(discoveryRoot: string, leafName: string, name: string): string {
  const dir = join(discoveryRoot, leafName)
  writeExtensionPkg(dir, name)
  writeFileSync(join(dir, 'index.ts'), 'export const tools = []\n', 'utf-8')
  return dir
}


function createMockInstaller(): IInstaller {
  return {
    installNpm: vi.fn().mockResolvedValue(undefined),
    uninstallNpm: vi.fn().mockResolvedValue(undefined),
    installDeps: vi.fn().mockResolvedValue({ failed: [] }),
    installGit: vi.fn().mockResolvedValue(undefined),
    getLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
  }
}


interface Fixture {
  service: ExtensionService
  /** npm 安装目录下的扩展路径（settings 源定位） */
  npmPkgDir: string
  /** discovery 物理目录（按 opts.discoveryDirs 下标） */
  discoveryDirs: string[]
  root: string
}


/** 注册的临时根目录，afterEach 统一清理。 */
const registeredRoots: string[] = []


/**
 * 构造 ExtensionService fixture：真实 ExtensionResolver + 真实 tmpdir 文件系统。
 * - settings.json 写入 packages[]（经 setSettingsPath 指向，模拟 settings 源）
 * - npmDir 下构造 node_modules/<pkg>（settings 源定位的 npm 安装版）
 * - discoveryDirs 按下标创建物理目录（getExtensionDirs 返回）
 */
function setup(opts: { discoveryDirs: string[]; packages: string[]; disabled: string[] }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ext-dedupe-'))
  registeredRoots.push(root)
  const settingsDir = join(root, 'settings')
  const npmDir = join(root, 'npm')

  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ packages: opts.packages }), 'utf-8')
  setSettingsPath(join(settingsDir, 'settings.json'))

  const discoveryDirs = opts.discoveryDirs.map((_, i) => join(root, `discovery-${i}`))
  for (const d of discoveryDirs) mkdirSync(d, { recursive: true })

  const npmPkgDir = join(npmDir, 'node_modules', EXT_NAME)
  if (opts.packages.includes(`npm:${EXT_NAME}`)) {
    writeExtensionPkg(npmPkgDir, EXT_NAME)
  }

  const service = new ExtensionService({
    settingsDir,
    projectRoot: root,
    packaged: false,
    installer: createMockInstaller(),
    resolver: new ExtensionResolver({ npmDir, settingsDir }),
    extensionSettings: {
      getPackages: () => opts.packages,
      getDisabled: () => opts.disabled,
      getAutoUpgrade: () => [],
      addPackage: vi.fn().mockResolvedValue(undefined),
      removePackage: vi.fn().mockResolvedValue(undefined),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      setAutoUpgrade: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionSettings,
    configStore: { getExtensionDirs: () => discoveryDirs } as unknown as IConfigStore,
    extensionsDir: join(root, 'extensions'),
    npmDir,
    tmpDir: join(root, 'tmp'),
  })

  return { service, npmPkgDir, discoveryDirs, root }
}


// ======================================================================
// ← src/services/__tests__/llm-retry-config.test.ts
// ======================================================================

const VALID = { enabled: true, maxRetries: 3, baseDelayMs: 2000 }

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-detect-sources', () => {
// ── tests ────────────────────────────────────────────────────

describe('config.detectSources WS round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reply config.sourcesDetected，payload.sources 是数组（含检测项）', async () => {
    const detected: SourceDetectResult[] = [
      { source: 'claude', installed: true, dir: '/h/.claude/skills', skillCount: 2, agentCount: 1 },
      { source: 'codex', installed: false, dir: '/h/.codex/skills' },
      { source: 'pi', installed: true, dir: '/h/.pi/agent/skills', skillCount: 0 },
      { source: 'zcode', installed: false, dir: '/h/.zcode/skills' },
    ]
    const ctx = mockContext(detected)
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(msg('config.detectSources', {}), mockWs())

    expect(handled).toBe(true)
    expect(ctx.configService.detectSources).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(
      mockWs() && expect.anything(),  // ws（不深比对象身份）
      'msg-1',
      'config.sourcesDetected',
      { sources: detected },
    )
  })

  it('无源安装时仍 reply 空数组（不报错）', async () => {
    const detected: SourceDetectResult[] = [
      { source: 'claude', installed: false, dir: '/h/.claude/skills' },
      { source: 'codex', installed: false, dir: '/h/.codex/skills' },
      { source: 'pi', installed: false, dir: '/h/.pi/agent/skills' },
      { source: 'zcode', installed: false, dir: '/h/.zcode/skills' },
    ]
    const ctx = mockContext(detected)
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(msg('config.detectSources', {}), mockWs())

    const replyCall = vi.mocked(ctx.reply).mock.calls[0]
    expect(replyCall[2]).toBe('config.sourcesDetected')
    expect(replyCall[3]).toEqual({ sources: detected })
    expect((replyCall[3] as { sources: unknown[] }).sources).toHaveLength(4)
  })

  it('reply 的 sources 内容与 configService.detectSources 返回值一致', async () => {
    const detected: SourceDetectResult[] = [
      { source: 'claude', installed: true, dir: '/h/.claude/skills', skillCount: 5, agentCount: 3 },
    ]
    const ctx = mockContext(detected)
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(msg('config.detectSources', {}, 'abc-123'), mockWs())

    // reply 第 4 参（payload）与 detectSources 返回值同构
    const payload = vi.mocked(ctx.reply).mock.calls[0][3] as { sources: SourceDetectResult[] }
    expect(payload.sources).toBe(detected)
    // id 透传正确
    expect(vi.mocked(ctx.reply).mock.calls[0][1]).toBe('abc-123')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-provider-import', () => {
// ── tests ────────────────────────────────────────────────────

describe('config.previewImportProviders / config.applyImportProviders WS round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T8: preview {source:pi} → reply config.providersPreviewed，importId 非空 + providers 是数组', async () => {
    const ctx = mockContext_m2()
    const preview: ProviderImportPreview = {
      source: 'pi',
      providers: [
        {
          id: 'deepseek-router',
          name: 'deepseek-router',
          protocol: 'anthropic-messages',
          modelCount: 2,
          apiKeyExtracted: true,
          credentialType: 'plaintext',
          conflict: 'none',
          warnings: [],
        },
      ],
    }
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      importId: 'import-uuid-123',
      preview,
    })
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(msg_m2('config.previewImportProviders', { source: 'pi' }), mockWs_m2())

    expect(handled).toBe(true)
    expect(ctx.configService.previewImportProviders).toHaveBeenCalledWith('pi')
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
      'config.providersPreviewed',
      { importId: 'import-uuid-123', preview },
    )
    // payload 形状断言
    const payload = vi.mocked(ctx.reply).mock.calls[0][3] as { importId: string; preview: ProviderImportPreview }
    expect(payload.importId).toBe('import-uuid-123')
    expect(Array.isArray(payload.preview.providers)).toBe(true)
    expect(payload.preview.providers).toHaveLength(1)
  })

  it('T9: preview 拿 importId → apply → reply config.providersImported + broadcastProviderList', async () => {
    const ctx = mockContext_m2()
    const importId = 'round-trip-import-id'
    const result: ProviderImportResult = {
      source: 'pi',
      imported: [
        { id: 'deepseek-router', name: 'deepseek-router', status: 'imported' },
        { id: 'existing-one', name: 'existing-one', status: 'skipped', reason: 'duplicate' },
      ],
      failedCount: 0,
    }
    // preview 返回 importId（apply 测试复用同一 importId）
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      importId,
      preview: { source: 'pi', providers: [] },
    })
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({ result })
    const handler = new SettingsMessageHandler(ctx)

    // Step1 preview
    await handler.handleSettingsMessage(msg_m2('config.previewImportProviders', { source: 'pi' }, 'preview-id'), mockWs_m2())

    // Step2 apply —— 复用 preview reply 里的 importId
    await handler.handleSettingsMessage(
      msg_m2('config.applyImportProviders', { importId, selectedIds: ['deepseek-router', 'existing-one'] }, 'apply-id'),
      mockWs_m2(),
    )

    // apply reply 断言
    const applyReply = vi.mocked(ctx.reply).mock.calls.find((c) => c[2] === 'config.providersImported')
    expect(applyReply).toBeDefined()
    // vi.mocked().mock.calls.find 返回 T | undefined；tsc 不会因 expect(toBeDefined) 收窄，故用非空断言。
    expect(applyReply![1]).toBe('apply-id')
    expect(applyReply![3]).toEqual({ result })
    // apply 成功 → 广播 provider 列表（让所有 panel 同步新增的 provider）
    // D9 后共 2 次：导入同步广播 1 次 + fire-and-forget refresh 完成后广播 1 次（refresh mock
    // 已 resolve，await 恢复前其 .then 回调已入 microtask 队列先执行）
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(2)
    // apply 传入的参数：importId + selectedIds
    expect(ctx.configService.applyImportProviders).toHaveBeenCalledWith(importId, ['deepseek-router', 'existing-one'])
  })

  it('T8b: preview 返回 error（源未安装）→ reply config.providersPreviewed 含 error 字段，不报错', async () => {
    const ctx = mockContext_m2()
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      error: { code: 'SOURCE_NOT_INSTALLED', message: 'claude not installed' },
    })
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(
      msg_m2('config.previewImportProviders', { source: 'claude' }, 'err-id'),
      mockWs_m2(),
    )

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'err-id',
      'config.providersPreviewed',
      { error: { code: 'SOURCE_NOT_INSTALLED', message: 'claude not installed' } },
    )
    // preview 失败不广播（无副作用）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })

  it('T9b: apply 返回 error（缓存过期）→ reply config.providersImported 含 error，不广播', async () => {
    const ctx = mockContext_m2()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({
      error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' },
    })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(
      msg_m2('config.applyImportProviders', { importId: 'expired-id', selectedIds: ['A'] }, 'apply-err-id'),
      mockWs_m2(),
    )

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'apply-err-id',
      'config.providersImported',
      { error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' } },
    )
    // apply 失败不广播（result 不含 result 字段）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })
})
// ══════════════════════════════════════════════════════════════════
// D9（pi-evolution-consistency-and-project-switcher §3.3）：导入成功后触发
// 远程目录刷新（fire-and-forget）。锁定 handler 层接线：成功路径调
// configService.refreshProviderCatalogs 且完成后二次广播；失败路径零触发；
// refresh reject 不影响导入 reply（不阻塞、不上抛）。
// ══════════════════════════════════════════════════════════════════
describe('D9: applyImportProviders 成功路径触发 refreshProviderCatalogs（fire-and-forget）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function applyMsg(): ClientMessage {
    return msg_m2('config.applyImportProviders', { importId: 'd9-id', selectedIds: ['deepseek-router'] }, 'd9-apply-id')
  }

  const OK_RESULT: ProviderImportResult = {
    source: 'pi',
    imported: [{ id: 'deepseek-router', name: 'deepseek-router', status: 'imported' }],
    failedCount: 0,
  }

  it('apply 成功 → refreshProviderCatalogs 被调用 + refresh 完成后二次广播（overlay 新模型推给前端）', async () => {
    const ctx = mockContext_m2()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({ result: OK_RESULT })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(applyMsg(), mockWs_m2())

    // 成功路径触发 refresh（经 config-service 薄包装，范围=聚合列表内 catalog provider）
    expect(ctx.configService.refreshProviderCatalogs).toHaveBeenCalledTimes(1)
    // 导入同步广播 + refresh 完成广播 = 2 次
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(2)
    // 导入 reply 不被 refresh 阻塞：providersImported 已在 refresh 前正常回给发起端
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'd9-apply-id',
      'config.providersImported',
      { result: OK_RESULT },
    )
  })

  it('apply 失败（缓存过期）→ 不触发 refresh，也不广播', async () => {
    const ctx = mockContext_m2()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({
      error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' },
    })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(applyMsg(), mockWs_m2())

    expect(ctx.configService.refreshProviderCatalogs).not.toHaveBeenCalled()
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })

  it('payload 校验失败（selectedIds 非字符串数组）→ sendError 短路，不触发 refresh', async () => {
    const ctx = mockContext_m2()
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(
      msg_m2('config.applyImportProviders', { importId: 'd9-id', selectedIds: [123] }, 'bad-id'),
      mockWs_m2(),
    )

    expect(handled).toBe(true)
    expect(ctx.sendError).toHaveBeenCalled()
    expect(ctx.configService.applyImportProviders).not.toHaveBeenCalled()
    expect(ctx.configService.refreshProviderCatalogs).not.toHaveBeenCalled()
  })

  it('refresh reject → 仅日志，导入 reply 不受影响，handler 不上抛（fire-and-forget 契约）', async () => {
    const ctx = mockContext_m2()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({ result: OK_RESULT })
    vi.mocked(ctx.configService.refreshProviderCatalogs).mockRejectedValue(new Error('disk full'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = new SettingsMessageHandler(ctx)

    // handler 不因 refresh 失败而上抛（失败不影响导入结果）
    await expect(handler.handleSettingsMessage(applyMsg(), mockWs_m2())).resolves.toBe(true)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'd9-apply-id',
      'config.providersImported',
      { result: OK_RESULT },
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[settings-handler] applyImportProviders: provider catalog refresh failed:'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})
// ══════════════════════════════════════════════════════════════════
// T10 端到端：previewImport('pi') 走真实 parseProviders（不 mock）+ 真实 Pi fixture
// ══════════════════════════════════════════════════════════════════
//
// W2 的 WS round-trip 测试（上方 describe）vi.mock 了 parseProviders，验证的是 handler↔configService
// 的接线，与真实解析逻辑解耦。本测试不 mock parseProviders / provider-parser，
// 把真实 Pi fixture（pi-models.json + pi-auth.json）写到临时 HOME 的 ~/.pi/agent/，
// 调真实的 previewImport('pi')，断言 preview.providers 含真实 Pi provider 数据
// （deepseek-router + zhipu，gemini 被丢弃），而非 W2 Mock 的固定值。
//
// 安全：apiKey 明文绝不进 preview（脱敏红线）。fixture 全用假 key。

describe('T10: previewImport 端到端（真实 parseProviders + 真实 Pi fixture）', () => {
  let prevHome: string | undefined
  let fakeHome: string

  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    prevHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'pi-e2e-'))
    // 写真实 Pi fixture 到 <fakeHome>/.pi/agent/
    const piAgentDir = join(fakeHome, '.pi', 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify(piModelsFixture))
    writeFileSync(join(piAgentDir, 'auth.json'), JSON.stringify(piAuthFixture))
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('previewImport(pi) 返回真实 Pi provider（deepseek-router + zhipu，gemini 丢弃），非 Mock 固定值', () => {
    const out = previewImport('pi')

    // 成功（有 importId）
    expect('importId' in out).toBe(true)
    if (!('importId' in out)) throw new Error('preview should succeed')
    expect(out.importId).toBeTruthy()

    // 真实 Pi fixture：deepseek-router + zhipu（gemini 协议不支持被丢弃）
    expect(out.preview.source).toBe('pi')
    const ids = out.preview.providers.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['deepseek-router', 'zhipu']))
    expect(ids).not.toContain('gemini')
    expect(out.preview.providers).toHaveLength(2)

    // deepseek-router 真实数据（非 W2 Mock 固定值）
    const deepseek = out.preview.providers.find((p) => p.id === 'deepseek-router')!
    expect(deepseek.protocol).toBe('anthropic-messages')
    expect(deepseek.modelCount).toBe(2) // deepseek-chat + deepseek-reasoner
    expect(deepseek.apiKeyExtracted).toBe(true)
    expect(deepseek.conflict).toBe('none')

    // zhipu：auth.json 提取到 key（注意：preview 只暴露 apiKeyExtracted 布尔，不暴露 key 值）
    const zhipu = out.preview.providers.find((p) => p.id === 'zhipu')!
    expect(zhipu.protocol).toBe('openai-completions')
    expect(zhipu.modelCount).toBe(2) // glm-4.6 + glm-4.5-air
    expect(zhipu.apiKeyExtracted).toBe(true)
  })

  it('previewImport 脱敏红线：preview JSON 不含 Pi fixture 的明文 key', () => {
    const out = previewImport('pi')
    const serialized = JSON.stringify(out)

    // 红线：apiKey 明文绝不进 preview 序列化结果
    expect(serialized).not.toContain('sk-fake-deepseek-from-auth')
    expect(serialized).not.toContain('sk-fake-zhipu-from-auth')
    expect(serialized).not.toContain('sk-fake-zhipu-in-models')
  })
})
// ══════════════════════════════════════════════════════════════════
// T11 端到端（sa3 F1）：孤儿凭据 preview 组 2 → apply → 真实 models.json 落盘
// ══════════════════════════════════════════════════════════════════
//
// 完整链路：真实 parsePiProviders（含孤儿凭据扫描）→ previewImport（组 2）→
// applyImport（内置模板补全）→ 真实 upsertProvider 写临时 models.json。
// 验收标准：
//   1. 孤儿凭据（auth.json 有、models.json 无的 openai）→ preview 组 2（builtinTemplateMatched）
//   2. [D1④ 契约变更] credentialWriter 未注入时 catalog 孤儿凭据**不写 models.json**——
//      旧实现用内置模板（tpl.api/tpl.baseUrl = 快照 artifact）+ oc.apiKey 落盘，是 artifact
//      捏造 + M5-01 同族 apiKey 错位写；现返回 failed 并引导用户经 UI 配置凭据
//      （imported 状态语义只对真实落盘成立）。组 1 的非 catalog provider 照常落盘（对照）。
//   3. 脱敏红线：preview 载荷无明文 key；models.json 亦无该明文 key

describe('T11: 孤儿凭据端到端（sa3 F1 · B.3/B.4/B.6）', () => {
  let prevHome: string | undefined
  let prevModelsPath: string | undefined
  let fakeHome: string
  let fakeModelsPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    prevHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'pi-orphan-e2e-'))
    // 写真实 Pi fixture：models.json 只有 zhipu（无 openai）+ auth.json 含 openai 孤儿凭据
    const piAgentDir = join(fakeHome, '.pi', 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify(piModelsFixture))
    writeFileSync(join(piAgentDir, 'auth.json'), JSON.stringify({
      ...piAuthFixture,
      // 孤儿凭据：models.json 未定义的 openai（内置 provider 的 key）
      openai: { type: 'api_key', key: 'sk-orphan-e2e-openai' },
    }))
    process.env.HOME = fakeHome
    // 真实 upsertProvider 写入路径指向临时 models.json（getProviderNames 同源）
    prevModelsPath = getModelsPath()
    fakeModelsPath = join(fakeHome, 'models-target.json')
    setModelsPath(fakeModelsPath)
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevModelsPath !== undefined) setModelsPath(prevModelsPath)
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('孤儿凭据 auth.json → preview 组 2 → catalog 无 credentialWriter → failed，且不写模板 artifact/apiKey 进 models.json（D1④）', async () => {
    const out = previewImport('pi')
    if (!('importId' in out)) throw new Error('preview should succeed')

    // 组 2：孤儿凭据 openai 匹配内置模板
    expect(out.preview.orphanCredentials).toHaveLength(1)
    const item = out.preview.orphanCredentials![0]
    expect(item.providerId).toBe('openai')
    expect(item.builtinTemplateMatched).toBe(true)
    expect(item.name).toBe('OpenAI')
    expect(item.credentialType).toBe('plaintext')
    expect(item.apiKeyExtracted).toBe(true)
    // 脱敏红线：组 2 载荷不含明文 key
    expect(JSON.stringify(out)).not.toContain('sk-orphan-e2e-openai')

    // apply：组 1（zhipu/deepseek-router）+ 组 2（openai）一起导入
    const applyOut = await applyImport(out.importId, ['zhipu', 'deepseek-router', 'openai'])
    if (!('result' in applyOut)) throw new Error('apply should succeed')

    // 设计 D1④：catalog provider 定义来自 pi 内置 catalog、凭据只允许落 auth.json（0600）
    // ——credentialWriter 未注入时无处安放，宁丢不写错位：不再有「写模板进 models.json」的
    // 降级（tpl.api/tpl.baseUrl 是快照 artifact，oc.apiKey 落 models.json 是 M5-01 同族错位写），
    // 返回 failed 并给出可操作的指引（经 UI 配置凭据）。
    const openaiResult = applyOut.result.imported.find((i) => i.id === 'openai')!
    expect(openaiResult.status).toBe('failed')
    expect(openaiResult.reason).toContain('credential writer')

    // 真实 models.json 落盘验证：catalog 孤儿凭据不产生任何条目（无 artifact、无 apiKey 错位写）
    const raw = readFileSync(fakeModelsPath, 'utf8')
    const written = JSON.parse(raw)
    expect(written.providers.openai).toBeUndefined()
    // 明文 key 绝不进 models.json（与 auth.json 凭据归属一致）
    expect(raw).not.toContain('sk-orphan-e2e-openai')

    // 组 1 非 catalog provider 不受影响：照常落盘（对照，证明 failed 只针对 catalog 降级分支）
    expect(written.providers.zhipu).toBeDefined()
    expect(written.providers['deepseek-router']).toBeDefined()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-service-catalog-overlay', () => {
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'overlay-integration-'))
  mkdirSync(join(dataDir, 'agent'), { recursive: true })
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('catalog 聚合 ⊕ 远程 overlay', () => {
  it('overlay 新 id 追加到快照模型之后（glm-5.3 场景）', () => {
    writeOwnCache({
      zai: {
        models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
        checkedAt: 1,
        lastModified: GENERATED_AT + 1000,
      },
    })
    const svc = makeService({ authIds: ['zai'] })
    const zai = svc.listProviders().find(p => p.id === 'zai')
    expect(zai).toBeDefined()
    const ids = zai!.models.map(m => m.id)
    expect(ids).toContain('glm-5.3')
    // 快照打底模型仍在（overlay 只追加/覆盖，不替换整个列表）
    expect(ids).toContain('glm-5.2')
  })

  it('overlay 同 id 覆盖快照版本（contextWindow 取 overlay 值）', () => {
    writeOwnCache({
      zai: {
        models: [{ id: 'glm-5.2', name: 'GLM-5.2 (remote)', contextWindow: 999999 }],
        checkedAt: 1,
        lastModified: GENERATED_AT + 1000,
      },
    })
    const svc = makeService({ authIds: ['zai'] })
    const zai = svc.listProviders().find(p => p.id === 'zai')!
    const m = zai.models.find(x => x.id === 'glm-5.2')
    expect(m?.name).toBe('GLM-5.2 (remote)')
    expect(m?.contextWindow).toBe(999999)
    // 同 id 覆盖后仍标 builtin 源（合并点在 builtin 集合内部，override 边界不变）
    expect(zai.models.find(x => x.id === 'glm-5.2')?.source).toBe('builtin')
  })

  it('override 用户定义最高优先：override 同 id 模型不被 overlay 改写', () => {
    writeOwnCache({
      zai: {
        models: [{ id: 'glm-5.2', name: 'GLM-5.2 (remote)', contextWindow: 999999 }],
        checkedAt: 1,
        lastModified: GENERATED_AT + 1000,
      },
    })
    const svc = makeService({
      authIds: ['zai'],
      models: { zai: { apiKey: 'k', models: [{ id: 'glm-5.2', name: 'my-override' }] } },
    })
    const zai = svc.listProviders().find(p => p.id === 'zai')!
    const m = zai.models.find(x => x.id === 'glm-5.2')
    expect(m?.name).toBe('my-override')
    expect(m?.source).toBe('override')
  })

  it('stale overlay（lastModified <= catalogGeneratedAt）不影响列表', () => {
    writeOwnCache({
      zai: {
        models: [{ id: 'glm-future', name: 'STALE' }],
        checkedAt: 1,
        lastModified: GENERATED_AT,
      },
    })
    const svc = makeService({ authIds: ['zai'] })
    const zai = svc.listProviders().find(p => p.id === 'zai')!
    expect(zai.models.map(m => m.id)).not.toContain('glm-future')
  })

  it('无 overlay 文件（离线/首次）→ 列表与纯快照一致', () => {
    const svc = makeService({ authIds: ['zai'] })
    const zai = svc.listProviders().find(p => p.id === 'zai')!
    expect(zai.models.length).toBeGreaterThan(0)
    expect(zai.models.map(m => m.id)).not.toContain('glm-future')
  })
})
});
// ======================================================================
// ← src/services/__tests__/config-service-providers.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-service-providers', () => {
// ════════════════ 来源: config-service-listproviders.test.ts ════════════════
describe('config-service-listproviders', () => {
  /**
   * listProviders 双源聚合测试（wave2，provider-dual-system-r2::list-providers-aggregate）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-listproviders.test.ts
   *
   * 策略：不 mock provider-catalog（用真实 builtin-providers.json + 真实 deriveEnabled），
   * mock configStore（readModels + getEnabledModels）+ authStorage（listCredentialIds +
   * hasCredentialSync）。覆盖 design TC1-TC5/TC7（聚合 / kind / enabled 派生 / override /
   * apiKeySet / 兼容）。TC6（findValidDefaultModel catalog 兜底过滤）见
   * pi-provider-store-finddefault.test.ts。
   */

  /** ConfigService 构造函数期望的 authStorage Pick（全方法，mock 只实现被调用的）。 */
  type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

  interface MakeOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    /** models.json providers（默认空）。 */
    models?: ConfigModelsConfig['providers']
    /** settings.json.enabledModels（默认空 = 全启用，DM3）。 */
    enabledModels?: string[]
    /** auth.json 顶层 providerId 列表（catalog 凭据源）。 */
    authIds?: string[]
    /** authStorage.hasCredentialSync 的判定函数（custom status 派生用）。 */
    hasCredential?: (id: string) => boolean
  }

  /** 构造 ConfigService + mock store/auth，返回 svc 供断言。 */
  function makeService(opts: MakeOpts = {}): ConfigService {
    const {
      models = {},
      enabledModels = [],
      authIds = [],
      hasCredential = () => false,
    } = opts
    const store = {
      readModels: vi.fn(() => ({ providers: models })),
      getEnabledModels: vi.fn(() => enabledModels),
    } as unknown as IConfigStore
    const auth = {
      listCredentialIds: vi.fn(() => authIds),
      hasCredentialSync: vi.fn((id: string) => hasCredential(id)),
    } as unknown as FullAuthPick
    // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（auth.json ∪ models.json），
    // 与旧内联判定（auth.json 集合）同源于上方 auth/store mock。
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth,
      configStore: store,
    })
    return new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
  }

  /** listProviders 结果按 id 索引，便于断言。 */
  function byId(svc: ConfigService): Record<string, ReturnType<ConfigService['listProviders']>[number]> {
    return Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
  }

  describe('TC1: listProviders 双源聚合——catalog 凭据在 auth.json 时也显示（F1 修复核心）', () => {
    it('models.json 只有 custom，auth.json 有 catalog 凭据 → 两者都出现', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', models: [{ id: 'm1' }] } },
        authIds: ['openai'],
      })
      const ids = svc.listProviders().map(p => p.id)
      expect(ids).toContain('my-custom')
      expect(ids).toContain('openai')
    })

    it('catalog 凭据在 auth.json 但 models.json 完全无该条目（F1 根因场景）', () => {
      const svc = makeService({ authIds: ['openai'] })
      const ids = svc.listProviders().map(p => p.id)
      expect(ids).toContain('openai')
      expect(ids).not.toContain('my-custom')
    })
  })

  describe('TC2: kind 标注——custom/catalog 分类', () => {
    it('混合 providers：custom（models.json ∉ builtin）+ catalog（auth.json ∩ builtin）', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', models: [] } },
        authIds: ['openai', 'anthropic'],
      })
      const m = byId(svc)
      expect(m['my-custom'].kind).toBe('custom')
      expect(m['openai'].kind).toBe('catalog')
      expect(m['anthropic'].kind).toBe('catalog')
    })
  })

  describe('TC3: deriveEnabled 算法（DM3）', () => {
    it('enabledModels 空/undefined → 全启用（pi 白名单语义）', () => {
      expect(deriveEnabled('openai', [])).toBe(true)
      expect(deriveEnabled('openai', undefined)).toBe(true)
    })

    it('enabledModels 非空 → 白名单匹配（<id>/* 或 <id>/model）', () => {
      expect(deriveEnabled('openai', ['openai/*'])).toBe(true)
      expect(deriveEnabled('openai', ['openai/gpt-4'])).toBe(true)
      expect(deriveEnabled('anthropic', ['openai/*'])).toBe(false)
    })

    it('startsWith 带斜杠防前缀碰撞：openai/* 不匹配 openai-compatible', () => {
      expect(deriveEnabled('openai-compatible', ['openai/*'])).toBe(false)
      expect(deriveEnabled('openai-compatible', ['openai-compatible/*'])).toBe(true)
    })

    it('经 listProviders 体现：enabledModels=["openai/*"] 时 openai→true, anthropic→false', () => {
      const svc = makeService({ enabledModels: ['openai/*'], authIds: ['openai', 'anthropic'] })
      const m = byId(svc)
      expect(m['openai'].enabled).toBe(true)
      expect(m['anthropic'].enabled).toBe(false)
    })
  })

  describe('TC4: catalog override——hasOverride + 字段优先取 override', () => {
    it('catalog provider 在 models.json 有 override → hasOverride=true + override 字段优先', () => {
      const svc = makeService({
        models: { openai: { name: 'My OpenAI', baseUrl: 'https://my.proxy' } },
      })
      const openai = byId(svc)['openai']
      expect(openai.kind).toBe('catalog')
      expect(openai.hasOverride).toBe(true)
      expect(openai.name).toBe('My OpenAI')
      expect(openai.baseUrl).toBe('https://my.proxy')
    })

    it('catalog provider 无 override（仅 auth.json 凭据）→ hasOverride=false + 用 builtin 副本', () => {
      const svc = makeService({ authIds: ['openai'] })
      const openai = byId(svc)['openai']
      expect(openai.hasOverride).toBe(false)
      // builtin openai 有 models（37 provider 之一），兜底非空
      expect(openai.models.length).toBeGreaterThan(0)
    })
  })

  describe('headers/authHeader 读侧回显——装配下发（幽灵数据修复）', () => {
    // 事故背景：装配函数漏带这两个字段，models.json 已存的 headers 成「界面看不见、
    // 保存「空=不动」语义又删不掉」的幽灵数据（空值 x-opencode-session 压制 pi 自动注入）
    it('catalog override 带 headers/authHeader → ProviderInfo 原值下发', () => {
      const svc = makeService({
        models: { openai: { headers: { 'x-flag': 'v1' }, authHeader: true } },
      })
      const openai = byId(svc)['openai']
      expect(openai.kind).toBe('catalog')
      expect(openai.headers).toEqual({ 'x-flag': 'v1' })
      expect(openai.authHeader).toBe(true)
    })

    it('custom config 带 headers/authHeader → ProviderInfo 原值下发', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', headers: { trace: 'on' }, authHeader: false, models: [] } },
      })
      const custom = byId(svc)['my-custom']
      expect(custom.kind).toBe('custom')
      expect(custom.headers).toEqual({ trace: 'on' })
      expect(custom.authHeader).toBe(false)
    })

    it('未配置 → headers/authHeader 缺省 undefined', () => {
      const svc = makeService({ models: { openai: {} } })
      const openai = byId(svc)['openai']
      expect(openai.headers).toBeUndefined()
      expect(openai.authHeader).toBeUndefined()
    })
  })

  // ── W2 重构特征锚定补充（listProviders 提取 helper 后的分支缺口）──

  describe('TC5 补充: catalog apiKeySet 双源判定——override.apiKey（models.json 手填 key 旧数据）', () => {
    it('auth.json 无凭据但 override.apiKey 非空 → apiKeySet=true + status=connected', () => {
      const svc = makeService({
        models: { openai: { apiKey: 'sk-manual', models: [{ id: 'gpt-x' }] } },
        authIds: [],
      })
      const openai = byId(svc)['openai']
      expect(openai.kind).toBe('catalog')
      expect(openai.apiKeySet).toBe(true)
      expect(openai.status).toBe('connected')
    })

    it('catalog 无 override 且 auth.json 无凭据 → apiKeySet=false + status=not_configured', () => {
      const svc = makeService({
        models: { openai: { name: 'Renamed OpenAI' } },
        authIds: [],
      })
      const openai = byId(svc)['openai']
      expect(openai.apiKeySet).toBe(false)
      expect(openai.status).toBe('not_configured')
      // override 只改 name：name 覆盖生效、hasOverride=true
      expect(openai.name).toBe('Renamed OpenAI')
      expect(openai.hasOverride).toBe(true)
    })

    it('catalog 无 override → name 回退 builtinP.name（非 id）', () => {
      const svc = makeService({ authIds: ['anthropic'] })
      const anthropic = byId(svc)['anthropic']
      expect(anthropic.hasOverride).toBe(false)
      // builtin anthropic 模板 name 非空且不等于 id
      expect(anthropic.name).toBeTruthy()
      expect(anthropic.name).not.toBe('anthropic')
    })
  })

  describe('TC5: apiKeySet 派生——catalog 来自 auth.json，custom 来自 models.json', () => {
    it('catalog 凭据在 auth.json（models.json 无 apiKey）→ apiKeySet=true', () => {
      const svc = makeService({ authIds: ['openai'] })
      expect(byId(svc)['openai'].apiKeySet).toBe(true)
    })

    it('custom provider apiKeySet 来自 models.json apiKey', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-c', models: [{ id: 'm1' }] } },
      })
      expect(byId(svc)['my-custom'].apiKeySet).toBe(true)
    })

    it('custom provider 无 apiKey → apiKeySet=false', () => {
      const svc = makeService({
        models: { 'my-custom': { models: [{ id: 'm1' }] } },
      })
      expect(byId(svc)['my-custom'].apiKeySet).toBe(false)
    })
  })

  describe('TC7: custom provider 行为兼容（apiKeySet/status/models 兜底，与旧实现一致）', () => {
    it('custom 有 apiKey → apiKeySet=true, status=connected', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', models: [{ id: 'm1' }] } },
      })
      const p = byId(svc)['my-custom']
      expect(p.apiKeySet).toBe(true)
      expect(p.status).toBe('connected')
      expect(p.kind).toBe('custom')
    })

    it('custom 无 apiKey 但 auth.json 有凭据 → status=connected（沿用旧 M6 逻辑）', () => {
      const svc = makeService({
        models: { 'my-custom': { models: [{ id: 'm1' }] } },
        // B3：custom status 改用 authIdSet（listCredentialIds 批量读），不再逐个 hasCredentialSync
        authIds: ['my-custom'],
        hasCredential: id => id === 'my-custom',
      })
      const p = byId(svc)['my-custom']
      expect(p.apiKeySet).toBe(false)
      expect(p.status).toBe('connected')
    })

    it('custom 无 apiKey 无凭据 → status=not_configured', () => {
      const svc = makeService({
        models: { 'my-custom': { models: [{ id: 'm1' }] } },
      })
      expect(byId(svc)['my-custom'].status).toBe('not_configured')
    })

    it('custom 空 models（非 builtin id）→ models 兜底为空数组', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', models: [] } },
      })
      expect(byId(svc)['my-custom'].models).toEqual([])
    })
  })

  describe('B-4b 读侧：model 级 headers 经 ProviderInfo.models 透传（读写对称）', () => {
    it('custom provider 模型带 headers → listProviders 输出含 headers', () => {
      const svc = makeService({
        models: {
          'my-custom': {
            apiKey: 'sk-x',
            models: [{ id: 'm1', name: 'M1', headers: { 'X-Model': 'v1' } }],
          },
        },
      })
      const model = byId(svc)['my-custom'].models.find(m => m.id === 'm1')
      expect(model?.headers).toEqual({ 'X-Model': 'v1' })
    })

    it('catalog override 模型带 headers → override 条目同样透传', () => {
      const svc = makeService({
        models: {
          openai: {
            models: [{ id: 'gpt-4o', name: 'GPT-4o', headers: { 'X-Ovr': 'y' } }],
          },
        },
      })
      const ovr = byId(svc)['openai'].models.find(m => m.id === 'gpt-4o')
      expect(ovr?.headers).toEqual({ 'X-Ovr': 'y' })
      expect(ovr?.source).toBe('override')
    })

    it('无 headers 的模型 → 字段缺省（行为兼容，不带 headers 键语义不变）', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] } },
      })
      const model = byId(svc)['my-custom'].models.find(m => m.id === 'm1')
      expect(model?.headers).toBeUndefined()
    })
  })
});
// ════════════════ 来源: config-service-model-source.test.ts ════════════════
describe('config-service-model-source', () => {
  /**
   * B-2 聚合层 source 标注测试（provider-config-quota-architecture design §3.6 决策 2 /
   * Phase B-2「聚合层配合」）。
   *
   * catalog provider 的混合模型列表（builtin 副本未被覆盖的 + models.json override）逐条标注
   * source：'builtin' | 'override'。custom provider 全部是用户定义，不标（undefined）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-model-source.test.ts
   *
   * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
   * 与 provider-read-source-switch.test.ts 同模式。zai-coding-cn 是真实 builtin catalog
   * provider（builtin 副本含 glm-4.5-air/glm-4.7/glm-5-turbo/glm-5.1/glm-5.2/glm-5v-turbo），
   * 同 id 替换用例用真实存在的 glm-5.2，新增 id 用例用 glm-my-alias。
   */

  let dir: string
  let agentDir: string
  let configStore: PiConfigStore

  function writeModelsJson(providers: Record<string, unknown>): void {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
  }

  function makeSvc(authIds: string[] = []): ConfigService {
    const auth = authIds.length > 0
      ? { listCredentialIds: () => authIds, hasCredentialSync: () => true } as never
      : undefined
    // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（真 PiConfigStore 读同一 models.json）
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth ?? { listCredentialIds: () => [] as string[], hasCredentialSync: () => false },
      configStore,
    })
    return new ConfigService('/tmp/project', configStore, auth, undefined, undefined, resolver)
  }

  function providerModels(svc: ConfigService, id: string): ReturnType<ConfigService['listProviders']>[number]['models'] {
    const p = svc.listProviders().find(x => x.id === id)
    expect(p).toBeDefined()
    return p!.models
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-service-model-source-'))
    agentDir = join(dir, 'agent')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
    configStore = new PiConfigStore()
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('B-2：catalog provider 无 override → 全部标 source:"builtin"', () => {
    it('凭据在 auth.json、models.json 无条目 → builtin 副本逐条 builtin 标注', () => {
      writeModelsJson({})
      const models = providerModels(makeSvc(['zai-coding-cn']), 'zai-coding-cn')

      expect(models.length).toBeGreaterThan(0)
      for (const m of models) {
        expect(m.source).toBe('builtin')
      }
      // 真实 builtin 副本非空（防御生成物损坏导致的假通过；清单锚 pi-ai 1.0.0 快照）
      expect(models.map(m => m.id)).toContain('glm-5.3')
    })
  })

  describe('B-2：catalog provider 有 override models → 混合列表逐条标注', () => {
    it('新增 id + 同 id 替换：override 条目（含覆盖 builtin 同 id 的）标 override，其余标 builtin，同 id 不重复', () => {
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          models: [
            // 同 id 替换 builtin 的 glm-5.3（用户覆写 contextWindow）
            { id: 'glm-5.3', name: 'GLM 5.3 (custom)', contextWindow: 111000 },
            // 新增自定义模型（builtin 无此 id）
            { id: 'glm-my-alias', name: 'My Alias', contextWindow: 200000 },
          ],
        },
      })

      const models = providerModels(makeSvc(), 'zai-coding-cn')
      const bySource = (s: 'builtin' | 'override') => models.filter(m => m.source === s).map(m => m.id)

      // override 两条均标 'override'——同 id 被 override 替换的也标 'override'（已被用户定义覆盖）
      expect(bySource('override')).toEqual(['glm-5.3', 'glm-my-alias'])
      // 其余 builtin 条目标 'builtin'（混合列表：override 存在时未被覆盖的内置条目仍在，
      // 对齐 pi 真实行为 design D1 探针——旧「override 非空即整体替换」与 pi 漂移）
      expect(bySource('builtin')).not.toContain('glm-5.3')
      expect(bySource('builtin')).toContain('glm-4.6v')
      expect(bySource('builtin')).toContain('glm-5.3-flash')
      // 同 id 不重复出现（覆盖而非并列）
      expect(models.filter(m => m.id === 'glm-5.3')).toHaveLength(1)
      // 覆盖条目取 override 定义值
      const overridden = models.find(m => m.id === 'glm-5.3')!
      expect(overridden.name).toBe('GLM 5.3 (custom)')
      expect(overridden.contextWindow).toBe(111000)
      // 混合列表顺序：builtin 在前、override 追加在后（design §3.1 场景 A 形态）
      const lastSource = models[models.length - 1].source
      expect(lastSource).toBe('override')
    })

    it('override 空数组（models: []）→ 退回纯 builtin 列表全标 builtin', () => {
      writeModelsJson({
        'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: [] },
      })

      const models = providerModels(makeSvc(), 'zai-coding-cn')
      expect(models.length).toBeGreaterThan(0)
      for (const m of models) {
        expect(m.source).toBe('builtin')
      }
    })
  })

  describe('B-2：custom provider → 不标 source（全部用户定义，无歧义）', () => {
    it('custom provider 的 models 元素 source 为 undefined', () => {
      writeModelsJson({
        'my-proxy': { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }, { id: 'm2' }] },
      })

      const models = providerModels(makeSvc(), 'my-proxy')
      expect(models.map(m => m.id)).toEqual(['m1', 'm2'])
      for (const m of models) {
        expect(m.source).toBeUndefined()
      }
    })
  })
});
// ════════════════ 来源: config-service-removebykind.test.ts ════════════════
describe('config-service-removebykind', () => {
  /**
   * removeProviderByKind 测试（wave4，provider-dual-system-r2::provider-ui-by-kind IF3）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-removebykind.test.ts
   *
   * 覆盖 design TC2/TC3 + 边界3(a)：
   *   - TC2 catalog 分支：清 auth.json 凭据 + 清 models.json override（removeProvider）+ 清 enabledModels 残留。
   *     不删 pi catalog 定义（本测试只验证 taiji 侧清理动作，pi 定义不可触达故不断言）。
   *   - TC3 custom 分支：删 models.json 条目（removeProvider）+ 清残留。
   *   - 边界3(a) 残留清除空数组检查：清完残留后白名单空 → cleanEnabledModelsResidue 调 clearEnabledModels（非 setEnabledModels([])）。
   *
   * 策略：mock IConfigStore（写方法 vi.fn 断言路由）+ mock authStorage.remove 断言清凭据调用。
   * makeStore 借鉴 config-service-toggle.test.ts 的状态化 mock 模式，但本测试聚焦「调用路由」
   * 而非 read-after-write，故 store 用最小 mock（getEnabledModels 返固定白名单即可）。
   */

  type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

  interface StoreOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    /** models.json providers（默认空）。 */
    models?: ConfigModelsConfig['providers']
    /** settings.json.enabledModels（默认空 = 全启用）。 */
    enabledModels?: string[]
  }

  /**
   * 最小 mock IConfigStore：写方法 vi.fn 供断言路由，读方法返固定值。
   * removeProvider 返回 removed:true（catalog override 存在时；custom 删除时）。
   */
  function makeStore(opts: StoreOpts = {}) {
    const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
    return {
      readModels: vi.fn(() => ({ providers: models })),
      getEnabledModels: vi.fn(() => [...(opts.enabledModels ?? [])]),
      getDefaultModel: vi.fn(() => null),
      getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
      setEnabledModels: vi.fn(),
      clearEnabledModels: vi.fn(),
      setDefaultModel: vi.fn(),
      ensureProviderInWhitelist: vi.fn(),
      cleanEnabledModelsResidue: vi.fn(),
      upsertProvider: vi.fn(),
      applyTypeTranslation: vi.fn((t: string) => t),
      removeProvider: vi.fn(() => ({ removed: true })),
    } as unknown as IConfigStore & {
      setEnabledModels: ReturnType<typeof vi.fn>
      clearEnabledModels: ReturnType<typeof vi.fn>
      cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
      removeProvider: ReturnType<typeof vi.fn>
    }
  }

  function makeAuth(): FullAuthPick {
    return {
      listCredentialIds: vi.fn(() => []),
      hasCredentialSync: vi.fn(() => false),
      remove: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      hasOAuth: vi.fn(() => false),
      hasOAuthSync: vi.fn(() => false),
    } as unknown as FullAuthPick
  }

  function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore>; auth: FullAuthPick } {
    const store = makeStore(opts)
    const auth = makeAuth()
    // M2fg 恒注入形态：凭据判定（含 M5-03 重选凭据优先）经 resolver 批量 sync 版，
    // 同源于上方 store/auth mock
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth,
      configStore: store,
    })
    const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
    return { svc, store, auth }
  }

  // ══ TC2: catalog 分支——清 auth.json 凭据 + 清 override + 清残留 ═══════════════════════

  describe('TC2: removeProviderByKind(catalog) 清 auth.json 凭据 + override + enabledModels 残留', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('调 authStorage.remove（清 catalog 凭据）', async () => {
      const { svc, auth } = makeService({ enabledModels: ['openai/*'] })
      await svc.removeProviderByKind('openai', 'catalog')
      expect(auth.remove).toHaveBeenCalledWith('openai')
    })

    it('调 configStore.removeProvider（清 models.json override 条目，若有）', async () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      await svc.removeProviderByKind('openai', 'catalog')
      expect(store.removeProvider).toHaveBeenCalledWith('openai')
    })

    it('调 configStore.cleanEnabledModelsResidue（清 enabledModels 残留 <id>/* 与 <id>/model）', async () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
      await svc.removeProviderByKind('openai', 'catalog')
      expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
    })

    it('返回 removed:true（catalog 定义不可删，用户侧状态已清即视为移除成功）', async () => {
      const { svc } = makeService({ enabledModels: ['openai/*'] })
      const ret = await svc.removeProviderByKind('openai', 'catalog')
      expect(ret).toEqual({ removed: true })
    })

    it('MF1（exec-review must-fix）：catalog override 承载 default 时透传 removeProvider 的 newDefault', async () => {
      // 场景：catalog provider openai 有 override 且承载 defaultModel，removeProvider 删 override 时
      // 内部重选 default（anthropic/claude-3）+ mutate settings.json。catalog 分支须透传 newDefault，
      // 否则 handler 不广播 config.defaults → renderer 收不到重选通知（confirmDelete 防御性清空仅缓解显示）。
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        removed: true,
        newDefault: { provider: 'anthropic', modelId: 'claude-3' },
      })
      const ret = await svc.removeProviderByKind('openai', 'catalog')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'anthropic', modelId: 'claude-3' } })
    })

    it('authStorage.remove 失败（reject）不阻塞移除主流程（cleanAuthCredential try-catch warn）', async () => {
      const { svc, store, auth } = makeService({ enabledModels: ['openai/*'] })
      ;(auth.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))
      // await 完成：cleanAuthCredential try-catch 吞掉凭据清理异常，删除主流程不阻断
      const ret = await svc.removeProviderByKind('openai', 'catalog')
      expect(ret).toEqual({ removed: true })
      expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
    })

    it('回归：catalog 删除 await 凭据清理完成，返回后 listProviders 即不含该 provider（修复广播 stale）', async () => {
      // 模拟真实 AuthStorage.remove 的异步性：withFileLock（proper-lockfile）获锁有延迟，
      // fire-and-forget 时凭据未即时落盘。本测试构造带延迟的 remove，验证 removeProviderByKind
      // await 其完成才返回 → 返回后 listProviders 立即反映凭据已清（广播拿到的就是干净列表）。
      const credentialIds = new Set<string>(['openai'])
      const auth = {
        listCredentialIds: vi.fn(() => [...credentialIds]),
        hasCredentialSync: vi.fn((id: string) => credentialIds.has(id)),
        remove: vi.fn(async (id: string) => {
          await new Promise(r => setTimeout(r, 5))
          credentialIds.delete(id)
        }),
        set: vi.fn().mockResolvedValue(undefined),
        hasOAuth: vi.fn(() => false),
        hasOAuthSync: vi.fn(() => false),
      } as unknown as FullAuthPick
      const store = makeStore({})
      // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（同源于本用例 auth mock——
      // remove 后 listCredentialIds 返回的集合随之变化，resolver 读同一 mock）
      const resolver = new ProviderCredentialResolver({
        authService: { getCredential: async () => undefined },
        authStorage: auth,
        configStore: store,
      })
      const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)

      // 删除前：openai 凭据在 auth.json → listProviders catalog 聚合显示
      expect(svc.listProviders().some(p => p.id === 'openai')).toBe(true)

      await svc.removeProviderByKind('openai', 'catalog')

      // 关键回归断言：await 返回时凭据已清，listProviders 不再显示 openai。
      // 若改回 fire-and-forget，此断言失败（凭据 5ms 后才删，返回后立即查仍在）。
      expect(svc.listProviders().some(p => p.id === 'openai')).toBe(false)
    })

    it('M5-03：catalog 无 override（removeProvider 返回 removed:false）且 default 承载该 provider → 显式重选并持久化', async () => {
      // 场景：catalog provider openai 无 models.json override（导入后常态形态），但 settings.json
      // default 承载它。removeProvider 提前 return {removed:false} 跳过默认清理（旧实现残留
      // 指向无凭据 provider 的 default）。修复：显式 pickEnabledDefaultModel 重选
      // + setDefaultModel 持久化 + 透传 newDefault 供广播。
      // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，重选结果随
      // builtin 目录漂移——custom 候选集固定为 mock 的 models，聚焦重选触发本身）。
      const { svc, store } = makeService({
        models: { 'other-llm': { models: [{ id: 'their-m' }] } },
        enabledModels: ['openai/*', 'other-llm/*'],
      })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'openai', modelId: 'gpt-4' })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'other-llm', modelId: 'their-m' } })
    })

    it('M5-03：catalog 无 override + default 承载该 provider + 无其他启用 provider → 不重选（无候选）', async () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'openai', modelId: 'gpt-4' })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      expect(store.setDefaultModel).not.toHaveBeenCalled()
      expect(ret).toEqual({ removed: true })
    })

    it('M5-03：catalog 无 override 且 default 不承载该 provider → 不重选', async () => {
      const { svc, store } = makeService({
        models: { anthropic: { models: [{ id: 'claude-3' }] } },
        enabledModels: ['anthropic/*'],
      })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'anthropic', modelId: 'claude-3' })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      expect(store.setDefaultModel).not.toHaveBeenCalled()
      expect(ret).toEqual({ removed: true })
    })

    it('MF-2：cleanEnabledModelsResidue 改白名单后 getDefaultModel auto-fix 不应跳过重选（预读修复）', async () => {
      // 复现生产缺陷：PiConfigStore.getDefaultModel 内部 findValidDefaultModel 在白名单变更后
      // auto-fix 重选。旧实现在 cleanEnabledModelsResidue（白名单变更）之后才读 default，
      // oldDefault.provider 已被 auto-fix 成别的 provider，oldDefault.provider === providerId
      // 恒 false，M5-03 显式 B1 凭据优先重选不可达。
      // 状态化 mock：getDefaultModel 在 cleanEnabledModelsResidue 前返 openai（真旧 default），
      // 之后返 other-llm（auto-fix 重选值）。修复（预读）后 getDefaultModel 在 clean 前被调用 →
      // oldDefault=openai，重选触发。旧实现该断言失败（setDefaultModel 未调用）。
      // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，重选结果随
      // builtin 目录漂移——custom 候选集固定为 mock 的 models）。
      const { svc, store } = makeService({
        models: { 'other-llm': { models: [{ id: 'their-m' }] } },
        enabledModels: ['openai/*', 'other-llm/*'],
      })
      let cleanCalled = false
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockImplementation(() =>
        cleanCalled ? { provider: 'other-llm', modelId: 'their-m' } : { provider: 'openai', modelId: 'gpt-4' },
      )
      ;(store.cleanEnabledModelsResidue as ReturnType<typeof vi.fn>).mockImplementation(() => { cleanCalled = true })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      // 修复后：预读 oldDefault=openai（clean 前），重选触发，setDefaultModel 被调
      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'other-llm', modelId: 'their-m' } })
    })

    // [2026-09 测试舰队审查 r2-24] MF-3（M5-03 路径）用例已删：与 config-service-toggle.test.ts
    // MF-3（M5-02 路径）同测 pickEnabledDefaultModel 跳过禁用 model，二留一保留 toggle 版
    // （其状态化 mock 更接近生产路径）。
  })

  // ══ TC3: custom 分支——删 models.json 条目 + 清残留 ═══════════════════════════════════

  describe('TC3: removeProviderByKind(custom) 删 models.json 条目 + 清 enabledModels 残留', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('调 configStore.removeProvider（删 custom 定义条目）', async () => {
      const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
      await svc.removeProviderByKind('my-custom', 'custom')
      expect(store.removeProvider).toHaveBeenCalledWith('my-custom')
    })

    it('调 configStore.cleanEnabledModelsResidue（清残留）', async () => {
      const { svc, store } = makeService({ enabledModels: ['my-custom/*', 'openai/*'] })
      await svc.removeProviderByKind('my-custom', 'custom')
      expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('my-custom')
    })

    it('不调 authStorage.remove（custom 凭据在 models.json，删条目即清，不走 auth.json）', async () => {
      const { svc, auth } = makeService({ enabledModels: ['my-custom/*'] })
      await svc.removeProviderByKind('my-custom', 'custom')
      expect(auth.remove).not.toHaveBeenCalled()
    })

    it('透传 removeProvider 返回值（含 default 重选 newDefault）', async () => {
      const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        removed: true,
        newDefault: { provider: 'openai', modelId: 'gpt-4' },
      })
      const ret = await svc.removeProviderByKind('my-custom', 'custom')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'openai', modelId: 'gpt-4' } })
    })
  })

  // ══ 边界3(a): cleanEnabledModelsResidue 空数组检查（pi-provider-store 层） ════════════
  // 注：removeProviderByKind 调 configStore.cleanEnabledModelsResidue（port），实际检查逻辑
  // 在 pi-provider-store.cleanEnabledModelsResidue。此用例直接测 pi-provider-store 导出函数，
  // 验证「重算空 → clearEnabledModels（delete 字段，非 setEnabledModels([])）」的边界3(a) 检查。


  describe('边界3(a): cleanEnabledModelsResidue 重算空 → clearEnabledModels（delete 字段，CL2）', () => {
    let dir: string
    let agentDir: string

    beforeEach(() => {
      vi.clearAllMocks()
      dir = mkdtempSync(join(tmpdir(), 'clean-residue-'))
      agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      process.env.TAIJI_AGENT_DATA_DIR = dir
    })

    afterEach(() => {
      delete process.env.TAIJI_AGENT_DATA_DIR
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('多 pattern 移除后非空 → setEnabledModels(remaining)；再清至空 → delete enabledModels 字段', async () => {
      // 动态 import：测试体内拿函数引用，确保 setModelsPath/setSettingsPath 已指向临时目录后再调用
      const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
      const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()

      // 先写非空白名单（含 openai 多个 pattern + anthropic）
      setEnabledModels(['openai/*', 'openai/gpt-4', 'anthropic/*'])

      // 清 openai 残留 → 剩 anthropic/*（非空）→ setEnabledModels(['anthropic/*'])
      cleanEnabledModelsResidue('openai')
      let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['anthropic/*'])

      // 再清 anthropic 残留 → 剩空 → clearEnabledModels（delete 字段，CL2——非写空数组）
      cleanEnabledModelsResidue('anthropic')
      raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect('enabledModels' in raw).toBe(false)
    })

    it('startsWith 带斜杠防前缀碰撞：清 openai 不误删 openai-compatible/*', async () => {
      const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
      const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()

      setEnabledModels(['openai/*', 'openai-compatible/*'])
      cleanEnabledModelsResidue('openai')
      const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['openai-compatible/*'])
    })

    it('幂等：provider 不在白名单时 no-op（文件不重复写）', async () => {
      const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
      const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()

      setEnabledModels(['anthropic/*'])
      cleanEnabledModelsResidue('openai') // openai 本不在白名单
      const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['anthropic/*']) // 无变化
    })
  })
});
// ════════════════ 来源: config-service-toggle.test.ts ════════════════
describe('config-service-toggle', () => {
  /**
   * toggleProviderEnabled + 边界检查 + setProvider 停用 enabled 测试（wave3，provider-dual-system-r2::enabledmodels-dual-consume）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-toggle.test.ts
   *
   * 策略：
   *   - TC1/TC2/TC3/TC6：mock configStore，断言写方法调用路由（setEnabledModels vs clearEnabledModels、
   *     setProvider merged 不含 provider 级 enabled）。
   *   - TC4/TC7：状态化 mock（写反映到读），验证 defaultModel 重选 + listProviders 联动。
   *   - 边界3 持久化（CL2）：真实 pi-settings-store（临时 settings 文件），验证 clearEnabledModels
   *     后 settings.json 物理无 enabledModels key（JSON.stringify 丢弃 delete 后的 undefined）。
   *
   * 覆盖 design TC1-TC4/TC6/TC7 + CL1（toggle(true) 空白名单 no-op）+ setProvider 边界1 检查。
   */
  // M5-02：mock 镜像生产 getDefaultModel 的 auto-fix 语义需要 deriveEnabled（与
  // pi-provider-store.findValidDefaultModel 同源判定）。本文件不 mock provider-catalog。
  // 真实 pi-settings-store（边界3 持久化验证用）

  type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

  interface StoreOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    /** models.json providers（默认空）。 */
    models?: ConfigModelsConfig['providers']
    /** settings.json.enabledModels（默认空 = 全启用，DM3）。 */
    enabledModels?: string[]
    /** settings.json defaultProvider/defaultModel（默认 null）。 */
    defaultModel?: { provider: string; modelId: string } | null
    /** auth.json 顶层 providerId 列表（catalog 凭据源，listProviders 联动用）。 */
    authIds?: string[]
  }

  /**
   * 状态化 mock IConfigStore：写操作（setEnabledModels/clearEnabledModels/setDefaultModel/
   * ensureProviderInWhitelist/upsertProvider）反映到后续读（getEnabledModels/getDefaultModel/
   * readModels/getProviderConfig）。TC4 边界2 重选 + TC7 联动需要 read-after-write 一致性。
   */
  function makeStore(opts: StoreOpts = {}) {
    let enabledModels = [...(opts.enabledModels ?? [])]
    let defaultModel = opts.defaultModel ?? null
    const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
    return {
      readModels: vi.fn(() => ({ providers: models })),
      getEnabledModels: vi.fn(() => [...enabledModels]),
      getDefaultModel: vi.fn(() => {
        // M5-02：镜像生产 PiConfigStore.getDefaultModel（findValidDefaultModel + wasFixed
        // auto-fix 写回）。default 有效（provider 在 models、有 models、启用、modelId 存在）
        // → 原值返回；无效 → 重选 models 中第一个启用且有 models 的 provider 并写回
        //（wasFixed 语义）；无可用 → null（生产 catalog 兜底 wasFixed:false 不写回，mock 简化为 null）。
        // 若 mock 仍是「无条件返回初值」，TC4 测的是生产不可达路径（旧实现顺序 bug 漏网）。
        if (!defaultModel) return null
        const cur = defaultModel
        const cfg = models[cur.provider]
        const isEnabled = deriveEnabled(cur.provider, enabledModels)
        if (cfg?.models?.length && isEnabled && cfg.models.some(m => m.id === cur.modelId)) {
          return cur
        }
        for (const [pid, pcfg] of Object.entries(models)) {
          if (pcfg.models?.length && deriveEnabled(pid, enabledModels)) {
            defaultModel = { provider: pid, modelId: pcfg.models[0].id }
            return defaultModel
          }
        }
        return null
      }),
      getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
      setEnabledModels: vi.fn((p: string[]) => { enabledModels = [...p] }),
      clearEnabledModels: vi.fn(() => { enabledModels = [] }),
      setDefaultModel: vi.fn((provider: string, modelId: string) => { defaultModel = { provider, modelId } }),
      ensureProviderInWhitelist: vi.fn((id: string) => {
        // 与 pi-provider-store.ensureProviderInWhitelist 同语义（状态化镜像，供 TC4/TC7 read-after-write）
        if (enabledModels.length === 0) return
        const pattern = `${id}/*`
        if (enabledModels.includes(pattern)) return
        enabledModels = [...enabledModels, pattern]
      }),
      upsertProvider: vi.fn((id: string, merged: ConfigProviderConfig) => {
        models[id] = merged
        return {}
      }),
      applyTypeTranslation: vi.fn((t: string) => t),
      removeProvider: vi.fn(() => ({ removed: true })),
    } as unknown as IConfigStore & {
      setEnabledModels: ReturnType<typeof vi.fn>
      clearEnabledModels: ReturnType<typeof vi.fn>
      setDefaultModel: ReturnType<typeof vi.fn>
      ensureProviderInWhitelist: ReturnType<typeof vi.fn>
      upsertProvider: ReturnType<typeof vi.fn>
    }
  }

  function makeAuth(authIds: string[] = []): FullAuthPick {
    return {
      listCredentialIds: vi.fn(() => authIds),
      hasCredentialSync: vi.fn(() => false),
      remove: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      hasOAuth: vi.fn(() => false),
      hasOAuthSync: vi.fn(() => false),
    } as unknown as FullAuthPick
  }

  function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore> } {
    const store = makeStore(opts)
    const auth = makeAuth(opts.authIds ?? [])
    // M2fg 恒注入形态：凭据判定（含 B1 重选凭据优先）经 resolver 批量 sync 版，
    // 同源于上方 store/auth mock
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth,
      configStore: store,
    })
    const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
    return { svc, store }
  }

  // ══ TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels ════════════════════

  describe('TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('enabledModels 非空 → 加 <id>/*', () => {
      const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
      svc.toggleProviderEnabled('openai', true)
      expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*', 'openai/*'])
    })

    it('CL1: enabledModels 空（全可用）→ no-op（不加 pattern，避免禁用其他）', () => {
      const { svc, store } = makeService({ enabledModels: [] })
      const ret = svc.toggleProviderEnabled('openai', true)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
      expect(ret).toEqual({})
    })

    it('CL1: enabledModels undefined（全可用）→ no-op', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      svc.toggleProviderEnabled('openai', true)
      // 幂等：pattern 已在白名单，不重复加
      expect(store.setEnabledModels).not.toHaveBeenCalled()
    })
  })

  // ══ TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern ═════════════

  describe('TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('移除 provider 级（<id>/*）+ model 级（<id>/<model>）所有 pattern', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*'])
    })

    it('startsWith 带斜杠防前缀碰撞：openai 不误删 openai-compatible/*', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai-compatible/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.setEnabledModels).toHaveBeenCalledWith(['openai-compatible/*'])
    })

    it('幂等：provider 不在白名单时 no-op', () => {
      const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
      expect(store.clearEnabledModels).not.toHaveBeenCalled()
    })
  })

  // ══ TC3: 边界3 空数组检查——重算空时 clearEnabledModels（非写空数组）══════════════════

  describe('TC3: 边界3 空数组检查——重算空时 clearEnabledModels（delete 字段，CL2）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('移除最后一个 pattern → clearEnabledModels 调用，setEnabledModels 不调用（非写空数组）', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
    })

    it('model 级 pattern 移除至空 → 同样 clearEnabledModels', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/gpt-4'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
    })
  })

  // ══ TC4: 边界2 defaultModel 检查——禁用承载 default 的 provider 时重选 ════════════════

  describe('TC4: 边界2 defaultModel 检查——禁用承载 default 的 provider 时重选', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('defaultModel=openai/gpt-4，禁用 openai → 重选为剩余 provider 的 model，返回 newDefault', () => {
      // B-2 混合合并后：catalog provider（如 anthropic）的 models 含 builtin 副本条目，
      // 重选结果随 builtin 目录漂移。候选用 custom id（other-llm）固定 mock 的 models 集，
      // 本用例聚焦「重选发生 + 写回」本身。
      const { svc, store } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          'other-llm': { models: [{ id: 'their-m' }] },
        },
        enabledModels: ['openai/*', 'other-llm/*'],
        defaultModel: { provider: 'openai', modelId: 'gpt-4' },
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      // 重选写入 other-llm/their-m
      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
      expect(ret.newDefault).toEqual({ provider: 'other-llm', modelId: 'their-m' })
    })

    it('禁用的 provider 不承载 default → 不重选，返回空对象', () => {
      const { svc, store } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          anthropic: { models: [{ id: 'claude-3' }] },
        },
        enabledModels: ['openai/*', 'anthropic/*'],
        defaultModel: { provider: 'anthropic', modelId: 'claude-3' },
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      expect(store.setDefaultModel).not.toHaveBeenCalled()
      expect(ret).toEqual({})
    })

    it('M5-02：剩余可用 provider 是 auth.json-only catalog → 重选凭据优先的 anthropic（生产真实路径）', () => {
      // 场景：openai 承载 default，禁用后唯一剩余可用是 auth.json 凭据的 catalog provider
      // anthropic（不在 models.json——生产 findValidDefaultModel 的 fallback 只扫 models.json，
      // 看不到它；pickEnabledDefaultModel 的 B1 凭据优先经 listProviders 双源聚合能看到）。
      const { svc, store } = makeService({
        models: { openai: { models: [{ id: 'gpt-4' }] } },
        enabledModels: ['openai/*'],
        defaultModel: { provider: 'openai', modelId: 'gpt-4' },
        authIds: ['anthropic'],
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      // 白名单更新前读到旧 default（openai）→ 重选 anthropic 并持久化
      expect(store.setDefaultModel).toHaveBeenCalledWith('anthropic', expect.any(String))
      expect(ret.newDefault?.provider).toBe('anthropic')
      // 关键：setDefaultModel 被调用（非惰性等下次 getDefaultModel auto-fix）
      expect(store.setDefaultModel).toHaveBeenCalledTimes(1)
    })

    it('MF-3：重选 default 时跳过候选 provider 的已禁用 model（model 级 enabled 校验，M5-02 路径）', () => {
      // 场景：openai 承载 default，禁用 openai 后重选到候选 provider，但其 models[0]
      // 被用户显式禁用（enabled:false）。旧实现 pickEnabledDefaultModel 只校验 provider 级
      // p.enabled + p.models[0] 存在性，会把已禁用 model 写成新 default。修复后 find 首个启用 model。
      // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，会掩盖
      // 「跳过禁用 model」的意图——custom 候选集固定为 mock 的 models）。
      const { svc, store } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          'other-llm': { models: [{ id: 'disabled-m', enabled: false }, { id: 'enabled-m', enabled: true }] },
        },
        enabledModels: ['openai/*', 'other-llm/*'],
        defaultModel: { provider: 'openai', modelId: 'gpt-4' },
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      // 重选跳过 disabled-m，选 enabled-m（首个启用 model）
      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'enabled-m')
      expect(ret.newDefault).toEqual({ provider: 'other-llm', modelId: 'enabled-m' })
    })
  })

  // ══ TC6: setProvider 停用 provider 级 enabled 写入 ══════════════════════════════════

  describe('TC6: setProvider 停用 provider 级 enabled 写入（C5）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('provider 级 enabled（data.enabled）不写入 models.json', () => {
      const { svc, store } = makeService({
        models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
      })
      svc.setProvider('openai', { enabled: false })
      const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
      // provider 级 enabled 不写入（停用——改由 enabledModels 承载）
      expect('enabled' in merged).toBe(false)
    })

    it('model 级 enabled（data.models[].enabled）不写入 models.json（G3 写侧切换，0161efce4）', () => {
      // model 级启停迁 config/providers.json modelStates（providers.json 侧的写入断言见
      // provider-write-side-switch.test.ts「model enabled 写 providers.json modelStates」），
      // models.json 不再落 pi schema 外的寄生 enabled 字段。
      const { svc, store } = makeService({
        models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
      })
      svc.setProvider('openai', { models: [{ id: 'gpt-4', enabled: false }] })
      const merged = store.upsertProvider.mock.calls[0][1] as { models: Array<{ id: string; enabled?: boolean }> }
      expect('enabled' in merged.models[0]).toBe(false)
    })
  })

  // ══ setProvider 边界1 检查——新建 provider 加白名单 ══════════════════════════════════

  describe('setProvider 边界1检查：新建 provider 时 ensureProviderInWhitelist（TC5 setProvider 路径）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('新建 provider（existingConfig===undefined）→ ensureProviderInWhitelist 调用', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      svc.setProvider('my-custom', { name: 'My', models: [{ id: 'm1' }] })
      expect(store.ensureProviderInWhitelist).toHaveBeenCalledWith('my-custom')
    })

    it('已有 provider（existingConfig!==undefined）→ ensureProviderInWhitelist 不调用', () => {
      const { svc, store } = makeService({
        models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
        enabledModels: ['openai/*'],
      })
      svc.setProvider('openai', { name: 'OpenAI Renamed' })
      expect(store.ensureProviderInWhitelist).not.toHaveBeenCalled()
    })
  })

  // ══ TC7: 联动验证——toggle 后 listProviders 的 enabled 派生正确 ═══════════════════════

  describe('TC7: 联动——toggle 后 listProviders 的 enabled 派生正确反映', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('toggle(openai,false) 后 listProviders：openai→false，anthropic→true', () => {
      const { svc } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          anthropic: { models: [{ id: 'claude-3' }] },
        },
        enabledModels: ['openai/*', 'anthropic/*'],
      })
      svc.toggleProviderEnabled('openai', false)
      const byId = Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
      expect(byId['openai'].enabled).toBe(false)
      expect(byId['anthropic'].enabled).toBe(true)
    })

    it('toggle(openai,true) 加白名单后 listProviders：openai→true', () => {
      const { svc } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          anthropic: { models: [{ id: 'claude-3' }] },
        },
        enabledModels: ['anthropic/*'],
      })
      // toggle 前 openai 未在白名单 → enabled=false
      expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(false)
      svc.toggleProviderEnabled('openai', true)
      expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(true)
    })
  })

  // ══ 边界3 持久化（CL2）：真实 pi-settings-store 验证 delete 字段后 settings.json 无 key ════

  describe('边界3 持久化（CL2）：clearEnabledModels 后 settings.json 物理无 enabledModels key', () => {
    let dir: string
    let agentDir: string

    beforeEach(() => {
      vi.clearAllMocks()
      dir = mkdtempSync(join(tmpdir(), 'toggle-bd3-'))
      agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      process.env.TAIJI_AGENT_DATA_DIR = dir
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()
    })

    afterEach(() => {
      delete process.env.TAIJI_AGENT_DATA_DIR
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it("setEnabledModels(['openai/*']) 后 clearEnabledModels → settings.json 无 enabledModels key", () => {
      // 先写一个非空白名单
      setEnabledModels(['openai/*'])
      let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['openai/*'])

      // clearEnabledModels 用 updateSettingsFields('model', delete) 删字段
      clearEnabledModels()
      // 文件仍存在（只删 key，非删文件）
      expect(existsSync(join(agentDir, 'settings.json'))).toBe(true)
      // JSON.stringify 丢弃 undefined 字段 → settings.json 物理无 enabledModels key
      raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect('enabledModels' in raw).toBe(false)
    })

    it("ensureProviderInWhitelist：enabledModels 非空时加 <id>/*，空时 no-op（真实行为）", () => {
      // 空（全可用）→ no-op，settings.json 不出现 enabledModels
      ensureProviderInWhitelist('openai')
      expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)

      // 非空 → 加 pattern
      setEnabledModels(['anthropic/*'])
      ensureProviderInWhitelist('openai')
      const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['anthropic/*', 'openai/*'])

      // 幂等：重复加同 id 不重复
      ensureProviderInWhitelist('openai')
      const raw2 = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw2.enabledModels).toEqual(['anthropic/*', 'openai/*'])
    })
  })
});
// ════════════════ 来源: provider-read-source-switch.test.ts ════════════════
describe('provider-read-source-switch', () => {
  /**
   * A1-3 读源切换测试：listProviders 聚合层的 taiji 私有字段（authMethod/quota/modelStates）
   * 从 config/providers.json 双读回退（providers.json 优先 + models.json 旧寄生字段兜底）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-read-source-switch.test.ts
   *
   * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
   * 与 provider-write-side-switch.test.ts 同模式。isCatalogProvider 走真实实现
   * （zai-coding-cn 是 builtin catalog provider）。
   */

  let dir: string
  let agentDir: string
  let extrasStore: TaijiProviderStore
  let configStore: PiConfigStore

  function writeModelsJson(providers: Record<string, unknown>): void {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
  }

  function writeExtrasJson(providers: ProviderExtrasFile['providers']): void {
    const file: ProviderExtrasFile = { version: 1, providers }
    writeFileSync(join(agentDir, 'config', 'providers.json'), JSON.stringify(file, null, 2))
  }

  function makeSvc(authIds: string[] = []): ConfigService {
    // catalog 源候选 = (auth.json keys ∪ models.json catalog keys) ∩ builtinData——
    // builtin 副本路径测试需注入 authStorage 让凭据型 catalog provider 进入聚合
    const auth = authIds.length > 0
      ? { listCredentialIds: () => authIds, hasCredentialSync: () => true } as never
      : undefined
    // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（真 PiConfigStore 读同一 models.json）
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth ?? { listCredentialIds: () => [] as string[], hasCredentialSync: () => false },
      configStore,
    })
    return new ConfigService('/tmp/project', configStore, auth, extrasStore, undefined, resolver)
  }

  function byId(svc: ConfigService): Record<string, ReturnType<ConfigService['listProviders']>[number]> {
    return Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-read-source-switch-'))
    agentDir = join(dir, 'agent')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
    extrasStore = new TaijiProviderStore(join(agentDir, 'config', 'providers.json'))
    configStore = new PiConfigStore()
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('A1-3 验收 1：聚合层读源（providers.json 优先）', () => {
    it('providers.json 有 authMethod/quota → catalog 与 custom 均读到（models.json 无寄生字段）', () => {
      writeModelsJson({
        'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        'my-proxy': { apiKey: 'sk-x', baseUrl: 'https://proxy.example.com' },
      })
      writeExtrasJson({
        'zai-coding-cn': { authMethod: 'api_key', quota: { fetcher: 'zhipu', enabled: true, apiKeySet: true } },
        'my-proxy': { authMethod: 'env_var', quota: { fetcher: 'kimi', enabled: false } },
      })

      const m = byId(makeSvc())

      // catalog 源：显式 authMethod 标注 + quota 来自 providers.json
      expect(m['zai-coding-cn'].authMethod).toBe('api_key')
      expect(m['zai-coding-cn'].quota).toEqual({ fetcher: 'zhipu', enabled: true, apiKeySet: true })
      // custom 源同
      expect(m['my-proxy'].authMethod).toBe('env_var')
      expect(m['my-proxy'].quota).toEqual({ fetcher: 'kimi', enabled: false })
    })

    it('fallback：providers.json 无条目 + models.json 有旧寄生字段（迁移失败窗口）→ 仍能读到', () => {
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          authMethod: 'oauth',
          quota: { fetcher: 'zhipu', enabled: true, cookieSet: true },
        },
        'my-proxy': {
          apiKey: '$MY_KEY',
          authMethod: 'env_var',
          quota: { fetcher: 'kimi', enabled: true },
        },
      })
      // providers.json 文件不存在（无条目）→ 双读回退 models.json 旧寄生字段

      const m = byId(makeSvc())

      expect(m['zai-coding-cn'].authMethod).toBe('oauth')
      expect(m['zai-coding-cn'].quota).toEqual({ fetcher: 'zhipu', enabled: true, cookieSet: true })
      expect(m['my-proxy'].authMethod).toBe('env_var')
      expect(m['my-proxy'].quota).toEqual({ fetcher: 'kimi', enabled: true })
    })

    it('providers.json 优先级：两处同 id 时 providers.json 胜（models.json 旧值不复活）', () => {
      writeModelsJson({
        'zai-coding-cn': {
          authMethod: 'oauth',
          quota: { fetcher: 'stale-fetcher', enabled: false },
        },
      })
      writeExtrasJson({
        'zai-coding-cn': { authMethod: 'api_key', quota: { fetcher: 'zhipu', enabled: true } },
      })

      const m = byId(makeSvc())

      expect(m['zai-coding-cn'].authMethod).toBe('api_key')
      expect(m['zai-coding-cn'].quota).toEqual({ fetcher: 'zhipu', enabled: true })
    })

    it('两处皆无 → authMethod 走 derive 推断、quota 为 undefined', () => {
      writeModelsJson({
        'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        'env-provider': { apiKey: '$MY_TOKEN', baseUrl: 'https://x.example.com' },
        'key-provider': { apiKey: 'sk-plain', baseUrl: 'https://y.example.com' },
        'bare-provider': { baseUrl: 'https://z.example.com' },
      })

      const m = byId(makeSvc())

      // catalog 无 override 凭据且无标注 → undefined；apiKey 推断：$开头→env_var / 非空→api_key / 缺省→undefined
      expect(m['zai-coding-cn'].authMethod).toBeUndefined()
      expect(m['env-provider'].authMethod).toBe('env_var')
      expect(m['key-provider'].authMethod).toBe('api_key')
      expect(m['bare-provider'].authMethod).toBeUndefined()
      // quota 双读皆 miss → undefined
      expect(m['zai-coding-cn'].quota).toBeUndefined()
      expect(m['env-provider'].quota).toBeUndefined()
    })
  })

  describe('A1-3 验收 2：modelStates 过滤（models[].enabled 迁移后等价）', () => {
    it('override models 路径：providers.json modelStates enabled=false → 聚合输出过滤行为与迁移前一致', () => {
      // 迁移前形态（models.json 寄生 enabled）——等价基准
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          models: [
            { id: 'glm-5.3', name: 'GLM 5.3' },
            { id: 'glm-5.2', name: 'GLM 5.2', enabled: false },
          ],
        },
      })
      const before = byId(makeSvc())['zai-coding-cn'].models
      expect(before.find(x => x.id === 'glm-5.3')?.enabled).toBe(true)
      expect(before.find(x => x.id === 'glm-5.2')?.enabled).toBe(false)

      // 迁移后形态（providers.json modelStates）——同一过滤结果
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          models: [
            { id: 'glm-5.3', name: 'GLM 5.3' },
            { id: 'glm-5.2', name: 'GLM 5.2' },
          ],
        },
      })
      writeExtrasJson({
        'zai-coding-cn': { modelStates: { 'glm-5.2': { enabled: false } } },
      })
      const after = byId(makeSvc())['zai-coding-cn'].models
      expect(after.find(x => x.id === 'glm-5.3')?.enabled).toBe(true)
      expect(after.find(x => x.id === 'glm-5.2')?.enabled).toBe(false)
    })

    it('custom provider 的 modelStates 同样生效', () => {
      writeModelsJson({
        'my-proxy': {
          apiKey: 'sk-x',
          models: [{ id: 'm1' }, { id: 'm2' }],
        },
      })
      writeExtrasJson({ 'my-proxy': { modelStates: { m1: { enabled: false } } } })

      const models = byId(makeSvc())['my-proxy'].models
      expect(models.find(x => x.id === 'm1')?.enabled).toBe(false)
      expect(models.find(x => x.id === 'm2')?.enabled).toBe(true)
    })

    it('builtin 副本路径：modelStates 对 catalog 内置模型生效（providers.json 手写场景）', () => {
      // catalog provider 无 override、凭据在 auth.json → models 兜底 builtin 副本；modelStates 仍应用
      writeModelsJson({})
      writeExtrasJson({ 'zai-coding-cn': { modelStates: {} } })
      // 先取一个真实 builtin model id 构造禁用态
      const svc = makeSvc(['zai-coding-cn'])
      const firstModel = byId(svc)['zai-coding-cn'].models[0]
      expect(firstModel).toBeDefined()

      writeExtrasJson({ 'zai-coding-cn': { modelStates: { [firstModel.id]: { enabled: false } } } })
      const models = byId(makeSvc(['zai-coding-cn']))['zai-coding-cn'].models
      expect(models.find(x => x.id === firstModel.id)?.enabled).toBe(false)
    })
  })
});
// ════════════════ 来源: config-service.test.ts ════════════════
describe('config-service', () => {
  /**
   * ConfigService — runtime enabled 读写链路（W2）端到端单测。
   *
   * 用真实 PiConfigStore（指向临时目录的 models.json）验证：
   * U1 listProviders 返回 provider 级 api 字段（修复编辑回填丢失 api，P0-1）+ enabled
   * U2 setProvider 写入 enabled 并被 listProviders 读回（真实读写 models.json，非硬编码）
   * U3 setProvider 写入 model 级 enabled 并被 aggregateModels 过滤（在 model-service.test.ts 验证过滤逻辑，
   *    此处只验证 listProviders 读回 model 级 enabled 字段）
   *
   * setup 模式复用 pi-provider-store.test.ts：setModelsPath/setSettingsPath 指向临时目录 +
   * writeModels 落盘 + refreshModels 刷缓存。
   */


  const mkdtempP = promisify(mkdtemp)
  const rmP = promisify(rm)

  let tmpDir: string
  let configStore: PiConfigStore
  let configService: ConfigService

  /**
   * M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（D3 唯一通道）。
   * auth.json 路径指向临时目录（零凭据 miss），models.json 路径经真 configStore。
   */
  function makeResolver(store: PiConfigStore): ProviderCredentialResolver {
    return new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: new AuthStorage(join(tmpDir, 'agent', 'auth.json')),
      configStore: store,
    })
  }

  beforeEach(async () => {
    tmpDir = await mkdtempP(join(tmpdir(), 'config-service-test-'))
    mkdirSync(join(tmpDir, 'agent'), { recursive: true })
    // 指向临时目录，避免污染真实 ~/.taiji/agent
    setModelsPath(join(tmpDir, 'agent', 'models.json'))
    setSettingsPath(join(tmpDir, 'agent', 'settings.json'))
    refreshModels()
    // ConfigService 接受 IConfigStore；用真实 PiConfigStore 走完整读写链路
    configStore = new PiConfigStore()
    configService = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, makeResolver(configStore))
  })

  afterEach(async () => {
    await rmP(tmpDir, { recursive: true, force: true })
  })

  // ── U1: listProviders 返回 provider 级 api 字段 ────────────────────
  // 修复编辑回填丢失 api：前端编辑 provider 时需用 api 字段回填 type 下拉，
  // listProviders 不返回 api 会导致编辑后 type 丢失（P0-1）。
  describe('ConfigService.listProviders · provider 级 api 字段（U1，修复 P0-1）', () => {
    it('返回 provider 的 api 字段（非 undefined）', () => {
      const models: PiModelsConfig = {
        providers: {
          p1: {
            api: 'anthropic-messages',
            apiKey: 'sk-x',
            enabled: true,
            models: [],
          },
        },
      }
      writeModels(models)
      refreshModels()

      const providers = configService.listProviders()
      expect(providers).toHaveLength(1)
      expect(providers[0]!.id).toBe('p1')
      // 关键断言：api 字段必须回填，否则前端编辑 provider 时 type 下拉丢失
      expect(providers[0]!.api).toBe('anthropic-messages')
    })

    it('enabled=true 的 provider 返回 enabled === true', () => {
      const models: PiModelsConfig = {
        providers: {
          p1: {
            apiKey: 'sk-x',
            enabled: true,
            models: [],
          },
        },
      }
      writeModels(models)
      refreshModels()

      const providers = configService.listProviders()
      expect(providers[0]!.enabled).toBe(true)
    })
  })

  // ── U2: provider 级 enabled 读写链路（enabledModels 白名单模型）────────
  // wave3/wave4 演进：provider 级 enabled 从「models.json provider.enabled 字段」迁移到
  // 「settings.json enabledModels 白名单」。setProvider 不再写 provider.enabled（wave3 C5/TC6：
  // 前端 provider 启用切换改走 toggleProviderEnabled），listProviders 的 enabled 从
  // deriveEnabled(id, enabledModels) 派生（DM3/F2，不读 models.json provider.enabled）。
  //
  // 故 U2 的读写链路 = toggleProviderEnabled 写 enabledModels 白名单 → listProviders 经
  // deriveEnabled 读回。白名单空/undefined = 全可用（deriveEnabled 恒 true）；非空 = 白名单匹配才启用。
  // 要测「禁用」语义，须先让白名单非空（模拟用户已显式收窄启用范围）——空白名单下 toggle(false) 幂等 no-op。
  describe('ConfigService · provider 级 enabled 读写链路（U2，enabledModels 白名单模型）', () => {
    it('toggleProviderEnabled(p1, false) 后 listProviders 读回 enabled === false', () => {
      writeModels({
        providers: {
          p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
          p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
        },
      })
      refreshModels()
      // 建立非空白名单（模拟用户已显式启用部分 provider）。空白名单=全可用，toggle(false) 幂等 no-op。
      configStore.setEnabledModels(['p1/*', 'p2/*'])

      configService.toggleProviderEnabled('p1', false)

      const providers = configService.listProviders()
      // p1 被移出白名单 → deriveEnabled(p1) === false
      expect(providers.find(p => p.id === 'p1')?.enabled).toBe(false)
      // 副作用断言：禁用 p1 不误伤 p2（startsWith('p1/') 不匹配 'p2/*'，防 openai vs openai-compatible 前缀碰撞）
      expect(providers.find(p => p.id === 'p2')?.enabled).toBe(true)
    })

    it('toggleProviderEnabled(p1, true) 把已禁用的 p1 加回白名单后读回 enabled === true', () => {
      writeModels({
        providers: {
          p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
          p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
        },
      })
      refreshModels()
      // p1 不在白名单（已被禁用），p2 在 → 非空白名单下 deriveEnabled(p1) === false
      configStore.setEnabledModels(['p2/*'])
      expect(configService.listProviders().find(p => p.id === 'p1')?.enabled).toBe(false)

      // toggle(true) 在白名单非空时补加 p1/*（空白名单下 no-op，故前置条件必须非空）
      configService.toggleProviderEnabled('p1', true)

      expect(configService.listProviders().find(p => p.id === 'p1')?.enabled).toBe(true)
    })

    it('toggleProviderEnabled(p1, false) 后盘上 settings.json 持久化移除 p1 pattern（端到端非硬编码）', () => {
      writeModels({
        providers: {
          p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
          p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
        },
      })
      refreshModels()
      configStore.setEnabledModels(['p1/*', 'p2/*'])

      configService.toggleProviderEnabled('p1', false)

      // 直接读盘验证（绕过 service 缓存）：enabledModels 白名单落盘到 settings.json（非 models.json）
      const raw = readFileSync(
        join(tmpDir, 'agent', 'settings.json'),
        'utf-8',
      )
      const parsed = JSON.parse(raw) as { enabledModels?: string[] }
      // p1 的 pattern 被移除，仅剩 p2（startsWith('p1/') 统一匹配 provider 级与 model 级 pattern）
      expect(parsed.enabledModels).toEqual(['p2/*'])
      expect(parsed.enabledModels?.some(p => p.startsWith('p1/'))).toBe(false)
    })
  })

  // ── 向上兼容：存量 provider 无 enabled 字段时默认视为启用 ──────────
  // config.enabled !== false 语义：undefined 和 true 都视为启用，
  // 只有显式 false 才禁用（向上兼容存量无此字段的 provider）。
  describe('ConfigService.listProviders · 向上兼容（无 enabled 字段默认 true）', () => {
    it('存量 provider 无 enabled 字段时 enabled === true（向上兼容）', () => {
      // 故意不写 enabled 字段（模拟存量 models.json）
      const models: PiModelsConfig = {
        providers: {
          legacy: {
            apiKey: 'sk-legacy',
            models: [{ id: 'm1' }],
          },
        },
      }
      writeModels(models)
      refreshModels()

      const providers = configService.listProviders()
      expect(providers[0]!.enabled).toBe(true)
    })
  })

  // ── U3 前置：listProviders 读回 model 级 enabled（aggregateModels 过滤在 model-service.test.ts 验证）──
  describe('ConfigService.listProviders · model 级 enabled 透传', () => {
    it('model 级 enabled=false 透传到 listProviders 结果', () => {
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            models: [
              { id: 'm1', name: 'M1', enabled: false },
              { id: 'm2', name: 'M2', enabled: true },
            ],
          },
        },
      })
      refreshModels()

      const providers = configService.listProviders()
      const models = providers[0]!.models
      // model 级 enabled 透传，供 aggregateModels 过滤判断
      expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
      expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)
    })
  })

  // ── U3b: setProvider 的 model 合并写路径必须保留传入的 enabled/api/baseUrl ──
  // review 发现：setProvider 的 model 合并循环只写 name/contextWindow/input/thinkingLevelMap，
  // 前端回传的 api/baseUrl/enabled 被丢弃。新模型（base={}）和编辑现有模型场景都会丢字段。
  // 此 describe 走 setProvider 写路径（而非 writeModels 直写），断言字段真落盘。
  // [G3 写侧切换] enabled 的落点改为 providers.json modelStates（models.json 不再写寄生字段）。
  describe('ConfigService.setProvider · model 级字段写路径（U3b，修复 review must_fix #1）', () => {
    it('新模型经 setProvider 保存后 enabled 生效（G3：落 providers.json modelStates，models.json 不落 enabled）', async () => {
      // 先建空 provider
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            models: [],
          },
        },
      })
      refreshModels()

      // [G3] enabled 落 providers.json modelStates——注入 extrasStore（生产恒注入）；
      // 未注入时 enabled 丢弃 + warn（宁丢不写错位，provider-write-side-switch.test.ts 覆盖）
      const extrasStore = new TaijiProviderStore(join(tmpDir, 'agent', 'config', 'providers.json'))
      const svc = new ConfigService(tmpDir, configStore, undefined, extrasStore, undefined, makeResolver(configStore))

      // setProvider 传入含 enabled 的 model（新模型，base={}）。modelStates 写入经
      // withFileLock 异步 RMW——必须 await 落盘后再断言
      await svc.setProvider('p1', {
        models: [
          { id: 'm1', enabled: false },
          { id: 'm2', enabled: true },
        ],
      })

      // 聚合层读 modelStates：enabled 语义保留（编辑保存不丢失）
      const providers = svc.listProviders()
      const models = providers[0]!.models
      expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
      expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)

      // models.json 不再序列化 enabled（pi schema 外寄生字段禁复活）
      const raw = JSON.parse(readFileSync(join(tmpDir, 'agent', 'models.json'), 'utf-8'))
      const rawModels = raw.providers.p1.models as Array<Record<string, unknown>>
      expect(rawModels.find(m => m.id === 'm1')).not.toHaveProperty('enabled')
      expect(rawModels.find(m => m.id === 'm2')).not.toHaveProperty('enabled')
    })

    it('model 级 api/baseUrl 经 setProvider 保存后落盘（编辑场景）', () => {
      // 先建含 m1 的 provider（m1 无 api/baseUrl）
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'anthropic-messages',
            models: [{ id: 'm1', name: 'M1' }],
          },
        },
      })
      refreshModels()

      // 编辑 m1，补 model 级 api/baseUrl（覆盖 provider 默认）
      configService.setProvider('p1', {
        models: [
          { id: 'm1', name: 'M1', api: 'openai-completions', baseUrl: 'https://m1.example.com' },
        ],
      })

      const providers = configService.listProviders()
      const m1 = providers[0]!.models.find(m => m.id === 'm1')
      expect(m1?.api).toBe('openai-completions')
      expect(m1?.baseUrl).toBe('https://m1.example.com')
    })

    it('model 级 compat 经 setProvider 保存后落盘（修复隐性数据丢失 bug）', () => {
      // 先建含 m1 的 provider（m1 已有 compat——模拟用户手改 json 配好的）
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'openai-completions',
            models: [{
              id: 'm1',
              name: 'M1',
              compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' },
            }],
          },
        },
      })
      refreshModels()

      // 前端编辑 provider（不改 m1 的 compat——localModels 经 ...m 展开回传）
      // bug 复现：setProvider 合并逻辑若不透传 compat，m1.compat 会被静默丢弃
      configService.setProvider('p1', {
        models: [
          { id: 'm1', name: 'M1', compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' } },
        ],
      })

      const providers = configService.listProviders()
      const m1 = providers[0]!.models.find(m => m.id === 'm1')
      expect(m1?.compat).toEqual({ supportsDeveloperRole: false, thinkingFormat: 'deepseek' })
    })

    it('model 级 compat 显式覆盖：编辑后 compat 更新落盘', () => {
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'openai-completions',
            models: [{ id: 'm1', compat: { supportsDeveloperRole: true } }],
          },
        },
      })
      refreshModels()

      // 用户在 UI 把 supportsDeveloperRole 改成 false
      configService.setProvider('p1', {
        models: [
          { id: 'm1', compat: { supportsDeveloperRole: false } },
        ],
      })

      const m1 = configService.listProviders()[0]!.models.find(m => m.id === 'm1')
      expect(m1?.compat).toEqual({ supportsDeveloperRole: false })
    })

    it('setProvider 删除已存在的 compat（compat === undefined 触发删除）', () => {
      // 1. 先写一个带 compat 的 model（模拟用户已配好的 compat）
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'openai-completions',
            models: [{ id: 'm1', compat: { thinkingFormat: 'xml' } }],
          },
        },
      })
      refreshModels()

      // 2. setProvider 传 models 不含 compat 字段（compat 为 undefined）——模拟前端 clearAll 按钮
      //    buildMap() 全 passthrough 时 buildCompat 返回 undefined，前端整体提交 models 时
      //    该 model 无 compat 键，应触发 else if 删除分支。
      configService.setProvider('p1', {
        models: [{ id: 'm1' }],
      })

      // 3. 读回的 compat 应为 undefined（被 delete，而非保留盘上旧值）
      const m1 = configService.listProviders()[0]!.models.find(m => m.id === 'm1')
      expect(m1?.compat).toBeUndefined()
    })
  })

  // ── W1: loadAgents sourceType 必须随来源目录推断（不再恒 'pi'）──────
  // 背景：config-service.loadAgents 旧版把每个 agent 硬编码 source/sourceType = 'pi'，
  // 导致 Settings Agent 页按 Claude/Agents tab 过滤时永远空（即便文件来自 ~/.claude/agents）。
  // W1 修复：agent-crud.listAgentFiles 扫描时按 discovered 目录 inferSourceType 填 sourceType，
  // config-service.loadAgents 透传该字段。
  // 这里 mock configStore.listAgentFiles 返回带不同 sourceType 的 entry，
  // 验证 loadAgents 不再恒 pi，而是如实透传。
  describe('ConfigService.loadAgents · sourceType 随来源推断（W1，修复 tab 过滤失效）', () => {
    /**
     * 构造一个最小 fake configStore：只实现 loadAgents 用到的方法。
     * listAgentFiles 按 mockFiles 返回（含 sourceType），其余方法返回安全空值。
     * 跳过真实 PiConfigStore 是为了隔离：本测只验证「f.sourceType → AgentInfo.sourceType 透传」，
     * 不关心目录扫描/去重逻辑（那部分在 agent-crud 层，由真实文件验证更合适）。
     */
    function makeFakeStore(
      mockFiles: Array<{ name: string; path: string; content: string; sourceType: string }>,
    ) {
      return {
        getPiAgentDir: () => '/fake/agent',
        getAgentDirs: () => [] as string[],
        listAgentFiles: () => mockFiles,
        // 以下方法 loadAgents 不会触达，给空实现满足 ConfigService 构造签名
        getDefaultModel: () => null,
        setDefaultModel: () => undefined,
        readModels: () => ({ providers: {} }),
        getProviderConfig: () => undefined,
        upsertProvider: () => ({}),
        removeProvider: () => ({ removed: false }),
        applyTypeTranslation: (t: string) => t,
        getSkillPaths: () => [] as string[],
        setSkillPaths: () => undefined,
        addSkillPath: () => undefined,
        removeSkillPath: () => undefined,
        migrateSettingsSkillsToDiscovery: () => undefined,
        setAgentDirs: () => undefined,
        writeAgentFile: () => undefined,
        deleteAgentFile: () => false,
        getConfigDir: () => '/fake/config',
      }
    }

    it('claude 目录来源的 agent sourceType === "claude"（非 pi）', () => {
      const store = makeFakeStore([
        {
          name: 'code-review',
          path: '/home/u/.claude/agents/code-review.md',
          content: '---\nname: Code Review\n---\nreview code',
          sourceType: 'claude',
        },
      ])
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      expect(agents).toHaveLength(1)
      // 关键断言：sourceType 必须如实透传，不能恒 pi（否则 Claude tab 过滤失效）
      expect(agents[0]!.sourceType).toBe('claude')
      expect(agents[0]!.source).toBe('claude')
    })

    it('agents 目录来源的 agent sourceType === "agents"', () => {
      const store = makeFakeStore([
        {
          name: 'builder',
          path: '/home/u/.agents/agents/builder.md',
          content: '---\nname: Builder\n---\nbuild things',
          sourceType: 'agents',
        },
      ])
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      expect(agents[0]!.sourceType).toBe('agents')
      expect(agents[0]!.source).toBe('agents')
    })

    it('混合来源各自透传（claude / agents / pi 共存）', () => {
      const store = makeFakeStore([
        {
          name: 'reviewer',
          path: '/h/.claude/agents/reviewer.md',
          content: '---\nname: Reviewer\n---',
          sourceType: 'claude',
        },
        {
          name: 'planner',
          path: '/h/.agents/agents/planner.md',
          content: '---\nname: Planner\n---',
          sourceType: 'agents',
        },
        {
          name: 'default',
          path: '/h/.taiji/agent/agents/default.md',
          content: '---\nname: Default\n---',
          sourceType: 'pi',
        },
      ])
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      const byId = new Map(agents.map(a => [a.id, a]))
      expect(byId.get('reviewer')?.sourceType).toBe('claude')
      expect(byId.get('planner')?.sourceType).toBe('agents')
      expect(byId.get('default')?.sourceType).toBe('pi')
    })

    it('sourceType 缺失时兜底为 pi（向后兼容旧 entry 无此字段）', () => {
      // 旧版 agent-crud 不填 sourceType（字段缺失 = undefined，非空串）；
      // config-service 用 ?? 'pi' 兜底，避免 undefined 污染前端。
      // 注意：?? 只兜底 null/undefined，不兜底空串——而 inferSourceType 运行时
      // 至少返回 'custom'，不会产出空串，故这里只测 undefined 这条兜底路径。
      const store = makeFakeStore([
        {
          name: 'legacy',
          path: '/h/somewhere/legacy.md',
          content: '---\nname: Legacy\n---',
          sourceType: '',
        },
      ])
      // 模拟「字段缺失」：删除 sourceType（等价于旧 entry 无此字段）
      delete (store.listAgentFiles()[0] as { sourceType?: string }).sourceType
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      // undefined → 兜底 pi
      expect(agents[0]!.sourceType).toBe('pi')
      expect(agents[0]!.source).toBe('pi')
    })
  })

  // ── LLM retry 域委托（llm-retry-settings 设计 §3.4：单行委托注入 port）──────────

  describe('ConfigService · resolver 显式检查访问器（R2 S-1 修复契约机器锁定，R3 S-4 补测）', () => {
    it('两参构造 + 调 provider 三方法 → 带恢复指引的 Error（非静默成功 / 非深处 TypeError）', async () => {
      // 与上方 llmRetrySettings 未注入抛错用例同模式：少参构造 = 测试构造错误，报错指向恢复动作
      const svc = new ConfigService(tmpDir, configStore)
      const expected = '[config-service] providerCredentialResolver 未注入'
      expect(() => svc.listProviders()).toThrow(expected)
      expect(() => svc.toggleProviderEnabled('p1', true)).toThrow(expected)
      // removeProviderByKind 是 async 方法：同步段抛错 → 拒绝的 Promise，用 rejects 断言
      await expect(svc.removeProviderByKind('p1', 'custom')).rejects.toThrow(expected)
      // 恢复指引文案可操作：指向注入 resolver / 改用 provider 无关实例（错误 → 权威源 → 重试闭环）
      try {
        svc.listProviders()
        expect.unreachable('listProviders should have thrown')
      } catch (e) {
        expect((e as Error).message).toContain('注入 resolver')
        expect((e as Error).message).toContain('listProviders / toggleProviderEnabled / removeProviderByKind')
      }
    })
  })

  describe('ConfigService · LLM retry 域（llmRetrySettings port）', () => {
    it('未注入 port：getRetryConfig / setRetryConfig 抛错（可选注入防御，生产恒注入）', () => {
      // beforeEach 构造的 configService 只传 2 个参数（未注入 llmRetrySettings）
      expect(() => configService.getRetryConfig()).toThrow('[config-service] llmRetrySettings not available (getRetryConfig)')
      expect(() => configService.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1000 })).toThrow(
        '[config-service] llmRetrySettings not available (setRetryConfig)',
      )
    })

    it('注入 port：读写单行委托（参数与返回值透传，ConfigService 不做 retry 域业务）', () => {
      const snapshot: LlmRetryConfigSnapshot = {
        configured: false,
        config: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
      }
      const getRetryConfig = vi.fn(() => snapshot)
      const setRetryConfig = vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
      const svc = new ConfigService(tmpDir, configStore, undefined, undefined, {
        getRetryConfig,
        setRetryConfig,
      } as unknown as ILlmRetrySettings)

      expect(svc.getRetryConfig()).toBe(snapshot)
      expect(getRetryConfig).toHaveBeenCalledTimes(1)

      const arg: LlmRetryConfig = { enabled: true, maxRetries: 1, baseDelayMs: 1000 }
      expect(svc.setRetryConfig(arg)).toEqual({ ok: true })
      expect(setRetryConfig).toHaveBeenCalledWith(arg)
    })
  })

  // ── M2c：D3 链 5 接线（构造器注入 → listProviders 消费）────────────────────────
  // 「装配点真的传了」的落点 = ConfigService 构造器（组合根 index.ts 以第 6 参传入）与
  // listProviders 的透传。本组用真实 ConfigService 构造 + 真实 PiConfigStore，证明 resolver
  // 经构造器到达 listProvidersImpl 并真实参与凭据判定（而非只测「listProvidersImpl 注入了就生效」）。
  describe('M2c: ConfigService 构造器注入 providerCredentialResolver（D3 链 5 接线）', () => {
    /** 假 resolver：仅暴露接口三方法（批量方法返回值可控，用于证明其输出被消费）。 */
    function makeSetResolver(credentialIds: string[]) {
      const listCredentialBackedProviderIds = vi.fn(() => new Set(credentialIds))
      return {
        resolver: {
          hasProviderCredential: vi.fn(() => false),
          listCredentialBackedProviderIds,
          resolveProviderCredential: vi.fn(async () => undefined),
          resolveProviderApiKeyRaw: async () => undefined,
          resolveProviderBaseUrl: vi.fn(() => undefined),
        },
        listCredentialBackedProviderIds,
      }
    }

    it('注入后 listProviders 经 resolver 批量 sync 版判定凭据（调用 + 输出被消费）', () => {
      // 该 provider 在 models.json 无 apiKey：status=connected 只能来自 resolver 的批量结果
      writeModels({ providers: { 'custom-no-key': { name: 'NoKey', models: [{ id: 'm1' }] } } })
      refreshModels()
      const { resolver, listCredentialBackedProviderIds } = makeSetResolver(['custom-no-key'])
      const svc = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, resolver)

      const providers = svc.listProviders()

      expect(listCredentialBackedProviderIds).toHaveBeenCalledTimes(1)
      expect(providers.find(p => p.id === 'custom-no-key')?.status).toBe('connected')
      expect(providers.find(p => p.id === 'custom-no-key')?.apiKeySet).toBe(false)
    })

    it('对照：resolver 空集 → 同一份数据不判 connected（差异证明 resolver 输出被消费；M2fg 恒注入形态）', () => {
      writeModels({ providers: { 'custom-no-key': { name: 'NoKey', models: [{ id: 'm1' }] } } })
      refreshModels()
      const { resolver } = makeSetResolver([])
      const svc = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, resolver)

      const providers = svc.listProviders()

      expect(providers.find(p => p.id === 'custom-no-key')?.status).toBe('not_configured')
    })
  })
});
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-load-dedupe', () => {
describe('ExtensionService.getExtensionPaths 同名去重（P7）', () => {
  beforeEach(() => {
    // 静默 dev 模式 builtin 路径缺失 warn + 去重 skip warn
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setSettingsPath(getActiveSettingsPath())
    for (const r of registeredRoots.splice(0)) {
      rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('双路径同名：discovery 目录 + settings npm 版 → 注入列表只含 npm 版一份', async () => {
    const { service, npmPkgDir, discoveryDirs } = setup({
      discoveryDirs: [EXT_NAME],
      packages: [`npm:${EXT_NAME}`],
      disabled: [],
    })
    writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([npmPkgDir])
    expect(paths).toHaveLength(1)
  })

  it('单路径（仅 discovery 目录）：注入 discovery 版，行为不变', async () => {
    const { service, discoveryDirs } = setup({ discoveryDirs: [EXT_NAME], packages: [], disabled: [] })
    const discoveryPkgDir = writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)
    // discovery 源注入的是入口文件路径（复刻 pi collectAutoExtensionEntries，--extension 接受文件入口）
    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([join(discoveryPkgDir, 'index.ts')])
  })

  it('单路径（仅 settings npm 版）：注入 npm 版，行为不变', async () => {
    const { service, npmPkgDir } = setup({ discoveryDirs: [], packages: [`npm:${EXT_NAME}`], disabled: [] })

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([npmPkgDir])
  })

  it('双路径不同名扩展：各自保留，不误杀其他扩展', async () => {
    const { service, npmPkgDir, discoveryDirs } = setup({
      discoveryDirs: [EXT_NAME],
      packages: [`npm:${EXT_NAME}`],
      disabled: [],
    })
    writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)
    const otherDiscoveryEntry = join(writeDiscoveryExtension(discoveryDirs[0], 'pi-model-info', '@zhushanwen/pi-model-info'), 'index.ts')

    const paths = await service.getExtensionPaths()
    // resolver 按包名字母序输出（pi-model-info < pi-vision → discovery 版在前），
    // 去重不改变源顺序——断言顺序无关（两条都在、不误杀）
    expect(paths).toHaveLength(2)
    expect([...paths].sort()).toEqual([npmPkgDir, otherDiscoveryEntry].sort())
  })

  it('受管版被禁用时占位：npm 版 disabled → discovery 版不顶上（UI 禁用语义生效）', async () => {
    const { service, discoveryDirs } = setup({
      discoveryDirs: [EXT_NAME],
      packages: [`npm:${EXT_NAME}`],
      disabled: [`npm:${EXT_NAME}`],
    })
    writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([])
  })

  it('多个 discovery 目录同名：保留第一个目录的版本', async () => {
    const { service, discoveryDirs } = setup({ discoveryDirs: [EXT_NAME, EXT_NAME], packages: [], disabled: [] })
    const dirA = writeDiscoveryExtension(discoveryDirs[0], 'reader-a', EXT_NAME)
    writeDiscoveryExtension(discoveryDirs[1], 'reader-b', EXT_NAME)

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([join(dirA, 'index.ts')])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('llm-retry-config', () => {
describe('resolveRetryConfig · configured 判定（D7）', () => {
  it('全缺省（undefined/空对象/坏值顶层）→ false', () => {
    expect(resolveRetryConfig(undefined).configured).toBe(false)
    expect(resolveRetryConfig({}).configured).toBe(false)
    expect(resolveRetryConfig('abc').configured).toBe(false)
    expect(resolveRetryConfig([1, 2]).configured).toBe(false)
    expect(resolveRetryConfig(null).configured).toBe(false)
  })

  it('顶层任一键显式存在 → true（半配置如仅 provider 一键也 true）', () => {
    expect(resolveRetryConfig({ enabled: false }).configured).toBe(true)
    expect(resolveRetryConfig({ maxRetries: 5 }).configured).toBe(true)
    expect(resolveRetryConfig({ baseDelayMs: 1000 }).configured).toBe(true)
    expect(resolveRetryConfig({ provider: { timeoutMs: 30000 } }).configured).toBe(true)
    expect(resolveRetryConfig({ provider: { maxRetries: 1 } }).configured).toBe(true)
    expect(resolveRetryConfig({ provider: { maxRetryDelayMs: 60000 } }).configured).toBe(true)
  })

  it('provider 层是坏值时 provider 三键不计 configured（但顶层键在仍 true）', () => {
    expect(resolveRetryConfig({ provider: 'abc' }).configured).toBe(false)
    expect(resolveRetryConfig({ enabled: true, provider: 'abc' }).configured).toBe(true)
  })

  it('键在值类型不符仍计 true，且解析回落默认值', () => {
    const { config, configured } = resolveRetryConfig({ maxRetries: 'abc', enabled: 1 })
    expect(configured).toBe(true)
    expect(config.maxRetries).toBe(3)
    expect(config.enabled).toBe(true)
  })
})
describe('resolveRetryConfig · 缺省合并 pi 默认（D7）', () => {
  it('完整合法配置原样返回（含 timeoutMs 出键条件）', () => {
    const { config } = resolveRetryConfig({
      enabled: false,
      maxRetries: 10,
      baseDelayMs: 5000,
      provider: { maxRetryDelayMs: 1800000 },
    })
    expect(config).toEqual({
      enabled: false,
      maxRetries: 10,
      baseDelayMs: 5000,
      provider: { maxRetries: 0, maxRetryDelayMs: 1800000 },
    })
    expect('timeoutMs' in config.provider!).toBe(false)
  })

  it('timeoutMs 数值存在时出现在合并结果（含超域存量值原样返回）', () => {
    const { config } = resolveRetryConfig({ provider: { timeoutMs: 700000 } })
    expect(config.provider!.timeoutMs).toBe(700000)
  })

  it('provider.timeoutMs=0 → 读侧清为未设（写侧必拒值，往返对称成立：resolved 不含该键回落默认）', () => {
    const { config, configured } = resolveRetryConfig({ provider: { timeoutMs: 0 } })
    // configured 仍 true：键在即「文件里有显式配置意图」（`in` 判定），值回落不改判定
    expect(configured).toBe(true)
    expect('timeoutMs' in config.provider!).toBe(false)
  })
})
describe('mergeRetryConfig · D3 嵌套 merge 纯函数', () => {
  it('null（缺省）→ 仅含已知键的新对象', () => {
    const merged = mergeRetryConfig(null, { ...VALID, provider: { maxRetries: 1 } })
    expect(merged).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { maxRetries: 1 } })
  })

  it('数组坏值 → 整体替换，不产生索引键垃圾', () => {
    const merged = mergeRetryConfig([1, 2], VALID)
    expect(merged).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: {} })
    expect(Object.keys(merged).some(k => /^\d+$/.test(k))).toBe(false)
  })

  it('未知子字段保留，未设 provider 键删键', () => {
    const merged = mergeRetryConfig(
      { future: 'x', provider: { futureSub: 9, timeoutMs: 30000 } },
      VALID,
    ) as { future: string; provider: Record<string, unknown> }
    expect(merged.future).toBe('x')
    expect(merged.provider.futureSub).toBe(9)
    expect(merged.provider.timeoutMs).toBeUndefined()
  })
})
describe('validateRetryConfigForWrite · 校验失败透传（D8）', () => {
  it('合法配置通过', () => {
    expect(validateRetryConfigForWrite({ ...VALID, provider: { timeoutMs: 1, maxRetries: 10, maxRetryDelayMs: 0 } })).toEqual({ ok: true })
  })

  it('越界值失败且错误信封含字段名/范围/当前值', () => {
    const result = validateRetryConfigForWrite({ ...VALID, maxRetries: 21 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('maxRetries')
      expect(result.error).toContain('0-20')
      expect(result.error).toContain('21')
    }
  })

  it('provider.maxRetryDelayMs 落入 (0,1000) 空档拒绝', () => {
    const result = validateRetryConfigForWrite({ ...VALID, provider: { maxRetryDelayMs: 500 } })
    expect(result.ok).toBe(false)
  })
})
});
});

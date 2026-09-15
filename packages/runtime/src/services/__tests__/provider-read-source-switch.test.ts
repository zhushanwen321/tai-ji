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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import { TaijiProviderStore, type ProviderExtrasFile } from '../provider-extras-store.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'

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

/**
 * listProviders 聚合 ⊕ 远程目录 overlay 集成测试（settings-provider 页进入时刷新链路）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-catalog-overlay.test.ts
 *
 * 策略：同 config-service-listproviders.test.ts 的 makeService fixture + TAIJI_AGENT_DATA_DIR
 * stub 到临时目录写入 overlay 缓存，断言 merge 语义（新 id 追加 / 同 id overlay 覆盖 /
 * override 用户定义最高优先 / staleness 过滤）。merge 点在 provider-config-helper
 * catalog 分支（getCatalogOverlayModels 注入）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import type { IConfigStore, ConfigModelsConfig } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'
import builtinData from '../../generated/builtin-providers.json'

const GENERATED_AT = (builtinData as { catalogGeneratedAt?: number }).catalogGeneratedAt ?? 0

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'overlay-integration-'))
  mkdirSync(join(dataDir, 'agent'), { recursive: true })
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

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

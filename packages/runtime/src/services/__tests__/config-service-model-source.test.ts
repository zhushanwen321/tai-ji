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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'

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
    // 真实 builtin 副本非空（防御生成物损坏导致的假通过）
    expect(models.map(m => m.id)).toContain('glm-5.2')
  })
})

describe('B-2：catalog provider 有 override models → 混合列表逐条标注', () => {
  it('新增 id + 同 id 替换：override 条目（含覆盖 builtin 同 id 的）标 override，其余标 builtin，同 id 不重复', () => {
    writeModelsJson({
      'zai-coding-cn': {
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        models: [
          // 同 id 替换 builtin 的 glm-5.2（用户覆写 contextWindow）
          { id: 'glm-5.2', name: 'GLM 5.2 (custom)', contextWindow: 111000 },
          // 新增自定义模型（builtin 无此 id）
          { id: 'glm-my-alias', name: 'My Alias', contextWindow: 200000 },
        ],
      },
    })

    const models = providerModels(makeSvc(), 'zai-coding-cn')
    const bySource = (s: 'builtin' | 'override') => models.filter(m => m.source === s).map(m => m.id)

    // override 两条均标 'override'——同 id 被 override 替换的也标 'override'（已被用户定义覆盖）
    expect(bySource('override')).toEqual(['glm-5.2', 'glm-my-alias'])
    // 其余 builtin 条目标 'builtin'（混合列表：override 存在时未被覆盖的内置条目仍在，
    // 对齐 pi 真实行为 design D1 探针——旧「override 非空即整体替换」与 pi 漂移）
    expect(bySource('builtin')).not.toContain('glm-5.2')
    expect(bySource('builtin')).toContain('glm-5-turbo')
    expect(bySource('builtin')).toContain('glm-4.7')
    // 同 id 不重复出现（覆盖而非并列）
    expect(models.filter(m => m.id === 'glm-5.2')).toHaveLength(1)
    // 覆盖条目取 override 定义值
    const overridden = models.find(m => m.id === 'glm-5.2')!
    expect(overridden.name).toBe('GLM 5.2 (custom)')
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

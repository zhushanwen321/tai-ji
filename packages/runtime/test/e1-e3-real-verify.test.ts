/**
 * E1/E3 real 层验证（CW test gate）。
 * 用真实 ConfigService + PiConfigStore 指向 mkdtemp 自建夹具（不依赖本机真实数据目录），
 * 验证 setProvider/setDefaultModel 后文件落盘。
 *
 * E1 已按设计 D1③ 分体系对齐（原设计文档已删除、git 可追溯）：catalog
 * provider 的 provider 级 `type` 被忽略（协议是模型级属性，provider 级 api 对 catalog 无用户语义），
 * 只有 custom provider 的 provider 级 api 才落盘——故 E1 显式按 kind 选取被测 provider 并给不同期望。
 * E2（toggleProviderEnabled → enabledModels 白名单落盘）的断言由 config-service.test.ts U2 承载，不在此重复。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigService } from '../src/services/config-service.js'
import { AuthStorage } from '../src/services/auth/auth-storage.js'
import { ProviderCredentialResolver } from '../src/services/auth/provider-credential-resolver.js'
import type { ProviderId } from '@taiji/shared'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import {
  setModelsPath,
  refreshModels,
  readModels,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath, readSettings } from '../src/infra/pi/pi-settings-store.js'

let fixtureDir: string
let fixtureConfigService: ConfigService

/** E1 的「反向 api」构造：保证新值与当前展示值必不相同（否则断言可能恒真）。 */
function oppositeApi(current: string | undefined): string {
  return current === 'anthropic-messages' ? 'openai-completions' : 'anthropic-messages'
}

/**
 * E1 分体系断言单点（设计 D1③）——始终做真实落盘读取（readModels，绕过缓存）：
 * - custom：provider 级 api 是 custom 的定义权威 → 新值落到 listProviders 与 models.json；
 * - catalog：provider 级 `type` 被忽略（协议是模型级属性）→ 盘上 api 键保持原状（无键仍无键 /
 *   有旧值仍为旧值），派生展示（listProviders().api）保持原状且不等于新传入值。
 */
function assertApiTypeByKind(service: ConfigService, kind: 'custom' | 'catalog', providerId: string): void {
  const before = service.listProviders().find(p => p.id === providerId)
  if (!before) throw new Error(`被测 ${kind} provider 不在 listProviders() 结果中：${providerId}`)
  const newApi = oppositeApi(before.api)
  const rawBefore = readModels().providers[providerId]?.api

  // 无 await 分支（本用例不传 apiKey/models/authMethod）时 setProvider 同步执行到底，
  // 调用后即可读到落盘结果——依赖 setProvider 的同步前缀时序契约（见其实现注释）。
  service.setProvider(providerId, { type: newApi })

  const after = service.listProviders().find(p => p.id === providerId)!
  const rawAfter = readModels().providers[providerId]?.api

  if (kind === 'custom') {
    expect(after.api).toBe(newApi)
    expect(rawAfter).toBe(newApi)
  } else {
    expect(after.api).toBe(before.api)
    expect(after.api).not.toBe(newApi)
    expect(rawAfter).toBe(rawBefore)
    expect(rawAfter).not.toBe(newApi)
  }
}

/**
 * 自建 fixture（不依赖真实数据目录）：覆盖 E1 的 custom + catalog 两分支与 E3 的默认模型落盘。
 *
 * mkdtemp 自建 models.json（custom 1 个 + catalog 2 个变体）保证两分支可执行证据完整：
 * catalog「无 api 键」与「有旧 api 键」两种落盘形态都断言。写删全部落在 mkdtemp
 * 临时目录内（fs-guard 白名单），不碰真实数据目录。
 */
describe('E1/E3 分体系 real 层持久化（自建 fixture）', () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'e1-kind-fixture-'))
    const piAgentDir = join(fixtureDir, 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    const providers = {
      // catalog（id 命中内置快照），override 无 provider 级 api 键
      anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', models: [] },
      // catalog + 既有 provider 级 api 键（历史冻结值形态）
      openai: { name: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', models: [] },
      // custom（id 不在内置快照）：provider 级 api 是定义权威
      'fixture-custom': {
        name: 'Fixture Custom',
        api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'sk-fixture',
        models: [{ id: 'fixture-model', name: 'Fixture Model' }],
      },
    }
    writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
    writeFileSync(join(piAgentDir, 'settings.json'), '{}')

    setModelsPath(join(piAgentDir, 'models.json'))
    setSettingsPath(join(piAgentDir, 'settings.json'))
    refreshModels()
    const fixtureStore = new PiConfigStore()
    fixtureConfigService = new ConfigService(
      fixtureDir,
      fixtureStore,
      undefined,
      undefined,
      undefined,
      // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（auth.json 腿指向临时目录，
      // 恒 miss；models.json 腿经真 PiConfigStore 读 fixture）
      new ProviderCredentialResolver({
        authService: { getCredential: async () => undefined },
        authStorage: new AuthStorage(join(piAgentDir, 'auth.json')),
        configStore: fixtureStore,
      }),
    )

    // fixture 前提自检：kind 判定符合构造意图，否则下面的分体系断言无意义
    const kinds = new Map(fixtureConfigService.listProviders().map(p => [p.id as string, p.kind]))
    expect(kinds.get('anthropic')).toBe('catalog')
    expect(kinds.get('openai')).toBe('catalog')
    expect(kinds.get('fixture-custom')).toBe('custom')
  })

  afterAll(() => {
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('E1-fixture/custom: provider 级 api 是 custom 的定义权威 → models.json 落盘新值', () => {
    assertApiTypeByKind(fixtureConfigService, 'custom', 'fixture-custom')
  })

  it('E1-fixture/catalog: provider 级 type 被忽略 → 盘上 api 键保持原状（无键仍无键 / 旧值仍旧值）', () => {
    // 变体一：无 api 键 → 落盘后仍无该键
    assertApiTypeByKind(fixtureConfigService, 'catalog', 'anthropic')
    expect((readModels().providers.anthropic ?? {}) as Record<string, unknown>).not.toHaveProperty('api')

    // 变体二：既有 api 键 → 保持旧值，不被新传入的 type 覆盖
    assertApiTypeByKind(fixtureConfigService, 'catalog', 'openai')
    expect(readModels().providers.openai?.api).toBe('openai-completions')
  })

  it('E3-fixture: setDefaultModel → settings.json 落盘 defaultProvider/defaultModel', () => {
    fixtureConfigService.setDefaultModel('fixture-custom' as ProviderId, 'fixture-model')

    // 直接读盘验证（绕过缓存）：defaultProvider/defaultModel 双键落盘
    const settings = readSettings()
    expect(settings.defaultProvider).toBe('fixture-custom')
    expect(settings.defaultModel).toBe('fixture-model')
  })
})

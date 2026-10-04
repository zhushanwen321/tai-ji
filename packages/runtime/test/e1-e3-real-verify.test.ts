/**
 * E1-E3 real 层验证（CW test gate）。
 * 用真实 ConfigService + PiConfigStore 指向 dev 数据的副本，验证 setProvider/setDefaultModel 后文件落盘。
 * 跑完即清理，不污染 dev 数据。
 *
 * E1 已按设计 D1③ 分体系对齐（原设计文档已删除、git 可追溯）：catalog
 * provider 的 provider 级 `type` 被忽略（协议是模型级属性，provider 级 api 对 catalog 无用户语义），
 * 只有 custom provider 的 provider 级 api 才落盘——故 E1 显式按 kind 选取被测 provider 并给不同期望，
 * 不再依赖 listProviders() 的数组顺序。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

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

const DEV_MODELS = join(homedir(), '.taiji-dev/agent/models.json')
const DEV_SETTINGS = join(homedir(), '.taiji-dev/agent/settings.json')

// 跳过条件：dev 无 models.json 或 providers 空。CI 无 dev 文件 → 跳过；
// 本地 dev providers 空（如未配置 provider）→ 也跳过，否则 listProviders()
// 返回 [] 会让 E1/E3 的按 kind 选取与 modelId 取值落空（测试设计缺陷修复）。
function devHasProviders(): boolean {
  if (!existsSync(DEV_MODELS)) return false
  try {
    const raw = JSON.parse(readFileSync(DEV_MODELS, 'utf8'))
    return Object.keys(raw?.providers ?? {}).length > 0
  } catch {
    return false
  }
}
const HAS_DEV_PROVIDERS = devHasProviders()

let tmpDir: string
let configService: ConfigService
let configStore: PiConfigStore
let subjectProviderId: string
let subjectModelId: string | undefined

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

beforeAll(() => {
  // 跳过条件：dev 无可用 provider 数据（providers 空）
  if (!HAS_DEV_PROVIDERS) return

  tmpDir = mkdtempSync(join(tmpdir(), 'e1-e3-real-'))
  const piAgentDir = join(tmpDir, 'agent')
  mkdirSync(piAgentDir, { recursive: true })
  copyFileSync(DEV_MODELS, join(piAgentDir, 'models.json'))
  if (existsSync(DEV_SETTINGS)) copyFileSync(DEV_SETTINGS, join(piAgentDir, 'settings.json'))

  setModelsPath(join(piAgentDir, 'models.json'))
  setSettingsPath(join(piAgentDir, 'settings.json'))
  refreshModels()

  configStore = new PiConfigStore()
  // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（auth.json 腿指向临时目录——
  // dev 副本未拷贝 auth.json，恒 miss；models.json 腿经真 PiConfigStore 读副本）
  configService = new ConfigService(
    tmpDir,
    configStore,
    undefined,
    undefined,
    undefined,
    new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: new AuthStorage(join(piAgentDir, 'auth.json')),
      configStore,
    }),
  )

  // E2/E3 的被测 provider：按 id 排序后取第一个「有模型」者（E3 需要 modelId）——
  // 排序 + 显式过滤消除原先 providers[0] 的偶然顺序依赖，测试意图不变。
  const providers = configService.listProviders()
  const sorted = [...providers].sort((a, b) => a.id.localeCompare(b.id))
  const subject = sorted.find(p => (p.models?.length ?? 0) > 0) ?? sorted[0]
  subjectProviderId = subject?.id ?? ''
  subjectModelId = subject?.models?.[0]?.id
})

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe.skipIf(!HAS_DEV_PROVIDERS)('E1-E3 real 层持久化验证', () => {
  it('E1: setProvider 改 api 类型 → 按 kind 分体系落盘（custom 落盘 api / catalog 忽略 type）', () => {
    const providers = configService.listProviders()
    const custom = providers.find(p => p.kind === 'custom')
    const catalog = providers.find(p => p.kind === 'catalog')

    // 两种 provider 都不存在（dev 数据异常）→ 按既有提前 return 模式跳过。
    // HAS_DEV_PROVIDERS 已保证 providers 非空；此处为纵深防御：非空但既无 custom 也无
    // catalog 属聚合层异常，跳过并说明理由，不抛 TypeError。
    if (!custom && !catalog) return

    // dev 数据有 custom 时覆盖「provider 级 api 落盘」；无 custom 时该分支由下方 fixture 覆盖。
    if (custom) assertApiTypeByKind(configService, 'custom', custom.id)
    if (catalog) assertApiTypeByKind(configService, 'catalog', catalog.id)
  })

  it('E2: toggleProviderEnabled(false) → settings.json enabledModels 落盘 + listProviders 派生 enabled=false', () => {
    // wave3 C5/TC6：setProvider 不再写 provider 级 enabled——provider 启停由 enabledModels
    // 白名单承载（listProviders 经 deriveEnabled 派生）。空白名单 = 全启用且 toggle(false)
    // 幂等 no-op（设计内，config-service-toggle.test TC2），故先显式构造多 pattern 白名单。
    const other = configService.listProviders().find(p => p.id !== subjectProviderId)
    if (!other) return // dev 单 provider：无法构造非末位白名单，跳过（对齐 E3 跳过模式）

    configStore.setEnabledModels([`${subjectProviderId}/*`, `${other.id}/*`])
    expect(configService.listProviders().find(p => p.id === subjectProviderId)!.enabled).toBe(true)

    configService.toggleProviderEnabled(subjectProviderId, false)

    const afterProvider = configService.listProviders().find(p => p.id === subjectProviderId)!
    expect(afterProvider.enabled).toBe(false)

    // 直接读盘验证（绕过缓存）：白名单不再含 subjectProviderId 的 pattern
    const settings = readSettings()
    expect(settings.enabledModels).toEqual([`${other.id}/*`])

    // 恢复（清白名单 = 回到全启用）
    configStore.clearEnabledModels()
  })

  it('E3: setDefaultModel → settings.json 落盘 defaultProvider/defaultModel', () => {
    if (!subjectModelId) return // provider 无 model，跳过

    configService.setDefaultModel(subjectProviderId as ProviderId, subjectModelId)

    const settings = readSettings()
    expect(settings.defaultProvider).toBe(subjectProviderId)
    expect(settings.defaultModel).toBe(subjectModelId)
  })
})

/**
 * 自建 fixture（不依赖 dev 数据）：覆盖 E1 的 custom + catalog 两分支。
 *
 * 真跑路径（上面的 dev 副本 describe）可能只有 catalog provider（或只有 custom），缺失的那一支
 * 断言会整体缺席；本 describe 用 mkdtemp 自建 models.json（custom 1 个 + catalog 2 个变体）补齐
 * 两分支可执行证据：catalog「无 api 键」与「有旧 api 键」两种落盘形态都断言。
 * 写删全部落在 mkdtemp 临时目录内（fs-guard 白名单），不碰真实数据目录。
 */
describe('E1 分体系（D1③）· 自建 fixture（custom 落盘 api / catalog 忽略 type）', () => {
  let fixtureDir: string
  let fixtureConfigService: ConfigService

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
})

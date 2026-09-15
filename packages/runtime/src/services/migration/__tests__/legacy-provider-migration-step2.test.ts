/**
 * step2 provider 级 enabled → enabledModels 白名单迁移测试（wave5 TC1-7）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/legacy-provider-migration-step2.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 pi-provider-store-finddefault.test.ts 同模式。验证 settings.json（enabledModels 有无）+
 * models.json（provider enabled 字段删除 + model.enabled 保留）物理状态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateProviderEnabledToWhitelist,
  migrateProviderConfig,
} from '../legacy-provider-migration.js'
import { setModelsPath } from '../../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { deriveEnabled } from '../../provider-catalog.js'
import { findValidDefaultModel } from '../../../infra/pi/pi-provider-store.js'
import { AuthStorage, type CredentialWriter } from '../../auth/auth-storage.js'

/** 轻量 credentialWriter adapter（与生产等价：AuthService.saveCredential 内部即 authStorage.set）。 */
function makeCredentialWriter(authStorage: AuthStorage): CredentialWriter {
  return { saveCredential: (id, cred) => authStorage.set(id, cred) }
}

let dir: string
let agentDir: string

/** 真实结构：<dataDir>/agent/（getPiAgentDir = getConfigDir()/agent） */
function realAgentDir(): string {
  return join(dir, 'agent')
}

/** 写 models.json。providers 形如 { openai: { enabled: true, ... } }。 */
function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

/** 读 models.json 原文（断言物理状态）。 */
function readModelsRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8'))
}

/** 读 settings.json 原文（断言物理状态）。文件不存在返回 null。 */
function readSettingsRaw(): Record<string, unknown> | null {
  const p = join(agentDir, 'settings.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}

/** 写 settings.json（可选 defaultProvider/defaultModel/enabledModels）。 */
function writeSettings(opts: { defaultProvider?: string; defaultModel?: string; enabledModels?: string[] } = {}): void {
  const s: Record<string, unknown> = {}
  if (opts.defaultProvider) s.defaultProvider = opts.defaultProvider
  if (opts.defaultModel) s.defaultModel = opts.defaultModel
  if (opts.enabledModels) s.enabledModels = opts.enabledModels
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(s, null, 2))
}

function writeAuth(credentials: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(credentials, null, 2))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-migration-step2-'))
  agentDir = realAgentDir()
  mkdirSync(agentDir, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  writeAuth({})
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('TC1: step2 部分禁用 → enabledModels = enabled providers 的 <id>/*', () => {
  it('迁移：enabledModels=[openai/*, custom-x/*]；anthropic 不含；deriveEnabled 反映启用状态', async () => {
    writeModels({
      openai: { enabled: true, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: false, models: [{ id: 'claude-3' }] },
      'custom-x': { enabled: true, models: [{ id: 'cx-1' }] },
    })

    const report = await migrateProviderEnabledToWhitelist(new PiConfigStore())

    expect(report.migratedEnabled).toBe(true)
    expect(report.fullDisabledWarn).toBeUndefined()

    // settings.json 物理状态：enabledModels 含 openai/custom-x，不含 anthropic
    const settings = readSettingsRaw()
    expect(settings?.enabledModels).toEqual(['openai/*', 'custom-x/*'])

    // deriveEnabled 反映启用状态（listProviders 的 provider 启用判定同源）
    const whitelist = settings!.enabledModels as string[]
    expect(deriveEnabled('openai', whitelist)).toBe(true)
    expect(deriveEnabled('custom-x', whitelist)).toBe(true)
    expect(deriveEnabled('anthropic', whitelist)).toBe(false)
  })
})

describe('TC2: step2 全 enabled（无禁用）→ no-op（不设白名单，保持全可用）', () => {
  it('迁移：enabledModels 不设（无此字段）；删 provider 级 enabled 字段；全可用', async () => {
    writeModels({
      openai: { enabled: true, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })

    const report = await migrateProviderEnabledToWhitelist(new PiConfigStore())

    expect(report.migratedEnabled).toBe(true)
    expect(report.fullDisabledWarn).toBeUndefined()

    // settings.json：enabledModels 字段未设（保持「无白名单=全可用」语义，CL1）
    const settings = readSettingsRaw()
    expect(settings?.enabledModels).toBeUndefined()

    // models.json：provider 级 enabled 字段已删
    const models = readModelsRaw()
    const providers = models.providers as Record<string, Record<string, unknown>>
    expect('enabled' in providers.openai).toBe(false)
    expect('enabled' in providers.anthropic).toBe(false)

    // 全可用：白名单未设 → deriveEnabled 全 true
    const whitelist = settings?.enabledModels as string[] | undefined
    expect(deriveEnabled('openai', whitelist)).toBe(true)
    expect(deriveEnabled('anthropic', whitelist)).toBe(true)
  })
})

describe('TC3: step2 全 disabled → 删字段 + warn（ES4 空数组守卫）', () => {
  it('迁移：clearEnabledModels（非空数组）+ fullDisabledWarn；迁移后全可用', async () => {
    writeModels({
      openai: { enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: false, models: [{ id: 'claude-3' }] },
    })

    const report = await migrateProviderEnabledToWhitelist(new PiConfigStore())

    expect(report.migratedEnabled).toBe(true)
    expect(report.fullDisabledWarn).toBe(true)

    // settings.json：enabledModels 字段删除（非空数组），pi 白名单语义空=全可用
    const settings = readSettingsRaw()
    expect(settings?.enabledModels).toBeUndefined()

    // 迁移后全可用（pi 契约硬限制：不支持全禁用）
    const whitelist = settings?.enabledModels as string[] | undefined
    expect(deriveEnabled('openai', whitelist)).toBe(true)
    expect(deriveEnabled('anthropic', whitelist)).toBe(true)
  })
})

describe('TC4: step2 删 provider 级 enabled 字段（model.enabled 保留）', () => {
  it('迁移：openai 无 enabled 字段；models[0].enabled=false 保留', async () => {
    writeModels({
      openai: {
        enabled: true,
        models: [{ id: 'gpt-4', enabled: false }, { id: 'gpt-3.5' }],
      },
      anthropic: { enabled: false, models: [{ id: 'claude-3' }] },
    })

    await migrateProviderEnabledToWhitelist(new PiConfigStore())

    const models = readModelsRaw()
    const openai = (models.providers as Record<string, Record<string, unknown>>).openai as Record<string, unknown>
    // provider 级 enabled 已删
    expect('enabled' in openai).toBe(false)
    // model 级 enabled 保留不动（pi 原生消费）
    const modelList = openai.models as Array<Record<string, unknown>>
    expect(modelList[0].enabled).toBe(false)
    expect('enabled' in modelList[1]).toBe(false)
  })
})

describe('TC5: step2 defaultModel 重选（迁移后 default 落白名单外 → 运行时兜底）', () => {
  it('default=openai/gpt-4，迁移后 openai 被禁用 → findValidDefaultModel 重选为启用的 provider', async () => {
    writeModels({
      openai: { enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })
    // 迁移前 default 落在被禁用的 openai
    writeSettings({ defaultProvider: 'openai', defaultModel: 'gpt-4' })

    await migrateProviderEnabledToWhitelist(new PiConfigStore())

    // settings.json：enabledModels = ['anthropic/*']（openai 被禁用）
    const settings = readSettingsRaw()
    expect(settings?.enabledModels).toEqual(['anthropic/*'])

    // CL2：step2 不主动重选 default，依赖运行时 findValidDefaultModel 兜底。
    // 迁移后 openai 落白名单外——findValidDefaultModel 不会选 openai（被 enabledModels 过滤）。
    // 此处验证 default 字段未被 step2 改写（CL2 决策），仍为迁移前值。
    expect(settings?.defaultProvider).toBe('openai')
    expect(settings?.defaultModel).toBe('gpt-4')

    // A8：findValidDefaultModel 主路径 + fallback（pickFirstModelProvider）均过滤 enabledModels——
    // openai 被禁用，主路径守卫跳过，fallback 选启用的 anthropic/claude-3，wasFixed=true（重选写回）。
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('anthropic')
    expect(r.result!.modelId).toBe('claude-3')
    expect(r.wasFixed).toBe(true)
  })

  it('default 落在已删除 provider（迁移前 models.json 无该 provider）→ findValidDefaultModel 重选', async () => {
    writeModels({
      openai: { enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })
    // default 指向不存在的 provider（已删/已迁移）
    writeSettings({ defaultProvider: 'deleted-provider', defaultModel: 'old-model' })

    await migrateProviderEnabledToWhitelist(new PiConfigStore())

    // settings.json：enabledModels = ['anthropic/*']
    expect(readSettingsRaw()?.enabledModels).toEqual(['anthropic/*'])

    // findValidDefaultModel 兜底重选（pickFirstModelProvider 不感知 enabledModels，
    // 选 models.json 第一个有 model 的 provider；此处验证兜底机制存在，不要求过滤）
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.wasFixed).toBe(true)
  })
})

describe('TC6: step2 幂等（无 provider 级 enabled 字段时 no-op）', () => {
  it('已迁移过（无 enabled 字段）→ 完全 no-op，不读不写 settings.json', async () => {
    // models.json 无 provider 级 enabled 字段
    writeModels({
      openai: { models: [{ id: 'gpt-4' }] },
      anthropic: { models: [{ id: 'claude-3' }] },
    })
    // 不写 settings.json（文件不存在）

    const report = await migrateProviderEnabledToWhitelist(new PiConfigStore())

    expect(report.migratedEnabled).toBe(false)
    expect(report.fullDisabledWarn).toBeUndefined()

    // settings.json 仍不存在（未触发任何写）
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)
  })

  it('已迁移过 + settings.json 已有 enabledModels → 不改写 enabledModels', async () => {
    writeModels({
      openai: { models: [{ id: 'gpt-4' }] },
    })
    // settings.json 已有用户后来配置的白名单（不是迁移产生的）
    writeSettings({ enabledModels: ['openai/*'] })

    const report = await migrateProviderEnabledToWhitelist(new PiConfigStore())

    expect(report.migratedEnabled).toBe(false)
    // settings.json enabledModels 不变（未被 step2 改写）
    expect(readSettingsRaw()?.enabledModels).toEqual(['openai/*'])
  })
})

describe('TC7: 编排 migrateProviderConfig（调 step1 + step2）', () => {
  it('models.json 有 catalog 错位 apiKey + provider 级 enabled → 两步都迁', async () => {
    // openai 是 catalog provider（isCatalogProvider 查 builtin-providers.json），有 apiKey + baseUrl + enabled。
    // baseUrl 触发 step1 hasOverride 分支（保留 rest 含 enabled/models，只删 apiKey）。
    // anthropic 是 catalog provider，enabled:false（部分禁用场景）。
    writeModels({
      openai: { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', enabled: true, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: false, models: [{ id: 'claude-3' }] },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    // step1：openai apiKey 迁 auth.json（hasOverride 分支保留其余字段）
    expect(report.catalog.migrated).toContain('openai')
    // step2：有 disabled（anthropic）→ enabledModels = ['openai/*']
    expect(report.enabled.migratedEnabled).toBe(true)
    expect(report.enabled.fullDisabledWarn).toBeUndefined()

    // settings.json：enabledModels = ['openai/*']
    expect(readSettingsRaw()?.enabledModels).toEqual(['openai/*'])

    // models.json：openai 的 apiKey 已删（step1），enabled 已删（step2），baseUrl/models 保留
    const models = readModelsRaw()
    const openai = (models.providers as Record<string, Record<string, unknown>>).openai as Record<string, unknown>
    expect(openai.apiKey).toBeUndefined()
    expect('enabled' in openai).toBe(false)
    expect(openai.baseUrl).toBe('https://api.openai.com/v1')
    expect((openai.models as unknown[]).length).toBe(1)

    // auth.json：openai apiKey 已迁入
    const auth = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf-8'))
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })

  it('迁移失败不阻断启动：step1 内部错误时 step2 仍执行', async () => {
    writeModels({
      openai: { enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })
    // 故意用不存在的 auth.json 路径构造 AuthStorage（get 抛错被 step1 try/catch，
    // 但不影响 step2 执行）
    const authStorage = new AuthStorage(join(agentDir, 'nonexistent', 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    // step2 仍执行：全 disabled 检测？不是——有一个 enabled (anthropic)
    // → enabledModels = ['anthropic/*']
    expect(report.enabled.migratedEnabled).toBe(true)
    expect(readSettingsRaw()?.enabledModels).toEqual(['anthropic/*'])
  })

  it('无 catalog apiKey + 无 provider enabled → 两步全 no-op', async () => {
    writeModels({
      'custom-only': { baseUrl: 'https://x', models: [{ id: 'm1' }] },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    // step1：custom-only 非 catalog → kept，不迁
    expect(report.catalog.migrated).toEqual([])
    expect(report.catalog.kept).toContain('custom-only')
    // step2：无 provider enabled 字段 → no-op
    expect(report.enabled.migratedEnabled).toBe(false)
    // settings.json 未写（两步全 no-op）
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)
  })

  it('MF1（exec-review must-fix）：catalog+apiKey+enabled+无override → step2 先确保 enabled 不丢', async () => {
    // G5 核心场景：catalog provider openai 有错位 apiKey + enabled:false + 无 override（用户填 key + 禁用 + 没改 baseUrl）。
    // 旧编排（step1 先）：step1「写最小条目」丢 enabled → step2 读不到 → openai 启停丢失（变全可用）。
    // MF1 修复（step2 先）：step2 先读 enabled 迁 enabledModels → step1 后处理 apiKey（不影响 settings.json）。
    writeModels({
      openai: { apiKey: 'sk-test', enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    // step2 先迁：有 disabled（openai）→ enabledModels = ['anthropic/*']
    expect(report.enabled.migratedEnabled).toBe(true)
    expect(readSettingsRaw()?.enabledModels).toEqual(['anthropic/*'])
    // step1 后迁：openai apiKey 迁 auth.json
    expect(report.catalog.migrated).toContain('openai')
    // M5-04：openai 条目含 models（model 级配置）→ hasOverride=true，保留条目仅删 apiKey
    //（旧 A7 语义只认 baseUrl/compat/headers，含 models 条目整条删除会丢 model 级配置）。
    const openaiCfg = (readModelsRaw().providers as Record<string, Record<string, unknown>>).openai
    expect(openaiCfg).toBeDefined()
    expect(openaiCfg.apiKey).toBeUndefined()
    expect((openaiCfg.models as unknown[]).length).toBe(1)
    // G5 达成：openai 被正确禁用（enabledModels 不含 openai/*），deriveEnabled(openai)=false
    const whitelist = readSettingsRaw()?.enabledModels as string[]
    expect(deriveEnabled('openai', whitelist)).toBe(false)
    expect(deriveEnabled('anthropic', whitelist)).toBe(true)
  })
})

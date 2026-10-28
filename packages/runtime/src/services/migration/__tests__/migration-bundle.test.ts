import { PiConfigStore } from '../../../infra/pi/pi-config-store.js';
import { findValidDefaultModel, readSettings, setDefaultModel, setModelsPath } from '../../../infra/pi/pi-provider-store.js';
import { invalidateSettingsCache, setSettingsPath } from '../../../infra/pi/pi-settings-store.js';
import { AuthStorage, type CredentialWriter } from '../../auth/auth-storage.js';
import { deriveEnabled } from '../../provider-catalog.js';
import { TaijiProviderStore } from '../../provider-extras-store.js';
import { migrateLegacyProviderConfig, migrateProviderConfig, migrateProviderEnabledToWhitelist } from '../legacy-provider-migration.js';
import { parseClaudeProviders } from '../parsers/claude-parser.js';
import { parseCodexProviders } from '../parsers/codex-parser.js';
import { parsePiProviders } from '../parsers/pi-parser.js';
import { parseZcodeProviders } from '../parsers/zcode-parser.js';
import { migrateProviderExtras, readExtrasWithFallback } from '../provider-extras-migration.js';
import { parseProviders, type ParseResult } from '../provider-parser.js';
import type { ProviderId } from '@taiji/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/migration/__tests__/legacy-provider-migration-step1.test.ts
// ======================================================================

/**
 * 轻量 credentialWriter adapter：与生产等价（AuthService.saveCredential 内部就是
 * authStorage.set，A1-4 收敛只收调用点不改锁语义）。测试文件内直调 authStorage.set
 * 不违反收敛 grep（验收排除测试文件）。
 */
function makeCredentialWriter(authStorage: AuthStorage): CredentialWriter {
  return { saveCredential: (id, cred) => authStorage.set(id, cred) }
}


let dir: string

let agentDir: string


function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}


function readModelsRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8'))
}


function readAuthRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf-8'))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('legacy-provider-migration-step1', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-migration-step1-'))
  agentDir = join(dir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({}, null, 2))
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('M5-04: step1 hasOverride 判定含 models/quota（catalog 条目保留仅删 apiKey）', () => {
  it('catalog 条目含 models 无 baseUrl → 保留条目，仅删 apiKey，model 级 enabled 保留', async () => {
    writeModels({
      openai: { apiKey: 'sk-test', models: [{ id: 'gpt-4', enabled: false }] },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    expect(report.migrated).toContain('openai')
    // models.json：条目保留（hasOverride——models 属用户配置，删除即丢 model 级 enabled），
    // apiKey 删除，models 原样（model.enabled=false 保留，与 step2「model 级 enabled 保留」承诺一致）
    const openai = (readModelsRaw().providers as Record<string, Record<string, unknown>>).openai
    expect(openai).toBeDefined()
    expect(openai.apiKey).toBeUndefined()
    const models = openai.models as Array<Record<string, unknown>>
    expect(models[0].enabled).toBe(false)
    // auth.json：apiKey 已迁入
    expect(readAuthRaw().openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })

  it('catalog 条目含 quota 无 baseUrl → 保留条目，仅删 apiKey，quota 保留', async () => {
    writeModels({
      anthropic: { apiKey: 'sk-test', quota: { fetcher: 'custom', enabled: true } },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    expect(report.migrated).toContain('anthropic')
    const anthropic = (readModelsRaw().providers as Record<string, Record<string, unknown>>).anthropic
    expect(anthropic).toBeDefined()
    expect(anthropic.apiKey).toBeUndefined()
    expect(anthropic.quota).toEqual({ fetcher: 'custom', enabled: true })
  })

  it('回归：无 override（仅 apiKey）→ 整条删除（catalog 回退 builtin template）', async () => {
    writeModels({ openai: { apiKey: 'sk-test' } })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    expect(report.migrated).toContain('openai')
    // A7：removeProvider 删整个条目，catalog provider 回退 builtin template
    expect((readModelsRaw().providers as Record<string, unknown>).openai).toBeUndefined()
    // auth.json：apiKey 已迁入（迁移不因删条目而丢失凭据）
    expect(readAuthRaw().openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })
})
describe('step1 分支覆盖补充：OAuth 冲突 / auth 读失败 / 写失败', () => {
  it('OAuth 冲突：auth.json 已有 oauth 凭据 → skipped，models.json 条目不动，auth.json 不被覆盖', async () => {
    writeModels({ openai: { apiKey: 'sk-test' } })
    const authPath = join(agentDir, 'auth.json')
    writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'at', refresh: 'rt', expires: 123 } }))
    const authStorage = new AuthStorage(authPath)

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter(authStorage))

    expect(report.skipped).toContain('openai')
    expect(report.migrated).not.toContain('openai')
    // models.json 条目原样（apiKey 保留，等用户处理 OAuth 冲突）
    expect((readModelsRaw().providers as Record<string, unknown>).openai).toEqual({ apiKey: 'sk-test' })
    // auth.json 的 oauth 凭据未被 api_key 覆盖
    expect(readAuthRaw().openai).toMatchObject({ type: 'oauth' })
  })

  it('auth.json 读失败不阻断：get 抛错时继续迁移（warn + migrated）', async () => {
    writeModels({ openai: { apiKey: 'sk-test' } })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))
    const failingAuthStorage = {
      get: async () => {
        throw new Error('disk error')
      },
    } as unknown as AuthStorage

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), failingAuthStorage, makeCredentialWriter(authStorage))

    // OAuth 冲突检查跳过（warn），迁移照常执行
    expect(report.skipped).toEqual([])
    expect(report.migrated).toContain('openai')
    expect(readAuthRaw().openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })

  it('凭据写入失败 → failed + errors（reason 透传错误消息），models.json 条目不动', async () => {
    writeModels({ openai: { apiKey: 'sk-test' } })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))
    const throwingWriter: CredentialWriter = {
      saveCredential: async () => {
        throw new Error('boom')
      },
    }

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage, throwingWriter)

    expect(report.failed).toContain('openai')
    expect(report.errors).toContain('openai: boom')
    expect(report.migrated).not.toContain('openai')
    // models.json 条目保留（apiKey 未迁出，原样）
    expect((readModelsRaw().providers as Record<string, unknown>).openai).toEqual({ apiKey: 'sk-test' })
  })
})
});

// ======================================================================
// ← src/services/migration/__tests__/legacy-provider-migration-step2.test.ts
// ======================================================================

/** 轻量 credentialWriter adapter（与生产等价：AuthService.saveCredential 内部即 authStorage.set）。 */
function makeCredentialWriter_m2(authStorage: AuthStorage): CredentialWriter {
  return { saveCredential: (id, cred) => authStorage.set(id, cred) }
}


let dir_m2_m2_z2: string

let agentDir_m2_m2_z2: string


/** 真实结构：<dataDir>/agent/（getPiAgentDir = getConfigDir()/agent） */
function realAgentDir(): string {
  return join(dir_m2_m2_z2, 'agent')
}


/** 写 models.json。providers 形如 { openai: { enabled: true, ... } }。 */
function writeModels_m2(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir_m2_m2_z2, 'models.json'), JSON.stringify({ providers }, null, 2))
}


/** 读 models.json 原文（断言物理状态）。 */
function readModelsRaw_m2_m2_z2(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir_m2_m2_z2, 'models.json'), 'utf-8'))
}


/** 读 settings.json 原文（断言物理状态）。文件不存在返回 null。 */
function readSettingsRaw(): Record<string, unknown> | null {
  const p = join(agentDir_m2_m2_z2, 'settings.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}


/** 写 settings.json（可选 defaultProvider/defaultModel/enabledModels）。 */
function writeSettings(opts: { defaultProvider?: string; defaultModel?: string; enabledModels?: string[] } = {}): void {
  const s: Record<string, unknown> = {}
  if (opts.defaultProvider) s.defaultProvider = opts.defaultProvider
  if (opts.defaultModel) s.defaultModel = opts.defaultModel
  if (opts.enabledModels) s.enabledModels = opts.enabledModels
  writeFileSync(join(agentDir_m2_m2_z2, 'settings.json'), JSON.stringify(s, null, 2))
}


function writeAuth(credentials: Record<string, unknown>): void {
  writeFileSync(join(agentDir_m2_m2_z2, 'auth.json'), JSON.stringify(credentials, null, 2))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('legacy-provider-migration-step2', () => {
beforeEach(() => {
  dir_m2_m2_z2 = mkdtempSync(join(tmpdir(), 'legacy-migration-step2-'))
  agentDir_m2_m2_z2 = realAgentDir()
  mkdirSync(agentDir_m2_m2_z2, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir_m2_m2_z2
  setModelsPath(join(agentDir_m2_m2_z2, 'models.json'))
  setSettingsPath(join(agentDir_m2_m2_z2, 'settings.json'))
  invalidateSettingsCache()
  writeAuth({})
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir_m2_m2_z2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('TC1: step2 部分禁用 → enabledModels = enabled providers 的 <id>/*', () => {
  it('迁移：enabledModels=[openai/*, custom-x/*]；anthropic 不含；deriveEnabled 反映启用状态', async () => {
    writeModels_m2({
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
    writeModels_m2({
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
    const models = readModelsRaw_m2_m2_z2()
    const providers = models.providers as Record<string, Record<string, unknown>>
    expect('enabled' in providers.openai).toBe(false)
    expect('enabled' in providers.anthropic).toBe(false)

    // 全可用：白名单未设 → deriveEnabled 全 true
    const whitelist = settings?.enabledModels as string[] | undefined
    expect(deriveEnabled('openai', whitelist)).toBe(true)
    expect(deriveEnabled('anthropic', whitelist)).toBe(true)
  })
})
describe('TC3: step2 全 disabled → 删字段 + warn（ES4 空数组检查）', () => {
  it('迁移：clearEnabledModels（非空数组）+ fullDisabledWarn；迁移后全可用', async () => {
    writeModels_m2({
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
    writeModels_m2({
      openai: {
        enabled: true,
        models: [{ id: 'gpt-4', enabled: false }, { id: 'gpt-3.5' }],
      },
      anthropic: { enabled: false, models: [{ id: 'claude-3' }] },
    })

    await migrateProviderEnabledToWhitelist(new PiConfigStore())

    const models = readModelsRaw_m2_m2_z2()
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
    writeModels_m2({
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
    // openai 被禁用，主路径检查跳过，fallback 选启用的 anthropic/claude-3，wasFixed=true（重选写回）。
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('anthropic')
    expect(r.result!.modelId).toBe('claude-3')
    expect(r.wasFixed).toBe(true)
  })

  it('default 落在已删除 provider（迁移前 models.json 无该 provider）→ findValidDefaultModel 重选', async () => {
    writeModels_m2({
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
    writeModels_m2({
      openai: { models: [{ id: 'gpt-4' }] },
      anthropic: { models: [{ id: 'claude-3' }] },
    })
    // 不写 settings.json（文件不存在）

    const report = await migrateProviderEnabledToWhitelist(new PiConfigStore())

    expect(report.migratedEnabled).toBe(false)
    expect(report.fullDisabledWarn).toBeUndefined()

    // settings.json 仍不存在（未触发任何写）
    expect(existsSync(join(agentDir_m2_m2_z2, 'settings.json'))).toBe(false)
  })

  it('已迁移过 + settings.json 已有 enabledModels → 不改写 enabledModels', async () => {
    writeModels_m2({
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
    writeModels_m2({
      openai: { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', enabled: true, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: false, models: [{ id: 'claude-3' }] },
    })
    const authStorage = new AuthStorage(join(agentDir_m2_m2_z2, 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter_m2(authStorage))

    // step1：openai apiKey 迁 auth.json（hasOverride 分支保留其余字段）
    expect(report.catalog.migrated).toContain('openai')
    // step2：有 disabled（anthropic）→ enabledModels = ['openai/*']
    expect(report.enabled.migratedEnabled).toBe(true)
    expect(report.enabled.fullDisabledWarn).toBeUndefined()

    // settings.json：enabledModels = ['openai/*']
    expect(readSettingsRaw()?.enabledModels).toEqual(['openai/*'])

    // models.json：openai 的 apiKey 已删（step1），enabled 已删（step2），baseUrl/models 保留
    const models = readModelsRaw_m2_m2_z2()
    const openai = (models.providers as Record<string, Record<string, unknown>>).openai as Record<string, unknown>
    expect(openai.apiKey).toBeUndefined()
    expect('enabled' in openai).toBe(false)
    expect(openai.baseUrl).toBe('https://api.openai.com/v1')
    expect((openai.models as unknown[]).length).toBe(1)

    // auth.json：openai apiKey 已迁入
    const auth = JSON.parse(readFileSync(join(agentDir_m2_m2_z2, 'auth.json'), 'utf-8'))
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })

  it('迁移失败不阻断启动：step1 内部错误时 step2 仍执行', async () => {
    writeModels_m2({
      openai: { enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })
    // 故意用不存在的 auth.json 路径构造 AuthStorage（get 抛错被 step1 try/catch，
    // 但不影响 step2 执行）
    const authStorage = new AuthStorage(join(agentDir_m2_m2_z2, 'nonexistent', 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter_m2(authStorage))

    // step2 仍执行：全 disabled 检测？不是——有一个 enabled (anthropic)
    // → enabledModels = ['anthropic/*']
    expect(report.enabled.migratedEnabled).toBe(true)
    expect(readSettingsRaw()?.enabledModels).toEqual(['anthropic/*'])
  })

  it('无 catalog apiKey + 无 provider enabled → 两步全 no-op', async () => {
    writeModels_m2({
      'custom-only': { baseUrl: 'https://x', models: [{ id: 'm1' }] },
    })
    const authStorage = new AuthStorage(join(agentDir_m2_m2_z2, 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter_m2(authStorage))

    // step1：custom-only 非 catalog → kept，不迁
    expect(report.catalog.migrated).toEqual([])
    expect(report.catalog.kept).toContain('custom-only')
    // step2：无 provider enabled 字段 → no-op
    expect(report.enabled.migratedEnabled).toBe(false)
    // settings.json 未写（两步全 no-op）
    expect(existsSync(join(agentDir_m2_m2_z2, 'settings.json'))).toBe(false)
  })

  it('MF1（exec-review must-fix）：catalog+apiKey+enabled+无override → step2 先确保 enabled 不丢', async () => {
    // G5 核心场景：catalog provider openai 有错位 apiKey + enabled:false + 无 override（用户填 key + 禁用 + 没改 baseUrl）。
    // 旧编排（step1 先）：step1「写最小条目」丢 enabled → step2 读不到 → openai 启停丢失（变全可用）。
    // MF1 修复（step2 先）：step2 先读 enabled 迁 enabledModels → step1 后处理 apiKey（不影响 settings.json）。
    writeModels_m2({
      openai: { apiKey: 'sk-test', enabled: false, models: [{ id: 'gpt-4' }] },
      anthropic: { enabled: true, models: [{ id: 'claude-3' }] },
    })
    const authStorage = new AuthStorage(join(agentDir_m2_m2_z2, 'auth.json'))

    const report = await migrateProviderConfig(new PiConfigStore(), authStorage, makeCredentialWriter_m2(authStorage))

    // step2 先迁：有 disabled（openai）→ enabledModels = ['anthropic/*']
    expect(report.enabled.migratedEnabled).toBe(true)
    expect(readSettingsRaw()?.enabledModels).toEqual(['anthropic/*'])
    // step1 后迁：openai apiKey 迁 auth.json
    expect(report.catalog.migrated).toContain('openai')
    // M5-04：openai 条目含 models（model 级配置）→ hasOverride=true，保留条目仅删 apiKey
    //（旧 A7 语义只认 baseUrl/compat/headers，含 models 条目整条删除会丢 model 级配置）。
    const openaiCfg = (readModelsRaw_m2_m2_z2().providers as Record<string, Record<string, unknown>>).openai
    expect(openaiCfg).toBeDefined()
    expect(openaiCfg.apiKey).toBeUndefined()
    expect((openaiCfg.models as unknown[]).length).toBe(1)
    // G5 达成：openai 被正确禁用（enabledModels 不含 openai/*），deriveEnabled(openai)=false
    const whitelist = readSettingsRaw()?.enabledModels as string[]
    expect(deriveEnabled('openai', whitelist)).toBe(false)
    expect(deriveEnabled('anthropic', whitelist)).toBe(true)
  })
})
});

// ======================================================================
// ← src/services/migration/__tests__/provider-extras-migration.test.ts
// ======================================================================

let dir_m2_m2_z3: string

let agentDir_m2_m2_z3: string

let extrasStore: TaijiProviderStore

let configStore: PiConfigStore

let extrasPath: string


function writeModelsJson(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir_m2_m2_z3, 'models.json'), JSON.stringify({ providers }, null, 2))
}


function readModelsRaw_m2_m2_z3(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(agentDir_m2_m2_z3, 'models.json'), 'utf-8')).providers
}


function readExtrasRaw(): Record<string, unknown> {
  // 文件不存在 = 空扩展数据（TaijiProviderStore 读路径不物化文件）
  if (!existsSync(extrasPath)) return {}
  return JSON.parse(readFileSync(extrasPath, 'utf-8')).providers
}


function listBackupFiles(): string[] {
  if (!existsSync(agentDir_m2_m2_z3)) return []
  return readdirSync(agentDir_m2_m2_z3).filter(f => f.startsWith('models.json.bak-migrate-'))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-extras-migration', () => {
beforeEach(() => {
  dir_m2_m2_z3 = mkdtempSync(join(tmpdir(), 'provider-extras-migration-'))
  agentDir_m2_m2_z3 = join(dir_m2_m2_z3, 'agent')
  mkdirSync(join(agentDir_m2_m2_z3, 'config'), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir_m2_m2_z3
  setModelsPath(join(agentDir_m2_m2_z3, 'models.json'))
  setSettingsPath(join(agentDir_m2_m2_z3, 'settings.json'))
  invalidateSettingsCache()
  extrasPath = join(agentDir_m2_m2_z3, 'config', 'providers.json')
  extrasStore = new TaijiProviderStore(extrasPath)
  configStore = new PiConfigStore()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir_m2_m2_z3, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('A1-2 迁移主场景（验收 1）', () => {
  beforeEach(() => {
    writeModelsJson({
      // 完整寄生形态：provider 级 quota + authMethod + enabled + models[].enabled + 合法定义字段
      'zai-coding-cn': {
        name: 'Z.AI Coding CN',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKey: 'sk-keep-me',
        authMethod: 'api_key',
        enabled: false,
        quota: { fetcher: 'zhipu', enabled: true, cookieSet: true, apiKeySet: true },
        models: [
          { id: 'glm-5.3', name: 'GLM 5.3' },
          { id: 'glm-5.2', name: 'GLM 5.2', enabled: false },
        ],
      },
      // 无寄生字段的条目：完全不动
      'clean-provider': {
        baseUrl: 'https://api.example.com',
        models: [{ id: 'm1' }],
      },
      // name-only + quota 空壳条目（setProvider 仅传 quota/name 的历史真实形态）
      'ghost-shell': {
        name: 'Ghost Shell',
        quota: { fetcher: 'kimi', enabled: true, cookieSet: false },
      },
    })
  })

  it('models.json 剥离干净：quota/authMethod/enabled 字段消失、models[].enabled 消失、空壳条目消失', async () => {
    const report = await migrateProviderExtras(configStore, extrasStore)

    const providers = readModelsRaw_m2_m2_z3()
    // 空壳条目整条删除（pi 八字段全缺，剥离后 pi applyModelsJson 会 throw 的形态）
    expect(providers['ghost-shell']).toBeUndefined()
    expect(report.removedShells).toEqual(['ghost-shell'])

    const zai = providers['zai-coding-cn'] as Record<string, unknown>
    expect(zai.quota).toBeUndefined()
    expect(zai.authMethod).toBeUndefined()
    expect(zai.enabled).toBeUndefined()
    // pi schema 内字段保留不动
    expect(zai.name).toBe('Z.AI Coding CN')
    expect(zai.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(zai.apiKey).toBe('sk-keep-me')
    // models[].enabled 剥离（其余 model 字段保留）
    expect(zai.models).toEqual([
      { id: 'glm-5.3', name: 'GLM 5.3' },
      { id: 'glm-5.2', name: 'GLM 5.2' },
    ])

    // 无寄生字段的条目不进迁移列表
    expect(report.migrated).toContain('zai-coding-cn')
    expect(report.migrated).toContain('ghost-shell')
    expect(report.migrated).not.toContain('clean-provider')
    expect(providers['clean-provider']).toEqual({ baseUrl: 'https://api.example.com', models: [{ id: 'm1' }] })
  })

  it('providers.json 值完整：quota 含 cookieSet/apiKeySet 保真 + authMethod + modelStates', async () => {
    await migrateProviderExtras(configStore, extrasStore)

    const extras = readExtrasRaw()
    expect(extras['zai-coding-cn']).toEqual({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: true, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    })
    // 空壳条目的 quota 同样保入 providers.json（条目删除前先保数据）
    expect(extras['ghost-shell']).toEqual({
      quota: { fetcher: 'kimi', enabled: true, cookieSet: false },
    })
    // 文件结构含 version
    const file = JSON.parse(readFileSync(extrasPath, 'utf-8'))
    expect(file.version).toBe(1)
  })

  it('备份文件 models.json.bak-migrate-<ts> 存在且内容为迁移前原文，权限收紧 0600（RT-5#7）', async () => {
    const original = readFileSync(join(agentDir_m2_m2_z3, 'models.json'), 'utf-8')
    await migrateProviderExtras(configStore, extrasStore)

    const backups = listBackupFiles()
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(agentDir_m2_m2_z3, backups[0]), 'utf-8')).toBe(original)
    // 源文件可含明文 apiKey——副本权限不得比源文件宽松（RT-5#7 chmod 0600）
    expect(statSync(join(agentDir_m2_m2_z3, backups[0])).mode & 0o777).toBe(0o600)
  })
})
describe('A1-2 幂等（验收 1 后半）', () => {
  it('二次迁移 no-op：报告 noOp=true，models.json 与 providers.json 的 mtime 不变，无新备份', async () => {
    writeModelsJson({
      'zai-coding-cn': {
        baseUrl: 'https://x.example.com',
        authMethod: 'api_key',
        quota: { fetcher: 'zhipu', enabled: true },
        models: [{ id: 'glm-5.3', enabled: false }],
      },
    })

    const first = await migrateProviderExtras(configStore, extrasStore)
    expect(first.noOp).toBe(false)

    const modelsPath = join(agentDir_m2_m2_z3, 'models.json')
    const mTimeModels = statSync(modelsPath).mtimeMs
    const mTimeExtras = statSync(extrasPath).mtimeMs
    expect(listBackupFiles()).toHaveLength(1)

    // 等待文件系统时间戳精度（mtime 精度 ms 级，确保潜在写入会改变 mtime）
    await new Promise(r => setTimeout(r, 20))

    const second = await migrateProviderExtras(configStore, extrasStore)
    expect(second.noOp).toBe(true)
    expect(second.migrated).toEqual([])
    expect(statSync(modelsPath).mtimeMs).toBe(mTimeModels)
    expect(statSync(extrasPath).mtimeMs).toBe(mTimeExtras)
    expect(listBackupFiles()).toHaveLength(1)

    // 三次同样 no-op（持续幂等）
    const third = await migrateProviderExtras(configStore, extrasStore)
    expect(third.noOp).toBe(true)
  })
})
describe('A1-2 合并策略（验收 2）', () => {
  it('providers.json 已有条目 → 字段级合并：已有字段域保留新值，缺失字段域自 legacy 补入，models.json 仍剥离', async () => {
    // 模拟迁移失败窗口后用户重新配置：providers.json 已有部分字段条目（仅 quota 新值）
    await extrasStore.modify('zai-coding-cn', () => ({
      quota: { fetcher: 'user-new-choice', enabled: false },
    }))
    writeModelsJson({
      'zai-coding-cn': {
        baseUrl: 'https://x.example.com',
        authMethod: 'oauth',
        quota: { fetcher: 'zhipu', enabled: true, cookieSet: true }, // stale 旧值
      },
    })

    const report = await migrateProviderExtras(configStore, extrasStore)

    // 字段级合并（round 1 review DG#2）：quota 已存在 → 保留新值（stale 不覆盖）；
    // authMethod 条目内缺失 → 自 legacy 补入（否则部分字段条目会让其余字段域永久丢失）
    expect(readExtrasRaw()['zai-coding-cn']).toEqual({
      authMethod: 'oauth',
      quota: { fetcher: 'user-new-choice', enabled: false },
    })
    expect(report.skippedExisting).toEqual(['zai-coding-cn'])
    // models.json 仍完成剥离（双源收敛：本次成功迁移即消除双源）
    const zai = readModelsRaw_m2_m2_z3()['zai-coding-cn'] as Record<string, unknown>
    expect(zai.authMethod).toBeUndefined()
    expect(zai.quota).toBeUndefined()
  })

  it('只有 provider 级 enabled 死字段的条目：models.json 剥离但 providers.json 不落空条目', async () => {
    writeModelsJson({
      'enabled-only': { enabled: false, baseUrl: 'https://x.example.com' },
    })
    const report = await migrateProviderExtras(configStore, extrasStore)

    expect(report.migrated).toEqual([]) // 无实质数据搬运
    expect(report.noOp).toBe(false)     // 但发生了 models.json 剥离
    expect((readModelsRaw_m2_m2_z3()['enabled-only'] as Record<string, unknown>).enabled).toBeUndefined()
    expect(readExtrasRaw()['enabled-only']).toBeUndefined()
  })
})
describe('迁移级 defaultModel 保全（round 2 review SUGGESTION，R1 must-fix #2 遗留）', () => {
  it('catalog + builtin 默认模型 + override 条目共存：pass-3 重写 dirty 条目不重置 defaultModel', async () => {
    // 迁移入口级检查 migrateProviderExtras → PiConfigStore.upsertProvider →
    // pi-provider-store.upsertProvider 全链路（union 语义此前只在 pi-provider-store
    // 单测层覆盖——若未来迁移改走不触发 default 校验/无 union 的独立写路径，本用例红）。
    // anthropic 是 catalog provider（builtin-providers.json 含 claude-sonnet-4-6）。
    writeModelsJson({
      anthropic: {
        apiKey: 'sk-test',
        quota: { fetcher: 'kimi', enabled: true, cookieSet: true },
        models: [{ id: 'my-override-model', enabled: false }],
      },
    })
    // 默认模型取 builtin id（不在 models.json 条目的 override 列表内）
    setDefaultModel('anthropic' as ProviderId, 'claude-sonnet-4-6')

    const report = await migrateProviderExtras(configStore, extrasStore)

    // anthropic 确实被 pass-3 重写（寄生字段剥离、override 保留），非 no-op
    expect(report.migrated).toContain('anthropic')
    const entry = readModelsRaw_m2_m2_z3()['anthropic'] as Record<string, unknown>
    expect(entry.quota).toBeUndefined()
    expect(entry.models).toEqual([{ id: 'my-override-model' }])
    // 寄生数据完整落入 providers.json
    expect(readExtrasRaw()['anthropic']).toEqual({
      quota: { fetcher: 'kimi', enabled: true, cookieSet: true },
      modelStates: { 'my-override-model': { enabled: false } },
    })

    // defaultModel 不被重置：upsertProvider 以「override ∪ builtin catalog」校验有效性，
    // builtin 默认模型仍有效（回归形态 = union 丢失 → defaultModel 被改写为 override 首项）
    const settings = readSettings()
    expect(settings.defaultProvider).toBe('anthropic')
    expect(settings.defaultModel).toBe('claude-sonnet-4-6')
  })
})
describe('readExtrasWithFallback（双读回退，A1-3 读侧切换）', () => {
  it('providers.json 有条目 → 优先返回', async () => {
    await extrasStore.modify('p1', () => ({ authMethod: 'api_key' }))
    writeModelsJson({ p1: { authMethod: 'oauth', baseUrl: 'https://x.example.com' } })
    const extras = readExtrasWithFallback(extrasStore, configStore, 'p1')
    expect(extras).toEqual({ authMethod: 'api_key' })
  })

  it('providers.json 无条目 + models.json 有旧寄生字段 → 回退读旧值（迁移失败窗口）', () => {
    writeModelsJson({
      p1: {
        baseUrl: 'https://x.example.com',
        authMethod: 'oauth',
        quota: { fetcher: 'kimi', enabled: true },
        models: [{ id: 'm1', enabled: false }],
      },
    })
    const extras = readExtrasWithFallback(extrasStore, configStore, 'p1')
    expect(extras).toEqual({
      authMethod: 'oauth',
      quota: { fetcher: 'kimi', enabled: true },
      modelStates: { m1: { enabled: false } },
    })
  })

  it('两处都无 → undefined', () => {
    writeModelsJson({ p1: { baseUrl: 'https://x.example.com' } })
    expect(readExtrasWithFallback(extrasStore, configStore, 'p1')).toBeUndefined()
    expect(readExtrasWithFallback(extrasStore, configStore, 'missing')).toBeUndefined()
  })
})
});

// ======================================================================
// ← src/services/migration/__tests__/provider-parser-dispatcher.test.ts
// ======================================================================

// ── vi.mock 各解析器模块（在 import 前，vitest hoist）──────────────
// 每个 mock 默认返回 null（源未安装），spy 形态便于断言被调用。
vi.mock('../parsers/pi-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/pi-parser.js')>()
  return { ...actual, parsePiProviders: vi.fn(() => null), }
})

vi.mock('../parsers/zcode-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/zcode-parser.js')>()
  return { ...actual, parseZcodeProviders: vi.fn(() => null), }
})

vi.mock('../parsers/codex-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/codex-parser.js')>()
  return { ...actual, parseCodexProviders: vi.fn(() => null), }
})

vi.mock('../parsers/claude-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/claude-parser.js')>()
  return { ...actual, parseClaudeProviders: vi.fn(() => null), }
})
// ── fixture ──────────────────────────────────────────────────

/** 构造一个可识别的 ParseResult（用于验证返回值透传）。 */
function fakeResult(tag: string): ParseResult {
  return {
    providers: [
      {
        _sourceName: tag,
        _apiKeyExtracted: false,
        _credentialType: 'missing',
        _warnings: [],
        api: 'openai-completions',
        models: [{ id: 'm', name: 'm' }],
      },
    ],
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-parser-dispatcher', () => {
describe('parseProviders dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 重置默认 mock 行为：返回 null（源未安装）
    vi.mocked(parsePiProviders).mockReturnValue(null)
    vi.mocked(parseZcodeProviders).mockReturnValue(null)
    vi.mocked(parseCodexProviders).mockReturnValue(null)
    vi.mocked(parseClaudeProviders).mockReturnValue(null)
  })

  // ── T9：每个 source 路由到对应解析器（参数 + 返回值透传）──────────
  it('T9: source=pi → 调 parsePiProviders 并透传返回值', () => {
    vi.mocked(parsePiProviders).mockReturnValue(fakeResult('pi-result'))

    const out = parseProviders('pi', '/home/test')

    expect(parsePiProviders).toHaveBeenCalledWith('/home/test')
    expect(parseZcodeProviders).not.toHaveBeenCalled()
    expect(parseCodexProviders).not.toHaveBeenCalled()
    expect(parseClaudeProviders).not.toHaveBeenCalled()
    expect(out).not.toBeNull()
    expect(out!.providers[0]._sourceName).toBe('pi-result')
  })

  it('T9: source=zcode → 调 parseZcodeProviders 并透传返回值', () => {
    vi.mocked(parseZcodeProviders).mockReturnValue(fakeResult('zcode-result'))

    const out = parseProviders('zcode', '/home/test')

    expect(parseZcodeProviders).toHaveBeenCalledWith('/home/test')
    expect(parsePiProviders).not.toHaveBeenCalled()
    expect(out!.providers[0]._sourceName).toBe('zcode-result')
  })

  it('T9: source=codex → 调 parseCodexProviders 并透传返回值', () => {
    vi.mocked(parseCodexProviders).mockReturnValue(fakeResult('codex-result'))

    const out = parseProviders('codex', '/home/test')

    expect(parseCodexProviders).toHaveBeenCalledWith('/home/test')
    expect(parsePiProviders).not.toHaveBeenCalled()
    expect(out!.providers[0]._sourceName).toBe('codex-result')
  })

  it('T9: source=claude → 调 parseClaudeProviders 并透传返回值', () => {
    vi.mocked(parseClaudeProviders).mockReturnValue(fakeResult('claude-result'))

    const out = parseProviders('claude', '/home/test')

    expect(parseClaudeProviders).toHaveBeenCalledWith('/home/test')
    expect(parsePiProviders).not.toHaveBeenCalled()
    expect(out!.providers[0]._sourceName).toBe('claude-result')
  })

  // ── T9b：null 透传（源未安装）──────────────────────────────────
  it('T9b: 解析器返回 null → parseProviders 也返回 null', () => {
    vi.mocked(parseCodexProviders).mockReturnValue(null)

    const out = parseProviders('codex', '/home/test')

    expect(parseCodexProviders).toHaveBeenCalledWith('/home/test')
    expect(out).toBeNull()
  })

  // ── T8：解析器返回 null 即「源未安装」（dispatcher 不查 existsSync）──
  // 注：parseProviders 是薄转发层——源目录存在性由各解析器内部 existsSync 判定，
  // 返回 null 表示「源未安装」。这里验证 dispatcher 正确把 null 传出去（不抛错、不兜底）。
  it('T8: 各解析器（mock existsSync 让源目录返回 false）返回 null → dispatcher 返回 null', () => {
    // 这里直接用 mock 返回 null 模拟「源目录不存在」场景（真实解析器内部 existsSync 判定）。
    // 各解析器的 existsSync→null 行为已由各自单元测试覆盖（pi-parser T8 / codex-parser T8 等）。
    for (const source of ['pi', 'zcode', 'codex', 'claude'] as const) {
      const out = parseProviders(source, '/nonexistent/home')
      expect(out).toBeNull()
    }
  })

  // ── B1：parser 抛异常时 dispatcher 转为 { providers: [], parseError }，不中断调用方 ──
  it('B1: 解析器抛异常 → dispatcher 兜底返回 { providers: [], parseError }，不向上抛', () => {
    vi.mocked(parsePiProviders).mockImplementation(() => {
      throw new Error('unexpected parser crash')
    })

    const out = parseProviders('pi', '/home/test')

    expect(out).not.toBeNull()
    expect(out!.providers).toEqual([])
    expect(out!.parseError).toMatch(/failed to parse pi/)
    expect(out!.parseError).toContain('unexpected parser crash')
  })

  // ── B1b：未知 source → null（与「源未安装」同处理）────────────────
  it('B1b: 未知 source（编译期 union 之外）→ 返回 null', () => {
    // 用 as any 模拟运行时非法 source（WS 异常 payload 场景）
    const out = parseProviders('unknown' as never, '/home/test')
    expect(out).toBeNull()
  })
})
});

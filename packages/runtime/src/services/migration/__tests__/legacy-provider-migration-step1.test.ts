/**
 * step1 catalog apiKey 迁移测试（M5-04 修复验证 + 既有行为回归）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/legacy-provider-migration-step1.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 legacy-provider-migration-step2.test.ts 同模式。isCatalogProvider 走真实实现
 *（builtin-providers.json 判定，openai/anthropic 均为 catalog provider）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyProviderConfig } from '../legacy-provider-migration.js'
import { setModelsPath } from '../../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { AuthStorage, type CredentialWriter } from '../../auth/auth-storage.js'

/**
 * 轻量 credentialWriter adapter：与生产等价（AuthService.saveCredential 内部就是
 * authStorage.set，A1-4 收口只收调用点不改锁语义）。测试文件内直调 authStorage.set
 * 不违反收口 grep（验收排除测试文件）。
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

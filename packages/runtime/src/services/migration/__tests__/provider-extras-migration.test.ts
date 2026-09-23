/**
 * A1-2 迁移测试：models.json 寄生字段 → config/providers.json（tmp 目录真实文件）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/provider-extras-migration.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 legacy-provider-migration-step2.test.ts 同模式。物理读两个文件断言终态。
 *
 * 覆盖（验收 1 迁移 + 验收 2 合并策略 + 幂等 no-op + readExtrasWithFallback）：
 * - 主场景：quota/authMethod/models[].enabled/provider 级 enabled + name-only+quota 空壳
 *   → models.json 剥离干净（空壳消失）、providers.json 值完整（cookieSet/apiKeySet 保真）、备份存在
 * - 幂等：二次迁移 no-op（文件 mtime 与备份文件数量均不变）
 * - 合并策略：providers.json 已有条目不覆盖（丢弃 models.json 旧值）
 * - readExtrasWithFallback 双读回退
 * - 迁移级 defaultModel 保全：catalog + builtin 默认模型 + override 条目共存时
 *   pass-3 重写 dirty 条目不重置 defaultModel（round 2 review SUGGESTION）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderId } from '@taiji/shared'
import { migrateProviderExtras, readExtrasWithFallback } from '../provider-extras-migration.js'
import { TaijiProviderStore } from '../../provider-extras-store.js'
import { setModelsPath, setDefaultModel, readSettings } from '../../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'

let dir: string
let agentDir: string
let extrasStore: TaijiProviderStore
let configStore: PiConfigStore
let extrasPath: string

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

function listBackupFiles(): string[] {
  if (!existsSync(agentDir)) return []
  return readdirSync(agentDir).filter(f => f.startsWith('models.json.bak-migrate-'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-extras-migration-'))
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

    const providers = readModelsRaw()
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
    const original = readFileSync(join(agentDir, 'models.json'), 'utf-8')
    await migrateProviderExtras(configStore, extrasStore)

    const backups = listBackupFiles()
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(agentDir, backups[0]), 'utf-8')).toBe(original)
    // 源文件可含明文 apiKey——副本权限不得比源文件宽松（RT-5#7 chmod 0600）
    expect(statSync(join(agentDir, backups[0])).mode & 0o777).toBe(0o600)
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

    const modelsPath = join(agentDir, 'models.json')
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
    const zai = readModelsRaw()['zai-coding-cn'] as Record<string, unknown>
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
    expect((readModelsRaw()['enabled-only'] as Record<string, unknown>).enabled).toBeUndefined()
    expect(readExtrasRaw()['enabled-only']).toBeUndefined()
  })
})

describe('迁移级 defaultModel 保全（round 2 review SUGGESTION，R1 must-fix #2 遗留）', () => {
  it('catalog + builtin 默认模型 + override 条目共存：pass-3 重写 dirty 条目不重置 defaultModel', async () => {
    // 迁移入口级守卫 migrateProviderExtras → PiConfigStore.upsertProvider →
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
    const entry = readModelsRaw()['anthropic'] as Record<string, unknown>
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

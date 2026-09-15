/**
 * findValidDefaultModel catalog 兜底 enabledModels 过滤测试（wave2 TC6，ES3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-provider-store-finddefault.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
 * 与 pi-provider-store.test.ts 同模式。凭据判定经注入的 resolver（M2c 链 3；原私有裸读已删）。
 * 覆盖 design TC6：catalog 兜底遍历 builtin 时跳过被 enabledModels 禁用的 provider。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findValidDefaultModel, initProviderCredentialResolver, readModels, getProviderConfig, setModelsPath } from '../pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../pi-settings-store.js'
import { ProviderCredentialResolver } from '../../../services/auth/provider-credential-resolver.js'
import { AuthStorage } from '../../../services/auth/auth-storage.js'
import builtinData from '../../../generated/builtin-providers.json'

let dir: string
let agentDir: string

/** 真实结构：<dataDir>/agent/（getPiAgentDir = getConfigDir()/agent） */
function realAgentDir(): string {
  return join(dir, 'agent')
}

function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

/**
 * 写 settings.json，含可选 defaultProvider/defaultModel/enabledModels。
 * enabledModels 是 wave2 DM3 的 provider 启用白名单源。
 */
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

/** 注入链 3 生产形态 resolver（M2c）：auth.json 经真实 AuthStorage（无缓存，读实时文件）。 */
function initResolver(): void {
  initProviderCredentialResolver(new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: new AuthStorage(join(agentDir, 'auth.json')),
    configStore: { readModels, getProviderConfig },
  }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-store-finddefault-'))
  agentDir = realAgentDir()
  mkdirSync(agentDir, { recursive: true })
  // auth.json 经注入的 AuthStorage（路径 = agentDir/auth.json）；models/settings 经 setPath 注入
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  writeAuth({})
  // 生产组合根 init 装配的等价形态：装配完成先于任何 findValidDefaultModel 调用
  initResolver()
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('TC6: findValidDefaultModel catalog 兜底过滤 enabledModels（ES3）', () => {
  it('被禁用的 catalog provider 不作 default——选有凭据且启用的', () => {
    // models.json 无可用 provider → 触发 catalog 兜底
    writeModels({})
    // 只有 anthropic 启用（openai 被禁用）
    writeSettings({ enabledModels: ['anthropic/*'] })
    // auth.json 两者都有凭据
    writeAuth({
      openai: { type: 'api_key', key: 'ko' },
      anthropic: { type: 'api_key', key: 'ka' },
    })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('anthropic')
    // wasFixed=false：兜底是临时展示，不写回 settings.json（不污染用户配置）
    expect(r.wasFixed).toBe(false)
  })

  it('有凭据的 provider 全被禁用时 → 返回 null（不选被禁用的）', () => {
    writeModels({})
    // 只有 anthropic 启用
    writeSettings({ enabledModels: ['anthropic/*'] })
    // 但 auth.json 只有 openai 凭据（被禁用）→ 无可用
    writeAuth({ openai: { type: 'api_key', key: 'ko' } })
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })

  it('对照：enabledModels 空 → 有凭据的 catalog provider 可作 default（过滤不影响）', () => {
    writeModels({})
    // 空 = 全启用（pi 白名单语义，DM3）
    writeSettings({ enabledModels: [] })
    writeAuth({ openai: { type: 'api_key', key: 'ko' } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('openai')
  })

  it('对照：enabledModels 未设置（undefined）→ 全启用，有凭据即可作 default', () => {
    writeModels({})
    // 不写 enabledModels（settings.json 无此字段 → readSettings().enabledModels ?? []）
    writeSettings({})
    writeAuth({ openai: { type: 'api_key', key: 'ko' } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('openai')
  })

  it('model 级 pattern（<id>/<model>）视为该 provider 已启用', () => {
    writeModels({})
    // model 级 pattern：openai/gpt-4 → openai 启用
    writeSettings({ enabledModels: ['openai/gpt-4', 'anthropic/*'] })
    writeAuth({
      openai: { type: 'api_key', key: 'ko' },
      anthropic: { type: 'api_key', key: 'ka' },
    })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    // anthropic 字母序在 openai 前，且两者都启用（openai 经 model 级 pattern 启用）
    expect(['anthropic', 'openai']).toContain(r.result!.provider)
  })

  it('回归：无凭据时返回 null，不选 ambient 的 amazon-bedrock（沿用既有保护）', () => {
    writeModels({})
    writeSettings({ enabledModels: [] })
    writeAuth({})
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })
})

describe('A8: findValidDefaultModel 主路径 enabledModels 过滤', () => {
  // 主路径：defaultProvider+defaultModel 在 models.json 有效时直接返回。A8 加 enabledModels 守卫——
  // 被禁用的 default 不走主路径，fall through 到 fallback（pickFirstModelProvider 同样过滤 enabled）。
  it('default provider 被 enabledModels 禁用 → 主路径跳过，fallback 重选到启用的 provider', () => {
    writeModels({
      'custom-a': { models: [{ id: 'm-a' }] },
      'custom-b': { models: [{ id: 'm-b' }] },
    })
    // default 指向 custom-a，但白名单只启用 custom-b
    writeSettings({ defaultProvider: 'custom-a', defaultModel: 'm-a', enabledModels: ['custom-b/*'] })
    writeAuth({})
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('custom-b')
    expect(r.result!.modelId).toBe('m-b')
    // fallback 重选 → wasFixed=true（getDefaultModel 会写回 settings.json）
    expect(r.wasFixed).toBe(true)
  })

  it('对照：default provider 启用 → 主路径直接返回（wasFixed=false，不写回）', () => {
    writeModels({
      'custom-a': { models: [{ id: 'm-a' }] },
    })
    // enabledModels 空 = 全启用
    writeSettings({ defaultProvider: 'custom-a', defaultModel: 'm-a', enabledModels: [] })
    writeAuth({})
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'custom-a', modelId: 'm-a' })
    expect(r.wasFixed).toBe(false)
  })

  it('主路径 model 重选不受 A8 守卫影响：default 启用但 defaultModel 无效 → 仍走 provider 内重选', () => {
    writeModels({
      'custom-a': { models: [{ id: 'm-a' }, { id: 'm-a2' }] },
    })
    // defaultModel='gone' 不在 provider models → 主路径内重选 models[0]
    writeSettings({ defaultProvider: 'custom-a', defaultModel: 'gone', enabledModels: [] })
    writeAuth({})
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'custom-a', modelId: 'm-a' })
    expect(r.wasFixed).toBe(true)
  })

  it('default 被禁用 + models.json 无其他启用 provider → fallback 返回 undefined，走 catalog 兜底', () => {
    // 仅 custom-a（被禁用），无其他启用 provider → pickFirstModelProvider 返回 undefined
    writeModels({
      'custom-a': { models: [{ id: 'm-a' }] },
    })
    writeSettings({ defaultProvider: 'custom-a', defaultModel: 'm-a', enabledModels: ['custom-x/*'] })
    // auth.json 无凭据 → catalog 兜底也找不到 → null
    writeAuth({})
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════
// A6（S3，scoped-model design D3 修复）：findValidDefaultModel 对 auth.json-only
// catalog provider（OAuth 形态常态：models.json 无条目、auth.json 有凭据）。
// D3 修复前主路径查 models.json 失败即 fallback 重选/写回，污染用户配置。
// ══════════════════════════════════════════════════════════════════
describe('A6: findValidDefaultModel 对 auth.json-only catalog provider（D3 修复）', () => {
  // builtin 模型集从 generated JSON 动态取（不 hardcode 具体 model id，随 catalog 演进稳定）
  const zaiModels = (builtinData.providers ?? []).find(p => p.id === 'zai-coding-cn')?.models ?? []
  const firstZaiModelId = zaiModels[0]?.id as string

  it('A6 default 指向 auth.json-only catalog provider 且 defaultModel ∈ builtin 集 → 直接返回不 fallback，wasFixed=false', () => {
    // models.json 放无关 custom provider 作 fallback 诱饵：D3 生效时不应被选中
    writeModels({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings({ defaultProvider: 'zai-coding-cn', defaultModel: firstZaiModelId, enabledModels: [] })
    writeAuth({ 'zai-coding-cn': { type: 'api_key', key: 'kz' } })

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: 'zai-coding-cn', modelId: firstZaiModelId })
    expect(r.wasFixed).toBe(false)
  })

  it('D5 态 3 演进：defaultModel 不在快照集且 overlay 从未见过 → pass-through 不改写（原「重选 builtin 第一个」被 D5 取代）', () => {
    writeModels({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings({ defaultProvider: 'zai-coding-cn', defaultModel: 'nonexistent-model', enabledModels: [] })
    writeAuth({ 'zai-coding-cn': { type: 'api_key', key: 'kz' } })
    // 未写任何 overlay 文件 → zai-coding-cn 处于 never-seen 态。D5 裁定：pass-through
    // 不判定有效性、不 auto-fix（垃圾模型名直传 pi 报错，优于静默改写用户配置）。
    // 旧行为（wasFixed:true 重选 builtin 第一个）正是设计文档「失败模式 A」同族：静默改写。

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: 'zai-coding-cn', modelId: 'nonexistent-model' })
    expect(r.wasFixed).toBe(false)
  })

  it('A6 对照：无凭据时 D3 不生效 → fallback 到 models.json 其他 provider', () => {
    writeModels({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings({ defaultProvider: 'zai-coding-cn', defaultModel: firstZaiModelId, enabledModels: [] })
    // auth.json 无 zai 凭据：D3 的 hasCredential 不满足 → 走 fallback 重选
    writeAuth({})

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: 'custom-x', modelId: 'm-x' })
    expect(r.wasFixed).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// M2c（D3 链 3 接线 / 检查点 5）：模块级 init 注入 + 装配序契约。
// 「装配完成先于任何 findValidDefaultModel 调用」在组合根由 index.ts 的调用位置保证；
// 本组用例锁定两侧行为契约：未注入 = 安全降级（视为无凭据，不抛错），注入后同一数据生效。
// ══════════════════════════════════════════════════════════════════
describe('M2c 装配序：init 注入先于 findValidDefaultModel 的行为差异', () => {
  const zaiModels = (builtinData.providers ?? []).find(p => p.id === 'zai-coding-cn')?.models ?? []
  const firstZaiModelId = zaiModels[0]?.id as string

  it('未注入（init 前）：凭据不可见 → catalog 兜底返回 null，不抛错（安全降级的差异侧）', () => {
    // 模拟「装配未完成就调用」：清空注入，auth.json 中明明有凭据也不参与判定
    initProviderCredentialResolver(undefined)
    writeModels({})
    writeSettings({ enabledModels: [] })
    writeAuth({ openai: { type: 'api_key', key: 'ko' } })

    let r: ReturnType<typeof findValidDefaultModel> | undefined
    expect(() => { r = findValidDefaultModel() }).not.toThrow()
    expect(r!.result).toBeNull()
  })

  it('对照（注入后）：同一份数据可选出 catalog provider——差异即装配序契约的语义后果', () => {
    writeModels({})
    writeSettings({ enabledModels: [] })
    writeAuth({ openai: { type: 'api_key', key: 'ko' } })
    initResolver()

    const r = findValidDefaultModel()

    expect(r.result?.provider).toBe('openai')
  })

  it('副路径（auth.json-only catalog provider）经 resolver.hasProviderCredential 判定（spy 命中）', () => {
    writeModels({ 'custom-x': { models: [{ id: 'm-x' }] } })
    writeSettings({ defaultProvider: 'zai-coding-cn', defaultModel: firstZaiModelId, enabledModels: [] })
    writeAuth({})
    const hasProviderCredential = vi.fn((id: string) => id === 'zai-coding-cn')
    initProviderCredentialResolver({
      hasProviderCredential,
      listCredentialBackedProviderIds: () => new Set<string>(),
      resolveProviderCredential: async () => undefined,
    })

    const r = findValidDefaultModel()

    expect(hasProviderCredential).toHaveBeenCalledWith('zai-coding-cn')
    expect(r.result).toEqual({ provider: 'zai-coding-cn', modelId: firstZaiModelId })
    expect(r.wasFixed).toBe(false)
  })
})

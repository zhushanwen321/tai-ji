/**
 * D4 合并目录单真相 + D5 三态语义单测（设计 pi-evolution-consistency-and-project-switcher）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/merged-catalog-three-state.test.ts
 *
 * 覆盖：
 * - D4：getMergedCatalogModels 单点——快照打底、仅 fresh 态 overlay 并入（同 id 覆盖 /
 *   新 id 追加）、expired/never-seen 退化为纯快照、非快照 provider 返回 undefined
 * - D5 态 1（fresh）：overlay-only 模型合法，不被 auto-fix 改写（含 auth-only 主通路
 *   与 override 条目主路径两条通路），settings.json 内容不变
 * - D5 态 2（expired：staleness 过滤 / 404-501 落盘的 lastModified:0）：按快照裁定，
 *   允许 auto-fix 落盘改写（getDefaultModel 落盘断言）
 * - D5 态 3（never-seen）：pass-through 不判定不改写，settings.json 逐字节不变
 *
 * 策略：与 pi-provider-store-finddefault.test.ts 同模式——真实文件系统（临时目录 +
 * setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），overlay 经真实缓存文件 +
 * mtime 失效检测读取（每用例新临时目录 → mtime 变化自然失效模块级 overlaySnapshot，
 * 无需 resetModules；连续无 overlay 文件的用例缓存复用的也是同样空语义）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMergedCatalogModels } from '../provider-catalog.js'
import { getCatalogOverlayState, getCatalogGeneratedAt } from '../provider-catalog-refresh.js'
import { findValidDefaultModel, getDefaultModel, initProviderCredentialResolver, readModels, getProviderConfig, setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import { AuthStorage } from '../auth/auth-storage.js'
import builtinData from '../../generated/builtin-providers.json'

const GENERATED_AT = getCatalogGeneratedAt()
// 快照内 provider（10 模型）与首模型 id 动态取自快照（不 hardcode，随 catalog 演进稳定）
const PROVIDER = 'zai-coding-cn'
const SNAPSHOT_IDS = ((builtinData.providers ?? []) as Array<{ id: string; models: Array<{ id: string }> }>)
  .find(p => p.id === PROVIDER)?.models.map(m => m.id) ?? []
const SNAPSHOT_FIRST = SNAPSHOT_IDS[0]
// 快照外 overlay-only 模型 id（失败模式 A 叙事中的 glm-5.4 同理物）
const OVERLAY_ONLY = 'glm-test-overlay'

let dir: string
let settingsPath: string

function agentDir(): string {
  return join(dir, 'agent')
}

function writeOwnCache(entries: unknown): void {
  writeFileSync(join(dir, 'provider-catalog-overlay.json'), JSON.stringify({ version: 1, entries }))
}

function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir(), 'models.json'), JSON.stringify({ providers }, null, 2))
}

function writeSettings(opts: { defaultProvider?: string; defaultModel?: string } = {}): void {
  const s: Record<string, unknown> = {}
  if (opts.defaultProvider) s.defaultProvider = opts.defaultProvider
  if (opts.defaultModel) s.defaultModel = opts.defaultModel
  writeFileSync(join(agentDir(), 'settings.json'), JSON.stringify(s, null, 2))
}

function writeAuth(credentials: Record<string, unknown>): void {
  writeFileSync(join(agentDir(), 'auth.json'), JSON.stringify(credentials, null, 2))
}

function readSettingsRaw(): string {
  return readFileSync(settingsPath, 'utf-8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merged-catalog-three-state-'))
  mkdirSync(agentDir(), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir(), 'models.json'))
  settingsPath = join(agentDir(), 'settings.json')
  setSettingsPath(settingsPath)
  invalidateSettingsCache()
  writeAuth({ [PROVIDER]: { type: 'api_key', key: 'kz' } })
  // M2c 链 3：凭据判定只走注入的 resolver（原私有裸读已删除）——按生产组合根形态注入，
  // auth.json 经真实 AuthStorage（无缓存，后续 writeAuth 立即可读）。
  initProviderCredentialResolver(new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: new AuthStorage(join(agentDir(), 'auth.json')),
    configStore: { readModels, getProviderConfig },
  }))
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ══════════════════════════════════════════════════════════════════
// D4：合并视图单点
// ══════════════════════════════════════════════════════════════════
describe('D4: getMergedCatalogModels 合并视图单点', () => {
  it('fresh overlay：overlay-only 模型并入 + 快照打底模型仍在，overlayState=fresh', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY, name: 'GLM Test Overlay' }], checkedAt: 1, lastModified: GENERATED_AT + 1000 },
    })
    const view = getMergedCatalogModels(PROVIDER)
    expect(view?.overlayState.state).toBe('fresh')
    const ids = view!.models.map(m => m.id)
    expect(ids).toContain(OVERLAY_ONLY)
    expect(ids).toEqual([...SNAPSHOT_IDS, OVERLAY_ONLY]) // 快照在前、overlay 追加在后
  })

  it('fresh overlay 同 id 覆盖快照字段（name/contextWindow 取 overlay 值）', () => {
    writeOwnCache({
      [PROVIDER]: {
        models: [{ id: SNAPSHOT_FIRST, name: 'SNAPSHOT-FIRST (remote)', contextWindow: 999999 }],
        checkedAt: 1,
        lastModified: GENERATED_AT + 1000,
      },
    })
    const view = getMergedCatalogModels(PROVIDER)
    const m = view!.models.find(x => x.id === SNAPSHOT_FIRST)
    expect(m?.name).toBe('SNAPSHOT-FIRST (remote)')
    expect(m?.contextWindow).toBe(999999)
  })

  it('expired（404/501 语义 lastModified:0）→ 退化为纯快照，overlayState=expired', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: 0 },
    })
    const view = getMergedCatalogModels(PROVIDER)
    expect(view?.overlayState.state).toBe('expired')
    expect(view!.models.map(m => m.id)).toEqual(SNAPSHOT_IDS)
  })

  it('expired（staleness：lastModified == catalogGeneratedAt）→ 退化为纯快照', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: GENERATED_AT },
    })
    const view = getMergedCatalogModels(PROVIDER)
    expect(view?.overlayState.state).toBe('expired')
    expect(view!.models.map(m => m.id)).toEqual(SNAPSHOT_IDS)
  })

  it('never-seen（无文件）→ 等于纯快照，overlayState=never-seen', () => {
    const view = getMergedCatalogModels(PROVIDER)
    expect(view?.overlayState.state).toBe('never-seen')
    expect(view!.models.map(m => m.id)).toEqual(SNAPSHOT_IDS)
  })

  it('never-seen（缓存文件损坏 fail-safe）→ 同 never-seen 语义', () => {
    writeFileSync(join(dir, 'provider-catalog-overlay.json'), '{broken json')
    const view = getMergedCatalogModels(PROVIDER)
    expect(view?.overlayState.state).toBe('never-seen')
    expect(view!.models.map(m => m.id)).toEqual(SNAPSHOT_IDS)
  })

  it('非快照内 provider → undefined（D6 快照闸门外不构成合并视图）', () => {
    expect(getMergedCatalogModels('my-custom-router')).toBeUndefined()
  })

  it('getCatalogOverlayState 三态直读：fresh 带 models / expired / never-seen', () => {
    expect(getCatalogOverlayState('nonexistent-provider')).toEqual({ state: 'never-seen' })
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: GENERATED_AT + 1000 },
      anthropic: { models: [{ id: 'stale' }], checkedAt: 1, lastModified: 0 },
    })
    expect(getCatalogOverlayState(PROVIDER)).toEqual({ state: 'fresh', models: [{ id: OVERLAY_ONLY }] })
    expect(getCatalogOverlayState('anthropic')).toEqual({ state: 'expired' })
  })
})

// ══════════════════════════════════════════════════════════════════
// D5 态 1：fresh → 合并视图判定，overlay-only 模型合法，不 auto-fix
// ══════════════════════════════════════════════════════════════════
describe('D5 态 1：overlay 新鲜 → 合并视图判定，overlay-only 模型合法', () => {
  it('auth-only 通路：default = overlay-only 模型 → 原样返回，wasFixed=false', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: GENERATED_AT + 1000 },
    })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: PROVIDER, modelId: OVERLAY_ONLY })
    expect(r.wasFixed).toBe(false)
  })

  it('auth-only 通路：getDefaultModel 不改写 settings.json（updateSettingsFields 未触达，内容不变）', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: GENERATED_AT + 1000 },
    })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })
    const before = readSettingsRaw()

    const dm = getDefaultModel()

    expect(dm).toEqual({ provider: PROVIDER, modelId: OVERLAY_ONLY })
    expect(readSettingsRaw()).toBe(before)
  })

  it('override 条目主路径：default = 快照模型、override 未命中 → 合并视图裁定合法（修复旧「override 未命中即改写」）', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: GENERATED_AT + 1000 },
    })
    writeModels({ [PROVIDER]: { models: [{ id: 'custom-x' }] } })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: SNAPSHOT_FIRST })
    const before = readSettingsRaw()

    const r = findValidDefaultModel()

    // 旧行为：override 未命中 → 改写为 override 首项 custom-x（失败模式 A 同族）
    expect(r.result).toEqual({ provider: PROVIDER, modelId: SNAPSHOT_FIRST })
    expect(r.wasFixed).toBe(false)
    expect(readSettingsRaw()).toBe(before)
  })
})

// ══════════════════════════════════════════════════════════════════
// D5 态 2：见过但过期 → 快照裁定，允许 auto-fix 落盘改写
// ══════════════════════════════════════════════════════════════════
describe('D5 态 2：见过但过期 → 快照裁定，允许 auto-fix', () => {
  it('auth-only 通路：404/501 语义（lastModified:0）+ default = 快照外模型 → auto-fix 到快照首模型', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: 0 },
    })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })

    const r = findValidDefaultModel()

    // 快照裁定：overlay-only 模型不在快照 → 无效，快照首模型接替
    expect(r.result).toEqual({ provider: PROVIDER, modelId: SNAPSHOT_FIRST })
    expect(r.wasFixed).toBe(true)
  })

  it('auth-only 通路：getDefaultModel 落盘改写 settings.json 为快照首模型（auto-fix 发生且可见）', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: 0 },
    })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })

    const dm = getDefaultModel()

    expect(dm).toEqual({ provider: PROVIDER, modelId: SNAPSHOT_FIRST })
    const persisted = JSON.parse(readSettingsRaw())
    expect(persisted.defaultProvider).toBe(PROVIDER)
    expect(persisted.defaultModel).toBe(SNAPSHOT_FIRST)
  })

  it('staleness 过滤态（lastModified == catalogGeneratedAt）同样按快照裁定允许 auto-fix', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: GENERATED_AT },
    })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: PROVIDER, modelId: SNAPSHOT_FIRST })
    expect(r.wasFixed).toBe(true)
  })

  it('override 条目主路径：过期 overlay 的快照外模型 → 快照裁定改写为 override 首项', () => {
    writeOwnCache({
      [PROVIDER]: { models: [{ id: OVERLAY_ONLY }], checkedAt: 1, lastModified: 0 },
    })
    writeModels({ [PROVIDER]: { models: [{ id: 'custom-x' }] } })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: PROVIDER, modelId: 'custom-x' })
    expect(r.wasFixed).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// D5 态 3：从未见过 → pass-through，不判定不改写
// ══════════════════════════════════════════════════════════════════
describe('D5 态 3：从未见过 → pass-through 不改写 settings', () => {
  it('auth-only 通路：default = 快照外模型（无 overlay 记录）→ 原样返回，wasFixed=false', () => {
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: PROVIDER, modelId: OVERLAY_ONLY })
    expect(r.wasFixed).toBe(false)
  })

  it('auth-only 通路：getDefaultModel 后 settings.json 逐字节不变（禁改写）', () => {
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })
    const before = readSettingsRaw()

    const dm = getDefaultModel()

    expect(dm).toEqual({ provider: PROVIDER, modelId: OVERLAY_ONLY })
    expect(readSettingsRaw()).toBe(before)
  })

  it('override 条目主路径：default = 快照外模型 → pass-through 不改写（不改写优先于 auto-fix）', () => {
    writeModels({ [PROVIDER]: { models: [{ id: 'custom-x' }] } })
    writeSettings({ defaultProvider: PROVIDER, defaultModel: OVERLAY_ONLY })
    const before = readSettingsRaw()

    const r = findValidDefaultModel()

    expect(r.result).toEqual({ provider: PROVIDER, modelId: OVERLAY_ONLY })
    expect(r.wasFixed).toBe(false)
    expect(readSettingsRaw()).toBe(before)
  })
})
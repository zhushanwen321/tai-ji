/**
 * toggleProviderEnabled + 边界守卫 + setProvider 停用 enabled 测试（wave3，provider-dual-system-r2::enabledmodels-dual-consume）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-toggle.test.ts
 *
 * 策略：
 *   - TC1/TC2/TC3/TC6：mock configStore，断言写方法调用路由（setEnabledModels vs clearEnabledModels、
 *     setProvider merged 不含 provider 级 enabled）。
 *   - TC4/TC7：状态化 mock（写反映到读），验证 defaultModel 重选 + listProviders 联动。
 *   - 边界3 持久化（CL2）：真实 pi-settings-store（临时 settings 文件），验证 clearEnabledModels
 *     后 settings.json 物理无 enabledModels key（JSON.stringify 丢弃 delete 后的 undefined）。
 *
 * 覆盖 design TC1-TC4/TC6/TC7 + CL1（toggle(true) 空白名单 no-op）+ setProvider 边界1 守卫。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import type { IConfigStore, ConfigModelsConfig, ConfigProviderConfig } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'
// M5-02：mock 镜像生产 getDefaultModel 的 auto-fix 语义需要 deriveEnabled（与
// pi-provider-store.findValidDefaultModel 同源判定）。本文件不 mock provider-catalog。
import { deriveEnabled } from '../provider-catalog.js'
// 真实 pi-settings-store（边界3 持久化验证用）
import { clearEnabledModels, ensureProviderInWhitelist, setEnabledModels, setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

interface StoreOpts {
  /** models.json providers（默认空）。 */
  models?: ConfigModelsConfig['providers']
  /** settings.json.enabledModels（默认空 = 全启用，DM3）。 */
  enabledModels?: string[]
  /** settings.json defaultProvider/defaultModel（默认 null）。 */
  defaultModel?: { provider: string; modelId: string } | null
  /** auth.json 顶层 providerId 列表（catalog 凭据源，listProviders 联动用）。 */
  authIds?: string[]
}

/**
 * 状态化 mock IConfigStore：写操作（setEnabledModels/clearEnabledModels/setDefaultModel/
 * ensureProviderInWhitelist/upsertProvider）反映到后续读（getEnabledModels/getDefaultModel/
 * readModels/getProviderConfig）。TC4 边界2 重选 + TC7 联动需要 read-after-write 一致性。
 */
function makeStore(opts: StoreOpts = {}) {
  let enabledModels = [...(opts.enabledModels ?? [])]
  let defaultModel = opts.defaultModel ?? null
  const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
  return {
    readModels: vi.fn(() => ({ providers: models })),
    getEnabledModels: vi.fn(() => [...enabledModels]),
    getDefaultModel: vi.fn(() => {
      // M5-02：镜像生产 PiConfigStore.getDefaultModel（findValidDefaultModel + wasFixed
      // auto-fix 写回）。default 有效（provider 在 models、有 models、启用、modelId 存在）
      // → 原值返回；无效 → 重选 models 中第一个启用且有 models 的 provider 并写回
      //（wasFixed 语义）；无可用 → null（生产 catalog 兜底 wasFixed:false 不写回，mock 简化为 null）。
      // 若 mock 仍是「无条件返回初值」，TC4 测的是生产不可达路径（旧实现顺序 bug 漏网）。
      if (!defaultModel) return null
      const cur = defaultModel
      const cfg = models[cur.provider]
      const isEnabled = deriveEnabled(cur.provider, enabledModels)
      if (cfg?.models?.length && isEnabled && cfg.models.some(m => m.id === cur.modelId)) {
        return cur
      }
      for (const [pid, pcfg] of Object.entries(models)) {
        if (pcfg.models?.length && deriveEnabled(pid, enabledModels)) {
          defaultModel = { provider: pid, modelId: pcfg.models[0].id }
          return defaultModel
        }
      }
      return null
    }),
    getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
    setEnabledModels: vi.fn((p: string[]) => { enabledModels = [...p] }),
    clearEnabledModels: vi.fn(() => { enabledModels = [] }),
    setDefaultModel: vi.fn((provider: string, modelId: string) => { defaultModel = { provider, modelId } }),
    ensureProviderInWhitelist: vi.fn((id: string) => {
      // 与 pi-provider-store.ensureProviderInWhitelist 同语义（状态化镜像，供 TC4/TC7 read-after-write）
      if (enabledModels.length === 0) return
      const pattern = `${id}/*`
      if (enabledModels.includes(pattern)) return
      enabledModels = [...enabledModels, pattern]
    }),
    upsertProvider: vi.fn((id: string, merged: ConfigProviderConfig) => {
      models[id] = merged
      return {}
    }),
    applyTypeTranslation: vi.fn((t: string) => t),
    removeProvider: vi.fn(() => ({ removed: true })),
  } as unknown as IConfigStore & {
    setEnabledModels: ReturnType<typeof vi.fn>
    clearEnabledModels: ReturnType<typeof vi.fn>
    setDefaultModel: ReturnType<typeof vi.fn>
    ensureProviderInWhitelist: ReturnType<typeof vi.fn>
    upsertProvider: ReturnType<typeof vi.fn>
  }
}

function makeAuth(authIds: string[] = []): FullAuthPick {
  return {
    listCredentialIds: vi.fn(() => authIds),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as FullAuthPick
}

function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore> } {
  const store = makeStore(opts)
  const auth = makeAuth(opts.authIds ?? [])
  // M2fg 恒注入形态：凭据判定（含 B1 重选凭据优先）经 resolver 批量 sync 版，
  // 同源于上方 store/auth mock
  const resolver = new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: auth,
    configStore: store,
  })
  const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
  return { svc, store }
}

// ══ TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels ════════════════════

describe('TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('enabledModels 非空 → 加 <id>/*', () => {
    const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
    svc.toggleProviderEnabled('openai', true)
    expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*', 'openai/*'])
  })

  it('CL1: enabledModels 空（全可用）→ no-op（不加 pattern，避免禁用其他）', () => {
    const { svc, store } = makeService({ enabledModels: [] })
    const ret = svc.toggleProviderEnabled('openai', true)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
    expect(ret).toEqual({})
  })

  it('CL1: enabledModels undefined（全可用）→ no-op', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.toggleProviderEnabled('openai', true)
    // 幂等：pattern 已在白名单，不重复加
    expect(store.setEnabledModels).not.toHaveBeenCalled()
  })
})

// ══ TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern ═════════════

describe('TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('移除 provider 级（<id>/*）+ model 级（<id>/<model>）所有 pattern', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*'])
  })

  it('startsWith 带斜杠防前缀碰撞：openai 不误删 openai-compatible/*', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai-compatible/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.setEnabledModels).toHaveBeenCalledWith(['openai-compatible/*'])
  })

  it('幂等：provider 不在白名单时 no-op', () => {
    const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
    expect(store.clearEnabledModels).not.toHaveBeenCalled()
  })
})

// ══ TC3: 边界3 空数组守卫——重算空时 clearEnabledModels（非写空数组）══════════════════

describe('TC3: 边界3 空数组守卫——重算空时 clearEnabledModels（delete 字段，CL2）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('移除最后一个 pattern → clearEnabledModels 调用，setEnabledModels 不调用（非写空数组）', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
  })

  it('model 级 pattern 移除至空 → 同样 clearEnabledModels', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/gpt-4'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
  })
})

// ══ TC4: 边界2 defaultModel 守卫——禁用承载 default 的 provider 时重选 ════════════════

describe('TC4: 边界2 defaultModel 守卫——禁用承载 default 的 provider 时重选', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('defaultModel=openai/gpt-4，禁用 openai → 重选为剩余 provider 的 model，返回 newDefault', () => {
    // B-2 混合合并后：catalog provider（如 anthropic）的 models 含 builtin 副本条目，
    // 重选结果随 builtin 目录漂移。候选用 custom id（other-llm）固定 mock 的 models 集，
    // 本用例聚焦「重选发生 + 写回」本身。
    const { svc, store } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        'other-llm': { models: [{ id: 'their-m' }] },
      },
      enabledModels: ['openai/*', 'other-llm/*'],
      defaultModel: { provider: 'openai', modelId: 'gpt-4' },
    })
    const ret = svc.toggleProviderEnabled('openai', false)
    // 重选写入 other-llm/their-m
    expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
    expect(ret.newDefault).toEqual({ provider: 'other-llm', modelId: 'their-m' })
  })

  it('禁用的 provider 不承载 default → 不重选，返回空对象', () => {
    const { svc, store } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['openai/*', 'anthropic/*'],
      defaultModel: { provider: 'anthropic', modelId: 'claude-3' },
    })
    const ret = svc.toggleProviderEnabled('openai', false)
    expect(store.setDefaultModel).not.toHaveBeenCalled()
    expect(ret).toEqual({})
  })

  it('M5-02：剩余可用 provider 是 auth.json-only catalog → 重选凭据优先的 anthropic（生产真实路径）', () => {
    // 场景：openai 承载 default，禁用后唯一剩余可用是 auth.json 凭据的 catalog provider
    // anthropic（不在 models.json——生产 findValidDefaultModel 的 fallback 只扫 models.json，
    // 看不到它；pickEnabledDefaultModel 的 B1 凭据优先经 listProviders 双源聚合能看到）。
    const { svc, store } = makeService({
      models: { openai: { models: [{ id: 'gpt-4' }] } },
      enabledModels: ['openai/*'],
      defaultModel: { provider: 'openai', modelId: 'gpt-4' },
      authIds: ['anthropic'],
    })
    const ret = svc.toggleProviderEnabled('openai', false)
    // 白名单更新前读到旧 default（openai）→ 重选 anthropic 并持久化
    expect(store.setDefaultModel).toHaveBeenCalledWith('anthropic', expect.any(String))
    expect(ret.newDefault?.provider).toBe('anthropic')
    // 关键：setDefaultModel 被调用（非惰性等下次 getDefaultModel auto-fix）
    expect(store.setDefaultModel).toHaveBeenCalledTimes(1)
  })

  it('MF-3：重选 default 时跳过候选 provider 的已禁用 model（model 级 enabled 校验，M5-02 路径）', () => {
    // 场景：openai 承载 default，禁用 openai 后重选到候选 provider，但其 models[0]
    // 被用户显式禁用（enabled:false）。旧实现 pickEnabledDefaultModel 只校验 provider 级
    // p.enabled + p.models[0] 存在性，会把已禁用 model 写成新 default。修复后 find 首个启用 model。
    // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，会掩盖
    // 「跳过禁用 model」的意图——custom 候选集固定为 mock 的 models）。
    const { svc, store } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        'other-llm': { models: [{ id: 'disabled-m', enabled: false }, { id: 'enabled-m', enabled: true }] },
      },
      enabledModels: ['openai/*', 'other-llm/*'],
      defaultModel: { provider: 'openai', modelId: 'gpt-4' },
    })
    const ret = svc.toggleProviderEnabled('openai', false)
    // 重选跳过 disabled-m，选 enabled-m（首个启用 model）
    expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'enabled-m')
    expect(ret.newDefault).toEqual({ provider: 'other-llm', modelId: 'enabled-m' })
  })
})

// ══ TC6: setProvider 停用 provider 级 enabled 写入 ══════════════════════════════════

describe('TC6: setProvider 停用 provider 级 enabled 写入（C5）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('provider 级 enabled（data.enabled）不写入 models.json', () => {
    const { svc, store } = makeService({
      models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
    })
    svc.setProvider('openai', { enabled: false })
    const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
    // provider 级 enabled 不写入（停用——改由 enabledModels 承载）
    expect('enabled' in merged).toBe(false)
  })

  it('model 级 enabled（data.models[].enabled）不写入 models.json（G3 写侧切换，0161efce4）', () => {
    // model 级启停迁 config/providers.json modelStates（providers.json 侧的写入断言见
    // provider-write-side-switch.test.ts「model enabled 写 providers.json modelStates」），
    // models.json 不再落 pi schema 外的寄生 enabled 字段。
    const { svc, store } = makeService({
      models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
    })
    svc.setProvider('openai', { models: [{ id: 'gpt-4', enabled: false }] })
    const merged = store.upsertProvider.mock.calls[0][1] as { models: Array<{ id: string; enabled?: boolean }> }
    expect('enabled' in merged.models[0]).toBe(false)
  })
})

// ══ setProvider 边界1 守卫——新建 provider 加白名单 ══════════════════════════════════

describe('setProvider 边界1守卫：新建 provider 时 ensureProviderInWhitelist（TC5 setProvider 路径）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('新建 provider（existingConfig===undefined）→ ensureProviderInWhitelist 调用', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.setProvider('my-custom', { name: 'My', models: [{ id: 'm1' }] })
    expect(store.ensureProviderInWhitelist).toHaveBeenCalledWith('my-custom')
  })

  it('已有 provider（existingConfig!==undefined）→ ensureProviderInWhitelist 不调用', () => {
    const { svc, store } = makeService({
      models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
      enabledModels: ['openai/*'],
    })
    svc.setProvider('openai', { name: 'OpenAI Renamed' })
    expect(store.ensureProviderInWhitelist).not.toHaveBeenCalled()
  })
})

// ══ TC7: 联动验证——toggle 后 listProviders 的 enabled 派生正确 ═══════════════════════

describe('TC7: 联动——toggle 后 listProviders 的 enabled 派生正确反映', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('toggle(openai,false) 后 listProviders：openai→false，anthropic→true', () => {
    const { svc } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['openai/*', 'anthropic/*'],
    })
    svc.toggleProviderEnabled('openai', false)
    const byId = Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
    expect(byId['openai'].enabled).toBe(false)
    expect(byId['anthropic'].enabled).toBe(true)
  })

  it('toggle(openai,true) 加白名单后 listProviders：openai→true', () => {
    const { svc } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['anthropic/*'],
    })
    // toggle 前 openai 未在白名单 → enabled=false
    expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(false)
    svc.toggleProviderEnabled('openai', true)
    expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(true)
  })
})

// ══ 边界3 持久化（CL2）：真实 pi-settings-store 验证 delete 字段后 settings.json 无 key ════

describe('边界3 持久化（CL2）：clearEnabledModels 后 settings.json 物理无 enabledModels key', () => {
  let dir: string
  let agentDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'toggle-bd3-'))
    agentDir = join(dir, 'agent')
    mkdirSync(agentDir, { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it("setEnabledModels(['openai/*']) 后 clearEnabledModels → settings.json 无 enabledModels key", () => {
    // 先写一个非空白名单
    setEnabledModels(['openai/*'])
    let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['openai/*'])

    // clearEnabledModels 用 updateSettingsFields('model', delete) 删字段
    clearEnabledModels()
    // 文件仍存在（只删 key，非删文件）
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(true)
    // JSON.stringify 丢弃 undefined 字段 → settings.json 物理无 enabledModels key
    raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect('enabledModels' in raw).toBe(false)
  })

  it("ensureProviderInWhitelist：enabledModels 非空时加 <id>/*，空时 no-op（真实行为）", () => {
    // 空（全可用）→ no-op，settings.json 不出现 enabledModels
    ensureProviderInWhitelist('openai')
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)

    // 非空 → 加 pattern
    setEnabledModels(['anthropic/*'])
    ensureProviderInWhitelist('openai')
    const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['anthropic/*', 'openai/*'])

    // 幂等：重复加同 id 不重复
    ensureProviderInWhitelist('openai')
    const raw2 = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw2.enabledModels).toEqual(['anthropic/*', 'openai/*'])
  })
})

/**
 * removeProviderByKind 测试（wave4，provider-dual-system-r2::provider-ui-by-kind IF3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-removebykind.test.ts
 *
 * 覆盖 design TC2/TC3 + 边界3(a)：
 *   - TC2 catalog 分支：清 auth.json 凭据 + 清 models.json override（removeProvider）+ 清 enabledModels 残留。
 *     不删 pi catalog 定义（本测试只验证 xyz-agent 侧清理动作，pi 定义不可触达故不断言）。
 *   - TC3 custom 分支：删 models.json 条目（removeProvider）+ 清残留。
 *   - 边界3(a) 残留清除空数组守卫：清完残留后白名单空 → cleanEnabledModelsResidue 调 clearEnabledModels（非 setEnabledModels([])）。
 *
 * 策略：mock IConfigStore（写方法 vi.fn 断言路由）+ mock authStorage.remove 断言清凭据调用。
 * makeStore 借鉴 config-service-toggle.test.ts 的状态化 mock 模式，但本测试聚焦「调用路由」
 * 而非 read-after-write，故 store 用最小 mock（getEnabledModels 返固定白名单即可）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import type { IConfigStore, ConfigModelsConfig } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

interface StoreOpts {
  /** models.json providers（默认空）。 */
  models?: ConfigModelsConfig['providers']
  /** settings.json.enabledModels（默认空 = 全启用）。 */
  enabledModels?: string[]
}

/**
 * 最小 mock IConfigStore：写方法 vi.fn 供断言路由，读方法返固定值。
 * removeProvider 返回 removed:true（catalog override 存在时；custom 删除时）。
 */
function makeStore(opts: StoreOpts = {}) {
  const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
  return {
    readModels: vi.fn(() => ({ providers: models })),
    getEnabledModels: vi.fn(() => [...(opts.enabledModels ?? [])]),
    getDefaultModel: vi.fn(() => null),
    getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
    setEnabledModels: vi.fn(),
    clearEnabledModels: vi.fn(),
    setDefaultModel: vi.fn(),
    ensureProviderInWhitelist: vi.fn(),
    cleanEnabledModelsResidue: vi.fn(),
    upsertProvider: vi.fn(),
    applyTypeTranslation: vi.fn((t: string) => t),
    removeProvider: vi.fn(() => ({ removed: true })),
  } as unknown as IConfigStore & {
    setEnabledModels: ReturnType<typeof vi.fn>
    clearEnabledModels: ReturnType<typeof vi.fn>
    cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
    removeProvider: ReturnType<typeof vi.fn>
  }
}

function makeAuth(): FullAuthPick {
  return {
    listCredentialIds: vi.fn(() => []),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as FullAuthPick
}

function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore>; auth: FullAuthPick } {
  const store = makeStore(opts)
  const auth = makeAuth()
  // M2fg 恒注入形态：凭据判定（含 M5-03 重选凭据优先）经 resolver 批量 sync 版，
  // 同源于上方 store/auth mock
  const resolver = new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: auth,
    configStore: store,
  })
  const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
  return { svc, store, auth }
}

// ══ TC2: catalog 分支——清 auth.json 凭据 + 清 override + 清残留 ═══════════════════════

describe('TC2: removeProviderByKind(catalog) 清 auth.json 凭据 + override + enabledModels 残留', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('调 authStorage.remove（清 catalog 凭据）', async () => {
    const { svc, auth } = makeService({ enabledModels: ['openai/*'] })
    await svc.removeProviderByKind('openai', 'catalog')
    expect(auth.remove).toHaveBeenCalledWith('openai')
  })

  it('调 configStore.removeProvider（清 models.json override 条目，若有）', async () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    await svc.removeProviderByKind('openai', 'catalog')
    expect(store.removeProvider).toHaveBeenCalledWith('openai')
  })

  it('调 configStore.cleanEnabledModelsResidue（清 enabledModels 残留 <id>/* 与 <id>/model）', async () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
    await svc.removeProviderByKind('openai', 'catalog')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
  })

  it('返回 removed:true（catalog 定义不可删，用户侧状态已清即视为移除成功）', async () => {
    const { svc } = makeService({ enabledModels: ['openai/*'] })
    const ret = await svc.removeProviderByKind('openai', 'catalog')
    expect(ret).toEqual({ removed: true })
  })

  it('MF1（exec-review must-fix）：catalog override 承载 default 时透传 removeProvider 的 newDefault', async () => {
    // 场景：catalog provider openai 有 override 且承载 defaultModel，removeProvider 删 override 时
    // 内部重选 default（anthropic/claude-3）+ mutate settings.json。catalog 分支须透传 newDefault，
    // 否则 handler 不广播 config.defaults → renderer 收不到重选通知（confirmDelete 防御性清空仅缓解显示）。
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      removed: true,
      newDefault: { provider: 'anthropic', modelId: 'claude-3' },
    })
    const ret = await svc.removeProviderByKind('openai', 'catalog')
    expect(ret).toEqual({ removed: true, newDefault: { provider: 'anthropic', modelId: 'claude-3' } })
  })

  it('authStorage.remove 失败（reject）不阻塞移除主流程（cleanAuthCredential try-catch warn）', async () => {
    const { svc, store, auth } = makeService({ enabledModels: ['openai/*'] })
    ;(auth.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))
    // await 完成：cleanAuthCredential try-catch 吞掉凭据清理异常，删除主流程不阻断
    const ret = await svc.removeProviderByKind('openai', 'catalog')
    expect(ret).toEqual({ removed: true })
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
  })

  it('回归：catalog 删除 await 凭据清理完成，返回后 listProviders 即不含该 provider（修复广播 stale）', async () => {
    // 模拟真实 AuthStorage.remove 的异步性：withFileLock（proper-lockfile）获锁有延迟，
    // fire-and-forget 时凭据未即时落盘。本测试构造带延迟的 remove，验证 removeProviderByKind
    // await 其完成才返回 → 返回后 listProviders 立即反映凭据已清（广播拿到的就是干净列表）。
    const credentialIds = new Set<string>(['openai'])
    const auth = {
      listCredentialIds: vi.fn(() => [...credentialIds]),
      hasCredentialSync: vi.fn((id: string) => credentialIds.has(id)),
      remove: vi.fn(async (id: string) => {
        await new Promise(r => setTimeout(r, 5))
        credentialIds.delete(id)
      }),
      set: vi.fn().mockResolvedValue(undefined),
      hasOAuth: vi.fn(() => false),
      hasOAuthSync: vi.fn(() => false),
    } as unknown as FullAuthPick
    const store = makeStore({})
    // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（同源于本用例 auth mock——
    // remove 后 listCredentialIds 返回的集合随之变化，resolver 读同一 mock）
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth,
      configStore: store,
    })
    const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)

    // 删除前：openai 凭据在 auth.json → listProviders catalog 聚合显示
    expect(svc.listProviders().some(p => p.id === 'openai')).toBe(true)

    await svc.removeProviderByKind('openai', 'catalog')

    // 关键回归断言：await 返回时凭据已清，listProviders 不再显示 openai。
    // 若改回 fire-and-forget，此断言失败（凭据 5ms 后才删，返回后立即查仍在）。
    expect(svc.listProviders().some(p => p.id === 'openai')).toBe(false)
  })

  it('M5-03：catalog 无 override（removeProvider 返回 removed:false）且 default 承载该 provider → 显式重选并持久化', async () => {
    // 场景：catalog provider openai 无 models.json override（导入后常态形态），但 settings.json
    // default 承载它。removeProvider 提前 return {removed:false} 跳过默认清理（旧实现残留
    // 指向无凭据 provider 的 default）。修复：显式 pickEnabledDefaultModel 重选
    // + setDefaultModel 持久化 + 透传 newDefault 供广播。
    // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，重选结果随
    // builtin 目录漂移——custom 候选集固定为 mock 的 models，聚焦重选触发本身）。
    const { svc, store } = makeService({
      models: { 'other-llm': { models: [{ id: 'their-m' }] } },
      enabledModels: ['openai/*', 'other-llm/*'],
    })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
    ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'openai', modelId: 'gpt-4' })

    const ret = await svc.removeProviderByKind('openai', 'catalog')

    expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
    expect(ret).toEqual({ removed: true, newDefault: { provider: 'other-llm', modelId: 'their-m' } })
  })

  it('M5-03：catalog 无 override + default 承载该 provider + 无其他启用 provider → 不重选（无候选）', async () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
    ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'openai', modelId: 'gpt-4' })

    const ret = await svc.removeProviderByKind('openai', 'catalog')

    expect(store.setDefaultModel).not.toHaveBeenCalled()
    expect(ret).toEqual({ removed: true })
  })

  it('M5-03：catalog 无 override 且 default 不承载该 provider → 不重选', async () => {
    const { svc, store } = makeService({
      models: { anthropic: { models: [{ id: 'claude-3' }] } },
      enabledModels: ['anthropic/*'],
    })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
    ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'anthropic', modelId: 'claude-3' })

    const ret = await svc.removeProviderByKind('openai', 'catalog')

    expect(store.setDefaultModel).not.toHaveBeenCalled()
    expect(ret).toEqual({ removed: true })
  })

  it('MF-2：cleanEnabledModelsResidue 改白名单后 getDefaultModel auto-fix 不应跳过重选（预读修复）', async () => {
    // 复现生产缺陷：PiConfigStore.getDefaultModel 内部 findValidDefaultModel 在白名单变更后
    // auto-fix 重选。旧实现在 cleanEnabledModelsResidue（白名单变更）之后才读 default，
    // oldDefault.provider 已被 auto-fix 成别的 provider，oldDefault.provider === providerId
    // 恒 false，M5-03 显式 B1 凭据优先重选不可达。
    // 状态化 mock：getDefaultModel 在 cleanEnabledModelsResidue 前返 openai（真旧 default），
    // 之后返 other-llm（auto-fix 重选值）。修复（预读）后 getDefaultModel 在 clean 前被调用 →
    // oldDefault=openai，重选触发。旧实现该断言失败（setDefaultModel 未调用）。
    // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，重选结果随
    // builtin 目录漂移——custom 候选集固定为 mock 的 models）。
    const { svc, store } = makeService({
      models: { 'other-llm': { models: [{ id: 'their-m' }] } },
      enabledModels: ['openai/*', 'other-llm/*'],
    })
    let cleanCalled = false
    ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockImplementation(() =>
      cleanCalled ? { provider: 'other-llm', modelId: 'their-m' } : { provider: 'openai', modelId: 'gpt-4' },
    )
    ;(store.cleanEnabledModelsResidue as ReturnType<typeof vi.fn>).mockImplementation(() => { cleanCalled = true })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })

    const ret = await svc.removeProviderByKind('openai', 'catalog')

    // 修复后：预读 oldDefault=openai（clean 前），重选触发，setDefaultModel 被调
    expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
    expect(ret).toEqual({ removed: true, newDefault: { provider: 'other-llm', modelId: 'their-m' } })
  })

  // [2026-09 测试舰队审查 r2-24] MF-3（M5-03 路径）用例已删：与 config-service-toggle.test.ts
  // MF-3（M5-02 路径）同测 pickEnabledDefaultModel 跳过禁用 model，二留一保留 toggle 版
  // （其状态化 mock 更接近生产路径）。
})

// ══ TC3: custom 分支——删 models.json 条目 + 清残留 ═══════════════════════════════════

describe('TC3: removeProviderByKind(custom) 删 models.json 条目 + 清 enabledModels 残留', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('调 configStore.removeProvider（删 custom 定义条目）', async () => {
    const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
    await svc.removeProviderByKind('my-custom', 'custom')
    expect(store.removeProvider).toHaveBeenCalledWith('my-custom')
  })

  it('调 configStore.cleanEnabledModelsResidue（清残留）', async () => {
    const { svc, store } = makeService({ enabledModels: ['my-custom/*', 'openai/*'] })
    await svc.removeProviderByKind('my-custom', 'custom')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('my-custom')
  })

  it('不调 authStorage.remove（custom 凭据在 models.json，删条目即清，不走 auth.json）', async () => {
    const { svc, auth } = makeService({ enabledModels: ['my-custom/*'] })
    await svc.removeProviderByKind('my-custom', 'custom')
    expect(auth.remove).not.toHaveBeenCalled()
  })

  it('透传 removeProvider 返回值（含 default 重选 newDefault）', async () => {
    const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      removed: true,
      newDefault: { provider: 'openai', modelId: 'gpt-4' },
    })
    const ret = await svc.removeProviderByKind('my-custom', 'custom')
    expect(ret).toEqual({ removed: true, newDefault: { provider: 'openai', modelId: 'gpt-4' } })
  })
})

// ══ 边界3(a): cleanEnabledModelsResidue 空数组守卫（pi-provider-store 层） ════════════
// 注：removeProviderByKind 调 configStore.cleanEnabledModelsResidue（port），实际守卫逻辑
// 在 pi-provider-store.cleanEnabledModelsResidue。此用例直接测 pi-provider-store 导出函数，
// 验证「重算空 → clearEnabledModels（delete 字段，非 setEnabledModels([])）」的边界3(a) 守卫。

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('边界3(a): cleanEnabledModelsResidue 重算空 → clearEnabledModels（delete 字段，CL2）', () => {
  let dir: string
  let agentDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'clean-residue-'))
    agentDir = join(dir, 'agent')
    mkdirSync(agentDir, { recursive: true })
    process.env.XYZ_AGENT_DATA_DIR = dir
  })

  afterEach(() => {
    delete process.env.XYZ_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('多 pattern 移除后非空 → setEnabledModels(remaining)；再清至空 → delete enabledModels 字段', async () => {
    // 动态 import：测试体内拿函数引用，确保 setModelsPath/setSettingsPath 已指向临时目录后再调用
    const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
    const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()

    // 先写非空白名单（含 openai 多个 pattern + anthropic）
    setEnabledModels(['openai/*', 'openai/gpt-4', 'anthropic/*'])

    // 清 openai 残留 → 剩 anthropic/*（非空）→ setEnabledModels(['anthropic/*'])
    cleanEnabledModelsResidue('openai')
    let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['anthropic/*'])

    // 再清 anthropic 残留 → 剩空 → clearEnabledModels（delete 字段，CL2——非写空数组）
    cleanEnabledModelsResidue('anthropic')
    raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect('enabledModels' in raw).toBe(false)
  })

  it('startsWith 带斜杠防前缀碰撞：清 openai 不误删 openai-compatible/*', async () => {
    const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
    const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()

    setEnabledModels(['openai/*', 'openai-compatible/*'])
    cleanEnabledModelsResidue('openai')
    const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['openai-compatible/*'])
  })

  it('幂等：provider 不在白名单时 no-op（文件不重复写）', async () => {
    const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
    const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()

    setEnabledModels(['anthropic/*'])
    cleanEnabledModelsResidue('openai') // openai 本不在白名单
    const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['anthropic/*']) // 无变化
  })
})

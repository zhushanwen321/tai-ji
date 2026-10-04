/**
 * provider-importer 白名单守卫测试（wave3 TC5，provider-dual-system-r2::enabledmodels-dual-consume）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-importer-whitelist.test.ts
 *
 * 策略：mock pi-provider-store（upsertProvider/getProviderNames/ensureProviderInWhitelist 三个 importer
 * 依赖点），用真实 createPreview 注入 preview 缓存条目，调 applyImport 后断言 ensureProviderInWhitelist
 * 对每个 imported provider 调用、对 skipped/failed 不调用。ensureProviderInWhitelist 自身真实行为
 * （非空加 pattern / 空时 no-op / 幂等）见 config-service-toggle.test.ts 的真实 pi-settings-store 用例。
 *
 * 覆盖 design TC5（边界1 importer 新建 provider 白名单守卫）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock pi-provider-store：importer 从此 import upsertProvider/getProviderNames/ensureProviderInWhitelist
vi.mock('../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getProviderNames: vi.fn(() => []),
    upsertProvider: vi.fn(() => ({})),
    ensureProviderInWhitelist: vi.fn(),
  }
})

import { applyImport } from '../migration/provider-importer.js'
import { createPreview } from '../migration/preview-cache.js'
import { _resetCacheForTest } from '../migration/preview-cache.js'
// 确保 mock 生效后 import（拿到 mocked 版本）
import { getProviderNames, upsertProvider, ensureProviderInWhitelist } from '../../infra/pi/pi-provider-store.js'
import type { ParsedProvider } from '../migration/provider-parser.js'

const mockedGetProviderNames = vi.mocked(getProviderNames)
const mockedUpsertProvider = vi.mocked(upsertProvider)
const mockedEnsure = vi.mocked(ensureProviderInWhitelist)

/** 构造最小 ParsedProvider（custom，非 catalog，无 authStorage 时走 models.json upsert 路径）。 */
function makeParsed(sourceName: string): ParsedProvider {
  return {
    _sourceName: sourceName,
    _apiKeyExtracted: false,
    _credentialType: 'missing',
    _envVarName: undefined,
    _warnings: undefined,
    name: sourceName,
    models: [{ id: 'm1', name: 'M1' }],
  } as unknown as ParsedProvider
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetCacheForTest()
  mockedGetProviderNames.mockReturnValue([])
  mockedUpsertProvider.mockReturnValue({})
})

afterEach(() => {
  _resetCacheForTest()
})

describe('TC5: importer applyImport 新建 provider 白名单守卫（边界1 / C2）', () => {
  it('导入新 provider 后 → ensureProviderInWhitelist 对每个 imported 调用', async () => {
    const importId = createPreview('pi', [makeParsed('my-custom'), makeParsed('another')])
    const out = await applyImport(importId, ['my-custom', 'another'])
    expect('result' in out).toBe(true)
    if (!('result' in out)) throw new Error('apply should succeed')
    // 两个新 provider 都 imported
    expect(out.result.imported.filter((i) => i.status === 'imported')).toHaveLength(2)
    // ensureProviderInWhitelist 对每个 imported id 调用
    expect(mockedEnsure).toHaveBeenCalledWith('my-custom')
    expect(mockedEnsure).toHaveBeenCalledWith('another')
    expect(mockedEnsure).toHaveBeenCalledTimes(2)
  })

  it('skipped（duplicate-id）的 provider 不调 ensureProviderInWhitelist', async () => {
    // models.json 已有 'existing-one' → conflict skipped
    mockedGetProviderNames.mockReturnValue(['existing-one'])
    const importId = createPreview('pi', [makeParsed('existing-one'), makeParsed('new-one')])
    const out = await applyImport(importId, ['existing-one', 'new-one'])
    if (!('result' in out)) throw new Error('apply should succeed')
    // existing-one skipped，new-one imported
    expect(mockedEnsure).toHaveBeenCalledTimes(1)
    expect(mockedEnsure).toHaveBeenCalledWith('new-one')
    expect(mockedEnsure).not.toHaveBeenCalledWith('existing-one')
  })

  it('未勾选（selectedIds 不含）的 provider 不导入也不守卫', async () => {
    const importId = createPreview('pi', [makeParsed('a'), makeParsed('b'), makeParsed('c')])
    const out = await applyImport(importId, ['a', 'c'])
    if (!('result' in out)) throw new Error('apply should succeed')
    expect(mockedEnsure).toHaveBeenCalledWith('a')
    expect(mockedEnsure).toHaveBeenCalledWith('c')
    expect(mockedEnsure).not.toHaveBeenCalledWith('b')
    expect(mockedEnsure).toHaveBeenCalledTimes(2)
  })

  it('ensureProviderInWhitelist 在 upsertProvider 之后调用（先建 provider 再守卫）', async () => {
    const order: string[] = []
    mockedUpsertProvider.mockImplementation(() => { order.push('upsert'); return {} })
    mockedEnsure.mockImplementation(() => { order.push('ensure') })
    const importId = createPreview('pi', [makeParsed('x')])
    await applyImport(importId, ['x'])
    // upsert 先（建 provider），ensure 后（加白名单）——守卫依赖 provider 已建立
    expect(order).toEqual(['upsert', 'ensure'])
  })
})

/**
 * RT-5#2（code-harden 审计批次 2 ⑤ / M15）：导入路径复用 settings 侧 B-4b 模型字段白名单。
 *
 * 修复前：applyModelsWritePolicy 只做空串转译（translateModelSchemaFields），外部 models
 * 的畸形 cost 裸透传直写 models.json——pi 0.84.4 ModelConfig.load 对 schema 违规**整表拒载**
 * （node_modules dist core/model-config.js：validateModelsConfig.Check 失败 → 空 providers Map），
 * 一条畸形模型毒死全部自定义 provider。
 * 修复后：导入路径经 applyValidatedModelFields/sanitizeModelCost 同一套校验，非法值由
 * applyProviderEntry 的 per-entry catch 折叠为该条 status:'failed' + reason，不落盘。
 */
describe('RT-5#2: 导入路径模型字段白名单（非法 cost → 该条 failed，不落盘）', () => {
  /** 带模型 cost 的 ParsedProvider fixture（覆盖 makeParsed 的 models）。 */
  function parsedWithCost(sourceName: string, cost: unknown): ParsedProvider {
    return {
      ...makeParsed(sourceName),
      models: [{ id: 'm1', name: 'M1', cost }],
    } as unknown as ParsedProvider
  }

  it.each([
    ['负数分量', { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }],
    ['非数字分量', { input: '1', output: 2, cacheRead: 0, cacheWrite: 0 }],
    ['缺 cost 分量', { input: 1, output: 2 }],
    ['cost 非对象', 'not-an-object'],
  ])('非法 cost（%s）→ status:failed + reason 含 cost，upsertProvider 不落盘', async (_label, badCost) => {
    const importId = createPreview('pi', [parsedWithCost('bad-cost', badCost), makeParsed('good-entry')])
    const out = await applyImport(importId, ['bad-cost', 'good-entry'])
    expect('result' in out).toBe(true)
    if (!('result' in out)) throw new Error('apply should succeed')
    const bad = out.result.imported.find((i) => i.id === 'bad-cost')
    expect(bad?.status).toBe('failed')
    expect(bad?.reason).toContain('cost')
    // 坏条目不写盘
    expect(mockedUpsertProvider).not.toHaveBeenCalledWith('bad-cost', expect.anything())
    // 同批合法条目照常导入
    const good = out.result.imported.find((i) => i.id === 'good-entry')
    expect(good?.status).toBe('imported')
    expect(mockedUpsertProvider).toHaveBeenCalledWith('good-entry', expect.anything())
  })

  it('非法 reasoning（非布尔）→ status:failed + reason 含 reasoning', async () => {
    const provider = {
      ...makeParsed('bad-reasoning'),
      models: [{ id: 'm1', name: 'M1', reasoning: 'yes' }],
    } as unknown as ParsedProvider
    const importId = createPreview('pi', [provider])
    const out = await applyImport(importId, ['bad-reasoning'])
    if (!('result' in out)) throw new Error('apply should succeed')
    const item = out.result.imported.find((i) => i.id === 'bad-reasoning')
    expect(item?.status).toBe('failed')
    expect(item?.reason).toContain('reasoning')
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
  })

  it('合法 cost 四分量 → imported，写盘 cost 为白名单重建的四字段形态', async () => {
    const importId = createPreview('pi', [parsedWithCost('valid-cost', { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 })])
    const out = await applyImport(importId, ['valid-cost'])
    if (!('result' in out)) throw new Error('apply should succeed')
    expect(out.result.imported.find((i) => i.id === 'valid-cost')?.status).toBe('imported')
    expect(mockedUpsertProvider).toHaveBeenCalledTimes(1)
    const [id, config] = mockedUpsertProvider.mock.calls[0] as [string, { models: Array<{ cost: Record<string, unknown> }> }]
    expect(id).toBe('valid-cost')
    expect(config.models[0].cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 })
  })

  it('缺 id 的模型条目 → 整条丢弃 + warn，不阻断同 provider 其余合法模型', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const provider = {
        ...makeParsed('mixed-models'),
        models: [{ name: 'no-id-model' }, { id: 'm2', name: 'M2' }],
      } as unknown as ParsedProvider
      const importId = createPreview('pi', [provider])
      const out = await applyImport(importId, ['mixed-models'])
      if (!('result' in out)) throw new Error('apply should succeed')
      expect(out.result.imported.find((i) => i.id === 'mixed-models')?.status).toBe('imported')
      const [, config] = mockedUpsertProvider.mock.calls[0] as [string, { models: Array<{ id: string }> }]
      expect(config.models.map((m) => m.id)).toEqual(['m2'])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped model without id'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

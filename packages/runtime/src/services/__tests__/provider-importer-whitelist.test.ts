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

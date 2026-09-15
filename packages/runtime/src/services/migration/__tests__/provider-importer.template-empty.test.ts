/**
 * applyOrphanWithTemplate「模板八字段全缺 → nothing to import」failed 分支补测（R3 S-3）。
 *
 * 为什么独立文件：真实 builtin-providers.json 的 39 个模板全有 name/api/baseUrl，
 * 「全缺」分支在真实数据下不可达（防御分支，供模板数据退化为空壳时兜底）——需对
 * generated/builtin-providers.json 注入「只有 id 的模板」fixture 才能命中。注入是模块级
 * vi.mock，会覆盖同文件其他用例依赖的真实模板（sa3-i5 等），故独立成文件、mock 策略
 * 与 provider-importer.test.ts 逐字对齐（parseProviders / pi-provider-store / provider-catalog）。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/provider-importer.template-empty.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.mock 必须在 import 之前（vitest hoist），与 provider-importer.test.ts 同策略 ──

vi.mock('../provider-parser.js', () => ({
  parseProviders: vi.fn(() => null),
}))

vi.mock('../../../infra/pi/pi-provider-store.js', () => ({
  getProviderNames: vi.fn(() => []),
  upsertProvider: vi.fn(() => ({})),
  ensureProviderInWhitelist: vi.fn(),
}))

vi.mock('../../provider-catalog.js', () => ({
  isCatalogProvider: vi.fn(() => false),
}))

// 模板 fixture：只有 id（无 name/api/baseUrl/models）——applyProviderWritePolicy 八字段
// 全缺 → skipUpsert →「不物化空壳也不谎报 imported」分支（provider-importer.ts nothing to import）
vi.mock('../../../generated/builtin-providers.json', () => ({
  default: { providers: [{ id: 'ghost-provider', models: [] }] },
}))

import { previewImport, applyImport } from '../provider-importer.js'
import { parseProviders } from '../provider-parser.js'
import { getProviderNames, upsertProvider } from '../../../infra/pi/pi-provider-store.js'
import { _resetCacheForTest } from '../preview-cache.js'

describe('applyImport 孤儿凭据模板全缺（nothing to import failed 分支）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    vi.mocked(parseProviders).mockReturnValue(null)
    vi.mocked(getProviderNames).mockReturnValue([])
  })

  it('模板只有 id + env-bundle 态无可写 apiKey → failed reason=nothing to import，不物化空壳不调 upsertProvider', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [
        { providerId: 'ghost-provider', credentialType: 'env-bundle', apiKey: undefined, warnings: [] },
      ],
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const out = await applyImport(prev.importId, ['ghost-provider'])

    expect('result' in out).toBe(true)
    if (!('result' in out)) return
    // 模板匹配到了（不进 no built-in template match 分支），但无实质字段可落盘
    expect(out.result.imported).toHaveLength(1)
    expect(out.result.imported[0]).toMatchObject({
      id: 'ghost-provider',
      status: 'failed',
      reason: 'nothing to import',
    })
    expect(out.result.failedCount).toBe(1)
    expect(upsertProvider).not.toHaveBeenCalled()
  })
})

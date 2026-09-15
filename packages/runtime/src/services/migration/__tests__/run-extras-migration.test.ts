/**
 * runProviderExtrasMigration 薄包装单测（round 2 review MUST_FIX #3）。
 *
 * 覆盖（返回值契约 = main() 侧 sanitize 门控的依据）：
 * - 迁移成功（非 no-op）→ { ok: true, report 透传 } + console.log 摘要，store 参数原样转发
 * - 迁移成功且 no-op → 不打摘要日志（幂等启动不刷屏）
 * - 迁移 reject → 不上抛 + { ok: false } + console.warn（调用方必须据此跳过 sanitize，
 *   否则 models.json 空壳条目被物理删除、寄生数据永久丢失，round 1 review DG#3）
 *
 * main() 侧三行接线（index.ts：`if (outcome.ok) sanitizeInvalidProviders()`）在组合根内，
 * import 即执行 main() 不可直测——本组用例守住返回值契约，接线由 typecheck + 评审保证。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/migration/__tests__/run-extras-migration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock migrateProviderExtras：迁移主体已有真实文件系统测试
// （provider-extras-migration.test.ts），此处聚焦薄包装的成败/日志/透传语义
vi.mock('../provider-extras-migration.js', () => ({
  migrateProviderExtras: vi.fn(),
}))

import { runProviderExtrasMigration } from '../run-extras-migration.js'
import { migrateProviderExtras, type ProviderExtrasMigrationReport } from '../provider-extras-migration.js'
import type { IConfigStore } from '../../ports/config.js'
import type { TaijiProviderStore } from '../../provider-extras-store.js'

// 哨兵对象：migrate 已 mock，只需可断言「同一引用被转发」
const configStore = { sentinel: 'config-store' } as unknown as IConfigStore
const extrasStore = { sentinel: 'extras-store' } as unknown as TaijiProviderStore

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.mocked(migrateProviderExtras).mockReset()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('runProviderExtrasMigration（sanitize 门控返回值契约）', () => {
  it('迁移成功（非 no-op）→ { ok: true, report 透传 } + console.log 摘要，store 参数原样转发', async () => {
    const report: ProviderExtrasMigrationReport = {
      migrated: ['zai-coding-cn', 'ghost-shell'],
      removedShells: ['ghost-shell'],
      noOp: false,
      skippedExisting: ['p2'],
    }
    vi.mocked(migrateProviderExtras).mockResolvedValue(report)

    const outcome = await runProviderExtrasMigration(configStore, extrasStore)

    expect(outcome.ok).toBe(true)
    expect(outcome.report).toBe(report) // 同引用透传（调用方观测迁移详情）
    expect(migrateProviderExtras).toHaveBeenCalledTimes(1)
    expect(migrateProviderExtras).toHaveBeenCalledWith(configStore, extrasStore)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy.mock.calls[0][0]).toBe('[runtime] provider extras migration:')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('迁移成功且 no-op → { ok: true, report } 不打任何日志（幂等启动不刷屏）', async () => {
    const report: ProviderExtrasMigrationReport = { migrated: [], removedShells: [], noOp: true, skippedExisting: [] }
    vi.mocked(migrateProviderExtras).mockResolvedValue(report)

    const outcome = await runProviderExtrasMigration(configStore, extrasStore)

    expect(outcome).toEqual({ ok: true, report })
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('迁移 reject → 不上抛 + { ok: false }（门控依据：寄生数据仍在 models.json）+ console.warn', async () => {
    vi.mocked(migrateProviderExtras).mockRejectedValue(new Error('disk full'))

    const outcome = await runProviderExtrasMigration(configStore, extrasStore)

    expect(outcome).toEqual({ ok: false })
    expect(outcome.report).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('[runtime] provider extras migration failed (will retry on next startup):')
    expect(logSpy).not.toHaveBeenCalled()
  })
})

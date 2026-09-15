/**
 * A1-2 迁移的启动挂载薄包装（provider-config-quota 架构，round 2 review MUST_FIX #3 抽取）。
 *
 * 为什么从 index.ts main() 抽出：组合根 import 即执行 main()，测试无法直接驱动
 * 「迁移失败 → 跳过 sanitizeInvalidProviders」门控分支（coverage 实测 main 0% 命中）。
 * 抽成独立小模块后，门控语义固化为可单测的返回值契约——ok=false 表示迁移未完成
 * （寄生数据仍在 models.json），调用方必须跳过 sanitize，否则空壳条目被物理删除、
 * 其承载的寄生数据未保入 providers.json 即永久丢失（round 1 review DG#3）。
 * main() 只剩单行调用 + 条件 sanitize，接线由 typecheck + 评审保证。
 *
 * 语义与原 main() 内联实现逐行等价：成功 → { ok: true, report }（非 noOp 打 console.log
 * 摘要）；失败 → best-effort 不上抛 + warn（下次启动幂等重试）+ { ok: false }。
 */
import type { IConfigStore } from '../ports/config.js'
import type { TaijiProviderStore } from '../provider-extras-store.js'
import { migrateProviderExtras, type ProviderExtrasMigrationReport } from './provider-extras-migration.js'

export interface ExtrasMigrationOutcome {
  /** false = 迁移未完成（寄生数据仍在 models.json），调用方必须跳过 sanitizeInvalidProviders */
  ok: boolean
  /** 成功时的迁移报告（透传给调用方观测；失败时 undefined） */
  report?: ProviderExtrasMigrationReport
}

export async function runProviderExtrasMigration(
  configStore: IConfigStore,
  extrasStore: TaijiProviderStore,
): Promise<ExtrasMigrationOutcome> {
  try {
    const report = await migrateProviderExtras(configStore, extrasStore)
    if (!report.noOp) {
      console.log('[runtime] provider extras migration:', JSON.stringify({
        migrated: report.migrated.length,
        removedShells: report.removedShells,
        skippedExisting: report.skippedExisting.length,
      }))
    }
    return { ok: true, report }
  } catch (e) {
    // 启动期迁移 best-effort：失败不阻塞启动（warn + 下次启动幂等重试）
    console.warn('[runtime] provider extras migration failed (will retry on next startup):', e)
    return { ok: false }
  }
}

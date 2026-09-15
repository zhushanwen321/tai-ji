/**
 * A8 验收测试：shared/src/update.ts 导出 LAUNCH_RESULT_STATUSES。
 *
 * 验证三值联合常量（done/failed/rolled-back）已从 shared 层导出，
 * 供 main/preload/renderer 三方共享使用。
 *
 * 运行：cd packages/shared && npx vitest run __tests__/update-launch-result.test.ts
 */
import { describe, it, expect } from 'vitest'
import { LAUNCH_RESULT_STATUSES, type LaunchResultStatus, type LaunchResult } from '../src/update'

describe('A8-shared-types-export-vitest: shared update.ts 导出 LAUNCH_RESULT_STATUSES', () => {
  it('A8-shared-types-export-vitest: LAUNCH_RESULT_STATUSES 包含三个终态值', () => {
    expect(LAUNCH_RESULT_STATUSES).toEqual(['done', 'failed', 'rolled-back'])
    expect(LAUNCH_RESULT_STATUSES).toHaveLength(3)
  })

  it('A8-shared-types-export-vitest: LaunchResultStatus 三值联合类型可赋值', () => {
    const done: LaunchResultStatus = 'done'
    const failed: LaunchResultStatus = 'failed'
    const rolledBack: LaunchResultStatus = 'rolled-back'
    expect(done).toBe('done')
    expect(failed).toBe('failed')
    expect(rolledBack).toBe('rolled-back')
  })

  it('A8-shared-types-export-vitest: LaunchResult 接口可构造', () => {
    const result: LaunchResult = { status: 'done', version: '0.9.9' }
    expect(result.status).toBe('done')
    expect(result.version).toBe('0.9.9')
  })
})

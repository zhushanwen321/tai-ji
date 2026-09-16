/**
 * parseBackgroundBashDetails 单测（对话流系统通知渲染升级 D1/D2）。
 *
 * 覆盖：合法两形态（natural / timeout-exitCode-null）全字段解析 + 防御矩阵——
 * details 非对象形态、必需字段（taskId/command/durationMs/endReason）缺失/空串/类型异常、
 * endReason 非法值（killed / process-exit 等不可达值）、exitCode 类型异常、可空字段缺失归 null。
 *
 * 消费点：ui SystemNotice.vue 的 background-bash 分支（命中 → 结构化行；null → content 原文行，
 * 旧 session 逐字节回到现状渲染）。解析口径与 parseBgNotifyDetails 同款（shared 单点收敛）。
 *
 * 运行：cd packages/shared && npx vitest run __tests__/background-bash-details.test.ts
 */
import { describe, it, expect } from 'vitest'
import { parseBackgroundBashDetails } from '../src/message'

/** natural 成功形态（exit 0）。 */
const naturalDetails: Record<string, unknown> = {
  taskId: 'bt-3',
  command: 'pnpm test --workspace extensions',
  durationMs: 192000,
  endReason: 'natural',
  exitCode: 0,
}

describe('parseBackgroundBashDetails 合法输入', () => {
  it('natural：五字段原样解析（exit 0 成功形态）', () => {
    expect(parseBackgroundBashDetails(naturalDetails)).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'natural',
      exitCode: 0,
    })
  })

  it('timeout：exitCode null 正常解析（超时杀进程无退出码）', () => {
    expect(
      parseBackgroundBashDetails({ ...naturalDetails, endReason: 'timeout', exitCode: null }),
    ).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'timeout',
      exitCode: null,
    })
  })

  it('非 0 exitCode 原样透传（成败判色由渲染层按值决定，解析层不改写）', () => {
    const parsed = parseBackgroundBashDetails({ ...naturalDetails, exitCode: 2 })
    expect(parsed?.exitCode).toBe(2)
    expect(parsed?.endReason).toBe('natural')
  })

  it('exitCode 缺失 → 归 null（可空字段缺失非整体拒绝，降级只显命令 + 耗时）', () => {
    const { exitCode: _drop, ...withoutExitCode } = naturalDetails
    const parsed = parseBackgroundBashDetails(withoutExitCode)
    expect(parsed).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'natural',
      exitCode: null,
    })
  })

  it('字段集锁定：只取契约内五字段，多余字段不泄漏', () => {
    const parsed = parseBackgroundBashDetails({
      ...naturalDetails,
      content: '[background-bash] bt-3 finished (exit 0, 3m12s)',
      extra: 'noise',
    })
    expect(Object.keys(parsed as object)).toEqual(['taskId', 'command', 'durationMs', 'endReason', 'exitCode'])
  })
})

describe('parseBackgroundBashDetails 防御矩阵：details 非对象形态 → null', () => {
  it('null / undefined → null', () => {
    expect(parseBackgroundBashDetails(null)).toBeNull()
    expect(parseBackgroundBashDetails(undefined)).toBeNull()
  })

  it('原始类型（string / number / boolean）→ null', () => {
    expect(parseBackgroundBashDetails('[background-bash] bt-3 finished')).toBeNull()
    expect(parseBackgroundBashDetails(42)).toBeNull()
    expect(parseBackgroundBashDetails(true)).toBeNull()
  })

  it('数组 → null（数组是 object，须显式排除）', () => {
    expect(parseBackgroundBashDetails([naturalDetails])).toBeNull()
  })
})

describe('parseBackgroundBashDetails 防御矩阵：必需字段缺失/空串/类型异常 → null', () => {
  it('逐个缺必需字段 → null', () => {
    const { taskId: _t, ...noTaskId } = naturalDetails
    const { command: _c, ...noCommand } = naturalDetails
    const { durationMs: _d, ...noDuration } = naturalDetails
    const { endReason: _e, ...noEndReason } = naturalDetails
    expect(parseBackgroundBashDetails(noTaskId)).toBeNull()
    expect(parseBackgroundBashDetails(noCommand)).toBeNull()
    expect(parseBackgroundBashDetails(noDuration)).toBeNull()
    expect(parseBackgroundBashDetails(noEndReason)).toBeNull()
  })

  it('必需字段类型异常 → null', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, taskId: 3 })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, command: null })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, durationMs: '192000' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: true })).toBeNull()
  })

  it('taskId / command 为空串 → null（空串视为缺失，与 parseBgNotifyDetails 同款语义）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, taskId: '' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, command: '' })).toBeNull()
  })

  it('endReason 非法值 → null（killed / process-exit 不可达值不落 schema）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'killed' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'process-exit' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'completed' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: null })).toBeNull()
  })
})

describe('parseBackgroundBashDetails 防御矩阵：exitCode 类型异常 → 整体拒绝', () => {
  it('exitCode 非 number/null → null（可空字段同样不静默吞类型异常）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: '0' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: false })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: { code: 0 } })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: [0] })).toBeNull()
  })
})

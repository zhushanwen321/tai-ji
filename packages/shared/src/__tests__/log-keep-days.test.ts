/**
 * readLogKeepDays() 单测（u-foundation，设计 §3.3 D6-⑦）。
 *
 * 守护：env TAIJI_LOG_KEEP_DAYS 覆盖 || 默认 7 的语义与 runtime infra/logger.ts:50-55
 * 现状（KEEP_DAYS = Number(process.env.TAIJI_LOG_KEEP_DAYS) || DEFAULT_KEEP_DAYS）逐字
 * 等价——D6-⑦ 要求 main（每日清理定时器）与 runtime（initLogger 清理）两进程同调
 * 此函数，语义漂移即两套保留期（长寿运行期超龄日志无人清理 / 或误删活跃日志）。
 *
 * env 卫生：beforeEach 存原值、afterEach 还原（含「原本未设置」的 delete 分支），
 * 不污染同进程后续测试；本测试零 fs 操作（纯函数 + env）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOG_KEEP_DAYS, readLogKeepDays } from '../constants.js'

const ENV_KEY = 'TAIJI_LOG_KEEP_DAYS'
let originalValue: string | undefined

beforeEach(() => {
  originalValue = process.env[ENV_KEY]
})

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalValue
})

describe('readLogKeepDays（D6-⑦：env 覆盖 || 默认，等价 logger.ts 现状语义）', () => {
  it('env 未设置 → 返回默认 7', () => {
    delete process.env[ENV_KEY]
    expect(readLogKeepDays()).toBe(7)
  })

  it('env 设置合法正整数 → 覆盖生效', () => {
    process.env[ENV_KEY] = '3'
    expect(readLogKeepDays()).toBe(3)
  })

  it('env 设置非数字 → Number 为 NaN（falsy）回退默认 7', () => {
    process.env[ENV_KEY] = 'not-a-number'
    expect(readLogKeepDays()).toBe(7)
  })

  it("env 设置空串 → Number('') = 0（falsy）回退默认 7（现状语义）", () => {
    process.env[ENV_KEY] = ''
    expect(readLogKeepDays()).toBe(7)
  })

  it('env 设置 0 → falsy 回退默认 7（现状语义，0 非合法保留期）', () => {
    process.env[ENV_KEY] = '0'
    expect(readLogKeepDays()).toBe(7)
  })

  it('env 设置负数 → truthy 透传（等价现状，函数内不另加校验）', () => {
    process.env[ENV_KEY] = '-1'
    expect(readLogKeepDays()).toBe(-1)
  })

  it('DEFAULT_LOG_KEEP_DAYS 常量与函数默认同源（改一处两处生效）', () => {
    expect(DEFAULT_LOG_KEEP_DAYS).toBe(7)
    process.env[ENV_KEY] = String(DEFAULT_LOG_KEEP_DAYS + 2)
    expect(readLogKeepDays()).toBe(DEFAULT_LOG_KEEP_DAYS + 2)
  })

  it('显式 env 参与宿主 process.env 解耦：显式对象优先（renderer 传参契约）', () => {
    // 函数体回归为直读 process.env（忽略参数）时本用例红灯：宿主干扰值 30 ≠ 显式参 3
    process.env[ENV_KEY] = '30'
    expect(readLogKeepDays({ [ENV_KEY]: '3' })).toBe(3)
  })
})

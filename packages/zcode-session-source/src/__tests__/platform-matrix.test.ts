/**
 * 平台行为矩阵自证：
 * ① 解析层纯函数全组合覆盖——node 双平台恒已知、bun 已登记平台返回登记值、
 *    未登记平台显式 probe-fallback（未来新平台永不静默套用已知平台断言）；
 * ② 级别推导（expectedRestDbVia）与行为二元组的一致性全枚举；
 * ③ 当前 platform+isBun 组合的实测开库行为与矩阵对账——known 红灯 = bun 捆绑
 *    sqlite 语义漂移警报（修复路径 = 实测更新矩阵，不是放宽断言）。
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import {
  buildFixtureDb,
  defaultTranscriptSeeds,
  makeFixtureDir,
} from './helpers.ts'
import {
  expectProbeOutcomeAccounting,
  expectedRestDbVia,
  probeRestDbDirectOpen,
  probeRestDbImmutableUriOpen,
  resolveRestDbExpectation,
  type RestDbPlatformBehavior,
} from './platform-matrix.ts'

const SEED_SESSION_COUNT = 2 // defaultTranscriptSeeds 的 session 行数（探测计数对账基线）

describe('bun:sqlite 静息态平台行为矩阵', () => {
  it('解析层：node 恒已知（works/works）；bun 已登记平台返回登记值；未登记平台显式 probe-fallback', () => {
    // node 无平台分叉（含未登记的 win32——node 组合不查 bun 矩阵）
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(resolveRestDbExpectation({ isBun: false, platform })).toEqual({
        kind: 'known',
        behavior: { readonlyDirectOpen: 'works', immutableUriOpen: 'works' },
      })
    }
    // bun 已登记平台：登记值即实测矩阵（darwin/linux 互补分叉）
    expect(resolveRestDbExpectation({ isBun: true, platform: 'darwin' })).toEqual({
      kind: 'known',
      behavior: { readonlyDirectOpen: 'throws', immutableUriOpen: 'works' },
    })
    expect(resolveRestDbExpectation({ isBun: true, platform: 'linux' })).toEqual({
      kind: 'known',
      behavior: { readonlyDirectOpen: 'works', immutableUriOpen: 'throws' },
    })
    // bun 未登记平台（如 win32）：显式兜底——新平台永不静默走已知平台的断言分支
    expect(resolveRestDbExpectation({ isBun: true, platform: 'win32' })).toEqual({ kind: 'probe-fallback' })
  })

  it('级别推导：直开 works → L1；直开抛 ∧ URI works → L2；双抛 → L3（快照兜底）', () => {
    const behavior = (direct: 'works' | 'throws', immutable: 'works' | 'throws'): RestDbPlatformBehavior => ({
      readonlyDirectOpen: direct,
      immutableUriOpen: immutable,
    })
    expect(expectedRestDbVia(behavior('works', 'works'))).toBe('L1-direct')
    expect(expectedRestDbVia(behavior('works', 'throws'))).toBe('L1-direct')
    expect(expectedRestDbVia(behavior('throws', 'works'))).toBe('L2-immutable')
    expect(expectedRestDbVia(behavior('throws', 'throws'))).toBe('L3-snapshot')
  })

  // 真实 sqlite fixture 单条的时间预算由 vitest.config.ts 包级 testTimeout 承担
  it('当前组合对账：实测开库行为与矩阵一致（known 红灯 = 漂移警报）', async () => {
    const expectation = resolveRestDbExpectation()
    // 两项探测各自独立 fixture：直开探测在 node 侧会创建 -shm/-wal 附属文件，
    // 隔离后 URI 探测不受污染（immutable 面的对账须在真静息态上跑）
    const fx1 = makeFixtureDir('zss-matrix-direct-')
    try {
      await buildFixtureDb(fx1.root, defaultTranscriptSeeds(), { quiesce: true })
      const direct = await probeRestDbDirectOpen(join(fx1.root, 'db.sqlite'))
      expectProbeOutcomeAccounting(direct, 'readonlyDirectOpen', expectation, SEED_SESSION_COUNT)
    } finally {
      fx1.cleanup()
    }
    const fx2 = makeFixtureDir('zss-matrix-imm-')
    try {
      await buildFixtureDb(fx2.root, defaultTranscriptSeeds(), { quiesce: true })
      const immutable = await probeRestDbImmutableUriOpen(join(fx2.root, 'db.sqlite'))
      expectProbeOutcomeAccounting(immutable, 'immutableUriOpen', expectation, SEED_SESSION_COUNT)
    } finally {
      fx2.cleanup()
    }
  })
})

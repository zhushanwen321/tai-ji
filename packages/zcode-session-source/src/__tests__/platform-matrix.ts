/**
 * bun:sqlite 静息态平台行为矩阵（测试断言的环境偶然性登记处）。
 *
 * bun 各平台构建捆绑的 sqlite 行为不一致：同 bun 1.3.8 下，darwin 与 linux 对
 * 静息态库（-wal 缺失）的两项开库行为完全相反。把单平台实测钉成跨平台事实的
 * 断言必在另一平台红灯——行为面按本矩阵显式分叉，断言与矩阵对账。
 *
 * [HISTORICAL] 矩阵实测登记（linux 值 = 2026-09-24 CI Linux bun 1.3.8 实测；
 * darwin 值 = 本机 bun 1.3.8 实测）：
 *   darwin bun：静息态 readonly 直开抛 CANTOPEN（F22，目录可写也失败）；
 *               file:?immutable=1 URI 开库成功 → 恢复阶梯命中 L2
 *   linux  bun：静息态 readonly 直开成功且全行可读；immutable URI 抛
 *               unable to open database file → 恢复阶梯命中 L1
 * node:sqlite 无平台分叉（darwin/linux CI 双绿）：直开与 URI 开库均 works
 * （直开成功但创建 -shm/-wal 附属，F24）。
 *
 * 矩阵即漂移警报：对账红灯 = bun 捆绑 sqlite 语义变化（bun 大版本升级须重验，
 * sqlite-driver/recovery 设计注释已声明该义务）——修复路径是实测后更新本矩阵
 * 并重验，不是放宽断言。
 */

import { expect } from 'vitest'

import { loadSqliteDriver, toSqliteFileUri, type SqliteDb } from '../sqlite-driver.ts'
import { isBun } from './helpers.ts'

/** 开库探测结果：works = open ∧ 探测查询双成功（与生产 tryOpen 的成功判定同构）。 */
export type ProbeOutcome = 'works' | 'throws'

/** 静息态库开库探测产物。 */
export interface RestDbOpenProbe {
  outcome: ProbeOutcome
  /** works 时的 session 表全行数（「可读」的量化证据，非仅「没抛」）。 */
  rowCount?: number
  /** throws 时的错误对象（归因留证；断言不依赖具体 message 文案）。 */
  error?: unknown
}

/** 平台行为二元组（矩阵登记项）。 */
export interface RestDbPlatformBehavior {
  /** 静息态 readonly 直开 + 探测查询。node 恒 works（F24：成功但创建附属文件）。 */
  readonlyDirectOpen: ProbeOutcome
  /** file:<db>?immutable=1 URI 开库 + 探测查询。node 恒 works。 */
  immutableUriOpen: ProbeOutcome
}

/** node:sqlite 行为（无平台分叉）。 */
const NODE_BEHAVIOR: RestDbPlatformBehavior = { readonlyDirectOpen: 'works', immutableUriOpen: 'works' }

/** bun:sqlite 平台矩阵（bun 1.3.8 实测登记；新平台先实测登记再进此表）。 */
const BUN_PLATFORM_MATRIX: Readonly<Record<string, RestDbPlatformBehavior>> = {
  darwin: { readonlyDirectOpen: 'throws', immutableUriOpen: 'works' },
  linux: { readonlyDirectOpen: 'works', immutableUriOpen: 'throws' },
}

/** 解析产物两态：known = 矩阵已登记（断言按登记值对账）；probe-fallback = 未登记平台（探测式断言兜底）。 */
export type RestDbExpectation =
  | { kind: 'known'; behavior: RestDbPlatformBehavior }
  | { kind: 'probe-fallback' }

/** 矩阵解析的运行时组合（可注入——纯函数全组合测试用）。 */
export interface RuntimeEnv {
  isBun: boolean
  platform: string
}

/** 解析当前（或注入的）运行时组合的矩阵期望。 */
export function resolveRestDbExpectation(env: RuntimeEnv = { isBun, platform: process.platform }): RestDbExpectation {
  if (!env.isBun) return { kind: 'known', behavior: NODE_BEHAVIOR }
  const behavior = BUN_PLATFORM_MATRIX[env.platform]
  return behavior ? { kind: 'known', behavior } : { kind: 'probe-fallback' }
}

/**
 * 静息态库 openWithRecovery 预期命中级别（由行为二元组推导，单一来源——与两项
 * 开库行为登记值不可能矛盾）。双抛形态落到 L3 快照兜底。
 */
export function expectedRestDbVia(behavior: RestDbPlatformBehavior): 'L1-direct' | 'L2-immutable' | 'L3-snapshot' {
  if (behavior.readonlyDirectOpen === 'works') return 'L1-direct'
  if (behavior.immutableUriOpen === 'works') return 'L2-immutable'
  return 'L3-snapshot'
}

/**
 * 探测一次静息态开库行为。fixture 须含 session 表（探测查询的计数对象）。
 * 探测查询必跑：bun/node 双端开库均惰性（open 不抛、首查询才报错），不跑查询则
 * works/throws 语义在双端不可对齐（与生产 tryOpen 的 open+probe 判定同构）。
 */
async function probeRestDb(dbPath: string, immutable: boolean): Promise<RestDbOpenProbe> {
  const driver = await loadSqliteDriver()
  const target = immutable ? toSqliteFileUri(dbPath, true) : dbPath
  let db: SqliteDb | undefined
  try {
    db = driver.open(target, { readOnly: true })
    const row = db.prepare('SELECT COUNT(*) AS c FROM session').get() as Record<string, unknown> | undefined
    return { outcome: 'works', rowCount: Number(row?.['c']) }
  } catch (error) {
    return { outcome: 'throws', error }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* 探测归因以 open/查询结果为准，close 失败不参与 */
      }
    }
  }
}

/** 探测：静息态库 readonly 直开 + 探测查询。 */
export function probeRestDbDirectOpen(dbPath: string): Promise<RestDbOpenProbe> {
  return probeRestDb(dbPath, false)
}

/** 探测：静息态库 file:?immutable=1 URI 开库 + 探测查询。 */
export function probeRestDbImmutableUriOpen(dbPath: string): Promise<RestDbOpenProbe> {
  return probeRestDb(dbPath, true)
}

/**
 * 探测结果与矩阵对账（漂移警报挂点）：
 * - known：实测 outcome 必须等于登记值——bun 升级改变捆绑 sqlite 语义时此处红灯；
 * - probe-fallback（未登记平台）：不假装知道方向（works/throws 均可接受），但
 *   works 仍必须全行可读（rowCount 对账），不是无断言放行。
 */
export function expectProbeOutcomeAccounting(
  probe: RestDbOpenProbe,
  axis: 'readonlyDirectOpen' | 'immutableUriOpen',
  expectation: RestDbExpectation,
  expectedRowCount: number,
): void {
  if (expectation.kind === 'known') {
    expect(probe.outcome).toBe(expectation.behavior[axis])
  }
  if (probe.outcome === 'works') {
    expect(probe.rowCount).toBe(expectedRowCount)
  }
}

/**
 * 触发条件评估器单测（crash-forensics-and-watchdog §3.3 D2，附录 A 20 条）。
 *
 * 纯内存 fixture（JSONL 行数组），无文件 IO——main 池 legacy 纯逻辑测试。
 * 断言矩阵（对齐实施计划 u2 验收）：
 *   - 20 条与附录 A 一一对应（全量清单断言，防漏条）
 *   - 计数类 #1/2/3/7/9/10 各自越线/未越线两态（#8/#16 独立 describe）
 *   - #8 四子句 + absent-report 排除子句单独断言
 *   - #16 计划内（shutdown 杀链发起）关联排除断言
 *   - 趋势类 #4 coverage<50% 降权断言；#5 数据就绪标注
 *   - requires-user-report 与 #17 的 no-data 标注断言
 *   - 坏行/空台账 → no-data 非静默（skippedLineCount 可辨）
 *   - trigger-review 出口断言（writer 收到带条件 id 的事件）
 */
import { describe, expect, it } from 'vitest'
import { evaluateTriggerConditions, TRIGGER_CONDITION_COUNT, TRIGGER_USER_REPORT_IDS } from '../diagnostics/trigger-evaluator.js'
import type { TriggerConditionRow } from '../diagnostics/trigger-evaluator.js'
import { runTriggerPatrol } from '../diagnostics/trigger-patrol.js'

// ── fixture 基建 ─────────────────────────────────────────────────────────────

/** 固定锚点（不依赖真实时钟）：2026-09-10T12:00:00Z。 */
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0)
const DAY = 86_400_000
const MIN = 60_000

/** 构造一行台账 JSONL（ts 转 ISO，字段按 schema 开放形态）。 */
const ev = (tsMs: number, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: new Date(tsMs).toISOString(), ...fields })

/** n 条同型事件（时刻逐条 +1ms，保持同窗同秒语义由调用方控制）。 */
const repeatEv = (n: number, tsMs: number, fields: Record<string, unknown> = {}): string[] =>
  Array.from({ length: n }, (_, i) => ev(tsMs + i, fields))

const rowById = (rows: TriggerConditionRow[], id: number): TriggerConditionRow => {
  const row = rows.find((r) => r.id === id)
  expect(row, `条件 #${id} 必须在状态表中`).toBeDefined()
  return row as TriggerConditionRow
}

const evaluate = (mainLines: string[], runtimeLines: string[], now?: number) =>
  evaluateTriggerConditions({ mainLines, runtimeLines, now })

// ── 全量清单（附录 A 一一对应，防漏条）───────────────────────────────────────

describe('全量清单：20 条与附录 A 一一对应', () => {
  const empty = evaluate([], [])

  it('rows 恰 20 条、id 1..20 升序', () => {
    expect(TRIGGER_CONDITION_COUNT).toBe(20)
    expect(empty.rows).toHaveLength(20)
    expect(empty.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  })

  it('每条描述与附录 A 条件文本对应（关键标识子串逐条断言）', () => {
    const expectedSubstrings: ReadonlyArray<[number, string]> = [
      [1, '截断告警周均 >10'],
      [2, '注册表 miss'],
      [3, 'supervisor 重启频率显著上升'],
      [4, '水位长期不回落'],
      [5, 'base64'],
      [6, '活跃态 Trace 降级重审'],
      [7, 'auto-respawn 周均 >5'],
      [8, 'defer-limit 占 forced >30%'],
      [9, 'renderer reload 月均 >4'],
      [10, '第三方扩展崩溃月均 >2'],
      [11, 'crashReporter 立项'],
      [12, '草稿持久化立项'],
      [13, '大文本可见差异反馈'],
      [14, '加载更早'],
      [15, 'Trace 首个真实命中'],
      [16, '连坐复发'],
      [17, '降级反弹'],
      [18, '漏推迟首案例'],
      [19, '终端终止抱怨'],
      [20, '脱敏版诊断导出'],
    ]
    for (const [id, substring] of expectedSubstrings) {
      const row = rowById(empty.rows, id)
      expect(row.description, `#${id} 描述`).toContain(substring)
      expect(row.threshold.length, `#${id} 阈值非空`).toBeGreaterThan(0)
    }
  })

  it('requires-user-report 型恰为评估器注册表声明的 9 条（恒 no-data 显式列出）', () => {
    const expected = [...TRIGGER_USER_REPORT_IDS]
    expect(expected).toEqual([6, 11, 12, 13, 14, 15, 18, 19, 20])
    const flagged = empty.rows.filter((r) => r.requiresUserReport === true).map((r) => r.id)
    expect(flagged).toEqual(expected)
    for (const id of expected) {
      const row = rowById(empty.rows, id)
      expect(row.status).toBe('no-data')
      expect(row.requiresUserReport).toBe(true)
    }
    // 其余 11 条不带该标注
    const unflagged = empty.rows.filter((r) => !expected.includes(r.id))
    expect(unflagged.every((r) => r.requiresUserReport !== true)).toBe(true)
  })

  it('#17 恒 no-data 且标注消费方 = Gate W 人工复审', () => {
    const withData = evaluate(
      [],
      repeatEv(3, T0 - DAY, { layer: 'runtime', event: 'watermark-daily', detailDigest: '{"heapMax":1000000000}' }),
      T0,
    )
    for (const result of [empty, withData]) {
      const row = rowById(result.rows, 17)
      expect(row.status).toBe('no-data')
      expect(row.note).toContain('Gate W')
    }
  })

  it('空台账 → 全表 no-data 非静默（无锚定时刻、无事件标注、零越线）', () => {
    expect(empty.nowIso).toBeNull()
    expect(empty.trippedIds).toEqual([])
    expect(empty.parsedEventCount).toEqual({ main: 0, runtime: 0 })
    for (const row of empty.rows) {
      expect(row.status).toBe('no-data')
    }
    expect(rowById(empty.rows, 1).note).toContain('空台账')
    expect(rowById(empty.rows, 3).note).toContain('空台账')
  })
})

// ── 计数类两态（#1/2/3/7/9/10）───────────────────────────────────────────────

describe('计数类两态', () => {
  it('#1 frame-truncated(warn-tier)：10 次 ok / 11 次 tripped / trunc-tier 不计 / 出窗不计', () => {
    const inWin = T0 - DAY
    const ok = evaluate([], repeatEv(10, inWin, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' }), T0)
    expect(rowById(ok.rows, 1).status).toBe('ok')
    expect(rowById(ok.rows, 1).currentValue).toContain('10 次')
    expect(rowById(ok.rows, 1).note).toContain('不足一个完整')

    const tripped = evaluate([], repeatEv(11, inWin, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' }), T0)
    expect(rowById(tripped.rows, 1).status).toBe('tripped')

    const truncTier = evaluate([], repeatEv(11, inWin, { layer: 'runtime', event: 'frame-truncated', reason: 'trunc-tier' }), T0)
    expect(rowById(truncTier.rows, 1).currentValue).toContain('0 次')
    expect(rowById(truncTier.rows, 1).status).toBe('ok')

    const outOfWindow = evaluate([], repeatEv(11, T0 - 8 * DAY, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' }), T0)
    expect(rowById(outOfWindow.rows, 1).status).toBe('ok')
  })

  it('#2 registry-miss 出现即 tripped（全时段，不受窗口限制）+ inbound-frame-dropped 佐证', () => {
    // runtime 台账有事件但无 registry-miss → ok（0 次）；台账全空是 no-data（数据缺失 ≠ 未发生）
    const clean = evaluate([], [ev(T0 - DAY, { layer: 'runtime', event: 'watermark-daily', detailDigest: '{"heapMax":1}' })], T0)
    expect(rowById(clean.rows, 2).status).toBe('ok')

    const old = evaluate([], [ev(T0 - 20 * DAY, { layer: 'runtime', event: 'registry-miss' })], T0)
    expect(rowById(old.rows, 2).status).toBe('tripped')

    const corroborated = evaluate(
      repeatEv(2, T0 - DAY, { layer: 'renderer', event: 'inbound-frame-dropped' }),
      [ev(T0 - DAY, { layer: 'runtime', event: 'registry-miss' })],
      T0,
    )
    expect(rowById(corroborated.rows, 2).status).toBe('tripped')
    expect(rowById(corroborated.rows, 2).currentValue).toContain('佐证 2 条')
  })

  it('#3 main.jsonl runtime crash：3 次 ok / 4 次 tripped / 非 runtime 层不计', () => {
    const inWin = T0 - DAY
    const ok = evaluate(repeatEv(3, inWin, { layer: 'runtime', event: 'crash' }), [], T0)
    expect(rowById(ok.rows, 3).status).toBe('ok')

    const tripped = evaluate(repeatEv(4, inWin, { layer: 'runtime', event: 'crash' }), [], T0)
    expect(rowById(tripped.rows, 3).status).toBe('tripped')

    const wrongLayer = evaluate(repeatEv(4, inWin, { layer: 'pi', event: 'crash' }), [], T0)
    expect(rowById(wrongLayer.rows, 3).currentValue).toContain('0 次')
    expect(rowById(wrongLayer.rows, 3).status).toBe('ok')
  })

  it('#7 auto-respawn 按 scheduled 事故计数（状态事件去重）：5 ok / 6 tripped / attempt-only 不计', () => {
    const incidentAt = (tsMs: number, sessionId: string): string[] => [
      ev(tsMs, { layer: 'pi', event: 'auto-respawn', reason: 'scheduled', sessionId }),
      ev(tsMs + 5_000, { layer: 'pi', event: 'auto-respawn', reason: 'attempt', sessionId }),
      ev(tsMs + 6_000, { layer: 'pi', event: 'auto-respawn', reason: 'succeeded', sessionId }),
    ]
    const incidents = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => incidentAt(T0 - DAY + i * MIN, `s-${i}`)).flat()

    expect(rowById(evaluate([], incidents(5), T0).rows, 7).status).toBe('ok')
    const tripped = evaluate([], incidents(6), T0)
    expect(rowById(tripped.rows, 7).status).toBe('tripped')
    expect(rowById(tripped.rows, 7).currentValue).toContain('6 次')

    // 10 条 attempt 状态事件（无 scheduled）→ 事故计数 0（防止按事件名全数导致多计）
    const attemptOnly = repeatEv(10, T0 - DAY, { layer: 'pi', event: 'auto-respawn', reason: 'attempt' })
    expect(rowById(evaluate([], attemptOnly, T0).rows, 7).currentValue).toContain('0 次')
  })

  it('#9 renderer reload 月均：4 次 ok / 5 次 tripped（main 台账为数据源）', () => {
    const inWin = T0 - DAY
    expect(rowById(evaluate(repeatEv(4, inWin, { layer: 'renderer', event: 'reload' }), [], T0).rows, 9).status).toBe('ok')
    expect(rowById(evaluate(repeatEv(5, inWin, { layer: 'renderer', event: 'reload' }), [], T0).rows, 9).status).toBe('tripped')
    // reload 事件按 D1 归 main.jsonl：runtime 台账里的同名事件不作为 #9 数据源
    //（main 台账放一条无关事件使 #9 进入可判定分支，验证 runtime 侧 reload 不计数）
    const mainHasOther = [ev(inWin, { layer: 'main', event: 'crash', reason: 'unclean-exit' })]
    expect(rowById(evaluate(mainHasOther, repeatEv(5, inWin, { layer: 'renderer', event: 'reload' }), T0).rows, 9).currentValue).toContain('0 次')
  })

  it('#10 第三方扩展崩溃：扩展归因分类计数 2 ok / 3 tripped / 非扩展崩溃不计', () => {
    const inWin = T0 - DAY
    const ext = [
      ev(inWin, { layer: 'pi', event: 'crash', reason: 'extension-stale-ctx' }),
      ev(inWin + MIN, { layer: 'plugin-worker', event: 'crash', reason: 'unclean-exit' }),
    ]
    expect(rowById(evaluate([], ext, T0).rows, 10).currentValue).toContain('2 次')
    expect(rowById(evaluate([], ext, T0).rows, 10).status).toBe('ok')

    const tripped = [...ext, ev(inWin + 2 * MIN, { layer: 'pi', event: 'crash', reason: 'extension-stale-ctx' })]
    expect(rowById(evaluate([], tripped, T0).rows, 10).status).toBe('tripped')

    const notExtension = repeatEv(3, inWin, { layer: 'pi', event: 'crash', reason: 'unclean-exit' })
    expect(rowById(evaluate([], notExtension, T0).rows, 10).currentValue).toContain('0 次')
  })
})

// ── #8 四子句（含 absent-report 排除子句单独断言）────────────────────────────

describe('#8 滚动重启四子句', () => {
  // rolling-restart 事件族由 runtime writer 写（rolling-restart.ts 恒 layer:'runtime'）：
  // 构造放 runtime 台账。runtime 空而 main 有事件时 #8 显式 no-data（数据源缺失非 ok）
  const rollingRestartAt = (tsMs: number): string[] => [ev(tsMs, { layer: 'runtime', event: 'rolling-restart' })]
  const deferredAt = (tsMs: number, sessionId?: string, reason?: string): string[] => [
    ev(tsMs, { layer: 'runtime', event: 'rolling-restart-deferred', sessionId, reason }),
  ]
  const forcedAt = (tsMs: number, sessionId?: string, reason?: string): string[] => [
    ev(tsMs, { layer: 'runtime', event: 'rolling-restart-forced', sessionId, reason }),
  ]

  it('子句 a：滚动重启 1 次/周 ok、2 次/周 tripped、出 7 天窗不计', () => {
    expect(rowById(evaluate([], rollingRestartAt(T0 - DAY), T0).rows, 8).status).toBe('ok')
    expect(
      rowById(evaluate([], [...rollingRestartAt(T0 - DAY), ...rollingRestartAt(T0 - 2 * DAY)], T0).rows, 8).status,
    ).toBe('tripped')
    expect(
      rowById(evaluate([], [...rollingRestartAt(T0 - 8 * DAY), ...rollingRestartAt(T0 - 9 * DAY)], T0).rows, 8).status,
    ).toBe('ok')
  })

  it('子句 b/c：推迟 10/月 ok（阈值边界）· 11/月 tripped、forced 4/月 tripped', () => {
    const atLimit = Array.from({ length: 10 }, (_, i) => deferredAt(T0 - DAY - i * MIN, `s-${i}`)[0])
    const rowAtLimit = rowById(evaluate([], atLimit, T0).rows, 8)
    expect(rowAtLimit.status).toBe('ok')
    expect(rowAtLimit.currentValue).toContain('10/30天')

    const deferred = Array.from({ length: 11 }, (_, i) => deferredAt(T0 - DAY - i * MIN, `s-${i}`)[0])
    expect(rowById(evaluate([], deferred, T0).rows, 8).status).toBe('tripped')

    const forced = Array.from({ length: 4 }, (_, i) => forcedAt(T0 - DAY - i * MIN, `s-${i}`, 'hard-threshold')[0])
    expect(rowById(evaluate([], forced, T0).rows, 8).status).toBe('tripped')
    expect(rowById(evaluate([], forced, T0).rows, 8).currentValue).toContain('4/30天')
  })

  it('子句 d：占比 0% ok / 33% 与 50% tripped（隔离断言须 forced ≤3，否则子句 c 先触发）', () => {
    // 3 forced 全 hard-threshold → 0% → ok
    const none = Array.from({ length: 3 }, (_, i) => forcedAt(T0 - DAY - i * MIN, `ht-${i}`, 'hard-threshold')[0])
    const row0 = rowById(evaluate([], none, T0).rows, 8)
    expect(row0.status).toBe('ok')
    expect(row0.currentValue).toContain('0%')

    // 1 defer-limit + 2 hard-threshold → 1/3 ≈ 33% > 30% → tripped
    const oneOfThree = [
      forcedAt(T0 - DAY, 'dl-0', 'defer-limit')[0],
      forcedAt(T0 - DAY + MIN, 'ht-0', 'hard-threshold')[0],
      forcedAt(T0 - DAY + 2 * MIN, 'ht-1', 'hard-threshold')[0],
    ]
    const row33 = rowById(evaluate([], oneOfThree, T0).rows, 8)
    expect(row33.status).toBe('tripped')
    expect(row33.currentValue).toContain('33%')

    // 1 defer-limit + 1 hard-threshold → 50% → tripped
    const half = [
      forcedAt(T0 - DAY, 'dl-0', 'defer-limit')[0],
      forcedAt(T0 - DAY + MIN, 'ht-0', 'hard-threshold')[0],
    ]
    const row50 = rowById(evaluate([], half, T0).rows, 8)
    expect(row50.status).toBe('tripped')
    expect(row50.currentValue).toContain('50%')
  })

  it('子句 d 分子排除 absent-report：同 session 关联窗内的 errs 推迟不计入占比', () => {
    const forcedAtT = T0 - DAY
    // 3 forced（2 defer-limit + 1 hard-threshold）：子句 c 不触发（3 不 > 3），占比子句隔离可判
    const twoDeferLimit = [
      ...forcedAt(forcedAtT, 's1', 'defer-limit'),
      ...forcedAt(forcedAtT, 's2', 'defer-limit'),
      ...forcedAt(forcedAtT + MIN, 's3', 'hard-threshold'),
    ]
    // 无 absent-report：2/3 ≈ 67% > 30% → tripped
    expect(rowById(evaluate([], twoDeferLimit, T0).rows, 8).status).toBe('tripped')

    // 两个 defer-limit 均有同 session 的 absent-report deferred（先于 forced 55min，落 60min 关联窗内）
    // → 分子 0 → ok，且 note 显式排除数
    const absentBoth = [
      ...deferredAt(forcedAtT - 55 * MIN, 's1', 'absent-report'),
      ...deferredAt(forcedAtT - 55 * MIN, 's2', 'absent-report'),
      ...twoDeferLimit,
    ]
    const rowExcluded = rowById(evaluate([], absentBoth, T0).rows, 8)
    expect(rowExcluded.status).toBe('ok')
    expect(rowExcluded.currentValue).toContain('0%')
    expect(rowExcluded.note).toContain('关联 2 条')

    // 仅 s1 关联 → 分子 1/3 ≈ 33% > 30% → 仍 tripped（ currentValue 显式 33%）
    const absentOne = [...deferredAt(forcedAtT - 55 * MIN, 's1', 'absent-report'), ...twoDeferLimit]
    const rowPartial = rowById(evaluate([], absentOne, T0).rows, 8)
    expect(rowPartial.status).toBe('tripped')
    expect(rowPartial.currentValue).toContain('33%')

    // absent-report 关联的是别的 session → 不排除 → 仍 67% tripped
    const absentOther = [...deferredAt(forcedAtT - 55 * MIN, 's9', 'absent-report'), ...twoDeferLimit]
    expect(rowById(evaluate([], absentOther, T0).rows, 8).status).toBe('tripped')

    // 关联窗外（deferred 距 forced 65min > 60min）→ 不排除 → tripped
    const outsideWindow = [...deferredAt(forcedAtT - 65 * MIN, 's1', 'absent-report'), ...twoDeferLimit]
    expect(rowById(evaluate([], outsideWindow, T0).rows, 8).status).toBe('tripped')
  })

  it('#8 数据源跨两本台账（rolling-restart 在 main、deferred/forced 在 runtime）', () => {
    const tripped = evaluate(rollingRestartAt(T0 - DAY), deferredAt(T0 - DAY, 's1'), T0)
    expect(rowById(tripped.rows, 8).currentValue).toContain('1/7天')
    expect(rowById(tripped.rows, 8).currentValue).toContain('1/30天')
  })

  it('main 非空 + runtime 空 → #8 显式 no-data「runtime 台账缺失」（数据源缺失非 ok）', () => {
    // rolling-restart 事件族全由 runtime writer 写：main 有事件（有锚点）但 runtime 台账空时，
    // 双空判据不命中——主数据源缺失必须独立呈现 no-data，不得降级为全 0 判 ok
    const mainOnly = evaluate(rollingRestartAt(T0 - DAY), [], T0)
    const row = rowById(mainOnly.rows, 8)
    expect(row.status).toBe('no-data')
    expect(row.currentValue).toContain('runtime 台账缺失')
    expect(row.note).toContain('runtime 台账无事件')
  })
})

// ── #16 同秒多 SIGTERM 形态（计划内关联排除）────────────────────────────────

describe('#16 E2 型连坐', () => {
  const base = T0 - DAY
  const piCrash = (tsMs: number, sessionId: string): string =>
    ev(tsMs, { layer: 'pi', event: 'crash', reason: 'sigterm', sessionId })
  const plannedShutdown = (tsMs: number, sessionId: string): string =>
    ev(tsMs, { layer: 'pi', event: 'shutdown', reason: 'planned', sessionId })

  it('同秒 3 个不同 session 非计划内 crash → tripped；2 个 → ok', () => {
    const three = [piCrash(base, 's1'), piCrash(base + 100, 's2'), piCrash(base + 200, 's3')]
    const row3 = rowById(evaluate([], three, T0).rows, 16)
    expect(row3.status).toBe('tripped')
    expect(row3.currentValue).toContain('峰值同秒 3 session')

    expect(rowById(evaluate([], [piCrash(base, 's1'), piCrash(base + 100, 's2')], T0).rows, 16).status).toBe('ok')
  })

  it('同 session 同秒多条 crash 不构成「≥3 session」', () => {
    const sameSession = [piCrash(base, 's1'), piCrash(base + 100, 's1'), piCrash(base + 200, 's1')]
    expect(rowById(evaluate([], sameSession, T0).rows, 16).status).toBe('ok')
  })

  it('计划内排除：同 session shutdown（杀链发起）关联窗内 → 不计入', () => {
    const withShutdown = [
      piCrash(base, 's1'),
      piCrash(base + 100, 's2'),
      piCrash(base + 200, 's3'),
      plannedShutdown(base + 50, 's1'),
      plannedShutdown(base + 150, 's2'),
      plannedShutdown(base + 250, 's3'),
    ]
    expect(rowById(evaluate([], withShutdown, T0).rows, 16).status).toBe('ok')

    // 仅排除其一 → 峰值同秒 2 → ok
    const partial = [
      piCrash(base, 's1'),
      piCrash(base + 100, 's2'),
      piCrash(base + 200, 's3'),
      plannedShutdown(base + 50, 's1'),
    ]
    const rowPartial = rowById(evaluate([], partial, T0).rows, 16)
    expect(rowPartial.status).toBe('ok')
    expect(rowPartial.currentValue).toContain('峰值同秒 2 session')

    // 关联窗外（shutdown 与 crash 相差 6s > 5s）→ 不排除 → tripped
    const outside = [
      piCrash(base, 's1'),
      piCrash(base + 100, 's2'),
      piCrash(base + 200, 's3'),
      plannedShutdown(base - 6_000, 's1'),
      plannedShutdown(base - 6_000 + 100, 's2'),
      plannedShutdown(base - 6_000 + 200, 's3'),
    ]
    expect(rowById(evaluate([], outside, T0).rows, 16).status).toBe('tripped')
  })

  it('出 30 天窗口的同秒连坐不计（复发观测面为月级）', () => {
    const old = [piCrash(T0 - 31 * DAY, 's1'), piCrash(T0 - 31 * DAY + 100, 's2'), piCrash(T0 - 31 * DAY + 200, 's3')]
    expect(rowById(evaluate([], old, T0).rows, 16).status).toBe('ok')
  })
})

// ── 趋势类 #4/#5（watermark-daily 消费 + coverage 降权）──────────────────────

describe('趋势类 #4/#5', () => {
  const watermarkAt = (tsMs: number, heapMax: number, coveragePct?: number): string =>
    ev(tsMs, {
      layer: 'runtime',
      event: 'watermark-daily',
      detailDigest: coveragePct === undefined ? `{"heapMax":${heapMax}}` : `{"heapMax":${heapMax},"coveragePct":${coveragePct}}`,
    })
  const RISING = [1e9, 1.2e9, 1.45e9, 1.7e9, 2e9]

  it('#4 coverage<50% 的日降权：4 有效覆盖日 → no-data（降权 1 天）；补足 5 日后可判', () => {
    const days = [T0 - 5 * DAY, T0 - 4 * DAY, T0 - 3 * DAY, T0 - 2 * DAY]
    const fourCovered = days.map((ts, i) => watermarkAt(ts, RISING[i]))
    const lowCoverage = watermarkAt(T0 - DAY, RISING[4], 30) // coveragePct 30 → 0.3 < 0.5 降权
    const rowInsufficient = rowById(evaluate([], [...fourCovered, lowCoverage], T0).rows, 4)
    expect(rowInsufficient.status).toBe('no-data')
    expect(rowInsufficient.note).toContain('降权 1 天')

    const judged = evaluate([], [...fourCovered, watermarkAt(T0 - DAY, RISING[4])], T0)
    expect(rowById(judged.rows, 4).status).toBe('tripped')

    // coveragePct 恰 50%（降权边界 = <50% 才降权）→ 全权重，5 日有效 → 可判
    const atHalf = evaluate([], [...fourCovered, watermarkAt(T0 - DAY, RISING[4], 50)], T0)
    const rowAtHalf = rowById(atHalf.rows, 4)
    expect(rowAtHalf.status).toBe('tripped')
    expect(rowAtHalf.note).not.toContain('降权')
  })

  it('#4 棘轮上行定义：持续上行 tripped / 回落 ok / 平台期（无上行）ok', () => {
    const rising = RISING.map((heap, i) => watermarkAt(T0 - (5 - i) * DAY, heap))
    expect(rowById(evaluate([], rising, T0).rows, 4).status).toBe('tripped')

    const falling = [2e9, 1.9e9, 1.8e9, 1.7e9, 1.6e9].map((heap, i) => watermarkAt(T0 - (5 - i) * DAY, heap))
    expect(rowById(evaluate([], falling, T0).rows, 4).status).toBe('ok')

    // 单日大幅回落破坏棘轮形态 → ok
    const cliff = [1e9, 1.5e9, 0.5e9, 0.6e9, 0.7e9].map((heap, i) => watermarkAt(T0 - (5 - i) * DAY, heap))
    expect(rowById(evaluate([], cliff, T0).rows, 4).status).toBe('ok')
  })

  it('#4 digest 缺失时退回顶层 heapUsed 字段；coverageStart/End 形式可判降权', () => {
    const noDigest = RISING.map((heap, i) => ev(T0 - (5 - i) * DAY, { layer: 'runtime', event: 'watermark-daily', heapUsed: heap }))
    expect(rowById(evaluate([], noDigest, T0).rows, 4).status).toBe('tripped')

    const isoCoverage = [
      ...RISING.slice(0, 4).map((heap, i) => watermarkAt(T0 - (5 - i) * DAY, heap)),
      ev(T0 - DAY, {
        layer: 'runtime',
        event: 'watermark-daily',
        detailDigest: JSON.stringify({ heapMax: RISING[4], coverageStart: new Date(T0 - DAY - 18 * 3_600_000).toISOString(), coverageEnd: new Date(T0 - DAY).toISOString() }),
      }),
    ]
    // 18h/24h = 75% ≥ 50% → 全权重 → 5 日有效 → 可判
    expect(rowById(evaluate([], isoCoverage, T0).rows, 4).status).toBe('tripped')
  })

  it('#5 base64 归因恒 no-data，标注 watermark-daily 数据就绪状态', () => {
    const notReady = rowById(evaluate([], [], T0).rows, 5)
    expect(notReady.status).toBe('no-data')
    expect(notReady.currentValue).toContain('未就绪')

    const ready = rowById(
      evaluate([], repeatEv(3, T0 - DAY, { layer: 'runtime', event: 'watermark-daily', detailDigest: '{"heapMax":1000000000}' }), T0).rows,
      5,
    )
    expect(ready.status).toBe('no-data')
    expect(ready.currentValue).toContain('已就绪')
    expect(ready.requiresUserReport).toBeUndefined()
  })
})

// ── 窗口语义与锚定 ──────────────────────────────────────────────────────────

describe('窗口语义与锚定', () => {
  it('周窗左开右闭：now 时刻命中、now-7d 整点出窗、未来事件不计', () => {
    const atNow = evaluate([], [ev(T0, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' })], T0)
    expect(rowById(atNow.rows, 1).currentValue).toContain('1 次')

    const atBoundary = evaluate([], [ev(T0 - 7 * DAY, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' })], T0)
    expect(rowById(atBoundary.rows, 1).currentValue).toContain('0 次')

    const future = evaluate([], [ev(T0 + DAY, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' })], T0)
    expect(rowById(future.rows, 1).currentValue).toContain('0 次')
  })

  it('缺省锚定台账末事件时刻（nowIso 可辨）', () => {
    const last = T0 - 3 * DAY
    const result = evaluate(
      [],
      [
        ev(last, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' }),
        ev(T0 - 10 * DAY, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' }),
      ],
    )
    expect(result.nowIso).toBe(new Date(last).toISOString())
    // 锚定 last：T0-10d 在 (last-7d, last] 之外 → 只计 1 条
    expect(rowById(result.rows, 1).currentValue).toContain('1 次')
  })
})

// ── 坏行 / 空台账非静默 ─────────────────────────────────────────────────────

describe('坏行与空台账非静默', () => {
  it('坏行跳过并计数（JSON 解析失败 / 非对象 / 缺 ts），空白行不计', () => {
    const valid = ev(T0 - DAY, { layer: 'runtime', event: 'registry-miss' })
    const result = evaluate(['{broken'], [
      'not json at all',
      '[1, 2]', // 合法 JSON 但非对象
      JSON.stringify({ event: 'crash' }), // 缺 ts（writer 恒补，缺即畸形）
      '', // 换行切分伪影：不计坏行
      valid,
    ])
    expect(result.skippedLineCount).toEqual({ main: 1, runtime: 3 })
    expect(result.parsedEventCount).toEqual({ main: 0, runtime: 1 })
    expect(result.trippedIds).toEqual([2]) // 有效行照常参与评估
  })

  it('部分台账为空 → 该源条件 no-data 显式标注（非静默空白）', () => {
    const result = evaluate([ev(T0 - DAY, { layer: 'main', event: 'reload' })], [], T0)
    expect(result.nowIso).not.toBeNull()
    const row1 = rowById(result.rows, 1)
    expect(row1.status).toBe('no-data')
    expect(row1.note).toContain('runtime 台账无事件')
    // main 有数据的条件照常判定
    expect(rowById(result.rows, 9).status).toBe('ok')
  })
})

// ── trigger-review 出口（巡检 WARN + writer 事件）───────────────────────────

describe('trigger-review 出口', () => {
  const trippingRuntimeLines = [
    ...repeatEv(11, T0 - DAY, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' }),
    ev(T0 - DAY, { layer: 'runtime', event: 'registry-miss' }),
  ]

  it('越线 → WARN 摘要行 + writer 收到带条件 id 的 trigger-review 事件', () => {
    const warnings: string[] = []
    const written: unknown[] = []
    const result = runTriggerPatrol({
      readMainLines: () => [],
      readRuntimeLines: () => trippingRuntimeLines,
      warn: (line) => warnings.push(line),
      append: (event) => written.push(event),
    })
    expect(result.trippedIds).toEqual([1, 2])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('#1')
    expect(warnings[0]).toContain('#2')
    expect(warnings[0]).toContain('trigger-review')
    expect(written).toHaveLength(2)
    for (const [i, expectedId] of [1, 2].entries()) {
      const event = written[i] as { event?: string; reason?: string; layer?: string; detailDigest?: string }
      expect(event.event).toBe('trigger-review')
      expect(event.reason).toBe(`condition-${expectedId}`)
      expect(event.layer).toBe('main')
      const digest = JSON.parse(event.detailDigest ?? '{}') as { id?: number }
      expect(digest.id).toBe(expectedId)
    }
  })

  it('无越线 → 不出声（无 WARN、无写入）', () => {
    const warnings: string[] = []
    const written: unknown[] = []
    const result = runTriggerPatrol({
      readMainLines: () => [],
      readRuntimeLines: () => [ev(T0 - DAY, { layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier' })],
      warn: (line) => warnings.push(line),
      append: (event) => written.push(event),
    })
    expect(result.trippedIds).toEqual([])
    expect(warnings).toHaveLength(0)
    expect(written).toHaveLength(0)
  })
})

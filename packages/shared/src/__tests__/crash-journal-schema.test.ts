/**
 * crash-journal-schema 单测（crash-forensics-and-watchdog.impl-plan.md u1a）。
 *
 * 守护三条验收线：
 * 1. 枚举与设计 §3.3 D1 schema JSON 块逐字一致——event 20 值 / layer 5 值 /
 *    reason 已知值分层登记（下方 DESIGN_REASON_LINE = 设计 reason 行 6 值逐字转录，
 *    IMPLEMENTED_KNOWN_REASONS = 设计行 ∪ 实装 append 调用点静态可枚举值全集；
 *    设计改 schema 时同步改 DESIGN_*；event 枚举不得混入 reason 值 unclean-exit，
 *    孤儿值 oom 已裁决删除——见 2026-09-12 D1 oom 行裁决注记与偏差 #32②）；
 * 2. 字段全可空——仅 {ts,layer,event} 的最小事件与全 null 事件均合法
 *    （设计「不知道 ≠ 没打点」；类型收窄导致构造不过 = 本文件编译红）；
 * 3. JSON.stringify→parse 往返不丢字段——JSONL 落盘/回读的最低保真契约
 *    （D2 评估器以台账 JSONL 为唯一输入，字段静默丢失 = 条件计数失真）。
 */
import { describe, it, expect } from 'vitest'
import {
  type CrashJournalEvent,
  type CrashJournalWriter,
  type CrashJournalWriterOptions,
  CRASH_JOURNAL_LAYERS,
  CRASH_JOURNAL_EVENTS,
  CRASH_JOURNAL_KNOWN_REASONS,
  CRASH_JOURNAL_ENUM_COVERAGE_LOCK,
} from '../crash-journal-schema.js'

// 设计 docs/architecture/crash-forensics-and-watchdog.md §3.3 D1 schema JSON 块逐字转录
const DESIGN_LAYER_LINE = ['pi', 'runtime', 'renderer', 'main', 'plugin-worker']
const DESIGN_EVENT_LINE = [
  'crash',
  'unresponsive',
  'auto-respawn',
  'auto-respawn-failed',
  'reload',
  'rolling-restart',
  'rolling-restart-deferred',
  'rolling-restart-forced',
  'shutdown',
  'deleted',
  'reclaimed',
  'memory-relief',
  'reattach-skipped',
  'checkpoint-corrupt',
  'reaped',
  'inbound-frame-dropped',
  'frame-truncated',
  'registry-miss',
  'watermark-daily',
  'trigger-review',
]
const DESIGN_REASON_LINE = [
  'extension-stale-ctx',
  'sigterm',
  'planned',
  'unclean-exit',
  'warn-tier',
  'trunc-tier',
]
/**
 * 实装 append 调用点静态可枚举已知值全集（impl-plan 偏差 #18 残留风险回写，逐值
 * 来源 = 全仓 crash 台账 append 点枚举；开放形态——Electron reason 透传、
 * `condition-<id>` 模板、无 reason 事件——不在此列，落 open 集语义）。
 */
const IMPLEMENTED_KNOWN_REASONS = [
  // 设计 D1 schema reason 行（6 值）
  ...DESIGN_REASON_LINE,
  // pi-respawn auto-respawn 四态 + 失败走向二值（pi-respawn.ts）
  'scheduled',
  'attempt',
  'succeeded',
  'retry-scheduled',
  'breaker-tripped',
  // runtime supervisor / window factory（main 侧监督与 renderer 守护）
  'process_exit',
  'liveness-unhealthy',
  'renderer-unresponsive',
  'circuit-breaker',
  // renderer 入站超界帧丢弃（renderer-log-handler.ts）
  'over-size-limit',
  // reattach-skipped 全集（startup-reattach.ts REATTACH_SKIP_REASONS + main.ts 隔离）
  'file-missing',
  'restore-failed',
  'reap-wait-timeout',
  'stale-checkpoint-after-clean-exit',
  // checkpoint-corrupt（runtime-checkpoint.ts）
  'parse-failed',
  // registry-miss（message-bus 出站守卫 dropReason 闭合二值）
  'registry_miss',
  'still_oversize_after_truncate',
  // rolling-restart-forced / deferred（rolling-restart.ts）
  'hard-threshold',
  'defer-limit',
  'inflight',
  'absent-report',
]
// schema JSON 块顶层字段集（14 个，与 CrashJournalEvent 字段一一对应）
const DESIGN_TOP_LEVEL_FIELDS = [
  'ts',
  'layer',
  'event',
  'sessionId',
  'reason',
  'exitCode',
  'rss',
  'heapUsed',
  'uptimeSec',
  'appVersion',
  'piVersion',
  'memPressure',
  'detailDigest',
  'detailPath',
]

describe('CRASH_JOURNAL_EVENTS（D1 schema event 行）', () => {
  it('恰 20 值（设计 schema event 行值数）', () => {
    expect(CRASH_JOURNAL_EVENTS).toHaveLength(20)
  })

  it('与设计 event 行集合完全一致（逐值对照，无多无漏）', () => {
    expect([...CRASH_JOURNAL_EVENTS].sort()).toEqual([...DESIGN_EVENT_LINE].sort())
  })

  it('逐值断言（每值独立断言，任一漂移定位到具体值）', () => {
    for (const name of DESIGN_EVENT_LINE) {
      expect(CRASH_JOURNAL_EVENTS).toContain(name)
    }
  })

  it('无重复值（枚举元组是全集矩阵数据源，重复会污染消费方测试矩阵）', () => {
    expect(new Set(CRASH_JOURNAL_EVENTS).size).toBe(CRASH_JOURNAL_EVENTS.length)
  })

  it('unclean-exit 是 reason 值不是 event 值（设计 schema 中它只出现在 reason 行）', () => {
    expect(CRASH_JOURNAL_EVENTS).not.toContain('unclean-exit')
    expect(CRASH_JOURNAL_KNOWN_REASONS).toContain('unclean-exit')
  })

  it('oom 已裁决删除（偏差 #32②：零生产者——renderer OOM 走 reload 事件 + reason=oom 透传，runtime 保守记 crash）', () => {
    expect(CRASH_JOURNAL_EVENTS).not.toContain('oom')
  })
})

describe('CRASH_JOURNAL_LAYERS（D1 schema layer 行）', () => {
  it('恰 5 值且与设计 layer 行完全一致', () => {
    expect(CRASH_JOURNAL_LAYERS).toHaveLength(5)
    expect([...CRASH_JOURNAL_LAYERS].sort()).toEqual([...DESIGN_LAYER_LINE].sort())
  })
})

describe('CRASH_JOURNAL_KNOWN_REASONS（开放枚举已知值登记面：设计行 + 实装调用点）', () => {
  it(`恰 ${IMPLEMENTED_KNOWN_REASONS.length} 值（设计行 + 实装已知值全集）`, () => {
    expect(CRASH_JOURNAL_KNOWN_REASONS).toHaveLength(IMPLEMENTED_KNOWN_REASONS.length)
  })

  it('设计 reason 行 6 值全部登记（行末「…」= 开放枚举，登记面是超集不是逐字转录）', () => {
    for (const reason of DESIGN_REASON_LINE) {
      expect(CRASH_JOURNAL_KNOWN_REASONS).toContain(reason)
    }
  })

  it('与实装 append 调用点已知值全集完全一致（无多无漏，偏差 #18 差集锁空）', () => {
    expect([...CRASH_JOURNAL_KNOWN_REASONS].sort()).toEqual([...IMPLEMENTED_KNOWN_REASONS].sort())
  })

  it('逐值断言（每值独立断言，任一漂移定位到具体值）', () => {
    for (const reason of IMPLEMENTED_KNOWN_REASONS) {
      expect(CRASH_JOURNAL_KNOWN_REASONS).toContain(reason)
    }
  })

  it('无重复值（登记面供消费方测试作全集矩阵，重复会污染矩阵）', () => {
    expect(new Set(CRASH_JOURNAL_KNOWN_REASONS).size).toBe(CRASH_JOURNAL_KNOWN_REASONS.length)
  })

  it('开放枚举：schema 未列的未知 reason 可携带且往返不丢（类型保持 string 不收窄）', () => {
    const event: CrashJournalEvent = {
      ts: '2026-09-12T02:57:03Z',
      layer: 'pi',
      event: 'crash',
      reason: 'some-future-reason-not-in-schema',
    }
    expect(CRASH_JOURNAL_KNOWN_REASONS).not.toContain('some-future-reason-not-in-schema')
    const parsed = JSON.parse(JSON.stringify(event)) as CrashJournalEvent
    expect(parsed.reason).toBe('some-future-reason-not-in-schema')
  })
})

describe('CrashJournalEvent 字段全可空（设计「不知道 ≠ 没打点」）', () => {
  it('仅 {ts,layer,event} 的最小事件合法（字段缺省形态，编译即守卫）', () => {
    const minimal: CrashJournalEvent = {
      ts: '2026-09-12T02:57:03Z',
      layer: 'runtime',
      event: 'crash',
    }
    const parsed = JSON.parse(JSON.stringify(minimal)) as CrashJournalEvent
    expect(Object.keys(parsed).sort()).toEqual(['event', 'layer', 'ts'])
  })

  it('全部 14 字段显式 null 仍合法（崩溃瞬间上下文全缺形态）', () => {
    const allNull: CrashJournalEvent = {
      ts: null,
      layer: null,
      event: null,
      sessionId: null,
      reason: null,
      exitCode: null,
      rss: null,
      heapUsed: null,
      uptimeSec: null,
      appVersion: null,
      piVersion: null,
      memPressure: null,
      detailDigest: null,
      detailPath: null,
    }
    expect(allNull.ts).toBeNull()
    expect(allNull.memPressure).toBeNull()
  })

  it('memPressure 子字段也可缺省可 null', () => {
    const event: CrashJournalEvent = {
      layer: 'runtime',
      event: 'watermark-daily',
      memPressure: { swapUsedMB: null, freeMB: 170 },
    }
    expect(event.memPressure?.swapUsedMB).toBeNull()
    expect(event.memPressure?.freeMB).toBe(170)
  })
})

describe('JSON 往返保真（JSONL 落盘/回读不丢字段）', () => {
  const full: CrashJournalEvent = {
    ts: '2026-09-12T02:57:03Z',
    layer: 'pi',
    event: 'crash',
    sessionId: '01a06a87-0000-0000-0000-000000000000',
    reason: 'unclean-exit',
    exitCode: 1,
    rss: 402653184,
    heapUsed: 301989888,
    uptimeSec: 86400,
    appVersion: '0.9.16',
    piVersion: '0.84.4',
    memPressure: { swapUsedMB: 11004, freeMB: 170 },
    detailDigest: 'last-10-lines-stderr-digest',
    detailPath: 'logs/pi-crash-2026-09-12.jsonl',
  }

  it('满字段事件 stringify→parse 深等值（含 memPressure 嵌套）', () => {
    const parsed = JSON.parse(JSON.stringify(full)) as CrashJournalEvent
    expect(parsed).toEqual(full)
  })

  it('顶层字段集恰为设计 schema 14 字段，往返后一个不少', () => {
    const parsed = JSON.parse(JSON.stringify(full)) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...DESIGN_TOP_LEVEL_FIELDS].sort())
  })

  it('memPressure 子字段往返保留', () => {
    const parsed = JSON.parse(JSON.stringify(full)) as CrashJournalEvent
    expect(Object.keys(parsed.memPressure ?? {}).sort()).toEqual(['freeMB', 'swapUsedMB'])
    expect(parsed.memPressure).toEqual({ swapUsedMB: 11004, freeMB: 170 })
  })

  it('扩展字段（偏差 #32③ 登记面）可携带且往返不丢（写入侧禁绕过接口私自扩字段的守卫基线）', () => {
    const withExtensions: CrashJournalEvent = {
      layer: 'pi',
      event: 'reaped',
      pid: 54528,
      ppid: 1,
      idleMs: 7_200_000,
      lastViewedAt: 1_728_700_000_000,
      processId: 'trusted-1',
      signal: 'SIGTERM',
      pluginIds: ['p1', 'p2'],
    }
    const parsed = JSON.parse(JSON.stringify(withExtensions)) as Record<string, unknown>
    expect(parsed.pid).toBe(54528)
    expect(parsed.ppid).toBe(1)
    expect(parsed.idleMs).toBe(7_200_000)
    expect(parsed.lastViewedAt).toBe(1_728_700_000_000)
    expect(parsed.processId).toBe('trusted-1')
    expect(parsed.signal).toBe('SIGTERM')
    expect(parsed.pluginIds).toEqual(['p1', 'p2'])
  })
})

describe('CrashJournalWriter 契约（u1b/u1c 两实现的共用签名）', () => {
  it('实现接口可消费：append 收到完整事件对象', () => {
    const appended: CrashJournalEvent[] = []
    const writer: CrashJournalWriter = {
      append: (event) => {
        appended.push(event)
      },
    }
    const event: CrashJournalEvent = { layer: 'main', event: 'reload', sessionId: 'sid-1' }
    writer.append(event)
    expect(appended).toEqual([event])
  })

  it('构造选项 role 受限 main|runtime 两值（D1 双文件角色）', () => {
    const mainWriter: CrashJournalWriterOptions = { role: 'main' }
    const runtimeWriter: CrashJournalWriterOptions = { role: 'runtime' }
    expect(mainWriter.role).toBe('main')
    expect(runtimeWriter.role).toBe('runtime')
  })
})

describe('枚举元组与联合的编译锁', () => {
  it('覆盖锁恒 true（联合扩值漏改元组时该常量类型红，运行期兜底断言）', () => {
    expect(CRASH_JOURNAL_ENUM_COVERAGE_LOCK).toEqual([true, true])
  })
})

/**
 * 触发条件每日巡检——评估器的 main 侧出口①（crash-forensics-and-watchdog §3.3 D2）。
 *
 * 分层：trigger-evaluator.ts 是纯函数（无 electron / fs / 定时器）；本模块持有
 * electron 环境的副作用面——台账文件读取、main-logger WARN、crash-journal writer、
 * 每日定时器。main.ts 在 whenReady 链调用 startTriggerPatrol()（1 行）。
 *
 * 行为（D2 出口①，最小闭环）：每日一次低频评估两本台账；任一条件 tripped →
 * main 日志一条 WARN 摘要行 + 台账写 `event=trigger-review`（每越线条件一条，
 * reason=condition-<id>，detailDigest 内嵌状态行）——「条件触发了有人知道」，
 * 不建仪表盘不做推送。非 tripped 不出声（ok 是常态，no-data 已在评估器行内显式）。
 *
 * 定时器形态复用 log-retention 的 startLogRetentionTimer 先例：启动立即跑一次 +
 * 此后固定间隔复扫，unref 不 hold 进程退出，返回 stop 函数。
 * 【平台节流声明（D2）】macOS 后台/不可见时 timer clamping 会拉长巡检间隔——
 * 条件窗口是周/月级，巡检延迟数小时可容忍；显式接受，不申请 powerSaveBlocker。
 */
import { join } from 'node:path'
import type { CrashJournalEvent } from '@taiji/shared'
import { crashJournal, getCrashJournalDir } from '../logs/crash-journal.js'
import { mainLogger } from '../logs/main-logger.js'
import { readJournalLines } from './journal-io.js'
import { evaluateTriggerConditions } from './trigger-evaluator.js'
import type { TriggerConditionRow, TriggerEvaluationResult } from './trigger-evaluator.js'

// 时间量纲换算基数（与 log-retention.ts 同款命名常量，非魔数）。
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
/** 每日巡检间隔（24h，log-retention 同款）。 */
const TRIGGER_PATROL_INTERVAL_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

/** 依赖注入面：测试注入内存 fixture / 替身 logger 与 writer，生产用默认实现。 */
export interface TriggerPatrolDeps {
  /** 读 main.jsonl 行数组；缺省读 <dataDir>/logs/crashes/main.jsonl。 */
  readMainLines?: () => string[]
  /** 读 runtime.jsonl 行数组；缺省读 <dataDir>/logs/crashes/runtime.jsonl。 */
  readRuntimeLines?: () => string[]
  /** WARN 出口；缺省 mainLogger.warn。 */
  warn?: (line: string) => void
  /** 台账写入出口；缺省 main 单例 crashJournal.append。 */
  append?: (event: CrashJournalEvent) => void
}

export interface TriggerPatrolResult {
  /** 本次越线的条件 id（空数组 = 常态无越线）。 */
  trippedIds: number[]
  /** 完整评估结果（状态表 / 坏行计数——no-data 非静默的可观测面）。 */
  evaluated: TriggerEvaluationResult
}

/**
 * 执行一次巡检评估 + 越线出声（纯编排，副作用全部可注入，main 池可测）。
 * 评估器本身不抛错（容错解析）；读取失败按空台账降级（评估器显式 no-data）。
 */
export function runTriggerPatrol(deps: TriggerPatrolDeps = {}): TriggerPatrolResult {
  const warn = deps.warn ?? ((line: string) => mainLogger.warn(line))
  const append = deps.append ?? ((event: CrashJournalEvent) => crashJournal.append(event))
  const mainLines = deps.readMainLines ?? (() => readJournalLines(join(getCrashJournalDir(), 'main.jsonl'), warn))
  const runtimeLines = deps.readRuntimeLines ?? (() => readJournalLines(join(getCrashJournalDir(), 'runtime.jsonl'), warn))

  const evaluated = evaluateTriggerConditions({ mainLines: mainLines(), runtimeLines: runtimeLines() })
  if (evaluated.trippedIds.length === 0) {
    return { trippedIds: [], evaluated }
  }
  const trippedRows = evaluated.rows.filter(
    (row: TriggerConditionRow): row is TriggerConditionRow & { status: 'tripped' } => row.status === 'tripped',
  )
  // WARN 摘要行（一条）：id + 当前值 vs 阈值，详情走台账 trigger-review 事件
  warn(
    `[trigger-patrol] 触发条件越线 ${trippedRows.length} 条: ` +
      trippedRows.map((r) => `#${r.id}[${r.currentValue}；阈值 ${r.threshold}]`).join(' | ') +
      '；已写台账 trigger-review 事件（main.jsonl）',
  )
  for (const row of trippedRows) {
    append({
      layer: 'main',
      event: 'trigger-review',
      reason: `condition-${row.id}`,
      detailDigest: JSON.stringify({ id: row.id, description: row.description, currentValue: row.currentValue, threshold: row.threshold, note: row.note }),
    })
  }
  return { trippedIds: evaluated.trippedIds, evaluated }
}

/**
 * 挂每日巡检定时器（main.ts whenReady 调用一次）：启动立即评估一次（补上次运行
 * 窗口的越线可见性）+ 此后每日复扫。unref 不 hold 退出；返回 stop 函数（测试清理用）。
 */
export function startTriggerPatrol(options: { intervalMs?: number } = {}): () => void {
  const intervalMs = options.intervalMs ?? TRIGGER_PATROL_INTERVAL_MS
  const runSafely = (): void => {
    try {
      runTriggerPatrol()
    } catch (err) {
      // 巡检是旁路观测面：自身异常不得反噬 main 启动链，记 WARN 等下一轮
      mainLogger.warn(`[trigger-patrol] 巡检异常（不影响下一轮）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  runSafely()
  const timer = setInterval(runSafely, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

// 台账读取统一走 ./journal-io.ts（【oe-audit C5】家族单一 reader：ENOENT 常态空 +
// 其余失败 warn 的设计 §3.1 口径 SSOT，patrol / export-diagnostic-bundle 共用）。

/**
 * reattach 编排（docs/architecture/crash-forensics-and-watchdog.md §3.3 D3，实施单元 u5）。
 *
 * 职责：runtime 启动（WS listen 后独立并行任务，组合根 index.ts 挂载）消费
 * runtime-checkpoint 快照，按「reaper 回收判定的真补集」恢复崩溃前的活跃 session。
 * 与 startup-background-init 串行链解耦（不阻塞链尾 reaper 启动）；唯一强制时序点是
 * 「live 孤儿未收割完不 spawn」（收割等待经 Promise.race 有界消费，架构 P9 消灭双持瞬态）。
 *
 * 流程（D3 时序）：读 checkpoint → 真补集过滤 → 等孤儿收割完成（有界）→ 高水位延迟
 * （mem-pressure 即时查询，冷启动零采样环数据可用）→ 分批 restore（并发 2，逐 session
 * 容错）→ 全部尝试完删除 checkpoint 文件。
 *
 * **可信度判定不在本模块（与 D3 原文的分工差异，机制等价）**：D3 原文把「判可信度」写进
 * runtime 启动流程，u4 落地时该判定归 main 侧冷启动块（marker 属主——main 独占
 * consume→判→写三步序，runtime 侧读 marker 会与 main 写序竞态）。clean-exit 残留已在
 * runtime 启动前被 isolateStaleCheckpoint 隔离 ⟹ 本编排读到 checkpoint 即 trusted-unclean，
 * 无需重复校验 unclean 信号。
 *
 * **过滤公式（真补集，常量读 reaper 既有 shared SSOT、不另开旋钮）**：
 *   occupancy==='occupied' || backgroundTasks || relayChildren
 *   || (now-lastActivityAt) ≤ idleWindow(2h) || (now-lastViewedAt) ≤ viewedWindow(30min)
 *   ——任一满足即恢复；边界恰等走恢复方向（reaper「恰好等于阈值不回收」的对偶，D3「真补集」
 *   字面要求）。
 *
 * **errs 方向（D3 显式声明，排查口径）**：
 * - lastActivityAt 只在 reaper 5min tick 搭车刷盘 ⟹ checkpoint 值 ≤ 真实值 ⟹ 算出
 *   idle ≥ 真实 idle ⟹ 过滤**偏「漏恢复」**（退化 = 现状 lazy，用户代价 = 一次手动触碰）；
 * - **快照布尔反向形态**：任务于 T 结束、T+≤5min 内崩溃时 backgroundTasks/relayChildren
 *   快照仍为 true → **多恢复**一个真实已 idle 的 session——新 runtime 的 reaper 后续拍
 *   按 checkpoint 时间戳正常回收它（自收敛，无用户可见损害）。排查口径：持续多恢复且
 *   不自收敛 = 公式错误；偶发单次后自收敛 = 快照滞后。
 *
 * **过滤排除不记台账**（设计无此要求）：被补集排除 = 设计内「不恢复」语义，非异常；
 * reattach-skipped 只覆盖三类异常跳过（reason 常量见下方导出），逐 session 一条。
 *
 * **checkpoint 删除（D3 契约 1 删除属主第二轨）**：全部尝试完后无条件删（含全跳过/全
 * 失败/收割超时跳过形态）；删除失败 best-effort（残留由 main 退出链删除 + 下次启动隔离
 * 双通道收敛）；高水位等待期间不删（等待中再崩 → checkpoint 保留 → 下次 runtime 重试）。
 */
import { existsSync, unlinkSync } from 'node:fs'
import type { CrashJournalWriter, ReattachDeferredPayload } from '@xyz-agent/shared'
import { DEFAULT_PI_RECLAIM_IDLE_MS, DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS } from '@xyz-agent/shared'
import {
  DEFAULT_MEM_PRESSURE_THRESHOLDS,
  isMemPressureHigh,
  queryMemPressure,
  type MemPressureSample,
  type MemPressureThresholds,
} from '../infra/mem-pressure.js'
import { getCrashJournal } from '../infra/crash-journal.js'
import {
  getRuntimeCheckpointStore,
  type RuntimeCheckpointEntry,
  type RuntimeCheckpointStore,
} from './session/runtime-checkpoint.js'

/** restore 并发上限（设计 D3「分批 reattach，并发上限 2」，spawn 峰值实测检查点初值）。 */
export const DEFAULT_REATTACH_CONCURRENCY = 2

/** 高水位轮询间隔（高压未缓解时的复查周期；恢复在压力缓解后立即继续，无总上限——手动 lazy 恒可用）。 */
export const DEFAULT_HIGH_WATER_POLL_MS = 30_000

/**
 * 收割等待上界（超界全部候选跳过走 lazy——宁 lazy 不双持，D3）。
 * 构成口径：收割链 = 5s 调度宽限（ORPHAN_REAP_DELAY_MS）+ ps 枚举 10s 上界 + 每孤儿 2s
 * 优雅宽限（D3 等待上界公式），60s 覆盖 ~20 孤儿量级；收割链自身各段有内部超时，本上界
 * 只兜「链路悬挂」的病理形态。errs 方向：超界跳过 = 退化 lazy，方向安全。
 */
export const DEFAULT_HARVEST_WAIT_BOUND_MS = 60_000

/** reattach-skipped reason：staleness guard 命中（filePath 未知或会话文件已缺失）。 */
export const REATTACH_SKIP_STALENESS = 'file-missing'

/** reattach-skipped reason：restore 执行失败（spawn/附着异常，含未配模型等运行态错误）。 */
export const REATTACH_SKIP_RESTORE_FAILED = 'restore-failed'

/** reattach-skipped reason：孤儿收割未在上界内完成（全部候选跳过，防双持）。 */
export const REATTACH_SKIP_REAP_TIMEOUT = 'reap-wait-timeout'

/** reattach-skipped 三类已知 reason（开放枚举的登记面，非校验闸）。 */
export const REATTACH_SKIP_REASONS = [
  REATTACH_SKIP_STALENESS,
  REATTACH_SKIP_RESTORE_FAILED,
  REATTACH_SKIP_REAP_TIMEOUT,
] as const

/** 过滤公式输入（窗口常量注入，缺省 = reaper 既有 shared SSOT）。 */
export interface ReattachFilterInput {
  nowMs: number
  idleWindowMs: number
  viewedWindowMs: number
}

/**
 * 真补集过滤公式（D3，纯函数导出供真值表测试）：
 * 任一长时豁免快照命中（occupancy 非 idle / backgroundTasks / relayChildren）或时效
 * 窗口命中（idle ≤ 2h / viewed ≤ 30min，恰等含）即恢复。
 *
 * 时间戳 null = 未知（「不知道 ≠ 没打点」）：该条不命中、其余条照判——errs 方向与 D3
 * 「偏漏恢复」口径一致（漏恢复退化 lazy，不冒进 spawn）。
 */
export function shouldReattachEntry(entry: RuntimeCheckpointEntry, input: ReattachFilterInput): boolean {
  // 长时豁免 #1：三维占用（turn/compacting/bash 任一命中即非 idle），安静长 turn 的
  // 反例④靠它恢复（idleMs 可超 2h 但必须恢复）。
  if (entry.occupancy === 'occupied') return true
  // 长时豁免 #2：running 后台任务（反例③——任务结束后快照可能滞后为 true，见文件头
  // 反向形态声明：多恢复由 reaper 自收敛）。
  if (entry.backgroundTasks === true) return true
  // 长时豁免 #3：在途 relay 子进程。
  if (entry.relayChildren === true) return true
  // idle 窗口：恰等阈值走恢复方向（reaper idleMs > 阈值才回收的对偶）。
  if (entry.lastActivityAt !== null && input.nowMs - entry.lastActivityAt <= input.idleWindowMs) return true
  // viewed 窗口：恰等阈值走恢复方向（reaper 豁免 #6「≤ 30 分钟」字面）。
  if (entry.lastViewedAt !== null && input.nowMs - entry.lastViewedAt <= input.viewedWindowMs) return true
  return false
}

/** reattach 编排的外部依赖（组合根注入；全部窄接口）。 */
export interface StartupReattachDeps {
  /**
   * 恢复执行（spawn + 附着）：生产 = sessionService.restoreSession（lifecycle
   * restoreSession → registerSession 汇聚点，onSessionRegistered 挂点随之触发）。
   */
  restore: (sessionId: string) => Promise<unknown>
  /**
   * 等待「live 孤儿收割完成」（startup-background-init 的收殓链 settle，含 5s 调度宽限）。
   * 契约：永不 reject（内部全 catch）。live 孤儿未收割完不 spawn（P9 消灭双持）。
   */
  waitForOrphanReap: () => Promise<void>
  /**
   * reattach:deferred 广播出口（偏差 #27 横幅腿的 runtime 半边；缺省无动作 = 纯逻辑单测
   * 与无 WS 形态零依赖）。组合根注入 server.broadcast 包装（u7c 滚动重启 broadcast 同形态）。
   *
   * **广播形态选择（进入单发 + 缓解退出单发，非延迟中每拍重发）**：两种形态对「renderer
   * 重连错过退出帧」的陈旧态残留窗口等价（退出帧都是单发），每拍重发只增冗余帧；且 D3
   * 高水位延迟只存在于启动后短窗口，协议面无只读拉取 RPC（「持续态必须可拉取」教训按状态
   * 生命周期区分适用——延迟是瞬态不是持续态）。残余窗口（进入后断连、退出也错过后重连）
   * 低概率，接受并已登记在 shared ReattachDeferredPayload 注释。
   */
  onDeferredBroadcast?: ReattachDeferredBroadcast
}

/** reattach:deferred 广播出口签名（payload 契约 = shared SSOT）。 */
export type ReattachDeferredBroadcast = (payload: ReattachDeferredPayload) => void

export interface StartupReattachOptions {
  /** 时钟注入（测试）；缺省 Date.now。 */
  now?: () => number
  /** 台账 writer（reattach-skipped 事件）；缺省 getCrashJournal() 单例。 */
  journal?: CrashJournalWriter
  /** checkpoint 读面与删除路径；缺省 getRuntimeCheckpointStore() 单例。 */
  checkpoint?: RuntimeCheckpointStore
  /** mem-pressure 即时查询注入（测试替身）；缺省 infra 真实现。 */
  queryMemPressure?: () => Promise<MemPressureSample>
  /** 高压阈值覆盖（初值 = mem-pressure DEFAULT，Gate W 校准入口）。 */
  memPressureThresholds?: Partial<MemPressureThresholds>
  /** 会话文件存在性查询注入（测试替身）；缺省 fs existsSync。 */
  fileExists?: (path: string) => boolean
  /** restore 并发上限；缺省 2（D3）。 */
  restoreConcurrency?: number
  /** idle 窗口 ms（过滤公式）；缺省 reaper 既有 shared SSOT（2h）。 */
  idleWindowMs?: number
  /** viewed 窗口 ms（过滤公式）；缺省 reaper 既有 shared SSOT（30min）。 */
  viewedWindowMs?: number
  /** 收割等待上界 ms；缺省 DEFAULT_HARVEST_WAIT_BOUND_MS。 */
  harvestWaitBoundMs?: number
  /** 高水位轮询间隔 ms；缺省 DEFAULT_HIGH_WATER_POLL_MS。 */
  highWaterPollMs?: number
  /** 延时注入（测试，替代真实等待）；缺省 unref 定时器。 */
  delay?: (ms: number) => Promise<void>
}

/** 编排结果（组合根/测试断言面）。 */
export interface ReattachReport {
  /** 是否读到 checkpoint（false = clean/corrupt，编排零动作）。 */
  checkpointFound: boolean
  /** 过滤通过、进入恢复候选的 session id（按 checkpoint 顺序）。 */
  candidates: string[]
  /** 被补集排除的 session id（不恢复、无台账事件，设计内语义）。 */
  excluded: string[]
  /** restore 成功的 session id。 */
  restored: string[]
  /** 跳过明细（逐 session 一条 reattach-skipped 台账行对应一项）。 */
  skipped: Array<{ sessionId: string; reason: string }>
  /** 高水位轮询等待次数（0 = 判定时刻无高压）。 */
  highWaterWaits: number
  /** checkpoint 主文件是否已删除（D3 契约 1 第二轨）。 */
  checkpointDeleted: boolean
}

function defaultDelay(ms: number): Promise<void> {
  // unref：编排是启动后的 fire-and-forget 任务，等待定时器不得独自挂住进程退出。
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/** reattach:deferred 广播（best-effort：出口注入缺陷/WS 故障只告警，不破坏编排链）。 */
function broadcastDeferredSafely(
  broadcast: ReattachDeferredBroadcast | undefined,
  payload: ReattachDeferredPayload,
): void {
  if (!broadcast) return
  try {
    broadcast(payload)
  } catch (e: unknown) {
    // best-effort 降级：广播是横幅告知面（非正确性面），失败只告警不传播——reattach
    // 编排链（恢复用户会话）不得被旁路设施故障阻塞；影响面 = renderer 少一条横幅。
    console.warn('[reattach] deferred broadcast failed (ignored):', e)
  }
}

/**
 * reattach 编排上下文：options/依赖的解析结果（缺省值解析集中于此，主函数只剩编排序）。
 */
interface ReattachContext {
  deps: StartupReattachDeps
  checkpoint: RuntimeCheckpointStore
  journal: CrashJournalWriter
  now: () => number
  idleWindowMs: number
  viewedWindowMs: number
  concurrency: number
  harvestWaitBoundMs: number
  highWaterPollMs: number
  fileExists: (path: string) => boolean
  delay: (ms: number) => Promise<void>
  onDeferredBroadcast: ReattachDeferredBroadcast | undefined
  thresholds: MemPressureThresholds
  queryPressure: () => Promise<MemPressureSample>
}

/** 时序/阈值类旋钮解析结果（缺省值 = reaper 既有 shared SSOT 与 D3 常量）。 */
interface ResolvedReattachOptions {
  idleWindowMs: number
  viewedWindowMs: number
  concurrency: number
  harvestWaitBoundMs: number
  highWaterPollMs: number
}

/**
 * 解析时序/阈值旋钮（独立成函数控制决策密度；缺省见各常量声明处）。
 */
function resolveReattachOptions(options: StartupReattachOptions): ResolvedReattachOptions {
  return {
    idleWindowMs: options.idleWindowMs ?? DEFAULT_PI_RECLAIM_IDLE_MS,
    viewedWindowMs: options.viewedWindowMs ?? DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS,
    concurrency: Math.max(1, options.restoreConcurrency ?? DEFAULT_REATTACH_CONCURRENCY),
    harvestWaitBoundMs: options.harvestWaitBoundMs ?? DEFAULT_HARVEST_WAIT_BOUND_MS,
    highWaterPollMs: options.highWaterPollMs ?? DEFAULT_HIGH_WATER_POLL_MS,
  }
}

/** 解析 options 缺省值与依赖引用（窗口常量缺省 = reaper 既有 shared SSOT）。 */
function createReattachContext(deps: StartupReattachDeps, options: StartupReattachOptions): ReattachContext {
  return {
    deps,
    ...resolveReattachOptions(options),
    checkpoint: options.checkpoint ?? getRuntimeCheckpointStore(),
    journal: options.journal ?? getCrashJournal(),
    now: options.now ?? Date.now,
    fileExists: options.fileExists ?? ((path: string) => existsSync(path)),
    delay: options.delay ?? defaultDelay,
    onDeferredBroadcast: deps.onDeferredBroadcast,
    thresholds: { ...DEFAULT_MEM_PRESSURE_THRESHOLDS, ...options.memPressureThresholds },
    queryPressure: options.queryMemPressure ?? (() => queryMemPressure()),
  }
}

function emptyReattachReport(): ReattachReport {
  return {
    checkpointFound: false,
    candidates: [],
    excluded: [],
    restored: [],
    skipped: [],
    highWaterWaits: 0,
    checkpointDeleted: false,
  }
}

/**
 * 执行 reattach 编排（一次性；组合根 listen 后 fire-and-forget 调用）。
 * 本函数不抛（内部逐步容错），返回编排报告供日志与测试断言。阶段实现拆分至下方
 * 阶段函数（partitionSnapshot / waitForOrphanReap / waitForMemPressureClear /
 * restoreCandidates），本函数只保留 D3 时序编排序。
 */
export async function runStartupReattach(
  deps: StartupReattachDeps,
  options: StartupReattachOptions = {},
): Promise<ReattachReport> {
  const ctx = createReattachContext(deps, options)
  const report = emptyReattachReport()

  // ① 读 checkpoint（staleness 第 0 步）：undefined = 无快照（clean exit 已删 / 首次启动，
  //    常态）或损坏已隔离退 lazy（u4 read() 契约）——零动作，冷启动维持 lazy（A3b）。
  const snapshot = ctx.checkpoint.read()
  if (!snapshot) return report
  report.checkpointFound = true

  // ② 真补集过滤（纯 CPU，无 IO；过滤排除不记台账，见文件头）。
  const entryById = partitionSnapshotEntries(ctx, snapshot, report)

  // ③ 零候选 = 零尝试：直接删 checkpoint（A6「全跳过也删」的零尝试形态）。
  if (report.candidates.length === 0) {
    report.checkpointDeleted = deleteCheckpointFile(ctx.checkpoint)
    return report
  }

  // ④ 等孤儿收割完成（有界 race）；超界时函数内部完成「全部候选跳过 + 删 checkpoint」
  //    的终态处理，返回 false 告知调用方直接收束。
  if (!(await waitForOrphanReap(ctx, report))) return report

  // ⑤ 高水位延迟（D3：即时系统级查询，无采样环历史依赖；高压持续则轮询等待至缓解）。
  await waitForMemPressureClear(ctx, report)

  // ⑥ 分批 restore（并发上限；Promise.allSettled 结构性保证单 session 失败不阻断批次，
  //    逐 session 容错在 restoreOne 内部收敛——allSettled 是第二道结构防线）。
  await restoreCandidates(ctx, entryById, report)

  // ⑦ 全部尝试完删除 checkpoint（D3 契约 1 第二轨——无条件删，含全跳过/全失败形态）。
  report.checkpointDeleted = deleteCheckpointFile(ctx.checkpoint)
  console.log(`[reattach] done: restored=${report.restored.length} skipped=${report.skipped.length} excluded=${report.excluded.length} checkpointDeleted=${report.checkpointDeleted}`)
  return report
}

/**
 * ② 真补集过滤：逐 entry 判定恢复候选（candidates）与排除（excluded），返回
 * sessionId → entry 映射（⑥ restoreOne 的 staleness guard 消费）。
 */
function partitionSnapshotEntries(
  ctx: ReattachContext,
  snapshot: { sessions: RuntimeCheckpointEntry[] },
  report: ReattachReport,
): Map<string, RuntimeCheckpointEntry> {
  const entryById = new Map<string, RuntimeCheckpointEntry>()
  const nowMs = ctx.now()
  for (const entry of snapshot.sessions) {
    entryById.set(entry.piSessionId, entry)
    if (shouldReattachEntry(entry, { nowMs, idleWindowMs: ctx.idleWindowMs, viewedWindowMs: ctx.viewedWindowMs })) {
      report.candidates.push(entry.piSessionId)
    } else {
      report.excluded.push(entry.piSessionId)
    }
  }
  return entryById
}

/**
 * ④ 等待孤儿收割完成（收割链含 5s 调度宽限——live 孤儿未收割完不 spawn）。
 *
 * 超界（false 返回）时本函数完成全部候选的终态处理：逐候选记 reattach-skipped
 * （reason=reap-wait-timeout）+ 删 checkpoint（A6「超界跳过 = 本实例内全部尝试已终态」）。
 */
async function waitForOrphanReap(ctx: ReattachContext, report: ReattachReport): Promise<boolean> {
  let harvested = true
  try {
    harvested = await Promise.race([
      ctx.deps.waitForOrphanReap().then(() => true),
      ctx.delay(ctx.harvestWaitBoundMs).then(() => false),
    ])
  } catch (e: unknown) {
    // 收割 promise 契约永不 reject；防御性 reject 按「未收割」处理（宁 lazy 不双持）。
    console.warn('[reattach] orphan reap wait rejected unexpectedly, skipping reattach:', e)
    harvested = false
  }
  if (!harvested) {
    for (const sessionId of report.candidates) {
      appendSkip(ctx.journal, sessionId, REATTACH_SKIP_REAP_TIMEOUT,
        `orphan reap did not settle within ${ctx.harvestWaitBoundMs}ms; all candidates fall back to lazy (never double-spawn)`)
      report.skipped.push({ sessionId, reason: REATTACH_SKIP_REAP_TIMEOUT })
    }
    // 超界跳过 = 本实例内全部尝试已终态：删 checkpoint（A6 语义）。
    report.checkpointDeleted = deleteCheckpointFile(ctx.checkpoint)
  }
  return harvested
}

/**
 * ⑤ 高水位延迟（D3）：即时系统级查询，高压持续则轮询等待至缓解（无总上限——手动 lazy
 * 恒可用）。偏差 #27：进入延迟 / 缓解退出各广播一次 reattach:deferred（形态选择见
 * ReattachDeferredBroadcast 注释）；best-effort——广播故障不破坏编排链。
 */
async function waitForMemPressureClear(ctx: ReattachContext, report: ReattachReport): Promise<void> {
  let deferredAnnounced = false
  for (;;) {
    let high = false
    try {
      const sample = await ctx.queryPressure()
      high = isMemPressureHigh(sample, ctx.thresholds)
    } catch (e: unknown) {
      // 查询契约永不 reject；防御兜底按「可恢复」处理（不因旁路设施故障阻塞恢复）。
      console.warn('[reattach] mem pressure query failed unexpectedly, resuming:', e)
    }
    if (!high) break
    report.highWaterWaits++
    if (report.highWaterWaits === 1) {
      console.warn(`[reattach] system memory pressure high — deferring reattach spawn (re-check every ${ctx.highWaterPollMs}ms; manual lazy restore unaffected)`)
      deferredAnnounced = true
      broadcastDeferredSafely(ctx.onDeferredBroadcast, { active: true, reason: 'high-memory', pollMs: ctx.highWaterPollMs })
    }
    await ctx.delay(ctx.highWaterPollMs)
  }
  if (report.highWaterWaits > 0) {
    console.log(`[reattach] memory pressure cleared after ${report.highWaterWaits} poll(s), resuming reattach`)
    if (deferredAnnounced) {
      // 进入拍广播过才发退出帧（零延迟常态不产生任何帧）；查询抛错按「可恢复」break 的
      // 防御形态同样收到缓解帧——与「进入帧已发出」配对，不留无退出信号的悬挂态。
      broadcastDeferredSafely(ctx.onDeferredBroadcast, { active: false, reason: 'high-memory', pollMs: ctx.highWaterPollMs })
    }
  }
}

/** ⑥ 分批 restore（并发上限 = ctx.concurrency，缺省 2；逐批 allSettled）。 */
async function restoreCandidates(
  ctx: ReattachContext,
  entryById: Map<string, RuntimeCheckpointEntry>,
  report: ReattachReport,
): Promise<void> {
  for (let i = 0; i < report.candidates.length; i += ctx.concurrency) {
    const batch = report.candidates.slice(i, i + ctx.concurrency)
    await Promise.allSettled(batch.map((sessionId) => restoreOne({
      sessionId,
      entry: entryById.get(sessionId),
      deps: ctx.deps,
      journal: ctx.journal,
      fileExists: ctx.fileExists,
      report,
    })))
  }
}

/** 单 session 恢复（staleness guard → restore；失败记事件，不向上抛）。 */
async function restoreOne(input: {
  sessionId: string
  entry: RuntimeCheckpointEntry | undefined
  deps: StartupReattachDeps
  journal: CrashJournalWriter
  fileExists: (path: string) => boolean
  report: ReattachReport
}): Promise<void> {
  const { sessionId, entry, deps, journal, fileExists, report } = input
  try {
    // staleness guard（D3 契约 2，消费侧职责）：filePath=null（pi 延迟写入窗口，快照未知）
    // 或会话文件已缺失（用户删除/清理）→ 跳过 + 记事件（逐 session 一条）。
    if (!entry?.filePath || !fileExists(entry.filePath)) {
      const detail = entry?.filePath
        ? `session file missing on disk: ${entry.filePath} (deleted by user or cleaned)`
        : 'checkpoint filePath unknown (pi delayed-write window before first flush)'
      appendSkip(journal, sessionId, REATTACH_SKIP_STALENESS, detail)
      report.skipped.push({ sessionId, reason: REATTACH_SKIP_STALENESS })
      return
    }
    await deps.restore(sessionId)
    report.restored.push(sessionId)
  } catch (e: unknown) {
    // 逐 session 容错（D3「失败走既有 lazy，不阻断」）：记录事件后继续其余候选。
    const message = e instanceof Error ? e.message : String(e)
    appendSkip(journal, sessionId, REATTACH_SKIP_RESTORE_FAILED, `restore failed: ${message}`)
    report.skipped.push({ sessionId, reason: REATTACH_SKIP_RESTORE_FAILED })
  }
}

/** 记一条 reattach-skipped 台账行（runtime 层，字段集 = schema D1；best-effort）。 */
function appendSkip(journal: CrashJournalWriter, sessionId: string, reason: string, detailDigest: string): void {
  journal.append({
    layer: 'runtime',
    event: 'reattach-skipped',
    sessionId,
    reason,
    detailDigest,
  })
}

/**
 * 删除 checkpoint 主文件（D3 契约 1 删除属主第二轨——删除属主在 main 退出链与本编排，
 * runtime 自身退出路径一律不删）。ENOENT = 已删/竞态删除（非失败）；其余失败 best-effort
 * 记日志，残留交 main 退出链与下次启动隔离双通道收敛。
 */
function deleteCheckpointFile(checkpoint: RuntimeCheckpointStore): boolean {
  try {
    unlinkSync(checkpoint.checkpointPath)
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    console.warn(`[reattach] checkpoint delete failed (${checkpoint.checkpointPath}):`, e)
    return false
  }
}

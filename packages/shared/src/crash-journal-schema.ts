/**
 * 崩溃台账事件 Schema SSOT（docs/architecture/crash-forensics-and-watchdog.md §3.3 D1）。
 *
 * 双文件 append-only JSONL（`<dataDir>/logs/crashes/main.jsonl` + `runtime.jsonl`）
 * 的事件形态在此唯一定义：main writer（写 main 自身 + renderer 事件）与 runtime
 * writer（写 runtime + pi + plugin-worker 事件）共用本类型，禁止各自复制定义
 * （实施计划 crash-forensics-and-watchdog.impl-plan.md u1b/u1c）。
 *
 * 枚举口径（设计 D1 schema JSON 块逐字对齐）：
 * - event：20 值闭合枚举。孤儿值删除先例：unclean-exit（v8，是 reason 值不是 event
 *   值——main 自身 crash 经 clean-exit marker 下次启动补记为 layer=main, event=crash,
 *   reason=unclean-exit，见 D1 写入点矩阵「main 自身 crash」行）；oom（2026-09-12
 *   裁决，偏差 #32②——零生产者：renderer OOM 实际形态 = reload 事件 + Electron
 *   RenderProcessGoneDetails reason='oom' 透传（open reason 集承载），runtime/watchdog
 *   保守记 crash / 只广播，见设计 D1 矩阵 oom 行裁决注记）。
 * - reason：开放式枚举（schema reason 行末「…」）——已知值登记在
 *   CRASH_JOURNAL_KNOWN_REASONS，未知值可携带（类型保持 string 不收窄联合，
 *   台账消费方按「值即文档」自解释），新增已知值时同步登记元组。
 *
 * 字段全可空（设计 D1「不知道 ≠ 没打点」原则）：崩溃瞬间常拿不全上下文，任何字段
 * 缺省或显式 null 都是合法事件——打点永不因字段不全而放弃。
 *
 * 纯类型/常量模块（无 node 依赖、无 process 访问），renderer barrel 安全。
 */

/** 事件产生层（schema layer 行，5 值）。 */
export type CrashJournalLayer = 'pi' | 'runtime' | 'renderer' | 'main' | 'plugin-worker'

/** 事件名（schema event 行，20 值闭合枚举，顺序与设计文档行逐字一致）。 */
export type CrashJournalEventName =
  | 'crash'
  | 'unresponsive'
  | 'auto-respawn'
  | 'auto-respawn-failed'
  | 'reload'
  | 'rolling-restart'
  | 'rolling-restart-deferred'
  | 'rolling-restart-forced'
  | 'shutdown'
  | 'deleted'
  | 'reclaimed'
  | 'memory-relief'
  | 'reattach-skipped'
  | 'checkpoint-corrupt'
  | 'reaped'
  | 'inbound-frame-dropped'
  | 'frame-truncated'
  | 'registry-miss'
  | 'watermark-daily'
  | 'trigger-review'

/**
 * 归因原因。开放式枚举（schema reason 行 `…` 语义）：已知值见
 * CRASH_JOURNAL_KNOWN_REASONS；类型保持 string——写入侧可携带 schema 未列的
 * 新原因（设计 D2 评估器只数已知形态，未知值落盘留待归因，不因收窄丢行）。
 */
export type CrashJournalReason = string

/**
 * reason 已知值集合（开放枚举的登记面，非校验闸）。
 *
 * 前段 6 值 = 设计 D1 schema reason 行逐字转录；其余 = 实装 append 调用点静态可枚举
 * 的已知值全集（impl-plan 偏差 #18 残留风险回写，按写入域分组，来源文件见行注释）。
 * 两类动态形态刻意不登记（非闭合字面量，落 open 集语义覆盖）：Electron
 * render-process-gone reason 透传（window-factory reload 行，值域由 Electron 决定）
 * 与 trigger-review 的 `condition-<id>` 参数化模板（trigger-patrol.ts）。
 */
export const CRASH_JOURNAL_KNOWN_REASONS = [
  // 设计 D1 schema reason 行（6 值，逐字）
  'extension-stale-ctx',
  'sigterm',
  'planned',
  'unclean-exit',
  'warn-tier',
  'trunc-tier',
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
] as const satisfies readonly CrashJournalReason[]

/** 系统级内存压力子对象（schema memPressure 行，值单位 MB）。 */
export interface CrashJournalMemPressure {
  /** 已用 swap（MB）。 */
  swapUsedMB?: number | null
  /** 物理空闲内存（MB）。 */
  freeMB?: number | null
}

/**
 * 台账事件（schema JSON 块字段集，14 个顶层字段全部可缺省可 null）+ 登记的扩展字段。
 * JSONL 每行一个本对象；字段语义见设计 D1 schema JSON 块与写入点矩阵。
 *
 * **扩展字段开放语义（偏差 #32③ 登记面）**：14 个 schema 字段之外，具体事件可携带
 * 下方「按事件登记的扩展字段」（全可空，与主字段同原则）——新增扩展字段必须先在
 * 本接口登记（字段 + 产生事件 + 产生文件注释），禁止写入侧绕过本接口私自扩字段；
 * 设计文档 D1 schema JSON 块只权威化 14 主字段，扩展字段以本接口为登记 SSOT。
 */
export interface CrashJournalEvent {
  /** 事件时刻（ISO 8601 UTC，如 2026-09-12T02:57:03Z）。 */
  ts?: string | null
  layer?: CrashJournalLayer | null
  event?: CrashJournalEventName | null
  sessionId?: string | null
  reason?: CrashJournalReason | null
  exitCode?: number | null
  /** 进程 RSS（bytes）。 */
  rss?: number | null
  /** V8 heap used（bytes）。 */
  heapUsed?: number | null
  /** 进程存活秒数。 */
  uptimeSec?: number | null
  /**
   * 滚动重启 deferred/forced 事件的当时镜像在途计数（D5 ⑤ stale-high 观测面）：
   * 数字 = 在场且已上报的镜像合计；null = 计数未知（errs/absent-report 形态，
   * u7b 配方——0 是「在场且无在途」的已证事实，null 才是未知）。其余事件缺省。
   */
  inflight?: number | null
  /** xyz-agent 应用版本（如 0.9.16）。 */
  appVersion?: string | null
  /** pi 版本（如 0.84.4）。 */
  piVersion?: string | null
  memPressure?: CrashJournalMemPressure | null
  /** 详情摘要内嵌（如末 10 行 stderr 摘要，≤2KB——归因不依赖会被清理的 detailPath）。 */
  detailDigest?: string | null
  /** 详情文件相对路径（如 logs/pi-crash-….log）。 */
  detailPath?: string | null

  // ── 扩展字段登记面（开放语义：新增须在此登记，见接口头注）─────────────

  /** [reaped] 被收殓的孤儿 pi 进程 pid（reap-orphan-pi.ts 杀链命中行）。 */
  pid?: number | null
  /** [reaped] 收殓时刻的 ppid（恒 1 = reparent 证据，归因复核判据；reap-orphan-pi.ts）。 */
  ppid?: number | null
  /** [reclaimed] 回收判定时的空闲时长 now - lastActivityAt（idle-pi-reaper.ts 摘除步）。 */
  idleMs?: number | null
  /** [reclaimed] 最近被查看时刻（epoch ms）；null = 从未被查看（idle-pi-reaper.ts）。 */
  lastViewedAt?: number | null
  /** [plugin-worker-crash] 宿主池内进程标识 trusted-N / sandbox-<pluginId>（plugin-host-process.ts）。 */
  processId?: string | null
  /** [plugin-worker-crash] 致死信号名；exit code 路径为 null（plugin-host-process.ts）。 */
  signal?: string | null
  /** [plugin-worker-crash] 崩溃时挂在该进程上的插件 id 集（trusted 进程最多 10 个受影响；plugin-host-process.ts）。 */
  pluginIds?: string[] | null
}

/** 台账文件角色：main writer 写 main.jsonl，runtime writer 写 runtime.jsonl（D1 双文件）。 */
export type CrashJournalFileRole = 'main' | 'runtime'

/** writer 构造选项。 */
export interface CrashJournalWriterOptions {
  /** 决定写入 crashes/main.jsonl 或 crashes/runtime.jsonl。 */
  role: CrashJournalFileRole
}

/**
 * 崩溃台账 writer 接口（u1b runtime / u1c main 两实现共用此签名）。
 *
 * append 为 fire-and-forget：追加一条事件（单行 JSONL）不向调用方抛错——台账是
 * 崩溃路径上的旁路，写失败（磁盘满等）不得放大为调用链故障（D1 防漏设计前提）。
 */
export interface CrashJournalWriter {
  append(event: CrashJournalEvent): void
}

// ─────────────────────────────────────────────────────────────────────────────
// 枚举值元组（消费方测试的全集覆盖矩阵数据源，范式同 subagent.ts SUBAGENT_STATUS_ALL）
// ─────────────────────────────────────────────────────────────────────────────

export const CRASH_JOURNAL_LAYERS = [
  'pi',
  'runtime',
  'renderer',
  'main',
  'plugin-worker',
] as const satisfies readonly CrashJournalLayer[]

export const CRASH_JOURNAL_EVENTS = [
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
] as const satisfies readonly CrashJournalEventName[]

/**
 * 反向完备编译锁（范式同 subagent.ts）：联合扩值漏改元组时退化为错误信息元组，
 * 下方赋值 tsc 红（正向「元组含非联合值」由上方 satisfies 拦截）。
 */
type _LayerCoversAll = [CrashJournalLayer] extends [(typeof CRASH_JOURNAL_LAYERS)[number]]
  ? true
  : ['CrashJournalLayer 扩值须同步 CRASH_JOURNAL_LAYERS 元组']
type _EventCoversAll = [CrashJournalEventName] extends [(typeof CRASH_JOURNAL_EVENTS)[number]]
  ? true
  : ['CrashJournalEventName 扩值须同步 CRASH_JOURNAL_EVENTS 元组']

/** 编译锁消费点（导出以通过 noUnusedLocals；值恒 true 无运行期语义，类型承重）。 */
export const CRASH_JOURNAL_ENUM_COVERAGE_LOCK: [_LayerCoversAll, _EventCoversAll] = [true, true]

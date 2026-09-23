/**
 * runtime checkpoint 持续交接（docs/architecture/crash-forensics-and-watchdog.md §3.3 D3，
 * 实施单元 u4）。
 *
 * 职责：把本 runtime 进程当前**活跃 session 清单 + 每 session 恢复元数据**持续落到
 * `<dataDir>/run/runtime-checkpoint.json`，供「runtime 死后新 runtime 的 reattach 编排」
 * （u5）判定该恢复谁。落盘时机 = session 生命周期事件（attach / detach / reclaim /
 * respawn 成功，由 session-service 挂点驱动）+ reaper 5min tick 搭车刷新时效字段
 * （idle-pi-reaper 每拍本来就要遍历活跃 session 算 idleMs，顺带刷新零新增探测）。
 *
 * 五契约（设计 §5「checkpoint 五契约」逐条映射，本模块落地其中 4 条；收割时序属 u5）：
 * 1. **删除属主双轨**：本模块提供 `removeSession`（摘除条目，非删文件）与只读面；**不提供
 *    任何退出路径的删文件动作**——runtime 自身任何退出路径（planned / uncaught / 被强杀）
 *    一律不删 checkpoint 文件（D5 退出链论证：SIGINT/SIGTERM/uncaughtException 三源共用
 *    shutdown 序，app 级退出与 liveness 强杀共用 supervisor 同一 stop 杀链，「app 级识别
 *    信号」不存在；自删即自毁恢复依据）。删除属主 = main 侧 app 退出链（成功段）+ 新
 *    runtime 的 reattach 编排（全部尝试完后）。
 * 2. **staleness guard**：消费侧（u5）职责——reattach 前校验 session 文件存在。本模块的
 *    贡献 = `read()` 返回 undefined 语义（文件缺失 = 无快照，不是空清单）与 filePath 字段
 *    如实落盘（null = 未知，不伪造成空串）。
 * 3. **完整性降级**：原子写（tmp + rename）；解析失败 → `checkpoint-corrupt` 台账事件 +
 *    失败现场隔离 + 返回 undefined（调用方退既有 lazy 恢复，不抛）。
 * 4. **失败现场**：`<runDir>/runtime-checkpoint-failed-<ts>.json` 保留最近 3 份（新失败
 *    覆盖最旧）。
 * 5. **风暴防护**：写只在生命周期事件与 reaper tick 发生（不在每次 touch 刷盘——D3 时效性
 *    裁决）；rename 同域失败幂等（ENOENT = 并发删除已隔离；EACCES = 原地残留静默，不重试
 *    不升级）；事件只记首次（进程内 once，防同一失败被反复记录）。
 *
 * **写失败可见性（code-harden RT-4#6，在契约 5 风暴防护之内的增强）**：写失败上报从
 * 「进程内 once、此后零日志」改为限流上报——首次失败立即 warn（保留 once 上报的首次
 * 即报语义），此后每 5min 至多一条（携带连续失败次数与最后成功写时刻）；连续失败达
 * 阈值落一条 crash 台账事件（reason=checkpoint-write-failed，每轮连续失败期只一条）。
 * `write()` 返回 bool 并维护两个诊断面：`getLastSuccessfulWriteAt()`（最后成功写盘时刻）
 * 与 `isCheckpointStale()`（自上次成功写盘后有失败 = 磁盘快照落后内存真相，下次成功
 * 写盘清除）。影响面登记（不夸大）：checkpoint 是恢复增强，写失败的后果 = u5 reattach
 * 读到旧版快照（漏恢复/多恢复，消费侧 staleness guard 已挡住「复活已删 session」），
 * 退化为既有 lazy 恢复；本增强解决的是诊断失真——停更可被发现、可归因。
 *
 * **时效性与 errs 方向（设计 D3 显式声明，实现口径必须一致）**：lastActivityAt 不在每次
 * touch 刷盘（写风暴），只搭 5min tick 的便车——checkpoint 值 ≤ 真实值，故消费侧算出的
 * idle = now − 值 **≥ 真实 idle**，过滤**偏「漏恢复」**（刚交互过但跨过阈值边界的 session
 * 被判更闲置而漏恢复），退化为现状 lazy（用户代价 = 一次手动触碰），不是偏「多恢复」。
 * 快照布尔的**反向形态**（诚实声明）：任务于 T 结束、T+≤5min 内崩溃时快照仍为 true，会
 * 多恢复一个真实已 idle 的 session——新 runtime 的 reaper 后续拍按 checkpoint 时间戳正常
 * 回收它（自收敛，无用户可见损害）。排查口径：持续多恢复且不自收敛 = 公式错误；偶发单次
 * 后自收敛 = 快照滞后。
 *
 * **覆盖式写入（不 seed 磁盘旧文件）**：内存清单是本进程的活跃 session 真相，第一次写入即
 * 整份覆写。理由（设计 D3 「误配对」裁决的落地）：若 seed 旧文件，clean exit 残留的陈旧
 * 清单会被当成本进程活跃集重新落盘，后续真 unclean 崩溃会复活用户已删除的 session。代价
 * 显式登记：reattach 进行中崩溃会丢失「尚未附着项」的清单（errs = 漏恢复，退化 lazy）；
 * 这正是设计「后续 unclean 覆写接管」通道的实现形态。
 *
 * 依赖注入（测试可注入）：目录 / 时钟 / 台账 writer 全经 options 传入，生产缺省走
 * getDataDir() 动态推导（禁止硬编码绝对路径）+ 模块级单例。单例风格对齐 crash-journal：
 * `getRuntimeCheckpointStore()` 懒初始化（生产零新增组合根接线），未写入前零副作用。
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { CrashJournalWriter } from '@taiji/shared'
import {
  RUN_CHECKPOINT_FAILED_PREFIX,
  RUN_CHECKPOINT_FAILED_RETENTION,
  RUN_CHECKPOINT_FILENAME,
  getDataDir,
} from '@taiji/shared/paths'
import { getCrashJournal } from '../../infra/crash-journal.js'
import { logger } from '../../infra/logger.js'

// 文件名/前缀/保留份数 SSOT = @taiji/shared/paths RUN_* 常量族（【oe-audit C8】：
// 原三处手抄字面量收敛——main.ts 残留隔离与诊断导出与本 writer 共享同一单点定义，
// 漏改即静默失配的漂移面构造性消失）。

/** 文件格式版本（消费方按需迁移；当前 1 = 设计 D3 字段集）。 */
export const CHECKPOINT_VERSION = 1

/** 写失败限流上报窗口（code-harden RT-4#6）：首次即报，此后每 5min 至多一条 warn。 */
// eslint-disable-next-line no-magic-numbers -- 5min 限流窗口是审计定值（RT-4#6「每 5min 一条」），非可调魔数
export const WRITE_FAILURE_WARN_INTERVAL_MS = 5 * 60_000

/** 连续写失败落 crash 台账事件的阈值（每轮连续失败期只一条；成功写盘复位）。 */
export const WRITE_FAILURE_LEDGER_THRESHOLD = 3

/** 台账 detailDigest 上限（设计 D1 防漏设计①：内嵌摘要 ≤2KB，与 pi-respawn 同口径）。 */
const CRASH_DIGEST_MAX_CHARS = 2048

/**
 * 占用快照（豁免 #1 三维判定：turn ≠ idle / compacting / bash，任一命中即 'occupied'）。
 * 术语与既有实现对齐——生产方 = reaper 的 `ReclaimExemptions.isOccupied`。
 */
export type CheckpointOccupancy = 'idle' | 'occupied'

/**
 * 单 session 恢复元数据（设计 D3 字段集：piSessionId / 文件路径 / lastActivityAt /
 * lastViewedAt / occupancy + 真补集公式所需的两项豁免快照布尔）。
 *
 * reattach 过滤公式（u5 消费，真补集语义）：`occupied === 'occupied' || backgroundTasks ||
 * relayChildren || idleMs ≤ 2h || lastViewedAt 距今 ≤ 30min`（任一满足即恢复）。
 */
export interface RuntimeCheckpointEntry {
  /** pi session id（= runtime 侧 sessionId，会话文件 id 同源）。 */
  piSessionId: string
  /** 会话 JSONL 文件路径；null = 未知（pi 延迟写入窗口，stalker guard 侧需校验存在性）。 */
  filePath: string | null
  /** 最近活动时刻（epoch ms；生产源 = pi client.lastActivityAt，attach 时取不到则 spawn 时刻）。 */
  lastActivityAt: number | null
  /** 最近被查看时刻（epoch ms）；null = 从未被查看（「不知道 ≠ 没打点」）。 */
  lastViewedAt: number | null
  /** 占用快照（豁免 #1）。 */
  occupancy: CheckpointOccupancy
  /** 豁免 #2 快照：有 running 后台任务。 */
  backgroundTasks: boolean
  /** 豁免 #3 快照：有在途 relay 子进程。 */
  relayChildren: boolean
}

/** checkpoint 文件整体形态（活跃 session 清单 + 写入时刻）。 */
export interface RuntimeCheckpointFile {
  version: number
  /** 本次写入时刻（ISO 8601 UTC；诊断/排查用，消费判定以每 session 时间戳为准）。 */
  updatedAt: string
  sessions: RuntimeCheckpointEntry[]
}

/** attach / respawn 成功时的整条写入输入（缺省字段取保守初值）。 */
export interface RuntimeCheckpointUpsert {
  /** pi session id。 */
  sessionId: string
  /** 会话文件路径（undefined/null = 未知）。 */
  filePath?: string | null
  /** 最近活动时刻（undefined = 取本模块时钟 now()）。 */
  activityAt?: number
  /** 最近被查看时刻（undefined = 未记录 → null）。 */
  viewedAt?: number
  /** 占用快照（undefined = 'idle'，新 spawn 语义）。 */
  occupancy?: CheckpointOccupancy
  /** 豁免 #2 快照（undefined = false，新 spawn 无后台任务）。 */
  backgroundTasks?: boolean
  /** 豁免 #3 快照（undefined = false，新 spawn 无 relay 子进程）。 */
  relayChildren?: boolean
}

/**
 * reaper tick 搭车刷新输入（D3：只刷时效字段与豁免快照，**不新增/不复活条目**——
 * 只更新内存清单中已存在的项，避免把未附着的候选写进 checkpoint）。
 */
export interface RuntimeCheckpointRefresh {
  /** pi session id。 */
  sessionId: string
  /** 本拍读到的活动时刻（undefined = 本拍无信号，保留现值）。 */
  activityAt?: number
  /** 本拍读到的查看时刻（undefined = 本拍未判定/未记录，保留现值）。 */
  viewedAt?: number
  /** 占用快照（undefined = 本拍未判定，保留现值）。 */
  occupancy?: CheckpointOccupancy
  /** 豁免 #2 快照（undefined = 本拍未判定，保留现值）。 */
  backgroundTasks?: boolean
  /** 豁免 #3 快照（undefined = 本拍未判定，保留现值）。 */
  relayChildren?: boolean
}

/** 残留隔离结果（rename 同域失败的幂等语义载体）。 */
export type CheckpointIsolationOutcome =
  /** 已重命名进失败现场家族（快照路径见返回值）。 */
  | 'isolated'
  /** ENOENT：源不存在（并发删除路径已处理）——视为已隔离，非失败。 */
  | 'already-absent'
  /** EACCES 等：rename 与 unlink 同域失败，接受原地残留（静默、不重试、不升级）。 */
  | 'residual'

export interface RuntimeCheckpointOptions {
  /** checkpoint 目录（`<dataDir>/run`）；缺省 getDataDir() 动态推导。 */
  dir?: string
  /** 时钟注入（测试 fake 时间戳；缺省 Date.now）。 */
  now?: () => number
  /** 台账 writer（checkpoint-corrupt 事件）；缺省 getCrashJournal() 单例。 */
  journal?: CrashJournalWriter
  /** 失败现场保留份数；缺省 3（D3）。 */
  failedSnapshotRetention?: number
}

export class RuntimeCheckpointStore {
  /** 本进程活跃 session 清单（真相在内存；磁盘是它的镜像——不 seed 旧文件，见文件头）。 */
  private readonly entries = new Map<string, RuntimeCheckpointEntry>()
  private readonly dir: string
  private readonly now: () => number
  private readonly journal: CrashJournalWriter
  private readonly failedSnapshotRetention: number
  /** checkpoint-corrupt 进程内一次（重复失败不重复记事件，D3 降级声明）。 */
  private corruptReported = false
  // ── 写失败可见性状态（code-harden RT-4#6）──
  /** 连续写失败计数（成功写盘归零）。 */
  private writeFailureCount = 0
  /** 上条写失败 warn 时刻（null = 本进程尚未报过；首次失败恒即报）。 */
  private lastWriteFailureWarnAt: number | null = null
  /** 连续失败台账事件已落标志（每轮连续失败期只一条；成功写盘复位）。 */
  private writeFailureLedgered = false
  /** 最后成功写盘时刻（epoch ms；null = 本进程从未成功写过。诊断导出面）。 */
  private lastSuccessfulWriteAt: number | null = null
  /** checkpoint 陈旧标志：自上次成功写盘后有写入失败（磁盘快照落后内存真相），成功写盘清除。 */
  private checkpointStale = false

  constructor(options: RuntimeCheckpointOptions = {}) {
    this.dir = options.dir ?? join(getDataDir(), 'run')
    this.now = options.now ?? Date.now
    this.journal = options.journal ?? getCrashJournal()
    this.failedSnapshotRetention = Math.max(1, options.failedSnapshotRetention ?? RUN_CHECKPOINT_FAILED_RETENTION)
  }

  /** run 目录（诊断/测试断言面）。 */
  get runDir(): string {
    return this.dir
  }

  /** checkpoint 主文件绝对路径。 */
  get checkpointPath(): string {
    return join(this.dir, RUN_CHECKPOINT_FILENAME)
  }

  /** 内存清单快照（诊断/测试断言面；order 无保证）。 */
  listEntries(): RuntimeCheckpointEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }))
  }

  /** 本进程清单中的 session id（诊断/测试断言面）。 */
  hasSession(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  /** 最后成功写盘时刻（epoch ms）；null = 本进程从未成功写过（诊断导出面，RT-4#6）。 */
  getLastSuccessfulWriteAt(): number | null {
    return this.lastSuccessfulWriteAt
  }

  /**
   * checkpoint 陈旧标志（诊断导出面，RT-4#6）：自上次成功写盘后发生过写入失败 = 磁盘
   * 快照落后内存真相（主文件停在上版）。下次成功写盘清除。消费方（诊断导出 / 排查）
   * 据此区分「checkpoint 新鲜」与「checkpoint 停更」。
   */
  isCheckpointStale(): boolean {
    return this.checkpointStale
  }

  /**
   * 读 checkpoint 主文件（消费侧 = u5 reattach 编排；staleness guard 的第 0 步）。
   *
   * 契约：文件不存在 → undefined（无快照，非空清单）；解析/形状失败 → **记一次
   * `checkpoint-corrupt` 台账事件 + 隔离失败现场**并返回 undefined（完整性降级：调用方
   * 退既有 lazy 恢复，不抛异常——checkpoint 是恢复增强，损坏不得升级为启动失败）。
   */
  read(): RuntimeCheckpointFile | undefined {
    let raw: string
    try {
      raw = readFileSync(this.checkpointPath, 'utf8')
    } catch {
      return undefined // ENOENT = 无快照（常态：clean exit 已删 / 首次启动）
    }
    try {
      return parseCheckpointFile(raw)
    } catch (e: unknown) {
      this.reportCorruptOnce(e)
      // 失败现场：把损坏文件移出主位（可能被后续真 unclean 误配对复活旧清单）
      this.isolateResidual()
      return undefined
    }
  }

  /**
   * attach / respawn 成功：整条写入（新建或覆盖）。
   *
   * respawn 成功与 attach 共用本入口的事实依据：pi 重 spawn 经 registerSession 汇聚点
   * 重新附着（session-service 的 onSessionRegistered 订阅），元数据以此为准整条刷新。
   */
  upsertSession(input: RuntimeCheckpointUpsert): void {
    this.entries.set(input.sessionId, {
      piSessionId: input.sessionId,
      filePath: input.filePath ?? null,
      lastActivityAt: input.activityAt ?? this.now(),
      lastViewedAt: input.viewedAt ?? null,
      occupancy: input.occupancy ?? 'idle',
      backgroundTasks: input.backgroundTasks ?? false,
      relayChildren: input.relayChildren ?? false,
    })
    this.write()
  }

  /**
   * detach / reclaim：摘除条目（不存在 = no-op，不落盘）。
   *
   * 摘除 ≠ 删除文件：文件删除属主在 main 退出链与 u5 reattach 编排（契约 1）。
   */
  removeSession(sessionId: string): void {
    if (!this.entries.delete(sessionId)) return
    this.write()
  }

  /**
   * reaper 5min tick 搭车刷新（D3 时效性裁决）：只更新**已存在**条目，一次落盘。
   *
   * 不新增条目（候选枚举与 checkpoint 同源 = getActiveSessionIds，未附着者不该进清单）；
   * 本拍未判定的字段保留现值（undefined = 不覆盖，区别于「判定为 false/idle」）。
   * 无任何变更时不落盘（避免空 tick 反复改写文件）。
   */
  refreshSessions(refreshes: readonly RuntimeCheckpointRefresh[]): void {
    let changed = false
    for (const r of refreshes) {
      const entry = this.entries.get(r.sessionId)
      if (!entry) continue
      let touched = false
      if (r.activityAt !== undefined) { entry.lastActivityAt = r.activityAt; touched = true }
      if (r.viewedAt !== undefined) { entry.lastViewedAt = r.viewedAt; touched = true }
      if (r.occupancy !== undefined) { entry.occupancy = r.occupancy; touched = true }
      if (r.backgroundTasks !== undefined) { entry.backgroundTasks = r.backgroundTasks; touched = true }
      if (r.relayChildren !== undefined) { entry.relayChildren = r.relayChildren; touched = true }
      changed = changed || touched
    }
    if (changed) this.write()
  }

  /**
   * 残留隔离（设计 D3 rename 同域失败幂等声明）：把 checkpoint 主文件重命名进失败现场
   * 家族（`runtime-checkpoint-failed-<ts>.json`），并按保留份数裁剪。
   *
   * 幂等语义：ENOENT（并发删除路径已处理）→ 'already-absent'，视为已隔离；EACCES 等
   * 同域失败 → 'residual'，接受原地残留（静默、不重试风暴、不升级）——收敛依赖双通道：
   * 下次启动重试隔离 + 后续 unclean 崩溃的覆写接管。本方法自身不记事件（事件是语义层
   * 的「为什么不恢复」，由调用方按进程内 once 记首次）。
   */
  isolateResidual(sourcePath: string = this.checkpointPath): CheckpointIsolationOutcome {
    const target = join(this.dir, `${RUN_CHECKPOINT_FAILED_PREFIX}${formatTimestamp(this.now())}.json`)
    try {
      renameSync(sourcePath, target)
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return 'already-absent'
      return 'residual'
    }
    this.pruneFailedSnapshots()
    return 'isolated'
  }

  /** 清空内存清单（组合根/测试复位；**不动磁盘文件**——文件删除属主在 main / u5）。 */
  reset(): void {
    this.entries.clear()
  }

  /**
   * 原子写主文件：tmp + rename（完整性降级的另一半——消费方永远读不到半截 JSON）。
   *
   * 失败 best-effort：清掉 tmp 残留 + 限流上报（RT-4#6），不抛。
   * 返回 bool（RT-4#6）：true = 成功落盘（更新 lastSuccessfulWriteAt、清 checkpointStale）；
   * false = 失败（置 checkpointStale，主文件保持上一版）。全部写入挂点（upsert/remove/
   * refresh）在本模块内部消费该结果维护诊断面，调用方无需感知。
   */
  private write(): boolean {
    let json: string
    try {
      json = JSON.stringify({
        version: CHECKPOINT_VERSION,
        updatedAt: new Date(this.now()).toISOString(),
        sessions: Array.from(this.entries.values()),
      } satisfies RuntimeCheckpointFile)
    } catch (e: unknown) {
      this.reportWriteFailure(`serialize failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
    const tmpPath = `${this.checkpointPath}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(tmpPath, json, 'utf8')
      renameSync(tmpPath, this.checkpointPath)
    } catch (e: unknown) {
      // 写失败时主文件保持上一版（rename 未发生）——消费方读到的是完整旧版而非半截新版本
      try {
        unlinkSync(tmpPath)
      // eslint-disable-next-line taste/no-silent-catch -- tmp 清理由失败路径触发，ENOENT 常态；不阻断降级
      } catch {
        // no-op
      }
      this.reportWriteFailure(`write failed: ${(e as NodeJS.ErrnoException).code ?? e}`)
      return false
    }
    // 成功写盘：刷新最后成功时刻、清陈旧标志、复位连续失败计数与台账事件轮次
    this.lastSuccessfulWriteAt = this.now()
    this.checkpointStale = false
    this.writeFailureCount = 0
    this.writeFailureLedgered = false
    return true
  }

  /** 失败现场裁剪：保留最近 N 份（按文件名 ts 排序，新覆盖最旧）。 */
  private pruneFailedSnapshots(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((n) => n.startsWith(RUN_CHECKPOINT_FAILED_PREFIX))
    } catch {
      return // 目录不可读（权限）→ 不做裁剪（隔离本身已 best-effort）
    }
    // 文件名内 ts 为固定宽度 ISO（字典序 = 时间序），升序后从头删多余份数
    names.sort()
    const excess = names.length - this.failedSnapshotRetention
    for (let i = 0; i < excess; i++) {
      try {
        unlinkSync(join(this.dir, names[i]!))
      // eslint-disable-next-line taste/no-silent-catch -- 裁剪是卫生动作，单份删除失败不阻塞隔离主结果
      } catch {
        // no-op
      }
    }
  }

  /** checkpoint-corrupt 事件：进程内只记首次（重复失败不重复记事件，D3 降级声明）。 */
  private reportCorruptOnce(error: unknown): void {
    if (this.corruptReported) return
    this.corruptReported = true
    this.journal.append({
      layer: 'runtime',
      event: 'checkpoint-corrupt',
      reason: 'parse-failed',
      detailDigest: error instanceof Error ? error.message : String(error),
      detailPath: this.checkpointPath,
    })
  }

  /**
   * 写失败限流上报（code-harden RT-4#6，替代「进程内 once、此后零日志」）：
   * - 首次失败立即 warn（保留 once 上报的首次即报语义——契约 5 风暴防护）；
   * - 此后每 5min 至多一条 warn，携带连续失败次数与最后成功写时刻（stale 可归因）；
   * - 连续失败达阈值落一条 crash 台账事件（reason=checkpoint-write-failed，每轮连续
   *   失败期只一条）——warn 在滚动日志里会被轮转，台账是持久结构化证据。
   * 成功写盘复位全部计数与标志（见 write()）。
   */
  private reportWriteFailure(message: string): void {
    this.writeFailureCount += 1
    this.checkpointStale = true
    const now = this.now()
    const warnDue = this.lastWriteFailureWarnAt === null
      || now - this.lastWriteFailureWarnAt >= WRITE_FAILURE_WARN_INTERVAL_MS
    if (warnDue) {
      this.lastWriteFailureWarnAt = now
      const lastSuccess = this.lastSuccessfulWriteAt === null
        ? 'never'
        : new Date(this.lastSuccessfulWriteAt).toISOString()
      logger.warn(`[runtime-checkpoint] checkpoint write failed (consecutive=${this.writeFailureCount}, lastSuccessfulWriteAt=${lastSuccess}, mainFileKeptAtPreviousVersion=true): ${message} (${this.checkpointPath})`)
    }
    if (this.writeFailureCount >= WRITE_FAILURE_LEDGER_THRESHOLD && !this.writeFailureLedgered) {
      this.writeFailureLedgered = true
      this.journal.append({
        layer: 'runtime',
        event: 'crash',
        reason: 'checkpoint-write-failed',
        detailDigest: `consecutive=${this.writeFailureCount}: ${message}`.slice(0, CRASH_DIGEST_MAX_CHARS),
        detailPath: this.checkpointPath,
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模块级单例（对齐 crash-journal：懒初始化 + 生产零新增组合根接线）
// ─────────────────────────────────────────────────────────────────────────────

let singleton: RuntimeCheckpointStore | undefined

/**
 * 显式初始化单例（幂等）。生产可不调——`getRuntimeCheckpointStore()` 会以
 * getDataDir() 动态推导懒初始化；本入口供组合根/测试指定目录与时钟。
 */
export function initRuntimeCheckpointStore(options: RuntimeCheckpointOptions = {}): RuntimeCheckpointStore {
  singleton ??= new RuntimeCheckpointStore(options)
  return singleton
}

/** 取单例（未初始化时以生产路径懒初始化：`<dataDir>/run`）。 */
export function getRuntimeCheckpointStore(): RuntimeCheckpointStore {
  singleton ??= new RuntimeCheckpointStore()
  return singleton
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 checkpoint 文件（形状校验在解析层：未知形状 = 损坏 → 降级）。
 * 只做结构性校验（version / sessions 数组 / 每条的 piSessionId），字段级缺失按可空语义
 * 归一——「不知道 ≠ 没打点」同样适用于消费侧。
 */
function parseCheckpointFile(raw: string): RuntimeCheckpointFile {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('checkpoint root is not an object')
  const root = parsed as { version?: unknown; updatedAt?: unknown; sessions?: unknown }
  if (!Array.isArray(root.sessions)) throw new Error('checkpoint sessions is not an array')
  const sessions: RuntimeCheckpointEntry[] = root.sessions.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`checkpoint session[${index}] is not an object`)
    const s = item as Partial<RuntimeCheckpointEntry>
    if (typeof s.piSessionId !== 'string' || s.piSessionId === '') {
      throw new Error(`checkpoint session[${index}] has no piSessionId`)
    }
    return {
      piSessionId: s.piSessionId,
      filePath: s.filePath ?? null,
      lastActivityAt: s.lastActivityAt ?? null,
      lastViewedAt: s.lastViewedAt ?? null,
      occupancy: s.occupancy === 'occupied' ? 'occupied' : 'idle',
      backgroundTasks: s.backgroundTasks === true,
      relayChildren: s.relayChildren === true,
    }
  })
  return {
    version: typeof root.version === 'number' ? root.version : CHECKPOINT_VERSION,
    updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : '',
    sessions,
  }
}

/**
 * 文件名安全的时间戳（固定宽度 ISO，字典序 = 时间序，跨平台无 `:` / `.`）。
 * 例：2026-09-11T02-57-03-123Z
 */
function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[:.]/g, '-')
}

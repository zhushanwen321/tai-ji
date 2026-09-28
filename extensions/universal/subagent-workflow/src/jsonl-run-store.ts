/**
 * Workflow Extension — JSONL Run Store
 *
 * RunStore port 的 Infra 实现。
 *
 * 职责：WorkflowRun 聚合根的 state 文件物化投影 + 跨 session 重水合（journal 权威）。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 RunStore port。
 * 依赖 @earendil-works/pi-coding-agent 的 ExtensionAPI/ExtensionContext（Infra 允许 Pi SDK）。
 *
 * 介质形态（[W1 介质归位 / D1/D2/D4]，ADR-0078）：
 * - **主 session 每 run 两条 v2 小条目**：注册条目（core lifecycle.runWorkflow 写，
 *   身份 + journalPath 锚点）与终态条目（core finalizeRun 终局 coda 写；本 store 的
 *   loadAll 在「journal 已终局而终态条目缺失」时幂等补写——D4 收编序列的条目半边）。
 *   运行态事实源 = run journal
 *   （`<sessionDir>/workflow-state/<runId>.events.jsonl`，core pump 单写者 + 收编
 *   入口幂等追加）。loadAll 的发现域 = v2 注册条目定界；历史形态 entry（v1 全量
 *   快照 / 旧 workflow-state-link 指针）不参与发现——旧 session JSONL 里的历史
 *   entry 仍在盘上，读侧对未知 entry 的容忍面不受影响。
 * - **save = state 物化投影**：state 文件内容是 fold 富集投影（journal 增量喂入），
 *   覆盖写、可删可重建。
 * - **doFlush 增量 fold（D6）**：journal 读走 core journal-tail 原语（readJournalTail）
 *   的 per-runId offset 续读——每次 flush 只读上次读后新增的完整行，消除「全量 scan
 *   重 fold」的 O(N²) 读放大。截断/重建（truncated）从文件头全量重读并整体替换累积。
 * - **loadAll = journal 权威重建（D4 收编定界）**：v2 注册条目定界（本会话有
 *   哪些实体）→ journal 全量读 → 投影重建（终局 ⟸ run-settled 投影）；「有注册、
 *   无终态」的实体保持 running 交恢复链收编；终局实体幂等补写终态条目。
 * - **事件边沿 flush（P3/D6）**：fs.watch 感知 journal append → 防抖合并 →
 *   flush 物化投影（时机加密到事件边沿；物化对象 = state 文件，无条目写放大面）。
 *   本 store 不消费任何节流设施（state 覆盖写无累积，无需节流）。
 *
 * 物化触发源（单一触发源合并：事件边沿为主，save 直通只留冷路径）：
 * - **冷路径**（本实例对该 runId 首写，或 isRunSettled 即终局）：同步挂链 flush
 *   立即物化——首写与终态投影不等待边沿（终态及时落盘，去抖窗口内的崩溃不吞终态）。
 * - **热路径**（running 中间态，本实例已写过）：只更新内存聚合 + 登记 pending 批
 *   （批内 N 次 save 由下一次物化一起落盘 1 次——serialize-at-flush：写 flush 时刻
 *   最新聚合状态），物化时机 = 事件边沿（watcher 正常时 save 不再起独立去抖 timer）。
 * - **降级直通**（watcher 失效/禁用）：边沿触发退役后物化时机由 save 自身承担——
 *   热路径 save 立即直通 flush（降级补偿：置位瞬间已登记的批一并直通兑现）。
 * - per-runId 串行 flush 链：同 runId 的 flush 排队顺序执行（不跳过、永不并发
 *   writeFile），链尾吞错防断链——错误只经各 save() Promise 的 settlers 传播。
 * - dispose()：幂等（缓存自身 Promise）；刷全部 pending 批 + await 全部 in-flight
 *   链后返回。dispose 后 save 静默 no-op + debug 日志（session_shutdown 编排收尾）。
 *
 * 序列化策略（写向单源）：save 的投影产出消费 core run-snapshot codec
 * （toRunSnapshot）；版本头 "wf-run-v2" 逐字节兼容存量。
 *
 * [S3 查证结论] pi 0.84.4 实装的 session 生命周期管理不含自动 GC（listSessionsFromDir
 * 只读扫描，`<sessionDir>/workflow-state/` 子目录不在 pi 的任何扫描/清理范围内）。
 * **推论：workflow-state 磁盘足迹无限累积，保留策略由本包自担**——每次新 run state
 * 文件首写成功触发一轮 retention 维护（runRetentionSweep：interrupted 放弃窗终局化
 * + 统一保留维护轮 runRetentionMaintenanceRound，判定与执行单源在 core；
 * [W1 / D5] cap 语义已废除，保留窗口是唯一资格判据）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
// 全部经 core barrel 消费（u-2c 删 ./* 通配后深路径仅测试侧 vitest alias 可解析，
// 生产消费必须走 barrel；[C3 常量上收] journal 后缀与 workflow-state 目录分量单源）。
// readJournalTail = D6 tail 增量读原语；v2 条目类型面 = D1 条目契约；retention 走
// core 统一维护轮入口（runRetentionMaintenanceRound + abandonElapsedInterruptedRuns）。
import {
  Budget,
  RUN_EVENT_JOURNAL_SUFFIX,
  STATE_DIR_NAME,
  Trace,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  abandonElapsedInterruptedRuns,
  buildWorkflowRecordSettledEntryData,
  classifyWorkflowRecordEntryData,
  getLogger,
  projectRunEvents,
  readJournalTail,
  runRetentionMaintenanceRound,
  toRunSnapshot,
  type DoneReason,
  type RunOutcome,
  type RunStore,
  type WorkflowRecordRegisteredEntryData,
  type WorkflowRecordSettledEntryData,
  type WorkflowRunEvent,
} from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { guardStaleCtx, isEnoentError, toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ── Serialization → core codec（下沉收口 D4，不变）────────────
//
// save 投影产出单源消费 core run-snapshot codec（toRunSnapshot）。键序与 strip
// live 语义与原实现逐字节一致（__tests__/jsonl-run-store-snapshot-codec.test.ts 锚定）。

// ── [W1 / D1] v2 条目读面（注册定界 + 终态判定）────────────────

/** loadAll 的 entry 扫描产物（D4 收编定界输入）。 */
interface EntrySources {
  /** v2 注册条目（runId → 注册载荷；journal 权威重建的定界源）。 */
  registered: Map<string, WorkflowRecordRegisteredEntryData>;
  /**
   * 已有 v2 终态条目的 run（runId → 终态载荷，后写覆盖 = last-wins）。双面证据的
   * 条目面（D4）：终态条目幂等补写的抑制判定 + 「journal 无终局帧」实体的先在
   * 终局证据（rebuild 按条目终局重建，见 rebuildRunsFromJournals）。
   */
  settledEntries: Map<string, WorkflowRecordSettledEntryData>;
}

/**
 * v2 条目 → 注册定界 / 终态判定（[W1 / D1] 读面）。载荷按 kind 分流：
 * registered → registered Map（定界 + journalPath 锚点）；settled → settledEntries
 * （终态条目幂等补写判定 + D4 双面证据的条目面）。载荷形状损坏（缺 runId 等半写
 * 形态）warn 留证后跳过（[SO-DATA-2] per-entry 隔离口径：残缺 entry 不得让
 * loadAll 返回空）。
 */
function collectV2RecordEntry(entry: CustomEntry, entryIndex: number, sources: EntrySources): void {
  if (entry.customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return;
  const classification = classifyWorkflowRecordEntryData(entry.data);
  if (classification.ok || classification.reason !== "v2") return;
  const v2 = classification.entry;
  if (v2.kind === "registered") {
    if (typeof v2.runId !== "string" || v2.runId === "" || typeof v2.journalPath !== "string") {
      logger.warn(
        `[subagent-workflow] workflow-record v2 registered entry #${entryIndex} malformed (runId/journalPath missing), skipped`,
      );
      return;
    }
    sources.registered.set(v2.runId, v2);
    return;
  }
  // settled
  if (typeof v2.runId !== "string" || v2.runId === "") {
    logger.warn(
      `[subagent-workflow] workflow-record v2 settled entry #${entryIndex} malformed (runId missing), skipped`,
    );
    return;
  }
  sources.settledEntries.set(v2.runId, v2);
}

/** loadAll 的 entry 扫描：主 session entries → v2 注册定界 + 终态判定（唯一发现
 *  通道）。历史形态 entry（v1 全量快照 / 旧 workflow-state-link 指针）静默忽略——
 *  历史数据仍在盘上，不再重建；未知 entry 的容忍面不受影响。 */
function collectEntrySources(entries: SessionEntry[]): EntrySources {
  const sources: EntrySources = {
    registered: new Map<string, WorkflowRecordRegisteredEntryData>(),
    settledEntries: new Map<string, WorkflowRecordSettledEntryData>(),
  };
  // 索引循环：损坏留证的 warn 需要 entry 索引（SO-DATA-2）
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "custom") continue;
    collectV2RecordEntry(entry, i, sources);
  }
  return sources;
}

/**
 * [W2/V1 D5 签名升级] journal `run-settled` 帧的 (RunOutcome, errorCode) 联合判别
 * → DoneReason：completed/failed 同名直取、cancelled → aborted（与 core
 * doneReasonToRunOutcome 正向映射互逆）；budget_limited/time_limited 恢复同名细分
 * （与帧生产侧 finalRunErrorCodeOf 恒等映射互逆——纯 outcome 反推会把预算/超时
 * 终局静默折叠成 "failed"，通知串与条目 reason 细分丢失，不采用）；interrupted →
 * "failed" 诊断兜底（DoneReason 无 interrupted 成员——显示语义一律走 outcome
 * 四值，折叠仅存 reason 诊断面）。
 *
 * 消费方：v2 journal 重建（reconstructRunFromProjection）/ 终态条目补写
 * （appendSettledEntryFallback）的 reason 派生。单源说明：core 侧同签名函数在
 * worker-message-pump.runSettledOutcomeToDoneReason（core 消费方专用）——双侧
 * 同语义实现（barrel/exports 不在本单元领地，跨包单源合并需 exports 登记后
 * 收口），值表一致性由两侧测试同规格锁定。
 */
/** run-settled 帧形状（从 journal 事件词表提取——errorCode 类型同源，免第二定义点）。 */
type RunSettledFrame = Extract<WorkflowRunEvent, { type: "run-settled" }>;

export function runSettledOutcomeToDoneReason(outcome: RunOutcome, errorCode?: RunSettledFrame["errorCode"]): DoneReason {
  if (outcome === "failed" && (errorCode === "budget_limited" || errorCode === "time_limited")) {
    return errorCode;
  }
  switch (outcome) {
    case "completed":
      return "completed";
    case "cancelled":
      return "aborted";
    case "failed":
    case "interrupted":
      return "failed";
  }
}

/**
 * [W2/V1] 终局记录（journal run-settled 帧载荷的进程内投影——与 core 侧
 * RunSettlementRecord 同构）。reason/errorCode 直取帧载荷；DoneReason 由
 * runSettledOutcomeToDoneReason 联合派生（不在本形状内预计算）。
 */
export interface RunSettlementRecord {
  outcome: RunOutcome;
  errorCode?: RunSettledFrame["errorCode"];
  reason?: string;
  settledAt: number;
}

// ── State file retention (OR-5 ⑥b default-on → [W1 / D5] core 单源收口) ─────
//
// [W1 / D5 清理规则] retention 维护已收口回 core 单源：裁剪资格（fold 终态 +
// 保留窗口，cap 语义废除）、journal 成对裁剪全部在 core 维护轮入口
// runRetentionMaintenanceRound（file-run-store.ts）；interrupted 放弃窗终局化在
// core abandonElapsedInterruptedRuns（run-registry.ts，[W1/D4] 起其终局化走收编
// 入口 adoptInterruptedRun）。本面只保留触发点（新 run 首写的冷路径）；保留窗口
// 的 env 解析同样单源 core（经 barrel 消费）。

// ── JsonlRunStore ────────────────────────────────────────────

const logger = getLogger("subagents");

/**
 * [P3/D6] 事件边沿 flush 的防抖窗口默认值（ms）——物化的唯一去抖窗口（单一触发源
 * 合并后 save 侧无独立 timer）：journal append 经 fs.watch 感知后按本窗口合并触发
 * flush，state 投影（calls[].startedAt/lastProgressAt、health、outcome/errorCode——
 * projectRunEvents fold）在事件落账后 ≤1s 内进入 state 文件（固定窗口合并不
 * 重置 timer；超标上调通道 = 构造参数 eventEdgeDebounceMs）。
 * 模块私有：无外部消费方（测试经构造参数注入小窗口）。
 */
const DEFAULT_EVENT_EDGE_DEBOUNCE_MS = 1000;

/**
 * per-runId pending 批。窗口内 N 次热路径 save 合并为一次物化：latestRun 保留
 * 最新聚合引用（serialize-at-flush），settlers 收集批内全部 save() 调用方的 settle
 * 回调（一次物化时一起兑现）。批自身无 timer——物化由事件边沿驱动（单一触发源），
 * 降级路径（watcher 失效/禁用）下 save 直通 flush，批只在边沿可用时存在。
 */
interface PendingSaveBatch {
  latestRun: WorkflowRun;
  settlers: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
}

interface JsonlRunStoreOptions {
  /** Session directory root (state files live under <sessionDir>/workflow-state/). */
  sessionDir: string;
  /** Pi ExtensionAPI for v2 终态条目补写（loadAll 收编面；optional for testing）。 */
  pi?: ExtensionAPI;
  /** Pi ExtensionContext for sessionManager.getEntries (optional for testing). */
  ctx?: ExtensionContext;
  /**
   * [P3/D6] 事件边沿 flush 防抖窗口（ms），默认 {@link DEFAULT_EVENT_EDGE_DEBOUNCE_MS}。
   * 测试经此注入小窗口（fake timers 推进）。
   */
  eventEdgeDebounceMs?: number;
  /**
   * [P3/D6] 是否开 journal 目录 watcher（fs.watch 边沿感知），默认 true。测试用：
   * 防抖合并的确定性用例经 {@link JsonlRunStore.simulateJournalEdgeForTest} seam 驱动，
   * 关掉真实 watcher 防双源竞争（seam 与真实事件各调度一次——设计内语义）。
   */
  watchJournalEdges?: boolean;
}

/**
 * RunStore port 的 pi 宿主 Infra 实现（session 锚定：事实源 = journal，state 文件
 * 是物化投影）。port 契约类型经 core barrel（RunStore 三方法 save / loadAll /
 * stateFilePath，models/ports.ts）。
 *
 * 本类的五个 interface 面（方法分组索引，便于按消费场景定位）：
 * 1. **port 面**（RunStore 契约）：save / loadAll / stateFilePath——组合根装配
 *    LifecycleDeps.store 的注入面；
 * 2. **adoption 面**（skill-reload 接管）：rebind + resendSnapshots——post-reload
 *    session_start 就地重绑 appendEntry 源并重发 state 投影；
 * 3. **生命周期面**：dispose + flushPendingSaves——shutdown 收尾 / 测试与排查的
 *    主动冲刷；
 * 4. **测试通道**：simulateJournalEdgeForTest——fake timers 下驱动 journal 边沿
 *    调度链（真实 watcher 不可控）；
 * 5. **词表导出**：无（customType / entry schema 版本已收 core
 *    workflow-record-entry.ts 单源，本模块不再导出词表常量）。
 */
export class JsonlRunStore implements RunStore {
  private readonly sessionDir: string;
  /**
   * v2 终态条目补写的 appendEntry 源（loadAll 收编面——journal 已终局而终态条目
   * 缺失时幂等补写）。类型收窄为该面——[skill-reload D3] rebind 时换入
   * stale-guarded 包装（见 {@link rebind}），构造时为裸 pi 原引用。
   */
  private pi?: Pick<ExtensionAPI, "appendEntry">;
  private ctx?: ExtensionContext;
  /** [P3/D6] 事件边沿 flush 防抖窗口（ms）——唯一的去抖窗口（单一触发源）。 */
  private readonly eventEdgeDebounceMs: number;
  /**
   * [P3/D6] 本实例活跃 run 的最新聚合引用（running 态才保留，终局即删）——
   * 事件边沿触发的 flush 需要可序列化的 run 实例，而边沿源（journal append）
   * 不经过 save()。有界性：条目数 = 本实例活跃 run 数，终局即回收。
   */
  private readonly activeRuns = new Map<string, WorkflowRun>();
  /** [P3/D6] per-runId 事件边沿防抖 timer（固定窗口合并，语义对齐 pending 批）。 */
  private readonly pendingEdgeFlushes = new Map<string, NodeJS.Timeout>();
  /**
   * [P3/D6] journal 目录 watcher（事件边沿感知）。惰性开（首次 doFlush 后目录
   * 必存在）；失败一次性降级（watcherBroken = 边沿触发退役，热路径 save 直通
   * flush 承担物化时机——辅助功能降级不拖垮持久化主链）。
   * persistent:false = 不钉住 extension 进程空转（对齐防抖 timer unref 纪律）。
   */
  private journalWatcher: fs.FSWatcher | undefined;
  private journalWatcherBroken = false;
  private readonly watchJournalEdges: boolean;
  /**
   * [W1 / D6] per-runId journal 续读字节偏移（只落在完整行边界；tail 原语维护）。
   * 有界性：条目数 = 本实例 flush 过的 run 数（与 chains Map 同量级）。
   */
  private readonly journalOffsets = new Map<string, number>();
  /**
   * [W1 / D6] per-runId 已读事件累积（增量 fold 的接续态——projectRunEvents 需要
   * 全量事件流重放，增量 chunk 追加进本累积；截断/重建时整体替换）。有界性同上。
   */
  private readonly journalEventsByRun = new Map<string, WorkflowRunEvent[]>();
  /** per-runId pending 批（热路径登记，事件边沿物化时取走兑现）。 */
  private readonly pending = new Map<string, PendingSaveBatch>();
  /** 本实例已至少成功发起过一次 flush 的 runId（冷/热路径判据）。 */
  private readonly writtenOnce = new Set<string>();
  /**
   * per-runId 串行 flush 链。同 runId 的 flush 排队顺序执行（排队不跳过——
   * 跳过会丢最新状态且打破后写覆盖前写的单调性），不同 runId 互不阻塞。
   * 链条目 settle 后不清理：runId 数量有界、生命周期短于 store，惰性清理
   * 与排队写入存在竞态——取舍为每 runId 残留一个 settled Promise 引用，可忽略。
   */
  private readonly chains = new Map<string, Promise<void>>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(opts: JsonlRunStoreOptions) {
    this.sessionDir = opts.sessionDir;
    this.pi = opts.pi;
    this.ctx = opts.ctx;
    this.eventEdgeDebounceMs = Math.max(0, opts.eventEdgeDebounceMs ?? DEFAULT_EVENT_EDGE_DEBOUNCE_MS);
    this.watchJournalEdges = opts.watchJournalEdges ?? true;
  }

  /** State directory: <sessionDir>/workflow-state/（目录分量经 core barrel STATE_DIR_NAME 单源） */
  private get stateDir(): string {
    return path.join(this.sessionDir, STATE_DIR_NAME);
  }

  /** State file path for a given runId. */
  private filePathFor(runId: string): string {
    return path.join(this.stateDir, `${runId}.jsonl`);
  }

  /** Public accessor: run 状态快照文件绝对路径（RunStore port 实现）。 */
  stateFilePath(runId: string): string {
    return this.filePathFor(runId);
  }

  /**
   * [W2/V1 D1 第 8 行] 单一判源函数（壳 store 域的判活/终局判定收拢）：
   * ① 聚合 done（恢复路径写点 run）；
   * ② journal run-settled 帧（v2 活体终局——两态机活体写点删除后聚合 status
   *    停更 running，帧是唯一活体终局证据；读面复用增量 tail 累积缓存，判活
   *    不新增全量 IO）。混合判源读收拢进本函数体（散落分支形态不采用——D1
   *    第 6/8 行同族裁决）。
   */
  private isRunSettled(run: WorkflowRun): boolean {
    if (run.state.status === "done") return true;
    return lastRunSettledEvent(this.readJournalEvents(run.runId)) !== undefined;
  }

  /**
   * [W2/V1] 终局记录查询（journal run-settled 帧投影）：生产消费方 = 通知载荷链
   *（runSettledEffects——载荷源换帧直取，D1 第 7 行）。miss = 无终局帧（未终局，
   * 或 journal 读失败降级——调用方按「不可判定」保守处置，不回退两态机字段兜底）。
   */
  settledRecordOf(runId: string): RunSettlementRecord | undefined {
    const settled = lastRunSettledEvent(this.readJournalEvents(runId));
    if (settled === undefined) return undefined;
    return {
      outcome: settled.outcome,
      ...(settled.errorCode !== undefined ? { errorCode: settled.errorCode } : {}),
      ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
      settledAt: settled.ts,
    };
  }

  /**
   * Persist a single run: rewrite mode (overwrite) — state 文件恒为最新完整投影。
   *
   * 触发源路由（单一触发源：事件边沿为主物化，save 直通只留冷路径）：
   * - 冷路径（本实例首写，或 isRunSettled 终局）→ 立即挂链 flush（不等待边沿——
   *   首写与终态投影及时落盘），回滚资格 = 首写（flush 失败时 doFlush 回滚
   *   writtenOnce，下次 save 重走冷路径）；
   * - 热路径（running 且已写过）→ 边沿可用时只登记 pending 批（物化 = 事件边沿
   *   取批 flush）；降级（watcher 失效/禁用）时直通 flush。
   *
   * Promise 语义：本批实际落盘后 resolve（同批多次调用共享 settle）；IO 错误
   * （非 ENOENT）reject 本批全部调用方；ENOENT 静默 resolve（工作目录已被清理，
   * 持久化无意义也无法完成——见 doFlush）。
   */
  async save(run: WorkflowRun): Promise<void> {
    // R5 处置：dispose 后（session_shutdown 收尾后 in-flight 链的迟到 save）静默
    // no-op + debug 留痕。不复活同步 flush——单向闸门状态机简单；此时 run 是
    // running 落盘无增益（kill-9 恢复同样转 done,failed），终态 reason 保真损失极窄。
    if (this.disposed) {
      logger.debug(
        `[subagent-workflow] jsonl-run-store save after dispose: silently dropped (runId=${run.runId})`,
      );
      return;
    }

    const runId = run.runId;
    // [P3/D6] 活跃 run 引用保留（事件边沿 flush 的实例源）：running 态更新、
    // 终局即删（有界性）。终局引用不保留——终局后的边沿无 flush 意义（投影已终态）。
    // [W2/V1 D1 第 8 行] 终局判据换源 isRunSettled（聚合 done ∨ journal run-settled
    // 帧——两态机活体写点删除后聚合 status 停更，帧是活体终局的唯一证据）。
    // IO 故障保守形态（已接受，四要素登记）：journal 读失败时本判定降级为已累积
    // 事件（无帧 → 判未终局）——activeRuns 条目保留不删（保守不删对齐 D6「误删
    // 活跃 run 是事故方向」纪律：误删使活跃 run 的事件边沿 flush 失去实例源）；
    // 恢复路径 = 进程生命周期结束 activeRuns 全清 + IO 恢复后下一判定点即删；
    // 重审触发 = 活跃引用随 IO 故障持续单调增长可观测时。
    if (this.isRunSettled(run)) {
      this.activeRuns.delete(runId);
    } else {
      this.activeRuns.set(runId, run);
    }
    const isFirstWrite = !this.writtenOnce.has(runId);
    const isCold = isFirstWrite || this.isRunSettled(run);
    if (isCold) {
      // 判定即记录：原子防并发双冷（两次并发首写都判 true 会各 flush 一次）。
      // ENOENT 边界：首写 flush 遇 ENOENT 时 state 未写但 writtenOnce 已记——
      // sessionDir 已删场景持久化无意义，接受（非 ENOENT 失败由 doFlush 回滚，重走冷路径）。
      this.writtenOnce.add(runId);
      // 原子取走 pending 批（终态与最后一个 agent-call 的登记 save 交错时，
      // pending 批 settlers 并入本次同步 flush 的批合并 settle——终局 flush 是
      // 该批的最后物化，链内保序防中间态后写覆盖终态）。
      const batch = this.pending.get(runId);
      if (batch) this.pending.delete(runId);
      return this.enqueueFlush(runId, run, batch ? batch.settlers : [], isFirstWrite);
    }

    // 热路径：running 中间态。单一触发源分流（见类头注触发源拓扑）：边沿可用 →
    // 只登记 pending 批（物化时机 = 事件边沿取批 flush）；降级（watcher 失效/禁用）
    // → save 直通 flush（边沿触发退役后物化时机由 save 自身承担，不丢）。
    const existing = this.pending.get(runId);
    if (existing) {
      // latestRun 更新（serialize-at-flush：批内多次 save 由下一次物化一起落盘）
      existing.latestRun = run;
      return new Promise<void>((resolve, reject) => {
        existing.settlers.push({ resolve, reject });
      });
    }
    const settlers: PendingSaveBatch["settlers"] = [];
    const promise = new Promise<void>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
    if (this.edgeTriggerAvailable) {
      this.pending.set(runId, { latestRun: run, settlers });
    } else {
      // 直通 flush：错误只经 settlers 传播给 save() 调用方（fire-and-forget + catch），
      // 此处 catch 防止 unhandled rejection（enqueueFlush 链尾已吞错）。
      this.enqueueFlush(runId, run, settlers, false).catch(() => {});
    }
    return promise;
  }

  /**
   * 事件边沿触发源是否可用（热路径 save 能否只登记批等边沿物化）。watcher 禁用
   * （watchJournalEdges=false，测试隔离形态）或已失效（watcherBroken 降级）时为
   * false——此时热路径 save 直通 flush 承担物化时机。
   */
  private get edgeTriggerAvailable(): boolean {
    return this.watchJournalEdges && !this.journalWatcherBroken;
  }

  /**
   * 把一次 flush 排到 runId 的串行链尾。调用方 Promise（本函数返回值）与传入
   * settlers 由同一次 doFlush 独占 settle 一次。
   */
  private enqueueFlush(
    runId: string,
    run: WorkflowRun,
    settlers: PendingSaveBatch["settlers"],
    rollbackFirstWrite: boolean,
  ): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
    // 排队不跳过：前一 flush in-flight 时本次挂链尾顺序执行，同 runId 永不并发
    // writeFile（整文件覆盖写并发会互相截断）。链尾吞错防断链——错误只经 settlers 传播。
    const next = (this.chains.get(runId) ?? Promise.resolve())
      .then(() => this.doFlush(runId, run, settlers, rollbackFirstWrite))
      .catch(() => {});
    this.chains.set(runId, next);
    return promise;
  }

  /**
   * 实际落盘（在 runId 串行链上执行）。settlers 由本函数独占 settle 一次：
   * 成功或 ENOENT 全 resolve，其他错误全 reject。
   */
  private async doFlush(
    runId: string,
    run: WorkflowRun,
    settlers: PendingSaveBatch["settlers"],
    rollbackFirstWrite: boolean,
  ): Promise<void> {
    const filePath = this.filePathFor(runId);
    try {
      // 兜底容错：run 工作目录（sessionDir）已被清理时，mkdir 抛 ENOENT，放弃持久化。
      // 竞态场景（review-fix-loop-e2e 等 runAndWait 测试）：handleReturn 活体终局经
      // journal run-settled 帧落账后（两态机活体写点已删——[W2/V1 D1]），runAndWait
      // 轮询按 isRunSettled（聚合 done ∨ journal run-settled 帧）判定终局并 resolve，
      // 测试 afterEach 随即 rmSync 删除 sessionDir；此时 in-flight 的 mkdir
      // 遇到目录链已删除 → ENOENT（{recursive:true} 在并发 rmSync 下仍可抛 ENOENT）。
      // run 既已终态（状态不再变化），持久化无意义也无法完成 → settle resolve。
      // 仅容错 ENOENT，其他错误（EACCES/ENOSPC 等真实磁盘问题）reject 不掩盖。
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      } catch (err) {
        if (isEnoentError(err)) {
          // resolve 语义保持（sessionDir 已删场景持久化无意义也无法完成），但按
          // run 形态分通道留痕：终态投影未落盘是数据损失面（warn 可归因「session
          // 目录被外部删除」）；running 中间态丢一拍等价崩溃语义（debug 即可，
          // 日志携带判定结果供读上下文归因）。[W2/V1] 分通道判据换源 isRunSettled。
          const msg = `state flush skipped, session dir missing (likely externally removed): runId=${runId} settled=${this.isRunSettled(run)}`;
          if (this.isRunSettled(run)) {
            logger.warn(`[subagent-workflow] ${msg} (terminal projection NOT persisted)`);
          } else {
            logger.debug(`[subagent-workflow] ${msg}`);
          }
          for (const s of settlers) s.resolve();
          return;
        }
        throw err;
      }
      // serialize-at-flush：写 flush 时刻的最新聚合状态（latestRun 语义）。
      // [W1 / D2/D6] fold 投影物化：journal 增量 tail 读（只读上次读后新增的完整行，
      // O(N²) 全量 scan 重放环消除）→ projectRunEvents fold → state 覆盖写。journal
      // 读失败/为空 → 降级为未富集投影（辅助增强面，不阻断持久化主链）。主 session
      // 条目只有注册 + 终态两条 v2 小条目（写点在 core lifecycle/finalizeRun 与本
      // store 的 loadAll 幂等补写）；运行态事实源在 journal。
      this.ensureJournalWatcher();
      const journalEvents = this.readJournalEvents(runId);
      const rawSnapshot = toRunSnapshot(run);
      const snapshot = journalEvents.length > 0 ? projectRunEvents(rawSnapshot, journalEvents) : rawSnapshot;
      await fs.promises.writeFile(filePath, JSON.stringify(snapshot) + "\n", "utf8");
      // OR-5 ⑥b 磁盘保留维护（默认开 → [Q2] core 单源收口 + abandon 接线）：新 run
      // state 文件首写成功后触发（rollbackFirstWrite 即 save() 冷路径传入的
      // isFirstWrite——「本实例首次写该 runId」≈ 新文件落盘时刻，每个新 run 进场
      // 做一轮维护）。维护内部吞错不抛，在串行链上 await：save 返回即维护已定。
      if (rollbackFirstWrite) {
        await this.runRetentionSweep();
      }
      for (const s of settlers) s.resolve();
    } catch (err) {
      // ES9 失败回滚（意义 = 下次 save 重走冷路径立即重试）。残余窗口（已知接受）：
      // 回滚后若再无任何 save（随即崩溃/退出），state 投影缺失——等价崩溃丢失，
      // 由 kill-9 恢复兜底（恢复链读 journal 权威，不依赖 state 投影）。
      if (rollbackFirstWrite) {
        this.writtenOnce.delete(runId);
      }
      if (settlers.length === 0) {
        // 边沿触发路径（事件边沿 flush / resendSnapshots 以空 settlers 入链）：
        // 错误无 save() 调用方可 reject，enqueueFlush 链尾吞——此处 warn 留证防
        // 静默丢失。settlers 非空时错误经 reject 传播，不重复留痕。
        logger.warn(
          `[subagent-workflow] state flush failed on caller-less flush (edge-triggered/resend, error otherwise swallowed): runId=${runId}: ${toErrorMessage(err)}`,
        );
      }
      for (const s of settlers) s.reject(err);
    }
  }

  // ── [P3/D6] 事件边沿 flush（journal watcher + 防抖合并）──────────

  /**
   * journal 事件读取（[W1 / D6] 增量 tail 读 + 累积）：readJournalTail 从上次完整行
   * 边界续读新增行，追加进 per-runId 累积；截断/重建（truncated）或冷启动（首读）
   * 整体替换累积（幂等——重读不产生重复应用）。坏行跳过 + 计数（宽容语义与 tail
   * 契约一致，不卡游标）；IO 异常降级为已累积事件（flush 主链不因增强面中断）。
   */
  private readJournalEvents(runId: string): readonly WorkflowRunEvent[] {
    const journalPath = path.join(this.stateDir, `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
    const offset = this.journalOffsets.get(runId) ?? 0;
    let chunk;
    try {
      chunk = readJournalTail(journalPath, offset, parseRunEventLine);
    } catch (err) {
      logger.warn(
        `[subagent-workflow] journal tail read failed, projection continues with accumulated events (runId=${runId}): ${toErrorMessage(err)}`,
      );
      return this.journalEventsByRun.get(runId) ?? [];
    }
    const accumulated = this.journalEventsByRun.get(runId);
    if (offset === 0 || chunk.truncated || accumulated === undefined) {
      this.journalEventsByRun.set(runId, [...chunk.events]);
    } else if (chunk.events.length > 0) {
      accumulated.push(...chunk.events);
    }
    this.journalOffsets.set(runId, chunk.nextOffset);
    if (chunk.skippedLines > 0) {
      logger.warn(
        `[subagent-workflow] journal tail skipped ${chunk.skippedLines} bad line(s) (runId=${runId})`,
      );
    }
    return this.journalEventsByRun.get(runId) ?? [];
  }

  /** 惰性开 journal 目录 watcher（首次 doFlush 后目录必存在）；失败一次性降级。
   *  disposed 后不开（in-flight 链的迟到 flush 不复活 watcher——dispose 已收尾关闭）。 */
  private ensureJournalWatcher(): void {
    if (!this.watchJournalEdges || this.disposed || this.journalWatcher || this.journalWatcherBroken) return;
    try {
      this.journalWatcher = fs.watch(this.stateDir, { persistent: false }, (_event, filename) => {
        this.onJournalDirEvent(typeof filename === "string" ? filename : undefined);
      });
      this.journalWatcher.on("error", (err: unknown) => {
        // 平台差异/目录被删等 watcher 级错误：降级退役（边沿触发 → save 直通）
        this.degradeJournalWatcher(err, "error");
      });
    } catch (err) {
      this.degradeJournalWatcher(err, "unavailable");
    }
  }

  /**
   * watcher 一次性降级（单向：边沿触发退役后不复活）。降级补偿：置位瞬间已登记的
   * pending 批全部直通 flush——这批 save 登记时边沿尚可用（只登记未物化），置位后
   * 边沿事件源已死，不补偿则批内 settlers 悬挂到 dispose（物化时机丢失）。之后的
   * 热路径 save 经 edgeTriggerAvailable 判定直通，不再产生新批。
   */
  private degradeJournalWatcher(err: unknown, variant: "error" | "unavailable"): void {
    this.journalWatcherBroken = true;
    this.closeJournalWatcher();
    logger.debug(
      `[subagent-workflow] journal watcher ${variant}, event-edge flush degraded: ${toErrorMessage(err)}`,
    );
    // dispose 收尾后无补偿面（批已被 doDispose 的 flushPendingSaves 取走，不再挂新链）
    if (this.disposed) return;
    for (const [runId, batch] of Array.from(this.pending.entries())) {
      this.pending.delete(runId);
      // 链尾吞错 + catch：错误只经 settlers 传播（同 timer 时代回调的孤儿防 unhandled 形态）
      this.enqueueFlush(runId, batch.latestRun, batch.settlers, false).catch(() => {});
    }
  }

  /**
   * watcher 回调：只认 journal 文件边沿（`.events.jsonl` 后缀——自身 `.jsonl`
   * 覆写、manifest `.json` 结构性排除，防自触发回环）。filename 缺失形态（部分
   * 平台 null）保守对全部活跃 run 调度——防抖窗口合并，误调度代价 = 一次幂等 flush。
   */
  private onJournalDirEvent(filename: string | undefined): void {
    if (this.disposed) return;
    if (filename === undefined) {
      for (const runId of this.activeRuns.keys()) this.scheduleEventEdgeFlush(runId);
      return;
    }
    if (!filename.endsWith(RUN_EVENT_JOURNAL_SUFFIX)) return;
    const runId = filename.slice(0, -RUN_EVENT_JOURNAL_SUFFIX.length);
    if (!this.activeRuns.has(runId)) return; // 非本实例活跃 run（终局/跨实例）不触发
    this.scheduleEventEdgeFlush(runId);
  }

  /**
   * per-runId 固定窗口防抖调度（不重置 timer——事件突发只落 1 次 flush，
   * 延迟有界 ≤eventEdgeDebounceMs）。触发时原子取走 pending 批（若有——批合并
   * settle：一次物化兑现批内全部 save 调用方），以批/活跃 run 引用走既有串行链
   * flush（空 settlers 时调用方无人 await，孤儿错误链尾吞）。
   * [W2/V1 D1 第 8 行] 无批形态的活跃判定换源 isRunSettled（原两态机 status
   * recheck 随活体写点删除停更——终局后 activeRuns 已删，此处注册表级守卫防
   * 残留边沿对已终局 run 再 flush）。
   */
  private scheduleEventEdgeFlush(runId: string): void {
    if (this.pendingEdgeFlushes.has(runId)) return;
    const timer = setTimeout(() => {
      this.pendingEdgeFlushes.delete(runId);
      if (this.disposed) return;
      // 批合并 settle：原子取走 pending 批（取批即交由本回调负责物化，防二次兑现）
      const batch = this.pending.get(runId);
      if (batch) this.pending.delete(runId);
      const run = batch ? batch.latestRun : this.activeRuns.get(runId);
      if (!run) return;
      // 终局拦截只作用于无批形态（activeRuns 已回收/已终局 run 的残留边沿不 flush
      // ——投影已终态，无 flush 意义）。有批形态不拦截：批内 settlers 必须由本次
      // 物化兑现（拦截即悬挂）；批建立时 run 是 running 态，flush 时刻 journal 已有
      // 终局帧则落终态投影合法，后续终局 save 的冷路径 flush 在串行链内保序收敛。
      if (!batch && this.isRunSettled(run)) return;
      this.enqueueFlush(runId, run, batch ? batch.settlers : [], false).catch(() => {});
    }, this.eventEdgeDebounceMs);
    timer.unref();
    this.pendingEdgeFlushes.set(runId, timer);
  }

  private closeJournalWatcher(): void {
    this.journalWatcher?.close();
    this.journalWatcher = undefined;
  }

  /**
   * [测试通道] journal 边沿模拟：与 watcher 回调同一入口（onJournalDirEvent）——
   * fake timers 下 fs.watch 的真实事件不受时钟控制，确定性测试经此 seam 驱动
   * 同一调度链；真实 watcher 接线另有 real-timers 集成用例覆盖。
   */
  simulateJournalEdgeForTest(runId: string): void {
    this.onJournalDirEvent(`${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
  }

  /**
   * [W1 / D5 清理规则] 新 run 进场的 retention 维护轮（两步，core 单源消费）：
   * 1. abandonElapsedInterruptedRuns——interrupted 超放弃窗终局化（收编入口幂等追加
   *    终态事件 + 物化 manifest，无悬挂态；活跃保护集 = 本实例 activeRuns）；
   * 2. runRetentionMaintenanceRound——统一保留维护轮（fold 终态 + 保留窗口；本触发
   *    点只传 run 域目录锚 stateDir——record 域由 record 首写 / session_start 兜底
   *    触发点覆盖，见 RetentionMaintenanceInput 的可选域说明）。
   *
   * 全程吞错不抛（辅助维护降级不拖垮 save 主链——core 单源内部各自降级，本方法
   * 再兜一层防接线面意外）；在冷路径串行链上 await：save 返回即维护已定。
   */
  private async runRetentionSweep(): Promise<void> {
    const stateDir = this.stateDir;
    const activeRunIds = new Set(this.activeRuns.keys());
    try {
      await abandonElapsedInterruptedRuns(stateDir, { activeRunIds });
    } catch (err) {
      logger.warn(
        `[subagent-workflow] state retention: interrupted-abandon sweep failed: ${toErrorMessage(err)}`,
      );
    }
    try {
      await runRetentionMaintenanceRound(
        { stateDir },
        {},
        {
          warn: (msg) => logger.warn(`[subagent-workflow] ${msg}`),
          debug: (msg) => logger.debug(`[subagent-workflow] ${msg}`),
          toMsg: (err: unknown) => toErrorMessage(err),
        },
      );
    } catch (err) {
      logger.warn(
        `[subagent-workflow] state retention: maintenance round failed: ${toErrorMessage(err)}`,
      );
    }
  }

  /**
   * 立即刷全部 pending 批（测试与排查的备用手段）。自身恒 resolve——IO 错误
   * 已由各 save() Promise 的 settlers 传播给调用方。store 保持可用：不动 disposed
   * 标志，后续 save 正常按触发源路由（边沿可用登记新批 / 降级直通）。
   */
  async flushPendingSaves(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const [runId, batch] of Array.from(this.pending.entries())) {
      this.pending.delete(runId);
      flushes.push(this.enqueueFlush(runId, batch.latestRun, batch.settlers, false));
    }
    await Promise.allSettled(flushes);
  }

  /**
   * 收尾：刷全部 pending 批 + 停 timer + await 全部 in-flight 链（in-flight flush
   * 完成后才返回），此后 save 静默 no-op。
   *
   * 幂等：dispose 缓存自身 Promise——首次未完成时并发交叠进入的后续调用返回
   * 同一 Promise（「dispose 返回 = 全部 flush 已落盘」对每个调用方都成立，
   * 无第二次拿到立即 resolve 的空 Promise 瑕疵）。故本方法不能是 async 函数
   * （async 总是创建新 Promise 破坏同一引用保证）。
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    // 同步置位：阻断新 save 进入去抖/冷路径（R5 no-op 分支接住 shutdown 后
    // in-flight 链的迟到 save）。置位必须先于 flushPendingSaves——async 函数体
    // 在调用时同步执行到第一个 await，批收集发生在置位后的同一同步段，时序与
    // 折叠前的内联收集逐分支等值。
    this.disposed = true;
    // [P3/D6] 事件边沿面收尾：清边沿防抖 timer（挂起的边沿 flush 由下方 flushPendingSaves
    // 的终批覆盖语义兜住）+ 关 watcher（persistent:false 本不钉进程，主动关 = 纪律收尾）。
    for (const timer of this.pendingEdgeFlushes.values()) clearTimeout(timer);
    this.pendingEdgeFlushes.clear();
    this.closeJournalWatcher();
    // 复用 flushPendingSaves（批收集循环与 await allSettled 与折叠前内联实现逐行等价；
    // flushPendingSaves 自身不动 disposed——dispose 语义仍由本方法的置位与缓存 Promise 承担）
    await this.flushPendingSaves();
    // await 全部 in-flight 链（ES4：flush 全部落定后才返回）
    await Promise.allSettled(Array.from(this.chains.values()));
  }

  /**
   * [skill-reload D3] adoption 就地重绑：post-reload session_start 接管（adoption）时
   * 原地改写 appendEntry 源与 ctx——store 实例跨 reload 存活（D2 槽），在飞去抖批与
   * per-runId 串行 flush 链持有 this，原地改写对后续 flush 天然可见。[W1] 换入的
   * appendEntry 源的消费方 = loadAll 的 v2 终态条目幂等补写（收编/调和面）；stale
   * guard 语义不变（窗口内 appendEntry 统一 debug 丢弃——条目是投影锚，缺失由下次
   * loadAll 幂等补写自愈）。
   */
  rebind(pi: ExtensionAPI, ctx: ExtensionContext): void {
    this.pi = {
      appendEntry: (customType: string, data?: unknown) => {
        guardStaleCtx(() => pi.appendEntry(customType, data), {
          label: "subagent-workflow:jsonl-run-store.appendEntry",
          // 「统一 stale → debug 丢弃」：窗口内丢弃是设计内降级，debug 留痕可归因
          onStale: (error) =>
            logger.debug(
              "[subagent-workflow] workflow-record entry append skipped (stale ctx)",
              { reason: toErrorMessage(error) },
            ),
        });
      },
    };
    this.ctx = ctx;
  }

  /**
   * [skill-reload D4] adoption 投影重发：把 runs 内全部 run 的当前投影经 per-runId
   * 串行 flush 链（enqueueFlush → doFlush）重发落 state 文件。
   *
   * 重发对象 = state 物化投影（可删可重建）；运行态权威在 journal（跨 reload 同
   * 进程存活，journal 随进程持续追加——adoption 不需要也不应该重写 journal）。
   * 设计红线保留：必须经本链而非绕链写盘——doFlush 的 await writeFile 之间存在
   * 事件循环间隙，绕链直接写会与 in-flight 中间态 flush 物理乱序（终态在前中间态在后）。
   *
   * rollbackFirstWrite=false：重发不是新文件首写（不触发磁盘保留裁剪）；失败不
   * 回滚 writtenOnce——重发失败向上抛，由 adoption 失败处置整体兜底（G3 可见）。
   */
  async resendSnapshots(runs: Map<string, WorkflowRun>): Promise<void> {
    for (const run of runs.values()) {
      // 串行 await：adoption 是一次性路径，跨 runId 顺序无语义，但全部重发完成
      //（或首个失败上抛）后才返回，调用方据此判定接管完成。
      await this.enqueueFlush(run.runId, run, [], false);
    }
  }

  /**
   * Reconstruct all runs（[W1 / D4] journal 权威 + 收编定界）。
   *
   * **v2 注册条目定界**：注册条目给出本会话的实体集与 journalPath 锚点 → 逐实体
   * journal 全量读 → 投影重建（终局 ⟸ run-settled 投影；非终局保持 running 交恢复
   * 链收编）；已终局且终态条目缺失 → 幂等补写（D4 收编序列的条目半边；经 rebind
   * 后的 appendEntry 面，stale guard 内置）。
   *
   * [已知限制·登记] 恢复域 = 本 session 的 entry 集 + 其 journalPath 锚点：崩溃后
   * 用户不再 resume 原 session（同 cwd 开新 session 继续）时，原 session 的遗留 run
   * 对新 session 的 loadAll/恢复链不可见——无 failed 记录、无 UI 痕迹，仅磁盘层兜底
   * （journal 7 天 abandon 收编写 manifest）。跨 session 收编需要引入跨 session 写入
   * 语义，与 W17 session 锚定设计相悖，收益面有限，故登记不改。
   *
   * 需要 ctx（构造时注入）——无 ctx 时返回空（测试或非 Pi 环境下）。
   */
  async loadAll(): Promise<WorkflowRun[]> {
    if (!this.ctx) return [];
    const runs: WorkflowRun[] = [];
    try {
      const entries = this.ctx.sessionManager.getEntries();
      const { registered, settledEntries } = collectEntrySources(entries);
      runs.push(...this.rebuildRunsFromJournals(registered, settledEntries));
    } catch (err) {
      // getEntries failed — 返回已收集结果（空集降级语义保持），但必须 error 留痕：
      // 静默空集会把 session 文件读故障伪装成「无 run 历史」，恢复无从下手。
      logger.error(
        `[subagent-workflow] loadAll: getEntries failed, returning empty run set (degraded). Recovery: check session file readability: ${toErrorMessage(err)}`,
      );
    }
    return runs;
  }

  // ── [W1 / D4] v2 实体的 journal 权威重建 ──────────────────────

  /**
   * 逐注册条目重建 run：journal 全量读（readJournalTail 冷启动形态）→ 事件流投影
   * 重建（projectRunEvents 对 degraded running 基线做富集）→ 终局判定。
   *
   * 终局判定与状态重建（D4 双面证据：journal 终态帧 ∧ 主 session 终态条目）：
   * - 投影 outcome 有值 ⟺ fold 命中 run-settled ⟺ 终局（等价于状态机 fold 的
   *   terminal 判定——run-settled 是唯一终局转移的 journal 帧）。终局 run 用
   *   reconstruct 直接构造 done 聚合（reason 从 outcome 映射、error 取帧 reason、
   *   completedAt 取帧 ts），并幂等补写终态条目（终态条目缺失时）。
   * - journal 无终局帧但终态条目已在（终局帧损坏 / 全损而条目完好）：按条目终局
   *   重建 done——条目即先在终局证据，**不交恢复链**（交恢复链会追加
   *   run-settled(failed) 收编帧与第二条 settled(failed) 条目，与既有 done 条目
   *   构成 D4 明文要防的两记录面矛盾）。
   * - 非终局且终态条目缺（含 journal 只有 run-created 首帧的早崩形态 / journal
   *   空·缺·全损）→ running 聚合交恢复链收编（recoverCrashedRuns 经收编链追加
   *   run-settled 后，下次 loadAll 自然读到终局；journal 空流的 run-settled 追加
   *   会撞 created × run-settled 表外转移，由恢复链围栏降级 state 快照面收编）。
   * - journal 空/缺/全损但终态条目已在：warn 跳过不重建——条目已是终局证据，
   *   该 run 的呈现面归条目读者（runtime 投影 / session-reader），壳 runs 集合
   *   不回收窗外实体（足迹已裁剪的终态 run 灌回内存会被 cap 淘汰反复震荡）。
   *
   * 投影载荷边界（登记）：journal 不携带 call 级结果/sessionFile（args 只进截断
   * 摘要）——v2 重建的 run 聚合是恢复语义的最小形态（spec.scriptSource 空、calls 空、
   * usedTokens 0）。步骤级详情的恢复读面 = journalPath 锚点直读（session-reader
   * 家族链 / runtime 投影），不经本聚合。
   */
  private rebuildRunsFromJournals(
    registered: Map<string, WorkflowRecordRegisteredEntryData>,
    settledEntries: Map<string, WorkflowRecordSettledEntryData>,
  ): WorkflowRun[] {
    const runs: WorkflowRun[] = [];
    for (const [runId, reg] of registered) {
      const journalPath = reg.journalPath;
      let chunk;
      try {
        chunk = readJournalTail(journalPath, 0, parseRunEventLine);
      } catch (err) {
        logger.warn(
          `[subagent-workflow] v2 rebuild: journal read failed, run skipped (runId=${runId}, journal=${journalPath}): ${toErrorMessage(err)}`,
        );
        continue;
      }
      if (chunk.skippedLines > 0) {
        // 坏行宽容（D4 收编判据的 tail 坏行语义）：跳过 + 计日志，不炸重建
        logger.warn(
          `[subagent-workflow] v2 rebuild: skipped ${chunk.skippedLines} bad journal line(s) (runId=${runId})`,
        );
      }
      if (chunk.events.length === 0) {
        // journal 空/缺/全损（readJournalTail 对 ENOENT 亦产空流）。终态条目在 =
        // 先在终局证据（双面证据条目面）→ 跳过不重建；终态条目缺 = 「有注册、无
        // 终态」的崩溃形态 → degraded running 基线交恢复链按中断收编（设计 §3.1
        // 失败路径样例「全文件不可解析 → 该 run 按中断收编」——静默跳过会让该
        // 实体对恢复链/abandon 扫描全部不可见）。
        if (settledEntries.has(runId)) {
          logger.warn(
            `[subagent-workflow] v2 rebuild: journal empty or missing but settled entry present, run skipped (runId=${runId}, journal=${journalPath})`,
          );
          continue;
        }
        logger.warn(
          `[subagent-workflow] v2 rebuild: journal empty or missing and no settled entry, degraded rebuild for interruption adoption (runId=${runId}, journal=${journalPath})`,
        );
        runs.push(this.reconstructRunFromProjection(runId, reg, chunk.events, undefined));
        continue;
      }
      const events = chunk.events;
      const settledEvent = lastRunSettledEvent(events);
      // [W1 / D4] 双面证据的条目面：journal 无可解析终局帧而终态条目已在 → 按
      // 条目终局重建 done，不交恢复链（防两记录面矛盾，见方法注释）。
      if (settledEvent === undefined && settledEntries.has(runId)) {
        logger.warn(
          `[subagent-workflow] v2 rebuild: journal has no parseable run-settled but settled entry present, rebuilt from settled entry (runId=${runId})`,
        );
        runs.push(this.reconstructRunFromSettledEntry(runId, reg, settledEntries.get(runId)!));
        continue;
      }
      const run = this.reconstructRunFromProjection(runId, reg, events, settledEvent);
      runs.push(run);
      // [W1 / D4] 终态条目幂等补写：journal 已终局而主 session 终态条目缺失
      //（终局 coda 的条目半边写失败 / 旧版本写点形态）→ 补写；条目已在 → 跳过
      //（双重启不重复追加的构造性保证——补写只在 loadAll 收编面发生且被 settledEntries
      // 拦截）。无 pi（测试/非 Pi 环境）跳过。
      if (settledEvent !== undefined && !settledEntries.has(runId)) {
        this.appendSettledEntryFallback(runId, settledEvent, events);
      }
    }
    return runs;
  }

  /**
   * 投影重建聚合根：degraded running 基线（注册条目身份 + spec 最小形态）+ 事件流
   * projectRunEvents 富集 → 终局/非终局两形态的 WorkflowRun。聚合不走 save（只读
   * 恢复面）；running 形态交恢复链收编。
   */
  private reconstructRunFromProjection(
    runId: string,
    reg: WorkflowRecordRegisteredEntryData,
    events: readonly WorkflowRunEvent[],
    settledEvent: Extract<WorkflowRunEvent, { type: "run-settled" }> | undefined,
  ): WorkflowRun {
    const startedAtIso = Number.isFinite(reg.startedAt)
      ? new Date(reg.startedAt).toISOString()
      : new Date().toISOString();
    // 恢复语义最小 spec（载荷边界见 rebuildRunsFromJournals 注）
    const spec = {
      scriptSource: "",
      args: {},
      scriptName: reg.scriptName,
      scriptPath: "",
      ...(reg.slug !== undefined ? { slug: reg.slug } : {}),
    };
    if (settledEvent === undefined) {
      return WorkflowRun.reconstruct(
        runId,
        spec,
        {
          status: "running",
          budget: new Budget(),
          calls: new Map(),
          trace: new Trace(),
          errorLogs: [],
        },
        { startedAt: startedAtIso },
      );
    }
    const reason = runSettledOutcomeToDoneReason(settledEvent.outcome, settledEvent.errorCode);
    return WorkflowRun.reconstruct(
      runId,
      spec,
      {
        status: "done",
        reason,
        budget: new Budget(),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
        // 成功终局无 error；失败终局带帧 reason 文本（不落 generic 恢复文案）
        ...(reason !== "completed" && settledEvent.reason !== undefined ? { error: settledEvent.reason } : {}),
      },
      {
        startedAt: startedAtIso,
        completedAt: new Date(settledEvent.ts).toISOString(),
      },
    );
  }

  /**
   * 按终态条目重建 done 聚合（D4 双面证据的条目面分支）：journal 终局帧不可解析
   * 而终态条目已在时，条目是唯一可用终局证据——reason 直取条目 DoneReason、
   * completedAt 取条目 settledAt。error 文本不构造（条目契约只携结构化 errorCode，
   * 无错误文本载荷——不落 generic 恢复文案，与帧分支同一纪律）。spec 基线与
   * {@link reconstructRunFromProjection} 同构（恢复语义最小形态）。
   */
  private reconstructRunFromSettledEntry(
    runId: string,
    reg: WorkflowRecordRegisteredEntryData,
    settled: WorkflowRecordSettledEntryData,
  ): WorkflowRun {
    const startedAtIso = Number.isFinite(reg.startedAt)
      ? new Date(reg.startedAt).toISOString()
      : new Date().toISOString();
    const spec = {
      scriptSource: "",
      args: {},
      scriptName: reg.scriptName,
      scriptPath: "",
      ...(reg.slug !== undefined ? { slug: reg.slug } : {}),
    };
    return WorkflowRun.reconstruct(
      runId,
      spec,
      {
        status: "done",
        reason: settled.reason,
        budget: new Budget(),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      {
        startedAt: startedAtIso,
        completedAt: new Date(settled.settledAt).toISOString(),
      },
    );
  }

  /**
   * 终态条目幂等补写（v2 收编面）：载荷经 core barrel 的 buildWorkflowRecordSettledEntryData
   * 构造器单源复用（[W1 / D1] 防字段集手抄漂移——壳写点与 core finalizeRun 写点同一
   * 构造；字段源 = journal run-settled 帧 + ask 计数投影）。best-effort：appendEntry
   * 失败留痕不阻断 loadAll（条目是投影锚，下次 loadAll 幂等重试）。
   */
  private appendSettledEntryFallback(
    runId: string,
    settledEvent: Extract<WorkflowRunEvent, { type: "run-settled" }>,
    events: readonly WorkflowRunEvent[],
  ): void {
    if (!this.pi) return;
    const data = buildWorkflowRecordSettledEntryData({
      runId,
      reason: runSettledOutcomeToDoneReason(settledEvent.outcome, settledEvent.errorCode),
      outcome: settledEvent.outcome,
      ...(settledEvent.errorCode !== undefined ? { errorCode: settledEvent.errorCode } : {}),
      settledAt: settledEvent.ts,
      callCount: events.filter((e) => e.type === "ask-settled").length,
      usedTokens: 0,
    });
    try {
      this.pi.appendEntry(WORKFLOW_RECORD_CUSTOM_TYPE, data);
    } catch (err) {
      logger.warn(
        `[subagent-workflow] v2 settled entry backfill failed (runId=${runId}): ${toErrorMessage(err)}`,
      );
    }
  }
}

// ── 模块级辅助（journal 行解析与事件取帧） ────────────────────

/** 事件信封守卫（taste/no-unsafe-cast：结构断言改类型守卫——type/ts 可用性在守卫内收窄）。 */
function hasEventEnvelope(v: object): v is { type: string; ts: number } {
  const rec = v as Record<string, unknown>;
  return typeof rec["type"] === "string" && rec["type"] !== "" && typeof rec["ts"] === "number" && Number.isFinite(rec["ts"]);
}

/**
 * journal 行解析器（journal-tail 原语的域注入形态）：合法事件行返回事件对象；
 * 坏行（JSON 解析失败 / 非对象 / 缺 type / 缺 ts 信封）返回 undefined——tail 侧
 * 跳过 + 计数。形状校验取最小公共面（type 字符串 + ts 有限数值——EventEnvelope
 * 信封全词表必填；其余载荷字段由消费方投影自行容错）。
 */
function parseRunEventLine(line: string): WorkflowRunEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !hasEventEnvelope(parsed)) return undefined;
  return parsed as WorkflowRunEvent;
}

/** 事件流尾向扫描取最后一帧 run-settled（单终局不变量下的防御性读取）。 */
function lastRunSettledEvent(
  events: readonly WorkflowRunEvent[],
): Extract<WorkflowRunEvent, { type: "run-settled" }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "run-settled") return ev;
  }
  return undefined;
}

/**
 * Workflow Extension — JSONL Run Store
 *
 * RunStore port 的 Infra 实现。
 *
 * 职责：持久化 WorkflowRun 聚合根到 JSONL 文件 + 跨 session 重水合。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 RunStore port。
 * 依赖 @earendil-works/pi-coding-agent 的 ExtensionAPI/ExtensionContext（Infra 允许 Pi SDK）。
 *
 * 设计：
 * - JsonlRunStore implements RunStore（而非散落的 persist/reconstruct 自由函数）。
 * - **D-5: 不向后兼容**——reconstruct 时检查 snapshotVersion，无版本号或版本不匹配
 *   的 session 返回空数组（spec 决策：旧 run 历史价值低，不尝试兼容迁移）。
 * - rewrite mode（writeFile 覆盖，文件始终是最新单行快照）。
 * - **W17 [D4] workflow-record 自描述 entry**：每次成功 flush 同步 append 一条完整
 *   快照 entry（pi.appendEntry）——pi 文件（session JSONL）是 workflow 数据持久化
 *   权威，state 文件降级为纯性能缓存（读序 = entry > state 文件 > 空，写路径保留）。
 *   旧 `workflow-state-link` 指针 entry 退役（loadAll 保留兼容读，存量 run 不丢）。
 *   [B-1/OR-5 同源] entry append 按 runId 节流（见 save 注释「entry append 节流」），
 *   pi session JSONL 是 append-only 文件，节流前每次 flush 全量 append 会随 run
 *   时长累积出单 run O(n²) 磁盘占用。
 *
 * save 去抖语义（cw swf-perf wave2）：
 * - **热路径**（running 中间态，本实例已写过）：per-runId pending 批合并——窗口内
 *   N 次 save 只落盘 1 次（serialize-at-flush：写 flush 时刻最新聚合状态）。
 *   固定窗口不重置 timer（批创建时定时一次），保证 flush 延迟有界 ≤saveDebounceMs；
 *   agent-call 间隔秒级下 trailing 重置无合并增益反可无限推迟。
 * - **冷路径**（本实例对该 runId 首写，或 status !== "running" 即 done）：
 *   同步挂链 flush 绕过 timer——首写立即可见（跨 session 重启后 loadAll 从 entry
 *   发现 run）、done 立即落盘（终态优先持久化：transition("done") 后的 save
 *   不进去抖批，去抖窗口内的崩溃不吞终态）。
 * - workflow-record entry append 节流（[B-1]，语义对齐 core FileRunStore.save
 *   的 OR-5 ⑥a 节流，间隔常量单源复用 core DEFAULT_SAVE_MIN_INTERVAL_MS）：
 *   running 中间态的 entry append 有最小间隔（缺省 60s；0 = 禁用），终态 flush
 *   的 entry 永不节流（最终状态必进 pi 权威文件，loadAll/恢复不丢终态）；
 *   state 文件 writeFile 不节流（rewrite mode 覆盖写，无累积）。节流窗口内的
 *   entry 跳过 = pi 文件最后一条 entry 最多落后真实状态一个窗口，崩溃语义与
 *   未落盘 running 尾部丢失同源（kill-9 恢复收编）。
 * - per-runId 串行 flush 链：同 runId 的 flush 排队顺序执行（不跳过、永不并发
 *   writeFile），链尾吞错防断链——错误只经各 save() Promise 的 settlers 传播。
 * - dispose()：幂等（缓存自身 Promise）；刷全部 pending 批 + await 全部 in-flight
 *   链后返回。dispose 后 save 静默 no-op + debug 日志（session_shutdown 编排收尾）。
 *
 * 序列化策略（下沉收口 D4 后）：
 * - 快照投影/重水合/版本 guard 全部消费 core run-snapshot codec（toRunSnapshot/
 *   fromRunSnapshot）——字段演进单点（G2）；本 store 只保留 IO 策略（rewrite/
 *   去抖/append，D4 裁决：IO 差异归属宿主 store 层）。
 * - 版本值沿用 core SNAPSHOT_VERSION "wf-run-v2"（D4 裁决①：pi 存量逐字节可读）。
 * - pi 侧版本不匹配静默跳过语义保持（D-5）；「缺 v 宽容」是 core FileRunStore
 *   侧的存量预处理职责，不内聚进 codec（D4 裁决②），故本侧零改动即保持。
 *
 * [S3 查证结论] pi 0.84.4 实装（node_modules/@earendil-works/pi-coding-agent/dist，
 * core/session-manager.js，PS-19）的 session 生命周期管理不含自动 GC：
 * listSessionsFromDir 只做只读扫描（readdir + `.jsonl` 过滤 + header 解析，:548-571，
 * 非递归——`<sessionDir>/workflow-state/` 子目录完全不在 pi 的任何扫描/清理范围内），
 * SessionManager.list / listAll 只是它之上的 cwd 过滤/排序封装（:1281-1287 / :1289），
 * 无按 age/数量的 retention/prune/expire 删除逻辑；唯一删除路径是 TUI SessionSelector
 * 里用户手动删除选中的单个顶层 session 文件（trash CLI → unlink fallback，
 * dist/modes/interactive/components/session-selector.js:539-550），非自动、
 * 不递归子目录。**推论：workflow-state state 文件无限累积，
 * 保留策略由本包自担**——磁盘侧保留默认开（OR-5 ⑥b）：每次新 run state 文件首写
 * 成功即按 mtime 裁剪到上限（未设 {@link STATE_MAX_RUNS_ENV} 时取
 * {@link DEFAULT_STATE_MAX_RUNS} 默认值，见 pruneStateFilesBeyondCap；显式非法值
 * 是 opt-out 通道）；内存侧由 evictDoneRunsBeyondCap 淘汰。W17 后 state 文件
 * 已降级为纯性能缓存（权威数据在 session JSONL 的 workflow-record entry），随 session
 * 文件被用户删除时一并消失。
 *
 * 参考：domain-models.md §Ports（RunStore 定义）、clarification.md D-5。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
// DEFAULT_SAVE_MIN_INTERVAL_MS / DEFAULT_STATE_MAX_RUNS 保留深路径：core barrel
// 刻意不导出（exports 面即 semver 契约，见 subagent-core src/index.ts 头注），壳侧
// barrel 消费（DEFAULT_* 已进 core barrel——u-2c 删 ./* 通配后深路径 tsc 不可解析）
import {
  DEFAULT_SAVE_MIN_INTERVAL_MS,
  DEFAULT_STATE_MAX_RUNS,
} from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/subagent-core";

import { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  SNAPSHOT_VERSION,
  fromRunSnapshot,
  toRunSnapshot,
  pruneStateFilesBeyondCap,
  type RunSnapshot,
} from "@zhushanwen/subagent-core";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ── Workflow-record self-describing entry (W17, D4) ─────────

/**
 * 自描述 workflow record entry 的 customType（W17 [D4]）。命名对齐 W16 的
 * `subagent-record`（连字符风格）。写点字面量与本常量的等值由
 * __tests__/jsonl-run-store-session-file.test.ts 断言钉住（消费方引用本常量，勿用裸字符串）。
 */
export const WORKFLOW_RECORD_CUSTOM_TYPE = "workflow-record";

/**
 * `workflow-record` entry 的 data schema（v1）。
 *
 * = 完整 RunSnapshot 快照（runId/status/calls/trace 等全部重建需要的字段）+ 版本号。
 * 读取方无需逆向解析 state 文件或指针（D4 自描述原则）；snapshot 内部自带 D-5
 * snapshotVersion guard（fromRunSnapshot 检查），entry 层 v 与 snapshot 层 v 是两级
 * 独立版本（entry schema 演化 vs 快照格式演化）。
 */
// 模块内类型（不导出：无外部消费方，fallow unused_types/private_type_leaks 双轨判定；
// 运行侧 workflow-extractor 的同形结构独立定义，见其注释）。
interface WorkflowRecordEntryData {
  /** schema 版本（W17 起 v1）。消费方按 v 判别解析，不认识的版本跳过而非猜测。 */
  v: 1;
  /** 完整 RunSnapshot（与同次 flush 写入 state 文件的内容是同一份，不二次序列化）。 */
  snapshot: RunSnapshot;
  /** append 时刻 ISO 时间（诊断用；重建不依赖）。 */
  updatedAt: string;
}

/** 已序列化快照 → 自描述 entry data（doFlush 消费同一 snapshot，保证 entry 与 state 文件一致）。 */
function toWorkflowRecordEntryData(snapshot: RunSnapshot): WorkflowRecordEntryData {
  return { v: 1, snapshot, updatedAt: new Date().toISOString() };
}

// ── Serialization → core codec（下沉收口 D4）──────────────────
//
// serializeRun/deserializeRun 本地投影已退役：快照投影/重水合/版本 guard 单源消费
// core run-snapshot codec（toRunSnapshot/fromRunSnapshot）。键序与 strip live 语义
// 与原本地实现逐字节一致（⛔5 快照锚定：__tests__/jsonl-run-store-snapshot-codec.test.ts）；
// 唯一投影差异 = spec.budgetRef 剔除（codec 单源裁决，嵌套 run 落盘少一脏字段，
// 性质同 strip live——同偏差登记）。

/** workflow-record entry → 重建 run 写入 recordRuns（v1 entry guard + D-5 版本不匹配
 *  跳过；同 runId 后写覆盖 = 最后一条 entry 胜出）。返回 entry 是否命中该类型。
 *
 *  版本可见性分层（D4 裁决③宿主侧落地）：v 不匹配（v1 存量/未来版本）→ 静默跳过
 *  （既有语义）；v 匹配但形状损坏（codec 返回 undefined——codec 形状校验不抛）→
 *  warn 留证。
 *
 *  [SO-DATA-2] per-entry 隔离：残缺 entry（截断/手改/半写）不得让 loadAll 返回空。
 *  原实现靠「deserializeRun 抛 TypeError → catch → warn」；codec 收敛后形状损坏
 *  走 undefined 返回（warn 分支保持同等留证），try/catch 保留兜底 codec 唯一抛点
 *  （done 快照缺 reason 的 WorkflowRun I2 不变式）。
 */
function collectRecordRun(entry: CustomEntry, entryIndex: number, recordRuns: Map<string, WorkflowRun>): boolean {
  if (entry.customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return false;
  // v1 entry guard：schema 版本不认识 → 跳过（不猜测解析）
  const data = entry.data as WorkflowRecordEntryData | undefined;
  if (data?.v !== 1 || !data.snapshot) return true;
  try {
    if (data.snapshot.v === SNAPSHOT_VERSION) {
      const run = fromRunSnapshot(data.snapshot);
      if (run) {
        recordRuns.set(run.runId, run); // 后写覆盖 = 最后一条 entry 胜出
      } else {
        logger.warn(
          `[subagent-workflow] workflow-record entry #${entryIndex} corrupted, skipped run rebuild: snapshot shape invalid`,
        );
      }
    }
    // D-5: 版本不匹配 = old snapshot format / future version — skip silently
  } catch (err) {
    const reason = toErrorMessage(err);
    logger.warn(
      `[subagent-workflow] workflow-record entry #${entryIndex} corrupted, skipped run rebuild: ${reason}`,
    );
  }
  return true;
}

/** 旧 workflow-state-link 指针 entry → 写入 pointers（仅 state 文件发现通道，W17 前形态）。
 *  返回 entry 是否命中该类型。 */
function collectStateLinkPointer(entry: CustomEntry, pointers: Map<string, { path: string }>): boolean {
  if (entry.customType !== "workflow-state-link") return false;
  const data = entry.data as { runId?: string; path?: string } | undefined;
  if (data?.runId && data?.path) {
    pointers.set(data.runId, { path: data.path });
  }
  return true;
}

/** loadAll 的 entry 扫描：主 session entries → 自描述 record 快照（每 runId 末条胜出）
 *  + 旧 workflow-state-link 指针（仅 state 文件发现通道）。 */
function collectEntrySources(entries: SessionEntry[]): {
  recordRuns: Map<string, WorkflowRun>;
  pointers: Map<string, { path: string }>;
} {
  const recordRuns = new Map<string, WorkflowRun>();
  const pointers = new Map<string, { path: string }>();
  // 索引循环：collectRecordRun 的 warn 留证需要 entry 索引（SO-DATA-2）
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "custom") continue;
    if (collectRecordRun(entry, i, recordRuns)) continue;
    collectStateLinkPointer(entry, pointers);
  }
  return { recordRuns, pointers };
}

/** 旧 link 指针指向的 state 文件读取：末行 JSON 解析重建。损坏/不可读/版本不匹配
 *  返回 null（单文件失败不阻断其余 run 重建；D-5 静默跳过语义保持）。 */
async function loadRunFromStateFile(filePath: string): Promise<WorkflowRun | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return null;
    const parsed: unknown = JSON.parse(lastLine);
    // D-5: undefined = old format / version mismatch / corrupt shape — skip silently
    return fromRunSnapshot(parsed) ?? null;
  } catch {
    // Corrupt/unreadable state file — skip (don't crash loadAll).
    return null;
  }
}

// ── State file retention (OR-5 ⑥b, default-on) ───────────────
//
// 裁剪主体单源消费 core pruneStateFilesBeyondCap（S4-A7 收口：本地曾有一份逐段
// 同构的私有实现，retention 语义双份各自演化是漂移隐患）；日志注入本模块
// logger + [subagent-workflow] tag，错误字符串化用 ext-guards toErrorMessage——
// 行为与收口前一致（差异仅经 core 单源演化时两宿主同步）。

// ── JsonlRunStore ────────────────────────────────────────────

/** Node fs 错误 code 判定（ENOENT = 路径不存在，并发删除场景）。 */
function isEnoentError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

const logger = getLogger("subagents");

/**
 * save 去抖窗口默认值（ms）。区间 100-250 内取值——agent-call 间隔秒级，
 * 200ms 足以合并同一 call 周期内的多次状态 mutation，又不至于让崩溃窗口
 * （未 flush 的 running 尾部丢失，等价崩溃链由 kill-9 恢复收编）明显放大。
 * 模块私有：无外部消费方（构造参数 saveDebounceMs 可调窗口，测试经其注入）。
 */
const DEFAULT_SAVE_DEBOUNCE_MS = 200;

/**
 * 磁盘保留清理的上限 env（OR-5 ⑥b 默认开）：workflow-state 目录内 run state
 * 文件上限。
 *
 * 解析语义与 core FileRunStore envName 通道一致（两实现面单源 {@link
 * DEFAULT_STATE_MAX_RUNS}）：
 * - 未设/空 → 按默认上限 {@link DEFAULT_STATE_MAX_RUNS} 裁剪（**默认开**——
 *   OR-5 修复前的 opt-in「默认关」正是跨 run 无界累积缺陷本身）；
 * - 有限正数 → 上限 = env 值（显式覆盖默认值）；
 * - 非法值（非有限数/≤0）→ 不清理（显式 opt-out 通道：用户意图不明时不动
 *   磁盘，对齐 prune 内部「任何失败都不抛」的保守哲学）。
 *
 * 用 XYZ_ 前缀而非 PI_：本 env 是 pi 进程内读的配置 env，xyz-agent 桌面 spawn 链按
 * ENV_WHITELIST_PREFIXES（只有 XYZ_ 等）过滤，PI_ 前缀在桌面场景被静默丢弃——
 * 同 XYZ_SUBAGENT_IDLE_TIMEOUT_MS 的改名教训（lifecycle-manager.ts）。
 */
export const STATE_MAX_RUNS_ENV = "XYZ_SUBAGENT_STATE_MAX_RUNS";

/** 解析保留上限；env 未设/空 → 默认上限，显式非法/≤0 → undefined（不清理）。 */
function getEnvStateMaxRuns(): number | undefined {
  const raw = process.env[STATE_MAX_RUNS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_STATE_MAX_RUNS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * per-runId 去抖批。窗口内 N 次 save 合并：latestRun 保留最新聚合引用
 * （serialize-at-flush），settlers 收集批内全部 save() 调用方的 settle 回调。
 */
interface PendingSaveBatch {
  latestRun: WorkflowRun;
  /**
   * 批的去抖 timer（构造时即确定——经 {@link JsonlRunStore.armPendingBatch} 工厂
   * 内联组装，timer 与批对象在同一同步段成型，类型上不存在「先构造后赋值」的
   * 可选窗口）。
   */
  timer: NodeJS.Timeout;
  settlers: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
}

interface JsonlRunStoreOptions {
  /** Session directory root (state files live under <sessionDir>/workflow-state/). */
  sessionDir: string;
  /** Pi ExtensionAPI for workflow-record appendEntry writes (optional for testing). */
  pi?: ExtensionAPI;
  /** Pi ExtensionContext for sessionManager.getEntries (optional for testing). */
  ctx?: ExtensionContext;
  /** save 去抖窗口（ms），默认 {@link DEFAULT_SAVE_DEBOUNCE_MS}。 */
  saveDebounceMs?: number;
  /**
   * workflow-record entry append 节流最小间隔（ms）；0 = 禁用节流。缺省
   * {@link DEFAULT_SAVE_MIN_INTERVAL_MS}（单源复用 core 常量）。测试经此注入小窗口
   * （fake timers 推进）。
   */
  entryAppendMinIntervalMs?: number;
}

export class JsonlRunStore {
  private readonly sessionDir: string;
  private readonly pi?: ExtensionAPI;
  private readonly ctx?: ExtensionContext;
  private readonly saveDebounceMs: number;
  /** workflow-record entry append 节流最小间隔（ms），0 = 禁用。 */
  private readonly entryAppendMinIntervalMs: number;
  /** per-runId 去抖批（热路径）。 */
  private readonly pending = new Map<string, PendingSaveBatch>();
  /** 本实例已至少成功发起过一次 flush 的 runId（冷/热路径判据）。 */
  private readonly writtenOnce = new Set<string>();
  /**
   * per-runId 上次 workflow-record entry append 时刻（节流判据，时间源 Date.now()——
   * fake timers 下可推进）。终态 append 后删（终态后 runId 不再 save）；残留条目
   * 只出现在 running 中 run 消失场景，单条可忽略（对齐 core FileRunStore.lastSavedAt
   * 的取舍先例）。
   */
  private readonly lastEntryAppendAt = new Map<string, number>();
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
    this.saveDebounceMs = opts.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
    this.entryAppendMinIntervalMs = Math.max(
      0,
      opts.entryAppendMinIntervalMs ?? DEFAULT_SAVE_MIN_INTERVAL_MS,
    );
  }

  /** State directory: <sessionDir>/workflow-state/ */
  private get stateDir(): string {
    return path.join(this.sessionDir, "workflow-state");
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
   * Persist a single run: rewrite mode (overwrite) — file always contains the
   * latest complete snapshot on a single line.
   *
   * 去抖路由：
   * - 冷路径（本实例首写，或 status !== "running"）→ 立即挂链 flush（绕过 timer），
   *   回滚资格 = 首写（flush 失败时 doFlush 回滚 writtenOnce，下次 save 重走冷路径）；
   * - 热路径（running 且已写过）→ 并入 per-runId 去抖批（固定窗口不重置 timer）。
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
    const isFirstWrite = !this.writtenOnce.has(runId);
    const isCold = isFirstWrite || run.state.status !== "running";
    if (isCold) {
      // 判定即记录：原子防并发双冷（两次并发首写都判 true 会各 flush 一次 entry）。
      // ENOENT 边界：首写 flush 遇 ENOENT 时 entry 未写但 writtenOnce 已记——
      // sessionDir 已删场景持久化无意义，接受（非 ENOENT 失败由 doFlush 回滚，重走冷路径）。
      this.writtenOnce.add(runId);
      // 原子取走 pending 批（终态与最后一个 agent-call 的 debounced save 交错时，
      // pending 批 settlers 并入本次同步 flush 的批合并 settle，timer 取消防二次写）。
      const batch = this.pending.get(runId);
      if (batch) {
        clearTimeout(batch.timer);
        this.pending.delete(runId);
      }
      return this.enqueueFlush(runId, run, batch ? batch.settlers : [], isFirstWrite);
    }

    // 热路径：running 中间态，并入去抖批
    const existing = this.pending.get(runId);
    if (existing) {
      // latestRun 更新（固定窗口不重置 timer——flush 延迟有界 ≤saveDebounceMs）
      existing.latestRun = run;
      return new Promise<void>((resolve, reject) => {
        existing.settlers.push({ resolve, reject });
      });
    }
    const settlers: PendingSaveBatch["settlers"] = [];
    const promise = new Promise<void>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
    this.pending.set(runId, this.armPendingBatch(runId, run, settlers));
    return promise;
  }

  /**
   * 构造去抖批（[review 修复] 工厂内联组装：timer 与批对象在同一同步段成型，
   * PendingSaveBatch.timer 保持非可选——消除「批先构造、timer 后赋值」靠注释维持
   * 的可选窗口）。timer 回调闭包经局部 batch 变量持批引用做身份守卫（ES3）。
   */
  private armPendingBatch(
    runId: string,
    run: WorkflowRun,
    settlers: PendingSaveBatch["settlers"],
  ): PendingSaveBatch {
    // timer 回调闭包经下方 const batch 持批引用做身份守卫——前向引用在运行时安全：
    // 回调最早 saveDebounceMs 后才执行，届时 batch 已在本同步段尾部初始化完毕。
    const timer = setTimeout(() => {
      // ES3 幂等守卫（批身份比较）：回调闭包持自身批引用，与 pending Map 现值做
      // 身份比较而非仅按键存在性判断。除「批已被冷路径/flushPendingSaves/dispose
      // 原子取走（clearTimeout 与回调触发在 fake timers 下可能交错）」的交接语义外，
      // 还防「旧 timer 撞新批」交错：本批被取走后同 runId 的新批已入 Map 时，若只看
      // 键存在性，旧 timer 会误取走新批提前 flush（缩短新批去抖窗口）。身份不匹配
      // 直接 return，批由取走方负责 flush。
      if (this.pending.get(runId) !== batch) return;
      this.pending.delete(runId);
      // 孤儿 Promise（无调用方持有）：错误只经 settlers 传播给 save() 调用方，
      // 此处 catch 防止 unhandled rejection。
      this.enqueueFlush(runId, batch.latestRun, batch.settlers, false).catch(() => {});
    }, this.saveDebounceMs);
    // DS5：timer 必须 unref——不 unref 会钉住空转的 extension 进程不退出。
    timer.unref();
    const batch: PendingSaveBatch = { latestRun: run, timer, settlers };
    return batch;
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
      // 竞态场景（review-fix-loop-e2e 等 runAndWait 测试）：handleReturn 内
      // run.transition("done") 同步改 status 后，runAndWait 轮询发现 done 并 resolve，
      // 测试 afterEach 随即 rmSync 删除 sessionDir；此时 in-flight 的 mkdir
      // 遇到目录链已删除 → ENOENT（{recursive:true} 在并发 rmSync 下仍可抛 ENOENT）。
      // run 既已终态（状态不再变化），持久化无意义也无法完成 → settle resolve。
      // 仅容错 ENOENT，其他错误（EACCES/ENOSPC 等真实磁盘问题）reject 不掩盖。
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      } catch (err) {
        if (isEnoentError(err)) {
          for (const s of settlers) s.resolve();
          return;
        }
        throw err;
      }
      // serialize-at-flush：写 flush 时刻的最新聚合状态（latestRun 语义）
      const snapshot = toRunSnapshot(run);
      await fs.promises.writeFile(filePath, JSON.stringify(snapshot) + "\n", "utf8");
      // W17 [D4]：成功 flush 同步 append 自描述 workflow-record entry（同一份 snapshot，
      // entry 与 state 文件内容一致）。pi 文件是 workflow 数据持久化权威（loadAll 优先
      // 从 entry 重建），state 文件降级纯性能缓存。pi 未注入（测试）时跳过。
      // [B-1] entry append 节流（语义对齐 core FileRunStore.save OR-5 ⑥a）：running
      // 中间态距上次 append 不足间隔 → 跳过（pi session JSONL append-only，节流前
      // 每次 flush 全量 append 累积单 run O(n²) 磁盘）；终态永不节流（最终状态必进
      // pi 权威文件）；间隔 0 禁用。判据在 append 成功后更新——本调用点位于 writeFile
      // 成功之后，writeFile 抛错时判据不更新，不吞下一次重试机会。
      const isTerminal = run.state.status !== "running";
      const now = Date.now();
      const lastAppendAt = this.lastEntryAppendAt.get(runId);
      if (
        this.entryAppendMinIntervalMs <= 0 ||
        isTerminal ||
        lastAppendAt === undefined ||
        now - lastAppendAt >= this.entryAppendMinIntervalMs
      ) {
        this.pi?.appendEntry(
          WORKFLOW_RECORD_CUSTOM_TYPE,
          toWorkflowRecordEntryData(snapshot),
        );
        if (isTerminal) {
          this.lastEntryAppendAt.delete(runId);
        } else {
          this.lastEntryAppendAt.set(runId, now);
        }
      }
      // OR-5 ⑥b 磁盘保留清理（默认开）：新 run state 文件首写成功后触发（rollbackFirstWrite
      // 即 save() 冷路径传入的 isFirstWrite——「本实例首次写该 runId」≈ 新文件落盘时刻，
      // 每个 run 只清一次，热路径 flush 不重复扫描目录）。prune 内部吞错不抛，
      // 在串行链上 await：save 返回即清理已定，测试可同步断言目录终态。
      if (rollbackFirstWrite) {
        const maxRuns = getEnvStateMaxRuns();
        if (maxRuns !== undefined) {
          // 单源裁剪（core pruneStateFilesBeyondCap），注入本扩展 logger tag 与
          // toErrorMessage（行为与本地实现收口前一致）
          await pruneStateFilesBeyondCap(this.stateDir, maxRuns, {
            warn: (msg) => logger.warn(`[subagent-workflow] ${msg}`),
            debug: (msg) => logger.debug(`[subagent-workflow] ${msg}`),
            toMsg: toErrorMessage,
          });
        }
      }
      for (const s of settlers) s.resolve();
    } catch (err) {
      // ES9 失败回滚（热路径 flush 也会写 entry，回滚的意义收敛为「下次 save 重走
      // 冷路径立即重试」——不再有旧指针形态下「热路径永不写 entry → run 对重启
      // 不可见」的窗口）。堵住首写失败后还得等去抖窗的恢复延迟。
      // 残余窗口（已知接受）：回滚后若再无任何 save（随即崩溃/退出），entry 与
      // state 文件双双缺失——等价崩溃丢失，由 kill-9 恢复兜底。
      if (rollbackFirstWrite) {
        this.writtenOnce.delete(runId);
      }
      for (const s of settlers) s.reject(err);
    }
  }

  /**
   * 立即刷全部 pending 去抖批（测试与排查的备用手段）。自身恒 resolve——IO 错误
   * 已由各 save() Promise 的 settlers 传播给调用方。store 保持可用：不动 disposed
   * 标志，后续 save 正常进入新去抖批。
   */
  async flushPendingSaves(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const [runId, batch] of Array.from(this.pending.entries())) {
      clearTimeout(batch.timer);
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
    // 复用 flushPendingSaves（批收集循环与 await allSettled 与折叠前内联实现逐行等价；
    // flushPendingSaves 自身不动 disposed——dispose 语义仍由本方法的置位与缓存 Promise 承担）
    await this.flushPendingSaves();
    // await 全部 in-flight 链（ES4：flush 全部落定后才返回）
    await Promise.allSettled(Array.from(this.chains.values()));
  }

 /**
 * Reconstruct all runs（W17 [D4] 读序 = workflow-record entry > state 文件 > 空）。
 *
 * 1. 优先扫描自描述 `workflow-record` entry（重建源——同一 runId 多条时最后一条
 *    胜出，等价「最后一次成功 flush」）。entry 层 v1 guard：不认识的版本跳过而非
 *    猜测；snapshot 层 D-5 snapshotVersion guard 保持（版本不匹配 → fromRunSnapshot
 *    返回 undefined → 跳过，不做兼容迁移）。
 * 2. 旧 `workflow-state-link` 指针 entry 兼容读取（优先级低——存量 run 不静默
 *    丢失，父文档 #9 踩坑）：entry 未覆盖的 runId 经指针读 state 文件最后行。
 *
 * 需要 ctx（构造时注入）——无 ctx 时返回空（测试或非 Pi 环境下）。
 */
  async loadAll(): Promise<WorkflowRun[]> {
    if (!this.ctx) return [];
    const runs: WorkflowRun[] = [];
    try {
      const entries = this.ctx.sessionManager.getEntries();
      const { recordRuns, pointers } = collectEntrySources(entries);

      // 1) 自描述 entry 重建（优先——pi 文件是持久化权威）
      runs.push(...recordRuns.values());

      // 2) 旧 link 指针 → state 文件兼容（entry 已覆盖的 runId 跳过——link 优先级低）
      for (const [runId, pointer] of pointers) {
        if (recordRuns.has(runId)) continue;
        const run = await loadRunFromStateFile(pointer.path);
        if (run) runs.push(run);
      }
    } catch (err) {
 // getEntries failed — return what we have (empty).
      void err;
    }
    return runs;
  }
}

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
 * [P3/D6] 事件边沿 flush（快照投影增强）：
 * - **fold 投影**：每次 flush 经 core `projectRunEvents` 从同目录事件 journal
 *   （`<runId>.events.jsonl`，core pump 单写者落账）重放投影 additive 字段
 *   （calls[].startedAt/lastProgressAt、run 级 health、终局 outcome/errorCode）——
 *   权威在事件流，快照是投影；journal 读失败/为空降级为未富集快照。
 * - **边沿触发**：fs.watch 感知 journal append → per-runId 防抖 1s 合并 → 走既有
 *   串行链 flush（flush 时机从「agent 完成」加密到「事件边沿」）；活跃 run 引用
 *   由 save() 保留（终局即删）。watcher 失败一次性降级（回落 pump save 链时机）。
 * - **entry 通道节流不变**（P-C3 写放大控制）：workflow-record entry append 仍受
 *   entryAppendMinIntervalMs（60s）约束——pi session JSONL append-only，边沿级
 *   entry append 会复活 O(n²)；边沿 flush 落的是 state 文件（rewrite 覆盖写，
 *   无累积）。写放大评估登记见实施报告。
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
 * 保留策略由本包自担**——磁盘侧保留默认开（OR-5 ⑥b → [Q2] core 单源收口）：每次
 * 新 run state 文件首写成功触发一轮 retention 维护（runRetentionSweep：interrupted
 * 放弃窗终局化 + 已终局 run 足迹裁剪，判定与执行在 core
 * pruneTerminalRunFiles / abandonElapsedInterruptedRuns）；内存侧由
 * evictDoneRunsBeyondCap 淘汰。W17 后 state 文件已降级为纯性能缓存（权威数据在
 * session JSONL 的 workflow-record entry），随 session 文件被用户删除时一并消失。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
// DEFAULT_SAVE_MIN_INTERVAL_MS / DEFAULT_STATE_MAX_RUNS 经 core barrel 消费
// （u-2c 删 ./* 通配后深路径 tsc 不可解析，barrel 是壳侧唯一消费通道）；
// RUN_EVENT_JOURNAL_SUFFIX / STATE_DIR_NAME 同理经 barrel 单源（C3 常量上收：
// journal 后缀与 workflow-state 目录分量原为本地镜像，漂移即 watcher 失配 /
// store 读写错目录，现编译期跟随 core）。
import {
  DEFAULT_SAVE_MIN_INTERVAL_MS,
  DEFAULT_STATE_MAX_RUNS,
  RUN_EVENT_JOURNAL_SUFFIX,
  STATE_DIR_NAME,
} from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/subagent-core";

import { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  closeOutInFlightCalls,
  SNAPSHOT_VERSION,
  createRunEventJournal,
  fromRunSnapshot,
  projectRunEvents,
  toRunSnapshot,
  type DoneReason,
  type RunEventJournal,
  type RunOutcome,
  type RunSnapshot,
  type WorkflowRunEvent,
} from "@zhushanwen/subagent-core";
// [Q2 / D5 清理规则] retention 维护单源（core 消费，barrel 导出）：
// - pruneTerminalRunFiles：已终局 run 磁盘足迹裁剪（manifest 资格 + cap + TTL +
//   journal 成对删）——本模块 P1b-2 的本地资格感知实现已收口于此；
// - abandonElapsedInterruptedRuns：interrupted 放弃窗终局化（D5 规则③，无悬挂态）；
// - resolveStateTtlMs：TTL env 解析单源（常量随迁 core）。
import {
  abandonElapsedInterruptedRuns,
  pruneTerminalRunFiles,
  resolveStateTtlMs,
} from "@zhushanwen/subagent-core";
import { guardStaleCtx, isEnoentError, toErrorMessage } from "@zhushanwen/pi-ext-guards";

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
  // v1 entry guard：schema 版本不认识 → 跳过（不猜测解析）。细分两种形态：
  // 显式版本号非 1 = 未来版本（升级前装旧版读取属正常降级，静默跳过）；
  // v 缺失（写点恒定 v:1，缺失即形态损坏——半写/手改）→ warn 留证，对齐
  // SO-DATA-2 的 per-entry 损坏留证口径（原实现两者共用静默分支，损坏无从归因）。
  const data = entry.data as WorkflowRecordEntryData | undefined;
  if (data?.v === undefined) {
    logger.warn(
      `[subagent-workflow] workflow-record entry #${entryIndex} malformed (missing v), skipped run rebuild`,
    );
    return true;
  }
  if (data.v !== 1) return true;
  if (!data.snapshot) {
    logger.warn(
      `[subagent-workflow] workflow-record entry #${entryIndex} malformed (v1 without snapshot), skipped run rebuild`,
    );
    return true;
  }
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

/** 旧 link 指针 / 终局调和共用的 state 文件读取：末行 JSON 解析重建。损坏/不可读/
 *  版本不匹配返回 null（单文件失败不阻断其余 run 重建；D-5 静默跳过语义保持）。 */
async function loadRunFromStateFile(filePath: string): Promise<WorkflowRun | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return null;
    const parsed: unknown = JSON.parse(lastLine);
    // D-5: undefined = old format / version mismatch / corrupt shape — skip silently
    return fromRunSnapshot(parsed) ?? null;
  } catch (err) {
    // Corrupt/unreadable state file — skip (don't crash loadAll)，降级语义保持；
    // warn 留证（含文件路径与原因）防静默丢 run 无从归因。消费方 = 旧 link 指针
    // 通道与终局调和（reconcileRunningFinality）。
    logger.warn(
      `[subagent-workflow] state snapshot file unreadable, run rebuild/skip: ${filePath}: ${toErrorMessage(err)}`,
    );
    return null;
  }
}

/**
 * [终局调和] journal `run-settled` 帧的 RunOutcome 三态 → DoneReason（completed/
 * failed 同名直取；cancelled → aborted——与 core doneReasonToRunOutcome 正向映射
 * 互逆；outcome 类型经 core barrel 直引 RunOutcome）。
 */
function runSettledOutcomeToDoneReason(outcome: RunOutcome): DoneReason {
  switch (outcome) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "aborted";
  }
}

// ── State file retention (OR-5 ⑥b default-on → [Q2] core 单源收口) ─────────
//
// [Q2 / D5 清理规则] retention 维护已收口回 core 单源（P1b-2 的本地资格感知实现
// 删除）：裁剪资格（manifest outcome 非空）、cap + TTL 双限、journal 成对裁剪
// 全部在 core pruneTerminalRunFiles（file-run-store.ts）；interrupted 放弃窗终局化
// （D5 规则③，无悬挂态）在 core abandonElapsedInterruptedRuns（run-registry.ts）。
// 本面只保留触发点（新 run 首写的冷路径——每个新 run 进场做一轮完整 retention
// 维护）与宿主侧 cap env 解析（getEnvStateMaxRuns——cap env 双实现为存量格局，
// 与 core FileRunStore envName 通道同形）。TTL 常量/env 解析已随收口迁入 core
// （resolveStateTtlMs 单源）。

// ── JsonlRunStore ────────────────────────────────────────────

const logger = getLogger("subagents");

/**
 * save 去抖窗口默认值（ms）。区间 100-250 内取值——agent-call 间隔秒级，
 * 200ms 足以合并同一 call 周期内的多次状态 mutation，又不至于让崩溃窗口
 * （未 flush 的 running 尾部丢失，等价崩溃链由 kill-9 恢复收编）明显放大。
 * 模块私有：无外部消费方（构造参数 saveDebounceMs 可调窗口，测试经其注入）。
 */
const DEFAULT_SAVE_DEBOUNCE_MS = 200;

/**
 * [P3/D6] 事件边沿 flush 的防抖窗口默认值（ms）。flush 时机从「agent 完成」
 * 加密到「事件边沿」：journal append（同目录 `<runId>.events.jsonl`）经
 * fs.watch 感知后按本窗口合并触发 flush，快照投影（calls[].startedAt /
 * lastProgressAt、health、outcome/errorCode——projectRunEvents fold）在事件
 * 落账后 ≤1s 内进入 state 文件（P-C3 写放大控制：固定窗口合并不重置 timer，
 * 事件突发只落 1 次；超标上调通道 = 构造参数 eventEdgeDebounceMs）。
 * 模块私有：无外部消费方（测试经构造参数注入小窗口）。
 */
const DEFAULT_EVENT_EDGE_DEBOUNCE_MS = 1000;

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
 * 用 TAIJI_ 前缀而非 PI_：本 env 是 pi 进程内读的配置 env，taiji 桌面 spawn 链按
 * ENV_WHITELIST_PREFIXES（只有 TAIJI_ 等）过滤，PI_ 前缀在桌面场景被静默丢弃——
 * 同 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS 的改名教训（lifecycle-manager.ts）。
 */
export const STATE_MAX_RUNS_ENV = "TAIJI_SUBAGENT_STATE_MAX_RUNS";

/** 解析保留上限；env 未设/空 → 默认上限，显式非法/≤0 → undefined（不清理）。 */
function getEnvStateMaxRuns(): number | undefined {
  const raw = process.env[STATE_MAX_RUNS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_STATE_MAX_RUNS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** journal 文件后缀（<runId>.events.jsonl）——watcher 边沿判定消费 core barrel
 *  单源 RUN_EVENT_JOURNAL_SUFFIX（retention 裁剪判定在 core pruneTerminalRunFiles，
 *  journal 作为 run 附属成对裁）。 */

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
  /**
   * [P3/D6] 事件边沿 flush 防抖窗口（ms），默认 {@link DEFAULT_EVENT_EDGE_DEBOUNCE_MS}。
   * P-C3 写放大超标时上调通道。测试经此注入小窗口（fake timers 推进）。
   */
  eventEdgeDebounceMs?: number;
  /**
   * [P3/D6] 是否开 journal 目录 watcher（fs.watch 边沿感知），默认 true。测试用：
   * 防抖合并的确定性用例经 {@link JsonlRunStore.simulateJournalEdgeForTest} seam 驱动，
   * 关掉真实 watcher 防双源竞争（seam 与真实事件各调度一次——设计内语义）。
   */
  watchJournalEdges?: boolean;
}

export class JsonlRunStore {
  private readonly sessionDir: string;
  /**
   * workflow-record entry 的 appendEntry 源。store 对 pi 的唯一消费面是 doFlush 的
   * appendEntry（W17 权威 entry 写入），类型收窄为该面——[skill-reload D3] rebind
   * 时换入 stale-guarded 包装（见 {@link rebind}），构造时为裸 pi 原引用。
   */
  private pi?: Pick<ExtensionAPI, "appendEntry">;
  private ctx?: ExtensionContext;
  private readonly saveDebounceMs: number;
  /** workflow-record entry append 节流最小间隔（ms），0 = 禁用。 */
  private readonly entryAppendMinIntervalMs: number;
  /** [P3/D6] 事件边沿 flush 防抖窗口（ms）。 */
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
   * 必存在）；失败一次性降级（watcherBroken = 边沿触发退役，flush 时机回落
   * 「agent 完成」的 pump save 链——辅助功能降级不拖垮持久化主链）。
   * persistent:false = 不钉住 extension 进程空转（对齐去抖 timer unref 纪律）。
   */
  private journalWatcher: fs.FSWatcher | undefined;
  private journalWatcherBroken = false;
  private readonly watchJournalEdges: boolean;
  /** [P3/D6] journal 读面（fold 投影数据源；惰性单例，目录与 state 文件同源）。 */
  private journal: RunEventJournal | undefined;
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
    // [P3/D6] 活跃 run 引用保留（事件边沿 flush 的实例源）：running 态更新、
    // 终局即删（有界性）。终局引用不保留——终局后的边沿无 flush 意义（快照已终态）。
    if (run.state.status === "running") {
      this.activeRuns.set(runId, run);
    } else {
      this.activeRuns.delete(runId);
    }
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
          // resolve 语义保持（sessionDir 已删场景持久化无意义也无法完成），但按
          // run 形态分通道留痕：终态快照未落盘是数据损失面（warn 可归因「session
          // 目录被外部删除」）；running 中间态丢一拍等价崩溃语义（debug 即可，
          // 日志携带 status 供读上下文归因）。
          const msg = `state flush skipped, session dir missing (likely externally removed): runId=${runId} status=${run.state.status}`;
          if (run.state.status !== "running") {
            logger.warn(`[subagent-workflow] ${msg} (terminal snapshot NOT persisted)`);
          } else {
            logger.debug(`[subagent-workflow] ${msg}`);
          }
          for (const s of settlers) s.resolve();
          return;
        }
        throw err;
      }
      // serialize-at-flush：写 flush 时刻的最新聚合状态（latestRun 语义）。
      // [P3/D6] fold 投影：journal 同目录（<stateDir>/<runId>.events.jsonl），每次
      // flush 重读重 fold（幂等、单一推导点 projectRunEvents）——快照 additive 字段
      // （calls[].startedAt/lastProgressAt、health、outcome/errorCode）由事件流派生，
      // 权威在事件流（D5）。journal 读失败/为空 → 降级为未富集快照（辅助增强面，
      // 不阻断持久化主链）。
      this.ensureJournalWatcher();
      const journalEvents = await this.readJournalEvents(runId);
      const rawSnapshot = toRunSnapshot(run);
      const snapshot = journalEvents.length > 0 ? projectRunEvents(rawSnapshot, journalEvents) : rawSnapshot;
      // [B3 顺序反转] 权威优先：workflow-record entry（W17 权威通道）先写，state
      // 文件（性能缓存）后写。原顺序（state 先写）在 appendEntry 同步抛错
      // （assertActive/磁盘满）且为该 run 最后一次 flush 时，留下「state 新、entry
      // 缺」的残余形态——loadAll 只认 entry，run 对重启不可见，「等价崩溃丢失由
      // kill-9 恢复兜底」的论证不成立（恢复链不读 state 文件）。反转后两种失败
      // 形态都无害：appendEntry 失败 → entry 与 state 双缺（等价崩溃丢失，冷路径
      // 回滚后重试）；appendEntry 成功 + writeFile 失败 → 权威 entry 已落，state
      // 停在旧快照（读序 entry > state 文件，读侧无损失）。
      // [B-1] entry append 节流（语义对齐 core FileRunStore.save OR-5 ⑥a）：running
      // 中间态距上次 append 不足间隔 → 跳过（pi session JSONL append-only，节流前
      // 每次 flush 全量 append 累积单 run O(n²) 磁盘）；终态永不节流（最终状态必进
      // pi 权威文件）；间隔 0 禁用。判据在 append 成功后更新——writeFile 随后失败
      // 不回退判据：entry 已成功落账是既成事实，重试的 writeFile 无需重复 append。
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
      await fs.promises.writeFile(filePath, JSON.stringify(snapshot) + "\n", "utf8");
      // OR-5 ⑥b 磁盘保留维护（默认开 → [Q2] core 单源收口 + abandon 接线）：新 run
      // state 文件首写成功后触发（rollbackFirstWrite 即 save() 冷路径传入的
      // isFirstWrite——「本实例首次写该 runId」≈ 新文件落盘时刻，每个 run 只清一次，
      // 热路径 flush 不重复扫描目录）。两步维护内部吞错不抛，在串行链上 await：
      // save 返回即维护已定，测试可同步断言目录终态。
      if (rollbackFirstWrite) {
        await this.runRetentionSweep();
      }
      for (const s of settlers) s.resolve();
    } catch (err) {
      // ES9 失败回滚（热路径 flush 也会写 entry，回滚的意义收敛为「下次 save 重走
      // 冷路径立即重试」——不再有旧指针形态下「热路径永不写 entry → run 对重启
      // 不可见」的窗口）。堵住首写失败后还得等去抖窗的恢复延迟。
      // 残余窗口（已知接受）：回滚后若再无任何 save（随即崩溃/退出），entry 与
      // state 文件双双缺失——等价崩溃丢失，由 kill-9 恢复兜底。[B3 顺序反转]后
      // 该形态是唯一残余（appendEntry 失败 → 双缺）；「state 新而 entry 缺」的
      // 变体已随反转消除（writeFile 失败时 entry 已先落权威）。
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
   * journal 事件读取（fold 投影数据源）。经 core journal 单源（scan 的坏行容忍
   * 与 warn 留证语义一致）；任何读错误降级为空流（flush 主链不因增强面中断——
   * scan 自身只对非 ENOENT 读错误抛出，此处再兜一层防御）。
   */
  private async readJournalEvents(runId: string): Promise<readonly WorkflowRunEvent[]> {
    try {
      this.journal ??= createRunEventJournal(this.stateDir);
      return await this.journal.scan(runId);
    } catch (err) {
      logger.warn(
        `[subagent-workflow] journal scan failed, snapshot projected without events (runId=${runId}): ${toErrorMessage(err)}`,
      );
      return [];
    }
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
        // 平台差异/目录被删等 watcher 级错误：降级退役（边沿触发 → pump save 链兜底）
        this.journalWatcherBroken = true;
        this.closeJournalWatcher();
        logger.debug(
          `[subagent-workflow] journal watcher error, event-edge flush degraded: ${toErrorMessage(err)}`,
        );
      });
    } catch (err) {
      this.journalWatcherBroken = true;
      logger.debug(
        `[subagent-workflow] journal watcher unavailable, event-edge flush degraded: ${toErrorMessage(err)}`,
      );
    }
  }

  /**
   * watcher 回调：只认 journal 文件边沿（`.events.jsonl` 后缀——自身 `.jsonl`
   * 覆写、manifest `.json`、`.state` 投影写入结构性排除，防自触发回环）。
   * filename 缺失形态（部分平台 null）保守对全部活跃 run 调度——防抖窗口合并，
   * 误调度代价 = 一次幂等 flush。
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
   * 延迟有界 ≤eventEdgeDebounceMs，语义对齐 pending 批）。触发时以保留的活跃
   * run 引用走既有串行链 flush（空 settlers——调用方无人 await，孤儿错误链尾吞）。
   */
  private scheduleEventEdgeFlush(runId: string): void {
    if (this.pendingEdgeFlushes.has(runId)) return;
    const timer = setTimeout(() => {
      this.pendingEdgeFlushes.delete(runId);
      if (this.disposed) return;
      const run = this.activeRuns.get(runId);
      if (!run || run.state.status !== "running") return;
      this.enqueueFlush(runId, run, [], false).catch(() => {});
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
   * [Q2 / D5 清理规则] 新 run 进场的 retention 维护轮（两步，core 单源消费）：
   * 1. abandonElapsedInterruptedRuns——interrupted 超放弃窗终局化（写 manifest，
   *    无悬挂态；活跃保护集 = 本实例 activeRuns）；abandon 成功的 run 随即获得
   *    清理资格，同轮 prune 即可兑现裁剪；
   * 2. pruneTerminalRunFiles——已终局 run 磁盘足迹裁剪（manifest 资格 + cap +
   *    TTL + journal 成对删）。
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
    const maxRuns = getEnvStateMaxRuns();
    if (maxRuns === undefined) return; // cap opt-out：显式非法值整轮不清理（既有语义）
    try {
      await pruneTerminalRunFiles(
        stateDir,
        { cap: maxRuns, ttlMs: resolveStateTtlMs() },
        {
          warn: (msg) => logger.warn(`[subagent-workflow] ${msg}`),
          debug: (msg) => logger.debug(`[subagent-workflow] ${msg}`),
          toMsg: (err: unknown) => toErrorMessage(err),
        },
      );
    } catch (err) {
      logger.warn(
        `[subagent-workflow] state retention: terminal prune sweep failed: ${toErrorMessage(err)}`,
      );
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
    // [P3/D6] 事件边沿面收尾：清防抖 timer（挂起的边沿 flush 由下方 flushPendingSaves
    // 的终批覆盖语义兜住——activeRuns 保留至 dispose 后不再更新，终态已由 pump save
    // 或后续链 flush）+ 关 watcher（persistent:false 本不钉进程，主动关 = 纪律收尾）。
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
   * 原地改写 entry 写入源与 ctx——store 实例跨 reload 存活（D2 槽），在飞去抖批与
   * per-runId 串行 flush 链持有 this，原地改写对后续 flush 天然可见（不遍历对象图
   * 重绑：闭包引用不可枚举，漏一处 = 恢复后随机 assertActive 抛——设计被否项）。
   * writtenOnce / lastEntryAppendAt / pending / chains 全部保留（接管而非重建）。
   *
   * [skill-reload D5] 换入的 appendEntry 源包 guardStaleCtx：下一次 reload 窗口
   * （invalidate → adoption rebind 完成之间，通常 <1s）in-flight flush 触碰已 stale
   * 的本 pi 时统一 debug 丢弃（不分中间态/终态——appendEntry 是同步 void，stale
   * 表现为同步 assertActive 抛错，不包会把窗口内 flush 打成 IO 错误路径：settlers
   * reject + writtenOnce 回滚）。终态保全不依赖窗口内写入，由 adoption 快照重发
   * （{@link resendSnapshots}）承担：窗口内终态的 run 在 adoption 时刻内存对象已
   * 是终态，快照重发追加的就是终态 entry。
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
   * [skill-reload D4] adoption 快照重发：把 runs 内全部 run 的当前快照经 per-runId
   * 串行 flush 链（enqueueFlush → doFlush）重发一条权威 workflow-record entry。
   *
   * 设计红线：必须经本链而非裸 pi.appendEntry——doFlush 的 await writeFile 与
   * appendEntry 之间存在事件循环间隙（W17 补充事实），绕链直接 append 会与
   * in-flight 中间态 flush 物理乱序（终态在前中间态在后，last-ways 读回 running →
   * 崩溃恢复误判）；走串行链后同 runId 的 entry 顺序由链内闭合保证。
   *
   * 节流语义自然继承 doFlush：终态 flush 永不节流（最终状态必进 pi 权威文件）；
   * running 中间态受既有 entryAppendMinIntervalMs（缺省 60s）节流约束可跳过——
   * 与常规 flush 同源（pi 文件最后一条 entry 最多落后真实状态一个窗口）。测试
   * 断言因此按终态/首写路径构造，不依赖中间态重发必落。
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
 * Reconstruct all runs（W17 [D4] 读序 = workflow-record entry > state 文件 > 空）。
 *
 * 1. 优先扫描自描述 `workflow-record` entry（重建源——同一 runId 多条时最后一条
 *    胜出，等价「最后一次成功 flush」）。entry 层 v1 guard：不认识的版本跳过而非
 *    猜测；snapshot 层 D-5 snapshotVersion guard 保持（版本不匹配 → fromRunSnapshot
 *    返回 undefined → 跳过，不做兼容迁移）。
 * 2. 旧 `workflow-state-link` 指针 entry 兼容读取（优先级低——存量 run 不静默
 *    丢失，父文档 #9 踩坑）：entry 未覆盖的 runId 经指针读 state 文件最后行。
 * 3. [终局调和] entry 重建出的 running run 与磁盘终局证据对账（见
 *    {@link reconcileRunningFinality}）——修复「实际已终局的 run 因终态 entry
 *    缺失/过时被恢复链误标 failed」的错误语义。
 *
 * [已知限制·登记] 恢复域 = 本 session 的 entry 集：崩溃后用户不再 resume 原
 * session（同 cwd 开新 session 继续）时，原 session 的遗留 run 对新 session 的
 * loadAll/恢复链不可见——无 failed 记录、无 UI 痕迹，仅磁盘层兜底（journal 7 天
 * abandon 写 manifest、state 文件 30 天 TTL/cap 裁剪）。跨 session 收编需要引入
 * 共享 stateDir 的孤儿扫描 + 跨 session 写入语义，与 W17 session 锚定设计相悖，
 * 收益面（用户主动放弃的 session）有限，故登记不改。
 *
 * 需要 ctx（构造时注入）——无 ctx 时返回空（测试或非 Pi 环境下）。
 */
  async loadAll(): Promise<WorkflowRun[]> {
    if (!this.ctx) return [];
    const runs: WorkflowRun[] = [];
    try {
      const entries = this.ctx.sessionManager.getEntries();
      const { recordRuns, pointers } = collectEntrySources(entries);

      // 3) 终局调和：entry 是「最后一次成功 append」的快照，journal 终局帧与
      // GC 终局化可能新于它——running 态先对账再交恢复链（对账采纳终局的 run
      // 不再被 recoverCrashedRuns 转 failed）。
      for (const run of recordRuns.values()) {
        if (run.state.status === "running") {
          await this.reconcileRunningFinality(run);
        }
      }

      // 1) 自描述 entry 重建（优先——pi 文件是持久化权威）
      runs.push(...recordRuns.values());

      // 2) 旧 link 指针 → state 文件兼容（entry 已覆盖的 runId 跳过——link 优先级低）
      for (const [runId, pointer] of pointers) {
        if (recordRuns.has(runId)) continue;
        const run = await loadRunFromStateFile(pointer.path);
        if (run) runs.push(run);
      }
    } catch (err) {
      // getEntries failed — 返回已收集结果（空集降级语义保持），但必须 error 留痕：
      // 静默空集会把 session 文件读故障伪装成「无 run 历史」，恢复无从下手。
      logger.error(
        `[subagent-workflow] loadAll: getEntries failed, returning empty run set (degraded). Recovery: check session file readability: ${toErrorMessage(err)}`,
      );
    }
    return runs;
  }

  // ── [终局调和] running 快照的磁盘终局对账 ──────────────────────

  /**
   * [终局调和] 把 entry 重建出的 running run 按磁盘终局证据收编为正确终态。
   *
   * 动机（两个已证实的误判面，修复 A1/A2）：
   * 1. **journal 终局先于终态 entry 落账**：pump 的终局 coda 落账顺序是 journal
   *   （appendFileSync 同步）→ saveRunBestEffort 写终态 entry（best-effort 不
   *   重试）。终态 entry 写失败（ENOSPC 等）后，任何一次进程退出都会让
   *   recoverCrashedRuns 把实际 completed 的 run 误标 failed——D5 明文「权威在
   *   事件流」，恢复读路径却只看快照 entry，权威声明与读路径分叉。
   * 2. **idle-GC 双轨**：core GC（FileRunStore 通道）终局化只写 state 文件不改
   *   entry，resume 后恢复链从 entry 读到 running 再次转 failed，覆盖 GC 终局。
   *
   * 证据读序（与 loadAll 读序同构）：journal `run-settled` 帧（权威——一个 run
   * 恰好一帧）> state 文件终态快照 > 无证据（保持 running，交 recoverCrashedRuns
   * 按崩溃语义收编）。journal 被保留期裁剪后（cap+TTL）降级到 state 文件通道；
   * 两通道皆失守的极旧 run 按 failed 收编，语义可接受。
   *
   * 调和只走 running→done（转移表唯一合法边），终局内容（reason/error）取自
   * 证据源；in-flight calls 收口对齐 recoverCrashedRuns 的收编动作。调和自身
   * 任何异常降级为保持 running（增强面不阻断 loadAll 主链），warn 留证。
   */
  private async reconcileRunningFinality(run: WorkflowRun): Promise<void> {
    try {
      // 1) journal run-settled 帧（尾向扫描取最后一帧——单帧契约下的防御性读取）
      const events = await this.readJournalEvents(run.runId);
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type !== "run-settled") continue;
        const reason = runSettledOutcomeToDoneReason(ev.outcome);
        if (reason !== "completed") {
          run.state.error =
            ev.reason ??
            `finality reconciled from journal: outcome=${ev.outcome} code=${ev.errorCode ?? "unknown"}`;
        }
        run.transition("done", reason);
        closeOutInFlightCalls(run);
        logger.warn(
          `[subagent-workflow] finality reconciliation: run ${run.runId} adopted terminal state from journal run-settled (outcome=${ev.outcome}) — snapshot entry was stale (still running)`,
        );
        return;
      }
      // 2) state 文件终态快照（GC 终局化通道 / 终态 entry append 失败的旁路证据）
      const stateRun = await loadRunFromStateFile(this.filePathFor(run.runId));
      if (stateRun?.state.status === "done" && stateRun.state.reason !== undefined) {
        run.state.error = stateRun.state.error;
        run.transition("done", stateRun.state.reason);
        closeOutInFlightCalls(run);
        logger.warn(
          `[subagent-workflow] finality reconciliation: run ${run.runId} adopted terminal state from state-file snapshot (reason=${stateRun.state.reason}) — snapshot entry was stale (still running)`,
        );
      }
    } catch (err) {
      logger.warn(
        `[subagent-workflow] finality reconciliation failed, run stays running for crash-recovery (runId=${run.runId}): ${toErrorMessage(err)}`,
      );
    }
  }
}

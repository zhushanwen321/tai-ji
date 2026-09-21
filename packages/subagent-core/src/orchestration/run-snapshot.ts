// src/orchestration/run-snapshot.ts
//
// WorkflowRun 快照 codec（下沉收口 D4——设计件 subagent-core-sink-design.md（已删，git 可追溯） U8）。
//
// 为什么需要它：WorkflowRun 的 JSONL 快照投影此前两宿主各写一份（core
// file-run-store.ts 的 toSnapshot/fromSnapshot 与 pi 壳 jsonl-run-store.ts 的
// serializeRun/deserializeRun）——字段集一致但语义细节分叉（版本 guard、
// budgetRef 剔除），修一处漏一处。本模块收敛为单源 codec：字段演进
// 单点（G2），两宿主（FileRunStore / pi JsonlRunStore）各自只保留 IO 策略
// （rewrite/append/去抖），投影与版本衔接语义全部经此模块。
//
// 版本衔接三裁决（D4，含审查 MF-2）：
// ① 版本值沿用 pi 现有字符串 "wf-run-v2"——pi 存量逐字节可读；
// ② FileRunStore 存量行（无 v 字段）按「缺版本 = 当前版本」宽容读取，写入时
//    补 v，不做自动迁移——「缺 v 宽容」实现于 FileRunStore 层预处理（读出的行
//    先补缺省 v 再进 fromRunSnapshot），**不内聚进本 codec**：codec 层面缺 v
//    即拒绝，保 pi 侧「v1 存量静默跳过」既有语义不被宽容化误读；
// ③ guard 语义 = v 不匹配当前版本即拒（字符串版本无大小序，不引入比较逻辑）；
//    「跳过 + warn」的可见性由宿主 store 层补（本 codec 只返回 undefined）。
//
// 序列化形态（键序即 JSON.stringify 输出序）逐键对齐 pi serializeRun 现网形态，
// 使 pi 切换本 codec 后存量往返逐字节一致（⛔5）。

import { AgentCall } from "./models/agent-call.ts";
import { Budget } from "./models/budget.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type {
  RunStatus,
  DoneReason,
  WorkerLogEntry,
  ExecutionTraceNode,
  AgentCallOpts,
  AgentResult,
} from "./models/types.ts";
import { Trace } from "./models/trace.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkflowRunMeta } from "./models/workflow-run.ts";
import type { RunErrorCode, RunOutcome, WorkflowRunEvent } from "./run-events.ts";

/**
 * 快照格式版本（D4 裁决①：字符串相等比较，无大小序）。
 *
 * 版本历史（沿用 pi jsonl-run-store 口径）：
 * - wf-run-v1：status 三态（含 paused）、meta 含 pausedAt（pi 旧格式，读路径拒绝）。
 * - wf-run-v2（当前）：status 两态（running/done）、meta 无 pausedAt。
 *
 * [P3/D6] additive 字段策略：v2 基线上新增的可选字段（CallSnapshot.startedAt /
 * lastProgressAt、state.health / outcome / errorCode）**不 bump 版本**——bump 会让
 * extractor 版本守卫把存量历史 run 快照整条跳过（历史 run 从 UI 消失，D6 明示代价），
 * 故走「纯 additive 读」：旧读侧对新字段天然跳过（未知字段容忍），旧快照对新读侧
 * 缺字段按缺省渲染（消费侧 lastProgressAt 缺 → 时长槽省略、health 缺 → unknown）。
 * 未来真需格式重构 bump 时，须按 D6-1 显式登记「升级后历史 run 从 UI 消失」代价与
 * 迁移方案。
 *
 * 升级格式时 bump 此常量——旧版本快照经 fromRunSnapshot 返回 undefined，由
 * 宿主 store 层决定跳过可见性（FileRunStore warn / pi 静默）。
 */
export const SNAPSHOT_VERSION = "wf-run-v2" as const;

/** Budget 实例的可序列化投影（构造 opts 同形，重水合直接 new Budget(...)）。 */
interface BudgetSnapshot {
  maxTokens?: number;
  maxCost?: number;
  maxTimeMs?: number;
  usedTokens: number;
  usedCost: number;
  totalCallCount: number;
}

/**
 * AgentCall 实例的可序列化投影。traceNode 整体落盘（节点引用不可序列化，
 * 落盘值拷贝；重水合后 D-10「引用共享」由 fromRunSnapshot 的 trace 回链尽力
 * 恢复——Trace.fromArray 注释先例）。
 *
 * [P3/D6] startedAt / lastProgressAt 两字段由事件 journal fold 投影填充
 * （{@link projectRunEvents}——单一推导点），不在 AgentCall 聚合上维护：
 * 「快照 + 事件流双写时快照必然漂移、权威必须在事件流」（D5 证据）。两字段
 * additive（可缺省——旧快照无此字段，消费侧缺省渲染），epoch ms 口径与
 * EventEnvelope.ts 同源。
 */
interface CallSnapshot {
  id: number;
  opts: AgentCallOpts;
  status: "pending" | "running" | "done";
  attempts: number;
  /** [P3/D6] 该 ask 首个派发/执行事件的墙钟时间（epoch ms）——「每 ask 已执行时长」槽的起点。 */
  startedAt?: number;
  /** [P3/D6] 该 ask 最近一次事件边沿（dispatched/executing/retrying/settled）的墙钟时间（epoch ms）。 */
  lastProgressAt?: number;
  result?: AgentResult;
  sessionId?: string;
  sessionFile?: string;
  traceNode: ExecutionTraceNode;
}

/**
 * run 级 health 投影（[P3/D6]）。**仅 lastProgressAt 单字段存储**——stalledSince
 * 由消费侧 lastProgressAt + 阈值推导（不落快照）；consecutiveFailures 不引入
 * （D6：全文无消费方，需求出现再加）。
 */
interface RunHealthSnapshot {
  /** run 最近任意事件边沿（含 run-created/armed/ask 族/run-settled）的墙钟时间（epoch ms）。 */
  lastProgressAt: number;
}

/**
 * WorkflowRun 的持久化快照形态（JSONL 单行，全量而非增量）。
 *
 * 形态与 pi 壳 jsonl-run-store.ts 的 RunSnapshot 同构（v 字段含内）——两宿主
 * 存量互读的前提，任何字段增删必须同步两处并评估存量行。
 */
export interface RunSnapshot {
  v: typeof SNAPSHOT_VERSION;
  runId: string;
  spec: RunSpec;
  state: {
    status: RunStatus;
    reason?: DoneReason;
    budget: BudgetSnapshot;
    calls: CallSnapshot[];
    trace: ExecutionTraceNode[];
    errorLogs: WorkerLogEntry[];
    error?: string;
    scriptResult?: unknown;
    /**
     * [P3/D6] run 级 health 投影（fold 填充，可缺省——旧快照无此字段）。
     * 权威源 = 事件 journal；stalledSince 由消费侧推导，不落快照（D6）。
     */
    health?: RunHealthSnapshot;
    /**
     * [P3/D6] 终局形态（run-settled fold 填充；仅终局后快照携带）。
     * 与 status/reason（DoneReason 六因）正交——「run 自身怎么死的」维度
     * （RunOutcome 三态），语义边界见 run-events.ts ALL_RUN_OUTCOMES 注释。
     */
    outcome?: RunOutcome;
    /** [P3/D6] 终局结构化错误码（failed 终局携带；词表 = RunErrorCode）。 */
    errorCode?: RunErrorCode;
  };
  meta: WorkflowRunMeta;
}

// ── 序列化 ──────────────────────────────────────────────────

/**
 * WorkflowRun → 单行快照。
 *
 * - 补 v 字段（D4 裁决②：写入恒带当前版本）。
 * - trace 节点全量序列化（[H2 W3] live strip 分支随 ExecutionTraceNode.live 字段
 *   删除而退役——节点不再携带运行期对象，无需防御性剥离；旧快照经 fromRunSnapshot
 *   重水合时多余键自然丢弃，存量行零迁移）。
 * - spec.budgetRef 剔除：父 Budget 共享引用是进程内优化（嵌套 workflow 预算
 *   共享），非持久化数据；Budget 实例若混入 spec 落盘将退化为普通对象投影
 *   （重水合后类型不符的脏字段）——重水合后 budget 从 state.budget 独立重建，
 *   嵌套 run 的预算共享不跨进程存活。
 * - runtime 不落盘（worker/controller/timer 不可序列化且跨进程必死——重水合
 *   语义见 WorkflowRun.reconstruct 注释）。
 */
export function toRunSnapshot(run: WorkflowRun): RunSnapshot {
  const { budgetRef: _budgetRef, ...spec } = run.spec;
  return {
    v: SNAPSHOT_VERSION,
    runId: run.runId,
    spec,
    state: {
      status: run.state.status,
      reason: run.state.reason,
      budget: {
        maxTokens: run.state.budget.maxTokens,
        maxCost: run.state.budget.maxCost,
        maxTimeMs: run.state.budget.maxTimeMs,
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost,
        totalCallCount: run.state.budget.totalCallCount,
      },
      calls: Array.from(run.state.calls.values(), (c) => ({
        id: c.id,
        opts: c.opts,
        status: c.status,
        attempts: c.attempts,
        result: c.result,
        sessionId: c.sessionId,
        sessionFile: c.sessionFile,
        traceNode: c.traceNode,
      })),
      // trace 节点全量拷贝序列化（toArray 返回内部数组只读引用，拷贝为可变数组
      // 落盘——节点不再携带运行期对象，无需防御性剥离）
      trace: [...run.state.trace.toArray()],
      errorLogs: run.state.errorLogs,
      error: run.state.error,
      scriptResult: run.state.scriptResult,
    },
    meta: run.meta,
  };
}

// ── 事件 journal fold 投影（[P3/D6] 单一推导点）──────────────

/**
 * 从事件 journal fold 投影快照的 additive 字段（[P3/D6] 唯一推导点）。
 *
 * 为什么是纯函数 + 调用方传入事件：本 codec 零 IO（模块头注），journal scan 归
 * 宿主 store 层（pi JsonlRunStore flush 时读同目录 `<runId>.events.jsonl` 后调
 * 本函数）。权威在事件流（D5 证据：「快照 + 事件流双写时快照必然漂移」）——
 * 每次 flush 重 fold（幂等：输出只由 (snap, events) 决定），不增量缓存。
 *
 * fold 规则（词表 = run-events.ts D5 七事件）：
 * - `ask-dispatched` / `ask-executing`：按 taskIndex 关联 calls[] 条目（id 同源
 *   D-10），startedAt ??= ts（首边沿即起点——executing 兜底覆盖 journal 缺
 *   dispatched 帧的历史分段）；lastProgressAt = ts；
 * - `ask-retrying` / `ask-settled`：仅推进 lastProgressAt（重试轨迹的进度语义）；
 * - `run-created` / `armed`：仅推进 run 级 health.lastProgressAt；
 * - `run-settled`：health 推进 + 终局投影（state.outcome / errorCode 落快照）；
 * - taskIndex 无关联条目（journal 与快照代际错位）：per-call 跳过、health 照常
 *   推进（run 级进展是事实）——坏数据失效模式 = 缺省渲染，不炸不丢 run；
 * - ts 单调防御：lastProgressAt 取 max（乱序帧不回拨进度时钟）。
 *
 * 不碰的字段：status / attempts / result / trace 等聚合权威字段原样透传——
 * calls 三态直读（D6：消费面按既有三态直读，不做词表转换），fold 只补事件侧
 * 派生字段。
 *
 * @param snap 基线快照（toRunSnapshot 产物；其新字段缺省 undefined）
 * @param events journal scan 产出（写入序；坏行已被 scan 侧跳过）
 * @returns 新快照对象（浅拷贝分层克隆——输入不被修改，flush 侧可安全覆写）
 */
export function projectRunEvents(snap: RunSnapshot, events: readonly WorkflowRunEvent[]): RunSnapshot {
  const callsById = new Map<number, CallSnapshot>();
  const calls = snap.state.calls.map((c) => {
    const clone: CallSnapshot = { ...c };
    callsById.set(clone.id, clone);
    return clone;
  });

  let lastProgressAt = snap.state.health?.lastProgressAt;
  let outcome = snap.state.outcome;
  let errorCode = snap.state.errorCode;

  const advanceCall = (taskIndex: number, ts: number, startIfFirst: boolean): void => {
    const call = callsById.get(taskIndex);
    if (call === undefined) return; // 代际错位：per-call 跳过（health 照常推进）
    if (startIfFirst && call.startedAt === undefined) call.startedAt = ts;
    call.lastProgressAt = call.lastProgressAt === undefined || call.lastProgressAt < ts
      ? ts
      : call.lastProgressAt;
  };

  for (const event of events) {
    lastProgressAt = lastProgressAt === undefined || lastProgressAt < event.ts
      ? event.ts
      : lastProgressAt;
    switch (event.type) {
      case "ask-dispatched":
      case "ask-executing":
        advanceCall(event.taskIndex, event.ts, true);
        break;
      case "ask-retrying":
      case "ask-settled":
        advanceCall(event.taskIndex, event.ts, false);
        break;
      case "run-settled":
        outcome = event.outcome;
        if (event.errorCode !== undefined) errorCode = event.errorCode;
        break;
      case "run-created":
      case "armed":
        // 仅推进 run 级 health（无 per-call 语义）
        break;
    }
  }

  return {
    ...snap,
    state: {
      ...snap.state,
      calls,
      ...(lastProgressAt !== undefined ? { health: { lastProgressAt } } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    },
  };
}

// ── 重水合 ──────────────────────────────────────────────────

/** 「truthy 且 typeof object」——与原内联守卫 `!x || typeof x !== "object"` 拒绝集一致。 */
function isPresentObject(v: unknown): v is object {
  return !!v && typeof v === "object";
}

/** 通过形状校验的快照视图：顶层必填字段（v/runId/spec/state/meta）均已验存在。 */
interface ValidatedSnapshot {
  v: typeof SNAPSHOT_VERSION;
  runId: string;
  spec: RunSpec;
  state: NonNullable<RunSnapshot["state"]>;
  meta: WorkflowRunMeta;
}

/**
 * 顶层形状校验（检查顺序与原内联守卫逐条一致）。
 *
 * 含 D4 裁决③ version guard（字符串相等，无大小序）：v 不等于当前版本即拒
 * （含缺版本——「缺 v 宽容」是 FileRunStore 层预处理职责，不内聚进本 codec；
 * pi 侧对 v1 存量行的静默跳过语义依赖此拒绝行为）。
 */
function isValidSnapshotShape(s: Partial<RunSnapshot>): s is ValidatedSnapshot {
  if (s.v !== SNAPSHOT_VERSION) return false;
  if (typeof s.runId !== "string" || !s.runId) return false;
  if (!isPresentObject(s.spec)) return false;
  const st = s.state;
  if (!isPresentObject(st)) return false;
  if (st.status !== "running" && st.status !== "done") return false;
  if (!isPresentObject(st.budget)) return false;
  if (!Array.isArray(st.calls) || !Array.isArray(st.trace)) return false;
  if (!isPresentObject(s.meta)) return false;
  return true;
}

/** call.traceNode → Trace 节点回链（D-10 尽力恢复，匹配不到退化为独立浅拷贝）。 */
function linkTraceNode(c: CallSnapshot, trace: Trace): ExecutionTraceNode | undefined {
  return (
    trace.toArray().find((n) => n.stepIndex === c.traceNode?.stepIndex) ??
    (c.traceNode ? { ...c.traceNode } : undefined)
  );
}

/**
 * 单条 CallSnapshot → AgentCall。残缺条目（非对象 / id 非数 / traceNode 缺失）
 * 返回 undefined，由调用方跳过——不炸整个 run。
 */
function rehydrateCall(c: CallSnapshot, trace: Trace): AgentCall | undefined {
  if (c === null || typeof c !== "object" || typeof c.id !== "number") return undefined;
  const linked = linkTraceNode(c, trace);
  if (!linked) return undefined;
  const call = new AgentCall(c.id, c.opts, linked);
  call.status = c.status;
  call.attempts = c.attempts;
  // Restore result directly — bypasses markRunning/markDone state-machine guards
  // because we're reconstructing a known-good persisted state, not transitioning.
  if (c.result !== undefined) call.result = c.result;
  if (c.sessionId !== undefined) call.sessionId = c.sessionId;
  if (c.sessionFile !== undefined) call.sessionFile = c.sessionFile;
  return call;
}

function rehydrateCalls(snapshots: CallSnapshot[], trace: Trace): Map<number, AgentCall> {
  const calls = new Map<number, AgentCall>();
  for (const c of snapshots) {
    const call = rehydrateCall(c, trace);
    if (call) calls.set(c.id, call);
  }
  return calls;
}

/**
 * 快照 → WorkflowRun 重水合。
 *
 * 版本 guard（D4 裁决③）：v 不等于当前版本即返回 undefined（含缺版本——
 * 「缺 v 宽容」是 FileRunStore 层预处理职责，不内聚进本函数；pi 侧对 v1 存量
 * 行的静默跳过语义依赖此拒绝行为）。
 *
 * 形状校验失败同样返回 undefined（调用方按损坏行处理，本函数不抛——唯一例外：
 * done 快照缺 reason 触发 WorkflowRun I2 不变式抛错，属真 bug 不可吞）。
 */
export function fromRunSnapshot(snap: unknown): WorkflowRun | undefined {
  if (snap === null || typeof snap !== "object") return undefined;
  const s = snap as Partial<RunSnapshot>;
  if (!isValidSnapshotShape(s)) return undefined;

  // Trace 先重建：calls 的 traceNode 回链到 Trace 副本（D-10 尽力恢复——
  // fromArray 拷贝节点，按 stepIndex 匹配使 call.traceNode 与 trace.nodes
  // 共享同一副本引用；匹配不到（快照数据漂移）退化为独立浅拷贝，仅保构造不炸。
  const trace = Trace.fromArray(s.state.trace);
  const calls = rehydrateCalls(s.state.calls, trace);

  return WorkflowRun.reconstruct(
    s.runId,
    s.spec,
    {
      status: s.state.status,
      reason: s.state.reason,
      budget: new Budget(s.state.budget),
      calls,
      trace,
      errorLogs: Array.isArray(s.state.errorLogs) ? s.state.errorLogs : [],
      error: s.state.error,
      scriptResult: s.state.scriptResult,
    },
    s.meta,
  );
}

// src/execution/subagent-actions-core.ts
//
// subagent tool 六 handler 的领域内核（校验 / 守卫链 / 归属判定 / 终态映射）。
//
// 来源：pi-sw `src/interface/subagent-actions.ts` 的零 pi-API 部分原样下沉
//（sink 设计 docs/design/subagent-core-sink-design.md §3.3 D6② / U10②；
// ⛔4 行为快照等值测试见 __tests__/subagent-actions-core.test.ts——期望值
// 硬编码自迁移前 pi-sw 实现的实测输出，含错误文案锚）。
//
// 分层：本模块产出**领域对象**（StartHandlerResult / ListHandlerResult / ...），
// 不感知 {content, details} 包装与 TUI/GUI 渲染——宿主 adapter 负责把领域对象
// 包成工具结果（pi 侧收缩为「参数提取 + core 调用 + TUI 渲染」）。
//
// 平台中立性：全部错误文案 / 提示文案面向 LLM（行动语言），无宿主专属词汇，
// 文案内聚本模块（文案即行为，⛔4 逐字锚定）。

import { findForeignLiveInstance } from "./alive-store.ts";
import { computeElapsedSeconds, projectOutcome } from "./execution-record.ts";
import { isResumable } from "./lifecycle-predicates.ts";
import { SLUG_MAX_LENGTH } from "../orchestration/models/types.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { SubagentService } from "./subagent-service.ts";
import { displayAgentName } from "../shared/agent-ref.ts";
import type {
  BgResponse,
  CancelResponse,
  CloseResponse,
  ExecutionRecord,
  ExecutionStatus,
  ExternalState,
  ForkFromResponse,
  ListResponse,
  MessageResponse,
  SubagentListItem,
  SubagentRecord,
} from "./types.ts";
import { ResurrectDeniedError } from "./types.ts";
import { COLLECT_SCAN_LIMIT } from "./collect-coordinator.ts";
// [H1 U2 / D5 双写点①] SP-5 升级 gate 的错误构造（文案/错误码/恢复指引单一权威，
// 与 Continuation D4 revive 格写点②共用）+ 默认引擎 id（engine 留痕缺省判据）。
import { engineConversationUpgradeUnsupportedError } from "./engine/common/capability-gate.ts";
import { DEFAULT_ENGINE_ID } from "./engine/registry.ts";

// ============================================================
// 常量
// ============================================================

/** list 默认 limit。 */
export const DEFAULT_LIST_LIMIT = 20;
/** list limit 上限。 */
export const MAX_LIST_LIMIT = 100;

/** background 启动提示文案（完成通知经自动注入消息投递，agent 不应轮询）。 */
export const BG_MESSAGE = "detached, will notify on completion (auto-injected message, do not poll)";

/** 通知投递契约回显恒值（契约声明；值语义由 execution/notify-ledger.ts 兑现）。 */
export const NOTIFY_CONTRACT = "ledger+at-least-once" as const;

/**
 * fork-from 开场引导语框架（prompt 未指定时注入）：先从继承的历史重建状态
 * 再继续，防猜。
 */
export const FORK_FROM_DEFAULT_PROMPT =
  "You are taking over work from a previous subagent whose full conversation history you inherited (--fork). " +
  "First reconstruct state from that history: list what was already done, decided, and left unfinished (a few bullet lines). " +
  "Then continue the remaining work to completion.";

/**
 * 有显式接续指令时的包裹框架：指令在前、上下文重建要求在后——指令首见即达，
 * 不湮没在元说明里（弱模型友好）。
 */
export function wrapForkFromPrompt(prompt: string): string {
  return (
    prompt.trim() +
    "\n\n(You are continuing a previous subagent's inherited conversation via --fork. " +
    "Reconstruct state from that history first — what was done, decided, and remains — then execute the instruction above.)"
  );
}

// ============================================================
// 入参 / 出参类型
// ============================================================

/** start 入参（拍平后从 tool params 顶层来，task + slug 必填）。
 *  StartHandlerInput 是 SubagentExecuteParams 的子集（13 字段全 optional）；
 *  调用方传整个 params（含 action/listParam/cancelParam），多余字段被忽略。 */
export interface StartHandlerInput {
  task?: string;
  /** 短标签（≤35 字符，kebab-case），必填。 */
  slug?: string;
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** fork 模式：继承主 session 上下文。 */
  fork?: boolean;
  /** worktree 模式：文件系统隔离运行。 */
  worktree?: boolean;
  /** 覆盖子 agent 工作目录（默认 mainCwd）。 */
  cwd?: string;
  /** 可持续对话模式（true = chatMode，轮次完成进 idle 等续聊）。 */
  conversation?: boolean;
  /**
   * 空闲超时毫秒数（仅 conversation 模式有意义，覆盖默认 5min）。
   * 显式传 0/负数 = 禁用 idle GC（不挂 timer）；不传走 env/默认优先级。
   */
  idleTimeoutMs?: number;
  /** 执行引擎（三层路由第一层：本参数 > agent frontmatter engine > config defaultEngine）。 */
  engine?: string;
  /**
   * 同步收集模式（subagent-sync-collect U1 foundation）。undefined = config
   * collectSync.default（缺省 "async"）。schema 层枚举限 "async"|"sync"；运行时
   * 宽收 string 与 engine 字段同风格（pi 工具框架把 schema Static 解析为 string；
   * 非法值 ≠ "sync" 按 async 处理，E4 守卫用精确 "sync" 判定）。透传
   * service.execute（ExecuteOptions.collect；record.collectMode 落点归 U2 接线）。
   */
  collect?: string;
}

/** start 领域对象（宿主 adapter 包成 bg 工具结果）。 */
export type StartHandlerResult = {
  kind: "bg";
  subagentId: string;
  sessionFile: string | undefined;
  /** 短标签，来自 record（handle.details.slug）。用于 result 行展示。 */
  slug: string;
  /**
   * registry 全等回显：handle.details.model = record.model = `${provider}/${id}`，
   * 源头是 resolveModel 裁决放行的条目——通过校验 = 子进程必然按此名执行。
   */
  model: string;
  response: BgResponse;
};

export interface ListHandlerInput {
  includeFinished?: boolean;
  /**
   * [H2 W1，设计 subagent-workflow-record-unification §3.3 D1①] 同时列出 workflow
   * 脚本 agent() 派发的 record（origin="workflow"）。缺省 false——list 默认只展示
   * 手动 tool 派发的 subagent；排查 workflow 子代理时显式传 true。
   */
  includeWorkflow?: boolean;
  limit?: number;
}

/** list 领域对象（宿主 adapter 包成 list 工具结果，最外层 subagentId/sessionFile 为 null）。 */
export interface ListHandlerResult {
  response: ListResponse;
}

export interface CancelHandlerInput {
  subagentId?: string;
}

/** cancel 领域对象（宿主 adapter 包成 cancel 工具结果）。 */
export interface CancelHandlerResult {
  subagentId: string;
  response: CancelResponse;
}

export interface MessageHandlerInput {
  subagentId?: string;
  text?: string;
  interrupt?: boolean;
}

/** message 领域对象（宿主 adapter 包成 message 工具结果）。
 *  slug 来自 record（GUI message 通道的留痕 details 需要），
 *  避免调用方二次 getRecordForAction 查询。 */
export type MessageHandlerResult = {
  kind: "message";
  subagentId: string;
  slug: string;
  response: MessageResponse;
};

export interface CloseHandlerInput {
  subagentId?: string;
  force?: boolean;
}

/** close 领域对象（宿主 adapter 包成 close 工具结果）。 */
export type CloseHandlerResult = {
  kind: "close";
  subagentId: string;
  response: CloseResponse;
};

export interface ForkFromHandlerInput {
  sourceSubagentId?: string;
  prompt?: string;
}

/** fork-from 领域对象（宿主 adapter 包成 fork-from 工具结果）。 */
export type ForkFromHandlerResult = {
  kind: "fork-from";
  /** 新 subagent 的 record id（后续续聊用 action:'message'）。 */
  subagentId: string;
  /** 作为 --fork 继承源的旧记录 session 文件。 */
  sourceSessionFile: string;
  response: ForkFromResponse;
};

// ============================================================
// message 拒绝文案分流（endedMessageGuard）
// ============================================================

/**
 * message 拒绝时的可行动文案分流。
 *
 * 背景：getRecordForAction 冷查只认 status==='running'（可续聊重建），任何终态/
 * 异归属记录都落到同一个「not found or not owned」错误，把两类完全不同的场景混为一谈：
 *   - user-close/cancelled：用户主动告别，记录真没了 → 引导 start 新的
 *   - parent-shutdown/gc/orphan 等：父会话重启/进程退出导致的断联，对话 jsonl 完好，
 *     resume/fork 基建现成 → 引导 fork-from 从旧记录接续
 *
 * 分流规则（消费方是 LLM，保持正交简单）：
 *   - 找不到记录 → 原样透传 getRecordForAction 错误（id 打错最常见，原文案最准）
 *   - closed + user-close/cancelled →「已主动关闭，无法续聊」文案
 *   - 其余（closed 其他 reason / running 但异归属）→「断联可接续」文案
 */
export function endedMessageGuard(service: SubagentService, id: string, original: unknown): Error {
  // 透明重生守卫拒绝（worktree/异进程占用）原样透传——错误自带完整行动语言，
  // 若被下方 fork-from 指引改写会误导 agent 走已被判死的通道（types.ts 契约声明）。
  if (original instanceof ResurrectDeniedError) return original;
  let snap: SubagentRecord | undefined;
  try {
    snap = service.queries.lookupRecordAnyState(id);
  } catch {
    snap = undefined;
  }
  if (!snap) {
    return original instanceof Error ? original : new Error(String(original));
  }
  if (snap.status === "closed") {
    if (snap.closedReason === "cancelled" || snap.closedReason === "user-close") {
      return new Error(
        `subagent ${id} was deliberately closed by user (closedReason: ${snap.closedReason}) — ` +
        `it cannot be messaged or resumed; nothing can reattach to it. ` +
        `Recovery: start a new subagent (action:'start'); use action:'list' with includeFinished:true to review its final output (add includeWorkflow:true to also see workflow-dispatched subagents).`,
      );
    }
    return new Error(
      `subagent ${id} is ended but reconnectable (closedReason: ${snap.closedReason ?? "unknown"}` +
      `${describeClosedContext(snap)}). Its conversation history is intact at ${snap.sessionFile ?? "(session file unavailable)"}. ` +
      `Recovery: resume from that history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"${id}"}}, ` +
      `or read key points directly from the session file.`,
    );
  }
  // running 但未通过 getRecordForAction：记录属于当前进程外的另一个 session 树
  //（主会话重启前的遗留态，或其他并发进程的活跃 subagent）。无论哪种，历史
  // jsonl 只读安全，fork-from 快照接续均有效。
  return new Error(
    `subagent ${id} is alive but belongs to a different session tree than this one` +
    `${describeClosedContext(snap)}. You cannot message it from here. ` +
    `Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"${id}"}}` +
    `${snap.sessionFile ? ` (source session: ${snap.sessionFile})` : ``}; otherwise start a new subagent.`,
  );
}

/** 终态快照的上下文人话短语（仅作补充描述，主分支逻辑在 endedMessageGuard）。 */
function describeClosedContext(r: SubagentRecord): string {
  switch (r.closedReason) {
    case "parent-shutdown":
      return " — it was disconnected when the previous parent session exited";
    case "parent-fork":
      return " — it was detached when the previous parent session forked";
    case "parent-new":
      return " — it was detached when the previous parent session switched";
    case "disconnected":
      return " — it ended in a previous session (exact cause unknown)";
    default:
      return "";
  }
}

// ============================================================
// 终态映射 / list 投影
// ============================================================

/** exhaustiveness 兜底：default 分支把 status 收敛为 never，ExecutionStatus 加态时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/**
 * 内部 ExecutionStatus → 对外 state 映射（设计决策 10 细则 3）。
 * 两态收敛后的真实映射只有两条：
 *   running → active / closed → ended（closed 统一终态，含 cancelled）
 * ExternalState 即两态联合（历史 waiting/error 死值成员已随 L2 清扫删除）。
 * 未来内部加态必须扩展此处，漏加会在 default 分支编译报错（而非静默返回 undefined
 * 让 state 字段以无主值进入 listResponse JSON）。
 */
export function mapExternalState(status: ExecutionStatus): ExternalState {
  switch (status) {
    case "running":
      return "active";
    case "closed":
      // closed 统一终态（含 cancelled）。对外映射为 ended。
      return "ended";
    default:
      throw new Error(`mapExternalState: unhandled ExecutionStatus ${assertNever(status)}`);
  }
}

/** SubagentRecord → SubagentListItem（state 两态主字段 + status 调试字段，duration 实时计算）。
 *  parent 从 record.parentRecordId 派生（配合直接父守卫），resumable 从 isResumable 派生
 *  （「可续聊」对外表达）；outcome 一等终态语义（projectOutcome 唯一出口），closedReason
 *  退出对外 JSON（保留为 record 内部诊断字段），对外成败判读收口到 outcome。
 *  agent 是 GUI/TUI list 共用的显示名——取 basename 短名（displayAgentName），
 *  完整路径保留在 record.agent（数据层）。 */
export function recordToListItem(r: SubagentRecord): SubagentListItem {
  return {
    subagentId: r.id,
    agent: displayAgentName(r.agent),
    slug: r.slug,
    state: mapExternalState(r.status),
    status: r.status,
    mode: r.mode,
    duration: computeElapsedSeconds(r),
    model: r.model,
    totalTokens: r.totalTokens,
    sessionFile: r.sessionFile,
    parent: r.parentRecordId,
    resumable: isResumable(r),
    outcome: projectOutcome(r),
  };
}

// ============================================================
// start handler
// ============================================================

export async function startHandler(
  service: SubagentService,
  input: StartHandlerInput | undefined,
  signal: AbortSignal | undefined,
  ctxModel?: ModelInfo,
): Promise<StartHandlerResult> {
  if (!input) throw new Error(
    "action:'start' requires task and slug (top-level fields). " +
    'Correct: {"action":"start","task":"<your task>","slug":"<kebab-case>"}',
  );
  // task 必填 + 空白校验
  const task = input.task?.trim();
  if (!task) throw new Error(
    "task is required for action:'start' (top-level field, must not be whitespace-only). " +
    'Correct: {"action":"start","task":"...","slug":"..."}',
  );
  // slug 必填 + 空白校验 + 长度校验（≤ SLUG_MAX_LENGTH 字符）
  const slug = input.slug?.trim();
  if (!slug) throw new Error(
    "slug is required for action:'start' (top-level field, must not be whitespace-only). " +
    'Correct: {"action":"start","task":"...","slug":"<kebab-case>"}',
  );
  if (slug.length > SLUG_MAX_LENGTH) throw new Error(`slug must be ≤${SLUG_MAX_LENGTH} chars (got ${slug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`);

  // ── collect 解析（subagent-sync-collect）──
  // resolved = 显式参数 ?? config collectSync.default（U2 偏差#3 接线：经 service
  // 公开访问器读真实 config，内部 DEFAULT 兑底——config 未配/读失败不炸）。
  // E4 守卫放在 resolved 之后：显式 collect:"sync" + conversation 即拒；config 默认
  // sync + conversation 同样被拦（同一守卫，无需改判定）。
  const resolvedCollect = input.collect ?? service.getCollectSyncDefault();
  // E4（设计 §3.1.5）：sync 仅支持 one-shot。immediate throw——校验先于 service.execute，
  // 不产生半启动 record（与 skillPath 路径守卫同风格：参数语义校验前置）。
  if (input.conversation === true && resolvedCollect === "sync") {
    throw new Error(
      'collect:"sync" only supports one-shot subagents — it cannot be combined with conversation:true. ' +
      'Remove either conversation or collect (use collect:"async", or omit it, for conversational subagents).',
    );
  }

  const handle = await service.execute({
    task,
    slug,
    agent: input.agent,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    skillPath: input.skillPath,
    appendSystemPrompt: input.appendSystemPrompt,
    schema: input.schema,
    maxTurns: input.maxTurns,
    graceTurns: input.graceTurns,
    fork: input.fork,
    worktree: input.worktree,
    cwd: input.cwd,
    conversation: input.conversation,
    idleTimeoutMs: input.idleTimeoutMs,
    engine: input.engine,
    // B1（code-simplify 审查发现的行为缺口）：config collectSync.default=sync 且调用方
    // 省略 collect 时，record 本体也要落 sync（设计 §3.1.3「缺省 = config 默认」作用于
    // record，而非仅回显）——createRecordForMode 只认 opts.collect==="sync"，原样透传
    // input.collect 会让 record 走 async 逐条通知而响应声称已入批。仅 sync 落值：
    // async/缺省路径传 undefined 语义（旧 record 零迁移）字节不变。
    collect: resolvedCollect === "sync" ? "sync" : input.collect,
    ctxModel,
    signal,
    // background detached 运行，完成由 notify 驱动新 turn。
  });

  const response: BgResponse = {
    status: "running",
    mode: "background",
    message: BG_MESSAGE,
    notifyContract: NOTIFY_CONTRACT,
  };
  // 同步收集登记回显段（设计 §3.1.1）：仅 resolved 为 sync 时附段——async 响应
  // 字节零变化（G3）。pendingSyncCount = 未闭合批 sync 成员总数（含本条，跨轮续累）。
  // 本条 record 已由 createRecordForMode 落 collectMode（U2 偏差#4 接线），
  // 枚举天然含本条，无需补偿。
  if (resolvedCollect === "sync") {
    response.collect = { mode: "sync", pendingSyncCount: countPendingSyncRecords(service) };
  }

  return {
    kind: "bg",
    subagentId: handle.subagentId,
    sessionFile: handle.sessionFile,
    slug: handle.details.slug,
    // registry 全等回显：record.model 由 resolved（裁决放行条目）拼接，原样透出。
    model: handle.details.model,
    response,
  };
}

/**
 * 当前未闭合批的 sync 成员计数（pendingSyncCount 口径，设计 §3.1.3）：本进程全部
 * record（含已终态未 flush 的缓冲成员，故 statusFilter="all"）中 collectMode="sync"
 * 且无 batchFinalized 标记的数量。含调用方刚启动的本条（record 已带 collectMode 入
 * 枚举——U2 偏差#4 接线）。
 *
 * 扫描上限与 service 冷路径全扫兑底同量级；常量用本 feature 已导出的
 * COLLECT_SCAN_LIMIT（collect 域扫描上限单点定义，S4 code-simplify）。
 */
function countPendingSyncRecords(service: SubagentService): number {
  let count = 0;
  for (const r of service.queries.collectRecords(COLLECT_SCAN_LIMIT, "all")) {
    if (r.collectMode === "sync" && r.batchFinalized !== true) count += 1;
  }
  return count;
}

// ============================================================
// list handler
// ============================================================

/**
 * list 数据源（诚实声明）：
 * collectRecords(limit, statusFilter, includeWorkflow) 合并内存(running) + 磁盘(重建)。
 * 磁盘源天然跨 session 可见——/new /resume /fork 后前 session 的终态 record 仍在
 * sessions 目录里（直到 GC）。内存源仅当前 session 的 running record。
 * [H2 W1] origin==="workflow" 的 record 默认过滤（D1①），includeWorkflow:true 放行。
 */
export function listHandler(
  service: SubagentService,
  input: ListHandlerInput | undefined,
): ListHandlerResult {
  const includeFinished = input?.includeFinished === true;
  const includeWorkflow = input?.includeWorkflow === true;
  // limit 夹紧：下限 1，上限 MAX_LIST_LIMIT
  const rawLimit = input?.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));

  // collectRecords 是 service 核心能力：statusFilter 决定 running-only 还是全部。
  // 防截断（先多取再过滤）已下沉到 store 层——这里直接传 limit + filter。
  const filter = includeFinished ? "all" : "running";
  const all = service.queries.collectRecords(limit, filter, includeWorkflow);
  // collectRecords 磁盘源是 light（无 totalTokens/model 等）：SubagentListItem 对
  // LLM 消费方暴露 totalTokens/model，逐项 getFullRecord 补全（per-file 缓存，仅首次
  // 全量解析；显式 tool 调用非渲染热路径，成本可接受）。
  const items: SubagentListItem[] = all.map((r) =>
    recordToListItem(service.queries.getFullRecord(r.id) ?? r),
  );
  const running = items.filter((i) => i.status === "running").length;

  return { response: { running, items } };
}

// ============================================================
// cancel handler
// ============================================================

export async function cancelHandler(
  service: SubagentService,
  input: CancelHandlerInput | undefined,
): Promise<CancelHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("cancelParam.subagentId is required for action:'cancel'");

  // step 1: id 不存在（findRecord 只查内存 running record，不从 session.jsonl 重建）
  const rec = service.queries.findRecord(id);
  if (!rec) {
    // 全树可见后，list/completion 可能列出其他进程（父/兄弟）的 running record
    //（collectRecords 扫共享 sessionsDir 按 rootSessionId 过滤，跨进程互相可见），而 cancel
    // 只作用于本进程内存 record。区分两种失败，避免「may have finished」误导（该 record 正
    // 被列出且未 finished，只是不属于本进程内存）。仅文案区分，不改 cancel 作用域。
    const treeRec = service.queries.collectRecords(DEFAULT_LIST_LIMIT, "all").find((r) => r.id === id);
    if (treeRec && treeRec.status === "running") {
      throw new Error(
        `Subagent record "${id}" is running but owned by another process in the tree ` +
          `(it was spawned by a different subagent process) — this process cannot cancel it; ` +
          `cancel only works for subagents spawned by the current process.`,
      );
    }
    throw new Error(`No subagent record with id "${id}". It may have finished — use action:'list' with includeFinished:true to verify (add includeWorkflow:true to also see workflow-dispatched subagents).`);
  }
  // step 2: controller 检查（controller 为 undefined 表示 record 已终态或未启动）
  if (rec.mode !== "background") {
    throw new Error(`Cannot cancel subagent ${id} (unsupported mode: ${rec.mode})`);
  }
  // 对话模式 cancel = close(force:true) 别名：chatMode record（running/idle）
  // 走 close 行为路径（idle 终态化 done；running 立即 SIGTERM cancelled），
  // 返回 cancel 响应（向后兼容 cancel action 的返回类型）。非 chatMode 保持现有 cancel 行为。
  if (rec.chatMode) {
    const chatRecord = service.chatActions.getRecordForAction(id);
    await service.chatActions.closeSubagent(chatRecord, true);
    return { subagentId: id, response: { cancelled: true } };
  }
  // step 3: service.cancel boolean（list-view 契约不变）；false = 已终态（CAS 抢锁失败）。
  // 注意：不嵌入 rec.status——findRecord 快照可能已过期（TOCTOU：cancel 期间 detached
  // 路径 CAS 到 done/failed）。重新查当前状态，避免「status: running」与「already finished」矛盾。
  if (!service.cancel(id)) {
    // CAS 失败 = record 在 cancel 期间被 detached 路径 finalize（done/failed）。
    // re-query 查当前真实状态。终态 record 被 archive 立即移出内存，
    // 诚实报告 "unknown (evicted from memory)" 而非回落到可能过期的 rec.status。
    const now = service.queries.findRecord(id);
    const statusDesc = now ? now.status : "unknown (evicted from memory)";
    throw new Error(`Subagent ${id} could not be cancelled (it likely just finished; status: ${statusDesc})`);
  }
  return { subagentId: id, response: { cancelled: true } };
}

// ============================================================
// message handler（对话模式续聊/插入）
// ============================================================

/**
 * message action handler：向对话模式 subagent 续聊/插入消息。
 *
 * [H1 U6] 状态分流面收敛：running → Continuation 派发新轮（新 run + resume 锚点）；
 * 在途轮存在 → D2 打断（abort + 入队）；终态 → throw ended（正常路径不命中——终态
 * record 已 archive，getRecordForAction 先 throw not found）。interrupt 输入字段保留
 *（[A4] 工具 schema 兼容面——extensions subagent-tool-schema 仍声明该字段）但不参与
 * 分派（D2 统一打断语义）。
 *
 * 归属守卫：getRecordForAction 内部校验 rootSessionId。
 *
 * @throws Error subagentId/text 缺失 / 不存在或非本 session 所有 / 已结束
 */
export async function messageHandler(
  service: SubagentService,
  input: MessageHandlerInput | undefined,
): Promise<MessageHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("messageParam.subagentId is required for action:'message'");
  const text = input?.text?.trim();
  if (!text) throw new Error(
    "messageParam.text is required for action:'message' (must not be whitespace-only). " +
    'Correct: {"action":"message","messageParam":{"subagentId":"sa-...","text":"your follow-up"}}',
  );

  // 归属守卫：getRecordForAction 内部校验 rootSessionId。
  // 拒绝时经 endedMessageGuard 分流：找不到 → 原错误；user-close/cancelled
  // → 「已主动关闭」；断联/已完成/异归属 → fork-from 可行动指引。仅 message action
  // 升级文案——close/cancel 维持原语义（它们不需要恢复通道）。
  let record: ExecutionRecord;
  try {
    record = service.chatActions.getRecordForAction(id, { allowReconnect: true });
  } catch (err) {
    throw endedMessageGuard(service, id, err);
  }

  // one-shot upgrade：非 chatMode 的 active record（running/idle）收到 message 时
  // 自动升级为 chatMode，后续走 Continuation 统一续聊路径（新 run + resume 锚点）。
  // closed/cancelled 终态 record 不可 upgrade（getRecordForAction 已抛 not found）。
  // chatMode 是 ExecutionRecord 的 readonly 字段，用 Mutable<T> 显式断言绕过 readonly 约束（upgrade 语义）。
  // Object.assign 隐式绕过 readonly 不可追踪，改为单字段显式赋值。
  // 进程内 upgrade 入口——one-shot 首条 message 触发 upgrade 置位 chatMode=true。
  // 与 conversation-continuation 的 D4 revive 格（跨重启冷升级写点②）分工协同：
  // 本入口服务进程内 one-shot，跨重启路径恒被 getRecordForAction 磁盘重建绕过
  //（该处经 Continuation revive 格 gate 化）。改动这两处必须协同。
  // [H1 U2 / D5 双写点①] 升级前置 gate：conversation 位检查——unsupported 引擎
  //（zcode）的 one-shot 收到 message 不升级（升级后续聊行为悬空），硬拒 + fork/重派
  // 指引（engineConversationUpgradeUnsupportedError 文案单源）。
  if (!record.chatMode && record.status === "running") {
    if (!service.canUpgradeToConversation(record)) {
      throw engineConversationUpgradeUnsupportedError(record.engine ?? DEFAULT_ENGINE_ID);
    }
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    (record as Mutable<ExecutionRecord>).chatMode = true;
  }

  // chatMode 统一投递：Continuation 编排（§3.4——D4 状态迁移表 / D2 打断语义）。
  // [H1 U6] 旧「进程死活分流热/冷路径」消亡（每轮 = 新 run + resume 锚点），
  // interrupt 参数随 D2 打断统一语义退役（在途轮存在即打断入队，不区分抢占/排队）。
  if (record.chatMode) {
    await service.chatActions.deliverChatMessage(record, text);
  } else {
    // 终态（closed/cancelled）：防御性兜底（终态 record 已 archive，正常走 not found）
    throw new Error(
      `subagent ${id} has ended (status: ${record.status}), cannot message. ` +
      `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
    );
  }
  return { kind: "message", subagentId: id, slug: record.slug, response: { delivered: true } };
}

// ============================================================
// close handler（对话模式结束）
// ============================================================

/**
 * close action handler：结束 subagent（对话模式为主，one-shot 同样支持）。
 *
 * force 语义（设计决策 5/10）：
 *   force:false（默认）= 优雅关闭——
 *     无在跑轮（等待续聊 timer armed / 无活进程）→ 立即终态化（closed + user-close，回收保活进程）
 *     有活进程在跑轮 → 置 closeAfterRound，轮完成时终态化——返回 {closed:true} 即承诺轮结束后资源已释放
 *   force:true = 立即终止——running 立即 SIGTERM（cancelBackground 显式 kill）+ closed+cancelled
 *
 * 行为分流委托 chatActions.closeSubagent（归属守卫由 chatActions.getRecordForAction 把关）。
 * 已终态 record 由 getRecordForAction throw not found（「已结束的不能再操作」语义）。
 */
export async function closeHandler(
  service: SubagentService,
  input: CloseHandlerInput | undefined,
): Promise<CloseHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("closeParam.subagentId is required for action:'close'");
  const force = input?.force === true;

  // 归属守卫（决策 3）+ 行为分流（chatActions.closeSubagent）
  const record = service.chatActions.getRecordForAction(id);
  await service.chatActions.closeSubagent(record, force);

  return { kind: "close", subagentId: id, response: { closed: true } };
}

// ============================================================
// fork-from handler（断联恢复通道）
// ============================================================

/**
 * fork-from action handler：从旧 subagent 的会话历史 spawn 新 id 接续。
 *
 * 用于 subagent 因会话重启/进程退出而断联后的恢复：新进程以 --fork 指向旧 session
 * 文件（copy-on-write 建分支会话），继承全部对话历史；源文件只读不续写。
 * 旧记录本身不动——closed 单向状态机不变量、tryTransition 语义均不触碰。
 *
 * 守卫链（拒绝原因与行动语言对齐，见 assertAndLookupForkFromSource）：
 *   1. 本进程内存 running → 还活着，应走 message（防双写同一子 session 文件）
 *   2. 不存在            → 引导 list 确认
 *   3. 异进程活跃         → 别处正跑，不可从此接续（同 id 双写风险；等其结束或在其所属会话内操作）
 *   4. cancelled/user-close → 用户主动告别，真没了（不提供接续通道）
 *   5. worktree 记录     → checkout 不可复用，fork 子进程 cwd 会回落主仓破坏隔离
 *   6. 无子 session 文件  → 无历史可继承（entry-only 孤儿：spawn 窗口期中断）
 *
 * @throws Error 各守卫命中 / service.execute 失败（引擎不支持等）
 */
export async function forkFromHandler(
  service: SubagentService,
  input: ForkFromHandlerInput | undefined,
): Promise<ForkFromHandlerResult> {
  const id = input?.sourceSubagentId?.trim();
  if (!id) throw new Error("forkFromParam.sourceSubagentId is required for action:'fork-from'");
  const prompt = input?.prompt?.trim() ?? "";
  const task = prompt ? wrapForkFromPrompt(prompt) : FORK_FROM_DEFAULT_PROMPT;

  const source = assertAndLookupForkFromSource(service, id);

  // slug 派生：源 slug + -resumed 后缀（截断到上限）。仅展示标签，不需唯一。
  const baseSlug = (source.slug || source.agent || "resumed").slice(0, SLUG_MAX_LENGTH - "-resumed".length);
  const handle = await service.execute({
    task,
    slug: `${baseSlug}-resumed`,
    forkFromSessionFile: source.sessionFile,
  });

  return {
    kind: "fork-from",
    subagentId: handle.subagentId,
    sourceSessionFile: source.sessionFile,
    response: { newSubagentId: handle.subagentId, sourceSessionFile: source.sessionFile },
  };
}

/** forkFromHandler 的守卫链（fork-from handler doc 的守卫 1–6 原样提取）：按序校验
 *  源记录可接续，命中即抛带行动语言的 Error；全部通过则返回源 SubagentRecord
 *  （守卫 6 已保证 sessionFile 非空，返回类型随之收窄）。 */
function assertAndLookupForkFromSource(service: SubagentService, id: string): SubagentRecord & { sessionFile: string } {
  // 守卫 1：本进程内存 running —— 直接 message 即可，fork-from 会双写其 session 文件。
  if (service.queries.findRecord(id)) {
    throw new Error(
      `subagent ${id} is still active in this process — use action:'message' to continue it directly. ` +
      `If you want a parallel branch from its history, close it first (action:'close'), then fork-from.`,
    );
  }

  // 守卫 2：全态查找（内存 archived + 磁盘重建）。
  const source = service.queries.lookupRecordAnyState(id);
  if (!source) {
    throw new Error(
      `No subagent record with id "${id}". It may never have existed or been garbage-collected — ` +
      `use action:'list' with includeFinished:true to verify the id (add includeWorkflow:true to also see workflow-dispatched subagents).`,
    );
  }

  // 守卫 3：异进程活跃（.alive 侧车指向另一进程的活 pid）。
  // 双写防护：fork 虽 copy-on-write（历史 jsonl 只读），但源仍在异进程运行时接续容易
  // 读到半截历史，等它结束再接更安全。判据 = findForeignLiveInstance 直接探针（同
  // cold-lookup 双守卫判据；[U4b / D3b (a′)] 原读 rec.externalInstance 重建缓存换现查
  // 探针——语义等价（externalInstance 非空 ⟺ 探针非空）且比重建时点缓存更新鲜；
  // externalInstance 字段链已随 U4a 删除），不拦 status==='running' 的快照——后者含跨重启
  // 回退重建的 running 记录（无活 pid，历史已完整落盘），它们正是 endedMessageGuard
  // 指引 fork-from 的目标；拦了会让 agent 在「建议 fork-from」与「fork-from 拒绝
  // running」两条错误间死循环。sessionFile 缺失（entry-born 孤儿）时无从探活，
  // 天然无 foreign 声明，落守卫 6 处置。
  if (source.sessionFile !== undefined && findForeignLiveInstance(source.sessionFile) !== undefined) {
    throw new Error(
      `subagent ${id} is still running in another process (alive pid marker present). ` +
      `Recovery: wait until it finishes, or operate it in its own session; then retry fork-from.`,
    );
  }

  // 守卫 4：主动告别（cancelled tombstone / user-close 正式关闭）——close 语义无旁路：
  // fork-from 与 message 一致拒绝（guard 一致性规格），文案升级为统一「主动关闭」形态
  //（含 closedReason 显式列入），与 deliverChatMessage 的同类分支同语系不同落地（此处强调不可 branch）。
  if (source.status === "closed" && (source.closedReason === "cancelled" || source.closedReason === "user-close")) {
    throw new Error(
      `subagent ${id} was deliberately closed by user (closedReason: ${source.closedReason}) — ` +
      `deliberately-closed records cannot be resumed or branched from; nothing can reattach to them. ` +
      `Recovery: start a fresh subagent (action:'start'); use action:'list' with includeFinished:true to review its final output (add includeWorkflow:true to also see workflow-dispatched subagents).`,
    );
  }

  // 守卫 5：worktree 记录 —— WorktreeHandle 不可序列化，checkout 已被 reaper/cleanup
  // 回收；fork 子进程若复用旧路径会回落主 repo（破坏文件隔离）。与 deliverChatMessage 的
  // hadWorktree 守卫同一判据同一理由。
  if (source.worktree === true) {
    throw new Error(
      `subagent ${id} was created with worktree isolation; that binding was lost when its parent process ended. ` +
      `Resuming from its history would run outside the original worktree isolation. ` +
      `Recovery: start a new subagent with action:'start' and carry over key findings manually ` +
      `(read ${source.sessionFile ?? "its session file"} if needed).`,
    );
  }

  // 守卫 6：无子 session 文件（entry-born 孤儿：spawn 窗口期中断，从未开跑）。
  const sessionFile = source.sessionFile;
  if (!sessionFile) {
    throw new Error(
      `subagent ${id} has no child session file to inherit from (it never started successfully). ` +
      `Recovery: start a fresh subagent (action:'start') describing the task again.`,
    );
  }

  return { ...source, sessionFile };
}

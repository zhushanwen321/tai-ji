// src/execution/assembly/subagent-actions-core.ts
//
// subagent tool 六 handler 的领域内核（校验 / 守卫链 / 归属判定 / 终态映射）。
//
// 来源：pi-sw `src/interface/subagent-actions.ts` 的零 pi-API 部分原样下沉
//（sink 设计 docs/design/subagent-core-sink-design.md（已删，git 可追溯） §3.3 D6② / U10②；
// ⛔4 行为快照等值测试见 __tests__/subagent-actions-core.test.ts——期望值
// 硬编码自迁移前 pi-sw 实现的实测输出，含错误文案锚）。
//
// 分层：本模块产出**领域对象**（StartHandlerResult / ListHandlerResult / ...），
// 不感知 {content, details} 包装与 TUI/GUI 渲染——宿主 adapter 负责把领域对象
// 包成工具结果（pi 侧收缩为「参数提取 + core 调用 + TUI 渲染」）。
//
// 平台中立性：全部错误文案 / 提示文案面向 LLM（行动语言），无宿主专属词汇，
// 文案内聚本模块（文案即行为，⛔4 逐字锚定）。

import { findForeignLiveInstance } from "../persistence/alive-store.ts";
// [U4 / §3.2.3] 锚可解析性判据（三件套判据一单点，cold-lookup 导出）——fork-from
// 守卫 5 的「锚不可解析 → 引导 reopen」分流消费。
import { isAnchorResolvable } from "./cold-lookup.ts";
import { computeElapsedSeconds, projectOutcome } from "../persistence/execution-record.ts";
import { SLUG_MAX_LENGTH } from "../../orchestration/models/types.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { SubagentService } from "../subagent-service.ts";
import { displayAgentName } from "../../shared/agent-ref.ts";
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
// [modeless 波1] message 资格 gate 的错误构造（文案/错误码/恢复指引单一权威，与
// Continuation revive 翻边格写点②共用）+ 默认引擎 id（engine 留痕缺省判据）。
import { engineConversationMessageUnsupportedError } from "../engine/common/capability-gate.ts";
import { DEFAULT_ENGINE_ID } from "../engine/registry.ts";

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
  /**
   * 空闲超时毫秒数（全 record 生效的 idle GC 节奏，覆盖默认 5min）。
   * 显式传 0/负数 = 禁用 idle GC（不挂 timer）；不传走 env/默认优先级。
   */
  idleTimeoutMs?: number;
  /** 执行引擎（三层路由第一层：本参数 > agent frontmatter engine > config defaultEngine）。 */
  engine?: string;
  // [collect 退役] 原 collect 字段（sync 批通知路由选项）已随 collect 批机制整体删除：
  // pi 对未知字段静默放行（typebox 无 additionalProperties），存量调用形态的 collect
  // 值到达此处即被忽略——批量编排走 `subagents` tool（fan-out 模板），完成通知恒为
  // 逐条 async 投递。
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
   * [R4/D6-① 连带] undefined = 用户未指定模型（引擎自身缺省解析），缺席如实回显。
   */
  model: string | undefined;
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
// message 拒绝文案分流（endedMessageGuard，[U4] 缩型）
// ============================================================

/** [U4 / §3.2.3] 异进程占用的统一拒绝文案句式（设计 §3.1 唯一拒绝形态：错误 →
 *  权威源 → 重试闭环）。 */
export function foreignLiveInstanceMessage(id: string, pid: number, sessionFile: string | undefined): string {
  return (
    `subagent ${id}: another process (pid ${pid}) is writing this session` +
    `${sessionFile ? ` (${sessionFile})` : ""}; close it or wait for it to exit, then retry.`
  );
}

/**
 * message 拒绝时的可行动文案分流（[U4 / §3.2.3 万物可续] 缩型）。
 *
 * [U4] 形态枚举分流消亡：旧七种文案（deliberately closed / reconnectable+fork-from
 * 指引 / 异树 fork-from 指引）随「万物可续」删除——任何 idle record（无论旧终态
 * 遗留位 closedReason 为何值）都可同 id 续聊；锚失效不拒绝，走 markReopened 自动
 * 带历史重开（reopen 降级，§3.2.3——无需用户操作）。剩余可达拒绝面收敛为：
 *   1. ResurrectDeniedError（worktree 绑定丢失 / 异进程活实例）→ 原样透传（自带
 *      pid/恢复指引——占用拒绝即唯一真实拒绝形态）；
 *   2. 记录不存在（id 打错）→ 原样透传 not found；
 *   3. 归属不匹配（跨 session 树 / 跨层）→ 归属判据文案（§3.2.3 判据三，非形态枚举）。
 * 兜底分支（理论不可达）附「重发 message 会自动带历史重开」的降级说明，保证
 * 锚失效场景的文案自解释。
 */
export function endedMessageGuard(service: SubagentService, id: string, original: unknown): Error {
  // 透明重生守卫拒绝（worktree/异进程占用）原样透传——错误自带完整行动语言。
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
  // 异进程活实例复检（findColdLookupCandidate 探针后、endedMessageGuard 前的窗口内
  // marker 被异进程重写，或内存快照路径未过冷查探针）→ 统一占用拒绝句式。
  if (snap.sessionFile !== undefined) {
    const foreign = findForeignLiveInstance(snap.sessionFile);
    if (foreign) {
      return new Error(foreignLiveInstanceMessage(id, foreign.pid, snap.sessionFile));
    }
  }
  // 归属不匹配（跨 session 树 / 跨层）：判据 = record 全态可查但 getRecordForAction
  // 抛「not found or not owned」（归属校验拒绝的唯一文案形态）。历史 jsonl 只读安全
  // ——跨树场景保留 fork-from 分叉指引（fork-from = 历史在分叉新 id，与 reopen 的
  // 「历史亡同 id 重启」语义分野）。
  const originalMsg = original instanceof Error ? original.message : String(original);
  if (originalMsg.includes("not found or not owned")) {
    return new Error(
      `subagent ${id} belongs to a different session tree than this one` +
      `${describeSessionTreeContext(snap)}. You cannot message it from here. ` +
      `Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"${id}"}}` +
      `${snap.sessionFile ? ` (source session: ${snap.sessionFile})` : ``}; otherwise start a new subagent.`,
    );
  }
  // 兜底（理论不可达——冷查准入全放行后，本进程可达 record 不再产生形态拒绝）：
  // 附 reopen 自动降级说明，保证锚失效场景文案自解释。
  return new Error(
    `${originalMsg} ` +
    `Note: if this subagent's transcript was collected (retention expired), re-sending the message ` +
    `(action:'message') automatically reopens it on the same id with a history summary injected — no manual step needed.`,
  );
}

/** 跨树快照的上下文人话短语（仅作补充描述，主分支逻辑在 endedMessageGuard）。 */
function describeSessionTreeContext(r: SubagentRecord): string {
  return r.rootSessionId !== undefined ? ` (rootSessionId: ${r.rootSessionId})` : "";
}

// ============================================================
// 终态映射 / list 投影
// ============================================================

/** exhaustiveness 兜底：default 分支把 status 收敛为 never，ExecutionStatus 加态时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/**
 * 内部 ExecutionStatus → 对外 state 映射（永久会话模型两态，U2 迁移）。
 * 真实映射只有两条：
 *   running → active / idle → idle（永久会话无 ended 形态——空闲即可续聊；旧
 *   closed→ended 映射随终态概念删除，「上一轮为什么停」经 stopReason 披露，U8 投影面）。
 * ExternalState 即两态联合。
 * 未来内部加态必须扩展此处，漏加会在 default 分支编译报错（而非静默返回 undefined
 * 让 state 字段以无主值进入 listResponse JSON）。
 */
export function mapExternalState(status: ExecutionStatus): ExternalState {
  switch (status) {
    case "running":
      return "active";
    case "idle":
      // 已收口/等续聊。对外映射为 idle（可续聊语义，替代旧 ended）。
      return "idle";
    default:
      throw new Error(`mapExternalState: unhandled ExecutionStatus ${assertNever(status)}`);
  }
}

/** SubagentRecord → SubagentListItem（state 两态主字段 + status 调试字段，duration 实时计算）。
 *  parent 从 record.parentRecordId 派生（配合直接父守卫）；[U5/D4] resumable 字段已
 *  退役（idle 即可续聊，state 主字段已并存表达）；outcome 一等终态语义（projectOutcome
 *  唯一出口），closedReason 退出对外 JSON（保留为 record 内部诊断字段），对外成败判读
 *  收口到 outcome。
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
    outcome: projectOutcome(r),
    origin: r.origin,
    parentRunId: r.parentRunId,
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
    idleTimeoutMs: input.idleTimeoutMs,
    engine: input.engine,
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
  // [collect 退役] 原 sync 路由登记回显段（response.collect）已随批机制删除——
  // 完成通知恒为逐条 async 投递。

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
  // [modeless 波1] cancel 语义统一：cancel = 打断在飞轮 + settle interrupted（record
  // 留 idle 可续聊，不收口——旧 chatMode record 的 close(force:true) 别名分支随
  // chatMode 消亡删除：cancel 不是收口动作，收口落账归 close action）。
  // step 3: service.cancel boolean（list-view 契约不变）；false = 已终态（CAS 抢锁失败）。
  // 注意：不嵌入 rec.status——findRecord 快照可能已过期（TOCTOU：cancel 期间 detached
  // 路径 CAS 到 done/failed）。重新查当前状态，避免「status: running」与「already finished」矛盾。
  if (!service.cancel(id)) {
    // CAS 失败 = record 在 cancel 期间被 detached 路径 finalize（done/failed）。
    // re-query 查当前真实状态。终态 record 被 archive 立即移出内存，
    // 诚实报告 "unknown (evicted from memory)" 而非回落到可能过期的 rec.status。
    const now = service.queries.findRecord(id);
    const statusDesc = now ? now.status : "unknown (evicted from memory)";
    throw new Error(
      `Subagent ${id} could not be cancelled (it has no in-flight round; status: ${statusDesc}). ` +
      `For an idle record use action:'close' to archive it, or action:'message' to continue it.`,
    );
  }
  return { subagentId: id, response: { cancelled: true } };
}

// ============================================================
// message handler（对话模式续聊/插入）
// ============================================================

/**
 * message action handler：向对话模式 subagent 续聊/插入消息。
 *
 * [U4 / §3.2.3 万物可续] 状态分流面收敛：任何非 workflow-origin record 的 message
 * 都放行——idle → Continuation 派发新轮（锚失效自动 markReopened 降级，同 id 带
 * 历史重开）；在途轮存在 → D2 打断（abort + 入队）。真实拒绝面（三类）：异进程占用
 *（ResurrectDeniedError 含 pid）/ 归属不匹配 / workflow 域边界（results are collected
 * by the workflow run——一次性成员不可续聊，重派走 `subagents` tool）。interrupt 输入字段
 * 保留（[A4] 工具 schema 兼容面——extensions subagent-tool-schema 仍声明该字段）但
 * 不参与分派（D2 统一打断语义）。
 *
 * 归属守卫：getRecordForAction 内部校验 rootSessionId + 直接父。
 *
 * @throws Error subagentId/text 缺失 / 不存在或非本 session 所有 / workflow 域边界
 * @throws ResurrectDeniedError 异进程占用（唯一占用拒绝形态，文案含 pid）
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

  // 归属守卫：getRecordForAction 内部校验 rootSessionId + 准入三件套（[U4 / §3.2.3]
  // 万物可续——任何 idle record 均可续聊，形态枚举 gate 消亡）。
  // 拒绝时经 endedMessageGuard 分流：找不到 → 原错误；异进程占用 → 含 pid 占用拒绝；
  // 跨 session 树 → 归属判据 + fork-from 指引。
  let record: ExecutionRecord;
  try {
    record = service.chatActions.getRecordForAction(id, { allowReconnect: true });
  } catch (err) {
    throw endedMessageGuard(service, id, err);
  }

  // [U4 / §1.4 D7 域边界] workflow-origin record 不进 message 通道：workflow agent
  // 结果由脚本返回值承载、无 message 对端（run-orchestration settleOneShotOutcome
  // D7 例外注释的四面连带——「被误升级为对话容器」正是本守卫承接的面）。origin 是
  // 记录的真实身份维度（非「以什么方式结束」的形态枚举），此拒绝不属万物可续的
  // 形态 gate 残留。
  if (record.origin === "workflow") {
    throw new Error(
      `subagent ${id} is a workflow-origin record — it is managed by its workflow script ` +
      `(results are collected by the workflow run, not by messaging). ` +
      `Recovery: use action:'list' with includeWorkflow:true to inspect it.` +
      ` To get these results, re-dispatch via the subagents tool.`,
    );
  }

  // [modeless 波1·升级路径删除] 「模式」不是 record 状态——message 对任何归属内
  // record 直接续聊（无 one-shot → chatMode 升级概念，Mutable<> 置位 hack 消亡）。
  // 引擎能力轴的 message 资格检查保留（与 record 无关：pi native / zcode cold 均
  // 可续；unsupported 引擎硬拒 + fork/重派指引——与 Continuation revive 翻边格
  // 写点②分工协同，改动这两处必须协同）。
  if (!service.engineSupportsConversation(record)) {
    throw engineConversationMessageUnsupportedError(record.engine ?? DEFAULT_ENGINE_ID);
  }

  // 统一投递：Continuation 编排（§3.4——两态分流 / D2 打断语义）。
  // [H1 U6] 旧「进程死活分流热/冷路径」消亡（每轮 = 新 run + resume 锚点），
  // interrupt 参数随 D2 打断统一语义退役（在途轮存在即打断入队，不区分抢占/排队）。
  await service.chatActions.deliverChatMessage(record, text);
  return { kind: "message", subagentId: id, slug: record.slug, response: { delivered: true } };
}

// ============================================================
// close handler（对话模式结束）
// ============================================================

/**
 * close action handler：结束 subagent（[U5 / §3.2.5] close = 收口落账——
 * 会话落 ended 侧，不终态化；对话模式为主，one-shot 同样支持）。
 *
 * force 语义（设计决策 5/10 × [U5] 意愿动作重定义）：
 *   force:false（默认）= 优雅收口——
 *     无在跑轮（timer armed / 无活进程）→ 立即收口落账（回收保活进程 + markSettledOut）
 *     有活进程在跑轮 → 置 closeAfterRound 挂起，收口轮 settle → 轮次通知送达 → 收口落账
 *     （顺序约束 [写死]）——返回 {closed:true} 即承诺轮结束后资源已释放
 *   force:true = 立即终止——cancel 语义（abort 轮 + settle interrupted + 放弃轮
 *     标记）+ 随即收口落账
 *
 * 行为分流委托 chatActions.closeSubagent（归属守卫由 chatActions.getRecordForAction 把关）。
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
 * 旧记录本身不动——tryTransition 语义均不触碰。
 *
 * [U4 / §3.2.3 万物可续] 语义分野写死：fork-from = **历史在**分叉新 id；reopen
 * （markReopened，经 message 触发）= 历史亡同 id 重启。守卫链按 transcript 锚
 * 可解析性分流——锚不可解析（transcript 被回收）时 fork-from 语义空洞，引导
 * message（reopen 语义）而非拒绝（zcode 例外：守卫 3 按引擎恒拒，见下）。
 *
 * 守卫链（拒绝原因与行动语言对齐，见 assertAndLookupForkFromSource）：
 *   1. 本进程内存 running → 还活着，应走 message（防双写同一子 session 文件）
 *   2. 不存在            → 引导 list 确认
 *   3. zcode 引擎        → fork-from 通道未接入，恒拒 + 准确理由（zcode 历史在隔离
 *      sqlite 会话库、不随 pi retention 回收——下方锚判据文案对 zcode 失实）
 *   4. 异进程活跃         → 别处正跑，不可从此接续（读到半截历史；等其结束或在其所属会话内操作）
 *   5. worktree 记录     → checkout 不可复用，fork 子进程 cwd 会回落主仓破坏隔离
 *   6. 锚不可解析         → 无历史可分叉（从未开跑 / transcript 被回收）——引导
 *      message（同 id reopen，历史摘要自动注入）或 start fresh
 *  （[U4] 原守卫 4「cancelled/user-close 拒绝」随万物可续删除——fork-from 对任何
 *   idle record 放行，主动告别不再是 fork 例外。）
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
 *  （守卫 6 已保证锚可解析、sessionFile 非空，返回类型随之收窄）。 */
function assertAndLookupForkFromSource(service: SubagentService, id: string): SubagentRecord & { sessionFile: string } {
  // 守卫 1：本进程内存 running —— 直接 message 即可，fork-from 会双写其 session 文件。
  if (service.queries.findRecord(id)) {
    throw new Error(
      `subagent ${id} is still active in this process — use action:'message' to continue it directly. ` +
      `If you want a parallel branch from its history, close it first (action:'close'), then fork-from.`,
    );
  }

  // 守卫 2：全态查找（内存 idle + 磁盘重建）。
  const source = service.queries.lookupRecordAnyState(id);
  if (!source) {
    throw new Error(
      `No subagent record with id "${id}". It may never have existed or been garbage-collected — ` +
      `use action:'list' with includeFinished:true to verify the id (add includeWorkflow:true to also see workflow-dispatched subagents).`,
    );
  }

  // 守卫 3（[R5] zcode 早分流）：fork-from 通道未对 zcode 接入，先于异进程探针 /
  // worktree / 锚判据按引擎恒拒并给出准确理由——zcode 会话历史在隔离 sqlite 会话库、
  // 不随 pi retention 回收，守卫 6 的「never started / transcript collected after
  // retention expired」与守卫 5 的「read its session file」行动语言对 zcode 均失实；
  // 守卫 4 探针判据基于 pi sessionFile（zcode 恒 undefined）天然跳过，无信息增量。
  if (source.engine === "zcode") {
    throw new Error(
      `subagent ${id} runs on the zcode engine, whose fork-from channel is not wired up yet — ` +
      `its session history lives in the engine's isolated sqlite session db (not a pi transcript file, ` +
      `so it is never collected by retention). ` +
      `Recovery: use action:'message' on this id — it reopens on the same id ` +
      `(prior-task summary auto-injected); or start a fresh subagent (action:'start').`,
    );
  }

  // 守卫 4：异进程活跃（.alive 侧车指向另一进程的活 pid）。
  // 双写防护：fork 虽 copy-on-write（历史 jsonl 只读），但源仍在异进程运行时接续容易
  // 读到半截历史，等它结束再接更安全。判据 = findForeignLiveInstance 直接探针（同
  // cold-lookup 准入判据；[U4b / D3b (a′)] 原读 rec.externalInstance 重建缓存换现查
  // 探针——语义等价且比重建时点缓存更新鲜）。sessionFile 缺失（entry-born 孤儿）时
  // 无从探活，天然无 foreign 声明，落守卫 6 处置。
  if (source.sessionFile !== undefined && findForeignLiveInstance(source.sessionFile) !== undefined) {
    throw new Error(
      `subagent ${id} is still running in another process (alive pid marker present). ` +
      `Recovery: wait until it finishes, or operate it in its own session; then retry fork-from.`,
    );
  }

  // 守卫 5：worktree 记录 —— WorktreeHandle 不可序列化，checkout 已被 reaper/cleanup
  // 回收；fork 子进程若复用旧路径会回落主 repo（破坏文件隔离）。与续聊链的
  // hadWorktree 守卫同一判据同一理由。
  if (source.worktree === true) {
    throw new Error(
      `subagent ${id} was created with worktree isolation; that binding was lost when its parent process ended. ` +
      `Resuming from its history would run outside the original worktree isolation. ` +
      `Recovery: start a new subagent with action:'start' and carry over key findings manually ` +
      `(read ${source.sessionFile ?? "its session file"} if needed).`,
    );
  }

  // 守卫 6（[U4] 锚判据化；[R5] zcode 形态已在守卫 3 早分流，到达此处必为 pi
  // record）：锚不可解析（字段缺失 = entry-born 从未开跑；
  // 文件不在 = transcript 被回收）→ fork-from「继承历史」语义空洞。不硬拒 start
  // fresh，引导 message 的 reopen 语义（同 id 重开 + 历史摘要自动注入）。
  const sessionFile = source.sessionFile;
  if (sessionFile === undefined || !isAnchorResolvable({ sessionFile })) {
    throw new Error(
      `subagent ${id} has no transcript history left to fork from (it never started, or the transcript ` +
      `was collected after its retention expired). ` +
      `Recovery: use action:'message' on this id — it reopens on the same id with a fresh transcript ` +
      `(prior-task summary auto-injected); or start a fresh subagent (action:'start').`,
    );
  }

  return { ...source, sessionFile };
}

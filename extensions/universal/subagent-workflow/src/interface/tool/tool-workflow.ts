/**
 * Workflow Extension — workflow 工具组（tool-declaration-slimming D3 拆分终态）。
 *
 * 拆为两工具（命名与 schedule_control 同族）：
 * - `workflow_run`：registry.getPath → runWorkflow（直接启动，无需用户确认；name 必填
 *   由 schema 表达）
 * - `workflow_control`（action: status/abort/resume）：status 无 runId 列出 runs
 *   （deps.runs）/ 带 runId 返回该 run 成员表（statusSingleRun）、abort 调 abortRun、
 *   resume 调 resumeRun（interrupted 态 run 断点续跑，D14 args 校验在入口）
 *
 * **resume 是中断恢复不是挂起恢复**：仅 interrupted 态 run 可续（崩溃收编 / terminate
 * 被动失联后的断点续跑，workflow-run-resume-revision U3/D14），不是把活跃 run 暂停再继续。
 * 一次性生命周期：run 不可挂起（pause 已废弃），提前停止用 abort，要新结果开新 run。
 *
 * 层归属：Interface。依赖 Pi SDK + Engine lifecycle/launcher + helpers。
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import os from "node:os";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("tool-workflow");
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core";
import { THINKING_ORDER } from "@zhushanwen/subagent-core";
import { displayWorkflowName } from "@zhushanwen/subagent-core";
import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { abortRun, resumeRun, runWorkflow } from "@zhushanwen/subagent-core";
import type { ResumeRunOptions } from "@zhushanwen/subagent-core";
import type { RunStore } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
// [D8 创建期拒单] 模型目录分类裁决 + 宿主注入的模型清单派生视图访问器（既有派生视图范围：
// session_start 把 ctx.modelRegistry 注入 ModelConfigService 单例——extension 零
// runtime import，H2/P5 宿主注入同款先例）。
import { assertModelInCatalog } from "@zhushanwen/subagent-core";
import { getModelConfigService } from "@zhushanwen/subagent-core";
// D9 closure：core args-meta 消费（reservedKeys 注入见下方 ARGS_META_OPTIONS）
// MAX_TIMER_DELAY_MS：OR-1 消费（barrel 导出，深路径经 u-2c 删通配后 tsc 不可解析）
import {
  argKeysFromMeta,
  findFlattenedArgKeys,
  MAX_RETAINED_DONE_RUNS,
  MAX_TIMER_DELAY_MS,
  workflowNotFoundMessage,
} from "@zhushanwen/subagent-core";
import { assertEntryTimeBudget, assertEntryTokenBudget, assertSlugWithinLimit } from "@zhushanwen/subagent-core";
import { runSummary } from "@zhushanwen/subagent-core";
// run 成员视图（subagent-tool-interface-refactor §3.3.3/§3.4）：record 优先 + trace 兜底
// 的 core 纯函数族——渲染与截断预算共用 core 同一度量单位（memberViewLine），防两处口径漂移。
import { ArgsValidationError } from "@zhushanwen/subagent-core";
import { getSubagentService } from "@zhushanwen/subagent-core";
import { MEMBER_VIEWS_MAX_CHARS, memberViewLine, runMemberViews, truncateRunMemberViews } from "@zhushanwen/subagent-core";
import type { RunMemberRecordView, RunMemberView } from "@zhushanwen/subagent-core";
import { ID_PREVIEW_LENGTH } from "../format/id-preview.ts";
import type { RunStartDetails, WorkflowToolResult } from "./tool-result.ts";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.ts";
import { formatRunStatusElapsed } from "../format/format.ts";
// run 视图 record 拉取上限（与 TUI run 视图 collectRecordsByParentRunId 同源口径）。
import { LIST_LIMIT } from "../tui/list-shared.ts";
import {
  assertNotAborted,
  buildRunSpecFromScript,
  optionSlugSuffix,
  renderTextResult,
  throwPrefixed,
} from "./tool-shared.ts";

// ── Parameter schema（D3 拆分：workflow_run + workflow_control）─────────────

/** workflow_control 工具的 action 枚举值（单一真相源；run 拆出为独立工具无 action）。 */
export type WorkflowControlAction =
  | "status"
  | "abort"
  | "resume";

const WORKFLOW_CONTROL_ACTIONS: readonly WorkflowControlAction[] = [
  "status",
  "abort",
  "resume",
];

const WorkflowRunParams = Type.Object({
  name: Type.String(
    { description: "Absolute path to a .js script — normally a <location> from <available_workflows>; ANY absolute .js path declaring @pi-meta kind:\"workflow\" works. Relative paths and bare names are rejected." },
  ),
  slug: Type.Optional(
    Type.String({
      description: "Short label (max 35 chars) shown in the TUI to distinguish concurrent runs. Defaults to the script name.",
      maxLength: SLUG_MAX_LENGTH,
    }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arguments passed to the workflow.",
    }),
  ),
  tokens: Type.Optional(Type.Number({
    // 预算纪律句已删（tool-declaration-slimming D1 单源化→注入段
    // SUBAGENT_DISPATCH_SHARED_RULES，原文见 git 历史）。
    description: "Max token budget.",
  })),
  time: Type.Optional(Type.Number({
    description: `Max time budget in ms (hard ceiling ${MAX_TIMER_DELAY_MS} ms — larger values fail fast).`,
  })),
  model: Type.Optional(Type.String({
    // 缺省继承主 agent 的纪律句已删（D1 单源化→注入段）；
    // run 级 override 作用域 / user override 优先级是本参数功能语义，保留。
    // 尾句 = §3.3.7 残留风险处置的说明腿：脚本把同名参数声明为可选时工具不会报错
    // （顶层键不进 args、脚本静默走自己的缺省值），schema 字段说明是该歧义唯一的
    // 结构性提示层（错误腿 = reservedKeyChannelError 只覆盖 required 缺参形态）。
    description:
      "Run-level model override in 'provider/modelId' format — all agents spawned by this run inherit it (unless a per-call agent() opts.model is set). " +
      "A user-issued runtime override (panel switch / /subagent-model) wins over this parameter and over any explicitly scripted model. " +
      "This key is NOT passed to the script — a script's own same-named parameter must be passed inside 'args'.",
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    // 枚举值由 schema 自身的 enum 承载（不重复列举）；「user override 不改显式 scripted
    // level」的优先级事实随 D1 单源化从 promptGuidelines Note 条迁入本字段说明。
    // 尾句同 model：§3.3.7 残留风险处置的说明腿（脚本同名参数的通道指引）。
    description: "Run-level thinkingLevel override — all agents in the run inherit it. Omit for each agent's model's highest available level. A user-issued runtime override (panel switch / /subagent-model) does not change an explicitly scripted level (explicit levels outrank the override's inline level). " +
      "This key is NOT passed to the script — a script's own same-named parameter must be passed inside 'args'.",
  })),
});

const WorkflowControlParams = Type.Object({
  action: StringEnum(WORKFLOW_CONTROL_ACTIONS, { description: "Control operation: 'status' without runId lists runs / with runId returns that run's member table, 'abort' stops one, 'resume' continues an interrupted run" }),
  runId: Type.Optional(
    Type.String({ description: "Workflow run ID (status with runId returns that run's member table; abort / resume; find ids via action:status without runId)" }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "For resume: optional — when passed, must deep-equal the original args (except internal _runId); mismatch rejected with the differing fields listed. Omit to reuse the original args.",
    }),
  ),
  tokens: Type.Optional(Type.Number({
    // 预算纪律句已删（D1 单源化→注入段）；
    // resume 分支是本参数的功能语义，保留。
    description: "Max token budget. For resume: applied to the resumed execution (tokens already spent count against it)",
  })),
  time: Type.Optional(Type.Number({
    description: `Max time budget in ms (hard ceiling ${MAX_TIMER_DELAY_MS} ms — larger values fail fast). For resume: applied to the resumed execution (active spent time counts; suspended does not)`,
  })),
  error: Type.Optional(
    Type.String({ description: "Error/reason message (optional, with abort)" }),
  ),
  model: Type.Optional(Type.String({
    // 缺省继承纪律句已删（D1 单源化→注入段）；user override 优先级在 workflow_run 的
    // model 字段说明一处（跨工具通用规则单源），此处只留 resume 分支功能语义。
    description:
      "Resumed run's model override (same channel as a panel switch), driving all re-dispatched steps.",
  })),
});

type WorkflowRunToolParams = Static<typeof WorkflowRunParams>;
type WorkflowControlToolParams = Static<typeof WorkflowControlParams>;

// ── Constants ────────────────────────────────────────────────

/**
 * tool 自身顶层键（workflow_run / workflow_control 两 schema 键的合集）——workflow
 * 参数名与 tool 键撞名时（如 workflow 声明参数 name），顶层同名键是 tool 参数而非
 * 平铺（m6 评审 M-3）。合集形态：run 与 control 各自的键集都是本集合子集，两工具
 * 共享同一 reservedKeys 注入（超集无害——reservedKeys 只做撞名豁免，不做校验）。
 *
 * D9 下沉后作为 core args-meta 的 reservedKeys 注入（ArgMetaOptions）——core 缺省
 * 空集，不注入则撞名保护失效（run 调用顶层必有 name，会被误判平铺）。
 * export 供 __tests__/tool-workflow.test.ts（TC3i 宿主 reservedKeys 接线锚）复用同一集合防漂移。
 */
export const TOOL_TOP_LEVEL = new Set([
  "action",
  "name",
  "slug",
  "runId",
  "args",
  "tokens",
  "time",
  "error",
  // Run-level overrides (Option B): excluded from flattening detection so a
  // workflow that declares its own `model`/`thinkingLevel` parameter does not
  // trip a false "belongs inside args" warning when the tool's top-level fields
  // are present. They flow via workerData → $MODEL/$THINKING_LEVEL globals.
  "model",
  "thinkingLevel",
]);

/**
 * core args-meta 的宿主差异注入项（D9 下沉）：reservedKeys = TOOL_TOP_LEVEL。
 * core 版 argKeysFromMeta / findFlattenedArgKeys 缺省 reservedKeys 为空集（core
 * 中性形态），不传此项则失去撞名保护、行为不等值——调用点必须携带（等值契约）。
 */
const ARGS_META_OPTIONS = { reservedKeys: TOOL_TOP_LEVEL };

/**
 * 保留键双通道解释的键集（§3.3.7）：workflow 脚本把这些名字声明为 required 参数、
 * 而 args 里缺失时，缺参错误补「顶层键 = run 级覆盖 / 脚本参数要进 args」的通道
 * 解释。name/args/error/action 等 tool 结构键不在此列——它们与脚本参数同名时语义
 * 不是「覆盖值」，平铺检测（findFlattenedArgKeys + TOOL_TOP_LEVEL 豁免）已另有处理。
 */
const RESERVED_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "model",
  "thinkingLevel",
  "tokens",
  "time",
  "slug",
]);

// ── Types ────────────────────────────────────────────────────

interface RunSummary {
  runId: string;
  name: string;
  /** Run 级 slug（可选，旧 run 缺失为 undefined）。 */
  slug?: string;
  status: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** run 唯一持久件（record 事件流 <root>/<rootSid>/workflow/runs/<runId>.record.jsonl）的绝对路径。 */
  stateFile?: string;
}

// ── Tool result types ──

/**
 * Discriminated union of the workflow tools'（workflow_run / workflow_control）`details` payloads.
 *
 * Discriminant: `action`. Each action's details shape is explicitly typed so
 * downstream consumers (structured-output) can narrow without unsafe casts.
 *
 * status 双变体（subagent-tool-interface-refactor §3.1.3，`mode` 为新增判别字段，
 * additive：list 变体仍带 runs，既有消费方读 details.runs 行为不变）：
 * - mode:"list" = 无 runId 列表（内存保留窗口内 run 摘要）；
 * - mode:"run" = 带 runId 单 run 视图（run 摘要 + 成员表 + 截断标记；members 为
 *   core runMemberViews 派生视图，truncated/total 来自同一截断预算）。
 */
export type WorkflowToolDetails =
  | ({ action: "run"; name: string } & RunStartDetails)
  | { action: "status"; mode: "list"; runs: RunSummary[] }
  | {
      action: "status";
      mode: "run";
      run: RunSummary;
      members: RunMemberView[];
      truncated: boolean;
      /** 成员表总行数（截断前——failed N/M 的 M 同源）。 */
      total: number;
    }
  | { action: "abort"; runId: string; status: string; reason?: string }
  | ({ action: "resume"; runId: string } & RunStartDetails);

/** Result returned by the workflow tools' execute（公共骨架见 tool-result.ts）。 */
type WorkflowExecuteResult = WorkflowToolResult<WorkflowToolDetails | undefined>;

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow 工具组（tool-declaration-slimming D3 拆分：workflow_run +
 * workflow_control，命名与 schedule_control 同族）。签名不变、内部注册两工具——
 * 组合根（index.ts）零改动。
 *
 * run 与 control 共用同一 reentryRef（与拆分前单工具 4 action 共用一 guard 语义
 * 一致：abort/resume 与 run 同占检查，双 guard 语义漂移不引入）。reentryRef 是
 * factory 级单例（index.ts 在 factory 内创建），跨 session 共享。当前 Pi 运行时
 * 单 session 串行（同一时刻只有一个 active session），跨 session 不会并发触发
 * workflow action，故共享无竞态。若未来支持多 session 并发，需改为 per-session guard。
 *
 * @param pi ExtensionAPI
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param reentryRef reentry guard
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  deps: LauncherDeps,
  reentryRef: ReentryGuardRef,
): void {
  pi.registerTool({
    name: "workflow_run",
    label: "Workflow Run",
    description:
      "Execute a workflow: start a listed workflow script directly (runs in background; results auto-delivered).\n" +
      "Run control (status/abort/resume) lives in the `workflow_control` tool.",
    promptSnippet: "Run a workflow",
    promptGuidelines: [
      // tool-declaration-slimming D1 终态：使用纪律单点。勿等待条/预算纪律条/模型缺省继承条
      // 已删（收敛点 = <available_subagents> 注入段 SUBAGENT_DISPATCH_SHARED_RULES）；args
      // 平铺检测 / model override 通道的功能语义在 schema 字段说明一处，不在此复述。
      // 锚词保留清单见 __tests__/tool-prompt-contract.test.ts 头注。
      "PRIORITY: 'workflow' / 'run workflow' → call workflow_run FIRST.",
      "Refs come from <available_workflows>; for parameter details read the <location> script file (@pi-meta header: parameters + usage + phases).",
      "Call shape (JSON): {\"name\":\"<script>\",\"args\":{...}} (+ optional tokens/time/model/thinkingLevel).",
      "Anti-patterns: flattening args sub-fields (task/items/...) to the top level — they belong inside args.",
      "CRITICAL: for orchestration patterns ALWAYS use workflow_run with the listed workflow's <location> path — NEVER use workflow-script action:generate to recreate covered patterns; generate is ONLY for novel patterns.",
    ],
    parameters: WorkflowRunParams,

    async execute(
      _toolCallId: string,
      params: WorkflowRunToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<WorkflowExecuteResult> {
      // P1-2: Honor abort signal up-front
      // throw（W4b）：execute throw → pi agent-loop catch 置 isError:true
      //（pi-agent-core dist/agent-loop.js executePreparedToolCall，1.0.0 实读 catch :581-588；
      // 1.0.0 起正常 return 的 isError 也被尊重——:579 isError: result.isError === true，
      // 0.84.4 才硬编码 false——本包失败恒走 throw，行为不变）——文案原样进 toolResult。
      // abort 前置判定收敛在 tool-shared（三处 tool 同源）。
      assertNotAborted(signal);
      // P1-6: Reentry guard（acquire 失败时尚未持有 guard，throw 前无需 release）
      if (!acquireReentryGuard(reentryRef)) {
        throw new Error(REENTRY_BUSY_MESSAGE);
      }
      try {
        // workflow 块分支（WORKFLOW_TOOL_NAMES 集合分流）恒折叠单行不消费 __gui__
        // （D8 裁决），details 不构造 GUI 描述符。
        return await actionRun(params, deps, signal);
      } finally {
        releaseReentryGuard(reentryRef);
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      // workflow ref 是绝对路径，标题行显示取 basename 短名（displayWorkflowName，
      // 与 subagent 标题行的 displayAgentName 对称）；slug 不受影响。
      const name = args.name ? ` ${displayWorkflowName(String(args.name))}` : "";
      // run 可选 slug：在 name 后追加 · slug（accent 色）
      const slug = optionSlugSuffix(args.slug, theme);
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow_run ")) +
          theme.fg("accent", name) +
          slug,
        0,
        0,
      );
    },

    renderResult: renderTextResult,
  });

  pi.registerTool({
    name: "workflow_control",
    label: "Workflow Control",
    description:
      "Control workflow runs: status (without runId = list runs; with runId = that run's member table), abort (stop a run), resume (continue an interrupted run).\n" +
      "Runs are one-shot (no pause): stop early with abort; for a settled run start a new one via `workflow_run`.",
    promptSnippet: "Check, abort, or resume workflow runs",
    promptGuidelines: [
      // D1 单源化终态：一次性生命周期与 resume 资格语义已在 description 说一遍，此处只留
      // 调用形状与「不得 resume 已终态 run」的纪律条（锚词清单见 tool-prompt-contract.test.ts）。
      "resume is ONLY for interrupted runs (crash or session-switch): it replays completed calls at zero token cost and continues. Do NOT resume a settled (done/failed/cancelled) run — start a new run via `workflow_run`.",
      "Call shapes (JSON): " +
      "- status: {\"action\":\"status\"} — or {\"action\":\"status\",\"runId\":\"<id>\"} for a single run's member table. " +
      "- abort: {\"action\":\"abort\",\"runId\":\"<id>\"}. " +
      "- resume: {\"action\":\"resume\",\"runId\":\"<id>\"} (+ optional args/tokens/time/model).",
    ],
    parameters: WorkflowControlParams,

    async execute(
      _toolCallId: string,
      params: WorkflowControlToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<WorkflowExecuteResult> {
      assertNotAborted(signal);
      if (!acquireReentryGuard(reentryRef)) {
        throw new Error(REENTRY_BUSY_MESSAGE);
      }
      try {
        let result: WorkflowExecuteResult;
        // 断言为 WorkflowControlAction 联合——typebox Static 推断退化为 string，显式
        // 标注让 default 分支的 never 穷尽检查生效（新增 action 时 tsc 报错强制补 case）。
        const action = params.action as WorkflowControlAction;
        switch (action) {
          case "status":
            result = actionStatus(params, deps);
            break;
          case "abort":
            result = await actionAbort(params, deps);
            break;
          case "resume":
            result = await actionResume(params, deps);
            break;
          default: {
            // Exhaustiveness check — 新增 WorkflowControlAction 成员时未补 case，tsc 在此报错。
            const _exhaustive: never = action;
            throw new Error(`Unknown action: ${String(_exhaustive)}`);
          }
        }
        // workflow 块分支（WORKFLOW_TOOL_NAMES 集合分流）恒折叠单行不消费 __gui__
        // （D8 裁决），details 不构造 GUI 描述符。
        return result;
      } finally {
        releaseReentryGuard(reentryRef);
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const action = String(args.action ?? "");
      const runId = args.runId ? ` ${String(args.runId).slice(0, ID_PREVIEW_LENGTH)}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow_control ")) +
          theme.fg("muted", action) +
          theme.fg("dim", runId),
        0,
        0,
      );
    },

    renderResult: renderTextResult,
  });
}

// ── run action ───────────────────────────────────────────────

export async function actionRun(
  params: WorkflowRunToolParams,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
): Promise<WorkflowExecuteResult> {
  const name = params.name;
  if (!name) {
    throw new Error(
      "run requires 'name' parameter (an absolute .js path, e.g. a <location> from <available_workflows>). Correct: {\"name\":\"<ref>\"}",
    );
  }
  // 弱模型常见误用（P0 静默失败）：把 task/items 等 args 子字段平铺到 workflow params
  // 顶层（缺 args 嵌套）。args ?? {} 会静默 args={}，启动缺参 run 不报错——比 subagent
  // 平铺事故更严重。m6：先 registry.getPath（动态参数集来源——schema 即 SSOT），
  // not_found 优先返回；平铺检测报错带 Correct 正例纠正。
  //
  // [D4-1 按名解析退役] name 解析 = 路径单通道（getPath：绝对路径 + ~/ 展开，
  // normalizeRef 既有——相对路径/裸名一律 null → not_found 拒单，既有文案列全部
  // 可用条目并附 location，失败一次即可按绝对路径自救）。原 registry.get（内置名 +
  // 用户保存名）按名解析整体退役：派发终态形态 = 全路径（用户裁决 2026-09-21），
  // P5 修复发现范围后注册表会命中内置名让裸名「复活」——反向违反终态裁决，故机制
  // 删除而非禁用。行为变更四要素：量级 = 裸名派发调用；旧行为 = registry.get 命中
  // 即启动；新行为 = not_found 拒单（零 token 沉没）；恢复 = 按清单 location 重试。
  const script = await deps.registry.getPath(name);
  // W4c：config-loader 的 toCachedMeta 对不可读/不存在文件返回 available:false 的
  // stub（非 undefined），仅判 !script 会绕过 not_found → 空 sourceCode 假启动
  //（W4b verifier 探针实测复现）。
  if (!script || !script.available) {
    // throw（W4）：execute throw → pi agent-loop catch 置 isError:true（pi-agent-core
    // dist/agent-loop.js executePreparedToolCall，1.0.0 实读 catch :581-588；1.0.0 起
    // 正常 return 的 isError 也被尊重——:579 isError: result.isError === true，0.84.4
    // 才硬编码 false——本包失败恒走 throw，行为不变）——文案原样进 toolResult。
    // [全路径自救指引] 清单逐条附绝对路径 location：run 的 name 形参最贴近的
    // 读侧就是本清单（<available_workflows> 注入点在 start 时已过时/可能不在
    // 上下文）——带 location 后失败一次即可按绝对路径自救。按名解析已退役
    // （D4-1），location 是唯一活路；文案单源 = core launcher.workflowNotFoundMessage。
    throw new Error(await workflowNotFoundMessage(name, deps));
  }

  // m6：动态参数集（schema 即 SSOT）→ 平铺检测；无 parameters → 单次 warn + 跳过
  // （legacy const-meta 类永久无检测——D1 无 adapter 声明）
  const { exact: knownKeys, patterns: knownPatterns } = argKeysFromMeta(
    script.meta.parameters,
    ARGS_META_OPTIONS,
  );
  if (knownKeys.size === 0 && knownPatterns.length === 0) {
    // M-2 显式信号：无参数契约（未声明/解析空）→ 单次 warn——静默退化变显式
    // （m6 exec-review M1：原实现排除 undefined 与设计相反）
    logger.warn(
      `[tool-workflow] ${script.name}: 未声明参数契约（或解析为空）——平铺检测跳过，args 不校验`,
    );
  }
  // core 版接收 meta 内联构建键集（签名与本地版键集三参不同，判定谓词逐字同源）——
  // 键集构建两次（此处 + core 内部）仅为 M-2 空契约信号，成本每 run 一次可忽略
  const flattened = findFlattenedArgKeys(params, script.meta.parameters, ARGS_META_OPTIONS);
  if (flattened.length > 0) {
    throw new Error(
      `Detected ${flattened.join(", ")} at top level — they belong inside 'args'. ` +
      `Correct: {"name":"${name}","args":{${flattened.map((k) => `"${k}": "<value>"`).join(", ")}}}`,
    );
  }
  // slug 运行时护栏（与 subagent startHandler 对称的纵深防御；schema maxLength 是第一道关卡）
  assertSlugWithinLimit(params.slug, ["fix-login", "extract-urls"]);
  const args = params.args ?? {};
  const tokens = params.tokens;
  const time = params.time;
  // OR-1 入口 fail-fast（crash-forensics-and-watchdog.md 附录 E（原 unbounded-wait-audit §7.2 T3①））：schema 的 time 是
  // Type.Number 直通（无上界）——超 setTimeout 安全域的值会穿透到 lifecycle 内层
  // 防线（assertSafeTimerDelay），而入口拦截让它永不进入副作用链（判定与文案单点在
  // core shared/entry-guards；LLM 可据消息自纠：clamp 或省略走 unlimited 语义）。
  // 负值同在入口拒绝：tokens 负值会被 Budget 的 maxTokens>0 检查、time 负值会被
  // lifecycle 的 budgetTimeMs>0 判定静默升格 unlimited（显式预算被忽略），入口拦截
  // 替代静默升格。
  assertEntryTimeBudget(time);
  assertEntryTokenBudget(tokens);

  // [D8 创建期拒单] 工具参数 model 是创建期唯一静态声明源（agent 资产 frontmatter
  // model 随脚本 JS 动态求值不可静态解析——由派发期 isPiRoute 对称校验覆盖，
  // 见 workflow-dispatch.resolveWorkflowIdentity）。查无 = run 创建失败（同步 throw，
  // 零 spawn 零 token），错误列可用清单 + 分类修复指引（查无 vs provider 配置漂移）。
  // 目录经宿主注入派生视图访问：session_start 已把 ctx.modelRegistry 注入
  // ModelConfigService 单例；单例缺席（生产不可达——tool execute 前必有 session_start）
  // 降级跳过 + warn 留痕，派发期 identity 解析仍是权威裁决。
  if (params.model !== undefined) {
    const modelService = getModelConfigService();
    if (modelService === null) {
      logger.warn(
        "[tool-workflow] model catalog unavailable (model service not initialized) — creation-time model check skipped; dispatch-time identity resolution remains authoritative",
      );
    } else {
      assertModelInCatalog(params.model, modelService.getModelRegistry(), {
        source: "run-level model override",
      });
    }
  }

 // 构建 RunSpec + 启动（m3：parameters 从 script.meta 拷贝——chokepoint 校验用；
 // 校验失败 → ArgsValidationError 被 catch 补保留键双通道解释后以 Error throw 给 pi
 //（W4：err.message 含 §5.3 指引，pi catch 后原文案进 toolResult content 并置
 // isError:true），其他错误保持传播）
  let runId: string;
  try {
    runId = await runWorkflow(
      buildRunSpecFromScript(script, {
        args,
        budgetTokens: tokens,
        budgetTimeMs: time,
        slug: params.slug,
        model: params.model,
        thinkingLevel: params.thinkingLevel,
      }),
      deps,
      signal,
    );
  } catch (err) {
    // [§3.3.7 保留键双通道] 按类型 catch：缺失 required 键与工具顶层 run 级覆盖键
    // 相交时补一段通道解释，普通缺参/类型错原样透出。
    if (err instanceof ArgsValidationError) {
      throw reservedKeyChannelError(err);
    }
    throw err;
  }

  return {
    content: [
      {
        type: "text",
        text: params.slug
          ? `Started workflow '${script.name}' · ${params.slug} (${runId}). Running in background — DO NOT bash sleep or poll status; results are auto-delivered via notifyDone.`
          : `Started workflow '${script.name}' (${runId}). Running in background — DO NOT bash sleep or poll status; results are auto-delivered via notifyDone.`,
      },
    ],
    details: { action: "run", runId, status: "running", name: script.name, slug: params.slug, stateFile: deps.store.stateFilePath(runId) },
  };
}


// ── 保留键双通道解释（§3.3.7，actionRun 的 ArgsValidationError catch 附属）──

/**
 * ArgsValidationError → 双通道解释错误：ajv 报告的缺失 required 键与
 * RESERVED_OVERRIDE_KEYS 相交时，在原错误文案后补「顶层键是 run 级覆盖、脚本参数
 * 要放进 args、同时传两者的正确形状」；不相交（普通缺参/类型错）原 message 原样透出。
 * 返回新 Error（不 mutate 原错误——保留其类型与调用方栈）。
 */
function reservedKeyChannelError(err: ArgsValidationError): Error {
  const overlaps = missingRequiredKeysOf(err).filter((k) => RESERVED_OVERRIDE_KEYS.has(k));
  if (overlaps.length === 0) {
    return new Error(err.message);
  }
  const keys = overlaps.map((k) => `"${k}"`).join(", ");
  const example: Record<string, unknown> = { name: "<script>" };
  for (const key of overlaps) {
    example[key] = "<run-level override>";
  }
  example.args = Object.fromEntries(overlaps.map((k) => [k, "<script argument>"]));
  return new Error(
    `${err.message}\n` +
    `Channel note: top-level ${keys} on workflow_run ${overlaps.length === 1 ? "is" : "are"} a run-level ` +
    `override applied to the whole run — it is NOT passed to the script. The script reads its own ` +
    `parameters from 'args'. Correct shape to pass both: ${JSON.stringify(example)} ` +
    `(omit the top-level ${keys} if no run-level override is needed).`,
  );
}

/**
 * 从 ArgsValidationError.errors（ajv 错误数组）提取缺失的 required 参数名
 * （ajv required 错误携带 params.missingProperty）；非 required 错误 / errors 缺席
 * （畸形 schema 形态）返回空集——不猜不扩。
 */
function missingRequiredKeysOf(err: ArgsValidationError): string[] {
  const keys = new Set<string>();
  for (const e of err.errors ?? []) {
    if (e === null || typeof e !== "object") continue;
    const params = (e as Record<string, unknown>).params;
    if (params === null || typeof params !== "object") continue;
    const missing = (params as Record<string, unknown>).missingProperty;
    if (typeof missing === "string") keys.add(missing);
  }
  return [...keys];
}

// ── status action ────────────────────────────────────────────

/**
 * status 双分支（subagent-tool-interface-refactor §3.1.3/§3.4）：带 runId = 单 run
 * 视图（run 摘要 + 成员表）；无 runId = 列表（现状，内存保留窗口内全部 run 摘要）。
 */
function actionStatus(params: WorkflowControlToolParams, deps: LauncherDeps): WorkflowExecuteResult {
  const runId = params.runId;
  if (runId !== undefined && runId !== "") {
    return statusSingleRun(runId, deps);
  }
  const runs = Array.from(deps.runs.values());
  if (runs.length === 0) {
    return {
      content: [{ type: "text", text: "No workflows in current session." }],
      details: { action: "status", mode: "list", runs: [] },
    };
  }
  const summaries = runs.map((r) => toRunSummary(r, deps.store));
  const lines = summaries.map((s) => {
    // [H2 A2] run done 后 elapsed 冻结于 completedAt（formatRunStatusElapsed 内切
    // now 基准），不再随每次 status 查询的墙钟增长。
    const duration = s.startedAt ? ` (${formatRunStatusElapsed(s.startedAt, s.completedAt)})` : "";
    const reasonSuffix = s.reason && s.reason !== "completed" ? ` [${s.reason}]` : "";
    return `[${s.status}${reasonSuffix}] ${s.name} (${s.runId.slice(0, ID_PREVIEW_LENGTH)})${duration}${s.error ? ` error: ${s.error}` : ""}`;
  });
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { action: "status", mode: "list", runs: summaries },
  };
}

/**
 * 单 run 视图（§3.1.3 成员表终态形状）：run 摘要行（带 failed N/M）+ 成员行
 * （stepIndex 序）+ 截断省略行。成员事实 = core runMemberViews（record 优先、
 * trace 兜底）；record 查询经 SubagentService 单例，缺席（standalone pi / session_start
 * 前）或查询读失败（磁盘/manifest 异常）降级 trace-only，不抛错、不隐藏成员行
 * （§3.4 错误规格：record 查询不可用 | 降级（不抛错））。
 */
function statusSingleRun(runId: string, deps: LauncherDeps): WorkflowExecuteResult {
  const run = deps.runs.get(runId);
  if (!run) {
    throw runNotFoundError(runId, deps);
  }
  const summary = toRunSummary(run, deps.store);
  // record 查询不可用降级（§3.1.3 trace 兜底把「跨进程读失败」与 service 缺席并列；
  // §3.4 错误规格「record 查询不可用 | 降级（不抛错）」）：查询抛错（磁盘/manifest
  // 异常）与缺席同样折为 records undefined → 全部成员行走 trace 兜底行，status 不整体
  // 失败。collectRecordsByParentRunId 的 limit 位与 TUI run 视图同源 LIST_LIMIT——同量级口径。
  let records: readonly RunMemberRecordView[] | undefined;
  const service = getSubagentService();
  if (service) {
    try {
      records = service.queries.collectRecordsByParentRunId(runId, LIST_LIMIT);
    } catch (err) {
      logger.warn(
        `[tool-workflow] record query failed for run ${runId} — falling back to trace-only member rows`,
        err,
      );
    }
  }
  const members = runMemberViews(run, { records, now: Date.now() });
  const budget = truncateRunMemberViews(members, MEMBER_VIEWS_MAX_CHARS);
  // failed N/M 从截断前的全量成员行计数（M = 去重后成员表行数，设计 §3.1.3 唯一定义；
  // 截断只省略渲染行，不改计数）。
  const failedCount = members.filter((m) => m.state === "failed").length;
  const lines: string[] = [runMemberHeaderLine(summary, members.length, failedCount)];
  for (const member of budget.members) {
    lines.push(memberViewLine(member));
  }
  if (budget.truncated) {
    lines.push(`… ${budget.omitted} more members omitted (failed rows kept)`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      action: "status",
      mode: "run",
      run: summary,
      members: budget.members,
      truncated: budget.truncated,
      total: budget.total,
    },
  };
}

/**
 * 单 run 摘要行（设计 §3.1.3 示例形态）：
 * `Run <runId> [<status>[:<reason>]] <name> · <M> members · <elapsed> · failed <N>/<M>`。
 * reason 恒显示（含 completed——与 list 行的「completed 无后缀」惯例不同，run 行
 * 对照设计示例 `[done:completed]`）；run 级 error 仍缀行尾（失败 run 的顶层错误可见）。
 */
function runMemberHeaderLine(summary: RunSummary, memberCount: number, failedCount: number): string {
  const reasonSuffix = summary.reason ? `:${summary.reason}` : "";
  const duration = summary.startedAt ? ` · ${formatRunStatusElapsed(summary.startedAt, summary.completedAt)}` : "";
  const errorSuffix = summary.error ? ` · error: ${summary.error}` : "";
  return (
    `Run ${summary.runId} [${summary.status}${reasonSuffix}] ${summary.name}` +
    ` · ${memberCount} members${duration} · failed ${failedCount}/${memberCount}${errorSuffix}`
  );
}

/**
 * 查无 runId 的两种文案（§3.1.3/错误规格）：判据 = 磁盘 record 流文件存在性——
 * 非终局 run（running 活体 / interrupted 重建）恒在内存 runs Map，「不在内存 + 磁盘
 * record 流在」= 已终局且被 MAX_RETAINED_DONE_RUNS 逐出保留窗口；磁盘也无 =
 * 未知 id。超窗口的恢复动作 = 从该 run 的完成通知恢复结果（省略 runId 列全部不可用
 * ——列表同样不含已逐出 run）。
 */
function runNotFoundError(runId: string, deps: LauncherDeps): Error {
  if (existsSync(deps.store.stateFilePath(runId))) {
    return new Error(
      `Workflow run '${runId}' is settled and no longer in the in-memory retention window ` +
      `(the most recent ${MAX_RETAINED_DONE_RUNS} settled runs are kept). Recover its results from the run's completion ` +
      `notification — a status listing will not include it.`,
    );
  }
  return new Error(
    `Workflow run '${runId}' not found. Double-check the runId (copy it from the tool result that ` +
    `started the run). ` +
    `Correct: {"action":"status"} without runId lists the runs still in the retention window.`,
  );
}

// ── abort action ─────────────────────────────────────────────

/**
 * [W2/V1 D1 分流表第 6 行] 单一判源函数（CLI 面显示/排序的混合判源收拢）：输出
 * 派生视图三态 status（running|interrupted|done——重新加载进内存的中断 run 经 meta.interruptedAt
 * 派生视图出中断态，[D2] 与 shared WorkflowRunStatus 三态同词；活体终局经进程内终局
 * 记录注册表判定、恢复路径写点 run 经聚合 status 读）。判源 = core runSummary
 * 派生视图，散落的等价分支形态不采用（D1 否决记录：散落分支在 grep 层不可区分，
 * 活体判据误用漏网）。
 *
 * 排序键契约：STATUS_ORDER 权重表只消费本函数的三态输出；outcome 细分由
 * runSummary.reason 并列承载（列表行 reasonSuffix）。
 *
 * 落点说明（实施期登记）：函数体消费 core barrel 既有导出 runSummary，落本文件
 * 使 commands/WorkflowsView 可单向 import（commands → view 既有边使 commands.ts
 * 落点成环，本文件与两者均无既有边）。
 */
export function displayStatusOf(run: WorkflowRun): "running" | "interrupted" | "done" {
  return runSummary(run).status;
}

// 一次性生命周期：abort 是唯一的提前停止方式（pause/resume 已随 D-2 移除）。
async function actionAbort(
  params: WorkflowControlToolParams,
  deps: LauncherDeps,
): Promise<WorkflowExecuteResult> {
  const runId = params.runId;
  if (!runId) {
    throw new Error(
      "abort requires 'runId' parameter. Correct: {\"action\":\"abort\",\"runId\":\"<id>\"} (use action:\"status\" to find runId)",
    );
  }
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(
      `Workflow '${runId}' not found. Use action:status to list active runs and their runIds.`,
    );
  }
  try {
    // [W2/V1 D1 分流表第 7 行] abort 读回换源：oldStatus/newStatus/reason 全部
    // 取 runSummary 派生视图（活体终局经终局记录派生 DoneReason——原两态机字段读随
    // 活体写点删除停更，abort 后 state.reason 恒 undefined）。
    const oldStatus = displayStatusOf(run);
    await abortRun(runId, deps, params.error);
    const summary = runSummary(run);
    const newStatus = summary.status;
    const reasonSuffix = summary.reason ? ` (${summary.reason})` : "";
    return {
      content: [
        {
          type: "text",
          text: `Workflow '${run.spec.scriptName}' (${runId}): ${oldStatus} → ${newStatus}${reasonSuffix}`,
        },
      ],
      details: { action: "abort", runId, status: newStatus, reason: summary.reason },
    };
  } catch (err) {
    // "Error: " 前缀是 abortRun 失败的既有 LLM 可见形态，保持不变
    throwPrefixed("Error", err);
  }
}

// ── resume action（args 判定归 core D14 单源 + resumeRun 接线）──
//
// [§2.5 下沉] args 一致性判定（D14）已移入 core `orchestration/resume-args-guard.ts`，
// 由 `assertResumeEligibility` 用**已读到的** run-created 事件执行——本文件只做参数
// 装配（args + journalDir）与成功文案，不再读 record 文件、不再持有比对逻辑与拒绝文案。

/**
 * resume action：interrupted 态 run 断点续跑。
 *
 * 入口语义（D14）：
 * - runId 必需；
 * - args 可选——传入时与 run-created 帧的历史 args 逐字段深度比对（排除 `_runId`），
 *   不一致明确拒绝并列出差异字段（换 args 重放 = 换意图，属新 run）；不传默认沿用历史；
 * - time 可选——resume 执行段的时间预算（活跃段算式在 core：已耗活跃时间计入、
 *   搁置不计）；入口护栏（负值/超安全域）与 run action 同源（assertEntryTimeBudget）。
 * - tokens 可选——resume 执行段的 token 预算（已耗加权 tokens 计入，帧推导下界
 *   口径）；入口护栏（负值）与 run action 同源（assertEntryTokenBudget）。
 *
 * 资格拒绝（非 interrupted / record 损坏 / 锁被占 / D13 嵌套 / 预算耗尽）由 core
 * resumeRun 权威裁决——ResumeRejectionError 文案含恢复指引，原样透出（throw，
 * pi 置 isError:true）。
 */
export async function actionResume(
  params: WorkflowControlToolParams,
  deps: LauncherDeps,
): Promise<WorkflowExecuteResult> {
  const runId = params.runId;
  if (!runId) {
    throw new Error(
      "resume requires 'runId' parameter. Correct: {\"action\":\"resume\",\"runId\":\"<id>\"} (use action:\"status\" to find runId; args optional — must equal the original run's args)",
    );
  }
  assertEntryTimeBudget(params.time);
  assertEntryTokenBudget(params.tokens);

  // 显式 model 参数的目录预检（run action 同款 D8 拒单语义——查无同步 throw 零写，
  // 单例缺席降级跳过 + warn，派发期 identity 解析仍是权威裁决）。
  if (params.model !== undefined) {
    const modelService = getModelConfigService();
    if (modelService === null) {
      logger.warn(
        "[tool-workflow] model catalog unavailable (model service not initialized) — resume model catalog check skipped; dispatch-time identity resolution remains authoritative",
      );
    } else {
      assertModelInCatalog(params.model, modelService.getModelRegistry(), {
        source: "resume model override",
      });
    }
  }

  const options: ResumeRunOptions = {
    ...(params.time !== undefined ? { budgetTimeMs: params.time } : {}),
    // token 预算显式覆盖（与 time 同款通道；三档回落与落盘归 core 单点）
    ...(params.tokens !== undefined ? { budgetTokens: params.tokens } : {}),
    // [F1-26 后续项] 显式 model 透传（core 落统一覆盖记账——「补切 + 无参 resume」
    // 的合一步；格式与目录已在本入口预检，记账落盘归 core 锁段单点）
    ...(params.model !== undefined ? { model: params.model } : {}),
    // [§2.5] args 原样下传由 core 判定（D14 单源）；journalDir 传壳的 store 同源目录，
    // 否则 core 会按模块锚解析 record 路径——多 session 场景会静默读成「无记录」
    //（D14 静默放行 = 安全语义反转；core 锚点与壳 store 锚点必须同源）。
    ...(params.args !== undefined ? { args: params.args } : {}),
    journalDir: dirname(deps.store.stateFilePath(runId)),
    host: os.hostname(),
  };
  await resumeRun(runId, deps, options);

  return {
    content: [
      {
        type: "text",
        text:
          `Resuming workflow run ${runId} — completed calls are replayed from the record at zero token cost, ` +
          "unfinished calls are re-dispatched. Running in background — DO NOT bash sleep or poll status; " +
          "results are auto-delivered via notifyDone.",
      },
    ],
    details: { action: "resume", runId, status: "running", stateFile: deps.store.stateFilePath(runId) },
  };
}

// ── helpers ──────────────────────────────────────────────────

/** WorkflowRun → 摘要（status action 用）：core runSummary 单源派生视图 + 宿主扩展 stateFile。
 *
 * 字段集不再本地维护（runSummary 双派生视图分叉的收尾点，D8/B5）；stateFile 依赖
 * RunStore 实例，属宿主扩展——core 派生视图刻意不依赖具体 store。 */
function toRunSummary(run: WorkflowRun, store: RunStore): RunSummary {
  return { ...runSummary(run), stateFile: store.stateFilePath(run.runId) };
}

// W4b：原 textResult(text, isError) helper 已删除——23 处错误路径全部改 throw
//（execute throw → pi agent-loop catch 置 isError:true——pi-agent-core dist/agent-loop.js
// executePreparedToolCall，1.0.0 实读 catch :581-588；1.0.0 起正常 return 的 isError
// 也被尊重，:579 isError: result.isError === true，0.84.4 才硬编码 false——本包失败
// 恒走 throw，行为不变），且本文件无非错误纯文本结果用途，无残留调用方。

/**
 * Subagent Workflow Extension — subagents tool（批量派发入口，一跳扁平 schema）。
 *
 * ⚠️ 命名同名不同命名空间，互指防混淆：本文件是 **tool**（模型调用的批量派发面，
 * 名为 `subagents`），`interface/command/subagents.ts` 是 **slash 命令**壳（`/subagents`：
 * TUI list overlay + GUI 定向消息通道）。两者无共享状态、无调用关系——改本文件
 * 不影响命令壳，反之亦然。
 *
 * 行为契约（设计 §3.1 终态 / §3.3 D1-D3、D8、D9）：
 * - 唯一批量入口：N 个已知独立任务一次派发；handler 按固定名解析内置 `fan-out`
 *   模板（FAN_OUT_SCRIPT_NAME，不经 registry 之外的第二套批机制），组装
 *   `args = {tasks, agents?, aggregate?}` 后交 runWorkflow 执行——**不生成脚本
 *   文本**，执行形态 = 内置模板 + 一跳扁平 args 透传。
 * - 执行形态保留间接层的原因：模板经 worker 执行模型（脚本 eval + postMessage
 *   调用协议）运载，该形态同时承载 resume 重放（脚本确定性重跑 + 已 settled 调用
 *   走 record 回放）、注入安全（workerData.scriptPath 定位 _shared，不回退当前目录）
 *   与脚本可探索性（@pi-meta 进可用 workflow 清单）——走 workflow 管道使批量派发
 *   继承持久化、journal、GUI 派生视图与断点恢复全套能力。
 * - 无 action 分发：status/abort 不复制，直接指路 workflow_control（runId 同体系）。
 * - 无 args 嵌套：tasks/agents/aggregate/... 全在顶层（弱模型信任 schema 结构信号，
 *   两跳转译是事故高发区——对照 workflow_run 的 name+args 形态）。
 * - 批量成员是一次性成员：不可 message/续聊（workflow-origin record 由 messageHandler
 *   拒绝），结果在 run 收尾时以一条通知（notifyDone）到达。
 * - 不构造 `details.__gui__`：GUI 挂载按 WORKFLOW_TOOL_NAMES 集合分流，批量块走
 *   workflow 块分支（恒折叠单行 + openWorkflowDrawer）；`__gui__` 的渲染点在普通
 *   tool 分支（v-else）的展开区内，isWorkflow 分支无展开路径不消费——构造即死代码
 *   （D8 裁决；workflow_run 的 `__gui__` 死构造已随之删除，isWorkflow 集合内工具零消费）。
 *
 * 层归属：Interface。依赖 Pi SDK + core lifecycle/registry + reentry-guard。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { MAX_TIMER_DELAY_MS, SLUG_MAX_LENGTH, THINKING_ORDER } from "@zhushanwen/subagent-core";
import type { LauncherDeps } from "@zhushanwen/subagent-core";
// formatAvailableWorkflowRefs：拒单可用清单单源（core launcher，副本已并入）。
import {
  assertEntryTimeBudget,
  assertSlugWithinLimit,
  formatAvailableWorkflowRefs,
  runWorkflow,
} from "@zhushanwen/subagent-core";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.ts";
import {
  assertNotAborted,
  buildRunSpecFromScript,
  optionSlugSuffix,
  renderTextResult,
} from "./tool-shared.ts";
import type { RunStartDetails, WorkflowToolResult } from "./tool-result.ts";

// ── Constants ────────────────────────────────────────────────

/**
 * 本工具的固定执行体（内置模板）脚本名。
 *
 * 常量而非参数：subagents tool 的契约就是「把 tasks 透传给 fan-out 模板」——参数化会让
 * 工具的语义随脚本漂移（对照 D3「执行管道唯一」）。脚本按名经 registry 解析
 * （内置名优先链与 workflow_run actionRun 同一条，见 plan U2「复刻既有加载路径」）。
 */
export const FAN_OUT_SCRIPT_NAME = "fan-out";

/** 批量标签时间短码基数（Date.now() 的 36 进制形态：8 字符覆盖到 2059 年）。 */
const SLUG_TIME_RADIX = 36;

// ── Parameter schema（D2：一跳扁平，无 action、无嵌套 args）──

const SubagentsParams = Type.Object({
  tasks: Type.Array(Type.String(), {
    description:
      "N complete, self-contained task prompts — one element = one dispatch. Members run as independent one-shot subagents (they do NOT see your conversation), so each must carry its own context and acceptance criteria. All run in parallel.",
  }),
  agents: Type.Optional(Type.String({
    description:
      "Comma-separated absolute paths to agent .md files (usually <location> values from <available_subagents>). One path applies to every member; N paths map one-to-one onto tasks in order and MUST equal the tasks count (mismatch fails the run). Omit for the default general-purpose executor.",
  })),
  aggregate: Type.Optional(Type.Boolean({
    description: "Default false. When true, one extra agent is appended to reduce all results into a single conclusion (results are still returned in full).",
  })),
  slug: Type.Optional(Type.String({
    description: "Batch label (max 35 chars, kebab-case) shown on the conversation block and run list. Omit to auto-generate.",
    maxLength: SLUG_MAX_LENGTH,
  })),
  model: Type.Optional(Type.String({
    // 缺省继承主 agent 的纪律句已删（D1 单源化→注入段，见
    // subagent-list-injector.ts SUBAGENT_DISPATCH_SHARED_RULES）；批内继承 run 级值是
    // 本参数的功能语义，保留。
    description:
      "Run-level model override in 'provider/modelId' format; every member of the batch inherits it.",
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description:
      "Run-level thinking depth for every member. Omit to default each agent to its model's highest available level.",
  })),
  tokens: Type.Optional(Type.Number({
    // 预算纪律句已删（D1 单源化→注入段）：跨工具预算纪律说一次，原文见 git 历史。
    description: "Max token budget for the whole batch.",
  })),
  time: Type.Optional(Type.Number({
    description: `Max time budget in ms for the whole batch (hard ceiling ${MAX_TIMER_DELAY_MS} ms — larger values fail fast at entry).`,
  })),
});

export type SubagentsToolParams = Static<typeof SubagentsParams>;

// ── Tool result types ────────────────────────────────────────

/**
 * `subagents` tool 的 details。
 *
 * 单形态（无 action 判别式——本工具只有一个动作）。刻意不含 `__gui__`（D8）：
 * 批量块由集合分流走 workflow 块分支，不消费 GUI 描述符。
 */
export interface SubagentsToolDetails extends RunStartDetails {
  /** 启动即返回（后台运行），恒 "running"。 */
  status: "running";
  /** 执行体模板名（恒 FAN_OUT_SCRIPT_NAME，供程序化消费方核对）。 */
  scriptName: string;
  /** 生效标签（模型提供的 slug，或 handler 生成的 fan-out-<时间短码>）。 */
  slug: string;
  taskCount: number;
}

/** Result returned by the `subagents` tool's execute（公共骨架见 tool-result.ts）。 */
type SubagentsExecuteResult = WorkflowToolResult<SubagentsToolDetails>;

// ── helpers ──────────────────────────────────────────────────

/**
 * 生成缺省批量标签 `fan-out-<时间短码>`（时间短码 = Date.now() 的 36 进制）。
 *
 * 长度：`fan-out-` (8) + 8 = 16 ≤ SLUG_MAX_LENGTH (35)，数十年内形态稳定
 * （36^8 = 2.8e12 ms ≈ 2059 年）——测试锁定该不变量。
 * 空串与空白串按「未提供」处理（避免状态侧出现空标签）。
 */
export function generateBatchSlug(now: number = Date.now()): string {
  return `${FAN_OUT_SCRIPT_NAME}-${now.toString(SLUG_TIME_RADIX)}`;
}

/** 启动返回文案（设计 §3.1 成功路径原文：一条通知 + 单次 status 恢复出口 + abort 指引）。 */
function subagentsStartupText(
  slug: string,
  runId: string,
  taskCount: number,
  scriptName: string,
): string {
  return [
    `Started batch '${slug}' (${runId}) as workflow run '${scriptName}' — ${taskCount} subagents dispatched in parallel (allSettled).`,
    "Results arrive as ONE notification when the run settles. Do NOT poll.",
    `If no notification arrives well past the expected duration, make a SINGLE status check: workflow_control {"action":"status"} with runId ${runId} (recovery exit, not a poll loop).`,
    `To abort: workflow_control {"action":"abort","runId":"${runId}"}`,
  ].join("\n");
}

/**
 * 批量运行体（execute 主体；导出供契约测试直接调用）。
 *
 * 失败形态与恢复动作见设计 §3.3 D9（本函数只做入口级 fail-fast：tasks 缺失/空、
 * slug 超长、time 超上界；tasks 元素/agents 数量错配由模板入口 fail-fast——run 即
 * 失败，两条路径不重复实现同一约束）。
 */
export async function runSubagentsBatch(
  params: SubagentsToolParams,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
): Promise<SubagentsExecuteResult> {
  // D9：tasks 缺失/空数组 → 入口 throw（pi 只对 execute throw 置 isError:true）。
  // 文案与其他 tool 的必填参数拒单同模板（<subject> requires '<param>' parameter.
  // Correct: <最小正确调用例>）：本工具无 action，主语用工具名。
  const tasks = params.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(
      'subagents requires \'tasks\' parameter (non-empty string array). Correct: {"tasks":["...","..."]}',
    );
  }

  // slug 运行时护栏（与 workflow_run actionRun 对称的纵深防御；schema maxLength 是第一道关卡）
  const providedSlug = params.slug?.trim();
  assertSlugWithinLimit(providedSlug, ["tri-review", "scan-docs"]);
  // 缺省（或空白）时 handler 生成 fan-out-<时间短码>：受益面 = 状态侧（drawer run header /
  // run 派生视图名）；对话流块面显示的是模型 input.slug（无 input 回写通路——D8 分面声明）。
  const slug = providedSlug ? providedSlug : generateBatchSlug();

  // OR-1 入口 fail-fast：schema 的 time 是 Type.Number 直通（无上界），超 setTimeout
  // 安全域的值会穿透到 lifecycle 内层防线（assertSafeTimerDelay）——入口拦截让它永不
  // 进入副作用链（判定与文案单点在 core shared/entry-guards）。
  const time = params.time;
  assertEntryTimeBudget(time);

  // 执行体脚本按固定内置名解析（registry.get 精确名匹配；脚本名是工具自带常量
  // FAN_OUT_SCRIPT_NAME 而非用户参数——workflow_run actionRun 的按名解析已退役
  // 走 getPath 单通道，本工具不允许换脚本，无 getPath 回落需求）。
  const script = await deps.registry.get(FAN_OUT_SCRIPT_NAME);
  if (!script || !script.available) {
    const all = await deps.registry.loadAll();
    const available = formatAvailableWorkflowRefs(all);
    throw new Error(
      `Built-in workflow '${FAN_OUT_SCRIPT_NAME}' is not available — the subagents tool runs it as its batch body. ` +
      `Recovery: verify the @zhushanwen/subagent-core package ships workflows/${FAN_OUT_SCRIPT_NAME}.js (reinstall/repair it), then retry. ` +
      `Workflows currently available:\n${available || "  (none)"}`,
    );
  }

  // D3 确定性 args 组装：tasks/agents/aggregate 原样进 args（模板参数侧，$ARGS）；未提供的
  // 缺省键不写入（模板侧 aggregate 缺省 false；空值不制造「都传/都缺」歧义形态）。
  const args: Record<string, unknown> = { tasks };
  if (params.agents !== undefined) args.agents = params.agents;
  if (params.aggregate !== undefined) args.aggregate = params.aggregate;

  const runId = await runWorkflow(
    buildRunSpecFromScript(script, {
      args,
      budgetTokens: params.tokens,
      budgetTimeMs: time,
      slug,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
    }),
    deps,
    signal,
  );

  return {
    content: [{ type: "text", text: subagentsStartupText(slug, runId, tasks.length, script.name) }],
    details: {
      runId,
      status: "running",
      scriptName: script.name,
      slug,
      taskCount: tasks.length,
      stateFile: deps.store.stateFilePath(runId),
    },
  };
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 `subagents` tool（唯一批量派发入口）。
 *
 * @param pi ExtensionAPI
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param reentryRef reentry guard。**与 workflow_run/workflow_control 共用同一实例**（index.ts
 *   factory 内创建的单例）——三者是同一条 runWorkflow 管道的入口，共用检查避免
 *   双 guard 语义漂移；workflow-script tool 的 isScriptRunning 是另一套 flag，
 *   与本 guard 无关。
 */
export function registerSubagentsTool(
  pi: ExtensionAPI,
  deps: LauncherDeps,
  reentryRef: ReentryGuardRef,
): void {
  pi.registerTool({
    name: "subagents",
    label: "Subagents (batch)",
    // tool-declaration-slimming U-C1 R1 裁决：低频批量入口延迟加载（defer 名单工具）。
    exposure: "deferred",
    description:
      "Spawn multiple subagents in ONE call, collect all results together — for N INDEPENDENT tasks.\n" +
      "Each member is a one-shot batch member: you cannot message or continue it (re-dispatch instead). Results arrive as ONE notification when the whole batch settles (not per member).\n" +
      "Single subagent you can message later: `subagent_message` tool. Dependent tasks (step 2 needs step 1's result): `workflow_run` tool — batch members never see each other's results.",
    promptSnippet: "Dispatch N independent subagent tasks in one batch",
    promptGuidelines: [
      "PRIORITY: 2+ independent tasks in one dispatch (results combined by you afterwards) → call `subagents` ONCE with the tasks array — do NOT issue N separate subagent_start calls and do NOT hand-build a workflow.",
      "One-shot batch members: message/fork-from is not supported; to redo or extend a member's work, dispatch a new task in a second batch.",
      // 勿等待条 / 预算纪律条 / 模型缺省继承条 三条已删（tool-declaration-slimming D1
      // 单源化→<available_subagents> 注入段 SUBAGENT_DISPATCH_SHARED_RULES 说一次，
      // 原文见 git 历史；零残留由 tool-subagents.test.ts 单源化终态断言锁定）。
      "Call shape (JSON): {\"tasks\":[\"<task 1>\",\"<task 2>\"],\"agents\":\"<abs .md path(s)>\",\"aggregate\":false,\"slug\":\"<label>\"} — tasks required, every element a complete self-contained prompt.",
      "Anti-patterns: nesting tasks under an 'args' key (top-level); dispatching dependent steps in one batch (chain across messages or use the `workflow_run` tool); treating batch results as verified without checking.",
      "Run control (status/abort) lives in the `workflow_control` tool — use the runId printed in this tool's output.",
    ],
    parameters: SubagentsParams,

    async execute(
      _toolCallId: string,
      params: SubagentsToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<SubagentsExecuteResult> {
      // throw（W4b 契约）：pi 只对 execute throw 置 isError:true，返回值里的 isError
      // 被 agent-loop 丢弃——错误一律 throw（abort 前置判定收敛在 tool-shared）。
      assertNotAborted(signal);
      // reentry guard：与 workflow_run/workflow_control 共用（acquire 失败时尚未持有 guard，throw 前无需 release）
      if (!acquireReentryGuard(reentryRef)) {
        throw new Error(REENTRY_BUSY_MESSAGE);
      }
      try {
        return await runSubagentsBatch(params, deps, signal);
      } finally {
        releaseReentryGuard(reentryRef);
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      // 单行标题：subagents <N tasks> · <slug>（TUI 惯例同 workflow_run 的 renderCall）
      const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
      const bulk = count > 0 ? ` ${count} tasks` : "";
      const slug = optionSlugSuffix(args.slug, theme);
      return new Text(
        theme.fg("toolTitle", theme.bold("subagents ")) +
          theme.fg("muted", bulk) +
          slug,
        0,
        0,
      );
    },

    renderResult: renderTextResult,
  });
}

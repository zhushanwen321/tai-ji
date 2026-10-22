/**
 * Subagent Workflow Extension — subagents tool（批量派发入口，一跳扁平 schema）。
 *
 * ⚠️ 命名同名不同命名空间，互指防混淆：本文件是 **tool**（模型调用的批量派发面，
 * 名为 `subagents`），`interface/command/subagents.ts` 是 **slash 命令**壳（`/subagents`：
 * TUI list overlay + GUI 定向消息通道）。两者无共享状态、无调用关系——改本文件
 * 不影响命令壳，反之亦然。
 *
 * 行为契约（subagent-tool-interface-refactor §3.1.2 批量终态 / §3.3.2）：
 * - 唯一批量入口：N 个已知独立任务一次派发；handler 按固定名解析内置 `fan-out`
 *   模板（FAN_OUT_SCRIPT_NAME，不经 registry 之外的第二套批机制），组装
 *   `args = {tasks}`（成员对象数组）后交 runWorkflow 执行——**不生成脚本
 *   文本**，执行形态 = 内置模板 + 一跳扁平 args 透传。
 * - 成员对象形状：tasks 元素 = {task, agent?, model?, thinkingLevel?}（schema 权威
 *   定义在 ./subagent-tool-schema.ts，与 start/manage/message 同文件供跨包契约测试
 *   import）。运行级 `agent` 由 handler 填入未指定 agent 的成员；`model` /
 *   `thinkingLevel` 不复制进成员——留空给 $MODEL/$THINKING_LEVEL 继承（workerData
 *   通路）。旧 `agents`（逗号串位置映射）与 `aggregate` 已从工具删除：出现即迁移
 *   检查 throw（typebox Object 不产 additionalProperties，schema 拒不了未知字段）。
 * - 执行形态保留间接层的原因：模板经 worker 执行模型（脚本 eval + postMessage
 *   调用协议）运载，该形态同时承载 resume 重放（脚本确定性重跑 + 已 settled 调用
 *   走 record 回放）、注入安全（workerData.scriptPath 定位 _shared，不回退当前目录）
 *   与脚本可探索性（@pi-meta 进可用 workflow 清单）——走 workflow 管道使批量派发
 *   继承持久化、journal、GUI 派生视图与断点恢复全套能力。
 * - 无 action 分发：status/abort 不复制，直接指路 workflow_control（runId 同体系）。
 * - 无 args 嵌套：tasks/agent/... 全在顶层（弱模型信任 schema 结构信号，
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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";

import type { LauncherDeps } from "@zhushanwen/subagent-core";
// formatAvailableWorkflowRefs：拒单可用清单单源（core launcher，副本已并入）。
import {
  assertEntryTimeBudget,
  assertModelInCatalog,
  assertSlugWithinLimit,
  formatAvailableWorkflowRefs,
  getModelConfigService,
  runWorkflow,
} from "@zhushanwen/subagent-core";
import { SubagentsParams } from "./subagent-tool-schema.ts";
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

// ── Parameter schema：权威定义在 ./subagent-tool-schema.ts（成员对象形状）──

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

/** 启动返回文案（subagent-tool-interface-refactor §3.1.4 样例原文：一条通知 + 成员一次性 + 单次恢复查询出口（then stop again）+ abort 指引）。 */
function subagentsStartupText(
  slug: string,
  runId: string,
  taskCount: number,
): string {
  return [
    `Started batch '${slug}' (${runId}) — ${taskCount} members, allSettled.`,
    "Results arrive as ONE notification when the run settles. Members are one-shot; to continue a member's work, dispatch a new task.",
    `If the notification has not arrived, make ONE query: workflow_control {"action":"status","runId":"${runId}"} (then stop again).`,
    `To abort: workflow_control {"action":"abort","runId":"${runId}"}`,
  ].join("\n");
}

/**
 * 旧字段迁移检查（§3.1.2「一个版本后删除」）：`agents`（逗号串位置映射）与
 * `aggregate` 已从工具删除。pi 参数校验对未知字段静默放行（typebox Object 不产
 * additionalProperties），而旧字段出现 = 模型记忆残留的混合形状，静默忽略会丢失
 * 用户意图（失败显式上报）——显式 throw 给成员对象 / 自行归约的 Correct 形状。
 */
function assertNoLegacyBatchFields(params: SubagentsToolParams): void {
  if (!("agents" in params || "aggregate" in params)) return;
  throw new Error(
    "subagents no longer accepts 'agents'/'aggregate' — batch members are objects now.\n" +
    'Correct (per-member executor): {"tasks":[{"task":"...","agent":"/abs/a.md"},{"task":"...","agent":"/abs/b.md"}]}\n' +
    'Correct (one executor for every member): {"tasks":[{"task":"..."}],"agent":"/abs/a.md"}\n' +
    "'aggregate' is removed: reduce the results into one conclusion yourself after the batch returns.",
  );
}

/**
 * 批量入口模型校验（§3.1.2 三层中的两层）：运行级 `model` 校验一次；成员显式
 * `model` 逐个校验并带成员下标（错误首行 source 标签 = member[i] model，模型可
 * 直接定位到第几个成员）。catalog 不可用时 fail-closed（§3.1.2：给出可操作错误，
 * 不静默跳过）——与 tool-workflow run action 的 warn+skip 降级是有意差异：成员级
 * 模型隔离是批量工具的核心契约，未校验的成员模型放行 = 契约失效。
 * `thinkingLevel` 无需入口校验：与运行级同一 StringEnum(THINKING_ORDER)（schema
 * 层即白名单），pi 参数校验拒绝非法档位。
 */
function assertBatchModelsInCatalog(params: SubagentsToolParams): void {
  const explicit: Array<{ source: string; model: string }> = [];
  if (params.model !== undefined) {
    explicit.push({ source: "run-level model override", model: params.model });
  }
  params.tasks.forEach((member, index) => {
    if (member.model !== undefined) {
      explicit.push({ source: `member[${index}] model`, model: member.model });
    }
  });
  if (explicit.length === 0) return;

  const modelService = getModelConfigService();
  if (modelService === null) {
    throw new Error(
      "Model catalog unavailable (model service not initialized) — subagents cannot verify explicit member models (fail-closed). " +
      "Recovery: retry after the session has fully started (session_start injects the model registry), " +
      "or omit the model params to inherit defaults.",
    );
  }
  for (const { source, model } of explicit) {
    assertModelInCatalog(model, modelService.getModelRegistry(), { source });
  }
}

/**
 * 批量运行体（execute 主体；导出供契约测试直接调用）。
 *
 * 失败形态与恢复动作见设计 §3.1.5（本函数只做入口级 fail-fast：旧字段迁移检查、
 * tasks 缺失/空、成员 task 空白、slug 超长、time 超上界、显式模型目录校验；
 * fan-out 模板入口另有成员形状/trim 检查——run 即失败，两条路径不重复实现同一约束）。
 */
export async function runSubagentsBatch(
  params: SubagentsToolParams,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
): Promise<SubagentsExecuteResult> {
  // 旧字段迁移检查最前：旧混合形态（对象 tasks + agents/aggregate 残留）直接拿
  // 迁移指引，不被后续形状检查的通用错误遮蔽。
  assertNoLegacyBatchFields(params);

  // tasks 缺失/空数组 → 入口 throw（pi 只对 execute throw 置 isError:true；真实
  // typebox 的 minItems:1 已拦空数组，此检查是 mock/纵深防御层）。文案与其他 tool
  // 的必填参数拒单同模板（Correct: <最小正确调用例>）。
  const tasks = params.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(
      'subagents requires \'tasks\' parameter (non-empty array of member objects). Correct: {"tasks":[{"task":"..."}]}',
    );
  }

  // 成员 task 非空白（三道防线：schema minLength:1 拦空串 → 本层 trim 检查拦纯空白串
  // （带成员下标，模型可直接定位修正，先行 fail-fast）→ fan-out 模板入口 trim（run 侧兜底））。
  for (const [index, member] of tasks.entries()) {
    if (typeof member.task !== "string" || member.task.trim() === "") {
      throw new Error(
        `subagents member[${index}] 'task' must be a non-empty prompt. ` +
        'Correct: {"tasks":[{"task":"<complete self-contained prompt>"}]}',
      );
    }
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

  // 显式模型入口校验（运行级一次 + 成员逐个带下标；catalog 不可用 fail-closed，§3.1.2）。
  assertBatchModelsInCatalog(params);

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

  // D3 确定性 args 组装：成员对象数组进 args（模板参数侧，$ARGS）。运行级 `agent`
  // 填入未指定 agent 的成员（§3.1.2：成员级值优先，运行级是缺省执行者）；model /
  // thinkingLevel 不复制进成员——留空给 $MODEL / $THINKING_LEVEL 继承（经
  // buildRunSpecFromScript 的 run 级字段 → workerData 流动）。
  const runLevelAgent = params.agent;
  const args: Record<string, unknown> = {
    tasks: tasks.map((member) =>
      member.agent === undefined && runLevelAgent !== undefined
        ? { ...member, agent: runLevelAgent }
        : member,
    ),
  };

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
    content: [{ type: "text", text: subagentsStartupText(slug, runId, tasks.length) }],
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
    // 常驻（subagent-tool-interface-refactor §3.3.4）：成员对象形状与成员级模型是
    // 首调正确性的关键，schema 必须第一轮可见（deferred 不进声明集，guidelines 不
    // 注入——ADR-0136 的 defer 名单据此移出 `subagents`）。不写 exposure 字段 =
    // SDK 默认 "direct"，与 start/manage/message/run/control 五个常驻工具同惯例。
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
      `Call shape (JSON): {"tasks":[{"task":"<task 1>","agent":"/abs/a.md"},{"task":"<task 2>"}],"slug":"<label>"} — tasks required, every element a member object (task + optional agent/model/thinkingLevel); "agent" also accepts a run-level default executor.`,
      "Anti-patterns: nesting tasks under an 'args' key (top-level); the removed 'agents' comma-string / 'aggregate' params (per-member 'agent' / run-level 'agent' / reduce results yourself instead); dispatching dependent steps in one batch (chain across messages or use the `workflow_run` tool); treating batch results as verified without checking.",
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

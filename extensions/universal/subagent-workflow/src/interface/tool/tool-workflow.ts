/**
 * Workflow Extension — workflow tool（4 actions，FR-5 tool 收口）。
 *
 * 合并原 tool-workflow.ts + tool-workflow-run.ts 为单 tool。
 *
 * Actions:
 * - run: registry.getPath → runWorkflow（直接启动，无需用户确认）
 * - status: 列出 runs（deps.runs）
 * - abort: 调 abortRun
 * - resume: 调 resumeRun（interrupted 态 run 断点续跑，D14 args 校验在入口）
 *
 * **restart 不包含**（D-9 废弃）；**pause 不包含**（一次性生命周期——run 不可
 * 挂起，提前停止用 abort，要新结果开新 run）。**resume 是中断恢复不是挂起恢复**：
 * 仅 interrupted 态 run 可续（崩溃收编 / terminate 被动失联后的断点续跑，
 * workflow-run-resume-revision U3/D14），不是把活跃 run 暂停再继续。
 *
 * 层归属：Interface。依赖 Pi SDK + Engine lifecycle/launcher + helpers。
 */

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
// [D8 创建期拒单] 模型目录分类裁决 + 宿主注入的模型清单投影访问器（既有投影面：
// session_start 把 ctx.modelRegistry 注入 ModelConfigService 单例——extension 零
// runtime import，H2/P5 宿主注入同款先例）。
import { assertModelInCatalog } from "@zhushanwen/subagent-core";
import { getModelConfigService } from "@zhushanwen/subagent-core";
// D9 closure：core args-meta 消费（reservedKeys 注入见下方 ARGS_META_OPTIONS）
// MAX_TIMER_DELAY_MS：OR-1 消费（barrel 导出，深路径经 u-2c 删通配后 tsc 不可解析）
import {
  argKeysFromMeta,
  findFlattenedArgKeys,
  MAX_TIMER_DELAY_MS,
  workflowNotFoundMessage,
} from "@zhushanwen/subagent-core";
import { assertEntryTimeBudget, assertEntryTokenBudget, assertSlugWithinLimit } from "@zhushanwen/subagent-core";
import { runSummary } from "@zhushanwen/subagent-core";
import { ID_PREVIEW_LENGTH } from "../format/id-preview.ts";
import type { RunStartDetails, WorkflowToolResult } from "./tool-result.ts";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.ts";
import { formatRunStatusElapsed } from "../format/format.ts";
import {
  assertNotAborted,
  buildRunSpecFromScript,
  optionSlugSuffix,
  renderTextResult,
  throwPrefixed,
} from "./tool-shared.ts";

// ── Parameter schema ─────────────────────────────────────────

/** workflow tool 的全部 action 枚举值（单一真相源）。 */
export type WorkflowAction =
  | "run"
  | "status"
  | "abort"
  | "resume";

const WORKFLOW_ACTIONS: readonly WorkflowAction[] = [
  "run",
  "status",
  "abort",
  "resume",
];

const WorkflowParams = Type.Object({
  action: StringEnum(WORKFLOW_ACTIONS, { description: "Workflow action to execute" }),
  name: Type.Optional(
    Type.String({ description: "Workflow ref: absolute path to a .js script — normally the <location> of a workflow from <available_workflows>, but ANY absolute .js path works if the file declares `@pi-meta kind: \"workflow\"` (the list is not required). Relative paths and bare names are rejected (run action)" }),
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "Short label (max 35 chars) for this run, shown in the TUI to distinguish concurrent runs. " +
        "If omitted, defaults to the script name.",
      maxLength: SLUG_MAX_LENGTH,
    }),
  ),
  runId: Type.Optional(
    Type.String({ description: "Workflow run ID (abort / resume action; find it via action:status)" }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Arguments passed to workflow as key-value pairs (run action). For resume: optional — when passed, " +
        "must deep-equal the run's original args (except the internal _runId key); mismatch is rejected with " +
        "the differing fields listed. Omit to reuse the original args.",
    }),
  ),
  tokens: Type.Optional(Type.Number({ description: "Max token budget — ONLY set when user explicitly requests a limit; omit = unlimited (default). For resume: the token budget applied to the resumed execution (tokens already spent by the run are counted against it)" })),
  time: Type.Optional(Type.Number({ description: `Max time budget in ms — ONLY set when user explicitly requests a limit; omit = unlimited (default; hard ceiling ${MAX_TIMER_DELAY_MS} ms — larger values fail fast at entry). For resume: the budget applied to the resumed execution (active time already spent by the run is counted against it; suspended time is not)` })),
  error: Type.Optional(
    Type.String({ description: "Error/reason message (optional, used with abort)" }),
  ),
  model: Type.Optional(Type.String({
    description: "Run-level model override in 'provider/modelId' format. When set, all agents spawned by this run inherit it by default (unless a per-call agent() opts.model is set). Omit to inherit the main agent's model.",
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description: "Run-level thinkingLevel override (off/minimal/low/medium/high/xhigh/max). All agents in this run inherit it by default. Omit to default each agent to its model's highest available level.",
  })),
});

type WorkflowToolParams = Static<typeof WorkflowParams>;

// ── Constants ────────────────────────────────────────────────

/**
 * tool 自身顶层键（workflow params schema 键）——workflow 参数名与 tool 键撞名时
 * （如 workflow 声明参数 name），顶层同名键是 tool 参数而非平铺（m6 评审 M-3）。
 * 未来新增 tool 顶层键需同步此集合。
 *
 * D9 下沉后作为 core args-meta 的 reservedKeys 注入（ArgMetaOptions）——core 缺省
 * 空集，不注入则撞名保护失效（run 调用顶层必有 action/name，会被误判平铺）。
 * export 供 detectors.test 复用同一集合防漂移。
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
  /** run 唯一持久件（record 事件流 <sessionDir>/workflow-state/<runId>.record.jsonl）的绝对路径。 */
  stateFile?: string;
}

// ── Tool result types ──

/**
 * Discriminated union of `workflow` tool `details` payloads.
 *
 * Discriminant: `action`. Each action's details shape is explicitly typed so
 * downstream consumers (structured-output) can narrow without unsafe casts.
 */
export type WorkflowToolDetails =
  | ({ action: "run"; name: string } & RunStartDetails)
  | { action: "status"; runs: RunSummary[] }
  | { action: "abort"; runId: string; status: string; reason?: string }
  | ({ action: "resume"; runId: string } & RunStartDetails);

/** Result returned by the `workflow` tool's execute（公共骨架见 tool-result.ts）。 */
type WorkflowExecuteResult = WorkflowToolResult<WorkflowToolDetails | undefined>;

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow tool（4 actions: run / status / abort / resume；pause 已随一次性
 * 生命周期移除——enum 拒绝由 pi 核心校验拦截，见 F3。resume = interrupted 态断点
 * 续跑，不是挂起恢复）。
 *
 * @param pi ExtensionAPI
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param reentryRef reentry guard。仅 workflow tool 使用——workflow-script tool
 *   有独立的 isScriptRunning flag（见 registerWorkflowScriptTool），不共用此 guard。
 *   注意：reentryRef 是 factory 级单例（index.ts 在 factory 内创建），跨 session 共享。
 *   当前 Pi 运行时单 session 串行（同一时刻只有一个 active session），跨 session
 *   不会并发触发 workflow action，故共享无竞态。若未来支持多 session 并发，需改为
 *   per-session guard。
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  deps: LauncherDeps,
  reentryRef: ReentryGuardRef,
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Execute and control workflows: run (start), status, abort, resume (continue an interrupted run).\n" +
      "Replaces workflow + workflow-run tools.",
    promptSnippet: "Run, abort, resume, or check workflow status",
    promptGuidelines: [
      "PRIORITY: When user says 'workflow', 'run workflow', try run action FIRST.",
      "All listed workflows run DIRECTLY with action:run — refs/descriptions come from " +
      "<available_workflows> (injected each turn). For parameter details, read the <location> " +
      "script file (script header has @pi-meta parameters + usage + phases). Do NOT use " +
      "workflow-script generate for patterns already covered by available workflows.",
      "run: pass the workflow ref as name — normally the <location> absolute .js path from <available_workflows>, but any absolute .js path with a valid @pi-meta also works (the list is not required). Bare names and relative paths are rejected with a not-found error listing locations.",
      "DO NOT bash sleep or poll status after starting — results appear automatically via notifyDone.",
      "Runs are one-shot: there is no pause — to stop a run early use abort; for a fresh result start a new run. " +
      "resume is ONLY for runs whose status is interrupted (crash or session-switch during execution): it replays " +
      "completed calls from the record at zero token cost and continues where the run stopped. " +
      "Do NOT resume a settled (done/failed/cancelled) run — start a new run instead.",
      "resume: pass the SAME args as the original run (they are verified field-by-field; a mismatch is rejected " +
      "with the differing fields listed). Omit args to reuse the original ones. Changed args = different intent = new run.",
      "Call shapes (JSON): " +
      "- run: {\"action\":\"run\",\"name\":\"<script>\",\"args\":{...},\"tokens\":N,\"time\":N,\"model\":\"<provider/modelId>\",\"thinkingLevel\":\"<level>\"}. " +
      "- status: {\"action\":\"status\"}. " +
      "- abort: {\"action\":\"abort\",\"runId\":\"<id>\"} (optional: {\"error\":\"<reason>\"}). " +
      "- resume: {\"action\":\"resume\",\"runId\":\"<id>\",\"args\":{...},\"tokens\":N,\"time\":N} — args/tokens/time optional.",
      "Budget: Do NOT set tokens/time unless the user explicitly requests a limit. Built-in workflows run unlimited by default.",
      "Model/thinkingLevel: omit by default (inherit main agent's model). Only set model/thinkingLevel when the user explicitly requests a specific model or thinking depth for this run.",
      "Anti-patterns: Flattening args sub-fields (task/items/...) to the top level — they belong inside args. Calling {\"action\":\"run\"} without name.",
      "CRITICAL: For orchestration patterns, ALWAYS use action:run with the <location> absolute " +
      "path of the matching listed workflow — NEVER use workflow-script action:generate to recreate patterns " +
      "already covered by available workflows. workflow-script generate is ONLY for novel patterns.",
    ],
    parameters: WorkflowParams,

    async execute(
      _toolCallId: string,
      params: WorkflowToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<WorkflowExecuteResult> {
 // P1-2: Honor abort signal up-front
      // throw（W4b）：pi 只对 execute throw 置 isError:true，返回值里的 isError
      // 被 agent-loop 丢弃（agent-loop.js:453-483）——文案原样进 toolResult。
      // abort 前置判定收敛在 tool-shared（三处 tool 同源）。
      assertNotAborted(signal);
 // P1-6: Reentry guard（acquire 失败时尚未持有 guard，throw 前无需 release）
      if (!acquireReentryGuard(reentryRef)) {
        throw new Error(REENTRY_BUSY_MESSAGE);
      }
      try {
        let result: WorkflowExecuteResult;
        // 断言为 WorkflowAction 联合——typebox Static 推断为 any，显式标注让 default
        // 分支的 never 穷尽检查生效（新增 action 时 tsc 报错强制补 case）。
        const action = params.action as WorkflowAction;
        switch (action) {
          case "run":
            result = await actionRun(params, deps, signal);
            break;
          case "status":
            result = actionStatus(deps);
            break;
          case "abort":
            result = await actionAbort(params, deps);
            break;
          case "resume":
            result = await actionResume(params, deps);
            break;
          default: {
            // Exhaustiveness check — 新增 WorkflowAction 成员时未补 case，tsc 在此报错。
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
      // workflow ref 是绝对路径，标题行显示取 basename 短名（displayWorkflowName，
      // 与 subagent 标题行的 displayAgentName 对称）；runId/slug 不受影响。
      const name = args.name ? ` ${displayWorkflowName(String(args.name))}` : "";
      // run action 可选 slug：在 name 后追加 · slug（accent 色）
      const slug = optionSlugSuffix(args.slug, theme);
      const runId = args.runId ? ` ${String(args.runId).slice(0, ID_PREVIEW_LENGTH)}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow ")) +
          theme.fg("muted", action) +
          theme.fg("accent", name) +
          slug +
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
  params: WorkflowToolParams,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
): Promise<WorkflowExecuteResult> {
  const name = params.name;
  if (!name) {
    throw new Error(
      "run requires 'name' parameter (an absolute .js path, e.g. a <location> from <available_workflows>). Correct: {\"action\":\"run\",\"name\":\"<ref>\"}",
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
  // P5 修复发现面后注册表会命中内置名让裸名「复活」——反向违反终态裁决，故机制
  // 删除而非禁用。行为变更四要素：量级 = 裸名派发调用；旧行为 = registry.get 命中
  // 即启动；新行为 = not_found 拒单（零 token 沉没）；恢复 = 按清单 location 重试。
  const script = await deps.registry.getPath(name);
  // W4c：config-loader 的 toCachedMeta 对不可读/不存在文件返回 available:false 的
  // stub（非 undefined），仅判 !script 会绕过 not_found → 空 sourceCode 假启动
  //（W4b verifier 探针实测复现）。
  if (!script || !script.available) {
    // throw（W4）：pi 只对 execute throw 置 isError:true，返回值里的 isError 被
    // agent-loop 丢弃（agent-loop.js:453-483）——文案原样进 toolResult。
    // [全路径自救指引] 清单逐条附绝对路径 location：run 的 name 形参最贴近的
    // 读取面就是本清单（<available_workflows> 注入面在 start 时已过时/可能不在
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
      `Correct: {"action":"run","name":"${name}","args":{${flattened.map((k) => `"${k}": "<value>"`).join(", ")}}}`,
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
  // 负值同在入口拒绝：tokens 负值会被 Budget 的 maxTokens>0 守卫、time 负值会被
  // lifecycle 的 budgetTimeMs>0 判定静默升格 unlimited（显式预算被忽略），入口拦截
  // 替代静默升格。
  assertEntryTimeBudget(time);
  assertEntryTokenBudget(tokens);

  // [D8 创建期拒单] 工具参数 model 是创建期唯一静态声明源（agent 资产 frontmatter
  // model 随脚本 JS 动态求值不可静态解析——由派发期 isPiRoute 对称校验覆盖，
  // 见 workflow-dispatch.resolveWorkflowIdentity）。查无 = run 创建失败（同步 throw，
  // 零 spawn 零 token），错误列可用清单 + 分类修复指引（查无 vs provider 配置漂移）。
  // 目录经宿主注入投影访问：session_start 已把 ctx.modelRegistry 注入
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
 // 校验失败 → ArgsValidationError 直接 throw 给 pi（W4：err.message 含 §5.3 指引，
 // pi catch 后原文案进 toolResult content 并置 isError:true），其他错误保持传播）
  const runId = await runWorkflow(
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


// ── status action ────────────────────────────────────────────

function actionStatus(deps: LauncherDeps): WorkflowExecuteResult {
  const runs = Array.from(deps.runs.values());
  if (runs.length === 0) {
    return {
      content: [{ type: "text", text: "No workflows in current session." }],
      details: { action: "status", runs: [] },
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
    details: { action: "status", runs: summaries },
  };
}

// ── abort action ─────────────────────────────────────────────

/**
 * [W2/V1 D1 分流表第 6 行] 单一判源函数（CLI 面显示/排序的混合判源收拢）：输出
 * 投影三态 status（running|interrupted|done——重水合中断 run 经 meta.interruptedAt
 * 投影中断态，[D2] 与 shared WorkflowRunStatus 三态同词；活体终局经进程内终局
 * 记录注册表判定、恢复路径写点 run 经聚合 status 读）。判源 = core runSummary
 * 投影，散落的等价分支形态不采用（D1 否决记录：散落分支在 grep 层不可区分，
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
  params: WorkflowToolParams,
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
    // 取 runSummary 投影（活体终局经终局记录派生 DoneReason——原两态机字段读随
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
  params: WorkflowToolParams,
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

  const options: ResumeRunOptions = {
    ...(params.time !== undefined ? { budgetTimeMs: params.time } : {}),
    // token 预算显式覆盖（与 time 同款通道；三档回落与落盘归 core 单点）
    ...(params.tokens !== undefined ? { budgetTokens: params.tokens } : {}),
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

/** WorkflowRun → 摘要（status action 用）：core runSummary 单源投影 + 宿主扩展 stateFile。
 *
 * 字段集不再本地维护（runSummary 双投影分叉的收口点，D8/B5）；stateFile 依赖
 * RunStore 实例，属宿主扩展——core 投影刻意不依赖具体 store。 */
function toRunSummary(run: WorkflowRun, store: RunStore): RunSummary {
  return { ...runSummary(run), stateFile: store.stateFilePath(run.runId) };
}

// W4b：原 textResult(text, isError) helper 已删除——23 处错误路径全部改 throw
// （pi 只对 execute throw 置 isError:true，返回值里的 isError 被 agent-loop 丢弃，
// agent-loop.js:453-483），且本文件无非错误纯文本结果用途，无残留调用方。

/**
 * Workflow Extension — tool-workflow-script
 *
 * workflow-script tool，5 actions（FR-5：脚本领域收敛为单 tool）。
 *
 * Actions:
 * - generate: AI 生成临时脚本 → 写 .pi/workflows/.tmp/
 * - lint: 静态检查脚本（调 engine/script-lint.ts lintScript）
 * - save: 临时脚本转固定（.tmp → .pi/workflows/）
 * - delete: 删除脚本（前查 isRunning 防删运行中脚本）
 * - list: 列出可用脚本（调 registry.loadAll）
 *
 * C5②（convergence D-6）：generate 五项校验管线 + tmp 写盘下沉 core
 * generateWorkflowScript（报错文案逐字平移，CA2 前提）；save/delete 改调 core
 * barrel（第三可选目录参数缺省即 pi 布局 .pi/workflows——pi 现两参调用形态零变化）。
 * 结构化 {ok}|{error} → pi 的 execute-throw 契约转换在本层（pi 1.0.0：execute 抛出经
 * pi-agent-core agent-loop.js executePreparedToolCall 外层 catch 统一转 isError:true）；
 * AbortSignal 的 aborted 检查在 execute 入口统一拦截（与
 * workflow / subagents 两 tool 同源，tool-shared assertNotAborted；C4 偏差 #4）。
 *
 * 层归属：Interface。依赖 Pi SDK + engine script-lint + infra workflow-files。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import {
  guiComponent,
  type GuiRenderResult,
} from "@zhushanwen/extension-protocol";
// C5②/C5⑦：创作闭环统一走 core barrel（generateWorkflowScript/saveWorkflow/
// deleteWorkflow/lintScript 均为 barrel 导出范围；深路径在 npm/vendored 形态不可达）
import {
  deleteWorkflow,
  formatAvailableWorkflowRefs,
  generateWorkflowScript,
  lintScript,
  saveWorkflow,
} from "@zhushanwen/subagent-core";
import type { WorkflowScriptRegistry } from "@zhushanwen/subagent-core";
import { toGuiCtx } from "../gui/gui-mappers.ts";
import type { WorkflowToolResult } from "./tool-result.ts";
import { assertNotAborted, renderTextResult, throwPrefixed, withGuiAttach } from "./tool-shared.ts";

// ── Parameter schema ─────────────────────────────────────────

const WorkflowScriptParams = Type.Object({
  action: StringEnum(["generate", "lint", "save", "delete", "list"] as const, {
    description: "Script management action",
  }),
  name: Type.Optional(
    Type.String({ description: "Workflow script name (generate/lint/save/delete)" }),
  ),
  script: Type.Optional(
    Type.String({ description: "Complete JS workflow script content (generate only)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "Workflow purpose (generate only)" }),
  ),
  newName: Type.Optional(
    Type.String({ description: "New name when saving a tmp script (save --as only)" }),
  ),
});

export type ScriptParams = Static<typeof WorkflowScriptParams>;

// ── Tool result types (S3: typed details, replaces Record<string, unknown>) ──

/**
 * Discriminated union of `workflow-script` tool `details` payloads.
 *
 * Discriminant: `action`. `save`/`delete` may surface structured `ok:false`
 * details on failure (instead of bare `undefined`) so programmatic consumers
 * can distinguish error shape from success.
 *
 * 收起态一行摘要 `summary`（约定见 docs/extensions/extension-conventions.md
 * 「Tool result details.summary 约定」）：5 个 action variant 由 buildScriptSummary
 * 统一推导（withScriptSummary 构造单点）；无 action 的 variant 承载原
 * `details: undefined` 的纯文本结果（lint 0 findings / list 空清单）——只带
 * 显式传入的 summary，历史 entry 的 details 缺 summary 字段由读侧兜底。
 */
export type WorkflowScriptToolDetails =
  | { action: "generate"; path: string; name: string; status: "ready"; summary: string; __gui__?: GuiRenderResult }
  | { action: "lint"; name: string; valid: boolean; findingCount: number; summary: string; __gui__?: GuiRenderResult }
  | { action: "list"; count: number; summary: string; __gui__?: GuiRenderResult }
  | { action: "save"; name: string; ok: boolean; summary: string; __gui__?: GuiRenderResult }
  | { action: "delete"; name: string; ok: boolean; summary: string; __gui__?: GuiRenderResult }
  | { summary: string; __gui__?: GuiRenderResult };

/** Result returned by the `workflow-script` tool's execute（公共骨架见 tool-result.ts）。 */
export type WorkflowScriptExecuteResult = WorkflowToolResult<WorkflowScriptToolDetails | undefined>;

// ── GUI 协议 helpers ───────────────────────────────────────

/**
 * 按 WorkflowScriptToolDetails 构造 stats-line GuiComponent。
 *
 * 所有 5 个 action 都映射到 stats-line（单行统计，无复杂结构）：
 *   - generate: 显示生成的脚本名
 *   - lint: passed / N findings
 *   - list: 脚本数量
 *   - save/delete: ok/warn
 */
export function buildScriptGui(details: WorkflowScriptToolDetails) {
  // summary-only details（原 details:undefined 的纯文本结果）：无结构化 stats 可提取，
  // 用摘要文本构造中性 stats-line，避免落进下方 switch 的 action 未知的防御兜底
  if (!("action" in details)) {
    return guiComponent("stats-line", {
      items: [{ label: "done", value: details.summary, severity: "ok" }],
    });
  }
  switch (details.action) {
    case "generate":
      return guiComponent("stats-line", {
        items: [{ label: "generated", value: details.name, severity: "ok" }],
      });
    case "lint":
      return guiComponent("stats-line", {
        items: [
          {
            label: "lint",
            value: details.valid ? "passed" : `${details.findingCount} findings`,
            severity: details.valid ? "ok" : "warn",
          },
        ],
      });
    case "list":
      return guiComponent("stats-line", {
        items: [{ label: "scripts", value: String(details.count), severity: "ok" }],
      });
    case "save":
    case "delete":
      return guiComponent("stats-line", {
        items: [
          {
            label: details.action,
            value: details.name,
            severity: details.ok ? "ok" : "warn",
          },
        ],
      });
    default:
      // 防御性兜底：action 是有限联合类型，理论不可达。
      // 若未来新增 action 忘了更新此 switch，返回中性 stats-line 而非 undefined。
      return guiComponent("stats-line", {
        items: [{ label: "action", value: String((details as { action: string }).action), severity: "warn" }],
      });
  }
}

// ── 收起态一行摘要（details.summary，TUI 折叠渲染与 taiji GUI ToolRow 读链共用同源文本）──

/** 分布式 Omit（union 逐成员去 key——普通 Omit 不分发，会坍缩成单成员） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** details 构造点传入的形态（summary 写入前 = WorkflowScriptToolDetails 去 summary） */
type WorkflowScriptDetailsInput = DistributiveOmit<WorkflowScriptToolDetails, "summary">;

/**
 * 按 action 从 details 推导收起态一行摘要（纯函数，英文一行、描述动作 + 目标；
 * 拿不到的数据省略后缀）。措辞与 buildScriptGui 的 stats-line 值域对齐
 * （lint：valid → "passed"，否则 "N findings"）。
 */
export function buildScriptSummary(_params: ScriptParams, details: WorkflowScriptDetailsInput): string {
  if (!("action" in details)) return "";
  switch (details.action) {
    case "generate":
      return `Script ${details.name} generated`;
    case "lint":
      return details.valid
        ? `Script ${details.name} linted: passed`
        : `Script ${details.name} linted: ${details.findingCount} findings`;
    case "list":
      return details.count === 1 ? "Listed 1 workflow script" : `Listed ${details.count} workflow scripts`;
    case "save":
      return `Script ${details.name} saved`;
    case "delete":
      return `Script ${details.name} deleted`;
    default:
      return "";
  }
}

/** details 构造单点包装：附加 buildScriptSummary 推导的 summary（各 action 出口统一走此） */
function withScriptSummary(
  params: ScriptParams,
  details: WorkflowScriptDetailsInput,
): WorkflowScriptToolDetails {
  return { ...details, summary: buildScriptSummary(params, details) };
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow-script tool（5 actions: generate/lint/save/delete/list）。
 *
 * @param pi ExtensionAPI
 * @param registry WorkflowScriptRegistry
 * @param isRunning 判断脚本是否正在运行（delete 前防删运行中脚本；factory 传入）
 */
export function registerWorkflowScriptTool(
  pi: ExtensionAPI,
  registry: WorkflowScriptRegistry,
  isRunning: (name: string) => boolean,
): void {
  pi.registerTool({
    name: "workflow-script",
    label: "Workflow Script",
    // tool-declaration-slimming U-C1 R1 裁决：低频脚本管理侧延迟加载（defer 名单工具）。
    exposure: "deferred",
    description:
      "Manage workflow scripts: generate (AI creates tmp script), lint (static check), " +
      "save (tmp→permanent), delete, list. Before generating a new script, use action:list " +
      "to check if an available workflow already " +
      "covers the use case.",
    promptSnippet: "Generate, lint, save, delete, or list workflow scripts",
    promptGuidelines: [
      "generate: AI writes a tmp workflow script to .pi/workflows/.tmp/. Declare metadata as a /* @pi-meta */ YAML block comment (name/description/phases required; parameters JSON Schema + usage markdown optional). NOT a const meta variable. Generate round-trip-validates the YAML and reports line/col on error (common pitfall: patternProperties regex must use double backslash \\d, not \d).",
      "lint: Statically check a script for common API misuse (outputSchema, result.output, file state).",
      "save: Promote a tmp script to permanent (.pi/workflows/).",
      "delete: Remove a script (blocked if a run is active).",
      "list: Show all available workflow scripts with source tags. " +
      "Use this to discover available workflows (see <available_workflows> injection) " +
      "and user-generated scripts before starting a run. After listing, start a script via " +
      "the `workflow_run` tool with the script name.",
      "CRITICAL ANTI-PATTERN: NEVER generate scripts for patterns already covered by available " +
      "workflows. These are BUILT-IN — run them directly via `workflow_run`. " +
      "generate is for NOVEL orchestration patterns ONLY. When in doubt, action:list first, " +
      "then run — not action:generate.",
    ],
    parameters: WorkflowScriptParams,

    async execute(
      _toolCallId: string,
      params: ScriptParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<WorkflowScriptExecuteResult> {
      // P1-2 abort 前置（三 tool 对称）：5 个 action 统一在 execute 入口拦截——
      // 原先只在 generate 内检查，lint/save/delete/list 四路径漏拦。throw（W4b）：
      // 错误路径统一 throw（单一错误路径纪律；pi 1.0.0 agent-loop 对抛出统一转
      // isError:true error result）。
      assertNotAborted(signal);
      let result: WorkflowScriptExecuteResult;
      switch (params.action) {
        case "generate":
          result = actionGenerate(params);
          break;
        case "lint":
          result = await actionLint(params, registry);
          break;
        case "save":
          result = await actionSave(params);
          break;
        case "delete":
          result = actionDelete(params, registry, isRunning);
          break;
        case "list":
          result = await actionList(params, registry);
          break;
        default:
          // 防御性（schema StringEnum 先拦）：throw（W4b）——错误路径统一 throw
          // （pi 1.0.0 pi-agent-core agent-loop.js executePreparedToolCall :579-588：
          // 抛出经外层 catch 转 isError:true error result）。
          throw new Error(`Unknown action: ${String(params.action)}`);
      }
      // GUI 协议：RPC 模式下附加 __gui__ 到 details（attach 单点在 tool-shared）
      return {
        ...result,
        details: withGuiAttach(result.details, toGuiCtx(ctx), buildScriptGui),
      };
    },

    renderCall(args: ScriptParams, theme: Theme, _context?: unknown) {
      const label = `workflow-script ${args.action}`;
      const name = args.name ?? "";
      const text =
        theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg("accent", name);
      return new Text(text, 0, 0);
    },

    renderResult(
      // 宽入参（SDK AgentToolResult 的 content 可含 image 块，窄 view 会逆变失配）：
      // 本 handler 只消费 details.summary 与 content 文本兜底
      result: {
        content?: Array<{ type: string; text?: string }>;
        details?: WorkflowScriptToolDetails | undefined;
      },
      options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      // 折叠态 + 有 summary → 一行摘要（details.summary 约定，见 extension-conventions.md）；
      // details 为 undefined / 历史 entry 无 summary → 落回 renderTextResult 全文渲染（向后兼容）
      const summary = result.details?.summary;
      if (!options.expanded && summary) {
        return new Text(theme.fg("dim", summary), 0, 0);
      }
      return renderTextResult(result);
    },
  });
}

// ── generate action ──────────────────────────────────────────

export function actionGenerate(params: ScriptParams): WorkflowScriptExecuteResult {
  // throw（W4b）：错误路径统一 throw（单一错误路径纪律；pi 1.0.0 agent-loop 对抛出
  // 统一转 isError:true error result）。
  // abort 前置在 execute 入口统一拦截（三 tool 同源，tool-shared assertNotAborted），
  // 本函数不再自带 signal 检查。
  const name = params.name ?? "";
  const script = params.script ?? "";

  // C5②：五项校验（ESM 拒/meta 必需/agent() 必需/语法/@pi-meta round-trip）+ tmp 写盘
  // 全部在 core generateWorkflowScript（缺省 tmpDir 即 pi 布局 .pi/workflows/.tmp，
  // 相对 cwd resolve——与旧本地实现一致）。结构化 {ok}|{error} → execute-throw 契约
  // 转换在此（报错文案逐字平移自 pi 旧版，含 round-trip 行列信息）。
  const result = generateWorkflowScript(name, script);
  if (!result.ok) {
    throw new Error(result.error);
  }
  // result.ok ⇒ name/script 非空（core 对空入参返回 error）
  const filePath = result.path;

  return {
    content: [
      {
        type: "text",
        text: `Generated workflow script: ${filePath}\nName: ${name}\nReady to run via the \`workflow_run\` tool.`,
      },
    ],
    details: withScriptSummary(params, { action: "generate", path: filePath, name, status: "ready" }),
  };
}

// ── lint action ──────────────────────────────────────────────

async function actionLint(
  params: ScriptParams,
  registry: WorkflowScriptRegistry,
): Promise<WorkflowScriptExecuteResult> {
  const name = params.name;
  if (!name) {
    throw new Error(
      "lint requires 'name' parameter. Correct: {\"action\":\"lint\",\"name\":\"<script>\"}",
    );
  }
  const source = await loadScriptSource(name, registry);
  if (!source) {
    // 清单 item 走 core formatAvailableWorkflowRefs 缺省形态（有意统一：与 run 拒单
    // 一致带 location 行，自纠指引同构）；"Available:" 标题与 (none) 空态是本调用点
    // 的语境文案。
    const all = await registry.loadAll();
    const suggestions = formatAvailableWorkflowRefs(all);
    throw new Error(
      `Workflow '${name}' not found or not available.\nAvailable:\n${suggestions || "  (none)"}`,
    );
  }

  const result = lintScript(source);
  if (result.findings.length === 0) {
    return textResult(`✅ No issues found in '${name}'.`, `Script ${name} linted: 0 issues`);
  }

  const lines = result.findings.map((f) => {
    const icon = f.severity === "error" ? "❌" : "⚠️";
    return `${icon} L${f.line}: ${f.message}\n   Suggestion: ${f.suggestion}`;
  });
  return {
    content: [
      {
        type: "text",
        text: `${result.valid ? "Warnings" : "Errors"} found in '${name}':\n\n${lines.join("\n\n")}`,
      },
    ],
    details: withScriptSummary(params, {
      action: "lint",
      name,
      valid: result.valid,
      findingCount: result.findings.length,
    }),
    isError: !result.valid,
  };
}

/**
 * 加载脚本源码（lint 用）。通过 registry port 获取——registry 返回的
 * WorkflowScript 自带 sourceCode（FR-2：registry 是唯一读文件处），
 * 不再穿透到 config-loader 直接扫文件系统。
 */
async function loadScriptSource(
  name: string,
  registry: WorkflowScriptRegistry,
): Promise<string | undefined> {
  const script = await registry.get(name);
  return script?.available ? script.sourceCode : undefined;
}

// ── save action ──────────────────────────────────────────────

async function actionSave(params: ScriptParams): Promise<WorkflowScriptExecuteResult> {
  const name = params.name;
  if (!name) {
    throw new Error(
      "save requires 'name' parameter (tmp script name). Correct: {\"action\":\"save\",\"name\":\"<tmp-script>\"}",
    );
  }
  try {
    const result = await saveWorkflow(name, params.newName);
    return {
      content: [{ type: "text", text: result }],
      details: withScriptSummary(params, { action: "save", name, ok: true }),
    };
  } catch (err: unknown) {
    throwPrefixed("Save failed", err);
  }
}

// ── delete action ────────────────────────────────────────────

function actionDelete(
  params: ScriptParams,
  registry: WorkflowScriptRegistry,
  isRunning: (name: string) => boolean,
): WorkflowScriptExecuteResult {
  const name = params.name;
  if (!name) {
    throw new Error(
      "delete requires 'name' parameter. Correct: {\"action\":\"delete\",\"name\":\"<script>\"}",
    );
  }
 // deleteWorkflow 内部检查 isRunning（防止删运行中脚本）
  try {
    const result = deleteWorkflow(name, isRunning);
 // 失效 registry 缓存（下次 list/get 重扫）
    registry.invalidate();
    return {
      content: [{ type: "text", text: result }],
      details: withScriptSummary(params, { action: "delete", name, ok: true }),
    };
  } catch (err: unknown) {
    throwPrefixed("Delete failed", err);
  }
}

// ── list action ──────────────────────────────────────────────

async function actionList(
  params: ScriptParams,
  registry: WorkflowScriptRegistry,
): Promise<WorkflowScriptExecuteResult> {
  try {
    const all = await registry.loadAll();
    // item 行走 core formatAvailableWorkflowRefs（includeSource 保留 [saved]/[tmp]
    // 标签、去 location 行、分隔符统一为 ":"——与拒单 item 模板单源）；标题与空态
    // 是本调用点的语境文案。
    const lines = formatAvailableWorkflowRefs(all, { includeSource: true, includeLocation: false });
    if (lines === "") {
      return textResult("No workflow scripts available.", "Listed 0 workflow scripts");
    }
    return {
      content: [{ type: "text", text: `Available workflows:\n${lines}` }],
      details: withScriptSummary(params, {
        action: "list",
        count: all.filter((wf) => wf.available).length,
      }),
    };
  } catch (err: unknown) {
    throwPrefixed("List failed", err);
  }
}

// ── helper ───────────────────────────────────────────────────

/**
 * 构造纯文本非错误结果（W4b：isError 参数已删除——异常错误路径一律 throw（单一
 * 错误路径纪律；pi 1.0.0 pi-agent-core agent-loop.js :579-588 对抛出统一转
 * isError:true error result），编译器兜底防回潮）。details 原为 undefined，改带
 * summary-only details（收起态一行摘要；summary 由调用方按 action 显式给出）。
 */
function textResult(text: string, summary: string): WorkflowScriptExecuteResult {
  return {
    content: [{ type: "text", text }],
    details: { summary },
  };
}

/**
 * @zhushanwen/pi-canvas —— 问题解决画布工具面（设计 §3.1(2) / §5-U4）。
 *
 * 六工具动词族，全部 exposure:"deferred"（画布是低频入口，不设常驻 direct——
 * tool_search 检索激活，一次检索同族 action 全解锁）。每工具 execute 将调用
 * 转译为 CANVAS_MARKER 的 {action, params} 嵌套载荷（契约 SSOT 在
 * @zhushanwen/extension-protocol 的 src/extensions/canvas/ 契约模块，U1），经 ctx.ui.select
 * 挂起由 taiji runtime 的 marker 显式分支路由到 CanvasService。
 *
 * 宿主检测：工具调用前检查 TAIJI_AGENT_EXT_LOG === "1" 且 ctx.mode === "rpc"
 * （对齐 plan isTaijiGuiHost 完整谓词，src/host.ts）——非 taiji GUI 宿主返回
 * 结构化错误、不进入 select（禁超时探测）。
 *
 * 该扩展不收窄宿主工具集（与 plan 的根本差异：agent 要边查代码边论证边生长），
 * 也无 per-session 状态——画布状态唯一权威在 runtime CanvasService。
 *
 * <available_tools> 常驻存在性段（before_agent_start 注入）：pi 1.0.0 下 deferred
 * 工具的 description 只进 tool_search 检索文档、promptSnippet 不进 system prompt
 * （D3-A1 真机验收实证：模型对画布工具零感知，自然语言驱动不会发起检索）——
 * 本段把六工具 name + description 常驻进 system prompt 并写明「需先 tool_search
 * 激活」，subagent-workflow <available_subagents> 注入段同族形态。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";

import { setPiHandle } from "@zhushanwen/pi-extension-logger";

import { isTaijiGuiHost } from "./host.js";
import { CanvasEnterParams, registerCanvasEnterTool } from "./tool-enter.js";
import { CanvasEditParams, registerCanvasEditTool } from "./tool-edit.js";
import { CanvasReadParams, registerCanvasReadTool } from "./tool-read.js";
import { CanvasReviewParams, registerCanvasReviewTool } from "./tool-review.js";
import { CanvasExportParams, registerCanvasExportTool } from "./tool-export.js";
import { CanvasListParams, registerCanvasListTool } from "./tool-list.js";

/**
 * 六工具对外描述单源（SSOT）：registerTool 的 description 与 <available_tools>
 * 常驻段共用同一份数据，双处文本零漂移。
 */
export const CANVAS_AVAILABLE_TOOLS: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: "canvas_enter",
    description:
      "Enter problem-solving-canvas mode: CREATE a canvas (pass statement + criterias + scope — the root problem triple) or OPEN an existing one (pass canvasId from canvas_list). " +
      "Use when the user asks to plan / think through / break down a problem before execution: the canvas is a human-agent co-edited argument map the user watches and rules on in the taiji GUI. " +
      "After entering, the user's GUI decisions (selections / vetoes / comments) arrive as canvas event notifications — always canvas_read the current state before responding. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
  },
  {
    name: "canvas_edit",
    description:
      "Grow and edit the problem-solving canvas: grow (append a batch of nodes — decomposition, options, arguments), patch (edit one node), select (mark the chosen option; replace to re-select with a comparison reason), transition (lifecycle moves like reject-with-record), comment-respond (answer a user comment — adopted or rebutted, never ignored). " +
      "Reason fields are mandatory (audit trail); always canvas_read first and edit the CURRENT state. " +
      "Structural guarantee: user-side rulings arrive as notifications, agent-side edits never self-notify. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
  },
  {
    name: "canvas_read",
    description:
      "Read the problem-solving canvas: full state or one subtree (nodes / edges / comments / review report / convergence flags). " +
      "The read-before-act discipline entry: respond to canvas event notifications and edit the canvas only after reading the current state. " +
      "Also the reviewer subagent's query surface. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
  },
  {
    name: "canvas_review",
    description:
      "Run the canvas adversarial review loop: run (dispatch one reviewer subagent over the six-dimension checklist — completeness / necessity / support / authenticity / conflict / depth — and write the report back; R2+ pass scope to re-review only the resolution table), append (reviewer report write path), resolve (register one entry's disposition: accepted / deferred / rejected-with-reason — the fix side's duty after repairing). " +
      "must-fix entries block convergence until cleared. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
  },
  {
    name: "canvas_export",
    description:
      "Export a converged canvas: 'planning-doc' (full direction-planning document) or 'requirement-card' (one execution leaf, pass leafId). " +
      "Rejected with not_converged until the canvas has converged (must-fix cleared, no dirty paths, root criterias confirmed). " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
  },
  {
    name: "canvas_list",
    description:
      "List all problem-solving canvases (id, name, statement, converged flag, open must-fix count, review status). " +
      "The canvasId source for canvas_enter's open form. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
  },
];

/**
 * 构造 <available_tools> 段文本：工具清单 + 检索激活指引（纯函数，导出供单测）。
 * description 单行化（注册侧 description 均为单行拼接串；列表项内换行会破坏
 * 列表形态，防御外部将来传入多行文本）。
 */
export function buildAvailableToolsSection(tools: ReadonlyArray<{ name: string; description: string }>): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description.replace(/\s+/g, " ").trim()}`);
  return [
    "<available_tools>",
    "The tools below are registered but NOT loaded into your toolset — calling one directly fails.",
    "To use one, first call `tool_search` with a query matching its name or purpose (e.g. \"canvas enter problem solving\");",
    "the match is activated and callable from your next turn.",
    "",
    ...lines,
    "</available_tools>",
  ].join("\n");
}

export default function canvasExtension(pi: ExtensionAPI): void {
  // logger 持久化通道接入（appendEntry custom entry，不进 LLM 上下文）
  setPiHandle(pi);

  // 注册配置：description 从 CANVAS_AVAILABLE_TOOLS 单源引用（逐工具索引；两处
  // 文本零漂移）；promptSnippet = 工具激活后 system prompt 工具索引里的精简条目
  // （未激活时不进上下文，入口可见性由 <available_tools> 常驻段承载）。
  registerCanvasEnterTool(pi, {
    name: "canvas_enter",
    label: "Canvas Enter",
    description: CANVAS_AVAILABLE_TOOLS[0].description,
    promptSnippet:
      "Enter canvas mode: create a problem-solving canvas (statement + criterias + scope) or open an existing one",
    parameters: CanvasEnterParams,
  });

  registerCanvasEditTool(pi, {
    name: "canvas_edit",
    label: "Canvas Edit",
    description: CANVAS_AVAILABLE_TOOLS[1].description,
    promptSnippet: "Grow / patch / select / transition / comment-respond on a canvas (one tool, five actions)",
    parameters: CanvasEditParams,
  });

  registerCanvasReadTool(pi, {
    name: "canvas_read",
    label: "Canvas Read",
    description: CANVAS_AVAILABLE_TOOLS[2].description,
    promptSnippet: "Read the current canvas state (full or one subtree) before acting on canvas events",
    parameters: CanvasReadParams,
  });

  registerCanvasReviewTool(pi, {
    name: "canvas_review",
    label: "Canvas Review",
    description: CANVAS_AVAILABLE_TOOLS[3].description,
    promptSnippet: "Run the adversarial review loop, append a reviewer report, or resolve one review entry",
    parameters: CanvasReviewParams,
  });

  registerCanvasExportTool(pi, {
    name: "canvas_export",
    label: "Canvas Export",
    description: CANVAS_AVAILABLE_TOOLS[4].description,
    promptSnippet: "Export a converged canvas as a planning doc or a requirement card",
    parameters: CanvasExportParams,
  });

  registerCanvasListTool(pi, {
    name: "canvas_list",
    label: "Canvas List",
    description: CANVAS_AVAILABLE_TOOLS[5].description,
    promptSnippet: "List all canvases (id, name, converged flag, open must-fix count)",
    parameters: CanvasListParams,
  });

  // <available_tools> 常驻段（注入内容注册期构造一次——每轮 system prompt 追加
  // 相同文本，KV-cache 前缀稳定）。宿主守卫与工具 execute 同谓词：非 taiji GUI
  // 宿主下画布工具调用必被 hostGateError 拒绝，不应引导模型检索。
  const availableToolsSection = buildAvailableToolsSection(CANVAS_AVAILABLE_TOOLS);
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (!isTaijiGuiHost(ctx)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${availableToolsSection}` };
  });
}

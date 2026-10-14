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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setPiHandle } from "@zhushanwen/pi-extension-logger";

import { CanvasEnterParams, registerCanvasEnterTool } from "./tool-enter.js";
import { CanvasEditParams, registerCanvasEditTool } from "./tool-edit.js";
import { CanvasReadParams, registerCanvasReadTool } from "./tool-read.js";
import { CanvasReviewParams, registerCanvasReviewTool } from "./tool-review.js";
import { CanvasExportParams, registerCanvasExportTool } from "./tool-export.js";
import { CanvasListParams, registerCanvasListTool } from "./tool-list.js";

export default function canvasExtension(pi: ExtensionAPI): void {
  // logger 持久化通道接入（appendEntry custom entry，不进 LLM 上下文）
  setPiHandle(pi);

  registerCanvasEnterTool(pi, {
    name: "canvas_enter",
    label: "Canvas Enter",
    description:
      "Enter problem-solving-canvas mode: CREATE a canvas (pass statement + criterias + scope — the root problem triple) or OPEN an existing one (pass canvasId from canvas_list). " +
      "Use when the user asks to plan / think through / break down a problem before execution: the canvas is a human-agent co-edited argument map the user watches and rules on in the taiji GUI. " +
      "After entering, the user's GUI decisions (selections / vetoes / comments) arrive as canvas event notifications — always canvas_read the current state before responding. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
    // deferred 形态下 snippet 是 system prompt 工具索引里的唯一入口信号（D3-A1
    // 验收发现：缺 snippet 时自然语言驱动模型不会 tool_search 画布工具）——
    // plan promptSnippet 同款「主动进入」引导
    promptSnippet:
      "## Entering canvas mode\n" +
      "When the user asks to plan / think through / break down a problem before execution, proactively enter canvas mode yourself: " +
      "canvas_enter(statement='<root problem>', criterias=[...], scope=[...]). The canvas is a human-agent co-edited argument map — " +
      "you grow and argue options on it, the user watches and rules on selections/vetoes in the taiji GUI. " +
      "No user confirmation is needed to enter; to open an existing canvas pass canvasId from canvas_list.",
    parameters: CanvasEnterParams,
  });

  registerCanvasEditTool(pi, {
    name: "canvas_edit",
    label: "Canvas Edit",
    description:
      "Grow and edit the problem-solving canvas: grow (append a batch of nodes — decomposition, options, arguments), patch (edit one node), select (mark the chosen option; replace to re-select with a comparison reason), transition (lifecycle moves like reject-with-record), comment-respond (answer a user comment — adopted or rebutted, never ignored). " +
      "Reason fields are mandatory (audit trail); always canvas_read first and edit the CURRENT state. " +
      "Structural guarantee: user-side rulings arrive as notifications, agent-side edits never self-notify. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
    promptSnippet: "Grow / patch / select / transition / comment-respond on a canvas (one tool, five actions)",
    parameters: CanvasEditParams,
  });

  registerCanvasReadTool(pi, {
    name: "canvas_read",
    label: "Canvas Read",
    description:
      "Read the problem-solving canvas: full state or one subtree (nodes / edges / comments / review report / convergence flags). " +
      "The read-before-act discipline entry: respond to canvas event notifications and edit the canvas only after reading the current state. " +
      "Also the reviewer subagent's query surface. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
    promptSnippet: "Read the current canvas state (full or one subtree) before acting on canvas events",
    parameters: CanvasReadParams,
  });

  registerCanvasReviewTool(pi, {
    name: "canvas_review",
    label: "Canvas Review",
    description:
      "Run the canvas adversarial review loop: run (dispatch one reviewer subagent over the six-dimension checklist — completeness / necessity / support / authenticity / conflict / depth — and write the report back; R2+ pass scope to re-review only the resolution table), append (reviewer report write path), resolve (register one entry's disposition: accepted / deferred / rejected-with-reason — the fix side's duty after repairing). " +
      "must-fix entries block convergence until cleared. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
    promptSnippet: "Run the adversarial review loop, append a reviewer report, or resolve one review entry",
    parameters: CanvasReviewParams,
  });

  registerCanvasExportTool(pi, {
    name: "canvas_export",
    label: "Canvas Export",
    description:
      "Export a converged canvas: 'planning-doc' (full direction-planning document) or 'requirement-card' (one execution leaf, pass leafId). " +
      "Rejected with not_converged until the canvas has converged (must-fix cleared, no dirty paths, root criterias confirmed). " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
    promptSnippet: "Export a converged canvas as a planning doc or a requirement card",
    parameters: CanvasExportParams,
  });

  registerCanvasListTool(pi, {
    name: "canvas_list",
    label: "Canvas List",
    description:
      "List all problem-solving canvases (id, name, statement, converged flag, open must-fix count, review status). " +
      "The canvasId source for canvas_enter's open form. " +
      "Requires the taiji desktop runtime (errors out in standalone pi).",
    promptSnippet: "List all canvases (id, name, converged flag, open must-fix count)",
    parameters: CanvasListParams,
  });
}

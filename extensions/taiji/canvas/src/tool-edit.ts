/**
 * canvas_edit —— 进画布后的密集高频族（设计 §3.1(2) 工具面）。
 *
 * 五 action 同族（grow / patch / select / transition / comment-respond）：一次
 * tool_search 检索五 action 全解锁（省 N-1 次检索往返）。共享纪律（写进各
 * description）：变更理由字段强制（留痕纪律：没有理由的 agent 改动不可审计）；
 * 「响应前先 canvas_read 取当前态」（连续 GUI 操作下按旧态直接响应会作用于被
 * 覆盖的状态——ADR-0097 拉为主的 agent 侧对称）。
 *
 * schema 形态对齐 subagent-workflow 的 SubagentManageParams（action 枚举 +
 * per-action 参数块），字段形状与 @zhushanwen/extension-protocol 契约 params
 * 一一同构（marker 载荷按契约组装，runtime 守卫按 isCanvasMarkerRequest 校验）。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { CanvasMarkerRequest } from "@zhushanwen/extension-protocol";
import { isCanvasMarkerRequest } from "@zhushanwen/extension-protocol";

import { callCanvas } from "./marker-channel.js";
import { hostGateError, isTaijiGuiHost } from "./host.js";

const NODE_TYPES = ["question", "option", "argument", "constraint"] as const;
const EDGE_TYPES = ["decompose", "resolve", "argue", "rebut"] as const;
const POLARITIES = ["support", "object"] as const;
const LIFECYCLES = ["draft", "under-review", "passed", "rejected", "shelved"] as const;

const EDIT_ACTIONS = ["grow", "patch", "select", "transition", "comment-respond"] as const;

export const CanvasEditParams = Type.Object({
  action: StringEnum(EDIT_ACTIONS, {
    description:
      "grow: append a batch of new nodes (MECE decomposition / options / arguments); " +
      "patch: edit one node (content / criterias / dispatchable / factVerified); " +
      "select: mark the chosen option for a question (replace for re-selection, with comparison reason); " +
      "transition: move a node's lifecycle (e.g. reject with a record); " +
      "comment-respond: answer a user comment (adopted with follow-up, or rebutted with reason). " +
      "Always canvas_read first: respond to the CURRENT state, not the state in an old notification.",
  }),
  growParams: Type.Optional(
    Type.Object(
      {
        canvasId: Type.String({ description: "Target canvas id (from canvas_list / canvas_enter)." }),
        batch: Type.Array(
          Type.Object({
            id: Type.String({
              description:
                "Globally unique node id YOU generate (timestamp + random). Idempotent upsert key — retry after a crash-safe failure produces no duplicates.",
            }),
            type: StringEnum(NODE_TYPES, {
              description: "question (sub-problem) / option (candidate solution) / argument (evidence) / constraint.",
            }),
            content: Type.String({ description: "Node text (one sentence)." }),
            attachTo: Type.String({ description: "Existing node id this new node attaches to." }),
            edge: StringEnum(EDGE_TYPES, {
              description: "decompose (question→sub) / resolve (option→question) / argue / rebut (argument→target).",
            }),
            edgePolarity: Type.Optional(StringEnum(POLARITIES, { description: "REQUIRED when edge is argue/rebut." })),
            dispatchable: Type.Optional(
              Type.Boolean({ description: "For option: mark as an execution leaf (dispatchable after passed)." }),
            ),
          }),
          { description: "Atomic batch: if any item fails validation the whole batch is rejected (no partial writes)." },
        ),
        reason: Type.String({ description: "REQUIRED. Why this growth step (audit trail)." }),
      },
      { description: "REQUIRED for action:'grow'." },
    ),
  ),
  patchParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Target canvas id." }),
      nodeId: Type.String({ description: "Node to patch." }),
      content: Type.Optional(Type.String({ description: "New node text." })),
      criterias: Type.Optional(Type.Array(Type.String(), { description: "For execution leaves: new success criterias." })),
      dispatchable: Type.Optional(Type.Boolean({ description: "For options: execution-leaf flag change." })),
      factVerified: Type.Optional(Type.Boolean({ description: "For fact arguments: verification flip." })),
      reason: Type.String({ description: "REQUIRED. Why this edit (audit trail)." }),
    }),
  ),
  selectParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Target canvas id." }),
      questionId: Type.String({ description: "The question node whose candidates are being decided." }),
      optionId: Type.String({ description: "The option node to mark selected." }),
      replace: Type.Optional(
        Type.Object(
          { fromOptionId: Type.String({ description: "The previously selected option to migrate out (same transaction)." }) },
          { description: "Re-selection migration: REQUIRED when the question already has a selected option (otherwise rejected with selection_conflict). The old option's whole subtree enters re-review." },
        ),
      ),
      reason: Type.String({ description: "REQUIRED. Comparison reason (why this option over alternatives)." }),
    }),
  ),
  transitionParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Target canvas id." }),
      nodeId: Type.String({ description: "Node to transition." }),
      to: StringEnum(LIFECYCLES, {
        description: "draft / under-review / passed / rejected / shelved (illegal jumps are rejected; rejected/shelved revive via draft).",
      }),
      rejection: Type.Optional(
        Type.Object(
          {
            reason: Type.String({ description: "REQUIRED when to:'rejected'. Why rejected (kept — prevents re-proposal)." }),
            reviveCondition: Type.Optional(Type.String({ description: "Condition under which this could be revived." })),
          },
          { description: "REQUIRED when to:'rejected'." },
        ),
      ),
      reason: Type.String({ description: "REQUIRED. Why this transition (audit trail)." }),
    }),
  ),
  commentRespondParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Target canvas id." }),
      commentId: Type.String({ description: "The user comment to respond to (from canvas_read)." }),
      disposition: StringEnum(["adopted", "rebutted"], {
        description: "adopted: the comment is folded back into the graph (say how); rebutted: keep a reason. Ignoring is not allowed.",
      }),
      note: Type.String({ description: "REQUIRED. What was adopted (and where), or why rebutted." }),
    }),
  ),
});

/** canvas_edit 五 action 词表（marker 词表子集）。 */
export type CanvasEditAction = "grow" | "patch" | "select" | "transition" | "comment-respond";

/** schema 参数块 → marker 请求组装（一一映射，无发明语义）。形状校验在发送前
 * 由 execute 的 isCanvasMarkerRequest 契约门承担（typebox StringEnum 的 Static
 * 是宽松 string，组装层不做窄化断言）。 */
export function editRequestOf(
  params: Static<typeof CanvasEditParams>,
): { action: CanvasEditAction; params: Record<string, unknown> } | { error: Error } {
  const missing = (block: string, action: string): Error =>
    new Error(
      `canvas_edit 缺参数块 [invalid_params] action='${action}' 需要 ${block}。` +
        `恢复动作：按 action 填对应 ${block} 参数块后重试（各块字段见工具 schema 说明）。`,
    );
  switch (params.action) {
    case "grow": {
      if (!params.growParams) return { error: missing("growParams", "grow") };
      return { action: "grow", params: params.growParams };
    }
    case "patch": {
      if (!params.patchParams) return { error: missing("patchParams", "patch") };
      return { action: "patch", params: params.patchParams };
    }
    case "select": {
      if (!params.selectParams) return { error: missing("selectParams", "select") };
      return { action: "select", params: params.selectParams };
    }
    case "transition": {
      if (!params.transitionParams) return { error: missing("transitionParams", "transition") };
      return { action: "transition", params: params.transitionParams };
    }
    case "comment-respond": {
      if (!params.commentRespondParams) return { error: missing("commentRespondParams", "comment-respond") };
      return { action: "comment-respond", params: params.commentRespondParams };
    }
  }
}

export function registerCanvasEditTool(
  pi: ExtensionAPI,
  cfg: { name: string; label: string; description: string; promptSnippet: string; parameters: typeof CanvasEditParams },
): void {
  pi.registerTool({
    name: cfg.name,
    label: cfg.label,
    exposure: "deferred",
    description: cfg.description,
    promptSnippet: cfg.promptSnippet,
    parameters: cfg.parameters,
    async execute(
      _toolCallId: string,
      params: Static<typeof CanvasEditParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      const request = editRequestOf(params);
      if ("error" in request) throw request.error;
      // 契约形状门（typebox StringEnum 的 Static 是宽松 string——LLM 参数不信任，
      // 发送前经 U1 总守卫逐块校验并收窄；非法 = 结构化错误，不进 select）。
      if (!isCanvasMarkerRequest(request)) {
        throw new Error(
          `canvas_edit 参数形状非法 [invalid_params] action='${params.action}' 的参数块未通过契约校验。` +
            "恢复动作：canvas_read 取当前态后，对照工具 schema 补齐必填字段（grow 的 batch 条目须含 id/type/content/attachTo/edge；select/transition 须带 reason）后重试。",
        );
      }
      const markerRequest: CanvasMarkerRequest = request;
      const reply = await callCanvas(ctx, markerRequest.action, markerRequest.params);
      return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], details: undefined };
    },
  });
}

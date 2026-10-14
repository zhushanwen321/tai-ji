/**
 * canvas_review —— 审查循环动词族（设计 §3.1(2) 工具面 + 审查编排节）。
 *
 * 三 action（对齐 U1 TOOL_ACTION_MAP：review-request / review-append / review-resolve，
 * agent 面命名 run / resolve / append）：
 * - run（review-request + 编排）：事件留痕（agent actor）→ 取画布全量 → 派单个
 *   reviewer（六维度模板 + 全量数据内联，见 review.ts 载体裁决）→ 报告条目经
 *   review-append 写回。run 全链路无墙钟超时（select 与 reviewer 派发均不设限）。
 * - append（review-append）：报告条目写回路径（reviewer 报告的通道承载；runtime
 *   按矩阵映射 actor=review）。
 * - resolve（review-resolve）：处置登记（采纳 / 登记后做 / 拒绝留理由，三选一）。
 *
 * 分离构造保证：reviewer 无改图能力（零工具）；主 agent 修复走 canvas_edit。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  isCanvasReviewAppendParams,
  isCanvasReviewResolveParams,
} from "@zhushanwen/extension-protocol";

import { callCanvas } from "./marker-channel.js";
import { hostGateError, isTaijiGuiHost } from "./host.js";
import {
  isCanvasStateReply,
  resolveReviewerDispatcher,
  runReviewRound,
} from "./review.js";

export const CanvasReviewParams = Type.Object({
  action: StringEnum(["run", "append", "resolve"], {
    description:
      "run: kick off one review round (records the review-request event, dispatches a single reviewer subagent, writes the report back; R2+ pass scope to narrow the review); " +
      "append: write report entries back (the reviewer report write path); " +
      "resolve: register the disposition of one report entry (accepted / deferred / rejected-with-reason) — this is the fix-side actor's duty after repairing.",
  }),
  runParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Canvas to review." }),
      scope: Type.Optional(
        Type.String({
          description: "R2+ only: narrow this round to 'previous resolution table + new attack points' (a short description). Omit on R1 (full six-dimension review).",
        }),
      ),
    }),
  ),
  appendParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Canvas the report belongs to." }),
      round: Type.Number({ description: "Round the entries belong to (R1 = 1)." }),
      entries: Type.Array(
        Type.Object({
          id: Type.String({ description: "Unique entry id." }),
          dimension: StringEnum(
            ["completeness", "necessity", "support", "authenticity", "conflict", "depth"],
            { description: "Review dimension." },
          ),
          severity: StringEnum(["must-fix", "suggestion"], { description: "must-fix blocks convergence until cleared." }),
          targetId: Type.String({ description: "Canvas element id this entry points at (must exist)." }),
          note: Type.String({ description: "Finding + evidence + fix direction." }),
        }),
      ),
    }),
  ),
  resolveParams: Type.Optional(
    Type.Object({
      canvasId: Type.String({ description: "Canvas the report belongs to." }),
      entryId: Type.String({ description: "Report entry to resolve." }),
      disposition: StringEnum(["accepted", "deferred", "rejected"], {
        description: "accepted: folded back into the graph; deferred: registered as to-do; rejected: keep a reason.",
      }),
      note: Type.String({ description: "REQUIRED. What was done (or why rejected)." }),
    }),
  ),
});

export function registerCanvasReviewTool(
  pi: ExtensionAPI,
  cfg: { name: string; label: string; description: string; parameters: typeof CanvasReviewParams },
): void {
  pi.registerTool({
    name: cfg.name,
    label: cfg.label,
    exposure: "deferred",
    description: cfg.description,
    parameters: cfg.parameters,
    async execute(
      _toolCallId: string,
      params: Static<typeof CanvasReviewParams>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      if (params.action === "resolve") {
        if (!params.resolveParams) {
          throw new Error(
            "canvas_review 缺参数块 [invalid_params] action='resolve' 需要 resolveParams。" +
              "恢复动作：填 {canvasId, entryId, disposition, note} 后重试。",
          );
        }
        // 契约形状门（typebox StringEnum 的 Static 是宽松 string——LLM 参数不信任，
        // 守卫兼做校验与类型收窄；非法 = 结构化错误，不进 select）。
        if (!isCanvasReviewResolveParams(params.resolveParams)) {
          throw new Error(
            "canvas_review resolve 参数形状非法 [invalid_params] disposition 须为 accepted/deferred/rejected 之一且 note 必填。" +
              "恢复动作：对照工具 schema 修正 resolveParams 后重试。",
          );
        }
        const reply = await callCanvas(ctx, "review-resolve", params.resolveParams);
        return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], details: undefined };
      }
      if (params.action === "append") {
        const appendParams = params.appendParams;
        if (!appendParams) {
          throw new Error(
            "canvas_review 缺参数块 [invalid_params] action='append' 需要 appendParams。" +
              "恢复动作：填 {canvasId, round, entries} 后重试（entries 字段见 schema）。",
          );
        }
        // 契约形状收口：CanvasReviewEntryInput 逐条带 round（幂等 upsert 锚点），
        // schema 顶层声明一次 round，此处注入每条；注入后过契约守卫（校验 + 收窄）。
        const request = {
          canvasId: appendParams.canvasId,
          round: appendParams.round,
          entries: appendParams.entries.map((entry) => ({ ...entry, round: appendParams.round })),
        };
        if (!isCanvasReviewAppendParams(request)) {
          throw new Error(
            "canvas_review append 参数形状非法 [invalid_params] entries 条目须含 id/dimension/severity/targetId/note 且词表合法。" +
              "恢复动作：对照工具 schema 修正 entries 后重试。",
          );
        }
        const reply = await callCanvas(ctx, "review-append", request);
        return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], details: undefined };
      }
      // action === "run"：编排链（review-request 留痕 → read 全量 → 派 reviewer → append 写回）
      if (!params.runParams) {
        throw new Error(
          "canvas_review 缺参数块 [invalid_params] action='run' 需要 runParams。" +
            "恢复动作：填 {canvasId}（R2+ 另带 scope）后重试。",
        );
      }
      await callCanvas(ctx, "review-request", {
        canvasId: params.runParams.canvasId,
        scope: params.runParams.scope,
      });
      const readReply = await callCanvas(ctx, "read", { canvasId: params.runParams.canvasId });
      if (!isCanvasStateReply(readReply)) {
        throw new Error(
          "review_read_shape_invalid: 画布读取回包不是 CanvasState 形状（runtime 契约漂移）。" +
            "恢复动作：核对 runtime 与 @zhushanwen/pi-canvas 版本一致后重试；详见扩展日志。",
        );
      }
      const dispatcher = resolveReviewerDispatcher();
      const outcome = await runReviewRound({
        state: readReply,
        scope: params.runParams.scope,
        signal,
        dispatch: dispatcher,
        appendWriteBack: (appendParams) => callCanvas(ctx, "review-append", appendParams).then(() => undefined),
      });
      const text = JSON.stringify({
        ok: true,
        canvasId: readReply.canvasId,
        round: outcome.round,
        appended: outcome.appended,
        dropped: outcome.dropped,
        summary: outcome.summary,
      });
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}

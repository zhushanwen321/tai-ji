/**
 * canvas_read —— 查询动词（设计 §3.1(2) 工具面）：读画布全量 / 子树。
 *
 * reviewer subagent 的查询面单独持有本工具（工具级裁剪——若与 edit 合并，
 * reviewer 白名单会拖进改图能力）；响应纪律「先 read 再动」的数据入口。
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { callCanvas } from "./marker-channel.js";
import { hostGateError, isTaijiGuiHost } from "./host.js";

export const CanvasReadParams = Type.Object({
  canvasId: Type.String({ description: "Canvas id to read (from canvas_list / canvas_enter)." }),
  subtree: Type.Optional(
    Type.String({ description: "Read only the trunk subtree below this node id. Omit for the full canvas." }),
  ),
});

export function registerCanvasReadTool(
  pi: ExtensionAPI,
  cfg: { name: string; label: string; description: string; promptSnippet: string; parameters: typeof CanvasReadParams },
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
      params: Static<typeof CanvasReadParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      const reply = await callCanvas(ctx, "read", { canvasId: params.canvasId, subtree: params.subtree });
      return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], details: undefined };
    },
  });
}

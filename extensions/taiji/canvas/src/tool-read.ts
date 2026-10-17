/**
 * canvas_read —— 查询动词（设计 §3.1(2) 工具面）：读画布全量 / 子树。
 *
 * agent 侧画布查询入口（reviewer 零工具——画布数据经父扩展 marker read 内联进
 * reviewer prompt；ExecuteOptions 无 tools 通道，结构上无法授工具）；
 * 响应纪律「先 read 再动」的数据入口。
 */
import type { ExtensionAPI, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { renderCanvasToolResult } from "./render.js";
import { canvasReadSummary } from "./summary.js";
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
    renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
      return renderCanvasToolResult(result, options, theme);
    },
    async execute(
      _toolCallId: string,
      params: Static<typeof CanvasReadParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      const reply = await callCanvas(ctx, "read", { canvasId: params.canvasId, subtree: params.subtree });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        details: { summary: canvasReadSummary(reply) },
      };
    },
  });
}

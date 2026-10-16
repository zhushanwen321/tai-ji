/**
 * canvas_list —— 列画布清单（设计 §3.1(2) 工具面）：canvas_enter 打开形态的
 * canvasId 来源；无参数（过滤无字段——runtime 按契约 Record 结构性拒绝夹带）。
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { callCanvas } from "./marker-channel.js";
import { hostGateError, isTaijiGuiHost } from "./host.js";

export const CanvasListParams = Type.Object({});

export function registerCanvasListTool(
  pi: ExtensionAPI,
  cfg: { name: string; label: string; description: string; promptSnippet: string; parameters: typeof CanvasListParams },
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
      _params: Static<typeof CanvasListParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      const reply = await callCanvas(ctx, "list", {});
      return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], details: undefined };
    },
  });
}

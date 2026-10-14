/**
 * canvas_export —— 导出交付动作（设计 §3.1(2) 工具面）：低频，独立成工具。
 *
 * 目标二态：方向规划文档 / 需求卡（需求卡须带执行叶子 nodeId）。未收敛调用会被
 * runtime 以 not_converged 拒绝（错误码 + 恢复动作文案经 marker-channel throw 透出）。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { callCanvas } from "./marker-channel.js";
import { hostGateError, isTaijiGuiHost } from "./host.js";

export const CanvasExportParams = Type.Object({
  canvasId: Type.String({ description: "Canvas id to export." }),
  target: StringEnum(["planning-doc", "requirement-card"], {
    description: "'planning-doc' exports the full direction-planning document; 'requirement-card' exports one execution leaf as a requirement card.",
  }),
  leafId: Type.Optional(
    Type.String({ description: "REQUIRED when target:'requirement-card' — the execution-leaf node id to export." }),
  ),
});

/** schema 平面参数 → 契约 CanvasExportTarget 判别形状。 */
export function exportRequestOf(
  params: Static<typeof CanvasExportParams>,
): { action: "export"; params: { canvasId: string; target: { target: "planning-doc" } | { target: "requirement-card"; leafId: string } } } | {
  error: Error;
} {
  if (params.target === "requirement-card" && typeof params.leafId !== "string") {
    return {
      error: new Error(
        "canvas_export 缺叶子节点 [invalid_params] target='requirement-card' 需要 leafId。" +
          "恢复动作：canvas_read 找到目标执行叶子（dispatchable option）的节点 id 后重试；整图方向规划文档用 target='planning-doc'。",
      ),
    };
  }
  return {
    action: "export",
    params:
      params.target === "planning-doc"
        ? { canvasId: params.canvasId, target: { target: "planning-doc" } }
        : { canvasId: params.canvasId, target: { target: "requirement-card", leafId: params.leafId as string } },
  };
}

export function registerCanvasExportTool(
  pi: ExtensionAPI,
  cfg: { name: string; label: string; description: string; parameters: typeof CanvasExportParams },
): void {
  pi.registerTool({
    name: cfg.name,
    label: cfg.label,
    exposure: "deferred",
    description: cfg.description,
    parameters: cfg.parameters,
    async execute(
      _toolCallId: string,
      params: Static<typeof CanvasExportParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      const request = exportRequestOf(params);
      if ("error" in request) throw request.error;
      const reply = await callCanvas(ctx, "export", request.params);
      return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], details: undefined };
    },
  });
}

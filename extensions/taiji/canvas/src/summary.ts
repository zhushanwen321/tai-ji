/**
 * canvas 六工具结果的一行摘要（details.summary 单一产出点）。
 *
 * 消费两路：各工具 execute 组装 details.summary（taiji GUI 对话流收起态展示）+
 * render.ts 的 renderResult 折叠态渲染（pi TUI）。纯函数无 IO：reply 是 marker
 * 通道回包（runtime 侧 JSON，不信任外部格式——逐字段守卫，形状漂移退化为无后缀
 * 短文案而非抛错；摘要只是展示辅助，不得反过来影响工具成功路径）。
 *
 * 数据可得性按契约（@zhushanwen/extension-protocol canvas 契约模块）核对：
 * - enter 打开形态 / read 的 reply = CanvasState（name/nodes）；enter 创建形态与
 *   mutate 族 reply = CanvasMutateReply（ok/eventId/evType/summary，无画布名）。
 * - review run 的 reply 是本包编排产物（review.ts runReviewRound：round/appended）；
 *   max-rounds 停回短路是 stopped/status 形状（tool-review.ts）。
 * - export 的 reply 是 CanvasMutateReply，不携带导出文件路径——target 从 params 取。
 */
import type { Static } from "typebox";

import type { CanvasEditParams } from "./tool-edit.js";
import type { CanvasEnterParams } from "./tool-enter.js";
import type { CanvasExportParams } from "./tool-export.js";
import type { CanvasReviewParams } from "./tool-review.js";

/** 不信任来源的对象访问统一入口（review.ts recordOf 同款）。 */
function recordOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stringField(rec: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = rec?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function arrayField(rec: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const v = rec?.[key];
  return Array.isArray(v) ? v : undefined;
}

function numberField(rec: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = rec?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** canvas_enter：打开形态 reply 带 CanvasState.name；创建形态 reply 无名（mutate
 * 信封），退 params.name（runtime 可能按 statement 派生名，params 未传则裸文案）。 */
export function canvasEnterSummary(params: Static<typeof CanvasEnterParams>, reply: unknown): string {
  const name = stringField(recordOf(reply), "name") ?? (params.name !== undefined && params.name !== "" ? params.name : undefined);
  return name !== undefined ? `Entered canvas "${name}"` : "Entered canvas";
}

/** canvas_edit：grow 从 params.batch 带新增节点数；其余 action 无数量语义。 */
export function canvasEditSummary(params: Static<typeof CanvasEditParams>): string {
  if (params.action === "grow" && params.growParams && Array.isArray(params.growParams.batch)) {
    return `Canvas edited · +${params.growParams.batch.length} nodes`;
  }
  return "Canvas edited";
}

/** canvas_read：reply = CanvasState（name + nodes 必备字段，守卫漂移时逐级省略）。 */
export function canvasReadSummary(reply: unknown): string {
  const rec = recordOf(reply);
  const name = stringField(rec, "name");
  const nodes = arrayField(rec, "nodes");
  if (name !== undefined && nodes !== undefined) return `Read canvas "${name}" · ${nodes.length} nodes`;
  if (name !== undefined) return `Read canvas "${name}"`;
  return "Read canvas";
}

/**
 * canvas_review 三 action 各按可得数据呈现：
 * - run：编排产物带 round/appended（写回条目数）；达轮次上限的停回短路带
 *   stopped/status。verdict（pass/fail）不在工具结果里（报告聚合在画布状态，
 *   经 canvas_read 读），文案不虚构该数据。
 * - append：entries 数与 must-fix 计数从 params 数（报告条目写回量）。
 * - resolve：处置条目与三选一结论从 params 取。
 */
export function canvasReviewSummary(params: Static<typeof CanvasReviewParams>, reply: unknown): string {
  if (params.action === "run") {
    const rec = recordOf(reply);
    if (rec?.stopped === true) {
      const status = stringField(rec, "status");
      return status !== undefined ? `Review stopped: ${status}` : "Review stopped";
    }
    const round = numberField(rec, "round");
    const appended = numberField(rec, "appended");
    if (round !== undefined && appended !== undefined) return `Review round ${round} · +${appended} entries`;
    return "Review ran";
  }
  if (params.action === "append") {
    const entries = params.appendParams?.entries;
    if (Array.isArray(entries)) {
      const mustFix = entries.filter((e) => recordOf(e)?.severity === "must-fix").length;
      return mustFix > 0
        ? `Review appended ${entries.length} entries · ${mustFix} must-fix`
        : `Review appended ${entries.length} entries`;
    }
    return "Review appended";
  }
  const resolve = params.resolveParams;
  if (resolve) return `Review resolved ${resolve.entryId} (${resolve.disposition})`;
  return "Review resolved";
}

/** canvas_export：reply 是 mutate 信封不携带产物路径——按 target 呈现导出物。 */
export function canvasExportSummary(params: Static<typeof CanvasExportParams>): string {
  if (params.target === "planning-doc") return "Exported planning-doc";
  if (params.target === "requirement-card" && params.leafId !== undefined && params.leafId !== "") {
    return `Exported requirement-card (leaf ${params.leafId})`;
  }
  return "Exported canvas";
}

/** canvas_list：reply = CanvasListReply { canvases }。 */
export function canvasListSummary(reply: unknown): string {
  const canvases = arrayField(recordOf(reply), "canvases");
  return canvases !== undefined ? `Listed ${canvases.length} canvases` : "Listed canvases";
}

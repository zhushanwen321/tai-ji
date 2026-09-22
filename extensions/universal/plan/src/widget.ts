import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PlanState } from "./state.js";

/**
 * plan 模式的 TUI widget/status 指示。taiji rpc 宿主（GUI）恒清除不设——GUI 的模式态
 * 由底部 PlanModeBar 常驻行承载，Composer 托盘 widget 区的 "[Plan Mode]" 文本与其冗余
 * （2026-09-21 用户裁决去除）；TUI 形态（独立 pi / 终端）保留原指示。
 */
export function updatePlanWidget(ctx: ExtensionContext, state: PlanState): void {
  if (ctx.mode === "rpc" || !state.isActive) {
    ctx.ui.setWidget("plan-mode", undefined);
    ctx.ui.setStatus("plan-mode", undefined);
    return;
  }

  const th = ctx.ui.theme;
  ctx.ui.setWidget("plan-mode", [th.fg("accent", "[Plan Mode]")]);
  ctx.ui.setStatus("plan-mode", th.fg("accent", "Plan Mode"));
}

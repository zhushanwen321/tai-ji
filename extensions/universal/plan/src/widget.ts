import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PlanState } from "./state.js";

export function updatePlanWidget(ctx: ExtensionContext, state: PlanState): void {
  if (!state.isActive) {
    ctx.ui.setWidget("plan-mode", undefined);
    ctx.ui.setStatus("plan-mode", undefined);
    return;
  }

  const th = ctx.ui.theme;
  ctx.ui.setWidget("plan-mode", [th.fg("accent", "[Plan Mode]")]);
  ctx.ui.setStatus("plan-mode", th.fg("accent", "Plan Mode"));
}

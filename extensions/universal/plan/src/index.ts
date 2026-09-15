import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerPlanCommand } from "./command.js";
import { registerPlanEventHandlers } from "./compact.js";
import { type PlanSessionMap, reconstructPlanState } from "./state.js";
import { registerPlanTool } from "./tool.js";
import { updatePlanWidget } from "./widget.js";

export default function planExtension(pi: ExtensionAPI) {
  // Per-session state cache — keyed by sessionId
  const sessions: PlanSessionMap = new Map();

  // Register tool and command
  registerPlanTool(pi, sessions);
  registerPlanCommand(pi, sessions);

  // Register compact/tree event handlers
  registerPlanEventHandlers(pi, sessions);

  // Reconstruct state on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = reconstructPlanState(ctx);
    sessions.set(sessionId, state);
    updatePlanWidget(ctx, state);
    // If plan mode was active, re-restrict tools to the plan-mode set (includes bash — file-write constraints come from the injected plan mode prompt)
    if (state.isActive) {
      pi.setActiveTools(["read", "bash", "grep", "find", "ls", "plan"]);
    }
  });

  // Clean up on session end
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    sessions.delete(sessionId);
  });
}

import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface PlanState {
  isActive: boolean;
  planFilePath: string;
  requirement: string;
  templateName: string;
}

export const DEFAULT_PLAN_STATE: PlanState = {
  isActive: false,
  planFilePath: "",
  requirement: "",
  templateName: "",
};

/** Per-session state cache. Keyed by sessionId. */
export type PlanSessionMap = Map<string, PlanState>;

/**
 * Get plan state for a session. Returns cached state if available,
 * otherwise reconstructs from sessionManager and caches it.
 */
export function getPlanState(
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
): PlanState {
  const cached = sessions.get(sessionId);
  if (cached) return cached;

  const reconstructed = reconstructPlanState(ctx);
  sessions.set(sessionId, reconstructed);
  return reconstructed;
}

export function persistPlanState(pi: ExtensionAPI, state: PlanState): void {
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
  });
}

/** Reset plan state to idle, persist, and clean up session cache. */
export function resetPlanState(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
): PlanState {
  const state = getPlanState(sessions, sessionId, ctx);
  state.isActive = false;
  state.planFilePath = "";
  state.requirement = "";
  state.templateName = "";
  persistPlanState(pi, state);
  sessions.delete(sessionId);
  return state;
}

function isPlanStateEntry(entry: SessionEntry): entry is CustomEntry<Partial<PlanState>> & { customType: "plan-state" } {
  // 判别式收窄（type === "custom"）后可直接访问 customType/data，无需 cast
  return (
    entry.type === "custom" &&
    entry.customType === "plan-state" &&
    typeof entry.data === "object" &&
    entry.data !== null
  );
}

export function reconstructPlanState(ctx: ExtensionContext): PlanState {
  const state = { ...DEFAULT_PLAN_STATE };
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    // entries[i] 是复杂表达式（TS 不收窄），守卫移到 const 变量上
    const entry = entries[i];
    if (!isPlanStateEntry(entry)) continue;
    const data = entry.data;
    // 逐字段 ?? 白名单式读取：旧版 entry 残留的 phase 字段被自然忽略（D6 兼容读）
    state.isActive = data?.isActive ?? false;
    state.planFilePath = data?.planFilePath ?? "";
    state.requirement = data?.requirement ?? "";
    state.templateName = data?.templateName ?? "";
    break;
  }

  return state;
}

import type { PlanDocMeta } from "@zhushanwen/extension-protocol";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * 审阅态两值（D1）——awaiting = 文档就绪等审批；revising = 修订中；
 * 无值 = 进行中。approve 不设中间态：直接走 complete → resetPlanState 落
 * isActive=false，横幅消失由 isActive 驱动。
 */
export type PlanReviewState = "awaiting" | "revising";

export interface PlanState {
  isActive: boolean;
  planFilePath: string;
  requirement: string;
  templateName: string;
  /**
   * --template 直传标记（D7 select-template 防御的判定信号）：直传进入时 =
   * 展开后模板文件绝对路径；模板流程进入缺失。templateName 字段两流程共用
   * （直传存 basename / 选中存模板名），单看它无法区分「已直传」与「已选中」，
   * 故独立持久化直传事实——重启经 entry 恢复，reset 时随退出失效。
   */
  templateProvidedPath?: string;
  /** 挂载技能名清单（--skills 解析产物；模板流程为空数组——挂载声明，reset 时随退出失效） */
  skills: string[];
  /** 产物文档清单（register-doc 登记；reset 时保留——产物 tab 与 isActive 解耦，跨重开留存） */
  docs: PlanDocMeta[];
  reviewState?: PlanReviewState;
  /**
   * 上次 submit-review 时的 docs 快照指纹（planDocsFingerprint 产物）。缺失 = 无既往
   * 提交（首次提交 / reset 后 / 旧版 entry 重挂），重提交无变化检测不警告；reset 随
   * 退出失效（新 plan 轮次重新计数），重开 session 经 entry 恢复（E3 重挂同款受益）。
   */
  lastSubmitReviewDocsFingerprint?: string;
}

export const DEFAULT_PLAN_STATE: PlanState = {
  isActive: false,
  planFilePath: "",
  requirement: "",
  templateName: "",
  skills: [],
  docs: [],
};

/** Per-session state cache. Keyed by sessionId. */
export type PlanSessionMap = Map<string, PlanState>;

/**
 * docs 快照指纹：fileName:version 按登记序拼接。register-doc 任何形态（新增 /
 * 同名原位 version+1）都会改变指纹 ⇒「与上次 submit-review 快照相同 ⇔ 期间无任何
 * register-doc」。空 docs 的指纹是空串，但 submit-review 的 no-docs 守卫先行拦截，
 * 空串指纹不会入库。
 */
export function planDocsFingerprint(docs: PlanDocMeta[]): string {
  return docs.map((d) => `${d.fileName}:${d.version}`).join("|");
}

/**
 * 挂起 select 的 per-session AbortController 注册表（E10）。
 * 生命周期钉死：每次发挂起 select 前 fresh 一个（见 freshAbortController），
 * select settled 即弃；session_start / session_shutdown / abort 联动处清理。
 */
export type PlanAbortControllers = Map<string, AbortController>;

/**
 * 发挂起 select 前新建 controller 并登记。禁复用已 abort 的 controller——
 * pi 实装对已 abort 的 signal 在 createDialogPromise 首行短路立即 resolve undefined，
 * 复用会让退出后再入 plan 的 submit-review 瞬时静默取消。
 * pi 实装锚点：dist/modes/rpc/rpc-mode.js:48（0.84.4）——createDialogPromise 首行
 * `opts?.signal?.aborted` 即 `return Promise.resolve(defaultValue)`，select 的
 * defaultValue = undefined（E10 生命周期设计依据）。
 */
export function freshAbortController(
  controllers: PlanAbortControllers,
  sessionId: string,
): AbortController {
  const controller = new AbortController();
  controllers.set(sessionId, controller);
  return controller;
}

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
  // customType 字面量 'plan-state' 是 runtime 投影链的派生锚点（u1-proj 侧用同字面量
  // 派生扫描），两侧独立常量，勿改字面量。optional 字段（reviewState /
  // lastSubmitReviewDocsFingerprint）为 undefined 时 JSON 序列化自然消失，旧 entry
  // 消费方对该字段惰性（D4 向后兼容）。
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
    templateProvidedPath: state.templateProvidedPath,
    skills: state.skills,
    docs: state.docs,
    reviewState: state.reviewState,
    lastSubmitReviewDocsFingerprint: state.lastSubmitReviewDocsFingerprint,
  });
}

/**
 * Reset plan state to idle, persist, and clean up session cache.
 *
 * 终态矩阵（D5/E10）：isActive=false + reviewState 清空 + skills 清空（挂载声明失效）+
 * docs 保留——产物 tab 由 docs.length 驱动、与 isActive 解耦，执行期（approve 后）与
 * 退出后（abort 后）都可回看产物文档；reset entry 持久，重开 session 后冷启动首拉仍恢复
 * docs 显示，至下次 /plan 同 slug 覆写。
 */
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
  delete state.templateProvidedPath;
  state.skills = [];
  delete state.reviewState;
  // 指纹快照随退出失效：approve/abort 后的新 plan 轮次从「无既往提交」重新计数，
  // 首次 submit-review 不触发无变化警告（docs 虽保留供回看，但不作为检测基线）
  delete state.lastSubmitReviewDocsFingerprint;
  persistPlanState(pi, state);
  sessions.delete(sessionId);
  return state;
}

function isPlanStateEntry(entry: SessionEntry): entry is CustomEntry<Partial<PlanState>> & { customType: "plan-state" } {
  // 判别式收窄（type === "custom"）后可直接访问 customType/data，无需 cast。
  // 「字段存在即合法」：新字段全部 optional，旧四字段 entry 同样合法（D4 向后兼容）。
  return (
    entry.type === "custom" &&
    entry.customType === "plan-state" &&
    typeof entry.data === "object" &&
    entry.data !== null
  );
}

/** skills 白名单式读取：数组 + 逐项 string 守卫，垃圾项丢弃（垃圾数据不进内存态） */
function readSkills(data: Partial<PlanState>): string[] {
  if (!Array.isArray(data.skills)) return [];
  return data.skills.filter((s): s is string => typeof s === "string");
}

/** PlanDocMeta 最小结构守卫：fileName/absPath 必要字段（渲染与 file.read 的锚点） */
function isPlanDocMeta(value: unknown): value is PlanDocMeta {
  if (typeof value !== "object" || value === null) return false;
  if (!("fileName" in value) || !("absPath" in value)) return false;
  return typeof value.fileName === "string" && typeof value.absPath === "string";
}

/** docs 白名单式读取：逐项校验 PlanDocMeta 必要字段（fileName/absPath），缺字段的条目丢弃 */
function readDocs(data: Partial<PlanState>): PlanDocMeta[] {
  if (!Array.isArray(data.docs)) return [];
  return data.docs.filter(isPlanDocMeta);
}

/** reviewState 值域守卫：'awaiting' | 'revising' 之外的值按无值处理 */
function readReviewState(data: Partial<PlanState>): PlanReviewState | undefined {
  return data.reviewState === "awaiting" || data.reviewState === "revising"
    ? data.reviewState
    : undefined;
}

/** 快照指纹白名单式读取：非 string（含缺失）按无既往提交处理（D4 字段级降级） */
function readDocsFingerprint(data: Partial<PlanState>): string | undefined {
  return typeof data.lastSubmitReviewDocsFingerprint === "string"
    ? data.lastSubmitReviewDocsFingerprint
    : undefined;
}

/** 直传标记白名单式读取：非 string（含缺失）按模板流程处理（D4 字段级降级） */
function readTemplateProvidedPath(data: Partial<PlanState>): string | undefined {
  return typeof data.templateProvidedPath === "string" ? data.templateProvidedPath : undefined;
}

export function reconstructPlanState(ctx: ExtensionContext): PlanState {
  const state = { ...DEFAULT_PLAN_STATE };
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    // entries[i] 是复杂表达式（TS 不收窄），守卫移到 const 变量上
    const entry = entries[i];
    if (!isPlanStateEntry(entry)) continue;
    const data = entry.data;
    // 逐字段 ?? 白名单式读取：旧版 entry 残留的 phase 字段被自然忽略（D6 兼容读）；
    // 新字段缺失（旧 entry）归一为空清单/无值（D4 字段级降级）
    state.isActive = data?.isActive ?? false;
    state.planFilePath = data?.planFilePath ?? "";
    state.requirement = data?.requirement ?? "";
    state.templateName = data?.templateName ?? "";
    state.templateProvidedPath = readTemplateProvidedPath(data ?? {});
    state.skills = readSkills(data ?? {});
    state.docs = readDocs(data ?? {});
    state.reviewState = readReviewState(data ?? {});
    state.lastSubmitReviewDocsFingerprint = readDocsFingerprint(data ?? {});
    break;
  }

  return state;
}

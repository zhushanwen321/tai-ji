import type { PlanDocMeta } from "@zhushanwen/extension-protocol";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * 审阅态两值（D1）——awaiting = 文档就绪等审批；revising = 修订中；
 * 无值 = 进行中。approve 不设中间态：直接走 complete → resetPlanState 落
 * isActive=false，PlanModeBar 消失由 isActive 驱动。
 */
export type PlanReviewState = "awaiting" | "revising";

/**
 * 降级态来源标记（plan-mode-ux-refactor §3.4）：reviewState='awaiting' 且无挂起 select
 * 时区分等待原因——'explain' = 用户请求解释后等 agent 解答完重新提交审批；'resubmit' =
 * 会话重启（E3）后 agent 尚未重新提交。写入点两处（tool.ts explain 分支 / index.ts E3
 * steer 重挂处），清除点三处（resetPlanState 终态清理组 / activatePlanMode 新轮次重置
 * 组 / submit-review 重挂起点重置）——缺清除 = 跨 plan run 残留（C-U2 同型缺陷：
 * bad-response 等罕见路径可渲染上一轮的来源文案）。字面量与 shared
 * PlanStateView.reviewStateSource 严格一致。
 */
export type PlanReviewStateSource = "explain" | "resubmit";

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
  /** 降级态来源标记（见 PlanReviewStateSource）；仅 reviewState 有值时有语义，无值 = 来源未知 */
  reviewStateSource?: PlanReviewStateSource;
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

/**
 * 计划态工具白名单（进入计划模式三处共用——slash 命令 / plan(enter) tool / session_start
 * 恢复；bash 在白名单内，文件写约束来自注入的计划模式提示词，见 pi-ext-021）。
 * 放在 state.ts（叶模块）而非 tool.ts：enter.ts 与本常量互需会造成 enter↔tool 循环依赖。
 */
export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "plan"];

/** Per-session state cache. Keyed by sessionId. */
export type PlanSessionMap = Map<string, PlanState>;

/**
 * requirement 长度封顶（64KB）：session.planState 帧在 runtime 出站守卫（outbound-frame-registry）
 * 按「requirement 有界」归入不登记 LARGE_FIELD_REGISTRY 的标量/小列表类——超 32MB 的未登记帧
 * 会被整帧丢弃（前端 plan 面板缺失）。本封顶把该隐含前提变为代码保障（进入写侧 + entry 重建
 * 读侧双点）。截断只影响 state/entry/帧；进入提示词仍携带全文直达模型（message content 通路
 * 有既有注册表登记兜底）。
 */
// eslint-disable-next-line no-magic-numbers -- 64KB = 64 * 1024 字节换算常数（同 event-journal.ts 32KB 先例）
export const MAX_PLAN_REQUIREMENT_LENGTH = 64 * 1024;

/** requirement 封顶：超长截断 + 省略标记（含被省略字符数），短文本原样返回 */
export function capPlanRequirement(requirement: string): string {
  if (requirement.length <= MAX_PLAN_REQUIREMENT_LENGTH) return requirement;
  const omitted = requirement.length - MAX_PLAN_REQUIREMENT_LENGTH;
  return `${requirement.slice(0, MAX_PLAN_REQUIREMENT_LENGTH)}\n[requirement truncated: ${omitted} characters omitted]`;
}

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
  // reviewStateSource / lastSubmitReviewDocsFingerprint）为 undefined 时 JSON 序列化
  // 自然消失，旧 entry 消费方对该字段惰性（D4 向后兼容）。
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
    templateProvidedPath: state.templateProvidedPath,
    skills: state.skills,
    docs: state.docs,
    reviewState: state.reviewState,
    reviewStateSource: state.reviewStateSource,
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
  // 来源标记与 reviewState 同生命周期随退出失效：残留 'explain' 会让下一轮经
  // bad-response 等罕见路径渲染「已收到你的问题」而本轮无人提问（C-U2 同型残留）
  delete state.reviewStateSource;
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

/** reviewStateSource 值域守卫：'explain' | 'resubmit' 之外的值按无值处理（与 readReviewState 同风格） */
function readReviewStateSource(data: Partial<PlanState>): PlanReviewStateSource | undefined {
  return data.reviewStateSource === "explain" || data.reviewStateSource === "resubmit"
    ? data.reviewStateSource
    : undefined;
}

/** requirement 白名单式读取 + 长度封顶：非 string（含缺失）归空串；封顶前旧版 entry 的
 * 超长文本在重建时同样封顶（读侧防御，保证派生 plan 帧恒有界） */
function readRequirement(data: Partial<PlanState>): string {
  return typeof data.requirement === "string" ? capPlanRequirement(data.requirement) : "";
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

/**
 * 单条 plan-state entry 数据的逐字段应用（调用方已过 isPlanStateEntry 门，data 为
 * 非空对象；`?? {}` 仅为 data?: T 的类型 shim）。
 */
function applyPlanStateEntry(state: PlanState, data: Partial<PlanState> | undefined): void {
  // 逐字段 ?? 白名单式读取：旧版 entry 残留的 phase 字段被自然忽略（D6 兼容读）；
  // 新字段缺失（旧 entry）归一为空清单/无值（D4 字段级降级）
  const entryData = data ?? {};
  state.isActive = entryData.isActive ?? false;
  state.planFilePath = entryData.planFilePath ?? "";
  state.requirement = readRequirement(entryData);
  state.templateName = entryData.templateName ?? "";
  state.templateProvidedPath = readTemplateProvidedPath(entryData);
  state.skills = readSkills(entryData);
  state.docs = readDocs(entryData);
  state.reviewState = readReviewState(entryData);
  state.reviewStateSource = readReviewStateSource(entryData);
  state.lastSubmitReviewDocsFingerprint = readDocsFingerprint(entryData);
}

export function reconstructPlanState(ctx: ExtensionContext): PlanState {
  const state = { ...DEFAULT_PLAN_STATE };
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    // entries[i] 是复杂表达式（TS 不收窄），守卫移到 const 变量上
    const entry = entries[i];
    if (!isPlanStateEntry(entry)) continue;
    applyPlanStateEntry(state, entry.data);
    break;
  }

  return state;
}

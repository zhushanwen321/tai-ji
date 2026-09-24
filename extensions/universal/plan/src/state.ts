import { readdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  PlanDocMeta,
  PlanLifecycleEvent,
  PlanLifecycleState,
  PlanTransitionResult,
} from "@zhushanwen/extension-protocol";
import { PLAN_LIFECYCLE_STATES, transition, truncateSelfReview } from "@zhushanwen/extension-protocol";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("pi-plan");

/**
 * 降级态等待原因（D2 resumeHint，取代旧 reviewStateSource 语义）：'resubmit' =
 * 会话重启（E3）后 agent 尚未重新提交审批。写入点 = index.ts E3 steer 重挂处；
 * 清除点三处（resetPlanState 终态清理组 / activatePlanMode 新轮次重置组 /
 * submit-review 转移落盘时（重挂起点））——不变量：resumeHint 只描述当前降级
 * 等待的原因，不跨轮残留（缺清除 = 跨 plan run 残留，C-U2 同型缺陷）。字面量与
 * shared PlanStateView.resumeHint 严格一致。
 */
export type PlanResumeHint = "resubmit";

/** 终态两值（D1）：completed = 批准并派发执行；exited = 主动退出。共享全部终态规则。 */
export type PlanTerminalState = Extract<PlanLifecycleState, "completed" | "exited">;

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
  /**
   * 生命周期状态（D1 八值，D2 取代式演进）：每次转移落盘，取代 reviewState/reviewStateSource
   * 的隐含编码（两旧键停写，仅旧 entry 映射读——见 applyPlanStateEntry）。生命周期写唯一
   * 通道 = applyPlanEvent（transition 纯函数）。
   */
  state: PlanLifecycleState;
  /**
   * 上次 submit-review 的 selfReview（D9①④）：单字段双角色——E3 重挂回传源 + 防照抄
   * 比较基线（同值同写点无分歧路径）。写入点 = submit-review 转移落盘（写侧 4KB 截断）；
   * 清除点 = resetPlanState / activatePlanMode 进入重置组。
   */
  selfReview?: string;
  /** 降级态等待原因（见 PlanResumeHint）；清除点三处（头注释） */
  resumeHint?: PlanResumeHint;
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
  state: "idle",
};

/**
 * 计划态工具白名单（进入计划模式三处共用——slash 命令 / plan(enter) tool / session_start
 * 恢复；bash 在白名单内，文件写约束来自注入的计划模式提示词，见 pi-ext-021）。
 * 放在 state.ts（叶模块）而非 tool.ts：enter.ts 与本常量互需会造成 enter↔tool 循环依赖。
 *
 * ask_user（D10/F9）：提示词 Phase B 本就指示「Use ask_user tool if available」，白名单
 * 曾把它排除（结构性禁言）。feature-tier 依赖降级：ask-user 是可禁扩展，pi setActiveTools
 * 对不存在的工具名静默跳过（0.84.4 已核实）——被禁时不报错不生效，提示词 "if available"
 * 条件语义即降级（回退对话流提问）。
 */
export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "plan", "ask_user"];

/**
 * plan 包注入消息的 customType（pi.sendMessage custom message 注入的 8 处调用
 * 统一使用）。命名对齐本包 entry customType 字面量 'plan-state' 的连字符风格
 * （设计 §2.1 双命名范式决策：各包跟随所在包 entry 惯例，跨包不统一）。
 * 放 state.ts（叶模块）理由同 PLAN_MODE_TOOLS。
 */
export const PLAN_CONTEXT_CUSTOM_TYPE = "plan-context";

/** Per-session state cache. Keyed by sessionId. */
export type PlanSessionMap = Map<string, PlanState>;

/**
 * reset 世代计数器（D3 连带段 epoch 世代判别）——session 级单调递增，替代门闩标记
 * （门闩标记在「规划期退出无挂起 select 时 cancelled 分支不执行」的形态下会跨轮残留、
 * 把下一次外部解散误判为命令解散，已否决）。
 *
 * 三句纪律（D3）：① epoch 是进程内存态，**禁入 PlanState/entry**（reconstructPlanState
 * 白名单重建会把入 entry 的计数归零错位）；② map 缺失值按「未变」处理（`?? 0` 两侧一致
 * ——新 session 首挂捕 0、比较 0）；③ activatePlanMode 不递增——正确性不依赖「enter 时
 * 无挂起 select」的可达性（逐挂起点捕获 epoch 使每个新 select 拿到当时代际，对任何到达序
 * 都正确；enter 若递增反而误伤同轮旧 select 归口）。
 *
 * 递增点 = resetPlanState 任何调用路径（含 /plan abort 的 handleAbort、tool executeAbort、
 * complete 终局）。生命周期随 abortControllers 注册表同款做 session_shutdown 内存清理
 * （无正确性依赖——注意 session_start 不清：清掉已递增的槽会让在途归口的世代比较失真）。
 */
export type PlanResetEpochs = Map<string, number>;

/** 归口点判别基线：缺失按 0（纪律②，`?? 0` 两侧一致） */
export function currentResetEpoch(epochs: PlanResetEpochs, sessionId: string): number {
  return epochs.get(sessionId) ?? 0;
}

/** reset 即递增（纪律①的写侧唯一出口，resetPlanState 内部调用） */
function bumpResetEpoch(epochs: PlanResetEpochs, sessionId: string): void {
  epochs.set(sessionId, currentResetEpoch(epochs, sessionId) + 1);
}

/**
 * 生命周期写唯一通道（D1）：六 action 的状态写全走本函数——转移成功才改 state.state，
 * 副作用（persist / 注入 / 工具集）由调用方内联在转移成功后执行；`ok:false` 不落盘、
 * 不执行副作用（终态上 ok:false 不落盘 = 归口点的兜底保险）。
 */
export function applyPlanEvent(state: PlanState, event: PlanLifecycleEvent): PlanTransitionResult {
  const result = transition(state.state, event);
  if (result.ok) state.state = result.next;
  return result;
}

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
  // 派生扫描），两侧独立常量，勿改字面量。optional 字段（templateProvidedPath /
  // selfReview / resumeHint / lastSubmitReviewDocsFingerprint）为 undefined 时 JSON
  // 序列化自然消失，旧 entry 消费方对该字段惰性（D4 向后兼容）。
  // D2 取代式演进：reviewState / reviewStateSource 停写——新写只落 state / resumeHint /
  // selfReview；读侧对旧 entry 的映射见 applyPlanStateEntry（D2 读方①）。
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
    templateProvidedPath: state.templateProvidedPath,
    skills: state.skills,
    docs: state.docs,
    state: state.state,
    selfReview: state.selfReview,
    resumeHint: state.resumeHint,
    lastSubmitReviewDocsFingerprint: state.lastSubmitReviewDocsFingerprint,
  });
}

/**
 * Reset plan state to idle, persist, and clean up session cache.
 *
 * 终态矩阵（D5/E10/D3 连带段）：isActive=false + state=terminal（默认 'exited'，complete
 * 终局传 'completed'）+ selfReview/resumeHint/指纹清空 + skills 清空（挂载声明失效）+
 * docs 保留——产物 tab 由 docs.length 驱动、与 isActive 解耦，执行期（approve 后）与
 * 退出后（abort 后）都可回看产物文档；reset entry 持久，重开 session 后冷启动首拉仍恢复
 * docs 显示，至下次 /plan 同 slug 覆写。
 */
/** 空 slug 目录清理（状态审查 P3-10）：enter 即 mkdir，未产任何文档即退出会留空目录残盘。
 * 仅删「真正为空」的 slug 目录——目录里有任何残留文件（含未登记杂文件）一律保留（保守，
 * 不做递归删除）；目录不存在 / 非空 / 不可读均降级跳过（warn 留痕），清理失败不影响退出主流程。
 */
function removeEmptyPlanDir(planFilePath: string): void {
  if (!planFilePath) return;
  try {
    const dir = dirname(planFilePath);
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch (error) {
    logger.warn("plan: empty plan dir cleanup skipped", { error: toErrorMessage(error) });
  }
}

export function resetPlanState(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  epochs: PlanResetEpochs,
  sessionId: string,
  ctx: ExtensionContext,
  terminal: PlanTerminalState = "exited",
): PlanState {
  // epoch 先递增（D3 连带段）：abort()→reset 同步临界段的归口点必在 reset 后运行，
  // 世代事实先行置位保证任何中途异常都不会漏递增（S15 同步临界段不变量的另一半）
  bumpResetEpoch(epochs, sessionId);
  const state = getPlanState(sessions, sessionId, ctx);
  state.isActive = false;
  // 空目录清理必须在 planFilePath 清空之前（路径是唯一的目录推导来源）
  removeEmptyPlanDir(state.planFilePath);
  state.planFilePath = "";
  state.requirement = "";
  state.templateName = "";
  delete state.templateProvidedPath;
  state.skills = [];
  // 终态参数（D3 连带段）：默认 'exited'，complete 终局传 'completed'——防 reset 覆写
  // completed（终态两值仅留诊断/审计区分，共享全部终态规则）
  state.state = terminal;
  // selfReview 随退出失效（E3 回传源 + 比较基线都只在本轮内有效，跨轮残留会误触新鲜度门）
  delete state.selfReview;
  // resumeHint 与降级等待同生命周期随退出失效（清除点三处之一）
  delete state.resumeHint;
  // 指纹快照随退出失效：approve/abort 后的新 plan 轮次从「无既往提交」重新计数，
  // 首次 submit-review 不触发无变化警告（docs 虽保留供回看，但不作为检测基线）
  delete state.lastSubmitReviewDocsFingerprint;
  persistPlanState(pi, state);
  sessions.delete(sessionId);
  return state;
}

function isPlanStateEntry(entry: SessionEntry): entry is CustomEntry<LegacyPlanEntryData> & { customType: "plan-state" } {
  // 判别式收窄（type === "custom"）后可直接访问 customType/data，无需 cast。
  // 「字段存在即合法」：新字段全部 optional，旧四字段 entry 同样合法（D4 向后兼容）。
  return (
    entry.type === "custom" &&
    entry.customType === "plan-state" &&
    typeof entry.data === "object" &&
    entry.data !== null
  );
}

/**
 * 旧 schema entry data（D2 读方①映射源）：reviewState/reviewStateSource 是已停写的历史字段
 * （取代式演进——新写只落 state/resumeHint/selfReview），只在重建读侧映射消费。
 */
type LegacyPlanEntryData = Partial<PlanState> & {
  reviewState?: unknown;
  reviewStateSource?: unknown;
};

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

/**
 * 生命周期状态读取（D2 读方①，旧字段映射归一点）：
 * ① 新字段直读（值域守卫：PLAN_LIFECYCLE_STATES 之外的垃圾值按缺失处理，落映射）；
 * ② 旧 entry 无 state 时映射 reviewState（awaiting→reviewing / revising→revising /
 *    无→planning|idle 按 isActive）。
 */
function readLifecycleState(data: LegacyPlanEntryData, isActive: boolean): PlanLifecycleState {
  const raw = data.state;
  if (typeof raw === "string" && (PLAN_LIFECYCLE_STATES as readonly string[]).includes(raw)) {
    return raw as PlanLifecycleState;
  }
  if (data.reviewState === "awaiting") return "reviewing";
  if (data.reviewState === "revising") return "revising";
  return isActive ? "planning" : "idle";
}

/** resumeHint 读取：新字段直读 + 旧 reviewStateSource 同义映射（D2 读方①），域外值按无值 */
function readResumeHint(data: LegacyPlanEntryData): PlanResumeHint | undefined {
  if (data.resumeHint === "resubmit") return "resubmit";
  return data.reviewStateSource === "resubmit" ? "resubmit" : undefined;
}

/**
 * selfReview 白名单式读取 + 有界防御：非 string（含缺失）归无值；读侧同样 4KB 截断
 * （对齐 readRequirement 读侧防御先例——保证派生/回传恒有界，封顶前旧 entry 超长文本
 * 在重建时同样封顶）。
 */
function readSelfReview(data: LegacyPlanEntryData): string | undefined {
  return typeof data.selfReview === "string" ? truncateSelfReview(data.selfReview) : undefined;
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
function applyPlanStateEntry(state: PlanState, data: LegacyPlanEntryData | undefined): void {
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
  // 生命周期状态：新字段直读 + 旧 reviewState 映射（isActive 兜底，D2 读方①）
  state.state = readLifecycleState(entryData, state.isActive);
  state.selfReview = readSelfReview(entryData);
  state.resumeHint = readResumeHint(entryData);
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

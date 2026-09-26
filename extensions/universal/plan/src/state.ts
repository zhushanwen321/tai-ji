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
 * 清除 = clearRoundFields 单函数出口（D4 收敛，三处轮次边界调用：resetPlanState /
 * activatePlanMode / submit-review 重挂起点）——不变量：resumeHint 只描述当前降级
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
   * --template 直传标记（D7 select-template 防御的判定信号；templateName/templateProvidedPath
   * 双字段合并后的独立判定字段——templateName 值域不变，直传事实不再以路径字段持久化）：
   * true = 直传进入；缺失 = 模板流程（进入与选中共用缺失态，防御只拦直传格）。
   * 重启经 entry 恢复，reset 时随退出失效。
   *
   * 双向版本错配登记（dev-link 窗口可达，生产被 Q-4 原子发版覆盖）：
   * ① 新扩展读旧 entry（双字段形态）：读侧把 templateProvidedPath 存在映射回本字段
   *   （readTemplateProvided），直传防御行为等价；
   * ② 旧扩展读新 entry（单字段形态）：旧读侧对缺失按模板流程降级，直传防御静默少拦
   *   （不误拦）——恢复动作 = dev-link 重新对齐版本后重试；生产出现该错配 = 原子发版
   *   被破坏的反证，重审本合并（候选替代 = 恢复 templateProvidedPath 双字段形态）。
   */
  templateProvided?: boolean;
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
   * 清除 = clearRoundFields（D4 单函数出口）。
   */
  selfReview?: string;
  /** 降级态等待原因（见 PlanResumeHint）；清除 = clearRoundFields（D4 单函数出口） */
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
 * D9 宿主分流信号：taiji runtime 对托管 pi 恒注入 TAIJI_AGENT_EXT_LOG=1；
 * 独立 pi 无此信号 → submit-review 走 E8 文本软门（不发 marker select——
 * pi TUI 原生渲染 \x00 控制符 title + JSON options 成乱码对话）。
 * 不用 TAIJI_RUNTIME_TOKEN：它在 SPAWN_ENV 出站 deny list 被强制剥除
 * （C-proc-09），pi 子进程 env 里恒不可见，照抄即分流静默失效且诱导实施者
 * 动 deny list 造成安全回归。每次调用时读（不可模块加载时缓存——测试与
 * 运行中 env 都可能变化）。
 *
 * [双语义耦合登记，2026-09-20 R1] 本 env 名义语义是扩展日志开关
 * （extension-logger 见之落盘 INFO，恒注入点 packages/pi-rpc/src/env.ts），本函数
 * 是第二消费方（宿主分流，submit-review / complete / 引导门三处）——若日志开关
 * 走向可配置（值不再是恒 '1'），三处分流同帧静默失效，届时必须拆专用宿主信号
 * env 并纳入恒注入，不得沿用本名。
 *
 * export（F-W3-1）：index.ts E3 reviewing 恢复分支复用同一宿主信号做 GUI 分流
 * （taiji GUI 宿主有 degraded 恢复按钮，不自动重挂审批；独立 pi 无按钮保留 steer）——
 * 第四消费方，同帧失效约束随登记面扩展。
 *
 * 放本叶模块（D-B1-7 随 isTaijiGuiHost 收敛迁入，原 tool.ts）：宿主判定信号与
 * per-session 注册表/挂起原语同域承载，不经 tool.js 大模块中转。
 */
export function isTaijiHost(): boolean {
  return process.env.TAIJI_AGENT_EXT_LOG === "1";
}

/**
 * taiji GUI 宿主判定（D-B1-7，B5 过渡步——批次 4 askInteractively 原语再收交互分流）：
 * 三处 `isTaijiHost() && ctx.mode === "rpc"` 复写（submit-review marker select /
 * complete 执行方式 form / E3 恢复分流）收敛为本谓词单点。mode 收紧 rpc 的理由
 * 同 isTaijiHost 双语义耦合登记：env 信号只证明 taiji runtime 在上游，宿主没有
 * marker 路由的形态（TUI / json / print）不发 select。
 */
export function isTaijiGuiHost(ctx: ExtensionContext): boolean {
  return isTaijiHost() && ctx.mode === "rpc";
}

/**
 * 挂起 select 的解散来源直传原语（D-B1-2，取代旧世代计数推断）：判别所需信息
 * 「是不是经 exitPlanMode 入口解散」产生于入口调用点，随挂起闭包直达等待处，
 * 消费侧不再按世代计数推断。
 *
 * 纪律：① dissolvedBy 由 markDissolved **一次赋值**（exitPlanMode 入口打 'self'；
 * 'external' 留给不经入口的外部解散显式打标，现无打标点——等待处按「非 'self'
 * 即外部」分派）；② 闭包身份天然携带轮次记忆——每个挂起 select 持有独立来源变量，
 * 跨轮迟到解散按各自闭包判别，无跨轮残留面；③ 禁入 PlanState/entry（进程内存态，
 * 随 controllers 注册表同生命周期）。
 */
export interface PendingSelect {
  controller: AbortController;
  /** 解散来源：undefined = 尚未解散（或外部级联未打标——turn abort 级联只 abort 不打标） */
  readonly dissolvedBy: "self" | "external" | undefined;
  /** 一次赋值：解散来源置位（重复调用以末次为准，正常路径仅入口打标一次） */
  markDissolved(source: "self" | "external"): void;
}

/**
 * 挂起 select 的 per-session 注册表（E10；值 = PendingSelect 含解散来源槽位，
 * 不新建注册表）。生命周期钉死：每次发挂起 select 前 fresh 一个（见 freshPendingSelect），
 * select settled 即弃；session_start / session_shutdown / exitPlanMode 联动处清理。
 */
export type PlanAbortControllers = Map<string, PendingSelect>;

/**
 * 发挂起 select 前新建 PendingSelect 并登记。禁复用已 abort 的 controller——
 * pi 实装对已 abort 的 signal 在 createDialogPromise 首行短路立即 resolve undefined，
 * 复用会让退出后再入 plan 的 submit-review 瞬时静默取消。
 * pi 实装锚点：dist/modes/rpc/rpc-mode.js:48（0.84.4）——createDialogPromise 首行
 * `opts?.signal?.aborted` 即 `return Promise.resolve(defaultValue)`，select 的
 * defaultValue = undefined（E10 生命周期设计依据）。
 */
export function freshPendingSelect(
  controllers: PlanAbortControllers,
  sessionId: string,
): PendingSelect {
  // dissolvedBy 走闭包变量（getter 透出）：markDissolved 即便被解构调用也指向同一存储
  let dissolvedBy: "self" | "external" | undefined;
  const pending: PendingSelect = {
    controller: new AbortController(),
    get dissolvedBy() {
      return dissolvedBy;
    },
    markDissolved(source) {
      dissolvedBy = source;
    },
  };
  controllers.set(sessionId, pending);
  return pending;
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
  // 派生扫描），两侧独立常量，勿改字面量。optional 字段（templateProvided /
  // selfReview / resumeHint / lastSubmitReviewDocsFingerprint）为 undefined 时 JSON
  // 序列化自然消失，旧 entry 消费方对该字段惰性（D4 向后兼容）。
  // D2 取代式演进：reviewState / reviewStateSource 停写——新写只落 state / resumeHint /
  // selfReview；读侧对旧 entry 的映射见 applyPlanStateEntry（D2 读方①）。
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
    templateProvided: state.templateProvided,
    skills: state.skills,
    docs: state.docs,
    state: state.state,
    selfReview: state.selfReview,
    resumeHint: state.resumeHint,
    lastSubmitReviewDocsFingerprint: state.lastSubmitReviewDocsFingerprint,
  });
}

/**
 * per-round 字段清理单函数（D4 clearRoundFields）：selfReview / resumeHint /
 * lastSubmitReviewDocsFingerprint 三个「只描述当前 plan 轮次」的字段随轮次边界
 * （退出 reset / 新轮进入 / submit-review 重挂起点）统一在此清除——三处清除点
 * 此前各自内联 delete，字段集的「同生命周期」约束靠三处注释互指维持；收敛后
 * 不变量单点表达：新增 per-round 字段只改本函数（grep `delete state.resumeHint`
 * 旧触点 = 本函数单出口）。
 *
 * executeSubmitReview 调用点随后置位 selfReview / 指纹（重挂起点写新值）——
 * delete→set 与原「仅 delete resumeHint」的属性终态一致，行为等价。
 */
export function clearRoundFields(state: PlanState): void {
  // selfReview：E3 回传源 + 防照抄比较基线只在本轮内有效，跨轮残留会误触新鲜度门
  delete state.selfReview;
  // resumeHint 只描述当前降级等待的原因，不跨轮残留（缺清除 = 跨 plan run 残留，
  // C-U2 同型缺陷：渲染上一轮「会话已重启」降级文案）
  delete state.resumeHint;
  // 指纹快照随轮次失效：新 plan 轮次从「无既往提交」重新计数，首次 submit-review
  // 不触发无变化警告（docs 虽保留供回看，但不作为检测基线）
  delete state.lastSubmitReviewDocsFingerprint;
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
  sessionId: string,
  ctx: ExtensionContext,
  terminal: PlanTerminalState = "exited",
): PlanState {
  const state = getPlanState(sessions, sessionId, ctx);
  state.isActive = false;
  // 空目录清理必须在 planFilePath 清空之前（路径是唯一的目录推导来源）
  removeEmptyPlanDir(state.planFilePath);
  state.planFilePath = "";
  state.requirement = "";
  state.templateName = "";
  delete state.templateProvided;
  state.skills = [];
  // 终态参数（D3 连带段）：默认 'exited'，complete 终局传 'completed'——防 reset 覆写
  // completed（终态两值仅留诊断/审计区分，共享全部终态规则）
  state.state = terminal;
  // per-round 字段随退出失效（D4 单函数出口，字段语义见 clearRoundFields）
  clearRoundFields(state);
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
 * （取代式演进——新写只落 state/resumeHint/selfReview），只在重建读侧映射消费；
 * templateProvidedPath 是双字段合并前已停写的直传路径字段（读侧映射 readTemplateProvided）。
 */
type LegacyPlanEntryData = Partial<PlanState> & {
  reviewState?: unknown;
  reviewStateSource?: unknown;
  templateProvidedPath?: unknown;
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

/**
 * 直传标记读取（新旧 entry 双形态）：新字段直读（严格 === true，垃圾值按无值）；
 * 旧 entry 的 templateProvidedPath（合并前已停写路径字段，保留边界「entry 级旧字段映射」）
 * 存在即直传——直传防御行为等价，双向版本错配登记见 PlanState.templateProvided 注释。
 */
function readTemplateProvided(data: LegacyPlanEntryData): boolean | undefined {
  if (data.templateProvided === true) return true;
  return typeof data.templateProvidedPath === "string" ? true : undefined;
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
  state.templateProvided = readTemplateProvided(entryData);
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

// src/protocol/contract-types.ts
//
// 引擎面契约类型 SSOT（协议两侧不许各写一份；core 反向 re-export 保上层消费面）。
// 设计权威源：docs/architecture/subagent-engine-protocolization.md §3.5.1 D7 类型闭包表 +
// impl-plan §2.1「类型闭包处置」。
//
// 搬运口径（逐字对照，结构等价、零 core import）：
//   - AgentEvent / AgentUsage / AgentUsageTotal / ToolCallResult / ToolCall /
//     InternalToolCall / Turn ← core execution/assembly/types.ts（2026-09-09 实测 :164-:313）
//   - ReplayedTurn / SessionView / EngineHandleData / EngineCapabilities / ProbeReport /
//     AgentOutcome ← core execution/engine/types.ts
//   - AgentFailureKind / AgentOutcomeUsage（core 名 AgentUsage，orchestration 版）/
//     ToolCallEntry / AgentCallOpts 子集 ← core orchestration/models/types.ts
//   - WorktreeHandle ← core execution/assembly/types.ts:349（SDK 结构等价副本——设计 §3.5.1
//     点名「AgentCallOpts.worktree 的 WorktreeHandle 即这类副本」）
//
// ==================== 字段归属判据 1-7（协议宪法·字段面；新增 wire 字段依序裁决，
// 先到先定。条文全文 = engine-protocol.ts 头注；删改史与判据 why =
// docs/adr/decisions.md ADR-0071） ====================
// 1. 引擎不消费它，任务能否正确完成？能 → 宿主自持不上协议。
// 2. 「任务是什么」（what→task）还是「在什么环境跑/怎么跑」（where/how→ctx）？
// 3. 引擎能否自行推导该环境值且与宿主恒等？能 → 不上协议；不能（推导分叉）→ ctx。
// 4. （绝对条款）同一语义不得 task/ctx 双写——wire 层同名键交集恒空（编译断言锁）。
// 5. （能力绑定）字段有效性依赖能力位时双向回指（先例 streamMode↔eventGranularity）。
// 6. （键三分类）advisory（忽略无语义影响，直接 additive）/ degradable（设计内静默
//    降级：缺省最弱档 + 判据 5 回指 + 预检豁免）/ behavior（忽略会静默改变任务语义：
//    必须绑定能力位 + 宿主派发前预检；先例 resume↔conversation gate、forkSource）。
//    判别式：「旧引擎静默忽略此键，宿主会发现吗？该降级是设计内吗？」
// 7. （能力位消费点登记）每个能力位登记消费点与 wire 载体，执行通道缺失如实登记；
//    未登记位 = 违宪（首个登记条目 = steer）。
//
// 演进政策（字段面）：新增字段/事件变体/方法/通道过新增门槛（消费方 + 降级路径 +
// 能力位绑定三件齐）才进协议，无消费方不进协议；A 型同形改名默认 additive 双读 +
// major 清除，B 型机制替换同批合法（对端同仓 + ADR 登记）——三条全文见
// engine-protocol.ts 头注，minor 协商触发条件见 ADR-0071。
//
// 新轴五触点清单（新增能力位；触发需求前不落代码，C 型纪律）：①本文件
// EngineCapabilities 加可选键 + 缺省最弱档注释；②core↔SDK 双向断言与存量必填保持绿；
// ③core 两表各登各的（CONSERVATIVE_CAPABILITIES 保守缺省值 / CAPABILITY_ENUMS 值域，
// 缺一即 undefined 透传 + gate 放行）；④gate 判据比较最弱档字面值（键集锁兜底）；
// ⑤pi-host-binding 能力位快照同步登记。
//
// ==================== 未知成员宽容语义四行（运行时半边，与编译期词表锁互补；
// 条文权威 = ADR-0071；本文件承载①④，②落 methods.ts 头注，③落 reverse-channels.ts
// 头注）====================
// ① 未知 event.type → 旧宿主 reducer default no-op 安全落空——逐变体 noop-safe:
//    论证标记登在下方 AGENT_EVENT_TYPE_NAMES 词表成员行（U2 已实装，标记守卫 =
//    contract-closure.test.ts「noop-safe 标记守卫」），此处只引用不复述论证内容。
// ④ 未知可选键 → advisory 忽略（判据 6 第一档：忽略无语义影响，直接 additive）；
//    behavior 键必有门（宿主派发前预检），不存在「无门依赖」的 behavior 键——与
//    判据 6 呼应：宽容只覆盖 advisory/degradable，behavior 靠预检不靠容忍。
// 引擎义务传导 = docs/extensions/subagents/engine-development-guide.md（②的应答义务
// 条目）+ docs/constraints.json C-proc-24（scope/触发描述双登记）。
//
// core 域类型（ExecutionRecord / Turn 的宿主内部态消费）留 core；SDK 侧一切类型为
// 结构等价形态，漂移由双向可赋值断言（AssertMutuallyAssignable）在 typecheck 期抓出
// ——core 侧断言挂靠归 W2（本文件导出该类型助手供其复用），SDK 侧样板见
// src/__tests__/contract-closure.test.ts。

// ============================================================
// 断言助手（W2 core 侧双向可赋值断言复用）
// ============================================================

/**
 * 双向可赋值断言：`type _A = AssertMutuallyAssignable<CoreX, SdkX>` 结果必须为 true。
 * 任一方向不可赋值（字段缺失 / 可选性漂移 / 联合分支不齐）结果为 never → 编译失败。
 * 用法（core 侧 W2 挂靠）：
 *   import type { AssertMutuallyAssignable } from "@zhushanwen/subagent-engine-sdk";
 *   type _CoreSdkAgentEvent = AssertMutuallyAssignable<CoreAgentEvent, SdkAgentEvent>;
 *   const _assert: _CoreSdkAgentEvent = true;
 */
export type AssertMutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

// ============================================================
// 事件面（AgentEvent 及其字段型）
// ============================================================

/** token 用量（message_end 单条消息增量）。← core execution/assembly/types.ts AgentUsage。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 本 message 的成本（USD）。无成本数据时缺省。 */
  cost?: number;
}

export interface AgentUsageTotal extends AgentUsage {
  /** 四项之和。投影时不再手工求和。 */
  total: number;
  /** 累计成本（USD）。无成本数据时为 0。 */
  cost: number;
}

/** tool 调用结果（tool_end 携带，含 structured-output 的 details）。 */
export interface ToolCallResult {
  content?: unknown[];
  details?: unknown;
}

/** tool 调用（导出的纯净数据形状，不含内部状态机）。 */
export interface ToolCall {
  toolName: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
}

/** 内部 ToolCall：追加 _status 进行中标记与 startedTs（reducer 内部态，跨边界导出前 strip）。 */
export interface InternalToolCall extends ToolCall {
  _status: "running" | "done" | "failed";
  /** tool_start 到达时的墙钟时间戳（Date.now()，ms）。 */
  startedTs: number;
}

/** 一个 turn 的完整内容（reducer turns[] 的元素）。 */
export interface Turn {
  /** 本 turn assistant 正文（text_delta 流式累积，完整）。 */
  text: string;
  /** 本 turn 推理（thinking_delta 流式累积，完整）。 */
  thinking: string;
  /** 本 turn 工具调用（InternalToolCall：含完整 result + _status 进行中标记）。 */
  toolCalls: InternalToolCall[];
  /** 本 turn message_end 的 token 增量（聚合得 usage 总量）。 */
  usageDelta?: AgentUsage;
  /** turn_end 是否已到达。false=正在进行；true=已闭合。 */
  closed: boolean;
  /** turn_end 到达时的墙钟时间戳（Date.now()，ms）。 */
  closedTs?: number;
}

/**
 * 引擎事件（9 种，协议 event.params.event 逐字序列化——「事件与 handle 序列化逐字
 * 兼容」不变量 3 的类型面）。语义锚点 = pi（ACP 词汇对照见 core execution/assembly/types.ts 注释）。
 *
 * activity = 纯活性信号：双侧 reducer no-op、不开 turn、不写状态、不落 journal
 * （core journal-wiring 对其豁免 append），只承诺「引擎活跃时周期性出现」——供宿主
 * 无进展守护刷新判活（长工具执行期）。节流属生产者实现细节，不进协议承诺。
 *
 * 每个成员的 type 经 `EventName<"…">` 受词表约束（编译锁①，见下方词表节）。
 */
export type AgentEvent =
  | { type: EventName<"tool_start">; toolName: string; args?: unknown }
  | { type: EventName<"tool_end">; toolName: string; args?: unknown; result?: ToolCallResult; isError?: boolean }
  | { type: EventName<"text_delta">; delta: string }
  | { type: EventName<"thinking_delta">; delta: string }
  | { type: EventName<"turn_end">; summary?: string }
  | { type: EventName<"message_end">; usage?: AgentUsage; error?: string }
  | { type: EventName<"compaction"> }
  | { type: EventName<"activity"> }
  | { type: EventName<"error">; message: string };

// ============================================================
// 事件词表锁（AgentEvent ⟷ AGENT_EVENT_TYPE_NAMES 同源互证）
// ============================================================

/**
 * 事件类型词表（协议事件全集 9 种，运行时 SSOT）：schema 事件 `type.enum` 从本表
 * 派生（schema.ts），测试取值遍历本表（protocol-schema.test.ts / contract-closure.test.ts）
 * ——新增事件变体不再手写第三处。
 *
 * 每个成员必须带一行 `// noop-safe: <论证>`：未知成员宽容语义四行①（ADR-0071）的
 * 逐变体登记——旧宿主 reducer 遇未知 event.type 走 default 分支零写入，标记后写
 * 「本变体被丢弃时状态无损」的一行论证（no-op 安全性属运行时消费语义，不可静态
 * 判定——守卫只查标记存在不查内容，落点 contract-closure.test.ts「noop-safe 标记守卫」）。
 *
 * 编译锁（漏改任一侧 typecheck 红，且错误指向漏点）：
 *   ① union 侧——成员 type 必须经 `EventName<"x">` 取名（约束 = 本词表）：union 加
 *      成员不登词表 → TS2344 直接落在漏改的成员行；
 *   ② 词表侧——`satisfies readonly AgentEvent["type"][]`：词表加成员不加 union
 *      → 错误直接落在词表漏改的成员行；
 *   ③ 兜底——成员绕过 EventName 约束裸加字面量 → _EventVocabSyncLock 爆红。
 * 新增事件变体 = 词表 + union 一处族两笔同改即全同步（schema enum 与测试断言自动
 * 跟随），不 bump 版本、不改任何引擎（演进政策 additive 面，判据全文见文件头注）。
 */
export const AGENT_EVENT_TYPE_NAMES = [
  "tool_start", // noop-safe: 旧宿主 default 分支零写入——丢弃仅缺 tool 起始占位（显示降级），turn 结构不受损
  "tool_end", // noop-safe: 旧宿主 default 分支零写入——丢弃仅缺 result，turn 收口由 turn_end/message_end 承担
  "text_delta", // noop-safe: 旧宿主 default 分支零写入——丢弃仅缺正文增量，不产生半解析状态
  "thinking_delta", // noop-safe: 旧宿主 default 分支零写入——丢弃仅缺推理增量，不产生半解析状态
  "turn_end", // noop-safe: 旧宿主 default 分支零写入——丢弃则该 turn 滞留进行态，journal 重放仍按序重建
  "message_end", // noop-safe: 旧宿主 default 分支零写入——丢弃仅缺 usage 聚合与闭合计量，已累积内容不回滚
  "compaction", // noop-safe: 事件无载荷且现行 reducer 即直接 return——丢弃与处理零差异
  "activity", // noop-safe: 纯活性信号，双侧 reducer 恒 no-op（协议语义见 AgentEvent 头注），丢弃零差异
  "error", // noop-safe: 旧宿主 default 分支零写入——丢弃仅缺 lastError 诊断留痕，已写状态不回滚
] as const satisfies readonly AgentEvent["type"][];

/** 词表派生的事件名联合（编译锁②/③的词表侧源；schema enum 与测试取值同源）。 */
export type AgentEventTypeName = (typeof AGENT_EVENT_TYPE_NAMES)[number];

/**
 * 词表约束的事件 type 字面量（编译锁①）：union 成员经 `EventName<"x">` 取名，
 * 词表漏登时 typecheck 错误落在该成员行。类型恒等（解析为同一字面量），
 * 结构与运行时语义零变化。
 */
type EventName<T extends AgentEventTypeName> = T;

// 编译锁③（兜底）：union 成员绕过 EventName 约束裸加字面量 → 本断言赋值处爆红
// （union ⊆ 词表 的精确落点由锁①承担，此处兜住绕过约束的裸写形态）。
const _EventVocabSyncLock: AssertMutuallyAssignable<AgentEvent["type"], AgentEventTypeName> = true;

// ============================================================
// handle / read 视图
// ============================================================

/**
 * EngineHandle 的持久化形态（JSON v1）。协议 run 终态应答 / read 的
 * handle 载荷（引擎不持有宿主运行时引用，data 即全部）。
 */
export interface EngineHandleData {
  v: 1;
  /** 引擎 id（'pi' | 'zcode' | ...）。 */
  engineId: string;
  /** 引擎自定义定位键值。pi = { recordId?, sessionFile? }；zcode = { sessionId, dbPath }。 */
  sessionRef: Record<string, string>;
  /**
   * journal 绝对路径（read 第②级数据源；宿主读前校验前缀白名单）。缺省 = 无 journal。
   * [池抽象降级 2026-09-13] 原 poolKey 字段已删除——两引擎 poolKey 恒 'shared'
   * （SDK SHARED_POOL_KEY），journal 固定落 engines/<engineId>/shared/，字段零信息量。
   */
  journalPath?: string;
  /** probe 实测版本（漂移排查锚点）。 */
  engineVersion?: string;
  /** 适配器版本（golden 样本对齐排查）。 */
  adapterVersion: string;
}

/**
 * [v1.x] 冷续 resume 锚点——EngineHandleData 定位键的投影子集（诊断字段
 * v/engineVersion/adapterVersion 不属锚点语义，不随锚点走）。消费点：
 *   - run.params.resume（宿主 → 引擎：冷续重开已 idle 的 session，pi 消费
 *     sessionRef.sessionFile —— 对照 core SpawnResumeOpts.sessionFile 的锚点面）。
 * [H1 U6 已切换] 键切换单批完成（读写端同批），锚点仅经 resume 键携带。
 * 类型层与 EngineHandleData 定位形态的对照由测试断言（Pick 可赋值闭包）锁定。
 */
export interface ResumeAnchor {
  /** 引擎定位键（pi = { recordId?, sessionFile? }；zcode = { sessionId, dbPath }）。 */
  sessionRef: Record<string, string>;
  /** journal 绝对路径（read 降级链第②级数据源；无 journal 缺省）。 */
  journalPath?: string;
}

/** Turn → ReplayedTurn：剥离内部态（closed 恒 true——重放物无进行时语义）。 */
export interface ReplayedTurn {
  text: string;
  thinking: string;
  /** 导出的纯净形状（ToolCall，无 _status/startedTs）。 */
  toolCalls: ToolCall[];
  closed: true;
}

/**
 * session 历史的引擎中立视图（协议 read 应答）。降级链三级：①引擎原生读取 →
 * ②宿主 event journal 重放 → ③outcome-only。source 字段是 GUI 降级标记数据源。
 */
export interface SessionView {
  engineId: string;
  sessionId?: string;
  /** turns[] 派生数据（重放/重建产物）。 */
  turns: ReplayedTurn[];
  /** 各 turn usageDelta 聚合。 */
  usage?: AgentUsageTotal;
  source: "native" | "journal" | "outcome-only";
}

// ============================================================
// 能力 / 探针 / 交互
// ============================================================

/**
 * 引擎能力声明（11 位）。三级：native / emulated / unsupported。
 * 声明的是本仓 subagent 链路实际接通的能力，不是引擎 RPC 层的理论能力。
 * 同步权威 = manifest（注册期直读）；握手应答仅诊断（§3.3「同步成员清单」）。
 */
export interface EngineCapabilities {
  /** native: --json-schema/--output-schema/env 注入。 */
  schemaEnforcement: "native" | "emulated";
  /** 注意区分「引擎 RPC 层有此能力」与「subagent 链路已接通」。 */
  steer: "native" | "emulated" | "unsupported";
  /**
   * [H1 D5 语义收窄 + modeless] 「怎么续」形态轴兼 message 资格轴：
   * 位非 'unsupported' = 引擎可续聊（core capability-gate 的 message 资格门消费），
   * 值区分续聊形态——native（原地续写）/ cold（冷恢复重建 + 新 run + resume 锚点）。
   * 原名字沿用——conversation 位保留、语义从「interact 长驻控制面」收窄为
   * 「resume 续聊能力」。[modeless 波2] 会话形态键只剩 run.params.resume（协议
   * task.conversation 已删），本轴不再是 per-run 模式开关——描述各引擎的真实
   * 续聊差异（gate 判据仍是 `=== "unsupported"` 拒绝，"cold" 与 "native" 等价
   * 放行）。
   */
  conversation: "native" | "cold" | "unsupported";
  /** 决定 persona 路由策略（file/flag/prompt 通道）。 */
  personaInjection: "file" | "flag" | "prompt";
  /** 粗粒度引擎：GUI 显示降级为阶段态。 */
  eventGranularity: "stream" | "coarse";
  /** emulated = worktree 隔离（无 OS sandbox 的引擎用文件写维度隔离补齐）。 */
  sandbox: "native" | "emulated" | "none";
  /** 重建历史的能力（read 降级链第①级保真度上限）。 */
  sessionRead: "full" | "partial" | "outcome-only";
  resume: "native" | "cold" | "unsupported";
  /** 优雅中断 or 只能杀进程（公共杀链兜底）。 */
  interrupt: "native" | "kill-only";
  /** kimi headless 固定 auto = ignored；GUI 据此隐藏/提示。 */
  permissionMode: "native" | "fixed" | "ignored";
  /** maxTurns 轮数上限执行能力位（pi=true / zcode=false）。 */
  maxTurns: boolean;
}

/** 引擎探针报告（probe 应答）。ok=false 时 error 必填（恢复指引）。 */
export interface ProbeReport {
  ok: boolean;
  /** 实测版本（探测不到时为空串）。 */
  engineVersion: string;
  /** 二进制存在/版本解析/干跑回归逐项。 */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  /** engine_probe_failed 的恢复指引（ok=false 时必填）。 */
  error?: { code: string; recovery: string };
}

// ============================================================
// 终态 / 任务声明
// ============================================================

/** 失败分诊结构化标签。unknown（含缺省）= 可重试（语义守恒）。 */
export type AgentFailureKind = "stale_context" | "schema_deterministic" | "unknown";

/**
 * AgentOutcome.usage 字段型（← core orchestration/models/types.ts AgentUsage 结构等价；
 * SDK 改名消歧——core 的两个同名 AgentUsage 分属 execution 与 orchestration 域）。
 */
export interface AgentOutcomeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** 单次 tool 调用记录（workflow trace 形态）。 */
export interface ToolCallEntry {
  /** Tool name. */
  name: string;
  /** Args preview string. */
  input: string;
}

/** worktree 句柄（结构等价副本；core 权威定义在 execution/assembly/types.ts:349）。 */
export interface WorktreeHandle {
  /** checkout 目录（子 agent 工作目录）。 */
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** 主仓库根目录（cleanup/scan 需要）。 */
  readonly mainCwd: string;
}

/**
 * 一次引擎执行的终态（协议 run 终态应答的 outcome 载荷）。锚定 core
 * orchestration AgentResult 并追加引擎层字段（engineId / engineFallback / exitCode）。
 */
export interface AgentOutcome {
  content: string;
  /** 失败分诊标签。产出侧 = 引擎；缺省 = unknown = 可重试。 */
  failureKind?: AgentFailureKind;
  /** native 引擎直传 / 仿真层 ajv 产出（D4 硬分流：native 路径宿主不做二次校验）。 */
  parsedOutput?: unknown;
  usage?: AgentOutcomeUsage;
  durationMs?: number;
  /** 错误码前缀格式（`<code>: <detail>`，错误规格见协议 error-codes）。 */
  error?: string;
  /** 引擎语义 session id。 */
  sessionId?: string;
  sessionFile?: string;
  /** 仅诊断——目录可能已被 finalize 清理，不得作为 cwd 复用。 */
  worktreePath?: string;
  toolCalls?: ToolCallEntry[];
  /** 实际执行引擎（fallback 后可能 ≠ 请求值）。 */
  engineId: string;
  /** fallback 留痕（record 同步投影，GUI 警告条数据源）。 */
  engineFallback?: { from: string; reason: string };
  /** null = 被信号杀死（杀链/abort 合成终态的判据）。 */
  exitCode?: number | null;
}

// ============================================================
// AgentCallOpts 引擎面子集（协议 run.params.task）
// ============================================================

/**
 * 引擎模型目录条目（manifest `modelCatalog.models` 条目形态，设计 §3.4 示例）。
 * 协议面 = initialize 应答 models? 与 listModels 应答 models 的元素型；
 * manifest 解析与生成（gen:model-catalog）归 W4/W5 实装。
 */
export interface ModelCatalogEntry {
  id: string;
  aliases?: string[];
  canonicalRef?: string;
}

/**
 * 单次 agent 调用的任务声明——引擎面子集（协议 run.params.task；core 全量
 * AgentCallOpts 22 字段留 core，core 侧反向 re-export 保消费面）。
 *
 * 字段裁决（对照 core orchestration/models/types.ts AgentCallOpts，2026-09-09）：
 * - 入选 = 引擎消费面：任务语义（prompt/schema/thinkingLevel/skill/skillPath/agent/persona 注入）、
 *   轮次预算（maxTurns/graceTurns/idleTimeoutMs）、隔离与权限（worktree/
 *   fork/forkSource/denyTools/permissionMode）、诊断（description/scene）；
 * - 排除并改挂 run.params.ctx（协议层已单列，task 内双写会分叉）：model（→ctx.model）、
 *   schemaEnv（→ctx.schemaEnv）、cwd（→ctx.cwd）、engineFallback（→ctx.engineFallback）；
 * - 排除（宿主侧消费，无引擎语义）：engine（路由决策已完成，收到的引擎即选中值）、
 *   timeoutMs（宿主超时链 mergeTimeoutSignal → cancel 帧，非引擎参数）、returnMeta
 *   （core 注释明确「dropped at the pi boundary」，非引擎消费）。
 *
 * W2 实装 EngineClient run 帧时以本类型为 params.task；core 侧全量 → 子集的方向性
 * 收窄（多余字段宿主自持不透传）不构成类型漂移（断言方向见 contract-closure 测试样板）。
 */
export interface AgentCallOpts {
  /** The task prompt to send to the agent. */
  prompt: string;
  /** Optional JSON schema for structured output（引擎按 capabilities.schemaEnforcement 分流）。 */
  schema?: Record<string, unknown>;
  /** Thinking level override（"high" | "medium" | "low" 等引擎自解释词表）。 */
  thinkingLevel?: string;
  /** Scene name passed through for model-selection hints. */
  scene?: string;
  /** Turn 上限（turn limiter）。未传或 <=0 = 不限。 */
  maxTurns?: number;
  /** Turn limiter 宽限轮数：超 maxTurns 后允许继续的轮数。 */
  graceTurns?: number;
  /** Skill name to load（引擎解析为 SKILL.md 注入）。 */
  skill?: string;
  /** Resolved absolute path to the skill directory or SKILL.md file. */
  skillPath?: string;
  /** Human-readable description for logging and debugging（slug 源字段）。 */
  description?: string;
  /** Agent ref (absolute .md path)——身份解析锚点。 */
  agent?: string;
  /** System prompt injection CONTENT（非文件路径）。 */
  appendSystemPrompt?: string[];
  /** Inherit parent session context (fork mode)。与 worktree（文件隔离）独立。 */
  fork?: boolean;
  /**
   * [v1.x 增量] fork-from 显式分叉源 session 文件绝对路径（断联 subagent 接续场景，
   * 宿主点名任意已有 session 文件；fork=true 则由引擎用主 session 作源，两者互斥——
   * 本字段存在时优先）。字段名对齐引擎侧既有 SpawnRunParams.forkSource（pi 引擎经
   * `--fork <path>` 消费）。可选增量、负向兼容：无此概念的引擎（zcode）按未知可选
   * 字段忽略，行为与不传一致；宿主能力门（capability-gate）仍按 steer/conversation
   * 通道族预检，不依赖引擎对本字段的支持声明。
   */
  forkSource?: string;
  /** Filesystem isolation: 新建 worktree | 复用外部已创建 worktree | 不隔离。 */
  worktree?: boolean | WorktreeHandle;
  /** 空闲超时毫秒数（[modeless] 全体 record 的 idle 回收节奏；显式 0/负 = 禁用 idle GC）。 */
  idleTimeoutMs?: number;
  /** 工具 denylist（各引擎做语法映射）。 */
  denyTools?: string[];
  /** 中立权限模式（映射按各引擎 capabilities.permissionMode）。 */
  permissionMode?: string;
}

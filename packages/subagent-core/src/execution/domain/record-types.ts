// src/execution/domain/record-types.ts
//
// [§2.4 类型归位 第一批] record 域的**状态与身份词汇**（原定义在
// `execution/assembly/types.ts`，属「领域概念住在应用层目录」的错位）。
//
// 归位口径（登记 §2.4 已裁决）：类型若是「业务不变量与业务语言的载体、且不依赖任何
// 外部系统形状」→ 领域层；本文件这批全部满足——状态词表（ExecutionStatus /
// StopReason / ClosedReason / ExecutionOutcome / ProjectedOutcome / ExternalState /
// ExecutionMode / RecordOrigin）、身份与谱系值对象（Epoch / AbandonedRoundMark /
// TranscriptRef 族 / AliveMarker）及其配套的判定常量与 `ResurrectDeniedError`。
//
// 现状：`execution/assembly/types.ts` 不再 re-export 本文件——领域词汇的权威路径 =
// execution/domain/，消费面 import 直达本文件；record 聚合（ExecutionRecord）在同
// 目录 record-model.ts。
//
// 依赖方向：本文件零内部依赖（只用 TS 内置与 SDK 类型），不得 import assembly 或
// orchestration——这是「领域层在下」的构造性保证。

/**
 * 唯一执行状态（永久会话模型两态，设计 subagent-permanent-session-model.md
 * §3.2.1/§3.2.2；U2 两态转正，终态概念删除）：
 *   running = 本轮有任务在飞；idle = 无任务在飞，随时可接下一条 message。
 *
 * 「上一轮为什么停」由 {@link StopReason} 承载（纯展示 + 排障；U6 起 stopReason
 * 参与 isOccupied 占用判定——`running && stopReason === undefined`，W4 死亡纳管态
 * 靠它排除）；旧 running 的隐性子态（resumable/纳管态）由「idle + transcriptRef 在」统一表达。
 *
 * [U2 桥接不变量 → U5 后现状] 旧「closed 终态」读判据 = `idle && closedReason !==
 * undefined`（读侧兼容位）：写侧只剩 workflow D7 例外族与监督器放弃继续产出
 * （out-of-scope 维持现状）；收口动作（U5）走 markSettled 只写 stopReason 不写
 * closedReason（不终态化），close 收口落账走 markSettledOut（不动占用位）——
 * closedReason 不再由 cancel/close/编排性关闭产出。
 */
export type ExecutionStatus = "running" | "idle";

/**
 * record 来源身份（H2 W1，设计 subagent-workflow-record-unification §3.3 D1 建议新增）：
 *   "tool"     — 主 agent 经 subagent 工具手动派发（现状全部 record）；
 *   "workflow" — workflow 脚本内 agent() 调用派发（生产写入方 W2 executeWorkflowAgent 接线）。
 * 缺省语义 = "tool"：存量 record / 未传字段的 entry 反序列化产物一律视为手动派发，
 * 四个投影消费面（subagents tool list / renderer 侧栏计数 / renderer 后台工作指示 /
 * TUI /subagents）对缺省 record 的可见性与历史行为完全一致（零迁移）。
 */
export type RecordOrigin = "tool" | "workflow";

/**
 * 旧 closed 终态的 L2 关闭原因子枚举。
 *
 * [U2 桥接期地位 → W2/V3 后现状] 终态概念已删除（{@link ExecutionStatus} 两态），
 * 本枚举退役为**读侧兼容位**：值域完整并入 {@link StopReason}（旧 7 值 = 旧 closed
 * 的展示迁移）。写侧遗留终态原语（trySettleLegacyClosed / completeLegacyClosed——
 * workflow D7 例外族 + 监督器放弃两个生产者）继续写本字段 + stopReason 双写，
 * 消费方（deriveOutcome/notifier 等）零改动；本字段随读侧谓词 isLegacyClosedSettled
 * 一并在 W4 sunset 退役。
 *
 * 值语义（历史）：
 *   parent-shutdown  — 父进程 session_shutdown 时回收子进程
 *   parent-fork     — 父进程 fork 新 session 时清理旧子进程
 *   parent-new      — 父进程创建新 subagent 时清理旧子进程
 *   user-close      — 用户手动 close action（含对话模式 close）
 *   cancelled       — 用户取消（close(force:true) / cancelBackground）
 *   gc              — 通用完成/失败（一次执行自然结束、超时、错误等无专属 reason 的终态）
 *   disconnected    — 历史数据读面兜底（读 sidecar 空内容/损坏 → disconnected：正常结束
 *                     但死因不可考）。现行事件流 fold 与 binding 快照读面都不产该值
 *                     （「死因不可考」的现行兜底展示 = interrupted-by-restart）；值域
 *                     成员保留供磁盘/内存历史数据（sidecar 时代写入）的读面判定与
 *                     RECONNECTABLE 集合成员资格。
 */
export type ClosedReason = 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc' | 'disconnected';

/**
 * [v8.5 D] 透明重生守卫拒绝专用错误：messageHandler 的 endedMessageGuard 必须原样
 * 透传本类错误（自带完整行动语言），不得按 A1 分流规则改写——否则 worktree/异进程
 * 占用文案会被「fork-from 指引」覆盖，误导 agent 走已被判死的通道。
 */
export class ResurrectDeniedError extends Error {}

/**
 * ClosedReason 中 6 个可写终态原因（运行时守卫用——防御性解析外部输入时校验成员资格）。
 * disconnected 是历史数据读面兜底、现行链路无写点（sidecar 读面已退场），不在本清单；
 * StopReason 全枚举 = 本清单 + disconnected + NEW_STOP_REASONS + ROUND_TERMINAL_STOP_REASONS。
 */
export const CLOSED_REASONS: readonly ClosedReason[] = [
  'parent-shutdown',
  'parent-fork',
  'parent-new',
  'user-close',
  'cancelled',
  'gc',
];

/**
 * 终态三态对外语义（U3 C-outcome 一等披露）。
 *
 * [W2 D5 词表单源 → D2 实施期裁决]（workflow-run-resume-revision）：原
 * `Exclude<RunOutcome, "interrupted">` 派生别名取消——interrupted 已移出
 * RunOutcome，Exclude 失去意义。本域（execution/subagent-record）词表改为独立
 * 实体字面量、与 RunOutcome 解耦：设计 D2 只裁决了 run 域词表改名
 * （completed→done）与 call 级（run 域 agent-settled 帧）随改传导，未裁决
 * execution/subagent-record 域（Out of scope 射程外——本域 outcome 语义是 record
 * 终局形态，与 run 域 status/outcome 同词原则无涉），本域写入值保持不变。消费方
 * （project/list/notify 文案/渲染器）只读本字段，不再各自手写成败推导 switch。
 *
 * 由 completeLegacyClosed 唯一写入点按 deriveOutcome 一次计算（判定顺序：cancelled 优先
 * → error 非空 → completed）。
 *
 * [D6 显式取舍] parent-shutdown/parent-fork/parent-new 合成关闭（subagent-service
 * disposeAllRecords 合成 result 恒写 error:"closed due to ..."）落 "failed"——语义为
 * 「父进程关闭时子 agent 未完成即失败」，选定行为而非疏漏，勿当 bug 改回 cancelled。
 */
export type ExecutionOutcome = "completed" | "failed" | "cancelled";

/**
 * 对外投影的 outcome 联合：含历史 record（outcome 字段诞生前的存量数据）兼容态。
 * 投影层（projectOutcome 唯一出口）对无 outcome 字段的 closed record 按
 * deriveOutcome(closedReason, error) 兜底派生；"closed-legacy" 预留给连派生输入都
 * 不足以判读的存量形态，消费方必须处理该成员（不得因未知值崩溃）。
 */
export type ProjectedOutcome = ExecutionOutcome | "closed-legacy";

/**
 * 对外两态（永久会话模型 U2 迁移）：内部 ExecutionStatus 两态收敛为 agent 可理解的
 * 状态语义。映射只有两条：
 *   running → active / idle → idle（永久会话无 ended 形态——空闲即可续聊，不再有
 *   「已结束」；旧 closed→ended 映射随终态概念删除，idle 的「上一轮为什么停」经
 *   stopReason 披露）。
 * mapExternalState 不消费 StopReason——状态映射与停因展示正交。
 *
 * 原始 ExecutionStatus 进 list item 的 status 字段供调试；state 是对外主字段。
 * 映射实现见 subagent-actions-core.ts mapExternalState——未来内部加态必须扩展该处，
 * 漏加会在 default 分支编译报错，不影响对外契约。
 */
export type ExternalState = "active" | "idle";

/** 执行模式。background = 调用方立即拿 handle 返回，子 agent 在 detached promise 里跑。 */
export type ExecutionMode = "background";

/**
 * 展示维度（§3.2.1）：上一轮为什么停。值域 = 旧 ClosedReason 7 值沿用 + 4 个新展示值
 * + 2 个正常轮终展示值：
 *   interrupted              — 用户 cancel 中断当前轮（§3.2.5 cancel = 暂停这一轮）
 *   interrupted-by-restart   — 宿主重启中断（§3.2.2 host shutdown 行）
 *   interrupted-by-parent    — 编排性关闭打断在飞轮（宿主 session fork/new 自动收口）
 *   reopened                 — 锚失效带历史重开（§3.2.3 reopen 降级，epoch+1 的首轮）
 *   completed / failed       — [A-lite] 正常轮终展示位（markRoundIdle 成功/失败轮写入；
 *                              status 翻 idle——[two-state-convergence U4/D3] 翻边后
 *                              本值承担「上一轮为什么停」的展示 + `.state` 收条 reason
 *                              词；中断族走 markSettled interrupted 族不经 markRoundIdle，
 *                              与上 4 值无冲突）
 * 展示 + 排障（列表主展示用派生 outcome）+ [U6] 占用资格判定（isOccupied =
 * `running && stopReason === undefined`——W4 死亡纳管态据此排除，见下方字段注释）；
 * 复活资格判据仍是物理三件套（§3.2.3）。在飞期本字段被轮始清点族清空
 *（markRoundStarted / revive 格，[U6/D4]）——「stopReason 不参与任何资格判定」的
 * 旧裁决随 two-state-convergence U6 退役。
 */
export type StopReason =
  | ClosedReason
  | "interrupted"
  | "interrupted-by-restart"
  | "interrupted-by-parent"
  | "reopened"
  | "completed"
  | "failed";

/** StopReason 的 4 个新展示值（运行时守卫与枚举完整性测试锚；值域见类型注释）。 */
export const NEW_STOP_REASONS = [
  "interrupted",
  "interrupted-by-restart",
  "interrupted-by-parent",
  "reopened",
] as const satisfies readonly StopReason[];

/** [A-lite] 正常轮终展示值（markRoundIdle 成功/失败轮写入；值域见 StopReason 注释）。 */
export const ROUND_TERMINAL_STOP_REASONS = ["completed", "failed"] as const satisfies readonly StopReason[];

/**
 * StopReason 全枚举（运行时守卫用——防御性解析外部输入时校验成员资格）。
 * = CLOSED_REASONS（6 个可写终态原因）+ disconnected（读侧兜底产出，不写入，
 * 见 CLOSED_REASONS 注释）+ NEW_STOP_REASONS（4 新展示值）+
 * ROUND_TERMINAL_STOP_REASONS（2 正常轮终展示值），共 13 值。
 * 完整性由 permanent-session-types.test.ts 断言（值数 + 成员逐一）。
 */
export const STOP_REASONS: readonly StopReason[] = [
  ...CLOSED_REASONS,
  "disconnected",
  ...NEW_STOP_REASONS,
  ...ROUND_TERMINAL_STOP_REASONS,
];

/**
 * 世代计数（§3.2.3 epoch 防撞）：常态 0（undefined 同义），reopen（带历史重开）+1。
 * 单调递增依赖跨重启持久化（随 `.record-binding` 落盘，丢 epoch 会被二次 reopen
 * 击穿）。消费点：通知账本 notifyId 从 `id:round` 扩为 `id:epoch:round`（epoch=0
 * 保持旧格式，磁盘账本零迁移）；迟到回注 gate 第一步的世代比较基准。
 */
export type Epoch = number;

/**
 * 放弃轮标记（§3.2.7 通知 gate ②判据，单槽）：abort（用户 cancel / 编排性关闭
 * 打断）时置为在飞轮 {epoch, round}；reopen（epoch+1）后残留标记自然失效（跨
 * epoch 丢弃是去重语义的正确执行）。迟到回注判定**显式两步**（比较基准 =
 * record 当前 epoch，非标记槽 epoch）：①回注 epoch ≠ record 当前 epoch → 丢弃；
 * ②同 epoch 且回注轮 ≤ 标记轮 → 丢弃；否则放行。
 */
export interface AbandonedRoundMark { // oe-exempt:20260930:framework:领域值对象——record 轮次弃置标记（§2.4 归位搬迁，非新增抽象）
  readonly epoch: Epoch;
  readonly round: number;
}

/** pi 引擎锚：子 session jsonl 文件（口径与 ExecutionRecord.sessionFile 一致）。 */
export interface PiTranscriptRef { // oe-exempt:20260930:framework:领域值对象——pi 会话谱系引用（§2.4 归位搬迁，非新增抽象）
  readonly engine: "pi";
  readonly sessionFile: string;
}

/** zcode 引擎锚：隔离会话库条目（sessionId + dbPath 二元组，§3.2.6）。 */
export interface ZcodeTranscriptRef { // oe-exempt:20260930:framework:领域值对象——zcode 会话谱系引用（§2.4 归位搬迁，非新增抽象）
  readonly engine: "zcode";
  readonly sessionId: string;
  readonly dbPath: string;
}

/**
 * 对话记录指针（§3.2.6 引擎中立锚，判别联合以 engine 字段判别）：会话历史的物理
 * 定位。与 SDK 协议层 EngineHandleData.sessionRef 是同一概念的两层投影——传输层
 * 弱类型 Record<string,string>，领域层强类型判别联合。锚的可解析性表达资源维度
 * （在 / 被回收），无独立字段；失效时 message 走 reopen 降级（§3.2.3）。
 */
export type TranscriptRef = PiTranscriptRef | ZcodeTranscriptRef;

/** alive marker：跨进程写权声明载体（写者 = 宿主进程；acquire/release 见
 *  alive-store 模块头；startedAt 仅载体字段，判活不消费——pid 单判据）。 */
export interface AliveMarker { // oe-exempt:20260930:framework:领域值对象——record 存活标记（§2.4 归位搬迁，非新增抽象）
  readonly pid: number;
  readonly id: string;
  readonly startedAt: number;
}

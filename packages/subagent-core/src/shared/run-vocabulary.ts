// src/shared/run-vocabulary.ts
//
// [D1 拆边 Class A] run 域**词汇常量与词表**的最低层声明处（execution 与 orchestration
// 双向可 import，不产生反向边）。
//
// 为什么下沉：这些名字原先定义在 `orchestration/run-events.ts` 与
// `orchestration/models/types.ts`，但消费方大量在 `execution/`（manifest-store /
// state-marker / run-state-evidence / pi-host-run-store / session-file-gc /
// workflow-dispatch / subagent-actions-core）——「持久化层读编排层的词汇」构成
// execution → orchestration 反向边。词汇本身是纯数据（无编排行为），下沉到 shared
// 直接消边，零语义变更。
//
// 归位边界：本文件只放**词表与常量**；`DoneReason → RunOutcome` 映射、`RunErrorCode`
// 判定谓词、事件 fold 等**行为**仍归 orchestration（它们要读 run 状态机语义）。
import type { AgentFailureKind, EngineProtocolErrorCode } from "@zhushanwen/subagent-engine-sdk";

/**
 * run 终局形态词表（四值，[D2] 词表变更登记后的形态——workflow-run-resume-revision）。
 *
 * 与 DoneReason（completed/failed/aborted/budget_limited/time_limited，五因单
 * 维度）的关系：outcome 是终态正交化后的「run 自身怎么死的」维度（harness 系统
 * 层）——脚本判定失败（review-failure）= outcome:done + 脚本返回失败结论（业务
 * 层），两者处置路径不同（前者人工聚合报告，后者修环境重跑），必须分维度表达。
 * aborted 在本词表命名为 cancelled（对齐 D5 词表；DoneReason 存量词表不动，映射
 * 归 journal 写入方实现）。
 *
 * [D2] 词表变更登记（现行四值与重构前四值的差异，逐条显式登记）：
 * 1. **completed → done 改名**：与 shared `WorkflowRunStatus` 终局值 'done' 统一
 *    字面量——status 域与 outcome 域的成功/终局值同词，投影链无需两套叫法；
 * 2. **interrupted 移出 outcome（入 lifecycle 暂停态）**：「终局了却又没死透」的
 *    概念矛盾消除——中断 = run-interrupted 转移事件（running/settling →
 *    interrupted），可经 run-resumed 复活，非终局；
 * 3. **time_limited 从 RunErrorCode 成员升格为 outcome 值**：超时终局从
 *    「failed 终局 + errorCode=time_limited 细分」升为独立 outcome；RunErrorCode
 *    词表中 time_limited 成员保留为历史帧解析（解析词表纪律），新写入方不再
 *    产出该 errorCode；
 * 4. **call 级（agent-settled 载荷）随共用类型重构随改不拆分**：本类型为
 *    run-settled 与 agent-settled 共用——call 级实际值域 = done/failed/cancelled
 *    三值（time_limited 为 run 级终局、interrupted 已移出 outcome——均不出现在
 *    call 帧，沿用「ask 级实装取值 = result.failureKind 映射」的值域边界纪律）。
 *
 * 值域跟随锚：shared `WorkflowRunOutcome`（投影派生输出口径的第三份字面量，
 * core↔shared 依赖方向不允许物理单源）经 runtime 侧双包值级等价断言钉住
 * （core ALL_RUN_OUTCOMES ≡ extractor 集合 ≡ shared 词表成员，runtime 单测）。
 */
export const ALL_RUN_OUTCOMES = [
  "done",
  "failed",
  "cancelled",
  "time_limited",
] as const;
/** run 终局形态（run-settled 与 agent-settled 共用——agent 粒度的 cancelled = run 中止连带在途 agent 终止；call 级实际值域 = done/failed/cancelled 三值）。 */
export type RunOutcome = (typeof ALL_RUN_OUTCOMES)[number];
/**
 * 终局/中断错误码：「怎么死的」（终局）与「为什么此刻被中断」（中断）的结构化编码。
 *
 * 词表复用两族既有实装，不造新词（D5-1）：
 * - 引擎错误码：SDK 协议固定词表（engine_crashed 等 9 个）+ 引擎自报透传面
 *   （engine_ 前缀、core 不解释文案的 passthrough 契约）。显式并列
 *   EngineProtocolErrorCode 而非只留模板面——固定词表是该 union 的权威枚举源，
 *   SDK 侧词表演进（含非 engine_ 前缀的新码）自动跟进；
 * - 失败分类：AgentFailureKind（stale_context / schema_deterministic / unknown，
 *   产出侧 classifyFailureKind 词表，经 orchestration/models/types.ts re-export）。
 *
 * unknown 是合法成员：分类不出来的失败照记事件（词表漂移的失效模式 = 保守
 * 可诊断，不是拒记）。
 *
 * budget_limited 是 run 级终局码（dispatchFinalRunSettle 生产：DoneReason 同名
 * 字面量恒等映射）——不描述引擎/agent 怎么失败，描述「为什么此刻被判终局」
 * （harness 系统层裁决）。不复用既有族的依据：engine_ 前缀有「引擎自报」契约
 * （SDK error-codes.ts 透传面，预算耗尽是宿主侧裁决非引擎上报，借用即伪造自
 * 报）；AgentFailureKind 是 agent 级失败分诊三态（预算耗尽不是 agent 失败形态）。
 *
 * [D2] time_limited 保留为历史帧解析成员：升格为 RunOutcome 独立值后，新写入方
 * 不再产出该 errorCode（超时终局直写 outcome=time_limited、无码），存量帧携带
 * 该值的解析按词表成员纪律放行（解析词表而非「现存写入方」登记，删值破坏历史
 * 帧解析——同 idle-evicted 纪律）。
 *
 * [D2] run-interrupted 帧的细分语境成员（中断来源标记，非终局码——中断是转移
 * 事件非终局帧，errorCode 字段承载来源）：
 * - `crashed`：崩溃收编（recoverCrashedRuns 装配，D15 入口接线）——进程死亡后
 *   壳侧重启对遗留 running run 的中断转移；
 * - `terminated`：terminate 被动失联（session 切换/关闭；D11 对 resume 来源 run
 *   的分叉在 U2 接线，词表成员随本批先行登记——「新增成员先改设计载荷表再动
 *   词表」纪律，设计 §3.1 事件表 run-interrupted 行已登记两成员）；
 * - `startup-sweep`：runtime 启动扫描收编（现行成员复用——设计 §3.1 事件表
 *   明示「startup-sweep 为 RunErrorCode 现行成员复用」；u1b 波改经 D15 入口后
 *   成为 run-interrupted 帧的写入方）。
 *
 * interrupted_abandoned / idle-evicted 同族保留（解析词表纪律）：历史写入方
 * （abandon 7 天窗终局化 / 30 天内存回收机制）已随 [D9] 与 ADR-0081 退役归零，
 * append-only record 流的存量帧携带该值，删值破坏历史帧解析——成员保留，
 * 无新写入方。
 */
export type RunErrorCode =
  | EngineProtocolErrorCode
  | `engine_${string}`
  | AgentFailureKind
  | "budget_limited"
  | "time_limited"
  | "interrupted_abandoned"
  | "startup-sweep"
  | "idle-evicted"
  | "crashed"
  | "terminated";
/**
 * run record 事件流文件名尾段（`<runId>.record.jsonl` 的 `.record.jsonl`）。
 *
 * [D1] record 单源存储收敛改名（`.events.jsonl` → `.record.jsonl`）：record 流是
 * run 域唯一事实源（append-only），文件名换新后缀使旧格式两件套（旧 journal
 * `.events.jsonl` + state 快照 `<runId>.jsonl`）与新流在文件名层面天然可分——
 * 全部读取路径只认本后缀（旧两件不读、不写、不主动删，历史 run 从壳侧读取面
 * 消失即 D1 历史数据处置的预期行为）。
 *
 * 单源导出（barrel 上收）：core 内部全部落/扫点（本文件 journalPath、
 * run-state-evidence / run-registry 的成对裁剪与扫描）+ 壳侧镜像消费点
 * （终局通知的 eventsJournalPath、record store 的流路径构造）统一 import 本
 * 常量——后缀字面量散布多处时任何一侧单独改动都是静默漂移（watcher 失配 /
 * 指针失效）。
 *
 * 已知范围外同值副本：session-reader 包（跨包无 core 依赖边，物理单源结构性
 * 不可行——与 D5 core↔shared 同款约束）本地持有旧值常量，其发现链重锚随宿主
 * 读侧适配批（D16 ③）同批落地。
 */
export const RUN_EVENT_JOURNAL_SUFFIX = ".record.jsonl";
/**
 * slug 最大长度（D6 合流迁入本文件，原权威定义在已删除的 execution/execute-options-mapper.ts）。
 * 历史值 20 偏紧——描述性 slug 如 "audit-structured-output"（23）/ "fix-subagent-wf-tools"（21）
 * 会撞上限，放宽到 35 兼顾「短到能塞进 TUI 标题行」与「容纳合理描述性 kebab-case 名」。
 * 放本文件的原因：约束对象是 AgentCallOpts.description（slug 的源字段，见下方 slug 派生说明），
 * 与字段同文件；subagent-actions-core（slug 校验）、subagent-service（record slug 截断）
 * 与壳侧 tool schema maxLength 共享引用。
 */
export const SLUG_MAX_LENGTH = 35;

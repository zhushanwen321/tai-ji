/**
 * Workflow Extension — Engine Ports + 编排层共享类型
 *
 * 3 个注入 Port（AgentRunner / RunStore / WorkerHost）——Engine 定义、Infra 实现，
 * 是真需要 mock 测试的依赖（子进程/文件系统/线程）。
 *
 * 编排层共享类型（WorkerHandlers / LifecycleDeps）——打破 lifecycle ↔
 * worker-message-pump 循环依赖：2 个 engine 函数文件各自独立，共用同一组
 * 依赖签名（D-12）。
 *
 * 层归属：Engine。零 infra 依赖（反向边由包级值依赖环检查拦截）。
 */
import type { AgentStreamSink } from "../../shared/agent-stream.ts";
import type { AgentEvent } from "../../shared/agent-event.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import type { RunSpec } from "./run-spec.ts";
import type { AgentCallOpts, AgentResult } from "./types.ts";
import type { WorkflowRun } from "./workflow-run.ts";

// ── Port 1: AgentRunner ───────────────────────────────────────

/**
 * Agent 子进程执行 port。Infra 实现：SubprocessAgentRunner。
 *
 * run 执行单次 agent 调用（委托 SubagentService.executeWorkflowAgent，[H2 W4] 纯转调），
 * 返回结构化结果。signal 用于 abort 传播。
 *
 * onEvent（可选）：强类型 AgentEvent 回调，透传 service 派发路径（journal 转发/守护
 * 刷新源），生产 pump 侧恒 undefined。
 *
 * D-005: onEvent 签名从 raw Record<string,unknown> 升级为 AgentEvent——委托后不再有
 * raw JSONL 中间层（executeAndAwait 直接出 AgentEvent）。
 */
export interface AgentRunner {
  run(opts: AgentCallOpts, signal: AbortSignal, onEvent?: (event: AgentEvent) => void, stream?: AgentStreamSink): Promise<AgentResult>;
}

// ── Port 2: RunStore ──────────────────────────────────────────

/**
 * WorkflowRun 持久化 port（写侧语义）。生产唯一实现 = pi 壳 JsonlRunStore
 * （session 锚定；core 侧通用文件写实现已随写身份退役删除）。
 *
 * save = 显式 no-op（state 快照已删，唯一事实源 = record 事件流，ADR-0082 D1；
 * 接口保留为 port 契约）；loadAll 在 session_start 折叠 record 流重建 run 聚合。
 * stateFilePath 返回 run record 流文件的绝对路径（供 overlay/GUI 暴露给用户）。
 *
 * 读侧职责不经本 port：终局证据判定核与保留期维护位于
 * execution/persistence/run-state-evidence.ts（journal/manifest 事实源直读，
 * 对账 sweep 与启动扫描枚举共用同一份判据）。
 */
export interface RunStore {
  save(run: WorkflowRun): Promise<void>;
  loadAll(): Promise<WorkflowRun[]>;
  /** 返回 run record 流文件的绝对路径：<sessionDir>/workflow-state/<runId>.record.jsonl（供 overlay/GUI 暴露） */
  stateFilePath(runId: string): string;
}

// ── Port 3: WorkerHost ────────────────────────────────────────

/**
 * Worker 线程启动 port。Infra 实现：WorkerHostImpl。
 *
 * start 创建一个 Worker thread 运行 workflow 脚本，返回 WorkerHandle。
 * handlers 绑定 message/error/exit 回调（见 WorkerHandlers）。
 */
export interface WorkerHost {
  start(
    spec: RunSpec,
    args: Record<string, unknown>,
    handlers: WorkerHandlers,
  ): WorkerHandle;
}

// ── 编排层共享类型 1: WorkerHandlers ───────────────────────────

/**
 * Worker 线程事件回调集合——WorkerHost.start 的入参，由 lifecycle
 * 构造并注入。2 个 engine 文件（lifecycle / worker-message-pump）共用此签名，
 * 避免各自定义形状不一致的 handler bag（打破循环依赖）。
 *
 * 所有回调返回 Promise——允许 engine 层在回调内做 await 终局编排等异步操作
 *（record 事件流落账；store.save 现为 no-op 契约保留，见 Port 2）。
 */
export interface WorkerHandlers {
 /** Worker → Main 的业务消息（agent-call / return / error / log）。 */
  onMessage(raw: unknown): Promise<void>;
 /** Worker 线程 uncaught error。 */
  onError(err: Error): Promise<void>;
 /** Worker 线程 exit（含 code，用于区分正常退出 vs 崩溃）。handle 用于竞态防护 G-025。 */
  onExit(code: number, handle: WorkerHandle): Promise<void>;
}

// ── 编排层共享类型 2: LifecycleDeps ────────────────────────────

/**
 * lifecycle / worker-message-pump 2 个 engine 函数文件的共同依赖 bag。
 *
 * 取代旧 4 个 Context factory（errorHandlerContext / agentCallContext /
 * budgetCallbacks / 旧 terminate bag，AC-2 目标）。函数签名 `(deps: LifecycleDeps, ...)`
 * 让每个 free function 自包含依赖，无需 God Facade 中介。
 *
 * - store: 持久化（RunStore port）
 * - workerHost: 启动 worker（WorkerHost port）
 * - runner: 执行 agent（AgentRunner port）
 * - runs: 内存中的活动 run 聚合根索引（runId → WorkflowRun），替代旧 6 张并行 map
 * - onRunDone?: run 到达 done 终态时的回调（C-4 修复，可选）。由 Interface 层
 * factory 注入（notifyDone —— 唤醒 parent agent 消费结果）。Engine 层不依赖
 * Pi SDK，通过 callback 把完成信号外推到 Interface 层。所有终局路径
 * （handleReturn / handleWorkerError / handleScriptError / abortRun /
 * dispatchAgentCall budget 终止）在终局编排后触发本回调（record 事件流落账；
 * store.save 为 no-op 契约保留，不承担持久化）。
 */
export interface LifecycleDeps {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRun>;
 /** run 到达 done 终态时的回调（C-4 修复，可选）。Interface 层注入 notifyDone。 */
  onRunDone?: (run: WorkflowRun) => void;
 /**
 * 跨扩展事件总线（pending-notifications register 信号灯）。
 *
 * runWorkflow 启动时 emit pending:register，经本端口（Engine 不直接依赖 Pi SDK）。
 * 可选——无 pending-notifications 扩展时 no-op（向后兼容）。
 *
 * [reload-closeout D4] 终局路径的 pending:unregister 持久化不走
 * 本端口（emit→内存 listener 是易失跳：reload 转换窗/多 extension factory 顺序窗
 * 内丢失即注销 entry 永缺位）——finalizeRun 改经下方 appendEntry 直落权威面。
 */
  eventBus?: { emit(channel: string, data: unknown): void };
 /**
 * [reload-closeout D4] pending entry 权威落盘面（pi.appendEntry 的调用时解析注入）。
 *
 * finalizeRun 的 pending:unregister 持久化直走本面落盘（session JSONL 是唯一权威，
 * 不经 eventBus emit→listener 易失跳）。注入实现须在函数体内现读当前 pi（生产装配
 * workflow-events makeDeps：resolveCurrentPi().appendEntry）——与 log/onRunDone
 * 同款 volatile 形态，在飞 pump 持有的旧 deps 对象自动路由到新 pi。entry 写法与
 * status 映射归消费点（finalizeRun）单点定义，本成员只承载写通道。
 *
 * 可选——未注入时（旧测试 deps）finalizeRun 跳过直落（向后兼容；生产装配恒注入，
 * 漏注入由 reconcile-sweep 下次 session_start 兜底）。
 */
  appendEntry?: (customType: string, data: unknown) => void;
 /**
 * 调试日志端口（Engine 不直接依赖 Pi SDK）。Interface 层注入实现。
 * 关键路径记录 run 启动、保存、pending 注册/注销，便于排查异步操作状态。
 */
  log?: (level: "debug" | "info" | "warn" | "error", component: string, message: string, data?: unknown) => void;
 /**
 * D-12 regression fix (round-2 #2)：rebuildRuntime 重新调度 run 级墙钟预算计时器。
 *
 * [HISTORICAL] worker/script 错误重试（replaceRuntime）已删（ADR-0122）；release 会 clearTimeout
 * 旧计时器（run-runtime.release）。新 runtime 必须重排 scheduleTimeBudget，否则带
 * budgetTimeMs 的 run 命中一次错误重试后时间预算静默失效（直到下次 pause/resume 才重排）。
 * 由 Interface 层 factory 注入——闭包捕获 deps，内部调 lifecycle.scheduleTimeBudget。
 *
 * 可选——旧测试 deps 不注入时 rebuildRuntime 不重排计时器（兼容，不影响无时间预算的 run）。
 */
  scheduleTimeBudget?: (
    runId: string,
    budgetTimeMs: number,
  ) => ReturnType<typeof setTimeout> | undefined;
 /**
  * [H2 W3] workflow 域 agent() 统一派发入口（SubagentService.executeWorkflowAgent 的
  * deps 注入形态，设计 §3.5 终态数据流）。窄函数类型——不引 execution 层具体类，
  * 保持本 ports 文件零 infra/execution 依赖。由组合根（extension index.ts makeDeps）
  * 注入：闭包捕获 getSubagentService() 单例，parentRunId 由 pump 侧补 run.runId。
  *
  * 可选——未注入时（旧测试 deps）dispatchAgentCall 回退 deps.runner（[H2 W4] 后
  * SAR 已掏空为纯转调 executeWorkflowAgent，两分支执行体归一非双轨，差异仅 parentRunId
  * 来源：注入 = 真实 run.runId，回退 = SAR_UNATTACHED_PARENT_RUN_ID 占位；生产装配
  * 两字段同时注入，dispatch 恒优先）。
  *
  * [W0 / D1] stepIndex（可选尾参）：origin="workflow" 时在 run 内的步骤索引，
  * pump dispatch 处以 msg.callId 单源传入（taskIndex 同源），随 originFields 进
  * record——run 视图按 (parentRunId, stepIndex) 关联 record 的关联键之一。显式
  * 参数而非 opts 成员：opts 是 worker 脚本的 API 面，内部键不污染脚本契约。
  */
  workflowAgentDispatch?: (
    opts: AgentCallOpts,
    parentRunId: string,
    signal?: AbortSignal,
    stepIndex?: number,
  ) => Promise<AgentResult>;
 /**
 * [F1-18 修复] resume 显式 model 落账后的宿主投影同步回调。
 *
 * journal model-override 帧落盘只是持久化半边——宿主侧还有两个派生投影（覆盖记账
 * 内存表 + workflow 域覆盖重建负缓存），不同步则进程存活期内重派被旧投影遮蔽
 * （内存表旧覆盖值内存命中 / 负缓存「已扫无覆盖」stale 登记短路 journal 重扫），
 * resume 的模型意图静默丢失。resume 写点（resume-run appendResumeModelOverride）
 * 落账成功后经本回调同步；宿主实现（extension makeDeps → SubagentService.
 * applyRunOverrideProjection）与既有 setModel 写点的「落账 + 内存表」双写形态对齐。
 *
 * 可选——未注入时（旧测试 deps）跳过投影（向后兼容，行为同修复前）；生产装配恒注入。
 * 载荷为结构类型（journal 帧拆装结果），不引 execution 域类型——本 ports 文件
 * 零 infra/execution 依赖纪律。
 */
  onResumeModelOverrideCommitted?: (
    runId: string,
    override: RunOverrideProjection,
  ) => void;
 /**
  * [dmg-r2-5] 宿主会话锚现读口（run-created 帧 rootSessionId 的唯一载荷源）。
  *
  * 引擎层不持会话身份（WorkflowRun 聚合 / RunSpec 均无会话域），归属锚只能由
  * 壳侧注入：实现 = 组合根 makeDeps 注入（sessionRootId 根进程语义与 record 域
  * rootSessionId 同源——根进程 = 本 session id，嵌套 = env 贯穿的真 ROOT）。
  * 消费点 = lifecycle.runWorkflow → dispatchRunCreated 条件式落帧（值 null/空不落
  * 字段）。runtime 网关（subagent-model-gateway）runId 分支读该字段做同 cwd 多
  * 会话的宿主精确路由——不注入时帧缺字段，读侧回落既有存在性判定（旧格式行放行）。
  *
  * 可选——未注入时（旧测试 deps）run-created 帧不落该字段（行为同修复前）。
  */
  getSessionRootId?: () => string | null;
}

/**
 * [F1-18 修复] resume 显式 model 落账帧的拆装结果（投影回调载荷）。
 * 与 orchestration model-override 帧的 model/thinkingLevel/ts 字段同构。
 */
export interface RunOverrideProjection {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  ts: number;
}

/**
 * @zhushanwen/subagent-core — 公共 API barrel（D5 定稿 + post-convergence B-2 扩面）
 *
 * 公共 API 面 = 本文件导出 + package.json exports 的语义子入口
 * （./engine/paths、./engine/engine-discovery-scan、./relay-env——[W11/H3] 引擎
 * 子入口 ./engines/zcode/* 已随内建引擎删除）+ ./workflows/* 资产子入口。exports 面即 semver 契约（D5）：收窄不放宽——
 * 新增导出走 minor，本文件刻意不使用 `export *`，逐名列出以使 diff 可审。
 * 内部实现细节（error-recovery / execute-agent-call / worker-script-builder 等
 * engine 编排件）不经 barrel 导出；host-surface 扩面（zsw 回接 U0，2026-08-30）
 * 后 port 的 Infra 实现与宿主组装件已列入公共面。
 *
 * 扩面判定标准（post-convergence D3）：壳非测试代码实际消费 ≥1 处即进 barrel——
 * 契约面 = 壳的实际消费面，core 内部移动/重命名文件不再是对壳的隐性 breaking。
 * 未进 barrel 的内部实现细节仍不经此导出；`./*` -> src 开发态通配已随 u-2a/u-2b
 * 从 package.json 删除，深路径归一由消费侧单元（u-2b/u-2c）收口，barrel 是公共
 * 消费终点。
 *
 * 设计权威源：docs/design/subagent-core-package-extraction.md §3.3 D5；
 * docs/design/subagent-post-convergence-architecture.md §3.2 B-2 / §3.6 D3/D8/D9；
 * docs/design/subagent-core-sink-design.md（sink 下沉收口扩面，2026-08-31）；
 * 宿主接入示例见包 README（§3.4 core_host_not_configured 恢复指引的落点）。
 */

// 0.4.0 = 首个公开发布的收敛收口面（0.3.0 为 2026-08-30 裁决的跳号占位，永不单独
// 发布；+ minor changeset 收口面落本号）；与 package.json version 的一致性由
// src/__tests__/smoke.test.ts 动态守护，改版本须两处同步。
export const CORE_PACKAGE_VERSION = "0.8.0";

// ── 宿主端口接线面（core/）────────────────────────────────────
// HostServices：dataRoot / log / discoveryRoots 端口 + configureCore 注入；
// 未 configureCore 即消费 dataRoot 抛 core_host_not_configured（§3.4 错误规格，
// 恢复指引指向 README 接入示例）。DEFAULT_DATA_ROOT 显式导出供宿主选用——
// 消除「缺省静默漂目录」。getHostServices：core 内统一取用点，宿主 injector
// 消费（resource-list-injector）。
export {
  configureCore,
  getHostServices,
  DEFAULT_DATA_ROOT,
  type DiscoveryRoot,
  type HostServices,
} from "./core/host-services.ts";

// getLogger：facade 代理 logger——每次 log 调用时动态解析当前宿主实现，
// 模块顶层缓存惯例（`const logger = getLogger(...)`）下 configureCore 前后透明切换。
// LogLevel 是 HostServices.log 契约的成员类型（宿主实现必读）。
export { getLogger, type CoreLogger, type LogLevel } from "./core/logger.ts";

// NotifyDomainPorts：通知域窄端口（投递内核工厂 + pending 活跃计数），
// 两成员可选，缺席降级（投递直发 / pending 计零）。
export {
  configureNotifyDomain,
  type NotifyDomainPorts,
} from "./core/notify-ports.ts";

// ── 引擎契约面（execution/engine）────────────────────────────
// EnginePort：subagent 执行引擎的唯一契约点（run / interact / read / probe 四能力面）。
// types.ts：引擎中立类型（宿主与引擎适配器共同消费，宿主不感知具体引擎）。
export type {
  EnginePort,
  EngineRunResult,
  RunContext,
} from "./execution/engine/port.ts";
export type {
  AgentEvent,
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  EngineHandleData,
  ProbeReport,
  ReplayedTurn,
  SessionView,
} from "./execution/engine/types.ts";
// RunContext 的成员类型（ctxModel / stream）——类型闭包随 EnginePort 必然公开，
// 显式导出免宿主深路径兜圈；type-only（SubagentStream 是 execution 内部实现，禁 new）。
export type { ModelInfo } from "./execution/model-resolver.ts";
export type { SubagentStream } from "./execution/stream-sink.ts";

// routeEngine：三层路由（调用参数 > frontmatter > 全局默认）+ probe fallback 编排
// 的单一权威点（engine-abstraction D9/D7）。宿主按 error.code（engine_* 错误族）
// 判别失败形态，无需导入错误类。
export {
  routeEngine,
  type EngineRouteOptions,
  type EngineRouteResult,
  type EngineRouting,
  type EngineRoutingInput,
  type EngineRoutingSource,
} from "./execution/engine/routing.ts";
// [W8 补扫接线面] setEngineDiscoveryRescanOptions：宿主登记 hasEngineWithRescan 的
// 补扫发现参数（与 session_start 发现扫描同源）；壳消费 = runtime
// subagent-engine-history 的 ensureRuntimeEngineWiring。
export { setEngineDiscoveryRescanOptions } from "./execution/engine/routing.ts";

// ── 引擎注册 / 发现与进程面（execution/engine）────────────────
// 组合根 index.ts 接线消费（registerXxx 引擎注册、syncEnginesFile engines 文件
// 同步、killAllSpawnedChildren session 派生进程兜底清理）。
export { syncEnginesFile } from "./execution/engine/engine-discovery.ts";
// [W11/DoD#5] registerPiEngine（inproc 'pi' 注册）已删；[W3 chat 域收口] chat 域 inproc
// 引擎（inproc pi 引擎目录）与 SubagentService 自持 DI 实例一并删除——registry 'pi' 由三级发现
// 装载 cli descriptor，chat 轮次与 run 域同路经协议客户端发往 pi-subagent-cli 引擎进程
// （G1：pi 引擎单一 CLI 形态，core 壳侧零内建引擎）。
// [W8 D8 薄壳] killAllSpawnedChildren：扩展 index.ts / zsw runner-core.js 的业务调用点
// 零改动。语义（[F-7 注释纠偏，如实口径]）= **仅镜像记账**——core 侧 spawnedChildren
// 镜像整体清空（engine/host/spawned-children.ts 公共面），不发任何进程信号；
// 子进程活在引擎进程内，其回收链 = ① stdin-EOF 自灭（宿主退出 / EngineClient 销毁
// → 引擎进程 stdin 断源自灭，正常路径）；② disposeEngines()（registry）显式触发全部
// 已实例化引擎 dispose（cli 形态 = RemoteEngine.dispose → EngineClient 有界收口）——
// 该入口为宿主 shutdown 链预留，现无生产接线。subagent-workflow 扩展的
// reapSpawnedChildrenOnShutdown（process hook 调本函数）因此同为镜像置死 no-op，
// 不构成真实收割（现状登记，workflow 包生产码不动）。
export { killAllSpawnedChildren } from "./execution/engine/host/spawned-children.ts";

// [W8 D8 兼容公共面薄壳]（设计 §3.6 D8 表）：registerZcodeEngine 确保cli descriptor
// 注册（vendored 相对定位，失败回退 inproc 过渡）+ engineDataDir 记入；createZcodeEngine
// 返回 RemoteEngine('zcode')（deps → 协议客户端映射，sources 不跨进程）。实现见
// execution/engine/d8-compat.ts——engines/zcode/registration.ts 的同名符号不再经
// barrel 导出（inproc 实现保留至 W11，仅内部测试/过渡消费）。
export {
  createZcodeEngine,
  registerZcodeEngine,
  type D8CompatZcodeEngineDeps,
} from "./execution/engine/d8-compat.ts";

// 在途事件出口（u7a，D5）：壳层（subagent-workflow host/inflight-reporter）注册
// 监听 + 求值绝对计数快照——core→壳回调出口的 barrel 消费面（exports 面收窄后
// 壳侧生产消费必须经 barrel，无深路径豁免）。
export {
  setInFlightListener,
  getInFlightSnapshot,
  type InFlightSnapshot,
  type InFlightListener,
} from "./execution/engine/inflight-snapshot.ts";
// W3 后内核宿主 = engine/host（host-bridge arm/disarm 委托点为在途迁移点），模块本体不经 engines/pi。
// maxTurnsToWatchdogMs 为 maxTurns→watchdog 毫秒换算（U3/U4 / D7，floor 语义
// 文档化——两宿主预算一致性 S2 的函数级锚点；[W3] 定义收敛在 pi-host-binding，
// 原 inproc session-runner（已删） 定义随删件消亡）；killRecordChildWithEscalation 为
// 单 record 子进程终止的镜像记账入口（[W3] 实际终止在引擎进程内经协议承载）。
export {
  killRecordChildWithEscalation,
} from "./execution/engine/host/spawned-children.ts";
export { maxTurnsToWatchdogMs } from "./execution/engine/host/pi-host-binding.ts";

// zcode 引擎注册面（[W8 D8 薄壳] createZcodeEngine 已上移 d8-compat——上方导出）。
// [W11 收口] ZcodeEngineDeps 与 D8CompatZcodeEngineDeps 合并为别名（zsw 调用面的
// deps 形状契约保持）；barrel 不导出引擎错误类（引擎错误归各引擎包自持）。
export type { ZcodeEngineDeps } from "./execution/engine/d8-compat.ts";

// 引擎注册表原语 + 引擎感知提示面：engine-awareness injector 消费。
export {
  DEFAULT_ENGINE_ID,
  normalizeEngineId,
} from "./execution/engine/registry.ts";
export {
  buildEngineModelsPromptAppend,
  buildSubagentEngineSection,
} from "./execution/engine/model-prompt.ts";

// session-view 归一符号（post-convergence D3）：runtime 读取侧 2 处深路径
// （subagent-extractor / subagent-engine-history）归一 barrel 的前置——不新增
// 子入口（D9：每条子入口 bundle 多一份 host-services 副本）。
export { parseEngineHandle } from "./execution/engine/common/session-view-types.ts";
export { readSubagentHistoryMessages } from "./execution/engine/common/session-view-service.ts";
// [W8] registerNativeSessionReader：runtime 成为协议客户端的①级接入点——宿主把
// 「协议 read」注册为引擎原生 reader，core 三级降级链（①协议 read → ②journal →
// ③outcome）自动编排（含投影），宿主零投影代码。壳消费 = runtime
// subagent-engine-history 的协议 reader 注册。
export { registerNativeSessionReader } from "./execution/engine/common/session-view-service.ts";

// ── 执行域（execution/）──────────────────────────────────────
// types.ts 领域类型族：record / 响应 / 列表项等 subagent 域公共契约（壳消费最高频面，
// tool 面 / interface 渲染层 / bg-notify 共同消费）。CLOSED_REASONS / DEFAULT_AGENT_NAME
// 为值常量，ResurrectDeniedError 为错误类（值 + 类型双形态）。
export {
  CLOSED_REASONS,
  DEFAULT_AGENT_NAME,
  ResurrectDeniedError,
} from "./execution/types.ts";
export type {
  AgentEventLogEntry,
  BgResponse,
  CancelResponse,
  CloseResponse,
  ClosedReason,
  DisplayItem,
  ExecutionMode,
  ExecutionOutcome,
  ExecutionRecord,
  ExecutionStatus,
  ExternalState,
  ForkFromResponse,
  ListResponse,
  MessageResponse,
  SubagentListItem,
  SubagentRecord,
  SubagentToolResult,
} from "./execution/types.ts";

// execution-record 投影函数族：record → 渲染态投影（outcome / elapsed / tool calls /
// live progress），interface 渲染层唯一消费入口。
export {
  computeElapsedSeconds,
  countAllToolCalls,
  deriveOutcome,
  getAllToolCalls,
  projectLiveProgress,
  projectOutcome,
} from "./execution/execution-record.ts";

// SubagentService 聚合面 + 进程单例访问器（post-convergence D8）：访问器经
// globalThis[Symbol.for] slot 防 jiti 多实例分裂，/resume /fork 复用既有实例
// （SR-3/SR-4 语义）。createSubagentService / SubagentServiceInit 为构造依赖参数
// 注入形态（modelService 等，无全局查找，@experimental U10 / D6）。
// [H3/R6] 单例访问器 + Init 接口外移支撑文件 service/service-bootstrap.ts，本
// barrel 直接改指向该文件（导出符号面不变；壳对 bootstrap 零 re-export——防壳↔
// bootstrap 值环，设计 v4 import 纪律）。对外消费方零感知。
export { SubagentService } from "./execution/subagent-service.ts";
export {
  getSubagentService,
  setSubagentService,
  createSubagentService,
  type SubagentServiceInit,
} from "./execution/service/service-bootstrap.ts";
// notifyGateAllowsDelivery：closedReason → 投递许可判定（通知门）——
// 投递内核与壳侧 notify 链的共同语义锚点（execution 生产域消费，A2a）。
export { notifyGateAllowsDelivery } from "./execution/subagent-service.ts";

// ModelConfigService 聚合面 + 单例访问器四件中的 model 侧两件（D8）；
// ModelConfigServiceInit 为 SubagentServiceInit.modelService 的构造依赖
// （MF-4：jsdoc 示例 `new ModelConfigService({cwd, agentDir})` 可构造）。
export {
  ModelConfigService,
  getModelConfigService,
  setModelConfigService,
  type ModelConfigServiceInit,
} from "./execution/model-config-service.ts";

// notify ledger：宿主通知账本端口（bind / getBound）——组合根装配 + workflow 域消费。
export {
  bindNotifyLedgerHost,
  getBoundNotifyLedger,
  type NotifyLedgerHost,
} from "./execution/notify-ledger.ts";

// identity 重建常量与类型：session_start identity custom entry 的写入侧契约。
export {
  IDENTITY_CUSTOM_TYPE,
  type SubagentIdentityData,
} from "./execution/session-reconstructor.ts";

// 执行域外围件（组合根 / interface 层直接消费的独立单点件）。
export { bestEffort } from "./execution/best-effort.ts";
// channel-registry 类型闭包（UiChannelRegistry / ChannelHandler）随值符号进 barrel
// （u-2b 主 agent 裁决 2026-09-03）：壳 index.ts 跨扩展 re-export surface 的非测试
// 生产消费，满足 D3 判定标准；type-only，零运行时面变化。
export {
  getOrCreateChannelRegistry,
  type UiChannelRegistry,
  type ChannelHandler,
} from "./execution/channel-registry-access.ts";
export { DialogGlobalQueue } from "./execution/dialog-queue.ts";
export {
  readGlobalConfig,
  type GlobalConfigReadResult,
} from "./execution/config.ts";
export { isResumable } from "./execution/lifecycle-predicates.ts";
export { maybeCleanupExpiredSessionFiles } from "./execution/session-file-gc.ts";
export { createUiRequestHandlerForMode } from "./execution/ui-request-handler-factory.ts";
export { WorktreeManager } from "./execution/worktree-manager.ts";
export { SubprocessAgentRunner } from "./execution/subprocess-agent-runner.ts";

// record 存储面：RecordStore 类 + 索引文件名常量（bench 扫描基准消费）；
// ChangeListener / RecordStorePi / StatusFilter 为状态查询面的类型闭包
//（@experimental U10 / D6：lookupRecordAnyState 全态查询等签名直接引用）。
export {
  RecordStore,
  type ChangeListener,
  type RecordStorePi,
  type StatusFilter,
} from "./execution/record-store.ts";
export { INDEX_FILENAME } from "./execution/sessions-index.ts";

// record 落盘 entry 契约：custom entry 写入侧（@experimental U10 / D6）。
export {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  toSubagentRecordEntry,
  type SubagentRecordEntryData,
} from "./execution/record-entry.ts";

// agent-registry 执行消费面：loadByPath 直接加载（@experimental U10 / D6）+
// parseAgentProfile 宽容解析（无 frontmatter 不拒、name 缺省 stem、返回 body 与
// 执行字段全量）——执行消费面单点；与严格注入投影（parseResourceMeta）双轨分离
// 的执行侧统一入口（U2 / D3）。
export { AgentRegistry } from "./execution/agent-registry.ts";
export {
  parseAgentProfile,
  type AgentProfile,
} from "./execution/agent-registry.ts";

// 错误类型族（error-recovery.ts 计划路径实测不存在，实测散布于下列源文件）：
// resurrect/fork-depth/dirty-worktree 为动作层守卫抛出点（types.ts），
// GitRunError 见 worktree 内核组裁决。
export {
  DirtyWorktreeError,
  ForkDepthExceededError,
} from "./execution/types.ts";

// 动作层领域内核（@experimental U10 / D6）：六 handler 的校验/守卫链/归属判定/
// 终态映射，产出领域对象，宿主 adapter 负责包装渲染。
export {
  BG_MESSAGE,
  cancelHandler,
  closeHandler,
  DEFAULT_LIST_LIMIT,
  endedMessageGuard,
  FORK_FROM_DEFAULT_PROMPT,
  forkFromHandler,
  listHandler,
  mapExternalState,
  MAX_LIST_LIMIT,
  messageHandler,
  NOTIFY_CONTRACT,
  recordToListItem,
  startHandler,
  wrapForkFromPrompt,
  type CancelHandlerInput,
  type CancelHandlerResult,
  type CloseHandlerInput,
  type CloseHandlerResult,
  type ForkFromHandlerInput,
  type ForkFromHandlerResult,
  type ListHandlerInput,
  type ListHandlerResult,
  type MessageHandlerInput,
  type MessageHandlerResult,
  type StartHandlerInput,
  type StartHandlerResult,
} from "./execution/subagent-actions-core.ts";

// 进程活性探针（watchdog/孤儿判定共用，agent-ref 契约原语组 U1）。
export { isProcessAlive } from "./execution/alive-store.ts";

// 并发池工厂（U3/U4 / D7）：queuePolicy 缺省 priority 保 pi 行为，zsw 消费
// strict-fifo——策略差异显式化而非双实现。
export {
  createConcurrencyPool,
  type ConcurrencyPool,
  type CreateConcurrencyPoolOptions,
  type QueuePolicy,
} from "./execution/concurrency-pool.ts";

// 模型引用切分原语（U1 契约面批件）：provider/model 引用切分与缺省值（两宿主
// maxTurns/model 换算同源）。[W11/H2] 实现体随 engines/zcode 删除迁至
// shared/zcode-model-ref.ts（宿主侧原语，与引擎包各自单源）。
export {
  DEFAULT_PROVIDER_ID,
  hasApiKey,
  splitZcodeModelRef,
  ZCODE_FALLBACK_DEFAULT_MODEL,
} from "./shared/zcode-model-ref.ts";

// ── worktree git 内核（U5 / D5）───────────────────────────────
// git 语义纯函数单源：保真读（gitRun）、SafeId 校验、dirty 谓词、
// collectWorktreePatch（统一 add+diff 基线机制，返回结构即 patchIncomplete
// 留痕载体）、三步容错清理、listWorktreePorcelain（原始输出供宿主 realpath
// 对账）。锚点缺失/损坏与 add 失败两条降级路径 warn + 留痕（⛔3）。
//
// GitRunError 同名双类裁决（u-core-exec-export 交接）：worktree-manager.ts 与
// worktree-git-ops.ts 各有一个 GitRunError（文案同但类独立）——barrel 只导出
// 本组 worktree-git-ops 版（git 语义新单源）；worktree-manager 版不进 barrel，
// 将来 manager 收缩到 git-ops 内核时随之消除。
export {
  assertSafeId,
  cleanupWorktree,
  collectWorktreePatch,
  GitRunError,
  gitRun,
  isSafeId,
  isTreeDirty,
  listWorktreePorcelain,
  SAFE_ID_RE,
  type CleanupWorktreeOptions,
  type CollectWorktreePatchOptions,
  type ListWorktreePorcelainOptions,
  type PatchBaselineAnchor,
  type WorktreePatchResult,
} from "./execution/worktree-git-ops.ts";

// 组装层（U2 装配）：discoverAgents 发现→宽容解析→去重→码点序（workflow 侧
// discoverWorkflows 对称面，第三宿主「列 agents」入口）。
export { discoverAgents } from "./execution/agents-assembly.ts";

// ── workflow 编排入口（orchestration）────────────────────────
// runWorkflow / abortRun：run 生命周期 free functions（D-12）——orchestration 的
// 最小宿主入口。更细粒度编排（terminateRunningRuns / evictDoneRunsBeyondCap /
// scheduleTimeBudget / 上限常量）为组合根实际消费面，随 B-2 扩面进 barrel
// （D3 判定标准首次执行）。host-surface 扩面（zsw 回接 U0）同出 barrel：宿主壳
// 组装 LifecycleDeps 需要亲手构造三个 port 实现与消费细粒度编排函数，深路径消费
// 在 npm 形态不可达（发布面无 `./*` 通配）——宿主触点证据即 zsw 回接设计 D2。
export { abortRun, runWorkflow } from "./orchestration/lifecycle.ts";
export {
  terminateRunningRuns,
  evictDoneRunsBeyondCap,
  scheduleTimeBudget,
  MAX_RETAINED_DONE_RUNS,
} from "./orchestration/lifecycle.ts";

// recoverCrashedRuns：崩溃恢复四步装配（宿主事件经 hooks 外置，U7 生命周期 / D8）。
export {
  recoverCrashedRuns,
  type RecoverCrashedRunsHooks,
  type RecoverCrashedRunsResult,
} from "./orchestration/lifecycle.ts";

// launcher 层：runAndWait / executeNestedWorkflow（workflow 域嵌套编排入口）
// + deps / 结果类型。
export {
  runAndWait,
  executeNestedWorkflow,
  type LauncherDeps,
  type WorkflowRunResult,
} from "./orchestration/launcher.ts";

// worker-message-pump 内核件（execution 生产域消费，A2a）：finalizeRun run 终态
// 收口 + FinalizeRunOptions 契约、closeOutInFlightCalls 在飞 call 批量清算、
// makeSerializeFailedResult 序列化失败结果构造、postBudgetUpdate 预算播报、
// resetRebuildFailureInjectionForTest 重建失败注入复位（测试面）。
export {
  finalizeRun,
  closeOutInFlightCalls,
  makeSerializeFailedResult,
  postBudgetUpdate,
  resetRebuildFailureInjectionForTest,
  type FinalizeRunOptions,
} from "./orchestration/worker-message-pump.ts";

// workflow 领域模型族：run / call / trace / budget / 状态与规格（壳 store 与
// interface 渲染层共同消费）。
export type { RunSpec } from "./orchestration/models/run-spec.ts";
export type { LifecycleDeps } from "./orchestration/models/ports.ts";
export type { RunStore } from "./orchestration/models/ports.ts";
// RunStore / AgentRunner / WorkerHost port 契约类型：宿主自写 Infra 实现（如 zsw
// 的 RunnerPort 桥接）需要契约面；WorkerHandlers 已随 WorkerHost 注释。
export type {
  AgentRunner,
  WorkerHandlers,
  WorkerHost,
} from "./orchestration/models/ports.ts";
export type { RunState } from "./orchestration/models/run-state.ts";
export { Trace } from "./orchestration/models/trace.ts";
export { AgentCall } from "./orchestration/models/agent-call.ts";
export { Budget } from "./orchestration/models/budget.ts";
export { WorkflowRun, type WorkflowRunMeta } from "./orchestration/models/workflow-run.ts";
export type {
  AgentCallOpts,
  AgentResult,
  DoneReason,
  ExecutionTraceNode,
  RunStatus,
  ToolCallEntry,
  WorkerLogEntry,
} from "./orchestration/models/types.ts";
// SLUG_MAX_LENGTH 单源（merge 收敛完成）：唯一定义在 orchestration/models/types.ts；
// 原 execution/execute-options-mapper.ts 重复定义已删（改 import 消费，深路径消费者
// subagent-actions-core 同步切到 models/types 单源）。
export { SLUG_MAX_LENGTH } from "./orchestration/models/types.ts";

// workflow 脚本资产面：registry 契约 + 实现 / 脚本 lint / 文件落盘（save / delete）
// + skill 路径缓存清理——组合根装配与 workflow 工具面消费。
export type { WorkflowScriptRegistry } from "./orchestration/models/workflow-script-registry.ts";
export { WorkflowScriptRegistryImpl } from "./orchestration/workflow-script-registry-impl.ts";
// WorkflowScript 实体与按路径加载工厂（第三宿主零复刻脚本加载，G3/S5）。
export {
  loadWorkflowScriptByPath,
  WorkflowScript,
} from "./orchestration/workflow-script-registry-impl.ts";
// lintScript：workflow 脚本静态检查（执行前 fail-fast，宿主 list/validate 面消费）。
export { lintScript } from "./orchestration/script-lint.ts";
export type { LintFinding, LintResult } from "./orchestration/script-lint.ts";
export { saveWorkflow, deleteWorkflow } from "./orchestration/workflow-files.ts";
export { clearSkillPathCache } from "./orchestration/skill-discovery.ts";
export { WorkerHostImpl } from "./orchestration/worker-host.ts";

// ── workflow 创作闭环面（orchestration/script-generate + workflow-files，W4）──
// generateWorkflowScript：generate 校验管线（五道闸 + @pi-meta round-trip + tmp
// 写盘）从 pi-sw 插件层下沉（D-6）——纯函数返回结构化结果（不 throw，pi 的
// isError 契约转换由宿主负责），报错文案逐字对齐 pi 现版（CA2 前提）。
// saveWorkflow/deleteWorkflow（上方已导出）+ 目录经 WorkflowDirOptions 注入
// （缺省 pi 布局 DEFAULT_WORKFLOW_TMP_DIR / DEFAULT_WORKFLOW_SAVED_DIR，向后兼容
// ——pi 现深路径调用形态行为不变，改接在 C5）。
export { generateWorkflowScript } from "./orchestration/script-generate.ts";
export type {
  GenerateWorkflowScriptOptions,
  GenerateWorkflowScriptResult,
} from "./orchestration/script-generate.ts";
export type { WorkflowDirOptions } from "./orchestration/workflow-files.ts";
// 缺省目录常量随面导出：宿主显式注入 pi 缺省布局时引用常量，避免字面硬编码回流。
export {
  DEFAULT_WORKFLOW_SAVED_DIR,
  DEFAULT_WORKFLOW_TMP_DIR,
} from "./orchestration/workflow-files.ts";

// workflow 发现/加载（ADR-031 统一资源发现）：宿主 list 面与 registry 构造消费；
// invalidateCache 供宿主在写脚本后主动失效 mtime 缓存。
export {
  discoverWorkflows,
  getWorkflow,
  getWorkflowByPath,
  invalidateCache,
  loadWorkflows,
} from "./orchestration/config-loader.ts";
export type {
  CachedWorkflowMeta,
  WorkflowMeta,
  WorkflowScanConfig,
  WorkflowSource,
} from "./orchestration/config-loader.ts";

// FileRunStore：RunStore port 的宿主无关文件实现（D2 设计件）——落盘
// <dataRoot>/workflow-state/<runId>.jsonl，zsw 等无 pi session 设施的宿主装配
// LifecycleDeps.store 用；pi 壳继续用 session 锚定的 JsonlRunStore。
// DEFAULT_* 两常量：壳 jsonl-run-store.ts 生产消费（D3 判定进 barrel），
// u-2c 删 ./* 通配后深路径仅测试侧 vitest alias 可解析，生产消费必须走 barrel。
// pruneStateFilesBeyondCap：磁盘 retention 裁剪单源（S4-A7）——壳 jsonl-run-store
// 的同构私有实现已删，改 import 本函数并注入自身 logger tag / toErrorMessage。
export {
  DEFAULT_SAVE_MIN_INTERVAL_MS,
  DEFAULT_STATE_MAX_RUNS,
  FileRunStore,
  pruneStateFilesBeyondCap,
  type PruneStateDeps,
} from "./orchestration/file-run-store.ts";

// ── 快照 codec（U8 / D4）──────────────────────────────────────
// WorkflowRun ↔ 落盘快照的单一投影：版本常量沿用 pi "wf-run-v2"（存量逐字节
// 可读）、live 字段 strip、更高版本跳过（宿主侧 warn 可见性自决）。
export {
  fromRunSnapshot,
  SNAPSHOT_VERSION,
  toRunSnapshot,
  type RunSnapshot,
} from "./orchestration/run-snapshot.ts";

// run 投影（U7 / D8）：isScriptRunning / runSummary 以 core WorkflowRun 为准的
// 投影（runSummary 双投影分叉收口）。
export {
  isScriptRunning,
  runSummary,
  type WorkflowRunSummary,
} from "./orchestration/workflow-run-summary.ts";

// ── schema 助手（U9 / D9）─────────────────────────────────────
// workflow 资产 @pi-meta parameters 的 schema→已知键集、平铺参数检测与
// 归一化（pi tool-workflow 消费面下沉；宿主白名单退役入口）。
export {
  argKeysFromMeta,
  findFlattenedArgKeys,
  normalizeArgsByMeta,
  type ArgKeySet,
  type ArgMetaOptions,
  type ArgMetaWarning,
  type NormalizedArgs,
} from "./orchestration/args-meta.ts";

// ── 共享原语（shared/）───────────────────────────────────────
// agent 展示名归一（渲染层 7 处消费的 SSOT）+ meta 解析 / XML 注入 / 资源发现 /
// thinking 档位序（THINKING_ORDER 定义源 shared/model-ref，model-resolver 为转发）。
export { displayAgentName } from "./shared/agent-ref.ts";
export {
  parseResourceMeta,
  parseResourceMetaDetailed,
} from "./shared/meta-parser.ts";
export { THINKING_ORDER } from "./shared/model-ref.ts";
// 定时器上限（壳 tool-workflow.ts OR-1 消费，D3 判定进 barrel）
export { MAX_TIMER_DELAY_MS } from "./shared/timer-delay.ts";
// 资源发现面（W2③）：discoverResources——agent .md / workflow .js 的多源统一发现
// （ADR-031）——多源扫描 + stem last-writer-wins 合并 + realpath 去重。宿主（zsw
// 回接）经 ScanConfig.hostRoots 注入发现根（source 标签即 ResourceSource 槽位键，
// 含 project-host 项目级槽）；深路径消费在 npm/vendored 发布形态不可达（exports 无
// 深路径通配），故出 barrel。发现链辅助（C5b）：findWorkspaceRoot（project 源根
// 定位）、getCachedParsed/getCachedFileContent（mtime 缓存读取）——发现链消费方
// （pi-sw injector 等宿主接线）逐条解析 DiscoveredResource 的 frontmatter/meta
// 需要它们，深路径同样不可达。
export {
  discoverResources,
  findWorkspaceRoot,
  getCachedFileContent,
  getCachedParsed,
} from "./shared/resource-discovery.ts";
export type {
  DiscoveredResource,
  ResourceKind,
  ResourceSource,
  ScanConfig,
} from "./shared/resource-discovery.ts";
export { escapeXml, renderXmlSection } from "./shared/xml-injection.ts";

// ── agent-ref 面（契约原语，U1）────────────────────────────────
// agent 引用规范化（normalizeRef 含 `..` 段拒绝——G4 声明的唯一行为收紧，
// ⛔2 样本集验证）+ 引用扩展名常量 + 报错文案工厂。
export {
  AGENT_REF_EXT,
  invalidAgentRefMessage,
  normalizeRef,
  type InvalidAgentRefMessageOptions,
  WORKFLOW_REF_EXT,
} from "./shared/agent-ref.ts";

// ── workflow 契约面（U1）──────────────────────────────────────
// workflow 引用规范化（名/路径二分 + 保留字裁决，knownNames 宿主注入——内置
// workflow 名不 core 硬编码）。
export {
  normalizeWorkflowRef,
  WORKFLOW_REF_RESERVED_NAMES,
  type NormalizeWorkflowRefOptions,
  type NormalizedWorkflowRef,
  type WorkflowRefInvalidReason,
} from "./shared/agent-ref.ts";

// ── 注入渲染面（shared/injection-render，W3）───────────────────
// 三段 XML（<available_subagents>/<available_workflows>/<available_provider_models>）
// 的 format 纯函数 + Entry 接口从 pi-sw 插件层下沉（D-3）：ModelEntry 并集口径
// （除 id/name 外全字段 optional，红线 5 守卫不抛不渲垃圾）、分段条目预算
// （码点序排 + 截尾 + 宿主注入兜底指引；models 段无预算永不截，红线 7）、
// guide 文案宿主注入（core 不内嵌平台文案）。summarizeDescription 随
// WorkflowEntry 链导出（zsw 侧同口径消费）。
export {
  formatAgentList,
  formatModelList,
  formatWorkflowList,
  sortByCodepoint,
  summarizeDescription,
} from "./shared/injection-render.ts";
export type {
  AgentEntry,
  ListFormatOptions,
  ModelEntry,
  ModelListFormatOptions,
  ModelReasoningInfo,
  WorkflowEntry,
} from "./shared/injection-render.ts";

// ── 原语（U6a）────────────────────────────────────────────────
// atomic-write：tmp+rename 原子写单一实现（统一 tmp 命名 `.tmp.<pid>.<seq>-<rand>`、
// 失败清理、崩溃残留扫描/清理入口）——core 内部全部写点已收敛于此（U6b）；
// sync/async 两档耐久语义见模块头。bounded-serialize：预算内 JSON 序列化
// （自 pi-sw helpers 平移，输出逐字节一致）。
export {
  atomicTmpPathFor,
  cleanupStaleTmpFiles,
  listStaleTmpFiles,
  parseAtomicTmpPath,
  writeAtomicFile,
  writeAtomicFileSync,
  type AtomicTmpRef,
  type AtomicWriteFileOptions,
  type AtomicWriteOptions,
  type CleanupStaleTmpOptions,
  type CleanupStaleTmpResult,
} from "./shared/atomic-write.ts";
export { boundedPrettySerialize } from "./shared/bounded-serialize.ts";

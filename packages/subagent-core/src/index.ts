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
 * [2026-09-13 barrel 全面收窄] 用户裁决不等跨仓验证直接收窄：零仓内消费导出删除
 * （A 组全死连定义删 / B 组仅定义文件内部使用只摘 barrel 行 / C 组仅测试消费摘
 * barrel 行 + 测试改深路径），298 → 229 符号；外部消费者（zsw 仓）编译报错符号
 * 按 git 历史原样加回 barrel（恢复通道）。弱活保留项：maxTurnsToWatchdogMs /
 * loadWorkflowScriptByPath / normalizeWorkflowRef / cleanupStaleTmpFiles /
 * listStaleTmpFiles / parseAtomicTmpPath（scripts/probe-third-host-integration.mjs
 * 探针消费）、CORE_PACKAGE_VERSION / DEFAULT_DATA_ROOT / routeEngine（版本一致性
 * 守卫 + dist 冒烟链消费）。
 *
 * 设计权威源：docs/architecture/subagent-core-package-extraction.md §3.3 D5；
 * docs/design/subagent-core-sink-design.md（已删，git 可追溯）（sink 下沉收口扩面，2026-08-31）；
 * 宿主接入示例见包 README（§3.4 core_host_not_configured 恢复指引的落点）。
 */

// 0.4.0 = 首个公开发布的收敛收口面（0.3.0 为 2026-08-30 裁决的跳号占位，永不单独
// 发布；+ minor changeset 收口面落本号）；与 package.json version 的一致性由
// src/__tests__/smoke.test.ts 动态守护，改版本须两处同步。
export const CORE_PACKAGE_VERSION = "0.12.0";

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
// EnginePort：subagent 执行引擎的唯一契约点（capabilities / probe / run / read 四必选
// 面 + listModels / validateModel / dispose 可选扩展；[H1] interact 能力面已随
// chat-run 统一退役，续聊 = run + resume 锚点——协议线对齐 SDK 9 正向方法集）。
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
export type { ModelInfo } from "./execution/assembly/model-resolver.ts";
export type { SubagentStream } from "./execution/assembly/stream-sink.ts";

// routeEngine：三层路由（调用参数 > frontmatter > 全局默认）+ probe fallback 编排
// 的单一权威点（engine-abstraction D9/D7）。宿主按 error.code（engine_* 错误族）
// 判别失败形态，无需导入错误类。
export {
  routeEngine,
  type EngineRouteResult,
} from "./execution/engine/routing.ts";
// [W8 补扫接线面] setEngineDiscoveryRescanOptions：宿主登记 hasEngineWithRescan 的
// 补扫发现参数（与 session_start 发现扫描同源）；壳消费 = runtime
// subagent-engine-history 的 ensureRuntimeEngineWiring。
export { setEngineDiscoveryRescanOptions } from "./execution/engine/routing.ts";

// ── 引擎注册 / 发现与进程面（execution/engine）────────────────
// 组合根 index.ts 接线消费（registerXxx 引擎注册、syncEnginesFile engines 文件
// 同步、markAllSpawnedChildrenDead session 派生进程兜底清理）。
export { syncEnginesFile } from "./execution/engine/engine-discovery.ts";
// [W11/DoD#5] registerPiEngine（inproc 'pi' 注册）已删；[W3 chat 域收口] chat 域 inproc
// 引擎（inproc pi 引擎目录）与 SubagentService 自持 DI 实例一并删除——registry 'pi' 由三级发现
// 装载 cli descriptor，chat 轮次与 run 域同路经协议客户端发往 pi-subagent-cli 引擎进程
// （G1：pi 引擎单一 CLI 形态，core 壳侧零内建引擎）。
// [W8 D8 薄壳] markAllSpawnedChildrenDead：扩展 index.ts / zsw runner-core.js 的
// 业务调用点。语义（[F-7 注释纠偏，如实口径]）= **仅镜像记账**——core 侧
// spawnedChildren 镜像整体清空（engine/host/spawned-children.ts 公共面），
// 不发任何进程信号（命名即语义：mark 镜像置死，非 kill 进程）；
// 子进程活在引擎进程内，其回收链 = ① stdin-EOF 自灭（宿主退出 / EngineClient 销毁
// → 引擎进程 stdin 断源自灭，正常路径）；② disposeEngines()（registry）显式触发全部
// 已实例化引擎 dispose（cli 形态 = RemoteEngine.dispose → EngineClient 有界收口）——
// 该入口为宿主 shutdown 链预留，现无生产接线。subagent-workflow 扩展的
// reapSpawnedChildrenOnShutdown（process hook 调本函数）因此同为镜像置死 no-op，
// 不构成真实收割（现状登记，workflow 包生产码不动）。
export { markAllSpawnedChildrenDead } from "./execution/engine/host/spawned-children.ts";

// [W8 D8 兼容公共面薄壳]（设计 §3.6 D8 表）：registerZcodeEngine 确保cli descriptor
// 注册（vendored 相对定位，失败回退 inproc 过渡）+ engineDataDir 记入；createZcodeEngine
// 返回 RemoteEngine('zcode')（deps → 协议客户端映射，sources 不跨进程）。实现见
// execution/engine/d8-compat.ts——engines/zcode/registration.ts 的同名符号不再经
// barrel 导出（inproc 实现保留至 W11，仅内部测试/过渡消费）。
export {
  createZcodeEngine,
  registerZcodeEngine,
} from "./execution/engine/d8-compat.ts";

// 在途事件出口（u7a，D5）：壳层（subagent-workflow host/inflight-reporter）注册
// 监听 + 求值绝对计数快照——core→壳回调出口的 barrel 消费面（exports 面收窄后
// 壳侧生产消费必须经 barrel，无深路径豁免）。
export {
  setInFlightListener,
  getInFlightSnapshot,
} from "./execution/engine/inflight-snapshot.ts";
// W3 后内核宿主 = engine/host（在途推送迁移点 = Continuation arm/disarm 与 EngineClient
// 反向通道镜像桥接），模块本体不经 engines/pi。
// maxTurnsToWatchdogMs 为 maxTurns→watchdog 毫秒换算（U3/U4 / D7，floor 语义
// 文档化——现役消费 = scripts/probe-third-host-integration.mjs 探针；引擎侧无消费
//（预算各自实现）；[W3] 定义收敛在 pi-host-binding，原 inproc session-runner（已删）
// 定义随删件消亡）；killRecordChildWithEscalation 为
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
// 模型引用串解析单点（runtime / 壳侧消费）：字符串只在入口解析一次，内部传结构体。
export { isModelRef, parseModelSelector, type ParsedModelSelector } from "./shared/model-ref.ts";
export { parseEngineHandle } from "./execution/engine/common/session-view-types.ts";
export { readSubagentHistoryMessages } from "./execution/engine/common/session-view-service.ts";
// 引擎路由身份域裁决单点（runtime 读链同源消费——本地副本会让「有锚无 engine」的
// 损坏 record 在 runtime 侧先被当成 pi，core 侧守卫永不触达）。
export {
  hasNativeEngineAnchor,
  RecordEngineIdentityError,
  resolveEngineRouteId,
} from "./execution/engine/common/session-view-service.ts";
// [W8] registerNativeSessionReader：runtime 成为协议客户端的①级接入点——宿主把
// 「协议 read」注册为引擎原生 reader，core 三级降级链（①协议 read → ②journal →
// ③outcome）自动编排（含投影），宿主零投影代码。壳消费 = runtime
// subagent-engine-history 的协议 reader 注册。
export { registerNativeSessionReader } from "./execution/engine/common/session-view-service.ts";

// ── 执行域（execution/）──────────────────────────────────────
// types.ts 领域类型族：record / 响应 / 列表项等 subagent 域公共契约（壳消费最高频面，
// tool 面 / interface 渲染层 / bg-notify 共同消费）。CLOSED_REASONS / DEFAULT_AGENT_NAME
// 为值常量，ResurrectDeniedError 为错误类（值 + 类型双形态）。
// stopReason 词表族（NEW_STOP_REASONS 中断+重开 4 值 / ROUND_TERMINAL_STOP_REASONS
// 正常轮终 2 值 / STOP_REASONS 13 值全集）单源在 types.ts——runtime workflow-step-merge
// 的步骤状态映射按词表判定（消费方引用常量，勿手抄字面量清单）。
export {
  CLOSED_REASONS,
  DEFAULT_AGENT_NAME,
  NEW_STOP_REASONS,
  ROUND_TERMINAL_STOP_REASONS,
  STOP_REASONS,
  ResurrectDeniedError,
} from "./execution/assembly/types.ts";
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
} from "./execution/assembly/types.ts";

// execution-record 投影函数族：record → 渲染态投影（outcome / elapsed / tool
// calls），interface 渲染层唯一消费入口（live 进度投影面 = SubagentRecord 投影族）。
export {
  computeElapsedSeconds,
  deriveOutcome,
  getAllToolCalls,
  projectOutcome,
} from "./execution/persistence/execution-record.ts";

// SubagentService 聚合面 + 进程单例访问器（post-convergence D8）：访问器经
// globalThis[Symbol.for] slot 防 jiti 多实例分裂，/resume /fork 复用既有实例
// （SR-3/SR-4 语义）。SubagentServiceInit 为构造依赖参数注入形态（modelService
// 等，无全局查找，@experimental U10 / D6）。
// [H3/R6] 单例访问器 + Init 接口外移支撑文件 service/service-bootstrap.ts，本
// barrel 直接改指向该文件（导出符号面不变；壳对 bootstrap 零 re-export——防壳↔
// bootstrap 值环，设计 v4 import 纪律）。对外消费方零感知。
// [2026-09-13 barrel 收窄] createSubagentService（全仓零消费，定义文件内部亦零
// 使用）已连定义删除——第三宿主参数注入构造改走 `new SubagentService(init)`
// （SubagentServiceInit 形状，见 subagent-service.ts 装配）；恢复通道 = git 历史。
export { SubagentService } from "./execution/subagent-service.ts";
export {
  getSubagentService,
  setSubagentService,
  type SubagentServiceInit,
} from "./execution/service/service-bootstrap.ts";
// notifyGateAllowsDelivery：[U5/K11] 轮次完成回注的投递门——二元组判据（回注
// epoch 世代比对 + 放弃轮标记命中阻断；收口轮构造性豁免——close 收口落账挂在
// 通知送达之后且不置标记），判据源已从旧「closedReason 形态枚举」切换为
// 「放弃标记」单维——
// 投递内核与壳侧 notify 链的共同语义锚点（execution 生产域消费，A2a/U5）。
export { notifyGateAllowsDelivery } from "./execution/subagent-service.ts";

// ModelConfigService 聚合面 + 单例访问器四件中的 model 侧两件（D8）。
// ModelConfigServiceInit 已随 2026-09-13 barrel 收窄出公共面（定义文件内部
// 类型闭包，形状经 `new ModelConfigService({cwd, agentDir})` 签名约束，
// MF-4 jsdoc 同）。
export {
  ModelConfigService,
  getModelConfigService,
  setModelConfigService,
} from "./execution/assembly/model-config-service.ts";

// ModelCatalog：pi 引擎模型目录（D8 两层挂点的共享裁决面——workflow tool 创建期
// 拒单 + workflow-dispatch 派发期对称校验同源消费；extensions 源文件只从 barrel
// 消费 core 符号，不进 barrel 无法接线，H4 formatEmptyResourceList 同构先例）。
export {
  assertModelInCatalog,
  type PiRegistryModelEntry,
  type ModelCatalogOptions,
  type ModelCatalogSource,
} from "./orchestration/model-catalog.ts";

// notify ledger：宿主通知账本端口（bind / getBound）——组合根装配 + workflow 域消费。
export {
  bindNotifyLedgerHost,
  getBoundNotifyLedger,
  type NotifyLedgerHost,
} from "./execution/notify/notify-ledger.ts";

// identity 重建常量与类型：session_start identity custom entry 的写入侧契约。
export {
  IDENTITY_CUSTOM_TYPE,
  type SubagentIdentityData,
} from "./execution/persistence/session-reconstructor.ts";

// 执行域外围件（组合根 / interface 层直接消费的独立单点件）。
export { bestEffort } from "./execution/assembly/best-effort.ts";
// channel-registry 类型闭包（UiChannelRegistry / ChannelHandler）随值符号进 barrel
// （u-2b 主 agent 裁决 2026-09-03）：core 内部消费 + 类型导出（原「壳 index.ts 跨
// 扩展 re-export surface」消费面已收）；type-only，零运行时面变化。
export {
  getOrCreateChannelRegistry,
  type UiChannelRegistry,
  type ChannelHandler,
} from "./execution/assembly/channel-registry-access.ts";
export { DialogGlobalQueue } from "./execution/ui/dialog-queue.ts";
export {
  readGlobalConfig,
  type GlobalConfigReadResult,
} from "./execution/assembly/config.ts";
export { isResumable } from "./execution/lifecycle/lifecycle-predicates.ts";
export { maybeCleanupExpiredSessionFiles } from "./execution/persistence/session-file-gc.ts";
export { createUiRequestHandlerForMode } from "./execution/ui/ui-request-handler-factory.ts";
export { WorktreeManager } from "./execution/worktree/worktree-manager.ts";
export { SubprocessAgentRunner } from "./execution/assembly/subprocess-agent-runner.ts";

// record 存储面：RecordStore 类（ChangeListener / RecordStorePi / INDEX_FILENAME
// 已随 2026-09-13 barrel 收窄出公共面——前两者为定义文件内部类型闭包、后者仅
// bench/测试深路径消费）；StatusFilter 为状态查询面的类型闭包
//（@experimental U10 / D6：lookupRecordAnyState 全态查询等签名直接引用）。
export {
  RecordStore,
  type StatusFilter,
} from "./execution/persistence/record-store.ts";

// record 落盘 entry 契约（登记 §3.3 后 = v2 注册/终态两条小条目；v1 全量快照写点随
// 兼容层删除——写侧自定义条目构造入口见下方 v2 条目契约行段）。
export { SUBAGENT_RECORD_CUSTOM_TYPE } from "./execution/persistence/record-entry.ts";

// ── W1 [D1/D3/D6]：介质归位契约与 tail 原语（U0 新增行段——既有行零改动，
// cap 族导出行的删改归 U7）。两族 v2 条目契约（版本常量/classify）+
// record 事件 journal 读写原语（append 单调分配 seq / scan 宽容解析）+
// 域无关 tail 读取器（offset 续读 / 完整行边界 / 坏行宽容 / watch 目录 +
// 周期复查）。生产消费方（U1 壳写侧 / U2a record 写侧 / U3 runtime 读侧 /
// U5 清理）一律经 barrel 消费。
export {
  SUBAGENT_RECORD_ENTRY_VERSION,
  classifySubagentRecordEntryData,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from "./execution/persistence/record-entry.ts";
export {
  createRecordEventJournal,
  foldRecordJournalEvents,
  INITIAL_RECORD_EVENT_FOLD_STATE,
  parseRecordEventFileLine,
  recordEventsPath,
  RECORD_EVENTS_SUFFIX,
  type RecordCreatedEvent,
  type RecordEventJournal,
  type RecordJournalEvent,
  type RecordJournalEventInput,
  type RecordJournalFoldState,
  type RecordSettledEvent,
  applyRecordEvent,
} from "./execution/persistence/record-events.ts";
export {
  createEventDirectoryTailer,
  readJournalTail,
  splitCompleteLines,
  type EventDirectoryTailer,
  type JournalDirectoryTailerOptions,
  type JournalLineParser,
  type JournalTailChunk,
} from "./execution/persistence/journal-tail.ts";

// agent-registry 执行消费面：loadByPath 直接加载（@experimental U10 / D6）+
// parseAgentProfile 宽容解析（无 frontmatter 不拒、name 缺省 stem、返回 body 与
// 执行字段全量）——执行消费面单点；与严格注入投影（parseResourceMeta）双轨分离
// 的执行侧统一入口（U2 / D3）。
export { AgentRegistry } from "./execution/assembly/agent-registry.ts";
export { parseAgentProfile } from "./execution/assembly/agent-registry.ts";

// 错误类型族（error-recovery.ts 计划路径实测不存在，实测散布于下列源文件）：
// resurrect/fork-depth/dirty-worktree 为动作层守卫抛出点（types.ts）。
export {
  DirtyWorktreeError,
  ForkDepthExceededError,
} from "./execution/assembly/types.ts";

// 动作层领域内核（@experimental U10 / D6）：六 handler 的校验/守卫链/归属判定/
// 终态映射，产出领域对象，宿主 adapter 负责包装渲染。
export {
  cancelHandler,
  closeHandler,
  endedMessageGuard,
  forkFromHandler,
  listHandler,
  mapExternalState,
  messageHandler,
  recordToListItem,
  startHandler,
  type CancelHandlerResult,
  type CloseHandlerResult,
  type ForkFromHandlerResult,
  type ListHandlerResult,
  type MessageHandlerResult,
  type StartHandlerResult,
} from "./execution/assembly/subagent-actions-core.ts";

// 进程活性探针（watchdog/孤儿判定共用，agent-ref 契约原语组 U1）。
export { isProcessAlive } from "./execution/persistence/alive-store.ts";

// 并发池工厂（U3/U4 / D7）：queuePolicy 缺省 priority 保 pi 行为，zsw 消费
// strict-fifo——策略差异显式化而非双实现。
// [2026-09-13 barrel 收窄] createConcurrencyPool / CreateConcurrencyPoolOptions /
// QueuePolicy 已出公共面（定义文件内部零使用，仅测试深路径消费）——池实例经
// zsw 侧装配注入，core 公共面只留 ConcurrencyPool 契约类型。
export type { ConcurrencyPool } from "./execution/assembly/concurrency-pool.ts";

// 模型引用切分原语（U1 契约面批件）：provider/model 引用切分（两宿主
// maxTurns/model 换算同源）。[W11/H2] 实现体随 engines/zcode 删除迁至
// shared/zcode-model-ref.ts（宿主侧原语，与引擎包各自单源）。[2026-09-29 account
// 体系迁移同步] DEFAULT_PROVIDER_ID / ZCODE_FALLBACK_DEFAULT_MODEL / hasApiKey
// 删除——plan 家族 id 经 entitlement 门控后宿主侧无消费场景（引擎侧模型源已切换
// provider_config.json，见 zcode-subagent-cli preparer.ts）。
export { splitZcodeModelRef } from "./shared/zcode-model-ref.ts";

// 组装层（U2 装配）：discoverAgents 发现→宽容解析→去重→码点序（workflow 侧
// discoverWorkflows 对称面，第三宿主「列 agents」入口）。
export { discoverAgents } from "./execution/assembly/agents-assembly.ts";

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
// [2026-09-13 barrel 收窄] RecoverCrashedRunsHooks / RecoverCrashedRunsResult
// 已出公共面（定义文件内部类型闭包），hooks 形状经函数签名隐式约束。
export { recoverCrashedRuns } from "./orchestration/lifecycle.ts";

// [U2/U3]（workflow-run-resume-revision）resume 编排原语：interrupted 态 run 的
// 断点续跑入口（壳 tool/命令通道消费，D14 args 校验在壳入口 tool-workflow）。
// 编排内部收敛 D7 跨进程锁 / D8 三档恢复 / D12 record 完整性校验 / D13 嵌套
// 拒绝 / D10 预算预检；资格拒绝统一 ResumeRejectionError（文案含恢复指引，
// 壳入口原样透出）。
export {
  resumeRun,
  ResumeRejectionError,
  type ResumeRunOptions,
} from "./orchestration/resume-run.ts";

// [§2.1b] run 会计重建（帧推导单源；壳侧折叠面与 core 重建面共用，避免第二套折算）。
export { rebuildBudget, runAccountingFromEvents } from "./orchestration/run-accounting.ts";
export { errorLogsFromEvents } from "./orchestration/run-events.ts";

// [§2.5] D14 args 一致性判定单源（原壳层实现下沉；壳只装配 args + journalDir）。
export {
  assertResumeArgsMatch,
  diffResumeArgs,
  historicalArgsOf,
  type HistoricalArgs,
} from "./orchestration/resume-args-guard.ts";

// launcher 层：deps 类型 + 拒单文案单点。
// formatAvailableWorkflowRefs / workflowNotFoundMessage：not found 拒单清单与
// 文案单点（extension 顶层 workflow tool 同案消费，副本已删）。
// runAndWait / executeNestedWorkflow（编程阻塞入口与脚本内嵌套调用实现）已随
// 嵌套 workflow() 编排 API 退役整体删除。
export {
  formatAvailableWorkflowRefs,
  workflowNotFoundMessage,
  type LauncherDeps,
} from "./orchestration/launcher.ts";

// worker-message-pump 内核件（execution 生产域消费，A2a）→ [D15] 迁移：终局编排
// 面与 v2 条目构造器迁 terminal-actions（终局编排单一入口——五路收敛），pump 薄化
// 为「消息路由 + 重试矩阵」（消息面符号仍自 pump 出 barrel：makeSerializeFailedResult
// 等测试深路径消费面）。
// [D15] terminal-actions 终局编排入口：finalizeRun 五步 coda（终局目标态）+
// interruptRun 中断编排（[D2] interrupted 暂停态转移）+ isRunSettled 判定 +
// buildWorkflowRecord{Registered,Settled,Interrupted}EntryData 条目构造器单源。
// [G1 跨包单源] runSettledOutcomeToDoneReason：壳侧曾持同语义本地实现（值表靠
// 双侧测试锁定），收敛为 core 单源——壳经 barrel import 消费。
export {
  finalizeRun,
  interruptRun,
  isRunSettled,
  runSettledOutcomeToDoneReason,
  closeOutInFlightCalls,
  buildWorkflowRecordRegisteredEntryData,
  buildWorkflowRecordSettledEntryData,
  buildWorkflowRecordInterruptedEntryData,
} from "./orchestration/terminal-actions.ts";

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
export type { RunExecutionSnapshot } from "./orchestration/models/run-state.ts";
export { Trace } from "./orchestration/models/trace.ts";
export { AgentCall } from "./orchestration/models/agent-call.ts";
export { Budget } from "./orchestration/models/budget.ts";
export { WorkflowRun } from "./orchestration/models/workflow-run.ts";
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
// isTerminalDoneReason：DoneReason 终止性判定（穷举 switch，词表新增成员 tsc 强制归类）。
// 壳 workflow-notify 的防偷懒收尾指令按它判定——词表镜像收编 core 单源。
export { isTerminalDoneReason } from "./orchestration/models/types.ts";

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
export type { LintResult } from "./orchestration/script-lint.ts";
export { saveWorkflow, deleteWorkflow } from "./orchestration/workflow-files.ts";
export { clearSkillPathCache } from "./orchestration/skill-discovery.ts";
export { WorkerHostImpl } from "./orchestration/worker-host.ts";

// ── workflow 创作闭环面（orchestration/script-generate + workflow-files，W4）──
// generateWorkflowScript：generate 校验管线（五道闸 + @pi-meta round-trip + tmp
// 写盘）从 pi-sw 插件层下沉（D-6）——纯函数返回结构化结果（不 throw，pi 的
// isError 契约转换由宿主负责），报错文案逐字对齐 pi 现版（CA2 前提）。
// saveWorkflow/deleteWorkflow（上方已导出）+ 目录参数注入（缺省 pi 布局
// DEFAULT_WORKFLOW_TMP_DIR，向后兼容——pi 现深路径调用形态行为不变，改接在 C5）。
// [2026-09-13 barrel 收窄] WorkflowDirOptions / GenerateWorkflowScriptOptions /
// GenerateWorkflowScriptResult / DEFAULT_WORKFLOW_SAVED_DIR 因仓内仅测试消费已出
// 公共面（恢复通道 = git 历史按符号原样加回）。
export { generateWorkflowScript } from "./orchestration/script-generate.ts";
// 缺省目录常量随面导出：宿主显式注入 pi 布局时引用常量，避免字面硬编码回流。
export { DEFAULT_WORKFLOW_TMP_DIR } from "./orchestration/workflow-files.ts";

// workflow 发现/加载（ADR-031 统一资源发现）：discoverWorkflows 为 registry 构造
// 消费（workflow-script-registry-impl）；宿主 list 面走 loadWorkflows；
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

// 终局证据判定核与保留期维护（workflow-run-store-convergence U3+U4：自
// orchestration/file-run-store.ts 迁入 execution/persistence/，RunStore 写实现
// 身份已退役——生产唯一实现 = pi 壳 JsonlRunStore）。
// [C3 常量上收] STATE_DIR_NAME：pi 壳 workflow-events / jsonl-run-store 的
// `<sessionDir>/workflow-state` 与 pi 宿主枚举的 agentDir 根回退目录同名分量
// 单源——壳侧字面量改 import 消费，防布局分量漂移。
export { STATE_DIR_NAME } from "./execution/persistence/run-state-evidence.ts";

// [W1 / D5] 统一保留维护轮入口：run journal prune + record 事件文件 prune 同轮
// 幂等扫描 + 判据②候选数日志。三触发点（新 run 首写 / 新 record 事件文件首写 /
// session_start 兜底）都经此单入口消费——壳生产消费必须走 barrel（深路径仅
// 测试侧 vitest alias 可解析，barrel 先例同上）。
export { runRetentionMaintenanceRound } from "./execution/persistence/run-state-evidence.ts";

// [裁决点 7]（workflow-run-resume-revision）孤儿 run 对账清理：无主 run 的唯一
// 磁盘清理通道（run 数据生命周期跟随 session 归属——引用集三代解析 + 宽限窗登记
// + 三件删除）。壳生产消费（session-lifecycle 装配的引用集注入面）走 barrel。
export { reapOrphanRuns } from "./execution/persistence/run-state-evidence.ts";

// [W1 / D5] session_start 兜底触发点的 record 域目录锚（与 SubagentService 构造点
// 同源同式推导）：getSubagentRecordsDir 给出 records 目录布局，ENV_ROOT_CWD 是
// rootCwd 贯穿 env 名单源（根进程无 env → ctx.cwd 兜底，与 SessionBaselines 推导
// 同式——壳侧复制推导式时经此常量锚定 env 名防漂移）。壳生产消费必须走 barrel。
export { ENV_ROOT_CWD } from "./execution/service/session-baselines.ts";
export { getSubagentRecordsDir } from "./execution/assembly/path-encoding.ts";

// resolvePiSessionScopedDir：pi 宿主 sessionDir 布局（cwd slug + existsSync 探测）
// 的单一权威源——pi 壳 session-lifecycle 的 resolveSessionDir 经 opts.agentDir
// 注入 pi SDK 活源 getAgentDir() 薄消费（原壳侧同形手写已删，收敛单源防漂移）；
// resolvePiWorkflowStateDir 为其 workflow-state 后缀派生，core 读侧装配经相对
// 路径消费，不需要 barrel 面。
export { resolvePiSessionScopedDir } from "./execution/assembly/workflow-state-root.ts";

// createPiHostRunEnumeration：pi 宿主 workflow run 的读侧枚举 store（agentDir
// 活源 + 全 session 目录）。消费方 = startupSweep 的枚举注入（runtime 启动扫描；
// 原 pi 壳定时器装配点已随机制退役）——跨包消费，需 barrel 面；
// 见 pi-host-run-store.ts 头注的分层边界。
export { createPiHostRunEnumeration } from "./execution/assembly/pi-host-run-store.ts";

// startupSweep：runtime 启动收编扫描的 core 装配单点（30 天定时器回收机制退役
// 后的替代实装——枚举 + 逐 run 收编 + 事件流静止宽限窗 + 失败语义 + 注入日志
// 通道；决策登记见 docs/adr/decisions.md 启动扫描条目）。消费方 = runtime main()
// 挂点（registerRuntimeInstance 之后、service 构造段之前，先于任何 pi spawn）。
export { startupSweep } from "./execution/assembly/startup-sweep.ts";

// ── workflow-record entry 契约（词表/guard 收敛单源）──────────
// customType / entry schema 版本 / v1 判定分类：壳 jsonl-run-store（写点 +
// loadAll 重建）与 runtime workflow-extractor（entry 扫描投影）共用的 entry 层
// 契约单源（收敛前壳与 shared 各持一份字面量、v1 guard 壳/runtime 双实现）。
// WORKFLOW_STATE_LINK_CUSTOM_TYPE：legacy workflow 指针条目（W17 前写侧停写，
// 读侧兼容消费——runtime 两处 + 壳 session-lifecycle 引用集解析经 barrel 引用）。
// classify 无 IO 无日志——日志策略（warn/warnOnce/静默）留消费方；snapshot 层
// 解码仍在 run-snapshot.ts codec（entry 层 v 与 snapshot 层 v 两级独立版本）。
export {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_STATE_LINK_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  classifyWorkflowRecordEntryData,
} from "./orchestration/workflow-record-entry.ts";
// [W1 / D1] v2 条目契约增量导出（既有行段零改动）：注册/终态两条小条目的类型面
// ——壳 U1 写点 / runtime U3 投影 / session-reader U4 锚链消费。
export {
  type WorkflowRecordRegisteredEntryData,
  type WorkflowRecordSettledEntryData,
} from "./orchestration/workflow-record-entry.ts";

// ── 快照格式版本（U8 / D4）────────────────────────────────────
// workflow-state/<runId>.jsonl 快照行的格式版本常量单源（消费方 = runtime
// workflow-extractor 版本守卫，经 barrel import 不落第二份字面量；additive
// 字段策略与 bump 代价见 run-snapshot.ts 常量注释）。
export { SNAPSHOT_VERSION } from "./orchestration/run-snapshot.ts";

// [P3/D6] run 事件 journal 读面（宿主 store fold 投影的数据源——journal scan 的
// 坏行容忍与日志语义单源；生产源码只从 barrel 消费 core 符号先例同上）。
// [C3 常量上收] RUN_EVENT_JOURNAL_SUFFIX / ALL_RUN_OUTCOMES / RunOutcome /
// doneReasonToRunOutcome：壳侧曾本地镜像 journal 后缀与 DoneReason→RunOutcome
// 映射（无机器守卫、漂移即静默失配）——经 barrel 单源后壳改 import 消费；
// 词表与映射的语义锚点注释见 run-events.ts 对应定义。
export {
  ALL_RUN_OUTCOMES,
  RUN_EVENT_TYPES,
  createRunEventJournal,
  doneReasonToRunOutcome,
  foldRunEventCheckpoint,
  INITIAL_RUN_EVENT_FOLD,
  RUN_EVENT_JOURNAL_SUFFIX,
  // [§3.2] record 流单行坏行判定原语（core 恢复读面与壳 strict 读面共用单源——规则
  // 在 core，错误文案由各调用方自持；此前两处各写一份判据，漂移即同一坏行一边拒绝
  // 一边放行）。
  parseRecordStreamLine,
  parseLegacyArgsSummary,
  type LegacyArgsSummaryIssue,
  type LegacyArgsSummaryResult,
  type RunAskStepFold,
  type RunEventFoldCheckpoint,
  type RunEventJournal,
  type RunEventLineIssue,
  type RunEventLineIssueKind,
  type RunEventLineResult,
  type RunJournalFold,
  type RunOutcome,
  type WorkflowRunEvent,
} from "./orchestration/run-events.ts";

// [Q2/D9-1] run 注册表（D5 状态机投影面）。[D9]（workflow-run-resume-revision）
// abandon 放弃窗终局化（abandonElapsedInterruptedRuns 及常量/env 通道）已随功能
// 整体移除——「数天后回来仍可 resume」的 run 不再被判死，无主 run 磁盘清理归裁决
// 点 7 对账清理（persistence/run-state-evidence 维护轮族）。中断收编原语 adoptInterruptedRun 与
// 投影函数族消费全在 core 内部（收编链 u1b 接线）——按 D3 判定标准不进 barrel。

// run 投影（U7 / D8）：runSummary 以 core WorkflowRun 为准的投影（双投影分叉收口）。
export { runSummary } from "./orchestration/workflow-run-summary.ts";

// ── schema 助手（U9 / D9）─────────────────────────────────────
// workflow 资产 @pi-meta parameters 的 schema→已知键集与平铺参数检测
// （pi tool-workflow 消费面下沉；宿主白名单退役入口）。
export {
  argKeysFromMeta,
  findFlattenedArgKeys,
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
// [§2.6] 进程级全局槽键单一声明处（壳侧托管槽 dialogQueue/workflowDomainState 同源消费）。
export { GLOBAL_SLOT_KEYS, type GlobalSlotName } from "./shared/global-slots.ts";
// 入口态 fail-fast 断言（time 上界/负值、tokens 负值、slug 长度）：两个 tool 入口
// 共用的同一份实现（findings g11a-F2；schema 第一道关卡之外，副作用链之前的运行时
// 第二道）。
export {
  assertEntryTimeBudget,
  assertEntryTokenBudget,
  assertSlugWithinLimit,
} from "./shared/entry-guards.ts";
// 资源发现面（W2③）：discoverResources——agent .md / workflow .js 的多源统一发现
// （ADR-031）——多源扫描 + stem last-writer-wins 合并 + realpath 去重。宿主（zsw
// 回接）经 ScanConfig.hostRoots 注入发现根（source 标签即 ResourceSource 槽位键）；
// 深路径消费在 npm/vendored 发布形态不可达（exports 无
// 深路径通配），故出 barrel。发现链辅助（C5b）：findWorkspaceRoot（project 源根
// 定位）、getCachedParsed/getCachedFileContent（mtime 缓存读取）——getCachedFileContent
// 生产消费在 core 内部 3 处（agents-assembly / config-loader / workflow-script-registry-impl）；
// 壳侧测试 mock 引用不计，深路径同样不可达。conventionRootDirs（约定根路径
// 集合，buildScanTargets 硬编码槽同源单推导）：壳 resource-list-injector 空态
// roots 提示清单消费，杜绝壳侧复刻 join 字面。
export {
  conventionRootDirs,
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
// ⛔2 样本集验证）+ 引用扩展名常量。
// [2026-09-13 barrel 收窄] invalidAgentRefMessage / InvalidAgentRefMessageOptions
// 已出公共面（报错文案工厂仅测试深路径消费，报错文案由 normalizeRef 自带）。
export {
  AGENT_REF_EXT,
  normalizeRef,
  WORKFLOW_REF_EXT,
} from "./shared/agent-ref.ts";

// ── workflow 契约面（U1）──────────────────────────────────────
// workflow 引用规范化（名/路径二分 + 保留字裁决，knownNames 宿主注入——内置
// workflow 名不 core 硬编码）。
// [2026-09-13 barrel 收窄] WORKFLOW_REF_RESERVED_NAMES / NormalizeWorkflowRefOptions /
// NormalizedWorkflowRef / WorkflowRefInvalidReason 已出公共面（定义文件内部
// 类型闭包 + 常量，保留字裁决行为随 normalizeWorkflowRef 本体）。
export { normalizeWorkflowRef } from "./shared/agent-ref.ts";

// ── 注入渲染面（shared/injection-render，W3）───────────────────
// 三段 XML（<available_subagents>/<available_workflows>/<available_provider_models>）
// 的 format 纯函数 + Entry 接口从 pi-sw 插件层下沉（D-3）：ModelEntry 并集口径
// （除 id/name 外全字段 optional，红线 5 守卫不抛不渲垃圾）、分段条目预算
// （码点序排 + 截尾 + 宿主注入兜底指引；models 段无预算永不截，红线 7）、
// guide 文案宿主注入（core 不内嵌平台文案）。summarizeDescription 随
// WorkflowEntry 链导出（zsw 侧同口径消费）。formatEmptyResourceList 为
// subagents/workflows 两段的空发现态渲染（D4-2 空注入显式化）。
export {
  formatAgentList,
  formatEmptyResourceList,
  formatModelList,
  formatWorkflowList,
  sortByCodepoint,
  summarizeDescription,
} from "./shared/injection-render.ts";
export type {
  AgentEntry,
  InvalidResource,
  ModelEntry,
  WorkflowEntry,
} from "./shared/injection-render.ts";
// [2026-09-13 barrel 收窄] ListFormatOptions / ModelListFormatOptions
// 已出公共面（定义文件内部类型闭包或仅测试深路径消费）。
// InvalidResource 随 P5 D4-3 入公共面（workflow-list-injector 经 barrel 消费——
// extensions 源文件只从 barrel 消费 core 符号，H4 formatEmptyResourceList 同款先例）。

// ── 原语（U6a）────────────────────────────────────────────────
// atomic-write：tmp+rename 原子写单一实现（统一 tmp 命名 `.tmp.<pid>.<seq>-<rand>`、
// 失败清理、崩溃残留扫描/清理入口）——core 内部全部写点已收敛于此（U6b）；
// sync/async 两档耐久语义见模块头。bounded-serialize：预算内 JSON 序列化
// （自 pi-sw helpers 平移，输出逐字节一致）。
// [2026-09-13 barrel 收窄] atomicTmpPathFor 与本组类型族（AtomicTmpRef /
// AtomicWriteFileOptions / AtomicWriteOptions / CleanupStaleTmpOptions /
// CleanupStaleTmpResult）已出公共面（类型为定义文件内部闭包，tmp 命名仅测试
// 深路径消费）；cleanupStaleTmpFiles / listStaleTmpFiles / parseAtomicTmpPath
// 为弱活保留项（scripts/probe-third-host-integration.mjs 探针消费）。
export {
  cleanupStaleTmpFiles,
  listStaleTmpFiles,
  parseAtomicTmpPath,
  writeAtomicFile,
  writeAtomicFileSync,
} from "./shared/atomic-write.ts";
export { boundedPrettySerialize } from "./shared/bounded-serialize.ts";

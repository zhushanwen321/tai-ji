// src/execution/engine/routing.ts
//
// 配置路由与探针编排。设计权威源（现行）：
// docs/architecture/subagent-engine-protocolization.md §3.8（缺省引擎与路由）/
// §3.5.3（路由与执行时序契约——「首个 await 前完成路由决策；执行经进程边界」）。
//
// 职责边界：本模块做「选哪个引擎」的决策（纯路由 + probe 编排）与窗口作用域的引擎
// 实例解析（文件尾「窗口实例状态」段，U2——登记/释放机制本体在 window-instances.ts
// [U1]，本模块承载 workflow 域挂载点：runId 键表登记处 + probe/get 取用解析单点），
// 不读任务正文。三层优先级与判定规则集中于此单一权威点——上层（SAR）只消费
// routeEngine 的结果，散落的 if engine === ... 分派被结构性排除。
//
// 路由纪律：三层（调用参数 / agent frontmatter / 全局缺省）任一指定了引擎，运行期
// 就按该引擎执行——不可用即按结构化错误失败，**不换引擎**。换目标等于替调用方改写
// 意图（沙箱类任务被静默卸除安全能力、显式 model 与引擎 provider 绑定被打破），故
// 只有「三层全缺」才落到缺省 pi。
//
// probe 触发时机（D7 的落地口径）：路由期触发、结果缓存于引擎实例（probeCache）。
// 内置缺省 pi 免探——pi 契约稳定且「缺省路径行为零变化」是 A1 硬约束（每次 run 前
// 强探会引入 pi --version 子进程开销与新的失败面）；显式 engine='pi' 同样免探。协议化
// 后 cli 形态引擎的首个 run 前强制 initialize（协议握手，EngineClient 承担），与 probe
// 分立。进程存活期间缓存不失效——版本变化（运行中 CLI 被升级）由 engine_run_failed
// 运行中兜底，重启进程 / 重新注册后重探。

import { getLogger } from "../../core/logger.ts";
import { toErrorMessage } from "../../core/error-message.ts";

import { EngineError } from "./common/errors.ts";
import type { EnginePort } from "./port.ts";
import {
  DEFAULT_ENGINE_ID,
  EngineNotFoundError,
  engineProcessModelOfDescriptor,
  getEngine,
  getEngineDescriptor,
  hasEngine,
  listEngines,
  setActiveWindowEngineDisposer,
} from "./registry.ts";
// [U2 pi-workflow-run-resource-model] 窗口实例解析段（文件尾「窗口实例状态」段）的
// 机制依赖：window-instances 是零依赖叶子模块（U1 交付），与 registry/discovery 的
// 传递闭包无环。
import {
  createWindowEngineInstances,
  isSharedServiceProcessModel,
  type EngineProcessModel,
  type WindowEngineInstance,
  type WindowEngineInstances,
} from "./window-instances.ts";
import {
  ensureEngineDiscovered,
  type DiscoverEnginesOptions,
} from "./engine-discovery-scan.ts";
import type { ProbeReport } from "./types.ts";
import { GLOBAL_SLOT_KEYS } from "../../shared/global-slots.ts";

// core log facade（execution 层统一 "subagents" component，模块顶层缓存惯例）。
const logger = getLogger("subagents");

// ============================================================
// [W8] hasEngine 补扫通道（W4 ensureEngineDiscovered 的存在性校验接线）
// ============================================================

// 补扫发现参数 slot（globalThis[Symbol.for]——防 jiti 双路径加载分裂，对齐 registry
// slot 惯例）。写入方 = 宿主接线面（runtime 在 W8 subagent-engine-history 的
// ensureRuntimeEngineWiring 装载；pi 壳接线归后续单元——slot 未设置时本通道与裸
// hasEngine 等价，零行为变化）。参数与 session_start 发现扫描同源（hostKind/agentDir/
// dataDir），补扫只读 manifest 不握手（DiscoverEnginesOptions 语义）。
const RESCAN_OPTS_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.engineDiscoveryRescanOpts);

/** 宿主接线：登记补扫发现参数（与发现扫描同源；重复登记覆盖，幂等）。 */
export function setEngineDiscoveryRescanOptions(opts: DiscoverEnginesOptions): void {
  Reflect.set(globalThis, RESCAN_OPTS_SLOT_KEY, { current: opts });
}

function getEngineDiscoveryRescanOptions(): DiscoverEnginesOptions | undefined {
  const slot = Reflect.get(globalThis, RESCAN_OPTS_SLOT_KEY) as
    | { current: DiscoverEnginesOptions }
    | undefined;
  return slot?.current;
}

/**
 * 存在性校验（快照优先 + 一次补扫）：registry 快照命中零开销返回；未命中且宿主已
 * 接线补扫参数 → ensureEngineDiscovered 同步补扫（只读 manifest 不 spawn）后复核；
 * 宿主未接线 → 与裸 hasEngine 等价。补扫异常吞掉返回 false（发现失败 ≠ 配置错误，
 * 由 routeEngine 的 engine_not_found 恢复指引收口）。
 */
export function hasEngineWithRescan(id: string): boolean {
  if (hasEngine(id)) return true;
  const opts = getEngineDiscoveryRescanOptions();
  if (opts === undefined) return false;
  try {
    return ensureEngineDiscovered(id, opts);
  } catch (err) {
    logger.debug(
      `[engine-routing] rescan for engine '${id}' failed (treated as not discovered): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// ============================================================
// 三层优先级（D9）
// ============================================================

/** 三层路由的输入（各层值由调用方装配；undefined = 该层不指定）。 */
export interface EngineRoutingInput {
  /** 第一层：调用参数 engine（workflow step 级 / AgentCallOpts.engine）。 */
  callEngine?: string;
  /** 第二层：agent .md frontmatter engine（解析期已对注册表校验）。 */
  agentEngine?: string;
  /** 第三层：全局默认引擎（config.json defaultEngine；缺省 'pi'）。 */
  globalDefaultEngine?: string;
}

/** 生效层标记（守卫 a 的判据：'call' = 显式指定，probe 失败不兜底）。 */
export type EngineRoutingSource = "call" | "frontmatter" | "default";

export interface EngineRouting {
  engineId: string;
  source: EngineRoutingSource;
}

/** 非空文本判据：路由层各配置入口统一口径——undefined 与空串同视为未指定。 */
function hasText(v: string | undefined): v is string {
  return v !== undefined && v !== "";
}

/**
 * 纯三层解析：调用参数 > agent frontmatter > 全局默认（缺省 'pi'）。
 * 不校验注册表（frontmatter 层已前置校验；调用参数层的校验归 routeEngine）——
 * 保持纯函数可独立单测。
 */
export function resolveEngineRouting(input: EngineRoutingInput): EngineRouting {
  if (hasText(input.callEngine)) {
    return { engineId: input.callEngine, source: "call" };
  }
  if (hasText(input.agentEngine)) {
    return { engineId: input.agentEngine, source: "frontmatter" };
  }
  if (hasText(input.globalDefaultEngine)) {
    return { engineId: input.globalDefaultEngine, source: "default" };
  }
  return { engineId: DEFAULT_ENGINE_ID, source: "default" };
}

// ============================================================
// routeEngine：配置路由 + probe 编排（不可用即失败，不换引擎）
// ============================================================

/** routeEngine 的参数（probe/getEngine 注入——测试可 mock，SAR 提供生产实现）。 */
export interface EngineRouteOptions {
  routing: EngineRoutingInput;
  /** 探针执行体（返回 ProbeReport；引擎实例内部有缓存语义）。 */
  probe: (engineId: string) => Promise<ProbeReport>;
  /**
   * 引擎获取（缺省 registry.getEngine；测试/SAR 可注入）。
   *
   * [U2 pi-workflow-run-resource-model] 窗口实例契约：派发窗口作用域的调用方
   * （workflow-dispatch.routeWorkflowEngine）注入的取用解析必须与其 probe **同一
   * 来源同一实例**（probeCache 在实例上；probe 探窗口实例而此处取 registry 单例的
   * 分叉 = 窗口收尾 dispose 掉探过的实例、真正服务 run 的单例反而常驻——G1 静默
   * 回归）。下方 `?? getEngine(engineId)` 兜底只服务：未注入调用方（chat 域，窗口
   * 实例挂载归 U3）与 shared-service 引擎透传（现状保形）。per-window 引擎的
   * fail-fast 防漏改守卫（连接级成员拒答）归 u5 registry D6 改造。
   */
  getEngineFn?: (engineId: string) => EnginePort;
  /** 注册表存在性检查（缺省 registry.hasEngine）。 */
  hasEngineFn?: (engineId: string) => boolean;
  /** 注册表清单（缺省 registry.listEngines——engine_not_found 文案的数据源）。 */
  listEnginesFn?: () => string[];
}

export interface EngineRouteResult {
  engine: EnginePort;
  /** 选中的执行引擎 id（= 三层路由结论；不存在「换了目标」的第二种值）。 */
  engineId: string;
  /** 生效层（调用参数 / frontmatter / 缺省）——错误文案与排障定位用。 */
  source: EngineRoutingSource;
}

/**
 * 路由 + 探针编排（SAR run 入口调用）。
 *
 * 失败形态（全部抛结构化错误，调用方转 AgentResult.error；路由先于 record 创建，
 * 失败不产生半截 record）：
 *   - 请求 id 未注册：EngineNotFoundError（engine_not_found，含来源定位与安装指引）
 *   - probe 失败：EngineError(engine_probe_failed)（含逐项 check 摘要与恢复指引）
 */
export async function routeEngine(opts: EngineRouteOptions): Promise<EngineRouteResult> {
  const { has, get } = resolveRouteHelpers(opts);
  const routing = resolveEngineRouting(opts.routing);

  // 注册表校验：三层任一指定的 id 未注册即配置错误（agent 作者/调用方写错，或引擎包
  // 被卸载）——前置暴露，不换引擎。
  if (!has(routing.engineId)) {
    throw new EngineNotFoundError(routing.engineId, opts.listEnginesFn?.() ?? listEngines(), describeRoutingSource(opts.routing));
  }

  // 内置缺省 pi 免探（见文件头「probe 触发时机」）——直接取引擎
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return directRoute(get(routing.engineId), routing);
  }

  const report = await opts.probe(routing.engineId);
  if (report.ok) {
    return directRoute(get(routing.engineId), routing);
  }

  throw probeFailedError(routing.engineId, report);
}

/**
 * routeEngine 的注入解析。[W8 补扫接线] 缺省存在性校验经 hasEngineWithRescan（快照
 * 未命中触发一次三级补扫，W4 ensureEngineDiscovered 通道——「装了包 → 下次解析即可用」）；
 * 宿主显式注入 hasEngineFn 时以注入值为准（测试 / 宿主自定义通道不变）。
 */
function resolveRouteHelpers(opts: EngineRouteOptions): {
  has: (engineId: string) => boolean;
  get: (engineId: string) => EnginePort;
} {
  return {
    has: opts.hasEngineFn ?? hasEngineWithRescan,
    get: opts.getEngineFn ?? getEngine,
  };
}

/** 直接取用形态（pi 免探 / probe 通过）：请求即执行。 */
function directRoute(engine: EnginePort, routing: EngineRouting): EngineRouteResult {
  return {
    engine,
    engineId: routing.engineId,
    source: routing.source,
  };
}

/** engine_probe_failed 的结构化构造（detail 含逐项检查摘要，recovery 用探针产出）。 */
function probeFailedError(engineId: string, report: ProbeReport): EngineError {
  const checks = report.checks.map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`).join(", ");
  return new EngineError(
    "engine_probe_failed",
    `engine '${engineId}' probe 失败，未自动切换引擎。checks: [${checks}]`,
    (report.error?.recovery ??
      `Confirm the engine binary and version, then re-run the probe (probe({force:true}) or re-initialize the engine).`) +
      ` To run on another engine, pass engine:'<id>' explicitly.`,
  );
}

/** 路由来源描述（EngineNotFoundError 的 source 定位）。 */
function describeRoutingSource(routing: EngineRoutingInput): string | undefined {
  if (hasText(routing.callEngine)) {
    return `call parameter engine='${routing.callEngine}'`;
  }
  if (hasText(routing.agentEngine)) {
    return `agent frontmatter engine='${routing.agentEngine}'`;
  }
  return undefined;
}

// ============================================================
// routeEngineForHost：宿主两调用点的统一编排（D3-② 路由单点）
// ============================================================

/** routeEngineForHost 的参数（宿主装配：本地 pi 引擎 + 路由三件注入）。 */
export interface HostRouteOptions {
  /** 三层路由输入（调用方装配：调用参数 / frontmatter / 全局默认）。 */
  routing: EngineRoutingInput;
  /** 探针执行体（生产 = registry 引擎 .probe()；测试可注入）。 */
  probe: (engineId: string) => Promise<ProbeReport>;
  /**
   * 本地 pi 引擎实例（chat 域 = Service 的 chatPiEngine；workflow 域 = SAR 的 per-session
   * DI 实例）。pi 请求与「兜底回 pi」两种形态都由它接管——不依赖 registry 全局
   * 注册态（单测注入 mock 时全局单例不可见；生产环境两者是同一进程单例对象）。
   */
  piEngine: EnginePort;
  /** 非 pi 引擎获取（缺省 registry.getEngine；测试注入）。 */
  getEngineFn?: (engineId: string) => EnginePort;
  /** 非 pi 注册表存在性检查（缺省 registry.hasEngine）。 */
  hasEngineFn?: (engineId: string) => boolean;
  /** 非 pi 注册表清单（缺省 registry.listEngines）。 */
  listEnginesFn?: () => string[];
}

/**
 * 宿主侧统一路由编排（D3-②：唯一实现，两调用点——SubagentService.execute 与
 * SAR.run）。把原先散在两调用点的「pi 同步短路 + registry 注入（本地 pi 恒可用，
 * engine_not_found 文案不把本地 pi 漏报成未注册）+ 兜底换本地实例」收敛到本函数。
 *
 * 时序契约（W3 改写，设计 §3.5.3）：pi 请求路径**同步返回** EngineRouteResult（非
 * Promise）——**首个 await 前完成路由决策**（engine id 已定，A2 观测点）；其后的执行
 * 经进程边界（cli 形态 spawn + 握手 + 帧往返必经 await），「run 内首个 await 前已触达
 * `executeAndAwait`」的旧时序契约由本设计**作废放宽**。非 pi 路径返回 Promise（probe
 * 编排固有异步），调用方统一用 `routed instanceof Promise ? await routed : routed` 消费
 * （pi 路径零 await）。
 */
export function routeEngineForHost(opts: HostRouteOptions): EngineRouteResult | Promise<EngineRouteResult> {
  const routing = resolveEngineRouting(opts.routing);

  // pi 请求（缺省/显式 pi）：本地 DI 实例同步短路——pi 恒免探，
  // 不经 routeEngine 的 await/probe（「缺省路径行为零变化」A1 硬约束）。
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return {
      engine: opts.piEngine,
      engineId: DEFAULT_ENGINE_ID,
      source: routing.source,
    };
  }

  return routeEngine({
    routing: opts.routing,
    probe: opts.probe,
    // 本地 pi 恒可用（per-session DI 绑定）——get/has/list 注入同一口径：
    // engine_not_found 文案不漏报本地 pi。
    // [U2] 非 pi 分支：注入位 = 窗口实例改道点（窗口作用域调用方经 getEngineFn
    // 注入窗口实例解析，per-window 引擎零 registry 触达；见 HostRouteOptions.
    // getEngineFn 契约注释），`?? getEngine` 兜底只服务未注入调用方与 shared-service
    // 透传。
    getEngineFn: (engineId) =>
      engineId === DEFAULT_ENGINE_ID ? opts.piEngine : (opts.getEngineFn?.(engineId) ?? getEngine(engineId)),
    hasEngineFn: (engineId) =>
      engineId === DEFAULT_ENGINE_ID || (opts.hasEngineFn?.(engineId) ?? hasEngine(engineId)),
    listEnginesFn: () => {
      const listed = opts.listEnginesFn?.() ?? listEngines();
      return listed.includes(DEFAULT_ENGINE_ID) ? listed : [DEFAULT_ENGINE_ID, ...listed];
    },
  });
}

// ============================================================
// 窗口实例状态（pi-workflow-run-resource-model U2）
// ============================================================
//
// 派发窗口作用域的引擎实例登记与收尾释放。设计权威源：ADR-0079 + 技术设计 §3.1
// 机制 2/3、§3.3 决策 1/2、§5 U2；登记/释放机制本体 = window-instances.ts（U1），
// 本段是该机制的 workflow 域挂载点（runId 键表登记处 + 取用解析单点）：
// - 表生命周期随 run：窗口内首次解析引擎时 get-or-create（懒建，lifecycle 不感知）；
//   finalizeRun 五步序列末尾统一 dispose（worker-message-pump coda 内调用
//   disposeWorkflowWindowEngineState——编排侧唯一消费点）。
// - 取用复用面：probe 与实际 run 必须拿到同一实例（probeCache 在实例上；两通道
//   分叉 = probe 探的是窗口实例、run 却走 registry 单例——窗口实例收尾 dispose 后
//   registry 单例反而常驻，G1 静默回归）。消费方（workflow-dispatch 的 probe +
//   getEngineFn 注入、run-orchestration 的 probe）经 resolveWorkflowWindowEnginePort
//   单点解析，禁止各自直连 registry。
//
// 槽位纪律：globalThis[Symbol.for]（registry 同款）——防 jiti 双路径加载分裂
//（development-guide §7.5）：收尾释放与 service 层消费方可能经不同模块实例装载，
// 模块级 Map 会让收尾与登记读不到同一份状态。

/**
 * 单个 workflow run 窗口的引擎实例状态。两份结构同生共死：
 * - instances：U1 窗口实例表（dispose 记账与收尾释放的唯一权威，幂等 disposeAll）；
 * - ports：本窗口已创建的引擎协议本体（engineId → EnginePort，取用复用面）。
 * 表登记与端口写入只在 resolveWorkflowWindowEnginePort 的创建分支成对发生，不存在
 * 单边漂移写点。
 */
export interface WorkflowWindowEngineState {
  readonly instances: WindowEngineInstances;
  readonly ports: Map<string, EnginePort>;
}

const WORKFLOW_WINDOW_STATES_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.workflowWindowEngineStates);

function getWorkflowWindowStates(): Map<string, WorkflowWindowEngineState> {
  // globalThis 无 symbol 索引签名，Reflect 读写（registry getRegistrySlot 同款）。
  let slot = Reflect.get(globalThis, WORKFLOW_WINDOW_STATES_SLOT_KEY) as
    | Map<string, WorkflowWindowEngineState>
    | undefined;
  if (!slot) {
    slot = new Map();
    Reflect.set(globalThis, WORKFLOW_WINDOW_STATES_SLOT_KEY, slot);
  }
  return slot;
}

/**
 * [D6 覆盖重注册触发的反向通知接线] 「dispose 全部活窗口引擎实例」执行体：经
 * registry 广播槽登记（setActiveWindowEngineDisposer——registry 不反向 import 本
 * 模块，零环）。覆盖重注册（引擎包升级换新代码）时对还活着的窗口实例触发 dispose，
 * 不等窗口收尾；窗口后续任务经窗口解析单点按新 descriptor 重建实例（respawn 用新
 * 代码）。逐窗口走 disposeWorkflowWindowEngineState（先摘后放 + 失败收集留痕）。
 */
let activeWindowDisposerRegistered = false;

function ensureActiveWindowDisposerRegistered(): void {
  if (activeWindowDisposerRegistered) return;
  activeWindowDisposerRegistered = true;
  setActiveWindowEngineDisposer(async () => {
    const states = getWorkflowWindowStates();
    for (const runId of [...states.keys()]) {
      await disposeWorkflowWindowEngineState(
        runId,
        "engine-reregistered",
        "registry overwrite (engine package upgraded) — active window instance disposed",
      );
    }
  });
}

/** 取（或懒建）一个 run 窗口的引擎实例状态。窗口起点 = 首次引擎解析，非 run 创建。 */
export function workflowWindowEngineState(runId: string): WorkflowWindowEngineState {
  ensureActiveWindowDisposerRegistered();
  const states = getWorkflowWindowStates();
  let state = states.get(runId);
  if (!state) {
    state = { instances: createWindowEngineInstances(), ports: new Map() };
    states.set(runId, state);
  }
  return state;
}

/**
 * 窗口引擎实例创建通道的注入缝（进程形态判别 + 不经 registry 的实例创建）。
 *
 * 生产缺省 = **真实实现**（u5 网关真实化，ADR-0079 D6/§5 网关真实化升级目标）：
 * processModelOf 读 manifest 注册期快照（u-foundation 解析面：descriptor.manifest.
 * processModel，缺省 per-window）；createPort 经 descriptor portFactory 产出不经
 * registry singletons 缓存的新实例（实例登记与收尾归窗口状态，本通道零 singletons
 * 触达）。测试可注入替身网关（注入覆盖生产缺省——u2/u3 验收用例形态）。
 *
 * 形态判定规则（engineProcessModelOfDescriptor 单源）：cli descriptor 按声明值
 * （缺省 per-window）；inproc 过渡形态 / 未注册 id → 'shared-service'——前者走
 * registry 单例路径现状保形，后者经 getEngine 抛既有 EngineNotFoundError（安装指引）。
 */
export interface WorkflowWindowEngineGateway {
  /** 引擎进程形态判别（实例创建之前分流——避免为 shared-service 产出有副作用实例再丢弃）。 */
  processModelOf(engineId: string): EngineProcessModel;
  /** per-window 引擎实例创建（必须产出不经 registry singletons 缓存的新实例）。 */
  createPort(engineId: string): EnginePort;
}

const productionWorkflowWindowEngineGateway: WorkflowWindowEngineGateway = {
  processModelOf(engineId: string): EngineProcessModel {
    return engineProcessModelOfDescriptor(getEngineDescriptor(engineId));
  },
  createPort(engineId: string): EnginePort {
    const descriptor = getEngineDescriptor(engineId);
    if (descriptor === undefined) {
      // per-window 创建分支的未注册 id：与透传路径同错误形态（含安装指引）。
      throw new EngineNotFoundError(engineId, listEngines());
    }
    if (descriptor.kind !== "cli") {
      // inproc 形态被 engineProcessModelOfDescriptor 判 shared-service，创建分支不可达；
      // 防御保留（创建点出声而非静默半个实例的纪律）。
      throw new EngineNotFoundError(engineId, listEngines());
    }
    // portFactory 闭包每次产出新 EngineClient + RemoteEngine——不经 singletons 缓存，
    // 实例生命周期归窗口状态（登记进窗口表、收尾统一 dispose）。
    return descriptor.portFactory();
  },
};

const WORKFLOW_WINDOW_GATEWAY_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.workflowWindowEngineGateway);

/** 宿主/测试注入窗口引擎网关（undefined = 回落生产缺省，保守透传）。 */
export function setWorkflowWindowEngineGateway(gateway: WorkflowWindowEngineGateway | undefined): void {
  Reflect.set(globalThis, WORKFLOW_WINDOW_GATEWAY_SLOT_KEY, { current: gateway });
}

function resolveWorkflowWindowEngineGateway(): WorkflowWindowEngineGateway {
  const slot = Reflect.get(globalThis, WORKFLOW_WINDOW_GATEWAY_SLOT_KEY) as
    | { current: WorkflowWindowEngineGateway | undefined }
    | undefined;
  return slot?.current ?? productionWorkflowWindowEngineGateway;
}

/**
 * 窗口作用域引擎解析单点（probe 通道与 getEngineFn 注入的同一来源）：
 * - per-window 引擎 + 窗口已知：首触创建（网关 createPort）并登记进 U1 表，后续复用
 *   同一实例——零 registry 触达；
 * - shared-service 引擎（或窗口未知——chat 域轮窗口归 U3 接线）：透传 registry
 *   getEngine 单例路径（现状保形；实例表 register 对该形态 no-op 兜漏判）。
 */
export function resolveWorkflowWindowEnginePort(
  windowRunId: string | undefined,
  engineId: string,
): EnginePort {
  const state = windowRunId !== undefined ? workflowWindowEngineState(windowRunId) : undefined;
  const cached = state?.ports.get(engineId);
  if (cached) return cached;
  const gateway = resolveWorkflowWindowEngineGateway();
  const processModel = gateway.processModelOf(engineId);
  if (state !== undefined && !isSharedServiceProcessModel(processModel)) {
    const port = gateway.createPort(engineId);
    state.ports.set(engineId, port);
    const instance: WindowEngineInstance = {
      engineId,
      processModel,
      // 引擎停机面委托 EnginePort.dispose（dispose 请求 → 按进程组终止兜底，P2）。
      // dispose 缺席的引擎实例无可释放资源，disposeAll 对其 await undefined 即过。
      dispose: () => port.dispose?.(),
    };
    state.instances.register(instance);
    return port;
  }
  return getEngine(engineId);
}

/**
 * 收尾释放一个 run 窗口的全部引擎实例（worker-message-pump finalizeRun 五步序列
 * 末尾的唯一生产调用点）。
 */
export async function disposeWorkflowWindowEngineState(
  runId: string,
  reason: string,
  context: string,
): Promise<void> {
  const states = getWorkflowWindowStates();
  const state = states.get(runId);
  if (state === undefined) return;
  // 先摘后放：与 U1 disposeAll 的「先清空后遍历」叠加，重复收尾构造性 no-op。
  states.delete(runId);
  state.ports.clear();
  const failures = await state.instances.disposeAll();
  for (const failure of failures) {
    logger.error(
      `[engine-routing] window engine dispose failed (runId=${runId}, reason=${reason}, ` +
        `context=${context}): ${toErrorMessage(failure)}`,
    );
  }
}

/**
 * 测试隔离：清空全部窗口状态 + 网关注入（setRunEventJournalDirForTest 同款 teardown
 * 纪律）。生产禁用——进程内窗口状态是全局状态。
 */
export function resetWorkflowWindowEngineStatesForTest(): void {
  getWorkflowWindowStates().clear();
  setWorkflowWindowEngineGateway(undefined);
}

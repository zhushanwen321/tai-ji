// src/execution/engine/routing.ts
//
// 配置路由与探针 fallback 编排（P4；W3 协议化改造）。设计权威源（现行）：
// docs/architecture/subagent-engine-protocolization.md §3.8 D4（缺省引擎与 fallback 目标）/
// §3.5.3（路由与执行时序契约——跨进程后作废「run 内首个 await 前已触达 executeAndAwait」，
// 改为「首个 await 前完成路由决策；执行经进程边界，时序契约由本设计放宽」）；
// 历史权威源 docs/architecture/subagent-engine-abstraction.md D9（配置路由三层 + 故障
// fallback 三守卫 + model/engine 正交 + workflow 脚本不写死 engine）+ D7（探针分级与
// 触发时机）+ §3.3.3 错误规格仍然有效。
//
// 职责边界：本模块只做「选哪个引擎」的决策（纯路由 + probe 编排），不 spawn、不读
// 任务正文。三层优先级与守卫的判定规则集中于此单一权威点——上层（SAR）只消费
// routeEngine 的结果，散落的 if engine === ... 分派被结构性排除。
//
// probe 触发时机（D7 的落地口径）：路由期触发、结果缓存于引擎实例（probeCache）。
// 内置缺省 pi 免探——pi 契约稳定且「缺省路径行为零变化」是 A1 硬约束（每次 run 前
// 强探会引入 pi --version 子进程开销与新的失败面）；显式 engine='pi' 同样免探
// （fallback 无处可去，守卫 a 对 pi 不可达是自然结果而非缺口）。协议化后 cli 形态
// 引擎的首个 run 前强制 initialize（协议握手，EngineClient 承担），与 probe 分立。
// 进程存活期间缓存不失效——版本变化（运行中 CLI 被升级）由 engine_run_failed 运行中
// 兜底，重启进程 / 重新注册后重探。

import { getLogger } from "../../core/logger.ts";

import { EngineError } from "./common/errors.ts";
import type { EnginePort } from "./port.ts";
import {
  DEFAULT_ENGINE_ID,
  EngineNotFoundError,
  getEngine,
  hasEngine,
  listEngines,
  listEnginesByDisplayName,
} from "./registry.ts";
import {
  ensureEngineDiscovered,
  type DiscoverEnginesOptions,
} from "./engine-discovery-scan.ts";
import type { ProbeReport } from "./types.ts";

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
const RESCAN_OPTS_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagent-workflow.engineDiscoveryRescanOpts");

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
// routeEngine：probe 编排 + fallback 三守卫（D9①/D7）
// ============================================================

/** routeEngine 的参数（probe/getEngine 注入——测试可 mock，SAR 提供生产实现）。 */
export interface EngineRouteOptions {
  routing: EngineRoutingInput;
  /**
   * 显式 model（守卫 c 判据：model 与引擎 provider 体系绑定，D9②）。短名 model 的
   * provider 缺省决策在 zcode preparer 的 defaultProviderForShortName——显式默认引擎
   * 模型配置（config.json per-engine model）引入时，两处须同步让位配置值优先
   * （对齐点⑦，详见 preparer.ts 该函数注释）。
   */
  taskModel?: string;
  /** engineRouting.strict（config.json）：true = 一切 probe 失败直接报错。 */
  strict: boolean;
  /** 探针执行体（返回 ProbeReport；引擎实例内部有缓存语义）。 */
  probe: (engineId: string) => Promise<ProbeReport>;
  /** 引擎获取（缺省 registry.getEngine；测试/SAR 可注入）。 */
  getEngineFn?: (engineId: string) => EnginePort;
  /** 注册表存在性检查（缺省 registry.hasEngine）。 */
  hasEngineFn?: (engineId: string) => boolean;
  /** 注册表清单（缺省 registry.listEngines——engine_not_found 文案的数据源）。 */
  listEnginesFn?: () => string[];
  /**
   * 可用引擎清单（D4 回落目标序：manifest displayName 稳定序；缺省
   * registry.listEnginesByDisplayName）。清单内 id 即视为可用（发现且已注册）——
   * 调用方负责排序口径；routeEngine 按序取第一个 ≠ 请求引擎的 id 作回落目标。
   */
  listAvailableEnginesFn?: () => string[];
}

export interface EngineRouteResult {
  engine: EnginePort;
  /** 实际执行引擎 id（fallback 后可能 ≠ 请求值）。 */
  engineId: string;
  /** 路由决策时的请求引擎 id（fallback 留痕的 from 值）。 */
  requestedEngineId: string;
  /** 生效层（守卫 a 判据的留痕）。 */
  source: EngineRoutingSource;
  /** fallback 留痕（record/outcome 投影，GUI 警告条数据源）。无 fallback 缺省。 */
  engineFallback?: { from: string; reason: string };
}

/**
 * D4 缺省引擎回落（default 层专用）：配置的缺省引擎 id 不在已发现清单（引擎被卸载 /
 * 未安装任何引擎包）→ warn + 回落第一个可用引擎（manifest displayName 稳定序）+
 * engineFallback 留痕（record 投影）。全不可用（清单空）→ 返回 undefined，调用方抛
 * engine_not_found（「未发现任何引擎包」+ 安装指引），不静默。
 *
 * 宽容回落只作用于 default 层：call/frontmatter 层显式指定的未知 id 是配置错误
 * （agent 作者/调用方写错），保持 engine_not_found 前置暴露（错误规格表第 1 行）——
 * 静默换引擎会违反显式意图（守卫 a 同源）。
 */
function resolveDefaultEngineFallback(
  requestedId: string,
  available: readonly string[],
): { engineId: string; fallback: { from: string; reason: string } } | undefined {
  if (available.length === 0) return undefined;
  const target = available[0]!;
  logger.warn(
    `[engine-routing] default engine '${requestedId}' is not in the discovered engines ` +
      `[${available.join(", ")}]; falling back to first available engine '${target}' (D4, recorded via engineFallback)`,
  );
  return { engineId: target, fallback: { from: requestedId, reason: "engine_not_found" } };
}

/**
 * 路由 + 探针 + fallback 编排（SAR run 入口调用）。
 *
 * 失败形态（全部抛结构化错误，调用方转 AgentResult.error）：
 *   - 未注册 id（call/frontmatter 层）：EngineNotFoundError（engine_not_found）
 *   - default 层缺省引擎不在清单且无任何可用引擎：EngineNotFoundError
 *     （「未发现任何引擎包」+ 安装指引，D4）
 *   - strict 或守卫命中：EngineError(engine_probe_failed)
 *   - 守卫 c（显式 model + 将换引擎）：EngineError(model_not_available)
 */
export async function routeEngine(opts: EngineRouteOptions): Promise<EngineRouteResult> {
  const { has, get, available } = resolveRouteHelpers(opts);
  const routing = resolveEngineRouting(opts.routing);

  // 注册表校验：call/frontmatter 层未知 id 直接报（配置错误前置暴露）；default 层走
  // D4 宽容回落（配置的缺省引擎被卸载 ≠ 用户写错 id——环境变化，回落 + 留痕）。
  if (!has(routing.engineId)) {
    return resolveUnregisteredEngine(opts, routing, get, available);
  }

  // 内置缺省 pi 免探（见文件头「probe 触发时机」）——直接取引擎
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return directRoute(get(routing.engineId), routing);
  }

  const report = await opts.probe(routing.engineId);
  if (report.ok) {
    return directRoute(get(routing.engineId), routing);
  }

  return resolveProbeFailedRoute(opts, routing, get, available, report);
}

/**
 * routeEngine 的注入解析。[W8 补扫接线] 缺省存在性校验经 hasEngineWithRescan（快照
 * 未命中触发一次三级补扫，W4 ensureEngineDiscovered 通道——「装了包 → 下次解析即可用」）；
 * 宿主显式注入 hasEngineFn 时以注入值为准（测试 / 宿主自定义通道不变）。
 */
function resolveRouteHelpers(opts: EngineRouteOptions): {
  has: (engineId: string) => boolean;
  get: (engineId: string) => EnginePort;
  available: () => string[];
} {
  return {
    has: opts.hasEngineFn ?? hasEngineWithRescan,
    get: opts.getEngineFn ?? getEngine,
    available: opts.listAvailableEnginesFn ?? listEnginesByDisplayName,
  };
}

/**
 * 注册表校验失败（请求 id 未发现）的收口：default 层 D4 宽容回落（清单空 → throw
 * 「未发现任何引擎包」+ 安装指引，不静默）；call/frontmatter 层配置错误前置暴露。
 */
function resolveUnregisteredEngine(
  opts: EngineRouteOptions,
  routing: EngineRouting,
  get: (engineId: string) => EnginePort,
  available: () => string[],
): EngineRouteResult {
  if (routing.source !== "default") {
    throw new EngineNotFoundError(routing.engineId, opts.listEnginesFn?.() ?? listEngines(), describeRoutingSource(opts.routing));
  }
  const fallback = resolveDefaultEngineFallback(routing.engineId, available());
  if (fallback === undefined) {
    // 全不可用：派发期 engine_not_found（「未发现任何引擎包」+ 安装指引，D4）
    throw new EngineNotFoundError(routing.engineId, [], describeRoutingSource(opts.routing));
  }
  const fallbackTrace = fallback.fallback;
  // 回落目标直接取用不探（probe 已失败一次不重复；目标引擎不可用由 run 期显式失败）
  return {
    engine: get(fallback.engineId),
    engineId: fallback.engineId,
    requestedEngineId: fallbackTrace.from,
    source: routing.source,
    engineFallback: fallbackTrace,
  };
}

/** 直接取用形态（pi 免探 / probe 通过）：请求即执行，无 fallback 留痕。 */
function directRoute(engine: EnginePort, routing: EngineRouting): EngineRouteResult {
  return {
    engine,
    engineId: routing.engineId,
    requestedEngineId: routing.engineId,
    source: routing.source,
  };
}

/**
 * probe 失败收口：strict / 三守卫 / fallback（D9① + D4 回落目标改「首个可用引擎」）。
 */
function resolveProbeFailedRoute(
  opts: EngineRouteOptions,
  routing: EngineRouting,
  get: (engineId: string) => EnginePort,
  available: () => string[],
  report: ProbeReport,
): EngineRouteResult {
  if (opts.strict) {
    throw probeFailedError(routing.engineId, report, "engineRouting.strict=true：probe 失败一律报错（不 fallback）");
  }
  // 守卫 a/b（首期合流）：显式指定（调用参数或 step 级）= 能力依赖声明，静默换引擎
  // 违反意图——沙箱类任务被静默卸除安全能力正是要防的形态（D9① 原文）。守卫 b 的
  // 独立载体（合流形状 AgentCallOpts 上的能力依赖声明字段，requires 已随 D6 裁撤）
  // 下钻后在本分支前独立判定，首期显式 engine 即声明。
  if (routing.source === "call") {
    throw probeFailedError(routing.engineId, report, "engine 来自调用参数显式指定（能力依赖声明）——不兜底");
  }

  const fallbackId = fallbackTargetId(opts.routing, routing, available());
  // D4：无可用引擎则不 fallback（直接报错）——回「未发现任何引擎包」口径，不静默
  if (fallbackId === undefined) {
    throw probeFailedError(routing.engineId, report, "probe 失败且无其他可用引擎可兜底（D4：不原地重试坏引擎）");
  }
  // 守卫 c：显式 model 与引擎 provider 体系绑定（D9② model/engine 正交）——换引擎
  // 后 model 可解析性无法保证，静默换引擎跑 = 「以为用了 X 实际用 Y」。判定取保守
  // 口径（显式 model + 引擎切换即拒）：路由层无各引擎 provider 注册表的访问面，
  // 精确可解析性判定归引擎 prepare 期（ZcodePrepareError.model_not_available 已有）。
  if (hasText(opts.taskModel) && fallbackId !== routing.engineId) {
    throw new EngineError(
      "model_not_available",
      `engine '${routing.engineId}' probe 失败且任务显式指定 model '${opts.taskModel}'——model 与引擎 provider 体系绑定，换引擎（fallback 到 '${fallbackId}'）不静默执行`,
      `修复 engine '${routing.engineId}' 的探针失败（见上方恢复指引）后重试，或去掉 model 指定 / 显式传 engine: '${fallbackId}' 确认模型可用后再派发`,
    );
  }

  return {
    engine: get(fallbackId),
    engineId: fallbackId,
    requestedEngineId: routing.engineId,
    source: "default",
    engineFallback: { from: routing.engineId, reason: "engine_probe_failed" },
  };
}

/**
 * fallback 目标（D4 终态语义：恒 'pi' 改「首个可用引擎」，无可用引擎返回 undefined
 * 由调用方直接报错不 fallback）。available = D4 排序清单（manifest displayName 稳定序）。
 *
 * - 请求来自 frontmatter/调用参数：优先全局默认引擎（可用且 ≠ 刚失败引擎时）；
 *   全局默认不可用/未配置/即请求引擎 → 首个可用引擎（排除 from——回退到刚 probe
 *   失败的同一引擎 = 原地重试坏引擎，from==to 误导留痕）。
 * - 请求即全局默认（defaultEngine 配了坏引擎，source='default'）：首个可用引擎。
 * - 清单排除 from 后为空 → undefined（无可用引擎，直接报错）。
 */
function fallbackTargetId(
  routingInput: EngineRoutingInput,
  resolved: EngineRouting,
  available: readonly string[],
): string | undefined {
  // source 与 engineId 由 resolved 承载配对关系，杜绝调用方传错配对的口子
  if (resolved.source !== "default") {
    const global = routingInput.globalDefaultEngine;
    if (hasText(global) && global !== resolved.engineId && available.includes(global)) {
      return global;
    }
  }
  return available.find((id) => id !== resolved.engineId);
}

/** engine_probe_failed 的结构化构造（detail 含逐 check 摘要，recovery 用探针产出）。 */
function probeFailedError(engineId: string, report: ProbeReport, guard: string): EngineError {
  const checks = report.checks.map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`).join(", ");
  return new EngineError(
    "engine_probe_failed",
    `engine '${engineId}' probe 失败（${guard}）。checks: [${checks}]`,
    report.error?.recovery ??
      `Confirm the engine binary and version, then re-run the probe (probe({force:true}) or re-initialize the engine).`,
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
  /**
   * 守卫 c 判据：调用方显式指定的 model（与 routeEngine.taskModel 同口径——解析后的
   * 兼底 model 恒非空会把一切兜底误判为 model 绑定命中，故只传显式值）。
   */
  taskModel?: string;
  /** engineRouting.strict（config.json）：true = 一切 probe 失败直接报错。 */
  strict: boolean;
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
  /** D4 可用引擎清单（缺省 registry.listEnginesByDisplayName；透传 routeEngine）。 */
  listAvailableEnginesFn?: () => string[];
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

  // pi 请求（缺省/显式 pi）：本地 DI 实例同步短路——pi 恒免探、无 fallback 可言，
  // 不经 routeEngine 的 await/probe（「缺省路径行为零变化」A1 硬约束）。
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return {
      engine: opts.piEngine,
      engineId: DEFAULT_ENGINE_ID,
      requestedEngineId: DEFAULT_ENGINE_ID,
      source: routing.source,
    };
  }

  return routeEngine({
    routing: opts.routing,
    taskModel: opts.taskModel,
    strict: opts.strict,
    probe: opts.probe,
    // 本地 pi 恒可用（per-session DI 绑定）——get/has/list 注入同一口径：
    // probe 失败兜底时取本地实例接管，engine_not_found 文案不漏报本地 pi。
    getEngineFn: (engineId) =>
      engineId === DEFAULT_ENGINE_ID ? opts.piEngine : (opts.getEngineFn?.(engineId) ?? getEngine(engineId)),
    hasEngineFn: (engineId) =>
      engineId === DEFAULT_ENGINE_ID || (opts.hasEngineFn?.(engineId) ?? hasEngine(engineId)),
    listEnginesFn: () => {
      const listed = opts.listEnginesFn?.() ?? listEngines();
      return listed.includes(DEFAULT_ENGINE_ID) ? listed : [DEFAULT_ENGINE_ID, ...listed];
    },
    // D4 可用清单透传（缺省 displayName 稳定序；注入缺失时本地 pi 仍须在清单内，
    // 否则 fallback「首个可用引擎」会把本地 pi 漏掉）
    listAvailableEnginesFn: () => {
      const available = opts.listAvailableEnginesFn?.() ?? listEnginesByDisplayName();
      return available.includes(DEFAULT_ENGINE_ID) ? available : [DEFAULT_ENGINE_ID, ...available];
    },
  });
}

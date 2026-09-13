// src/execution/engine/registry.ts
//
// 引擎注册表（P1；W3 协议化改造）。设计权威源（现行）：
// docs/architecture/subagent-engine-protocolization.md §3.4 发现与注册 / §3.8 D1（EngineDescriptor
// 双模）+ D4（缺省引擎与 fallback 目标）；实现级规格 impl-plan §2.3。历史权威源
// docs/architecture/subagent-engine-abstraction.md §3.3.1/§3.3.3（engine_not_found 错误
// 规格第 1 行）仍然有效。
//
// 为什么需要注册表：引擎身份是「spawn 细节的归属边界」——上层（配置路由/agent 解析）
// 按 id 取引擎，不感知实现类；新引擎接入 = 装一个引擎包（manifest 自注册，W4 发现器
// 装载）或登记一行 inproc 工厂（过渡期），不改上层与既有引擎。
//
// 双模 descriptor（D1）：`{kind:"inproc", factory}`（过渡期——内建 pi/zcode，DoD#5 后
// 随 inproc 分支删除）与 `{kind:"cli", command, args, capabilities, portFactory}`（目标——
// 独立引擎 CLI 包，port 由 W2 RemoteEngine 承担）。上层 getEngine(id) 返回代理，两形态
// 透明：cli descriptor 首次使用才经 portFactory 解析（构造同步、缺包/坏包不在构造期
// throw，§3.5.3 代理形态），失败形态 = 首次协议调用的结构化错误。
//
// 依赖方向（贯穿纪律，协议化后不变）：registry 只依赖 port/types 的类型与 SDK 的
// modelCatalog 条目类型，不 import 任何具体引擎或协议客户端（client/）——cli 形态的
// port 装配（RemoteEngine + EngineClient + 宿主侧参数）归 portFactory 注入方（W4 发现器
// 装载 descriptor 时装配），registry 只持类型与惰性代理。（core/logger 是 facade 基础
// 设施非引擎，dispose best-effort 记日志需要它，不违反本纪律。）

import { getLogger } from "../../core/logger.ts";
import type { ModelCatalogEntry } from "@zhushanwen/subagent-engine-sdk";

import type { EngineCapabilities } from "./types.ts";
import type { EnginePort } from "./port.ts";

// core log facade（execution 层统一 "subagents" component，模块顶层缓存惯例）。
const logger = getLogger("subagents");

/** 引擎工厂：惰性创建引擎实例（getEngine 首次取用时执行）。 */
export type EngineFactory = () => EnginePort;

/**
 * 引擎包 manifest 注册期快照（session_start 扫描所得，非握手缓存——设计 §3.3「同步
 * 成员清单」单一同步源原则）。descriptor 携带，cli 形态 port（RemoteEngine）的同步
 * 成员（capabilities/listModels/validateModel）直读本快照。
 *
 * 与 client/remote-engine.ts 的 RemoteEngineManifestSnapshot 是结构闭包（后者多出
 * core 中立类型包装；漂移由 protocol-closure 同族结构互证断言守卫）。
 */
export interface EngineManifestSnapshot {
  /** manifest `capabilities`（同步能力位权威，注册期读，无缓存）。 */
  capabilities: EngineCapabilities;
  /**
   * manifest `modelCatalog` 三态（W4 §2.4：缺省 = 不注入保持 undefined；null 合法等价
   * 省略；`models: []` 仅作者显式声明）。解析器不得把省略填成 `[]`——否则「无枚举面」
   * 语义不可达。
   */
  modelCatalog?: { dynamic: boolean; models: ModelCatalogEntry[] } | null;
  /** manifest `displayName`（可选，缺省 = id；D4 缺省引擎回落序的排序键）。 */
  displayName?: string;
}

/** cli 形态 descriptor（目标形态）：引擎 CLI 启动参数 + manifest 快照 + port 装配器。 */
export interface CliEngineDescriptor {
  kind: "cli";
  /** 引擎 CLI 命令（发现器解析后的绝对路径/可执行名；不依赖 PATH）。 */
  command: string;
  /** 引擎 CLI 参数（不含 command 本身）。 */
  args: readonly string[];
  /** manifest `capabilities`（同步能力位权威——gate 同步消费，无缓存）。 */
  capabilities: EngineCapabilities;
  /**
   * cli 形态 EnginePort 实例装配器（core 侧接线通道，非 manifest 面）。生产 = W4
   * 发现器装载 descriptor 时装配（W2 `RemoteEngine` + `EngineClient` + 宿主侧参数
   * dataDir/hostKind/engineConfig 等——registry 不越权猜宿主形态）。必须构造同步、
   * 不 throw（§3.5.3 代理形态：缺包/坏包的失败推迟到首次协议调用）。
   */
  portFactory: EngineFactory;
  /** manifest 快照余项（modelCatalog/displayName；capabilities 已提升为直读字段）。 */
  manifest?: Omit<EngineManifestSnapshot, "capabilities">;
}

/** inproc 形态 descriptor（过渡期）：内建引擎工厂。DoD#5 后随 inproc 分支删除。 */
export interface InprocEngineDescriptor {
  kind: "inproc";
  factory: EngineFactory;
}

/** D1 双模引擎描述符：inproc（过渡期）/ cli（目标）。上层经 getEngine 拿代理，两形态透明。 */
export type EngineDescriptor = InprocEngineDescriptor | CliEngineDescriptor;

/**
 * 缺省引擎 id（D4 重定义：**配置的缺省引擎 id**——config defaultEngine 未配置时的
 * 归一名，不再表达「内置 pi 永久兜底」）。配置值不在已发现清单 → warn + 回落第一个
 * 可用引擎（manifest displayName 稳定序，D4）；全不可用 → 派发期 engine_not_found
 * （「未发现任何引擎包」+ 安装指引）。
 */
export const DEFAULT_ENGINE_ID = "pi";

/**
 * defaultEngine 缺省归一（单一权威源）：空白 / undefined 归一到缺省引擎（'pi'）。
 * 引擎感知检测 diff 与状态段渲染必须对同一读取结果给出同一引擎 id——若两处各自
 * 内联归一，一致性只靠注释人工耦合，漂移即两处说谎；故收敛到本函数供各处调用。
 * sanitize 保证透传值非空，但可能带首尾空格，故 trim 后再判。
 */
export function normalizeEngineId(engine: string | undefined): string {
  return engine?.trim() || DEFAULT_ENGINE_ID;
}

/**
 * engine_not_found（错误规格表第 1 行）：请求的引擎 id 无对应注册/发现结果。
 * 错误文案契约：含已注册引擎清单 + 配置文件指引——配置错误前置暴露（agent 解析期），
 * 不留到运行时神秘失败。
 *
 * D4 全不可用文案：清单为空（未发现任何引擎包）时追加安装指引——此时问题不是 id
 * 写错，而是环境里没有任何引擎包可派发，恢复动作 = 装引擎包/配发现根，不是改 typo。
 */
export class EngineNotFoundError extends Error {
  /** 结构化错误码（错误规格表的 code 列，供调用方程序化分流）。 */
  readonly code = "engine_not_found";
  /** 请求的（未注册的）引擎 id。 */
  readonly engineId: string;
  /** 请求时刻的已注册清单快照（防错误对象跨时间读 Map 的失真）。 */
  readonly registered: readonly string[];
  /** 错误来源定位（agent .md 文件路径 / 配置键等；运行期 getEngine 无来源不传）。 */
  readonly source: string | undefined;

  constructor(engineId: string, registered: readonly string[], source?: string) {
    super(
      `engine_not_found: engine '${engineId}' is not registered. ` +
        `Registered engines: ${registered.length > 0 ? registered.join(", ") : "(none)"}. ` +
        (registered.length === 0
          ? `No engine packages were discovered. ` +
            `Recovery: install an engine package (e.g. @zhushanwen/pi-subagent-cli / @zhushanwen/zcode-subagent-cli), ` +
            `or add its location to XYZ_AGENT_ENGINE_ROOTS / subagents/config.json engines section.`
          : `Recovery: check the engine id in the agent .md frontmatter (engine: field) or the global ` +
            `default engine setting, fix the typo, or install/register the engine first ` +
            `(registered engines are listed above).`) +
        (source !== undefined ? ` Source: ${source}.` : ""),
    );
    this.name = "EngineNotFoundError";
    this.engineId = engineId;
    this.registered = registered;
    this.source = source;
  }
}

/**
 * id → descriptor（注册表本体）+ id → 惰性单例（getEngine 首次取用创建；重复注册
 * 覆盖时丢弃旧实例）。进程级单例状态，用 globalThis[Symbol.for] 持有防 jiti 双路径
 * 加载分裂（development-guide §7.5），不用模块级 const。
 */
const ENGINE_REGISTRY_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagent-workflow.engineRegistry");

/** 注册表槽位形状（同文件唯一写入点，运行时保证）。 */
interface EngineRegistrySlot {
  descriptors: Map<string, EngineDescriptor>;
  singletons: Map<string, EnginePort>;
}

function getRegistrySlot(): EngineRegistrySlot {
  // globalThis 无 symbol 索引签名，但运行时支持 symbol 键——用 Reflect 安全读写，
  // 避免双重断言（同 model-config-service.ts 先例）。
  let slot = Reflect.get(globalThis, ENGINE_REGISTRY_SLOT_KEY) as EngineRegistrySlot | undefined;
  if (!slot) {
    slot = { descriptors: new Map(), singletons: new Map() };
    Reflect.set(globalThis, ENGINE_REGISTRY_SLOT_KEY, slot);
  }
  return slot;
}

/** descriptor → port 装配器（两形态透明收敛点：inproc = factory，cli = portFactory）。 */
function portFactoryOf(descriptor: EngineDescriptor): EngineFactory {
  return descriptor.kind === "inproc" ? descriptor.factory : descriptor.portFactory;
}

/**
 * [R1 D6] 触发引擎 dispose：同步调用拿 Promise 不 await（「触发不等待」，D6①——
 * dispose 的同步面〔fire close 帧 + 同步 SIGTERM〕由引擎实现保证在返回 Promise 前
 * 完成，registry 不等待异步段）。同步 throw 与异步 reject 均记日志吞掉，绝不外溢
 * 阻断调用方——重注册替换（D6②）与宿主收割（D6③）都是 best-effort 面，且 reject
 * 无人接会成为 unhandledRejection 崩宿主。两条 dispose 路径共用本函数。
 */
function triggerEngineDispose(engine: EnginePort, source: string): void {
  if (typeof engine.dispose !== "function") return;
  try {
    engine.dispose().then(undefined, (err: unknown) => {
      logger.warn(
        `[engine-registry] engine '${engine.id}' dispose rejected (${source}, best-effort continue): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  } catch (err) {
    logger.warn(
      `[engine-registry] engine '${engine.id}' dispose threw synchronously (${source}, best-effort continue): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * 登记引擎工厂（inproc 快捷形态，等价 registerEngineDescriptor(id, {kind:"inproc", factory})）。
 * 重复注册同一 id = 覆盖（组合根可能多次执行，如每次 session_start 重跑 registerPiEngine
 * ——幂等覆盖保证不炸也不堆积），覆盖时丢弃缓存的旧单例，让下一次 getEngine 用新
 * descriptor 重建。
 *
 * [R1 D6②] 覆盖前对已实例化的旧单例触发 dispose（防泄漏——旧实例可能持有常驻进程/
 * 长连接）；触发不等待 + 失败不阻断（见 triggerEngineDispose），幂等覆盖语义不变。
 */
export function registerEngine(id: string, factory: EngineFactory): void {
  registerEngineDescriptor(id, { kind: "inproc", factory });
}

/**
 * 登记引擎 descriptor（D1 双模注册入口）。inproc（过渡期内建引擎）与 cli（引擎包，
 * portFactory 由发现器装配）两形态；覆盖语义与 dispose 触发同 registerEngine。
 */
export function registerEngineDescriptor(id: string, descriptor: EngineDescriptor): void {
  const slot = getRegistrySlot();
  const previous = slot.singletons.get(id);
  if (previous) triggerEngineDispose(previous, `registerEngineDescriptor('${id}') overwrite`);
  slot.descriptors.set(id, descriptor);
  slot.singletons.delete(id);
}

/**
 * [R1 D6③] 对已实例化的引擎单例触发 dispose（触发不等待）。宿主唯一收割入口
 * （session-runner killAllSpawnedChildren）在杀 per-record children 之前调用——
 * 常驻进程的回收归引擎 dispose，本函数只负责按序触发。
 *
 * 只遍历 singletons：已实例化才可能持有常驻资源，绝不经 getEngine 实例化未用
 * 引擎（停机路径反向创建资源违背停机语义）。dispose 后不删单例——幂等与
 * 「dispose 后首个 run 自动重建」由引擎实现承诺（§3.4 不变量 4），registry
 * 不越权管理引擎内部生命周期。
 */
export function disposeEngines(): void {
  for (const engine of getRegistrySlot().singletons.values()) {
    triggerEngineDispose(engine, "disposeEngines()");
  }
}

/**
 * 按 id 取引擎代理（两形态透明）。惰性单例：descriptor 首次使用才解析（inproc 工厂
 * / cli portFactory 都是此刻才调用——构造同步、缺包/坏包不在本函数期 throw，§3.5.3
 * 代理形态；cli 形态实例 = W2 RemoteEngine，失败形态是首次协议调用的结构化错误）。
 */
export function getEngine(id: string): EnginePort {
  const slot = getRegistrySlot();
  const cached = slot.singletons.get(id);
  if (cached) return cached;
  const descriptor = slot.descriptors.get(id);
  if (!descriptor) {
    throw new EngineNotFoundError(id, listEngines());
  }
  const engine = portFactoryOf(descriptor)();
  slot.singletons.set(id, engine);
  return engine;
}

/** id 是否已注册（agent 解析期的配置校验入口——不取实例、不触发 port 装配副作用）。 */
export function hasEngine(id: string): boolean {
  return getRegistrySlot().descriptors.has(id);
}

/** 已注册引擎 id 清单（稳定序 = 注册序；错误文案与 GUI 引擎选择器共用）。 */
export function listEngines(): string[] {
  return [...getRegistrySlot().descriptors.keys()];
}

/**
 * 已发现引擎按 manifest `displayName` 稳定序排序（D4 缺省引擎回落序的单一权威）。
 * displayName 缺省 = id（inproc 形态无 manifest 恒用 id）；排序 = 码点序（不用
 * localeCompare——跨环境字节稳定，同 model-prompt.ts 字节稳定先例）；displayName
 * 相同按 id 决胜，保证全序确定。
 */
export function listEnginesByDisplayName(): string[] {
  const slot = getRegistrySlot();
  const keyed = [...slot.descriptors.entries()].map(([id, descriptor]) => {
    const displayName =
      descriptor.kind === "cli" ? (descriptor.manifest?.displayName ?? id) : id;
    return { id, displayName };
  });
  keyed.sort((a, b) =>
    a.displayName !== b.displayName
      ? a.displayName < b.displayName ? -1 : 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return keyed.map((k) => k.id);
}

/**
 * 第一个可用引擎 id（D4 回落目标：缺省引擎不在清单 / fallback 目标的「首个可用」）。
 * 空注册表返回 undefined——调用方按 D4 转 engine_not_found（「未发现任何引擎包」+
 * 安装指引），不静默。
 */
export function firstAvailableEngineId(): string | undefined {
  return listEnginesByDisplayName()[0];
}

/**
 * 清空注册表（测试隔离专用：防止用例间 descriptor/单例泄漏串扰）。
 * 生产代码禁用——进程内注册表是全局状态，清空会让已获取的引擎句柄与新注册表脱钩。
 */
export function clearEngines(): void {
  const slot = getRegistrySlot();
  slot.descriptors.clear();
  slot.singletons.clear();
}

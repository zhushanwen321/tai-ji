// src/execution/assembly/model-config-service.ts
//
// 配置 + 模型解析领域 Service。"给定 agent 名 + 用户参数 + 主 agent 模型，用哪个模型？"
//
// 与 SubagentService（执行/记录/通知域）正交——本 Service 不碰 pool/store/notifier。
// 上游：SubagentService.execute 内部调 resolveModel。
// session_start 时经 initModel 注入 modelRegistry。

import { EngineError } from "../engine/common/errors.ts";
import { AgentRegistry } from "./agent-registry.ts";
import {
  DEFAULT_CONFIG,
  readGlobalConfig,
  type GlobalConfigReadResult,
} from "./config.ts";
import {
  type AgentConfig,
  type ModelInfo,
  type ModelRegistryLike,
  type ResolvedModel,
  resolveModel,
} from "./model-resolver.ts";
import type { SubagentsGlobalConfig } from "./types.ts";
import { GLOBAL_SLOT_KEYS } from "../../shared/global-slots.ts";

// ============================================================
// 类型
// ============================================================

/** Service 构造参数（进程级，跨 session 不变）。 */
export interface ModelConfigServiceInit {
  agentDir: string;
  /** 项目根目录（ctx.cwd，用于推导 workspaceRoot 扫描 project 级资源）。 */
  cwd: string;
}

/** session_start 注入参数（session 级，每次重建）。 */
export interface ModelServiceSessionInit {
  /** 模型注册表（鉴权 + 发现）。null 立即抛错（fail-fast）。 */
  modelRegistry: ModelRegistryLike | null;
  /** 当前 session ID。 */
  sessionId: string;
  /**
   * 主 agent 当前 model（session_start 时注入，model_select 时刷新）。
   *
   * renderCall 阶段的 ToolRenderContext 不含 model 字段（SDK 限制），无法直接拿到
   * 主 agent model。缓存后 renderCall 的 resolveModel 能命中第三层（ctxModel），
   * 让标题行恢复显示 model——即使未显式传 model 也能展示默认 model。
   *
   * [HISTORICAL] 99f20da1e 引入三层 fallback 后，renderCall 因拿不到 ctxModel
   * 而 resolveModel 拗错→降级不显示 model。此缓存修复该降级。
   */
  ctxModel?: ModelInfo;
}

// ============================================================
// ModelConfigService
// ============================================================

/**
 * 配置 + 模型解析 Service。进程级单例。
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  globalConfig（~/.pi/.../config.json，仅 maxConcurrent）│
 *   │  agentRegistry（agent .md 发现 + frontmatter）         │
 *   │  modelRegistry（SDK 注入的可用模型）                    │
 *   │                                                      │
 *   │  resolveModel: override → agentConfig → 主 agent model │
 *   └──────────────────────────────────────────────────────┘
 */
export class ModelConfigService {
  private globalConfig: SubagentsGlobalConfig;
  /** 最近一次全局配置三态读取结果（构造与 reload 均记录）——路由链据此区分
   *  「明确缺省」与「读失败」（读失败不得静默按缺省引擎派发）。 */
  private lastGlobalConfigRead: GlobalConfigReadResult;
  private readonly agentRegistry: AgentRegistry;
  private readonly agentRegistryDir: string;
  private modelRegistry: ModelRegistryLike | null = null;
  private _sessionId: string | undefined;
  /** 主 agent 当前 model 缓存（session_start 注入，model_select 刷新）。 */
  private _ctxModel: ModelInfo | undefined;

  constructor(init: ModelConfigServiceInit) {
    this.agentRegistryDir = init.agentDir;
    // 构造即用三态读取：读失败要留痕（旧 loadGlobalConfig 把「坏 JSON」与「文件不存在」
    // 同判缺省且无日志），状态供路由链在派发前显式拒绝。
    this.lastGlobalConfigRead = readGlobalConfig(init.agentDir);
    // failed 态不携带 config（读失败无值可采信）→ 落内置缺省；断言方法会拦下派发。
    this.globalConfig =
      this.lastGlobalConfigRead.status === "failed" ? { ...DEFAULT_CONFIG } : this.lastGlobalConfigRead.config;
    this.agentRegistry = new AgentRegistry();
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /**
   * session_start 注入。封装 3 步固定时序：
   *   1. reloadGlobalConfig（复用时拿最新 config）
   *   2. injectModelRegistry（fail-fast：null 抛错）
   *   3. setSessionId
   */
  initModel(init: ModelServiceSessionInit): void {
    // 1. 重载配置（agent 按需 loadByPath，无预热扫描）
    this.reloadGlobalConfig();

    // 2. modelRegistry（fail-fast）
    if (init.modelRegistry === null) {
      throw new Error("modelRegistry is required but got null");
    }
    this.modelRegistry = init.modelRegistry;

    // 3. sessionId + ctxModel 缓存（model_select 后续调 setCtxModel 刷新）
    this._sessionId = init.sessionId;
    this._ctxModel = init.ctxModel;
  }

  /**
   * 将一次三态读取结果提交到路由缓存（纯赋值幂等）。
   *
   * ok/absent 覆盖缓存、failed 保持缓存不动（坏 JSON 不能把好缓存打回缺省）；
   * 返回入参便于链式消费。用途 = 构造性同源：session_start 初始化与 per-turn 引擎
   * 检测各只读一次文件，同一读取结果既刷新路由缓存又充当检测基准，消灭两次独立
   * 读取之间的分叉窗口（两次读值不一致时检测走 unchanged，状态段/路由永停旧值）。
   */
  applyGlobalConfig(read: GlobalConfigReadResult): GlobalConfigReadResult {
    this.lastGlobalConfigRead = read;
    if (read.status !== "failed") {
      this.globalConfig = read.config;
    }
    return read;
  }

  /**
   * 最近一次全局配置读取状态（ok / absent / failed）。
   *
   * 消费方（引擎路由链）：`failed` = 配置文件存在但读不出来，此时「缺省引擎」是未知量，
   * 必须显式拒绝派发而不是按内置缺省 pi 执行——否则用户配置的引擎会被一次坏 JSON
   * 静默替换。`absent`（文件不存在）是合法缺省，按内置缺省执行。
   */
  getGlobalConfigReadStatus(): GlobalConfigReadResult["status"] {
    return this.lastGlobalConfigRead.status;
  }

  /**
   * 派发前断言全局配置可读（引擎路由链的 chokepoint，先于 record 创建与 worker 启动）。
   *
   * 读失败（配置文件存在但读不出来）时「缺省引擎」是未知量——按内置缺省 pi 继续执行
   * 等于用一次坏 JSON 静默替换用户配置的引擎。此处显式拒绝：结构化错误 + 恢复指引。
   * `absent`（配置不存在）是合法缺省，不拦。
   */
  assertGlobalConfigReadable(): void {
    if (this.lastGlobalConfigRead.status !== "failed") return;
    throw new EngineError(
      "engine_config_unreadable",
      `global config (config.json) exists but cannot be read or parsed, so the default engine is unknown` +
        (this.lastGlobalConfigRead.reason !== undefined ? `: ${this.lastGlobalConfigRead.reason}` : ""),
      "Fix or remove the global config file, then retry — the run is rejected instead of silently running on the built-in default engine.",
    );
  }

  /**
   * 三态重读全局配置并提交缓存（幂等可重入），返回本次读取结果供调用方感知。
   *
   * 从 initModel 提取（设计 D2）：引擎感知检测器 per-turn poll 发现 config 变更时
   * 调用本方法，使「system prompt 现值、路由缓存、变更通知」同 turn 对齐——只改注入
   * 不刷新路由缓存，会出现 prompt 说引擎 B、实际派发跑引擎 A（权威信息源说谎）。
   * 幂等性：只做「读文件 → 按三态提交缓存」单向赋值，无时序状态，重复调用收敛到
   * 同一结果。三态语义（failed 保持缓存、静默回落 DEFAULT 是旧缺陷——读失败曾把
   * 好缓存打回缺省且调用方无法感知）：ok/absent 覆盖、failed 保持并携带原因。
   */
  reloadGlobalConfig(): GlobalConfigReadResult {
    return this.applyGlobalConfig(readGlobalConfig(this.agentRegistryDir));
  }

  /**
   * 刷新主 agent model 缓存。model_select 事件时调用。
   * renderCall 的 resolveModel 读此缓存以显示标题行 model。
   */
  setCtxModel(model: ModelInfo | undefined): void {
    this._ctxModel = model;
  }

  // ── 模型解析（SubagentService.execute 内部调）──────────────

  /**
   * 解析 agent 的模型（三层：override → agentConfig → 主 agent model）。
   *
   * @param agentRef   agent 引用（.md 绝对路径；查 agentConfig 的 model override）
   * @param override   调用方显式 override（最高优先级）
   * @param ctxModel   主 agent 当前模型（兜底，直接透传）
   */
  resolveModel(
    agentRef: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
    /** 已解析的 agent 配置（调用方已加载时复用，避免同一 agentRef 二次 loadByPath）。 */
    agentConfig?: AgentConfig,
  ): ResolvedModel {
    this.assertReady();
    const config = agentConfig ?? (agentRef ? this.agentRegistry.loadByPath(agentRef) : undefined);
    // ctxModel 优先用显式传入（execute 路径），其次用 session 缓存（renderCall 路径）
    return resolveModel(config, this.modelRegistry!, override, ctxModel ?? this._ctxModel);
  }

  /** 查询 agent 配置（SubagentService 内部判定 defaultBackground 用）。
   *  undefined = 合法缺省语义（未点名 / 默认 general-purpose 形态）。 */
  getAgentConfig(agentRef?: string): AgentConfig | undefined {
    return agentRef ? this.agentRegistry.loadByPath(agentRef) : undefined;
  }

  /**
   * 查询 agent 配置——显式 ref 失败即 throw（SubagentService.resolveIdentity 用）。
   *
   * 与 getAgentConfig 的语义分界（「用户显式点名」vs「默认 general-purpose」）：
   * 用户显式点名的 agentRef（工具 agent 参数 / workflow agent({agent}) opts）解析
   * 失败 = 配置错误，必须显式报错——错误文案含 <available_subagents> 恢复指引
   * （对齐 workflow name not found 反馈风格），不允许静默降级为无配置
   * general-purpose 形态（systemPrompt/工具白名单全丢且零反馈）。默认形态
   * （不传 agent）走 getAgentConfig：undefined = 合法缺省，走 override → ctxModel 兜底。
   */
  getRequiredAgentConfig(agentRef: string): AgentConfig {
    return this.agentRegistry.loadByPath(agentRef, true);
  }

  // ── 配置读取（subagent-service 调）────────────────────────

  /** 全局配置深拷贝（调用方拿到副本，改不影响 Service 内部）。 */
  getGlobalConfig(): SubagentsGlobalConfig {
    return structuredClone(this.globalConfig);
  }

  /** 内部：session id 缓存（initModel 注入；当前无消费者，保留供未来 session 作用域需求）。 */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** agent 配置目录（SubagentService 构造 store/SessionRunnerContext 时读）。 */
  getAgentDir(): string {
    return this.agentRegistryDir;
  }

  /** modelRegistry（SubagentService 构造 factoryCtx 时读）。已注入保证非 null。 */
  getModelRegistry(): ModelRegistryLike {
    if (this.modelRegistry === null) {
      throw new Error("modelRegistry not injected (initModel not called?)");
    }
    return this.modelRegistry;
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 校验 modelRegistry 已注入。 */
  private assertReady(): void {
    if (this.modelRegistry === null) {
      throw new Error("modelRegistry not injected (initModel not called?)");
    }
  }
}

// ============================================================
// 进程单例访问器
// ============================================================

// 用 globalThis[Symbol.for] 持有进程单例，避免 jiti 因路径字符串不同加载多份模块
// 导致单例分裂（详见 docs/STANDARDS.md §7.5）。
const MODEL_SERVICE_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.modelService);

type ModelServiceSlot = { current: ModelConfigService | null };

function getModelServiceSlot(): ModelServiceSlot {
  // globalThis 无 symbol 索引签名，但运行时支持 symbol 键——用 Reflect 安全读写，
  // 避免双重断言。ModelServiceSlot 是运行时保证的固定形状（同文件唯一写入点）。
  let slot = Reflect.get(globalThis, MODEL_SERVICE_SLOT_KEY) as ModelServiceSlot | undefined;
  if (!slot) {
    slot = { current: null };
    Reflect.set(globalThis, MODEL_SERVICE_SLOT_KEY, slot);
  }
  return slot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getModelConfigService(): ModelConfigService | null {
  return getModelServiceSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setModelConfigService(service: ModelConfigService): void {
  getModelServiceSlot().current = service;
}

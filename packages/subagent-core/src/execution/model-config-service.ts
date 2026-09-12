// src/execution/model-config-service.ts
//
// 配置 + 模型解析领域 Service。"给定 agent 名 + 用户参数 + 主 agent 模型，用哪个模型？"
//
// 与 SubagentService（执行/记录/通知域）正交——本 Service 不碰 pool/store/notifier。
// 上游：SubagentService.execute 内部调 resolveModel。
// session_start 时经 initModel 注入 modelRegistry。

import { AgentRegistry } from "./agent-registry.ts";
import {
  loadGlobalConfig,
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
  private readonly agentRegistry: AgentRegistry;
  private readonly agentRegistryDir: string;
  private modelRegistry: ModelRegistryLike | null = null;
  private _sessionId: string | undefined;
  /** 主 agent 当前 model 缓存（session_start 注入，model_select 刷新）。 */
  private _ctxModel: ModelInfo | undefined;

  constructor(init: ModelConfigServiceInit) {
    this.agentRegistryDir = init.agentDir;
    this.globalConfig = loadGlobalConfig(init.agentDir);
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
    if (read.status !== "failed") {
      this.globalConfig = read.config;
    }
    return read;
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
   * （不传 agent）走 getAgentConfig：undefined = 合法缺省，走 override → ctxModel 兑底。
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
// 导致单例分裂（详见 docs/standards.md §7.5）。
const MODEL_SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.model-service");

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

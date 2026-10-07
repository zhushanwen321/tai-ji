// src/execution/service/model-switch.ts
//
// [subagent-model-switch §7.2] setModel 宿主编排封装层——本设计的裁决点集中地。
//
// 上层（runtime WS 消息 / 前端）不感知执行状态，只调用 setModel(target, model,
// thinkingLevel?)；编排内部 = **校验 → 按状态分流 → 写持久化** 的单一时序三步
//（设计 §7.2，review-main#1 + review-impact#6 定形的顺序约束）：
//
//   ① 校验（全部写入前拦截）：目录存在性（assertModelInCatalog 分类化拒单）+
//     canonical ref 全等 / 凭据 / thinking 档位（resolveModel 对新模型按现役候选链
//     完整裁决——预检 = 提前跑一遍未来解析，同一函数同一路径）；workflow 域附加
//     run 非终局检查（终局 fail-fast）。凭据与档位预检对有活进程与无活进程两条
//     路径统一生效（「无活进程 + 无凭据模型」组合在写入前即拦截，不留死状态）。
//   ② 按状态分流：chat 域有活进程 → capability 预检（不支持转记账 + 提示）→
//     引擎 setModel 转发 → 回读生效值 → 已生效型应答；workflow run 级 → U5 聚合
//     （本单元接桩，真实转发联调挂 U3/U5 commit 门补跑）；无活进程 → 记账路径，
//     已记账型应答。
//   ③ 写持久化意图：统一在分流之后，写不写由 §7.2 分型处置表裁决（7 行，见
//     disposition 分型实现与 model-switch.test.ts 逐行用例）。
//
// 审计口径（§7.2 三词分立）：覆盖记账是当前用户意图的唯一权威（本层写入）；应答
// （已生效型）与面板标签取引擎回读的生效值——记账不收生效值、生效值不改写记账。
//
// 依赖注入形态（R1 打样模式）：deps 全晚绑定闭包语义（装配点 = subagent-service
// 壳构造）。引擎转发（engineSetModel）与 run 级聚合（runAggregate）的接线通道已由
// 生产装配注入真实通道（壳侧：EnginePort.setModel 协议转发 + runModelSwitchAggregate
// 聚合 + run registry fold 终局判定，见 subagent-service.setModel 装配段）。

import type {
  ModelRef,
  SetModelErrorCode,
  SetModelParams,
  SetModelResult,
} from "@zhushanwen/subagent-engine-sdk";

import { SET_MODEL_ERROR_CODES } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "../../core/error-message.ts";
import { getLogger } from "../../core/logger.ts";
import { assertModelInCatalog } from "../../shared/model-catalog.ts";

import type { ModelConfigService } from "../assembly/model-config-service.ts";
import type { AgentConfig, ModelInfo } from "../assembly/model-resolver.ts";
import {
  type RunModelSwitchAggregateInput,
  type RunSwitchAggregateResult,
} from "../assembly/types.ts";
import type { EnginePort } from "../engine/port.ts";
import { hasLiveProcessHandle } from "../lifecycle/lifecycle-predicates.ts";
import type { ExecutionRecord, ModelOverride } from "../domain/record-model.ts";

// ============================================================
// 应答契约（§7.1 两型 + 错误应答 / run 级聚合）
// ============================================================

/**
 * chat 域 setModel 应答（§7.1 chat 域两型 + §7.5 错误规格行的应答形态）：
 * - `effective`：已生效型——引擎命令成功且回读到手，携带生效模型 ref + 生效
 *   thinking 档位（§6.4：生效值只进应答回执与前端展示，不进覆盖记账）。
 * - `recorded`：已记账型——无活进程 / 竞态窗口内退出 / 引擎不支持热切转记账；
 *   携带提示性文案，**不携带档位值**（无回读源，档位将由下次解析按现役候选链
 *   对新模型推导，预告值必然是猜测）。
 * - `error`：错误应答——快照型与回读失败（已写 + 错误应答，errorCode 携带引擎
 *   分型）/ 凭据漂移窗口（校验型失败处置，不写）。生效值未知如实报，不虚构。
 */
export type ChatSetModelReply =
  | { kind: "effective"; effectiveModel: ModelRef; effectiveThinkingLevel: string }
  | { kind: "recorded"; notice: string }
  | { kind: "error"; errorCode?: SetModelErrorCode; message: string };

/**
 * setModel 总应答。`error` scope = 校验型失败（两域共用——ref 非法 / 目录无此模型 /
 * 凭据缺失 / thinking 档位不可用 / run 已终局，§7.5 前四行的 fail-fast 应答；
 * 恒未写入，message 携带候选 / 可用档位恢复指引）。
 */
export type SetModelReply =
  | { scope: "chat"; reply: ChatSetModelReply }
  | { scope: "workflow-run"; aggregate: RunSwitchAggregateResult }
  | { scope: "error"; message: string };

/** setModel 目标（作用域分流判据，§6.1 决策一的作用域分流）。 */
export type ModelSwitchTarget =
  | { domain: "chat"; record: ExecutionRecord }
  | { domain: "workflow-run"; runId: string };

// ============================================================
// 依赖注入面
// ============================================================

/**
 * 编排层对模型服务的窄依赖（ModelConfigService 结构子集——测试桩可自建同构对象）。
 */
export interface ModelSwitchModelService { // oe-exempt:20261006:framework:类型契约先行的 DI 窄依赖（ports 接口先立、单实现常态）
  getModelRegistry(): ReturnType<ModelConfigService["getModelRegistry"]>;
  getAgentConfig(agentRef?: string): AgentConfig | undefined;
  resolveModel(
    agentRef: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
    agentConfig?: AgentConfig,
    userOverride?: { model: string; thinkingLevel?: string },
  ): { model: ModelInfo; thinkingLevel: string | undefined };
  setModelOverride(key: string, override: ModelOverride): void;
}

/**
 * setModel 编排的依赖注入面。转发通道（engineSetModel / runAggregate）与 workflow
 * 侧查询（assertRunNotTerminal / listAcceptedMemberRunIds / persistRunOverride）的
 * 生产实装在壳装配段（subagent-service.setModel deps 闭包）。
 */
export interface ModelSwitchDeps { // oe-exempt:20261006:framework:setModel 编排依赖注入面（U3/U5/U4 接线点，端口先立单实现常态）
  /** 模型服务（步骤①校验 + 步骤③内存记账表写入）。 */
  readonly getModelService: () => ModelSwitchModelService;
/**
 * chat 域覆盖落账原语（store.markModelOverride——内存 record 字段 + record 事件
 * 文件帧，持久化权威）。返回 false = record 非内存实例（未注册 / 已回收 / 重建
 * 对象），两面都未写——调用方（writeChatOverride）必须同步跳过内存记账表，禁止
 * 「持久化缺失而内存生效」的双介质状态（dmg-r1-10）。
 */
readonly markModelOverride: (record: ExecutionRecord, override: ModelOverride) => boolean;
  /** chat 域目标引擎解析（与派发链同一路由裁决——resolveRoundEnginePort 同款形态）。 */
  readonly resolveEnginePort: (record: Pick<ExecutionRecord, "engine" | "engineHandle" | "id">) => EnginePort;
  /**
   * 引擎 setModel 转发通道（签名 = SDK SetModelParams→SetModelResult）。生产实装 =
   * EnginePort.setModel 协议转发（U3 实装的可选面——manifest capabilities.setModel
   * = 'native' 条件挂方法）；capability 非 'native' 的引擎在步骤②预检即被拦截，
   * 本通道只承接 native 引擎。
   */
  readonly engineSetModel: (port: EnginePort, params: SetModelParams) => Promise<SetModelResult>;
  /**
   * 「进程已退出」判别（§7.3 竞态窗口：引擎转发期间子进程退出 → 宿主转纯记账
   * 路径）。U3 应答形态定形后接线；缺省判别生产装配注入恒 false 的保守桩
   *（判别 miss 时按错误应答处置——写 + 错误，不虚构生效值，与处置表不冲突）。
   */
  readonly isEngineNotActiveError: (err: unknown) => boolean;
  /**
   * run 级全切聚合通道（签名 = assembly/types RunModelSwitchAggregateInput）。生产
   * 实装 = runModelSwitchAggregate（U5 聚合函数，壳装配注入 resolveMemberPort 成员
   * 引擎解析）。run 级意图写入由本编排聚合返回后统一执行（下方步骤③——聚合层
   * 只做转发与分派，不持持久化回调）。
   */
  readonly runAggregate: (input: RunModelSwitchAggregateInput) => Promise<RunSwitchAggregateResult>;
  /**
   * workflow run 非终局检查（步骤①附加校验——终局 fail-fast，§7.5「run 已终局」
   * 行）。生产实装 = run registry fold 终局判定（record fold 唯一权威，无第二判据）；
   * `void | Promise<void>`：终局判定经 run 事件流扫描（磁盘 IO），编排 await 它——
   * 异步校验仍在全部写入前完成（步骤①语义不变），终局抛错走 catch 转 error 应答。
   */
  readonly assertRunNotTerminal: (runId: string) => void | Promise<void>;
  /** run 级已受理成员 runId 全量清单（全切转发面，§7.4——不做宿主侧存活预判）。 */
  readonly listAcceptedMemberRunIds: (runId: string) => string[];
  /**
   * run 级覆盖意图持久化（U4a journal 覆盖事件——run 事件流是唯一合法持久化写入
   * 形态）。U4b 接线为真实通道（journal append）。`void | Promise<void>`：编排
   * await 该结果——持久化失败 reject 上抛转报错应答（§7.5 覆盖持久化行「报错应答；
   * 内存覆盖仍生效」——内存写先于本调用，reject 不回滚内存表）。
   */
  readonly persistRunOverride: (runId: string, override: ModelOverride) => void | Promise<void>;
}

// ============================================================
// 编排实现
// ============================================================

/** ModelRef 结构 → canonical ref 词形（组帧单点——结构化形状的拆装收在宿主编排层，
 *  SDK contract-types ModelRef 注释的语义）。 */
export function canonicalRefOf(modelRef: ModelRef): string {
  return `${modelRef.provider}/${modelRef.modelId}`;
}

/** unknown → setModel 错误分型收窄（引擎 error 帧分型值域 = SET_MODEL_ERROR_CODES
 *  三型；非分型错误返回 undefined——错误应答不带 errorCode）。 */
export function engineSetModelErrorCode(err: unknown): SetModelErrorCode | undefined {
  if (err instanceof Error) {
    const carrier = err as { code?: unknown };
    if (
      typeof carrier.code === "string" &&
      (SET_MODEL_ERROR_CODES as readonly string[]).includes(carrier.code)
    ) {
      return carrier.code as SetModelErrorCode;
    }
  }
  return undefined;
}

const NOT_ACTIVE_NOTICE = "已记录，下次执行生效。";
const ENGINE_UNSUPPORTED_NOTICE = "该引擎暂不支持执行中热切换，已记录，下次执行生效。";
const RACE_EXIT_NOTICE = "子进程在切换期间已退出，已记录，下次执行生效。";

/**
 * 处置表「写记账后回错误应答」分型词表（行 3 快照型 / 行 7 回读失败型——catch 分支
 * 除 credential_missing 特判外的写面分型登记）。词表外引擎错误码 / 无码错误走同一
 * 写面兜底（「命令已送达、意图已表达」的保守归属，catch 实装按 credential_missing
 * 特判组织——特判 = SDK 词表全集减本词表）；shared 的 SUBAGENT_SET_MODEL_ACCOUNTED_
 * ERROR_CODES 是本词表的前端显示面投影（badge 亮灯依据，词表外码不亮 badge）。
 * **对账锚**：packages/runtime/src/infra/subagent-model-gateway.test.ts
 * 「core ↔ shared setModel 对账」——本词表扩位漏同步 shared 时该测试红。
 */
export const ACCOUNTED_SET_MODEL_ERROR_CODES = [
  "engine_model_not_in_snapshot",
  "engine_state_readback_failed",
] as const satisfies readonly SetModelErrorCode[];

/**
 * setModel 宿主编排（单一时序三步，§7.2）。校验型失败返回 error 应答（不写——
 * 处置表行 2）；内部 IO 异常原样上抛（调用方 sendError 承接）。
 */
export async function setModel(
  deps: ModelSwitchDeps,
  target: ModelSwitchTarget,
  model: ModelRef,
  thinkingLevel?: string,
): Promise<SetModelReply> {
  const modelService = deps.getModelService();

  // ── 步骤 ① 校验（全部写入前拦截）────────────────────────
  const canonical = canonicalRefOf(model);
  const registry = modelService.getModelRegistry();
  const agentConfig: AgentConfig | undefined =
    target.domain === "chat" ? modelService.getAgentConfig(target.record.agent) : undefined;
  try {
    // 目录存在性（分类化拒单——provider_drift / not_found 的修复指引文案，§5.2
    // 第一行）。抛错与下方裁决抛错同经 catch 转 error 应答（fail-fast 应答形态，
    // 校验型失败不写）。
    assertModelInCatalog(canonical, registry, { source: "subagent setModel" });
    if (target.domain === "workflow-run") {
      // workflow 域附加校验：run 非终局（终局 fail-fast——不可 resume、无未来步骤
      // 消费覆盖，§7.5「run 已终局」行）。先于 resolveModel 校验（作用域校验优先
      // 于模型校验——目标 run 不可切时模型对错无关紧要）。await：终局判定经 run
      // 事件流 fold（磁盘扫描），异步完成仍在全部写入前（步骤①语义不变）。
      await deps.assertRunNotTerminal(target.runId);
    }
    // canonical ref 全等 + 凭据预检 + thinking 档位预检：resolveModel 对新模型按
    // 现役候选链裁决（预检 = 提前跑一遍未来解析——同一函数同一路径）。预检候选
    // 链的完整度按域分野（§7.2 步骤①）：chat 域带 agentConfig（frontmatter 档位
    // 环参与裁决）——「受理时未裁决、下一轮 spawn 才硬失败」的窗口在该域不留；
    // run 级分支 agentRef 空串、agentConfig 恒 undefined——成员级显式档位
    // （frontmatter / 脚本调用参数）不在受理预检候选链内，个别成员档位对新模型
    // 不可用时受理照过、留待派发期第 0 层解析按成员失败分项呈现（§6.1③ 容错
    // 语义：个别成员失败不升级为整单拒绝）。抛错 = 校验型失败（§5.2 对应行
    // 文案由裁决函数产出，含候选/可用档位恢复指引）。
    modelService.resolveModel(
      target.domain === "chat" ? target.record.agent : "",
      undefined,
      undefined,
      agentConfig,
      {
        model: canonical,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      },
    );
  } catch (err) {
    // 处置表行 2（校验型失败）：不写（步骤①拦截，未到步骤③）。
    return { scope: "error", message: toErrorMessage(err) };
  }
  const override: ModelOverride = {
    ref: { provider: model.provider, modelId: model.modelId },
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    setAt: Date.now(),
  };

  // ── 步骤 ② 按状态分流 ── 步骤 ③ 写持久化意图（分流之后，按处置表）──
  if (target.domain === "workflow-run") {
    const aggregate = await deps.runAggregate({
      runId: target.runId,
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      memberRunIds: deps.listAcceptedMemberRunIds(target.runId),
    });
    // 处置表行 4（run 级聚合个别成员转发失败——以及全员成功行 1 的 run 级面）：
    // run 级意图恒写（§6.1③「一个成员失败不回滚其他成员」的直接推论；不写则已
    // 热切成功的成员被下一轮 spawn 旧 argv 压回）。写面 = 内存表 + U4a 事件载体
    //（await 持久化结果——失败上抛转报错应答，内存覆盖仍生效，§7.5）。
    modelService.setModelOverride(target.runId, override);
    await deps.persistRunOverride(target.runId, override);
    return { scope: "workflow-run", aggregate };
  }

  const record = target.record;
  // chat 域活进程判定（宿主镜像判据——进程存活事实的权威在引擎侧，转发 miss 由
  // isEngineNotActiveError 通道承接竞态窗口）。
  if (!hasLiveProcessHandle(record.id)) {
    return recordChatOverride(deps, record, override, NOT_ACTIVE_NOTICE);
  }
  // capability 预检（§7.3 能力位消费点）：位非 'native'（含 undefined = 旧 manifest
  // 未声明）不发 setModel 方法调用，转记账路径 + 提示性应答。
  const engine = deps.resolveEnginePort(record);
  if (engine.capabilities().setModel !== "native") {
    return recordChatOverride(deps, record, override, ENGINE_UNSUPPORTED_NOTICE);
  }
  try {
    const result = await deps.engineSetModel(engine, {
      runId: record.id,
      model,
    });
    // 处置表行 1（成功——生效值回读到手）：写 + 已生效型应答（回读值，不进记账）。
    writeChatOverride(deps, record, override);
    return {
      scope: "chat",
      reply: {
        kind: "effective",
        effectiveModel: result.effectiveModel,
        effectiveThinkingLevel: result.effectiveThinkingLevel,
      },
    };
  } catch (err) {
    if (deps.isEngineNotActiveError(err)) {
      // 处置表行 5（竞态无活进程——§7.3 全部竞态窗口内退出）：写 + 提示性应答。
      return recordChatOverride(deps, record, override, RACE_EXIT_NOTICE);
    }
    const errorCode = engineSetModelErrorCode(err);
    if (errorCode === "engine_credential_missing") {
      // §7.5 凭据行（chat 域单成员场景）：预检通过后的 registry 态漂移窗口——
      // 权威兜底（pi checkAuth）判失败 = 校验型失败处置，不写（意图与执行一一
      // 对应，单目标失败 = 切换整体未生效）。
      return { scope: "chat", reply: { kind: "error", errorCode, message: toErrorMessage(err) } };
    }
    // 处置表行 3（快照型失败 engine_model_not_in_snapshot——模型本身有效，下一轮
    // spawn 现取目录即可用）与行 7（回读失败 engine_state_readback_failed——命令
    // 已送达，用户意图已表达；生效值未知如实报错，不虚构）：写 + 错误应答。
    writeChatOverride(deps, record, override);
    return { scope: "chat", reply: { kind: "error", ...(errorCode !== undefined ? { errorCode } : {}), message: toErrorMessage(err) } };
  }
}

const logger = getLogger("subagents");

/** chat 域覆盖落账（步骤③写面）：持久化（store 原语——record 字段 + 事件帧）+
 *  内存记账表。切换不改写 record.model 盖章值（不变量 5 由 store 原语保证）。
 *
 *  落账返回值门（dmg-r1-10）：false = record 非内存实例，持久化两面（事件帧 +
 *  record 字段）都未写——内存记账表同步跳过，只 warn 上浮（消除「内存覆盖生效 /
 *  重启丢失、详情载荷查询无覆盖」的双介质劈叉）；该形态 = 调用方传入重建 record
 *  的集成缺陷信号（正常链 record 来自内存表），warn 后应答形态不变（引擎已实际
 *  切换的行 1 场景转报失败反而虚构），缺陷由 warn 日志暴露给排障链。 */
function writeChatOverride(
  deps: ModelSwitchDeps,
  record: ExecutionRecord,
  override: ModelOverride,
): void {
  if (!deps.markModelOverride(record, override)) {
    logger.warn(
      `[model-switch] markModelOverride skipped (record not the in-memory instance) — ` +
        `override NOT persisted and NOT applied to in-memory table (id=${record.id}); ` +
        `caller should pass the store-resident record`,
    );
    return;
  }
  deps.getModelService().setModelOverride(record.id, override);
}

/** 写 + 提示性应答（处置表行 5/6——已记账型，不携带档位值）。 */
function recordChatOverride(
  deps: ModelSwitchDeps,
  record: ExecutionRecord,
  override: ModelOverride,
  notice: string,
): SetModelReply {
  writeChatOverride(deps, record, override);
  return { scope: "chat", reply: { kind: "recorded", notice } };
}

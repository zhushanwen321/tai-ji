// src/execution/engine/client/remote-engine.ts
//
// RemoteEngine：cli 形态 EnginePort 适配（W2，impl-plan §2.2「RemoteEngine 同步成员
// 形态映射」必写死；[H1 U6] 交互控制面与 recordId 键路由面已随 chat 域退役删除）。
// 把 core EnginePort 的成员映射到 EngineClient 协议请求；
// 同步成员（capabilities / listModels / validateModel）**只读 manifest 注册期快照**
// ——单源化原则（设计 §3.3「同步成员清单」v6 减法）：无握手缓存、无失效时机，
// initialize 应答仅诊断（warn 由 EngineClient 留痕）。
//
// 直接 implements EnginePort：SDK 契约类型与 core 中立类型是结构等价闭包，
// implements 即编译期结构互证（字段漂移在 typecheck 期报错，与 protocol-closure
// 双向可赋值断言同向）。
//
// W3 消费契约：routing/registry 的 cli 形态 EnginePort 实例 = 本类（先写后读）。

import { homedir } from "node:os";
import { join } from "node:path";

import {
  EngineSdkError,
  killPidChain,
  type AgentCallOpts as SdkAgentCallOpts,
  type AgentOutcome as SdkAgentOutcome,
  type EngineHandleData as SdkEngineHandleData,
  type ModelCatalogEntry,
  type ProbeReport as SdkProbeReport,
  type SessionView as SdkSessionView,
} from "@zhushanwen/subagent-engine-sdk";

import type { AgentCallOpts } from "../../../orchestration/models/types.ts";
import { getHostServices } from "../../../core/host-services.ts";
import { getLogger } from "../../../core/logger.ts";
import { getSubagentSessionDir } from "../../assembly/path-encoding.ts";
import { assertGateCapabilitiesMatched } from "../common/capability-gate.ts";
import type {
  EngineCapabilities,
  EngineHandle,
  EngineHandleData,
  ProbeReport,
  SessionView,
} from "../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../port.ts";
import type { EngineClient, RunRoute } from "./engine-client.ts";

/** manifest 注册期快照（发现器/注册表读取，构造时注入——同步成员唯一源）。 */
export interface RemoteEngineManifestSnapshot {
  /** manifest `capabilities`（同步能力位权威，注册期读，无缓存）。 */
  capabilities: EngineCapabilities;
  /**
   * manifest `modelCatalog` 三态（§2.4：缺省 = 不注入保持 undefined；null 合法等价
   * 省略；`models: []` 仅作者显式声明）。解析器**不得**把省略填成 `[]`——否则
   * 「无枚举面」语义不可达（恒走 buildEmptyModelsHint 与事实不符）。
   */
  modelCatalog?: { dynamic: boolean; models: ModelCatalogEntry[] } | null;
}

export interface RemoteEngineOptions {
  engineId: string;
  client: EngineClient;
  manifest: RemoteEngineManifestSnapshot;
  /** 引擎数据根（协议 read.dataDir 必填：存量池时代相对 dbPath 定位需要它）。 */
  dataDir: string;
  hostKind: string;
  hostVersion?: string;
  /** L3 显式配置 engines.<id>.config（initialize.engineConfig 透传；EngineClient 消费）。 */
  engineConfig?: Record<string, string>;
  /**
   * cancel 收敛杀链兜底窗（缺省 CANCEL_SETTLE_KILL_CHAIN_GRACE_MS）。测试注入
   * 小窗用（量级断言由常量锚定用例持有）；生产链路不传。
   */
  cancelSettleGraceMs?: number;
}

/** manifest 目录条目命中：id / canonicalRef / 任一 alias 与 ref 全等。 */
function matchCatalogEntry(
  entries: ModelCatalogEntry[],
  ref: string,
): ModelCatalogEntry | undefined {
  return entries.find(
    (entry) =>
      entry.id === ref || entry.canonicalRef === ref || entry.aliases?.includes(ref) === true,
  );
}

const logger = getLogger("remote-engine");

/**
 * cancel 后 run 应答收敛的兜底窗（超时 = 本地合成 abort 终态收尾 record + [D9-2]
 * run 拓扑杀——只杀该 run 的引擎孙进程，引擎宿主与其上其他并发 run 存活；组杀
 * 引擎的旧路径已退役，全调用面裁决见 killRunTopology 注释块）。
 *
 * 量级校准依据（全局超时原则：兜底窗按被保护对象粒度校准——本窗保护的是
 * 「pi 引擎 cancel 停轮收敛」这一任务级过程，非控制面单请求）：pi 引擎 cancel
 * 停轮链 = SIGTERM → trap-flush（在途工具/turn 收尾写盘）→ 进程退出 → run 应答
 * 返回，实测可达 15s（S1 验收 timeline 取证）；兜底窗取实测值的 2× 量级 = 30s。
 * 历史 3s（SDK CANCEL_SETTLE_GRACE_MS）按「控制面单请求秒级」量级误校准到本
 * 任务级窗口上——常驻引擎在 pi 正常收敛途中被组杀，续聊轮 run 陪葬（S1 主路径
 * 8/8 失败，P1）。SDK 常量仍由 engine-client.cancelRun 作为单请求超时使用（秒级
 * 量级对 cancel 帧往返正确），两窗语义自此分离。
 */
export const CANCEL_SETTLE_KILL_CHAIN_GRACE_MS = 30_000;

/**
 * [D3 协议版 P6] armed 回执等待窗缺省值：native 引擎 + schema 任务的 run 在本窗内
 * 未收到引擎 armed 回执 → run fail-fast（合成失败 outcome，错误含双形态恢复指引）。
 *
 * 量级依据：armed 在引擎侧是 spawn 成功后立即上报（启动期，非执行期）——正常链路
 * 到达耗时 = 引擎进程 spawn + 一帧 IPC，秒级以内；10s 覆盖慢宿主/慢磁盘的裕量，
 * 远小于「schema 链路断掉烧完整 run」的沉没成本（G1 的保险丝语义）。用户通道：
 * env 覆盖（测试调短窗 + 排障调长窗），TAIJI_SUBAGENT_* 前缀（ENV_WHITELIST_PREFIXES
 * 白名单——PI_ 前缀在桌面 spawn 链被静默丢弃的教训，见 settled-watchdog 同款注记）。
 */
export const ARMED_RECEIPT_TIMEOUT_MS = 10_000;

/** armed 回执等待窗的 env 覆盖通道（>0 毫秒数生效；未设/非法 = 缺省 10s）。 */
export const ARMED_RECEIPT_TIMEOUT_ENV = "TAIJI_SUBAGENT_ARMED_RECEIPT_TIMEOUT_MS";

/**
 * 等待窗解析（每次 run 现读，不缓存——测试逐用例改 env 零串扰；非法值 warn 回落
 * 缺省，对齐 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS 的 LC-7 教训：非法回落必须可见）。
 */
function resolveArmedReceiptTimeoutMs(): number {
  const raw = process.env[ARMED_RECEIPT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return ARMED_RECEIPT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[remote-engine] ${ARMED_RECEIPT_TIMEOUT_ENV}="${raw}" is invalid (expected a positive millisecond number) — ` +
        `falling back to the default armed-receipt window (${ARMED_RECEIPT_TIMEOUT_MS}ms). ` +
        `Recovery: set a plain ms value (e.g. 500 for tests) or unset the env.`,
    );
    return ARMED_RECEIPT_TIMEOUT_MS;
  }
  return parsed;
}

// ============================================================
// [D3 协议版 P6] armed 回执等待门（宿主等待侧）
// ============================================================

/**
 * armed 回执等待门：native 引擎 + schema 任务的 run 派发后开窗计时，引擎 armed
 * 事件到达（经 run 事件路由）即收窗；窗满未到 → onTimeout 回调（调用方合成失败
 * outcome + best-effort cancel）。emulated 引擎 / 无 schema 任务豁免（不建门——
 * 「武装」概念仅对有孙进程 env/扩展依赖的 native 引擎成立，D3 分流判据 =
 * capabilities.schemaEnforcement；任务形态判据复用 H1 的 task.schema 声明形态，
 * 与引擎自查断言同源不同侧）。
 *
 * 为什么是「监控信号不与施控同源」：引擎侧武装断言（pi-subagent-cli）是引擎自查，
 * 断言代码自身失效/被绕过时自查恒绿——宿主侧独立等待窗是第二道防线（F-1 同源
 * 缴械教训的结构性应用）。
 */
interface ArmedReceiptGate {
  /** run 事件路由喂入点（armed 到达即收窗；其余事件无操作）。 */
  observe(event: unknown): void;
  /** 窗满回调（构造后登记——回调需要 run 上下文合成失败 outcome）。 */
  onTimeout(onFire: () => void): void;
  /** 收窗（run 终态 settle / 超时触发后调用；幂等）。 */
  dispose(): void;
}

function armArmedReceiptGate(
  capabilities: EngineCapabilities,
  task: AgentCallOpts,
): ArmedReceiptGate | undefined {
  // emulated 豁免（zcode 及 schema-emulation 登记域：引擎侧消费 wire task.schema，
  // 无武装面，宿主不期待回执、不 fail-fast——D3 防 emulated 误伤）。
  if (capabilities.schemaEnforcement !== "native") return undefined;
  // 无 schema 任务豁免（H1 判据：task.schema 声明形态；无声明 = 无武装面）。
  if (task.schema === undefined) return undefined;
  let armed = false;
  let onFire: (() => void) | undefined;
  const timer = setTimeout(() => {
    if (!armed) onFire?.();
  }, resolveArmedReceiptTimeoutMs());
  return {
    observe: (event) => {
      if (armed) return;
      if (!isArmedEventFrame(event)) return;
      armed = true;
      clearTimeout(timer);
    },
    onTimeout: (cb) => {
      onFire = cb;
    },
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

/** 运行时 guard：事件帧是否 armed 回执（wire 载荷 unknown，按 type 窄化，无 any）。 */
function isArmedEventFrame(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "armed"
  );
}

/**
 * run 请求与 armed 等待门的合流：run 应答先到 → 正常收门返回；窗满先到 → 合流
 * resolve 为调用方合成的失败结果（fail-fast，EnginePort 契约「运行中失败不 reject
 * ——合成 outcome + 正常 handle」）。败者后续 settle 一律吞掉（settled 守卫 +
 * run 请求的 then 链恒有 handler，无 unhandled rejection）。
 */
function awaitRunOrArmedTimeout<T>(
  runRequest: Promise<T>,
  gate: ArmedReceiptGate,
  synthesizeOnTimeout: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (settleFn: () => void): void => {
      if (settled) return;
      settled = true;
      gate.dispose();
      settleFn();
    };
    runRequest.then(
      (value) => settle(() => resolve(value)),
      (err) => settle(() => reject(err)),
    );
    gate.onTimeout(() => settle(() => resolve(synthesizeOnTimeout())));
  });
}

/**
 * cli 形态 EnginePort。构造同步、不 throw（缺包/坏包不在构造期报——descriptor
 * 首次使用才解析，设计 §3.5.3 代理形态）；真正的失败发生在首次协议调用。
 */
export class RemoteEngine implements EnginePort {
  readonly id: string;

  private readonly opts: RemoteEngineOptions;

  constructor(opts: RemoteEngineOptions) {
    this.opts = opts;
    this.id = opts.engineId;
    if (opts.manifest.modelCatalog === undefined || opts.manifest.modelCatalog === null) {
      // 同步成员形态映射（必写死）：manifest 省略 modelCatalog → validateModel 成员
      // **不实现**（消费方 model-validation.ts:115/:224 两处判定点
      // `typeof engine.validateModel !== "function"` → 跳过校验恒放行）。实例 own
      // property 置 undefined 遮蔽原型方法——
      // typeof engine.validateModel === "undefined"。
      (this as { validateModel?: unknown }).validateModel = undefined;
    }
  }

  /** 直读 manifest 注册期快照（无缓存——每次调用同值，快照不可变）。 */
  capabilities(): EngineCapabilities {
    return this.opts.manifest.capabilities;
  }

  /**
   * [stdout-wedge self-heal] 协议客户端只读暴露面：service 层（chat-rounds 的
   * settled-watchdog fire 处置）读取 run 事件计数 / 在册路由数（
   * eventsReceivedForRun / activeRunCount）并触发楔死自愈杀链
   * （killEngineForStdoutWedge）。诊断 / 自愈专用——运行路径不消费本成员，
   * RemoteEngine 行为零参与。
   */
  get protocolClient(): EngineClient {
    return this.opts.client;
  }

  /**
   * listModels 三态映射（必写死）：
   *   省略 modelCatalog / models null → 返回 null（buildCoreAlignedHint 语义）；
   *   显式 `models: []` → 返回 []（buildEmptyModelsHint）；
   *   数组 → 原样返回。
   */
  listModels(): Array<{ id: string; name?: string }> | null {
    const catalog = this.opts.manifest.modelCatalog;
    if (catalog === undefined || catalog === null) return null;
    return catalog.models;
  }

  /**
   * validateModel 同源 manifest 判定（成员在 catalog 省略时已被构造器摘除）：
   *   命中（id/canonicalRef/alias 全等）→ {canonicalRef: entry.canonicalRef ?? entry.id}；
   *   未命中且 dynamic:false → throw engine_model_unknown（同步拒，record 不创建）；
   *   未命中且 dynamic:true → 放行，返回原样 ref（运行期以引擎为权威
   *   engine_model_mismatch；无斜杠 ref 的 core 侧拆分 = 契约变更④，归 W3）。
   * modelRef undefined（查引擎缺省）对静态目录恒属未命中：dynamic:true 放行回空串
   * （缺省模型无静态 canonical 形态，运行期自证）；dynamic:false 同步拒。
   */
  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    const catalog = this.opts.manifest.modelCatalog;
    if (!catalog || modelRef === undefined || modelRef.trim() === "") {
      if (catalog?.dynamic === false) {
        throw new EngineSdkError(
          "engine_model_unknown",
          `engine '${this.id}' declares a static model catalog (dynamic:false) and has no engine-default entry; `
            + "an explicit `model` ref from the catalog is required.",
          "Retry with an exact model id from the engine's model list (engine listModels), or declare "
            + "the engine-default entry in the manifest modelCatalog.",
        );
      }
      return { canonicalRef: modelRef ?? "" };
    }
    const entry = matchCatalogEntry(catalog.models, modelRef);
    if (entry !== undefined) {
      return { canonicalRef: entry.canonicalRef ?? entry.id };
    }
    if (catalog.dynamic === false) {
      throw new EngineSdkError(
        "engine_model_unknown",
        `model '${modelRef}' is not in engine '${this.id}' static model catalog (dynamic:false)`,
        "Retry with an exact model id from the engine's model list (engine listModels), "
          + "or fix the manifest modelCatalog / upgrade the engine package.",
      );
    }
    return { canonicalRef: modelRef };
  }

  async probe(probeOpts?: { force?: boolean }): Promise<ProbeReport> {
    await this.opts.client.ensureConnected();
    const report = (await this.opts.client.request("probe", {
      force: probeOpts?.force ?? false,
    })) as SdkProbeReport;
    return report;
  }

  /**
   * 协议 run 映射。task 收窄为引擎面子集（model/cwd/engineFallback 改挂
   * run.params.ctx，协议层单列——SDK AgentCallOpts 注释的字段裁决；schema 本体经
   * wire task.schema 单字段承载，PI_WORKFLOW_SCHEMA env 由引擎侧派生——H1 schema
   * 传输归位）；事件经 run 作用域
   * 路由分发（event 通知 / streamDelta / poolResolved / handleReady）；abort → cancel
   * 帧 + 收敛兜底窗（CANCEL_SETTLE_KILL_CHAIN_GRACE_MS；窗满 = 本地合成终态 +
   * [D9-2] run 拓扑杀，引擎宿主不动）。运行中失败
   * 不 reject——合成 error outcome + 正常
   * handle 返回（EnginePort 契约：record 必须收尾）；run 帧发出前的失败（连接/握手）
   * reject。childSpawned/childStateChanged 镜像归 EngineClient（协议形态无
   * ChildProcess 实例，ctx.onChildSpawned 不调用——W6 起生命周期谓词读镜像）。
   */
  async run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    await this.opts.client.ensureConnected();

    // [W3 契约⑤ run 期接线] gate 位方向判定②：同步面 assertTaskShapeSupported 读
    // manifest 拦「少声明」；「多声明」（manifest 声明可用、引擎实态不符）gate 同步面
    // 读不到，由握手应答发现——manifest 快照 vs initialize 应答 capabilities 逐 gate
    // 位对照（common/capability-gate），命中抛 engine_capability_mismatch：本处位于
    // run 帧发出前 → prepare 期失败 reject、不产生 handle，上层 executeViaEngine 经
    // finalizeFailed → Step 3b cleanupWorktreeIfBound 清理 run 前已建的前置副作用。
    // 每次 run 都对照（纯内存比较，幂等）：崩溃重建重新握手后应答变化也能在下一 run
    // 发现。非 gate 位不一致不进此判定（诊断面 warnOnManifestDiagnostics 已留痕）。
    const answeredCaps = this.opts.client.getInitializeDiagnostics()?.capabilities;
    if (answeredCaps !== undefined) {
      assertGateCapabilitiesMatched(this.id, this.opts.manifest.capabilities, answeredCaps);
    }

    const runId = ctx.taskId;
    const runParams = buildRunParams(task, ctx, runId);

    // [D3 协议版 P6] armed 回执等待门（native + schema 任务专属；emulated / 无
    // schema 豁免 = undefined）：事件路由包裹 observe——armed 到达即收窗，窗满未到
    // 由合流等待器合成失败 outcome（下方 awaitRunOrArmedTimeout）。
    const armedGate = armArmedReceiptGate(this.opts.manifest.capabilities, task);
    const route = buildRunRouteHandlers(ctx);
    if (armedGate !== undefined) {
      const forwardEvent = route.onEvent;
      route.onEvent = (event) => {
        armedGate.observe(event);
        forwardEvent?.(event);
      };
    }

    const unregister = this.opts.client.registerRunRoute(runId, route);

    // abort 分级：cancel 帧 → 等收敛（CANCEL_SETTLE_KILL_CHAIN_GRACE_MS）→ [D9-2]
    // run 拓扑杀 + 本地合成终态（引擎宿主不动，裁决登记见 killRunTopology 注释块）。
    const abort = wireAbortSignal(
      this.opts.client,
      runId,
      ctx,
      this.opts.cancelSettleGraceMs ?? CANCEL_SETTLE_KILL_CHAIN_GRACE_MS,
    );

    try {
      // wire 载荷收窄（帧 result unknown → 协议 RunResult 形态）；SDK → core 结构
      // 兼容由 implements EnginePort 在 typecheck 期互证。
      const runRequest = this.opts.client.request("run", runParams) as Promise<{
        handle: SdkEngineHandleData;
        outcome: SdkAgentOutcome;
      }>;
      const armedSettled = armedGate !== undefined
        ? awaitRunOrArmedTimeout(runRequest, armedGate, () => {
          // 窗满 fail-fast（EnginePort 契约：运行中失败不 reject——合成 outcome +
          // 正常 handle）。best-effort cancel 先行：孙进程可能已在烧 token，宿主
          // 侧失败不等于引擎侧自停（cancel 受理失败由杀链兜底窗承接）。
          void this.opts.client.cancelRun(runId, "armed receipt timeout").catch(() => {
            // cancel 受理失败不阻断 fail-fast（杀链兜底窗是既有的第二道回收）。
          });
          logger.warn(
            `[remote-engine] armed receipt not received within ${resolveArmedReceiptTimeoutMs()}ms ` +
              `for run ${runId} (native engine, schema task) — failing the run fast`,
          );
          return {
            handle: this.synthesizeHandle(),
            outcome: armedReceiptTimeoutOutcome(this.id, runId),
          };
        })
        : runRequest;
      // [D9-2] 收敛窗合流：引擎应答先到正常返回；窗满先到 = 本地合成 abort 终态 +
      // run 拓扑杀（wireAbortSignal 窗满回调），晚到的引擎应答由 settled 守卫吞掉。
      const wireResult = await awaitRunOrForceSettle(
        armedSettled,
        abort,
        () => ({
          handle: this.synthesizeHandle(),
          outcome: abortedRunOutcome(this.id, runId, undefined),
        }),
      );
      return { handle: { data: wireResult.handle }, outcome: wireResult.outcome };
    } catch (err) {
      if (abort.isCancelSent()) {
        // cancel 后未收敛（杀链已杀）或引擎在 abort 期间报错：合成 abort 终态，不 reject
        // （exitCode null = 被信号杀死，杀链判据）。
        //
        // [时序窗登记（S1 验收实测修订）] 本合成 outcome 携 error + exitCode null，且
        // 其到达消费方的时间由 pi 停轮收敛链决定：SIGTERM → trap-flush → 退出实测
        // 可达 15s（杀链 30s 兜底窗内为**常态路径**，非窄窗）。原「CAS 恒先行、窗极窄」
        // 断言在 cancel → 用户 message revive 场景不成立：cancelBackground 的 settle
        // 不再终态化 record（idle + interrupted，可随时 revive），15s 窗口内 message
        // 即把 status 翻回 running——本 outcome 到达时 status 守卫失守，须由
        // Continuation 侧轮身份校验（activeRunId）丢弃迟到应答（S1 P1 修复②，
        // conversation-continuation.ts dispatchRoundAsync handlers）。
        return {
          handle: { data: this.synthesizeHandle() },
          outcome: abortedRunOutcome(this.id, runId, err),
        };
      }
      if (isTransientRunFailure(err)) {
        // 运行中失败（引擎崩溃 / 数据面故障杀链）：合成 error outcome + 正常 handle。
        return {
          handle: { data: this.synthesizeHandle() },
          outcome: transientRunOutcome(this.id, err),
        };
      }
      throw err; // prepare 期失败（连接/握手/model 拒）——进程创建前 reject，不产生 handle
    } finally {
      abort.dispose();
      unregister();
    }
  }

  /** 协议 read（dataDir 必填——引擎数据根，构造注入）。 */
  async read(handle: EngineHandle): Promise<SessionView> {
    await this.opts.client.ensureConnected();
    const view = (await this.opts.client.request("read", {
      handle: handle.data,
      dataDir: this.opts.dataDir,
    })) as SdkSessionView;
    return view;
  }

  /** 协议 dispose（幂等）→ EngineClient 停机清理（镜像置死 + pidfile + 组杀兜底）。 */
  async dispose(): Promise<void> {
    await this.opts.client.dispose();
  }

  /** 运行中失败的合成 handle：handleReady 回填优先，缺省空 sessionRef。 */
  private synthesizeHandle(): EngineHandleData {
    const partial = this.opts.client.getPartialHandle();
    const diag = this.opts.client.getInitializeDiagnostics();
    return {
      v: 1,
      engineId: this.id,
      sessionRef: partial?.sessionRef ?? {},
      engineVersion: diag?.engineVersion,
      adapterVersion: diag?.adapterVersion ?? `remote-engine/${this.id}`,
    };
  }
}

/**
 * 运行中失败（合成 outcome）vs prepare 期失败（reject）的分界：EngineSdkError 的
 * engine_crashed / engine_request_timeout / engine_handshake_timeout 三类由「run 帧
 * 已受理后进程死亡/链路故障」产生；其余（engine_protocol_mismatch、engine_model_*、
 * 未知错误）按 prepare 期失败上抛（调用方分诊）。进程组杀引发的 stdin 写失败同属
 * engine_crashed（engine-client.request 统一包装）。
 */
function isTransientRunFailure(err: unknown): boolean {
  if (!(err instanceof EngineSdkError)) return false;
  return (
    err.code === "engine_crashed" ||
    err.code === "engine_request_timeout" ||
    err.code === "engine_handshake_timeout"
  );
}

/** run 帧 wire 载荷（EngineClient.request("run") 入参形态）。 */
interface WireRunParams {
  runId: string;
  task: SdkAgentCallOpts;
  ctx: {
    cwd?: string;
    model: string | undefined;
    ctxModel: string | undefined;
    engineFallback: RunContext["engineFallback"];
    streamMode: "stream" | undefined;
    sessionRootId?: string;
    /** [Option C] 恒有值（宿主注入 ?? 同源 env 推导）——与 sessionRootId 的
     * "undefined 不上 wire" 不同，本字段派生恒产出字符串。 */
    sessionDir: string;
    /** [D2 扩展加载显式化] 孙进程显式加载的扩展路径集（HostServices 端口取值；
     * 宿主未实现端口 = undefined 不上 wire）。 */
    extensionPaths?: string[];
  };
  resume?: NonNullable<RunContext["resume"]>;
}

// pi 壳宿主进程内贯穿的两条 env（与 subagent-service / workflow-state-root 同源推导）：
//   - PI_CODING_AGENT_DIR：pi SDK getAgentDir 的 env 覆盖通道——taiji 生产链路由
//     runtime spawn pi 时显式注入（rpc-client buildPiOutboundEnv，经
//     buildOutboundChildEnv 共享构建器出站）；缺省 ~/.pi/agent 与 pi
//     实装版 dist config.js getAgentDir 逐字同构（锚定先例 workflow-state-root.ts）。
//   - PI_SUBAGENT_ROOT_CWD：真 ROOT 的 cwd（MF-3 贯穿）——嵌套 subagent 场景宿主
//     spawn 子进程时注入，与 subagent-service 构造处的 rootCwd 同 env 同值。
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_ROOT_CWD_ENV = "PI_SUBAGENT_ROOT_CWD";

/**
 * [Option C 协议化] 宿主权威 subagent session 目录（Gate B S6 修复）：宿主进程内
 * 同源 env 推导 agentDir/rootCwd 后调 getSubagentSessionDir（宿主单一权威推导，
 * path-encoding.ts——引擎本地推导与宿主布局三处不等价，已降级 [LEGACY] fallback）。
 * 每次调用重新解析（env 读取零成本，不缓存防测试/宿主切换读旧值，对齐
 * common/data-dir.ts getEngineDataDir 惯例）。rootCwd 缺省 process.cwd()：pi 壳
 * ctx.cwd = pi 进程启动 cwd（session-lifecycle 侧同用进程 cwd 的既有锚定）。
 */
function deriveHostSubagentSessionDir(): string {
  const agentDir = process.env[PI_AGENT_DIR_ENV];
  const resolvedAgentDir =
    agentDir !== undefined && agentDir !== "" ? agentDir : join(homedir(), ".pi", "agent");
  const rootCwd = process.env[PI_ROOT_CWD_ENV];
  const resolvedRootCwd = rootCwd !== undefined && rootCwd !== "" ? rootCwd : process.cwd();
  return getSubagentSessionDir(resolvedAgentDir, resolvedRootCwd);
}

/**
 * [D2 扩展加载显式化] HostServices.extensionPaths 端口取值（每次 run 现取——
 * P-C2 惰性求值，扫描/注册期早于 configureCore 的坑不在此复现：buildRunParams
 * 只在 run 派发时执行）。返回 wire 展开形态（undefined = 端口缺席，不挂键）。
 */
function hostExtensionPaths(): { extensionPaths: string[] } | undefined {
  const paths = getHostServices().extensionPaths?.();
  return paths !== undefined ? { extensionPaths: paths } : undefined;
}

/**
 * run 帧 wire 载荷构建。协议 ctx 承载（RunContext 字段映射表）：cwd 取任务声明值
 * （有值才上 wire——缺省不上，引擎侧回退自身进程 cwd；worktree 隔离路径由
 * taskSpecWithModel 合流后必有值）；ctxModel 投影 canonical 词形（provider/id，
 * ModelInfo 字段裁决）。
 * [H1 U6] 会话形态参数直传（RunContext.resume → run.params.resume；结构由
 * RunContext.resume 注释与 SDK RunResumeParams 的 implements 互证承载）。一次性轮
 * ctx.resume === undefined → wire 上不出现该键（协议 additive 语义）。
 */
function buildRunParams(task: AgentCallOpts, ctx: RunContext, runId: string): WireRunParams {
  const ctxModelRef = ctx.ctxModel ? `${ctx.ctxModel.provider}/${ctx.ctxModel.id}` : undefined;
  return {
    runId,
    task: toSdkTaskSubset(task),
    ctx: {
      // cwd 有值才上 wire（additive，与 sessionRootId 同写法）——引擎侧 task.cwd
      // undefined 时回退进程 cwd，与「core 进程 cwd 兜底上 wire」的旧行为相比不
      // 改变无 worktree/无显式 cwd 任务的落点。
      ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
      model: task.model,
      ctxModel: ctxModelRef,
      engineFallback: ctx.engineFallback,
      streamMode: ctx.stream !== undefined ? ("stream" as const) : undefined,
      // [F6] 根 session id（relay 归属键 SESSION_ID 权威源）——undefined 不上 wire
      //（additive 语义，与顶层 chat 参数同写法）。
      ...(ctx.sessionRootId !== undefined ? { sessionRootId: ctx.sessionRootId } : {}),
      // [Option C 协议化] 权威 subagent session 目录（Gate B S6）：宿主注入值优先，
      // 缺省同源 env 推导（deriveHostSubagentSessionDir）——恒有值恒上 wire，引擎
      // 据此组装 --session-dir 不自推导（引擎本地推导降级 [LEGACY] fallback）。
      sessionDir: ctx.sessionDir ?? deriveHostSubagentSessionDir(),
      // [D2 扩展加载显式化] 孙进程扩展路径集走 HostServices 端口（per-host 常量，
      // 不经 per-run 载荷）：pi 壳双形态注入（taiji 宿主 argv 白名单 / 独立 peerDep
      // 回退）。端口缺席（zsw 壳 / 未配置）= undefined 不上 wire（协议 additive）；
      // 在场时空数组也上 wire（显式「无扩展」，引擎侧不拼 --extension）。
      ...(hostExtensionPaths() ?? {}),
    },
    ...(ctx.resume !== undefined ? { resume: ctx.resume } : {}),
  };
}

/** run 作用域事件路由（event / streamDelta / handleReady）。 */
function buildRunRouteHandlers(ctx: RunContext): RunRoute {
  return {
    onEvent: (event) => ctx.onEvent?.(event as Parameters<NonNullable<RunContext["onEvent"]>>[0]),
    onStreamDelta: (delta) => ctx.stream?.onDelta(delta),
    onHandleReady: (partial) => ctx.onHandleReady?.(partial),
  };
}

// ============================================================
// [D9-2 杀伤半径收窄] cancel 收敛兜底的 run 拓扑杀 + 全调用面裁决登记
// ============================================================

/**
 * [D9-2 调用面裁决登记（grep 锚：D9-2）] `EngineClient.killAll`（组杀引擎 CLI）
 * 全调用面逐处判定——本文件只承载①②的收窄后路径；③④及其余引擎级故障面保留
 * 组杀（豁免判定以本表为权威）：
 *
 * | # | 调用面 | 位置 | 判定 |
 * |---|--------|------|------|
 * | ① | watchdog no-progress（workflow-dispatch fire → abort → 本阶梯） | wireAbortSignal 收敛窗 | **收窄**到 run 进程拓扑（killRunTopology）——杀半径只及该 run 的引擎孙进程，引擎宿主与同引擎其他并发 run 存活 |
 * | ② | cancel 收敛兜底（外部 abort → cancel 帧 → 收敛窗超时） | 同上（与①共享同一代码路径） | **同案收窄**到 run 拓扑——cancel 语义是停这一个 run，组杀引擎是无辜面 |
 * | ③ | dispose（宿主停机 / 引擎退役语义） | engine-client.ts dispose | **保留组杀 + 豁免**：停机时引擎本就该全灭，无「无辜并发 run」要保护 |
 * | ④ | stdout-wedge 自愈（引擎级 stdout 腿楔死恢复） | engine-client.ts killEngineForStdoutWedge | **保留组杀 + 豁免**：卡死定位在引擎级而非 run 级，本就无 run 级目标 |
 * | — | 引擎自报故障杀链（data-plane 反向请求 10s 未答判引擎故障） | engine-client.ts failEngine | **保留组杀 + 豁免**（同④族）：故障定位在引擎级（引擎反向通道楔死），无 run 级目标；D9-2 四处枚举外的第五调用面，实施期 grep 枚举补登记 |
 *
 * 收窄后语义（①②共享）：收敛窗超时 = 宿主放弃等待引擎应答——本地合成 abort
 * 终态收尾 record（EnginePort 契约「record 必须收尾」；晚到的引擎应答由 settled
 * 守卫吞掉，形态同 armed 等待门），同时 best-effort 杀该 run 的引擎孙进程
 * （mirror 中 recordId 锚定的活子进程，SDK killPidChain 单 pid 杀链）。zcode 等
 * 常驻 app-server 引擎无 per-run 子进程（镜像零目标）→ 降级为 stall 出声不杀
 * （ADR-0047 静默 ≠ 卡死；stall 通知通道 = P4 workflow-stall informational 通知，
 * 由 subagent-workflow 扩展的 journal 尾帧扫描承载，core 不另开第二通知面）。
 */

/** run 拓扑杀的拓扑锚：一次性 run = runId；续聊 run 的引擎子进程以 resume.recordId 归账（pi 引擎 childSpawned 帧的关联键）。 */
function runTopologyKey(ctx: RunContext): string {
  return ctx.resume?.recordId ?? ctx.taskId;
}

/**
 * [D9-2 ①②] 收敛窗超时的 run 拓扑杀：只杀该 run 在镜像中的活子进程（SIGTERM →
 * 5s → SIGKILL 升级，SDK killPidChain），引擎宿主进程不动、其他 run 的子进程不动。
 *
 * 零目标分支 = 无 per-run 进程拓扑引擎的降级出口（zcode 常驻 app-server 恒落此；
 * pi 引擎孙进程未 spawn / 已退出的窄窗同理）——不杀任何进程，warn 出声降级语义：
 * 组杀引擎是被 D9-2 明令禁止的无辜面，stall 信号由 P4 workflow-stall 通道承载。
 */
function killRunTopology(client: EngineClient, ctx: RunContext, reason: string): void {
  const topologyKey = runTopologyKey(ctx);
  const live = client.mirror
    .snapshot()
    .filter((e) => e.recordId === topologyKey && e.state === "running" && !e.killed);
  if (live.length === 0) {
    logger.warn(
      `[remote-engine] cancel did not settle within grace for run ${ctx.taskId}; ` +
        `no run-scoped child process to kill for topology '${topologyKey}' — ` +
        `engine host left untouched (group kill is forbidden for run-scoped recovery, D9-2). ` +
        `The run is stalled, not stopped: a stall notice is owned by the workflow-stall ` +
        `notification channel; the host-side record has been force-settled as aborted.`,
    );
    return;
  }
  logger.warn(
    `[remote-engine] cancel did not settle within grace for run ${ctx.taskId}; ` +
      `killing ${live.length} run-scoped child process(es) (pids: ${live.map((e) => e.pid).join(",")}) — ` +
      `engine host and other concurrent runs are untouched (${reason})`,
  );
  for (const entry of live) {
    killPidChain(entry.pid, { note: `run ${ctx.taskId} topology child` });
  }
}

/**
 * abort 接线的运行态句柄（isCancelSent 供 run catch 分支分诊；dispose 归 finally；
 * onForceSettle 供 run 请求在收敛窗超时时本地合成终态——EnginePort「record 必须收尾」
 * 契约的兑现点，晚到的引擎应答由调用方 settled 守卫吞掉）。
 */
interface AbortWiring {
  isCancelSent(): boolean;
  /** 收敛窗超时回调登记（窗满 = run 请求尚未应答 → 本地合成 abort 终态 + run 拓扑杀）。 */
  onForceSettle(cb: () => void): void;
  dispose(): void;
}

/**
 * abort 分级接线：cancel 帧 → 等收敛（graceMs，缺省 CANCEL_SETTLE_KILL_CHAIN_GRACE_MS）
 * → 收敛窗超时 = run 拓扑杀（[D9-2] 只杀该 run 的引擎孙进程，引擎宿主不动——全调用面
 * 裁决见 killRunTopology 注释块）+ 本地合成终态回调。signal 已 aborted 则立即进入收敛
 * 窗口；dispose 在 run 终态（finally）标记 settled 并清理 timer / listener。
 */
function wireAbortSignal(
  client: EngineClient,
  runId: string,
  ctx: RunContext,
  graceMs: number,
): AbortWiring {
  let cancelSent = false;
  let settled = false;
  let settleTimer: NodeJS.Timeout | undefined;
  let forceSettle: (() => void) | undefined;
  const onAbort = (): void => {
    if (cancelSent || settled) return;
    cancelSent = true;
    void client.cancelRun(runId, "abort").catch(() => {
      // 受理失败由收敛窗口兜底（本地合成终态 + run 拓扑杀）。
    });
    settleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killRunTopology(client, ctx, `cancel did not settle within grace for run ${runId}`);
      forceSettle?.();
    }, graceMs);
  };
  if (ctx.signal !== undefined) {
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    isCancelSent: () => cancelSent,
    onForceSettle: (cb) => {
      forceSettle = cb;
    },
    dispose: () => {
      settled = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * run 请求与收敛窗的合流（形态同 awaitRunOrArmedTimeout）：引擎应答先到 → 正常返回；
 * 收敛窗超时先到 → 本地合成 abort 终态（EnginePort「record 必须收尾」契约）。败者
 * 后续 settle 一律吞掉（settled 守卫 + run 请求的 then 链恒有 handler，无 unhandled
 * rejection）。
 */
function awaitRunOrForceSettle<T>(
  runRequest: Promise<T>,
  wiring: AbortWiring,
  synthesizeOnForceSettle: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (settleFn: () => void): void => {
      if (settled) return;
      settled = true;
      wiring.dispose();
      settleFn();
    };
    wiring.onForceSettle(() => settle(() => resolve(synthesizeOnForceSettle())));
    runRequest.then(
      (value) => settle(() => resolve(value)),
      (err) => settle(() => reject(err)),
    );
  });
}

/** abort 期合成 outcome（exitCode null = 被信号杀死，杀链判据）。 */
function abortedRunOutcome(engineId: string, runId: string, err: unknown): SdkAgentOutcome {
  return {
    content: "",
    error: `engine_run_failed: run ${runId} aborted before terminal answer${
      err instanceof Error ? ` (${err.message})` : ""
    }`,
    exitCode: null,
    engineId,
  };
}

/** 运行中失败合成 outcome（引擎崩溃 / 数据面故障杀链）。 */
function transientRunOutcome(engineId: string, err: unknown): SdkAgentOutcome {
  return {
    content: "",
    error: err instanceof Error ? err.message : String(err),
    exitCode: null,
    engineId,
  };
}

/**
 * [D3 协议版 P6] armed 回执窗满合成 outcome。文案语义对齐引擎侧武装断言（H3）双形态
 * 恢复指引；差异点 = 本侧是宿主独立信号（引擎自查之外的监控面），失败含义多一支：
 * 「引擎版本过旧不上报回执」。exitCode null = cancel/杀链终态族（被信号杀死判据）。
 */
function armedReceiptTimeoutOutcome(engineId: string, runId: string): SdkAgentOutcome {
  return {
    content: "",
    error:
      `[schema-arming] engine_run_failed: no armed receipt from native engine within the ` +
      `wait window for a schema task (run ${runId}) — the run was failed fast because ` +
      `continuing could complete with an unvalidated structured output. Either the arming ` +
      `chain is broken (schema env / grandchild extension never reached the pi grandchild), ` +
      `or the engine does not report armed receipts (engine package too old to speak the ` +
      `armed event). Recovery — taiji host form: check the runtime extension-service ` +
      `diagnostics for the grandchild extension whitelist staging of ` +
      `@zhushanwen/pi-structured-output. Recovery — standalone pi form: install ` +
      `@zhushanwen/pi-structured-output (peerDependency) or use a schema-less workflow ` +
      `instead (drop the schema from the agent call). If engine-side arming assertions pass ` +
      `but no receipt arrives, upgrade or reinstall the engine package ` +
      `(@zhushanwen/pi-subagent-cli).`,
    exitCode: null,
    engineId,
  };
}

/** core AgentCallOpts → SDK 引擎面子集（宿主自持字段不透传，SDK 契约类型注释裁决）。 */
function toSdkTaskSubset(task: AgentCallOpts): SdkAgentCallOpts {
  return {
    prompt: task.prompt,
    schema: task.schema,
    thinkingLevel: task.thinkingLevel,
    scene: task.scene,
    maxTurns: task.maxTurns,
    graceTurns: task.graceTurns,
    skill: task.skill,
    skillPath: task.skillPath,
    description: task.description,
    agent: task.agent,
    appendSystemPrompt: task.appendSystemPrompt,
    fork: task.fork,
    // fork-from 源（fork-from 轮次 --fork 的协议载体，W3 断链修复）：host-task-spec
    // 已把 ExecuteOptions.forkFromSessionFile 改名为 task.forkSource，此处同名透传。
    // 缺省 undefined 不落 wire（JSON 序列化丢弃，与相邻可选字段同语义）。
    forkSource: task.forkSource,
    worktree: task.worktree,
    idleTimeoutMs: task.idleTimeoutMs,
    denyTools: task.denyTools,
    permissionMode: task.permissionMode,
  };
}

// src/execution/engine/port.ts
//
// EnginePort 接口（P1）。设计权威源：docs/architecture/subagent-engine-abstraction.md
// §3.3.5「EnginePort 完整签名」——本文件是可编码落地的契约层，后续 wave（公共降级层
// P2 / zcode 引擎 P3 / 配置路由 P4）以本接口为实现契约，字段级变更须先改设计文档。
//
// 字段级扩展登记（接上文纪律——先改设计文档再扩接口）：
//   - [R1 已实施 2026-08-30] EnginePort.dispose?()——引擎停机面。权威源：
//     docs/design/zcode-engine-appserver-resident.md §3.3 D6 / §3.4 不变量 4。
//   - [R4 已实施 2026-08-30] RunContext.onHandleReady——运行中句柄回填通道
//     （同设计 §3.4 不变量 3：sessionRef 在 create 应答后经本回调送达编排层，
//     与 onPoolResolved 分立两个时点）。
//   - [u-h2 已实施 2026-09-05] EnginePort.validateModel?()——派发同步期 model 校验面。
//     权威源：docs/design/timeout-audit-hygiene-batch.md §3.2 D2-2。
//   - [u7a 已实施 2026-09-10] EnginePort.inFlightSnapshot?()——引擎在途只读快照面
//     （滚动重启推迟谓词输入）。权威源：
//     docs/design/crash-forensics-and-watchdog.md §3.3 D5。
//
// 三个能力面（D1；[H1 U6] interact 面已随 chat 域退役删除——续聊统一为新 run + resume）：
//   run        —— 主语义：一次性 fire-to-completion 任务执行（会话形态续聊轮同走 run，
//                 resume 锚点经 RunContext.resume 携带）；
//   read       —— session 历史读取（D6 三级降级链）；
//   probe      —— 探针（D7：二进制存在/版本解析/干跑校验）。
// capabilities() 同步无副作用——「调用前拒绝」（D11 处置三级）的判据。

import type { ChildProcess } from "node:child_process";

import type { ResumeAnchor } from "@zhushanwen/subagent-engine-sdk";

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { ModelInfo } from "../model-resolver.ts";
import type { SubagentStream } from "../stream-sink.ts";
import type { AgentEvent } from "../types.ts";
import type {
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  EngineHandleData,
  ProbeReport,
  SessionView,
} from "./types.ts";

// ============================================================
// RunContext（run 的运行期上下文）
// ============================================================

/**
 * run 的运行期上下文。任务声明（AgentCallOpts，D6 合流后的单一形状）与运行期句柄
 * 分离——signal/ctxModel/onComplete 从 ExecuteOptions 移出（设计 §3.3.5 删字段去向），
 * 因为它们是宿主注入的运行期对象，不属于跨引擎持久化的任务声明。
 *
 * 常驻进程友好（D1）：onEvent 回调式（而非迭代器式）+ AbortSignal——引擎内部换常驻
 * server 实现（未来 driver host）时接口不动。
 */
export interface RunContext {
  /** = record.id（bg-N-xxx / run-N）——journal 文件名与池引用计数 key（P2 消费）。 */
  taskId: string;
  /** D5 隔离池（宿主分配，设计 §3.3.9；pi 无池化恒 'shared'）。 */
  poolKey: string;
  /** abort 分级入口（D1：引擎原生中断 → 公共杀链兜底）。 */
  signal?: AbortSignal;
  /** 事件流出口（host 消费后统一落 journal，D6 第②级）。 */
  onEvent?: (event: AgentEvent) => void;
  /**
   * model 解析第三层兜底（现有 D-008 语义不变）——**pi 链路专属兜底**：经
   * taskSpecToExecuteOptions → resolveModel 第三层消费（PiEngine 直通）。自带
   * provider 体系与缺省模型的引擎（如 zcode：requested > 引擎缺省常量链）按自身
   * 默认链解析，不消费本字段（zcode 侧在「ctx 有模型但被忽略」时出声留痕，
   * zcode-engine.warnIgnoredCtxModel）。
   */
  ctxModel?: ModelInfo;
  /**
   * text_delta streaming 通道（宿主侧 UI widget）。与 onEvent 平行的 text_delta 出口：
   * background 路径 onEvent=undefined 但流式仍需送达（双通道互斥设计，见 session-runner
   * agentEvent 出口注释）。pi 回填期承载 AgentRunner port 的 stream 透传（行为零变化），
   * 语义上是宿主设施而非引擎专有——未来引擎的 text_delta 同样可走此通道。
   */
  stream?: SubagentStream;
  /**
   * [P1 pi 回填透传] 调用方已持有的 schema 激活预编码值（AgentCallOpts.schemaEnv 直传
   * 形态）。生产路径中 resolveAgentOpts 恒耦合产出 schema+schemaEnv（值 = JSON.stringify
   * (schema)），引擎从 task.schema 派生即可逐字节等值；解耦形态（有 schemaEnv 无
   * schema）生产不可达、仅见于直构调用，派生无源——本字段是其唯一透交通道。
   * 引擎在 task.schema 存在时忽略此值（派生优先，设计 §3.3.5 删字段去向）。
   */
  schemaEnv?: string;
  /**
   * [P4 D9①] 引擎 fallback 留痕（probe 失败路由回默认引擎）。路由层（routing.ts）
   * 产出，引擎投影到 outcome.engineFallback（zcode 等无 record 通路的引擎以此留痕；
   * pi 引擎另经 ExecuteOptions 投影进 record）。
   */
  engineFallback?: { from: string; reason: string };
  /**
   * [F6] 根 session id（SubagentService.sessionRootId 注入）——pi 引擎 relay 归属键
   * SESSION_ID 的权威来源（经 wire ctx.sessionRootId → server 还原 → SpawnRunParams
   * → buildChildEnv）。刻意走 per-run ctx 而非 EngineClient 的进程级 env：客户端按
   * 引擎缓存为惰性单例，进程级 env 在 pi fork 换 sessionId 后会陈旧；per-run ctx 恒
   * 新鲜，且与 RECORD_ID 已有的 per-run 形态一致。additive：undefined/null/空串不
   * 上 wire，zcode 等引擎忽略。
   */
  sessionRootId?: string;
  /**
   * [Option C 协议化] 权威 subagent session 目录（getSubagentSessionDir(agentDir,
   * rootCwd) 宿主推导值）——经 wire ctx.sessionDir 送达 pi 引擎组装 `--session-dir`。
   * 生产注入方 = RemoteEngine（cli 形态引擎的唯一宿主侧适配点，env 同源推导，见
   * remote-engine buildRunParams）；编排层显式注入（ctx.sessionDir 有值）时优先于
   * RemoteEngine 自推导。zcode 等不消费 session 目录的引擎忽略本字段。编排层可
   * 不注入；RemoteEngine 缺省以同源 env 推导值补齐后恒上 wire；[LEGACY] fallback
   * 仅旧宿主/独立运行引擎形态可达。
   */
  sessionDir?: string;
  /**
   * [P4 对齐点③] 引擎声明实际隔离池 key（journal 落盘路径权威）。宿主创建 journal
   * writer 时只能用缺省占位 poolKey（pi 恒 'shared'），非池化稳定的引擎（zcode 按
   * provider+model 池化）在 prepare 期确定 poolKey 后回调本方法重定向 writer——
   * 保证 journal 落盘路径与 handle.poolKey 同源（单一权威，不再两边推导）。
   * 契约：必须在首个事件 emit 之前调用（zcode coarse 事件在终态后合成，天然满足；
   * 未来流式引擎需在事件出口前调用）。
   */
  onPoolResolved?: (poolKey: string) => void;
  /**
   * [R4 §3.4 不变量 3] 运行中句柄回填通道：引擎在「session/create 应答到达后」
   * 立即回调（早于 run resolve——stream 引擎的 run 生命周期远长于会话建立）。
   * 与 onPoolResolved 分立两个时点：poolKey 在 prepare 期（onPoolResolved，连接
   * 建立前即可知），sessionRef 在 create 应答后（本回调）。编排层收到后立即回填
   * record.engineHandle 并落 entry——运行中的 GUI 经 entry 重建 record 即拿到
   * ①②级读取钥匙，不再等 run resolve 后的终态回填。可选回调：不支持运行中回填
   * 的引擎（spawn 单轮、终态即回填）不调用，宿主语义不受影响。
   */
  onHandleReady?: (partial: Pick<EngineHandleData, "sessionRef" | "poolKey">) => void;
  /**
   * [U0 D10] 引擎 spawn 的子进程句柄注册钩子（宿主终止链记账）。引擎在 spawn 成功后
   * 同步回调（与 pi runSpawn 的 spawnedChildren.set 同构时机）；宿主据此把 child 注册进
   * session-runner 的 spawnedChildren Map（cancel SIGTERM / dispose 收割兜底 / killAll
   * 全量清理对非 pi 引擎 record 生效）。close/error 后由宿主按句守卫移除。可选：引擎
   * 内部不 spawn 进程（如未来常驻 driver host 实现）时不调用，宿主记账自然为空。
   *
   * 边界声明（R1 D6）：本钩子只用于 per-record 一次性 spawn（一任务一进程模态）。
   * 引擎持有的常驻进程（跨任务共享，如 app-server 常驻连接）不经本钩子注册、不进
   * spawnedChildren Map——其生命周期完全归引擎 dispose 管理（防 per-record 重复
   * SIGTERM / 单任务 abort 误杀共享进程）。
   */
  onChildSpawned?: (child: ChildProcess) => void;
  /**
   * [W3 v1.x → H1 U6 终态] 会话形态参数（协议 run.params.resume 的 RunContext
   * 承载位，键已随 U6 键切换从 `chat` 泛化为 `resume`）：
   *   - recordId：core 预建 record 的关联键（引擎据此上报 childSpawned/childStateChanged
   *     的 record 键形态与 handle 锚定）——会话形态轮（task.conversation === true）必传；
   *   - resume：续聊锚点（record.sessionFile 续写原文件；pi 消费
   *     sessionRef.sessionFile——对照协议化设计前 SpawnResumeOpts.sessionFile 的锚点面）。
   * 类型权威 = SDK RunResumeParams（remote-engine 直传，结构互证由 implements 关系
   * 在 typecheck 期承载）。一次性轮不传，wire 上不出现该键。
   */
  resume?: { recordId: string; resume?: ResumeAnchor };
}

// ============================================================
// run 返回（handle + outcome）
// ============================================================

/**
 * run 的返回：终态 + 可持久化 handle。
 *
 * handle 语义（设计 §3.3.5 run 错误语义三条）：prepare 期错误（credential_missing /
 * model_not_available / prompt_too_large）在进程创建前 reject、不产生 handle；运行中
 * 失败不 reject——合成 error outcome + 正常 handle 返回（record 必须收尾）；abort 走
 * 完杀链后同前（exitCode=null + error 含杀链标记）。
 */
export interface EngineRunResult {
  handle: EngineHandle;
  outcome: AgentOutcome;
}

// ============================================================
// EnginePort
// ============================================================

/**
 * subagent 执行引擎的唯一契约点（D1）。实现方：PiEngine（回填）/ ZcodeEngine（P3）/
 * 未来各引擎适配器。上层（工具面/workflow 引擎/GUI）只消费中立类型，不感知引擎。
 *
 * 贯穿纪律（设计 §3.3.1）：宿主编排——引擎只当单 agent 执行器，六家原生多 agent 机制
 * 一律禁用不依赖。
 */
export interface EnginePort {
  /** 注册表 key（'pi' | 'zcode' | ...）。 */
  readonly id: string;

  /** D3（同步无副作用——调用前拒绝的判据）。 */
  capabilities(): EngineCapabilities;

  /** D7（factory 初始化 + 版本变化检测触发；opts.force 跳过缓存强探）。 */
  probe(opts?: { force?: boolean }): Promise<ProbeReport>;

  /** D1 主语义：fire-to-completion。[D6 合流] task = AgentCallOpts（单一任务形状，
   *  原 AgentTaskSpec 已并入——字段裁定见 orchestration/models/types.ts）。会话形态
   *  续聊轮同走本方法（resume 锚点经 ctx.resume 携带，[H1 U6] interact 面退役）。 */
  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult>;

  /** D6 三级降级链：①引擎原生读取 → ②宿主 event journal（P2）→ ③outcome-only。 */
  read(handle: EngineHandle): Promise<SessionView>;

  /**
   * [U7] 可选面：模型可发现性——引擎自带 provider/model 体系时（如 zcode 的 v2 桌面
   * 登录态），列出当前环境实际可用的模型清单（带凭据校验），供 system prompt 引擎段
   * 与 GUI 引擎选择器消费。省略/返回 null = 「与主 agent 模型体系一致」（pi 的语义：
   * system prompt 已有 <available_provider_models> 段，无需引擎再列）。
   * engine-neutral：未来引擎（AcpEngine 等）实现本方法即自动获得注入与展示，宿主
   * 侧零改动。
   */
  listModels?(): Array<{ id: string; name?: string }> | null;

  /**
   * [u-h2 D2-2] 可选面：派发同步期 model 校验（引擎 registry 单源裁决）。实现引擎复用其
   * prepare 期同一校验函数（zcode: resolveZcodeModelRef——同一函数两处消费，canonicalRef
   * 归一化与短名缺省 provider 决策不产生双实现漂移）；校验失败同步 throw（编排层包装为
   * 「引擎与模型不配套」错误，见 engine/model-validation.ts）。
   *
   * modelRef undefined = 查询引擎缺省模型（D2-1：主 agent 的 pi id 不透传给非 pi 引擎，
   * 缺省语义归引擎——zcode 落 ZCODE_FALLBACK_DEFAULT_MODEL）。返回 canonical ref 供
   * record.model 留痕。[W3 契约变更④] 协议化后 canonicalRef 允许**无斜杠**形态
   * （引擎原样返回的 ref）——core 侧按 provider=""/id=ref/整串进 name 拆分留痕
   * （splitEngineModelRef 单一权威），不落 "<ref>/" 畸形。
   *
   * 未实现：model 透传，引擎自身 prepare 期校验兜底（现状语义）；pi 不实现（pi 链走
   * 既有三层解析 + assertCanonicalModelRef 裁决，搬迁是大重构，设计 D2-2 被否②）。
   */
  validateModel?(modelRef: string | undefined): { canonicalRef: string };

  /**
   * [R1 D6] 可选停机面：释放引擎持有的常驻资源（如 app-server 常驻进程 / 长连接）。
   * 幂等契约（§3.4 不变量 4）：重复调用无副作用；dispose 后首个 run 自动重建（与
   * 「进程死后重建」同一代码路径）。可选成员保持向后兼容——无常驻资源的引擎（pi
   * 现状 spawn 单轮）不必实现。等待策略（D6①「触发不等待」）：宿主收割入口
   * （registry disposeEngines → killAllSpawnedChildren）只同步调用拿 Promise 不
   * await，引擎实现须自行保证同步面（立即 fire close 帧 + 同步 SIGTERM）在返回
   * Promise 前完成；grace→SIGKILL 升级序列属异步面（promise 段）。
   */
  dispose?(): Promise<void>;

  /**
   * [u7a D5] 可选面：引擎在途任务只读快照（滚动重启推迟谓词的引擎侧输入——
   * 权威源：docs/design/crash-forensics-and-watchdog.md §3.3 D5「推迟判定源 =
   * relay ∪ 引擎池在途 ∪ pi 侧 extension 聚合上报」）。同步纯读、无副作用。
   *
   * 返回 null = 引擎不提供快照；成员缺席（undefined，pi 引擎不实现）= 无引擎侧
   * 在途面——pi 形态的在途由 subagent-workflow extension 聚合上报覆盖（EnginePort
   * 之外的第 4 通道，两通道互不替代）。可选成员保持向后兼容（port.ts 既有扩展
   * 先例：listModels / validateModel / dispose 全为可选成员）。
   *
   * zcode 实现语义（显式裁决）：在途 = activeSessions 非空——poolKey 'shared' 的
   * app-server 空闲常驻进程恒活，**禁止按进程存在判定**（会恒真、推迟常态化）。
   */
  inFlightSnapshot?(): { inFlight: number } | null;
}

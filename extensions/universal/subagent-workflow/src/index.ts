/**
 * subagent-workflow Extension — Factory（extension 装配点）
 *
 * 合并 @zhushanwen/pi-subagents + @zhushanwen/pi-workflow 为统一包。
 * 注册项：3 tool（subagent + workflow + workflow-script）+ 2 command（subagents + workflows）
 * + messageRenderer（subagent-bg-notify）+ pi.__workflowRun + session 事件。
 *
 * 包内结构（执行运行时已迁 packages/subagent-core，本包只留注册面与宿主适配）：
 *   interface/ → 注册胶水（tools / commands / TUI 渲染 / GUI mappers）
 *   host/      → pi 宿主端口实现（HostServices / NotifyDomain 的 pi 侧兑现）
 *   injectors/ → 提示注入器（engine-awareness / model-list / resource-list …）
 *   session-lifecycle.ts → 会话生命周期装配 seam（测试可注入 fake 依赖）
 *
 * 架构导航见 docs/extensions/subagents/architecture.md。
 *
 * 设计基线：D-004（旧包不动）/ ADR-025（进程内执行）/ D-8（pi.__workflowRun 签名）。
 */

import type { ExtensionAPI, ExtensionContext, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";

// ═══ core 宿主端口接线（subagent-core 包抽离 u0-wire；实现见 src/host/pi-host.ts） ═══
import { configureCore } from "@zhushanwen/subagent-core";
import { configureNotifyDomain } from "@zhushanwen/subagent-core";
import { setInFlightListener } from "@zhushanwen/subagent-core";
import { createPiHostServices, createPiNotifyDomainPorts } from "./host/pi-host.ts";
// [u7a D5] 壳层在途上报出口：core 状态迁移 → 本出口 → select 通道（marker 帧）→ runtime。
import { createInFlightReporter } from "./host/inflight-reporter.ts";

import { bestEffort } from "@zhushanwen/subagent-core";
// ═══ 经 core barrel 消费执行域（执行运行时住 packages/subagent-core） ═══
// [U7] 引擎列表状态文件（registry → engines.json，GUI 引擎选择器数据源）
import { syncEnginesFile } from "@zhushanwen/subagent-core";
// [W11/DoD#5] registerPiEngine（inproc 'pi' 注册）已随内建引擎删除：registry 'pi'
// 由下方 syncEnginesFile 的三级发现装载 cli descriptor（engines/zcode 同理由
// registerZcodeEngine D8 薄壳承载）。
// [P3 引擎接线] 组合根登记 'zcode' 引擎（D8 薄壳：vendored 定位 cli descriptor；
// engineDataDir 默认走 common/data-dir SSOT）
import { registerZcodeEngine } from "@zhushanwen/subagent-core";
import { getModelConfigService } from "@zhushanwen/subagent-core";
import { getBoundNotifyLedger } from "@zhushanwen/subagent-core";
import { getSubagentService } from "@zhushanwen/subagent-core";
import { killAllSpawnedChildren } from "@zhushanwen/subagent-core";
// [engine-awareness U3/D7-④] per-turn 引擎检测编排 + before_agent_start 链尾接线
import { setupEngineAwarenessInjector } from "./injectors/engine-awareness.ts";
import { setupModelListInjector } from "./injectors/model-list-injector.ts";
import { setupSubagentListInjector } from "./injectors/subagent-list-injector.ts";
import { setupWorkflowListInjector } from "./injectors/workflow-list-injector.ts";
import { renderBgNotifyMessage } from "./interface/bg-notify-render.ts";
import { registerWorkflowsCommand } from "./interface/commands.ts";
import { toGuiCtx } from "./interface/gui-mappers.ts";
import { notifyDone, trackNotifiedRunId } from "./interface/helpers.ts";
import { registerSubagentTool } from "./interface/subagent-tool.ts";
// ═══ interface/ 层（tools/commands/tui 合并） ═══
import { registerSubagentsCommand } from "./interface/subagents.ts";
import { registerWorkflowTool } from "./interface/tool-workflow.ts";
import { registerWorkflowScriptTool } from "./interface/tool-workflow-script.ts";
// ═══ 经 core barrel 消费 workflow 域（引擎与 worker 住 packages/subagent-core） ═══
import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { executeNestedWorkflow, runAndWait, type WorkflowRunResult } from "@zhushanwen/subagent-core";
import {
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  scheduleTimeBudget,
  terminateRunningRuns,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { WorkerHostImpl } from "@zhushanwen/subagent-core";
import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";
// ═══ session 生命周期装配 seam（bootstrap seam，设计 §3.1/D1） ═══
import {
  getOrCreateDialogQueue,
  setupSessionLifecycle,
  type SessionLifecycleDeps,
  type SessionLifecycleResult,
} from "./session-lifecycle.ts";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ── pi.__workflowRun 类型扩展（D-8 签名） ─────────────────

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    __workflowRun?: (
      workflowName: string,
      workflowArgs: Record<string, unknown>,
      workflowSignal?: AbortSignal,
      workflowTimeoutMs?: number,
    ) => Promise<WorkflowRunResult>;
  }
}

// ── Factory ──────────────────────────────────────────────────

// 模块级 logger（setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("subagents");

// ═══ [V2 决策 7 防线 i] process 级 shutdown hook ═══
//
// session_shutdown 是 pi 的 async hook，进程被 SIGTERM/SIGINT 强杀或崩溃时来不及
// 触发；sync 子进程（controller 为 undefined，abortRunningControllers 跳过它们）会
// 泄漏为孤儿。process.on 兜底显式 killAllSpawnedChildren 收割全部活子进程。
// guard 防多信号叠加（如 SIGINT 后又 beforeExit）重复 kill。
let processShutdownHookFired = false;

function reapSpawnedChildrenOnShutdown(): void {
  if (processShutdownHookFired) return;
  processShutdownHookFired = true;
  try {
    killAllSpawnedChildren("SIGTERM");
  } catch (err) {
    // best-effort：收割失败不阻断退出流程——debug 留痕（孤儿子进程排查线索），
    // 不静默吞错，对齐「错误必须可操作」。
    logger.debug(
      "[subagents] process shutdown reap best-effort failed (killAllSpawnedChildren SIGTERM)",
      { reason: toErrorMessage(err) },
    );
  }
}

/**
 * 测试钩子：重置 module 级 shutdown guard。
 *
 * 对齐 lifecycle-manager._resetLifecycleState 模式——processShutdownHookFired 是
 * module 级单例状态，跨 test 持久，单测需显式重置以验证 idempotent 行为。
 */
export function _resetProcessShutdownGuardForTest(): void {
  processShutdownHookFired = false;
}

export default function subagentsWorkflowExtension(pi: ExtensionAPI): void {
  // 注入 pi handle 给全局 extension-logger，让深层代码（best-effort / error-recovery）
  // 的 getLogger("subagents") 也能走 appendEntry。
  setPiHandle(pi);

  // [u0-wire] core 宿主端口接线：本波端口尚无 core 消费方（消费切换在 u0-log /
  // u0-data-discovery / u0-notify 波次），接线本身零行为变化。紧随 setPiHandle——
  // core log 桥接走 pi-extension-logger，其 pi handle 先注入则配置完成即桥接链路
  // 完整；且先于任何可能消费 core 端口的初始化逻辑（引擎登记等）。缺省态若被消费，
  // dataRoot 抛 core_host_not_configured（§3.4），接线后不再可达。
  configureCore(createPiHostServices());
  // [F1] 通知域端口无 factory 基准参数：跨 session 残留过滤基准（W4 读侧过滤②）
  // 由 core 读侧 per-call 提供（session-pending 读「被读 entries 所属 session」）——
  // 本装配在扩展启动时执行一次，session id 逐 session 变化，factory 定型表达不了
  // per-call 基准（生产装配也从未传参，防御曾实际缺基准）。
  configureNotifyDomain(createPiNotifyDomainPorts());

  // [W11/DoD#5] 'pi' 的 inproc 注册（registerPiEngine）已删除——缺省引擎 'pi' 的
  // registry 条目由下方 syncEnginesFile 内的三级发现装载（cli descriptor，幂等），
  // P4 配置路由（agent frontmatter engine 字段 + 三层优先级）在其上消费；chat 域
  // pi 引擎不经 registry（SubagentService 自持 DI，W11 主 agent 裁决的临时豁免面）。
  // [P3 引擎接线] 登记 'zcode'（幂等同上）。D8 薄壳：vendored 定位 cli descriptor。
  registerZcodeEngine();

  // [u7a D5] 在途聚合上报接线：core 状态迁移（spawn/close/arm/disarm）→ 出口回调 →
  // 本 reporter 经 select 通道推绝对计数帧。出口为进程级单监听（在途记账本身是 pi
  // 进程级模块状态），后注册覆盖先注册（jiti 重载幂等）；回调同步 void，不进任何
  // 生命周期 await 链（D5 接线约束①）。ctx 由 session_start 注入（factory 阶段无 ui）。
  const inflightReporter = createInFlightReporter();
  setInFlightListener(inflightReporter.onInFlightChanged);

  // [U7b] 引擎列表在 extension 模块加载时即同步 engines.json（不等 session_start——
  // 用户体验拍板 2026-08-25：xyz-agent 打开后激活任意 session 的第一时间（含 TUI 等价
  // 场景）GUI 引擎选择器就该有数据；session_start 处保留幂等重写兜底 jiti 双路径/
  // 模块重载场景的刷新）。
  syncEnginesFile(getAgentDir());

  // ════════════════════════════════════════════════════════════
  //  subagents 域：tool + command + messageRenderer
  // ════════════════════════════════════════════════════════════
  registerSubagentTool(pi);
  registerSubagentsCommand(pi);
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  // ════════════════════════════════════════════════════════════
  //  injectors：before_agent_start 注入 <available_subagents> + <available_workflows>
  //  + <available_provider_models>（模型列表供派发时指定 model 参数；与 subagent/workflow 清单对称）
  //
  //  归位自 unified-hooks（subagent-list-injector）+ 新增 workflow-list-injector。
  //  injector 是 subagent-workflow 的内聚功能（让 LLM 知道有哪些 agent/workflow
  //  可用），与同包 resource-discovery 同包后直接 import，消除跨包依赖（ADR-031）。
  //  pi 串联多 before_agent_start handler：各自返回 systemPrompt 链式叠加。
  // ════════════════════════════════════════════════════════════
  setupSubagentListInjector(pi);
  setupWorkflowListInjector(pi);
  setupModelListInjector(pi);

  // [主 session 文件解析随迁] cachedMainSessionFile 缓存与 resolveMainSessionFileById
  // 随 session_start 装配块整体迁入 session-lifecycle.ts（唯一消费方是随迁块；
  // SubagentService 的 getMainSessionFile getter 由 createOrReuseServices 提供）。

  // resources_discover：不再注册 handler（v4 决策：不再注入额外 skill 目录，
  // ADR-031 废弃 discovery.json）。pi 核心 auto-discovery 已覆盖 .agents/skills
  // 等标准目录，子 session 的 --skill 由 agent({skill}) 调用方显式传入，无需
  // extension 额外补充。

  // ════════════════════════════════════════════════════════════
  //  workflow 域：tools + command + pi.__workflowRun + state
  // ════════════════════════════════════════════════════════════
  const lsRef = { lastSessionId: "" };
  const notifiedRunIds = new Set<string>();
  const guard = { isProcessing: false };

  // Infra 实例（per-factory 单例，跨 session 复用）
  const workerHost = new WorkerHostImpl();
  const registry = new WorkflowScriptRegistryImpl();

  // SAR 改为 per-session 构造（需要 ctxModel 填底 D-008 + subagentService 委托目标），
  // 构造点随 session_start 装配块迁入 session-lifecycle.ts，经 SessionLifecycleResult
  // 传回（见 setupSessionLifecycle）。

  // per-session 状态（session_start 时重建）。value = SessionLifecycleResult
  // （setupSessionLifecycle 装配结果，ctx 必有）。
  const sessionState = new Map<string, SessionLifecycleResult>();

  function log(
    level: "debug" | "info" | "warn" | "error",
    component: string,
    message: string,
    data?: unknown,
  ): void {
    try {
      pi.appendEntry("workflow:log", {
        timestamp: Date.now(),
        level,
        component,
        message,
        data,
      });
    } catch (err) {
      void err;
    }
  }

  // [workflow state 目录解析随迁] resolveSessionDir 随 session_start 装配块整体迁入
  // session-lifecycle.ts（唯一消费方是随迁块）。

  /** 组合根侧生产 deps 工厂：SessionLifecycleDeps 全部成员有生产默认实现（住
   *  session-lifecycle.ts——createOrReuseServices 单例语义 / WorktreeManager 每次
   *  扫描新建 / JsonlRunStore per-session 新建），此处无本地构造可注入；工厂形态
   *  保留为 index 侧注入点（测试或后续演进可在此覆盖）。
   *  测试注入路径：不挂载 index.ts，直接调 setupSessionLifecycle(pi, ctx, fakeDeps)。 */
  function makeLifecycleDeps(): SessionLifecycleDeps {
    return {};
  }

  function makeDeps(
    state: Pick<SessionLifecycleResult, "store" | "runs" | "sessionDir" | "runner">,
    sessionCtx?: ExtensionContext,
  ) {
    const deps: LauncherDeps = {
      store: state.store,
      workerHost,
      runner: state.runner,
      runs: state.runs,
      registry,
      // onRunDone 是全部 done 路径的单点汇聚（abortRun + error-recovery），顺序固化为
      // notify → track → evict：notifyDone 先发完整聚合通知（淘汰后聚合根仍在闭包参数
      // run 引用上不受影响），trackNotifiedRunId 有界化去重窗口，最后裁剪 done run 内存。
      // 本轮 run 的 completedAt 在 transition("done") 时同步设为当前时刻=全局最新，
      // 恒在保留端——结构性保证其不被自身触发的裁剪淘汰，无需 protectRunId。
      onRunDone: (run: WorkflowRun) => {
        notifyDone(pi, run.runId, run, notifiedRunIds, toGuiCtx(sessionCtx));
        trackNotifiedRunId(notifiedRunIds, run.runId);
        const evicted = evictDoneRunsBeyondCap(state.runs, MAX_RETAINED_DONE_RUNS);
        if (evicted > 0) {
          logger.debug("[subagent-workflow] evicted done runs beyond cap", {
            evicted,
            keep: MAX_RETAINED_DONE_RUNS,
            sessionId: lsRef.lastSessionId,
          });
        }
      },
      eventBus: pi.events,
      scheduleTimeBudget: (runId: string, budgetTimeMs: number) =>
        scheduleTimeBudget(runId, deps, budgetTimeMs),
      onWorkflowCall: (name: string, args: Record<string, unknown>, parentRun: WorkflowRun) =>
        executeNestedWorkflow(name, args, parentRun, deps),
      // [H2 W3] workflow agent() 统一派发入口（设计 §3.5）：pump 侧 dispatchAgentCall
      // 经此转调 SubagentService.executeWorkflowAgent——真实 record（origin:"workflow"
      // + parentRunId）进 store、共享池/守护/journal 归 service 编排；parentRunId 由
      // pump 补 run.runId。service 单例在 session_start 后必在（run 只能于 session 内
      // 派发）；null 时抛错由 pump 的 dispatchCall catch 兜底回发 failed result。
      workflowAgentDispatch: (opts, parentRunId, signal) => {
        const service = getSubagentService();
        if (!service) {
          throw new Error("workflow agent dispatch unavailable: subagent service not initialized");
        }
        return service.executeWorkflowAgent(opts, parentRunId, signal);
      },
      log,
    };
    return deps;
  }

  function isScriptRunning(name: string): boolean {
    for (const state of sessionState.values()) {
      for (const run of state.runs.values()) {
        if (run.spec.scriptName === name && run.state.status === "running") return true;
      }
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════
  //  session_start：初始化 subagents + workflow 两域
  //
  //  六职责编排（identity 重建 / ledger 装配 / 双 Service 装配 / GC+恢复 / kill-9
  //  循环 / SAR+engine 基线）已随迁 session-lifecycle.ts（bootstrap seam，设计
  //  §3.1/D1/D2 原样搬移）。此处仅接线：lastSessionId 先行赋值（时序与原 handler
  //  开头一致）+ 装配结果写入 per-session sessionState。
  // ════════════════════════════════════════════════════════════
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    lsRef.lastSessionId = ctx.sessionManager.getSessionId();
    // [u7a D5] 初始上报（count=当下绝对计数）：触发时点 = extension 加载完成 / session
    // 就绪（factory 无 ctx/ui，session_start 是最早带 ctx 的钩子——plugin-bridge 同款
    // 事实）。fire-and-forget 在 await 装配链之前发起，不阻塞也不被阻塞。
    inflightReporter.attachSession(ctx);
    const result = await setupSessionLifecycle(pi, ctx, makeLifecycleDeps());
    sessionState.set(result.sessionId, result);
  });

  // ════════════════════════════════════════════════════════════
  //  [U2 P-B4 降级] session_compact：compaction 对 custom entry 保留行为实装未
  //  验证——检测 ledger/ack entry 被 compaction 清除时按内存态补写（notify-ledger
  //  compactionCheck；未清除则 no-op）。内存态在 compaction 后仍活着，作为补写源；
  //  重启后的权威仍是两列 entry 差集（内存不承担销账职责）。
  // ═══════════════════════════════════════════════════════
  pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
    try {
      const rewritten = getBoundNotifyLedger()?.compactionCheck() ?? 0;
      if (rewritten > 0) {
        logger.warn(`[subagents] notify ledger entries lost to compaction; rewrote ${rewritten} from memory`);
      }
    } catch (err) {
      logger.warn("[subagents] notify ledger compactionCheck failed", {
        reason: toErrorMessage(err),
      });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  [U7 + engine-awareness U3] before_agent_start：引擎感知注入（链尾注册，D7——
  //  段内容变化只断 system prompt 尾部 cache 前缀）。
  //  D7-④：接线收编于 engine-awareness.ts 的 setupEngineAwarenessInjector（与上方
  //  三个 setup* 同形，注入链序由调用先后表达）；per-session lastEngine 经
  //  sessionState 存取器注入。编排/渲染/链尾依据的完整注释随迁至该函数。
  // ════════════════════════════════════════════════════════════
  setupEngineAwarenessInjector(pi, {
    getLastEngine: (sid) => sessionState.get(sid)?.lastEngine,
    setLastEngine: (sid, engine) => {
      const state = sessionState.get(sid);
      if (state) state.lastEngine = engine;
    },
  });

  // ════════════════════════════════════════════════════════════
  //  model_select：用户切换 model 时刷新缓存
  // ════════════════════════════════════════════════════════════
  pi.on("model_select", (event, ctx: ExtensionContext) => {
    const service = getModelConfigService();
    if (service && typeof service.setCtxModel === "function") {
      service.setCtxModel(event.model);
    }
    // H1: 同步刷新所有 session 的 SAR ctxModel（旧实现只在 session_start 固化）
    const sid = ctx.sessionManager.getSessionId();
    const state = sessionState.get(sid);
    if (state) {
      state.runner.updateCtxModel(event.model);
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_tree：切分支前终止所有 running run（一次性生命周期——切走即作废）
  // ════════════════════════════════════════════════════════════
  pi.on("session_tree", async (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

    const state = sessionState.get(sessionId);
    if (state) {
      // 一次性生命周期（D-2）：running run 转 done,failed 落盘（helper 内部自过滤
      // running，单 run 失败不中断其余）。此处不再挂起待恢复。
      try {
        await terminateRunningRuns(makeDeps(state, ctx), "Session switched: run terminated");
      } catch (err) {
        bestEffort(err, "terminateRunningRuns (session_tree handler)");
      }
    }
  });

  // ════════════════════════════════════════════════════════════
  //  SP-4: session_before_fork（/fork）/ session_before_switch（/new）级联关闭
  // ════════════════════════════════════════════════════════════
  //  主 session /fork 或 /new 时，清理旧 record（disposeAllRecords：CAS 转终态 +
  //  archive + worktree 清理）。before 事件在 session 替换前触发，确保旧 session 的
  //  subagent 在新 session 创建前被清理（随后的 session_shutdown → dispose 收割子进程）。
  //
  //  [M2 修复] 旧实现把 /new 级联挂在 session_before_tree 上——SDK 中该事件只由
  //  AgentSession.navigateTree()（/tree 同 session 分支切换）触发，/new 走
  //  session_before_switch(reason:"new") + session_shutdown(reason:"new")，从不触发
  //  before_tree。后果双向：/new 级联是死代码；普通 /tree 分支导航反而误杀全部活跃
  //  subagent。现 /new 改挂 session_before_switch(reason==="new")，before_tree handler
  //  移除（/tree 是同 session 内导航，record/子进程归属不变，无级联关闭诉求）。
  pi.on("session_before_fork", (_event, _ctx) => {
    const service = getSubagentService();
    if (service) {
      const count = service.onParentFork();
      if (count > 0) {
        logger.warn(`[subagents] /fork 级联关闭 ${count} 个 subagent`);
      }
    }
  });

  pi.on("session_before_switch", (event, _ctx) => {
    // /new（reason:"new"）创建全新 session → 级联关闭旧 record。
    // reason:"resume"（/resume /import 回到已有 session）不级联：record 按 rootSessionId
    // 归属隔离，跨 session 读写由 store 过滤守卫，无需销毁。
    if (event.reason !== "new") return;
    const service = getSubagentService();
    if (service) {
      const count = service.onParentNew();
      if (count > 0) {
        logger.warn(`[subagents] /new 级联关闭 ${count} 个 subagent`);
      }
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_shutdown：dispose subagents + terminate workflows + store 收尾 + cleanup
  //
  //  store 收尾：每 session 的 JsonlRunStore 在 terminateRunningRuns 之后 dispose（刷
  //  pending 去抖批 + await in-flight 链，见 W2C5）。R3 声明：SIGTERM/SIGINT 走下方
  //  process handler 不触发本路径，pending 去抖丢失等价崩溃链（重启后 kill-9 恢复
  //  收编 running 残留——终态/创建均冷路径已落盘，丢的只有 ≤saveDebounceMs 的
  //  running 尾巴，ES1 已接受）；不做 best-effort SIGTERM dispose（需同步 IO 改造，
  //  超出 wave 边界）。
  // ════════════════════════════════════════════════════════════
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    // ── subagents 域：dispose SubagentService ──
    getSubagentService()?.dispose();

    // [u7a D5] 在途上报通道随 session 终结：摘 ctx + 停重试（session 已死，重试直至
    // 成功的语义只对活 session 成立；进程级出口监听保留——后续 /new 重新 attach）。
    inflightReporter.detachSession();

    // ── workflow 域：terminate 所有 running run + store 收尾 + 清理 temp files ──
    // H-5: 遍历所有 sessionState 条目清理（而不只 lastSessionId——
    // 防御 session 切换但 session_tree 未先触发导致 lastSessionId 指向已删除 session 的情况）。
    for (const [sessionId, state] of sessionState) {
      // 编排顺序（W2C5）：terminate（await，failed 落盘——重启后 kill-9 恢复不误判）
      // → store.dispose（await，刷 pending 去抖批 + await in-flight 链，关「shutdown
      // 时刻 pending 去抖写丢失」窗口）→ delete。terminate 的 running 过滤在 helper
      // 内部（单 run 失败不中断其余）；外层 try/catch 兜底防单 session 异常中断后续
      // session 条目的 dispose + delete（对齐原 allSettled 的不中断语义）。
      try {
        await terminateRunningRuns(makeDeps(state, _ctx), "Session shutdown: run terminated");
      } catch (err) {
        bestEffort(err, "terminateRunningRuns (session_shutdown handler)");
      }
      // dispose 自身恒 resolve，catch 兜底防御——handler 内抛错会中断后续 session
      // 条目清理。不留静默吞错（错误必须可操作）：debug 留痕带 sessionId/sessionDir，
      // 排查「shutdown 后 run 状态不落盘」类问题时有迹可循。
      await state.store.dispose().catch((err: unknown) => {
        logger.debug(
          `[subagent-workflow] session_shutdown store.dispose failed (sessionId=${sessionId}, sessionDir=${state.sessionDir})`,
          { reason: toErrorMessage(err) },
        );
      });
      sessionState.delete(sessionId);
    }

    // M2: 清理 dialog queue 运行时状态（queue/current/processing）。
    // [#10] rejectAll() settle 所有 pending dialog Promise（防闭包泄漏：未 settle 的
    // Promise 持有 resolve/reject 闭包及 handler 上下文，session 退出后仍挂在全球队列上），
    // 并内部重置 queue/current/processing（原子操作，无 footgun）。
    // 单 session 假设（M-2，同 lastSessionId）：rejectAll() 清空进程级单例的所有 pending，
    // 依赖 Pi 单进程单 session 串行保证——不会误清其他 session。多 session 并发的迁移策略
    // 见 DialogGlobalQueue 类注释（rejectAllForSession）。
    // channel registry 不清：跨 session 持久是有意设计（ask-user 扩展注册的 channel handler
    // 在 /new /resume /fork 时不丢失注册）。
    const dialogQueue = getOrCreateDialogQueue();
    dialogQueue.rejectAll();
  });

  // ════════════════════════════════════════════════════════════
  //  [V2 决策 7 防线 i] process 级 shutdown hook（显式收割三道防线之一）
  //
  //  上方 session_shutdown（pi async hook）在进程被 SIGTERM/SIGINT 强杀或崩溃时
  //  不触发，此处 process.on 兜底确保 sync 子进程被收割（防线 i：shutdown 时显式
  //  SIGTERM 全部 activation）。
  //
  //  - SIGTERM：pi 各 mode（rpc/interactive/print）自带 SIGTERM handler 负责退出编排，
  //    本 extension 的 handler 只做收割 + 设 exitCode（不 re-raise、不抢 pi 的退出语义；
  //    xyz-agent 桌面 supervisor 用 SIGTERM 杀 pi 走这条路）。
  //  - SIGINT：pi 本体不注册常规 SIGINT handler（interactive/print/rpc 均 SIGTERM only），
  //    依赖 Node 默认终止。本 extension 注册 listener 即取消默认终止——若只设 exitCode，
  //    本地 pi CLI 的 Ctrl-C 杀不死进程（TUI/stdin/agent loop 仍在事件循环）。故收割
  //    完成后 re-raise 恢复默认终止，见下方 sigintHandler。
  //  - beforeExit 是退出前最后事件，不 exit（自然退出）。
  //  - idempotent guard（reapSpawnedChildrenOnShutdown 内）防多信号叠加重复 kill。
  //
  //  防线 iii（activate 互斥）：未接线——acquireActivateLock 机制已随简化清扫删除
  //  （历史接线点随协议化重构消失，仅余自持单测）。当前的双写者防护由
  //  subagent-service 的 resumesInFlight 集合守卫承担。
  //  防线 ii（启动孤儿扫描）：未接线，骨架已随 L2 死代码清扫删除（当前 piped stdio
  //  下 stdin-EOF 自灭链覆盖崩溃路径，见 docs/design/v2-defense-ii-iii-resolution.md）。
  // ════════════════════════════════════════════════════════════
  process.on("SIGTERM", () => {
    reapSpawnedChildrenOnShutdown();
    // S-3: 改用 process.exitCode 而非 process.exit(0)，让子进程 cleanup 完成后再自然退出。
    // process.exit(0) 会立即终止，可能在 reapSpawnedChildrenOnShutdown 完成前截断。
    // 退出编排归 pi 自身的 SIGTERM handler（rpc-mode 会主动退出）。
    process.exitCode = 0;
  });
  // [review 修复] SIGINT re-raise：收割同步完成后，先移除自身 listener 再向自身重发
  // SIGINT，恢复 Node 默认终止。不 removeListener 直接 kill(process.pid) 会再次进入
  // 本 handler 递归；移除后无其他 SIGINT listener（pi 不注册）→ 默认行为终止进程。
  const sigintHandler = (): void => {
    reapSpawnedChildrenOnShutdown();
    process.removeListener("SIGINT", sigintHandler);
    process.kill(process.pid, "SIGINT");
  };
  process.on("SIGINT", sigintHandler);
  process.on("beforeExit", reapSpawnedChildrenOnShutdown);

  // ════════════════════════════════════════════════════════════
  //  workflow deps 守卫（单一出口）
  //
  //  [守卫合一] 原 pi.__workflowRun 内联守卫 + getDeps 守卫两份重复（state 缺失 /
  //  storeHealthy=false），合并为单一 getWorkflowDeps：返回 discriminated union，
  //  两个消费点各自决定失败形态——pi.__workflowRun（D-8 API）返回错误对象（不
  //  throw，保住调用方 Promise 契约），getDeps（3 个 tool 的 lazy deps 源）throw
  //  （pi tool 框架将其转译为 tool 错误结果）。错误消息逐字保留（crash-recovery
  //  测试锁 "store unavailable" / "loadAll failed" 子串）。
  // ════════════════════════════════════════════════════════════
  type WorkflowDepsResolution =
    | { ok: true; deps: LauncherDeps }
    | { ok: false; reason: string };

  const getWorkflowDeps = (sessionId: string): WorkflowDepsResolution => {
    const state = sessionState.get(sessionId);
    if (!state) {
      return { ok: false, reason: "Session not initialized" };
    }
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      return { ok: false, reason: "Workflow store unavailable (loadAll failed in session_start)" };
    }
    return { ok: true, deps: makeDeps(state, state.ctx) };
  };

  // ════════════════════════════════════════════════════════════
  //  pi.__workflowRun（D-8 签名）
  // ════════════════════════════════════════════════════════════
  pi.__workflowRun = async (
    workflowName: string,
    workflowArgs: Record<string, unknown>,
    workflowSignal?: AbortSignal,
    workflowTimeoutMs?: number,
  ): Promise<WorkflowRunResult> => {
    // 注意：lastSessionId 是单值假设——Pi 当前保证单 session 串行（一次只一个活跃 session）。
    // 若未来 Pi 支持多 session 并发，此处需改为从 ctx.sessionManager.getSessionId() 显式传入。
    // M-2 已记录此假设。
    const resolved = getWorkflowDeps(lsRef.lastSessionId);
    if (!resolved.ok) {
      return {
        status: "done",
        reason: "failed",
        error: resolved.reason,
        runId: "",
      };
    }
    return runAndWait(
      workflowName,
      workflowArgs,
      resolved.deps,
      workflowSignal,
      workflowTimeoutMs,
    );
  };

  // ════════════════════════════════════════════════════════════
  //  Tools（3 个）—— lazy deps 注入
  //
  //  lazyDeps：属性访问触发 getWorkflowDeps 守卫 + makeDeps 求值（每属性独立）。
  //  守卫合一后 getWorkflowDeps 返回 discriminated union，getter 内消费时 throw
  //  （与 __workflowRun 的 return 错误对象对齐——同源同消息，session-lifecycle.test.ts 锁定）。
  // ════════════════════════════════════════════════════════════
  const lazyDeps: LauncherDeps = {
    get store() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.store;
    },
    get runs() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.runs;
    },
    get registry() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.registry;
    },
    get onRunDone() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.onRunDone;
    },
    get eventBus() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.eventBus;
    },
    get workerHost() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.workerHost;
    },
    get runner() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.runner;
    },
    // scheduleTimeBudget / onWorkflowCall 不可缺席（ports.ts D-12 regression fix）：
    // rebuildRuntime 重排 run 级墙钟预算计时器、worker 脚本嵌套 workflow() 调用都经
    // 这两个成员消费——lazyDeps 缺席会让消费点拿到 undefined（可选属性静默放行），
    // 带时间预算的 run 命中一次错误重试后计时器静默失效。转发形态与其余成员一致。
    get scheduleTimeBudget() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.scheduleTimeBudget;
    },
    get onWorkflowCall() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.onWorkflowCall;
    },
    get log() {
      const resolved = getWorkflowDeps(lsRef.lastSessionId);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.deps.log;
    },
  };

  registerWorkflowTool(pi, lazyDeps, guard);
  registerWorkflowScriptTool(pi, registry, isScriptRunning);

  // ════════════════════════════════════════════════════════════
  //  Commands（2 个）
  // ════════════════════════════════════════════════════════════
  registerWorkflowsCommand(
    pi,
    () => {
      const state = sessionState.get(lsRef.lastSessionId);
      return state?.runs ?? new Map();
    },
    lazyDeps,
  );
}

// ============================================================
// 进程级单例（channel registry + dialog queue）
// ============================================================

// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API）。
// dialog queue 单例随 session_start 装配域迁居 session-lifecycle.ts
// （getOrCreateDialogQueue；消费方 = 该文件 createOrReuseServices + 本文件
// session_shutdown），Symbol key 单定义点随迁，避免双份定义漂移。

// 跨扩展 channel handler 注册入口已收口到 core 深路径
// `@zhushanwen/subagent-core/execution/channel-registry-access.ts`
// （getOrCreateChannelRegistry / UiChannelRegistry / ChannelHandler）。
// 历史上的包根 re-export 已删：ask-user 等跨扩展消费者经 globalThis 握手
// （DIALOG_QUEUE_KEY 同款进程级单例），不再经包根 import 消费本模块。

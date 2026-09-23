/**
 * workflow-events — workflow 域事件族装配 seam。
 *
 * 随迁内容 = 原组合根 index.ts 的 workflow 域闭包状态与事件 handler（原样搬移，
 * D2 纪律：本文件不改行为；lazyDeps 10 个同构 getter 收敛为 createLazy 单一原语
 * ——守卫/throw/转发语义与错误消息逐字保留）。原闭包变量收编为显式
 * WorkflowDomainState（[skill-reload D2] 提权为 globalThis Symbol 槽 get-or-create
 * ——pi reload 时 jiti(moduleCache:false) 重求值模块图、模块级状态归零，槽跨
 * reload 存活，factory 重跑拿到同一 domain state，post-reload adoption 据此接管
 * 在飞 run）：
 *   1. per-factory 域状态（lsRef / notifiedRunIds / workerHost / registry / sessionState）
 *   2. log（pi.appendEntry 包装）+ makeLifecycleDeps + makeDeps（LauncherDeps 生产装配）
 *   3. 7 个 pi.on handler（session_start / session_compact / model_select /
 *      session_tree / session_before_fork / session_before_switch / session_shutdown，
 *      注册相对顺序原样保留）
 *   4. getWorkflowDeps 守卫（单一出口，discriminated union）+ lazyDeps（tool lazy 注入源）
 *
 * 组合根消费面：setupWorkflowDomain(pi, { inflightReporter }) 返回
 * WorkflowDomainHandle（state / lazyDeps / getWorkflowDeps / isScriptRunning），
 * tool + command 注册与 pi.__workflowRun 仍留 index.ts。
 *
 * [skill-reload D3] makeDeps 的三个 volatile 成员（eventBus / log / onRunDone 的
 * pi 与 GuiContext）不做闭包快照：pi 从槽上 currentPi 现读（factory 重跑时覆盖
 * 登记），ctx 从 sessionState 条目的 state.ctx 现读（adoption rebind 换新后自动
 * 跟进）——在飞 pump 持有的旧 deps 对象经属性访问自动路由到新绑定，无需遍历重绑。
 *
 * 测试入口：既有 index 挂载类测试（index-session-start / process-shutdown-hook /
 * wave0-package-structure 等）经 factory 间接覆盖；mock 锚点是模块解析路径
 * （jsonl-run-store / interface/* / subagent-core 深路径），随迁不改写。
 *
 * 架构导航见 docs/extensions/subagents/architecture.md §2.1。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
// ═══ 经 core barrel 消费 workflow 域（引擎与 worker 住 packages/subagent-core） ═══
import { bestEffort } from "@zhushanwen/subagent-core";
import { getBoundNotifyLedger } from "@zhushanwen/subagent-core";
import { getModelConfigService } from "@zhushanwen/subagent-core";
import { getSubagentService } from "@zhushanwen/subagent-core";
import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { executeNestedWorkflow, terminateRunningRuns } from "@zhushanwen/subagent-core";
import {
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  scheduleTimeBudget,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { WorkerHostImpl } from "@zhushanwen/subagent-core";
import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";
// [u7a D5] 在途上报出口类型（实例由组合根创建并接线 setInFlightListener，
// 本模块只在 session_start / session_shutdown 驱动 attach/detach）。
import type { InFlightReporter } from "./host/inflight-reporter.ts";
import { toGuiCtx } from "./interface/gui-mappers.ts";
import { notifyDone, trackNotifiedRunId } from "./interface/helpers.ts";
// ═══ session 生命周期装配 seam（bootstrap seam，设计 §3.1/D1） ═══
import {
  getOrCreateDialogQueue,
  setupSessionLifecycle,
  type SessionLifecycleDeps,
  type SessionLifecycleResult,
} from "./session-lifecycle.ts";

// 模块级 logger（与 index.ts 同 component 名；setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("subagents");

// ── per-factory 域状态（原 index.ts factory 闭包变量的显式收编） ────────────────

export interface WorkflowDomainState {
  /** 单值假设（M-2）：Pi 当前保证单 session 串行，lastSessionId 即当前活跃 session。 */
  lsRef: { lastSessionId: string };
  /** notifyDone 完成通知的去重窗口（trackNotifiedRunId 有界化维护）。 */
  notifiedRunIds: Set<string>;
  /** Infra 实例（per-factory 单例，跨 session 复用）。 */
  workerHost: WorkerHostImpl;
  /** workflow 脚本仓库（workflow-script tool 与 makeDeps 共享同一实例）。 */
  registry: WorkflowScriptRegistryImpl;
  /** per-session 状态（session_start 时重建）。value = SessionLifecycleResult
   *  （setupSessionLifecycle 装配结果，ctx 必有）。 */
  sessionState: Map<string, SessionLifecycleResult>;
  /** [skill-reload D3] current pi 的 volatile 登记点：setupWorkflowDomain 每次
   *  factory 重跑开头覆盖（reload 后新 factory 持新 pi）。makeDeps 的 eventBus /
   *  log / onRunDone 三 volatile 成员经属性访问从本成员现读——在飞 pump 持有的
   *  旧 deps 对象因此自动解析到新 pi，无需遍历重绑。undefined = setup 未跑过
   *  （makeDeps 只能经 setup 之后的事件链创建，命中即时序异常，fail-fast）。 */
  currentPi: ExtensionAPI | undefined;
}

function createWorkflowDomainState(): WorkflowDomainState {
  return {
    lsRef: { lastSessionId: "" },
    notifiedRunIds: new Set<string>(),
    workerHost: new WorkerHostImpl(),
    registry: new WorkflowScriptRegistryImpl(),
    sessionState: new Map<string, SessionLifecycleResult>(),
    currentPi: undefined,
  };
}

// [skill-reload D2] WorkflowDomainState 进程槽：与 SERVICE_SLOT_KEY /
// DIALOG_QUEUE_KEY 同一防线形态（globalThis[Symbol.for]，跨 jiti 多实例与
// pi reload 模块重求值存活）。get-or-create 整对象一槽——禁止逐字段筛选提权
// （sessionState/workerHost/registry/notifiedRunIds/lsRef 是一张对象图，漏提
// 一项即新旧实例并存、闭包引用分裂，设计被否项）。reload 后 factory 重跑经
// 此槽拿回同一 domain state，session_shutdown(reload) 跳过清理（D1）保住的
// 在飞 run / store 由 post-reload session_start(reason=reload) 的 adoption
// 接管（D4，session-lifecycle.ts）。
const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");

function getOrCreateWorkflowDomainState(): WorkflowDomainState {
  let state = Reflect.get(globalThis, WORKFLOW_DOMAIN_SLOT_KEY) as WorkflowDomainState | undefined;
  if (!state) {
    state = createWorkflowDomainState();
    Reflect.set(globalThis, WORKFLOW_DOMAIN_SLOT_KEY, state);
  }
  return state;
}

// [skill-reload D3] makeDeps volatile 成员的 pi 现读源。只读槽不创建——本函数被调
// 时 domainState 必已存在（makeDeps 只能经 setupWorkflowDomain 之后的事件链创建）。
// 窗口语义：reload 的 ②invalidate 到新 factory 重跑覆盖登记之间，这里读到的仍是
// 旧 pi（设计 D5 声明的窗口内 stale 形态，降级守卫在消费侧——notifyDone 的
// guardStaleCtx / store appendEntry 的 stale guard，本单元不处理）。缺失 = 时序
// 异常（槽被外力删除或 deps 逃逸到 setup 之前使用），fail-fast 带恢复指向。
function resolveCurrentPi(): ExtensionAPI {
  const state = Reflect.get(globalThis, WORKFLOW_DOMAIN_SLOT_KEY) as WorkflowDomainState | undefined;
  const pi = state?.currentPi;
  if (!pi) {
    throw new Error(
      "workflow deps current pi binding unset: setupWorkflowDomain has not run " +
        "(slot @zhushanwen/pi-subagents.workflow-domain-state); re-run extension factory to re-register",
    );
  }
  return pi;
}

/** 组合根侧生产 deps 工厂：SessionLifecycleDeps 全部成员有生产默认实现（住
 *  session-lifecycle.ts——createOrReuseServices 单例语义 / WorktreeManager 每次
 *  扫描新建 / JsonlRunStore per-session 新建），此处无本地构造可注入；工厂形态
 *  保留为组合根侧注入点（测试或后续演进可在此覆盖）。
 *  测试注入路径：不挂载 index.ts，直接调 setupSessionLifecycle(pi, ctx, fakeDeps)。
 *  [skill-reload D4] 唯一本地构造 onAdoptionFailed 依赖 setupWorkflowDomain 闭包
 *  （makeDeps / sessionState），其定义随迁函数体内部（见 makeDeps 之后）。 */

// ── workflow deps 守卫（单一出口） ─────────────────────────────────────────────
//
// [守卫合一] 原 pi.__workflowRun 内联守卫 + getDeps 守卫两份重复（state 缺失 /
// storeHealthy=false），合并为单一 getWorkflowDeps：返回 discriminated union，
// 两个消费点各自决定失败形态——pi.__workflowRun（D-8 API）返回错误对象（不
// throw，保住调用方 Promise 契约），getDeps（3 个 tool 的 lazy deps 源）throw
// （pi tool 框架将其转译为 tool 错误结果）。错误消息逐字保留（crash-recovery
// 测试锁 "store unavailable" / "loadAll failed" 子串）。
export type WorkflowDepsResolution =
  | { ok: true; deps: LauncherDeps }
  | { ok: false; reason: string };

// ── lazyDeps 样板收敛 ──────────────────────────────────────────────────────────

/**
 * lazyDeps 单成员转发原语：属性访问触发 getWorkflowDeps 守卫求值，失败 throw
 * （与 __workflowRun 的 return 错误对象对齐——同源同消息），成功转发 deps[key]。
 * 收敛原 index.ts 10 个同构 4 行 getter；每属性独立求值语义不变。
 */
function createLazy<K extends keyof LauncherDeps>(
  resolve: () => WorkflowDepsResolution,
  key: K,
): LauncherDeps[K] {
  const resolved = resolve();
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.deps[key];
}

// ── 组合根消费面 ───────────────────────────────────────────────────────────────

export interface WorkflowDomainHandle {
  /** workflow 域状态（组合根只读消费：engine-awareness lastEngine 存取器 /
   *  workflows command runs getter / pi.__workflowRun lastSessionId）。 */
  state: WorkflowDomainState;
  /** 3 个 tool + workflows command 的 lazy deps 注入源。 */
  lazyDeps: LauncherDeps;
  /** 守卫单一出口（pi.__workflowRun 消费点；lazyDeps 内部走同一函数）。 */
  getWorkflowDeps(sessionId: string): WorkflowDepsResolution;
  /** workflow-script tool 的重入检查（跨 session 全局视角）。 */
  isScriptRunning(name: string): boolean;
}

/**
 * workflow 域事件族装配单一入口（事件族 seam，与 session-lifecycle.ts 同构）。
 * index.ts 的 workflow 域退为本调用 + 装配结果消费。
 *
 * 7 个 pi.on handler 的注册相对顺序原样保留（session_start → session_compact →
 * model_select → session_tree → session_before_fork → session_before_switch →
 * session_shutdown）；engine-awareness（before_agent_start 链尾）仍由组合根在
 * 本调用之后注册（before_agent_start 链序不变，跨事件通道无注册时序语义）。
 */
export function setupWorkflowDomain(
  pi: ExtensionAPI,
  wiring: { inflightReporter: InFlightReporter },
): WorkflowDomainHandle {
  const { inflightReporter } = wiring;
  // [skill-reload D2] handle.state 即槽对象本身（不做解构重包装——否则容器每次
  // factory 重跑新建，调用方拿不到「同一 domain state 引用」的接管前提）。
  const domainState = getOrCreateWorkflowDomainState();
  // [skill-reload D3] current pi 登记点：factory 每次重跑（reload 后新 factory 持新
  // pi）在此覆盖槽上 volatile 绑定——旧 deps 对象的现读成员（见 makeDeps）自动
  // 路由到新 pi，这是「不做遍历重绑」的登记侧前提。
  domainState.currentPi = pi;
  const { lsRef, notifiedRunIds, sessionState, workerHost, registry } = domainState;

  // [skill-reload D3] log 不闭包捕获 factory 期 pi：每次调用从槽现读 current pi
  // ——reload 后旧 deps.log 的 workflow:log entry 落进新 pi 的权威 session JSONL
  // （旧 pi 的 session 已随 reload invalidate，写旧 pi 命中 assertActive 即丢日志）。
  function log(
    level: "debug" | "info" | "warn" | "error",
    component: string,
    message: string,
    data?: unknown,
  ): void {
    try {
      resolveCurrentPi().appendEntry("workflow:log", {
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

  function makeDeps(
    state: Pick<SessionLifecycleResult, "store" | "runs" | "sessionDir" | "runner" | "ctx">,
  ) {
    const deps: LauncherDeps = {
      store: state.store,
      workerHost,
      runner: state.runner,
      runs: state.runs,
      registry,
      // [skill-reload D3] 三个 volatile 成员（eventBus / log / onRunDone 的 pi 与
      // GuiContext）现读不快照：pi 从槽 currentPi 解析（factory 重跑覆盖登记），ctx
      // 从 state.ctx 解析（槽上 sessionState 条目字段，adoption rebind 换新后自动
      // 跟进）。在飞 pump 持有的旧 deps 对象经属性访问自动路由到新 pi/ctx。eventBus
      // 是值成员必须 getter；log/onRunDone 是函数成员，现读在函数体内达成（函数引用
      // 稳定，调用方缓存引用也无 stale 面）。
      //
      // onRunDone 是全部 done 路径的单点汇聚（abortRun + error-recovery），顺序固化为
      // notify → track → evict：notifyDone 先发完整聚合通知（淘汰后聚合根仍在闭包参数
      // run 引用上不受影响），trackNotifiedRunId 有界化去重窗口，最后裁剪 done run 内存。
      // 本轮 run 的 completedAt 在 transition("done") 时同步设为当前时刻=全局最新，
      // 恒在保留端——结构性保证其不被自身触发的裁剪淘汰，无需 protectRunId。
      onRunDone: (run: WorkflowRun) => {
        notifyDone(resolveCurrentPi(), run.runId, run, notifiedRunIds, toGuiCtx(state.ctx));
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
      get eventBus() {
        return resolveCurrentPi().events;
      },
      // [reload-closeout D4] pending:unregister 直落权威面：finalizeRun 直接
      // appendEntry 落盘（session JSONL 唯一权威），不经 eventBus emit→内存
      // listener——emit 链在 reload 转换窗/多 extension factory 顺序窗内整链失效，
      // 丢失即注销 entry 永缺位（S1b 事故形态①段）。函数体内现读 current pi
      // （与 log/onRunDone 同款 volatile 形态）——在飞 pump 持有的旧 deps 对象
      // 经属性访问自动路由到新 pi。
      appendEntry: (customType: string, data: unknown) => {
        resolveCurrentPi().appendEntry(customType, data);
      },
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

  /** [skill-reload D4] onAdoptionFailed 依赖 setupWorkflowDomain 闭包（makeDeps 的
   *  LauncherDeps 完整形态——workerHost / onRunDone 通知链经 D3 现读自动路由到新
   *  pi；sessionState 移除依赖 domain state Map），归 workflow 域、session-lifecycle
   *  seam 无访问通道，经 SessionLifecycleDeps 注入。 */
  function makeLifecycleDeps(): SessionLifecycleDeps {
    return {
      onAdoptionFailed: async (existing, reason) => {
        // notifyDone: true（D4/r4）——session 仍在（reload 是同会话原地重建），run
        // 终止对用户必须可见（G3 不静默）；terminate 前的 rebind-first 已在
        // failAdoption 完成，终态 flush 走新 pi 落权威 JSONL。
        await terminateRunningRuns(
          makeDeps(existing),
          `skill reload adoption failed: ${reason}`,
          { notifyDone: true },
        );
        sessionState.delete(existing.sessionId);
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  //  session_start：初始化 subagents + workflow 两域
  //
  //  六职责编排（identity 重建 / ledger 装配 / 双 Service 装配 / GC+恢复 / kill-9
  //  循环 / SAR+engine 基线）已随迁 session-lifecycle.ts（bootstrap seam，设计
  //  §3.1/D1/D2 原样搬移）。此处仅接线：lastSessionId 先行赋值（时序与原 handler
  //  开头一致）+ 装配结果写入 per-session sessionState。
  // ════════════════════════════════════════════════════════════
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    lsRef.lastSessionId = ctx.sessionManager.getSessionId();
    // [u7a D5] 初始上报（count=当下绝对计数）：触发时点 = extension 加载完成 / session
    // 就绪（factory 无 ctx/ui，session_start 是最早带 ctx 的钩子——plugin-bridge 同款
    // 事实）。fire-and-forget 在 await 装配链之前发起，不阻塞也不被阻塞。
    inflightReporter.attachSession(ctx);
    // [skill-reload D4] adoption 入参接线：reason 是 handler 独占信息（event 参数），
    // existing 是 sessionState（domainState 闭包）里的既有条目——两者都是
    // session-lifecycle seam 的 adoption 分流判据，经 SessionStartOptions 传入。
    // 非 reload 的 session_start 不取 existing（quit 族 session_shutdown 已删条目，
    // 此处恒 undefined；显式不传也防误接管）。
    const existing =
      event.reason === "reload" ? sessionState.get(ctx.sessionManager.getSessionId()) : undefined;
    const result = await setupSessionLifecycle(pi, ctx, makeLifecycleDeps(), {
      reason: event.reason,
      existing,
    });
    sessionState.set(result.sessionId, result);
  });

  // ════════════════════════════════════════════════════════════
  //  [U2 P-B4 降级] session_compact：compaction 对 custom entry 保留行为实装未
  //  验证——检测 ledger/ack entry 被 compaction 清除时按内存态补写（notify-ledger
  //  compactionCheck；未清除则 no-op）。内存态在 compaction 后仍活着，作为补写源；
  //  重启后的权威仍是两列 entry 差集（内存不承担销账职责）。
  // ═══════════════════════════════════════════════════════════
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
        await terminateRunningRuns(makeDeps(state), "Session switched: run terminated");
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
  //  [skill-reload D1] 按 reason 分支：pi 的 SessionShutdownReason 枚举
  //  （quit|reload|new|resume|fork，SDK types.d.ts）里 reload 是唯一「同会话原地
  //  重建」成员——进程不死、session 不离开，仅 extension 模块图重求值。reload 分支
  //  跳过全部破坏性动作（a dispose / c terminate / d store.dispose / e sessionState
  //  清除 / f dialogQueue.rejectAll），只执行 b（inflightReporter.detachSession，
  //  detach 不是破坏——旧 reporter 是 per-factory 实例，不 detach 会在重试循环里持
  //  stale ctx 反复 attempt；新 factory 建新 reporter 并覆盖进程级单监听）。存活的
  //  在飞 run / store 经 D2 槽由 post-reload session_start(reason=reload) 的
  //  adoption 接管（D4，session-lifecycle.ts）。quit/new/resume/fork = 会话真离开，
  //  六动作现状全保持；session_tree / session_before_switch 的 terminate 路径不受
  //  影响（各自独立 handler，真语义）。
  //
  //  store 收尾：每 session 的 JsonlRunStore 在 terminateRunningRuns 之后 dispose（刷
  //  pending 去抖批 + await in-flight 链，见 W2C5）。R3 声明：SIGTERM/SIGINT 走
  //  组合根 process handler 不触发本路径，pending 去抖丢失等价崩溃链（重启后 kill-9
  //  恢复收编 running 残留——终态/创建均冷路径已落盘，丢的只有 ≤saveDebounceMs 的
  //  running 尾巴，ES1 已接受）；不做 best-effort SIGTERM dispose（需同步 IO 改造，
  //  超出 wave 边界）。
  // ════════════════════════════════════════════════════════════
  pi.on("session_shutdown", async (event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    if (event.reason === "reload") {
      // b 动作保留（理由见上方 D1 分支说明）。
      inflightReporter.detachSession();

      // [skill-reload D8] reload 分支归因日志：preserved 计数取自跳过清理时的存活
      // 对象真实统计（runs = 各 session 内存 run 聚合根数；records = run.state.calls
      // 的 agent 调用数——每 call 对应一条 subagent record；stores = sessionState
      // 条目数即 store 实例数），供归因演练（S4）与 orchestrator 段日志对账——
      // 「reload 存活了什么」必须能从这一行直接读出，不靠时间戳猜。
      let preservedRuns = 0;
      let preservedRecords = 0;
      for (const state of sessionState.values()) {
        preservedRuns += state.runs.size;
        for (const run of state.runs.values()) {
          preservedRecords += run.state.calls.size;
        }
      }
      logger.debug(
        `[workflow-events] session_shutdown reason=reload preserved={runs:${preservedRuns}, records:${preservedRecords}, stores:${sessionState.size}}`,
      );
      return;
    }

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
        await terminateRunningRuns(makeDeps(state), "Session shutdown: run terminated");
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

  const getWorkflowDeps = (sessionId: string): WorkflowDepsResolution => {
    const state = sessionState.get(sessionId);
    if (!state) {
      return { ok: false, reason: "Session not initialized" };
    }
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      return { ok: false, reason: "Workflow store unavailable (loadAll failed in session_start)" };
    }
    return { ok: true, deps: makeDeps(state) };
  };

  // ════════════════════════════════════════════════════════════
  //  lazyDeps（3 个 tool + workflows command 的 lazy deps 注入源）
  //
  //  属性访问触发 getWorkflowDeps 守卫 + makeDeps 求值（每属性独立，createLazy
  //  原语转发）。守卫合一后 getWorkflowDeps 返回 discriminated union，getter 内
  //  消费时 throw（与 __workflowRun 的 return 错误对象对齐——同源同消息，
  //  session-lifecycle.test.ts 锁定）。
  // ════════════════════════════════════════════════════════════
  const resolveDeps = (): WorkflowDepsResolution => getWorkflowDeps(lsRef.lastSessionId);
  const lazyDeps: LauncherDeps = {
    get store() { return createLazy(resolveDeps, "store"); },
    get runs() { return createLazy(resolveDeps, "runs"); },
    get registry() { return createLazy(resolveDeps, "registry"); },
    get onRunDone() { return createLazy(resolveDeps, "onRunDone"); },
    get eventBus() { return createLazy(resolveDeps, "eventBus"); },
    get workerHost() { return createLazy(resolveDeps, "workerHost"); },
    get runner() { return createLazy(resolveDeps, "runner"); },
    // scheduleTimeBudget / onWorkflowCall / appendEntry 不可缺席（ports.ts D-12
    // regression fix 同族）：rebuildRuntime 重排 run 级墙钟预算计时器、worker 脚本
    // 嵌套 workflow() 调用、finalizeRun 的 pending:unregister 直落都经这三个成员
    // 消费——lazyDeps 缺席会让消费点拿到 undefined（可选属性静默放行）；appendEntry
    // 缺席尤其危险：workflow tool 的 run action 以 lazyDeps 为 deps 启动 run，直落
    // 静默跳过 + emit 已删 = 注销 entry 永缺位。转发形态与其余成员一致。
    get scheduleTimeBudget() { return createLazy(resolveDeps, "scheduleTimeBudget"); },
    get onWorkflowCall() { return createLazy(resolveDeps, "onWorkflowCall"); },
    get appendEntry() { return createLazy(resolveDeps, "appendEntry"); },
    get log() { return createLazy(resolveDeps, "log"); },
  };

  return { state: domainState, lazyDeps, getWorkflowDeps, isScriptRunning };
}

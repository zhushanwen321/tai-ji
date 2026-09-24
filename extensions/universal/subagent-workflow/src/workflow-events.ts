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
 *   3. 本域 3 个 pi.on handler（session_start / session_tree / session_shutdown）
 *      + 4 个跨域事件注册（notify ledger compaction 守卫 / model 缓存刷新 /
 *      subagents 父级联关闭×2——setup* 函数住各自域模块，本 seam 在原注册位
 *      置调用；pi.on 全链注册顺序逐位不变，
 *      workflow-events-registration-order.test.ts 锁定）
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

import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
// ═══ 经 core barrel 消费 workflow 域（引擎与 worker 住 packages/subagent-core） ═══
import { bestEffort } from "@zhushanwen/subagent-core";
import { getSubagentService } from "@zhushanwen/subagent-core";
import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { executeNestedWorkflow, terminateRunningRuns } from "@zhushanwen/subagent-core";
import {
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  RUN_EVENT_JOURNAL_SUFFIX,
  scheduleTimeBudget,
  STATE_DIR_NAME,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { WorkerHostImpl } from "@zhushanwen/subagent-core";
import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";
// [u7a D5] 在途上报出口类型（实例由组合根创建并接线 setInFlightListener，
// 本模块只在 session_start / session_shutdown 驱动 attach/detach）。
import type { InFlightReporter } from "./host/inflight-reporter.ts";
import { notifyDone, notifyStall, trackNotifiedRunId, WORKFLOW_STALL_THRESHOLD_MS } from "./workflow-notify.ts";
// ═══ 跨域事件注册（handler 体住各自域模块，本 seam 原位调用保注册顺序） ═══
import { setupNotifyLedgerCompactionGuard } from "./workflow-notify.ts";
import { setupModelEvents } from "./model-events.ts";
import { setupSubagentsCascadeEvents } from "./subagents-events.ts";
import { toGuiCtx } from "./interface/gui-mappers.ts";
// ═══ session 生命周期装配 seam（bootstrap seam，设计 §3.1/D1） ═══
import {
  getOrCreateDialogQueue,
  setupSessionLifecycle,
  type SessionLifecycleDeps,
  type SessionLifecycleResult,
} from "./session-lifecycle.ts";
// ═══ [D6-2] stall watchdog（run 无进展 informational 通知——监控逻辑独立模块，此处仅装配） ═══
import { getOrCreateStallWatchdog, type StallRunView } from "./workflow-stall-watchdog.ts";

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
// throw，保住调用方 Promise 契约），getDeps（2 个 tool + workflows command 的
// lazy deps 注入源——workflow-script tool 走 state.registry 直供不经 lazyDeps）
// throw
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
  /** 2 个 tool + workflows command 的 lazy deps 注入源（workflow-script tool 走 state.registry 直供不经 lazyDeps）。 */
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
 * 本域 3 个 handler（session_start → session_tree → session_shutdown）与 4 个
 * 跨域 setup* 注册（notify ledger compaction 守卫 / model 缓存刷新 / subagents
 * 父级联关闭×2）交错，pi.on 全链注册顺序逐位不变（锁
 * workflow-events-registration-order.test.ts）；engine-awareness
 * （before_agent_start 链尾）仍由组合根在本调用之后注册（before_agent_start
 * 链序不变，跨事件通道无注册时序语义）。
 */
export function setupWorkflowDomain(
  pi: ExtensionAPI,
  wiring: { inflightReporter: InFlightReporter },
): WorkflowDomainHandle {
  const { inflightReporter } = wiring;
  // [skill-reload D2] handle.state 即槽对象本身（不做解构重包装——否则容器每次
  //  factory 重跑新建，调用方拿不到「同一 domain state 引用」的接管前提）。
  const domainState = getOrCreateWorkflowDomainState();
  // [D6-2] stall watchdog 装配：监控逻辑本体在 workflow-stall-watchdog.ts（timer/
  // 判定/恰一次/journal 尾读内聚，可脱离装配面直测），此处仅注入 deps + arm（arm
  // 幂等清旧 timer——reload 防双 tick；实例跨 reload 挂槽复用，恰一次标记不丢）。
  // status 过滤与 journalPath 构造在投影内（模块收纯 view，零路径知识）。
  const stallWatchdog = getOrCreateStallWatchdog({
    thresholdMs: WORKFLOW_STALL_THRESHOLD_MS,
    *getRunningRuns() {
      for (const st of domainState.sessionState.values()) {
        for (const run of st.runs.values()) {
          if (run.state.status !== "running") continue;
          yield {
            runId: run.runId,
            scriptName: run.spec.scriptName,
            startedAtMs: Date.parse(run.meta.startedAt),
            journalPath: join(st.sessionDir, STATE_DIR_NAME, `${run.runId}${RUN_EVENT_JOURNAL_SUFFIX}`),
          } satisfies StallRunView;
        }
      }
    },
    notifyStalled: (view, stalledMs, lastProgressMs) =>
      notifyStall(resolveCurrentPi(), view.runId, view.scriptName, stalledMs, lastProgressMs),
    onTickError: (err) => {
      logger.warn(`[workflow] stall watchdog tick failed: ${toErrorMessage(err)}`);
    },
  });
  stallWatchdog.arm();
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
      // appendEntry 失败（stale ctx / session 已关闭等）= workflow:log entry 零痕迹。
      // 独立通道留痕：extension-logger 的写点通道是 `subagents:log`（非
      // `workflow:log`），不重入本函数；其 error() 内部 catch appendEntry 失败并
      // 降级文件日志（TAIJI_AGENT_DEBUG=1 可见），自身不再抛。
      logger.error(
        `[subagent-workflow] workflow:log appendEntry failed (component=${component}): ${message}`,
        { level, reason: toErrorMessage(err) },
      );
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
      //
      // [D7] notifyDone 第 6 参注入产物目录指针（<sessionDir>/workflow-state——
      // journal/manifest/.state 同目录；state.sessionDir 是 sessionState 条目字段，
      // adoption rebind 换新后自动跟进；目录分量经 core barrel STATE_DIR_NAME 单源）。
      // [D6-2] 终局同时回收 stall 已通知标记（转发 watchdog 槽实例——run 已终局，
      // stall 声明生命周期结束；Set 防泄漏）。
      onRunDone: (run: WorkflowRun) => {
        stallWatchdog.noteRunSettled(run.runId);
        notifyDone(
          resolveCurrentPi(),
          run.runId,
          run,
          notifiedRunIds,
          toGuiCtx(state.ctx),
          join(state.sessionDir, STATE_DIR_NAME),
        );
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
          // [C2] 错误带恢复动作：service 缺席 = session_start 装配链失败（与
          // getWorkflowDeps 的 Session not initialized 同根因），文案同款闭环。
          throw new Error(
            "workflow agent dispatch unavailable: subagent service not initialized " +
              "(session_start assembly failed). Recovery: restart pi or reload this session; " +
              "check the subagents extension logs for the root cause.",
          );
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
    // 装配链异常不向 pi 事件分发逃逸（pi 0.84.4 extension handler 未捕获的 rejection
    // 直接炸进程——E1 同机制）：围栏 error 留痕（含 sessionId）后保持 handler 不抛。
    // lsRef 在 try 内先行赋值：getSessionId 自身抛错时 catch 里拿到的是上一 session
    // 的 id（留痕仍可检索）。
    try {
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
    } catch (err) {
      logger.error(
        `[subagent-workflow] session_start handler failed (sessionId=${lsRef.lastSessionId})`,
        { reason: toErrorMessage(err) },
      );
    }
  });

  // ════════════════════════════════════════════════════════════
  //  [U2 P-B4 降级] notify ledger compaction 补写守卫（notify 域）
  // ════════════════════════════════════════════════════════════
  setupNotifyLedgerCompactionGuard(pi);

  // ════════════════════════════════════════════════════════════
  //  model 缓存刷新（model 域）
  // ════════════════════════════════════════════════════════════
  setupModelEvents(pi);

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
        // 外层兜底（正常路径 helper 内部已自过滤单 run 失败）——error 级：终态落盘
        // 失败意味着重启后 kill-9 恢复的输入缺失，必须可见。
        bestEffort(err, "terminateRunningRuns (session_tree handler)", "error");
      }
    }
  });

  // ════════════════════════════════════════════════════════════
  //  SP-4: 父级联关闭（subagents 域）——/fork 与 /new 的级联 record 清理
  // ════════════════════════════════════════════════════════════
  setupSubagentsCascadeEvents(pi);

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
  //  六动作现状全保持；session_tree 与 /new 父级联（subagents-events.ts）的
  //  terminate 路径不受影响（各自独立 handler，真语义）。
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
    // dispose 是多步同步链，任一步同步抛错会跳过后续全部清理（terminateRunningRuns /
    // store.dispose / dialogQueue.rejectAll）——围栏与下方 store.dispose 的防御同款：
    // error 留痕（含 sessionId）后继续后续清理，不向 pi 事件分发逃逸。
    try {
      getSubagentService()?.dispose();
    } catch (err) {
      logger.error(
        `[subagent-workflow] session_shutdown SubagentService.dispose failed (sessionId=${lsRef.lastSessionId})`,
        { reason: toErrorMessage(err) },
      );
    }

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
        // 外层兜底（正常路径 helper 内部已自过滤单 run 失败）——error 级：终态落盘
        // 失败意味着重启后 kill-9 恢复的输入缺失，必须可见。
        bestEffort(err, "terminateRunningRuns (session_shutdown handler)", "error");
      }
      // dispose 自身恒 resolve，catch 兜底防御——handler 内抛错会中断后续 session
      // 条目清理。不留静默吞错（错误必须可操作）：warn 留痕带 sessionId/sessionDir，
      // 排查「shutdown 后 run 状态不落盘」类问题时有迹可循。
      await state.store.dispose().catch((err: unknown) => {
        logger.warn(
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
      // [C2] 错误带恢复动作（对齐下方 store unavailable 的 MF-1 闭环风格）：state
      // 缺席的 root cause 是 session_start 装配链失败（围栏 catch 只留 extension
      // 日志），文案指引 reload + 查日志，接通「现象 → 根因」链路。前缀子串
      // "Session not initialized" 被 session-lifecycle / workflow-events-deps-getter
      // 测试锁定（toThrowError 子串匹配），改写时保留该前缀。
      return {
        ok: false,
        reason:
          "Session not initialized (session_start assembly failed). " +
          "Recovery: restart pi or reload this session to re-run initialization; " +
          "check the subagents extension logs (session_start failure) for the root cause.",
      };
    }
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      // 错误带恢复动作（错误 → 恢复闭环）：loadAll 失败的 store 本进程内不恢复，
      // 重启 pi 或重载 session（重建 store + 重跑 kill-9 恢复）是唯一出路。前半段
      // 子串（"store unavailable" / "loadAll failed"）被 crash-recovery 等测试锁定。
      return {
        ok: false,
        reason:
          "Workflow store unavailable (loadAll failed in session_start). " +
          "Restart pi or reload this session to re-run crash recovery.",
      };
    }
    return { ok: true, deps: makeDeps(state) };
  };

  // ════════════════════════════════════════════════════════════
  //  lazyDeps（2 个 tool + workflows command 的 lazy deps 注入源；
  //  workflow-script tool 走 state.registry 直供不经 lazyDeps）
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
    // [A1 修复循环 R3] workflowAgentDispatch 必须随 lazyDeps 转发：workflow tool 的
    // run action 以 lazyDeps 为 deps 启动 run，漏本成员则 pump dispatchAgentCall 读到
    // undefined 回退 deps.runner（SAR.run 占位 runId）→ record.parentRunId =
    // "sar-unattached" → armed 回执落账键错 → fold 出 created 态 → IllegalTransitionError
    // 让位，run journal 恒缺 armed 帧（真机 wf-1790034646281-w7tp4f 实证链，R2 裁决）。
    get workflowAgentDispatch() { return createLazy(resolveDeps, "workflowAgentDispatch"); },
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

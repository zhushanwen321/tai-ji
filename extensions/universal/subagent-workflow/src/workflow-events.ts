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
 *   2. log（pi.appendEntry 包装）+ runSettledEffects（onRunDone 三步终局副作用
 *      管线，具名导出可直测）+ makeLifecycleDeps + makeDeps（LauncherDeps 纯装配）
 *   3. 本域 3 个 pi.on handler（session_start / session_tree / session_shutdown）
 *      + 4 个跨域事件注册（notify ledger compaction 守卫 / model 缓存刷新 /
 *      subagents 父级联关闭×2——setup* 函数住各自域模块，本 seam 在原注册位
 *      置调用；pi.on 全链注册顺序逐位不变，
 *      workflow-events.test.ts 锁定）
 *   4. deps 守卫（单一出口，失败 throw）+ lazyDeps（tool lazy 注入源）
 *
 * 组合根消费面：setupWorkflowDomain(pi) 返回
 * WorkflowDomainHandle（state / lazyDeps / isScriptRunning），
 * tool + command 注册仍留 index.ts。
 *
 * [skill-reload D3] makeDeps 的三个 volatile 成员（eventBus / log / onRunDone 的
 * pi）不做闭包快照：pi 从槽上 currentPi 现读（factory 重跑时覆盖登记）——在飞
 * pump 持有的旧 deps 对象经属性访问自动路由到新绑定，无需遍历重绑。
 *
 * 测试入口：既有 index 挂载类测试（index-session-start / process-shutdown-hook /
 * wave0-package-structure 等）经 factory 间接覆盖；mock 锚点是模块解析路径
 * （jsonl-run-store / interface/* / subagent-core 深路径），随迁不改写。
 * runSettledEffects 经 fake deps 直测（workflow-events.test.ts，
 * 不挂装配面）。注册顺序经 workflow-events.test.ts 锁定。
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
import { terminateRunningRuns } from "@zhushanwen/subagent-core";
import { setInFlightListener } from "@zhushanwen/subagent-core";
import {
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  runSummary,
  scheduleTimeBudget,
  STATE_DIR_NAME,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { WorkerHostImpl } from "@zhushanwen/subagent-core";
import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";
// [u7a D5] 在途上报出口：实例由本 seam 创建并接线 setInFlightListener（组合根零
// 管道），session_start / session_shutdown 驱动 attach/detach；测试可注入 fake。
import { createInFlightReporter, type InFlightReporter } from "./host/inflight-reporter.ts";
// [W2/V1 D1 第 8 行] 判活类消费面（isScriptRunning）经 core 投影单点
//（runSummary.status 三态投影——终局判定源 = 终局记录注册表）。
import { type RunSettlementRecord } from "./jsonl-run-store.ts";
import { notifyDone, trackNotifiedRunId } from "./workflow-notify.ts";
// ═══ 跨域事件注册（handler 体住各自域模块，本 seam 原位调用保注册顺序） ═══
import { setupNotifyLedgerCompactionGuard } from "./workflow-notify.ts";
import { setupModelEvents } from "./model-events.ts";
import { setupSubagentsCascadeEvents } from "./subagents-events.ts";
// ═══ session 生命周期装配 seam（bootstrap seam，设计 §3.1/D1） ═══
import { GLOBAL_SLOT_KEYS } from "@zhushanwen/subagent-core";
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
const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.workflowDomainState);

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
        `(slot ${GLOBAL_SLOT_KEYS.workflowDomainState}); re-run extension factory to re-register`,
    );
  }
  return pi;
}

// ── workflow deps 守卫（单一出口） ─────────────────────────────────────────────
//
// 守卫单一出口（lazyDeps 消费）：state 缺失 / storeHealthy=false 时 throw（pi tool
// 框架将其转译为 tool 错误结果）。错误消息逐字保留（crash-recovery 测试锁
// "store unavailable" / "loadAll failed" 子串）。

// ── lazyDeps 样板收敛 ──────────────────────────────────────────────────────────

/**
 * lazyDeps 单成员转发原语：属性访问触发 deps 守卫求值，失败 throw，成功转发
 * deps[key]。收敛原 index.ts 10 个同构 4 行 getter；每属性独立求值语义不变。
 */
function createLazy<K extends keyof LauncherDeps>(
  resolve: () => LauncherDeps,
  key: K,
): LauncherDeps[K] {
  return resolve()[key];
}

// ── run 终局固定顺序副作用（makeDeps onRunDone 管线提级，可直测） ─────────────

/** runSettledEffects 的注入面（生产装配点 = makeDeps；直测注入 fake——模块行为
 *  可脱离装配面独立测试）。 */
export interface RunSettledEffectsEnv {
  /** 完成通知的发送面（现读 volatile pi：生产传 resolveCurrentPi，调用时解析——
   *  D3 不快照，reload 后自动路由新 pi）。 */
  resolvePi(): ExtensionAPI;
  /** notifyDone 完成通知去重窗口（domainState.notifiedRunIds，调用方持有）。 */
  notifiedRunIds: Set<string>;
  /** per-session 装配结果（sessionDir/runs 两字段调用时现读——sessionState
   *  条目引用，adoption rebind 换新后自动跟进的 D3 语义保持）。 */
  state: Pick<SessionLifecycleResult, "sessionDir" | "runs">;
  /**
   * [W2/V1 D1 第 7 行] 终局记录查询面（通知载荷源——journal run-settled 帧直取）。
   * 生产装配 = JsonlRunStore.settledRecordOf；返回 undefined = 无终局帧（journal
   * dispatch 失败窗口）——通知跳过 + error 留痕（不回退两态机字段兜底：I2 失效
   * 窗口下兜底 = 恒 completed 假成功，比丢通知更糟）。
   */
  settledRecordOf(runId: string): RunSettlementRecord | undefined;
  /** evict 日志的 session 归属（lsRef 引用，调用时现读 lastSessionId）。 */
  lsRef: { lastSessionId: string };
}

/**
 * run 终局后的固定顺序副作用管线（原 makeDeps 的 onRunDone 闭包体提级具名导出）。
 *
 * onRunDone 是全部 done 路径的单点汇聚（abortRun + error-recovery），顺序固化为
 * notifyDone → trackNotifiedRunId → evictDoneRunsBeyondCap：
 * notifyDone 先发完整聚合通知（淘汰后聚合根仍在参数 run 引用上不受影响），
 * trackNotifiedRunId 有界化去重窗口，最后裁剪已终局 run 内存（[W2/V1] 终局判定
 * 经 core isRunSettled 换源——本管线被 onRunDone 触发时注册表已 note，本轮 run
 * 恒可淘汰候选，且其终局时序 = 全局最新，恒在保留端，不被自身触发的裁剪淘汰）。
 *
 * 失败语义（直测锁定，workflow-events.test.ts）：管线内部无围栏
 * ——notifyDone 抛错（账本写账失败 / 降级直发非 stale 失败）时后续 track/evict
 * 不执行、异常原样上抛，由调用方 finalizeRun 的 onRunDone 独立 try 围栏接住
 * （core worker-message-pump，OR-4/B-4：真实副作用失败 error 留痕不崩宿主）。
 * notifyDone 幂等早退（notifiedRunIds 已含 runId）不是错误：后两步照常执行。
 *
 * [D7] notifyDone 注入产物目录指针（<sessionDir>/workflow-state——
 * journal/manifest/.state 同目录；state.sessionDir 是 sessionState 条目字段，
 * adoption rebind 换新后自动跟进；目录分量经 core barrel STATE_DIR_NAME 单源）。
 * [W2/V1 D1 第 7 行] notifyDone 尾参注入终局记录（载荷源 = 帧直取）；记录缺席
 *（journal dispatch 失败窗口）时通知跳过 + error 留痕——evict 照常
 *（内存有界性独立于通知），track 不标（未发通知不占去重窗口，允许后续语义修正）。
 */
export function runSettledEffects(env: RunSettledEffectsEnv, run: WorkflowRun): void {
  const settlement = env.settledRecordOf(run.runId);
  if (settlement !== undefined) {
    notifyDone(
      env.resolvePi(),
      run.runId,
      run,
      env.notifiedRunIds,
      join(env.state.sessionDir, STATE_DIR_NAME),
      settlement,
    );
    trackNotifiedRunId(env.notifiedRunIds, run.runId);
  } else {
    logger.error(
      `[workflow] done notify skipped: settlement record unavailable (runId=${run.runId}) — ` +
        "run-settled journal dispatch likely failed; recovery: consult the journal error log above",
    );
  }
  const evicted = evictDoneRunsBeyondCap(env.state.runs, MAX_RETAINED_DONE_RUNS);
  if (evicted > 0) {
    logger.debug("[subagent-workflow] evicted done runs beyond cap", {
      evicted,
      keep: MAX_RETAINED_DONE_RUNS,
      sessionId: env.lsRef.lastSessionId,
    });
  }
}

// ── 组合根消费面 ───────────────────────────────────────────────────────────────

export interface WorkflowDomainHandle {
  /** workflow 域状态（组合根只读消费：engine-awareness lastEngine 存取器 /
   *  workflows command runs getter）。 */
  state: WorkflowDomainState;
  /** 2 个 tool + workflows command 的 lazy deps 注入源（workflow-script tool 走 state.registry 直供不经 lazyDeps）。 */
  lazyDeps: LauncherDeps;
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
 * workflow-events.test.ts）；engine-awareness
 * （before_agent_start 链尾）仍由组合根在本调用之后注册（before_agent_start
 * 链序不变，跨事件通道无注册时序语义）。
 */
export function setupWorkflowDomain(
  pi: ExtensionAPI,
  wiring: { inflightReporter?: InFlightReporter } = {},
): WorkflowDomainHandle {
  // [u7a D5] 在途聚合上报接线（自组合根 index.ts 收编）：core 状态迁移
  // （spawn/close/arm/disarm）→ 出口回调 → reporter 经 select 通道推绝对计数帧。
  // 出口为进程级单监听（在途记账本身是 pi 进程级模块状态），后注册覆盖先注册
  // （jiti 重载幂等）；回调同步 void，不进任何生命周期 await 链（D5 接线约束①）。
  // ctx 由 session_start 注入（factory 阶段无 ui）。wiring.inflightReporter 是测试
  // 注入面（fake reporter 观察 attach/detach 驱动时点）；生产路径缺省真实创建——
  // 组合根对实例零知识（纯管道参数已删）。
  const inflightReporter = wiring.inflightReporter ?? createInFlightReporter();
  setInFlightListener(inflightReporter.onInFlightChanged);
  // [skill-reload D2] handle.state 即槽对象本身（不做解构重包装——否则容器每次
  //  factory 重跑新建，调用方拿不到「同一 domain state 引用」的接管前提）。
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
    state: Pick<SessionLifecycleResult, "store" | "runs" | "sessionDir" | "runner">,
  ) {
    const deps: LauncherDeps = {
      store: state.store,
      workerHost,
      runner: state.runner,
      runs: state.runs,
      registry,
      // [skill-reload D3] 三个 volatile 成员（eventBus / log / onRunDone 的 pi）
      // 现读不快照：pi 从槽 currentPi 解析（factory 重跑覆盖登记）。在飞 pump 持有的
      // 旧 deps 对象经属性访问自动路由到新 pi。eventBus
      // 是值成员必须 getter；log/onRunDone 是函数成员，现读在函数体内达成（函数引用
      // 稳定，调用方缓存引用也无 stale 面）。
      //
      // onRunDone = run 终局固定顺序副作用管线（提级为 runSettledEffects 具名
      // 导出，顺序与失败语义的权威注释在该函数；此处纯装配注入依赖）。
      // [W2/V1 D1 第 7 行] settledRecordOf 注入 = store 帧查询（notifyDone 在
      // finalizeRun coda 内于 dispatch 落账之后触发，帧必已落 journal）。
      onRunDone: (run: WorkflowRun) =>
        runSettledEffects(
          {
            resolvePi: resolveCurrentPi,
            notifiedRunIds,
            state,
            // [W2/V1 D1 第 7 行] 可选调用（fake lifecycle result 的 store 缺该面时返回 undefined
            // ——notifyDone 跳过分支承接，见 runSettledEffects 注释）。
            settledRecordOf: (runId) => state.store.settledRecordOf?.(runId),
            lsRef,
          },
          run,
        ),
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
      // [H2 W3] workflow agent() 统一派发入口（设计 §3.5）：pump 侧 dispatchAgentCall
      // 经此转调 SubagentService.executeWorkflowAgent——真实 record（origin:"workflow"
      // + parentRunId）进 store、共享池/守护/journal 归 service 编排；parentRunId 由
      // pump 补 run.runId。service 单例在 session_start 后必在（run 只能于 session 内
      // 派发）；null 时抛错由 pump 的 dispatchCall catch 兜底回发 failed result。
      workflowAgentDispatch: (opts, parentRunId, signal, stepIndex) => {
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
        return service.executeWorkflowAgent(opts, parentRunId, signal, undefined, undefined, stepIndex);
      },
      log,
    };
    return deps;
  }

  function isScriptRunning(name: string): boolean {
    for (const state of sessionState.values()) {
      for (const run of state.runs.values()) {
        // [W2/V1 D1 第 8 行] 判活换源 runSummary 投影二值（混合判源收拢在 core
        // 投影单点——原两态机 status 读随活体写点删除停更）。
        if (run.spec.scriptName === name && runSummary(run).status === "running") return true;
      }
    }
    return false;
  }

  /** 组合根侧生产 deps 工厂：SessionLifecycleDeps 全部成员有生产默认实现（住
   *  session-lifecycle.ts——createOrReuseServices 单例语义 / WorktreeManager 每次
   *  扫描新建 / JsonlRunStore per-session 新建），此处无本地构造可注入；工厂形态
   *  保留为组合根侧注入点（测试或后续演进可在此覆盖）。
   *  测试注入路径：不挂载 index.ts，直接调 setupSessionLifecycle(pi, ctx, fakeDeps)。
   *  [skill-reload D4] 唯一本地构造 onAdoptionFailed 依赖 setupWorkflowDomain 闭包
   *  （makeDeps 的 LauncherDeps 完整形态——workerHost / onRunDone 通知链经 D3
   *  现读自动路由到新 pi；sessionState 移除依赖 domain state Map），归 workflow 域、
   *  session-lifecycle seam 无访问通道，经 SessionLifecycleDeps 注入。 */
  function makeLifecycleDeps(): SessionLifecycleDeps {
    return {
      onAdoptionFailed: async (existing, reason) => {
        // [D11] 统一中断：run 转 interrupted 暂停态（非终局），用户可见性由 v2
        // 中断条目承载（workflow 列表「已中断（可续跑）」）；terminate 前的
        // rebind-first 已在 failAdoption 完成，中断条目落新 pi 权威 JSONL。
        await terminateRunningRuns(
          makeDeps(existing),
          `skill reload adoption failed: ${reason}`,
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
  //  恢复收编 running 残留——终态/创建均冷路径已落盘，丢的只有最后一次成功物化之后
  //  的 running 尾巴（边沿防抖窗口内有批未物化时同属此列），ES1 已接受）；不做
  //  best-effort SIGTERM dispose（需同步 IO 改造，
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
      // 编排顺序（W2C5）：terminate（await，[D11] 中断转移落 record——run 停
      // interrupted 暂停态可再 resume）
      // → store.dispose（await，刷 pending 去抖批 + await in-flight 链，关「shutdown
      // 时刻 pending 去抖写丢失」窗口）→ delete。terminate 的 running 过滤在 helper
      // 内部（单 run 失败不中断其余）；外层 try/catch 兜底防单 session 异常中断后续
      // session 条目的 dispose + delete（对齐原 allSettled 的不中断语义）。
      try {
        await terminateRunningRuns(makeDeps(state), "Session shutdown: run terminated");
      } catch (err) {
        // 外层兜底（正常路径 helper 内部已自过滤单 run 失败）——error 级：中断转移
        // 落账失败意味着重启后收编链的输入缺失（该 run 仍呈 running 活体投影），必须可见。
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

  /** deps 守卫单一出口：state 缺失 / store 不健康时 throw（错误消息逐字保留——
   *  crash-recovery / session-lifecycle 等测试锁定子串），成功返回 LauncherDeps。 */
  const resolveDepsFor = (sessionId: string): LauncherDeps => {
    const state = sessionState.get(sessionId);
    if (!state) {
      // [C2] 错误带恢复动作（对齐下方 store unavailable 的 MF-1 闭环风格）：state
      // 缺席的 root cause 是 session_start 装配链失败（围栏 catch 只留 extension
      // 日志），文案指引 reload + 查日志，接通「现象 → 根因」链路。前缀子串
      // "Session not initialized" 被 session-lifecycle / workflow-events-deps-getter
      // 测试锁定（toThrowError 子串匹配），改写时保留该前缀。
      throw new Error(
        "Session not initialized (session_start assembly failed). " +
          "Recovery: restart pi or reload this session to re-run initialization; " +
          "check the subagents extension logs (session_start failure) for the root cause.",
      );
    }
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      // 错误带恢复动作（错误 → 恢复闭环）：loadAll 失败的 store 本进程内不恢复，
      // 重启 pi 或重载 session（重建 store + 重跑 kill-9 恢复）是唯一出路。前半段
      // 子串（"store unavailable" / "loadAll failed"）被 crash-recovery 等测试锁定。
      throw new Error(
        "Workflow store unavailable (loadAll failed in session_start). " +
          "Restart pi or reload this session to re-run crash recovery.",
      );
    }
    return makeDeps(state);
  };

  // ════════════════════════════════════════════════════════════
  //  lazyDeps（2 个 tool + workflows command 的 lazy deps 注入源；
  //  workflow-script tool 走 state.registry 直供不经 lazyDeps）
  //
  //  属性访问触发 deps 守卫 + makeDeps 求值（每属性独立，createLazy 原语转发；
  //  守卫失败 throw——pi tool 框架转译为 tool 错误结果，session-lifecycle.test.ts
  //  锁定消息子串）。
  // ════════════════════════════════════════════════════════════
  const resolveDeps = (): LauncherDeps => resolveDepsFor(lsRef.lastSessionId);
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
    // scheduleTimeBudget / appendEntry 不可缺席（ports.ts D-12 regression fix 同族）：
    // rebuildRuntime 重排 run 级墙钟预算计时器、finalizeRun 的 pending:unregister
    // 直落都经这两个成员消费——lazyDeps 缺席会让消费点拿到 undefined（可选属性
    // 静默放行）；appendEntry 缺席尤其危险：workflow tool 的 run action 以 lazyDeps
    // 为 deps 启动 run，直落静默跳过 + emit 已删 = 注销 entry 永缺位。转发形态与其余成员一致。
    get scheduleTimeBudget() { return createLazy(resolveDeps, "scheduleTimeBudget"); },
    get appendEntry() { return createLazy(resolveDeps, "appendEntry"); },
    get log() { return createLazy(resolveDeps, "log"); },
  };

  return { state: domainState, lazyDeps, isScriptRunning };
}

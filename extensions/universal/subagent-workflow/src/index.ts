/**
 * subagent-workflow Extension — Factory（extension 装配点）
 *
 * 合并 @zhushanwen/pi-subagents + @zhushanwen/pi-workflow 为统一包。
 * 注册项：3 tool（subagent + workflow + workflow-script）+ 2 command（subagents + workflows）
 * + messageRenderer（subagent-bg-notify）+ pi.__workflowRun + session 事件。
 *
 * 包内结构（执行运行时已迁 packages/subagent-core，本包只留注册面与宿主适配）：
 *   interface/           → 注册胶水（tools / commands / TUI 渲染 / GUI mappers）
 *   host/                → pi 宿主端口实现（HostServices / NotifyDomain 的 pi 侧兑现）
 *   injectors/           → 提示注入器（engine-awareness / model-list / resource-list …）
 *   session-lifecycle.ts → 会话生命周期装配 seam（测试可注入 fake 依赖）
 *   workflow-events.ts   → workflow 域事件族装配 seam（7 个 pi.on handler + deps 装配）
 *
 * 本文件 = 组合根：只留注册（tools / commands / renderer / pi.__workflowRun / 进程级
 * 信号 hook）与装配接线（core 端口 / 注入器 / 两个 seam 调用）。
 *
 * 架构导航见 docs/extensions/subagents/architecture.md。
 *
 * 设计基线：D-004（旧包不动）/ ADR-025（进程内执行）/ D-8（pi.__workflowRun 签名）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ═══ core 宿主端口接线（subagent-core 包抽离 u0-wire；实现见 src/host/pi-host.ts） ═══
import { configureCore } from "@zhushanwen/subagent-core";
import { configureNotifyDomain } from "@zhushanwen/subagent-core";
import { setInFlightListener } from "@zhushanwen/subagent-core";
import { createPiHostServices, createPiNotifyDomainPorts } from "./host/pi-host.ts";
// [u7a D5] 壳层在途上报出口：core 状态迁移 → 本出口 → select 通道（marker 帧）→ runtime。
import { createInFlightReporter } from "./host/inflight-reporter.ts";

// ═══ 经 core barrel 消费执行域（执行运行时住 packages/subagent-core） ═══
// [U7] 引擎列表状态文件（registry → engines.json，GUI 引擎选择器数据源）
import { syncEnginesFile } from "@zhushanwen/subagent-core";
// [W11/DoD#5] registerPiEngine（inproc 'pi' 注册）已随内建引擎删除：registry 'pi'
// 由下方 syncEnginesFile 的三级发现装载 cli descriptor（engines/zcode 同理由
// registerZcodeEngine D8 薄壳承载）。
// [P3 引擎接线] 组合根登记 'zcode' 引擎（D8 薄壳：vendored 定位 cli descriptor；
// engineDataDir 默认走 common/data-dir SSOT）
import { registerZcodeEngine } from "@zhushanwen/subagent-core";
import { killAllSpawnedChildren } from "@zhushanwen/subagent-core";
import { runAndWait, type WorkflowRunResult } from "@zhushanwen/subagent-core";
// [engine-awareness U3/D7-④] per-turn 引擎检测编排 + before_agent_start 链尾接线
import { setupEngineAwarenessInjector } from "./injectors/engine-awareness.ts";
import { setupModelListInjector } from "./injectors/model-list-injector.ts";
import { setupSubagentListInjector } from "./injectors/subagent-list-injector.ts";
import { setupWorkflowListInjector } from "./injectors/workflow-list-injector.ts";
import { renderBgNotifyMessage } from "./interface/bg-notify-render.ts";
import { registerWorkflowsCommand } from "./interface/commands.ts";
import { registerSubagentTool } from "./interface/subagent-tool.ts";
// ═══ interface/ 层（tools/commands/tui 合并） ═══
import { registerSubagentsCommand } from "./interface/subagents.ts";
import { registerSubagentsTool } from "./interface/tool-subagents.ts";
import { registerWorkflowTool } from "./interface/tool-workflow.ts";
import { registerWorkflowScriptTool } from "./interface/tool-workflow-script.ts";
// ═══ workflow 域事件族装配 seam（7 个 pi.on handler + makeDeps/getWorkflowDeps/
// lazyDeps；与 session-lifecycle.ts 同构，D2 原样搬移 + lazyDeps 样板收敛） ═══
import { setupWorkflowDomain } from "./workflow-events.ts";

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
// 泄漏为孤儿。process.on 兜底调 killAllSpawnedChildren——[如实口径] core 侧该入口
// 为镜像置死 no-op（仅清空 core spawnedChildren 镜像记账，不发任何进程信号），真实
// 回收链 = 子进程 stdin-EOF 自灭（宿主退出 / EngineClient 销毁）+ dispose 链；本调用
// 保留兜底占位（镜像一致性），不构成真实收割。guard 防多信号叠加（如 SIGINT 后又
// beforeExit）重复触发。
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
  // 用户体验拍板 2026-08-25：taiji 打开后激活任意 session 的第一时间（含 TUI 等价
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

  // ════════════════════════════════════════════════════════════
  //  workflow 域：per-factory 状态 + 7 个 session/model 事件 + deps 装配
  //
  //  状态创建（lsRef / notifiedRunIds / workerHost / registry / sessionState）、log、
  //  makeLifecycleDeps / makeDeps、7 个 pi.on handler、getWorkflowDeps 守卫 +
  //  lazyDeps 已收编 workflow-events.ts（事件族 seam，与 session-lifecycle.ts 同构；
  //  7 个 handler 的注册相对顺序原样保留）。此处仅接线。
  // ════════════════════════════════════════════════════════════
  const workflow = setupWorkflowDomain(pi, { inflightReporter });

  // ════════════════════════════════════════════════════════════
  //  [U7 + engine-awareness U3] before_agent_start：引擎感知注入（链尾注册，D7——
  //  段内容变化只断 system prompt 尾部 cache 前缀）。
  //  D7-④：接线收编于 engine-awareness.ts 的 setupEngineAwarenessInjector（与上方
  //  三个 setup* 同形，注入链序由调用先后表达）；per-session lastEngine 经
  //  sessionState 存取器注入。编排/渲染/链尾依据的完整注释随迁至该函数。
  // ════════════════════════════════════════════════════════════
  setupEngineAwarenessInjector(pi, {
    getLastEngine: (sid) => workflow.state.sessionState.get(sid)?.lastEngine,
    setLastEngine: (sid, engine) => {
      const state = workflow.state.sessionState.get(sid);
      if (state) state.lastEngine = engine;
    },
  });

  // ════════════════════════════════════════════════════════════
  //  [V2 决策 7 防线 i] process 级 shutdown hook（显式收割三道防线之一）
  //
  //  上方 session_shutdown（pi async hook，workflow-events.ts）在进程被 SIGTERM/
  //  SIGINT 强杀或崩溃时不触发，此处 process.on 兜底确保 sync 子进程被收割
  //  （防线 i：shutdown 时显式 SIGTERM 全部 activation）。
  //
  //  - SIGTERM：pi 各 mode（rpc/interactive/print）自带 SIGTERM handler 负责退出编排，
  //    本 extension 的 handler 只做收割 + 设 exitCode（不 re-raise、不抢 pi 的退出语义；
  //    taiji 桌面 supervisor 用 SIGTERM 杀 pi 走这条路）。
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
  //  下 stdin-EOF 自灭链覆盖崩溃路径）。
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
    const resolved = workflow.getWorkflowDeps(workflow.state.lsRef.lastSessionId);
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
  //  Tools（3 个）+ Commands（2 个）—— 注册面
  //
  //  lazyDeps / isScriptRunning / registry 由 workflow-events.ts 装配结果提供。
  //  guard：workflow tool 与 subagents（批量派发入口）共用同一 guard——两者是同一条
  //  runWorkflow 管道的入口，单守卫防双 guard 语义漂移（D3 复用裁决）。
  // ════════════════════════════════════════════════════════════
  const guard = { isProcessing: false };

  registerWorkflowTool(pi, workflow.lazyDeps, guard);
  registerSubagentsTool(pi, workflow.lazyDeps, guard);
  registerWorkflowScriptTool(pi, workflow.state.registry, workflow.isScriptRunning);

  registerWorkflowsCommand(
    pi,
    () => {
      const state = workflow.state.sessionState.get(workflow.state.lsRef.lastSessionId);
      return state?.runs ?? new Map();
    },
    workflow.lazyDeps,
  );
}

// ============================================================
// 进程级单例（channel registry + dialog queue）
// ============================================================

// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API）。
// dialog queue 单例随 session_start 装配域迁居 session-lifecycle.ts
// （getOrCreateDialogQueue；消费方 = 该文件 createOrReuseServices + workflow-events.ts
// session_shutdown），Symbol key 单定义点随迁，避免双份定义漂移。

// 跨扩展 channel handler 注册入口已收口到 core 深路径
// `@zhushanwen/subagent-core/execution/assembly/channel-registry-access.ts`
// （getOrCreateChannelRegistry / UiChannelRegistry / ChannelHandler）。
// 历史上的包根 re-export 已删：ask-user 等跨扩展消费者经 globalThis 握手
// （DIALOG_QUEUE_KEY 同款进程级单例），不再经包根 import 消费本模块。

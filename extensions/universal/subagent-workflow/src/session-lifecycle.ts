/**
 * session-lifecycle — 会话生命周期装配 seam（bootstrap seam）。
 *
 * 设计锚点：docs/design/subagent-post-convergence-architecture.md §3.1（D1/D2/D8）。
 * 随迁内容 = 原组合根 index.ts session_start handler（:336-613）的六职责，原样搬移
 * （D2 纪律：本文件不改行为；行为变更点——守卫合一 / lazyDeps getter 化（10 成员
 * 守卫触发对象，偏差 #10）——留在 index.ts，各自独立成条）：
 *   1. identity env→appendEntry 重建（类型 13 字段含 1 个 @deprecated，写入 12）
 *   2. notify ledger host 装配 + 重启恢复
 *   3. 双 Service 装配 + initSession（createOrReuseServices 封装，单例语义 D8）
 *   4. GC / manifest tmp 清扫（[U4c/D6] promote 退役）/ 索引重建（[U4c/G1] boot 全量腿）/ worktree 恢复
 *   5. per-session run store + kill-9 恢复循环 + evictDoneRunsBeyondCap
 *   6. SAR + engine 基线（经 SessionLifecycleResult 返回，sessionState 写入留在组合根）
 *
 * 测试入口：deps（SessionLifecycleDeps）注入 fake 即可验证装配行为，无需挂载整个
 * index.ts 整类打桩（设计 §3.1 使用者视角样例）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { guardStaleCtx, oncePerProcess, toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ═══ core 宿主端口消费（随迁块的依赖；production 默认实现住本文件） ═══
import { getOrCreateChannelRegistry } from "@zhushanwen/subagent-core";
import { DialogGlobalQueue } from "@zhushanwen/subagent-core";
import { syncEnginesFile } from "@zhushanwen/subagent-core";
import { createUiRequestHandlerForMode } from "@zhushanwen/subagent-core";
import {
  getModelConfigService,
  ModelConfigService,
  setModelConfigService,
} from "@zhushanwen/subagent-core";
import { bindNotifyLedgerHost, type NotifyLedgerHost } from "@zhushanwen/subagent-core";
import { IDENTITY_CUSTOM_TYPE, type SubagentIdentityData } from "@zhushanwen/subagent-core";
import type { ExecutionMode } from "@zhushanwen/subagent-core";
import { maybeCleanupExpiredSessionFiles } from "@zhushanwen/subagent-core";
import {
  getSubagentService,
  setSubagentService,
  SubagentService,
} from "@zhushanwen/subagent-core";
import { SubprocessAgentRunner } from "@zhushanwen/subagent-core";
import { WorktreeManager } from "@zhushanwen/subagent-core";
import { clearSkillPathCache } from "@zhushanwen/subagent-core";
// kill-9 崩溃恢复四步（loadAll → failed → save → evict）收口 core（D8：宿主各写
// 一遍正是 failure-mode-B）；dev 侧 u-audit-fix 的 6 个 oncePerProcess 守卫随迁块
// 从 index.ts 原样迁入（f23fbcc3c）。
import { recoverCrashedRuns } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
// [engine-awareness D1b] lastEngine 基线归一（随迁块 6 消费）——normalizeEngineId
// 单一权威源在 core，直连 barrel（engine-awareness 的历史再导出面已删，dev 侧
// 「导入面折叠直连」语义）
import { normalizeEngineId } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "./jsonl-run-store.ts";

// 模块级 logger（与原 index.ts 同 component 名；setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("subagents");

// ── 主 session 文件解析（随迁为 module 私有，唯一消费方是随迁块） ─────────────────

// 模块级缓存：主 session 的 sessionFile（fork source 解析用）。
// [搬移注] 原为 index.ts factory 闭包状态，随 createOrReuseServices 域整体随迁为
// module 级：生产形态 extension factory 每进程实例化一次，闭包与 module 级等价；
// 每次 session_start 都无条件刷新此缓存（见下方搬移块），/resume /fork 复用实例时
// getter 读到的恒为最新值（SR-3 语义不变）。
let cachedMainSessionFile: string | undefined;

function getCachedMainSessionFile(): string | undefined {
  return cachedMainSessionFile;
}

/**
 * 按 sessionId 解析主 session 文件路径（文件名约定 `<ISO 时间戳>_<sessionId>.jsonl`）。
 * [E2E 实测] attach 场景下 ctx.sessionManager.getSessionFile() 会返回前一 session 的
 * 文件（session_start(root=01a01bf5) 时仍返回刚新建 session 的路径）——恢复逻辑
 * 读错文件会整段漏判。此处按 id 从 sessions 目录解析为准；新 session 文件未 flush
 * 时（AGENTS.md 规则 6：首条 assistant 消息前可能不存在）返回 undefined，调用方
 * （fork 解析 / 孤儿恢复）对该场景本就无 entry 可读。
 *
 * [pi 锚点 ADR-0063 I4] getSessionFile attach 语义：返回 `this.sessionFile` 字段
 * （pi-mono coding-agent/src/core/session-manager.ts :1011-1013），该字段仅在
 * _setSessionFile（:884/:895-896，constructor 显式路径或 setSessionFile）与
 * newSession（:953 生成 `<ts>_<sessionId>.jsonl`）时写入——session_start 事件时点
 * extension ctx 持有的 sessionManager 若尚未重绑到 root session，getSessionFile
 * 仍回旧值（与 E2E 实测一致）。clone v0.84.2 核对，实装 0.84.4。
 */
function resolveMainSessionFileById(sessionId: string): string | undefined {
  const sessionsDir = path.join(getAgentDir(), "..", "sessions");
  try {
    const match = fs.readdirSync(sessionsDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
    return match === undefined ? undefined : path.join(sessionsDir, match);
  } catch {
    return undefined;
  }
}

/** workflow 域 per-session state 目录探测（随迁为 module 私有，唯一消费方是随迁块）。 */
function resolveSessionDir(): string {
  const defaultDir = getAgentDir();
  const sessionSlug = `--${process.cwd().replace(/^\//, "").replace(/\//g, "-")}--`;
  // F2：根改 getAgentDir() 派生（实例隔离）；保留 sessionScopedDir 存在则用之的探测语义
  const sessionScopedDir = path.join(getAgentDir(), "sessions", sessionSlug);
  return fs.existsSync(sessionScopedDir) ? sessionScopedDir : defaultDir;
}

// ── 进程级单例（dialog queue；原 index.ts module 级随域搬移） ────────────────────
//
// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API），不在此列。
// dialog queue 仍为本模块私有单例——消费方 = 本文件 createOrReuseServices +
// index.ts session_shutdown（flush L2 pending dialog）。

const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");

/** 获取或创建进程级 dialog queue 单例。
 *  L2 跨子进程串行队列——所有子进程的 dialog 类请求共享同一队列实例。 */
export function getOrCreateDialogQueue(): DialogGlobalQueue {
  let queue = Reflect.get(globalThis, DIALOG_QUEUE_KEY) as DialogGlobalQueue | undefined;
  if (!queue) {
    queue = new DialogGlobalQueue();
    Reflect.set(globalThis, DIALOG_QUEUE_KEY, queue);
  }
  return queue;
}

// ── deps 契约（SessionLifecycleDeps）与装配结果 ─────────────────────────────────

/** createOrReuseServices 返回值。reused 标志仅供测试断言与日志——禁止据其跳过
 *  initModel/initSession（D8：reused=true 跳过 init 会让上一 session 的
 *  uiRequestHandler/sessionId 残留）。 */
export interface ServicesBundle {
  service: SubagentService;
  modelService: ModelConfigService;
  reused: boolean;
}

/** 组合根可注入的装配依赖。全部可选：undefined 时走生产默认实现（住本文件）；
 *  测试传 fake 逐项覆盖。 */
export interface SessionLifecycleDeps {
  /**
   * 双 Service 装配工厂（随迁块 3）。默认 = createOrReuseServices：完整保留
   * existing-??-new + 仅 !existing 时 set 的单例语义（D8——jiti 多实例分裂靠
   * globalThis Symbol 单例防护，/resume /fork 复用既有实例）。裸 new 禁止绕过
   * 单例检查出现在默认实现里（否则每个 session_start 新建实例，GC timer 翻倍、
   * record store 状态分裂）。
   */
  createServices?: (pi: ExtensionAPI, ctx: ExtensionContext) => ServicesBundle;
  /**
   * worktree reaper（随迁块 4 的 ADR-035 启动恢复扫描）。默认 = 每次扫描新建
   * WorktreeManager（现状语义：无状态扫描器，无单例诉求）。测试注入 fake
   * （如 scanCalls 计数）观察扫描行为，见设计 §3.1 使用者视角样例。
   */
  worktreeManager?: Pick<WorktreeManager, "scan">;
  /**
   * per-session run store 工厂（随迁块 5）。默认 = new JsonlRunStore({ sessionDir, pi, ctx })
   * （per-session 新建为现状设计：store 生命周期与 session 等同，D-008/F-4）。
   * 测试注入 fake 以控制 loadAll 行为（kill-9 恢复分支）。
   */
  createRunStore?: (sessionDir: string, pi: ExtensionAPI, ctx: ExtensionContext) => JsonlRunStore;
}

/** setupSessionLifecycle 装配结果——组合根据此写入 per-session sessionState。 */
export interface SessionLifecycleResult {
  sessionId: string;
  store: JsonlRunStore;
  runs: Map<string, WorkflowRun>;
  sessionDir: string;
  /** D-008 per-session SAR（需要 ctxModel + subagentService 委托目标） */
  runner: SubprocessAgentRunner;
  /** session 上下文（notifyDone 需要 GuiContext） */
  ctx: ExtensionContext;
  /** MF-1: store 健康度。session_start 时 store.loadAll 失败则 false，
   *  workflow 域启动时 fail-fast，避免后续 store.save 再次失败导致 run 状态不落地。
   *  subagent 域不依赖 store，不受此标志影响。 */
  storeHealthy: boolean;
  /** [engine-awareness D1b] 上一次已知默认引擎（session_start 初始化，per-turn 检测
   *  diff 基准）。undefined = 初始化时 config 读失败——首 turn 检测遇 undefined
   *  静默基线化，不算变更、不发通知（防首 turn 伪通知）。 */
  lastEngine?: string;
}

// ── 双 Service 装配（随迁块 3 封装；D8 单例语义关键不变量） ───────────────────────

/**
 * 双 Service 装配：getSubagentService() ?? new + 仅 !existing 时 set 的整段原样保留
 * （jiti 多实例分裂靠 globalThis Symbol 单例防护，/resume /fork 复用既有实例——
 * SR-3/SR-4）。initModel/initSession 对 new 与 reused 均无条件执行：
 * - SR-3：/resume /fork 复用实例时注入 handler 覆盖旧值、更新 sessionId；
 * - SR-4：dialogQueue 注入（session-runner child close 时清 L2 pending dialog）。
 * reused 返回标志仅供测试断言与日志，不存在任何「reused=true 跳过 init」分支。
 */
function createOrReuseServices(pi: ExtensionAPI, ctx: ExtensionContext): ServicesBundle {
  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const existingService = getSubagentService();
  const existingModelService = getModelConfigService();
  const modelService = existingModelService ?? new ModelConfigService({ agentDir, cwd });
  const service = existingService ?? new SubagentService({ cwd, modelService, getMainSessionFile: getCachedMainSessionFile });

  modelService.initModel({
    modelRegistry: ctx.modelRegistry,
    sessionId: ctx.sessionManager.getSessionId(),
    ctxModel: ctx.model ?? undefined,
  });

  // ── W3: handler 注入链路接通 ──
  // 进程级单例：channel registry + dialog queue 跨 session 复用
  //（与 SubagentService 单例模式一致，globalThis Symbol 持有避免 jiti 多实例分裂）。
  const channelRegistry = getOrCreateChannelRegistry();
  const dialogQueue = getOrCreateDialogQueue();
  const uiRequestHandler = createUiRequestHandlerForMode(ctx, channelRegistry, dialogQueue);

  // 主 session 文件：按 sessionId 解析（getSessionFile() 在 attach 场景会返回前一
  // session 的文件，E2E 实测），未 flush 的新 session 回退 getSessionFile()。
  // 值直传 initSession——jiti 多实例分裂下闭包缓存（cachedMainSessionFile）不跨
  // 实例共享，恢复逻辑经缓存读会拿到滞后一个事件的值（E2E 实测 ENOENT 漏判）；
  // 缓存本身保留给既有 getter 消费者（fork source 解析）。
  cachedMainSessionFile =
    resolveMainSessionFileById(ctx.sessionManager.getSessionId()) ??
    ctx.sessionManager.getSessionFile() ??
    undefined;

  service.initSession({
    pi,
    sessionId: ctx.sessionManager.getSessionId(),
    mainSessionFile: cachedMainSessionFile,
    // 注入 ctx.ui.setWidget 作为 streaming sink（只绑方法，不持有整个 ctx）。
    // background subagent 执行期间，text_delta 经 SubagentStream 合并后由此通道转发。
    // [W1 修复] ctx.mode === 'rpc' 守卫：TUI/json/print 下 streamSink = undefined（无 widget 噪音），
    // rpc mode（GUI/xyz-agent）下保持原行为（ctx.ui.setWidget → sidecar → chatStore）。
    // streamSink API 不变（SubagentStream.onDelta 仍可调，只是 TUI 下 stream 不会被创建）。
    streamSink: ctx.mode === "rpc"
      ? { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) }
      : undefined,
    // [#24][D4-④] uiRequestHandler 单一注入入口 = initSession 参数（原
    // setUiRequestHandler 方法已随 D4 拆分删除）。SR-3 语义保留：无论 new 还是
    // existing（/resume /fork 复用），session_start 都注入 handler 覆盖旧值；
    // headless 下工厂返回 undefined → 传 null（显式清空语义，防上一个 session 的
    // handler 残留——与原 setUiRequestHandler(undefined) 行为等价）。
    uiRequestHandler: uiRequestHandler ?? null,
    mode: ctx.mode,
    // SR-4：注入 L2 dialog 队列——session-runner child close 时调 rejectChildDialogs
    // 清理该 child 在 L2 的 pending dialog，防全局死锁（C1 修复：清理路径接通）。
    dialogQueue,
    // [竞态修复] 注入 ctx.isIdle：notifier flush 在主 agent busy 时退避，idle 后再
    // sendMessage(triggerTurn)，规避 agent_end→finishRun 窗口里走 steer 分支丢失通知。
    isIdle: () => ctx.isIdle(),
  });

  const reused = existingService !== null;
  if (!existingService) {
    setModelConfigService(modelService);
    setSubagentService(service);
  }

  // S-2: 启动 idle record GC 定时器（30 天 TTL，每小时检查一次）。
  // 注册 setInterval 属进程级副作用——oncePerProcess 守卫防双跑（u-audit-fix）。
  oncePerProcess("subagent-workflow:start-gc-timer", () => service.startGcTimer());

  return { service, modelService, reused };
}

// ── 装配分组 helper（复杂度消减提取；调用序 = 原内联序，行为不变） ────────────────

/**
 * [M4] identity 子进程写入（V2 决策 5）。
 *
 * 子进程经 env（PI_SUBAGENT_*）接收自己的 identity，在 session_start 用 pi.appendEntry
 * 写 subagent-identity custom entry。pi 自动生成 id/parentId → message tree 连续。
 * 旧实现父进程 fs.appendFileSync 补写的 custom entry 缺 id/parentId → 污染 _buildIndex
 * leafId 指针 → message tree 断成两棵 → 多轮对话丢上下文（bug 根因）。
 * 主/子进程判定：PI_SUBAGENT_SELF_RECORD_ID 仅 session-runner spawn 子进程时注入，
 * 主进程无此 env → 跳过（identity 只在子进程写一次）。失败记日志不阻断（设计 §3.4）。
 */
function appendSubagentIdentityEntry(pi: ExtensionAPI): void {
  const selfRecordId = process.env.PI_SUBAGENT_SELF_RECORD_ID;
  if (!selfRecordId) return;
  try {
    const modeEnv = process.env.PI_SUBAGENT_MODE;
    // ExecutionMode 联合窄化：父进程经 env 注入（record.mode 恒为 "background"），
    // 运行时校验合法值，非法兜底 background（避免裸 cast，符合 taste/no-unsafe-cast）。
    const mode: ExecutionMode = modeEnv === "background" ? modeEnv : "background";
    const identity: SubagentIdentityData = {
      id: selfRecordId,
      agent: process.env.PI_SUBAGENT_AGENT ?? "",
      mode,
      task: process.env.PI_SUBAGENT_TASK ?? "",
      slug: process.env.PI_SUBAGENT_SLUG,
      startedAt: Number(process.env.PI_SUBAGENT_STARTED_AT ?? Date.now()),
      rootSessionId: process.env.PI_SUBAGENT_ROOT_SESSION_ID,
      parentRecordId: process.env.PI_SUBAGENT_PARENT_RECORD_ID,
      depth:
        process.env.PI_SUBAGENT_DEPTH !== undefined
          ? Number(process.env.PI_SUBAGENT_DEPTH)
          : undefined,
      forkDepth:
        process.env.PI_SUBAGENT_FORK_DEPTH !== undefined
          ? Number(process.env.PI_SUBAGENT_FORK_DEPTH)
          : undefined,
      chatMode: process.env.PI_SUBAGENT_CHAT_MODE === "true",
      // [review round2] worktree 隔离标志（session-runner 注入）：跨重启重建路径据此
      // 拒绝续聊（handle 不可序列化，reattach 不可行）。
      worktree: process.env.PI_SUBAGENT_WORKTREE === "true",
    };
    pi.appendEntry(IDENTITY_CUSTOM_TYPE, identity);
  } catch (err) {
    logger.warn("[subagents] identity appendEntry failed in session_start", {
      reason: toErrorMessage(err),
    });
  }
}

/**
 * [U2] 通知账本装配 + 重启恢复（设计 D4：存在性 / 可达性分离）。
 *
 * bind 先于 service.initSession（notifier.revive 在其内——notify() 经
 * getBoundNotifyLedger 消费账本）。recoverFromSession 扫 ledger/ack 两列 entry
 * 差集：未销账号重放投递（已销账零重发，notifyId 幂等）；fork 继承未销账
 * pending 属可接受语义（D4 归属规则——扫描域 = 单 session 文件，幂等键作用域
 * 随文件域隔离）。compaction 存活情况归 session_compact handler 的条件降级（P-B4
 * 探针阶段 5 实测，见 notify-ledger.ts compactionCheck）。装配失败不阻断
 * session_start（通知退回 notifier 的内核路径）。
 *
 * export + 返回装配的 NotifyLedgerHost = 测试直入 seam（可直调 sendDelivery 验证
 * 守卫分诊）；生产调用方（setupSessionLifecycle）忽略返回值，行为不变。装配失败
 * 返回 undefined。
 */
export function bindLedgerHostAndRecover(pi: ExtensionAPI, ctx: ExtensionContext): NotifyLedgerHost | undefined {
  try {
    const ledgerHost: NotifyLedgerHost = {
      appendLedgerEntry: (customType, data) => {
        pi.appendEntry(customType, data);
      },
      readSessionEntries: () => ctx.sessionManager.getEntries(),
      isIdle: () => ctx.isIdle(),
      onAgentSettled: (handler) => {
        pi.on("agent_settled", handler);
      },
      sendDelivery: (message) => {
        // D5 单通道：唯一发送形态 = sendCustomMessage({triggerTurn:true})，
        // courier 已在发送前二次复查 isIdle，多通道投递选项已删（D5）。
        // stale ctx 防御（crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：
        // sendDelivery 经 settled 边沿 / 看门狗 / 恢复重放异步触发——session 替换窗口
        // 触碰 stale pi 命中 assertActive（PS-30）即无人接 rejection（E1 同机制）。
        // stale 静默降级（本条通知不投递，attemptDeliver 按已受理标 sentAt——session
        // 替换后通知对旧 session 已无意义，与守卫前「留 pending 反复撞 stale 直到账本
        // 重绑」终局一致），非 stale 错误原样上抛（attemptDeliver 既有 catch 走
        // settleRejected 留账重试语义不变）。
        guardStaleCtx(() => pi.sendMessage(message, { triggerTurn: true }), {
          label: "subagent-workflow:sendDelivery",
          onStale: (error) =>
            logger.warn("notify delivery skipped (stale ctx)", {
              error: toErrorMessage(error),
            }),
        });
      },
    };
    // U4：重放观测已内聚到 ledger 分桶日志（recoveryReplays 桶经 extensionLogger
    // 通道落盘），此处不再重复打日志。
    bindNotifyLedgerHost(ledgerHost).recoverFromSession();
    return ledgerHost;
  } catch (err) {
    logger.warn("[subagents] notify ledger bind failed", {
      reason: toErrorMessage(err),
    });
    return undefined;
  }
}

/**
 * 随迁块 4 的进程级维护三连（各 try-catch「失败记日志不阻断」，设计 §3.4）：
 * 过期 session 文件清理 / ADR-035 manifest tmp 恢复 / ADR-035 worktree reaper 扫描。
 * 另含 [E1] sync 批崩溃恢复（per-session 域，不用 oncePerProcess——见块内注释）。
 */
async function runProcessLevelMaintenance(
  agentDir: string,
  ctx: ExtensionContext,
  service: SubagentService,
  deps: SessionLifecycleDeps,
): Promise<void> {
  // [E1] sync 批崩溃恢复（subagent-sync-collect 设计 §3.1.5 E1，U5 接线）：扫描主
  // session 末条 entry 重建批缓冲；全员终态未投递 → notifyBatch 补发 + 统一补
  // batchFinalized 标记（账本同 hash 幂等拒绝也算已投递）。须晚于 initSession（孤儿
  // 终态恢复先行收敛 running 成员，createOrReuseServices 内部同步完成）与 ledger
  // bind（补发走 notifyBatch 写账链，见上方 bindNotifyLedgerHost）。per-session 域
  // （主 session 文件），不用 oncePerProcess；best-effort 不阻断 session_start。
  // 时序约束在调用点 setupSessionLifecycle 已满足（bindLedgerHostAndRecover 与
  // createOrReuseServices 均先于本 helper 调用）。
  try {
    service.recoverSyncCollectBatch();
  } catch (err) {
    logger.warn("[subagents] sync collect batch recovery failed", {
      reason: toErrorMessage(err),
    });
  }

  try {
    // 递归扫描 <agentDir>/subagents + unlink 超 TTL 跨 session 文件属进程级维护
    // ——oncePerProcess 守卫防双跑（u-audit-fix）。
    oncePerProcess("subagent-workflow:cleanup-expired-session-files", () =>
      maybeCleanupExpiredSessionFiles(agentDir, ctx.cwd));
  } catch (err) {
    logger.warn("[subagents] expired session file cleanup failed", {
      reason: toErrorMessage(err),
    });
  }

  // ADR-035 启动清扫：manifest tmp 残留（崩溃打断的 writeManifest 留下）。
  // [U4c / D6] tmp 恢复退役为静默删除——manifest 已是可丢可重建缓存（权威 =
  // `.state`，重建走下方 rebuildIndexes 钩子），promote 半写 tmp 的恢复语义失效。
  // 扫描属进程级维护——oncePerProcess 守卫防双跑（u-audit-fix）；第二派发重放首次
  // Promise（结果缓存语义），deleted 计数日志可能重打，无文件副作用。
  try {
    const swept = await oncePerProcess("subagent-workflow:sweep-manifest-tmp-files", () =>
      service.recoverManifestTmpFiles());
    if (swept.deleted > 0) {
      logger.warn(`[subagents] manifest tmp sweep: ${swept.deleted} stale tmp file(s) removed (manifest is rebuildable cache)`);
    }
  } catch (err) {
    logger.warn("[subagents] manifest tmp sweep failed", {
      reason: toErrorMessage(err),
    });
  }

  // [U4c / G1] 缓存降级重建（boot 全量腿）：boot revive 已完成（createOrReuseServices
  // 内 initSession 的孤儿恢复/可重连 entry 重物化先于本 helper），此处全量重建可丢
  // 缓存——manifest 幂等补缺 + sessions-index 经首扫自愈重写。进程级维护（磁盘域
  // 全量），oncePerProcess 守卫防双跑；/resume /fork 同进程复用实例时跳过（查询面
  // 惰性通道兜底，且终态写点本身维持 manifest 就位）。
  try {
    oncePerProcess("subagent-workflow:rebuild-record-indexes", () =>
      service.rebuildIndexes());
  } catch (err) {
    logger.warn("[subagents] record index rebuild failed", {
      reason: toErrorMessage(err),
    });
  }

  try {
    // ADR-035：worktree reaper 扫描（git/rm 进程操作 + 注册表/目录扫描）属进程级
    // 维护——oncePerProcess 守卫防双跑（u-audit-fix）。默认每次扫描新建
    // WorktreeManager（现状语义）；deps.worktreeManager 供测试注入 fake（scanCalls 计数）。
    await oncePerProcess("subagent-workflow:worktree-scan", async () => {
      const wtm = deps.worktreeManager ?? new WorktreeManager(agentDir);
      await wtm.scan();
    });
  } catch (err) {
    logger.warn("[subagents] worktree reaper scan failed", {
      reason: toErrorMessage(err),
    });
  }
}

/** createSessionRunState 返回值（随迁块 5 的装配产物）。 */
interface SessionRunState {
  store: JsonlRunStore;
  runs: Map<string, WorkflowRun>;
  /** MF-1: loadAll 失败则 false，workflow 域启动时 fail-fast */
  storeHealthy: boolean;
}

/**
 * 随迁块 5：per-session run store + runs + kill-9 崩溃恢复循环 + storeHealthy 跟踪。
 *
 * MF-1: store 健康度跟踪。loadAll 失败 → storeHealthy=false，workflow 域启动时 fail-fast。
 * 崩溃恢复四步（loadAll → failed → save → evict）收口到 core recoverCrashedRuns（D8：
 * 宿主各写一遍正是 failure-mode-B）；pending:unregister 经 hooks 外置发射（位置在
 * transition 后、save 前，对齐原内联实现）；save 走 store 冷路径（done 绕过去抖）——
 * 冷路径语义在 JsonlRunStore.save 内，不随循环归属转移。loadAll 失败的 fail-fast
 * （storeHealthy=false 停初始化）是宿主职责，core 原样上抛、这里 catch 兜住。
 */
async function createSessionRunState(
  sessionDir: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SessionLifecycleDeps,
): Promise<SessionRunState> {
  const store = deps.createRunStore
    ? deps.createRunStore(sessionDir, pi, ctx)
    : new JsonlRunStore({
        sessionDir,
        pi,
        ctx,
      });
  const runs = new Map<string, WorkflowRun>();

  // F-4/D-003: agent 发现走 shared/resource-discovery（ADR-031），modelService
  // 自持 AgentRegistry（subagents/workflow 两域共用同一发现结果）。
  // M2 修正：workflow 域 resolveAgentOpts 不再消费 agentRegistry（agent ref 交
  // resolveIdentity），无需经 state 透传——modelService 是唯一 registry 源。
  let storeHealthy = true;
  try {
    // 崩溃恢复 loadAll 扫 cwd 共享 sessionDir（同 cwd 跨 session 共享）并把 running run
    // 转 failed 落盘——写非本 session 的 run state 文件属跨 session 副作用，oncePerProcess
    // 守卫防双跑（u-audit-fix）。第二派发重放首次 Promise：不再落盘、不再 emit。
    await oncePerProcess(
      "subagent-workflow:recover-crashed-runs",
      () =>
        recoverCrashedRuns(
          store,
          runs,
          "Process killed (kill-9 or crash recovery)",
          {
            onRunRecovered: (payload) => {
              pi.events.emit("pending:unregister", payload);
            },
          },
        ),
    );
  } catch (err) {
    // QMF-4 fix: store.loadAll 失败是关键路径错误，workflow 域将未初始化
    logger.error("[subagent-workflow] store.loadAll failed, workflow domain uninitialized", {
      reason: toErrorMessage(err),
    });
    storeHealthy = false;
  }
  return { store, runs, storeHealthy };
}

// ── 单一装配入口 ─────────────────────────────────────────────────────────────────

/**
 * 会话生命周期装配单一入口（bootstrap seam，D1）。index.ts 的 session_start 退为
 * `await setupSessionLifecycle(pi, ctx, makeLifecycleDeps())`。
 *
 * 错误处理语义原样保留（设计 §3.4）：identity/ledger/cleanup 各 try-catch
 * 「失败记日志不阻断」；kill-9 恢复 save 失败 error 日志不阻断其余 run（下次
 * session_start 幂等重试）。
 */
export async function setupSessionLifecycle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SessionLifecycleDeps,
): Promise<SessionLifecycleResult> {
  const agentDir = getAgentDir();
  const sessionId = ctx.sessionManager.getSessionId();

  // [U7] 引擎列表同步 engines.json（幂等零写 + fail-safe；组合根注册已在
  // extension 工厂体完成，此处 registry 已含全部引擎）。写 agentDir 全局文件属
  // 跨 session 副作用——oncePerProcess 守卫防 factory 二调/handler 累积双跑（u-audit-fix）。
  oncePerProcess("subagent-workflow:sync-engines-file", () => syncEnginesFile(agentDir));

  // skill 路径两级缓存 session 级失效：pi 同进程可能有多个 session（TUI /new、/fork），
  // 运行中安装的 skill 需对新 session 可见（含曾 miss 缓存的 undefined 条目与 npm 新装
  // 包的候选目录）。session 内复用收益不变（IF8/DM3 消重发生在同 session 的重复调用）。
  clearSkillPathCache();

  // ── [M4] identity 子进程写入（随迁块 1）──
  appendSubagentIdentityEntry(pi);

  // ── [U2] 通知账本装配 + 重启恢复（随迁块 2）──
  bindLedgerHostAndRecover(pi, ctx);

  // ── subagents 域：双 Service 装配（随迁块 3，经 deps 可注入）──
  const { service, modelService } = deps.createServices
    ? deps.createServices(pi, ctx)
    : createOrReuseServices(pi, ctx);

  // ── GC / manifest tmp / worktree 恢复（随迁块 4）──
  await runProcessLevelMaintenance(agentDir, ctx, service, deps);

  // ── workflow 域：per-session store + runs + kill-9 恢复（随迁块 5）──
  const sessionDir = resolveSessionDir();
  const { store, runs, storeHealthy } = await createSessionRunState(sessionDir, pi, ctx, deps);

  // D-008: per-session SAR（需要 ctxModel 填底 + subagentService 委托目标）。
  // old: const runner = new SubprocessAgentRunner()（module-level singleton，无 deps）
  // new: per-session session_start 时创建，经 SessionLifecycleResult 传给组合根。
  const runner = new SubprocessAgentRunner({
    subagentService: service,
    ctxModel: ctx.model ?? undefined,
  });

  // [engine-awareness D1b] lastEngine 初始化：构造性同源——单次 reloadGlobalConfig
  // 读取同时刷新 Service 路由缓存与 lastEngine 基准，消灭 initModel 与本处两次独立
  // 读取间的分叉窗口（两读值不一致时检测走 unchanged 分支不 reload，状态段/路由
  // 永停旧值且永不通知）。ok/absent → 归一后的当前引擎；failed → undefined（首 turn
  // 检测静默基线化兜底，此时缓存亦保持不动）。/resume、/fork 同样走 session_start
  // （SR-3），基线天然覆盖。
  const engineRead = modelService.reloadGlobalConfig();

  return {
    sessionId,
    store,
    runs,
    sessionDir,
    runner,
    ctx,
    storeHealthy,
    lastEngine:
      engineRead.status === "failed" ? undefined : normalizeEngineId(engineRead.config.defaultEngine),
  };
}

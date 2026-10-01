/**
 * session-lifecycle — 会话生命周期装配 seam（bootstrap seam）。
 *
 * 随迁内容 = 原组合根 index.ts session_start handler（:336-613）的六职责，原样搬移
 * （D2 纪律：本文件不改行为；行为变更点——守卫合一 / lazyDeps getter 化（10 成员
 * 守卫触发对象，偏差 #10）——留在 index.ts，各自独立成条）：
 *   1. identity env→appendEntry 重建（类型 13 字段含 1 个 @deprecated，写入 12）
 *   2. notify ledger host 装配 + 重启恢复
 *   3. 双 Service 装配 + initSession（createOrReuseServices 封装，单例语义 D8）
 *   4. GC / manifest tmp 清扫（[U4c/D6] promote 退役）/ 索引重建（[U4c/G1] boot 全量腿）/ worktree 恢复 / 保留维护轮兜底（[W1/D5] session_start 触发）
 *   5. per-session run store + kill-9 恢复循环 + evictDoneRunsBeyondCap
 *   6. SAR + engine 基线（经 SessionLifecycleResult 返回，sessionState 写入留在组合根）
 *
 * 测试入口：deps（SessionLifecycleDeps）注入 fake 即可验证装配行为，无需挂载整个
 * index.ts 整类打桩（设计 §3.1 使用者视角样例）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { oncePerProcess, toErrorMessage } from "@zhushanwen/pi-ext-guards";
// notify ledger host 装配工厂（五端口接线 + 送达 stale 防御的共享单点实现，
// 与 session-manager notify-ledger.ts 同一装配机制收敛于此）
import { createPiNotifyLedgerHost } from "@zhushanwen/pi-notify-ledger-host";
// [W2/V4 D6] 恢复链注销直落消费的 protocol SSOT（customType + status 映射单点——
// 与 finalizeRun 直落 / reconcile-sweep 补注销同一函数，零新增定义点）。
import { mapReasonToStatus, PENDING_UNREGISTER_ENTRY_TYPE } from "@zhushanwen/extension-protocol";

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
import { resolvePiSessionScopedDir } from "@zhushanwen/subagent-core";
// [W1 / D5] session_start 兜底触发点的统一保留维护轮：入口 + record 域目录锚
// （getSubagentRecordsDir 布局 + ENV_ROOT_CWD 贯穿 env 名单源）+ state 目录分量
// 单源 STATE_DIR_NAME——全部经 barrel 消费（壳生产消费纪律）。
import { reapOrphanRuns, runRetentionMaintenanceRound } from "@zhushanwen/subagent-core";
import { getSubagentRecordsDir } from "@zhushanwen/subagent-core";
import { ENV_ROOT_CWD } from "@zhushanwen/subagent-core";
import { STATE_DIR_NAME } from "@zhushanwen/subagent-core";
// workflow 族 customType 词表单源（workflow-record 现役 + workflow-state-link legacy
// 指针）：引用集三代解析的判别字面量经 barrel 消费，勿手抄。
import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_STATE_LINK_CUSTOM_TYPE,
} from "@zhushanwen/subagent-core";
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
import { GLOBAL_SLOT_KEYS } from "@zhushanwen/subagent-core";

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
 * 布局对齐 pi 实装 getSessionsDir（config.js）：session 文件落
 * `<agentDir>/sessions/<encoded-cwd>/` 子目录（session-manager.js——`--<cwd 编码>--`
 * 目录内 `<ts>_<sessionId>.jsonl`；与 collectAliveWorkflowRunReferences 同一布局
 * 锚点）。子目录枚举 + 文件名后缀段 `<ts>_<sessionId>.jsonl` 匹配，slug 目录名不
 * 解析（pi 编码规则演进不影响按 id 命中）。任一层 readdir 失败（sessions 根不存在
 * 等）返回 undefined，调用方回落 getSessionFile()。
 *
 * [pi 锚点 ADR-0063 I4] getSessionFile attach 语义：返回 `this.sessionFile` 字段
 * （pi-mono coding-agent/src/core/session-manager.ts :1011-1013），该字段仅在
 * _setSessionFile（:884/:895-896，constructor 显式路径或 setSessionFile）与
 * newSession（:953 生成 `<ts>_<sessionId>.jsonl`）时写入——session_start 事件时点
 * extension ctx 持有的 sessionManager 若尚未重绑到 root session，getSessionFile
 * 仍回旧值（与 E2E 实测一致）。clone v0.84.2 核对，实装 0.84.4。
 */
/** sessions 根下的 encoded-cwd slug 子目录绝对路径列表（布局锚点 = `<agentDir>/sessions`
 *  对齐 pi 实装 getSessionsDir，详注见 resolveMainSessionFileById 与
 *  collectAliveWorkflowRunReferences）。readdir 失败原样上抛——错误分通道
 *  （catch-all 回落 / ENOENT 空态分流）归各调用方。 */
function listSessionSlugDirs(agentDir: string): string[] {
  const sessionsRoot = path.join(agentDir, "sessions");
  return fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => path.join(sessionsRoot, ent.name));
}

function resolveMainSessionFileById(sessionId: string): string | undefined {
  let slugDirs: string[];
  try {
    slugDirs = listSessionSlugDirs(getAgentDir());
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  for (const dir of slugDirs) {
    try {
      const match = fs.readdirSync(dir).find((f) => f.endsWith(suffix));
      if (match !== undefined) return path.join(dir, match);
    } catch {
      continue; // 单子目录读失败继续其余（宁回落 getSessionFile，不中断装配）
    }
  }
  return undefined;
}

/**
 * workflow 域 per-session state 目录探测（随迁为 module 私有，唯一消费方是随迁块）。
 *
 * [已知限制·登记] slug 锚 process.cwd()（进程 cwd）而非 session cwd：pi CLI 在
 * 目录 B resume cwd 为 A 的 session 时，新 run 的 record 事件流落 B 的 slug
 * 目录、旧 run 的在 A——GC/retention sweep（core 同源推导）读不到旧 run 的磁盘
 * 足迹，兜底失效。主数据不受影响（权威 entry 在 session 文件里，跨 cwd 可重建）。
 * 布局单源在 core resolvePiSessionScopedDir（workflow-state-root.ts）——修复改锚
 * 只动 core 单点，本薄消费自动跟随。taiji 桌面场景（spawn cwd 恒等于 session
 * cwd）不触发，仅裸 pi CLI 的跨目录 resume 触发，故登记不改。
 */
function resolveSessionDir(): string {
  // F2：agentDir 走 pi SDK 活源注入（实例隔离）；slug + 探测布局单源在 core。
  return resolvePiSessionScopedDir({ agentDir: getAgentDir() });
}

// ── [裁决点 7] 存活 session 引用集采集（壳侧注入面，core 不 import pi SDK）──────
//
// 全池 session 文件流式扫描（sessions 根 + 全 slug 子目录的 *.jsonl），逐文件
// 提 workflow run 的注册引用并集——三代形态都解析（v2 注册条目 / v1 全量快照
// 条目 / pre-W17 link 指针）：
// - v2：workflow-record custom entry，data.kind === "registered" → data.runId；
// - v1：data.v === 1 且 data.snapshot.runId 为 string → snapshot.runId；
// - link：workflow-state-link custom entry → data.runId。
// 只认 v2 会把存量 run 首轮误判无主并不可逆删除（设计裁决点 7「引用集三代形态」）。
//
// 行预过滤（customType 子串）+ 逐行 JSON.parse 的宽容扫描：单文件解析失败跳过
// （坏文件不阻断整轮——引用集缺侧 = 宁保留方向：少采集到的 run 引用会使其
// 进观察期而非直接删除，宽限窗兜底）。成本量级 = 全池文件流式扫描，秒级～
// 十秒级（设计「实现落点」登记的实测预期——每 session_start 一次，oncePerProcess
// 守卫下进程内单跑）。

/** Node fs 错误 code 判定（ENOENT = 路径不存在；core shared/fs-error 的 errorCodeOf
 *  未进 barrel——本地等价 helper，判据与 pi-host-run-store 的读错分通道同款）。 */
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** workflow custom entry 的最小消费视图（宽容扫描用）：customType 保持 unknown
 *  （值域分流在调用方），data 已过对象校验（字段级读取仍走 unknown 判型）。 */
interface WorkflowCustomEntryView {
  customType: unknown;
  data: Record<string, unknown>;
}

/** [extractRunReferencesFromLine 守卫] 是否为 data 载荷成形的 workflow custom
 *  entry（type=custom 且 data 为对象；customType 免判型——分流在调用方）。 */
function isWorkflowCustomEntry(v: unknown): v is WorkflowCustomEntryView {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  return rec.type === "custom" && typeof rec.data === "object" && rec.data !== null;
}

function extractRunReferencesFromLine(line: string, out: Set<string>): void {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.includes("workflow")) return; // 行级预过滤
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isWorkflowCustomEntry(parsed)) return;
  const d: Record<string, unknown> = parsed.data;
  if (parsed.customType === WORKFLOW_RECORD_CUSTOM_TYPE) {
    extractWorkflowRecordRunReference(d, out);
  } else if (parsed.customType === WORKFLOW_STATE_LINK_CUSTOM_TYPE) {
    if (typeof d.runId === "string" && d.runId !== "") out.add(d.runId);
  }
}

/** [extractRunReferencesFromLine 拆分] workflow-record 条目两代引用提取
 * （v2 registered 的 runId / v1 快照内 runId）。 */
function extractWorkflowRecordRunReference(
  d: Record<string, unknown>,
  out: Set<string>,
): void {
  if (d.kind === "registered" && typeof d.runId === "string" && d.runId !== "") {
    out.add(d.runId);
  } else if (d.v === 1 && typeof d.snapshot === "object" && d.snapshot !== null) {
    const snapRunId: unknown = (d.snapshot as Record<string, unknown>).runId;
    if (typeof snapRunId === "string" && snapRunId !== "") out.add(snapRunId);
  }
}

/**
 * [裁决点 7] 采集全部存活 session 的 workflow run 引用并集（agentDir 活源）。
 *
 * sessions 布局对齐 pi 实装 getSessionsDir（config.js）：`<agentDir>/sessions`
 * 下的 encoded-cwd 子目录（session-manager.js——`--<cwd 编码>--` 目录内
 * `<ts>_<sessionId>.jsonl`）。指向错误层级会静默扫出空集，裁决点 7 的引用
 * 保护整体落空（活跃 run 误判无主）——布局锚点以 pi dist 实装为准。
 */
async function collectAliveWorkflowRunReferences(
  agentDir: string,
): Promise<ReadonlySet<string>> {
  const refs = new Set<string>();
  let slugDirs: string[];
  try {
    slugDirs = listSessionSlugDirs(agentDir);
  } catch (err) {
    // 读错分通道（对齐 core pi-host-run-store 同款纪律）：ENOENT = 从未落盘的
    // 正常空态，空集返回（core reapOrphanRuns 按「无引用」正常判定）；非 ENOENT
    // （EACCES/EIO 等真 IO 故障）上抛——空集会把「引用状态不可知」折叠成「无任何
    // 引用」的成功返回，core 的「采集失败 = 整轮跳过（宁保留）」防御（reapOrphan
    // Runs 的 collectAliveRunReferences catch）在生产路径将不可达，持续 IO 权限
    // 故障下被存活 session 引用的 run 会在宽限窗后被不可逆删除。
    if (isEnoent(err)) return refs;
    throw err;
  }
  const readOpts = { encoding: "utf8" as const };
  for (const dir of slugDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      // 同款分通道：ENOENT = 该 slug 目录被并发清走（会话删除竞态），跳过；真 IO
      // 故障上抛整轮跳过（该目录下 session 的引用集缺席只延后删除——但「缺席的
      // 原因不可知」时按失败处置，不冒充空集）。
      if (!isEnoent(err)) throw err;
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const content = fs.readFileSync(path.join(dir, file), readOpts);
        for (const line of content.split("\n")) {
          extractRunReferencesFromLine(line, refs);
        }
      } catch {
        continue; // 单文件读失败跳过（宁保留——该文件的引用缺席只延后删除）
      }
    }
  }
  return refs;
}

// ── 进程级单例（dialog queue；原 index.ts module 级随域搬移） ────────────────────
//
// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API），不在此列。
// dialog queue 仍为本模块私有单例——消费方 = 本文件 createOrReuseServices +
// index.ts session_shutdown（flush L2 pending dialog）。

const DIALOG_QUEUE_KEY = Symbol.for(GLOBAL_SLOT_KEYS.dialogQueue);

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
   *  （per-session 新建为现状设计：store 生命周期与 session 等同，D-008/F-4）。
   * 测试注入 fake 以控制 loadAll 行为（kill-9 恢复分支）。
   */
  createRunStore?: (sessionDir: string, pi: ExtensionAPI, ctx: ExtensionContext) => JsonlRunStore;
  /**
   * [skill-reload D4] adoption 失败处置回调（组合根注入）：terminate adopted running
   * runs（notifyDone: true——用户可见）+ 移除 sessionState 条目。terminate 依赖的
   * LauncherDeps 完整形态（workerHost / onRunDone 通知链 / notifiedRunIds 去重窗口）
   * 与 sessionState Map 归 workflow 域闭包（workflow-events.ts）持有，本 seam 无访问
   * 通道，经此注入；未注入时失败处置仅完成 rebind-first + 日志（测试可观察调用）。
   */
  onAdoptionFailed?: (existing: SessionLifecycleResult, reason: string) => Promise<void>;
}

/** setupSessionLifecycle 的 adoption 分流入参（[skill-reload D4]）。 */
export interface SessionStartOptions {
  /**
   * session_start 事件 reason（pi SessionStartEvent.reason，SDK 锚定）。缺省视为
   * 非 reload——现状全量装配路径（向后兼容，现有调用/测试不传即走原行为）。
   */
  reason?: SessionStartEvent["reason"];
  /**
   * adoption 候选（既有 per-session 条目）。调用点在 reason==='reload' 时从
   * sessionState 取；条目缺失（reload 落在首次装配 await 链中）传 undefined →
   * 全量装配（唯一差异 = 恢复门控已跳过）。
   */
  existing?: SessionLifecycleResult;
}

/** setupSessionLifecycle 装配结果——组合根据此写入 per-session sessionState。 */
export interface SessionLifecycleResult {
  sessionId: string;
  store: JsonlRunStore;
  runs: Map<string, WorkflowRun>;
  sessionDir: string;
  /** D-008 per-session SAR（subagentService 委托目标） */
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
    // rpc mode（GUI/taiji）下保持原行为（ctx.ui.setWidget → sidecar → chatStore）。
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
  // host 五端口接线 + 送达 stale 防御（D5 单通道 {triggerTurn:true} / stale 静默降级 /
  // abandon 补显形 T4③）收敛在 @zhushanwen/pi-notify-ledger-host 工厂，权威注释随迁
  // 工厂内；component/logger 参数保持本包 label 前缀与 warn 通道归因不变，
  // sendDisplayMessage = 生产 bind 恒实现（NotifyLedgerHost 可选端口的本侧既有语义）。
  const ledgerHost = createPiNotifyLedgerHost(pi, ctx, {
    component: "subagent-workflow",
    logger,
    sendDisplayMessage: true,
  });
  // bind 与 recover 拆独立 try（失败归因不同）：
  // - bind 失败：槽上无 ledger，消费方（getBoundNotifyLedger）退回内核直发路径；
  // - recover 失败：bind 已成功、槽上 ledger 仍在，消费方照常走账本路径（重启重放
  //   缺席，边沿/看门狗仍投新通知）——不得共用 "bind failed" 文案误报。
  let ledger: ReturnType<typeof bindNotifyLedgerHost>;
  try {
    ledger = bindNotifyLedgerHost(ledgerHost);
  } catch (err) {
    logger.warn("[subagents] notify ledger bind failed", {
      reason: toErrorMessage(err),
    });
    return undefined;
  }
  try {
    // U4：重放观测已内聚到 ledger 分桶日志（recoveryReplays 桶经 extensionLogger
    // 通道落盘），此处不再重复打日志。
    ledger.recoverFromSession();
  } catch (err) {
    logger.warn("[subagents] notify ledger recoverFromSession failed (ledger stays bound)", {
      reason: toErrorMessage(err),
    });
  }
  return ledgerHost;
}

/**
 * 随迁块 4 的进程级维护三连（各 try-catch「失败记日志不阻断」，设计 §3.4）：
 * 过期 session 文件清理 / ADR-035 manifest tmp 恢复 / ADR-035 worktree reaper 扫描。
 * （[modeless 波5] 原 [E1] sync 批崩溃恢复接线已摘除；[collect 退役] core 侧
 * recoverSyncCollectBatch 方法本体已删——sync 批机制不存在，无恢复面可接线。）
 */
async function runProcessLevelMaintenance(
  agentDir: string,
  ctx: ExtensionContext,
  service: SubagentService,
  deps: SessionLifecycleDeps,
): Promise<void> {
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

  // [W1 / D5] session_start 兜底触发：统一保留维护轮（冷启动即清——进程首启
  // 无任何新写时的清理机会，覆盖「崩溃后重开的会话」历史遗留）。run 域目录锚
  // = resolveSessionDir 同源（与 JsonlRunStore 落盘同布局）；record 域目录锚 =
  // getSubagentRecordsDir(agentDir, rootCwd)，rootCwd 推导与 SubagentService 构造点
  // （SessionBaselines）同式：env 贯穿 ?? ctx.cwd 兜底，env 名单源 ENV_ROOT_CWD——
  // enc 段不漂移（sessions 与 records 两目录同源不变量）。进程级维护幂等，
  // oncePerProcess 守卫防双跑；/resume /fork 同进程复用时跳过（record-only 会话
  // 的持续累积由 record 首写触发点 RecordStore.register 覆盖）。
  try {
    await oncePerProcess("subagent-workflow:retention-maintenance-round", async () => {
      const envRootCwd = process.env[ENV_ROOT_CWD];
      const rootCwd = envRootCwd && envRootCwd !== "" ? envRootCwd : ctx.cwd;
      await runRetentionMaintenanceRound(
        {
          stateDir: path.join(resolveSessionDir(), STATE_DIR_NAME),
          recordsDir: getSubagentRecordsDir(agentDir, rootCwd),
        },
        {},
        {
          warn: (msg) => logger.warn(`[subagent-workflow] ${msg}`),
          debug: (msg) => logger.debug(`[subagent-workflow] ${msg}`),
          toMsg: (err: unknown) => toErrorMessage(err),
        },
      );
      // [裁决点 7]（workflow-run-resume-revision）孤儿 run 对账清理：引用集采集 =
      // 壳侧注入面（core 不 import pi SDK——全池 session 文件流式扫描，v2 注册
      // 条目 ∪ v1 快照条目 ∪ pre-W17 link 指针三代解析的并集）。同维护轮触发点、
      // 同 oncePerProcess 守卫（幂等整轮）；宽限窗缺省 7 天（env 可调）。
      // 触发面 = 全部 state 目录（对齐 core pi-host-run-store 枚举口径：agentDir
      // 根回退 + sessions/<slug>/workflow-state 全目录 + 本 session 锚定目录）——
      // 「引用 session 全删的目录」的残留 run 对本 session 维护轮结构性可达，判定
      // 与删除判据归 core reapOrphanRuns，本处只做目录枚举。引用集预采集一次复用
      // 全部目录（同轮同快照，逐目录重复全池扫描无增益）；登记文件
      // （orphan-run-reap.json）落各自 stateDir，多目录天然隔离。
      const stateDirs = new Set<string>([
        path.join(resolveSessionDir(), STATE_DIR_NAME),
        path.join(agentDir, STATE_DIR_NAME),
      ]);
      try {
        for (const ent of fs.readdirSync(path.join(agentDir, "sessions"), { withFileTypes: true })) {
          if (ent.isDirectory()) {
            stateDirs.add(path.join(agentDir, "sessions", ent.name, STATE_DIR_NAME));
          }
        }
      } catch (err) {
        // sessions 根不可枚举：ENOENT = 从未落盘（首次运行形态），仅保留上方两
        // 目录锚；非 ENOENT（EACCES/EIO 等真 IO 故障）debug 留痕不放大——枚举
        // 缺侧 = 少扫目录（宁保留方向，宽限窗兜底），对齐读错分通道纪律。
        if (!isEnoent(err)) {
          logger.debug(
            `[subagent-workflow] sessions 根目录枚举失败，state 目录触发面缺侧：${toErrorMessage(err)}`,
          );
        }
      }
      // 引用集惰性单次采集（同轮同快照，逐目录重复全池扫描无增益）：promise 在
      // core reapOrphanRuns 的 await 表达式内才创建——采集器上抛（真 IO 故障，
      // 读错分通道）时拒绝被该 await 的 try/catch 即时接住，不产生提前创建导致的
      // 未处理拒绝告警；登记文件（orphan-run-reap.json）落各自 stateDir，多目录天然隔离。
      let aliveRefsPromise: Promise<ReadonlySet<string>> | undefined;
      const collectAliveRefsOnce = (): Promise<ReadonlySet<string>> => {
        aliveRefsPromise ??= collectAliveWorkflowRunReferences(agentDir);
        return aliveRefsPromise;
      };
      const reapDeps = {
        collectAliveRunReferences: collectAliveRefsOnce,
        warn: (msg: string) => logger.warn(`[subagent-workflow] ${msg}`),
        debug: (msg: string) => logger.debug(`[subagent-workflow] ${msg}`),
        toMsg: (err: unknown) => toErrorMessage(err),
      };
      for (const dir of stateDirs) {
        await reapOrphanRuns({ stateDir: dir }, reapDeps);
      }
    });
  } catch (err) {
    logger.warn("[subagents] retention maintenance round failed", {
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
 * 宿主各写一遍正是 failure-mode-B）；pending:unregister 经 hooks 外置回调在本面
 * appendEntry 直落（[W2/V4 D6] 与 reload-closeout D4 定案对齐——不经 emit；位置在
 * transition 后、save 前，对齐原内联实现）；save 走 store 冷路径（done 绕过去抖）——
 * 冷路径语义在 JsonlRunStore.save 内，不随循环归属转移。loadAll 失败的 fail-fast
 * （storeHealthy=false 停初始化）是宿主职责，core 原样上抛、这里 catch 兜住。
 */
async function createSessionRunState(
  sessionDir: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SessionLifecycleDeps,
  opts: { skipRecovery: boolean },
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
  // [skill-reload D4] 恢复门控：session_start(reason==='reload') 全程不跑
  // recoverCrashedRuns（无论条目有无）。暗礁（设计 §2.4）：recoverCrashedRuns 判
  // 「crashed」只看 record fold 出的 running 态（loadAll 产物；runs Map 内存活
  // run 不参与判定）——loadAll 折叠重建出 running 态即经 interruptRun（终局编排
  // 单一入口）收编，事件流不含进程存活信息、窗口内存活 run 的流同样是 running
  // 形态——契约前提是「拥有这些 run 的进程已死」，而 reload 恰恰证明进程没死，
  // 跑恢复即误杀窗口内存活的 run。条目缺失场景同理
  // 门控：磁盘可能有本 session 的 running entry（前一轮 adoption 未完成又
  // reload 的窗口），由下一次**非 reload** 的 session_start（真重启/切换）按既有
  // kill-9 语义收编。跳过 loadAll 时无从证伪健康度：storeHealthy 保持 true
  // （workflow 域可用，可派发新 run）。
  if (!opts.skipRecovery) {
    try {
      // [B1 修复] 恢复不挂 oncePerProcess：loadAll 只认本 session 的 v2 注册
      // 条目（record 流折叠重建，W17 定界的现行形态）、收编即向本 run 的 record
      // 流追加 run-interrupted 转移事件（不覆盖任何文件，天然幂等）——恢复是
      // session 级幂等操作，挂进程级守卫会让同进程的后续 session_start（如 /new
      // 后 /resume 一个上次崩溃退出的 session）重放首次 Promise、跳过 loadAll，
      // 该 session 的 running 残留既不收编也不进 run 列表。reload 的防误杀由上方
      // opts.skipRecovery（分流处按 reason 判定）承担，无需进程级守卫。
      const { loaded, recovered } = await recoverCrashedRuns(
        store,
        runs,
        "Process killed (kill-9 or crash recovery)",
        {
          onRunRecovered: (payload) => {
            // [W2/V4 D6] 注销直落权威面：appendEntry 直接落盘，不经 emit。
            // [reload-closeout D4] 定案「emit 链在 reload 转换窗失效、appendEntry
            // 是唯一可靠通道」在崩溃恢复链同样适用（session_start 装配窗可能仍在
            // reload 转换内）；pending 域消费方全部从持久化 entries 现算，直落对其
            // 即时生效。status 经 protocol mapReasonToStatus 单点（与 finalizeRun
            // 直落 / reconcile-sweep 补注销同一函数）；抛错由 core 侧 hook 围栏
            // warn 留痕后恢复循环继续，差集残留交 reconcile-sweep 下次收口。
            pi.appendEntry(PENDING_UNREGISTER_ENTRY_TYPE, {
              id: payload.id,
              reason: payload.reason,
              status: mapReasonToStatus(payload.reason),
            });
          },
          // [W1 / D4] 收编终态条目补写（恢复链收编的条目半边）：core 在 journal
          // run-settled 落账后回调本面，v2 终态条目经当前 pi appendEntry 落主
          // session（注册 + 终态两条 v2 小条目的收编补齐；本 store loadAll 对
          // 「journal 已终局而条目缺失」形态的幂等补写与此同构）。围栏在 core 消费
          // 侧（同步抛错 warn 后恢复循环继续，lifecycle.ts hooks 契约）。
          appendSettledEntry: (customType, data) => {
            pi.appendEntry(customType, data);
          },
        },
      );
      logger.debug(
        `[subagent-workflow] recoverCrashedRuns: loaded=${loaded} recovered=${recovered}`,
      );
    } catch (err) {
      // QMF-4 fix: store.loadAll 失败是关键路径错误，workflow 域将未初始化
      logger.error("[subagent-workflow] store.loadAll failed, workflow domain uninitialized", {
        reason: toErrorMessage(err),
      });
      storeHealthy = false;
    }
  }
  return { store, runs, storeHealthy };
}

// ── [skill-reload D4] post-reload adoption（接管而非重建） ─────────────────────

/**
 * adoption 主体：接管既有条目（同引用原地改写）。成功返回原 SessionLifecycleResult
 * （sessionState.get(sid) 与 reload 前同一引用——探针红线，store/runs 不换实例）；
 * 失败（健康检查不过 / rebind 抛错）走 {@link failAdoption} 后返回
 * undefined（调用方落到全量装配）。
 */
async function tryAdoptExistingSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SessionLifecycleDeps,
  existing: SessionLifecycleResult,
  lastEngine: string | undefined,
): Promise<SessionLifecycleResult | undefined> {
  // 健康检查：上一轮装配时 loadAll 失败（storeHealthy=false）的 store 不具备承载
  // 接管的写入可靠性 → 失败处置（G3 用户可见），不接管。
  if (!existing.storeHealthy) {
    await failAdoption(pi, ctx, deps, existing, "store unhealthy (loadAll failed in previous session_start)");
    return undefined;
  }
  try {
    // D3 rebind：store 实例跨 reload 存活（this 引用不变），原地改写 .pi/.ctx；
    // 换入的 appendEntry 源带 stale guard（D5）。[D1] record 单源后 store 无投影
    // 物化面（原 D4 快照重发随 state 快照删除而退役）——接管动作收敛为 rebind，
    // 后续 v2 终态条目补写自动走新 pi。
    existing.store.rebind(pi, ctx);
  } catch (err) {
    await failAdoption(pi, ctx, deps, existing, toErrorMessage(err));
    return undefined;
  }
  // 接管：同引用原地改写（ctx 换新——旧 ctx 已被 invalidate；lastEngine 按当前
  // config 重置基线）。跳过 store/runner 重建（幂等 last-wins）。
  existing.ctx = ctx;
  existing.lastEngine = lastEngine;
  logger.debug(
    `[subagent-workflow] adoption ok (sessionId=${existing.sessionId}, runs=${existing.runs.size})`,
  );
  return existing;
}

/**
 * adoption 失败处置（顺序敏感，设计 D4/r4）：
 * ① 先无条件 store.rebind(newPi, newCtx)——失败若发生在 rebind 之前，terminate
 *   的终态 flush 走未 rebind 的旧 pi 且 stale guard 未装 → 终态 failed entry 不落
 *   权威 JSONL，run 从 session 历史消失；先 rebind 让终态 flush 走新 pi，G3 可见性
 *   与权威记录同时兑现。rebind 自身再失败则跳过并日志登记终态丢失面。
 * ②+③ 经组合根注入回调：terminateRunningRuns（notifyDone: true，用户可见）+
 *   移除 sessionState 条目（不残留半接管状态）。
 * ④ adoption=failed 归因日志（G4：可从日志直接读出因果）。
 */
async function failAdoption(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SessionLifecycleDeps,
  existing: SessionLifecycleResult,
  reason: string,
): Promise<void> {
  try {
    existing.store.rebind(pi, ctx);
  } catch (rebindErr) {
    logger.warn(
      "[subagent-workflow] adoption failure rebind also failed (terminal entries may be lost)",
      { sessionId: existing.sessionId, reason: toErrorMessage(rebindErr) },
    );
  }
  if (!deps.onAdoptionFailed) {
    logger.warn(
      "[subagent-workflow] adoption failure cleanup callback not injected (runs not terminated, entry not removed)",
      { sessionId: existing.sessionId },
    );
  } else {
    try {
      await deps.onAdoptionFailed(existing, reason);
    } catch (err) {
      logger.error("[subagent-workflow] adoption failure cleanup failed", {
        sessionId: existing.sessionId,
        reason: toErrorMessage(err),
      });
    }
  }
  logger.error(
    `[subagent-workflow] adoption=failed sessionId=${existing.sessionId} reason=${reason}`,
  );
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
  options?: SessionStartOptions,
): Promise<SessionLifecycleResult> {
  const agentDir = getAgentDir();
  const sessionId = ctx.sessionManager.getSessionId();

  // [U7] 引擎列表同步 engines.json（幂等零写 + fail-safe；组合根注册已在
  // extension 工厂体完成，此处 registry 已含全部引擎）。写 agentDir 全局文件属
  // 跨 session 副作用——oncePerProcess 守卫防 factory 二调/handler 累积双跑（u-audit-fix）。
  oncePerProcess("subagent-workflow:sync-engines-file", () => syncEnginesFile(agentDir));

  // skill 路径两级缓存 session 级失效：pi 同进程可能有多个 session（TUI /new、/fork），
  // 运行中安装的 skill 需对新 session 可见（含曾 miss 缓存的 undefined 条目与 npm 新装
  // 包的候选目录）。session 内复用收益不变（IF8/DM3 重读发生在同 session 的重复调用）。
  clearSkillPathCache();

  // ── [M4] identity 子进程写入（随迁块 1）──
  appendSubagentIdentityEntry(pi);

  // ── [U2] 通知账本装配 + 重启恢复（随迁块 2）──
  // [skill-reload D4] 两分支都保留：ledger re-bind 到新 pi/ctx（getBoundNotifyLedger()
  // 现读方自动看到新绑定）。
  bindLedgerHostAndRecover(pi, ctx);

  // ── subagents 域：双 Service 装配（随迁块 3，经 deps 可注入）──
  // [skill-reload D4] 两分支都保留：initSession 复活链 + 新 ctx 注入（SubagentService
  // 跨 reload 存活，其 stale 面 _pi/_streamSink/_isIdleFn 由 initSession 重注入覆盖）。
  const { service, modelService } = deps.createServices
    ? deps.createServices(pi, ctx)
    : createOrReuseServices(pi, ctx);

  // ── GC / manifest tmp / worktree 恢复（随迁块 4）──
  // [skill-reload D4] 两分支都保留：进程级维护幂等重跑无害（oncePerProcess 守卫 Map
  // 是模块级状态，reload 后归零属预期——D9）。
  await runProcessLevelMaintenance(agentDir, ctx, service, deps);

  // [engine-awareness D1b] lastEngine 基线重算提前到 adoption 分流前（两分支共用）：
  // 构造性同源——单次 reloadGlobalConfig 读取同时刷新 Service 路由缓存与 lastEngine
  // 基准，消灭 initModel 与本处两次独立读取间的分叉窗口。ok/absent → 归一后的当前
  // 引擎；failed → undefined（首 turn 检测静默基线化兜底）。
  const engineRead = modelService.reloadGlobalConfig();
  const lastEngine =
    engineRead.status === "failed" ? undefined : normalizeEngineId(engineRead.config.defaultEngine);

  // ── [skill-reload D4] adoption 分流（post-reload session_start(reason==='reload')）──
  // 恢复门控已由 isReload 承载（先于条目判断）；条目存在 → 接管（同引用原地改写，
  // store/runner 不重建）；条目缺失（reload 落在首次装配 await 链中）→ 落到下方
  // 全量装配，唯一差异 = 恢复门控已跳过。
  const isReload = options?.reason === "reload";
  if (isReload && options.existing) {
    const adopted = await tryAdoptExistingSession(pi, ctx, deps, options.existing, lastEngine);
    if (adopted) return adopted;
    // adoption 失败处置已完成（rebind-first + terminate + 条目移除 + 日志）→
    // 落到下方全量装配（session 继续可用：新建 store/runs/runner，恢复仍被门控跳过）。
  }

  // ── workflow 域：per-session store + runs + kill-9 恢复（随迁块 5）──
  const sessionDir = resolveSessionDir();
  const { store, runs, storeHealthy } = await createSessionRunState(sessionDir, pi, ctx, deps, {
    skipRecovery: isReload,
  });

  // D-008: per-session SAR（subagentService 委托目标）——per-session session_start
  // 时创建，经 SessionLifecycleResult 传给组合根。
  const runner = new SubprocessAgentRunner({
    subagentService: service,
  });

  return {
    sessionId,
    store,
    runs,
    sessionDir,
    runner,
    ctx,
    storeHealthy,
    lastEngine,
  };
}

/**
 * Workflow Fullscreen TUI View — Three-level navigation.
 *
 * Level 0 (Phase): 左 phase list，右 agent overview
 * Level 1 (Agent): 左 agent list，右 agent summary
 * Level 2 (Detail): 完整 agent 执行详情
 *
 * 读 WorkflowRun 聚合根；移除 restart（D-9）。新 engine 无 orchestrator 事件层
 * （AC-3），view 改用内部轮询（setInterval TICK_MS）从 run.state.trace 实时读 +
 * requestRender。
 *
 * SDK 集成：ctx.ui.custom factory 返回 Component{render(width), handleInput(data),
 * invalidate}，第二参数 `{overlay:true, overlayOptions}`（全屏 overlay，对齐 main +
 * subagents 扩展 + docs/pi-tui-development-guide.md §3.2）。按键经
 * matchesKey(data, KeyId) 解析（兼容 xterm/iTerm/kitty 转义序列差异）。
 * escape/ctrl+c 在 keybindings 同映射到 exit。
 *
 * 关键实现点：(a) overlay 第二参数必须传，否则 view 不全屏；(b) trace 必须 per-render
 * 重读（run.state.trace.toArray 返回内部数组引用，trace.append 后下次 render 可见），
 * 配条件失效 tick（签名比对，IF11）+ requestRender 保证运行中刷新；(c) 's' save 模式无条件可用
 * （saveWorkflow 内部对非 tmp workflow 返回错误消息）；(d) abort 失败时 notify 反馈，
 * 不静默吞（run 一次性生命周期——无 pause/resume，abort 是唯一提前停止方式）。
 */

import { promises as fsPromises } from "node:fs";
import { join as pathJoin } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

import {
  displayAgentName,
  saveWorkflow,
} from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  buildPhaseGroups,
  ELLIPSIS,
  formatActivityLine,
  formatAgentOneLiner,
  formatElapsed,
  formatElapsedSeconds,
  formatPhaseLine,
  formatStatusBadge,
  statusDotStr,
  type ThemeLike,
} from "../format.ts";
import {
  b,
  dashes,
  padToVisible,
  plainBorder,
  termRows,
  walled,
} from "../tui-kit.ts";
import {
  BOX_BORDER_CHARS,
  BUDGET_TOKENS_DIVISOR,
  SIDEBAR_WIDTH,
} from "./view-constants.ts";

// L2 详情内容构建 + 滚动按键（纯函数）抽到 detail-content.ts（view 与其测试直接 import）。
// [H2 W3] live 进度数据源 = store record 投影（LiveProgressView，替代 node.live）。
import {
  buildDetailContent,
  detailContentLength,
  projectRecordProgress,
  type DetailScrollContext,
  type LiveProgressView,
  processDetailKey,
} from "./detail-content.ts";

// ── TUI layout constants ──────────────────────────────────────

const NAV_LEVEL_DETAIL = 2;
type NavLevel = 0 | 1 | typeof NAV_LEVEL_DETAIL;
const MIN_BODY_LINES = 3;
const BODY_HEIGHT_NUMERATOR = 2;
const BODY_HEIGHT_DENOMINATOR = 3;
/** save overlay 居中计算的除数（÷2 居中）。 */
const OVERLAY_CENTER_DIVISOR = 2;

/** 轮询间隔：engine 无事件推送，view 自轮询 trace 变化。
 *  200ms 对齐 subagents spinner 节奏，保证 agent 运行中 live 进度（tool calls/activity）流式可见。 */
const TICK_MS = 200;

/** 可打印 ASCII 字符下限（用于 save overlay 输入过滤）。 */
const PRINTABLE_CHAR_MIN = 32;

// ── 边框着色 helper 家族（b/dash/dashes/titleBorder/plainBorder/walled）──
// 单定义 ../tui-kit.ts（post-convergence C4）：本文件原私有自由函数副本与
// subagents list-component 的方法形态副本收敛为 kit 一份（本文件形态胜出），
// 统一 borderMuted token，所有 ╭╮╰╯├┤┬┴─│ 颜色一致。

// ── Minimal TUI duck-types（避免直接 import TUI/KeybindingsManager 类型 ──
// 共享类型 fallback 不导出 TUI 类，
// workspace 跨包 typecheck 会报 "no exported member 'TUI'"。
// 此处用结构化接口替代——只声明 view 实际用到的成员（requestRender + terminal）。

interface TuiLike {
  terminal: { columns: number; rows: number };
  requestRender(): void;
}

// ── View actions ──────────────────────────────────────────────

/**
 * view 可触发的 lifecycle 操作（由调用方注入，避免 view 直接依赖 Engine 函数）。
 * 每个 action 接收 runId；调用方绑到 abortRun（一次性生命周期——仅 abort）。
 */
export interface ViewActions {
  abort: (runId: string) => Promise<void>;
}

// ── 渲染签名（IF11/TC7/DM6：tick 条件失效的判据，渲染动态字段 SSOT）──────

// ── [H2 W3] live 数据源：store record 配对（设计 D2 进度源切换）─────────

/**
 * 查询 + 配对：本 run 的 store records → running trace node 的 live 进度投影。
 *
 * **record ↔ trace node 对应关系（opts 标签映射 + 时间最近邻）**：
 *   - 候选 = 查询结果中 status==="running" 的 record（执行期 record 恒在内存源；
 *     archive 后的终态 record 从磁盘 light 重建，无 eventLog——但终态节点的渲染走
 *     node.result 终态摘要路径，不消费 record 投影）；
 *   - 标签匹配 = `record.task === node.task`（record.task = opts.prompt，与
 *     node.task 同源——workflowCallToExecuteOptions 的 task 映射单点）；
 *   - 多候选（parallel 同 prompt）时取 startedAt 与 node.startedAt 差绝对值最小者
 *     （record 创建紧随 dispatch，pi 快路径下仅隔数个 microtask；非 pi 引擎 probe
 *     异步时仍是最优最近邻）；配对后从候选池移除（贪心一一）。
 *
 * 精度语义：不同 prompt/agent 的节点精确匹配；完全同构（prompt+agent 均同）的
 * parallel 孪生节点匹配到两者之一（数值可能在孪生间互换，形态不变）。running
 * node 无匹配 record（重试间隙——上个 record 已 failed、新 record 未创建）时
 * 走终态 fallback 渲染（与旧 live 缺失路径同形态）。
 */
export function collectNodeLiveProgress(
  run: WorkflowRun,
  records: SubagentRecord[],
): Map<number, LiveProgressView> {
  const candidates = records.filter((r) => r.status === "running");
  const result = new Map<number, LiveProgressView>();
  for (const node of run.state.trace.toArray()) {
    if (node.status !== "running") continue;
    const nodeStarted = node.startedAt !== undefined ? Date.parse(node.startedAt) : Number.NaN;
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i++) {
      const rec = candidates[i]!;
      if (rec.task !== node.task) continue;
      // startedAt 解析失败（防御，正常不可达）排最后——不与有限值比较出假精度。
      const delta = Number.isFinite(nodeStarted)
        ? Math.abs(rec.startedAt - nodeStarted)
        : Number.POSITIVE_INFINITY;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) continue;
    const [matched] = candidates.splice(bestIdx, 1);
    if (matched) result.set(node.stepIndex, projectRecordProgress(matched));
  }
  return result;
}

/**
 * computeRenderSignature — 渲染输出中全部动态决定字段的签名（now 参数化，供测试）。
 *
 * 纯度说明：now 是显式参数，但 live 节点的 elapsedSeconds 经 projectRecordProgress
 * 内的 computeElapsedSeconds 现算（record.endedAt 缺省时取 Date.now()）——即使两次
 * 调用传同一 now，跨秒的真实时钟也会使签名变。该内含实时源只朝「多失效」方向
 * 偏离（多失效、不多绘、更不漏绘），对「签名同 → 跳过重绘」的单向判据安全。
 *
 * 用途：200ms tick 用它与上次签名比对——相同则该帧内容无可见变化，跳过清缓存 +
 * requestRender（纯等待场景零重建零重绘）；不同则走现状失效路径。可见行为逐帧
 * 等价的前提 = 签名字段集覆盖当前渲染的全部动态字段（漏字段 = 该字段渲染滞后一拍，
 * ES7；签名取原始值时粒度细于显示量化值，只多失效不多绘不漏绘）。
 *
 * **字段核对表**（每字段 ↔ 渲染消费点 file:line，完备性唯一证据——测试只能证
 * 「已入字段变 → 签名变」，不能证无漏字段）。live 七字段经 collectNodeLiveProgress
 * 的 store record 投影（[H2 W3] 数据源从 node.live 切换，字段口径不变）：
 *
 * | 签名字段 | 消费点 |
 * |---|---|
 * | run.state.status | WorkflowsView.ts renderHeader（statusDotStr+statusLabel 同串源）/ detail-content.ts statusLabel（statusDotStr 调用处）/ renderFooter |
 * | 秒桶 Math.floor(now/1000) | renderHeader formatElapsed（现算 elapsed）+ detail-content.ts（now 参与未完成节点 elapsed）|
 * | completed/total（节点 status 推导）| renderHeader |
 * | budget 量化值（tokens round-k + cost toFixed(4)=BUDGET_COST_DECIMALS，与 renderHeader budgetStr 同精度——第 3-4 位小数变化是可见变化）| renderHeader / saveTraceToFile |
 * | run.state.errorLogs 指纹 = length+末条 level:message（errorLogs 仅经 push + slice(-MAX_ERROR_LOGS) 变异——append-only + 前向淘汰、条目不可变；封顶后 length 不变内容移，单取 length 会漏失效，而任何可见变化必伴随 length 变或末条变，故 length+末条是完备且最小的指纹）| detail-content.ts（renderWorkerLogSection：total 标签 + 末 20 条）|
 * | 节点 stepIndex | nodeParts 首字段（trace 数组序参与拼接，节点重排→签名变）/ saveTraceToFile（trace 导出 `### [#stepIndex]` 标题）|
 * | 节点 sessionFile | detail-content.ts（renderSessionSection）|
 * | 节点 status | 节点行 statusDotStr / detail statusLabel |
 * | live.totalTokens | 节点行（level1AgentCells）/ detail（buildDetailContent 用量行）|
 * | live.toolCallCount（store 投影：eventLog tool_start 计数，与 getAllToolCalls(record).length 恒等——LiveProgressView 无别的计数字段，不得另引）| 节点行 / detail（用量行 + Activity 标签）|
 * | live.elapsedSeconds | 节点行 / detail（用量行 + Outcome Running 行）|
 * | live.turns | detail（Activity 标签 + Outcome Running 行）|
 * | live.eventLog.length（append-only，长度变化即尾部窗口右移出新事件）| detail（Activity 区 filter turn_end + 最近 N 条）|
 * | live.currentActivity（type+label 均入签名）| detail（Activity 当前活动行）|
 * | live.lastError（内容入签名，防同存在性不同文本漏绘）| detail（Outcome ⚠ 行）|
 *
 * 维护约定（DS8）：WorkflowsView/detail-content 新增任何动态展示字段必须同步
 * 并入本签名并更新上表，否则该字段渲染滞后一拍。本文件编辑会使表内 WorkflowsView
 * 行号漂移——改动核对表下方代码后必须 grep 实际位置刷新本表。
 */
/** 秒桶宽度（ms）：签名取 Math.floor(now / SECOND_MS)，秒桶推进 = 可见 elapsed 变化。 */
const SECOND_MS = 1000;

export function computeRenderSignature(
  run: WorkflowRun,
  liveProgress: Map<number, LiveProgressView>,
  now: number,
): string {
  const traceArr = run.state.trace.toArray();
  const completed = traceArr.filter((n) => n.status === "completed").length;
  const budget = run.state.budget;
  // budget 量化串与 renderHeader budgetStr 同源同精度（round-k token / toFixed(4) cost）
  const budgetPart = `${Math.round(budget.usedTokens / BUDGET_TOKENS_DIVISOR)}k/${budget.maxTokens ? `${Math.round(budget.maxTokens / BUDGET_TOKENS_DIVISOR)}k` : "∞"}::$${budget.usedCost.toFixed(BUDGET_COST_DECIMALS)}`;
  // errorLogs 指纹：detail 只渲染 total 标签 + 末 20 条（renderWorkerLogSection），
  // 而 errorLogs 仅经 push + slice(-MAX_ERROR_LOGS) 变异（append-only + 前向淘汰、
  // 条目不可变）——封顶后 length 不变内容移，单取 length 漏失效；任何可见变化必
  // 伴随「length 变」或「末条变」，故 length+末条（level:message）是完备最小指纹。
  const logs = run.state.errorLogs;
  const lastLog = logs && logs.length > 0 ? `${logs[logs.length - 1].level}:${logs[logs.length - 1].message}` : "-";
  const errorLogsPart = `${logs?.length ?? 0}:${lastLog}`;
  const nodeParts = traceArr.map((n) => {
    const l = liveProgress.get(n.stepIndex);
    return `${n.stepIndex}:${n.status}:${n.sessionFile ?? "-"}:${l?.totalTokens ?? -1}:${l?.toolCallCount ?? -1}:${l?.elapsedSeconds ?? -1}:${l?.turns ?? -1}:${l?.eventLog.length ?? -1}:${l?.currentActivity ? `${l.currentActivity.type}:${l.currentActivity.label}` : "-"}:${l?.lastError ?? "-"}`;
  });
  return [run.state.status, Math.floor(now / SECOND_MS), `${completed}/${traceArr.length}`, budgetPart, errorLogsPart, ...nodeParts].join("|");
}

// ── View state ────────────────────────────────────────────────

interface ViewState {
  level: NavLevel;
  phaseIdx: number;
  agentIdx: number;
  promptExpanded: boolean;
  disposed: boolean;
 // ── Save mode ──
  saveMode: boolean;
  saveInputValue: string;
  saveMessage: string;
  saveMsgOk: boolean;
 // ── L0/L1 列表滚动 ──
  /** 左侧 phase list 滚动 offset。 */
  phaseScrollOffset: number;
  /** 右侧 agent list 滚动 offset。 */
  agentScrollOffset: number;
 // ── L2 详情滚动 ──
  /** 右侧 detail 当前滚动 offset（render 路径 clamp 收敛）。 */
  detailScrollOffset: number;
  /** running 态是否自动钉底部（用户 PgUp 后置 false，End/PgDn 到底恢复 true）。 */
  followTail: boolean;
}

function createInitialState(): ViewState {
  return {
    level: 0,
    phaseIdx: 0,
    agentIdx: 0,
    promptExpanded: false,
    disposed: false,
    saveMode: false,
    saveInputValue: "",
    saveMessage: "",
    saveMsgOk: false,
    phaseScrollOffset: 0,
    agentScrollOffset: 0,
    detailScrollOffset: 0,
    followTail: true, // 默认钉底（对齐 subagents 进详情即底部对齐）
  };
}

// ── View factory ──────────────────────────────────────────────

/**
 * 创建 workflow fullscreen view。
 *
 * @param run WorkflowRun 聚合根（读 state.status/spec/trace/meta）
 * @param theme ThemeLike（避免直接 import Pi runtime）
 * @param ctx ExtensionContext（调 ui.custom 渲染 + ui.notify 错误反馈）
 * @param actions lifecycle 操作（abort），由调用方注入
 * @param runStateFile run 状态快照路径（可选，header 展示）
 * @param liveRecords 本 run 的 store record 查询（[H2 W3] 设计 D2 进度源切换：
 *   经 SubagentService.queries.collectRecordsByParentRunId 查询（内存 ∪ 磁盘重建 ∪
 *   manifest，LIST_LIMIT 口径），view 在 200ms tick 与 render 时重查并按
 *   collectNodeLiveProgress 配对到 running trace node。未注入（无 service 的测试
 *   环境）时 live 投影恒空，渲染走终态 result 路径。终态 record archive 出内存后
 *   由下次重查从磁盘重建面取终态快照——无需带 payload 的新事件类型（D2 实现锚点）。
 */
export function createWorkflowsView(
  run: WorkflowRun,
  theme: ThemeLike,
  ctx: ExtensionContext,
  actions: ViewActions,
  runStateFile?: string,
  liveRecords?: () => SubagentRecord[],
): Promise<void> {
  return ctx.ui.custom<void>((_tui: unknown, _t: unknown, _kb: unknown, done: (result: void) => void) => {
    const state = createInitialState();
    const tui = _tui as TuiLike;

    /** 查询 + 配对：本 run running 节点的 live 进度投影（liveRecords 未注入时恒空）。 */
    function collectLive(): Map<number, LiveProgressView> {
      return liveRecords === undefined ? new Map() : collectNodeLiveProgress(run, liveRecords());
    }

    function currentPhaseAgents() {
      const live = buildPhaseGroups([...run.state.trace.toArray()]);
      const pg = live[state.phaseIdx];
      return pg ? pg.nodes : [];
    }

    function clampSelections() {
      const live = buildPhaseGroups([...run.state.trace.toArray()]);
      if (state.phaseIdx >= live.length) state.phaseIdx = Math.max(0, live.length - 1);
      const agents = currentPhaseAgents();
      if (state.agentIdx >= agents.length) state.agentIdx = Math.max(0, agents.length - 1);
    }

 // 渲染缓存：缓存 key = width×rows，终端 resize 改高度时缓存失效（防行数不匹配终端）
    const cache = { key: undefined as string | undefined, lines: undefined as string[] | undefined };
    const requestRender = () => tui.requestRender();

 // ── 轮询 tick：engine 无事件推送，view 自轮询 trace + store record 变化 ──
 // 每 200ms 条件失效（IF11/TC7）：先查 store（parentRunId 查询域）配对 live 投影，
 // 再算渲染签名（computeRenderSignature，覆盖 header/节点行/L2 detail 全部动态
 // 字段），与上次相同 → 该帧内容无可见变化，直接 return（不清 cache、不
 // requestRender——纯等待场景零重建零重绘）；不同 → 现状路径（清缓存 +
 // requestRender）。lastSignature 初始 undefined，首 tick 必失效（保证首绘）。
 // 签名计算 O(N)（N=trace 节点数）远低于全量 render。
    let lastSignature: string | undefined;
    const tick = setInterval(() => {
      if (state.disposed) return;
      const signature = computeRenderSignature(run, collectLive(), Date.now());
      if (signature === lastSignature) return;
      lastSignature = signature;
      cache.key = undefined;
      cache.lines = undefined;
      requestRender();
    }, TICK_MS);

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      clearInterval(tick);
      done();
    };

 // ── L2 详情滚动辅助 ──
    /** L2 右侧 detail viewport 高度（与 renderLayout 的 viewH 同源）。 */
    function detailViewportHeight(): number {
      return Math.max(MIN_BODY_LINES, bodyHeight(termRows(tui)));
    }
    /** 重置 detail 滚动到底部对齐（切 agent / 进 L2 时调用）。 */
    function resetDetailScroll(): void {
      state.detailScrollOffset = Number.MAX_SAFE_INTEGER; // render clamp 收敛到 max
      state.followTail = true;
    }

 // ── Key handling（SDK Component.handleInput 模式，对齐 main） ──
 // matchesKey(data, KeyId) 处理终端转义序列差异（xterm/iTerm/kitty），
 // 优于手写 \x1b[A 等原始序列。escape/ctrl+c 在 keybindings 里同映射到 exit。
 // 阶段化编排（形态 1）：主函数只留「saveMode 拦截 → 各键阶段短路链」，
 // 各 handle*Key 返回是否消费该键；阶段顺序与原单函数 if 链逐一对齐。
    function handleInput(data: string): void {
      if (state.disposed) return;

 // ── Save mode 拦截（缺陷 #3 恢复）── save overlay 活跃时，所有键走 save 流程
      if (state.saveMode) {
        handleSaveModeInput(data);
        return;
      }

      if (handleEscapeKey(data)) return;
      if (handleDetailScrollKey(data)) return;
      if (handleNavUpKey(data)) return;
      if (handleNavDownKey(data)) return;
      if (handleEnterKey(data)) return;
      handleShortcutKeys(data);
    }

    /** escape/ctrl+c：L0 关闭 overlay（wrappedDone），否则降一级并重绘。 */
    function handleEscapeKey(data: string): boolean {
      if (!matchesKey(data, Key.escape)) return false;
      if (state.level === 0) {
        wrappedDone();
        return true;
      }
      state.level = (state.level - 1) as NavLevel;
      state.promptExpanded = false;
      cache.key = undefined;
      requestRender();
      return true;
    }

    /** L2 详情滚动键（委托 processDetailKey）。非 L2 / 无节点 / 未命中 → 返回 false 落到导航键
     *  （与原嵌套 if 跳过语义一致：L2 无节点时 up/down 仍可切 agent）。 */
    function handleDetailScrollKey(data: string): boolean {
      if (state.level !== NAV_LEVEL_DETAIL) return false;
      const node = currentPhaseAgents()[state.agentIdx];
      if (!node) return false;
      const detailCtx: DetailScrollContext = {
        viewportHeight: detailViewportHeight(),
        contentLines: detailContentLength(node, state, run, theme, collectLive().get(node.stepIndex)),
        isRunning: node.status === "running",
      };
      const r = processDetailKey(
        data,
        { scrollOffset: state.detailScrollOffset, followTail: state.followTail },
        detailCtx,
      );
      if (!r.handled) return false;
      state.detailScrollOffset = r.scrollOffset;
      state.followTail = r.followTail;
      cache.key = undefined;
      requestRender();
      return true;
    }

    /** up：L0 上移 phase / L1、L2 上移 agent（L2 同时重置详情滚动）。命中 up 即消费（无条件重绘收尾）。 */
    function handleNavUpKey(data: string): boolean {
      if (!matchesKey(data, Key.up)) return false;
      if (state.level === 0 && state.phaseIdx > 0) {
        state.phaseIdx--;
        state.agentIdx = 0;
        state.phaseScrollOffset = 0; // 切 phase → 重置滚动
        state.agentScrollOffset = 0; // 切 phase → 重置滚动
      } else if (state.level === 1 && state.agentIdx > 0) {
        state.agentIdx--;
        // agentScrollOffset 由 renderLevel1 自动调整
      } else if (state.level === NAV_LEVEL_DETAIL && state.agentIdx > 0) {
        state.agentIdx--;
        state.promptExpanded = false;
        resetDetailScroll(); // 切 agent → 底部对齐（对齐 subagents 进详情即钉底）
      }
      cache.key = undefined;
      requestRender();
      return true;
    }

    /** down：L0/L1/L2 逐级下移（边界截停）。命中 down 即消费（无条件重绘收尾）。 */
    function handleNavDownKey(data: string): boolean {
      if (!matchesKey(data, Key.down)) return false;
      if (state.level === 0) {
        const live = buildPhaseGroups([...run.state.trace.toArray()]);
        if (state.phaseIdx < live.length - 1) {
          state.phaseIdx++;
          state.agentIdx = 0;
          state.phaseScrollOffset = 0; // 切 phase → 重置滚动
          state.agentScrollOffset = 0; // 切 phase → 重置滚动
        }
      } else if (state.level === 1) {
        const agents = currentPhaseAgents();
        if (state.agentIdx < agents.length - 1) state.agentIdx++;
        // agentScrollOffset 由 renderLevel1 自动调整
      } else if (state.level === NAV_LEVEL_DETAIL) {
        const agents = currentPhaseAgents();
        if (state.agentIdx < agents.length - 1) {
          state.agentIdx++;
          state.promptExpanded = false;
          resetDetailScroll(); // 切 agent → 底部对齐
        }
      }
      cache.key = undefined;
      requestRender();
      return true;
    }

    /** enter：L0→L1→L2 逐级下钻 / L2 切换 prompt 展开。命中 enter 即消费（无条件重绘收尾）。 */
    function handleEnterKey(data: string): boolean {
      if (!matchesKey(data, Key.enter)) return false;
      if (state.level === 0 && currentPhaseAgents().length > 0) {
        state.level = 1;
        state.agentIdx = 0;
        state.agentScrollOffset = 0; // 进 L1 → 重置滚动
      } else if (state.level === 1) {
        state.level = NAV_LEVEL_DETAIL;
        state.promptExpanded = false;
        resetDetailScroll(); // 进 L2 → 底部对齐
      } else if (state.level === NAV_LEVEL_DETAIL) {
        state.promptExpanded = !state.promptExpanded;
        // 展开/折叠改变内容长度，render 路径 clamp 收敛；保持当前锚点语义
      }
      cache.key = undefined;
      requestRender();
      return true;
    }

    /** lifecycle 快捷键（链尾，命中即消费且不再回退）：a abort（仅 running）/ s 进 save mode / S 导出 trace。 */
    function handleShortcutKeys(data: string): void {
 // ── Lifecycle shortcuts (no restart per D-9; no pause/resume — one-shot) ──
      if (data === "a") {
        if (run.state.status === "running") {
          void actions.abort(run.runId)
            .then(() => { cache.key = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Abort failed: ${err.message}`, "error"));
        }
        return;
      }

 // ── Save shortcut（对齐 main：总是进入 save mode，非 tmp 时 saveWorkflow 报错） ──
      if (data === "s") {
        state.saveMode = true;
        state.saveInputValue = run.spec.scriptName;
        state.saveMessage = "";
        state.saveMsgOk = false;
        cache.key = undefined;
        requestRender();
        return;
      }

 // ── Trace export（对齐 main 的 S 键）：导出完整 trace 到 Markdown 文件 ──
      if (data === "S") {
        saveTraceToFile(run, ctx);
      }
    }

 /** save overlay 内的按键处理（esc 取消 / enter 保存 / backspace 删除 / 可打印追加）。 */
    function handleSaveModeInput(data: string): void {
 // Escape → 退出 save 模式
      if (matchesKey(data, Key.escape)) {
        state.saveMode = false;
        cache.key = undefined;
        requestRender();
        return;
      }
 // Enter → 保存
      if (data === "\r" || data === "\n") {
        const name = state.saveInputValue.trim();
        if (!name) {
          state.saveMessage = "Please enter a name";
          state.saveMsgOk = false;
          cache.key = undefined;
          requestRender();
          return;
        }
        void saveWorkflow(run.spec.scriptName, name)
          .then((msg) => {
            state.saveMessage = msg;
            state.saveMsgOk = true;
            state.saveMode = false;
            cache.key = undefined;
            requestRender();
          })
          .catch((err: Error) => {
            state.saveMessage = err.message;
            state.saveMsgOk = false;
            cache.key = undefined;
            requestRender();
          });
        return;
      }
 // Backspace → 删除最后一个字符
      if (data === "\x7f" || data === "\b") {
        state.saveMessage = "";
        if (state.saveInputValue.length > 0) {
          state.saveInputValue = state.saveInputValue.slice(0, -1);
        }
        cache.key = undefined;
        requestRender();
        return;
      }
 // 可打印字符 → 追加
      if (data.length === 1 && data.charCodeAt(0) >= PRINTABLE_CHAR_MIN) {
        state.saveMessage = "";
        state.saveInputValue += data;
        cache.key = undefined;
        requestRender();
        return;
      }
 // 屏蔽其他键（↑↓ 等）
    }

 // ── Component（SDK 规范：render(width) → string[] + handleInput + invalidate） ──
    return {
      invalidate(): void {
        cache.key = undefined;
        cache.lines = undefined;
      },
      render(width: number): string[] {
        const height = tui.terminal.rows;
        const key = `${width}x${height}`;
        if (cache.lines && cache.key === key) return cache.lines;
        clampSelections();
 // 缺陷 #1 修复：每次 render 从 run.state.trace 实时读（toArray 返回内部数组引用，
 // 后续 trace.append 会反映到 view），不再用 factory 时的冻结快照。live 进度同源
 // 重查 store（[H2 W3]：进度源 = collectRecordsByParentRunId 查询域）。
        const liveGroups = buildPhaseGroups([...run.state.trace.toArray()]);
        const raw = renderLayout(run, state, liveGroups, theme, width, height, runStateFile, collectLive());
 // Pad to terminal height so the overlay fills the screen (matches main 行为）
        const lines = raw.length < height
          ? [...raw, ...Array.from({ length: height - raw.length }, () => "")]
          : raw;
        cache.key = key;
        cache.lines = lines;
        return lines;
      },
      handleInput,
    };
  }, {
 // 缺陷 #2 修复：overlay 第二参数（对齐 main + subagents + pi-tui guide §3.2）
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 0 },
  });
}

// ── Layout rendering（box-drawing 框架，对齐 main）──────────────
//
// 视觉结构（与 main 一致）：
// ╭───────────────────────────────────────────────────╮
// │ name (bold) ● status · x/y · Ns │ ← header
// ├───────────────────────────────────────────────────┤
// │ Phases │ title · N agents │
// │ ──────────────── │ ────────────────── │ ← body
// │ ❯ ● 1 build 0/2 │ ● builder model ... │
// │ ● 2 deploy 0/1 │ ● tester model ... │
// │ (pad) │ (pad) │
// ╰───────────────────────────────────────────────────╯
// ↑↓ phase · ⏎ enter · a abort · s save · esc back ← footer (框外)
//
// body = sidebar(SIDEBAR_WIDTH) │ main(rest)
// save overlay 活跃时居中覆盖 body。

function bodyHeight(screenHeight: number): number {
 // header(2: name+desc/blank) + border(1) + body + border(1) + footer(1)
  const HEADER_FOOTER_LINES = 6;
  return Math.max(MIN_BODY_LINES, Math.floor((screenHeight * BODY_HEIGHT_NUMERATOR) / BODY_HEIGHT_DENOMINATOR) - HEADER_FOOTER_LINES);
}

const BUDGET_COST_DECIMALS = 4;

function renderLayout(
  run: WorkflowRun,
  state: ViewState,
  phaseGroups: ReturnType<typeof buildPhaseGroups>,
  theme: ThemeLike,
  screenWidth: number,
  screenHeight: number,
  runStateFile?: string,
  live?: Map<number, LiveProgressView>,
): string[] {
  const lines: string[] = [];
  const contentWidth = screenWidth - BOX_BORDER_CHARS;
  const mainWidth = contentWidth - SIDEBAR_WIDTH - 1; // -1 for the │ divider

  renderHeader(lines, run, theme, contentWidth, runStateFile);

  const phase = phaseGroups[state.phaseIdx] ?? phaseGroups[0];
  const agents = phase?.nodes ?? [];
  const now = Date.now();

 // 固定 body 高度，确保 renderLayout 始终返回固定行数
  const viewH = Math.max(MIN_BODY_LINES, bodyHeight(screenHeight));

  const bodyStart = lines.length;
  if (state.level === 0) {
    renderLevel0(lines, run, phaseGroups, state, theme, mainWidth, now, viewH);
  } else if (state.level === 1) {
    renderLevel1(lines, run, phaseGroups, state, theme, mainWidth, now, viewH, live);
  } else {
    // L2 详情走固定高度 viewport（右侧滚动），高度 = minBody（与 L0/L1 最小一致）
    renderLevel2(lines, run, agents, state, theme, mainWidth, now, viewH, live);
  }

 // Padding 已在各 renderLevel 内部处理，无需额外 padding

 // Wrap body lines with │ borders + sidebar divider（统一 borderMuted）
  for (let i = bodyStart; i < lines.length; i++) {
    lines[i] = walled(theme, lines[i], contentWidth);
  }

  lines.push(plainBorder(theme, "╰", "╯", contentWidth));

 // Save overlay（缺陷 #3）：居中覆盖 body
  if (state.saveMode) {
    const overlayLines = renderSaveOverlay(state, theme, screenWidth);
    const overlayStart = Math.max(bodyStart, bodyStart + Math.floor((lines.length - bodyStart - overlayLines.length) / OVERLAY_CENTER_DIVISOR));
    for (let i = 0; i < overlayLines.length && overlayStart + i < lines.length; i++) {
      lines[overlayStart + i] = overlayLines[i];
    }
  }

 // Footer（框外，对齐 main renderFooter）
  renderFooter(lines, run, state, theme);
  return lines;
}

/** Header：╭─╮ + name(bold) + 右侧 status/agents/elapsed/budget + 可选 state 路径行。 */
function renderHeader(
  lines: string[],
  run: WorkflowRun,
  theme: ThemeLike,
  contentWidth: number,
  runStateFile?: string,
): void {
  const traceArr = run.state.trace.toArray();
  const completed = traceArr.filter((n) => n.status === "completed").length;
  const total = traceArr.length;
  const elapsed = formatElapsed(run.meta.startedAt);
  const headerRight = `${formatStatusBadge(run.state.status, theme)} · ${completed}/${total} agents · ${elapsed}`;
  const budget = run.state.budget;
  const budgetStr = `${Math.round(budget.usedTokens / BUDGET_TOKENS_DIVISOR)}k/${budget.maxTokens ? `${Math.round(budget.maxTokens / BUDGET_TOKENS_DIVISOR)}k` : "∞"} tok · $${budget.usedCost.toFixed(BUDGET_COST_DECIMALS)}`;

  const nameLine = run.spec.slug
    ? `${theme.bold(run.spec.scriptName)}${theme.fg("dim", " · ")}${theme.fg("accent", run.spec.slug)}`
    : theme.bold(run.spec.scriptName);
  const rightPart = theme.fg("muted", `${headerRight} · ${budgetStr}`);

  lines.push(plainBorder(theme, "╭", "╮", contentWidth));
  lines.push(walled(theme, nameLine, contentWidth));

  if (run.spec.description) {
    const maxDesc = contentWidth - visibleWidth(rightPart) - 1;
    const descText = run.spec.description.length > maxDesc
      ? run.spec.description.slice(0, maxDesc - 1) + ELLIPSIS
      : run.spec.description;
    const descPart = theme.fg("dim", descText);
    const padLen = Math.max(0, contentWidth - visibleWidth(descPart) - visibleWidth(rightPart));
    lines.push(`${b(theme, "│")}${descPart}${" ".repeat(padLen)}${rightPart}${b(theme, "│")}`);
  } else {
    lines.push(walled(theme, rightPart, contentWidth));
  }
  // run 状态快照文件路径（可选——无 store 注入时不渲染）
  if (runStateFile) {
    lines.push(walled(theme, theme.fg("dim", `state: ${runStateFile}`.slice(0, contentWidth)), contentWidth));
  }
  lines.push(plainBorder(theme, "├", "┤", contentWidth));
}

/** Footer（框外）：nav hint + lifecycle shortcuts + esc/ctrl+c。 */
function renderFooter(
  lines: string[],
  run: WorkflowRun,
  state: ViewState,
  theme: ThemeLike,
): void {
  const navPart = state.level === 0
    ? "↑↓ phase · ⏎ enter"
    : state.level === 1
      ? "↑↓ agent · ⏎ detail"
      : "↑↓ agent · ⏎ prompt · PgUp/PgDn scroll";
  const actionParts: string[] = [];
  if (run.state.status === "running") {
    actionParts.push("a abort");
  }
  actionParts.push("s save");
  actionParts.push("S trace");
  actionParts.push("esc back");
  const footer = `${navPart} · ${actionParts.join(" · ")}`;
  lines.push("");
  lines.push(theme.fg("muted", footer));
}

/** mergeBody：左侧 sidebar + │ divider + 右侧 main，拼成 body 行（divider 着色 borderMuted）。 */
function mergeBody(
  lines: string[],
  leftLines: string[],
  rightLines: string[],
  theme: ThemeLike,
): void {
  const bodyHeightVal = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeightVal; i++) {
    const left = padToVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + b(theme, "│") + (rightLines[i] ?? ""));
  }
}

// 分屏视图固定头部行数（title + separator = 2）。
const SPLIT_HEADER_LINES = 2;

/** 计算滚动视口起始 index，确保选中项可见（居中策略，参考 subagents renderLeftColumn）。
 *  返回 [startIdx, viewportH]：startIdx 是内容区第一个可见项的 index，viewportH 是内容区可显示行数。 */
function computeViewport(
  totalCount: number,
  selectedIdx: number,
  bodyH: number,
): { startIdx: number; viewportH: number } {
  const viewportH = Math.max(0, bodyH - SPLIT_HEADER_LINES);
  if (viewportH <= 0) return { startIdx: 0, viewportH: 0 };
  if (totalCount <= viewportH) return { startIdx: 0, viewportH };
  // 选中项居中，到列表顶/底贴边
  const maxStart = Math.max(0, totalCount - viewportH);
  const center = Math.floor(selectedIdx - viewportH / OVERLAY_CENTER_DIVISOR);
  return { startIdx: Math.max(0, Math.min(center, maxStart)), viewportH };
}

// ── Level 0: Phase selection ──────────────────────────────────

function renderLevel0(
  lines: string[],
  run: WorkflowRun,
  phases: ReturnType<typeof buildPhaseGroups>,
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
  bodyH: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

 // Left: sidebar title + phase list（固定高度 viewport + 滚动，只构建可见行）
  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push(dashes(theme, SIDEBAR_WIDTH));
  const { startIdx: phaseStart, viewportH: phaseViewportH } = computeViewport(phases.length, state.phaseIdx, bodyH);
  for (let i = phaseStart; i < phaseStart + phaseViewportH && i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }
  // 回写滚动偏移（clamp，防止状态脏值）
  state.phaseScrollOffset = phaseStart;
  // padding 到固定高度
  while (leftLines.length < bodyH) leftLines.push("");
  leftLines.length = bodyH;

 // Right: agents in the currently selected phase only（固定高度 viewport + 滚动）
  const selectedPhase = phases[state.phaseIdx] ?? phases[0];
  rightLines.push(theme.fg("muted", selectedPhase
    ? (selectedPhase.name
      ? `${selectedPhase.name} · ${selectedPhase.nodes.length} agents · ${formatElapsed(run.meta.startedAt, now)}`
      : `${selectedPhase.nodes.length} agents · ${formatElapsed(run.meta.startedAt, now)}`)
    : "(no phase)"));
  rightLines.push(dashes(theme, mainWidth));
  if (selectedPhase) {
    const { startIdx: agentStart, viewportH: agentViewportH } = computeViewport(selectedPhase.nodes.length, state.agentIdx, bodyH);
    for (let i = agentStart; i < agentStart + agentViewportH && i < selectedPhase.nodes.length; i++) {
      rightLines.push(formatAgentOneLiner(selectedPhase.nodes[i], theme));
    }
    state.agentScrollOffset = agentStart;
  }
  while (rightLines.length < bodyH) rightLines.push("");
  rightLines.length = bodyH;

  mergeBody(lines, leftLines, rightLines, theme);
}

// ── Level 1: Agent selection ──────────────────────────────────

/** L1 左列：sidebar title + phase list（固定高度 viewport + 滚动，只构建可见行）。
 *  与 renderLevel0 左列同构——本 helper 只供 renderLevel1（renderLevel0 不在本单元目标内，不并轨，
 *  避免扩大行为面；后续如消重可让 L0 复用）。 */
function buildLevelSidebar(
  phases: ReturnType<typeof buildPhaseGroups>,
  state: ViewState,
  theme: ThemeLike,
  bodyH: number,
): string[] {
  const leftLines: string[] = [];
 // Left: sidebar title + phase list（固定高度 viewport + 滚动，只构建可见行）
  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push(dashes(theme, SIDEBAR_WIDTH));
  const { startIdx: phaseStart, viewportH: phaseViewportH } = computeViewport(phases.length, state.phaseIdx, bodyH);
  for (let i = phaseStart; i < phaseStart + phaseViewportH && i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }
  state.phaseScrollOffset = phaseStart;
  while (leftLines.length < bodyH) leftLines.push("");
  leftLines.length = bodyH;
  return leftLines;
}

/** L1 右列 header：phase 名 · agent 计数（无 phase 时 "(no phase)" 占位，两分支都补分隔线）。 */
function pushLevel1Header(
  rightLines: string[],
  phases: ReturnType<typeof buildPhaseGroups>,
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
): void {
  const currentPhase = phases[state.phaseIdx];
  if (currentPhase) {
    rightLines.push(theme.fg("muted", currentPhase.name
      ? `${currentPhase.name} · ${currentPhase.nodes.length} agents`
      : `${currentPhase.nodes.length} agents`));
    rightLines.push(dashes(theme, mainWidth));
  } else {
    rightLines.push(theme.fg("muted", "(no phase)"));
    rightLines.push(dashes(theme, mainWidth));
  }
}

/** L1 agent 行统计三元组：live 路径优先（运行中从 store record 投影读实时 token/tool + elapsed），
 *  终态回退 result 统计。 */
function level1AgentCells(
  node: ExecutionTraceNode,
  liveView: LiveProgressView | undefined,
  now: number,
): { tokStr: string; tcCount: number; elapsed: string } {
  if (liveView) {
    return {
      tokStr: liveView.totalTokens > 0 ? `${Math.round(liveView.totalTokens / BUDGET_TOKENS_DIVISOR)}k tok` : "",
      tcCount: liveView.toolCallCount,
      elapsed: formatElapsedSeconds(liveView.elapsedSeconds),
    };
  }
  const elapsed = formatElapsed(
    node.startedAt,
    node.completedAt ? new Date(node.completedAt).getTime() : now,
  );
  const tok = node.result?.usage;
  return {
    tokStr: tok ? `${Math.round((tok.input + tok.output) / BUDGET_TOKENS_DIVISOR)}k tok` : "",
    tcCount: node.result?.toolCalls?.length ?? 0,
    elapsed,
  };
}

/** L1 单个 agent 展示行：pointer + 状态点 + agent/model + tok/tools/elapsed（live 与终态同模板）。 */
function formatLevel1AgentLine(
  node: ExecutionTraceNode,
  theme: ThemeLike,
  liveView: LiveProgressView | undefined,
  now: number,
  selected: boolean,
): string {
  const pointer = selected ? "❯ " : "  ";
  const dot = statusDotStr(node.status, theme);
  const { tokStr, tcCount, elapsed } = level1AgentCells(node, liveView, now);
  return `${pointer}${dot} ${displayAgentName(node.agent)}    ${node.model}    ${tokStr} · ${tcCount} tools · ${elapsed}`;
}

function renderLevel1(
  lines: string[],
  _run: WorkflowRun,
  phases: ReturnType<typeof buildPhaseGroups>,
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
  bodyH: number,
  live?: Map<number, LiveProgressView>,
): void {
  const leftLines = buildLevelSidebar(phases, state, theme, bodyH);

 // Right: agent list（固定高度 viewport + 滚动）
  const rightLines: string[] = [];
  pushLevel1Header(rightLines, phases, state, theme, mainWidth);
  const currentPhase = phases[state.phaseIdx];
  const agents = currentPhase?.nodes ?? [];
  const { startIdx: agentStart, viewportH: agentViewportH } = computeViewport(agents.length, state.agentIdx, bodyH);
  for (let i = agentStart; i < agentStart + agentViewportH && i < agents.length; i++) {
    rightLines.push(formatLevel1AgentLine(agents[i], theme, live?.get(agents[i]!.stepIndex), now, i === state.agentIdx));
  }
  state.agentScrollOffset = agentStart;
  while (rightLines.length < bodyH) rightLines.push("");
  rightLines.length = bodyH;

  mergeBody(lines, leftLines, rightLines, theme);
}

// ── Level 2: Execution detail ─────────────────────────────────
// 详情内容构建 + 滚动按键已抽到 detail-content.ts（纯函数，可单测，且控制本文件行数）。

function renderLevel2(
  lines: string[],
  run: WorkflowRun,
  agents: ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
  viewH: number,
  live?: Map<number, LiveProgressView>,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

 // Left: agents title + agent names
  leftLines.push(theme.fg("muted", "Agents"));
  leftLines.push(dashes(theme, SIDEBAR_WIDTH));
  const AGENT_NAME_BUDGET = 4; // pointer(2) + spacing(2)
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const pointer = i === state.agentIdx ? "❯ " : "  ";
    const maxNameWidth = SIDEBAR_WIDTH - AGENT_NAME_BUDGET;
    const agentRef = displayAgentName(a.agent);
    const agentName = visibleWidth(agentRef) > maxNameWidth
      ? agentRef.slice(0, maxNameWidth - 1) + ELLIPSIS
      : agentRef;
    leftLines.push(`${pointer}${agentName}`);
  }

 // Right: full detail（viewport 截断 + 滚动，对齐 subagents renderRightDetail）
  const node = agents[state.agentIdx];
  if (node) {
    const content = buildDetailContent(node, state, run, theme, mainWidth, now, live?.get(node.stepIndex));
    const maxOff = Math.max(0, content.length - viewH);
    // running 且 followTail → 钉底部（最新输出始终可见，用户 PgUp 后停止跟随）
    if (node.status === "running" && state.followTail) {
      state.detailScrollOffset = maxOff;
    }
    // clamp 收敛（切 agent / End 越界后下次 render 归位）
    if (state.detailScrollOffset > maxOff) state.detailScrollOffset = maxOff;
    const start = state.detailScrollOffset;
    const visible = content.slice(start, start + viewH);
    while (visible.length < viewH) visible.push(""); // pad 填满视口
    rightLines.push(...visible);

    // 位置指示（仅内容超一屏时，对齐 subagents detailScrollInfo）
    if (content.length > viewH) {
      const end = Math.min(start + viewH, content.length);
      // 覆盖第一行标题，拼上 (start+1-end/total)
      const titleBase = "Detail";
      const indicator = ` (${start + 1}-${end}/${content.length})`;
      rightLines[0] = theme.fg("muted", titleBase + indicator);
    }
  }

 // body 固定高度 = viewH（左右都 pad/截到 viewH，避免内容撑高溢出）
  const bodyH = viewH;
  const leftPadded: string[] = [];
  for (let i = 0; i < bodyH; i++) leftPadded.push(leftLines[i] ?? "");
  const rightPadded: string[] = [];
  for (let i = 0; i < bodyH; i++) rightPadded.push(rightLines[i] ?? "");
  mergeBody(lines, leftPadded, rightPadded, theme);
}

// ── Trace export（S 键，对齐 main saveTraceToFile）─────────────

/** trace 导出文件每节点 outcome 截断长度。 */
const TRACE_OUTCOME_SLICE = 2000;
/** trace 导出文件 activity 行宽。 */
const TRACE_ACTIVITY_WIDTH = 80;

/**
 * 导出完整 workflow trace 到 Markdown 文件。
 * 路径：<agentDir>/workflow-traces/{runId}.md（agentDir = getAgentDir()，实例隔离）
 * 对齐 main 的 saveTraceToFile（WorkflowsView.ts:365-396）。
 * 阶段化编排：header 行 + 逐 phase 逐 node 全段同步拼完后，才走 mkdir→write→notify 异步链
 * （与原单函数时序一致：文件内容构建全部先于首次 fs 调用）。
 */
function saveTraceToFile(run: WorkflowRun, ctx: ExtensionContext): void {
  const dir = pathJoin(getAgentDir(), "workflow-traces");
  const filePath = pathJoin(dir, `${run.runId}.md`);
  const lines = traceHeaderLines(run);
  const phases = buildPhaseGroups([...run.state.trace.toArray()]);
  for (const pg of phases) {
    lines.push(`## Phase: ${pg.name || "(unnamed)"}`, "");
    for (const node of pg.nodes) {
      lines.push(...traceNodeLines(node));
    }
  }
  fsPromises.mkdir(dir, { recursive: true })
    .then(() => fsPromises.writeFile(filePath, lines.join("\n"), "utf8"))
    .then(() => ctx.ui.notify(`Trace saved: ${filePath}`, "info"))
    .catch((err: Error) => ctx.ui.notify(`Save failed: ${err.message}`, "error"));
}

/** trace 导出头部三行：标题 + 空行、Status/Started/Duration、Budget + 空行。 */
function traceHeaderLines(run: WorkflowRun): string[] {
  const lines: string[] = [];
  lines.push(`# Workflow Trace: ${run.spec.scriptName} (${run.runId})`, "");
  lines.push(`Status: ${run.state.status} | Started: ${run.meta.startedAt ?? "-"} | Duration: ${formatElapsed(run.meta.startedAt)}`);
  const budget = run.state.budget;
  lines.push(`Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens, $${budget.usedCost.toFixed(BUDGET_COST_DECIMALS)}`, "");
  return lines;
}

/** 单节点全段：### 标题 + Model/Duration + Prompt + Activity + Outcome（行序同原单函数版）。 */
function traceNodeLines(node: ExecutionTraceNode): string[] {
  const lines: string[] = [];
  lines.push(`### [#${node.stepIndex}] ${node.agent} — ${node.status}`);
  lines.push(`- Model: ${node.model}`);
  lines.push(`- Duration: ${formatElapsed(node.startedAt, node.completedAt ? new Date(node.completedAt).getTime() : Date.now())}`, "");
  lines.push("**Prompt:**", node.task, "");
  lines.push(...traceActivityLines(node));
  lines.push(...traceOutcomeLines(node));
  return lines;
}

/** 单节点 Activity 段：**Activity:** + 每条 toolCall 一行 + 空行；无 toolCall 时整段省略。 */
function traceActivityLines(node: ExecutionTraceNode): string[] {
  const lines: string[] = [];
  const toolCalls = node.result?.toolCalls ?? [];
  if (toolCalls.length > 0) {
    lines.push("**Activity:**");
    for (const tc of toolCalls) lines.push(`- ${formatActivityLine(tc, TRACE_ACTIVITY_WIDTH)}`);
    lines.push("");
  }
  return lines;
}

/** 单节点 Outcome 段：**Outcome:** + running/error/content（截断）三态互斥 + 空行。 */
function traceOutcomeLines(node: ExecutionTraceNode): string[] {
  const lines: string[] = [];
  lines.push("**Outcome:**");
  if (node.status === "running") lines.push("Still running...");
  else if (node.result?.error) lines.push(node.result.error);
  else if (node.result?.content) lines.push(node.result.content.slice(0, TRACE_OUTCOME_SLICE));
  lines.push("");
  return lines;
}

// ── Save overlay（缺陷 #3 恢复，从 main 移植简化版）────────────

/**
 * save overlay——名称输入框 + 状态消息。
 * refactor 的 saveWorkflow 仅支持 project scope（workflow-files.ts 统一为 rename），
 * 故去掉 main 的 scope 切换（Tab），只保留名称输入。
 */
function renderSaveOverlay(
  state: ViewState,
  theme: ThemeLike,
  width: number,
): string[] {
  const contentWidth = width - BOX_BORDER_CHARS;
  const lines: string[] = [];

  lines.push(plainBorder(theme, "╭", "╮", contentWidth));

 // Title
  lines.push(walled(theme, theme.bold(" Save dynamic workflow"), contentWidth));

 // Destination preview
  const destName = state.saveInputValue || "(name)";
  const destLine = `.pi/workflows/${destName}.js`;
  lines.push(walled(theme, theme.fg("dim", destLine), contentWidth));

 // Empty line
  lines.push(walled(theme, "", contentWidth));

 // Label
  lines.push(walled(theme, "Save as:", contentWidth));

 // Input line with cursor block
  const inputLine = `  > ${state.saveInputValue}\u2588`;
  lines.push(walled(theme, inputLine, contentWidth));

 // Empty line
  lines.push(walled(theme, "", contentWidth));

 // Inline message (error or success)
  if (state.saveMessage) {
    const msgStyle = state.saveMsgOk ? "success" : "error";
    const msgLine = `  ${state.saveMessage}`;
    lines.push(walled(theme, theme.fg(msgStyle, msgLine), contentWidth));
  } else {
    lines.push(walled(theme, "", contentWidth));
  }

 // Hint
  const hint = "Enter to save · Esc to cancel";
  lines.push(walled(theme, theme.fg("muted", hint), contentWidth));

  lines.push(plainBorder(theme, "╰", "╯", contentWidth));

  return lines;
}

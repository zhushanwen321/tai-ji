// src/interface/gui/workflow-tray-widget.ts
//
// workflow 托盘件的 widget 树产出 + 推送器（容器扩展点统一 §6.6 层 1，U10：托盘
// workflow 件改插件推 widget 树，宿主自建 workflow 分桶/首拉/专属面板退役——「树由谁
// 构造」从宿主换到插件进程，判据 = 事件源头在插件进程内；与 subagent 件 tray-widget.ts
// 同族同形态，差异只在数据源与变更出口）。
//
// 数据源 = workflow 域 per-session 的 runs Map（WorkflowRun 聚合根，LauncherDeps.runs
// 同源——经注入的 readRuns 现读，组合根 workflow-events 在 session_start 装配链后注入
// 当前 session 条目；聚合根内存投影即绝对状态，重启后经 loadAll 磁盘重建覆盖冷读）。
// 行级信息 = core runSummary 派生视图（三态 done>interrupted>running + DoneReason 终局
// 因）+ state.calls 成员计数（N/M 进度的原语承载位——list-tree 无进度条原语，拼进行
// label，信息不静默丢弃）。
//
// 变更驱动 = run 域 journal 落盘出口（core notifyJournalAppended 的壳层组合分发——
// run 生命周期每条转移帧都落 run 域 journal，出口回调即权威变更信号；进程级单监听
// 由组合根分发给 journal reporter 与本推送器两个消费者）。queueMicrotask 合并同 tick
// 多次触发后重推（微任务清空是构造性保证，不设 timer——ADR-0122 事件顺序承载）。
//
// 推送通道 = protocol setWidgetDual（与 subagent/todo/goal 同一 widget 区机制：RPC 经
// marker 到宿主 ViewHostStore per-session 分区 → composer 托盘 widget 区；TUI 走原生
// 文本行）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  guiComponent,
  guiResult,
  setWidgetDual,
  type DualWidgetContent,
  type GuiComponent,
  type GuiContext,
} from "@zhushanwen/extension-protocol";
import { runSummary } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/** 托盘 widget 的 viewId（宿主 widget 区分区键；todo/goal/subagent 同形短名）。 */
export const WORKFLOW_TRAY_VIEW_ID = "workflow";

/** 单次推送的 run 行上限（托盘是概览面不是全量列表；序 = runs Map 插入序截断）。 */
const TRAY_RUN_LIMIT = 50;

// ── 行级判据（宿主侧 tray-tone workflow 档的插件侧承载；run 级判据，消费
//    core runSummary/DoneReason 词表——与 subagent 件的 record 级投影判据不同组：
//    那组判据已下沉 extension-protocol 单点（subagent-projection/predicates.ts），
//    本组以 runSummary 为输入、仅本文件承载，词表扩值时与 core runSummary 同批评估。──

/**
 * 单个 run 的成员进度计数（N/M）：N = 已落定 call 数（result 已设置——markDone
 * 前置保证落定即有 result，error 有无区分成败）；M = 总 call 数。行 label 的承载位
 * （原宿主托盘 workflow 行的进度条 + N/M 文本迁 widget 后由 label 承载，不静默丢弃）。
 */
function memberProgressOf(run: WorkflowRun): { settled: number; total: number } {
  let settled = 0;
  for (const call of run.state.calls.values()) {
    if (call.result !== undefined) settled += 1;
  }
  return { settled, total: run.state.calls.size };
}

/** 行状态映射（与对话流 buildWorkflowGui 的 runTreePresentation 同口径）：running
 * 在途 → running；interrupted（暂停态无活体）→ 无圆点 pause；终局按终止性因分档
 * （failed 族红 / completed 与 aborted 绿——aborted 是用户主动取消非失败）。 */
function rowPresentation(
  summary: ReturnType<typeof runSummary>,
): { status?: "running" | "done" | "failed"; icon: "circle" | "pause" | "cross" | "check" } {
  if (summary.status === "running") return { status: "running", icon: "circle" };
  if (summary.status === "interrupted") return { icon: "pause" };
  switch (summary.reason) {
    case "failed":
    case "budget_limited":
    case "time_limited":
    case "partially_succeeded":
      return { status: "failed", icon: "cross" };
    case "completed":
    case "aborted":
      return { status: "done", icon: "check" };
    // done + 终局因缺省（注册表 miss 窗口）——数据缺口不作成败断言，中性 pause。
    case undefined:
      return { icon: "pause" };
  }
}

/** 行 label：`name · slug · N/M`（slug 缺省跳段——filter(Boolean) 防双空格）。 */
function rowLabelOf(run: WorkflowRun): string {
  const summary = runSummary(run);
  const progress = memberProgressOf(run);
  return [summary.name, summary.slug, `${progress.settled}/${progress.total}`]
    .filter(Boolean)
    .join(" · ");
}

/** 段清单（tab-bar sections 的段 = 子树数组）：两段共用同一行构造（仅过滤条件不同）。 */
function traySegment(runs: readonly WorkflowRun[]): GuiComponent[] {
  return [
    guiComponent("list-tree", {
      items: runs.map((run) => {
        const presentation = rowPresentation(runSummary(run));
        return {
          label: rowLabelOf(run),
          status: presentation.status,
          icon: presentation.icon,
          depth: 0,
        };
      }),
    }),
  ];
}

/** TUI 文本臂（pi 原生 widget 行——非 rpc/TUI 模式经 setWidgetDual 的 text 分支呈现）。 */
function trayTextLines(runs: readonly WorkflowRun[]): string[] {
  return runs.map((run) => {
    const summary = runSummary(run);
    const state = summary.status;
    return `[${state}] ${rowLabelOf(run)}`;
  });
}

/** meta 状态词表（head 状态点语义）。 */
type MetaStatus = NonNullable<import("@zhushanwen/extension-protocol").WidgetMeta["status"]>;

/**
 * workflow 托盘 widget 双模内容（meta head + tab-bar 双段，形态对齐 subagent 件的
 * 「进行中 / 已结束」两桶语义——原宿主分桶面板的两视图裁决同构）：
 * - gui 臂 meta：status = running>0 亮运行态、有失败终局落 failed、否则 done；
 *   badge/progress = 进行中 run 数（原宿主按钮角标的计数语义同源）；icon 点名
 *   'workflow'（宿主 widget icon registry 在册——U10 随件迁移登记）。
 * - gui 臂内容 = tab-bar 双段互斥覆盖全量：进行中段 = status==="running" 行；
 *   已结束段 = 其余（done / interrupted——interrupted 计已结束与原宿主 [D2] 显式
 *   裁决同口径：interrupted 是无活体暂停态不算进行中）。
 * - text 臂 = TUI 原生文本行。
 * - 空 runs → undefined（调用方按清屏语义推 setWidgetDual(…, undefined)——与 todo /
 *   subagent 空列表清屏同款，宿主 widget 区「有 entry 即渲染、清屏即消失」）。
 */
export function buildWorkflowTrayWidget(
  runs: readonly WorkflowRun[],
): DualWidgetContent | undefined {
  if (runs.length === 0) return undefined;
  const running = runs.filter((r) => runSummary(r).status === "running");
  const ended = runs.filter((r) => runSummary(r).status !== "running");
  const hasFailure = ended.some((r) => {
    const p = rowPresentation(runSummary(r));
    return p.status === "failed";
  });
  const status: MetaStatus =
    running.length > 0 ? "running" : hasFailure ? "failed" : "done";
  return {
    gui: guiResult(
      guiComponent("tab-bar", {
        tabs: [
          // 首段带 active：容器化宿主据此建立初始 tab（此后本地切换不被推送重置）
          { label: `进行中 ${running.length}`, active: true },
          { label: `已结束 ${ended.length}` },
        ],
        sections: [traySegment(running), traySegment(ended)],
      }),
      {
        title: "Workflows",
        status,
        progress: {
          current: running.length,
          total: runs.length,
          label: String(running.length),
        },
        icon: "workflow",
        badge: String(running.length),
      },
    ),
    text: trayTextLines(runs),
  };
}

// ── 推送器（组合根注入 readRuns 的 per-factory 实例）────────────────────────

/** workflow 域 run 集的现读口（组合根装配：当前 session 的 runs Map 值集，截断在推送器）。 */
export type WorkflowRunsReader = () => readonly WorkflowRun[];

/**
 * workflow 托盘 widget 推送器。attach = 初始推送（绝对投影——聚合根内存态即当前真值）；
 * notifyRunsChanged = run 域 journal 出口的变更信号（组合根分发，同 tick 多次合并为
 * 一次重推）；detach = 摘 ctx 停推。推送失败首败 warn 留痕（不重试——下一次 journal
 * 事件驱动重推，绝对投影语义下任何一帧成功即整镜恢复，subagent 件同款方向）。
 *
 * ctx 为 null 期间（attach 前 / detach 后）push 为 no-op；readRuns 抛错（session 装配
 * 链未完成的时序窗）按无数据清屏投影——不反噬 journal 出口调用方（core 写链不得被
 * 渲染侧故障打断）。
 */
export interface WorkflowTrayWidgetPusher { // oe-exempt:20261025:framework:托盘推树 port 契约（工厂单装配，非抽象接口单实现）
  attach(ctx: ExtensionContext): void;
  detach(): void;
  /** run 域变更信号（journal 出口组合分发调用；同 tick 多次合并微任务边界一次推送）。 */
  notifyRunsChanged(): void;
}

export function createWorkflowTrayWidgetPusher(
  readRuns: WorkflowRunsReader,
): WorkflowTrayWidgetPusher {
  const logger = getLogger("subagents");
  let ctx: ExtensionContext | null = null;
  /** 同 tick 多次变更信号合并为一次推送（微任务边界 = 合并点，无 timer）。 */
  let flushScheduled = false;
  let firstFailureLogged = false;

  function push(): void {
    if (ctx === null) return;
    let runs: readonly WorkflowRun[] = [];
    try {
      runs = readRuns();
    } catch (err) {
      // 读侧故障按清屏投影 + 留痕（不静默）——下一事件自然重推。
      logger.warn(`[workflow-tray] runs read failed; projecting empty: ${toErrorMessage(err)}`);
      runs = [];
    }
    try {
      setWidgetDual(
        ctx as GuiContext,
        WORKFLOW_TRAY_VIEW_ID,
        buildWorkflowTrayWidget(runs.slice(0, TRAY_RUN_LIMIT)),
      );
      firstFailureLogged = false;
    } catch (err) {
      // 推送失败不反噬 journal 出口调用方；显式留痕防静默丢（绝对投影语义）。
      if (!firstFailureLogged) {
        firstFailureLogged = true;
        logger.warn(`[workflow-tray] widget push failed; will retry on next run journal event: ${toErrorMessage(err)}`);
      }
    }
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      push();
    });
  }

  return {
    attach(target: ExtensionContext): void {
      ctx = target;
      scheduleFlush();
    },

    detach(): void {
      ctx = null;
    },

    notifyRunsChanged(): void {
      scheduleFlush();
    },
  };
}

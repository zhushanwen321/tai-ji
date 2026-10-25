// src/interface/gui/tray-widget.ts
//
// subagent 托盘件的 widget 树产出 + 推送器（容器扩展点统一 §6.6 层 1：托盘 subagent
// 件改插件推 widget 树，宿主自建分桶/计数/专属面板退役——「树由谁构造」从宿主换到
// 插件进程，判据 = 事件源头在插件进程内）。
//
// 数据源 = subagent-core RecordStore 查询面（getSubagentService().queries）：
// collectRecords 四源合并（内存 running ∪ 磁盘重建 ∪ 主 session entry ∪ manifest），
// rootSession 过滤在查询面内收敛（与宿主侧 recordsOf(sessionId) 同分区语义）；磁盘
// 重建天然覆盖宿主重启后的冷读收敛（S6 重启观察点——startup-sweep / ADR-0161 补写
// 的事件经折叠进同一重建规则，不丢形态）。变更驱动 = queries.onChange（core 状态迁移
// 点同步出口），queueMicrotask 合并同 tick 多次触发后重推（微任务清空是构造性保证，
// 不设 timer——ADR-0122 事件顺序承载，无时间窗）。
//
// 推送通道 = protocol setWidgetDual（模式分派单点：RPC 经 marker 到宿主 ViewHostStore
// per-session 分区 → composer 托盘 widget 区；TUI 走原生文本行）。渲染终点与 todo/goal
// 同一 widget 区机制（宿主 ComposerTray widgetItems → TrayWidgetButton/TrayWidgetPanel）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  guiComponent,
  guiResult,
  setWidgetDual,
  type DualWidgetContent,
  type GuiComponent,
  type GuiContext,
} from "@zhushanwen/extension-protocol";
import { getSubagentService, type SubagentRecord } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/** 托盘 widget 的 viewId（宿主 widget 区分区键；todo/goal 同形短名）。 */
export const SUBAGENT_TRAY_VIEW_ID = "subagent";

/** 单次推送的记录上限（托盘是概览面不是全量列表；行数超限按查询面排序截断）。 */
const TRAY_RECORD_LIMIT = 50;

// ── 判据（宿主侧 renderer lib/subagent-bucket SSOT 的插件侧镜像）──────────────
// 两域判据同形不同源：core 不依赖宿主 renderer，宿主不进插件进程——镜像由两侧
// 单测各自锚定（本文件 tray-widget.test / renderer subagent-bucket.test），词表
// 扩值时两侧同批评估（shared SubagentRecord 词表纪律同款）。

/** 占用判据：running 且无轮收条停因（「轮收条已写 = 本轮不在途」的等价信号）。 */
function isRunningProjection(record: SubagentRecord): boolean {
  return record.status === "running" && record.stopReason === undefined;
}

/**
 * 失败轮判据：lastRound.failure 存在且非 user.cancelled（FailureCause 存在即失败轮；
 * user.cancelled 是用户主动中止非失败）。返回该 failure 供展示消费；非失败轮返回
 * undefined。
 */
function failedRoundOf(record: SubagentRecord): SubagentRecord["lastRound"] | undefined {
  const failure = record.lastRound?.failure;
  if (failure === undefined) return undefined;
  if (failure.class === "user" && failure.kind === "cancelled") return undefined;
  return record.lastRound;
}

/** 失败分类展示词："<class>.<kind>" 点拼（与 run 终局 failedMembers[].cause 序列化形态同形）。 */
function failureCauseLabel(failure: { class: string; kind: string }): string {
  return `${failure.class}.${failure.kind}`;
}

// ── widget 树构造（纯函数，单测锚点）─────────────────────────────────────────

/** 行状态映射：running 在途 → running；失败轮 → failed（红点）；其余收尾 → done。 */
function rowStatusOf(record: SubagentRecord): "running" | "done" | "failed" | undefined {
  if (isRunningProjection(record)) return "running";
  if (failedRoundOf(record) !== undefined) return "failed";
  return "done";
}

/** 行 label：agent · slug · 失败分类（失败分类拼进行尾——TreeItem 无独立严重度文本
 *  字段，label 是该信息的原语承载位；迁移前宿主行的 failure chip 同为文本呈现，
 *  信息不静默丢弃，§6.6 风险②）。user.cancelled 是用户主动中止非失败（判据同源
 *  排除）：不拼失败词也不落 failed 点——拼上会与真失败同视觉，违反原宿主行的
 *  中性/危险二分（中止事实仍以「已结束」段行可见，非丢弃）。 */
function rowLabelOf(record: SubagentRecord): string {
  const parts = [record.agent];
  if (record.slug) parts.push(record.slug);
  const failure = failedRoundOf(record)?.failure;
  if (failure !== undefined) parts.push(failureCauseLabel(failure));
  return parts.join(" · ");
}

/** 单段清单（sections 的段 = 子树数组）：两段共用同一构造（仅过滤条件不同），保住行构造的单一口径。 */
function traySegment(records: readonly SubagentRecord[]): GuiComponent[] {
  return [
    guiComponent("list-tree", {
      items: records.map((record) => ({
        label: rowLabelOf(record),
        status: rowStatusOf(record),
        depth: 0,
      })),
    }),
  ];
}

/** TUI 文本臂（pi 原生 widget 行——非 rpc/TUI 模式经 setWidgetDual 的 text 分支呈现）。 */
function trayTextLines(records: readonly SubagentRecord[]): string[] {
  return records.map((record) => {
    const state = isRunningProjection(record) ? "running" : failedRoundOf(record) ? "failed" : "done";
    return `[${state}] ${rowLabelOf(record)}`;
  });
}

/** meta 状态词表（head 状态点语义）。 */
type MetaStatus = NonNullable<import("@zhushanwen/extension-protocol").WidgetMeta["status"]>;

/**
 * 托盘 widget 双模内容（meta head + tab-bar 双段，形态对齐 todo 的双段架构与原宿主
 * 托盘两桶语义「进行中 / 已结束」）：
 * - gui 臂 meta：宿主壳层唯一渲染 head（标题/状态点/进度/icon/badge）；status = running>0
 *   亮运行态（宿主呼吸点），有失败轮落 failed，否则 done；badge/progress = 进行中条数
 *   （托盘 `[bot N]` 计数语义与原宿主按钮角标同源）；icon 点名 'bot'（宿主
 *   WIDGET_ICON_ENTRIES 在册）。
 * - gui 臂内容 = tab-bar 双段互斥覆盖全量：运行中段 = 占用谓词命中行；已结束段 = 其余
 *   （含失败轮——失败分类在行 label 承载，状态点 failed 红，不静默丢弃）。
 * - text 臂 = TUI 原生文本行（setWidgetDual 模式分派到非 rpc 臂的呈现）。
 * - 空记录 → undefined（调用方按清屏语义推 setWidgetDual(…, undefined)——与 todo
 *   空列表清屏同款，宿主 widget 区「有 entry 即渲染、清屏即消失」）。
 */
export function buildSubagentTrayWidget(
  records: readonly SubagentRecord[],
): DualWidgetContent | undefined {
  if (records.length === 0) return undefined;
  const running = records.filter((r) => isRunningProjection(r));
  const ended = records.filter((r) => !isRunningProjection(r));
  const hasFailure = ended.some((r) => failedRoundOf(r) !== undefined);
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
        title: "Subagents",
        status,
        progress: {
          current: running.length,
          total: records.length,
          label: String(running.length),
        },
        icon: "bot",
        badge: String(running.length),
      },
    ),
    text: trayTextLines(records),
  };
}

// ── 推送器（session_start/shutdown 驱动的 per-factory 实例）──────────────────

/**
 * subagent 托盘 widget 推送器。attach = 订阅 record 变更 + 初始推送（collectRecords
 * 磁盘重建覆盖冷读）；detach = 取消订阅。推送失败首败 warn 留痕（不重试——下一次
 * onChange 事件驱动重推，绝对投影语义下任何一帧成功即整镜恢复，inflight reporter
 * 的 dirty 重推同款方向）。
 *
 * ctx 为 null 期间（attach 前 / detach 后）push 为 no-op；getSubagentService() 为
 * null（session_start 装配链之前）不订阅——attach 调用点在 setupSessionLifecycle
 * 之后（service 必在），防御分支仅覆盖异常时序。
 */
export interface SubagentTrayWidgetPusher { // oe-exempt:20261025:framework:托盘推树 port 契约（工厂单装配，非抽象接口单实现）
  attach(ctx: ExtensionContext): void;
  detach(): void;
}

export function createSubagentTrayWidgetPusher(): SubagentTrayWidgetPusher {
  const logger = getLogger("subagents");
  let ctx: ExtensionContext | null = null;
  let unsubscribe: (() => void) | null = null;
  /** 同 tick 多次 onChange 合并为一次推送（微任务边界 = 合并点，无 timer）。 */
  let flushScheduled = false;
  let firstFailureLogged = false;

  function push(): void {
    if (ctx === null) return;
    const service = getSubagentService();
    const records =
      service?.queries.collectRecords(TRAY_RECORD_LIMIT, "all", false) ?? [];
    try {
      // todo makeRefreshDisplay 同款断言（协议侧既有先例）：pi 的 ExtensionContext.ui.custom
      // 泛型签名与 GuiContext 静态不兼容，setWidgetDual 只读 mode/hasUI/ui.setWidget。
      setWidgetDual(ctx as GuiContext, SUBAGENT_TRAY_VIEW_ID, buildSubagentTrayWidget(records));
      firstFailureLogged = false;
    } catch (err) {
      // 推送失败不反噬 onChange 调用方（core 写链不得被渲染侧故障打断）；
      // 显式留痕防静默丢（绝对投影语义，下一事件自然补推）。
      if (!firstFailureLogged) {
        firstFailureLogged = true;
        logger.warn(`[subagent-tray] widget push failed; will retry on next record change: ${toErrorMessage(err)}`);
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
      const service = getSubagentService();
      // onChange 订阅幂等：reload 场景 attach 前先 detach（组合根时序保证），防御
      // 重复订阅在此收敛（先解后订，监听集不累积）。
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      if (service !== null) {
        unsubscribe = service.queries.onChange(scheduleFlush);
      }
      scheduleFlush();
    },

    detach(): void {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      ctx = null;
    },
  };
}

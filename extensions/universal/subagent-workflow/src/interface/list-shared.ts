// src/interface/list-shared.ts
//
// list-view 与 list-component 共享的类型/常量/纯函数，避免两者循环依赖。
// 原循环：list-view import 组件类 SubagentsListComponent；组件 import key 处理 + 状态类型。
// 本文件下沉「无跨文件依赖」的共享契约（list-view → list-component 单向）。
// 按键处理 processKey 仍留 list-view，由 list-view factory 注入给组件（KeyHandler 类型在此），
// 故 list-component 无需 import list-view，循环消除。

import type { SubagentService } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";

// ============================================================
// 常量
// ============================================================

/** list 收集的 record 上限（足够覆盖一个活跃 session）。factory/key/组件共用。 */
export const LIST_LIMIT = 100;

// ============================================================
// 类型
// ============================================================

/** list 视图内部状态。 */
export interface ViewState {
  selectedIdx: number;
  scrollOffset: number;
  filterText: string;
  detailMode: boolean;
  disposed: boolean;
}

/** 详情翻屏上下文（processKey 算步长用）。 */
export interface DetailKeyContext {
  viewportHeight: number;
  contentLines?: number;
}

/** TUI 接口（duck-type：requestRender + terminal.rows）。
 *  terminal.rows 用于全屏框填满 + 详情翻屏步长（同 WorkflowsView.ts:104 cast）。 */
export interface TuiLike {
  requestRender(): void;
  terminal: { rows: number };
}

/** 触发外部 notify 的回调（避免 list-view 直接依赖 ctx.ui）。 */
export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

/** 按键处理结果：changed 表示状态变更需重绘；exit 表示调用方应关闭 overlay。二者正交。 */
export interface KeyResult {
  /** 状态变更，需 invalidate + requestRender。 */
  changed: boolean;
  /** 调用方应调用 closeFn 关闭 overlay。 */
  exit: boolean;
}

/** 按键处理函数签名（list-view 的 processKey 类型）。
 *  依赖注入给 list-component，避免组件 import list-view 的 processKey 造成循环依赖。 */
export type KeyHandler = (
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  selected: SubagentRecord | null,
  service: SubagentService | null,
  detailCtx: DetailKeyContext | undefined,
  notify: NotifyFn | undefined,
) => KeyResult;

// ============================================================
// 纯函数
// ============================================================

/** filter 过滤 + 排序（纯函数，可单测）。 */
export function applyFilter(records: SubagentRecord[], filterText: string): SubagentRecord[] {
  const q = filterText.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) => {
    return (
      r.agent.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q) ||
      r.mode.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q)
    );
  });
}

// src/interface/list-view.ts
//
// /subagents list 全屏带框左右分屏 overlay。
//   左列：record 列表（状态图标 + agent + mode + 绝对时长）
//   右列：选中 record 详情（eventLog + result/error，可翻屏）
//
// 布局（margin:0 全屏覆盖，自画视觉边距盖住底下对话流）：
//   overlay 覆盖整个终端；框外留 1 行/1 列空白（applyPadding 画），框在内侧。
//     ┌────────────────────────────┐  ← overlay 顶空白行（盖底下）
//     │  ╭─ Subagents ───────────╮  │  ← 左 1 空格 + 框 + 右 1 空格
//     │  │ filter: _              │  │
//     │  ├─ Records ─┬─ Detail ───┤  │
//     │  │ body ...   │ body ...   │  │
//     │  ├────────────┴────────────┤  │
//     │  │ ↑↓ 导航 ...             │  │
//     │  ╰─────────────────────────╯  │
//     └────────────────────────────┘  ← overlay 底空白行
//   （外层框线仅为示意，实际是空白行/空格列）
//
// 契约（ctx.ui.custom overlay，对照 tui-rendering-pitfalls.md §3.2）：
//   custom<void>((tui, theme, kb, done) => Component, {overlay:true, overlayOptions})
//   Component: render(width):string[] + invalidate() + handleInput?(data)
//
// 关键避坑：
//   1. G-017 防叠加：模块级 activeView 单例，进入前 close()，factory 内 setActiveView
//   2. 导航只用方向键 matchesKey("up"|"down")，禁 j/k（避 filter 冲突）
//   3. overlay 退出 wrappedDone：幂等→标记→unsubscribe→clearAnimTimer→clearActiveView→done
//   4. 不调 theme.bg（背景由 Pi overlay 容器施加），只 fg/bold
//   6. 所有行经 truncLine（ANSI 安全）
//   7. 边框不调 renderShell:"self"（守 default-shell / 无残影契约）
//   8. 不用 Pi 的 overlay margin（那是物理留白会透出底内容）——改 margin:0 全屏覆盖
//      + applyPadding 自画视觉边距（顶底空白行 + 左右空格列），盖住底下对话流
//   9. 动画 setInterval(250ms) 安全：行数恒定（pad 到满屏），diff 只重画 spinner/elapsed

import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SubagentService } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import { type ThemeLike } from "./format.ts";
import { SubagentsListComponent } from "./list-component.ts";
import {
  type DetailKeyContext,
  type KeyHandler,
  type KeyResult,
  LIST_LIMIT,
  type NotifyFn,
  type TuiLike,
  type ViewState,
} from "./list-shared.ts";
import { PAGE_SCROLL_DEFAULT } from "./tui-kit.ts";

// ============================================================
// 常量
// ============================================================

// 布局/边框常量（LEFT_COL_RATIO、COL_*、BORDER_WIDTH、PAD_*、MIN_*、TITLE_*、
// SPLIT_FIXED_LINES、DETAIL_LEN_PROBE_WIDTH、VERT_CENTER_DIVISOR、
// SPINNER_FRAME_MS、PREVIEW_RECENT_LINES）已随 SubagentsListComponent 移至 list-component.ts；
// 终端兜底零件（终端行数兜底/termRows/边框家族）单定义在 ./tui-kit.ts（C4）。
// 共享类型/常量/纯函数（LIST_LIMIT/ViewState/DetailKeyContext/TuiLike/NotifyFn/applyFilter/
// KeyResult/KeyHandler）已移至 list-shared.ts（消除 list-view ↔ list-component 循环依赖）。

/** 详情区 eventLog 翻屏步长（方向键单步）。 */
const DETAIL_SCROLL_STEP = 1;

/** overlay 动画刷新间隔（spinner 换帧 + elapsed 跳动）。同 tool-render.ts SPINNER_INTERVAL_MS。 */
const OVERLAY_REFRESH_MS = 250;
/** onChange 重绘节流间隔。streaming 期间 text_delta 每个 token 都触发 store 变化，
 * 若每次全屏 invalidate + requestRender，重绘频率极高，pi diff 引擎在高频重绘下
 * 易产生 cell 残留（视觉重影）。节流到 120ms，animTimer（250ms）兜底保证刷新。 */
const ONCHANGE_DEBOUNCE_MS = 120;

// ============================================================
// G-017：模块级 overlay 单例（防叠加）
// ============================================================

/** 当前活动的 list overlay 句柄（null 表示无）。连按两次快捷键时先 close 前一个。 */
let activeView: { close: () => void } | null = null;

// ============================================================
// overlay 工厂
// ============================================================

/**
 * 创建全屏左右分屏 overlay。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  1. G-017 防叠加：activeView?.close()                              ║
 *   ║  2. ctx.ui.custom((tui, theme, kb, done) => {                      ║
 *   ║       unsubscribe = service.queries.onChange(() => tui.requestRender())  ║
 *   ║       activeView = { close: wrappedDone }                          ║
 *   ║       return new SubagentsListComponent(...)                       ║
 *   ║     }, { overlay:true, overlayOptions:{margin:0, width:"100%"}})   ║
 *   ║                                                                    ║
 *   ║  directId 不在 records 中 → notify 警告，仍打开列表                ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 */
export async function createSubagentsView(
  service: SubagentService,
  theme: ThemeLike,
  ctx: ExtensionContext,
  directId?: string,
): Promise<void> {
  // G-017：先关前一个 overlay
  if (activeView) {
    activeView.close();
    activeView = null;
  }

  const notify: NotifyFn = (msg, type) => ctx.ui.notify(msg, type);

  // directId 提示
  if (directId) {
    const all = service.queries.collectRecords(LIST_LIMIT);
    if (!all.some((r) => r.id === directId)) {
      notify(`No record found for id "${directId}", showing all`, "warning");
    }
  }

  await ctx.ui.custom<void>(
    (tui, _theme, _kb, done) => {
      // duck-type cast：读 terminal.rows 做满屏填高 + 详情翻屏步长
      const tuiLike = tui as TuiLike;
      const state: ViewState = {
        selectedIdx: 0,
        scrollOffset: 0,
        filterText: "",
        detailMode: false,
        disposed: false,

      };

      // 订阅 store 变化 → invalidate + requestRender（store 驱动重渲）。
      // 必须 invalidate：render 命中 width×rows 缓存会返回旧行——最后一个 running record
      // 完成、且无其他 running 时 animTimer 不再 invalidate（hasRunning=false 提前返回），
      // 导致 running→done 状态翻转永不重绘。invalidateFn 在 component 创建后绑定。
      // holder：onChange 注册时 component 尚未创建，用 ref 延后绑定 invalidate
      // （避免 let 重赋值触发 prefer-const）
      const invalidateRef = { fn: undefined as (() => void) | undefined };
      // debounce：streaming 期间 text_delta 每个 token 都触发 store 变化，若每次都
      // 全屏 invalidate + requestRender，重绘频率极高，pi diff 引擎在高频重绘下
      // 易产生 cell 残留（视觉重影）。节流到 ONCHANGE_DEBOUNCE_MS，animTimer（250ms）
      // 兜底刷新。终态变化（record 完成）延迟可接受。
      let renderDebounce: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = service.queries.onChange(() => {
        if (state.disposed) return;
        if (renderDebounce) clearTimeout(renderDebounce);
        renderDebounce = setTimeout(() => {
          renderDebounce = undefined;
          if (state.disposed) return;
          invalidateRef.fn?.();
          tuiLike.requestRender();
        }, ONCHANGE_DEBOUNCE_MS);
      });

      // directId 命中 → 进详情模式（右侧就地展开，底部对齐）
      if (directId) {
        const records = service.queries.collectRecords(LIST_LIMIT);
        const idx = records.findIndex((r) => r.id === directId);
        if (idx >= 0) {
          state.selectedIdx = idx;
          state.detailMode = true;
          state.scrollOffset = 0; // 顶部对齐：task 置顶可见（与 Enter 进详情一致）
        }
      }

      const component = new SubagentsListComponent(
        service,
        theme,
        tuiLike,
        state,
        unsubscribe,
        notify,
        processKey, // 依赖注入：组件不 import list-view（消除循环依赖）
      );
      invalidateRef.fn = () => component.invalidate();

      // 动画 timer：有 running record 时定期 invalidate + requestRender，
      // 让 spinner 丝滑换帧、elapsed 实时跳动（行数恒定，安全——对照
      // tool-render.ts 的 setInterval 模式 + dev guide §8160a5d13 安全分析）。
      const animTimer = setInterval(() => {
        if (state.disposed) return;
        if (!component.hasRunning()) return; // 无 running 不浪费刷新
        component.invalidate();
        tuiLike.requestRender();
      }, OVERLAY_REFRESH_MS);
      component.setAnimTimer(animTimer);

      // wrappedDone（dev guide §4 顺序：幂等→标记→unsubscribe→clearAnimTimer→clearActiveView→done）
      const wrappedDone = () => {
        if (state.disposed) return; // 幂等
        state.disposed = true; // ① 标记
        unsubscribe(); // ② 解订 store 事件
        clearInterval(animTimer); // ③ 清动画 timer
        if (renderDebounce) clearTimeout(renderDebounce); // ④ 清 debounce timer
        activeView = null; // ⑤ 清 G-017 句柄
        done(undefined); // ⑥ 框架 done（触发 overlay 销毁）
      };
      component.setCloseFn(wrappedDone);
      activeView = { close: wrappedDone };

      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center" as const,
        width: "100%",
        maxHeight: "100%",
        // margin:0 → overlay 覆盖整个终端（不留物理空白）。
        // 视觉边距由 buildLines 自画（顶底空白行 + 左右空格列），盖住底下对话流。
        // Pi 的 margin 是「物理留白透出底内容」，这里不能用。
        margin: 0,
      },
    },
  );
}

// ============================================================
// 按键处理（纯函数，可单测）——阶段化提取（形态 1）
// ============================================================

/**
 * 按键处理入口。两阶段焦点（detailMode 控制），主函数只留阶段编排：
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  阶段 1（list 焦点，detailMode=false）：                            ║
 *   ║    Esc 退出（有 filter 先清）/ ↑↓ 导航左列 / Enter 进阶段 2         ║
 *   ║    Backspace 删 filter / 可打印字符直接 filter                     ║
 *   ║                                                                    ║
 *   ║  阶段 2（detail 焦点，detailMode=true）：左侧锚定，滚右侧详情       ║
 *   ║    Esc 返回阶段 1 / ↑↓ PgUp/PgDn Home End 滚右侧 eventLog          ║
 *   ║    x 停止：background → service.cancel(id)（真正 abort）         ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 返回 KeyResult：changed 表示状态变更需重绘；exit 表示调用方应关闭 overlay。
 * 二者正交——Esc 在阶段 1 无 filter 时 changed=false + exit=true。
 *
 * 注：KeyResult/KeyHandler 类型定义在 list-shared.ts（list-component 也用 KeyHandler 做构造
 * 参数类型，避免组件 import list-view）。本函数由 list-view factory 注入组件（依赖注入）。
 * 各阶段子函数按原 if 链顺序匹配，命中短路返回（与原单函数版时序逐一对齐）。
 */
export const processKey: KeyHandler = (
  data,
  records,
  state,
  selected,
  service,
  detailCtx,
  notify,
): KeyResult => {
  if (state.detailMode) {
    return processDetailModeKey(data, state, selected, service, detailCtx, notify);
  }
  return processListModeKey(data, records, state, selected);
};

// ============================================================
// 阶段 2（detail 焦点，detailMode=true）：左侧锚定，滚右侧详情
// ============================================================

/** 阶段 2 滚动/返回键（Esc/↑/↓/PgUp/PgDn/Home/End，匹配顺序同原 if 链）。未命中返回 undefined。 */
function detailScrollKey(
  data: string,
  state: ViewState,
  detailCtx: DetailKeyContext | undefined,
): KeyResult | undefined {
  if (matchesKey(data, "escape")) {
    state.detailMode = false;
    state.scrollOffset = 0;
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "up")) {
    state.scrollOffset = Math.max(0, state.scrollOffset - DETAIL_SCROLL_STEP);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "down")) {
    const max = detailScrollMax(detailCtx);
    state.scrollOffset = Math.min(max, state.scrollOffset + DETAIL_SCROLL_STEP);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "pageUp")) {
    const step = detailCtx?.viewportHeight ?? PAGE_SCROLL_DEFAULT;
    state.scrollOffset = Math.max(0, state.scrollOffset - step);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "pageDown")) {
    const step = detailCtx?.viewportHeight ?? PAGE_SCROLL_DEFAULT;
    const max = detailScrollMax(detailCtx);
    state.scrollOffset = Math.min(max, state.scrollOffset + step);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "home")) {
    state.scrollOffset = 0;
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "end")) {
    state.scrollOffset = detailScrollMax(detailCtx);
    return { changed: true, exit: false };
  }
  return undefined;
}

/** 阶段 2 停止键（x）：background → service.cancel(id) 真正 abort。未命中返回 undefined。 */
function detailStopKey(
  data: string,
  selected: SubagentRecord | null,
  service: SubagentService | null,
  notify: NotifyFn | undefined,
): KeyResult | undefined {
  if (data === "x" && selected) {
    const changed = handleCancel(selected, service, notify);
    return { changed, exit: false };
  }
  return undefined;
}

/** 阶段 2 编排：滚动/返回 → 停止 → 落空（与原阶段 2 if 链 + 兜底 return 逐一对齐）。 */
function processDetailModeKey(
  data: string,
  state: ViewState,
  selected: SubagentRecord | null,
  service: SubagentService | null,
  detailCtx: DetailKeyContext | undefined,
  notify: NotifyFn | undefined,
): KeyResult {
  const scroll = detailScrollKey(data, state, detailCtx);
  if (scroll) return scroll;
  const stop = detailStopKey(data, selected, service, notify);
  if (stop) return stop;
  return { changed: false, exit: false };
}

// ============================================================
// 阶段 1（list 焦点，detailMode=false）：↑↓ 导航左列 + filter 编辑
// ============================================================

/** 阶段 1 filter 编辑键（backspace 删末字符 / 可打印 ASCII 字符追加）。未命中返回 undefined。 */
function listFilterKey(data: string, state: ViewState): KeyResult | undefined {
  if (matchesKey(data, "backspace")) {
    if (state.filterText.length > 0) {
      state.filterText = state.filterText.slice(0, -1);
      state.selectedIdx = 0;
      return { changed: true, exit: false };
    }
    return { changed: false, exit: false };
  }
  // 可打印字符 → filter（单字符 ASCII 可见区）
  if (data.length === 1 && data >= " " && data <= "~") {
    state.filterText += data;
    state.selectedIdx = 0;
    return { changed: true, exit: false };
  }
  return undefined;
}

/** 阶段 1 编排：Esc 清 filter/退出 → 导航 → 进详情 → filter 编辑 → 落空（匹配顺序同原 if 链）。 */
function processListModeKey(
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  selected: SubagentRecord | null,
): KeyResult {
  if (matchesKey(data, "escape")) {
    // 有 filter 先清（changed）；无 filter → 退出 overlay（exit）
    if (state.filterText.length > 0) {
      state.filterText = "";
      state.selectedIdx = 0;
      return { changed: true, exit: false };
    }
    return { changed: false, exit: true };
  }
  if (matchesKey(data, "up")) {
    state.selectedIdx = Math.max(0, state.selectedIdx - 1);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "down")) {
    state.selectedIdx = Math.min(Math.max(0, records.length - 1), state.selectedIdx + 1);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    if (selected) {
      state.detailMode = true;
      // 顶部对齐：task 提示词置顶（buildDetailContent 首行），进详情第一眼就看到。
      // 此前用 MAX_SAFE_INTEGER 底部对齐是为「event log 最新在底」，但 content > viewH 时
      // 会把置顶的 task 滚出视口顶——task 是「它在干嘛」的唯一线索（streaming 尤甚），
      // 必须可见。event log 在下方，向下滚可看历史。
      state.scrollOffset = 0;
      return { changed: true, exit: false };
    }
    return { changed: false, exit: false };
  }
  const filter = listFilterKey(data, state);
  if (filter) return filter;
  return { changed: false, exit: false };
}

// ============================================================
// 内部辅助
// ============================================================

/** 详情翻屏最大 offset（contentLines - viewportHeight，兜底 0）。
 *  与 renderRightDetail 的 max 计算保持一致（content.length - viewH）。 */
function detailScrollMax(detailCtx: DetailKeyContext | undefined): number {
  const content = detailCtx?.contentLines ?? 0;
  const viewH = detailCtx?.viewportHeight ?? 1;
  return Math.max(0, content - viewH);
}

/** 处理取消按键（x）。background 真正 abort。返回是否变化。 */
function handleCancel(
  record: SubagentRecord,
  service: SubagentService | null,
  notify: NotifyFn | undefined,
): boolean {
  if (record.status !== "running") {
    notify?.(`Cannot stop: record is ${record.status}`, "warning");
    return false;
  }
  if (!service) {
    notify?.("Runtime not ready, cannot stop", "error");
    return false;
  }
  const ok = service.cancel(record.id);
  notify?.(ok ? `Requested stop for ${record.id}` : `Stop failed (record may have ended)`, ok ? "info" : "warning");
  return true;
}

// firstLine 已上移到 ./format.ts 共享。

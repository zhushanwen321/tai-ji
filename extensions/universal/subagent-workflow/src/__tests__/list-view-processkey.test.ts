// src/__tests__/list-view-processkey.test.ts
//
// processKey（list-view）纯函数直接单测——两阶段焦点按键分发。
// 重构前该函数无直接测试（仅经 list-component.test.ts 的 keyHandler 注入间接触达），
// 本文件补齐阶段 1（list）/ 阶段 2（detail）全键位覆盖。
// 键序列取 pi-tui 实装（node_modules @earendil-works/pi-tui/dist/keys.js
// LEGACY_KEY_SEQUENCES + KEY_CODES），与运行时 matchesKey 判定同源。

import { describe, expect, it, vi } from "vitest";

import type { SubagentRecord, SubagentService } from "@zhushanwen/subagent-core";

import { processKey } from "../interface/list-view.ts";
import type { DetailKeyContext, NotifyFn, ViewState } from "../interface/list-shared.ts";

// ── 键序列（pi-tui 实装） ──

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const RETURN = "\n";
const BACKSPACE = "\x7f";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

// ── fixture 工厂（对齐 list-component.test.ts 形态） ──

function makeState(over: Partial<ViewState> = {}): ViewState {
  return {
    selectedIdx: 0,
    scrollOffset: 0,
    filterText: "",
    detailMode: false,
    disposed: false,
    ...over,
  };
}

function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "run-1",
    agent: "worker",
    task: "do the thing",
    status: "running",
    mode: "background",
    startedAt: 1000,
    endedAt: undefined,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    turns: 1,
    totalTokens: 10,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    ...over,
  } as SubagentRecord;
}

function makeService(cancel: (id: string) => boolean = () => true): SubagentService {
  return { cancel } as unknown as SubagentService;
}

function makeNotify() {
  // vi.fn() 可调用形态与 NotifyFn 结构兼容；断言走 .mock.calls
  return vi.fn();
}

function call(
  data: string,
  state: ViewState,
  opts: {
    records?: SubagentRecord[];
    selected?: SubagentRecord | null;
    service?: SubagentService | null;
    detailCtx?: DetailKeyContext;
    notify?: NotifyFn;
  } = {},
) {
  return processKey(
    data,
    opts.records ?? [makeRecord()],
    state,
    opts.selected ?? null,
    opts.service ?? null,
    opts.detailCtx,
    opts.notify,
  );
}

// ============================================================
// 阶段 1（list 焦点，detailMode=false）
// ============================================================
describe("processKey — 阶段 1（list）", () => {
  it("escape with filter clears it and resets selection (changed, no exit)", () => {
    const state = makeState({ filterText: "wo" });
    const r = call(ESC, state);
    expect(state.filterText).toBe("");
    expect(state.selectedIdx).toBe(0);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("escape without filter exits the overlay (no change)", () => {
    const r = call(ESC, makeState());
    expect(r).toEqual({ changed: false, exit: true });
  });

  it("up clamps at 0", () => {
    const state = makeState({ selectedIdx: 0 });
    const r = call(UP, state);
    expect(state.selectedIdx).toBe(0);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("up moves selection up", () => {
    const state = makeState({ selectedIdx: 2 });
    call(UP, state);
    expect(state.selectedIdx).toBe(1);
  });

  it("down clamps at records.length - 1", () => {
    const records = [makeRecord(), makeRecord({ id: "run-2" })];
    const state = makeState({ selectedIdx: 1 });
    const r = call(DOWN, state, { records });
    expect(state.selectedIdx).toBe(1);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("enter with selected record enters detail mode top-aligned", () => {
    const selected = makeRecord();
    const state = makeState({ selectedIdx: 0, scrollOffset: 7 });
    const r = call(ENTER, state, { selected });
    expect(state.detailMode).toBe(true);
    expect(state.scrollOffset).toBe(0);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("return key behaves identically to enter", () => {
    const state = makeState();
    const r = call(RETURN, state, { selected: makeRecord() });
    expect(state.detailMode).toBe(true);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("enter without selection is a no-op (none)", () => {
    const state = makeState();
    const r = call(ENTER, state, { records: [], selected: null });
    expect(state.detailMode).toBe(false);
    expect(r).toEqual({ changed: false, exit: false });
  });

  it("backspace deletes last filter char; without filter is none", () => {
    const state = makeState({ filterText: "abc" });
    const r = call(BACKSPACE, state);
    expect(state.filterText).toBe("ab");
    expect(state.selectedIdx).toBe(0);
    expect(r).toEqual({ changed: true, exit: false });

    const empty = makeState();
    const r2 = call(BACKSPACE, empty);
    expect(r2).toEqual({ changed: false, exit: false });
  });

  it("printable ascii char appends to filter", () => {
    const state = makeState({ filterText: "ru" });
    const r = call("n", state);
    expect(state.filterText).toBe("run");
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("unhandled multi-char sequence (pageUp) in list stage is none, not filter input", () => {
    const state = makeState();
    const r = call(PAGE_UP, state);
    expect(state.filterText).toBe("");
    expect(r).toEqual({ changed: false, exit: false });
  });
});

// ============================================================
// 阶段 2（detail 焦点，detailMode=true）
// ============================================================
describe("processKey — 阶段 2（detail）", () => {
  const detailCtx: DetailKeyContext = { viewportHeight: 5, contentLines: 10 };

  it("escape returns to list and resets scroll to top", () => {
    const state = makeState({ detailMode: true, scrollOffset: 4 });
    const r = call(ESC, state);
    expect(state.detailMode).toBe(false);
    expect(state.scrollOffset).toBe(0);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("up/down scroll by single step, clamped to [0, max]", () => {
    const state = makeState({ detailMode: true, scrollOffset: 3 });
    expect(call(UP, state, { detailCtx })).toEqual({ changed: true, exit: false });
    expect(state.scrollOffset).toBe(2);

    const bottom = makeState({ detailMode: true, scrollOffset: 5 });
    call(DOWN, bottom, { detailCtx });
    expect(bottom.scrollOffset).toBe(5); // max = contentLines - viewportHeight = 5

    const mid = makeState({ detailMode: true, scrollOffset: 2 });
    call(DOWN, mid, { detailCtx });
    expect(mid.scrollOffset).toBe(3);
  });

  it("pageUp/pageDown scroll by viewport height with clamping", () => {
    const state = makeState({ detailMode: true, scrollOffset: 4 });
    call(PAGE_UP, state, { detailCtx });
    expect(state.scrollOffset).toBe(0); // max(0, 4-5)

    const state2 = makeState({ detailMode: true, scrollOffset: 2 });
    call(PAGE_DOWN, state2, { detailCtx });
    expect(state2.scrollOffset).toBe(5); // min(max=5, 2+5)
  });

  it("home/end jump to top/bottom", () => {
    const state = makeState({ detailMode: true, scrollOffset: 3 });
    call(HOME, state, { detailCtx });
    expect(state.scrollOffset).toBe(0);

    const state2 = makeState({ detailMode: true, scrollOffset: 1 });
    call(END, state2, { detailCtx });
    expect(state2.scrollOffset).toBe(5);
  });

  it("pageUp without detailCtx falls back to PAGE_SCROLL_DEFAULT", () => {
    const state = makeState({ detailMode: true, scrollOffset: 3 });
    call(PAGE_UP, state);
    // PAGE_SCROLL_DEFAULT 来自 tui-kit（终端兜底步长）——只断言未越界为负即可钉住回退路径
    expect(state.scrollOffset).toBe(0);
  });

  it("x stops a running record via service.cancel and notifies info", () => {
    const cancel = vi.fn(() => true);
    const notify = makeNotify();
    const selected = makeRecord({ id: "run-9", status: "running" });
    const state = makeState({ detailMode: true });
    const r = call("x", state, { selected, service: makeService(cancel), notify });
    expect(cancel).toHaveBeenCalledWith("run-9");
    expect(notify.mock.calls.some(([msg]) => msg === "Requested stop for run-9")).toBe(true);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("x on a non-running record only warns and does not change", () => {
    const cancel = vi.fn(() => true);
    const notify = makeNotify();
    const selected = makeRecord({ id: "run-9", status: "closed" });
    const state = makeState({ detailMode: true });
    const r = call("x", state, { selected, service: makeService(cancel), notify });
    expect(cancel).not.toHaveBeenCalled();
    expect(notify.mock.calls.some(([msg]) => msg.startsWith("Cannot stop: record is closed"))).toBe(true);
    expect(r).toEqual({ changed: false, exit: false });
  });

  it("x without service notifies error and does not change", () => {
    const notify = makeNotify();
    const state = makeState({ detailMode: true });
    const r = call("x", state, { selected: makeRecord({ status: "running" }), service: null, notify });
    expect(notify.mock.calls.some(([msg]) => msg === "Runtime not ready, cannot stop")).toBe(true);
    expect(r).toEqual({ changed: false, exit: false });
  });

  it("unhandled key in detail stage is none (no state change)", () => {
    const state = makeState({ detailMode: true, scrollOffset: 1 });
    const r = call("z", state, { detailCtx });
    expect(r).toEqual({ changed: false, exit: false });
    expect(state.scrollOffset).toBe(1);
    expect(state.detailMode).toBe(true);
  });
});

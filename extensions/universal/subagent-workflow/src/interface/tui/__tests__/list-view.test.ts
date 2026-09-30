/**
 * createSubagentsView factory 驱动测试（与 list-component.test.ts 的组件/键位直测互补：
 * 本文件只覆盖 factory 编排面——G-017 防叠加、directId 分流、onChange 防抖订阅、
 * animTimer 动画循环、wrappedDone 收尾顺序）。
 *
 * 驱动方式：fake ctx.ui.custom 同步调 factory 捕获 Component；service 为最小 stub
 * （collectRecords / onChange / cancel）；fake timers 驱动 250ms 动画帧与 120ms 防抖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRecord, SubagentService } from "@zhushanwen/subagent-core";

import type { ThemeLike } from "../../format/format.ts";
import { createSubagentsView } from "../list-view.ts";

const ESC = "\x1b";

const plainTheme: ThemeLike = {
  bg: (_color: string, text: string) => text,
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
};

function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "run-1",
    agent: "worker",
    task: "do the thing",
    status: "closed",
    mode: "sync",
    startedAt: 1000,
    endedAt: 2000,
    depth: 0,
    turns: 1,
    totalTokens: 10,
    model: "test/model",
    eventLog: [],
    displayItems: [],
    result: "ok",
    ...over,
  } as SubagentRecord;
}

interface ListComponentView { // oe-exempt:20260930:test:test double shape for component capture (test infra)
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  hasRunning(): boolean;
}

interface Driver { // oe-exempt:20260930:test:test fixture harness shape (test infra)
  component: ListComponentView;
  done: Promise<void>;
  notifies: Array<{ msg: string; type?: string }>;
  service: {
    collectRecords: ReturnType<typeof vi.fn>;
    onChange: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  unsubscribe: ReturnType<typeof vi.fn>;
  tui: { terminal: { columns: number; rows: number }; requestRender: ReturnType<typeof vi.fn> };
}

function openDriver(opts: { records?: SubagentRecord[]; directId?: string } = {}): Driver {
  const records = opts.records ?? [makeRecord()];
  const unsubscribe = vi.fn();
  const collectRecords = vi.fn(() => records);
  const onChange = vi.fn(() => unsubscribe);
  const cancel = vi.fn(() => true);
  const getFullRecord = vi.fn(() => undefined as SubagentRecord | undefined);
  const service = {
    queries: { collectRecords, onChange, getFullRecord, findRecord: vi.fn(() => undefined), lookupRecordAnyState: vi.fn(() => undefined) },
    cancel,
  } as unknown as SubagentService;
  const tui = { terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() };
  const notifies: Array<{ msg: string; type?: string }> = [];
  let component!: ListComponentView;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const ctx = {
    mode: "tui",
    ui: {
      notify: (msg: string, type?: string) => notifies.push({ msg, type }),
      custom: (
        factory: (t: unknown, th: unknown, kb: unknown, d: (v: void) => void) => ListComponentView,
      ): Promise<void> => {
        component = factory(tui, plainTheme, {}, () => resolveDone());
        return done;
      },
    },
  } as unknown as ExtensionContext;
  void createSubagentsView(service, plainTheme, ctx, opts.directId);
  return { component, done, notifies, service: { collectRecords, onChange, cancel }, unsubscribe, tui };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSubagentsView factory", () => {
  it("打开即返回可用组件：render 出行、无 directId 时零 notify", () => {
    const d = openDriver();
    expect(d.component.render(100).length).toBeGreaterThan(0);
    expect(d.notifies).toEqual([]);
    expect(d.service.onChange).toHaveBeenCalledTimes(1);
  });

  it("directId 未命中 → warning notify，仍打开列表", () => {
    const d = openDriver({ directId: "ghost" });
    expect(d.notifies).toEqual([{ msg: 'No record found for id "ghost", showing all', type: "warning" }]);
    expect(d.component.render(100).length).toBeGreaterThan(0);
  });

  it("directId 命中 → 直接进详情模式（esc 先退详情而非关闭 overlay）", async () => {
    const d = openDriver({ directId: "run-1" });
    d.component.handleInput(ESC); // detailMode=true → 退出详情，overlay 保持
    const resolved = await Promise.race([d.done.then(() => true), Promise.resolve(false)]);
    expect(resolved).toBe(false);
    expect(d.unsubscribe).not.toHaveBeenCalled();
    // 再按 esc（list 模式无 filter）→ 关闭
    d.component.handleInput(ESC);
    await d.done;
    expect(d.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("G-017 防叠加：第二个 overlay 打开时关闭前一个（前一 done 落定 + 解订）", async () => {
    const d1 = openDriver();
    const d2 = openDriver();
    await d1.done; // 前一个被 activeView.close() 关闭
    expect(d1.unsubscribe).toHaveBeenCalledTimes(1);
    // d2 仍存活：esc 关闭
    d2.component.handleInput(ESC);
    await d2.done;
    expect(d2.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("onChange 防抖：120ms 窗口内多次触发只重绘一次；disposed 后触发早退", async () => {
    const d = openDriver();
    const fire = d.service.onChange.mock.calls[0][0] as () => void;
    fire();
    fire();
    fire();
    vi.advanceTimersByTime(120);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
    // 关闭后触发 → disposed 早退，不再重绘
    d.component.handleInput(ESC);
    await d.done;
    const calls = d.tui.requestRender.mock.calls.length;
    fire();
    vi.advanceTimersByTime(120);
    expect(d.tui.requestRender.mock.calls.length).toBe(calls);
  });

  it("animTimer：有 running record 时 250ms 帧刷新；全终态后停止浪费刷新", () => {
    const d = openDriver({ records: [makeRecord({ status: "running" })] });
    expect(d.component.hasRunning()).toBe(true);
    vi.advanceTimersByTime(250);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
    // 记录集变全终态（collectRecords 每次重查）→ hasRunning false → 不再 invalidate
    (d.service.collectRecords as ReturnType<typeof vi.fn>).mockReturnValue([makeRecord({ status: "closed" })]);
    vi.advanceTimersByTime(250);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("wrappedDone 幂等：esc 关闭后重复关闭不再解订/不再 done", async () => {
    const d = openDriver();
    d.component.handleInput(ESC);
    await d.done;
    // 组件 closeFn 幂等（state.disposed 早退），二次 esc 无副作用
    d.component.handleInput(ESC);
    expect(d.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("cancel 接线：详情模式对 running record 按 x → service.cancel + info notify", () => {
    const d = openDriver({ records: [makeRecord({ id: "run-x", status: "running" })], directId: "run-x" });
    d.component.handleInput("x");
    expect(d.service.cancel).toHaveBeenCalledWith("run-x");
    expect(d.notifies).toEqual([{ msg: "Requested stop for run-x", type: "info" }]);
  });
});

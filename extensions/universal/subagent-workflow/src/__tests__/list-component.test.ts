// src/__tests__/list-component.test.ts
//
// SubagentsListComponent 单元测试（循环依赖消除后的新结构）。
//
// subagents overlay 域两面合一（同 overlay、互补无断言重叠）：
//   1. SubagentsListComponent 组件分发面——render 三分支调度 / hasRunning / 左列
//      视口窗口 / 右列预览兜底链 / handleInput exit|changed|none 分支 / render 缓存 /
//      detailMode 切换 / 帧缓存，按键处理用 stub keyHandler 注入；
//   2. processKey（list-view）键位直测面——阶段 1（list）/ 阶段 2（detail）全键位
//      纯函数直测（见文末 describe）。
//
// 被测组件 list-component.ts 不再 import list-view——按键处理经第 7 个构造函数参数
// keyHandler 注入（list-view factory 的 processKey），状态经第 4 参数 ViewState 注入。
//
// Mock 策略：theme 透传为纯文本（断言业务文本而非 ANSI 码），service 只 stub collectRecords，
// keyHandler 由各用例注入返回 KeyResult。spinner 帧 Date.now() 驱动 → fake timers 锁定。

import { afterEach,beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeLike } from "../interface/format.ts";
import { SubagentsListComponent } from "../interface/list-component.ts";
import { processKey } from "../interface/list-view.ts";
import type { DetailKeyContext, KeyHandler, KeyResult, NotifyFn, TuiLike, ViewState } from "../interface/list-shared.ts";
import type { SubagentService } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";

// ── KeyResult 常量（语义清晰，避到处写字面量对象） ──

const KEY_NONE: KeyResult = { changed: false, exit: false };
const KEY_CHANGED: KeyResult = { changed: true, exit: false };
const KEY_EXIT: KeyResult = { changed: false, exit: true };

// ── 键序列（pi-tui 实装，processKey 直测用；node_modules @earendil-works/pi-tui/dist/
//    keys.js LEGACY_KEY_SEQUENCES + KEY_CODES，与运行时 matchesKey 判定同源） ──

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

// ── stub 工厂 ──

/** 透传 theme（list-component 经 format.ts 调用 fg/bold，ThemeLike 要求 4 方法齐全）。 */
function makeTheme(): ThemeLike {
  return {
    fg: (_tag: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
  } as ThemeLike;
}

/** service stub：list-component 只调 collectRecords(limit) 单参数 + getFullRecord（[perf]
 *  选中项详情懒加载，mock 回 undefined → fullRecordOf 回退 light record，与旧行为一致）。
 *  部分对象直接断言为 SubagentService（duck-type）。
 *  [D4 聚合跟随] 读面经 service.queries（成员与平铺键同引用，spy 断言不受影响）。 */
function makeService(records: SubagentRecord[] = []): SubagentService {
  const collectRecords = vi.fn(() => records);
  const getFullRecord = vi.fn(() => undefined as SubagentRecord | undefined);
  return {
    collectRecords,
    getFullRecord,
    queries: {
      collectRecords,
      getFullRecord,
      findRecord: vi.fn(() => undefined),
      lookupRecordAnyState: vi.fn(() => undefined),
      onChange: vi.fn(() => () => {}),
    },
  } as unknown as SubagentService;
}

/** processKey 直测的最小 service stub：两阶段键位只触达 cancel。 */
function makeCancelService(cancel: (id: string) => boolean = () => true): SubagentService {
  return { cancel } as unknown as SubagentService;
}

/** record fixture（字段见 types.ts SubagentRecord）。 */
function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "run-1",
    agent: "worker",
    task: "do the thing",
    status: "closed",
    mode: "sync",
    startedAt: 1000,
    endedAt: 2000,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    turns: 1,
    totalTokens: 10,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: "ok",
    error: undefined,
    sessionFile: undefined,
    ...over,
  };
}

/** 构造 N 条 records（agent/task 含索引便于断言可见性）。 */
function makeRecords(n: number): SubagentRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord({ id: `run-${i}`, agent: `agent-${i}`, task: `task-${i}` }),
  );
}

type MakeOpts = {
  records?: SubagentRecord[];
  rows?: number;
  selectedIdx?: number;
  detailMode?: boolean;
  keyHandler?: KeyHandler;
}

/** 构造组件 + 暴露 service/tui/state 供断言。 */
function makeComponent(opts: MakeOpts = {}) {
  const records = opts.records ?? [];
  const service = makeService(records);
  const theme = makeTheme();
  const tui = {
    requestRender: vi.fn(),
    terminal: { rows: opts.rows ?? 24 },
  };
  const state: ViewState = {
    selectedIdx: opts.selectedIdx ?? 0,
    scrollOffset: 0,
    filterText: "",
    detailMode: opts.detailMode ?? false,
    disposed: false,
    syncCancelHint: false,
  };
  const keyHandler: KeyHandler = opts.keyHandler ?? (() => KEY_NONE);
  const comp = new SubagentsListComponent(
    service,
    theme,
    tui as TuiLike,
    state,
    () => {},
    () => {},
    keyHandler,
  );
  return { comp, service, theme, tui, state };
}

// ============================================================
// SubagentsListComponent
// ============================================================
describe("SubagentsListComponent", () => {
  beforeEach(() => {
    // spinner 帧由 Math.floor(Date.now()/250) 选取，锁定时间避免 flaky。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── render 三分支调度 ──────────────────────────────────
  describe("render 分支调度", () => {
    it("rows < MIN_TERM_ROWS(8) → too small 提示", () => {
      const { comp } = makeComponent({ records: [], rows: 5 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("too small");
      expect(joined).toContain("need >=");
    });

    it("空 records → emptyBox（含 (no subagent records) 文案）", () => {
      const { comp } = makeComponent({ records: [], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("(no subagent records)");
      // 紧凑小框不渲染分屏分区线
      expect(joined).not.toContain("Records");
    });

    it("有 records → splitBox（含 record 的 task + agent 文本）", () => {
      const rec = makeRecord({ agent: "researcher", task: "investigate bug" });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("researcher"); // 左列 agent
      expect(joined).toContain("investigate bug"); // 右列 task 首行
      expect(joined).toContain("Records"); // 分区线标题
      expect(joined).toContain("Detail");
    });
  });

  // ── hasRunning ────────────────────────────────────────
  describe("hasRunning", () => {
    it("records 全是 closed（终态）→ false", () => {
      const { comp } = makeComponent({
        // v4 B-1：done/failed 等旧终态已收敛为 closed（fixture 同步迁移）
        records: [makeRecord({ status: "closed" }), makeRecord({ status: "closed" })],
      });
      expect(comp.hasRunning()).toBe(false);
    });

    it("records 含一个 running → true", () => {
      const { comp } = makeComponent({
        records: [
          makeRecord({ id: "a", status: "closed" }),
          makeRecord({ id: "b", status: "running" }),
        ],
      });
      expect(comp.hasRunning()).toBe(true);
    });
  });

  // ── 左列视口窗口 ──────────────────────────────────────
  describe("左列视口窗口", () => {
    it("records 数 > bodyH → render 行数 ≤ rows（不溢出终端）", () => {
      // rows=24 → 内框高 innerRows = 24 - PAD_ROWS(2) = 22；bodyH = 22 - SPLIT_FIXED_LINES(6) = 16。
      // 30 条 records 远超 bodyH，选中行在中间。断言输出总行数 == rows（overlay 填满全屏），
      // 且左列只渲染 bodyH 条（不溢出导致底框被推出终端）。
      const records = makeRecords(30);
      const { comp } = makeComponent({ records, rows: 24, selectedIdx: 15 });
      const lines = comp.render(80);
      expect(lines.length).toBe(24); // 填满全屏，不溢出
      // 中间 record 的 agent 不在视口窗口外应仍可见（窗口居中显示 selectedIdx 附近）。
      const joined = lines.join("\n");
      expect(joined).toContain("agent-15"); // 选中行在视口内
    });

    it("selectedIdx 在尾部 → 视口贴底（最后一条可见）", () => {
      const records = makeRecords(30);
      const { comp } = makeComponent({ records, rows: 24, selectedIdx: 29 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("agent-29"); // 尾部 record 仍可见（视口贴底）
    });
  });

  // ── 右列预览兜底链 ────────────────────────────────────
  describe("右列预览兜底链 (renderRightPreview)", () => {
    it("record 有 displayItems → 输出含 displayItems 内容", () => {
      const rec = makeRecord({
        displayItems: [{ type: "text", text: "partial analysis output" }],
      });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("partial analysis output");
    });

    it("record 无 displayItems 但有 eventLog → 回退 eventLog（输出含 event 标签）", () => {
      const rec = makeRecord({
        displayItems: [],
        eventLog: [{ type: "tool_start", label: "Read file.ts", ts: 1500 }],
      });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      // formatEventLine 的 tool_start 输出 "tool: <label>"
      expect(joined).toContain("tool:");
      expect(joined).toContain("Read file.ts");
    });

    it("record 两者都无 → 输出 (no output) 兜底文案", () => {
      const rec = makeRecord({ displayItems: [], eventLog: [] });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("(no output)");
    });
  });

  // ── handleInput ───────────────────────────────────────
  describe("handleInput", () => {
    it("disposed → 直接返回，不调用 keyHandler", () => {
      const keyHandler = vi.fn(() => KEY_NONE);
      const { comp, state } = makeComponent({ keyHandler });
      state.disposed = true;
      comp.handleInput("x");
      expect(keyHandler).not.toHaveBeenCalled();
    });

    it("keyHandler 返回 exit → 调用 closeFn 关闭 overlay", () => {
      const keyHandler = vi.fn(() => KEY_EXIT);
      const { comp } = makeComponent({ keyHandler });
      const closeFn = vi.fn();
      comp.setCloseFn(closeFn);
      comp.handleInput("\x1b"); // Esc
      expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it("keyHandler 返回 changed → invalidate + requestRender", () => {
      const keyHandler = vi.fn(() => KEY_CHANGED);
      const { comp, tui } = makeComponent({ keyHandler });
      comp.handleInput("\x1b[B"); // Down
      expect(tui.requestRender).toHaveBeenCalledTimes(1);
    });

    it("keyHandler 返回 none → 不 invalidate / 不 close / 不 requestRender", () => {
      const keyHandler = vi.fn(() => KEY_NONE);
      const closeFn = vi.fn();
      const { comp, tui } = makeComponent({ keyHandler });
      comp.setCloseFn(closeFn);
      comp.handleInput("x");
      expect(closeFn).not.toHaveBeenCalled();
      expect(tui.requestRender).not.toHaveBeenCalled();
    });

    it("exit 优先于 changed（exit=true 时只 close，不 requestRender）", () => {
      const keyHandler = vi.fn(() => ({ changed: true, exit: true }));
      const closeFn = vi.fn();
      const { comp, tui } = makeComponent({ keyHandler });
      comp.setCloseFn(closeFn);
      comp.handleInput("\x1b");
      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(tui.requestRender).not.toHaveBeenCalled();
    });
  });

  // ── render 缓存 ───────────────────────────────────────
  describe("render 缓存", () => {
    it("相同 width 连续两次 render → 返回相同结果（缓存命中）", () => {
      const records = [makeRecord({ agent: "cached-agent" })];
      const { comp } = makeComponent({ records, rows: 24 });
      const first = comp.render(80);
      const second = comp.render(80);
      // 缓存命中：返回同一引用（buildLines 未重新执行）。
      expect(second).toBe(first);
    });

    it("invalidate 后再 render → 重建（结果内容相同但引用不同）", () => {
      const records = [makeRecord()];
      const { comp } = makeComponent({ records, rows: 24 });
      const first = comp.render(80);
      comp.invalidate();
      const second = comp.render(80);
      expect(second).not.toBe(first); // 引用不同 → 重建
      expect(second).toEqual(first); // 内容相同
    });

    it("不同 width → 不命中缓存（重新构建）", () => {
      const records = [makeRecord()];
      const { comp } = makeComponent({ records, rows: 24 });
      const w80 = comp.render(80);
      const w100 = comp.render(100);
      // 宽度不同 → 不同 key → 重建。行数应随宽度变化内容（至少引用不同）。
      expect(w100).not.toBe(w80);
    });
  });

  // ── detailMode 切换 ───────────────────────────────────
  describe("detailMode 切换", () => {
    it("detailMode=true → footer 含 Esc back + 右侧锚定提示 Pinned", () => {
      const rec = makeRecord({ agent: "pinned-agent" });
      const { comp } = makeComponent({ records: [rec], rows: 24, detailMode: true });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("Esc back to list");
      expect(joined).toContain("Pinned:");
      expect(joined).toContain("pinned-agent");
    });

    it("detailMode=false → footer 含 navigate / Enter detail（非锚定文案）", () => {
      const rec = makeRecord();
      const { comp } = makeComponent({ records: [rec], rows: 24, detailMode: false });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("Enter detail");
      expect(joined).not.toContain("Pinned:");
    });

    it("detailMode 下完整详情含 result + sessionFile（预览阶段不显示 sessionFile）", () => {
      const rec = makeRecord({
        result: "final report content",
        sessionFile: "/tmp/session-abc.jsonl",
      });
      // 预览阶段
      const previewComp = makeComponent({ records: [rec], rows: 24, detailMode: false });
      const previewJoined = previewComp.comp.render(80).join("\n");
      expect(previewJoined).toContain("Enter for full detail"); // 预览阶段提示
      // 详情阶段
      const detailComp = makeComponent({ records: [rec], rows: 24, detailMode: true });
      const detailJoined = detailComp.comp.render(80).join("\n");
      expect(detailJoined).toContain("final report content"); // Result 段
      expect(detailJoined).toContain("Result:");
      expect(detailJoined).toContain("session-abc.jsonl"); // sessionFile
    });

    // ── [U8 / §3.2.1 展示层词汇收敛] stopReason 只在详情/排障面板出现 ──
    it("detail 元数据行：idle ∧ stopReason → 追加 stopped: <reason>；running / 无字段省略", () => {
      const idleRec = makeRecord({ id: "sa-idle", status: "idle", stopReason: "interrupted" });
      const { comp } = makeComponent({ records: [idleRec], rows: 24, detailMode: true });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("stopped: interrupted");

      // running（在飞，无停因）与无 stopReason 的 idle（存量数据）不出现停因段
      const runningRec = makeRecord({ id: "sa-run", status: "running" });
      const runComp = makeComponent({ records: [runningRec], rows: 24, detailMode: true });
      expect(runComp.comp.render(80).join("\n")).not.toContain("stopped:");
      const legacyRec = makeRecord({ id: "sa-legacy", status: "idle" });
      const legacyComp = makeComponent({ records: [legacyRec], rows: 24, detailMode: true });
      expect(legacyComp.comp.render(80).join("\n")).not.toContain("stopped:");
    });
  });

  // ── 帧缓存 collectRecordsFrame（TC3/IF3/DM5）──────────
  describe("帧缓存 collectRecordsFrame", () => {
    it("同一帧（TTL 50ms 内）hasRunning + render 只触发 1 次 service.collectRecords", () => {
      // fake timers 已锁 Date.now()（beforeEach）→ 帧内多次消费共享同一份 records
      const rec = makeRecord({ id: "a", status: "running" });
      const { comp, service } = makeComponent({ records: [rec], rows: 24 });
      expect(comp.hasRunning()).toBe(true); // 第 1 次扫描
      comp.render(80); // buildLines 消费（帧命中，不重扫）
      comp.handleInput("x"); // handleInput 消费（帧命中）
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1);
    });

    it("advance 100ms 后 TTL 过期 → 重扫（collectRecords 递增）", () => {
      const rec = makeRecord({ id: "a", status: "running" });
      const { comp, service } = makeComponent({ records: [rec], rows: 24 });
      comp.render(80);
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100); // > FRAME_TTL_MS(50)
      // 镜像 animTimer 真实序列：hasRunning（帧消费点）→ invalidate → render。
      // hasRunning 直接走帧缓存（不经 render 行缓存），TTL 过期 → 重扫
      expect(comp.hasRunning()).toBe(true);
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(2);
      comp.invalidate();
      comp.render(80); // 重建行，但帧刚刷新（100ms 后的同一时刻）→ 不再重扫
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(2);
    });

    it("invalidate 不清帧缓存：invalidate 后同帧 render 仍命中（不重扫）", () => {
      // timer 序列 hasRunning → invalidate → requestRender 的共享前提：
      // invalidate 只清渲染行缓存（cachedKey/cachedLines），帧缓存由 TTL 独立保证
      const rec = makeRecord({ id: "a", status: "running" });
      const { comp, service } = makeComponent({ records: [rec], rows: 24 });
      const first = comp.render(80);
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1);
      comp.invalidate();
      const second = comp.render(80);
      expect(second).not.toBe(first); // 渲染行缓存已清 → 重建
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1); // 帧缓存未清 → 不重扫
    });

    it("detailMode 渲染路径（buildDetailContent children）同帧共享：render 仍只 1 次扫描", () => {
      // 选中项有子 record → buildDetailContent 内 children 计算消费 collectRecordsFrame
      const parent = makeRecord({ id: "p", status: "closed" });
      const child = makeRecord({ id: "c", parentRecordId: "p" });
      const { comp, service } = makeComponent({ records: [parent, child], rows: 24, detailMode: true });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("children:");
      expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1); // buildLines + children 同帧合一
    });
  });
});

// ============================================================
// processKey（list-view）纯函数直接单测——两阶段焦点按键分发。
// 重构前该函数无直接测试（仅经上方 keyHandler 注入间接触达），
// 以下补齐阶段 1（list）/ 阶段 2（detail）全键位覆盖。
// 键序列取 pi-tui 实装（见文件头部键序列常量注释），与运行时 matchesKey 判定同源。
// ============================================================

// ── fixture 工厂（对齐上方 list-component 用例形态，makeRecord 共用） ──

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
    const r = call("x", state, { selected, service: makeCancelService(cancel), notify });
    expect(cancel).toHaveBeenCalledWith("run-9");
    expect(notify.mock.calls.some(([msg]) => msg === "Requested stop for run-9")).toBe(true);
    expect(r).toEqual({ changed: true, exit: false });
  });

  it("x on a non-running record only warns and does not change", () => {
    const cancel = vi.fn(() => true);
    const notify = makeNotify();
    const selected = makeRecord({ id: "run-9", status: "closed" });
    const state = makeState({ detailMode: true });
    const r = call("x", state, { selected, service: makeCancelService(cancel), notify });
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

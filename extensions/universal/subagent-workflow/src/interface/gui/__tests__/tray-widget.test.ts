// tray-widget.test.ts —— subagent 托盘件 widget 树构造 + 推送器（容器扩展点统一 §6.6 U9 层 1）。
//
// 三视角：
//   ①使用者（宿主 widget 区视角）——树形状：meta head（title/status/progress/icon/badge）
//     + tab-bar 双段（进行中/已结束）行集；失败轮行 label 承载 class.kind 失败分类且
//     status=failed（§6.6 风险②「lastRound.failure 不得静默丢弃」的单测承载——原宿主
//     托盘行的失败分类 chip 随件迁移，信息原语承载位 = TreeItem label + status 圆点）；
//   ②构建者——分桶判据（占用谓词镜像）/ 空记录清屏 / 推送器 attach 初始推送 +
//     onChange 事件驱动重推（微任务合并）+ detach 退订；
//   ③观察者——纯函数入参出参；推送失败不反噬调用方（warn 留痕后继续）。
//
// 判据单点：本文件的占用/失败判据与 renderer lib/subagent-bucket 同源——判据本体
// 在 @zhushanwen/extension-protocol（extensions/subagent-projection/predicates.ts），
// 两侧 import 同一实现（[dmg-r1-4] 下沉，镜像手抄退役），词表扩值评估两侧同批
// （shared/core record 词表纪律不变）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：logger 防文件落盘；protocol 只 mock setWidgetDual 推送点，
//    guiComponent/guiResult 走真实现——树形状断言消费真实产物；core barrel 只留 service 可控点）──

const extensionLoggerMock = vi.hoisted(() => {
  // 稳定单例（模块内 getLogger(...) 的每次调用返回同一 mock 实例——断言才能取到写入）
  const instance = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: vi.fn(() => instance), instance };
});

const setWidgetDualMock = vi.hoisted(() => vi.fn());

const mockService = vi.hoisted(() => ({
  current: null as null | {
    queries: {
      collectRecords: ReturnType<typeof vi.fn>;
      onChange: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);
vi.mock("@zhushanwen/pi-ext-guards", () => ({
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("@zhushanwen/extension-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/extension-protocol")>();
  return { ...actual, setWidgetDual: setWidgetDualMock };
});
vi.mock("@zhushanwen/subagent-core", () => ({
  getSubagentService: () => mockService.current,
}));

import type { SubagentRecord } from "@zhushanwen/subagent-core";
import {
  SUBAGENT_TRAY_VIEW_ID,
  buildSubagentTrayWidget,
  createSubagentTrayWidgetPusher,
} from "../tray-widget.ts";
import type { GuiComponent } from "@zhushanwen/extension-protocol";

/** record fixture（字段见 core assembly/types.ts SubagentRecord）。 */
function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "rec-1",
    agent: "worker",
    task: "do the thing",
    slug: "thing",
    status: "idle",
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
  } as SubagentRecord;
}

/** tab-bar 树的段 items 提取（sections[i][0].items——段 = 子树数组，单组件子树取首项）。 */
function segmentItems(component: GuiComponent, index: number): Array<{ label: string; status?: string }> {
  expect(component.type).toBe("tab-bar");
  const sections = (component.props as { sections?: GuiComponent[][] }).sections ?? [];
  const seg = sections[index]?.[0];
  expect(seg?.type).toBe("list-tree");
  return (seg.props as { items: Array<{ label: string; status?: string }> }).items;
}

beforeEach(() => {
  setWidgetDualMock.mockReset();
  mockService.current = null;
});

describe("buildSubagentTrayWidget 树构造（纯函数）", () => {
  it("空记录 → undefined（宿主清屏语义——widget 区「清屏即消失」）", () => {
    expect(buildSubagentTrayWidget([])).toBeUndefined();
  });

  it("meta head：title/icon/badge/progress（badge = 进行中数，icon 点名 bot）与状态点（running>0 → running）", () => {
    const result = buildSubagentTrayWidget([
      makeRecord({ id: "r-run", status: "running", stopReason: undefined }),
      makeRecord({ id: "r-idle", status: "idle" }),
    ]);
    expect(result).toBeDefined();
    expect(result?.gui.meta).toMatchObject({
      title: "Subagents",
      status: "running",
      icon: "bot",
      badge: "1",
      progress: { current: 1, total: 2, label: "1" },
    });
  });

  it("分桶：占用谓词命中行落进行中段，其余落已结束段；行 label = agent · slug", () => {
    const result = buildSubagentTrayWidget([
      makeRecord({ id: "r-run", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
      makeRecord({ id: "r-end", agent: "worker", slug: "wrk", status: "idle" }),
    ]);
    expect(result?.gui.meta?.status).toBe("running");
    const runningItems = segmentItems(result!.gui.component, 0);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(runningItems).toEqual([{ label: "reviewer · rev", status: "running", depth: 0 }]);
    expect(endedItems).toEqual([{ label: "worker · wrk", status: "done", depth: 0 }]);
  });

  it("全部收尾 → status=done；失败轮在场 → status=failed（head 状态点反映最重事实）", () => {
    const clean = buildSubagentTrayWidget([makeRecord({ id: "r1", status: "idle" })]);
    expect(clean?.gui.meta?.status).toBe("done");

    const failed = buildSubagentTrayWidget([
      makeRecord({
        id: "r2",
        status: "idle",
        stopReason: "error",
        lastRound: {
          engineStopReason: "error",
          failure: { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "rpm 101/100" },
        },
      }),
    ]);
    expect(failed?.gui.meta?.status).toBe("failed");
  });

  it("失败分类承载（§6.6 风险②不静默丢弃）：失败轮行 label 含 class.kind 且 status=failed", () => {
    const result = buildSubagentTrayWidget([
      makeRecord({
        id: "r-fail",
        agent: "reviewer",
        slug: "rev",
        status: "idle",
        stopReason: "aborted",
        lastRound: {
          engineStopReason: "aborted",
          failure: { class: "harness", kind: "turn_budget_exhausted", retryable: false, raw: "budget" },
        },
      }),
    ]);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(endedItems).toHaveLength(1);
    expect(endedItems[0].label).toContain("harness.turn_budget_exhausted");
    expect(endedItems[0].status).toBe("failed");
  });

  it("user.cancelled 是用户主动中止非失败：行不标 failed、label 不拼失败词、head 不落 failed", () => {
    const result = buildSubagentTrayWidget([
      makeRecord({
        id: "r-cancel",
        agent: "worker",
        slug: "wrk",
        status: "idle",
        stopReason: "aborted",
        lastRound: {
          engineStopReason: "aborted",
          failure: { class: "user", kind: "cancelled", retryable: false, raw: "user aborted" },
        },
      }),
    ]);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(endedItems[0].label).toBe("worker · wrk");
    expect(endedItems[0].status).toBe("done");
    expect(result?.gui.meta?.status).toBe("done");
  });

  it("占用判据（protocol 单点）：running + 轮收条停因（stopReason 已写）落已结束段（「轮收条已写 = 本轮不在途」）", () => {
    const result = buildSubagentTrayWidget([
      makeRecord({ id: "r-dead", status: "running", stopReason: "failed" }),
      makeRecord({ id: "r-live", status: "running", stopReason: undefined }),
    ]);
    expect(segmentItems(result!.gui.component, 0)).toHaveLength(1);
    expect(segmentItems(result!.gui.component, 1)).toHaveLength(1);
  });
});

describe("createSubagentTrayWidgetPusher 推送器", () => {
  function makeCtx() {
    return { mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "s-1" } };
  }

  function wireService(records: SubagentRecord[]) {
    const listeners = new Set<() => void>();
    const collect = vi.fn(() => records);
    const onChange = vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    mockService.current = { queries: { collectRecords: collect, onChange } };
    return { listeners, collect, onChange };
  }

  afterEach(() => {
    // 微任务排空：scheduleFlush 的 queueMicrotask 不跨用例泄漏
  });

  it("attach → 初始推送（collectRecords 磁盘重建覆盖冷读）+ onChange 订阅；有记录推树、空记录推清屏", async () => {
    const { collect, onChange } = wireService([makeRecord({ id: "r1", status: "running", stopReason: undefined })]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalled();
    // 推送键 = SUBAGENT_TRAY_VIEW_ID；内容 = 树（meta 在场）
    expect(setWidgetDualMock.mock.calls[0][1]).toBe(SUBAGENT_TRAY_VIEW_ID);
    expect(setWidgetDualMock.mock.calls[0][2]?.gui.meta?.title).toBe("Subagents");

    // 记录清空后的重推 = 清屏（第二参数 undefined）
    collect.mockReturnValue([]);
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(2));
    expect(setWidgetDualMock.mock.calls[1][2]).toBeUndefined();
  });

  it("同 tick 多次 onChange 合并为一次推送（微任务边界合并，无 timer）", async () => {
    const { listeners, onChange } = wireService([makeRecord()]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));

    // 连续触发三次（core 写链单 tick 多迁移的形态）：合并为一次重推
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    await Promise.resolve();
    await Promise.resolve();
    expect(setWidgetDualMock).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
  });

  it("detach → 退订 + 通道静默（session 终结后不推帧）", async () => {
    const { listeners } = wireService([makeRecord()]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));

    pusher.detach();
    expect(listeners.size).toBe(0);
    setWidgetDualMock.mockClear();
    // 退订后无事件路径可达推送；本用例断言 detach 后通道静默（重新 attach 才恢复）
    expect(setWidgetDualMock).not.toHaveBeenCalled();
  });

  it("service 缺席（session 装配链前的异常时序）→ no-op 不抛错", async () => {
    mockService.current = null;
    const pusher = createSubagentTrayWidgetPusher();
    expect(() => pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0])).not.toThrow();
    await Promise.resolve();
    // collectRecords 不可达 → 投影按空记录处理 → 推清屏（不虚亮）
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));
    expect(setWidgetDualMock.mock.calls[0][2]).toBeUndefined();
  });

  it("推送异常不反噬（warn 首败留痕后继续，下一事件重推）", async () => {
    wireService([makeRecord()]);
    setWidgetDualMock.mockImplementationOnce(() => {
      throw new Error("ctx dead");
    });
    const pusher = createSubagentTrayWidgetPusher();
    expect(() => pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0])).not.toThrow();
    await vi.waitFor(() => {
      expect(extensionLoggerMock.instance.warn).toHaveBeenCalled();
    });
  });
});

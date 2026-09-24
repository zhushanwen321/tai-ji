import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// index.ts 只做装配：mock 掉子模块注册函数，只捕获 pi.on 的 hook、sessions 缓存与
// widget 刷新（session_tree handler 纯重建断言的观察面）
vi.mock("../tool.js", () => ({
  registerPlanTool: vi.fn(
    (_pi: unknown, sessions: Map<string, unknown>, _controllers: unknown) => {
      captured.sessions = sessions as Map<string, import("../state.js").PlanState>;
    },
  ),
  PLAN_MODE_TOOLS: ["read", "bash", "grep", "find", "ls", "plan"],
}));
vi.mock("../command.js", () => ({ registerPlanCommand: vi.fn() }));
vi.mock("../compact.js", () => ({ registerPlanEventHandlers: vi.fn() }));
vi.mock("../widget.js", () => ({ updatePlanWidget: vi.fn() }));

import planExtension from "../index.js";
import { updatePlanWidget } from "../widget.js";
import {
  DEFAULT_PLAN_STATE,
  getPlanState,
  type PlanSessionMap,
  type PlanState,
  reconstructPlanState,
} from "../state.js";

/**
 * U6b：reconstructPlanState 接活跃路径裁剪 + session_tree handler 即时重建。
 * 被撤子树的 plan-state entry 不进重建态；handler 为纯重建体（无 steer / 写盘副作用）
 * 且缓存同步更新（getPlanState 缓存命中 = 最新重建态）。
 */

const captured: { sessions?: PlanSessionMap } = {};

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function planStateEntry(id: string, parentId: string | null, data: Record<string, unknown>) {
  return { type: "custom", id, parentId, timestamp: "2026-09-24T00:00:00.000Z", customType: "plan-state", data };
}

/** 撤回后真实形态：label entry 落文件尾（parentId = 回退后叶子） */
function labelEntry(id: string, parentId: string | null) {
  return { type: "label", id, parentId, timestamp: "2026-09-24T00:00:01.000Z", targetId: "u-x", label: "taiji:revoked" };
}

function makeCtx(entries: unknown[], leafId: string | null): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => entries,
      getLeafId: () => leafId,
    },
  } as unknown as ExtensionContext;
}

describe("reconstructPlanState 活跃路径裁剪（U6b）", () => {
  it("有分支 fixture：被撤子树的 plan-state entry 不进重建态——逆序取活跃路径内最后一条", () => {
    // 树：e1(base) → e2(active-branch)；e1 → e3(revoked-branch，物理后写=被撤子树)；
    // 撤回落 label 锚 L（parentId = 回退后叶子 e2），leafId = L → 活跃路径 {L, e2, e1}
    const entries = [
      planStateEntry("e1", null, { isActive: true, planFilePath: "/p/base.md", requirement: "base", templateName: "" }),
      planStateEntry("e2", "e1", { isActive: true, planFilePath: "/p/active.md", requirement: "active-branch", templateName: "" }),
      planStateEntry("e3", "e1", { isActive: true, planFilePath: "/p/revoked.md", requirement: "revoked-branch", templateName: "" }),
      labelEntry("L", "e2"),
    ];

    const state = reconstructPlanState(makeCtx(entries, "L"));

    // 逆序扫描在裁剪后 entries 内取第一条：e2（active-branch），非物理最后的 e3
    expect(state.requirement).toBe("active-branch");
    expect(state.planFilePath).toBe("/p/active.md");
  });

  it("活跃路径内无 plan-state（plan 进入随子树整个被撤）→ 重建 DEFAULT，不回退到旧分支 entry", () => {
    // 无裁剪的旧实现逆序全量扫描会命中 e2（被撤子树）——这正是撤回要封堵的注入面
    const entries = [
      { type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } },
      planStateEntry("e2", "e1", { isActive: true, planFilePath: "/p/revoked.md", requirement: "revoked", templateName: "" }),
      labelEntry("L", "e1"),
    ];

    const state = reconstructPlanState(makeCtx(entries, "L"));

    expect(state.isActive).toBe(false);
    expect(state.requirement).toBe("");
    expect(state).toEqual({ ...DEFAULT_PLAN_STATE });
  });

  it("无分支回归：leafId = 文件尾 → 逆序全量取最后一条（现行为不变）", () => {
    const entries = [
      planStateEntry("e1", null, { isActive: true, requirement: "first", templateName: "" }),
      planStateEntry("e2", "e1", { isActive: false, requirement: "second-final", templateName: "" }),
    ];

    const state = reconstructPlanState(makeCtx(entries, "e2"));

    expect(state.requirement).toBe("second-final");
    expect(state.isActive).toBe(false);
  });

  it("leafId 防御：null / 指向不存在 entry → 回退文件尾全量逆序（不静默清空重建态）", () => {
    const entries = [
      planStateEntry("e1", null, { isActive: true, requirement: "first", templateName: "" }),
      planStateEntry("e2", "e1", { isActive: true, requirement: "tail-snapshot", templateName: "" }),
    ];

    for (const leafId of [null, "missing-id"]) {
      const state = reconstructPlanState(makeCtx(entries, leafId));
      expect(state.requirement).toBe("tail-snapshot");
    }
  });
});

describe("环状 parentId 防御（损坏文件 / 非 pi 产出写入）", () => {
  it("环状 parentId（a↔b，leafId 指向环内）→ 回溯终止不挂死，重建完成且不抛错", () => {
    // 环：a.parentId=b、b.parentId=a；leafId=a → 回溯 a→b→(二次命中 a) 守卫终止
    const entries = [
      planStateEntry("a", "b", { isActive: true, planFilePath: "/p/cycle-a.md", requirement: "cycle-a", templateName: "" }),
      planStateEntry("b", "a", { isActive: true, planFilePath: "/p/cycle-b.md", requirement: "cycle-b", templateName: "" }),
    ];

    const state = reconstructPlanState(makeCtx(entries, "a"));

    // 终止形态（实现语义）：activeIds = {a, b}，逆序扫描命中回溯链上最后一条 plan-state b
    expect(state.requirement).toBe("cycle-b");
    expect(state.planFilePath).toBe("/p/cycle-b.md");
  });
});

describe("session_tree handler 即时重建（U6b：纯重建体 + 缓存同步）", () => {
  type PiMock = ExtensionAPI & {
    sendMessage: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    setActiveTools: ReturnType<typeof vi.fn>;
  };

  function setup(): { handlers: Map<string, Handler>; pi: PiMock } {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, handler);
      }),
      sendMessage: vi.fn(),
      setActiveTools: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as PiMock;
    planExtension(pi);
    return { handlers, pi };
  }

  const branchedEntries = [
    planStateEntry("e1", null, { isActive: true, planFilePath: "/p/base.md", requirement: "base", templateName: "" }),
    planStateEntry("e2", "e1", { isActive: true, planFilePath: "/p/active.md", requirement: "active-branch", templateName: "" }),
    planStateEntry("e3", "e1", { isActive: true, planFilePath: "/p/revoked.md", requirement: "revoked-branch", templateName: "" }),
    labelEntry("L", "e2"),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    captured.sessions = undefined;
  });

  it("纯重建：无 sendMessage / appendEntry / setActiveTools 副作用，只重建内存态 + widget 刷新", async () => {
    const { handlers, pi } = setup();
    // 预填 stale 缓存：模拟撤回前已缓存的旧分支态（getPlanState 缓存命中短路的 stale 窗口）
    captured.sessions!.set("test-session", {
      ...DEFAULT_PLAN_STATE,
      isActive: true,
      requirement: "stale-revoked",
    });

    await handlers.get("session_tree")!({ type: "session_tree" }, makeCtx(branchedEntries, "L"));

    // 纯重建体：绝不复刻 session_start 块的 E3 steer / persist / 工具限制副作用
    // （本事件由撤回编排触发——steer 会让撤回编排自己注入消息，persist 会污染新分支）
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    // widget 刷新（显示面与重建态一致）
    expect(updatePlanWidget).toHaveBeenCalledTimes(1);
  });

  it("缓存同步：sessions 缓存更新为重建态——getPlanState 缓存命中返回活跃路径态而非 stale", async () => {
    const { handlers } = setup();
    captured.sessions!.set("test-session", {
      ...DEFAULT_PLAN_STATE,
      isActive: true,
      requirement: "stale-revoked",
    });

    await handlers.get("session_tree")!({ type: "session_tree" }, makeCtx(branchedEntries, "L"));

    // 「缓存命中 = 最新重建态」：stale 窗口消除（压缩摘要注入面读 getPlanState 不再拿到被撤 requirement）
    const cached = captured.sessions!.get("test-session");
    expect(cached?.requirement).toBe("active-branch");
    expect(cached?.requirement).not.toBe("stale-revoked");

    // 缓存命中路径直接返回重建态对象（不再触发 reconstruct）
    const ctx = makeCtx(branchedEntries, "L");
    const hit = getPlanState(captured.sessions!, "test-session", ctx);
    expect(hit).toBe(cached);
    expect(hit.requirement).toBe("active-branch");
  });
});

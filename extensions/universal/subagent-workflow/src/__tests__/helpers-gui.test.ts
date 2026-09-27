/**
 * notifyDone 的 GUI 协议测试（S#13）。
 *
 * notifyDone 在 run 到达 done 终态时发送完成通知，RPC 模式下附加 __gui__ list-tree。
 * 本测试覆盖：
 *   - RPC 模式下 details.__gui__ 正确构造（list-tree + status/icon 映射）
 *   - reason 非空时 statusStr 拼接后映射正确（如 done (failed) → failed/cross）
 *   - reason 为空时的映射
 *   - 非 RPC 模式不附加 __gui__
 *   - label 格式含 slug（I#3 对齐）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuiRenderResult } from "@zhushanwen/extension-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_NOTIFIED_RUN_IDS,
  notifyDone,
  trackNotifiedRunId,
} from "../interface/helpers.ts";

/** notifyDone details 内联镜像（helpers.ts WorkflowNotifyDetails 已去 export 为模块私有）。 */
type WorkflowNotifyDetails = {
  runId: string;
  name: string;
  status: string;
  reason: string | undefined;
  traceLength: number;
  /** [u9] 账本幂等键（wf-done:<runId>）——本文件无 ledger 绑定，走降级直发，字段原样携带。 */
  notifyId: string;
  __gui__?: GuiRenderResult;
};

/** 最小 WorkflowRun mock（duck typing，notifyDone 只访问这些字段；calls 与真实
 *  RunState 构造期恒有一致——D7 失败终局的 errorCode 提取消费面）。 */
type RunMock = {
  spec: { scriptName: string; slug?: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    calls: Map<number, unknown>;
    trace: { toArray: () => Array<{ stepIndex: number; agent: string; status: string }> };
  };
};

function makeRun(overrides: {
  scriptName?: string;
  slug?: string;
  status?: string;
  reason?: string;
  scriptResult?: unknown;
  traceNodes?: Array<{ stepIndex: number; agent: string; status: string }>;
}): RunMock {
  return {
    spec: {
      scriptName: overrides.scriptName ?? "build",
      slug: overrides.slug,
    },
    state: {
      status: overrides.status ?? "done",
      reason: overrides.reason,
      scriptResult: overrides.scriptResult,
      calls: new Map(),
      trace: {
        toArray: () => overrides.traceNodes ?? [],
      },
    },
  };
}

/** 最小 pi mock（只 mock sendMessage 捕获 details）。 */
function makePi(): { pi: ExtensionAPI; captured: { details: unknown }[] } {
  const captured: { details: unknown }[] = [];
  const pi = {
    sendMessage: vi.fn((_msg: unknown, _opts: unknown) => {
      captured.push((_msg as { details: unknown }).details as { details: unknown });
    }),
  } as unknown as ExtensionAPI;
  return { pi, captured };
}

describe("notifyDone — GUI 协议", () => {
  // notifyDone 接收 WorkflowRun（class），RunMock 结构兼容（duck typing），
  // 用单次断言收窄避免每个用例重复 as never。
  const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

  it("RPC 模式 + reason=failed → __gui__ list-tree status=failed icon=cross", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "failed", slug: "ci" });

    notifyDone(pi, "run-abc12345", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.__gui__).toBeDefined();
    const comp = details.__gui__!.component;
    expect(comp.type).toBe("list-tree");
    const items = comp.props.items as Array<{ status: string; icon: string }>;
    // statusStr = "done (failed)" → mapRunStatus 含 "failed" → failed
    expect(items[0].status).toBe("failed");
    expect(items[0].icon).toBe("cross");
  });

  it("RPC 模式 + 无 reason → __gui__ status=done icon=check", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: undefined, slug: "deploy" });

    notifyDone(pi, "run-defg1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ status: string; icon: string }>;
    expect(items[0].status).toBe("done");
    expect(items[0].icon).toBe("check");
  });

  it("RPC 模式 + reason=completed → __gui__ status=done icon=check", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: "deploy" });

    notifyDone(pi, "run-comp1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ status: string; icon: string }>;
    expect(items[0].status).toBe("done");
    expect(items[0].icon).toBe("check");
  });

  it("RPC 模式 + label 含 slug（I#3 对齐 buildWorkflowGui 格式）", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: "ci" });

    notifyDone(pi, "abcdefgh1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ label: string }>;
    // label = `${name} ${slug} ${runId.slice(0,8)}`.trim()
    expect(items[0].label).toBe("build ci abcdefgh");
  });

  it("RPC 模式 + 无 slug → label 不含多余空格（filter(Boolean) 生效）", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: undefined });

    notifyDone(pi, "abcdefgh1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ label: string }>;
    // slug 为 undefined → filter(Boolean) 过滤空段 → "build abcdefgh"（单空格）
    expect(items[0].label).toBe("build abcdefgh");
  });

  it("非 RPC 模式 → 不附加 __gui__", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });

    notifyDone(pi, "run-xxx", runAsParam(run), new Set(), { mode: "tui", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.__gui__).toBeUndefined();
  });

  it("无 ctx → 不附加 __gui__", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });

    notifyDone(pi, "run-yyy", runAsParam(run), new Set(), undefined);

    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.__gui__).toBeUndefined();
  });

  it("去重：同一 runId 第二次调用不发送消息", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });
    const notified = new Set<string>();

    notifyDone(pi, "run-dedup", runAsParam(run), notified, { mode: "rpc", hasUI: true });
    notifyDone(pi, "run-dedup", runAsParam(run), notified, { mode: "rpc", hasUI: true });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
  });

  it("details 基础字段正确（runId/name/status/reason/traceLength）", () => {
    const { pi, captured } = makePi();
    const run = makeRun({
      status: "done",
      reason: "completed",
      scriptName: "my-workflow",
      traceNodes: [
        { stepIndex: 0, agent: "coder", status: "done" },
        { stepIndex: 1, agent: "reviewer", status: "done" },
      ],
    });

    notifyDone(pi, "run-base123", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.runId).toBe("run-base123");
    expect(details.name).toBe("my-workflow");
    expect(details.status).toBe("done");
    expect(details.reason).toBe("completed");
    expect(details.traceLength).toBe(2);
  });
});

describe("trackNotifiedRunId（notifiedRunIds 有界 FIFO）", () => {
  // 与上方 describe 同款：RunMock 结构兼容 notifyDone 的 WorkflowRun 参数（duck typing）
  const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

  it("W3TC11: 有界 FIFO——超 cap 删最旧（Set 迭代序=插入序）", () => {
    const set = new Set<string>();
    trackNotifiedRunId(set, "a", 3);
    trackNotifiedRunId(set, "b", 3);
    trackNotifiedRunId(set, "c", 3);
    trackNotifiedRunId(set, "d", 3);

    // "a" 最旧被删——Set 迭代序=插入序，删迭代器首元素即删最旧
    expect(set.size).toBe(3);
    expect(Array.from(set)).toEqual(["b", "c", "d"]);
  });

  it("W3TC12: 有界后旧 id 不再去重——被挤出窗口的 runId 再 notifyDone 会重新发送", () => {
    const { pi } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });
    const set = new Set<string>();
    const ctx = { mode: "rpc", hasUI: true } as const;

    // old 首次通知 + track
    notifyDone(pi, "old", runAsParam(run), set, ctx);
    trackNotifiedRunId(set, "old", 3);
    // 3 个新 run 依次通知 + track——"old" 被挤出窗口（set 现为 n1/n2/n3）
    for (const id of ["n1", "n2", "n3"]) {
      notifyDone(pi, id, runAsParam(run), set, ctx);
      trackNotifiedRunId(set, id, 3);
    }
    expect(set.size).toBe(3);
    expect(Array.from(set)).toEqual(["n1", "n2", "n3"]);

    // 第二次对 "old" 的 notifyDone：has 为 false → 重新发送
    notifyDone(pi, "old", runAsParam(run), set, ctx);

    // 旧行为『永不重复』在挤出窗口后不成立——边界显式钉死：
    // old 首次 + n1/n2/n3 + old 二次 = 5 次
    expect(pi.sendMessage).toHaveBeenCalledTimes(5);
  });

  it("W3TC13: 幂等——重复 track 同一 id 不改变插入位置", () => {
    const set = new Set<string>();
    trackNotifiedRunId(set, "x", 3);
    trackNotifiedRunId(set, "x", 3); // 重复：Set.add 不改变迭代位置
    trackNotifiedRunId(set, "y", 3);
    trackNotifiedRunId(set, "z", 3);
    trackNotifiedRunId(set, "w", 3); // 触发超限：若第二次 track("x") 误重置位置，被删的将错为 y

    // 被删的是 "x"（首次插入位置不变仍最旧），非 "y"
    expect(set.size).toBe(3);
    expect(Array.from(set)).toEqual(["y", "z", "w"]);
  });

  it("生产默认 cap 锚定：不传 cap 时窗口上限 === MAX_NOTIFIED_RUN_IDS（循环实测 1001 次）", () => {
    expect(MAX_NOTIFIED_RUN_IDS).toBe(1000);
    const set = new Set<string>();
    for (let i = 0; i < 1001; i++) {
      trackNotifiedRunId(set, `run-${i}`);
    }
    expect(set.size).toBe(MAX_NOTIFIED_RUN_IDS);
    // 最旧的 run-0 已被挤出窗口
    expect(set.has("run-0")).toBe(false);
    expect(set.has("run-1")).toBe(true);
    expect(set.has("run-1000")).toBe(true);
  });
});

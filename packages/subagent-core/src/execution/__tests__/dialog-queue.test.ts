// src/__tests__/dialog-queue.test.ts
//
// W2 红灯测试：dialog-queue.ts — L2 跨子进程全局 dialog 串行队列。
//
// 测试对象：extensions/universal/subagent-workflow/src/execution/dialog-queue.ts（新建）
// 契约来源：.fix-plans/00-master-summary.md §一 冲突 3（L2 DialogGlobalQueue 设计）
//
// DialogGlobalQueue 设计要点：
//   - 进程单例，跨所有子进程共享，串行所有 dialog 类请求（isDialogMethod===true）
//   - enqueue(req, handler): Promise<UiResponse> — 入队，返回 Promise
//   - FIFO 串行：前一个 handler resolve 后才处理下一个
//   - SR-4：入队项带 child 引用，child close 时把该 child 的 pending dialog 全部
//     reject 为 cancelled（防 Promise 永挂 + 内存泄漏）
//   - handler 抛错兜底：catch → appendEntry "subagent:dialog-handler-failed"
//     → 回 {cancelled:true} → 继续处理下一个（不能让一个失败卡死队列）
//   - 调用方约定只对 dialog 类调 enqueue；fire-and-forget 由调用方（factory 层）
//     直接调 handler 不入队。enqueue 内仍防御性兼容 fire-and-forget（直接调 handler）
//
// 4 个 TC-E4 测试 case：
//   1. 3 个并发 dialog 请求按 FIFO 顺序串行处理
//   2. SR-4: child close 时 pending dialog reject 为 cancelled
//   3. handler 抛错后队列继续处理下一个
//   4. fire-and-forget method 不入队（直接调 handler）
//
// 红灯原因：dialog-queue.ts 尚未创建，import 失败。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import {
  DEFAULT_DIALOG_TIMEOUT_MS,
  DialogGlobalQueue,
  _getActiveDialogQueueForTest,
  notifyChildProcessExited,
  registerActiveDialogQueue,
  type UiRequest,
  type UiResponse,
} from "../dialog-queue.ts";

// ── 类型助手 ────────────────────────────────────────────────
// UiRequest 最小形状（method + id）。dialog 类：select/confirm/input/editor。
// fire-and-forget 类：notify/setStatus/...。

function dialogReq(id: string, method: "select" | "confirm" | "input" | "editor" = "select"): UiRequest {
  return { method, id, title: `q-${id}` };
}

function fireAndForgetReq(id: string): UiRequest {
  return { method: "notify", id, message: `n-${id}` };
}

// ── 测试 fixture ────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DialogGlobalQueue — FIFO 串行（TC-E4 case 1）", () => {
  it("3 个并发 dialog 请求按 FIFO 顺序串行处理（前一个 resolve 后才处理下一个）", async () => {
    const queue = new DialogGlobalQueue();
    const callOrder: string[] = [];
    // 每个请求返回独立的可控 Promise，模拟 handler 延迟
    const resolvers: Array<(v: UiResponse) => void> = [];

    const handler = vi.fn((req: UiRequest): Promise<UiResponse> => {
      callOrder.push(req.id);
      return new Promise<UiResponse>((resolve) => {
        resolvers.push(resolve);
      });
    });

    // 并发入队 3 个 dialog 请求
    const p1 = queue.enqueue(dialogReq("r1"), handler);
    const p2 = queue.enqueue(dialogReq("r2"), handler);
    const p3 = queue.enqueue(dialogReq("r3"), handler);

    // 只有第一个立即被处理
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["r1"]);

    // resolve 第一个 → 第二个开始
    resolvers[0]({ value: "a1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["r1", "r2"]);

    // resolve 第二个 → 第三个开始
    resolvers[1]({ value: "a2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(["r1", "r2", "r3"]);

    // resolve 第三个 → 全部 settle
    resolvers[2]({ value: "a3" });
    await vi.advanceTimersByTimeAsync(0);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual({ value: "a1" });
    expect(r2).toEqual({ value: "a2" });
    expect(r3).toEqual({ value: "a3" });
  });
});

describe("DialogGlobalQueue — SR-4 child close reject（TC-E4 case 2）", () => {
  it("child close 时该 child 的 pending dialog reject 为 cancelled（防 Promise 永挂）", async () => {
    const queue = new DialogGlobalQueue();
    const child = { pid: 20001 };

    const handler = vi.fn(
      (): Promise<UiResponse> => new Promise<UiResponse>(() => {}),
    );

    // 入队一个永远不 resolve 的 dialog，绑定 child
    const pending = queue.enqueue(dialogReq("r1"), handler, { child });

    // 模拟 child close —— pending 必须被 reject 为 cancelled
    queue.rejectChildDialogs(child);

    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it("child close 不影响其他 child 的 pending dialog", async () => {
    const queue = new DialogGlobalQueue();
    const childA = { pid: 30001 };
    const childB = { pid: 30002 };

    const handler = vi.fn(
      (): Promise<UiResponse> => new Promise<UiResponse>(() => {}),
    );

    const pendingA = queue.enqueue(dialogReq("a1"), handler, { child: childA });
    const pendingB = queue.enqueue(dialogReq("b1"), handler, { child: childB });

    // close childA —— 只有 pendingA 被 reject，pendingB 仍 pending
    queue.rejectChildDialogs(childA);

    await expect(pendingA).resolves.toEqual({ cancelled: true });
    // pendingB 不被 reject（仍 pending）—— 用 race + real timer 验证它没 settle。
    // fake timer 下 setTimeout 不自动跑，临时切 real timer 做 10ms 超时探测。
    vi.useRealTimers();
    const settled = await Promise.race([
      pendingB.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);
    expect(settled).toBe(false);
    vi.useFakeTimers();
  });
});

describe("DialogGlobalQueue — handler 抛错兜底（TC-E4 case 3）", () => {
  it("handler 第一次抛错 → 回 cancelled → 队列继续处理下一个（不卡死）", async () => {
    const queue = new DialogGlobalQueue();
    const callOrder: string[] = [];

    const handler = vi.fn((req: UiRequest): Promise<UiResponse> => {
      callOrder.push(req.id);
      if (req.id === "r1") {
        return Promise.reject(new Error("handler boom"));
      }
      return Promise.resolve<UiResponse>({ value: "ok-" + req.id });
    });

    const p1 = queue.enqueue(dialogReq("r1"), handler);
    const p2 = queue.enqueue(dialogReq("r2"), handler);

    await vi.advanceTimersByTimeAsync(0);

    // r1 抛错兜底回 cancelled（不向上抛）
    await expect(p1).resolves.toEqual({ cancelled: true });
    // r2 正常处理
    await expect(p2).resolves.toEqual({ value: "ok-r2" });

    expect(callOrder).toEqual(["r1", "r2"]);
  });
});

describe("DialogGlobalQueue — fire-and-forget 防御性兼容（TC-E4 case 4）", () => {
  it("fire-and-forget method（notify）防御性直接调 handler，不串行等待（调用方约定不传此类）", async () => {
    const queue = new DialogGlobalQueue();
    const callOrder: string[] = [];

    // 第一个 dialog 请求永不 resolve（占住队列）
    const blockingHandler = vi.fn(
      (): Promise<UiResponse> => new Promise<UiResponse>(() => {}),
    );
    const ffHandler = vi.fn((req: UiRequest): Promise<UiResponse> => {
      callOrder.push(req.id);
      return Promise.resolve<UiResponse>({ ack: true });
    });

    // 入队一个 blocking dialog（占住队列）
    queue.enqueue(dialogReq("d1"), blockingHandler);
    // fire-and-forget 必须立即被调用，不等 d1 resolve
    const ffResult = await queue.enqueue(fireAndForgetReq("f1"), ffHandler);

    expect(ffHandler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["f1"]);
    expect(ffResult).toEqual({ ack: true });
    // blocking dialog 的 handler 仍只调用一次，ff 没有插入队列等待
    expect(blockingHandler).toHaveBeenCalledTimes(1);
  });
});

// ── A4+C12：rejectAll + #19 单一推进点 + child close 集成语义 ──

describe("DialogGlobalQueue — rejectAll settle 全部 pending + 清状态（#10/session_shutdown）", () => {
  it("rejectAll 把 current + 队列所有 pending settle 为 cancelled，并清空 queue/current/processing", async () => {
    const queue = new DialogGlobalQueue();
    const child = { pid: 50001 };
    const blocking = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));

    // r1 占 current（永不 settle）；r2/r3 在队列等（含跨 child 的 r3）
    const p1 = queue.enqueue(dialogReq("r1"), blocking, { child });
    const p2 = queue.enqueue(dialogReq("r2"), blocking, { child });
    const p3 = queue.enqueue(dialogReq("r3"), blocking);
    expect(queue.size).toBe(2);

    queue.rejectAll();

    // 全部 settle 为 cancelled（Promise 不永挂）
    await expect(p1).resolves.toEqual({ cancelled: true });
    await expect(p2).resolves.toEqual({ cancelled: true });
    await expect(p3).resolves.toEqual({ cancelled: true });
    // 状态清空
    expect(queue.size).toBe(0);
  });

  it("rejectAll 幂等：重复调用不抛错，状态保持清空，已 settle 的 Promise 不重复 resolve", async () => {
    const queue = new DialogGlobalQueue();
    const blocking = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const p1 = queue.enqueue(dialogReq("r1"), blocking);

    queue.rejectAll();
    await expect(p1).resolves.toEqual({ cancelled: true });

    // 再次调用——幂等（settled 标志保证只 settle 一次），不抛错
    expect(() => queue.rejectAll()).not.toThrow();
    expect(queue.size).toBe(0);
    // p1 仍是 cancelled（防重复 resolve）
    await expect(p1).resolves.toEqual({ cancelled: true });
  });

  it("rejectAll 后队列仍可正常 enqueue 新请求（状态完全重置，processing 不残留）", async () => {
    const queue = new DialogGlobalQueue();
    const blocking = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    queue.enqueue(dialogReq("r1"), blocking);
    queue.rejectAll();

    // rejectAll 后 enqueue 新 dialog，能正常处理（processing 已重置为 false）
    const okHandler = vi.fn(async (): Promise<UiResponse> => ({ value: "new" }));
    const p = queue.enqueue(dialogReq("after"), okHandler);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual({ value: "new" });
    expect(okHandler).toHaveBeenCalledTimes(1);
  });
});

describe("DialogGlobalQueue — #19 单一推进点 + child close 集成语义", () => {
  it("#19 单一推进点：rejectChildDialogs 取消占住 current 的永不 settle dialog 后，队列下一个 item 被推进处理（不卡死）", async () => {
    const queue = new DialogGlobalQueue();
    const childA = { pid: 60001 };
    const blockingHandler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const r2Handler = vi.fn(async (): Promise<UiResponse> => ({ value: "r2-ok" }));

    // r1 占 current（永不 settle，模拟等用户输入卡死）；r2（另一 child）排队等待
    const p1 = queue.enqueue(dialogReq("r1"), blockingHandler, { child: childA });
    const p2 = queue.enqueue(dialogReq("r2"), r2Handler);
    expect(blockingHandler).toHaveBeenCalledTimes(1);
    expect(r2Handler).toHaveBeenCalledTimes(0); // r2 还在等 r1 settle

    // childA close → rejectChildDialogs settle r1；#19：settleItem 内唯一 processNext 推进 r2
    queue.rejectChildDialogs(childA);
    await vi.advanceTimersByTimeAsync(0);

    await expect(p1).resolves.toEqual({ cancelled: true });
    // 关键：r2 被推进（队列没卡死在永不 settle 的 r1）
    expect(r2Handler).toHaveBeenCalledTimes(1);
    await expect(p2).resolves.toEqual({ value: "r2-ok" });
  });

  it("child close 集成语义：queue 中同一 child 的多个 pending 被 rejectChildDialogs 一次全部 settle cancelled", async () => {
    // 模拟子进程退出事件 → dialogQueue.rejectChildDialogs(child) 清理路径。
    // 生产绑定点 = 宿主侧引擎镜像层（SpawnedChildrenMirror → notifyChildProcessExited，
    // 见 mirror.test.ts 的接线用例）；本用例聚焦 rejectChildDialogs 本身的批量语义。
    // 用 blocker 占 current（另一 child）使被测 child 的项全排队，聚焦验证 queue 批量 cancel。
    const queue = new DialogGlobalQueue();
    const blocker = { pid: 70000 };
    const child = { pid: 70001 };
    const blocking = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));

    // blocker 占 current（永不 settle），让 child 的项都进队列
    queue.enqueue(dialogReq("blk"), blocking, { child: blocker });
    const p1 = queue.enqueue(dialogReq("c1"), blocking, { child });
    const p2 = queue.enqueue(dialogReq("c2"), blocking, { child });
    const p3 = queue.enqueue(dialogReq("c3"), blocking, { child });
    expect(queue.size).toBe(3);

    queue.rejectChildDialogs(child);

    await expect(p1).resolves.toEqual({ cancelled: true });
    await expect(p2).resolves.toEqual({ cancelled: true });
    await expect(p3).resolves.toEqual({ cancelled: true });
    expect(queue.size).toBe(0);
  });
});

// ── LC-3/T2⑦：dialog 超时上界（有意的行为变更：「等用户无限久」→ 默认 30min 有界）──
// 设计权威源：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2 措施⑦。
// 覆盖：①传 timeout 按传值 settle（错误消息含恢复指引与已等待时长）②未传挂 30min 默认上界
// ③超时后队列继续（L2 processing 释放，不全局卡死）④handler 与队列级竞态 settle 恰一次。

describe("DialogGlobalQueue — dialog 超时上界（LC-3/T2⑦）", () => {
  /** 探测 pending 是否已 settle（fake timers 下不能直接 await 未定 Promise）。 */
  function probe(pending: Promise<UiResponse>): { settled: () => boolean } {
    const state = { settled: false };
    void pending.then(() => {
      state.settled = true;
    });
    return { settled: () => state.settled };
  }

  it("请求方传 timeout → 按传值超时 settle cancelled，日志含恢复指引与已等待时长", async () => {
    const queue = new DialogGlobalQueue();
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const p = queue.enqueue({ ...dialogReq("r1"), timeout: 1000 }, handler);

    // 999ms（未到点）：不 settle
    await vi.advanceTimersByTimeAsync(999);
    const before = probe(p);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.settled()).toBe(false);

    // 第 1000ms：到点 settle cancelled（不 reject——enqueue 公共契约 Promise 不 reject）
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ cancelled: true });

    // 完整错误消息承载在父进程日志：含已等待时长 + 「重新发起提问」恢复指引
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const msg = loggerMock.warn.mock.calls[0]![0] as string;
    expect(msg).toContain("1000ms");
    expect(msg).toContain("重新发起提问");
    // 队列状态已释放
    expect(queue.size).toBe(0);
  });

  it("未传 timeout → 挂 DEFAULT_DIALOG_TIMEOUT_MS（30min）默认上界 settle cancelled", async () => {
    const queue = new DialogGlobalQueue();
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const p = queue.enqueue(dialogReq("r1"), handler);

    // 30min - 1ms：不 settle（原行为是永不 settle，此处锁死「有上界」语义）
    await vi.advanceTimersByTimeAsync(DEFAULT_DIALOG_TIMEOUT_MS - 1);
    const before = probe(p);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ cancelled: true });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const msg = loggerMock.warn.mock.calls[0]![0] as string;
    expect(msg).toContain(`${DEFAULT_DIALOG_TIMEOUT_MS}ms`);
    expect(msg).toContain("重新发起提问");
  });

  it("timeout 非法（<=0）→ 回落默认上界（不因脏参数拆掉上界回到无界）", async () => {
    const queue = new DialogGlobalQueue();
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const p = queue.enqueue({ ...dialogReq("r1"), timeout: 0 }, handler);

    await vi.advanceTimersByTimeAsync(DEFAULT_DIALOG_TIMEOUT_MS - 1);
    const before = probe(p);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ cancelled: true });
  });

  it("超时后 L2 processing 释放，队列继续处理后续项（不全局卡死）", async () => {
    const queue = new DialogGlobalQueue();
    const blocking = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const nextHandler = vi.fn(async (): Promise<UiResponse> => ({ value: "r2-ok" }));

    // r1 永挂（host UI promise 挂死形态），带 timeout:1000；r2 排队
    const p1 = queue.enqueue({ ...dialogReq("r1"), timeout: 1000 }, blocking);
    const p2 = queue.enqueue(dialogReq("r2"), nextHandler);
    expect(nextHandler).toHaveBeenCalledTimes(0);

    // r1 超时 → settle + 推进 r2
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p1).resolves.toEqual({ cancelled: true });
    expect(nextHandler).toHaveBeenCalledTimes(1);
    await expect(p2).resolves.toEqual({ value: "r2-ok" });
  });

  it("竞态恰一次（超时先到）：超时 settle 后迟到的 handler 结果不覆盖，队列不重复推进", async () => {
    const queue = new DialogGlobalQueue();
    let resolveHandler: ((v: UiResponse) => void) | undefined;
    const handler = vi.fn(
      (): Promise<UiResponse> =>
        new Promise<UiResponse>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const nextHandler = vi.fn(async (): Promise<UiResponse> => ({ value: "next-ok" }));

    const p1 = queue.enqueue({ ...dialogReq("r1"), timeout: 1000 }, handler);
    const p2 = queue.enqueue(dialogReq("r2"), nextHandler);

    // 超时先 settle
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p1).resolves.toEqual({ cancelled: true });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);

    // 迟到的 handler 结果不覆盖（Promise 恰 settle 一次），r2 也已被推进恰一次
    resolveHandler!({ value: "late" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(p1).resolves.toEqual({ cancelled: true });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(nextHandler).toHaveBeenCalledTimes(1);
    await expect(p2).resolves.toEqual({ value: "next-ok" });
  });

  it("竞态恰一次（handler 先到）：handler 正常完成后迟到超时点不触发第二次 settle 与超时日志", async () => {
    const queue = new DialogGlobalQueue();
    let resolveHandler: ((v: UiResponse) => void) | undefined;
    const handler = vi.fn(
      (): Promise<UiResponse> =>
        new Promise<UiResponse>((resolve) => {
          resolveHandler = resolve;
        }),
    );

    const p = queue.enqueue({ ...dialogReq("r1"), timeout: 1000 }, handler);
    resolveHandler!({ value: "fast" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual({ value: "fast" });
    expect(loggerMock.warn).toHaveBeenCalledTimes(0);

    // 越过原超时点：timer 已被 clearTimeout，无第二次 settle、无超时日志
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toEqual({ value: "fast" });
    expect(loggerMock.warn).toHaveBeenCalledTimes(0);
    expect(queue.size).toBe(0);
  });
});

// ── A2-2：reject/rejectAll 抢先 settle 后超时 timer 必须撤下 ────────────────
// 修复前：clearTimeout 只在 processNext 的 handler settle/throw 两路径——handler 永挂时
// await 永不 resume，rejectChildDialogs/rejectAll 抢先 settle 后 timer 仍 armed 到期，
// 触发虚假「dialog timed out」warn + 句柄滞留至超时点（30min~24.8 天）。

describe("DialogGlobalQueue — reject 抢先 settle 后超时 timer 清理（A2-2）", () => {
  it("current 被 rejectChildDialogs 抢先 settle → timer 撤下，到期无虚假 warn、无句柄滞留", async () => {
    const queue = new DialogGlobalQueue();
    // host UI promise 永挂（rejectChildDialogs 的设计触发场景）
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const p = queue.enqueue({ ...dialogReq("r1"), timeout: 1000 }, handler, { child: { pid: 42 } });

    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1); // 已成 current，超时 timer 已 armed
    expect(vi.getTimerCount()).toBe(1);

    // child close：抢先 settle 为 cancelled
    queue.rejectChildDialogs({ pid: 42 });
    await expect(p).resolves.toEqual({ cancelled: true });
    expect(vi.getTimerCount()).toBe(0); // timer 已随 settle 清除，无句柄滞留

    // 越过原超时点：不触发虚假「dialog timed out」warn、无第二次 settle
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toEqual({ cancelled: true });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("rejectAll 抢先 settle current → 同样撤下 timer（无虚假 warn、无句柄滞留）", async () => {
    const queue = new DialogGlobalQueue();
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));
    const p = queue.enqueue({ ...dialogReq("r1"), timeout: 1000 }, handler);

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    queue.rejectAll();
    await expect(p).resolves.toEqual({ cancelled: true });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

describe("DialogGlobalQueue — 活跃队列登记 + 子进程退出通知（SR-4 接线）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    registerActiveDialogQueue(undefined);
    vi.useRealTimers();
  });

  it("notifyChildProcessExited：取消该 pid 的当前项与排队项（该 pid 的 pending 全 settle cancelled）", async () => {
    const queue = new DialogGlobalQueue();
    registerActiveDialogQueue(queue);
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));

    // 同 pid：1 项占住 current（永不 settle）+ 1 项排队
    const current = queue.enqueue(dialogReq("r1"), handler, { child: { pid: 20001 } });
    const queued = queue.enqueue(dialogReq("r2"), handler, { child: { pid: 20001 } });
    expect(queue.size).toBe(1); // r2 仍在排队（enqueue 同步入队，current 立即置位）

    notifyChildProcessExited(20001);

    await expect(current).resolves.toEqual({ cancelled: true });
    await expect(queued).resolves.toEqual({ cancelled: true });
    expect(queue.size).toBe(0);
  });

  it("notifyChildProcessExited：不影响其他 pid 的挂起项", async () => {
    const queue = new DialogGlobalQueue();
    registerActiveDialogQueue(queue);
    const handler = vi.fn((): Promise<UiResponse> => new Promise<UiResponse>(() => {}));

    const other = queue.enqueue(dialogReq("r1"), handler, { child: { pid: 30001 } });

    notifyChildProcessExited(30002); // 另一个 pid 退出

    let settled = false;
    void other.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(queue.size).toBe(0); // 该项仍是 current，未被动过
  });

  it("未登记队列时 notifyChildProcessExited 为 no-op（不抛）", () => {
    expect(_getActiveDialogQueueForTest()).toBeUndefined();
    expect(() => notifyChildProcessExited(40001)).not.toThrow();
  });

  it("登记后 _getActiveDialogQueueForTest 可读；注销后回落 undefined", () => {
    const queue = new DialogGlobalQueue();
    registerActiveDialogQueue(queue);
    expect(_getActiveDialogQueueForTest()).toBe(queue);
    registerActiveDialogQueue(undefined);
    expect(_getActiveDialogQueueForTest()).toBeUndefined();
  });
});

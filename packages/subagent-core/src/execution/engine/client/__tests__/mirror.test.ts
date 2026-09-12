// mirror 单元测试（W2，impl-plan §2.2「镜像失效语义」逐条）：
//   1. 未收 childSpawned 前 = 无句柄（getChildByRecord undefined 等价）；
//   2. killAll 整体置死（killed=true + 状态广播）；
//   3. 置死后清空，isResumable 回落「无句柄」；
//   killed 必含判据 = `entry !== undefined && !entry.killed`。

import { afterEach, describe, expect, it } from "vitest";

import {
  DialogGlobalQueue,
  registerActiveDialogQueue,
  type UiRequest,
  type UiResponse,
} from "../../../dialog-queue.ts";
import { SpawnedChildrenMirror } from "../mirror.ts";

describe("SpawnedChildrenMirror", () => {
  it("未收 childSpawned 前 = 无句柄：getChildByRecord/hasLiveProcessHandle/isResumable 全部回落无句柄", () => {
    const mirror = new SpawnedChildrenMirror();
    expect(mirror.getChildByRecord("rec-1")).toBeUndefined();
    expect(mirror.getEntry(4242)).toBeUndefined();
    expect(mirror.hasLiveProcessHandle("rec-1")).toBe(false);
    expect(mirror.isResumable("rec-1")).toBe(false);
  });

  it("childSpawned 落项后句柄可达；childStateChanged 更新状态（killed 必含）", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    expect(mirror.getChildByRecord("rec-1")).toMatchObject({ pid: 101, recordId: "rec-1", state: "running", killed: false });
    expect(mirror.isResumable("rec-1")).toBe(true);

    mirror.recordStateChanged({ pid: 101, recordId: "rec-1", state: "exited", killed: true, exitCode: 0 });
    expect(mirror.getChildByRecord("rec-1")).toMatchObject({ state: "exited", killed: true, exitCode: 0 });
    // exited + killed → 谓词回落 false（判据 child !== undefined && !child.killed）
    expect(mirror.isResumable("rec-1")).toBe(false);
  });

  it("killAll：全部镜像项整体置死（killed=true + state=exited）+ 逐项广播 + 清空", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    mirror.recordSpawned(102, "rec-2");
    const events: Array<{ reason: string; pid?: number; recordId?: string }> = [];
    mirror.onChange((e) => events.push(e));

    mirror.killAll();

    // 置死广播先于清空（失效语义 2：宿主谓词/通知先看到 killed=true）
    const killEvents = events.filter((e) => e.reason === "killedAll");
    expect(killEvents.map((e) => e.pid).sort()).toEqual([101, 102]);
    // 广播后镜像清空（失效语义 3：isResumable 回落「无句柄」）
    expect(mirror.size).toBe(0);
    expect(mirror.getChildByRecord("rec-1")).toBeUndefined();
    expect(mirror.snapshot()).toEqual([]);
  });

  it("killAll 幂等：空镜像也发一次广播（订阅方依赖收敛信号）", () => {
    const mirror = new SpawnedChildrenMirror();
    const events: string[] = [];
    mirror.onChange((e) => events.push(e.reason));
    mirror.killAll();
    expect(events).toEqual(["killedAll"]);
  });

  it("同一 pid 的 childStateChanged 覆盖原项；多 record 各自独立", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    mirror.recordSpawned(102, "rec-2");
    mirror.recordStateChanged({ pid: 101, recordId: "rec-1", state: "exited", killed: false, exitCode: 0 });
    expect(mirror.size).toBe(2);
    expect(mirror.getChildByRecord("rec-1")).toMatchObject({ state: "exited", killed: false });
    expect(mirror.isResumable("rec-2")).toBe(true);
  });
});

// ── [SR-4 接线] 子进程退出 → 取消该 pid 挂起的 dialog ──
//
// 原绑定点（宿主 spawn pi 子进程时代的 session-runner child close）随协议化消失；
// 新链路 = 引擎 host/childStateChanged(exited) → 本镜像 → notifyChildProcessExited。
describe("SpawnedChildrenMirror — 子进程退出取消挂起 dialog（SR-4 接线）", () => {
  afterEach(() => {
    registerActiveDialogQueue(undefined);
  });

  /** 入队一个永不 settle 的 dialog（绑定 pid），返回其结果观察 promise。 */
  function enqueuePending(queue: DialogGlobalQueue, pid: number, id: string): Promise<UiResponse> {
    const req: UiRequest = { method: "select", id, title: `q-${id}` };
    return queue.enqueue(req, () => new Promise<UiResponse>(() => {}), { child: { pid } });
  }

  it("state=exited → 该 pid 的挂起 dialog resolve cancelled", async () => {
    const queue = new DialogGlobalQueue();
    registerActiveDialogQueue(queue);
    const pending = enqueuePending(queue, 101, "req-1");

    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    mirror.recordStateChanged({ pid: 101, recordId: "rec-1", state: "exited", killed: true, exitCode: 0 });

    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it("state=running 不触发取消（进程仍在跑，dialog 继续排队）", async () => {
    const queue = new DialogGlobalQueue();
    registerActiveDialogQueue(queue);
    let settled = false;
    void enqueuePending(queue, 102, "req-2").then(() => {
      settled = true;
    });

    const mirror = new SpawnedChildrenMirror();
    mirror.recordStateChanged({ pid: 102, recordId: "rec-2", state: "running", killed: false });
    await Promise.resolve();

    expect(settled).toBe(false);
  });

  it("killAll（引擎进程消亡）→ 逐 pid 取消各自挂起 dialog", async () => {
    const queue = new DialogGlobalQueue();
    registerActiveDialogQueue(queue);
    const p1 = enqueuePending(queue, 201, "req-a");
    const p2 = enqueuePending(queue, 202, "req-b");

    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(201, "rec-a");
    mirror.recordSpawned(202, "rec-b");
    mirror.killAll();

    await expect(p1).resolves.toEqual({ cancelled: true });
    await expect(p2).resolves.toEqual({ cancelled: true });
  });

  it("未登记队列（headless / 无 UI 通道宿主）→ exited 为 no-op，不抛", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(301, "rec-3");
    expect(() =>
      mirror.recordStateChanged({ pid: 301, recordId: "rec-3", state: "exited", killed: true }),
    ).not.toThrow();
  });
});

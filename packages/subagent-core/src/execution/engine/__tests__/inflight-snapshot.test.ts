// inflight-snapshot.test.ts —— core→壳在途事件出口（u7a，设计权威源：
// docs/architecture/crash-forensics-and-watchdog.md §3.3 D5）。
//
// 三视角：
//   ①使用者（壳层 reporter 视角）——setInFlightListener 注册后，core 状态迁移点
//     （子进程注册/移除、idle timer arm）触发通知，监听者自行 getInFlightSnapshot
//     现取快照（发送时刻求值）；getInFlightSnapshot 随时可拉（初始上报数据源）。
//   ②构建者——计数 = 双谓词过滤（hasLiveProcessHandle && !hasIdleTimer，与
//     notify-host hasRunningBackground 同源）：活句柄且无 armed idle timer 才算在途，
//     Path A 保活（timer armed）不算——D5 防推迟恒真的核心裁决。
//   ③观察者——出口监听者抛错不反噬 core；无参签名（2026-09-13 oe-audit：原
//     snapshot 参数自交付起无任何监听者消费，删除）。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import {
  armIdleTimer,
  disarmIdleTimer,
  _resetLifecycleState,
} from "../../lifecycle/lifecycle-manager.ts";
import {
  getInFlightSnapshot,
  notifyInFlightChanged,
  setInFlightListener,
  type InFlightSnapshot,
} from "../inflight-snapshot.ts";
// W3 合并改写：inproc 引擎已删——句柄记账走 host/spawned-children 镜像（register +
// reset 测试面）。
import {
  killRecordChildWithEscalation,
  registerSpawnedChildForRecord,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../host/spawned-children.ts";
import { createHostBridge } from "../host/host-bridge.ts";

/** 最小 fake 子进程（EventEmitter + killed/pid 字段——hasLiveProcessHandle 消费面）。 */
function makeFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  (child as { pid?: number }).pid = 4242;
  (child as { killed: boolean }).killed = false;
  return child;
}

beforeEach(() => {
  _resetLifecycleState();
  setInFlightListener(null);
});

afterEach(() => {
  // 清理本测试注册的句柄镜像（W3 后记账在 host/spawned-children，reset 即清；close 事件
  // 摘除路径已由「close 摘除自动触发通知」用例覆盖），防跨用例泄漏。
  _resetCoreSpawnedChildrenMirrorForTest();
  _resetLifecycleState();
  setInFlightListener(null);
});

describe("getInFlightSnapshot：双谓词绝对计数（D5 求值位置 = 状态所在进程）", () => {
  it("空态 → 0（无任何 subagent 的 session 初始上报数据源）", () => {
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0 });
  });

  it("注册活句柄 → 1；arm idle timer（Path A 保活）→ 0；disarm → 1", () => {
    const id = "sa-inflight-arm";
    registerSpawnedChildForRecord(id, makeFakeChild());
    expect(getInFlightSnapshot().inFlight).toBe(1);

    armIdleTimer(id, () => undefined, 60_000);
    expect(getInFlightSnapshot().inFlight).toBe(0);

    disarmIdleTimer(id);
    expect(getInFlightSnapshot().inFlight).toBe(1);
  });

  it("killed 句柄不算活（hasLiveProcessHandle 的 !killed 子句）", () => {
    const id = "sa-inflight-killed";
    const child = makeFakeChild();
    registerSpawnedChildForRecord(id, child);
    // W3 镜像形态：killed 判据由镜像置死位承载（注册后改 child 引用字段不进镜像——
    // 生产置死路径 = killRecordChildWithEscalation 杀链记账面 / 引擎反向通道）。
    killRecordChildWithEscalation(id, "test");
    expect(getInFlightSnapshot().inFlight).toBe(0);
  });

  it("多 record 混合形态：在途/保活/垂死并存时按谓词逐一过滤", () => {
    const running = makeFakeChild();
    const keepAlive = makeFakeChild();
    const dying = makeFakeChild();
    (dying as { killed: boolean }).killed = true;
    registerSpawnedChildForRecord("sa-inflight-run", running);
    registerSpawnedChildForRecord("sa-inflight-keep", keepAlive);
    registerSpawnedChildForRecord("sa-inflight-dying", dying);
    armIdleTimer("sa-inflight-keep", () => undefined, 60_000);
    expect(getInFlightSnapshot().inFlight).toBe(1);
  });
});

describe("notifyInFlightChanged：迁移点 → 壳层监听者（同步 fire-and-forget）", () => {
  it("监听者在迁移时刻被调，现取快照即最新值（发送时刻求值，非注册时刻）", () => {
    const seen: InFlightSnapshot[] = [];
    setInFlightListener(() => seen.push(getInFlightSnapshot()));

    notifyInFlightChanged();
    expect(seen).toEqual([{ inFlight: 0 }]);

    registerSpawnedChildForRecord("sa-inflight-notify", makeFakeChild());
    notifyInFlightChanged();
    expect(seen[seen.length - 1]).toEqual({ inFlight: 1 });
  });

  it("监听者抛错不反噬 core（壳层故障不打断生命周期主链）", () => {
    setInFlightListener(() => {
      throw new Error("shell reporter bug");
    });
    expect(() => notifyInFlightChanged()).not.toThrow();
  });

  it("无监听者时 no-op；注册覆盖语义（后注册者收到，先注册者不再收）", () => {
    expect(() => notifyInFlightChanged()).not.toThrow();

    let firstCalls = 0;
    let secondCalls = 0;
    setInFlightListener(() => { firstCalls += 1; });
    setInFlightListener(() => { secondCalls += 1; });
    notifyInFlightChanged();
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
  });

  it("host-bridge armIdleTimer / disarmIdleTimer 委托点自动触发通知（迁移点接线证据）", () => {
    // W3 镜像形态：register 本身不再通知（子进程终止经引擎反向通道），core 侧唯一挂
    // notifyInFlightChanged 的委托面 = host-bridge 的 arm/disarm（u7a 迁移点新宿主）。
    const seen: InFlightSnapshot[] = [];
    setInFlightListener(() => seen.push(getInFlightSnapshot()));
    registerSpawnedChildForRecord("sa-inflight-auto", makeFakeChild());

    const bridge = createHostBridge({
      service: {} as Parameters<typeof createHostBridge>[0]["service"],
      onIdleTimeout: () => undefined,
    });
    bridge.armIdleTimer("sa-inflight-auto", 60_000);
    expect(seen.at(-1)).toEqual({ inFlight: 0 });

    bridge.disarmIdleTimer("sa-inflight-auto");
    expect(seen.at(-1)).toEqual({ inFlight: 1 });
  });
});

// core 侧 spawnedChildren 状态镜像单测（W6 建立；[W3 改写] 纯镜像形态）。
// 覆盖：注册记账、终止意图置死位、镜像整体置死、hasLiveProcessHandleCore 读点。
// inproc 过渡桥（双写/委托杀/并读）随 inproc pi 引擎目录 删除消亡——实际终止在引擎进程内
// 经协议 interact cancel/close 承载，本模块只做镜像记账。

import { describe, it, expect, beforeEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  coreSpawnedChildrenMirror,
  hasLiveProcessHandleCore,
  killAllSpawnedChildren,
  killRecordChildWithEscalation,
  registerSpawnedChildForRecord,
} from "../spawned-children.ts";

/** 最小 ChildProcess fake（镜像注册只读 pid/killed）。 */
function fakeChild(id: string): ChildProcess {
  return { pid: 10_000 + (id.charCodeAt(0) % 1000), killed: false } as unknown as ChildProcess;
}

describe("core 侧 spawnedChildren 状态镜像（W6；W3 纯镜像形态）", () => {
  beforeEach(() => {
    _resetCoreSpawnedChildrenMirrorForTest();
  });

  it("registerSpawnedChildForRecord：写镜像（host/childSpawned 上报的同款落点）", () => {
    const child = fakeChild("sa-a");
    registerSpawnedChildForRecord("sa-a", child);
    expect(coreSpawnedChildrenMirror().getChildByRecord("sa-a")).toMatchObject({
      pid: child.pid,
      killed: false,
    });
  });

  it("hasLiveProcessHandleCore：镜像注册后 true；markKilled 后 false", () => {
    registerSpawnedChildForRecord("sa-a", fakeChild("sa-a"));
    expect(hasLiveProcessHandleCore("sa-a")).toBe(true);
    coreSpawnedChildrenMirror().markKilled("sa-a");
    expect(hasLiveProcessHandleCore("sa-a")).toBe(false);
  });

  it("killRecordChildWithEscalation：终止意图记账（镜像置死位；实际终止经协议承载）", () => {
    registerSpawnedChildForRecord("sa-a", fakeChild("sa-a"));
    killRecordChildWithEscalation("sa-a", "test escalation");
    expect(coreSpawnedChildrenMirror().getChildByRecord("sa-a")?.killed).toBe(true);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(false);
  });

  it("killAllSpawnedChildren：镜像整体置死（失效语义 2+3），返回清理条目数", () => {
    registerSpawnedChildForRecord("sa-a", fakeChild("sa-a"));
    registerSpawnedChildForRecord("sa-b", fakeChild("sa-b"));
    const killed = killAllSpawnedChildren();
    expect(killed).toBe(2);
    expect(coreSpawnedChildrenMirror().snapshot()).toEqual([]);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(false);
    expect(hasLiveProcessHandleCore("sa-b")).toBe(false);
  });

  it("不存在的 record killAll：返回 0（幂等）", () => {
    expect(killAllSpawnedChildren()).toBe(0);
  });

  it("同 recordId 重 spawn：镜像覆盖旧句柄（与引擎侧 Map 覆盖语义同构）", () => {
    registerSpawnedChildForRecord("sa-a", fakeChild("sa-a"));
    killRecordChildWithEscalation("sa-a", "old killed");
    const fresh = fakeChild("sa-b");
    registerSpawnedChildForRecord("sa-a", fresh);
    expect(coreSpawnedChildrenMirror().getChildByRecord("sa-a")?.pid).toBe(fresh.pid);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(true);
  });
});

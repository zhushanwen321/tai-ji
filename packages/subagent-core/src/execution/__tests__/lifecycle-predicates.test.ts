// lifecycle-predicates 单测（v4 B-1；W6 随拆依赖改写：读点改 core 侧状态镜像）。
// 验证 isIdle/isResumable/hasLiveProcessHandle 在两态收敛后的判定逻辑。
// 依赖 lifecycle-manager 模块级 idleTimers 与 core 侧 spawnedChildren 镜像
// （engine/host/spawned-children.ts），beforeEach 重置隔离。
// [W3 改写] inproc 过渡桥并读用例随 inproc pi 引擎目录 删除消亡——镜像成为唯一数据源
// （host/childSpawned 上报 + 终止意图置死位），等价性用例的「并读」语义不再存在。

import { describe, it, expect, beforeEach } from "vitest";

import {
  armIdleTimer,
  disarmIdleTimer,
  _resetLifecycleState,
} from "../lifecycle/lifecycle-manager.ts";
import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../assembly/types.ts";

import { hasLiveProcessHandle, isIdle, isResumable } from "../lifecycle/lifecycle-predicates.ts";

/** 构造最小 ExecutionRecord（status 默认 running）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "sa-test",
    agent: "general-purpose",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "test",
    startedAt: Date.now(),
    rootSessionId: "root",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    round: 0,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    ...overrides,
  } as ExecutionRecord;
}

describe("lifecycle-predicates (v4 B-1)", () => {
  beforeEach(() => {
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
  });

  describe("isIdle (= hasIdleTimer)", () => {
    it("armed idle timer → true", () => {
      const rec = makeRecord();
      armIdleTimer(rec.id, () => {});
      expect(isIdle(rec)).toBe(true);
    });

    it("no idle timer → false", () => {
      expect(isIdle(makeRecord())).toBe(false);
    });

    it("disarmed timer → false", () => {
      const rec = makeRecord();
      armIdleTimer(rec.id, () => {});
      disarmIdleTimer(rec.id);
      expect(isIdle(rec)).toBe(false);
    });
  });

  describe("hasLiveProcessHandle（W6 改读镜像）", () => {
    it("no mirror entry → false", () => {
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("mirror entry running (not killed) → true", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: false });
      expect(hasLiveProcessHandle("sa-test")).toBe(true);
    });

    it("mirror entry killed → false", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: true });
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("mirror markKilled 置死后 → false", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: false });
      coreSpawnedChildrenMirror().markKilled("sa-test");
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

  });

  describe("isResumable (= running && !hasLiveProcessHandle)", () => {
    it("running + no live process → true (Path B / 跨重启)", () => {
      expect(isResumable(makeRecord({ status: "running" }))).toBe(true);
    });

    it("running + live process (镜像) → false (Path A 保活 / 正在执行)", () => {
      const rec = makeRecord({ status: "running" });
      coreSpawnedChildrenMirror().register(rec.id, { pid: 1, killed: false });
      expect(isResumable(rec)).toBe(false);
    });

    it("closed + no live process → false (终态不可 resume)", () => {
      expect(isResumable(makeRecord({ status: "idle" }))).toBe(false);
    });

    it("closed + live process → false (终态优先)", () => {
      const rec = makeRecord({ status: "idle" });
      coreSpawnedChildrenMirror().register(rec.id, { pid: 1, killed: false });
      expect(isResumable(rec)).toBe(false);
    });
  });
});

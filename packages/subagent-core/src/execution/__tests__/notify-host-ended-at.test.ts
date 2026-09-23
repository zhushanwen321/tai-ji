// src/execution/__tests__/notify-host-ended-at.test.ts
//
// [U8 / 设计 §3.3 D5 耗时来源] toNotifyRecord 的 endedAt 物化域单测：
//   1. running 轮终（生产 markRoundIdle 收口形态：status="idle" ∧ 无 closedReason）→
//      载荷含 number 型 endedAt（物化前恒 undefined——bg-notify 边界行的耗时恒不显）；
//   2. ~~批成员（batchMember=true，closed 载荷形态）~~ [collect 退役 merge] 用例随
//      批机制删除（toNotifyRecord 收窄单参）；
//   3. legacyClosed（status="idle" ∧ closedReason 有值）保持原值透传（有则透传、
//      无则不补）——原「archived 归档提示」域外分支已随 2026-09-16 全链路删除裁决
//      消亡（收口提示与任务结束同刻，无「收起延迟」失真源）；
//   4. 快照已有 endedAt 优先于投影时刻（settleRoundFailed / drain-drop 两条自带
//      endedAt 的既有构造路径保真）；
//   5. 投影边界一次完成：返回对象固定，时钟推进不追涨（新投影才取新时钟）；
//   6. record 内存零触碰：不写回 record.endedAt（「终态冻结信号」不变量）；
//   7. 收口提示投递链（notifyClosed）复用同一映射：idle 落账形态物化 endedAt，
//      载荷形态由入口固定 closed。
//
// 时钟：vi.useFakeTimers({ toFake: ["Date"] })——只 fake Date，不碰真实定时器
//（本族零 timer 依赖；notifier 构造点无定时器武装）。
// 数据面：createRecord 真工厂 + 真 NotifyHost（不 mock 映射内部），内存断言即真实对象。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { createNotifyHost, type NotifyHost, type PiLike } from "../notify/notify-host.ts";
import type { BgNotifyRecord } from "../notify/notifier.ts";
import { createRecord } from "../persistence/execution-record.ts";
import type { ExecutionRecord } from "../assembly/types.ts";
import { makePi } from "./helpers/pi-mock.ts";

/** 冻结时钟（投影时刻断言基准）。 */
const FROZEN_NOW = 1788189209000;
const AN_HOUR_MS = 60 * 60 * 1000;

/** 构造 ExecutionRecord（createRecord 真工厂，over 覆盖到目标形态）。 */
function makeRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord(id, {
    agent: "worker",
    model: "prov/m1",
    mode: "background",
    task: "t",
    slug: "ended-at",
    startedAt: 1000,
    rootSessionId: "root-A",
  });
  return { ...base, ...over };
}

/** 通知簇 host（pi 缺席——本族只消费 toNotifyRecord；投递链用例单传 pi 替身）。 */
function makeHost(pi: PiLike | null = null): NotifyHost {
  return createNotifyHost({
    getPi: () => pi,
    listRunning: () => [],
    getIsIdle: () => undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("[U8] 物化域 = running 轮终 + 批成员", () => {
  it("running 轮终载荷物化 endedAt = 投影时刻", () => {
    const host = makeHost();
    const record = makeRecord("sa-round-idle", { status: "idle" });
    // 生产形态前提：markRoundIdle 不写内存 endedAt（「终态冻结信号」）——载荷缺值即本单元根因。
    expect(record.endedAt).toBeUndefined();

    const notify = host.toNotifyRecord(record);

    expect(notify).toBeDefined();
    expect(notify!.status).toBe("running");
    expect(typeof notify!.endedAt).toBe("number");
    expect(notify!.endedAt).toBe(FROZEN_NOW);
  });

  it("物化域内快照已有 endedAt 优先透传（不覆写为投影时刻）", () => {
    const host = makeHost();
    const roundTerminal = makeRecord("sa-has-ended", { status: "idle", endedAt: 4242 });
    expect(host.toNotifyRecord(roundTerminal)!.endedAt).toBe(4242);
  });
});

describe("[U8] 域外分支不合成新值（原值透传）", () => {
  it("legacyClosed 无原值 → 不补；有原值 → 透传", () => {
    const host = makeHost();
    const legacy = makeRecord("sa-legacy", { status: "idle", closedReason: "gc" });
    const legacyWithHistory = makeRecord("sa-legacy-hist", {
      status: "idle",
      closedReason: "gc",
      endedAt: 777,
    });

    const noValue = host.toNotifyRecord(legacy);
    expect(noValue!.status).toBe("closed");
    expect(noValue!.endedAt).toBeUndefined();
    expect(host.toNotifyRecord(legacyWithHistory)!.endedAt).toBe(777);
  });
});

describe("[U8] 投影边界一次完成 + record 内存零触碰", () => {
  it("返回对象固定：时钟推进不追涨，新投影才取新时钟", () => {
    const host = makeHost();
    const notify = host.toNotifyRecord(makeRecord("sa-fixed", { status: "idle" }));
    expect(notify!.endedAt).toBe(FROZEN_NOW);

    vi.setSystemTime(FROZEN_NOW + AN_HOUR_MS);

    // 物化 = 边界一次求值（非 getter / 延迟计算）——已返回对象不随读取时刻增长。
    expect(notify!.endedAt).toBe(FROZEN_NOW);
    // 每次投影独立物化：新投影取当时时钟。
    expect(host.toNotifyRecord(makeRecord("sa-fixed-2", { status: "idle" }))!.endedAt).toBe(
      FROZEN_NOW + AN_HOUR_MS,
    );
  });

  it("endedAt 不写回 record 内存（「终态冻结信号」不变量）", () => {
    const host = makeHost();
    const roundTerminal = makeRecord("sa-mem", { status: "idle" });
    const legacy = makeRecord("sa-mem-legacy", { status: "idle", closedReason: "gc" });

    host.toNotifyRecord(roundTerminal);
    host.toNotifyRecord(legacy);

    expect(roundTerminal.endedAt).toBeUndefined();
    expect(legacy.endedAt).toBeUndefined();
  });
});

describe("[U8] 收口提示投递链复用同一映射（notifyClosed）", () => {
  it("idle 落账形态送达：endedAt 物化（收口时刻 ≈ 结束时刻）+ 载荷固定 closed", () => {
    const pi = makePi();
    const host = makeHost(pi);

    host.notifyClosed(makeRecord("sa-close", { status: "idle" }));

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const details = pi.sendMessage.mock.calls[0]![0].details as BgNotifyRecord;
    expect(details.status).toBe("closed");
    expect(details.endedAt).toBe(FROZEN_NOW);
  });
});

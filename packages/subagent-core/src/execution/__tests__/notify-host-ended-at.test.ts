// src/execution/__tests__/notify-host-ended-at.test.ts
//
// [U8 / 设计 §3.3 D5 耗时来源] toNotifyRecord 的 endedAt 物化域单测：
//   1. running 轮终（生产 markRoundIdle 收口形态：status="idle" ∧ 无 closedReason）→
//      载荷含 number 型 endedAt（物化前恒 undefined——bg-notify 边界行的耗时恒不显）；
//   2. 批成员（batchMember=true，closed 载荷形态）→ 同样物化；
//   3. 归档（intent="archived"）不合成新值：无原值保持 undefined、带历史值原值透传
//      （归档时刻 ≠ 任务结束时刻，「收起延迟」不得混入耗时）；
//   4. legacyClosed（status="idle" ∧ closedReason 有值）保持原值透传（有则透传、
//      无则不补）；
//   5. 快照已有 endedAt 优先于投影时刻（settleRoundFailed / drain-drop 两条自带
//      endedAt 的既有构造路径保真）；
//   6. 投影边界一次完成：返回对象固定，时钟推进不追涨（新投影才取新时钟）；
//   7. record 内存零触碰：不写回 record.endedAt（「终态冻结信号」不变量）；
//   8. 归档提示投递链（notifyClosed）复用同一映射且不物化。
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

interface SentMessage {
  customType: string;
  content: string;
  details?: unknown;
}

/** pi 替身（投递链用例捕获 sendMessage 载荷）。 */
function makePi(): { pi: PiLike; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const pi: PiLike = {
    appendEntry: () => {},
    events: { emit: () => {} },
    sendMessage: (message) => {
      sent.push(message);
    },
  };
  return { pi, sent };
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

  it("批成员载荷（closed 形态）同样物化 endedAt", () => {
    const host = makeHost();
    const record = makeRecord("sa-batch-member", { status: "idle" });

    const notify = host.toNotifyRecord(record, { batchMember: true });

    expect(notify).toBeDefined();
    expect(notify!.status).toBe("closed");
    expect(notify!.endedAt).toBe(FROZEN_NOW);
  });

  it("物化域内快照已有 endedAt 优先透传（不覆写为投影时刻）", () => {
    const host = makeHost();
    const roundTerminal = makeRecord("sa-has-ended", { status: "idle", endedAt: 4242 });
    const batchMember = makeRecord("sa-has-ended-batch", { status: "idle", endedAt: 4242 });

    expect(host.toNotifyRecord(roundTerminal)!.endedAt).toBe(4242);
    expect(host.toNotifyRecord(batchMember, { batchMember: true })!.endedAt).toBe(4242);
  });
});

describe("[U8] 域外两分支不合成新值（原值透传）", () => {
  it("归档提示（intent=archived）无原值 → 保持 undefined", () => {
    const host = makeHost();
    const record = makeRecord("sa-archived", { status: "idle", intent: "archived" });

    const notify = host.toNotifyRecord(record);

    expect(notify).toBeDefined();
    expect(notify!.status).toBe("closed");
    expect(notify!.endedAt).toBeUndefined();
  });

  it("归档提示带历史 endedAt → 原值透传（不覆写为归档时刻）", () => {
    const host = makeHost();
    const record = makeRecord("sa-archived-hist", { status: "idle", intent: "archived", endedAt: 4242 });

    expect(host.toNotifyRecord(record)!.endedAt).toBe(4242);
  });

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
    const archived = makeRecord("sa-mem-arch", { status: "idle", intent: "archived" });

    host.toNotifyRecord(roundTerminal);
    host.toNotifyRecord(roundTerminal, { batchMember: true });
    host.toNotifyRecord(archived);

    expect(roundTerminal.endedAt).toBeUndefined();
    expect(archived.endedAt).toBeUndefined();
  });
});

describe("[U8] 归档提示投递链不物化（notifyClosed 复用同一映射）", () => {
  it("送达载荷 endedAt 缺席（归档时刻不得当耗时）", () => {
    const { pi, sent } = makePi();
    const host = makeHost(pi);

    host.notifyClosed(makeRecord("sa-close", { status: "idle", intent: "archived" }));

    expect(sent).toHaveLength(1);
    const details = sent[0]!.details as BgNotifyRecord;
    expect(details.status).toBe("closed");
    expect(details.endedAt).toBeUndefined();
  });
});

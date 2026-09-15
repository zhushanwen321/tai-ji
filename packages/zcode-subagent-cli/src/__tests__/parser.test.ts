// parser.test.ts —— usage 字段映射（事件层 execution 版）+ coarse 事件合成不变量回归。
// 原 stdout 有界收集/终 JSON 解析/运行失败文案一族（含 golden spawn 样本回归）已随
// CLI spawn 链删除（2026-09 单一 app-server 形态——终态来自 session-channel 收尾帧，
// 不经 stdout 解析）；mapZcodeOutcomeUsage（终态层映射）经 zcode-engine-appserver.test.ts
// 的 outcome.usage 断言覆盖。

import { describe, expect, it } from "vitest";

import { mapZcodeUsage, synthesizeCoarseEvents } from "../parser.ts";

describe("mapZcodeUsage：字段名映射", () => {
  it("usage 字段名映射：inputTokens→input 等四项（cost 无来源不出现）", () => {
    const u = mapZcodeUsage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    });
    expect(u).toEqual({ input: 10, output: 20, cacheRead: 5, cacheWrite: 0 });
    expect(u !== undefined && "cost" in u).toBe(false);
  });

  it("usage 形状不完整时显式 undefined（不给残缺对象）", () => {
    expect(mapZcodeUsage(undefined)).toBeUndefined();
    expect(mapZcodeUsage("nope")).toBeUndefined();
    expect(mapZcodeUsage({})).toBeUndefined();
  });
});

describe("synthesizeCoarseEvents：coarse 不变量", () => {
  it("message_end（含 usage）在前、turn_end 最后", () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    const evs = synthesizeCoarseEvents("ok", usage);
    expect(evs).toEqual([{ type: "message_end", usage }, { type: "turn_end" }]);
  });

  it("无 usage 时 message_end 不带残缺字段", () => {
    const evs = synthesizeCoarseEvents("ok");
    expect(evs[0]).toEqual({ type: "message_end" });
    expect("usage" in evs[0]!).toBe(false);
    expect(evs[evs.length - 1]).toEqual({ type: "turn_end" });
  });
});

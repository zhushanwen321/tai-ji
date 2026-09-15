// contract.agent-events.test.ts —— conformance C3（AgentEvent 不变量）+ 负例自证
// （A12「套件有牙」：故意破坏一个不变量的样本必须被断言器检出——用「注入坏
// parser」的形态：构造抽掉 message_end / usage 半映射的坏样本流，断言套件转红；
// 若断言器检不出破坏则本元测试失败）。
//
// W10 协议化：app-server 常驻全链用例随 zcode 引擎内移（zcode-subagent-cli
// protocol-e2e/zcode-engine-* 测试覆盖，fake-appserver + golden 同款语料）；core 侧
// 保留断言器正反例与负例自证（协议黑盒套件 protocol-blackbox.test.ts 消费断言器）。
// 历史注：2026-09 重构（共享宿主 HOME）：CLI spawn 链删除后引擎只剩 app-server 常驻链，
// C3 的引擎全链覆盖只走 app-server 形态（fake 常驻引擎 + stream 口径，文件末
// describe；app-server 设计 §3.4 不变量 1：text_delta 拼接 == read 全文、终态唯一
// turn.terminal 权威、message_end.usage 完整、tool 事件不合成——granularity 声明
// 与实际流出一致）。断言器行为正反例与负例自证均为手工构造样本，不依赖引擎实现。

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../assembly/types.ts";
import {
  assertAgentEventInvariants,
  checkAgentEventInvariants,
} from "./agent-event-invariants.ts";

describe("conformance C3：AgentEvent 不变量（断言器正反例，手工构造样本）", () => {
  it("不变量 1：终态唯一——turn_end 后不得再出现非 error 事件", () => {
    const events: AgentEvent[] = [{ type: "message_end" }, { type: "turn_end" }, { type: "text_delta", delta: "x" }];
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "1")).toBe(true);
  });

  it("不变量 2：message_end.usage 残缺对象（NaN token）被判违例", () => {
    const events: AgentEvent[] = [
      { type: "message_end", usage: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "2")).toBe(true);
  });

  it("不变量 2 正例：usage 显式缺省整个字段 = 合法（不给残缺）", () => {
    const events: AgentEvent[] = [{ type: "message_end" }, { type: "turn_end" }];
    expect(checkAgentEventInvariants(events, { granularity: "coarse" })).toEqual([]);
  });

  it("不变量 3a：流式 text_delta 拼接 ≠ content 判违例（byte 级）", () => {
    const events: AgentEvent[] = [
      { type: "text_delta", delta: "abc" },
      { type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    const findings = checkAgentEventInvariants(events, { granularity: "stream", content: "abd" });
    expect(findings.some((f) => f.invariant === "3a")).toBe(true);
  });

  it("不变量 3b：coarse 序列缺 message_end（turn_end 裸终态）判违例", () => {
    const events: AgentEvent[] = [{ type: "turn_end" }];
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "3b")).toBe(true);
  });

  it("不变量 4：未配对 tool_start 且无 error 兜底判违例；error 兜底合法", () => {
    const unpaired: AgentEvent[] = [
      { type: "tool_start", toolName: "bash" },
      { type: "turn_end" },
    ];
    expect(checkAgentEventInvariants(unpaired, { granularity: "coarse" }).some((f) => f.invariant === "4")).toBe(true);

    const withError: AgentEvent[] = [
      { type: "tool_start", toolName: "bash" },
      { type: "error", message: "boom" },
      { type: "turn_end" },
    ];
    expect(checkAgentEventInvariants(withError, { granularity: "coarse" }).some((f) => f.invariant === "4")).toBe(false);
  });
});

describe("conformance 负例自证（A12：套件有牙）", () => {
  it("注入坏 parser（抽掉 message_end 的合成器）：断言器必须检出（不变量 3b 转红）", () => {
    // 坏 parser 形态：zcode 新版本漂移后合成器丢 message_end——不变量 3b 应抓到
    const badParser = (): AgentEvent[] => [{ type: "turn_end" }];
    const events = badParser();
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.invariant === "3b")).toBe(true);
    // 断言形态同步转红（conformance 用例消费的入口）
    expect(() => assertAgentEventInvariants(events, { granularity: "coarse" })).toThrowError(/不变量/);
  });

  it("注入坏 parser（usage 半映射）：断言器必须检出（不变量 2 转红）", () => {
    // 坏 parser 形态：新版本 usage 字段改名，数值映射 Number(undefined) → NaN 渗入
    const badParser = (): AgentEvent[] => [
      { type: "message_end", usage: { input: Number.NaN, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    const findings = checkAgentEventInvariants(badParser(), { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "2")).toBe(true);
  });
});

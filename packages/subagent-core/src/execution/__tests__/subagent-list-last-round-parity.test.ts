// core↔shared SubagentLastRound 形状对拍（[subagent-observability §3.3.6] assembly
// SubagentListLastRound 注释声明的「跨包形状一致由对拍测试锚定」的承载文件）。
//
// 物理单源结构性不可行（@taiji/shared 为 private 包、subagent-core 为 npm 发布包，
// core 生产码不 import shared 主入口），两侧各自持同形接口——漂移只能靠本对拍抓：
//   ① shared 键集 ⊆ core 键集（wire 契约字段在 list 读模型侧缺席即红）；
//   ② core 独有键 = 已登记偏差清单（stderrTeePath / swept——core 未登记加键即红，
//      shared 加键不跟 core 也红）。
// 样例对象 satisfies 各自接口（任一侧接口收窄/改名即编译红），键集运行时可枚举。
// 纯类型/常量断言，零 fs / 零 timer——不触碰真实数据目录。
import { describe, expect, it } from "vitest";

import type { SubagentLastRound } from "@taiji/shared";

import type { SubagentListLastRound } from "../assembly/types.ts";

/** shared wire 契约键集样例（satisfies 编译锚——shared 侧收窄/改名即本文件编译红）。 */
const SHARED_LAST_ROUND_SAMPLE = {
  engineStopReason: "stop",
  failure: { class: "provider", kind: "rate_limited", retryable: true, raw: "429" },
  promptDisposition: "handled",
  result: "round reply",
  turns: 2,
  usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, total: 4 },
  retryAttempts: 0,
  observations: [],
} as const satisfies SubagentLastRound;

/** core list 读模型键集样例（satisfies 编译锚——core 侧收窄/改名即本文件编译红）。 */
const CORE_LAST_ROUND_SAMPLE = {
  engineStopReason: "stop",
  failure: { class: "provider", kind: "rate_limited", retryable: true, raw: "429" },
  promptDisposition: "handled",
  result: "round reply",
  turns: 2,
  usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, total: 4 },
  retryAttempts: 0,
  observations: [],
  // [有意偏差] core 独有：stderrTeePath = list 证据链字段（evidence 装配供源）；
  // swept = 失联清点附注。shared 侧（renderer 展示通道）暂不承载，透传需求出现时
  // shared 同批加字段（assembly/types.ts 注释同款登记）。
  stderrTeePath: "/tmp/tee.log",
  swept: { at: 0, evidence: "manifest=executionStatus:running" },
} as const satisfies SubagentListLastRound;

describe("SubagentListLastRound（core）↔ SubagentLastRound（shared）键集对拍", () => {
  it("shared wire 键集 ⊆ core list 键集（契约字段在读模型侧缺席即红）", () => {
    const sharedKeys = Object.keys(SHARED_LAST_ROUND_SAMPLE);
    for (const key of sharedKeys) {
      expect(key in CORE_LAST_ROUND_SAMPLE).toBe(true);
    }
  });

  it("core 独有键恰为已登记偏差清单（stderrTeePath / swept——未登记加键即红）", () => {
    const sharedKeys = new Set(Object.keys(SHARED_LAST_ROUND_SAMPLE));
    const coreOnly = Object.keys(CORE_LAST_ROUND_SAMPLE).filter((key) => !sharedKeys.has(key));
    expect(coreOnly.sort()).toEqual(["stderrTeePath", "swept"]);
  });
});

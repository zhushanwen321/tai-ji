// src/execution/engine/__tests__/identity-envelope.test.ts
//
// [D4 第三阶段] 宿主侧身份信封构造单点（identityEnvelopeOf）：
//   - 三处 run 组装点共用它 → 取值口径单点，防「某条派发链漏填某键」；
//   - `slug` 空串不上 wire（record 允许空 slug，空串会让壳写空标签）；
//   - `startedAt` / `mode` 是 record 不变式字段，恒在。
import { describe, expect, it } from "vitest";

import { identityEnvelopeOf } from "../port.ts";

describe("identityEnvelopeOf（[D4] record → 身份信封）", () => {
  it("常规 record：三键齐全", () => {
    expect(
      identityEnvelopeOf({ slug: "fix-bug-42", startedAt: 1_700_000_000_000, mode: "background" }),
    ).toEqual({ slug: "fix-bug-42", startedAt: 1_700_000_000_000, mode: "background" });
  });

  it("空 slug 不上 wire（additive 语义：键缺席而非空串）", () => {
    const envelope = identityEnvelopeOf({ slug: "", startedAt: 1, mode: "background" });
    expect("slug" in envelope!).toBe(false);
    expect(envelope).toEqual({ startedAt: 1, mode: "background" });
  });

  it("mode 透传 record 的权威值（core 词表现只有 background；env 侧读者仍按字符串兜底）", () => {
    // core 的 ExecutionMode = "background"（chat 形态随 modeless 波退役）；env 侧
    // PI_SUBAGENT_MODE 仍是字符串键（其它引擎可写 chat），壳读者对非法值兜底 background。
    expect(identityEnvelopeOf({ slug: "s", startedAt: 2, mode: "background" })!.mode).toBe("background");
  });
});

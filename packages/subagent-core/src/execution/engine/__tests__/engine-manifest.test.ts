// engine-manifest.test.ts —— parseCapabilities 旧格式 warn 回退语义（workflow-architecture-
// redesign P7 验收条款 c 的最小用例：SDK 侧不演练 manifest 回退，回退断言归属本测试域）。
// 覆盖三路回退：段缺失/坏型 = 全保守；缺键/坏值 = 该键保守；未知键 = 忽略（additive
// 友好——引擎新增能力位时旧解析器不炸，协议演进宪法 C2 的依赖前提）。
// 纯函数测试，零 fs 触点。

import { describe, expect, it } from "vitest";

import { CONSERVATIVE_CAPABILITIES, parseCapabilities } from "../engine-manifest.ts";
import type { EngineCapabilities } from "../types.ts";

const FULL_VALID: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "native",
  conversation: "native",
  personaInjection: "file",
  eventGranularity: "stream",
  sandbox: "native",
  sessionRead: "full",
  resume: "native",
  interrupt: "native",
  permissionMode: "native",
  maxTurns: true,
};

describe("parseCapabilities 旧格式 warn 回退（P7 验收 c）", () => {
  it("段缺失 = 全保守回退（不抛错）", () => {
    expect(parseCapabilities("e1", undefined)).toEqual(CONSERVATIVE_CAPABILITIES);
    expect(parseCapabilities("e1", null)).toEqual(CONSERVATIVE_CAPABILITIES);
  });

  it("缺键 = 该键保守回退，其余键照常解析", () => {
    const { maxTurns: _dropped, ...partial } = FULL_VALID;
    const out = parseCapabilities("e1", partial);
    expect(out.maxTurns).toBe(false);
    expect(out.schemaEnforcement).toBe("native");
    expect(out.sessionRead).toBe("full");
  });

  it("未知键 = 忽略不炸（additive 友好：新能力位对旧解析器安全）", () => {
    const out = parseCapabilities("e1", { ...FULL_VALID, futureAxis: "native" });
    expect(out).toEqual(FULL_VALID);
    expect("futureAxis" in out).toBe(false);
  });
});

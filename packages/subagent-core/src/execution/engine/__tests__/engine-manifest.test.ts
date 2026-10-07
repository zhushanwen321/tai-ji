// engine-manifest.test.ts —— parseCapabilities 旧格式 warn 回退语义（workflow-architecture-
// redesign P7 验收条款 c 的最小用例：SDK 侧不演练 manifest 回退，回退断言归属本测试域）。
// 覆盖三路回退：段缺失/坏型 = 全保守；缺键/坏值 = 该键保守；未知键 = 忽略（additive
// 友好——引擎新增能力位时旧解析器不炸，协议演进宪法 C2 的依赖前提）。
// 纯函数测试，零 fs 触点。

import { describe, expect, it, vi } from "vitest";

import { CONSERVATIVE_CAPABILITIES, parseCapabilities, parseProcessModel } from "../engine-manifest.ts";
import type { EngineCapabilities } from "../types.ts";

// [teardown 竞态修复] 被测链（parseCapabilities/parseProcessModel 回退路径）的 logger 输出
// 经 console 落 stderr，本文件用例全同步——刷写只能落在文件结束的 teardown 窗口，与
// worker rpc 关闭竞态 → vitest EnvironmentTeardownError（onUserConsoleLog pending）
// → run 退出码 1。本文件对 logger 零断言依赖，mock 静默（rebuild-indexes.test.ts 同款先例）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

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
  // [subagent-model-switch] setModel 新轴（CAPABILITY_ENUMS 词表已收，fixture 全键跟随）。
  setModel: "native",
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

// processModel 解析（pi-workflow-run-resource-model §3.3 决策 3 / 单元 U0 验收 1）：
// 进程形态不是任务能力，不走 CAPABILITY_ENUMS 词表——缺省与非法值都归一 'per-window'
// （宿主实例管理分流读位：per-window → 窗口作用域实例，shared-service → registry 单例）。
describe("parseProcessModel 缺省回落（U0 验收：缺省按 per-window 分流）", () => {
  it("缺省（未声明）= per-window；显式两枚举值原样解析", () => {
    expect(parseProcessModel("e1", undefined)).toBe("per-window");
    expect(parseProcessModel("e1", "per-window")).toBe("per-window");
    expect(parseProcessModel("e1", "shared-service")).toBe("shared-service");
  });

  it("非法值（错别字/非串/空串）= warn 回落 per-window（包仍可用）", () => {
    expect(parseProcessModel("e1", "per_window")).toBe("per-window");
    expect(parseProcessModel("e1", "shared")).toBe("per-window");
    expect(parseProcessModel("e1", 42)).toBe("per-window");
    expect(parseProcessModel("e1", "")).toBe("per-window");
    expect(parseProcessModel("e1", null)).toBe("per-window");
  });
});

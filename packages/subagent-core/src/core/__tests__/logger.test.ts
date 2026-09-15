// logger.test.ts —— core log facade 的时序契约（D2「解析时机契约」的直接守护）。
//
// 核心场景：模块顶层 `const logger = getLogger(...)` 缓存惯例（切面内 30 处既有形态）
// 下，configureCore 前后透明切换——facade 每次方法调用动态解析宿主实现，无模块加载
// 顺序依赖。另覆盖：缺省 console 行为、singleton 缓存惯例、level 逐字透传。

import { afterEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../host-services.ts";
import { getLogger } from "../logger.ts";

// 模块顶层缓存 facade——复刻既有惯例的加载形态：加载期 getLogger，此时宿主必然未
// 配置。下面的时序契约用例证明：配置后该引用无需重建即路由到宿主实现。
const topLevelLogger = getLogger("top-level-comp");

afterEach(() => {
  vi.restoreAllMocks();
  resetCoreForTests();
});

describe("facade 顶层缓存惯例 + configureCore 前后透明切换（时序契约）", () => {
  it("顶层缓存的 logger：配置前落缺省 console，配置后同一引用路由到宿主实现", () => {
    // 1) configureCore 前：facade 调用落缺省 console（warn 通道）。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    topLevelLogger.warn("before-configure", { stage: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toBe("[top-level-comp] before-configure");
    expect(warnSpy.mock.calls[0][1]).toEqual({ stage: 1 });

    // 2) configureCore：宿主 log 接线（模拟宿主壳初始化时点，晚于本模块加载）。
    const hostLog = vi.fn<HostServices["log"]>();
    configureCore({ dataRoot: () => "/host/root", log: hostLog });

    // 3) 同一引用（未重建、未重新 getLogger）调用即刻路由到宿主实现——无模块加载
    //    顺序依赖；console 缺省出口不再被消费。
    topLevelLogger.warn("after-configure");
    topLevelLogger.error("fatal-after-configure", { code: 7 });
    expect(hostLog).toHaveBeenCalledWith("warn", "top-level-comp", "after-configure", undefined);
    expect(hostLog).toHaveBeenCalledWith("error", "top-level-comp", "fatal-after-configure", {
      code: 7,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1); // 配置后不再增长
  });

  it("debug 也经同一动态解析链路（配置前 no-op、配置后路由宿主）", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    topLevelLogger.debug("dbg-before");
    expect(logSpy).not.toHaveBeenCalled(); // 缺省 no-op

    const hostLog = vi.fn<HostServices["log"]>();
    configureCore({ dataRoot: () => "/host/root", log: hostLog });
    topLevelLogger.debug("dbg-after");
    expect(hostLog).toHaveBeenCalledWith("debug", "top-level-comp", "dbg-after", undefined);
  });
});

describe("getLogger", () => {
  it("同 component 返回同一引用（singleton 缓存惯例，对齐 pi-extension-logger）", () => {
    expect(getLogger("same-comp")).toBe(getLogger("same-comp"));
  });

  it("不同 component 返回不同 facade", () => {
    expect(getLogger("comp-a")).not.toBe(getLogger("comp-b"));
  });

  it("level/component/message/data 四参逐字透传宿主（调用面等价替换的前提）", () => {
    const hostLog = vi.fn<HostServices["log"]>();
    configureCore({ dataRoot: () => "/host/root", log: hostLog });

    const logger = getLogger("pass-through-comp");
    logger.debug("m1", { a: 1 });
    logger.warn("m2");
    logger.error("m3", null);
    expect(hostLog).toHaveBeenNthCalledWith(1, "debug", "pass-through-comp", "m1", { a: 1 });
    expect(hostLog).toHaveBeenNthCalledWith(2, "warn", "pass-through-comp", "m2", undefined);
    expect(hostLog).toHaveBeenNthCalledWith(3, "error", "pass-through-comp", "m3", null);
  });
});

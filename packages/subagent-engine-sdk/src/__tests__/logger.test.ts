// src/__tests__/logger.test.ts
//
// logger facade 缺省 console 出口（CONSOLE_SINK）行为面：warn/error 落 console
// 且 data 缺省时省略第二参数（node console 会把显式 undefined 格式化成
// " undefined" 尾巴）、debug 未配置期 no-op（对齐 core NULL_HOST 语义）；
// configureLoggerSink 后透明切换，data 参数透传 sink。
// primitives.test.ts 已覆盖「先缓存后配置」时序契约，本文件只补缺省出口分支。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureLoggerSink,
  getLogger,
  resetLoggerSinkForTests,
  type LoggerSink,
} from "../logger.ts";

describe("logger 缺省 console 出口（未注入 sink）", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLoggerSinkForTests();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetLoggerSinkForTests();
  });

  it("warn/error 落 console（data 缺省省略第二参数），debug no-op 不刷 console", () => {
    const logger = getLogger("sdk-console-test");
    logger.debug("quiet during bootstrap");
    logger.error("boom");
    logger.error("boom-with-data", { code: 1 });
    logger.warn("careful");
    logger.warn("careful-with-data", { code: 2 });

    // mock.calls 全量断言：调用次数与逐次参数（含 data 缺省省略第二参数的形态）一并锁定
    expect(errorSpy.mock.calls).toEqual([
      ["[sdk-console-test] boom"],
      ["[sdk-console-test] boom-with-data", { code: 1 }],
    ]);
    expect(warnSpy.mock.calls).toEqual([
      ["[sdk-console-test] careful"],
      ["[sdk-console-test] careful-with-data", { code: 2 }],
    ]);
  });

  it("configureLoggerSink 覆盖式注入后 debug/error/warn 全量透传 sink（含 data）", () => {
    const seen: Array<{ level: string; component: string; msg: string; data: unknown }> = [];
    const sink: LoggerSink = {
      log(level, component, message, data) {
        seen.push({ level, component, msg: message, data });
      },
    };
    configureLoggerSink(sink);
    const logger = getLogger("sdk-sink-test");
    logger.debug("d", { trace: 1 });
    logger.error("e");
    expect(seen).toEqual([
      { level: "debug", component: "sdk-sink-test", msg: "d", data: { trace: 1 } },
      { level: "error", component: "sdk-sink-test", msg: "e", data: undefined },
    ]);
    // 覆盖式注入：后一次 configure 生效（前一次 sink 不再收到——seen 仍只有前两条）
    const second: LoggerSink = { log() {} };
    configureLoggerSink(second);
    logger.warn("w");
    expect(seen.map((s) => s.msg)).toEqual(["d", "e"]);
  });

  it("resetLoggerSinkForTests：清空配置态后回落缺省 console 出口", () => {
    configureLoggerSink({ log() {} });
    resetLoggerSinkForTests();
    getLogger("sdk-reset-test").warn("back to console");
    expect(warnSpy).toHaveBeenCalledWith("[sdk-reset-test] back to console");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

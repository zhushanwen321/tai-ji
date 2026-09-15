// host-services.test.ts —— HostServices 配置态 / NULL_HOST 降级 / DEFAULT_DATA_ROOT。
//
// 三视角：①构建者——configureCore 覆盖语义与 getHostServices 解析；②使用者——
// 未配置消费 dataRoot 得到可操作错误（core_host_not_configured + 恢复指引关键词，
// 设计 §3.4 错误规格）；③观察者——NULL_HOST 日志落缺省 console（warn/error），
// discoveryRoots 可选端口缺席为 undefined，DiscoveryRoot.source 标签原样透传。

import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCore,
  DEFAULT_DATA_ROOT,
  getHostServices,
  resetCoreForTests,
  type DiscoveryRoot,
  type HostServices,
} from "../host-services.ts";

beforeEach(() => {
  resetCoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCoreForTests();
});

function makeHost(overrides: Partial<HostServices> = {}): HostServices {
  return {
    dataRoot: () => "/data/root",
    log: () => {},
    ...overrides,
  };
}

describe("getHostServices（未配置 → NULL_HOST）", () => {
  it("消费 dataRoot 抛错，message 含 core_host_not_configured", () => {
    expect(() => getHostServices().dataRoot()).toThrowError("core_host_not_configured");
  });

  it("错误文案含恢复指引：configureCore 调用时机 + pi 壳 / zsw 壳接入示例落点", () => {
    try {
      getHostServices().dataRoot();
      expect.unreachable("dataRoot must throw before configureCore");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("core_host_not_configured");
      expect(msg).toContain("configureCore");
      expect(msg).toContain("pi-host.ts");
      expect(msg).toContain("README");
    }
  });

  it("log warn → console.warn，error → console.error，带 [component] 前缀", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = getHostServices();

    host.log("warn", "comp-a", "w-message", { k: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toBe("[comp-a] w-message");
    expect(warnSpy.mock.calls[0][1]).toEqual({ k: 1 });
    expect(errorSpy).not.toHaveBeenCalled();

    host.log("error", "comp-a", "e-message");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toBe("[comp-a] e-message");
  });

  it("data 缺省时省略第二参数（node console 会把显式 undefined 打成尾巴）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getHostServices().log("warn", "comp-a", "bare");
    expect(warnSpy.mock.calls[0].length).toBe(1);
  });

  it("debug 缺省 no-op（对齐 pi-extension-logger debug 默认 no-op 语义）", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getHostServices().log("debug", "comp-a", "d-message");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("discoveryRoots 为 undefined（可选端口缺席）", () => {
    expect(getHostServices().discoveryRoots).toBeUndefined();
  });
});

describe("configureCore", () => {
  it("配置后 dataRoot / log 路由到宿主实现", () => {
    const logSpy = vi.fn<HostServices["log"]>();
    configureCore(makeHost({ dataRoot: () => "/host/root", log: logSpy }));

    const host = getHostServices();
    expect(host.dataRoot()).toBe("/host/root");
    host.log("warn", "comp", "msg", { x: 2 });
    expect(logSpy).toHaveBeenCalledWith("warn", "comp", "msg", { x: 2 });
  });

  it("DiscoveryRoot.source 标签由宿主提供、core 原样透传（不枚举封闭集）", () => {
    const roots: DiscoveryRoot[] = [
      { dir: "/roots/npm", source: "npm" },
      { dir: "/roots/user-pi", source: "user-pi" },
      { dir: "/roots/custom-tag", source: "host-defined-anything" },
    ];
    configureCore(
      makeHost({
        discoveryRoots: () => ({ agents: roots }),
      }),
    );

    const resolved = getHostServices().discoveryRoots?.();
    expect(resolved?.agents).toEqual(roots);
    expect(resolved?.agents?.[2].source).toBe("host-defined-anything");
  });

  it("重复调用以后者覆盖（测试切宿主依赖此语义）", () => {
    const firstLog = vi.fn<HostServices["log"]>();
    const secondLog = vi.fn<HostServices["log"]>();
    configureCore(makeHost({ log: firstLog }));
    configureCore(makeHost({ log: secondLog }));

    getHostServices().log("error", "comp", "msg");
    expect(firstLog).not.toHaveBeenCalled();
    expect(secondLog).toHaveBeenCalledTimes(1);
  });

  it("resetCoreForTests 后回到未配置态（dataRoot 抛错）", () => {
    configureCore(makeHost());
    resetCoreForTests();
    expect(() => getHostServices().dataRoot()).toThrowError("core_host_not_configured");
  });
});

describe("DEFAULT_DATA_ROOT", () => {
  it("等于 ~/.subagent-core（homedir 推导，不写死绝对路径）", () => {
    expect(DEFAULT_DATA_ROOT).toBe(join(homedir(), ".subagent-core"));
    expect(DEFAULT_DATA_ROOT.startsWith(homedir())).toBe(true);
  });
});

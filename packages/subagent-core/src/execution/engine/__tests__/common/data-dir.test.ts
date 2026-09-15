// data-dir.test.ts —— dataDir 通道解析（TAIJI_AGENT_DATA_DIR 权威通道 + 宿主数据根回退）。
//
// 三视角：①构建者——两级解析顺序正确；②使用者——独立 pi 用户（无 taiji env）拿到
// 宿主数据根（pi 壳 dataRoot() = getAgentDir()）作根；③观察者——回退路径 warn 一次
// （不留静默漂移），不刷屏。
//
// 隔离（u0-data-discovery 注入化后）：fallback 值来自 HostServices.dataRoot() 端口，
// 每用例 resetCoreForTests + configureCore 假宿主控制端口态，避免跨用例泄漏；
// 不再依赖 vitest alias 的 pi-coding-agent mock。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureCore, resetCoreForTests } from "../../../../core/host-services.ts";
import {
  getEngineDataDir,
  resetDataDirWarnForTests,
  TAIJI_DATA_DIR_ENV,
} from "../../common/data-dir.ts";

const FAKE_DATA_ROOT = "/home/user/.pi/agent";

beforeEach(() => {
  resetCoreForTests();
  configureCore({
    dataRoot: () => FAKE_DATA_ROOT,
    log: () => {},
  });
  resetDataDirWarnForTests();
});

afterEach(() => {
  resetCoreForTests();
});

describe("getEngineDataDir", () => {
  it("TAIJI_AGENT_DATA_DIR 存在 → 权威通道直取，不 warn", () => {
    const warnings: string[] = [];
    const dir = getEngineDataDir({ [TAIJI_DATA_DIR_ENV]: "/data/taiji" }, (m) => warnings.push(m));
    expect(dir).toBe("/data/taiji");
    expect(warnings).toEqual([]);
  });

  it("空串/空白串视为缺失（truthy 语义与 shared getDataDir 的 || 归一对齐）", () => {
    const warnings: string[] = [];
    const dir = getEngineDataDir({ [TAIJI_DATA_DIR_ENV]: "   " }, (m) => warnings.push(m));
    expect(dir).not.toBe("   ");
    expect(warnings.length).toBe(1);
  });

  it("缺 env → 回退宿主数据根（HostServices.dataRoot()，假宿主值）并 warn 一次", () => {
    const warnings: string[] = [];
    const warn = (m: string): void => { warnings.push(m); };
    const dir1 = getEngineDataDir({}, warn);
    expect(dir1).toBe(FAKE_DATA_ROOT);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("TAIJI_AGENT_DATA_DIR");

    // warn once：第二次调用不再刷
    const dir2 = getEngineDataDir({}, warn);
    expect(dir2).toBe(dir1);
    expect(warnings.length).toBe(1);
  });

  it("reset 后再次回退会重新 warn（测试隔离钩子可用）", () => {
    const warnings: string[] = [];
    getEngineDataDir({}, (m) => warnings.push(m));
    resetDataDirWarnForTests();
    getEngineDataDir({}, (m) => warnings.push(m));
    expect(warnings.length).toBe(2);
  });

  it("未 configureCore 即消费回退段 → 抛 core_host_not_configured（端口必需语义）", () => {
    resetCoreForTests();
    expect(() => getEngineDataDir({}, (m) => warningsNoop(m))).toThrow(/core_host_not_configured/);
  });
});

function warningsNoop(_msg: string): void {}

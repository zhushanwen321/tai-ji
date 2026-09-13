// warnOnManifestDiagnostics 单元测试（models 声明空占位跳过 / 真漂移不吞）。
//
// 纯函数直测不 spawn 引擎；logger 经 configureLoggerSink 注入捕获 warn，
// afterEach resetLoggerSinkForTests 还原（不污染其它测试文件的 console 出口）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configureLoggerSink,
  resetLoggerSinkForTests,
  type EngineCapabilities,
  type InitializeResult,
  type LoggerSink,
  type ModelCatalogEntry,
} from "@zhushanwen/subagent-engine-sdk";

import { warnOnManifestDiagnostics } from "../client-options.ts";

const CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "native",
  conversation: "native",
  personaInjection: "file",
  eventGranularity: "coarse",
  sandbox: "native",
  sessionRead: "partial",
  resume: "native",
  interrupt: "native",
  permissionMode: "native",
  maxTurns: true,
};

function makeResult(models?: ModelCatalogEntry[] | null): InitializeResult {
  return {
    protocolVersion: 1,
    engineId: "fake",
    engineVersion: "1.0.0",
    adapterVersion: "1.0.0",
    capabilities: CAPABILITIES,
    ...(models !== undefined ? { models } : {}),
  };
}

const warns: string[] = [];

const captureSink: LoggerSink = {
  log(level, _component, message) {
    if (level === "warn") warns.push(message);
  },
};

beforeEach(() => {
  warns.length = 0;
  configureLoggerSink(captureSink);
});

afterEach(() => {
  resetLoggerSinkForTests();
});

describe("warnOnManifestDiagnostics models 分支", () => {
  it("声明侧空占位（null/undefined/[]）跳过比对：应答空值形态差异不 warn", () => {
    warnOnManifestDiagnostics("fake", { models: null }, makeResult(null));
    warnOnManifestDiagnostics("fake", { models: null }, makeResult([]));
    warnOnManifestDiagnostics("fake", { models: [] }, makeResult(null));
    warnOnManifestDiagnostics("fake", { models: [] }, makeResult());
    expect(warns).toHaveLength(0);
  });

  it("声明侧非空而应答为空仍 warn（真漂移不吞）", () => {
    warnOnManifestDiagnostics("fake", { models: [{ id: "m1" }] }, makeResult(null));
    warnOnManifestDiagnostics("fake", { models: [{ id: "m1" }] }, makeResult([]));
    expect(warns).toHaveLength(2);
    expect(warns.every((m) => m.includes("models differ from manifest"))).toBe(true);
  });

  it("声明侧非空时内容比对行为保留：等价不 warn、不等价 warn", () => {
    warnOnManifestDiagnostics("fake", { models: [{ id: "m1" }] }, makeResult([{ id: "m1" }]));
    expect(warns).toHaveLength(0);
    warnOnManifestDiagnostics("fake", { models: [{ id: "m1" }] }, makeResult([{ id: "m2" }]));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("models differ from manifest");
  });
});

// src/__tests__/transport-selection.test.ts
//
// [m-core-4 / m-core-5] transport 选择谓词单源 + GUI widget 抑制 + local 回落日志级别。
//
// 覆盖：
//   - usesRuntimeTransport：control env 非空 → runtime；空串/缺失 → local；
//     D9 逃生舱（TAIJI_SUBAGENT_TRANSPORT=local，trim）优先；非法值不改变谓词。
//   - createBackgroundStream：GUI + runtime transport → 抑制（runtime tee 供数）；
//     GUI + control env + D9 forced local → 创建（本地 spawn 无 fd3/tee，恢复 widget）；
//     GUI + 非托管 → 创建；TUI + 托管 → 创建；sink=null → 不创建。
//   - EngineClient.resolveTransport：缺省 local 回落 warn（设计 D5 字面）；D9 forced
//     local warn；runtime transport debug（不 warn）。

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getLogger as sdkGetLogger } from "@zhushanwen/subagent-engine-sdk";
import { EngineClient } from "../execution/engine/client/engine-client.ts";
import {
  SUBAGENT_TRANSPORT_ENV,
  isForcedLocalTransport,
  usesRuntimeTransport,
} from "../execution/engine/client/transport-selection.ts";
import { SubagentStream, createBackgroundStream } from "../execution/assembly/stream-sink.ts";

const CONTROL_SOCKET = "TAIJI_SUBAGENT_CONTROL_SOCKET";
const CONTROL_ON = { [CONTROL_SOCKET]: "/tmp/transport-selection.sock" };
const sink = { setWidget: vi.fn() };
/** engine-client 的 logger 来自 SDK facade（同一 component 单例）；spyOn 即拦截。 */
const subagentsLogger = sdkGetLogger("subagents");

describe("[m-core-4] usesRuntimeTransport：实际 transport 选择单源", () => {
  it("control env 非空 → runtime；空串/缺失 → local", () => {
    expect(usesRuntimeTransport(CONTROL_ON)).toBe(true);
    expect(usesRuntimeTransport({ [CONTROL_SOCKET]: "" })).toBe(false);
    expect(usesRuntimeTransport({})).toBe(false);
  });

  it("D9 逃生舱优先：control env 非空 + TAIJI_SUBAGENT_TRANSPORT=local → local", () => {
    const env = { ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: "local" };
    expect(isForcedLocalTransport(env)).toBe(true);
    expect(usesRuntimeTransport(env)).toBe(false);
    // trim 语义：带空白的 local 同样生效
    expect(usesRuntimeTransport({ ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: " local " })).toBe(false);
  });

  it("非法值不改变默认谓词", () => {
    expect(usesRuntimeTransport({ ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: "runtime" })).toBe(true);
    expect(usesRuntimeTransport({ ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: "bogus" })).toBe(true);
  });
});

describe("[m-core-4] createBackgroundStream：GUI widget 抑制按实际 transport", () => {
  it("GUI + runtime transport → 不创建（runtime tee 供数）", () => {
    expect(createBackgroundStream("rec-1", sink, "rpc", CONTROL_ON)).toBeUndefined();
  });

  it("GUI + control env + D9 forced local → 创建（本地 spawn 无 fd3/tee，恢复 widget 自供）", () => {
    const stream = createBackgroundStream("rec-1", sink, "rpc", {
      ...CONTROL_ON,
      [SUBAGENT_TRANSPORT_ENV]: "local",
    });
    expect(stream).toBeInstanceOf(SubagentStream);
    stream?.dispose();
  });

  it("GUI + 非托管（无 control env）→ 创建；TUI + 托管 → 创建", () => {
    const standalone = createBackgroundStream("rec-1", sink, "rpc", {});
    expect(standalone).toBeInstanceOf(SubagentStream);
    standalone?.dispose();

    const tui = createBackgroundStream("rec-1", sink, "tui", CONTROL_ON);
    expect(tui).toBeInstanceOf(SubagentStream);
    tui?.dispose();
  });

  it("sink=null 恒不创建", () => {
    expect(createBackgroundStream("rec-1", null, "rpc", CONTROL_ON)).toBeUndefined();
    expect(createBackgroundStream("rec-1", null, "rpc", {})).toBeUndefined();
  });
});

/** resolveTransport 是 protected（测试 seam）：子类只开观测口，不改行为。 */
class ExposedEngineClient extends EngineClient {
  exposeResolveTransport(): void {
    this.resolveTransport();
  }
}

function makeClient(baseEnv: Record<string, string | undefined>): ExposedEngineClient {
  return new ExposedEngineClient({
    engineId: "selection",
    command: process.execPath,
    args: ["--never-spawned"],
    hostKind: "test",
    dataDir: join(tmpdir(), "transport-selection-no-io"),
    envPrefixes: [],
    baseEnv,
  });
}

describe("[m-core-5] transport 选择日志级别", () => {
  it("缺省 local 回落 → warn（设计 D5：空串/缺失 → local（warn））", () => {
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(() => {});
    makeClient({}).exposeResolveTransport();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("transport selected: local (no control env)"),
    );
    warnSpy.mockRestore();
  });

  it("D9 forced local → warn 留痕", () => {
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(() => {});
    makeClient({
      [CONTROL_SOCKET]: "/tmp/transport-selection.sock",
      [SUBAGENT_TRANSPORT_ENV]: "local",
    }).exposeResolveTransport();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("forcing local transport (D9 escape hatch)"),
    );
    warnSpy.mockRestore();
  });

  it("runtime transport → debug（不 warn）", () => {
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(subagentsLogger, "debug").mockImplementation(() => {});
    makeClient(CONTROL_ON).exposeResolveTransport();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("transport selected: runtime control channel"),
    );
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });
});

// contract.probe.test.ts —— conformance C1（probe 形状）：ProbeReport 字段完整；
// ok=false 时 error.recovery 非空（§3.3.5——恢复指引是错误闭环「错误→权威源→重试」
// 的载体，空指引 = 拦截了但不知道怎么修）。
//
// W10 协议黑盒化：断言对象从内建 PiEngine/ZcodeEngine（inproc，W11 删除）改为
// RemoteEngine × fake 引擎 CLI（协议 probe 帧往返）——成功/失败两形态都经协议面。
// 引擎内 probe 细节（版本探测、二进制检查）随 W5/W7 归各引擎包测试。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineClient } from "../../client/engine-client.ts";
import { RemoteEngine } from "../../client/remote-engine.ts";
import { FAKE_CAPABILITIES } from "./fake-engine-capabilities.ts";
import type { ProbeReport } from "../../types.ts";

const FAKE_ENGINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__", "engine-protocol", "fake-engine-protocol.mjs",
);
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__", "engine-protocol", "smoke-run.fixture.json",
);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w10-c1-probe-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function assertProbeShape(report: ProbeReport): void {
  expect(typeof report.ok).toBe("boolean");
  expect(typeof report.engineVersion).toBe("string");
  expect(Array.isArray(report.checks)).toBe(true);
  expect(report.checks.length).toBeGreaterThan(0);
  for (const c of report.checks) {
    expect(typeof c.name).toBe("string");
    expect(typeof c.ok).toBe("boolean");
  }
  if (!report.ok) {
    expect(report.error).toBeDefined();
    expect(report.error?.code).toBe("engine_probe_failed");
    // 恢复指引非空且指向动作（C1 断言核心——空指引直接 fail）
    expect(report.error?.recovery).toBeTruthy();
    expect(report.error?.recovery.length).toBeGreaterThan(20);
  }
}

function makeEngine(extraEnv: Record<string, string> = {}): RemoteEngine {
  const client = new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    hostVersion: "w10-c1-probe",
    dataDir,
    envPrefixes: [],
    baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE, ...extraEnv },
  });
  return new RemoteEngine({
    engineId: "fake",
    client,
    manifest: { capabilities: FAKE_CAPABILITIES },
    dataDir,
    hostKind: "test",
  });
}

describe("conformance C1：probe 形状（协议黑盒：RemoteEngine × fake 引擎）", () => {
  it("成功路径：probe 帧往返 → ProbeReport 形状完整", async () => {
    const engine = makeEngine();
    try {
      const report = await engine.probe();
      assertProbeShape(report);
      expect(report.ok).toBe(true);
    } finally {
      await engine.dispose();
    }
  });

  it("失败路径（FAKE_PROBE_FAIL）：ok=false + error.recovery 非空且指向动作", async () => {
    const engine = makeEngine({ FAKE_PROBE_FAIL: "1" });
    try {
      const report = await engine.probe({ force: true });
      assertProbeShape(report);
      expect(report.ok).toBe(false);
      expect(report.error?.recovery).toContain("Reinstall");
    } finally {
      await engine.dispose();
    }
  });
});

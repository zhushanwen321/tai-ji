// zcode-engine.harvest-grace.test.ts —— HARVEST_GRACE 兜底窗的非门控单测层。
//
// 背景：崩溃收割确认窗 harvestGraceMs 的两个消费点——awaitConnFinalized 的 close
// 确认 timer 与 shutdownRuntimeAndDisposeChannel 的收割 race——此前只在集成门控档
//（zcode-engine.abort-dispose.test.ts，真实 fake-appserver 子进程）执行，门控关闭时
// 该链零覆盖。本文件用 mock 连接同形态补非门控层，断言同一契约：「close 永不到达时
// 按 HARVEST_GRACE（env 注入缝可缩短）有界返回，close 到达即提前返回」。窗口数值不是
// 被测契约（与门控档同口径），默认值另有静态断言保护（abort-dispose 验收⑤）。
//
// 白盒注入形态沿 zcode-engine.abort-dispose.test.ts「窄竞态检查」先例：runtime 字段
// 编译期私有、运行时可注入，cast 经 unknown 中转。

import { describe, expect, it, vi } from "vitest";

import { AppServerConnection } from "../connection.ts";
import { SessionChannel } from "../session-channel.ts";
import { ZcodeEngine } from "../zcode-engine.ts";
import {
  FAKE_CLI,
  dataDirPath,
  registerZcodeEngineHarness,
  tmpRootDir,
} from "./zcode-engine-harness.ts";

registerZcodeEngineHarness();

/** awaitConnFinalized / dispose 注入缝 env 键（同源常量 ZCODE_APPSERVER_HARVEST_GRACE_ENV 的字面值）。 */
const HARVEST_GRACE_ENV = "TAIJI_ZCODE_TEST_HARVEST_GRACE_MS";

/** 引擎私有方法的运行时形态（编译期 private，测试按既有先例白盒驱动）。 */
type EngineInternals = {
  awaitConnFinalized(rt: unknown): Promise<void>;
};

/** close 永不到达的 mock 连接（alive + onClose 注册通道，供白盒驱动 confirm 链）。 */
function makeNeverClosingConn(fired: { off?: () => void } = {}): {
  alive: boolean;
  onClose(fn: () => void): () => void;
} {
  return {
    alive: true,
    onClose(fn: () => void) {
      fired.off = fn;
      return () => {
        fired.off = undefined;
      };
    },
  };
}

describe("HARVEST_GRACE 兜底窗（非门控 mock 层）", () => {
  it("awaitConnFinalized：close 永不到达 → env 注入的兜底窗内有界返回（不挂死）", async () => {
    vi.stubEnv(HARVEST_GRACE_ENV, "120");
    const engine = new ZcodeEngine({ engineDataDir: () => dataDirPath() });
    const conn = makeNeverClosingConn();
    const started = Date.now();
    await (engine as unknown as EngineInternals).awaitConnFinalized({ conn });
    const elapsed = Date.now() - started;
    // 窗口 120ms 到点兜底返回；上界放宽到 2s 防负载抖动（契约 = 有界，非精确时长）
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  it("awaitConnFinalized：close 到达 → 立即返回，不等满兜底窗", async () => {
    // 窗口故意给 5s：close 在 30ms 触发，若误走 timer 路径 elapsed ≈ 5s 必超断言
    vi.stubEnv(HARVEST_GRACE_ENV, "5000");
    const engine = new ZcodeEngine({ engineDataDir: () => dataDirPath() });
    const fired: { off?: () => void } = {};
    const conn = makeNeverClosingConn(fired);
    const pending = (engine as unknown as EngineInternals).awaitConnFinalized({ conn });
    setTimeout(() => fired.off?.(), 30);
    const started = Date.now();
    await pending;
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("dispose：进程从未 spawn（close 永不到达）→ 收割 race 输给兜底窗后有界返回", async () => {
    // 形态同门控档「窄竞态检查」：runtime.conn 无活进程，channel.dispose 兜底收割在途 turn。
    // 区别：本用例断言 dispose 全链时长受 HARVEST_GRACE 约束（race 兜底路径的契约）。
    vi.stubEnv(HARVEST_GRACE_ENV, "120");
    const engine = new ZcodeEngine({
      engineDataDir: () => dataDirPath(),
      cliPath: FAKE_CLI,
      processEnv: { PATH: process.env.PATH ?? "" },
    });
    const conn = new AppServerConnection({
      cliPath: FAKE_CLI,
      cwd: tmpRootDir(),
      env: { PATH: process.env.PATH ?? "" },
      stderrLogPath: `${dataDirPath()}/harvest-grace-stderr.log`,
    });
    (engine as unknown as { appserverRuntime: unknown }).appserverRuntime = {
      conn,
      channel: new SessionChannel(conn),
      activeSessions: new Set<string>(["sess_harvest"]),
    };
    expect(conn.alive).toBe(false); // 前置：无活进程（close 永不到达的形态前提）
    const started = Date.now();
    await engine.dispose();
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);
});

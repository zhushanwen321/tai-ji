// engine-crash.test.ts —— [W6/D5 前置闸] 引擎进程中途被 SIGTERM → run 终态 failed
// + 原因含信号信息（协议黑盒：真 kill 信号路径）。
//
// 设计权威源：chat-domain-v1x-liveness-governance.md §3.2 D5（消亡处置顺序约束）+
// §4 P2 探针 + 验收 A2/G3。D5 顺序约束：本用例必须先于 W3 删 `inproc pi 引擎目录/
// session-runner.ts`（旧 143 误分类器：被信号终止一律归 success=true——事故环 3
// 「死亡误报 completed」的根因载体）存在并保持绿——它把新路径语义钉成契约：
//
//   引擎进程被外部信号终止（SIGTERM）→ 在途 run 终态 **failed**（EngineSdkError
//   engine_crashed，message = "…exited unexpectedly: signal SIGTERM…" + stderr 尾
//   400 字符）→ core 上层（subagent-service adoptResumableAfterEngineDeath，W4）
//   据此走「failed 如实 + record 保持 resumable + 监督器接管」，禁 completed 谎报。
//
// 对照既有语义：
//   - 引擎侧：`pi-subagent-cli/src/spawn-runner.ts`「signal 退出 = 异常路径」
//     （agent_end 干净终结主动 kill 的 close 带信号但语义是成功，143 只属异常）——
//     W2 包内测试已承载；本用例钉宿主侧（协议客户端）对信号死亡的投影语义；
//   - 宿主侧 crash 域既有覆盖（W2 client 套件）：fake 引擎自行 exit（code 137 /
//     crash 模式）走 `exit code N` 分支；本用例覆盖 **signal 分支**
//     （`onEngineExit(null, "SIGTERM")` → detail = `signal SIGTERM`）——外部真实
//     信号（事故形态：宿主 infra 连带击杀）是 W2 套件未触达的形态；
//   - engine_crashed 错误规格：stderr 内存环形缓冲尾 400 字符（STDERR_TAIL_CHARS，
//     SDK 权威）随 message 携带——用「头标记被截断 + 尾标记保留」的窗口行为断言
//     钉死（不 import 常量复述值）。
//
// 与监督器的链路衔接（表 3 行 1 全链）见 round-liveness-supervisor.test.ts 场景一。

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineClient } from "../../client/engine-client.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "engine-protocol");
const FAKE_ENGINE = join(FIXTURE_DIR, "fake-engine-protocol.mjs");
const FIXTURE = join(FIXTURE_DIR, "smoke-run.fixture.json");

/**
 * stderr 样本（>400 字符）：头标记落 400 尾窗外（必被截断）、尾标记落窗内
 * （必保留）——stderr 尾窗行为的自证断言材料。
 */
const STDERR_SAMPLE =
  "HEAD-OF-STDERR-SAMPLE|" + "x".repeat(400) + "|TAIL-OF-STDERR-SAMPLE";

let dataDir: string;
let pidFile: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w6-engine-crash-"));
  pidFile = join(dataDir, "fake-engine.pid");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeCrashHarness(): EngineClient {
  return new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    hostVersion: "w6-engine-crash",
    dataDir,
    envPrefixes: [],
    baseEnv: {
      ...process.env,
      FAKE_PROTOCOL_FIXTURE: FIXTURE,
      FAKE_PID_FILE: pidFile,
      FAKE_RUN_STDERR_HANG: "1",
      FAKE_STDERR_SAMPLE: STDERR_SAMPLE,
    },
  });
}

/** 轮询等待 fake 引擎 pid 落盘（FAKE_PID_FILE 锚）。 */
async function waitForPidFile(): Promise<number> {
  await expect.poll(() => existsSync(pidFile), { timeout: 5_000, interval: 20 }).toBe(true);
  return Number(readFileSync(pidFile, "utf8").trim());
}

describe("[W6/D5 前置闸] 引擎进程被 SIGTERM → run 终态 failed（禁 completed 谎报）", () => {
  it("run 中途真 kill SIGTERM → engine_crashed，原因含 signal SIGTERM + stderr 尾 400 窗行为", async () => {
    if (process.platform === "win32") {
      // Windows 无 POSIX 信号语义（process.kill(SIGTERM) 行为不等价）——信号死亡
      // 形态挂真机门（A2 手动剧本杀引擎进程），本用例仅 POSIX。
      return;
    }
    const client = makeCrashHarness();
    try {
      await client.ensureConnected();
      expect(client.currentState).toBe("ready");

      // run 挂起（FAKE_RUN_STDERR_HANG 注入：stderr 样本 → host/log 到达锚 → hang）
      const runPromise = client.request("run", {
        runId: "run-sigterm-1",
        task: "w6 sigterm crash probe",
        ctx: { poolKey: "shared", cwd: dataDir, model: "fake/fake-1" },
      });

      // 确定性同步锚 ①：fake 引擎 pid 落盘（进程已起）。
      const pid = await waitForPidFile();
      // 确定性同步锚 ②：stderr 样本已入 core 环形缓冲尾（先写后杀——事件竞争
      // 面收窄为「已积累样本后 kill」，stderr 尾断言不靠 sleep 赌时序）。
      await expect
        .poll(() => client.stderrTailText.includes("TAIL-OF-STDERR-SAMPLE"), {
          timeout: 5_000,
          interval: 20,
        })
        .toBe(true);

      // 事故形态复现：外部直接 SIGTERM 引擎进程（宿主 infra 连带击杀等价物）。
      process.kill(pid, "SIGTERM");

      // 钉死语义：run 终态 failed（engine_crashed）+ 原因含信号信息——
      // 旧 143 误分类器（inproc session-runner（已删）:2667-2677，W3 删）的反命题：
      // 信号死亡绝不允许投影为 success/completed。
      const err = (await runPromise.catch((e: Error) => e)) as Error & {
        code?: string;
        data?: { stderrTail?: string };
      };
      expect(err).toMatchObject({
        name: "EngineSdkError",
        code: "engine_crashed",
      });
      expect(err.message).toContain("engine process exited unexpectedly: signal SIGTERM");
      // engine_crashed 错误规格：stderr 尾 400 字符随 message——尾标记保留。
      expect(err.message).toContain("TAIL-OF-STDERR-SAMPLE");
      // 窗口行为自证：头标记（400 字符窗外）已被截断——「尾 400」非「全量」。
      expect(err.message).not.toContain("HEAD-OF-STDERR-SAMPLE");
      // 结构化 data.stderrTail 与 message 尾部同源（SDK engineCrashedError 契约）。
      expect(err.data?.stderrTail).toContain("TAIL-OF-STDERR-SAMPLE");

      // 死亡后状态：exited（非 unavailable——下次 run 走重建退避链，W2 套件已测）。
      expect(client.currentState).toBe("exited");
    } finally {
      // 幂等收口：进程已死，dispose 不悬挂（killAll/dispose 对已死进程的空操作面）。
      await expect(client.dispose()).resolves.toBeUndefined();
    }
  });
});

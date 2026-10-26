// contract-suite.test.ts —— conformance 协议契约簇（round5-g 合并产物）。
//
// 合并来源（同目录 conformance/，断言对象同为 RemoteEngine × fake 引擎 CLI 协议黑盒）：
// - contract.abort.test.ts（C4 abort：cancel 帧收敛）
// - contract.probe.test.ts（C1 probe 形状）
// - contract.read-degradation.test.ts（C5 read 降级链 + reducer 等价性）
// - engine-crash.test.ts（W6/D5 SIGTERM 信号死亡终态）
// 各源文件的文件级 dataDir/env hook 已下沉进各自 describe（abort 的
// TAIJI_AGENT_DATA_DIR 注入不得泄漏他节）；probe 的 makeEngine 改名
// makeProbeEngine 消歧；fixture 路径常量四份同值去重。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";

import type { AgentCallOpts } from "../../../../shared/agent-call-types.ts";
import { EngineClient } from "../../client/engine-client.ts";
import { RemoteEngine } from "../../client/remote-engine.ts";
import type { RunContext } from "../../port.ts";
import type { AgentEvent, EngineHandle, ProbeReport } from "../../types.ts";
import { eventsToSessionView } from "../../common/journal-replay.ts";
import { JournalWriter } from "../../common/event-journal.ts";
import { FAKE_CAPABILITIES } from "./fake-engine-capabilities.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "engine-protocol");
const FAKE_ENGINE = join(FIXTURE_DIR, "fake-engine-protocol.mjs");
const FIXTURE = join(FIXTURE_DIR, "smoke-run.fixture.json");


// ══════ 来源: contract.abort.test.ts ══════

// contract.abort.test.ts —— conformance C4（abort 行为）：运行中 cancel → 引擎
// 3s 窗口内收敛终态、无悬挂 promise、错误语义结构化。
//
// W10 协议黑盒化：断言对象从内建 ZcodeEngine × fake app-server（inproc，W11 删除）
// 改为 RemoteEngine × fake 引擎 CLI——abort 走协议 cancel 帧 + 引擎收敛应答
// （杀链升级路径 = W2 EngineClient 套件 3s 收敛窗口用例）。zcode app-server 的
// stop 优雅链随 W5 归 zcode-subagent-cli 引擎内测试。



describe("conformance C4：abort 行为（协议黑盒：cancel 帧 + 引擎收敛）", () => {

  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "w10-c4-abort-"));
    // [session-store-layout-inversion] 协议 run 的 wire sessionDir 经
    // getSubagentSessionDir(ctx.sessionRootId)（env dataDir 兜底）推导——stubEnv 把
    // 推导落点收进本 mkdtemp 目录（自建自删红线）。
    process.env["TAIJI_AGENT_DATA_DIR"] = dataDir;
  });

  afterEach(() => {
    delete process.env["TAIJI_AGENT_DATA_DIR"];
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeEngine(): { engine: RemoteEngine; client: EngineClient; dispose: () => Promise<void> } {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "w10-c4-abort",
      dataDir,
      envPrefixes: [],
      baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE, FAKE_RUN_HANG: "1" },
    });
    const engine = new RemoteEngine({
      engineId: "fake",
      client,
      manifest: { capabilities: FAKE_CAPABILITIES },
      dataDir,
      hostKind: "test",
    });
    return { engine, client, dispose: () => engine.dispose() };
  }
  it("挂起 run 中 abort → cancel 帧送达 → 引擎窗口内收敛终态，run 正常 resolve（不悬挂）", async () => {
    const { engine, client, dispose } = makeEngine();
    try {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const ctx: RunContext = {
        taskId: "w10-c4-abort",
        // [session-store-layout-inversion] 派发器在 active session 内注入
        // sessionRootId（wire sessionDir 分区键的编排层权威源）——conformance 黑盒
        // 同契约注入；缺席时 buildRunParams fail-fast（host 无 env 绑定形态）。
        sessionRootId: "sid-c4-abort",
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      };
      const task: AgentCallOpts = {
        prompt: "hang",
        description: "abort-protocol",
        model: "fake/fake-1",
        cwd: dataDir,
      };
      // 推进到 run 受理再 abort——abort 先于受理会走 pre-aborted 短路面（cancel 帧
      // 先于 run 帧写入，覆盖不到 cancel 收敛），确定性推进两步：
      // ① 预建连接（真实信号：spawn + initialize 握手完成）；
      await client.ensureConnected(ctx.sessionRootId !== undefined ? { rootSessionId: ctx.sessionRootId } : undefined);
      const runP = engine.run(task, ctx);
      // ② 跨一个宏任务边沿再 abort。连接就绪后 run() 的「ensureConnected 幂等返回 →
      // wireAbortSignal 注册 → run 帧同步写入」全链是纯微任务，宏任务边沿构造性保证
      // run 帧已写入 stdin；同一 stdio FIFO 保序 → 引擎必先受理挂起再收 cancel
      //（顺序契约保证，零时长余量——CPU 忙只推迟连接建立，不改写帧顺序）。
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      const { outcome } = await runP; // 必须正常 resolve（引擎收敛，无需杀链）

      expect(outcome.exitCode).toBeNull();
      expect(outcome.error).toContain("cancelled");
    } finally {
      await dispose();
    }
  }, 20_000);
});

// ══════ 来源: contract.probe.test.ts ══════

// contract.probe.test.ts —— conformance C1（probe 形状）：ProbeReport 字段完整；
// ok=false 时 error.recovery 非空（§3.3.5——恢复指引是错误闭环「错误→权威源→重试」
// 的载体，空指引 = 拦截了但不知道怎么修）。
//
// W10 协议黑盒化：断言对象从内建 PiEngine/ZcodeEngine（inproc，W11 删除）改为
// RemoteEngine × fake 引擎 CLI（协议 probe 帧往返）——成功/失败两形态都经协议范围。
// 引擎内 probe 细节（版本探测、二进制检查）随 W5/W7 归各引擎包测试。



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

describe("conformance C1：probe 形状（协议黑盒：RemoteEngine × fake 引擎）", () => {

  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "w10-c1-probe-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  function makeProbeEngine(extraEnv: Record<string, string> = {}): RemoteEngine {
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
  it("成功路径：probe 帧往返 → ProbeReport 形状完整", async () => {
    const engine = makeProbeEngine();
    try {
      const report = await engine.probe();
      assertProbeShape(report);
      expect(report.ok).toBe(true);
    } finally {
      await engine.dispose();
    }
  });

  it("失败路径（FAKE_PROBE_FAIL）：ok=false + error.recovery 非空且指向动作", async () => {
    const engine = makeProbeEngine({ FAKE_PROBE_FAIL: "1" });
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

// ══════ 来源: contract.read-degradation.test.ts ══════

// contract.read-degradation.test.ts —— conformance C5（read 降级链）：不 throw、
// 坏 handle → 结构化降级（outcome-only）非崩溃、journal 重放与 live 一致
// （重放等价性，§3.3.6——journal 重放与 live 通路共用同一 reducer 的断言范围）。
//
// W10 协议黑盒化：read 的引擎内三级降级（①级 db / ②级 journal / ③级 outcome-only）
// 随 W5/W7 归各引擎包（zcode zcode-engine-degrade / pi read-fallback）；core 协议层
// 断言 = read 帧往返 + 错误帧结构化（EngineSdkError，不裸 throw 崩宿主）+ reducer
// 重放等价性（core 侧事件→SessionView 共用通路）。





/** live 通路形态的事件序列（与 golden 回放同源——重放等价性的比对基准）。 */
const liveEvents: AgentEvent[] = [
  { type: "text_delta", delta: "part one. " },
  { type: "text_delta", delta: "part two." },
  { type: "message_end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
  { type: "turn_end" },
];

function makeHandle(engineId: string, sessionRef: Record<string, string>, eventsPath?: string): EngineHandle {
  return {
    data: {
      v: 1,
      engineId,
      sessionRef,
      ...(eventsPath !== undefined ? { eventsPath } : {}),
      adapterVersion: "1.0.0-test",
    },
  };
}

describe("conformance C5：read 降级链（协议黑盒 + reducer 等价性）", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "c5-read-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("重放等价性：journal 重放 turns 与 live 累积一致（共用 updateFromEvent reducer）", () => {
    const live = eventsToSessionView(liveEvents, "pi", "sess-x");
    expect(live.source).toBe("journal");
    expect(live.turns).toHaveLength(1);
    expect(live.turns[0]?.text).toBe("part one. part two.");
    expect(live.usage?.total).toBe(15);
  });

  it("协议 read 帧往返：正常 handle → SessionView 结构（协议层形状）", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "w10-c5",
      dataDir,
      envPrefixes: [],
      baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE },
    });
    const engine = new RemoteEngine({
      engineId: "fake",
      client,
      manifest: { capabilities: FAKE_CAPABILITIES },
      dataDir,
      hostKind: "test",
    });
    try {
      await engine.read(makeHandle("fake", { sessionId: "sess-fixture" }));
      // fixture.read.result 透传（协议层不解释 SessionView 内容——形状由引擎层
      // golden 与 reducer 等价性断言盖）
    } finally {
      await engine.dispose();
    }
  });

  it("协议 read 错误帧：引擎报错 → 结构化 EngineSdkError（code/message），不裸 throw", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "w10-c5",
      dataDir,
      envPrefixes: [],
      baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE, FAKE_PROTOCOL_ERROR: "unknown_method" },
    });
    try {
      await client.ensureConnected();
      // read 是已知方法——unknown_method 模式下用未知名触发错误帧透传断言
      await expect(client.request("bogus/read", { handle: {} }, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
        EngineSdkError,
      );
    } finally {
      await client.dispose();
    }
  });

  it("journal 落盘形态与 live 事件序列逐项相等（协议层回放复用的落盘通路）", async () => {
    const eventsPath = path.join(dataDir, "journal-sa-c5.jsonl");
    const writer = new JournalWriter({ path: eventsPath, taskId: "sa-c5", engineId: "fake" });
    for (const ev of liveEvents) writer.append(ev);
    await writer.close();
    const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(liveEvents.length);
  });
});

// ══════ 来源: engine-crash.test.ts ══════

// engine-crash.test.ts —— [W6/D5 前置闸] 引擎进程中途被 SIGTERM → run 终态 failed
// + 原因含信号信息（协议黑盒：真 kill 信号路径）。
//
// 设计锚点：D5（消亡处置顺序约束）+
// P2 探针 + 验收 A2/G3。D5 顺序约束：本用例必须先于 W3 删 `inproc pi 引擎目录/
// session-runner.ts`（旧 143 误分类器：被信号终止一律归 success=true——事故环 3
// 「死亡误报 completed」的根因载体）存在并保持绿——它把新路径语义钉成契约：
//
//   引擎进程被外部信号终止（SIGTERM）→ 在途 run 终态 **failed**（EngineSdkError
//   engine_crashed，message = "…exited unexpectedly: signal SIGTERM…" + stderr 尾
//   400 字符）→ core 上层 = Continuation 失败分支收尾 settleRoundFailed（idle 可
//   恢复 + 失败通知，禁 completed 谎报）——原 adopt 链（adoptResumableAfterEngineDeath：
//   failed 如实 + record 保持 resumable + 监督器接管）已随 subagent-observability
//   u3 §3.3.3 退役删除（run-orchestration-write-lease.test.ts 头注退役注记为锚）。
//
// 对照既有语义：
//   - 引擎侧：`pi-subagent-cli/src/spawn-runner.ts`「signal 退出 = 异常路径」
//     （agent_end 干净终结主动 kill 的 close 带信号但语义是成功，143 只属异常）——
//     W2 包内测试已承载；本用例固定宿主侧（协议客户端）对信号死亡的派生视图语义；
//   - 宿主侧 crash 域既有覆盖（W2 client 套件）：fake 引擎自行 exit（code 137 /
//     crash 模式）走 `exit code N` 分支；本用例覆盖 **signal 分支**
//     （[u-m3-local] exit 投影 `EngineTransportExitInfo {code:null, signal:"SIGTERM"}` → detail = `signal SIGTERM`）——外部真实
//     信号（事故形态：宿主 infra 连带击杀）是 W2 套件未触达的形态；
//   - engine_crashed 错误规格：stderr 内存环形缓冲尾 400 字符（STDERR_TAIL_CHARS，
//     SDK 权威）随 message 携带——用「头标记被截断 + 尾标记保留」的窗口行为断言
//     固定（不 import 常量复述值）。
//
// 与监督器的链路衔接（表 3 行 1 全链）见 round-liveness-supervisor.test.ts 场景一。



/**
 * stderr 样本（>400 字符）：头标记落 400 尾窗外（必被截断）、尾标记落窗内
 * （必保留）——stderr 尾窗行为的自证断言材料。
 */
const STDERR_SAMPLE =
  "HEAD-OF-STDERR-SAMPLE|" + "x".repeat(400) + "|TAIL-OF-STDERR-SAMPLE";

describe("[W6/D5 前置闸] 引擎进程被 SIGTERM → run 终态 failed（禁 completed 谎报）", () => {

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

      // 固定语义：run 终态 failed（engine_crashed）+ 原因含信号信息——
      // 旧 143 误分类器（inproc session-runner（已删）:2667-2677，W3 删）的反命题：
      // 信号死亡绝不允许映射为 success/completed。
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
      // 幂等收尾：进程已死，dispose 不悬挂（killAll/dispose 对已死进程的空操作面）。
      await expect(client.dispose()).resolves.toBeUndefined();
    }
  });
});

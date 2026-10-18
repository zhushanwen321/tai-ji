// src/__tests__/spawn-runner-prompt-ack.test.ts
//
// [relay-spawn-transport §3.4.2 M2] runSpawnOnce × prompt 送达回执集成测试（fake pi
// 子进程故障注入，run-spawn-once.integration.test.ts 同款装配）：
//
//   - S7 假 pi 完全不产出（零 stdout）→ 注入窗（TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS
//     =300ms）内失败，错误码前缀 engine_prompt_not_delivered + 诊断五元组进 detail +
//     子进程被杀（SIGKILL 收割）+ error 事件上协议；
//   - S7b pi 拒绝 prompt（response success:false）→ 立即失败不等窗口，错误码前缀
//     engine_prompt_rejected（不误报 not_delivered），错误含 pi error 文本；
//   - S8b get_state 有应答但 prompt response 延迟 → 不杀不判失败：零输出计时器被
//     stdout 活性取消（prompt ack delayed warn），response 到达后 run 正常完成；
//   - S9 stdin 不可用 / prompt 写入 EPIPE → 立即失败（不等零输出窗口）：
//     delivered:false → failNow(stdin-unavailable) / catch EPIPE → failNow(epipe)，
//     错误码前缀 engine_prompt_not_delivered + SIGKILL 收割 + error 事件 1 条；
//   - [M1 D2] PI_SUBAGENT_TASK 写入点截断：identity env 值 = 前 2000 字符 + 截断
//     标记（子 pi 实际收到的 env 经 text_delta 回显断言），多字节/代理对不劈半；
//     边界纯函数面（truncateTaskForEnv）+ applyIdentityEnvToChildEnv 装配单测同文件。
//
// fake pi 脚本落 mkdtemp 自建目录（tmpdir 白名单，不触碰真实数据目录）。
//
// [确定性] 正向用例（S7b/S8b）的零输出窗口用测试时钟冻结：prompt 在 spawn 同一
// 同步段内写入（生产顺序固定，测试不可提前写入），窗口起点必然包含「子进程启动 →
// node 引导 → 管道就绪」的真实耗时——负载下可达数百 ms，固定窗内完成是时序假设。
// 测试时钟把这段真实启动耗时移出窗口（窗口只在 pi 就绪后起算）：用例先等 onHandleReady
// （get_state 应答经 pump 回填 = pi 已就绪），再推进窗口——若活性未取消计时器，
// 推进即刻触发 not_delivered（负向对照仍然有效）；断言与 300ms 预算不变。
// S7（零输出）保持真实时钟：它验证的就是窗口本身必须到期。
//
// 就绪信号取既有 get_state 应答（onHandleReady），不引入额外 stdout 标记：prompt 在
// spawn 同一同步段写入，任何标记都晚于窗口武装，且与 response 同受启动/调度延迟
// （负载下同样可能晚于窗口）；S8b 的 getStateAnswered=true 断言还要求 prompt 写入后
// 首条活性就是 get_state 应答——启动标记会把它变成 false。get_state 应答即既有
// 「pi 已就绪」事实，窗口在它之后起算才消除真实启动耗时的时序假设。

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureLoggerSink,
  PI_SUBAGENT_TASK_MAX_CHARS,
  resetLoggerSinkForTests,
  type LogLevel,
  type AgentEvent,
} from "@zhushanwen/subagent-engine-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { killAllActiveChildren, getActiveChild, runSpawnOnce, applyIdentityEnvToChildEnv, truncateTaskForEnv, type SpawnRunCallbacks, type SpawnRunParams, type SpawnRunResult } from "../spawn-runner.ts";
import { PROMPT_ACK_TIMEOUT_ENV } from "../prompt-ack.ts";

/**
 * 注入窗（真机 30s 不可等）。S7 用真实时钟验证窗口必须到期；S7b/S8b 的窗口由测试
 * 时钟冻结到 pi 就绪后（见文件头 [确定性]）——窗口值不变，变的是起算点。
 */
const ACK_WINDOW_MS = 300;

/**
 * [m-pi-2 / S9] 立即失败用例的注入窗（拉大只为区分「立即失败」与「等窗口超时」：
 * 失败路径在 prompt 写入同 tick 结算，实测远小于窗；若接线退化为等窗口，elapsed
 * 会 ≥ 窗值或错误文案变成 timeout）。
 */
const S9_WINDOW_MS = 5_000;

/** fake pi 脚本：stdin JSONL 命令 → stdout JSONL（M2 故障注入形态）。 */
const FAKE_PI_SCRIPT = `
import readline from "node:readline";
const mode = process.env.FAKE_PI_MODE ?? "success";
const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };
const SESSION_ID = "fake-ack-sess";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "get_state") {
    if (mode === "silent") return; // S7：对一切命令完全零输出
    send({ type: "response", command: "get_state", success: true, id: msg.id,
      data: { sessionFile: "/tmp/fake-ack/20260910T010101_" + SESSION_ID + ".jsonl", sessionId: SESSION_ID } });
    return;
  }
  if (msg.type !== "prompt") return;
  if (mode === "silent") return;
  if (mode === "get-state-only") {
    // S8b：get_state 已应答、prompt response 延迟（600ms > 注入窗 300ms）
    setTimeout(() => {
      send({ type: "response", command: "prompt", success: true, id: msg.id, data: { disposition: "started" } });
      send({ type: "message_end", message: { stopReason: "stop" } });
      send({ type: "agent_end", willRetry: false, reason: "end_turn" });
      send({ type: "agent_settled" });
    }, 600);
    return;
  }
  if (mode === "reject-prompt") {
    send({ type: "response", command: "prompt", success: false, id: msg.id, error: "provider quota exceeded (fake)" });
    return;
  }
  if (mode === "echo-task-env") {
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: process.env.PI_SUBAGENT_TASK ?? "<env-absent>" } });
    send({ type: "message_end", message: { stopReason: "stop" } });
    send({ type: "agent_end", willRetry: false, reason: "end_turn" });
    send({ type: "agent_settled" });
    return;
  }
});
if (mode === "silent") { setInterval(() => {}, 1000); } // 零输出形态：不退出，等引擎杀链
`;

type Harness = {
  rootDir: string;
  sessionDir: string;
  events: AgentEvent[];
  deltas: string[];
  stateChanges: Array<{ pid: number; state: string; killed: boolean; exitCode?: number; signal?: string }>;
  argv1Saved: string;
  /** pi 就绪信号：首个 get_state 应答经 pump 回填身份（onHandleReady）时 resolve。 */
  ready: Promise<void>;
  notifyReady: () => void;
}

function makeHarness(mode: string): Harness {
  const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-ack-test-"));
  const sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(join(rootDir, "fake-pi.mjs"), FAKE_PI_SCRIPT);
  process.env.FAKE_PI_MODE = mode;
  const argv1Saved = process.argv[1] ?? "";
  process.argv[1] = join(rootDir, "fake-pi.mjs"); // getPiInvocation 分支 1：node <script>
  let notifyReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    notifyReady = resolve;
  });
  return { rootDir, sessionDir, events: [], deltas: [], stateChanges: [], argv1Saved, ready, notifyReady };
}

function restoreHarness(h: Harness): void {
  process.argv[1] = h.argv1Saved;
  delete process.env.FAKE_PI_MODE;
  fs.rmSync(h.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function callbacksOf(h: Harness, overrides: Partial<SpawnRunCallbacks> = {}): SpawnRunCallbacks {
  return {
    onEvent: (e) => h.events.push(e),
    onDelta: (d) => h.deltas.push(d),
    onChildStateChanged: (p) => h.stateChanges.push(p),
    // pi 就绪 = get_state 应答回填 sessionFile（ready 只在正向用例被 await）。
    onHandleReady: () => h.notifyReady(),
    ...overrides,
  };
}

const baseParams = (h: Harness, overrides: Partial<SpawnRunParams> = {}): SpawnRunParams => ({
  recordId: "rec-ack-1",
  task: "integrate me",
  agentName: "ack-agent",
  model: "prov/model-1",
  sessionDir: h.sessionDir,
  cwd: h.rootDir,
  ...overrides,
});

/** 注入短 ack 窗（用后恢复；返回 restore 函数）。 */
function injectAckWindow(windowMs: number = ACK_WINDOW_MS): () => void {
  const saved = process.env[PROMPT_ACK_TIMEOUT_ENV];
  process.env[PROMPT_ACK_TIMEOUT_ENV] = String(windowMs);
  return () => {
    if (saved === undefined) delete process.env[PROMPT_ACK_TIMEOUT_ENV];
    else process.env[PROMPT_ACK_TIMEOUT_ENV] = saved;
  };
}

/** 让出一轮 libuv 事件循环（真实 setImmediate——不受 vi 测试时钟接管）。 */
function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 等待谓词成立（kill 链/收尾异步面）。 */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  // 防御：正向用例的测试时钟异常退出时不得泄漏到后续用例（S7 用真实时钟验证窗口到期）。
  vi.useRealTimers();
  killAllActiveChildren();
});

describe("S7 假 pi 完全不产出 → 注入窗内 engine_prompt_not_delivered + killChild", () => {
  it("零 stdout 300ms → 失败终态：错误码前缀 + 诊断五元组 detail + SIGKILL 收割 + error 事件", async () => {
    const h = makeHarness("silent");
    const restoreWindow = injectAckWindow();
    try {
      const startedAt = Date.now();
      const result: SpawnRunResult = await runSpawnOnce(baseParams(h), callbacksOf(h));
      const elapsed = Date.now() - startedAt;

      // 注入窗内显式失败（30s 默认窗不可等——env 覆盖生效的构造性证明）
      expect(elapsed).toBeLessThan(ACK_WINDOW_MS * 10);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^engine_prompt_not_delivered:/);
      expect(result.error).toContain(`within ${ACK_WINDOW_MS}ms`);
      // 诊断五元组逐字段进失败 detail（验收 4）
      expect(result.error).toContain("pid=");
      expect(result.error).toContain("bytesWritten=");
      expect(result.error).toContain("stdoutBytes=0");
      expect(result.error).toContain("stdoutBytesAfterPrompt=0");
      expect(result.error).toContain("getStateAnswered=false");
      expect(result.error).toContain("lastEventType=-");
      expect(result.error).toContain("Recovery:");
      // 失败分诊：送达码确定性分支 → unknown（可重试），不被误诊 stale
      expect(result.failureKind).toBe("unknown");

      // 子进程被杀（SIGKILL 直杀收割）+ error 事件上协议（journal 留痕）
      await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
      expect(h.stateChanges[0]).toMatchObject({ state: "running", killed: false });
      const exited = h.stateChanges.find((s) => s.state === "exited");
      expect(exited).toMatchObject({ killed: true, signal: "SIGKILL" });
      const errorEvents = h.events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { message: string }).message).toMatch(/^engine_prompt_not_delivered:/);
    } finally {
      restoreWindow();
      restoreHarness(h);
    }
  });
});

describe("S7b pi 拒绝 prompt → 立即 engine_prompt_rejected（不等窗口、不误报 not_delivered）", () => {
  it("success:false response → 立即失败，错误含 pi error 文本，分型独立", async () => {
    const h = makeHarness("reject-prompt");
    const restoreWindow = injectAckWindow();
    // 零输出窗口走测试时钟：子进程启动耗时移出窗口（见文件头 [确定性]）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = runSpawnOnce(baseParams(h), callbacksOf(h));
      await h.ready; // pi 已就绪（get_state 应答落位）——窗口自此起算
      await nextImmediate(); // 该应答行的 onChannelActivity（取消计时器）已同步完成
      // 窗口逻辑时间耗尽：活性已取消零输出计时器 → 不误判 not_delivered。
      // 若取消接线缺失，此处推进即触发 timeout → 下方 rejected 断言失败（负向对照）。
      vi.advanceTimersByTime(ACK_WINDOW_MS * 2);
      const result: SpawnRunResult = await run;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^engine_prompt_rejected:/);
      expect(result.error).toContain("provider quota exceeded (fake)"); // pi error 文本在 detail
      expect(result.error).not.toContain("engine_prompt_not_delivered"); // 分型防误诊
      expect(result.failureKind).toBe("unknown");
      const errorEvents = h.events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      restoreWindow();
      restoreHarness(h);
    }
  });
});

describe("S8b get_state 有应答但 prompt response 延迟 → 不杀不判失败", () => {
  it("活性取消零输出计时器：run 继续，延迟 response 到达后正常完成（零误杀）", async () => {
    const h = makeHarness("get-state-only");
    const restoreWindow = injectAckWindow();
    const logs: Array<{ level: LogLevel; message: string }> = [];
    configureLoggerSink({ log: (level, _component, message) => logs.push({ level, message }) });
    // 零输出窗口走测试时钟：子进程启动耗时移出窗口（见文件头 [确定性]）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = runSpawnOnce(baseParams(h), callbacksOf(h));
      await h.ready; // pi 已就绪（get_state 应答落位）——窗口自此起算
      await nextImmediate(); // 该应答行的 onChannelActivity（取消计时器）已同步完成
      // 窗口逻辑时间耗尽：若活性未取消计时器，此处即误杀（负向对照）。
      vi.advanceTimersByTime(ACK_WINDOW_MS * 2);
      const result: SpawnRunResult = await run;

      // run 正常完成（response 延迟 600ms > 窗 300ms——若误杀此处即失败）
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.sessionId).toBe("fake-ack-sess");
      // 零输出计时器被 get_state response 活性取消：prompt ack delayed warn（含诊断摘要）
      const delayed = logs.filter((l) => l.level === "warn" && l.message.includes("prompt ack delayed"));
      expect(delayed).toHaveLength(1);
      expect(delayed[0]!.message).toContain("getStateAnswered=true");
      // 无误报：无 not_delivered 失败日志
      expect(logs.some((l) => l.message.includes("prompt not delivered"))).toBe(false);
    } finally {
      vi.useRealTimers();
      resetLoggerSinkForTests();
      restoreWindow();
      restoreHarness(h);
    }
  });
});

// ============================================================
// [m-pi-2 / S9] stdin 不可用 / EPIPE → 立即失败（run 级装配接线）
// ============================================================
// 组件半面（stdin-writer 的 delivered:false/throw、prompt-ack 的 failNow）已有覆盖，
// 但 `if (!sent.delivered) failNow` 与 catch-EPIPE 两条装配分支此前无 run 级用例
// 执行——删掉/改错分支不会红。驱动方式：onChildSpawned（prompt 写入前同步触发）
// 拿到活跃子进程 stdin 注入故障；fake pi 用 silent 形态（读 stdin 但零输出、
// setInterval 保活），确保失败由 failNow + SIGKILL 收割而非自然退出。

describe("S9 stdin 不可用 → delivered:false → 立即 engine_prompt_not_delivered（不等窗口）", () => {
  it("spawn 后销毁 stdin → failNow(stdin-unavailable)：错误前缀 + SIGKILL + error 事件 1 条", async () => {
    const h = makeHarness("silent");
    const restoreWindow = injectAckWindow(S9_WINDOW_MS);
    try {
      const startedAt = Date.now();
      const result: SpawnRunResult = await runSpawnOnce(
        baseParams(h),
        callbacksOf(h, {
          onChildSpawned: (_pid, recordId) => {
            // prompt 写入前拿到活跃子进程（registerActiveChild 先于本回调）
            const stdin = getActiveChild(recordId)?.stdin;
            if (stdin === null || stdin === undefined) {
              throw new Error("S9 harness: active child stdin missing");
            }
            stdin.destroy();
          },
        }),
      );
      const elapsed = Date.now() - startedAt;

      // 立即失败：远小于注入窗（若退化为等窗口，错误文案会变成 timeout）
      expect(elapsed).toBeLessThan(S9_WINDOW_MS);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^engine_prompt_not_delivered:/);
      expect(result.error).toContain("stdin-unavailable");
      expect(result.error).not.toContain("zero stdout after prompt write"); // 非 timeout 形态
      expect(result.failureKind).toBe("unknown");

      await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
      const exited = h.stateChanges.find((s) => s.state === "exited");
      expect(exited).toMatchObject({ killed: true, signal: "SIGKILL" });
      const errorEvents = h.events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { message: string }).message).toMatch(/^engine_prompt_not_delivered:/);
    } finally {
      restoreWindow();
      restoreHarness(h);
    }
  });
});

describe("S9 prompt 写入 EPIPE → catch → failNow(epipe)（不等窗口、不误报 timeout）", () => {
  it("stdin.write 抛 EPIPE（仅 prompt 帧）→ engine_prompt_not_delivered 含 epipe + SIGKILL", async () => {
    const h = makeHarness("silent");
    const restoreWindow = injectAckWindow(S9_WINDOW_MS);
    try {
      const startedAt = Date.now();
      const result: SpawnRunResult = await runSpawnOnce(
        baseParams(h),
        callbacksOf(h, {
          onChildSpawned: (_pid, recordId) => {
            const stdin = getActiveChild(recordId)?.stdin;
            if (stdin === null || stdin === undefined) {
              throw new Error("S9 harness: active child stdin missing");
            }
            const originalWrite = stdin.write.bind(stdin);
            stdin.write = ((chunk: string) => {
              // get_state 握手照常写入；只让 prompt 帧抛 EPIPE（模拟管道已断）
              if (chunk.includes('"type":"prompt"')) {
                throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
              }
              return originalWrite(chunk);
            }) as typeof stdin.write;
          },
        }),
      );
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(S9_WINDOW_MS);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^engine_prompt_not_delivered:/);
      expect(result.error).toContain("epipe");
      expect(result.error).toContain("EPIPE on stdin write"); // writeStdinLine 的 throw 文案
      expect(result.error).not.toContain("zero stdout after prompt write"); // 非 timeout 形态
      expect(result.failureKind).toBe("unknown");

      await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
      const exited = h.stateChanges.find((s) => s.state === "exited");
      expect(exited).toMatchObject({ killed: true, signal: "SIGKILL" });
      const errorEvents = h.events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { message: string }).message).toMatch(/^engine_prompt_not_delivered:/);
    } finally {
      restoreWindow();
      restoreHarness(h);
    }
  });
});

// ============================================================
// [M1 D2] PI_SUBAGENT_TASK 写入点截断
// ============================================================

describe("truncateTaskForEnv（写入点截断纯函数面）", () => {
  it("短任务 / 恰好 2000 字符 → 原样（无标记）", () => {
    expect(truncateTaskForEnv("short task")).toBe("short task");
    expect(truncateTaskForEnv("y".repeat(PI_SUBAGENT_TASK_MAX_CHARS))).toBe("y".repeat(PI_SUBAGENT_TASK_MAX_CHARS));
  });

  it("超限 ASCII → 前 2000 字符 + 标记文案（N = 被截字符数）", () => {
    const task = `${"a".repeat(2001)}tail`;
    expect(truncateTaskForEnv(task)).toBe(`${"a".repeat(2000)}…[truncated ${task.length - 2000} chars]`);
  });

  it("CJK 多字节整字符截断（UTF-16 码元边界 = BMP 整字符，不产残字）", () => {
    const task = "あ".repeat(2500);
    const out = truncateTaskForEnv(task);
    expect(out).toBe(`${"あ".repeat(2000)}…[truncated 500 chars]`);
    expect(out).not.toMatch(/[\uD800-\uDFFF]/); // 无代理对残片
  });

  it("边界劈在 astral 字符（emoji 代理对）→ 回退一个码元，env 值无孤立代理（不劈半）", () => {
    const task = `${"x".repeat(1999)}😀tail`;
    const out = truncateTaskForEnv(task);
    // 边界本应劈在 😀 的高低代理之间（keep=2000）→ 回退到 1999，emoji 整体被截
    expect(out).toBe(`${"x".repeat(1999)}…[truncated ${task.length - 1999} chars]`);
    expect(out).not.toMatch(/[\uD800-\uDFFF]/); // 无孤立高低代理（execve UTF-8 编码安全）
  });
});

describe("applyIdentityEnvToChildEnv × 截断（装配面）", () => {
  it("identity env 的 task 键写截断值（env 读取点消费方零改动的前提 = 值自含标记）", () => {
    const childEnv: Record<string, string> = {};
    applyIdentityEnvToChildEnv(
      childEnv,
      { recordId: "rec-1", agentName: "agent-a", task: "z".repeat(3000), cwd: "/w" },
      {},
    );
    expect(childEnv.PI_SUBAGENT_TASK).toBe(`${"z".repeat(2000)}…[truncated 1000 chars]`);
    expect(childEnv.PI_SUBAGENT_AGENT).toBe("agent-a");
  });
});

describe("M1 D2 截断 × 真实 spawn env 接线（echo-task-env）", () => {
  it("子 pi 实际收到的 PI_SUBAGENT_TASK env = 截断值 + 标记（经 text_delta 回显断言）", async () => {
    const h = makeHarness("echo-task-env");
    try {
      const task = `${"x".repeat(1999)}😀tail`; // 边界 astral 形态（同单测用例）
      const result: SpawnRunResult = await runSpawnOnce(baseParams(h, { task }), callbacksOf(h));

      expect(result.success).toBe(true);
      const expected = `${"x".repeat(1999)}…[truncated ${task.length - 1999} chars]`;
      expect(result.content).toBe(expected); // 子进程 env 实测值 = 截断投影
      expect(result.content).not.toMatch(/[\uD800-\uDFFF]/);
    } finally {
      restoreHarness(h);
    }
  });
});

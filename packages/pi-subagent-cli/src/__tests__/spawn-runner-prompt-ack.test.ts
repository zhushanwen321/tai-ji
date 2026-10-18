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
//   - [M1 D2] PI_SUBAGENT_TASK 写入点截断：identity env 值 = 前 2000 字符 + 截断
//     标记（子 pi 实际收到的 env 经 text_delta 回显断言），多字节/代理对不劈半；
//     边界纯函数面（truncateTaskForEnv）+ applyIdentityEnvToChildEnv 装配单测同文件。
//
// fake pi 脚本落 mkdtemp 自建目录（tmpdir 白名单，不触碰真实数据目录）。

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
import { afterEach, describe, expect, it } from "vitest";

import { killAllActiveChildren, runSpawnOnce, applyIdentityEnvToChildEnv, truncateTaskForEnv, type SpawnRunCallbacks, type SpawnRunParams, type SpawnRunResult } from "../spawn-runner.ts";
import { PROMPT_ACK_TIMEOUT_ENV } from "../prompt-ack.ts";

/** 注入窗（真机 30s 不可等；fake timers 管不了真实子进程 IO，用短真窗）。 */
const ACK_WINDOW_MS = 300;

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
}

function makeHarness(mode: string): Harness {
  const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-ack-test-"));
  const sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(join(rootDir, "fake-pi.mjs"), FAKE_PI_SCRIPT);
  process.env.FAKE_PI_MODE = mode;
  const argv1Saved = process.argv[1] ?? "";
  process.argv[1] = join(rootDir, "fake-pi.mjs"); // getPiInvocation 分支 1：node <script>
  return { rootDir, sessionDir, events: [], deltas: [], stateChanges: [], argv1Saved };
}

function restoreHarness(h: Harness): void {
  process.argv[1] = h.argv1Saved;
  delete process.env.FAKE_PI_MODE;
  fs.rmSync(h.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function callbacksOf(h: Harness): SpawnRunCallbacks {
  return {
    onEvent: (e) => h.events.push(e),
    onDelta: (d) => h.deltas.push(d),
    onChildStateChanged: (p) => h.stateChanges.push(p),
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
function injectAckWindow(): () => void {
  const saved = process.env[PROMPT_ACK_TIMEOUT_ENV];
  process.env[PROMPT_ACK_TIMEOUT_ENV] = String(ACK_WINDOW_MS);
  return () => {
    if (saved === undefined) delete process.env[PROMPT_ACK_TIMEOUT_ENV];
    else process.env[PROMPT_ACK_TIMEOUT_ENV] = saved;
  };
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
    try {
      const result: SpawnRunResult = await runSpawnOnce(baseParams(h), callbacksOf(h));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^engine_prompt_rejected:/);
      expect(result.error).toContain("provider quota exceeded (fake)"); // pi error 文本在 detail
      expect(result.error).not.toContain("engine_prompt_not_delivered"); // 分型防误诊
      expect(result.failureKind).toBe("unknown");
      const errorEvents = h.events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
    } finally {
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
    try {
      const result: SpawnRunResult = await runSpawnOnce(baseParams(h), callbacksOf(h));

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
      resetLoggerSinkForTests();
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

// src/__tests__/run-spawn-once.integration.test.ts
//
// runSpawnOnce 真实子进程集成测试：spawn 一个 fake pi 脚本（node 子进程，stdin
// JSONL 驱动 / stdout JSONL 事件流），驱动 spawn-runner → spawn-run-pump →
// spawn-event-translator 全链（不含真实 pi 二进制）。覆盖验收面：
//   - rpc 模式成功流：get_state 握手身份回填、事件翻译（tool/text/thinking/turn/
//     message_end usage）、agent_end 主动终结的 exit 0 口径、stderr tee 落盘、
//     invalid 行 / extension_ui_request 管道不中断；
//   - header 模式（json mode）：header 行身份 + 握手同值去重（不重发 handleReady）；
//   - 失败退出（exit 3）→ success=false + failureKind 分诊；
//   - message_end stopReason=aborted → record.lastError → success=false（stale 分诊）；
//   - abort signal → SIGTERM → 128+signal 折算退出码；
//   - spawn 失败（relay node 不存在路径，真实 ENOENT）→ 失败终态 + 可诊断 error（F4）；
//   - chatMode（[H1 U3] run 派发形态）：agent_end 不 kill、agent_settled resolve
//     （exit 0）+ 杀链收割（每轮一进程，续聊 = 新 run + resume）；
//   - model 缺失 → prepare 期抛错（不 spawn）。
//
// fake pi 脚本落 mkdtemp 临时目录；process.argv[1] 临时指向它（getPiInvocation
// 分支 1 形态：node <script> ...），用后恢复——pi-invocation 的 memo 按 argv[1]
// 值自动失效重算，不影响同 worker 其他测试。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getActiveChild,
  killAllActiveChildren,
  runSpawnOnce,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";
import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";

/** fake pi 脚本：stdin JSONL 命令 → stdout JSONL 事件（pi rpc mode 行为模拟）。 */
const FAKE_PI_SCRIPT = `
import readline from "node:readline";
import fs from "node:fs";
import { join } from "node:path";
const mode = process.env.FAKE_PI_MODE ?? "success";
const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };
process.stderr.write("fake-pi stderr boot\\n");
const SESSION_ID = "fake-sess-1";
const SESSION_FILE = "/tmp/fake-sessions/20260910T010101_00000000-0000-0000-0000-0000000000aa.jsonl";
if (mode === "header") {
  // json/print mode 形态：首行 header，get_state 回握手拼出的同值路径
  send({ type: "session", id: "hdr-sess", timestamp: "2026-09-10T01:02:03.000Z", cwd: "/tmp/fake" });
}
const sessionDirArg = (() => {
  const i = process.argv.indexOf("--session-dir");
  return i >= 0 ? process.argv[i + 1] : "/tmp/fake-sessions";
})();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "extension_ui_response") return;
  if (msg.type === "get_state") {
    if (mode === "id-only") {
      // V2 契约形态：应答只带 sessionId（缺 sessionFile）→ 握手视同未应答（走满 3 轮）
      send({ type: "response", command: "get_state", success: true, id: msg.id, data: { sessionId: SESSION_ID } });
      return;
    }
    if (mode === "header") {
      const file = sessionDirArg + "/2026-09-10T01-02-03-000Z_hdr-sess.jsonl";
      send({ type: "response", command: "get_state", success: true, id: msg.id, data: { sessionFile: file, sessionId: "hdr-sess" } });
    } else {
      send({ type: "response", command: "get_state", success: true, id: msg.id, data: { sessionFile: SESSION_FILE, sessionId: SESSION_ID } });
    }
    return;
  }
  if (msg.type !== "prompt") return;
  if (mode === "exit-3") { process.exit(3); return; }
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  if (mode === "id-only") {
    // 落一个 <ts>_<sessionId>.jsonl（LC-4 后缀反查目标）
    fs.writeFileSync(
      join(sessionDirArg, "20260910T010101_" + SESSION_ID + ".jsonl"),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-10T01:01:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "另一个 session 的历史内容" }] } }) + "\\n",
    );
    send({ type: "message_end", message: { stopReason: "stop" } });
    send({ type: "agent_end", willRetry: false, reason: "end_turn" });
    return;
  }
  if (mode === "stop-aborted") {
    send({ type: "message_end", message: { stopReason: "aborted", errorMessage: "aborted by user" } });
    send({ type: "agent_end", willRetry: false, reason: "aborted" });
    send({ type: "agent_settled" });
    return;
  }
  // success / header 共用的完整事件流（含 invalid 行与 ui request 管道）
  process.stdout.write("this line is not json\\n");
  send({ nope: 1 });
  send({ type: "extension_ui_request", id: "ui-1", method: "input", title: "需要输入" });
  send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file", args: { path: "a.txt" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
  send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read_file", result: { content: [{ type: "text", text: "contents" }] }, isError: false });
  send({ type: "turn_end" });
  send({ type: "message_end", message: { usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, cost: { total: 0.42 } }, stopReason: "stop" } });
  send({ type: "agent_end", willRetry: false, reason: "end_turn" });
  send({ type: "agent_settled" });
  // 一次性模式：宿主 agent_end → SIGTERM 收割；chatMode：settled resolve 后杀链收割（U3 每轮一进程）
});
`;

interface Harness {
  rootDir: string;
  sessionDir: string;
  scriptPath: string;
  events: AgentEvent[];
  deltas: string[];
  handleReady: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
  childSpawned: Array<{ pid: number; recordId: string }>;
  stateChanges: Array<{ pid: number; state: string; killed: boolean; exitCode?: number; signal?: string }>;
  argv1Saved: string | undefined;
}

async function makeHarness(mode: string): Promise<Harness> {
  const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-spawn-"));
  const sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const scriptPath = join(rootDir, "fake-pi.mjs");
  fs.writeFileSync(scriptPath, FAKE_PI_SCRIPT);
  process.env.FAKE_PI_MODE = mode;
  const argv1Saved = process.argv[1];
  process.argv[1] = scriptPath; // getPiInvocation 分支 1：node <script> <args>
  return {
    rootDir,
    sessionDir,
    scriptPath,
    events: [],
    deltas: [],
    handleReady: [],
    childSpawned: [],
    stateChanges: [],
    argv1Saved,
  };
}

function restoreHarness(h: Harness): void {
  // argv1Saved 恒非 undefined（makeHarness 保存时机在改写前）；undefined 形态仅
  // 防御 probe 用例先改动 argv[1] 的极端顺序
  process.argv[1] = h.argv1Saved ?? "";
  delete process.env.FAKE_PI_MODE;
  fs.rmSync(h.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function callbacksOf(h: Harness): SpawnRunCallbacks {
  return {
    onEvent: (e) => h.events.push(e),
    onHandleReady: (p) => h.handleReady.push(p),
    onChildSpawned: (pid, recordId) => h.childSpawned.push({ pid, recordId }),
    onChildStateChanged: (p) => h.stateChanges.push(p),
    onDelta: (d) => h.deltas.push(d),
  };
}

const baseParams = (h: Harness, overrides: Partial<SpawnRunParams> = {}): SpawnRunParams => ({
  recordId: "rec-int-1",
  task: "integrate me",
  agentName: "integration-agent",
  model: "prov/model-1",
  sessionDir: h.sessionDir,
  cwd: h.rootDir,
  ...overrides,
});

/** 等待谓词成立（tee 异步 flush 等场景）。 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  killAllActiveChildren();
  resetAllEpipeFailures();
});

describe("runSpawnOnce 集成（fake pi 子进程）", () => {
  it("rpc 模式成功流：握手身份 + 事件翻译 + exit 0 口径 + stderr tee 落盘 + invalid/ui 管道不中断", async () => {
    const h = await makeHarness("success");
    try {
      const result: SpawnRunResult = await runSpawnOnce(
        baseParams(h, { appendSystemPrompt: ["be terse"], maxTurns: 3 }),
        callbacksOf(h),
      );

      // 结果聚合（translator 事件流 → reducer → collector）
      expect(result.success).toBe(true); // agent_end 主动终结 = exit 0 口径
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("hello world");
      expect(result.turns).toBe(1);
      expect(result.sessionId).toBe("fake-sess-1");
      expect(result.sessionFile).toBe(
        "/tmp/fake-sessions/20260910T010101_00000000-0000-0000-0000-0000000000aa.jsonl",
      );
      expect(result.parsedOutput).toBeUndefined();
      expect(result.failureKind).toBeUndefined();
      // tool_end 配对 tool_start（toolCallId 回填 args）；对象为 InternalToolCall
      // 运行时形态（含 _status/startedTs 内部态，导出面 strip 归消费方），业务字段
      // 用 toMatchObject 断言
      expect(result.toolCalls).toMatchObject([
        {
          toolName: "read_file",
          args: { path: "a.txt" },
          result: { content: [{ type: "text", text: "contents" }] },
          isError: false,
        },
      ]);
      expect(result.usage).toEqual({ input: 11, output: 7, cacheRead: 2, cacheWrite: 3, cost: 0.42 });

      // 事件翻译序列（SdkEvent → AgentEvent）
      expect(h.events.map((e) => e.type)).toEqual([
        "tool_start", "text_delta", "text_delta", "thinking_delta", "tool_end", "turn_end", "message_end",
      ]);
      expect(h.deltas).toEqual(["hello ", "world"]);
      const toolEnd = h.events.find((e) => e.type === "tool_end");
      expect(toolEnd).toMatchObject({ toolName: "read_file", isError: false });

      // 身份回填：get_state response 行同步路径发 handleReady（握手 promise 同值去重不重发）
      expect(h.handleReady).toHaveLength(1);
      expect(h.handleReady[0]).toEqual({
        sessionRef: { sessionId: "fake-sess-1", sessionFile: result.sessionFile },
        poolKey: "shared",
      });

      // 镜像上报：childSpawned 先行 + running/exited 状态（killed=true = agent_end 收割）
      expect(h.childSpawned).toHaveLength(1);
      expect(h.childSpawned[0]!.recordId).toBe("rec-int-1");
      expect(h.stateChanges.map((s) => s.state)).toEqual(["running", "exited"]);
      expect(h.stateChanges[1]).toMatchObject({ killed: true, signal: "SIGTERM" });

      // close 后活跃子进程表清理
      expect(getActiveChild("rec-int-1")).toBeUndefined();

      // stderr tee 落盘（<dataDir>/logs/pi-task-stderr-<pid>.log，懒打开 + close flush）
      const dataDir = process.env.XYZ_AGENT_DATA_DIR ?? "";
      const logsDir = join(dataDir, "logs");
      await waitFor(() => {
        const names = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
        return names.some((n) => n.startsWith("pi-task-stderr-"));
      });
      const logName = fs.readdirSync(logsDir).find((n) => n.startsWith("pi-task-stderr-"))!;
      const logContent = fs.readFileSync(join(logsDir, logName), "utf8");
      expect(logContent).toContain("fake-pi stderr boot");
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("header 模式（json mode）：header 行身份落位 + 握手同值去重", async () => {
    const h = await makeHarness("header");
    try {
      const result = await runSpawnOnce(baseParams(h), callbacksOf(h));

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe("hdr-sess");
      expect(result.sessionFile).toBe(join(h.sessionDir, "2026-09-10T01-02-03-000Z_hdr-sess.jsonl"));
      // header 行先发 handleReady；get_state 握手回传同值 → 不重发
      expect(h.handleReady).toHaveLength(1);
      expect(h.handleReady[0]!.sessionRef).toEqual({
        sessionId: "hdr-sess",
        sessionFile: result.sessionFile,
      });
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("V2 契约（M1 打通的组合）：get_state 只回 sessionId → 3 轮耗尽带 sessionId → close 后 sessionFile 经 LC-4 落位", async () => {
    const h = await makeHarness("id-only");
    try {
      const result: SpawnRunResult = await runSpawnOnce(baseParams(h), callbacksOf(h));
      const lc4File = join(h.sessionDir, "20260910T010101_fake-sess-1.jsonl");

      expect(fs.existsSync(lc4File)).toBe(true);
      expect(result.success).toBe(true);
      // 握手三轮应答都缺 sessionFile（S2 契约：视同未应答 → 3 轮耗尽 resolve 已收集字段）
      // → 身份只有 sessionId；sessionFile 只可能来自 close 期的 LC-4 后缀反查
      expect(result.sessionId).toBe("fake-sess-1");
      expect(result.sessionFile).toBe(lc4File);
      // handleReady 恰一次且携带 sessionFile：spawn 期应答无 sessionFile（不发通知），
      // 故这一条只能由 close 期的 LC-4 落位产生 ——「只在 close 后发一次」
      expect(h.handleReady).toEqual([
        { sessionRef: { sessionId: "fake-sess-1", sessionFile: lc4File }, poolKey: "shared" },
      ]);
    } finally {
      restoreHarness(h);
    }
  }, 20_000);

  it("失败退出（exit 3）→ success=false + 结构化 error + unknown 分诊", async () => {
    const h = await makeHarness("exit-3");
    try {
      const result = await runSpawnOnce(baseParams(h), callbacksOf(h));
      expect(result.success).toBe(false);
      expect(result.error).toBe("pi child exited with code 3");
      expect(result.failureKind).toBe("unknown");
      expect(result.content).toBe("");
      expect(result.sessionId).toBe("fake-sess-1"); // get_state 握手先于 prompt 完成
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("message_end stopReason=aborted → error 事件 → record.lastError → success=false + stale 分诊", async () => {
    const h = await makeHarness("stop-aborted");
    try {
      const result = await runSpawnOnce(baseParams(h), callbacksOf(h));
      expect(h.events.some((e) => e.type === "error")).toBe(true);
      expect(result.success).toBe(false); // exit 0 但 lastError 非空 → 不静默 success
      expect(result.error).toBe("aborted by user");
      expect(result.failureKind).toBe("stale_context"); // "aborted" 命中 stale 词表
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("abort signal → SIGTERM → 128+signal 折算（143）异常退出口径", async () => {
    const h = await makeHarness("hang");
    try {
      const controller = new AbortController();
      const runP = runSpawnOnce(baseParams(h, { signal: controller.signal }), callbacksOf(h));
      setTimeout(() => controller.abort(), 150);
      const result = await runP;
      expect(result.success).toBe(false);
      // 信号退出折算 = SIGNAL_EXIT_CODE_BASE（128），不与信号序号相加
      expect(result.error).toBe("pi child exited with code 128");
      expect(result.failureKind).toBe("unknown");
      expect(result.turns).toBe(0);
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("spawn 失败（relay node 指向不存在路径，真实 ENOENT）→ 失败终态 + 可诊断 error，不伪成功（F4）", async () => {
    const h = await makeHarness("success");
    // relay 三键激活 → getPiInvocation 分支 0：command = RELAY_NODE（真实不存在的
    // 绝对路径）。不经任何 mock——Node spawn 的 'error' 事件（ENOENT）+ 迟到
    // close(code=-2) 全真实时序，锁「从未启动的子进程不得判成功」。
    const ghostNode = join(h.rootDir, "nonexistent-node-bin");
    process.env.XYZ_SUBAGENT_RELAY_SOCKET = join(h.rootDir, "relay.sock");
    process.env.XYZ_SUBAGENT_RELAY_NODE = ghostNode;
    process.env.XYZ_SUBAGENT_RELAY_SCRIPT = join(h.rootDir, "relay.mjs");
    try {
      const result = await runSpawnOnce(baseParams(h), callbacksOf(h));

      expect(result.success).toBe(false); // 从未启动 → 失败，不得 success=true 空内容
      expect(result.error).toContain("pi child error:");
      expect(result.error).toContain("ENOENT"); // 原始 errno code 可诊断
      expect(result.error).toContain(ghostNode); // 失败的命令路径可诊断
      expect(result.error).toContain("127"); // 失败折算退出码
      expect(result.failureKind).toBe("unknown"); // 不命中 stale 词表（可重试口径）
      expect(result.content).toBe("");
      expect(result.turns).toBe(0);
      // 子进程从未运行：无 pid 可上报（reportChildSpawned 的 pid 缺失守卫）
      expect(h.childSpawned).toHaveLength(0);
    } finally {
      delete process.env.XYZ_SUBAGENT_RELAY_SOCKET;
      delete process.env.XYZ_SUBAGENT_RELAY_NODE;
      delete process.env.XYZ_SUBAGENT_RELAY_SCRIPT;
      restoreHarness(h);
    }
  }, 15_000);

  it("chatMode（[H1 U3] run 派发形态）：agent_end 不 kill；agent_settled resolve（exit 0）并收割子进程", async () => {
    const h = await makeHarness("success");
    let roundEnded = 0;
    let settled = 0;
    try {
      const result = await runSpawnOnce(baseParams(h, { chatMode: true, maxTurns: 2 }), {
        ...callbacksOf(h),
        onChatRoundEnd: () => {
          roundEnded += 1;
        },
        onChatAgentSettled: () => {
          settled += 1;
        },
      });

      expect(roundEnded).toBe(1);
      expect(settled).toBe(1);
      expect(result.success).toBe(true); // resolveChatRun(0)，与 close 信号无关
      expect(result.content).toBe("hello world");
      // agent_settled 消费面按轮重置 turnCount（SP-9：chat 续聊轮独立预算）
      expect(result.turns).toBe(0);

      // [H1 U3] agent_settled resolve 后杀链收割（每轮一进程——续聊 = 新 run +
      // resume 锚点；不再保活）：active-children 注销 + exited 镜像上报（killed）
      await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
      const exited = h.stateChanges.find((s) => s.state === "exited")!;
      expect(exited.killed).toBe(true);
      expect(getActiveChild("rec-int-1")).toBeUndefined();
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("model 缺失（非 canonical provider/id）→ prepare 期抛错，不 spawn 子进程", async () => {
    const h = await makeHarness("success");
    try {
      await expect(
        runSpawnOnce(baseParams(h, { model: undefined }), callbacksOf(h)),
      ).rejects.toThrow(/canonical model ref/);
      expect(h.childSpawned).toHaveLength(0);
    } finally {
      restoreHarness(h);
    }
  });
});

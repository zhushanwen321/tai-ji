// src/__tests__/run-spawn-once.integration.test.ts
//
// runSpawnOnce 测试：spawn 边界双形态（单测层只测逻辑，OS 进程边界按用例性质分流）。
//
// 形态 A —— stub 子进程（翻译/分诊类，18 条）：SDK spawnEngineChild（全部引擎 CLI
// 任务子进程的唯一 spawn 入口）替换为进程内 fake 子进程（PassThrough 驱动）。OS
// 进程边界换注入桩，被测逻辑全链真实执行：spawn-runner 编排 → spawn-run-pump →
// spawn-event-translator → close 收尾 → outcome 收集。覆盖：事件翻译序列、握手
// 身份回填、header 同值去重、schema env 派生（buildChildEnv）与武装断言、F-1
// 确定性检查、退出码分诊、取消终态、armed 回执时序、env 污染不透传。
// fake 的 stdout/stderr 写入排微任务（保序交付）：真实子进程不可能在引擎写 stdin
// 的同一同步块内应答——桩必须保持该异步边界，否则 get_state 应答会早于监听登记
// 被丢弃（握手等满 2s 超时、身份回填丢失）。
//
// 形态 B —— 真 spawn 冒烟（4 条，集成门控）：真 node 子进程跑 fake pi 脚本
// （stdin JSONL 驱动 / stdout JSONL 事件流）。保留 OS × 引擎的组合事实：全链锚点
// （stderr tee 落盘 + 镜像上报 + settled 收割 + active-children 注销）、V2 契约
// （get_state 只回 sessionId → 3 轮耗尽 → close 后 LC-4 后缀反查落位）、abort →
// SIGTERM → 128+signal 折算、真实 ENOENT（F4：从未启动不得判成功）。真进程存亡
// 无完成信号可等、窗口随负载拉长——移出默认单测层（TAIJI_TEST_INTEGRATION 启用
// 时真跑），默认组只保留形态 A 的进程内桩逻辑。
//
// fake pi 脚本（形态 B）落 mkdtemp 临时目录；process.argv[1] 临时指向它
// （getPiInvocation 分支 1 形态：node <pi 入口> ...），用后恢复——pi-invocation 的
// memo 按 argv[1] 值自动失效重算，不影响同 worker 其他测试。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getActiveChild,
  killAllActiveChildren,
  runSpawnOnce,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import type { AgentEvent, SpawnEngineChildOptions } from "@zhushanwen/subagent-engine-sdk";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "./integration-gate.local.ts";

/**
 * [D3] 武装态 schema 任务的扩展路径：native + schema run 必须携带 structured-output
 * 路径（命中武装断言②的 `<scope>/<pkg>` 段判据），否则 runSpawnOnce 在 spawn 前
 * fail-fast。fake pi 不真加载扩展，路径无需存在。
 */
const ARMED_EXTENSION_PATH = "/staged/resources/extensions/@zhushanwen/pi-structured-output";

/**
 * spawn 边界（SDK spawnEngineChild）的双模替换状态：
 * - real = 委派真实 spawnEngineChild（形态 B 真 spawn 用例）；
 * - stub = 进程内 fake 子进程（形态 A；current 记录最近一次创建，零 spawn 断言
 *   据此判定「spawn 边界从未被调用」）。
 */
const spawnBoundary = vi.hoisted(() => ({
  real: false,
  realSpawn: undefined as unknown,
  makeFake: undefined as unknown,
  current: undefined as unknown,
  waiters: [] as Array<(child: unknown) => void>,
}));

vi.mock("@zhushanwen/subagent-engine-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/subagent-engine-sdk")>();
  spawnBoundary.realSpawn = actual.spawnEngineChild;
  const spawnEngineChildStub = ((opts: SpawnEngineChildOptions) =>
    spawnBoundary.real
      ? (spawnBoundary.realSpawn as typeof actual.spawnEngineChild)(opts)
      : (spawnBoundary.makeFake as (o: SpawnEngineChildOptions) => ChildProcess)(opts)) as typeof actual.spawnEngineChild;
  return { ...actual, spawnEngineChild: spawnEngineChildStub };
});

/** fake pi 脚本（形态 B 真 spawn 用）：stdin JSONL 命令 → stdout JSONL 事件（pi rpc mode 行为模拟）。 */
const FAKE_PI_SCRIPT = `
import readline from "node:readline";
import fs from "node:fs";
import { join } from "node:path";
const mode = process.env.FAKE_PI_MODE ?? "success";
const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };
process.stderr.write("fake-pi stderr boot\\n");
const SESSION_ID = "fake-sess-1";
const SESSION_FILE = "/tmp/fake-sessions/20260910T010101_00000000-0000-0000-0000-0000000000aa.jsonl";
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
    send({ type: "response", command: "get_state", success: true, id: msg.id, data: { sessionFile: SESSION_FILE, sessionId: SESSION_ID } });
    return;
  }
  if (msg.type !== "prompt") return;
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
    send({ type: "agent_settled" });
    return;
  }
  // success 共用的完整事件流（含 invalid 行与 ui request 管道）
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
  // settled resolve 后杀链收割（每轮一进程——续聊 = 新 run + resume 锚点）
});
`;

// ── fake 子进程（形态 A 的注入桩） ──

/** fake pi 脚本（stub 形态）：驱动 fake 子进程的 stdin → stdout 行为。 */
interface FakePiScript {
  /** spawn 后立即写 header 行（json/print mode 形态；先于 get_state 握手）。 */
  header?: { id: string; timestamp: string; cwd: string };
  /** get_state 应答 data（缺省 = 不应答）。函数形态可读 spawn 入参（header 模式派生路径）。 */
  getStateData?: Record<string, unknown> | ((child: FakeChild) => Record<string, unknown>);
  /** prompt 命令到达后的动作（事件流 / stderr / 退出）。 */
  onPrompt: (child: FakeChild) => void;
}

/** rpc 成功形态身份（get_state 应答）。 */
const SUCCESS_IDENTITY: Record<string, unknown> = {
  sessionFile: "/tmp/fake-sessions/20260910T010101_00000000-0000-0000-0000-0000000000aa.jsonl",
  sessionId: "fake-sess-1",
};

/** 完整事件流（success/header 共用：invalid 行 + ui 请求 + tool/text/thinking/turn/message_end usage + 轮收敛）。 */
function emitSuccessEventStream(child: FakeChild): void {
  child.writeStdoutRaw("this line is not json\n");
  child.writeStdoutLine({ nope: 1 });
  child.writeStdoutLine({ type: "extension_ui_request", id: "ui-1", method: "input", title: "需要输入" });
  child.writeStdoutLine({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file", args: { path: "a.txt" } });
  child.writeStdoutLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
  child.writeStdoutLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
  child.writeStdoutLine({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
  child.writeStdoutLine({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read_file",
    result: { content: [{ type: "text", text: "contents" }] },
    isError: false,
  });
  child.writeStdoutLine({ type: "turn_end" });
  child.writeStdoutLine({
    type: "message_end",
    message: { usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, cost: { total: 0.42 } }, stopReason: "stop" },
  });
  child.writeStdoutLine({ type: "agent_end", willRetry: false, reason: "end_turn" });
  child.writeStdoutLine({ type: "agent_settled" });
}

/** 默认 stub 脚本：rpc 成功形态（握手应答 + prompt 后完整事件流）。 */
function successScript(): FakePiScript {
  return { getStateData: { ...SUCCESS_IDENTITY }, onPrompt: emitSuccessEventStream };
}

/** exit-3 形态：prompt 到达 → stderr 产出 + 非零退出。 */
function exit3Script(): FakePiScript {
  return {
    getStateData: { ...SUCCESS_IDENTITY },
    onPrompt: (child) => {
      child.writeStderr("fake-pi stderr boot\n");
      child.exit(3);
    },
  };
}

/** stop-aborted 形态：message_end stopReason=aborted → 轮收敛（exit 0 但 lastError 非空）。 */
function stopAbortedScript(): FakePiScript {
  return {
    getStateData: { ...SUCCESS_IDENTITY },
    onPrompt: (child) => {
      child.writeStdoutLine({ type: "message_end", message: { stopReason: "aborted", errorMessage: "aborted by user" } });
      child.writeStdoutLine({ type: "agent_end", willRetry: false, reason: "aborted" });
      child.writeStdoutLine({ type: "agent_settled" });
    },
  };
}

/** header 形态（json/print mode）：spawn 即写 header 行；get_state 应答同值路径。 */
function headerScript(): FakePiScript {
  return {
    header: { id: "hdr-sess", timestamp: "2026-09-10T01:02:03.000Z", cwd: "/tmp/fake" },
    getStateData: (child) => ({
      sessionFile: `${child.sessionDirArg()}/2026-09-10T01-02-03-000Z_hdr-sess.jsonl`,
      sessionId: "hdr-sess",
    }),
    onPrompt: emitSuccessEventStream,
  };
}

/** stub 子进程的 pid 基数（逐例递增，tee 路径互不重叠）。 */
let nextFakePid = 424242;

/**
 * fake 子进程：ChildProcess 结构子集（pid / killed / exitCode / signalCode /
 * stdin/stdout/stderr 三 pipe / kill / exit/close 事件）。stdout/stderr 写入排
 * 微任务保序交付（见文件头：桩必须保持进程间异步边界）；exit 排宏任务（kill 的
 * close 必须晚于 run resolve 的微任务——「resolve 先于收割」断言依赖该次序）。
 */
class FakeChild extends EventEmitter {
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /** spawn 边界入参快照（command / args / env / cwd——execve 前的引擎侧终态）。 */
  readonly spawnOptions: { command: string; args: string[]; env: Record<string, string | undefined>; cwd: string | undefined };
  /** 已收到的 stdin 行（诊断用）。 */
  readonly stdinLines: string[] = [];
  private readonly script: FakePiScript;
  private stdinBuffer = "";
  private finished = false;

  constructor(opts: SpawnEngineChildOptions, script: FakePiScript) {
    super();
    this.pid = nextFakePid++;
    this.script = script;
    this.spawnOptions = {
      command: opts.command,
      args: [...opts.args],
      env: { ...opts.env },
      cwd: opts.cwd,
    };
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.consumeStdin(chunk));
    if (script.header !== undefined) {
      this.writeStdoutLine({ type: "session", ...script.header });
    }
    spawnBoundary.current = this;
    for (const waiter of spawnBoundary.waiters.splice(0)) waiter(this);
  }

  /** --session-dir 参数值（header 模式派生 session 文件路径用）。 */
  sessionDirArg(): string {
    const i = this.spawnOptions.args.indexOf("--session-dir");
    return i >= 0 ? (this.spawnOptions.args[i + 1] ?? "/tmp/fake-sessions") : "/tmp/fake-sessions";
  }

  private consumeStdin(chunk: string): void {
    this.stdinBuffer += chunk;
    let nl = this.stdinBuffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdinBuffer.slice(0, nl);
      this.stdinBuffer = this.stdinBuffer.slice(nl + 1);
      if (line.trim() !== "") this.handleStdinLine(line);
      nl = this.stdinBuffer.indexOf("\n");
    }
  }

  private handleStdinLine(line: string): void {
    let msg: { id?: string; type?: string };
    try {
      msg = JSON.parse(line) as { id?: string; type?: string };
    } catch {
      return;
    }
    this.stdinLines.push(line);
    if (msg.type === "get_state") {
      if (this.script.getStateData !== undefined) {
        const data =
          typeof this.script.getStateData === "function" ? this.script.getStateData(this) : this.script.getStateData;
        this.writeStdoutLine({ type: "response", command: "get_state", success: true, id: msg.id, data });
      }
      return;
    }
    if (msg.type === "prompt") {
      this.script.onPrompt(this);
    }
  }

  /** stdout 写一行 NDJSON（微任务保序交付）。 */
  writeStdoutLine(obj: unknown): void {
    this.queueWrite(this.stdout, `${JSON.stringify(obj)}\n`);
  }

  /** stdout 写原始文本（invalid 行等）。 */
  writeStdoutRaw(text: string): void {
    this.queueWrite(this.stdout, text);
  }

  /** stderr 写文本（tee 落盘验证用）。 */
  writeStderr(text: string): void {
    this.queueWrite(this.stderr, text);
  }

  private queueWrite(stream: PassThrough, chunk: string): void {
    queueMicrotask(() => {
      stream.write(chunk);
    });
  }

  /** 子进程自行退出（exit + close，Node 真实事件顺序；宏任务交付）。 */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.finished) return;
    this.finished = true;
    setImmediate(() => {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.finished) return true;
    this.killed = true;
    const sig: NodeJS.Signals | null = typeof signal === "string" ? signal : null;
    // 宏任务：close 必须晚于 agent_settled 的 run resolve（微任务）——
    // 「resolve 先于收割」的确定性次序（见轮次时序用例）。
    setImmediate(() => this.exit(null, sig));
    return true;
  }
}

/** 当前 stub 脚本（makeFake 在 fake 创建时读取）。 */
let activeScript: FakePiScript = successScript();
spawnBoundary.makeFake = (opts: SpawnEngineChildOptions) => new FakeChild(opts, activeScript);

/** 取本次 run 的 fake 子进程句柄（spawn 边界创建时交出；断言 spawn 入参用）。 */
function nextFakeChild(): Promise<FakeChild> {
  if (spawnBoundary.current !== undefined) {
    const child = spawnBoundary.current as FakeChild;
    spawnBoundary.current = undefined;
    return Promise.resolve(child);
  }
  return new Promise<FakeChild>((resolve) => {
    spawnBoundary.waiters.push((c) => resolve(c as FakeChild));
  });
}

interface Harness {
  rootDir: string;
  sessionDir: string;
  scriptPath: string;
  events: AgentEvent[];
  deltas: string[];
  handleReady: Array<{ sessionRef: Record<string, string> }>;
  childSpawned: Array<{ pid: number; recordId: string }>;
  stateChanges: Array<{ pid: number; state: string; killed: boolean; exitCode?: number; signal?: string }>;
  /** 真 spawn 形态保存的 argv[1]（stub 形态不改 argv[1]，恒 undefined）。 */
  argv1Saved?: string;
}

/** 真 spawn harness（形态 B）：写 FAKE_PI_SCRIPT + argv[1] 指向它 + 委派真实 spawn。 */
async function makeRealHarness(mode: string): Promise<Harness> {
  const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-spawn-"));
  const sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  // 文件名取 pi npm 入口词形 cli.js：getPiInvocation 分支 1 资格 = pi 入口白名单
  // （basename 精确匹配；staged 引擎入口不得复现的防回归用例见 pi-invocation.test.ts）
  const scriptPath = join(rootDir, "cli.js");
  fs.writeFileSync(scriptPath, FAKE_PI_SCRIPT);
  process.env.FAKE_PI_MODE = mode;
  spawnBoundary.real = true;
  const argv1Saved = process.argv[1];
  process.argv[1] = scriptPath; // getPiInvocation 分支 1：node <pi 入口> <args>
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

/** stub harness（形态 A）：只建临时目录；spawn 边界由 fake 子进程接管（无真进程）。 */
function makeStubHarness(script: FakePiScript = successScript()): Harness {
  activeScript = script;
  const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-stub-"));
  const sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    rootDir,
    sessionDir,
    scriptPath: "",
    events: [],
    deltas: [],
    handleReady: [],
    childSpawned: [],
    stateChanges: [],
  };
}

function restoreHarness(h: Harness): void {
  // argv1Saved 恒非 undefined（makeRealHarness 保存时机在改写前）；undefined 形态仅
  // 防御 probe 用例先改动 argv[1] 的极端顺序
  if (h.argv1Saved !== undefined) process.argv[1] = h.argv1Saved;
  delete process.env.FAKE_PI_MODE;
  spawnBoundary.real = false;
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
  spawnBoundary.current = undefined;
  spawnBoundary.waiters.length = 0;
});

// ── 形态 B：真 spawn 冒烟（集成门控——本地默认跳过，CI / 按改动范围触发时真跑） ──
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `runSpawnOnce 真 spawn 冒烟（fake pi 真子进程全链）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
  it("rpc 模式成功流：握手身份 + 事件翻译 + exit 0 口径 + stderr tee 落盘 + invalid/ui 管道不中断", async () => {
    const h = await makeRealHarness("success");
    try {
      const result: SpawnRunResult = await runSpawnOnce(
        baseParams(h, { appendSystemPrompt: ["be terse"], maxTurns: 3 }),
        callbacksOf(h),
      );

      // 结果聚合（translator 事件流 → reducer → collector）
      expect(result.success).toBe(true); // agent_settled resolve = exit 0 口径
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("hello world");
      // 成功 run 轮数 = resolve 时刻快照（本流 1 条 turn_end → 真实轮数 1）——
      // agent_settled 消费方的按轮清零（SP-9）不得腐化收集侧
      expect(result.turns).toBe(1);
      expect(result.sessionId).toBe("fake-sess-1");
      expect(result.sessionFile).toBe(
        "/tmp/fake-sessions/20260910T010101_00000000-0000-0000-0000-0000000000aa.jsonl",
      );
      expect(result.parsedOutput).toBeUndefined();
      expect(result.failureKind).toBeUndefined();
      // tool_end 配对 tool_start（toolCallId 回填 args）；对象为 InternalToolCall
      // 运行时形态（含 _status/startedTs 内部态，导出清单 strip 归消费方），业务字段
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
        });

      // close 收尾面（镜像 exited / active-children 注销 / tee close flush）在 run
      // resolve 之后异步到达（agent_settled resolve 早于收割）：先等 exited 镜像上报
      // 再断言，避免与 close 事件赛跑。close finalizer 内 exited 之前的步骤（tee
      // close / 注销登记）已同步完成，故 exited 到达即下列断言全部就绪。
      await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));

      // 镜像上报：childSpawned 先行 + running/exited 状态（killed=true = settled 收割）
      expect(h.childSpawned).toHaveLength(1);
      expect(h.childSpawned[0]!.recordId).toBe("rec-int-1");
      expect(h.stateChanges.map((s) => s.state)).toEqual(["running", "exited"]);
      // ADR-0122 防御清理：settled 收割 = SIGKILL 直杀（原 SIGTERM 阶梯退役）
      expect(h.stateChanges[1]).toMatchObject({ killed: true, signal: "SIGKILL" });

      // close 后活跃子进程表清理
      expect(getActiveChild("rec-int-1")).toBeUndefined();

      // stderr tee 落盘（<dataDir>/logs/pi-task-stderr-<pid>.log，懒打开 + close flush）
      const dataDir = process.env.TAIJI_AGENT_DATA_DIR ?? "";
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

  it("V2 契约（M1 打通的组合）：get_state 只回 sessionId → 3 轮耗尽带 sessionId → close 后 sessionFile 经 LC-4 落位", async () => {
    const h = await makeRealHarness("id-only");
    try {
      const result: SpawnRunResult = await runSpawnOnce(baseParams(h), callbacksOf(h));
      const lc4File = join(h.sessionDir, "20260910T010101_fake-sess-1.jsonl");

      expect(fs.existsSync(lc4File)).toBe(true);
      expect(result.success).toBe(true);
      // 握手三轮应答都缺 sessionFile（S2 契约：视同未应答 → 3 轮耗尽 resolve 已收集字段）
      // → 身份只有 sessionId；sessionFile 只可能来自 close 期的 LC-4 后缀反查
      expect(result.sessionId).toBe("fake-sess-1");
      // [modeless 波2] run 在 agent_settled 即应答（早于收割 close）——outcome 收集
      // 时刻 sessionFile 仍缺；LC-4 后缀反查在 close 收尾才发生，transcript 锚点经
      // handleReady 通知补齐（record 锚不进 outcome）。
      expect(result.sessionFile).toBeUndefined();
      // handleReady 恰一次且携带 sessionFile：spawn 期应答无 sessionFile（不发通知），
      // 故这一条只能由 close 期的 LC-4 落位产生 ——「只在 close 后发一次」
      await waitFor(() => h.handleReady.length === 1);
      expect(h.handleReady).toEqual([
        { sessionRef: { sessionId: "fake-sess-1", sessionFile: lc4File }},
      ]);
    } finally {
      restoreHarness(h);
    }
  }, 20_000);

  it("abort signal → SIGTERM → 128+signal 折算（143）异常退出口径", async () => {
    const h = await makeRealHarness("hang");
    try {
      const controller = new AbortController();
      const runP = runSpawnOnce(baseParams(h, { signal: controller.signal }), callbacksOf(h));
      setTimeout(() => controller.abort(), 150);
      const result = await runP;
      expect(result.success).toBe(false);
      // POSIX 信号退出折算 = 128 + signo（SIGTERM=15 → 143）
      expect(result.error).toBe("pi child exited with code 143");
      expect(result.failureKind).toBe("unknown");
      expect(result.turns).toBe(0);
    } finally {
      restoreHarness(h);
    }
  }, 15_000);

  it("spawn 失败（execPath 指向不存在路径，真实 ENOENT）→ 失败终态 + 可诊断 error，不伪成功（F4）", async () => {
    const h = await makeRealHarness("success");
    // 执行器不存在（真实绝对路径）：argv[1] 指向不存在脚本（basename 非 pi 发行入口
    // → 分支 1 不命中）+ execPath basename 命中 pi 二进制命名白名单 → getPiInvocation
    // 分支 2：command = execPath。不经任何 mock——Node spawn 的 'error' 事件（ENOENT）
    // + 迟到 close(code=-2) 全真实时序，锁「从未启动的子进程不得判成功」。
    const ghostPi = join(h.rootDir, "pi");
    const originalExecPath = process.execPath;
    process.argv[1] = join(h.rootDir, "nonexistent-pi-entry.mjs");
    Object.defineProperty(process, "execPath", { value: ghostPi, configurable: true });
    try {
      const result = await runSpawnOnce(baseParams(h), callbacksOf(h));

      expect(result.success).toBe(false); // 从未启动 → 失败，不得 success=true 空内容
      expect(result.error).toContain("pi child error:");
      expect(result.error).toContain("ENOENT"); // 原始 errno code 可诊断
      expect(result.error).toContain(ghostPi); // 失败的命令路径可诊断
      expect(result.error).toContain("127"); // 失败折算退出码
      expect(result.failureKind).toBe("unknown"); // 不命中 stale 词表（可重试口径）
      expect(result.content).toBe("");
      expect(result.turns).toBe(0);
      // 子进程从未运行：无 pid 可上报（reportChildSpawned 的 pid 缺失检查）
      expect(h.childSpawned).toHaveLength(0);
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
      restoreHarness(h);
    }
  }, 15_000);
  },
);

describe("runSpawnOnce 集成（stub 子进程翻译/分诊）", () => {
  // ── 形态 A：stub 子进程（翻译/分诊类，进程内桩——默认单测层） ──

  it("[D5 诊断引用写入 journal 记录] 失败（exit 3）→ 终态应答携带 stderrTeePath 且 tee 文件存在（S2 引擎段）", async () => {
    const h = makeStubHarness(exit3Script());
    const result = await runSpawnOnce(baseParams(h), callbacksOf(h));
    expect(result.success).toBe(false);
    expect(result.error).toBe("pi child exited with code 3");
    // 失败伴随路径：载荷含 tee 路径（<dataDir>/logs/pi-task-stderr-<pid>.log 形态）
    expect(result.stderrTeePath).toBeDefined();
    expect(result.stderrTeePath).toMatch(/[/\\]logs[/\\]pi-task-stderr-\d+\.log$/);
    // 文件真实存在且内容为子进程 stderr 产出（懒打开 + close flush 在 run resolve
    // 之后异步收敛——waitFor 等待，对齐上方成功用例的 tee 断言时序）
    await waitFor(() => {
      try {
        return (
          fs.existsSync(result.stderrTeePath!) &&
          fs.readFileSync(result.stderrTeePath!, "utf8").includes("fake-pi stderr boot")
        );
      } catch {
        return false;
      }
    });
  });

  it("[D5 诊断引用写入 journal 记录] 成功 → 终态应答不带 stderrTeePath（tee 存在也不报）", async () => {
    const h = makeStubHarness();
    const result = await runSpawnOnce(baseParams(h), callbacksOf(h));
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.stderrTeePath).toBeUndefined();
  });

  it("header 模式（json mode）：header 行身份落位 + 握手同值去重", async () => {
    const h = makeStubHarness(headerScript());
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
  });

  it("[D1] params.schema → 子进程 env PI_WORKFLOW_SCHEMA = JSON.stringify 本体（逐字节等值）", async () => {
    // 派生注入验收：schema 本体 → buildChildEnv 派生 → spawn 边界 env 入参，全链单次
    // JSON.stringify、无二次转写/包装。断言点 = spawn 边界入参（execve 透传是 OS
    // 事实，非引擎逻辑；旧「孙进程回显」观察通道随 fake 进程一并换成边界捕获）。
    const schema = {
      type: "object",
      properties: {
        answer: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["answer"],
      additionalProperties: false,
    };
    const h = makeStubHarness();
    const runP = runSpawnOnce(
      baseParams(h, { schema, extensionPaths: [ARMED_EXTENSION_PATH] }),
      callbacksOf(h),
    );
    const child = await nextFakeChild();
    await runP;
    // [D3] 武装态 run：schema 任务须带 structured-output 扩展路径（武装断言放行），
    // 回显链路走得到；此处只验派生值逐字节等于 JSON.stringify(schema)
    expect(child.spawnOptions.env.PI_WORKFLOW_SCHEMA).toBe(JSON.stringify(schema));
  });

  it("[D1] 无 schema run：PI_WORKFLOW_SCHEMA 不注入子进程 env", async () => {
    const h = makeStubHarness();
    const runP = runSpawnOnce(baseParams(h), callbacksOf(h));
    const child = await nextFakeChild();
    const result = await runP;
    expect(result.success).toBe(true);
    // schema 声明缺省 → 不注入（env 键不挂）
    expect(child.spawnOptions.env.PI_WORKFLOW_SCHEMA).toBeUndefined();
  });

  it("[D2] extensionPaths → 孙进程 argv 含 --extension <structured-output 路径> + 基座 --no-extensions", async () => {
    // spawn 边界 argv 入参验收（协议化后 argv 镜像机制废弃的显式替代通道）：ctx 还原 →
    // SpawnRunParams.extensionPaths → buildSpawnArgs → spawn 边界 argv。
    const extPath = "/staged/resources/extensions/@zhushanwen/pi-structured-output";
    const h = makeStubHarness();
    const runP = runSpawnOnce(baseParams(h, { extensionPaths: [extPath] }), callbacksOf(h));
    const child = await nextFakeChild();
    await runP;
    const argv = child.spawnOptions.args;
    expect(argv).toContain("--no-extensions");
    // 基座恒带 --extension builtin:codemode（codemode 设计 D8），白名单路径追加其后——
    // 白名单路径须与 --extension 成对出现（以值反查，不经 indexOf 首个 --extension，
    // 那是基座对）
    const extValIdx = argv.indexOf(extPath);
    expect(extValIdx).toBeGreaterThan(0);
    expect(argv[extValIdx - 1]).toBe("--extension");
    // 旧镜像机制的面不再透传（--approve/--no-context-files 属主进程 flag，非孙进程固有）
    expect(argv).not.toContain("--approve");
    expect(argv).not.toContain("--no-context-files");
  });

  it("[D2] extensionPaths 缺省 → 孙进程 argv 仅含基座 --extension builtin:codemode 一对（--no-extensions 仍在）", async () => {
    const h = makeStubHarness();
    const runP = runSpawnOnce(baseParams(h), callbacksOf(h));
    const child = await nextFakeChild();
    await runP;
    const argv = child.spawnOptions.args;
    // 基座恒带 codemode 装载对（codemode 设计 D8）；缺省白名单 = 无第二个 --extension
    expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
    const extIdx = argv.indexOf("--extension");
    expect(argv[extIdx + 1]).toBe("builtin:codemode");
    expect(argv).toContain("--no-extensions");
  });

  it("[D2] extensionPaths dev 源码布局 → spawn 链 argv 透传 + 武装断言②放行（L4 A1 回归锁）", async () => {
    // dev 下 taiji 宿主注入的 extensionPaths 是源码目录（无 @zhushanwen scope 段）。
    // 断言②（schema 任务 + dev 布局路径）走完 spawn 链 = 放行证明；到达 F-1 检查
    // 翻 false（fake 无 structured-output 调用，同上方武装态用例的预期形态）。
    const devExtPath = "/repo/extensions/universal/structured-output";
    const h = makeStubHarness();
    const runP = runSpawnOnce(
      baseParams(h, {
        schema: { type: "object", properties: { answer: { type: "number" } } },
        extensionPaths: [devExtPath],
      }),
      callbacksOf(h),
    );
    const child = await nextFakeChild();
    const result = await runP;
    // 武装断言未拦截（零 spawn 前抛错）→ run 走到 F-1 确定性检查
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("schema_deterministic");
    expect(h.childSpawned).toHaveLength(1);
    // dev 布局路径原样进 argv（透传证明）
    expect(child.spawnOptions.args).toContain(devExtPath);
  });

  it("[F-1] schemaExpected 判定源 = task.schema 声明形态：声明存在且无 structured-output 产出 → 静默成功被拦截", async () => {
    // 判定信号 = params.schema 声明（与 env 注入值解耦）：声明存在 → 检查武装，
    // run 正常结束（exit 0）但无 parsedOutput → 不得静默 success。反面（schema
    // 缺省 → success 保持 true）由上方 [D1] 无 schema run 用例覆盖。
    // [D3] 武装态 run：schema 任务须带 structured-output 扩展路径（武装断言放行）。
    const h = makeStubHarness();
    const result = await runSpawnOnce(
      baseParams(h, { schema: { type: "object", properties: { answer: { type: "number" } } }, extensionPaths: [ARMED_EXTENSION_PATH] }),
      callbacksOf(h),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Structured output failed deterministically:");
    expect(result.failureKind).toBe("schema_deterministic");
  });

  it("[D3] 武装断言接线：native + schema 任务 + structured-output 缺席 → spawn 前 fail-fast（零 spawn + 双形态恢复指引）", async () => {
    const h = makeStubHarness();
    let err: unknown;
    try {
      // 无 extensionPaths = 断言②命中场景（taiji 形态注入源置空 / 独立形态未装
      // peerDep 的同构失败情形——引擎侧两者都是「--extension 无 structured-output」）
      await runSpawnOnce(
        baseParams(h, { schema: { type: "object", properties: { answer: { type: "number" } } } }),
        callbacksOf(h),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = err instanceof Error ? err.message : "";
    expect(msg).toContain("[schema-arming]");
    // 双形态恢复指引（D2 行为变更声明）：taiji 宿主形态 + 独立形态文案都在
    expect(msg).toContain("extension-service");
    expect(msg).toContain("install @zhushanwen/pi-structured-output (peerDependency)");
    expect(msg).toContain("schema-less workflow");
    // 秒级 fail-fast 的接线证明：断言在孙进程 spawn 前抛出——spawn 边界从未被调用
    //（fake 子进程零创建）+ 零事件
    expect(spawnBoundary.current).toBeUndefined();
    expect(h.childSpawned).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("[D3 协议版] 武装回执上报：断言通过 + 孙进程 spawn 成功后 onEvent 收到 armed（先于翻译事件）；无 schema 任务零上报", async () => {
    // 协议版上报 = 宿主独立信号源（引擎自查断言之外的第二道防线）：上报时机 =
    // assertSchemaEnforcementArmed 通过（spawn 前拦截即零上报——上方用例已断言
    // h.events 为空）+ spawnEngineChild 成功返回（「孙进程启动确认」的最强可得形态）。
    const schema = { type: "object", properties: { answer: { type: "number" } } };
    const h = makeStubHarness();
    await runSpawnOnce(
      baseParams(h, { schema, extensionPaths: [ARMED_EXTENSION_PATH] }),
      callbacksOf(h),
    );
    // armed 恰一帧、载荷 = 已核验的武装事实（env 变量名 + 必备扩展包名）
    const armed = h.events.filter((e) => e.type === "armed");
    expect(armed).toEqual([
      { type: "armed", schemaEnvVar: "PI_WORKFLOW_SCHEMA", extensionPkg: "@zhushanwen/pi-structured-output" },
    ]);
    // 时序：armed 先于孙进程 stdout 翻译事件（spawn 后即报，pump 事件必晚于它）
    expect(h.events[0].type).toBe("armed");
    expect(h.events.length).toBeGreaterThan(1);
  });

  it("[D3 协议版] 无 schema 任务不上报 armed（武装概念不适用，宿主等待门只在 schema 任务生效）", async () => {
    const h = makeStubHarness();
    await runSpawnOnce(baseParams(h), callbacksOf(h));
    expect(h.events.some((e) => e.type === "armed")).toBe(false);
  });

  it("[F-1 回归 × D1 归位] env 污染 + 无声明：污染不透传（幽灵 schema env 不达孙进程），检查只认声明形态不武装", async () => {
    // H3 判定源回归（H1 归位后的消费方检查）+ [D1 补强] 传输归位回归：
    // PI_WORKFLOW_SCHEMA 是派生注入键，唯一合法来源 = task.schema 派生——引擎 env
    // 被污染时该键**不透传**到 spawn 边界（结构化输出扩展会按幽灵 schema 校验无
    // schema 任务）；同时 schemaExpected 只认 params.schema 声明形态：env 污染、
    // 声明缺 → 检查不武装，静默成功不被拦截。若判定源回归 env 同源或派生补强退化
    // 回透传，本用例翻红。
    const h = makeStubHarness();
    const polluted = JSON.stringify({ type: "object" });
    process.env.PI_WORKFLOW_SCHEMA = polluted;
    try {
      const runP = runSpawnOnce(baseParams(h), callbacksOf(h));
      const child = await nextFakeChild();
      const result = await runP;
      // [D1 归位] 污染值不透传：spawn 边界 env 无 PI_WORKFLOW_SCHEMA
      expect(child.spawnOptions.env.PI_WORKFLOW_SCHEMA).toBeUndefined();
      // 检查信号源是声明形态：无声明 → schemaExpected 不置位 → 静默成功保持
      expect(result.success).toBe(true);
    } finally {
      delete process.env.PI_WORKFLOW_SCHEMA;
    }
  });

  it("失败退出（exit 3）→ success=false + 结构化 error + unknown 分诊", async () => {
    const h = makeStubHarness(exit3Script());
    const result = await runSpawnOnce(baseParams(h), callbacksOf(h));
    expect(result.success).toBe(false);
    expect(result.error).toBe("pi child exited with code 3");
    expect(result.failureKind).toBe("unknown");
    expect(result.content).toBe("");
    expect(result.sessionId).toBe("fake-sess-1"); // get_state 握手先于 prompt 完成
  });

  it("message_end stopReason=aborted → error 事件 → record.lastError → success=false + stale 分诊", async () => {
    const h = makeStubHarness(stopAbortedScript());
    const result = await runSpawnOnce(baseParams(h), callbacksOf(h));
    expect(h.events.some((e) => e.type === "error")).toBe(true);
    expect(result.success).toBe(false); // exit 0 但 lastError 非空 → 不静默 success
    expect(result.error).toBe("aborted by user");
    expect(result.failureKind).toBe("stale_context"); // "aborted" 命中 stale 词表
  });

  it("轮次时序（modeless 唯一语义）：agent_settled 以 exit 0 口径 resolve run（与 close 信号无关）并收割子进程", async () => {
    const h = makeStubHarness();
    const runP = runSpawnOnce(baseParams(h), callbacksOf(h));
    await nextFakeChild();
    const result = await runP;

    expect(result.success).toBe(true); // resolveChatRun(0)，与 close 信号无关
    expect(result.content).toBe("hello world");
    // 成功 run 轮数 = resolve 时刻快照（真实轮数），按轮清零不得泄漏进收集侧
    expect(result.turns).toBe(1);

    // [H1 U3] resolve 先于收割的证明：stub 子进程永不自行退出——close 只可能来自
    // 引擎的 settled 收割（SIGKILL，signal 折算 137）。run 能以 exit 0 口径应答
    // 只能是 settled 边界的 resolveChatRun(0) 先 settle 了 exitPromise；若收割先行
    // 或以 close 信号定退出码，success 必为 false（本用例会红）。
    // agent_settled resolve 后杀链收割（每轮一进程——续聊 = 新 run + resume 锚点；
    // 不再保活）：active-children 注销 + exited 镜像上报（killed）
    await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
    const exited = h.stateChanges.find((s) => s.state === "exited")!;
    expect(exited.killed).toBe(true);
    expect(getActiveChild("rec-int-1")).toBeUndefined();
  });

  it("model 缺失（非 canonical provider/id）→ prepare 期抛错，不 spawn 子进程", async () => {
    const h = makeStubHarness();
    await expect(
      runSpawnOnce(baseParams(h, { model: undefined }), callbacksOf(h)),
    ).rejects.toThrow(/canonical model ref/);
    expect(h.childSpawned).toHaveLength(0);
    expect(spawnBoundary.current).toBeUndefined();
  });

  it("[M2 ⑦] prepare 期已 abort（signal 预置位）→ 不 spawn，取消终态（无子进程/无 pid 镜像/无事件）", async () => {
    const h = makeStubHarness();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by host: pre-abort before spawn"));
    const result: SpawnRunResult = await runSpawnOnce(
      baseParams(h, { signal: controller.signal }),
      callbacksOf(h),
    );

    // 取消终态：成功位 false + 宿主 cancel 通道既有措辞（signal.reason 透传）；
    // 载荷构造与中途 abort（143）同形——failureKind 落 unknown，不误诊 stale
    expect(result.success).toBe(false);
    expect(result.error).toBe("cancelled by host: pre-abort before spawn");
    expect(result.failureKind).toBe("unknown");
    expect(result.content).toBe("");
    expect(result.sessionId).toBeUndefined();
    // 不 spawn：spawn 边界从未被调用（fake 子进程零创建）+ 无 childSpawned/状态镜像
    // + 无活跃子进程登记 + 零事件
    expect(spawnBoundary.current).toBeUndefined();
    expect(h.childSpawned).toHaveLength(0);
    expect(getActiveChild("rec-int-1")).toBeUndefined();
    expect(h.stateChanges).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
});

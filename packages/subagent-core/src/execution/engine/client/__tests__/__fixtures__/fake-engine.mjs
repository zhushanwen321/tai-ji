// fake 引擎 CLI（W2 EngineClient / RemoteEngine 测试 fixture）。
//
// 形态对齐协议 v1（stdout 独占 NDJSON 帧；stderr 样本；stdin 帧驱动）：
// - 模式（--mode / FAKE_ENGINE_MODE）：normal（缺省）/ crash（启动即崩，stderr 留样本）/
//   hang（不回 initialize 应答，供握手超时）；
// - 协议版本（FAKE_PROTOCOL_VERSION，缺省 1）：版本协商越界测试用；
// - run 动作脚本（FAKE_RUN_ACTIONS，JSON 数组）：emit / streamDelta / poolResolved /
//   handleReady / childSpawned / childStateChanged / askUser / log / delay / spawnGrandchild /
//   exit —— 逐动作播放，播完回 run 终态应答；
// - cancel：受理应答；FAKE_CANCEL_SETTLE=1 时同步收敛 run 终态（测收敛路径），
//   缺省继续挂（测 3s 收敛窗口超时杀链）；
// - spawnGrandchild：spawn 同组长眠子进程（不 detached → 与引擎同组，供组杀断言），
//   pid 经 childSpawned 上报。
//
// 反向请求应答（core → 引擎的帧②，id = 反向请求 id）由 stdin 循环统一分发：
// askUser 的最终结果到达后写入 ASKUSER_RESULTS（动作层取出继续播放）。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : (process.env[name] ?? fallback);
}

const MODE = argOf("--mode", "normal");
const ENGINE_ID = argOf("--engine-id", "fake");
const PROTOCOL_VERSION = Number(argOf("--protocol-version", process.env.FAKE_PROTOCOL_VERSION ?? "1"));
const CANCEL_SETTLES = (argOf("--cancel-settle", process.env.FAKE_CANCEL_SETTLE ?? "0") === "1");
const RUN_HANGS = (argOf("--run-hang", process.env.FAKE_RUN_HANG ?? "0") === "1");
const RUN_ACTIONS = JSON.parse(argOf("--run-actions", process.env.FAKE_RUN_ACTIONS ?? "[]"));

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function sendError(id, code, message) {
  send({ id, error: { code, message, recovery: "inspect the fake engine scenario" } });
}
function reverseRequest(id, method, params) {
  send({ id, method, params });
}

// ── run 状态（cancel 收敛路径用）──
let activeRun = null; // { id, resolve }
const askUserResults = new Map(); // reverse id → result（帧②到达）

function runOutcomeAborted() {
  return {
    handle: {
      v: 1,
      engineId: ENGINE_ID,
      sessionRef: { sessionId: "fake-aborted" },
      poolKey: "shared",
      adapterVersion: "fake-adapter",
    },
    outcome: { content: "", error: "engine_run_failed: aborted (fake)", exitCode: null, engineId: ENGINE_ID },
  };
}

async function playRunActions(requestId) {
  for (const action of RUN_ACTIONS) {
    if (activeRun === null) return; // run 已被 cancel 收敛
    switch (action.op) {
      case "emit":
        send({ method: "event", params: { runId: action.runId ?? "run-1", seq: action.seq ?? 1, event: action.event } });
        break;
      case "streamDelta":
        reverseRequest(`rev-stream-${requestId}`, "host/streamDelta", { runId: action.runId ?? "run-1", delta: action.delta ?? "" });
        break;
      case "poolResolved":
        reverseRequest(`rev-pool-${requestId}`, "host/poolResolved", { runId: action.runId ?? "run-1", poolKey: action.poolKey ?? "shared" });
        break;
      case "handleReady":
        reverseRequest(`rev-ready-${requestId}`, "host/handleReady", {
          runId: action.runId ?? "run-1",
          sessionRef: action.sessionRef ?? { sessionId: "fake-session" },
          poolKey: action.poolKey ?? "shared",
        });
        break;
      case "childSpawned":
        reverseRequest(`rev-child-${requestId}`, "host/childSpawned", { pid: action.pid, recordId: action.recordId ?? "rec-1" });
        break;
      case "childStateChanged":
        reverseRequest(`rev-childst-${requestId}`, "host/childStateChanged", {
          pid: action.pid,
          recordId: action.recordId ?? "rec-1",
          state: action.state ?? "exited",
          killed: action.killed ?? false,
          ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
          ...(action.signal !== undefined ? { signal: action.signal } : {}),
        });
        break;
      case "log":
        reverseRequest(`rev-log-${requestId}`, "host/log", { level: action.level ?? "debug", component: action.component ?? "fake", message: action.message ?? "" });
        break;
      case "askUser": {
        const revId = `rev-ask-${requestId}-${Math.random().toString(36).slice(2, 7)}`;
        reverseRequest(revId, "host/askUser", { runId: action.runId ?? "run-1", request: action.request ?? { method: "select", id: "q1" } });
        // 等两阶段最终结果（ack 之后 core 异步补帧②）——挂起至结果到达。
        await new Promise((resolve) => {
          const poll = setInterval(() => {
            if (askUserResults.has(revId)) {
              clearInterval(poll);
              if (action.echoEvent !== false) {
                send({
                  method: "event",
                  params: { runId: action.runId ?? "run-1", seq: action.seq ?? 99, event: { type: "error", message: `askUser-result:${JSON.stringify(askUserResults.get(revId))}` } },
                });
              }
              resolve();
            }
          }, 20);
        });
        break;
      }
      case "spawnGrandchild": {
        // 同组后代（不 detached）：进程组收割断言对象。node 长眠进程。
        const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: false,
          stdio: "ignore",
        });
        grandchild.unref();
        reverseRequest(`rev-grand-${requestId}`, "host/childSpawned", { pid: grandchild.pid, recordId: action.recordId ?? "rec-grand" });
        break;
      }
      case "delay":
        await new Promise((resolve) => setTimeout(resolve, action.ms ?? 10));
        break;
      case "exit":
        process.stderr.write(action.stderr ?? "fake engine mid-run crash\n");
        process.exit(action.code ?? 137);
        break; // unreachable
      default:
        break;
    }
  }
}

function fakeRunResult(requestId) {
  return {
    handle: {
      v: 1,
      engineId: ENGINE_ID,
      sessionRef: { sessionId: `fake-session-${requestId}` },
      poolKey: "shared",
      engineVersion: "fake-1.0.0",
      adapterVersion: "fake-adapter",
    },
    outcome: {
      content: `fake-content-${requestId}`,
      engineId: ENGINE_ID,
      exitCode: 0,
      durationMs: 1,
    },
  };
}

const CAPABILITIES = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "fixed",
  maxTurns: false,
};

// initialize 应答 capabilities 局部覆盖（gate 位多声明测试：模拟「引擎实态与
// manifest 不符」——如实态 sandbox 降为 none）。仅影响应答，不改变 run 行为。
const CAPS_OVERRIDE = argOf("--caps-override", process.env.FAKE_CAPS_OVERRIDE ?? "");
const ANSWERED_CAPABILITIES = CAPS_OVERRIDE
  ? { ...CAPABILITIES, ...JSON.parse(CAPS_OVERRIDE) }
  : CAPABILITIES;

const MODELS = [
  { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
  { id: "mimo-v2.5-pro", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.5-pro" },
];

if (MODE === "crash") {
  process.stderr.write(`fatal: fake engine boot failure ${"x".repeat(600)}\n`);
  process.exit(1);
}
if (MODE === "hang") {
  // 不回任何帧——握手超时 / 假死场景。保持进程活着。
  setInterval(() => {}, 60_000);
} else {
  // normal：stdin NDJSON 循环
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.method === undefined) {
      // 帧②：反向请求的应答（id 为字符串 = 反向请求 id）
      if (typeof frame.id === "string") askUserResults.set(frame.id, frame.result);
      return;
    }
    const { id, method, params } = frame;
    switch (method) {
      case "initialize":
        send({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            engineId: ENGINE_ID,
            engineVersion: "fake-1.0.0",
            adapterVersion: "fake-adapter",
            capabilities: ANSWERED_CAPABILITIES,
            models: MODELS,
          },
        });
        break;
      case "probe":
        send({ id, result: { ok: true, engineVersion: "fake-1.0.0", checks: [{ name: "boot", ok: true }] } });
        break;
      case "ping":
        send({ id, result: { pong: true } });
        break;
      case "run": {
        if (RUN_HANGS) return; // run 挂起不回终态（cancel 收敛窗口测试）
        const requestId = params?.runId ?? "run-1";
        // run-params 回显：RemoteEngine 帧映射断言的数据源（seq 0）。
        send({
          method: "event",
          params: {
            runId: requestId,
            seq: 0,
            event: { type: "error", message: `run-params:${JSON.stringify({ task: params?.task, ctx: params?.ctx, runId: params?.runId })}` },
          },
        });
        activeRun = { id, resolve: null };
        void (async () => {
          await playRunActions(requestId);
          if (activeRun !== null && activeRun.id === id) {
            activeRun = null;
            send({ id, result: fakeRunResult(requestId) });
          }
        })();
        break;
      }
      case "cancel":
        send({ id, result: { ok: true } });
        if (CANCEL_SETTLES && activeRun !== null) {
          const runFrameId = activeRun.id;
          activeRun = null;
          send({ id: runFrameId, result: runOutcomeAborted() });
        }
        break;
      case "read":
        send({
          id,
          result: {
            engineId: ENGINE_ID,
            sessionId: params?.handle?.sessionRef?.sessionId ?? "fake-session",
            turns: [{ text: "fake turn", thinking: "", toolCalls: [], closed: true }],
            source: "native",
          },
        });
        break;
      case "listModels":
        send({ id, result: { models: MODELS } });
        break;
      case "validateModel":
        send({ id, result: { canonicalRef: params?.modelRef ?? "" } });
        break;
      case "dispose":
        send({ id, result: { ok: true } });
        setTimeout(() => process.exit(0), 20);
        break;
      default:
        sendError(id, "engine_unknown_method", `unknown method ${method}`);
        break;
    }
  });
  // stdin EOF：宿主死亡信号。fake 引擎不实现自灭（自灭守卫归引擎包，SDK 层已测），
  // 但正常退出路径（dispose / 宿主杀组）会终止本进程——EOF 后保活由测试管理。
  rl.on("close", () => {
    // 宿主 stdin 关闭：挂住直到被杀（孤儿场景由 pidfile 清扫/组杀处理）。
    setInterval(() => {}, 60_000);
  });
  process.stderr.write("fake engine ready\n");
}

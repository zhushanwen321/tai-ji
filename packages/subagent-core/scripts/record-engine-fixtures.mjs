#!/usr/bin/env node
// record-engine-fixtures.mjs —— W10 协议基线「录制」入口（真机层手动门工具）。
//
// 用途（设计 §4 录制/复跑口径）：对任一引擎 CLI（真实引擎或 fake）发起一次协议
// 会话，把双向 wire 帧裁剪/脱敏后落 fixture（schemaVersion 1），供
// `test:engine-protocol`（fake 引擎回放 + 白名单逐字段比对）复跑。
//
// 实现形态：极简参考宿主（纯 JS，不依赖 core TS 面）——直接 spawn 引擎 CLI、
// 走协议 v1 stdio NDJSON。这样录制口径 = wire 真形态，不经 EngineClient 的
// 内部语义转换。
//
// 用法：
//   pnpm --filter @zhushanwen/subagent-core record:engine-fixtures \
//     -- --command <node> --args <engine-entry.mjs> --task "smoke task" \
//     [--out <fixture.json>] [--engine-id fake] [--cwd <dir>] [--keep-deltas]
//
// 脱敏规则（录制产物必须可直接入库）：
//   - 绝对路径（$HOME、cwd、tmpdir）→ <workdir>/<home> 占位；
//   - sessionId / runId 之外的随机长 id → 截断保留前 8 字符 + 后缀 (redacted)；
//   - text_delta.delta 正文默认保留结构不比对（复跑侧白名单显式排除）；--keep-deltas
//     关闭时 delta 置 "<redacted>"（省体积，结构等价断言不受影响）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/execution/engine/__tests__/conformance/__fixtures__/engine-protocol/recorded.fixture.json",
);

function argOf(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const command = argOf("--command", process.execPath);
const engineArgs = (argOf("--args", "")).split(" ").filter((s) => s !== "");
const task = argOf("--task", "recorded smoke task (redacted)");
const out = argOf("--out", DEFAULT_OUT);
const engineId = argOf("--engine-id", "recorded");
const cwd = argOf("--cwd", process.cwd());
const keepDeltas = process.argv.includes("--keep-deltas");
const runId = `run-${engineId}-record`;

const home = process.env.HOME ?? "";
function redact(value) {
  if (typeof value === "string") {
    let s = value;
    if (home !== "" && s.includes(home)) s = s.split(home).join("<home>");
    if (s.includes(cwd)) s = s.split(cwd).join("<workdir>");
    if (/^\/(private\/)?var\/folders\//.test(s) || /^\/tmp\//.test(s)) s = "<tmp>";
    return s;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "delta" && !keepDeltas) out[k] = "<redacted>";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

const frames = { hostToEngine: [], engineToHost: [] };
let nextId = 1;
const pending = new Map();

function send(frame) {
  frames.hostToEngine.push(redact(frame));
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

const child = spawn(command, engineArgs, {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  // env 全量继承：目标引擎的旋钮（如 FAKE_PROTOCOL_FIXTURE / XYZ_ZCODE_CLI）经
  // 调用方 env 注入；录制宿主不做白名单（真机层手动门工具，非生产 spawn 点）。
  env: { ...process.env },
});
child.stderr.on("data", () => {}); // 引擎 stderr 不入 fixture（体积 + 脱敏面）

function request(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer, method });
    send({ id, method, params });
  });
}

createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  frames.engineToHost.push(redact(frame));
  if (typeof frame.id === "number" && pending.has(frame.id)) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.error !== undefined) p.reject(new Error(`${p.method} error: ${JSON.stringify(frame.error)}`));
    else p.resolve(frame.result);
    return;
  }
  if (typeof frame.id === "string") {
    // 反向请求：数据面/交互面统一先 ack（录制宿主不做交互，回 unsupported 由引擎自行降级）
    send({ id: frame.id, result: frame.method === "host/askUser" || frame.method === "host/permission"
      ? { unsupported: true } : { ok: true } });
  }
});

child.on("exit", (code, signal) => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(`engine exited (code=${String(code)} signal=${String(signal)})`));
  }
});

const events = [];
function noteEvent(params) {
  if (params?.event?.type) events.push({ type: params.event.type });
}

// 录制主序列：握手 → probe → run（期间事件/反向帧全录）→ dispose
(async () => {
  const initialize = await request("initialize", {
    protocolVersion: 1,
    hostInfo: { name: "record-engine-fixtures", version: "1", dataRoot: "<dataRoot>" },
    engineConfig: {},
  });
  try { await request("probe", { force: false }); } catch { /* probe 失败也继续录 run */ }
  const engineToHostRaw = [];
  const origPush = frames.engineToHost.push.bind(frames.engineToHost);
  frames.engineToHost.push = (f) => { engineToHostRaw.push(f); origPush(f); if (f.method === "event") noteEvent(f.params); };
  let runResult;
  let runError;
  try {
    runResult = await request("run", { runId, task, ctx: { cwd: "<workdir>" } });
  } catch (err) {
    runError = String(err.message);
  }
  try { await request("dispose", {}); } catch { /* 已退出 */ }

  const fixture = {
    _comment: "recorded by packages/subagent-core/scripts/record-engine-fixtures.mjs (W10)；裁剪/脱敏后 wire 帧 + 结构白名单；复跑 = pnpm test:engine-protocol",
    schemaVersion: 1,
    engineId,
    recordedAt: new Date().toISOString(),
    protocolVersion: initialize?.protocolVersion ?? 1,
    wire: frames,
    run: runResult !== undefined ? { result: runResult } : { error: runError },
    events,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`[record-engine-fixtures] wrote ${out} (${frames.engineToHost.length} engine→host frames, ${frames.hostToEngine.length} host→engine frames, ${events.length} events)`);
  process.exit(runError !== undefined ? 1 : 0);
})().catch((err) => {
  console.error(`[record-engine-fixtures] failed: ${err.message}`);
  child.kill("SIGKILL");
  process.exit(1);
});

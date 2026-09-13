#!/usr/bin/env node
// probe/p-t1-lazy-getstate.mjs — 探针 P-T1（⛔ T1 实施前门）
//
// 设计来源：docs/architecture/crash-forensics-and-watchdog.md 附录 E §7.3 P-T1 行 / §7.2 T1 主题。
// 验证断言：agent_end 时子进程（已完成 turn、idle）对 get_state **毫秒级**应答——
// T1「agent_end 决策链惰性回补」方案成立的前提（sessionFile 缺失现场重试 get_state
// 之所以可行，是因为此刻子进程已完成 turn、rpc 主循环空闲，get_state handler 只读
// 内存 state，不走 LLM）。
//
// 受控复现（设计规定形态）：并发 6 路 spawn pi 子进程 + 人为抑制首次握手，断言
// 惰性重试 < 1s 返回 sessionFile。失败 → T1 降级路径（sessionDir 后缀扫描 +
// 无 sessionFile 时按 leaf 短路）。
//
// RC-1 抑制方式：真实链路 spawn 后无条件执行 performGetStateHandshake
//（src/execution/get-state-handshake.ts）；本探针 spawn 后**不执行**握手、直接发
// prompt——agent_end 到达时「sessionFile 从未被采集」（record.sessionFile 语义为空），
// 与 RC-1 的决策现场同构：决策点只能现场发 get_state 回补。
//
// 协议事实权威源 = node_modules 实装版 @earendil-works/pi-coding-agent@0.84.4 dist JS
//（断言前已逐项核验，非 clone 参照）：
//   - spawn args 核心面：--mode rpc --session-dir <dir> --model <provider>/<id>
//     （与 src/execution/session-runner.ts buildSpawnArgs :803-809 一致）
//   - prompt 驱动：stdin {id, type:"prompt", message}（rpc mode 只消费 stdin RpcCommand，
//     positional/-p 被无视；session-runner.ts sendPromptCommand 同构）
//   - get_state 请求：stdin {id, type:"get_state"}（stdin-writer.ts sendGetStateCommand 同构）
//   - get_state 应答：stdout {type:"response", command:"get_state", success, id,
//     data:{sessionFile, sessionId, isStreaming, messageCount, ...}}
//     （dist/modes/rpc/rpc-mode.js:347-363，handler 同步读 session 内存 state）
//   - agent_end 事件：stdout {type:"agent_end", willRetry}（dist/core/agent-session.js:386）
//   - rpc mode 长驻不退出、无 stdin shutdown 命令 → 收尾用 SIGTERM（rpc-mode.js:283
//     有 signal handler）+ SIGKILL 兜底
//
// 运行：node probe/p-t1-lazy-getstate.mjs [--count 6] [--model <ref>] [--smoke]
// 退出码：0 = 全部通过；1 = 存在失败/超时。session 数据目录用 /tmp 隔离，结束即清理。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
// probe/ -> subagent-core/ -> packages/ -> workspace root（pnpm workspace 根存放 hoisted node_modules）
const PKG_ROOT = path.resolve(PROBE_DIR, "..", "..", "..");
/** 实装版 pi 入口（权威源）。node + entry 形态与 pi-invocation.ts getPiInvocation 分支 1 同构。 */
const PI_ENTRY = path.join(
  PKG_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

function readCliVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(PKG_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
        "utf8",
      ),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function parseArgs(argv) {
  const out = { count: 6, model: "xiaomi-token-plan-cn/mimo-v2.5-pro", task: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") out.count = Number(argv[++i]);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--task") out.task = argv[++i];
    else if (a === "--smoke") out.count = 1;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node p-t1-lazy-getstate.mjs [--count 6] [--model <provider/id>] [--task <text>] [--smoke]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(out.count) || out.count < 1) {
    console.error(`invalid --count: ${out.count}`);
    process.exit(2);
  }
  return out;
}

const cliArgs = parseArgs(process.argv.slice(2));
const COUNT = cliArgs.count;
const MODEL = cliArgs.model;
// 极小真实任务：让模型真实推理并完成一个 turn（agent_end 自然到达），token 成本最小化。
const TASK = cliArgs.task ?? "Reply with exactly one word: pong";

/** get_state 应答等待上限（断言目标是 <1000ms；10s 上限只用于判定失败形态，非通过线）。 */
const GET_STATE_WAIT_TIMEOUT_MS = 10_000;
/** 断言通过线（设计 §7.3：「断言惰性重试 < 1s 返回 sessionFile」）。 */
const PASS_BUDGET_MS = 1_000;
/** 单路从 spawn 起的整体兜底（模型不可达/挂死时结束该路并记录形态）。 */
const PER_LANE_HARD_BUDGET_MS = 120_000;
/** 全局兜底（防任何路径 hang 住探针进程）。 */
const GLOBAL_BUDGET_MS = COUNT * 150_000 + 60_000;
/** SIGTERM 后等待子进程退出的宽限，超时升级 SIGKILL。 */
const SIGKILL_GRACE_MS = 5_000;

if (!fs.existsSync(PI_ENTRY)) {
  console.error(`[p-t1] pi entry not found: ${PI_ENTRY}`);
  console.error("[p-t1] recovery: run `pnpm install` at the workspace root, then retry.");
  process.exit(2);
}

const PI_VERSION = readCliVersion();
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p-t1-sessions-"));

// ---------------------------------------------------------------------------
// 单路探测
// ---------------------------------------------------------------------------

/**
 * 运行单路：spawn pi rpc 子进程 →（抑制握手）直接 prompt → agent_end 时惰性发 get_state
 * → 计时应答。resolve 终态记录（成功或任一失败形态）。
 */
function probeLane(index, model) {
  return new Promise((resolve) => {
    /** 终态记录（JSON 报告与断言的直接数据源）。 */
    const rec = {
      lane: index,
      pid: undefined,
      model,
      spawnAt: undefined,
      agentEndAt: undefined,
      turnDurationMs: undefined,
      get_state_sentAt: undefined,
      get_state_latencyMs: undefined,
      sessionFile: undefined,
      sessionFileExists: undefined,
      sessionId: undefined,
      isStreaming: undefined,
      messageCount: undefined,
      pass: false,
      failure: undefined,
      stderrTail: "",
      stdoutSample: [],
    };

    const child = spawn(
      process.execPath,
      // --no-extensions：本探针只测协议面（get_state 应答延迟），用户全局安装的
      // extension（版本漂移）会以无关失败污染探针（冒烟实证：旧版 pi-subagent-workflow
      // 因 subagent-core exports 漂移启动即崩）。真实链路 buildSpawnArgs 的 MirrorFlags
      // 同样支持该 flag 透传，形态一致。
      [PI_ENTRY, "--mode", "rpc", "--no-extensions", "--session-dir", SESSION_DIR, "--model", model],
      { cwd: os.tmpdir(), shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    rec.pid = child.pid;
    rec.spawnAt = performance.now();

    let settled = false;
    let buf = "";
    let get_state_reqId = null;
    let waitTimer = null;
    let hardTimer = null;
    let sigkillTimer = null;
    let closed = false;

    function killChild(reason) {
      if (closed || child.exitCode !== null || child.signalCode) return;
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, SIGKILL_GRACE_MS);
      if (reason) rec.failure ??= reason;
    }

    function finish() {
      if (settled) return;
      settled = true;
      if (waitTimer) clearTimeout(waitTimer);
      if (hardTimer) clearTimeout(hardTimer);
      killChild();
      // 等子进程退出后再 resolve（防孤儿进程写文件与目录清理竞争）。
      const onExit = () => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve(rec);
      };
      if (child.exitCode !== null || child.signalCode) onExit();
      else child.once("close", onExit);
    }

    hardTimer = setTimeout(() => {
      rec.failure ??= `lane hard budget exceeded (${PER_LANE_HARD_BUDGET_MS}ms) — no agent_end / no response`;
      finish();
    }, PER_LANE_HARD_BUDGET_MS);

    child.on("error", (err) => {
      rec.failure ??= `spawn error: ${err.message}`;
      finish();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      rec.stderrTail = (rec.stderrTail + chunk).slice(-2000);
    });

    // RC-1 抑制：spawn 后不执行首次 get_state 握手（真实链路此处无条件
    // performGetStateHandshake），直接发 prompt。prompt 写入即计时参照。
    child.stdin.write(JSON.stringify({ id: randomUUID(), type: "prompt", message: TASK }) + "\n");

    /** agent_end 到达：记录 turn 计时并现场发 get_state（T1 惰性回补决策现场）。 */
    function handleAgentEndEvt(obj) {
      // willRetry=true 是 agent 层重试信号，非本轮完成（session-runner isAgentEndEvt 同判定）。
      if (obj.willRetry === true) return;
      if (rec.agentEndAt !== undefined) return; // 只认首个自然 agent_end
      rec.agentEndAt = performance.now();
      rec.turnDurationMs = rec.agentEndAt - rec.spawnAt;
      // ---- T1 惰性回补决策现场：此刻 sessionFile 从未采集（RC-1 抑制），现场发 get_state ----
      get_state_reqId = randomUUID();
      rec.get_state_sentAt = performance.now();
      try {
        child.stdin.write(JSON.stringify({ id: get_state_reqId, type: "get_state" }) + "\n");
      } catch (err) {
        rec.failure ??= `stdin write on get_state failed: ${err?.message ?? err}`;
        finish();
        return;
      }
      waitTimer = setTimeout(() => {
        rec.failure ??=
          `get_state no response within ${GET_STATE_WAIT_TIMEOUT_MS}ms after agent_end (idle process silent — T1 lazy retry assumption broken)`;
        finish();
      }, GET_STATE_WAIT_TIMEOUT_MS);
    }

    /** get_state 应答与本路请求 id 匹配（迟到/错路 response 不认）。 */
    function isGetStateResponse(obj) {
      return (
        obj.type === "response" &&
        obj.command === "get_state" &&
        typeof obj.id === "string" &&
        obj.id === get_state_reqId
      );
    }

    /** 采集 get_state 应答字段到 rec（宽松形态校验：非字符串/空串归 undefined）。 */
    function recordGetStateFields(obj) {
      rec.get_state_latencyMs = performance.now() - rec.get_state_sentAt;
      const d = obj.data && typeof obj.data === "object" ? obj.data : {};
      rec.sessionFile = typeof d.sessionFile === "string" && d.sessionFile.length > 0 ? d.sessionFile : undefined;
      rec.sessionId = typeof d.sessionId === "string" && d.sessionId.length > 0 ? d.sessionId : undefined;
      rec.isStreaming = d.isStreaming;
      rec.messageCount = d.messageCount;
    }

    /** 四段判定（success / sessionFile 非空 / 预算 / 落盘），失败形态写 rec.failure。 */
    function judgeGetStateOutcome(obj) {
      if (obj.success !== true) {
        rec.failure ??= `get_state responded success=false (error: ${obj.error ?? "n/a"})`;
      } else if (!rec.sessionFile) {
        rec.failure ??= "get_state responded but data.sessionFile empty — sessionFile cannot be backfilled";
      } else if (rec.get_state_latencyMs >= PASS_BUDGET_MS) {
        rec.failure ??= `latency ${rec.get_state_latencyMs.toFixed(1)}ms >= ${PASS_BUDGET_MS}ms budget`;
      } else {
        rec.sessionFileExists = fs.existsSync(rec.sessionFile);
        if (!rec.sessionFileExists) {
          rec.failure ??= `sessionFile reported but not on disk: ${rec.sessionFile}`;
        }
      }
    }

    /** get_state 应答到达：采集字段 → 判定 → 终态。 */
    function handleGetStateResponse(obj) {
      recordGetStateFields(obj);
      judgeGetStateOutcome(obj);
      rec.pass = rec.failure === undefined;
      finish();
    }

    /** stdout 分帧：拆行 → JSON.parse（坏行入 stdoutSample）→ 按事件类别分派。 */
    function onStdoutChunk(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          if (rec.stdoutSample.length < 5) rec.stdoutSample.push(line.slice(0, 200));
          continue;
        }
        if (settled) continue;
        if (obj.type === "agent_end") {
          handleAgentEndEvt(obj);
          continue;
        }
        if (isGetStateResponse(obj)) {
          handleGetStateResponse(obj);
          continue;
        }
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onStdoutChunk);

    child.once("close", (code, signal) => {
      closed = true;
      if (!settled) {
        rec.failure ??= `child exited before agent_end/response (code=${code}, signal=${signal})`;
        if (rec.stderrTail) rec.failure += ` | stderr tail: ${rec.stderrTail.slice(-400)}`;
        if (hardTimer) clearTimeout(hardTimer);
        if (waitTimer) clearTimeout(waitTimer);
        settled = true;
        resolve(rec);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const globalTimer = setTimeout(() => {
  console.error(`[p-t1] global budget ${GLOBAL_BUDGET_MS}ms exceeded — aborting probe process`);
  process.exit(3);
}, GLOBAL_BUDGET_MS);

console.log(`[p-t1] pi entry : ${PI_ENTRY}`);
console.log(`[p-t1] pi ver   : ${PI_VERSION} (node_modules installed; PATH pi may differ)`);
console.log(`[p-t1] model    : ${MODEL}`);
console.log(`[p-t1] lanes    : ${COUNT} (concurrent)`);
console.log(`[p-t1] task     : ${JSON.stringify(TASK)}`);
console.log(`[p-t1] sessionDir: ${SESSION_DIR} (RC-1 suppression: no first get_state handshake before prompt)`);

const t0 = performance.now();
const results = await Promise.all(Array.from({ length: COUNT }, (_, i) => probeLane(i, MODEL)));
const wallMs = performance.now() - t0;
clearTimeout(globalTimer);

// 汇总输出（人读表 + JSON 行，供报告摘录）
console.log("\nlane | pid       | turn_ms  | get_state_latency_ms | sessionFile                                              | result");
console.log("-----+-----------+----------+----------------------+----------------------------------------------------------+-------");
for (const r of results) {
  const lat = r.get_state_latencyMs !== undefined ? r.get_state_latencyMs.toFixed(1) : "-";
  const turn = r.turnDurationMs !== undefined ? r.turnDurationMs.toFixed(0) : "-";
  const file = r.sessionFile ? path.basename(r.sessionFile) : "(none)";
  const verdict = r.pass ? "PASS" : `FAIL: ${r.failure}`;
  console.log(
    `${String(r.lane).padStart(4)} | ${String(r.pid ?? "-").padStart(9)} | ${turn.padStart(8)} | ${lat.padStart(20)} | ${file.padEnd(56)} | ${verdict}`,
  );
}

const latencies = results.filter((r) => r.pass).map((r) => r.get_state_latencyMs);
const allPass = results.length > 0 && results.every((r) => r.pass);
const summary = {
  probe: "P-T1",
  assertion: "agent_end idle child answers get_state < 1000ms with sessionFile",
  piEntry: PI_ENTRY,
  piVersionInstalled: PI_VERSION,
  model: MODEL,
  lanes: COUNT,
  passCount: results.filter((r) => r.pass).length,
  failCount: results.filter((r) => !r.pass).length,
  latencies_ms: results.map((r) => ({
    lane: r.lane,
    latencyMs: r.get_state_latencyMs !== undefined ? Number(r.get_state_latencyMs.toFixed(1)) : null,
    turnMs: r.turnDurationMs !== undefined ? Number(r.turnDurationMs.toFixed(0)) : null,
    isStreaming: r.isStreaming ?? null,
    messageCount: r.messageCount ?? null,
    pass: r.pass,
    failure: r.failure ?? null,
  })),
  maxLatencyMs: latencies.length ? Number(Math.max(...latencies).toFixed(1)) : null,
  wallMs: Number(wallMs.toFixed(0)),
  verdict: allPass ? "PASS" : "FAIL",
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);

// 临时会话数据目录清理（探针脚本与报告不删）
try {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  console.log(`\n[p-t1] cleaned temp session dir: ${SESSION_DIR}`);
} catch (err) {
  console.warn(`\n[p-t1] WARN: failed to clean ${SESSION_DIR}: ${err?.message ?? err}`);
}

process.exit(allPass ? 0 : 1);

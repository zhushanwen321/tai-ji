// probe/p-t2c-settled-window.mjs
//
// 探针 P-T2c：chatMode post-run（agent_end → agent_settled）真实时长分布。
// 支撑设计 T2-③「settled 等待固定硬上限（默认 10min）」的标定
//（docs/architecture/crash-forensics-and-watchdog.md 附录 E §7.2 T2-③ / §7.3 P-T2c 行）。
//
// 方法：真实 pi 会话（--mode rpc，xiaomi-token-plan-cn/mimo-v2.5-pro）串行多轮
// prompt（3 短 + 2 长上下文），每轮记录 agent_end 与 agent_settled 两事件行的
// 接收时刻差。pi stdout JSONL 事件行不带时间戳，由本探针在接收时打点。
//
// 运行：node probe/p-t2c-settled-window.mjs   （在 packages/subagent-core/ 下）
// 产出：stdout 统计 JSON + 同目录 p-t2c-results.json（供报告引用）。
// 会话数据隔离在 /tmp/p-t2c-<runid>/，结束时清理。

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";
// pi 路径动态解析（后台 shell PATH 可能不含 nvm bin；禁止写死个人绝对路径）
function resolvePi() {
  try {
    return execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    console.error("FATAL: pi CLI not found on PATH");
    process.exit(1);
  }
}
const PI_BIN = resolvePi();
const ROUND_TIMEOUT_MS = 300_000; // 单轮等 settled 上限 5min（远大于 10min 上限的标定目标量级，足够区分秒级 vs 分钟级）
const TOTAL_BUDGET_MS = 600_000; // 探针总预算 10min
const STARTED = Date.now();

const results = {
  probe: "P-T2c",
  model: MODEL,
  startedAt: new Date(STARTED).toISOString(),
  rounds: [],
  invalidLines: 0,
  abortedReason: null,
};

function log(msg) {
  process.stdout.write(`[p-t2c ${((Date.now() - STARTED) / 1000).toFixed(1)}s] ${msg}\n`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  // 最近邻法；样本 < 100 时 P99 退化 ≈ max，报告须注明
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// 长上下文文本（约 sizeKB KB 的重复可读文本）
function makeLongText(sizeKB) {
  const unit =
    "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. " +
    "How vexingly quick daft zebras jump. Sphinx of black quartz, judge my vow. ";
  const block = unit.repeat(16); // ~1.6KB
  const repeated = block.repeat(Math.ceil((sizeKB * 1024) / block.length));
  return (
    `Below is a large reference document (~${sizeKB}KB) for context expansion testing.\n\n` +
    repeated +
    `\n\nEnd of document. Reply with exactly one short sentence: how many sentences started the document?`
  );
}

const ROUND_PLANS = [
  { id: "r1", label: "short-1", message: "Reply with exactly: OK-1. No other text." },
  { id: "r2", label: "short-2", message: "Reply with exactly: OK-2. No other text." },
  { id: "r3", label: "short-3", message: "Reply with exactly: OK-3. No other text." },
  { id: "r4", label: "long-60KB", message: makeLongText(60) },
  { id: "r5", label: "long-120KB", message: makeLongText(120) },
  // compact 场景尝试：400KB（~100k tokens）逼近 auto-compact 阈值；
  // 若模型上下文超限拒绝，则如实登记「compact 场景不可复现」
  { id: "r6", label: "long-400KB-compact-attempt", message: makeLongText(400) },
];

// 会话数据隔离在 /tmp（任务要求；os.tmpdir() 在 macOS 返回 /var/folders 不符）
const sessionDir = mkdtempSync("/tmp/p-t2c-");
log(`session dir: ${sessionDir}`);

const child = spawn(
  PI_BIN,
  // --no-extensions：本机全局 extension（npm 版 pi-subagent-workflow）加载 fatal
  // 导致 pi exit 1（与探针目标无关的安装漂移）；settled 窗口是 core 语义，
  // 无扩展形态为最小变量基线（偏差已在报告登记）。
  ["--mode", "rpc", "--no-extensions", "--session-dir", sessionDir, "--model", MODEL, "--approve"],
  { stdio: ["pipe", "pipe", "pipe"] },
);

let stdoutBuf = "";
let agentEndAt = null; // 当前轮 agent_end 接收时刻
let currentRound = null;
let pendingRounds = [...ROUND_PLANS];
let startedRound = false;

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (line.trim()) handleLine(line);
  }
});
child.stderr.on("data", (c) => {
  const s = c.toString().trim();
  if (s) log(`stderr: ${s.slice(0, 200)}`);
});

/** prompt 应答：success 记 ack；失败标记该轮失败并推进下一轮。 */
function handlePromptResponse(ev, now) {
  if (!(ev.type === "response" && ev.command === "prompt")) return false;
  if (ev.success) {
    log(`round ${currentRound?.id ?? "?"} prompt ack (${now - STARTED}ms since start)`);
  } else {
    // 单轮拒绝（如上下文超限）不中止探针：标记该轮失败，已完成轮次仍有效
    log(`round ${currentRound?.id ?? "?"} prompt FAILED: ${ev.error}`);
    if (currentRound) {
      currentRound.error = `prompt rejected: ${ev.error}`;
      results.rounds.push(currentRound);
      currentRound = null;
      agentEndAt = null;
      sendNextRound();
    }
  }
  return true;
}

/** agent_end：当前轮首个 agent_end 打点（后续重复事件忽略）。 */
function handleAgentEnd(ev, now) {
  if (!(ev.type === "agent_end" && currentRound && agentEndAt === null)) return false;
  agentEndAt = now;
  log(`round ${currentRound.id} agent_end`);
  return true;
}

/** compaction 事件打点：判定 settled 窗口内是否含 auto-compact（设计要标的最坏形态）。 */
function handleCompactionEvent(ev, now) {
  if (!((ev.type === "compaction_start" || ev.type === "compaction_end") && currentRound)) return false;
  currentRound.compactionEvents ??= [];
  currentRound.compactionEvents.push({
    type: ev.type,
    atMsFromAgentEnd: agentEndAt !== null ? now - agentEndAt : null,
  });
  log(`round ${currentRound.id} ${ev.type}`);
  return true;
}

/** agent_settled（已见 agent_end）：记录 gap、收轮、推进下一轮。 */
function handleAgentSettled(ev, now) {
  if (!(ev.type === "agent_settled" && currentRound && agentEndAt !== null)) return false;
  const gap = now - agentEndAt;
  currentRound.agentEndToSettledMs = gap;
  currentRound.settledAt = new Date(now).toISOString();
  log(`round ${currentRound.id} agent_settled (gap=${gap}ms)`);
  results.rounds.push(currentRound);
  currentRound = null;
  agentEndAt = null;
  sendNextRound();
  return true;
}

/** settled 在 agent_end 打点前到达（理论上不该发生）——记录为异常样本。 */
function warnSettledWithoutAgentEnd(ev) {
  if (!(ev.type === "agent_settled" && currentRound && agentEndAt === null)) return;
  log(`WARN: agent_settled without prior agent_end in round ${currentRound.id}`);
}

function handleLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    results.invalidLines += 1;
    return;
  }
  const now = Date.now();
  if (handlePromptResponse(ev, now)) return;
  if (handleAgentEnd(ev, now)) return;
  if (handleCompactionEvent(ev, now)) return;
  if (handleAgentSettled(ev, now)) return;
  warnSettledWithoutAgentEnd(ev);
}

function sendNextRound() {
  const plan = pendingRounds.shift();
  if (!plan) {
    log("all rounds complete");
    finish(0);
    return;
  }
  currentRound = {
    id: plan.id,
    label: plan.label,
    promptSentAt: new Date().toISOString(),
    promptBytes: plan.message.length,
    agentEndToSettledMs: null,
  };
  startedRound = true;
  child.stdin.write(JSON.stringify({ type: "prompt", message: plan.message, id: plan.id }) + "\n");
  log(`round ${plan.id} (${plan.label}, ${plan.message.length}B) prompt sent`);
}

const totalTimer = setTimeout(() => {
  results.abortedReason = "total budget exceeded (10min)";
  finish(3);
}, TOTAL_BUDGET_MS);

function watchdogRound() {
  if (currentRound && Date.now() - new Date(currentRound.promptSentAt).getTime() > ROUND_TIMEOUT_MS) {
    results.abortedReason = `round ${currentRound.id} exceeded ${ROUND_TIMEOUT_MS}ms waiting for settled`;
    finish(4);
  }
}
const roundTimer = setInterval(watchdogRound, 5_000);

let exitCode = 99;
function finish(code) {
  if (exitCode !== 99) return; // 幂等
  exitCode = code;
  clearTimeout(totalTimer);
  clearInterval(roundTimer);
  const gaps = results.rounds.map((r) => r.agentEndToSettledMs).filter((g) => typeof g === "number");
  const sorted = [...gaps].sort((a, b) => a - b);
  results.summary = {
    sampleCount: gaps.length,
    gapsMs: gaps,
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
    p50Ms: percentile(sorted, 50),
    p99Ms: percentile(sorted, 99),
    p99Note: sorted.length < 100 ? "样本数 <100，P99 为最近邻保守值（≈max）" : null,
    cap10minComparison:
      sorted.length > 0
        ? `${((sorted.at(-1) ?? 0) / 60000).toFixed(2)}min max vs 10min cap = ${((sorted.at(-1) ?? 0) / 600000).toFixed(3)}x`
        : "no samples",
  };
  try {
    writeFileSync(new URL("./p-t2c-results.json", import.meta.url), JSON.stringify(results, null, 2));
  } catch (e) {
    log(`WARN: failed to write results json: ${e.message}`);
  }
  log(`summary: ${JSON.stringify(results.summary)}`);
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
    process.exit(exitCode);
  }, 1500);
}

child.on("exit", (code) => {
  if (exitCode === 99 && startedRound && currentRound) {
    results.abortedReason = "pi exited mid-round";
    log(`pi exited (code=${code}) mid-round ${currentRound.id}`);
    finish(5);
  }
});

child.on("error", (err) => {
  if (exitCode === 99) {
    results.abortedReason = `spawn error: ${err.message}`;
    log(`FATAL: ${err.message}`);
    finish(6);
  }
});

// 等 pi rpc 就绪（无显式 ready 事件；实测 1.5s 足够 stdin 缓冲前的握手，命令会排队）
setTimeout(() => sendNextRound(), 1500);

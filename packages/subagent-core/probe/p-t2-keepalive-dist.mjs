// probe/p-t2-keepalive-dist.mjs
//
// 探针 P-T2：keep-alive 真实时长分布——T2-①「keep-alive 裸缺省默认上限 30min」
// 不误杀真实 wave 场景的标定依据（docs/architecture/crash-forensics-and-watchdog.md 附录 E
// §7.2 T2-① / §7.3 P-T2 行）。
//
// 决策树（按设计降级路径顺序执行）：
//   ① 优先回溯历史数据：扫描本机 ~/.pi/agent/sessions/ 与 ~/.pi/agent/cw/ 下
//      session JSONL 中的 `subagent-record` 自描述 entry（record 每次状态迁移
//      append 完整快照，见 src/execution/record-entry.ts）。keep-alive 窗口 =
//      closed entry timestamp − 同 record 最后一条非 closed entry timestamp。
//   ② 样本不足（<20）→ 如实登记，并给出路径②（真实任务补样本）的建议与脚本形态。
//   ③ 不可得 → 报告「数据不足」，建议 u-t2a 按设计降级路径 B（无进展检测语义）实现。
//
// 口径说明（写进报告防误读）：
//   - keepAliveWindowMs 是下界口径：closed entry 的写点时刻 − 最后一次非 closed
//     状态迁移写点时刻。真实 keep-alive ≥ 此值（最后迁移写点早于 run 实际结束
//     的误差 ≤ 单轮写点粒度）。
//   - closedReason=parent-shutdown 的样本表示「宿主从未主动关，父进程退出才级联
//     收敛」——正是设计语境「wave keep-alive 数小时是合法形态」的直接证据面。
//
// 运行：node probe/p-t2-keepalive-dist.mjs
// 产出：stdout 统计 + 同目录 p-t2-results.json。只读历史数据，无写副作用。

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCAN_ROOTS = [join(HOME, ".pi/agent/sessions"), join(HOME, ".pi/agent/cw")];
const MIN_SAMPLES = 20; // 设计决策树的样本门槛

function log(msg) {
  process.stdout.write(`[p-t2] ${msg}\n`);
}
function toMs(t) {
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const v = Date.parse(t);
    return Number.isNaN(v) ? null : v;
  }
  return null;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}
function dist(sorted) {
  if (!sorted.length) return { count: 0 };
  const s = [...sorted].sort((a, b) => a - b);
  return {
    count: s.length,
    p50Ms: percentile(s, 50),
    p90Ms: percentile(s, 90),
    p95Ms: percentile(s, 95),
    p99Ms: percentile(s, 99),
    p99Note: s.length < 100 ? "样本 <100，P99 为最近邻保守值（≈max）" : null,
    maxMs: s.at(-1),
  };
}

// ① 预筛含 subagent-record 的 session 文件（grep 快，避免全量逐文件读）
const files = [];
for (const root of SCAN_ROOTS) {
  try {
    const out = execFileSync("grep", ["-rl", "--include=*.jsonl", "subagent-record", root], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    files.push(...out.split("\n").filter(Boolean));
  } catch (e) {
    if (e.status !== 1) log(`WARN: grep on ${root} failed: ${e.message}`);
  }
}
log(`scanned roots: ${SCAN_ROOTS.join(", ")}`);
log(`files containing subagent-record entries: ${files.length}`);

// ② 抽 entry 并按 record id 分组
const records = new Map(); // id -> { entries: [{ts, data}], file }
let entryCount = 0;
let parseErrors = 0;
for (const f of files) {
  let content;
  try {
    content = execFileSync("grep", ["subagent-record", f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    continue;
  }
  for (const line of content.split("\n")) {
    if (!line.includes("subagent-record")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    const ts = toMs(e.timestamp);
    const data = e.data ?? {};
    if (!data.id || ts === null) continue;
    if (!records.has(data.id)) records.set(data.id, { entries: [], file: f });
    records.get(data.id).entries.push({ ts, data });
    entryCount += 1;
  }
}
log(`records: ${records.size}, entries: ${entryCount}, parse errors: ${parseErrors}`);

// ③ 计算每条 record 的 keep-alive 窗口
const samples = [];
let negativeWindows = 0;
let missingClosed = 0;
for (const { entries } of records.values()) {
  entries.sort((a, b) => a.ts - b.ts);
  const closed = entries.filter((e) => e.data.status === "closed").at(-1);
  if (!closed) {
    missingClosed += 1;
    continue;
  }
  const beforeClosed = entries.filter((e) => e.ts < closed.ts && e.data.status !== "closed");
  const lastActive = beforeClosed.at(-1);
  const first = entries[0];
  const windowMs = lastActive ? closed.ts - lastActive.ts : closed.ts - first.ts;
  if (windowMs < 0) {
    negativeWindows += 1;
    continue;
  }
  samples.push({
    id: closed.data.id,
    mode: closed.data.mode,
    closedReason: closed.data.closedReason ?? null,
    agent: closed.data.agent,
    depth: closed.data.depth ?? 0,
    turns: closed.data.turns,
    round: closed.data.round ?? null,
    keepAliveWindowMs: windowMs,
    totalLifetimeMs: closed.ts - first.ts,
    startedAt: new Date(first.ts).toISOString(),
    closedAt: new Date(closed.ts).toISOString(),
  });
}
log(`closed records: ${samples.length}, no-closed-entry: ${missingClosed}, negative windows excluded: ${negativeWindows}`);

// ④ 分布统计：全局 + mode 分桶 + closedReason 分桶 + >30min 占比
const allWindows = samples.map((s) => s.keepAliveWindowMs);
const THIRTY_MIN = 30 * 60 * 1000;
const bucket = (key) => {
  const map = {};
  for (const s of samples) {
    const k = s[key] ?? "null";
    (map[k] ??= []).push(s.keepAliveWindowMs);
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, dist(v)]));
};

const summary = {
  probe: "P-T2",
  path: "①历史数据回溯",
  scannedRoots: SCAN_ROOTS,
  filesWithRecords: files.length,
  totalRecords: records.size,
  closedSamples: samples.length,
  excludedNoClosed: missingClosed,
  excludedNegativeWindow: negativeWindows,
  global: dist(allWindows),
  over30min: {
    count: allWindows.filter((w) => w > THIRTY_MIN).length,
    ratio: allWindows.length ? (allWindows.filter((w) => w > THIRTY_MIN).length / allWindows.length).toFixed(3) : null,
  },
  byMode: bucket("mode"),
  byClosedReason: bucket("closedReason"),
  minSamplesThreshold: MIN_SAMPLES,
  decisionTreeNode:
    samples.length >= MIN_SAMPLES
      ? `样本 ${samples.length} ≥ ${MIN_SAMPLES}，走路径①定案（分布即输入）`
      : `样本 ${samples.length} < ${MIN_SAMPLES}，路径①不足——需走路径②（真实任务补样本）或按设计降级路径 B`,
};

// ⑤ 输出
log("==== SUMMARY ====");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
// 样本明细（报告附表用，按窗口降序前 30）
summary.topSamples = [...samples].sort((a, b) => b.keepAliveWindowMs - a.keepAliveWindowMs).slice(0, 30);
try {
  writeFileSync(new URL("./p-t2-results.json", import.meta.url), JSON.stringify({ summary, samples }, null, 2));
  log("results written to probe/p-t2-results.json");
} catch (e) {
  log(`WARN: write results failed: ${e.message}`);
}

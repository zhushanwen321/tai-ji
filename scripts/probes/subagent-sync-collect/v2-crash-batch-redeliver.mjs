#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/v2-crash-batch-redeliver.mjs
//
// [V2] 含成功成员的崩溃批补发（v2 设计 §4 验收表 V2 行〔设计文档已删，git 可追溯〕/ GV2①）
// 3 个 sync（2 快任务先完成 + 1 sleep 240s 在跑）→ 批等待中 **SIGKILL** 宿主
// （不是 SIGTERM——SIGTERM 走 dispose/E9 转换路径，测不到 E1；kill 时 2 成员
// 已终态未通知、批未闭合）→ 重启同 session → 断言：
//   - 重启 #1 后收到**单条**补发批通知（v1 三重断：候选空 / 口径顶死 / 无再驱动，
//     v2 orphan 覆写保标记 + E1 resumable 口径 + 补发路径修复后可达）；
//   - 含 2 个成功成员正文（result 全文来自覆写 entry 的 merge 保留）；
//   - 批头计数与成员终态形态一致（慢成员经 gc 依子文件末行完整性二选一：
//     3 finished / 2 finished + 1 failed 两形态均合法，cancelled 恒 0）；
//   - 重启 #2 零重发（账本 sync-batch:<hash> 幂等键 + batchFinalized 落标）。
//
// 用法：node v2-crash-batch-redeliver.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   含 240s sleep + 三次进程生命周期，长时场景——总时长约 5-8 分钟。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as C from "./common.mjs";

const SCENARIO = "V2";
const DESIGN = "subagent-sync-collect-v2.md §4 验收表 V2（含成功成员的崩溃批补发 + 二次重启零重发）";
const EXPECT = "SIGKILL 后重启 #1 单条补发批（含 2 成功成员 result 全文，批头 finished/failed 两形态）→ 重启 #2 零重发";

const FAST_RESULTS = ["V2-OK-1", "V2-OK-2"];

/** 慢成员 sleep 秒数——task 模板与按 task 文本定位慢成员（"sleep 240"）的唯一来源，
 *  防 task 实际值与定位串脱节（曾漂移：task sleep 240 vs 定位 includes("sleep 90")）。 */
const SLOW_SLEEP_SECONDS = 240;

/** 等进程真正死亡（exitCode 或 signalCode 置位；SIGKILL 下 exitCode 保持 null）。 */
async function waitDead(session, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const c = session.child;
    if (c.exitCode !== null || c.signalCode !== null) return true;
    if (Date.now() - start > timeoutMs) return false;
    await C.sleep(100);
  }
}

/** 主 session 文件：RPC 捕获优先，兜底 sessionDir 下唯一 .jsonl。 */
function resolveSessionFile(session, ws) {
  if (session.sessionFile) return session.sessionFile;
  const files = readdirSync(ws.sessionDir).filter((f) => f.endsWith(".jsonl"));
  return files.length > 0 ? join(ws.sessionDir, files[0]) : null;
}

function spawnRestart(ws, sessionFile, label) {
  return C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd, // 同 cwd → 同 encoded subagents 树（record 恢复语义）
    sessionDir: ws.sessionDir,
    sessionFile,
    model: C.resolveModel(),
    label,
  });
}

/** 补发批头合法性（慢成员 gc 二选一形态）：3 finished / 2 finished + 1 failed。 */
function parseBatchHeader(content) {
  const m = content.split("\n")[0].match(C.BATCH_HEADER_RE);
  if (!m) return null;
  return { finished: Number(m[1]), failed: Number(m[2]), cancelled: Number(m[3]) };
}

/** 主 session 文件中每 id 末条 subagent-record entry data（轮终检测用；形态自适应
 *  customType 在顶层或 data 内、payload 在 data 或扁平——真实 pi 落盘形态以行为准）。 */
function lastRecordEntryById(F) {
  const map = new Map();
  for (const e of C.readJsonlEntries(F)) {
    if (!e) continue;
    const ct = e.customType ?? e.data?.customType;
    if (ct !== "subagent-record") continue;
    const d = e.data && typeof e.data === "object" && typeof e.data.id === "string" ? e.data : typeof e.id === "string" ? e : null;
    if (d) map.set(d.id, d);
  }
  return map;
}

/** 等 n 个 sync 成员在主 session 文件出现轮终末条（result 非空 + resumable——SP-5
 *  one-shot 成员完成形态 doFinalizeRoundToIdle；.finalized sidecar 只在完整终态化
 *  路径写，sync 轮终不写，故不能用 countFinalized 观察完成）。 */
async function waitForRoundTerminal(F, ids, n, timeoutMs) {
  const start = Date.now();
  let interval = 1000;
  const doneOf = () => {
    const last = lastRecordEntryById(F);
    return ids.filter((id) => {
      const d = last.get(id);
      return d && typeof d.result === "string" && d.result.length > 0 && d.resumable === true;
    });
  };
  for (;;) {
    const done = doneOf();
    if (done.length >= n) return done;
    if (Date.now() - start > timeoutMs) {
      const last = lastRecordEntryById(F);
      const states = ids.map((id) => `${id.slice(0, 10)}:result=${JSON.stringify(String(last.get(id)?.result ?? "")).slice(0, 24)},resumable=${last.get(id)?.resumable}`).join(" ");
      throw new Error(`waitForRoundTerminal timeout after ${timeoutMs}ms (want ${n}, got ${done.length}) — ${states}`);
    }
    await C.sleep(interval);
    interval = Math.min(interval * 2, 3000);
  }
}

/** 崩溃窗口构造：等 2 快成员轮终 → 核对批未闭合 → SIGKILL 主 pi（E1 路径，非
 *  dispose/E9）。可继续返回 true；任一门未过（轮终超时 / 批已闭合 / kill 未生效）
 *  返回 false（调用方终止探针，FAIL 已如实留痕）。 */
async function constructCrashWindow(checks, ws, s1, F, syncIds) {
  try {
    const done = await waitForRoundTerminal(F, syncIds, 2, 300000);
    checks.check("2 快成员轮终（主文件末条 result+resumable）", done.length >= 2, `done=${done.length}`);
  } catch (err) {
    checks.check("2 快成员轮终（主文件末条 result+resumable）", false, `${err.message}（子 session 文件=${C.subagentSessionFiles(ws).length}）`);
    return false;
  }
  const preNotify = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  checks.check("kill 前批未闭合（零 notify——批等待中）", preNotify === 0, `notify=${preNotify}`);
  if (preNotify > 0) return false;

  s1.kill("SIGKILL");
  const dead = await waitDead(s1, 8000);
  checks.check("SIGKILL 生效（批等待中、含 2 终态成员）", dead, dead ? "SIGKILL" : "8s 未死");
  return dead;
}

/** 重启 #1 补发断言：单条批 + 批头合法性（gc 二选一形态）+ 成功成员 result 全文 +
 *  条目 id 集一致 + 慢成员正文 note。返回 { head, content }；批缺失返回 null。 */
async function assertRedeliveredBatch(checks, F, deliveredBefore, dispatched) {
  const entries = await C.waitForNotify(
    F,
    240000,
    (ns) => ns.some((n) => C.BATCH_HEADER_RE.test(n.content.split("\n")[0] || "")),
    "补发批通知（含 2 成功成员）",
  );
  const batches = C.syncBatchNotifyEntries(entries);
  const total = C.bgNotifyEntries(entries).length;
  checks.check("重启 #1 补发恰好 1 条批通知", batches.length === 1 && total - deliveredBefore === 1, `batches=${batches.length} total=${total}`);
  if (!batches[0]) return null;
  const batch = batches[0];

  const head = parseBatchHeader(batch.content);
  checks.check(
    "批头合法性（finished≥2 且 finished+failed=3 且 cancelled=0；慢成员 gc 二选一形态）",
    head !== null && head.finished >= 2 && head.finished + head.failed === 3 && head.cancelled === 0,
    head ? `${head.finished} finished, ${head.failed} failed, ${head.cancelled} cancelled` : batch.content.split("\n")[0],
  );

  // 成功成员正文：result 全文（覆写 merge 保留，非 "(empty)"）
  const content = batch.content;
  for (const r of FAST_RESULTS) {
    checks.check(`批 content 含成功成员 result 全文 ${JSON.stringify(r)}`, content.includes(r), r);
  }

  // 条目 id 集 == 派发 sync 成员 id 集
  const segs = C.batchSegments(content);
  checks.check("批头 + 3 条目", segs.length === 4, `segments=${segs.length}`);
  const startIds = new Set(dispatched.map((s) => s.saId));
  const itemIds = new Set(segs.slice(1).map((s) => C.saIdOf(s)).filter(Boolean));
  checks.check(
    "补发条目 id 集 == 派发 sync 成员 id 集",
    startIds.size === 3 && itemIds.size === 3 && [...itemIds].every((id) => startIds.has(id)),
    `items=${itemIds.size} starts=${startIds.size}`,
  );
  // 慢成员条目正文（result 或截断 error 文案，非门仅留痕；dispatchedStarts 产物无
  // slug 字段，按 task 文本定位——定位串与 task 模板同源 SLOW_SLEEP_SECONDS）
  const slowStart = dispatched.find((s) => s.task.includes(`sleep ${SLOW_SLEEP_SECONDS}`));
  if (slowStart) {
    const slowItem = segs.slice(1).find((s) => s.includes(slowStart.saId));
    if (slowItem) checks.note("慢成员条目正文形态（gc 二选一：result / 截断 error）", C.itemResultBody(slowItem).slice(0, 80));
  }
  return { head, content };
}

/** 二次重启：SIGKILL + 同 session 重建 → 30s 观察窗零重发（batchFinalized 落标 +
 *  账本幂等）。返回观察前后 notify 数。 */
async function assertSecondRestartNoRedeliver(checks, ws, F, s2, sessions) {
  await C.sleep(6000); // 落标清态窗口
  const before2 = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  s2.kill("SIGKILL");
  await waitDead(s2, 8000);
  const s3 = spawnRestart(ws, F, `${SCENARIO}-restart2`);
  sessions.push(s3);
  const ready3 = await s3.waitReady();
  checks.check("重启 #2 RPC 就绪", !!ready3, ready3 ? "" : s3.stderrTail());
  await C.sleep(30000); // session_start 恢复钩子触发观察窗
  const after2 = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  checks.check("二次重启零重发（30s 观察窗）", after2 === before2, `before=${before2} after=${after2}`);
  return { before2, after2 };
}

/** RESULTS.md 留痕（补发批头 / 成功成员全文 / 二次重启 notify 前后）。 */
function recordV2Outcome(checks, { head, content }, before2, after2) {
  const summary = checks.summary();
  C.appendResultRecord(SCENARIO, [
    `- 世代: v2 探针（subagent-sync-collect-v2 §4 V2；GV2①）——${summary.passed} PASS / ${summary.failed} FAIL`,
    `- 模式: primary（SIGKILL 于批等待中，2 终态成员 + 1 sleep ${SLOW_SLEEP_SECONDS}s 中）`,
    `- 模型: ${C.resolveModel()}`,
    `- 补发批头: ${head ? `${head.finished} finished, ${head.failed} failed, ${head.cancelled} cancelled` : "(未解析)"}`,
    `- 成功成员 result 全文: ${FAST_RESULTS.every((r) => content.includes(r)) ? "yes（覆写 merge 保留）" : "no"}`,
    `- 二次重启 notify: before=${before2} after=${after2}`,
  ]);
}

async function runProbe(checks, ws, sessions) {
  const s1 = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-main`,
  });
  sessions.push(s1);

  const ready = await s1.waitReady();
  checks.check("pi RPC 就绪", !!ready, ready ? "" : s1.stderrTail());

  const starts = [
    ...FAST_RESULTS.map((r, i) => ({
      task: `Reply with exactly: ${r}. Do not use any tools, do not add any other text.`,
      slug: `v2-fast-${i + 1}`,
      collect: "sync",
    })),
    {
      task:
        `You MUST actually run this exact bash command first: sleep ${SLOW_SLEEP_SECONDS} && echo marker-v2-slow. ` +
        "After it finishes, reply with exactly: v2-slow-done",
      slug: "v2-slow",
      collect: "sync",
    },
  ];
  const prompt = C.dispatchPrompt({ starts });
  const turn = await s1.prompt(prompt, 120000);
  checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

  const F = resolveSessionFile(s1, ws);
  checks.check("主 session 文件可定位", !!F, F || "n/a");
  const dispatched = C.dispatchedStarts(C.readJsonlEntries(F)).filter((s) => s.collect === "sync");
  checks.check("派发 3 个 collect:sync start", dispatched.length === 3, `starts=${dispatched.length}`);
  if (dispatched.length !== 3) return;

  // ── 崩溃窗口构造：2 快成员轮终（主文件末条 result+resumable，SP-5 one-shot 完成
  //  形态——不写 .finalized sidecar），慢成员 sleep 中。mimo 3 并发下快任务实测可达
  //  2-4 分钟：等待 300s，慢任务 sleep 240s 保 kill 时点仍在批等待中。──
  const syncIds = dispatched.map((s) => s.saId);
  if (!(await constructCrashWindow(checks, ws, s1, F, syncIds))) return;

  // ── 重启 #1：E1 补发（orphan 覆写保标记 → 候选非空 → 补发单批 + 落标）──
  const deliveredBefore = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  const s2 = spawnRestart(ws, F, `${SCENARIO}-restart1`);
  sessions.push(s2);
  const ready2 = await s2.waitReady();
  checks.check("重启 #1 RPC 就绪", !!ready2, ready2 ? "" : s2.stderrTail());

  const redelivered = await assertRedeliveredBatch(checks, F, deliveredBefore, dispatched);
  if (!redelivered) return;

  const { before2, after2 } = await assertSecondRestartNoRedeliver(checks, ws, F, s2, sessions);
  recordV2Outcome(checks, redelivered, before2, after2);
}

async function main() {
  if (C.isDryRun(process.argv)) {
    process.exit(
      C.dryRunReport({
        scenarioId: SCENARIO,
        design: DESIGN,
        expect: EXPECT,
        scriptFile: import.meta.url,
        plan: [
          "mkdtemp + spawn pi RPC → 同轮 3 个 collect:sync start（2 快任务 reply exactly + 1 sleep 240s）",
          "等 2 快成员轮终（主 session 末条 subagent-record entry result+resumable——sync one-shot 不写 .finalized）+ 核对零 notify → SIGKILL 主 pi（E1 路径，非 dispose/E9）",
          "重启 #1（同 cwd + 同 session-dir + --session <file>）→ 240s 内补发单条批：含 2 成功成员 result 全文",
          "批头合法性：finished≥2 且 finished+failed=3 且 cancelled=0（慢成员 gc 二选一形态）",
          "二次重启（SIGKILL + 同 session 重建）→ 30s 观察窗 notify 零新增（账本幂等 + 落标）",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("v2-crash");
  const sessions = [];

  try {
    await runProbe(checks, ws, sessions);
  } finally {
    for (const s of sessions) s.kill("SIGKILL");
    for (const s of sessions) await waitDead(s, 3000);
    ws.cleanup();
    // finish 收尾对齐 v1 旧探针（a4/a6）约定，但置于 finally：本场景存在多处
    // check FAIL 后的 early return，若按旧形态放 try 末尾会跳过汇总——FAIL 不置
    // 非零 exit code，DoD 门失去机器可检性。
    checks.finish(SCENARIO);
  }
}

C.runScenario(SCENARIO, main);

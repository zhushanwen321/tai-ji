#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a6-crash-recovery.mjs
//
// [A6] 主 pi 崩溃后的批恢复（D5 降级门）
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A6 行（设计文档已删，git 可追溯）：
//   2 个 collect:"sync"（sleep 60s 任务）→ 批等待中 kill -9 主 pi → 同 session-dir
//   重启 → 断言补发单条批；二次重启零重发。
// 预期输出：
//   - kill -9 于批等待中生效（session 文件尚无 notify entry、2 成员未 finalize）
//   - 重启 #1 后补发恰好 1 条批通知：批头 `2 finished, 0 failed, 0 cancelled`，
//     条目 == 派发的 2 个 sync 成员
//   - 孤儿子进程自行跑完（≥2 个 finalized sidecar）
//   - 二次重启 30s 观察窗内 notify 零新增
//   - kill -9 时序不可构造（批已先行闭合 / SIGKILL 未生效）时自动降级：
//     dispose(SIGTERM)→重建→session_start 恢复钩子，输出与 RESULTS.md 注明降级与原因
//
// 用法：node a6-crash-recovery.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   含 2×60s sleep + 三次进程生命周期，长时场景——主 agent 统一执行。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as C from "./common.mjs";

const SCENARIO = "A6";
const DESIGN = "subagent-sync-collect.md §4 验收表 A6（主 pi 崩溃后批恢复 + 二次重启零重发，D5 降级门）";
const EXPECT = "kill -9 于批等待中；重启补发单条批（2 finished 0 failed）；二次重启零重发；不可构造时降级注明";

const BATCH_HEADER_2 = "Subagent batch completed: 2 finished, 0 failed, 0 cancelled.";

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
    sessionDir: ws.sessionDir, // 同 session-dir
    sessionFile,
    model: C.resolveModel(),
    label,
  });
}

/** kill 窗口构造：静置 8s 后核对零 notify，kill -9 主 pi；批已先行闭合或 SIGKILL 未死
 *  时置降级（SIGTERM dispose 兜底）并打印降级说明。返回 degraded | null。 */
async function constructKillWindow(checks, s1, F) {
  // 静置 8s：让两个子进程越过启动段进入 sleep（kill 窗口稳定）
  await C.sleep(8000);
  const preNotify = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : -1;
  let degraded = null;
  if (preNotify > 0) {
    degraded = { reason: `批在 kill 前已闭合（preNotify=${preNotify}）——kill -9 时序不可构造` };
  } else {
    s1.kill("SIGKILL");
    const dead = await waitDead(s1, 8000);
    if (!dead) {
      degraded = { reason: "SIGKILL 8s 未生效——kill -9 时序不可构造" };
      s1.kill("SIGTERM");
      await waitDead(s1, 10000);
    } else {
      checks.check("kill -9 于批等待中生效", true, "SIGKILL");
    }
  }
  if (degraded) {
    console.log(`  [${SCENARIO}] 降级路径：dispose→重建→session_start 恢复钩子（${degraded.reason}）`);
    checks.note("kill -9 时序不可构造，走降级路径（dispose→重建→session_start 恢复钩子）", degraded.reason);
  }
  return degraded;
}

/** 补发批形状断言（批头 2 finished / details.items / 批头+2 条目 / 条目 id 集一致）。 */
function assertRedeliveredBatchShape(checks, entries, batch) {
  const header = batch.content.split("\n")[0];
  checks.check(`补发批头 \`2 finished, 0 failed, 0 cancelled\``, header === BATCH_HEADER_2, header);
  checks.check("补发 details.items 含 2 成员", Array.isArray(batch.details.items) && batch.details.items.length === 2, `items=${(batch.details.items || []).length}`);
  const segs = C.batchSegments(batch.content);
  checks.check("补发批头 + 2 条目", segs.length === 3, `segments=${segs.length}`);
  const starts = C.dispatchedStarts(entries).filter((s) => s.collect === "sync");
  const startIds = new Set(starts.map((s) => s.saId));
  const itemIds = new Set(segs.slice(1).map((s) => C.saIdOf(s)).filter(Boolean));
  checks.check(
    "补发条目 id 集 == 派发 sync 成员 id 集",
    startIds.size === 2 && itemIds.size === 2 && [...itemIds].every((id) => startIds.has(id)),
    `items=${itemIds.size} starts=${startIds.size}`,
  );
}

/** 重启 #1 主路径（未投递态）：等补发批 + 形状断言 + 孤儿跑完（finalized ≥2）。 */
async function assertCrashRedelivery(checks, ws, F) {
  const entries = await C.waitForNotify(
    F,
    240000,
    (ns) => ns.some((n) => C.BATCH_HEADER_RE.test(n.content.split("\n")[0] || "")),
    "补发批通知",
  );
  const batches = C.syncBatchNotifyEntries(entries);
  const total = C.bgNotifyEntries(entries).length;
  checks.check("补发恰好 1 条批通知", batches.length === 1 && total === 1, `batches=${batches.length} total=${total}`);
  if (batches[0]) {
    assertRedeliveredBatchShape(checks, entries, batches[0]);
  }
  try {
    const n = await C.waitForFinalized(ws, 2, 90000);
    checks.check("孤儿子进程自行跑完（finalized ≥2）", n >= 2, `finalized=${n}`);
  } catch (err) {
    checks.check("孤儿子进程自行跑完（finalized ≥2）", false, err.message);
  }
}

/** 重启 #1 降级路径（已投递态）：30s 观察窗零重复投递。 */
async function assertNoDuplicateOnDelivered(checks, F) {
  const before = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  await C.sleep(30000);
  const after = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  checks.check("[重启 #1] 已投递态零重复投递", after === before, `before=${before} after=${after}`);
}

/** 二次重启：SIGKILL + 同 session 重建 → 30s 观察窗零重发。返回观察前后 notify 数。 */
async function assertSecondRestartNoRedeliver(checks, ws, F, s2, sessions) {
  await C.sleep(6000); // 恢复钩子清态落盘
  const before2 = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : 0;
  s2.kill("SIGKILL");
  await waitDead(s2, 8000);
  const s3 = spawnRestart(ws, F, `${SCENARIO}-restart2`);
  sessions.push(s3);
  const ready3 = await s3.waitReady();
  checks.check("重启 #2 RPC 就绪", !!ready3, ready3 ? "" : s3.stderrTail());
  await C.sleep(30000); // session_start 恢复钩子的（误）触发观察窗
  const after2 = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : -1;
  checks.check("二次重启零重发（30s 观察窗）", after2 === before2, `before=${before2} after=${after2}`);
  return { before2, after2 };
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

  const prompt = C.dispatchPrompt({
    starts: [60, 61].map((n) => ({
      task:
        `You MUST actually run this exact bash command first: sleep 60 && echo marker-a6-${n}. ` +
        `After it finishes, reply with exactly: a6-${n}-done`,
      slug: `a6-slow-${n}`,
      collect: "sync",
    })),
  });
  const turn = await s1.prompt(prompt, 120000);
  checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

  const F = resolveSessionFile(s1, ws);
  checks.check("主 session 文件可定位", !!F, F || "n/a");
  // [A6 修复] 派发证据改用主 session 已落盘的 dispatchedStarts（派发轮 turn_end 后必
  // 已 flush；worker 子 session 文件延迟写入不可靠——真跑实证 8s 时仅 1/2 可见）。
  const dispatched = C.dispatchedStarts(C.readJsonlEntries(F)).filter((s) => s.collect === "sync");
  checks.check("派发 2 个 collect:sync start（子进程已拉起）", dispatched.length === 2, `starts=${dispatched.length}`);
  const subSessionsNow = C.subagentSessionFiles(ws).length;
  checks.note("当前可见 worker 子 session 文件数（延迟写入，仅参考）", `${subSessionsNow}`);

  const degraded = await constructKillWindow(checks, s1, F);

  // ── 重启 #1（重建）── 按 kill 时刻投递态分流：未投递→期望补发；已投递→零重复
  const deliveredBefore = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : 0;
  const s2 = spawnRestart(ws, F, `${SCENARIO}-restart1`);
  sessions.push(s2);
  const ready2 = await s2.waitReady();
  checks.check("重启 #1 RPC 就绪", !!ready2, ready2 ? "" : s2.stderrTail());

  if (deliveredBefore === 0) {
    await assertCrashRedelivery(checks, ws, F);
  } else {
    await assertNoDuplicateOnDelivered(checks, F);
  }

  // ── 二次重启：零重发 ──
  const { before2, after2 } = await assertSecondRestartNoRedeliver(checks, ws, F, s2, sessions);

  C.appendResultRecord(SCENARIO, [
    `- 模式: ${degraded ? `降级（${degraded.reason}）` : "primary（kill -9 于批等待中）"}`,
    `- 模型: ${C.resolveModel()}`,
    `- 二次重启前 notify 总数: ${before2}／观察窗后: ${after2}`,
  ]);
  checks.finish(SCENARIO);
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
          "mkdtemp + spawn pi RPC → 同轮 2 个 collect:sync start（各 sleep 60s + echo marker）",
          "等派发轮 turn_end，静置 8s（子进程进入 sleep 段），核对 session 文件零 notify",
          "kill -9 主 pi（SIGKILL）；批已先行闭合 / SIGKILL 未生效 → 降级 dispose(SIGTERM)→重建 并注明",
          "重启 #1（同 cwd + 同 session-dir + --session <file>）→ 断言补发单条批（2 finished 0 failed）+ 2 finalized",
          "二次重启（再 kill + 再建）→ 30s 观察窗内 notify 零新增（零重发）",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("a6");
  const sessions = [];

  try {
    await runProbe(checks, ws, sessions);
  } finally {
    for (const s of sessions) s.kill("SIGKILL");
    for (const s of sessions) await waitDead(s, 3000);
    ws.cleanup();
  }
}

C.runScenario(SCENARIO, main);

#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/v3-kill9-recovery.mjs
//
// [V3] kill -9 崩溃恢复（v2 设计 §4 验收表 V3 行〔设计文档已删，git 可追溯〕/ GV2②；v1 A6 FAIL 复验转 PASS）
// v1 A6 裁决：kill 形态可构造、补发不可达（240s 零到达）——worker 与宿主 SIGKILL
// 共亡，成员 record 停留 running，E1 恢复钩子被「仍有 running」永久顶死。真根因
// （v2 §2.2/§2.3）：orphan 覆写抹 collectMode（候选恒空）+ E1 running 口径与协调器
// 分岔（轮终 running+resumable 的成功成员被误判仍在跑）。v2 W1/W2 修复后：
//   - 2 个 sync（sleep 60s）派发后 kill -9 主 pi → 重启同 session → 断言 240s 内
//     补发单条批通知（kill -9 下 worker 共亡 → 孤儿成员经 orphan 恢复转终态，
//     批标记保留 → E1 候选非空 → 补发可达）；
//   - 批头计数容忍 finished/failed 两形态（gc 成员依子文件末行完整性二选一，
//     kill -9 下截断与否是概率形态：0-2 finished / 0-2 failed，cancelled 恒 0）；
//   - 二次重启零重发。
//
// 用法：node v3-kill9-recovery.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   含 2×60s sleep + 三次进程生命周期，长时场景——总时长约 4-6 分钟。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as C from "./common.mjs";

const SCENARIO = "V3";
const DESIGN = "subagent-sync-collect-v2.md §4 验收表 V3（kill -9 恢复，v1 A6 FAIL 转 PASS）";
const EXPECT = "kill -9 → 重启 240s 内补发单条批（批头 finished/failed 两形态容忍）→ 二次重启零重发";

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

function parseBatchHeader(content) {
  const m = content.split("\n")[0].match(C.BATCH_HEADER_RE);
  if (!m) return null;
  return { finished: Number(m[1]), failed: Number(m[2]), cancelled: Number(m[3]) };
}

/** 条目正文「空形态」判定：trim 后为空，或为构建方无 result 可 merge 时的
 *  "(empty)" 字面占位（实跑实证：kill -9 sleep 成员的批条目正文是 7 字符字符串
 *  "(empty)" 而非空串——按长度判定会误报「非空」）。 */
function isEmptyBody(body) {
  const t = body.trim();
  return t.length === 0 || t === "(empty)";
}

/** 记录行「成员正文」段：按补发批成员正文实况插值（全空 → 空正文第三形态说明；
 *  含非空 → 首段摘录；未观察 → n/a——曾硬编码「实测为空」与实跑漂移，禁回写经验值）。 */
function memberBodyNote(bodies) {
  if (bodies.length === 0) return "（成员正文未观察——降级/批未达）";
  const nonEmpty = bodies.filter((b) => !isEmptyBody(b));
  if (nonEmpty.length === 0) {
    return "（成员正文实测为空——sleep 中 kill 无 assistant 输出，gc 判 finished + 覆写 entry 无 result 可 merge，设计「result 或截断 error」二分外的第三形态：空正文）";
  }
  const state = nonEmpty.length === bodies.length ? "全非空" : `${nonEmpty.length}/${bodies.length} 非空`;
  return `（成员正文实测${state}——首段摘录: ${JSON.stringify(nonEmpty[0].slice(0, 80))}）`;
}

/** kill 窗口构造（v3 形态：无 SIGTERM 兜底）：静置 8s → 核对零 notify → SIGKILL。
 *  批已先行闭合时置 degraded（探针继续，验证幂等面）；kill 未生效返回 false（调用方
 *  终止探针）。返回 { degraded, proceed }。 */
async function constructKillWindow(checks, s1, F) {
  // 静置 8s：让两个子进程越过启动段进入 sleep（kill 窗口稳定）
  await C.sleep(8000);
  const preNotify = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : -1;
  const state = { degraded: null, proceed: true };
  if (preNotify > 0) {
    state.degraded = { reason: `批在 kill 前已闭合（preNotify=${preNotify}）——kill -9 时序不可构造` };
    checks.note("kill -9 时序不可构造", state.degraded.reason);
  } else {
    s1.kill("SIGKILL");
    const dead = await waitDead(s1, 8000);
    checks.check("kill -9 于批等待中生效", dead, dead ? "SIGKILL" : "8s 未死");
    if (!dead) state.proceed = false;
  }
  return state;
}

/** 重启 #1 主路径（kill -9 生效）：等补发批 → 恰 1 条 + 批头合法性 + 条目 id 集一致
 *  + 成员正文形态 note。返回补发批头 | null。memberBodies 由本函数 push 填充。 */
async function assertCrashRedeliver(checks, F, deliveredBefore, dispatched, memberBodies) {
  const entries = await C.waitForNotify(
    F,
    240000,
    (ns) => ns.some((n) => C.BATCH_HEADER_RE.test(n.content.split("\n")[0] || "")),
    "补发批通知（kill -9 恢复）",
  );
  const batches = C.syncBatchNotifyEntries(entries);
  const total = C.bgNotifyEntries(entries).length;
  checks.check("重启 #1 补发恰好 1 条批通知", batches.length === 1 && total - deliveredBefore === 1, `batches=${batches.length} total=${total}`);
  if (!batches[0]) return null;

  const head = parseBatchHeader(batches[0].content);
  checks.check(
    "批头合法性（finished+failed=2 且 cancelled=0；gc 二选一：0-2 finished / 0-2 failed）",
    head !== null && head.finished + head.failed === 2 && head.cancelled === 0,
    head ? `${head.finished} finished, ${head.failed} failed, ${head.cancelled} cancelled` : batches[0].content.split("\n")[0],
  );
  const segs = C.batchSegments(batches[0].content);
  checks.check("批头 + 2 条目", segs.length === 3, `segments=${segs.length}`);
  const startIds = new Set(dispatched.map((s) => s.saId));
  const itemIds = new Set(segs.slice(1).map((s) => C.saIdOf(s)).filter(Boolean));
  checks.check(
    "补发条目 id 集 == 派发 sync 成员 id 集",
    startIds.size === 2 && itemIds.size === 2 && [...itemIds].every((id) => startIds.has(id)),
    `items=${itemIds.size} starts=${startIds.size}`,
  );
  // 成员正文形态（result 或截断 error 文案——kill -9 概率形态，非门仅留痕）
  for (const seg of segs.slice(1)) {
    const segBody = C.itemResultBody(seg);
    memberBodies.push(segBody);
    checks.note("成员条目正文形态（gc：崩溃前 result / 截断 error 二选一）", segBody.slice(0, 80));
  }
  return head;
}

/** 重启 #1 降级路径（批已先行闭合）：已投递态下重启应零重复（仍验证幂等面）。 */
async function assertNoDuplicateOnDelivered(checks, F, deliveredBefore) {
  await C.sleep(30000);
  const after = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
  checks.check("[降级] 已投递态重启零重复", after === deliveredBefore, `before=${deliveredBefore} after=${after}`);
}

/** 二次重启：SIGKILL + 同 session 重建 → 30s 观察窗零重发。返回观察前后 notify 数。 */
async function assertSecondRestartNoRedeliver(checks, ws, F, s2, sessions) {
  await C.sleep(6000); // 落标清态窗口
  const before2 = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : 0;
  s2.kill("SIGKILL");
  await waitDead(s2, 8000);
  const s3 = spawnRestart(ws, F, `${SCENARIO}-restart2`);
  sessions.push(s3);
  const ready3 = await s3.waitReady();
  checks.check("重启 #2 RPC 就绪", !!ready3, ready3 ? "" : s3.stderrTail());
  await C.sleep(30000); // session_start 恢复钩子触发观察窗
  const after2 = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : -1;
  checks.check("二次重启零重发（30s 观察窗）", after2 === before2, `before=${before2} after=${after2}`);
  return { before2, after2 };
}

/** RESULTS.md 留痕（模式 / 补发批头按实况插值 / 二次重启 notify 前后）。 */
function recordV3Outcome(checks, degraded, redeliverHead, memberBodies, before2, after2) {
  const summary = checks.summary();
  C.appendResultRecord(SCENARIO, [
    `- 世代: v2 探针（subagent-sync-collect-v2 §4 V3；v1 A6 FAIL 转 PASS）——${summary.passed} PASS / ${summary.failed} FAIL`,
    `- 模式: ${degraded ? `降级（${degraded.reason}）` : "primary（kill -9 于批等待中）"}`,
    `- 模型: ${C.resolveModel()}`,
    `- 补发批头: ${redeliverHead ? `${redeliverHead.finished} finished, ${redeliverHead.failed} failed, ${redeliverHead.cancelled} cancelled` : degraded ? "n/a（时序不可构造）" : "(未解析)"}${memberBodyNote(memberBodies)}`,
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

  const prompt = C.dispatchPrompt({
    starts: [60, 61].map((n) => ({
      task:
        `You MUST actually run this exact bash command first: sleep 60 && echo marker-v3-${n}. ` +
        `After it finishes, reply with exactly: v3-${n}-done`,
      slug: `v3-slow-${n}`,
      collect: "sync",
    })),
  });
  const turn = await s1.prompt(prompt, 120000);
  checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

  const F = resolveSessionFile(s1, ws);
  checks.check("主 session 文件可定位", !!F, F || "n/a");
  const dispatched = C.dispatchedStarts(C.readJsonlEntries(F)).filter((s) => s.collect === "sync");
  checks.check("派发 2 个 collect:sync start", dispatched.length === 2, `starts=${dispatched.length}`);
  if (dispatched.length !== 2) return;

  const { degraded, proceed } = await constructKillWindow(checks, s1, F);
  if (!proceed) return;

  // ── 重启 #1：E1 补发（v1 A6 在此 240s 零到达；v2 修复后应可达）──
  const deliveredBefore = F ? C.bgNotifyEntries(C.readJsonlEntries(F)).length : 0;
  const s2 = spawnRestart(ws, F, `${SCENARIO}-restart1`);
  sessions.push(s2);
  const ready2 = await s2.waitReady();
  checks.check("重启 #1 RPC 就绪", !!ready2, ready2 ? "" : s2.stderrTail());

  const memberBodies = []; // 补发批各成员条目正文（记录行按实况插值，禁硬编码形态）
  let redeliverHead = null; // 补发批头（RESULTS.md 留痕用）
  if (degraded) {
    await assertNoDuplicateOnDelivered(checks, F, deliveredBefore);
  } else {
    redeliverHead = await assertCrashRedeliver(checks, F, deliveredBefore, dispatched, memberBodies);
  }

  // ── 二次重启：零重发（batchFinalized 落标 + 账本幂等）──
  const { before2, after2 } = await assertSecondRestartNoRedeliver(checks, ws, F, s2, sessions);
  recordV3Outcome(checks, degraded, redeliverHead, memberBodies, before2, after2);
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
          "kill -9 主 pi（SIGKILL；批已先行闭合则中止并注明时序不可构造）",
          "重启 #1（同 cwd + 同 session-dir + --session <file>）→ 240s 内补发单条批",
          "批头合法性：finished+failed=2 且 cancelled=0（gc 成员末行完整性二选一：0-2 finished / 0-2 failed）",
          "二次重启（SIGKILL + 同 session 重建）→ 30s 观察窗 notify 零新增（零重发）",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("v3-kill9");
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

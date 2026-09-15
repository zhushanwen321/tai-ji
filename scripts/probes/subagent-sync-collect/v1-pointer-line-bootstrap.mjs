#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/v1-pointer-line-bootstrap.mjs
//
// [V1] 指针行取回自举（v2 设计 §4 验收表 V1 行〔设计文档已删，git 可追溯〕/ v1 A4① 复验）
// 断链 1（manifest 永不产生）修复后：批通知指针行原文 `session_read
// {"action":"result","session":"<sa- id>"}` 应可直接自举取回——v1 A4① 实跑中
// sa- id 反查报「无匹配 record」（manifest 惰性不落盘，须人工换绝对路径），v2 W3
// 在批通知路径补写 manifest；时序竞态修订后写点前移为「写账前屏障 await 全部落盘」
// （原落标出口 fire-and-forget 与通知投递并发，「送达时已落盘」只大概率成立——
// 探针实测 mtime 相对 notify entry ±2/3ms 方向不定），「通知可达 ⇒ 索引就位」
// 升为构造性保证（by construction），本探针恢复严格时序门（硬 check）。
// 预期输出：
//   - 恰 1 条批通知（批头 `1 finished, 0 failed, 0 cancelled`），条目正文截断 + 指针行；
//   - 批通知首见时点（waitForNotify pred 粒度）records/<sa-id>.json 已落盘，且
//     manifest mtime 严格早于 notify entry timestamp（屏障硬 check）；
//   - 主 agent 按指针行原文（sa- id，非绝对路径）调 session_read result：
//     不再出现「无匹配 record」，取回正文与子 session 磁盘全文（record.result 同源）
//     逐字节一致。
//
// 截断触发沿用 a4 前身的确定性手法（v1 教训：弱模型不服从「输出 >10K 字符」强指令，
// 长文生成不可靠且慢）：隔离 agentDir + config perItemChars=100，task 只要求 200-300
// 字介绍（弱模型必然超预算）——「超预算 → 截断 → 指针行」链路与 >10K 场景同构。
//
// 用法：node v1-pointer-line-bootstrap.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）

import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as C from "./common.mjs";

const SCENARIO = "V1";
const DESIGN = "subagent-sync-collect-v2.md §4 验收表 V1（指针行取回自举；v1 A4① 复验）";
const EXPECT =
  "批通知指针行 sa- id 原文反查命中（无「无匹配 record」）+ 取回与 record.result 逐字节一致 + manifest mtime 严格早于 notify entry timestamp（屏障构造性保证）";

/** 条目内指针行（以 `[truncated ` 开头的行）。 */
function pointerLineOf(item) {
  return item.split("\n").find((l) => l.startsWith("[truncated ")) || null;
}

/** 从指针行解析 session_read 的 session id。 */
function pointerSessionId(item) {
  const line = pointerLineOf(item);
  if (!line) return null;
  const m = line.match(/"session"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** mtime vs notify entry timestamp 的时序差描述（正 = manifest 先落盘）。
 *  屏障修复后方向恒为正（构造性保证），仍保留按符号选词的形态以在异常时如实呈现。 */
function mtimeOrderNote(deltaMs) {
  if (deltaMs == null) return "mtime vs notify entry timestamp: n/a";
  if (deltaMs > 0) return `mtime 严格早于 notify entry timestamp ${deltaMs.toFixed(1)}ms`;
  if (deltaMs < 0) return `mtime 晚于 notify entry timestamp ${(-deltaMs).toFixed(1)}ms（屏障失效）`;
  return "mtime 与 notify entry timestamp 同刻";
}

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 批唤醒 turn 可能仍在跑：streamingBehavior=followUp 排队写入（确定性）。 */
async function promptWithRetry(session, message, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await session.prompt(message, 180000, { streamingBehavior: "followUp" });
    } catch (err) {
      lastErr = err;
      await C.sleep(10000);
    }
  }
  throw lastErr;
}

/** pred 首见快照：批条目指针行/正文反查 sa- id + manifest 落盘态 + notify entry timestamp。 */
function snapshotFirstManifest(batch, ws, sessionFile) {
  const seg = C.batchSegments(batch.content)[1] || "";
  const saId = pointerSessionId(seg) || C.saIdOf(seg);
  const manifestPath = saId
    ? join(C.resolveAgentDir(), "subagents", ws.enc, "records", `${saId}.json`)
    : null;
  // bgNotifyEntries 产物不含原 entry——按 index 回查批通知 entry 的落盘 timestamp
  const rawEntry = C.readJsonlEntries(sessionFile)[batch.index];
  return {
    saId,
    exists: manifestPath ? existsSync(manifestPath) : false,
    manifestMtime: manifestPath && existsSync(manifestPath) ? statSync(manifestPath).mtimeMs : null,
    notifyEntryTs: rawEntry && typeof rawEntry.timestamp === "string" ? Date.parse(rawEntry.timestamp) : null,
  };
}

/** 批通知首见观察（waitForNotify pred 内联钩子，轮询粒度 ≤2s）：首见时点立即快照
 *  manifest 落盘态。屏障（写账前 await 落盘）已构造性保证「通知可达 ⇒ 索引就位」，
 *  本快照 + 下方 mtime 硬 check 是对该保证的真实通路验证（FAIL = 屏障被回归破坏，
 *  如实红）。 */
async function observeFirstNotify(session, ws) {
  let manifestSeenAtFirstNotify = null; // { saId, exists, manifestMtime, notifyEntryTs }
  const entries = await C.waitForNotify(session.sessionFile, 240000, (ns) => {
    const batch = ns.find((n) => C.BATCH_HEADER_RE.test(n.content.split("\n")[0] || ""));
    if (!batch) return false;
    if (manifestSeenAtFirstNotify === null) {
      manifestSeenAtFirstNotify = snapshotFirstManifest(batch, ws, session.sessionFile);
    }
    return true;
  }, "批 notify entry");
  return { entries, manifestSeenAtFirstNotify };
}

/** 批形状断言（批头文案 / 批头+1 条目）→ 条目正文；无条目返回 falsy（调用方终止）。 */
function assertBatchShape(checks, batch) {
  const header = batch.content.split("\n")[0];
  checks.check(
    "批头 `1 finished, 0 failed, 0 cancelled`",
    header === "Subagent batch completed: 1 finished, 0 failed, 0 cancelled.",
    header,
  );

  const segs = C.batchSegments(batch.content);
  checks.check("批头 + 1 条目", segs.length === 2, `segments=${segs.length}`);
  return segs[1];
}

/** 条目截断 + 指针行断言（正文 ≤101 / 指针行存在 / 指针行含 sa- id）→ { body, sid }。 */
function assertTruncationAndPointer(checks, item) {
  const body = C.itemResultBody(item);
  checks.check(
    "条目正文截断至 ≤100 字符（perItemChars=100 + 省略号 1）",
    body.length > 0 && body.length <= 101,
    `body=${body.length}`,
  );
  const pLine = pointerLineOf(item);
  checks.check("指针行存在（[truncated ... session_read ...]）", !!pLine, pLine || "(无)");
  const sid = pointerSessionId(item);
  checks.check("指针行含 sa- id（取回路径就绪）", !!sid && sid.startsWith("sa-"), sid || "(未解析到)");
  return { body, sid };
}

/** [V1 核心断言 1 + 严格时序门] manifest 批通知首见已落盘 + mtime 严格早于 notify
 *  entry timestamp + 磁盘 manifest 投影字段齐备。返回 { mtimeDeltaMs, manifestStatus }。
 *
 *  严格时序门：时序竞态修订（原 fire-and-forget 与投递并发，探针实测 ±2/3ms 方向
 *  不定）后的硬 check——屏障（写账前 await 全部落盘）使「通知可达 ⇒ 索引就位」成为
 *  构造性保证，mtime 落后/同刻即屏障回归，不再留痕降级。 */
function assertManifestBootstrap(checks, ws, sid, manifestSeenAtFirstNotify) {
  checks.check(
    "磁盘 manifest 在批通知首见时点已存在",
    manifestSeenAtFirstNotify !== null && manifestSeenAtFirstNotify.exists === true,
    manifestSeenAtFirstNotify
      ? `saId=${manifestSeenAtFirstNotify.saId} exists=${manifestSeenAtFirstNotify.exists}`
      : "(pred 钩子未触发)",
  );
  let mtimeDeltaMs = null; // notify entry timestamp - manifest mtime（正 = mtime 更早）
  if (manifestSeenAtFirstNotify?.manifestMtime != null && manifestSeenAtFirstNotify.notifyEntryTs != null) {
    mtimeDeltaMs = manifestSeenAtFirstNotify.notifyEntryTs - manifestSeenAtFirstNotify.manifestMtime;
    checks.check(
      "manifest mtime 严格早于 notify entry timestamp（屏障构造性保证）",
      mtimeDeltaMs > 0,
      `notify-entry - mtime = ${mtimeDeltaMs.toFixed(1)}ms`,
    );
  }
  let manifestStatus = null;
  const manifestFile = join(C.resolveAgentDir(), "subagents", ws.enc, "records", `${sid}.json`);
  if (existsSync(manifestFile)) {
    const raw = JSON.parse(readFileSync(manifestFile, "utf-8"));
    manifestStatus = typeof raw.status === "string" ? raw.status : null;
    checks.check(
      "manifest 投影字段齐备（id/sessionFile 反查索引可用）",
      raw.id === sid && typeof raw.sessionFile === "string" && raw.sessionFile.endsWith(".jsonl"),
      `id=${raw.id} sessionFile=${String(raw.sessionFile).slice(-40)} status=${raw.status}`,
    );
  }
  return { mtimeDeltaMs, manifestStatus };
}

/** 截断前全文（磁盘同源）→ fullText；子 session 非唯一返回 null。 */
function assertFullText(checks, ws) {
  const subFiles = C.subagentSessionFiles(ws);
  checks.check("子 session 文件唯一", subFiles.length === 1, `files=${subFiles.length}`);
  if (subFiles.length !== 1) return null;
  const fullText = C.finalAssistantText(subFiles[0]);
  checks.check("截断前全文 >100 字符（截断确实发生）", fullText.length > 100, `full=${fullText.length}`);
  return fullText;
}

/** 取回轮诊断用：末条 assistant 回复文本（string 直取；数组拼 text 块；无消息给占位）。 */
function lastAssistantTextSummary(entries2) {
  const lastAssistant = C.assistantMessages(entries2).slice(-1)[0];
  if (!lastAssistant) return "(无 assistant 消息)";
  const content = lastAssistant.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === "text").map((c) => c.text || "").join(" ");
  }
  return "";
}

/** [V1 核心断言 2] 按指针行原文（sa- id）自举取回——不换绝对路径。弱模型偶发
 *  不服从单轮工具指令（a4 先例同款 prompt 实跑过服从，此处加一次重试 + 诊断
 *  留痕：失败 detail 带取回轮 assistant 文本，不为绿改断言）。toolResult 缺失
 *  返回 null。 */
async function fetchByPointerId(checks, session, sid) {
  const fetchPrompt =
    `Use the session_read tool with exactly these arguments: {"action":"result","session":${JSON.stringify(sid)}}. ` +
    "Do not pass any other arguments. After the tool result returns, reply with only: fetched";
  let fetched = null;
  let fetchDiag = "";
  for (let attempt = 1; attempt <= 2 && !fetched; attempt += 1) {
    const fetchTurn = await promptWithRetry(session, fetchPrompt);
    checks.check(`session_read（sa- id 原文）取回轮 #${attempt} turn_end`, !!fetchTurn.ok, `stopReason=${fetchTurn.stopReason || "n/a"}`);
    const entries2 = C.readJsonlEntries(session.sessionFile);
    const results = C.toolResultTexts(entries2, "session_read");
    if (results.length > 0) {
      fetched = results[results.length - 1];
      break;
    }
    fetchDiag = `取回轮未产生 session_read toolResult；assistant 回复: ${lastAssistantTextSummary(entries2).slice(0, 200)}`;
  }
  checks.check("session_read toolResult 存在", !!fetched, fetched ? "" : fetchDiag);
  if (!fetched) return null;

  // v1 A4① 的 FAIL 形态：反查报「无匹配 record」——v2 后不得再出现
  checks.check("无「无匹配 record」（sa- id 反查命中，GV1）", !fetched.includes("无匹配 record"), fetched.slice(0, 120));
  return fetched;
}

/** RESULTS.md 留痕（摘要 / 全文与保留长度 / 屏障门与 manifest 投影 / 反查与一致性）。 */
function recordV1Outcome(checks, { fullText, body, manifestSeenAtFirstNotify, mtimeDeltaMs, manifestStatus, fetched, identical }) {
  const summary = checks.summary();
  C.appendResultRecord(SCENARIO, [
    `- 世代: v2 探针（subagent-sync-collect-v2 §4 V1；v1 A4① 复验）——${summary.passed} PASS / ${summary.failed} FAIL`,
    `- 模型: ${C.resolveModel()}（config perItemChars=100 确定性触发截断）`,
    `- 全文长度: ${fullText.length}（截断前）／批内保留: ${body.length}`,
    `- manifest 首见时点已落盘: ${manifestSeenAtFirstNotify?.exists === true ? "yes" : "no"}（${mtimeOrderNote(mtimeDeltaMs)}；屏障严格门 ${mtimeDeltaMs != null && mtimeDeltaMs > 0 ? "PASS" : "FAIL"}；manifest.status 如实投影 ${JSON.stringify(manifestStatus)}）`,
    `- sa- id 自举反查: ${fetched.includes("无匹配 record") ? "FAIL（无匹配 record）" : "命中"}`,
    `- 取回一致: ${identical ? "yes（逐字节）" : "no"}`,
  ]);
}

async function runProbe(checks, ws, session) {
  const ready = await session.waitReady();
  checks.check("pi RPC 就绪（隔离 agentDir + config perItemChars=100 注入）", !!ready, ready ? "" : session.stderrTail());

  const prompt = C.dispatchPrompt({
    starts: [
      {
        task:
          "用中文写一段 200 到 300 字的关于「子代理协作」的介绍，内容随意，" +
          "但总长度必须超过 150 个字符。不要使用任何工具，直接输出正文。",
        slug: "bootstrap-long",
        collect: "sync",
      },
    ],
  });
  const turn = await session.prompt(prompt, 120000);
  checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

  const { entries, manifestSeenAtFirstNotify } = await observeFirstNotify(session, ws);
  const batches = C.syncBatchNotifyEntries(entries);
  checks.check("恰 1 条批通知", batches.length === 1, `batches=${batches.length}`);
  if (!batches[0]) return;

  const item = assertBatchShape(checks, batches[0]);
  if (!item) return;

  const { body, sid } = assertTruncationAndPointer(checks, item);
  if (!sid) return;

  const bootstrap = assertManifestBootstrap(checks, ws, sid, manifestSeenAtFirstNotify);

  // 截断前全文（磁盘同源）：子 session 唯一
  const fullText = assertFullText(checks, ws);
  if (!fullText) return;

  const fetched = await fetchByPointerId(checks, session, sid);
  if (!fetched) return;

  const identical = fetched === fullText;
  checks.check(
    "取回与截断前全文逐字节一致（record.result 同源）",
    identical,
    identical
      ? `len=${fetched.length}`
      : `fetched=${fetched.length} full=${fullText.length} 首差异@${firstDiffIndex(fetched, fullText)}`,
  );

  recordV1Outcome(checks, { fullText, body, manifestSeenAtFirstNotify, ...bootstrap, fetched, identical });
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
          "mkdtemp 工作区 + 隔离 agentDir + 写 subagents/config.json collectSync.perItemChars=100（确定性截断触发）",
          "1 个 collect:sync start（task 要求 200-300 字介绍）→ 等批通知 ≤240s",
          "批通知首见时点（pred 粒度）检查 records/<sa-id>.json 已落盘 + mtime 严格早于 notify entry timestamp（屏障硬 check）",
          "主 agent 按指针行原文调 session_read {action:result, session:<sa- id>}（不换绝对路径）",
          "断言：无「无匹配 record」+ 取回 toolResult 与子 session 磁盘全文逐字节一致",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("v1-bootstrap", {
    isolatedAgentDir: true,
    writeConfig: (agentDir) => {
      writeFileSync(
        join(agentDir, "subagents", "config.json"),
        JSON.stringify({ version: 1, collectSync: { perItemChars: 100, totalChars: 24000 } }, null, 2),
      );
    },
  });
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-main`,
  });

  try {
    await runProbe(checks, ws, session);
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
    // finish 收尾对齐 v1 旧探针（a4/a6）约定，但置于 finally：本场景存在多处
    // check FAIL 后的 early return，若按旧形态放 try 末尾会跳过汇总——FAIL 不置
    // 非零 exit code，DoD 门失去机器可检性。
    checks.finish(SCENARIO);
  }
}

C.runScenario(SCENARIO, main);

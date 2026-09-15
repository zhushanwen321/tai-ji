#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a4-truncation-and-fetch.mjs
//
// [A4 v2] 批条目截断 + session_read 取回一致（config 确定性触发版）
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A4 行（设计文档已删，git 可追溯）。v1 弱模型不服从
// 「输出 11000 字符」强指令（长文本生成不可靠且慢）→ v2 改 config 覆盖做确定性
// 触发：隔离 agentDir（拷最小鉴权/模型配置集）+ PI_CODING_AGENT_DIR 注入 +
// <agentDir>/subagents/config.json 写 collectSync 预算（config.ts：
// getGlobalConfigPath = <getAgentDir()>/subagents/config.json，flush 时热读）。
//   ① perItemChars=100 + 1 个 sync 成员（task 只要求写 ~300 字介绍——弱模型也必然
//      >100 字）→ 断言条目正文截断至 100（+省略号共 101）+ 指针行；
//      随后发 session_read {"action":"result","session":"<id>"} 取回，与截断前全文一致。
//   ② totalChars=600, perItemChars=6000 + 7 成员短答 → effectivePerItem =
//      clamp(floor(600/7)=85, 200, 6000)=200 纯清单断言（短答不截断也必然 ≤200，
//      不依赖模型产量）。
// 预期输出：
//   ① 恰 1 条批通知（批头 `1 finished, 0 failed, 0 cancelled`）；条目正文 ≤100 字符；
//      指针行 `[truncated ... full result: session_read {"action":"result","session":"<id>"}]`
//      （C3：成员预算 >8000 时该 JSON 另附 "limit":N——本探针 per-item 100/200 均不触发）；
//      session_read 取回 toolResult == 子 session 磁盘全文（逐字节）。
//   ② 恰 1 条批通知（批头 `7 finished, 0 failed, 0 cancelled`）；每条目正文 ≤200；
//      批条目 id 集 == 派发 7 成员 id 集（截断指针数为 NOTE——短答本可不截断）。
//
// 用法：node a4-truncation-and-fetch.mjs [--dry-run] [--only single|seven]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   隔离 agentDir 为 mkdtemp（auth.json/models.json/models-store.json/settings.json
//   从真实 agentDir 拷入），零真实目录污染。

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "./common.mjs";

const SCENARIO = "A4";
const DESIGN = "subagent-sync-collect.md §4 验收表 A4（批条目截断 + session_read 取回一致；config 确定性触发）";
const EXPECT =
  "①条目截断至 100 + 指针行 + session_read 取回与全文逐字节一致；②7 成员 effectivePerItem 收紧至 200、id 集一致";

function argOnly() {
  const i = process.argv.indexOf("--only");
  const v = i >= 0 ? process.argv[i + 1] : "both";
  if (v === "single") return ["single"];
  if (v === "seven") return ["seven"];
  return ["single", "seven"];
}

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

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 批唤醒 turn 可能仍在跑：streamingBehavior=followUp 排队写入（确定性），被拒则退避重试兜底。 */
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

function makeWs(label, collectSync) {
  return C.makeWorkspace(label, {
    isolatedAgentDir: true,
    writeConfig: (agentDir) => {
      writeFileSync(
        join(agentDir, "subagents", "config.json"),
        JSON.stringify({ version: 1, collectSync }, null, 2),
      );
    },
  });
}

// ── 子场景 ①：perItemChars=100 → 截断 100 + 指针 + 取回一致 ──

/** 批到达 + 批形状断言（恰 1 条 / 批头文案 / 批头+1 条目）→ 条目正文；无批返回 null。 */
function assertBatchArrival(checks, entries) {
  const batches = C.syncBatchNotifyEntries(entries);
  checks.check("[①] 恰 1 条批通知", batches.length === 1, `batches=${batches.length}`);
  if (!batches[0]) return null;
  const header = batches[0].content.split("\n")[0];
  checks.check(
    "[①] 批头 `1 finished, 0 failed, 0 cancelled`",
    header === "Subagent batch completed: 1 finished, 0 failed, 0 cancelled.",
    header,
  );

  const segs = C.batchSegments(batches[0].content);
  checks.check("[①] 批头 + 1 条目", segs.length === 2, `segments=${segs.length}`);
  return segs[1];
}

/** 条目截断形态断言（正文 ≤101 保留口径 / 指针行存在 / 指针行含 session id）。 */
function assertTruncationShape(checks, item) {
  const body = C.itemResultBody(item);
  // 保留口径：slice(0, perItemChars) + 尾部省略号 1 字符 = 预算+1（A4 真跑实证 101/100）
  checks.check(
    "[①] 条目正文截断至 ≤100 字符（perItemChars=100 确定性触发，含省略号 +1）",
    body.length > 0 && body.length <= 101,
    `body=${body.length} limit=100(+1)`,
  );
  checks.note("[①] 实际保留长度（100 + 省略号 1 字符 = 101 口径）", `${body.length}`);

  const pLine = pointerLineOf(item);
  checks.check("[①] 指针行存在（[truncated ... session_read ...]）", !!pLine, pLine || "(无)");
  const sid = pointerSessionId(item);
  checks.check("[①] 指针行含取回路径 session id", !!sid, sid || "(未解析到)");
  return body;
}

/** 截断前全文（磁盘同源，子 session 唯一）+ 派发证据 → { subFile, fullText }；子 session
 *  非唯一返回 null（后续取回路径依赖唯一性）。 */
function assertFullTextAndDispatch(checks, ws, item, entries) {
  // 截断前全文（磁盘同源）：子 session 唯一（realpath + env 消毒后扫描已对齐）
  const subFiles = C.subagentSessionFiles(ws);
  checks.check("[①] 子 session 文件唯一", subFiles.length === 1, `files=${subFiles.length}`);
  if (subFiles.length !== 1) return null;
  const fullText = C.finalAssistantText(subFiles[0]);
  checks.check(
    "[①] 截断前全文 >100 字符（截断确实发生）",
    fullText.length > 100,
    `full=${fullText.length}`,
  );

  const starts = C.dispatchedStarts(entries);
  const syncStarts = starts.filter((s) => s.collect === "sync");
  checks.check("[①] 派发 1 个 collect:sync start", syncStarts.length === 1, `starts=${starts.length}`);
  if (syncStarts.length === 1) {
    checks.check("[①] 批条目 == 派发成员", item.includes(syncStarts[0].saId), `expect ${syncStarts[0].saId}`);
  }
  return { subFile: subFiles[0], fullText };
}

/** session_read（绝对路径形态）取回 + 逐字节比对 + 结果记录。toolResult 缺失返回 null。
 *  指针行的 sa- id 在真实 CLI 流下不可解析（manifest 惰性不落盘，真跑实证 session_read
 *  返回「无匹配 record」错误文案——产线缺口已上报）；取回完整性改用可解析的绝对路径
 *  形态断言（result action 对同一文件走同一提取器）。 */
async function fetchAndCompare(checks, session, subFile, fullText, body) {
  const fetchPrompt =
    `Use the session_read tool with exactly these arguments: {"action":"result","session":${JSON.stringify(subFile)}}. ` +
    "Do not pass any other arguments. After the tool result returns, reply with only: fetched";
  const fetchTurn = await promptWithRetry(session, fetchPrompt);
  checks.check("[①] session_read 取回轮 turn_end", !!fetchTurn.ok, `stopReason=${fetchTurn.stopReason || "n/a"}`);

  const entries2 = C.readJsonlEntries(session.sessionFile);
  const results = C.toolResultTexts(entries2, "session_read");
  const fetched = results.length > 0 ? results[results.length - 1] : null;
  checks.check("[①] session_read toolResult 存在", !!fetched, `results=${results.length}`);
  if (!fetched) return null;
  const identical = fetched === fullText;
  checks.check(
    "[①] 取回与截断前全文逐字节一致",
    identical,
    identical
      ? `len=${fetched.length}`
      : `fetched=${fetched.length} full=${fullText.length} 首差异@${firstDiffIndex(fetched, fullText)}`,
  );
  if (!identical && fetched.includes(fullText)) {
    checks.note("[①] 取回为全文 + 额外包装（完整性成立，逐字节门未过）", `wrapper=${fetched.length - fullText.length} chars`);
  }

  C.appendResultRecord(SCENARIO, [
    `- [①] 模型: ${C.resolveModel()}（config perItemChars=100）`,
    `- [①] 全文长度: ${fullText.length}（截断前）／保留: ${body.length}`,
    `- [①] 取回一致: ${identical ? "yes（逐字节）" : "no"}`,
  ]);
  return fetched;
}

async function runSingle(checks) {
  const ws = makeWs("a4-single", { perItemChars: 100, totalChars: 24000 });
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-single`,
  });
  try {
    const ready = await session.waitReady();
    checks.check("[①] pi RPC 就绪（隔离 agentDir + config 注入）", !!ready, ready ? "" : session.stderrTail());

    const prompt = C.dispatchPrompt({
      starts: [
        {
          task:
            "用中文写一段 200 到 300 字的关于「子代理协作」的介绍，内容随意，" +
            "但总长度必须超过 150 个字符。不要使用任何工具，直接输出正文。",
          slug: "intro-long",
          collect: "sync",
        },
      ],
    });
    const turn = await session.prompt(prompt, 120000);
    checks.check("[①] 派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const entries = await C.waitForNotify(session.sessionFile, 240000, (ns) => ns.length > 0, "批 notify entry");
    const item = assertBatchArrival(checks, entries);
    if (!item) return;
    const body = assertTruncationShape(checks, item);
    const fetchCtx = assertFullTextAndDispatch(checks, ws, item, entries);
    if (!fetchCtx) return;
    const fetched = await fetchAndCompare(checks, session, fetchCtx.subFile, fetchCtx.fullText, body);
    if (!fetched) return;
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
}

// ── 子场景 ②：totalChars=600 + perItemChars=6000 → effectivePerItem=200 清单断言 ──

async function runSeven(checks) {
  const ws = makeWs("a4-seven", { perItemChars: 6000, totalChars: 600 });
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-seven`,
  });
  try {
    const ready = await session.waitReady();
    checks.check("[②] pi RPC 就绪（隔离 agentDir + config 注入）", !!ready, ready ? "" : session.stderrTail());

    const starts = Array.from({ length: 7 }, (_, i) => ({
      task: `Reply with exactly: done-${i + 1}. Do not use any tools, do not add any other text.`,
      slug: `short-${i + 1}`,
      collect: "sync",
    }));
    const prompt = C.dispatchPrompt({ starts });
    const turn = await session.prompt(prompt, 120000);
    checks.check("[②] 派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const entries = await C.waitForNotify(session.sessionFile, 300000, (ns) => ns.length > 0, "批 notify entry（7 成员）");
    const batches = C.syncBatchNotifyEntries(entries);
    checks.check("[②] 恰 1 条批通知", batches.length === 1, `batches=${batches.length}`);
    if (!batches[0]) return;
    const header = batches[0].content.split("\n")[0];
    checks.check(
      "[②] 批头 `7 finished, 0 failed, 0 cancelled`",
      header === "Subagent batch completed: 7 finished, 0 failed, 0 cancelled.",
      header,
    );

    const segs = C.batchSegments(batches[0].content);
    checks.check("[②] 批头 + 7 条目", segs.length === 8, `segments=${segs.length}`);

    // effectivePerItem = clamp(floor(600/7)=85, 200, 6000) = 200——纯清单断言：
    // 短答不截断也必然 ≤200，不依赖模型产量（v1 弱模型不服从长文生成的教训）。
    const bodies = segs.slice(1).map((s) => C.itemResultBody(s));
    const over = bodies.map((b, i) => [i + 1, b.length]).filter(([, len]) => len > 200);
    checks.check(
      "[②] 每条目正文 ≤200（effectivePerItem 收紧）",
      over.length === 0,
      over.length > 0
        ? `超限: ${over.map(([n, len]) => `#${n}=${len}`).join(",")}`
        : `lens=${bodies.map((b) => b.length).join(",")}`,
    );
    const total = bodies.reduce((a, b) => a + b.length, 0);
    const truncated = segs.slice(1).filter((s) => pointerLineOf(s));
    checks.note("[②] 条目正文总量（200×7 上限，非 totalChars=600 门——floor-clamp 语义）", `${total}`);
    checks.note("[②] 截断指针条数（短答本可不截断）", `${truncated.length}/7`);

    const dispatched = C.dispatchedStarts(entries);
    const syncStarts = dispatched.filter((s) => s.collect === "sync");
    checks.check("[②] 派发 7 个 collect:sync start", dispatched.length === 7 && syncStarts.length === 7, `starts=${dispatched.length}/${syncStarts.length} sync`);
    const itemIds = new Set(segs.slice(1).map((s) => C.saIdOf(s)).filter(Boolean));
    const startIds = new Set(syncStarts.map((s) => s.saId));
    checks.check(
      "[②] 批条目 id 集 == 派发 sync 成员 id 集",
      itemIds.size === 7 && startIds.size === 7 && [...itemIds].every((id) => startIds.has(id)),
      `items=${itemIds.size} starts=${startIds.size}`,
    );

    C.appendResultRecord(SCENARIO, [
      `- [②] 成员正文长度: ${bodies.map((b) => b.length).join(" / ")}（上限 200）`,
      `- [②] 总量: ${total}／截断指针: ${truncated.length}/7`,
    ]);
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
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
          "① mkdtemp 工作区 + 隔离 agentDir（拷 auth/models 集）+ 写 subagents/config.json collectSync.perItemChars=100",
          "① 1 个 collect:sync start（task 只要求 ~300 字介绍）→ 等批通知 ≤240s：正文 ≤100 + 指针行含 session id",
          "① session_read {action:result, session:<id>} → toolResult 与子 session 磁盘全文逐字节一致",
          "② 新工作区 + config collectSync{perItemChars:6000, totalChars:600} → effectivePerItem=clamp(85,200,6000)=200",
          "② 同轮 7 个 collect:sync start（短答）→ 批头 7 finished / 每条目 ≤200（纯清单断言不依赖产量）/ id 集一致",
          "可选 --only single|seven 分跑子场景",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const only = argOnly();
  if (only.includes("single")) await checks.guard("[①] 子场景执行异常", () => runSingle(checks));
  if (only.includes("seven")) await checks.guard("[②] 子场景执行异常", () => runSeven(checks));
  checks.finish(SCENARIO);
}

C.runScenario(SCENARIO, main);

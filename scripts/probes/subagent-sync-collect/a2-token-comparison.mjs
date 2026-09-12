#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a2-token-comparison.mjs
//
// [A2] token 对比探针（数字记录非门：设计 §4 验收表 A2 行「仅记录不设硬阈值」，设计文档已删，git 可追溯）
// 同一任务组（3 个快速 one-shot）分别以 async（不传 collect）与 sync 各跑一次，
// 从主 session assistant usage 统计 input tokens 对比表。
// 预期输出（结构门 + 数字记录）：
//   - async 路径产生 ≥2 条中间 ack turn（每个/批成员完成各自唤醒主 agent）
//   - sync 为 0 条中间 turn（恰 1 条批通知唤醒）
//   - Σ input tokens（含 cacheRead 口径）对比表落 RESULTS.md（sync 预期低于 async，
//     3 subagent 规模通常差距 ≥40%——参考基线，非门）
//
// 用法：node a2-token-comparison.mjs [--dry-run] [--order sync-first]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//
// 「手动执行模板」：脚本可直接实跑（3 任务均为秒级，非长时场景）；若人工分跑，
// 用 --order async / --order sync 各跑一次，表格行会分别追加到 RESULTS.md。

import * as C from "./common.mjs";

const SCENARIO = "A2";
const DESIGN = "subagent-sync-collect.md §4 验收表 A2（token 对比探针，数字记录非门）";
const EXPECT =
  "async ≥2 条中间 ack turn、sync 0 条；Σ input tokens 对比表（sync < async 为参考预期，非门）";

// 任务完成时刻刻意错开（sleep 3/10/18，间隔 ≥7s）：async 侧避免 3 个秒级任务落在同一
// settled 边沿被 courier 合并成 1 条通知 + 1 次唤醒（那会让「≥2 中间 ack turn」断言 flaky）。
const TASKS = [
  { task: "You MUST actually run this exact bash command first: sleep 3 && echo alpha. After it finishes, reply with exactly: alpha-done", slug: "alpha" },
  { task: "You MUST actually run this exact bash command first: sleep 10 && echo beta. After it finishes, reply with exactly: beta-done", slug: "beta" },
  { task: "You MUST actually run this exact bash command first: sleep 18 && echo gamma. After it finishes, reply with exactly: gamma-done", slug: "gamma" },
];

function argOrder() {
  const i = process.argv.indexOf("--order");
  const v = i >= 0 ? process.argv[i + 1] : "both";
  if (v === "async") return ["async"];
  if (v === "sync") return ["sync"];
  return ["async", "sync"];
}

/** 单次运行：派发 mode 组任务 → 等全部通知送达 → 返回统计。 */
async function runOnce(mode, checks) {
  const ws = C.makeWorkspace(`a2-${mode}`);
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-${mode}`,
  });
  try {
    const ready = await session.waitReady();
    checks.check(`[${mode}] pi RPC 就绪`, !!ready, ready ? "" : session.stderrTail());

    const prompt = C.dispatchPrompt({
      starts: TASKS.map((t) => ({
        ...t,
        ...(mode === "sync" ? { collect: "sync" } : {}),
      })),
    });
    const turn = await session.prompt(prompt, 120000);
    checks.check(`[${mode}] 派发轮 turn_end`, !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const baseEntries = C.readJsonlEntries(session.sessionFile);
    const baseAssistant = C.assistantMessages(baseEntries).length;
    const baseUsage = C.sumUsage(baseEntries);
    const dispatchAt = Date.now();

    // async：3 条单条通知全部送达；sync：1 条批通知
    //（sync 侧 pred 不消费 ns——waitForNotify 每轮重读主 session 文件取批头形态）
    const pred =
      mode === "sync"
        ? () => C.syncBatchNotifyEntries(C.readJsonlEntries(session.sessionFile)).length >= 1
        : (ns) => ns.length >= 3;
    const entries = await C.waitForNotify(
      session.sessionFile,
      180000,
      pred,
      mode === "sync" ? "1 条批通知" : "3 条单条通知",
    );

    const notifies = C.bgNotifyEntries(entries);
    const syncBatches = C.syncBatchNotifyEntries(entries);
    const usage = C.sumUsage(entries);
    const wakeTurns = usage.assistantCount - baseUsage.assistantCount; // 派发轮之后的唤醒 turn assistant 条数
    const midWakeTurns = notifies.length > 0
      ? C.assistantCountBefore(entries, notifies[notifies.length - 1].index) - baseAssistant
      : -1;

    return {
      mode,
      notifyCount: notifies.length,
      batchCount: syncBatches.length,
      assistantCount: usage.assistantCount,
      baseAssistantCount: baseAssistant,
      midWakeTurns,
      wakeTurns,
      input: usage.input,
      cacheRead: usage.cacheRead,
      inputPlusCache: usage.input + usage.cacheRead,
      output: usage.output,
      elapsedS: ((Date.now() - dispatchAt) / 1000).toFixed(1),
      sessionFile: session.sessionFile,
    };
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
}

function tableRow(r) {
  return `| ${r.mode} | ${r.notifyCount} | ${r.batchCount} | ${r.midWakeTurns} | ${r.input} | ${r.cacheRead} | ${r.inputPlusCache} | ${r.output} | ${r.elapsedS}s |`;
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
          "runOnce(async)：3 个 one-shot 不传 collect → 各自单条通知唤醒（≥2 中间 turn）",
          "runOnce(sync)：同 3 任务 collect:sync → 恰 1 条批通知（0 中间 turn）",
          "Σ usage 对比（input / cacheRead / input+cache / output）→ RESULTS.md 表格",
          "结构门：async midWakeTurns ≥2 且 sync midWakeTurns == 0；token 数字仅记录（note 非门）",
          "可选 --order async|sync 人工分跑（表格行分别追加）",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const order = argOrder();
  const results = [];
  for (const mode of order) {
    console.log(`\n── ${SCENARIO} runOnce(${mode}) ──`);
    results.push(await runOnce(mode, checks));
  }

  const asyncR = results.find((r) => r.mode === "async");
  const syncR = results.find((r) => r.mode === "sync");

  console.log(`\n── ${SCENARIO} 对比表（Σ 主 session assistant usage）──`);
  console.log("| mode | notify entries | sync 批 | 中间唤醒 turn | input | cacheRead | input+cache | output | 派发→末通知 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) console.log(tableRow(r));

  const lines = [
    `| mode | notify entries | sync 批 | 中间唤醒 turn | input | cacheRead | input+cache | output | 派发→末通知 |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...results.map(tableRow),
  ];
  if (asyncR && syncR) {
    const saving =
      asyncR.inputPlusCache > 0
        ? (((asyncR.inputPlusCache - syncR.inputPlusCache) / asyncR.inputPlusCache) * 100).toFixed(1)
        : "n/a";
    lines.push(``, `input+cache 节省: ${saving}%（sync ${syncR.inputPlusCache} vs async ${asyncR.inputPlusCache}，参考非门）`);
    checks.note("token 对比（参考非门）", `sync input+cache=${syncR.inputPlusCache} vs async=${asyncR.inputPlusCache}，节省 ${saving}%`);
  }
  C.appendResultRecord(SCENARIO, lines);

  // 结构门（验收行的硬部分）：async ≥2 中间 ack turn / sync 0
  if (asyncR) {
    checks.check("[async] 产生 ≥2 条中间 ack turn（3 成员各自唤醒）", asyncR.midWakeTurns >= 2, `midWakeTurns=${asyncR.midWakeTurns}`);
    checks.check("[async] 全部为单条/合并形态（0 条 sync 批）", asyncR.batchCount === 0, `batchCount=${asyncR.batchCount}`);
  }
  if (syncR) {
    checks.check("[sync] 0 条中间唤醒 turn（单唤醒）", syncR.midWakeTurns === 0, `midWakeTurns=${syncR.midWakeTurns}`);
    checks.check("[sync] 恰 1 条批通知", syncR.batchCount === 1 && syncR.notifyCount === 1, `notify=${syncR.notifyCount} batch=${syncR.batchCount}`);
    if (asyncR && syncR.inputPlusCache < asyncR.inputPlusCache) {
      checks.note("sync Σ input+cache 低于 async（设计预期，非门）", `${syncR.inputPlusCache} < ${asyncR.inputPlusCache}`);
    }
  }
  checks.finish(SCENARIO);
}

C.runScenario(SCENARIO, main);

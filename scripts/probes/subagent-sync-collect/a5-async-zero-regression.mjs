#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a5-async-zero-regression.mjs
//
// [A5] async 路径零回归
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A5 行（设计文档已删，git 可追溯）：
//   不传 collect 的单 subagent 流程，与显式 collect:"async" 同 prompt 双跑对照——
//   单条通知文案与 collect:"async" 时逐字节一致（sa-/uuid 等运行期标识归一后 diff 为空）。
// 预期输出：
//   - 两跑各自恰好 1 条单条通知（非批头形态，details.batch !== true）
//   - 通知 content 含任务 marker（zero-reg-done）
//   - 归一运行期标识后两跑 content 逐字节一致（对照同 prompt 双跑 diff）
//
// 用法：node a5-async-zero-regression.mjs [--dry-run] [--order omit|explicit]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   两跑均为秒级 one-shot，可直接实跑；--order 单跑一侧便于人工分跑对照。

import * as C from "./common.mjs";

const SCENARIO = "A5";
const DESIGN = "subagent-sync-collect.md §4 验收表 A5（async 路径零回归：缺省 vs 显式 collect:async）";
const EXPECT = "两跑各 1 条单条通知；归一 sa-/uuid 后通知文案逐字节一致";

const TASK =
  "You MUST actually run this exact bash command first: echo zero-reg. " +
  "After it finishes, reply with exactly: zero-reg-done";

/** 运行期标识归一：sa- id 与 uuid 每跑必变，归一后才可比对文案本体。 */
function normalizeIdentities(s) {
  return s
    .replace(/sa-[0-9a-zA-Z][0-9a-zA-Z-]*/g, "<SA_ID>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>");
}

function argOrder() {
  const i = process.argv.indexOf("--order");
  const v = i >= 0 ? process.argv[i + 1] : "both";
  if (v === "omit") return ["omit"];
  if (v === "explicit") return ["explicit"];
  return ["omit", "explicit"];
}

/** 单次运行：派发 1 个不传 collect / 显式 collect:async 的 one-shot → 等单条通知。 */
async function runOnce(mode, checks) {
  const ws = C.makeWorkspace(`a5-${mode}`);
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

    const starts = [{ task: TASK, slug: "zero-reg" }];
    if (mode === "explicit") starts[0].collect = "async";
    const prompt = C.dispatchPrompt({ starts });
    const turn = await session.prompt(prompt, 120000);
    checks.check(`[${mode}] 派发轮 turn_end`, !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const entries = await C.waitForNotify(session.sessionFile, 180000, (ns) => ns.length >= 1, "单条 notify entry");
    const notifies = C.bgNotifyEntries(entries);
    const singles = C.singleNotifyEntries(entries);
    const syncBatches = C.syncBatchNotifyEntries(entries);
    checks.check(`[${mode}] 恰 1 条通知`, notifies.length === 1, `count=${notifies.length}`);
    checks.check(`[${mode}] 单条形态（非 sync 批头）`, singles.length === 1 && syncBatches.length === 0, `singles=${singles.length} batches=${syncBatches.length}`);
    const content = notifies.length > 0 ? notifies[0].content : "";
    checks.check(`[${mode}] 结果正文含 marker`, content.includes("zero-reg-done"), content.split("\n")[0] || "(空)");
    if (notifies.length > 0) {
      checks.note(`[${mode}] details.batch`, String(notifies[0].details.batch));
    }
    return { mode, content };
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
          "runOnce(omit)：1 个 start 不传 collect（缺省 async）→ 恰 1 条单条通知",
          "runOnce(explicit)：同 task 显式 collect:'async' → 恰 1 条单条通知",
          "归一 sa-/uuid 后 diff 两跑通知 content → 断言逐字节一致",
          "可选 --order omit|explicit 单跑一侧（人工分跑对照）",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const results = [];
  for (const mode of argOrder()) {
    console.log(`\n── ${SCENARIO} runOnce(${mode}) ──`);
    results.push(await runOnce(mode, checks));
  }

  const omit = results.find((r) => r.mode === "omit");
  const explicit = results.find((r) => r.mode === "explicit");
  if (omit && explicit) {
    const a = normalizeIdentities(omit.content);
    const b = normalizeIdentities(explicit.content);
    const identical = a === b;
    checks.check(
      "归一后两跑文案逐字节一致（零回归）",
      identical,
      identical
        ? `len=${a.length}`
        : `omit=${a.length} explicit=${b.length} 首差异@${a.split("").findIndex((ch, i) => ch !== b[i])}`,
    );
    if (!identical) {
      checks.note("归一后文案（omit）", JSON.stringify(a).slice(0, 300));
      checks.note("归一后文案（explicit）", JSON.stringify(b).slice(0, 300));
    }
    C.appendResultRecord(SCENARIO, [
      `- 模型: ${C.resolveModel()}`,
      `- omit content: ${JSON.stringify(omit.content).slice(0, 300)}`,
      `- explicit content: ${JSON.stringify(explicit.content).slice(0, 300)}`,
      `- 归一 diff: ${identical ? "空（逐字节一致）" : "非空（零回归破坏）"}`,
    ]);
  }
  checks.finish(SCENARIO);
}

C.runScenario(SCENARIO, main);

#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a8-mixed-dispatch.mjs
//
// [A8] 同轮混合派发（2 sync + 1 async）
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A8 行（设计文档已删，git 可追溯）：
//   同轮 2 个 collect:"sync" + 1 个不传 collect（async）。
// 预期输出：
//   - sync 部分恒 1 条批通知：批头 `2 finished, 0 failed, 0 cancelled`，
//     条目只含 2 个 sync 成员 id，不含 async 结果
//   - async 成员独立通知（单条形态，不混入 sync 批）：先于批闭合送达（sleep 5 < 25）
//   - 全 session bg-notify 恰 2 条（1 批 + 1 单）
//
// 用法：node a8-mixed-dispatch.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   全程 ~40-60s（sleep 5/15/25），可直接实跑。

import * as C from "./common.mjs";

const SCENARIO = "A8";
const DESIGN = "subagent-sync-collect.md §4 验收表 A8（同轮混合派发：2 sync 恒单批 + async 独立通知）";
const EXPECT = "恰 2 条通知：1 条 sync 批（2 finished）+ 1 条 async 单条（独立先行）";

const MARKER_ASYNC = "async-done";
const MARKER_SYNC_ONE = "sync-one-done";
const MARKER_SYNC_TWO = "sync-two-done";
const BATCH_HEADER_2 = "Subagent batch completed: 2 finished, 0 failed, 0 cancelled.";

async function main() {
  if (C.isDryRun(process.argv)) {
    process.exit(
      C.dryRunReport({
        scenarioId: SCENARIO,
        design: DESIGN,
        expect: EXPECT,
        scriptFile: import.meta.url,
        plan: [
          "mkdtemp + spawn pi RPC → 同轮 3 个 start：async（sleep 5，不传 collect）+ sync×2（sleep 15/25，collect:sync）",
          "等派发轮 turn_end，轮询 session JSONL ≤180s 直到 ≥2 条 notify 且含 sync 批头",
          "断言：恰 2 条 notify / sync 批恰 1 条（批头 2 finished）/ async 独立单条",
          "断言：async 条目先于批条目送达（index 序）/ 批条目 id 集 == 2 个 sync 成员 / 批不含 async 结果",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("a8");
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-main`,
  });

  try {
    const ready = await session.waitReady();
    checks.check("pi RPC 就绪", !!ready, ready ? "" : session.stderrTail());

    const prompt = C.dispatchPrompt({
      starts: [
        {
          task:
            `You MUST actually run this exact bash command first: sleep 5 && echo mixed-async. ` +
            `After it finishes, reply with exactly: ${MARKER_ASYNC}`,
          slug: "mixed-async",
          // 不传 collect → async
        },
        {
          task:
            `You MUST actually run this exact bash command first: sleep 15 && echo mixed-sync-one. ` +
            `After it finishes, reply with exactly: ${MARKER_SYNC_ONE}`,
          slug: "mixed-sync-one",
          collect: "sync",
        },
        {
          task:
            `You MUST actually run this exact bash command first: sleep 25 && echo mixed-sync-two. ` +
            `After it finishes, reply with exactly: ${MARKER_SYNC_TWO}`,
          slug: "mixed-sync-two",
          collect: "sync",
        },
      ],
    });
    const turn = await session.prompt(prompt, 120000);
    checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    // async 成员 ~5s 独立送达；sync 批 ~25s 后闭合
    const entries = await C.waitForNotify(
      session.sessionFile,
      180000,
      (ns) => ns.length >= 2 && ns.some((n) => C.BATCH_HEADER_RE.test(n.content.split("\n")[0] || "")),
      "sync 批通知 + async 单条通知",
    );

    const notifies = C.bgNotifyEntries(entries);
    const syncBatches = C.syncBatchNotifyEntries(entries);
    const asyncSingles = C.asyncNotifyEntries(entries);
    checks.check("bg-notify 恰 2 条（1 批 + 1 单）", notifies.length === 2, `count=${notifies.length}`);
    checks.check("sync 部分恒 1 条批通知", syncBatches.length === 1, `batches=${syncBatches.length}`);
    checks.check("async 独立单条通知", asyncSingles.length === 1, `singles=${asyncSingles.length}`);

    if (syncBatches[0] && asyncSingles[0]) {
      const batch = syncBatches[0];
      const single = asyncSingles[0];

      // 独立性证据：async 通知先于批闭合送达（sleep 5 < 25 的确定性时序）
      checks.check("async 通知先于 sync 批送达（index 序）", single.index < batch.index, `async@${single.index} batch@${batch.index}`);

      const header = batch.content.split("\n")[0];
      checks.check(`批头 \`2 finished, 0 failed, 0 cancelled\``, header === BATCH_HEADER_2, header);
      checks.check("批形态 details.batch === true", batch.details.batch === true);

      const segs = C.batchSegments(batch.content);
      checks.check("批头 + 2 条目（async 未混入批）", segs.length === 3, `segments=${segs.length}`);
      checks.check("批 content 不含 async 结果", !batch.content.includes(MARKER_ASYNC), MARKER_ASYNC);

      // 派发核对：2 个显式 sync + 1 个 async（task marker 识别）
      const starts = C.dispatchedStarts(entries);
      const syncStarts = starts.filter((s) => s.collect === "sync");
      const asyncStart = starts.find((s) => s.task.includes(MARKER_ASYNC));
      checks.check("派发 2 个 collect:sync + 1 个 async", starts.length === 3 && syncStarts.length === 2 && !!asyncStart, `starts=${starts.length} sync=${syncStarts.length}`);

      const batchIds = new Set(segs.slice(1).map((s) => C.saIdOf(s)).filter(Boolean));
      const syncIds = new Set(syncStarts.map((s) => s.saId));
      checks.check(
        "批条目 id 集 == 2 个 sync 成员 id 集",
        batchIds.size === 2 && syncIds.size === 2 && [...batchIds].every((id) => syncIds.has(id)),
        `batch=${batchIds.size} sync=${syncIds.size}`,
      );
      if (asyncStart) {
        checks.check("async 成员 id 不在批条目中", ![...batchIds].some((id) => id === asyncStart.saId), asyncStart.saId);
        checks.check("async 单条含 async 成员 id 与结果 marker", single.content.includes(asyncStart.saId) && single.content.includes(MARKER_ASYNC), single.content.split("\n")[0] || "(空)");
      }
      const okSyncMarkers = [MARKER_SYNC_ONE, MARKER_SYNC_TWO].every((m) => batch.content.includes(m));
      checks.check("批含 2 个 sync 成员结果 marker", okSyncMarkers, `${MARKER_SYNC_ONE}/${MARKER_SYNC_TWO}`);
    }

    C.appendResultRecord(SCENARIO, [
      `- 模型: ${C.resolveModel()}`,
      `- notify 总数: ${notifies.length}（预期 2 = 1 批 + 1 单）`,
    ]);
    checks.finish(SCENARIO);
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
}

C.runScenario(SCENARIO, main);

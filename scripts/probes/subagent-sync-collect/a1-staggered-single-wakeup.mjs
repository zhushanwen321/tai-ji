#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a1-staggered-single-wakeup.mjs
//
// [A1] 错峰全成功单唤醒（DoD 门）
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A1 行（设计文档已删，git 可追溯）：
//   RPC 起 pi，发一条含 3 个 collect:"sync" start 的 prompt（任务里让三台
//   sleep 10s/30s/60s 再返回），等待。
// 预期输出：
//   - session JSONL 中 subagent-bg-notify custom entry 恰好 1 条（批形态）
//   - 批头 `Subagent batch completed: 3 finished, 0 failed, 0 cancelled.`
//   - 批闭合前主 agent 无任何新增 turn（notify entry 之前 assistant 数 == 派发轮基线）
//   - 三段结果在同一条消息（3 个不同 sa- id 条目）
//   - 错峰证据：批通知时刻距派发轮结束 ≥50s（最慢成员 sleep 60s 主导闭合）
//
// 用法：node a1-staggered-single-wakeup.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   本场景含 60s sleep，属长时场景——主 agent 统一执行，探针只保证可执行性。

import * as C from "./common.mjs";

const SCENARIO = "A1";
const DESIGN = "subagent-sync-collect.md §4 验收表 A1（错峰全成功单唤醒，DoD 门）";
const EXPECT =
  "恰 1 条 subagent-bg-notify（批头 3 finished 0 failed 0 cancelled）；批闭合前零新增 turn；三段结果同一条消息";

const SLEEPS = [10, 30, 60];

async function main() {
  if (C.isDryRun(process.argv)) {
    process.exit(
      C.dryRunReport({
        scenarioId: SCENARIO,
        design: DESIGN,
        expect: EXPECT,
        scriptFile: import.meta.url,
        plan: [
          `mkdtemp 工作区 + spawn pi RPC（模型 ${C.resolveModel()}）`,
          "发 1 条 prompt：同轮 3 个 subagent start（collect:sync，task = sleep 10s/30s/60s + echo marker）",
          "等派发轮 turn_end，记 session JSONL assistant 基线数",
          "轮询 session JSONL ≤240s 直到 subagent-bg-notify entry 出现",
          "断言：notify 恰 1 条 / 批头 3 finished / notify 前 assistant 数 == 基线 / 3 个不同 sa- id / 通知距派发 ≥50s",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("a1");
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-main`,
  });

  try {
    const ready = await session.waitReady();
    checks.check("pi RPC 就绪（extensions 加载成功）", !!ready, ready ? "" : session.stderrTail());

    const dispatchAt = Date.now();
    const prompt = C.dispatchPrompt({
      starts: SLEEPS.map(
        (s) => ({
          task:
            `You MUST actually run this exact bash command first: sleep ${s} && echo marker-${s}. ` +
            `After it finishes, reply with exactly: done-${s}`,
          slug: `sleep-${s}s`,
          collect: "sync",
        }),
      ),
    });
    const turn = await session.prompt(prompt, 120000);
    checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const baseEntries = C.readJsonlEntries(session.sessionFile);
    const baseAssistantCount = C.assistantMessages(baseEntries).length;
    const baseNotifyCount = C.bgNotifyEntries(baseEntries).length;
    checks.check("派发轮后基线：notify entry 为 0", baseNotifyCount === 0, `baseline=${baseNotifyCount}`);

    // 3 台 sleep 10/30/60 + 子进程启动/LLM 开销：240s 轮询预算
    const entries = await C.waitForNotify(
      session.sessionFile,
      240000,
      (ns) => ns.length > 0,
      "批 notify entry",
    );
    const notifyAt = Date.now();

    const notifies = C.bgNotifyEntries(entries);
    const syncBatches = C.syncBatchNotifyEntries(entries);
    checks.check("subagent-bg-notify 恰好 1 条", notifies.length === 1, `count=${notifies.length}`);

    const batch = syncBatches[0];
    checks.check("批形态（批头行匹配）", syncBatches.length === 1, syncBatches.length === 1 ? "" : `syncBatches=${syncBatches.length}`);
    if (batch) {
      const header = batch.content.split("\n")[0];
      checks.check(
        "批头 `3 finished, 0 failed, 0 cancelled`",
        header === "Subagent batch completed: 3 finished, 0 failed, 0 cancelled.",
        header,
      );
      checks.check("details.batch === true", batch.details.batch === true);

      const segs = C.batchSegments(batch.content);
      checks.check("三段结果在同一条消息（批头 + 3 条目）", segs.length === 4, `segments=${segs.length}`);
      const ids = segs.slice(1).map((s) => C.saIdOf(s));
      const uniqueIds = new Set(ids.filter(Boolean));
      checks.check("3 个不同 sa- id 条目", uniqueIds.size === 3, `ids=${[...uniqueIds].join(",")}`);

      // 派发参数核对：3 个 start 均 collect:"sync"
      const starts = C.dispatchedStarts(entries);
      const syncStarts = starts.filter((s) => s.collect === "sync");
      checks.check("派发 3 个 start 均 collect:sync", syncStarts.length === 3, `starts=${starts.length}/${syncStarts.length} sync`);
      if (uniqueIds.size === 3 && syncStarts.length === 3) {
        const startIds = new Set(syncStarts.map((s) => s.saId));
        checks.check("批条目 id == 派发 sync 成员 id 集", startIds.size === uniqueIds.size && [...uniqueIds].every((id) => startIds.has(id)));
      }
    }

    // 批闭合前零新 turn：notify entry 之前的 assistant 数 == 派发轮基线
    //（批唤醒 turn 的 assistant 回复发生在 notify 注入之后）
    const preAssistant = C.assistantCountBefore(entries, notifies[0].index);
    checks.check(
      "批闭合前主 agent 零新增 turn",
      preAssistant === baseAssistantCount,
      `before=${preAssistant} baseline=${baseAssistantCount}`,
    );

    // 错峰证据：最慢成员 60s 主导闭合（10s/30s 成员早已完成却未单独唤醒）
    const elapsed = (notifyAt - dispatchAt) / 1000;
    checks.check("批通知距派发 ≥50s（等齐 60s 成员）", elapsed >= 50, `elapsed=${elapsed.toFixed(1)}s`);

    C.appendResultRecord(SCENARIO, [
      `- 模型: ${C.resolveModel()}`,
      `- 批通知时延: ${elapsed.toFixed(1)}s（派发 → 单唤醒）`,
      `- notify entry 总数: ${notifies.length}（预期 1）`,
    ]);
    checks.finish(SCENARIO);
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
}

C.runScenario(SCENARIO, main);

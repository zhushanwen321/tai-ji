#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a3-failure-in-batch.mjs
//
// [A3] 成员失败入批
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A3 行（设计文档已删，git 可追溯）：
//   3 个 collect:"sync"，其一 task 为「直接 throw/失败」。
// 预期输出：
//   - 仍单条批通知（subagent-bg-notify 恰 1 条，批形态）
//   - 批头 `Subagent batch completed: 2 finished, 1 failed, 0 cancelled.`
//   - 失败条目 `Subagent "..." (sa-...) failed: <error 首行>` 且 error 首行非空
//   - details.items 长度 3（2 成功 + 1 失败同批）
//
// 失败注入方式：成员 task 要求立即 `kill -9 $PPID`（bash 工具进程的父进程即
// subagent 的 pi 进程）→ 子进程异常退出（signal）→ closedReason/error → failed。
// 这是运行时注入，不是 mock——与「真实 CLI 探针」定位一致。
//
// 用法：node a3-failure-in-batch.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）

import * as C from "./common.mjs";

const SCENARIO = "A3";
const DESIGN = "subagent-sync-collect.md §4 验收表 A3（成员失败入批）";
const EXPECT = "单条批通知；批头 2 finished, 1 failed, 0 cancelled；失败条目含 error 首行";

async function main() {
  if (C.isDryRun(process.argv)) {
    process.exit(
      C.dryRunReport({
        scenarioId: SCENARIO,
        design: DESIGN,
        expect: EXPECT,
        scriptFile: import.meta.url,
        plan: [
          "mkdtemp 工作区 + spawn pi RPC",
          "发 1 条 prompt：同轮 3 个 start（collect:sync）—— 2 个正常 echo 任务 + 1 个 `kill -9 $PPID` 崩溃任务",
          "等派发轮 turn_end，轮询 session JSONL ≤180s 直到批 notify 出现",
          "断言：恰 1 条批 / 批头 2 finished 1 failed / 失败条目 error 首行非空 / details.items==3",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const ws = C.makeWorkspace("a3");
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
          task: "You MUST actually run this exact bash command first: echo ok-one. After it finishes, reply with exactly: one-done",
          slug: "ok-one",
          collect: "sync",
        },
        {
          task:
            "This subagent is a deliberate crash test. Do NOT do any other work. " +
            "Immediately run this exact bash command: kill -9 $PPID . " +
            "It terminates your own agent process — that is the expected outcome of this test.",
          slug: "crash-two",
          collect: "sync",
        },
        {
          task: "You MUST actually run this exact bash command first: sleep 8 && echo ok-three. After it finishes, reply with exactly: three-done",
          slug: "ok-three",
          collect: "sync",
        },
      ],
    });
    const turn = await session.prompt(prompt, 120000);
    checks.check("派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const entries = await C.waitForNotify(session.sessionFile, 180000, (ns) => ns.length > 0, "批 notify entry");

    const notifies = C.bgNotifyEntries(entries);
    checks.check("仍单条通知", notifies.length === 1, `count=${notifies.length}`);

    const batches = C.syncBatchNotifyEntries(entries);
    checks.check("批形态", batches.length === 1, `batches=${batches.length}`);
    if (batches[0]) {
      const batch = batches[0];
      const header = batch.content.split("\n")[0];
      checks.check(
        "批头 `2 finished, 1 failed, 0 cancelled`",
        header === "Subagent batch completed: 2 finished, 1 failed, 0 cancelled.",
        header,
      );
      checks.check("details.items 含 3 成员", Array.isArray(batch.details.items) && batch.details.items.length === 3, `items=${(batch.details.items || []).length}`);

      const segs = C.batchSegments(batch.content);
      checks.check("批头 + 3 条目", segs.length === 4, `segments=${segs.length}`);
      const failItem = segs.slice(1).find((s) => s.includes(") failed: "));
      const okItems = segs.slice(1).filter((s) => s.includes(") completed. Result:"));
      checks.check("2 个 completed 条目", okItems.length === 2, `completed=${okItems.length}`);
      checks.check("1 个 failed 条目", !!failItem, segs.slice(1).map((s) => s.split("\n")[0]).join(" || "));
      if (failItem) {
        const firstLine = failItem.split("\n")[0];
        const m = firstLine.match(/failed: (.+)$/);
        checks.check("失败条目 error 首行非空", !!m && m[1].trim().length > 0, firstLine.slice(0, 120));
      }

      // 失败成员 sa-id 与派发 crash task 对应（非 mock：崩的是派发指定的成员）
      const starts = C.dispatchedStarts(entries);
      const crashStart = starts.find((s) => /crash/i.test(s.task));
      if (crashStart && failItem) {
        checks.check("失败条目 == 派发的崩溃任务成员", failItem.includes(crashStart.saId), `expect ${crashStart.saId}`);
      }
    }

    C.appendResultRecord(SCENARIO, [
      `- 模型: ${C.resolveModel()}`,
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

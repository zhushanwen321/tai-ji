// src/__tests__/record-mode/driver-resume.ts
//
// [u4a][场景 9] 双进程夹具的 resume driver（tsx 子进程载体，非测试文件——
// vitest include 只收 *.test.ts）。经 child_process spawn 以独立 OS 进程运行
// resumeRun，验证 [D7] proper-lockfile 跨进程互斥（mkdir 原子性）。
//
// 角色由 env 注入：
// - WF_DRIVER_ROLE=holder：持锁方。resumeRun 的锁段内 deps.appendEntry 同步
//   阻塞（Atomics.wait 6s——模拟慢 IO 拉长锁持有段，覆盖竞争方 tsx 子进程冷启动，制造确定性竞争窗口；
//   窗口取值见 blockMs 调用点注释），阻塞前写 marker（与主测试进程握手：marker
//   在场 = 锁已持有）。复活后等 run 终局再退出（exit 0）。
// - WF_DRIVER_ROLE=contender：竞争方。直接 resumeRun，预期 [D7] ELOCKED 拒绝
//   （ResumeRejectionError 文案含 "being resumed by another process"）——exit 1，
//   拒绝文案打到 stderr 供主进程断言。
//
// import 走相对物理路径（tsx 逐级 node_modules 解析 proper-lockfile 等 core 依赖）。
import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { resumeRun } from "../../../../../../packages/subagent-core/src/orchestration/resume-run.ts";
import { runSummary } from "../../../../../../packages/subagent-core/src/orchestration/workflow-run-summary.ts";
import { WorkerHostImpl } from "../../../../../../packages/subagent-core/src/orchestration/worker-host.ts";
import { setRunEventJournalDirForTest } from "../../../../../../packages/subagent-core/src/orchestration/terminal-actions.ts";
import type { LifecycleDeps } from "../../../../../../packages/subagent-core/src/orchestration/models/ports.ts";

const STATE_DIR = process.env.WF_DRIVER_STATE_DIR ?? "";
const RUN_ID = process.env.WF_DRIVER_RUN_ID ?? "";
const ROLE = process.env.WF_DRIVER_ROLE ?? "";
const MARKER_NAME = process.env.WF_DRIVER_MARKER ?? "";

if (STATE_DIR === "" || RUN_ID === "" || (ROLE !== "holder" && ROLE !== "contender")) {
  process.stderr.write("driver-resume: WF_DRIVER_STATE_DIR / WF_DRIVER_RUN_ID / WF_DRIVER_ROLE(holder|contender) required\n");
  process.exit(2);
}

// journal 模块锚 = 本轮 tmp stateDir（与主测试进程 setRunEventJournalDirForTest
// 同一注入机制——driver 是独立 OS 进程，模块态不继承，必须自锚）。[session-store-
// layout-inversion D2/D3] 新布局下生产链的活体 dispatch（agent-settled 等经
// WorkflowRun 投递，不带 per-call journalDir）走进程级 rootSessionId 锚
// （SessionBaselines.initSession 绑定）；driver 不是 pi 宿主（无 initSession），
// 生产同位锚不可用，按场景 kit 惯例锚显式目录（resume 的 per-call journalDir 与
// 锚同目录，跨进程锁语义不受影响）。
setRunEventJournalDirForTest(STATE_DIR);

/** 持锁方 marker（同步写——appendEntry 是同步调用点，且后续 Atomics.wait 会
 * 冻结 event loop，异步写在阻塞窗口内不可达）。文件名与 scenario-kit 的
 * driverMarkerPath(stateDir, name) 对齐（driver-<name>.marker）。 */
function writeMarkerSync(): void {
  fs.writeFileSync(`${STATE_DIR}/driver-${MARKER_NAME}.marker`, String(Date.now()), "utf8");
}

/** 同步阻塞 ms（主线程 Atomics.wait——node 下合法的同步等待原语）。 */
function blockMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const deps: LifecycleDeps = {
  store: {
    save: async () => {},
    loadAll: async () => [],
    stateFilePath: () => "",
  },
  workerHost: new WorkerHostImpl(),
  runner: {
    async run() {
      return { content: "driver-faux-result", durationMs: 5 };
    },
  },
  runs: new Map(),
  appendEntry: () => {
    if (ROLE === "holder" && MARKER_NAME !== "") {
      // 锁段内：先握手再拉长持有段（确定性竞争窗口——竞争方到达时锁必被持有）。
      // 窗口只需 > 竞争方 tsx 子进程到达锁仲裁点的耗时：实测（2026-10-26 空载
      // 探针：tsx 冷启动 + 本 driver import 链全编译 + resumeRun 前置到锁 mkdir
      // 尝试点）为 0.17-0.31s；6s 保留约 19x 空载余量，同机满载放大（tiering
      // 第九节实证 ±40%，取极端 5x）下仍 >3.8x。窗口与断言零数值耦合（断言只
      // 锚序关系：竞争方在窗口内到达即 ELOCKED）。
      writeMarkerSync();
      blockMs(6000);
    }
  },
  log: () => {},
};

async function main(): Promise<void> {
  try {
    await resumeRun(RUN_ID, deps, { journalDir: STATE_DIR });
  } catch (err) {
    process.stderr.write(`driver(${ROLE}): resume rejected: ${(err as Error).message}\n`);
    process.exit(1);
  }
  if (ROLE === "holder") {
    // 复活后等 run 终局再退（worker thread 持事件循环——不等待则子进程不退）
    const deadline = Date.now() + 30_000;
    for (;;) {
      const run = deps.runs.get(RUN_ID);
      if (run && runSummary(run).status !== "running") {
        process.stderr.write(`driver(holder): settled reason=${runSummary(run).reason ?? "?"} error=${runSummary(run).error ?? "-"}\n`);
        break;
      }
      if (Date.now() > deadline) {
        process.stderr.write(`driver(holder): run ${RUN_ID} did not settle within 30s\n`);
        process.exit(3);
      }
      await delay(5);
    }
  }
  process.exit(0);
}

void main();

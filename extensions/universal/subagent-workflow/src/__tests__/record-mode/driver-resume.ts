// src/__tests__/record-mode/driver-resume.ts
//
// [u4a][场景 9] 双进程夹具的 resume driver（tsx 子进程载体，非测试文件——
// vitest include 只收 *.test.ts）。经 child_process spawn 以独立 OS 进程运行
// resumeRun，验证 [D7] proper-lockfile 跨进程互斥（mkdir 原子性）。
//
// 角色由 env 注入：
// - WF_DRIVER_ROLE=holder：持锁方。resumeRun 的锁段内 deps.appendEntry 同步
//   阻塞（Atomics.wait 20s——模拟慢 IO 拉长锁持有段，覆盖竞争方 tsx 子进程冷启动，制造确定性竞争窗口），
//   阻塞前写 marker（与主测试进程握手：marker 在场 = 锁已持有）。复活后等 run
//   终局再退出（exit 0）。
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
import type { LifecycleDeps } from "../../../../../../packages/subagent-core/src/orchestration/models/ports.ts";

const STATE_DIR = process.env.WF_DRIVER_STATE_DIR ?? "";
const RUN_ID = process.env.WF_DRIVER_RUN_ID ?? "";
const ROLE = process.env.WF_DRIVER_ROLE ?? "";
const MARKER_NAME = process.env.WF_DRIVER_MARKER ?? "";

if (STATE_DIR === "" || RUN_ID === "" || (ROLE !== "holder" && ROLE !== "contender")) {
  process.stderr.write("driver-resume: WF_DRIVER_STATE_DIR / WF_DRIVER_RUN_ID / WF_DRIVER_ROLE(holder|contender) required\n");
  process.exit(2);
}

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
      // 锁段内：先握手再拉长持有段（确定性竞争窗口——竞争方到达时锁必被持有）
      writeMarkerSync();
      blockMs(20000);
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

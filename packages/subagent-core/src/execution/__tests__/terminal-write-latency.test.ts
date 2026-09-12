// src/execution/__tests__/terminal-write-latency.test.ts
//
// [H4 / D2 / 待验证检查点①] 终态原语同步写时延实测（vitest 内采样，非 bench 文件）：
// markFinalized 的持久化面 = `.state` writeSync + manifest writeSync（D8 v7 双写），
// D2 重审阈值 = 终态路径 P99 增量 > 10ms（超限方向 = 降级「shutdown 前 flush 批量
// 同步写」，设计 §3.3 D2）。本测试在真实 mkdtemp 目录采样 N=100 次，断言 P99 <
// 10ms；实测数字经 console.info 落测试输出，供 H4 文档回写登记。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecord } from "../execution-record.ts";
import { ManifestStore } from "../manifest-store.ts";
import { RecordStore } from "../record-store.ts";

/** 采样次数（D2 口径 N=100）。 */
const SAMPLE_COUNT = 100;
/** D2 重审阈值（ms）：终态路径 P99 超此值触发设计重审。 */
const D2_P99_THRESHOLD_MS = 10;

describe("D2 时延实测：markFinalized 终态同步双写", () => {
  let tmpDir: string;
  let recordsDir: string;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-latency-"));
    recordsDir = path.join(tmpDir, "records");
    // 生产形态全接线：manifestStore 与 manifestDir（同步写通道，D8 v7）同源同目录。
    store = new RecordStore(
      tmpDir,
      new ManifestStore(recordsDir),
      { appendEntry: () => {} },
      recordsDir,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it(`.state + manifest 双写 P99 < ${D2_P99_THRESHOLD_MS}ms（N=${SAMPLE_COUNT}，真实磁盘）`, () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const record = createRecord(`sa-latency-${i}`, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        slug: "t",
        task: "latency probe",
        startedAt: 1000,
        rootSessionId: "root",
      });
      record.sessionFile = sessionFile;
      store.register(record);
      const t0 = performance.now();
      const persisted = store.markFinalized(record, "gc");
      const t1 = performance.now();
      expect(persisted).toBe(true);
      samples.push(t1 - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(SAMPLE_COUNT * 0.5)]!;
    const p99 = samples[Math.ceil(SAMPLE_COUNT * 0.99) - 1]!;
    const max = samples[SAMPLE_COUNT - 1]!;
    // eslint 基建：__tests__ 豁免 no-console（测试基建通道，非生产源码）。
    console.info(
      `[D2 latency] markFinalized N=${SAMPLE_COUNT}: p50=${p50.toFixed(3)}ms ` +
        `p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms (threshold ${D2_P99_THRESHOLD_MS}ms, D8 v7 .state+manifest 双写)`,
    );
    expect(p99).toBeLessThan(D2_P99_THRESHOLD_MS);
  });
});

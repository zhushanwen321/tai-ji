// src/execution/__tests__/terminal-write-latency.test.ts
//
// [H4 / D2 / 待验证检查点①] markFinalized 终态写面——两条轨道（单测层极端测试
// 整治第二波拆分层，判据见 docs/TEST-STRATEGY.md「新写测试判据」节）：
//
//   1. 单测轨（默认）：终态写面的**逻辑断言**——「双写发生且 persisted=true」。
//      现行写面（.state 收条已退场，见 record-store.ts 意图原语表 markFinalized 行）：
//      record-settled 事件帧（appendFileSync 同步落盘，事件流是磁盘终态的权威）
//      + 终态 manifest 投影（writeAtomicFileSync 同步落盘），写序 = 先事件后派生
//      （manifest 携带事件文件 stat 水位，构造性新鲜）。
//   2. 时延实测轨（TAIJI_TEST_INTEGRATION=1 才跑，本地默认跳过）：真实磁盘采样
//      N=100 的耗时分布实测（P99 水位追踪）。
//
// 为什么时延轨不再有阈值断言：负载态墙钟耗时（CPU 被并行 worker 抢占的整段慢窗）
// 在单测/集成轨都没有稳定上界，历史上的 10ms→200ms 抬升正是拿阈值补偿负载的
// 反模式（症状不是解法）——阈值已随拆层退役，P99 数字经 console.info 落测试输出
// 供人工/文档追踪（结构性回归如误加 fsync / N 倍冗余写在数字上呈数量级跳变，
// 单跑口径即可见）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../../test-guard/integration-gate.ts";
import {
  completeLegacyClosed,
  createRecord,
  trySettleLegacyClosed,
} from "../persistence/execution-record.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { RecordStore } from "../persistence/record-store.ts";

/** 时延实测轨采样次数（D2 口径 N=100）。 */
const SAMPLE_COUNT = 100;

describe("markFinalized 终态写面：双写发生且 persisted=true（单测轨）", () => {
  let tmpDir: string;
  let recordsDir: string;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-write-"));
    recordsDir = path.join(tmpDir, "records");
    // 生产形态全接线：manifestStore 与 manifestDir（同步写通道，D8 v7）同源同目录。
    store = new RecordStore(() => tmpDir, new ManifestStore(() => recordsDir), { appendEntry: () => {} }, () => recordsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("record-settled 事件帧 + 终态 manifest 双写发生，返回 true，record 出册", () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf8");
    const record = createRecord("sa-terminal-write", {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "terminal write probe",
      startedAt: 1000,
      rootSessionId: "root",
    });
    record.sessionFile = sessionFile;
    store.register(record);
    // 生产调用惯例（record-store.ts 字段写点表）：终态冻结先由调用方完成
    // （trySettleLegacyClosed 抢锁 → completeLegacyClosed 冻结 endedAt），
    // markFinalized 只吸收持久化面。
    expect(trySettleLegacyClosed(record, "gc")).toBe(true);
    completeLegacyClosed(record, { text: "done", turns: 1, durationMs: 1, success: true, sessionId: "sid", toolCalls: [] }, "gc");

    const persisted = store.markFinalized(record, "gc");

    expect(persisted).toBe(true);
    // 双写①：record-settled 事件帧已同步落盘（appendFileSync——markFinalized
    // 返回即达页缓存，无需等待窗口）
    const eventsPath = path.join(recordsDir, `${record.id}.events`);
    const events = fs.readFileSync(eventsPath, "utf8");
    expect(events).toContain('"type":"record-settled"');
    // 双写②：终态 manifest 投影已同步落盘（writeAtomicFileSync），投影口径 =
    // legacy status closed + 两态 executionStatus idle + closedReason 随行
    const manifestPath = path.join(recordsDir, `${record.id}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      status?: string;
      executionStatus?: string;
      closedReason?: string;
      eventsStamp?: { mtimeMs: number; size: number };
    };
    expect(manifest.status).toBe("closed");
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.closedReason).toBe("gc");
    // 写序水位：manifest 携带事件文件当前 stat 戳 = 物化发生在事件追加之后
    // （「先事件后派生」的确定性证据，非时序推测）
    const eventsStat = fs.statSync(eventsPath);
    expect(manifest.eventsStamp).toEqual({ mtimeMs: eventsStat.mtimeMs, size: eventsStat.size });
    // 终态 record 已出册（archive 立即移出内存）
    expect(store.getMutable(record.id)).toBeUndefined();
  });
});

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  "D2 时延实测：markFinalized 终态同步写（真实磁盘）" +
    (INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""),
  () => {
    let tmpDir: string;
    let recordsDir: string;
    let store: RecordStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-latency-"));
      recordsDir = path.join(tmpDir, "records");
      store = new RecordStore(() => tmpDir, new ManifestStore(() => recordsDir), { appendEntry: () => {} }, () => recordsDir);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    // 采样口径与历史系列可比：fresh record（无 endedAt，register 后直接
    // markFinalized）——计时窗内每次迭代的真实同步写 = 终态 manifest
    // writeAtomicFileSync（register 的事件面写在计时窗外）。
    it(`markFinalized N=${SAMPLE_COUNT} 采样：P99/p50/max 落输出（水位追踪，无阈值断言）`, () => {
      const sessionFile = path.join(tmpDir, "session.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf8");
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
      // 无阈值断言：负载态墙钟无稳定上界（历史 10ms→200ms 抬升即其症状，已退役），
      // 结构性回归按数量级跳变在落盘数字上人工/文档追踪。
      console.info(
        `[D2 latency] markFinalized N=${SAMPLE_COUNT}: p50=${p50.toFixed(3)}ms ` +
          `p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms（终态 manifest 同步写；P99 水位追踪，无阈值）`,
      );
      expect(samples.length).toBe(SAMPLE_COUNT);
    });
  },
);

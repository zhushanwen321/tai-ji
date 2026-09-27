// file-run-store.test.ts —— RunStore port 的宿主无关文件实现（D2 设计件）。
//
// 四视角：
// ①使用者——save/loadAll 往返一致（聚合根字段全量保真：spec/state/budget/calls/trace/meta）；
// ②隔离者——多 run 各落各文件，互不串扰；
// ③幸存者——append-only + 损坏行容错（半行写入崩溃后取最后一条「有效」行；整文件损坏不炸 loadAll）；
// ④接线者——stateFilePath 路径形状（<dataRoot>/workflow-state/<runId>.jsonl）与
//   未 configureCore 的 fail-loud（core_host_not_configured，§3.4 错误规格）。
//
// dataRoot 经 configureCore(tmp) 注入 + resetCoreForTests 复位（对齐
// core/__tests__/host-services.test.ts 的配置态隔离模式）；warn 断言经宿主 log
// 端口 spy 捕获（logger facade 每次调用动态解析宿主实现，logger.ts 契约）。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import {
  createRecordEventJournal,
  type RecordJournalEventInput,
} from "../../execution/persistence/record-events.ts";
// [W1 / D5 触发点②] RecordStore.register 首写触发维护轮的行为断言面
import { RecordStore } from "../../execution/persistence/record-store.ts";
import { createRecord } from "../../execution/persistence/execution-record.ts";
// barrel 消费面回归锚：维护轮入口经 barrel 导出（三触发点接线面，U7 消费同路径）
import { runRetentionMaintenanceRound } from "../../index.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import {
  FileRunStore,
  PruneStateDeps,
  pruneTerminalRunFiles,
} from "../file-run-store.ts";
import { RUN_EVENT_JOURNAL_SUFFIX } from "../run-events.ts";

let dataRoot: string;
let logSpy: ReturnType<typeof vi.fn<(level: import("../../core/logger.ts").LogLevel, component: string, message: string, data?: unknown) => void>>;
let store: FileRunStore;

beforeEach(() => {
  resetCoreForTests();
  dataRoot = mkdtempSync(join(tmpdir(), "file-run-store-"));
  logSpy = vi.fn((_level: import("../../core/logger.ts").LogLevel, _component: string, _message: string, _data?: unknown) => {});
  const host: HostServices = {
    dataRoot: () => dataRoot,
    log: logSpy,
  };
  configureCore(host);
  store = new FileRunStore();
});

afterEach(() => {
  resetCoreForTests();
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造可持久化的 WorkflowRun（对齐 lifecycle.test.ts makeEvictableRun 模式）。 */
function makeRun(runId: string, opts: { status?: "running" | "done" } = {}): WorkflowRun {
  const status = opts.status ?? "running";
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "export function execute() { return 'ok'; }",
      args: { topic: "demo", count: 2 },
      scriptName: "test-script",
      scriptPath: "/fake/test.js",
      parameters: { type: "object" },
      budgetTokens: 1000,
    },
    {
      status,
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget({ maxTokens: 1000, usedTokens: 42, usedCost: 0.5, totalCallCount: 3 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
      scriptResult: status === "done" ? { summary: "done-value" } : undefined,
    },
    { startedAt: "2026-08-30T00:00:00.000Z" },
  );
}

/** warn 级日志消息集合（log 端口 (level, component, message) 签名过滤）。 */
function warnMessages(): string[] {
  return logSpy.mock.calls
    .filter((c) => c[0] === "warn")
    .map((c) => String(c[2]));
}

/** 直接往 workflow-state 目录写预置文件（损坏行场景——不经 save 路径建目录）。 */
function writeStateFile(name: string, content: string): void {
  const dir = join(dataRoot, "workflow-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

describe("FileRunStore — save/loadAll 往返一致", () => {
  it("running 快照往返：runId/spec/budget/trace/meta 字段保真", async () => {
    const run = makeRun("wf-rt-1");
    await store.save(run);

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    const back = loaded[0];

    expect(back.runId).toBe("wf-rt-1");
    expect(back.state.status).toBe("running");
    expect(back.spec.scriptName).toBe("test-script");
    expect(back.spec.args).toEqual({ topic: "demo", count: 2 });
    expect(back.spec.parameters).toEqual({ type: "object" });
    // Budget 重水合为实例且消耗累积保真（后续预算判定不归零）
    expect(back.state.budget).toBeInstanceOf(Budget);
    expect(back.state.budget.maxTokens).toBe(1000);
    expect(back.state.budget.usedTokens).toBe(42);
    expect(back.state.budget.usedCost).toBe(0.5);
    expect(back.state.budget.totalCallCount).toBe(3);
    // Trace 重水合为实例；runtime 不落盘（跨进程必死，reconstruct 语义）
    expect(back.state.trace).toBeInstanceOf(Trace);
    expect(back.runtime).toBeUndefined();
    expect(back.meta.startedAt).toBe("2026-08-30T00:00:00.000Z");
  });

  it("done 快照往返：reason/scriptResult/error 保真", async () => {
    const run = makeRun("wf-rt-2", { status: "done" });
    await store.save(run);

    const back = (await store.loadAll())[0];
    expect(back.state.status).toBe("done");
    expect(back.state.reason).toBe("completed");
    expect(back.state.scriptResult).toEqual({ summary: "done-value" });
  });

  it("append-only：同 run 多次 save 追加多行，loadAll 取最后一条（状态演进不丢）", async () => {
    const run = makeRun("wf-rt-3");
    await store.save(run);
    run.transition("done", "failed");
    await store.save(run);

    const raw = readFileSync(store.stateFilePath("wf-rt-3"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);

    const back = (await store.loadAll())[0];
    expect(back.state.status).toBe("done");
    expect(back.state.reason).toBe("failed");
  });

  it("[W1 节流退役回归] save 不再节流：高频 running save 每次都落盘", async () => {
    // W1 写通道语义收敛后 store 不再自带节流层（快照 = journal fold 的物化投影，
    // 写点收敛归 pump 物化时机）——节流模块已随写通道退役删除，本用例锁「每次
    // save 都 append」的直接语义（throttle 测试件随节流移除删除，此处承接回归锚）
    const run = makeRun("wf-unthrottle-1");
    for (let i = 0; i < 3; i++) {
      await store.save(run); // 不推进时间——全量落盘
    }
    const raw = readFileSync(store.stateFilePath("wf-unthrottle-1"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("含 calls 的快照往返：calls Map 逐项保真 + traceNode 回链 Trace 副本", async () => {
    const run = makeRun("wf-rt-4");
    // 经公开 append 路径构造 trace 节点（Trace 值对象，禁止外部打洞 nodes 数组；
    // append 返回 void，节点对象由调用方持有——正是 D-10「call 与 trace 共享引用」的入口）
    const node = {
      stepIndex: 0,
      agent: "coder",
      task: "do work",
      model: "test-model",
      status: "completed" as const,
    };
    run.state.trace.append(node);
    const calls = run.state.calls as Map<number, import("../models/agent-call.ts").AgentCall>;
    const AgentCallMod = await import("../models/agent-call.ts");
    const call = new AgentCallMod.AgentCall(0, { prompt: "do work" }, node);
    call.status = "done";
    call.attempts = 1;
    run.state.calls.set(0, call);

    await store.save(run);
    const back = (await store.loadAll())[0];

    expect(back.state.calls.size).toBe(1);
    const restored = back.state.calls.get(0)!;
    expect(restored.id).toBe(0);
    expect(restored.opts.prompt).toBe("do work");
    expect(restored.status).toBe("done");
    expect(restored.attempts).toBe(1);
    // D-10 尽力恢复：重水合 call.traceNode 与 trace.nodes 副本共享引用
    expect(back.state.trace.toArray()[0].stepIndex).toBe(0);
    expect(restored.traceNode.stepIndex).toBe(0);
    expect(restored.traceNode).toBe(back.state.trace.toArray()[0]);
  });
});

describe("FileRunStore — 多 run 隔离", () => {
  it("两个 run 各落各文件，loadAll 全量返回且互不覆盖", async () => {
    const a = makeRun("wf-iso-a");
    const b = makeRun("wf-iso-b", { status: "done" });
    await store.save(a);
    await store.save(b);

    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId).sort()).toEqual(["wf-iso-a", "wf-iso-b"]);
    const backA = loaded.find((r) => r.runId === "wf-iso-a")!;
    const backB = loaded.find((r) => r.runId === "wf-iso-b")!;
    expect(backA.state.status).toBe("running");
    expect(backB.state.status).toBe("done");
  });
});

describe("FileRunStore — 损坏行容错", () => {
  it("文件尾损坏行（半行写入）→ 取更早的最后有效行 + warn", async () => {
    const run = makeRun("wf-corrupt-1");
    await store.save(run);
    // 模拟崩溃半行：追加一段非法 JSON（无换行截断形态）
    const path = store.stateFilePath("wf-corrupt-1");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before + '{"runId": "wf-corrupt-1", "state": {"sta');

    const back = (await store.loadAll())[0];
    expect(back?.runId).toBe("wf-corrupt-1");
    expect(back?.state.status).toBe("running");
    expect(warnMessages().some((m) => m.includes("wf-corrupt-1.jsonl"))).toBe(true);
  });

  it("形状合法但字段残缺的快照（缺 runId/state）→ 判损坏跳过 + warn", async () => {
    writeStateFile("wf-corrupt-2.jsonl", '{"foo": 1}\n{"also": "bad"}\n');

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(0);
    expect(warnMessages().some((m) => m.includes("malformed snapshot"))).toBe(true);
  });

  it("整文件全损坏 → run 跳过不炸 loadAll（其余 run 正常恢复）", async () => {
    writeStateFile("wf-corrupt-3.jsonl", "not json at all\n{broken\n");
    const good = makeRun("wf-corrupt-4");
    await store.save(good);

    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["wf-corrupt-4"]);
  });

  it("非 .jsonl 文件与空文件不参与加载", async () => {
    writeStateFile("README.txt", "hello");
    writeStateFile("wf-corrupt-5.jsonl", "\n\n");

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(0);
  });

  it("loadAll 目录不存在（干净环境首启）→ 空数组不抛错", async () => {
    // beforeEach 只建了 dataRoot 本身，workflow-state 尚未创建（未 save 过）
    const loaded = await store.loadAll();
    expect(loaded).toEqual([]);
  });
});

describe("FileRunStore — 版本衔接与 live-strip（U8 / ⛔5，D4 裁决）", () => {
  /** core 存量形态行（U8 前：无 v 字段、live 未 strip 直接落盘）。 */
  const LEGACY_LINE = JSON.stringify({
    runId: "wf-legacy-1",
    spec: {
      scriptSource: "export function execute() { return 'legacy'; }",
      args: { topic: "legacy" },
      scriptName: "test-script",
      scriptPath: "/fake/test.js",
    },
    state: {
      status: "running",
      budget: { maxTokens: 1000, usedTokens: 7, usedCost: 0.1, totalCallCount: 1 },
      calls: [
        {
          id: 0,
          opts: { prompt: "legacy work" },
          status: "running",
          attempts: 1,
          traceNode: {
            stepIndex: 0,
            agent: "coder",
            task: "legacy work",
            model: "test-model",
            status: "running",
            live: { turns: [] },
          },
        },
      ],
      trace: [
        {
          stepIndex: 0,
          agent: "coder",
          task: "legacy work",
          model: "test-model",
          status: "running",
          live: { turns: [] },
        },
      ],
      errorLogs: [],
    },
    meta: { startedAt: "2026-08-29T00:00:00.000Z" },
  });

  it("⛔5 无 v 存量行（core 旧格式，含未 strip 的 live）宽容读取不丢数据", async () => {
    writeStateFile("wf-legacy-1.jsonl", LEGACY_LINE + "\n");

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    const back = loaded[0];
    expect(back.runId).toBe("wf-legacy-1");
    expect(back.state.status).toBe("running");
    expect(back.state.budget.usedTokens).toBe(7);
    expect(back.spec.args).toEqual({ topic: "legacy" });
    // 宽容读不是降级路径：不产生 warn（版本不匹配才 warn）
    expect(warnMessages().some((m) => m.includes("wf-legacy-1"))).toBe(false);
  });

  it("⛔5 写入补 v 字段（快照行携带 wf-run-v2）+ 宽容读行写回后自然迁移", async () => {
    const run = makeRun("wf-vwrite-1");
    await store.save(run);

    const raw = readFileSync(store.stateFilePath("wf-vwrite-1"), "utf8").trim();
    expect(JSON.parse(raw).v).toBe("wf-run-v2");

    // 存量行宽容读 → 再 save：落盘行升级为带 v 当前版本（不做自动迁移的
    // 渐进收敛——D4 裁决②「写入时补 v」）。[H2 W3] live 字段退役后 codec 不再
    // 承担键清洗（strip 分支随字段删除退役）——存量行的多余键原样透传（类型
    // 层面已无写点，新写行不可能再产生 live 键；真实存量行经旧 codec strip 也不带）。
    writeStateFile("wf-legacy-2.jsonl", LEGACY_LINE + "\n");
    const legacy = (await store.loadAll()).find((r) => r.runId === "wf-legacy-1")!;
    await store.save(legacy);
    const migrated = readFileSync(store.stateFilePath("wf-legacy-1"), "utf8").trim();
    expect(JSON.parse(migrated).v).toBe("wf-run-v2");
    expect(JSON.parse(migrated).state.status).toBe("running");
  });

  it("⛔5 未知更高版本行跳过 + warn（消息含实际版本值，可定位）", async () => {
    const future = JSON.parse(LEGACY_LINE);
    future.runId = "wf-future-1";
    future.v = "wf-run-v3";
    const current = JSON.parse(LEGACY_LINE);
    current.runId = "wf-current-1";
    current.v = "wf-run-v2";
    // 从尾向头扫描序：尾损坏行（继续向前）→ 高版本行（warn 跳过，继续向前）
    // → 当前版本行（恢复）——单行版本不匹配不拖垮同文件其余行，warn 可见
    writeStateFile(
      "wf-vermix.jsonl",
      JSON.stringify(current) + "\n" + JSON.stringify(future) + "\n" + '{"trunc',
    );

    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["wf-current-1"]);
    expect(warnMessages().some((m) => m.includes("unsupported version") && m.includes("wf-run-v3"))).toBe(true);
  });

  it("⛔5 [H2 W3] live 字段退役：落盘行无 live 键（类型层面收敛的端到端回归）", async () => {
    const run = makeRun("wf-livestrip-1");
    const node: import("../models/types.ts").ExecutionTraceNode = {
      stepIndex: 0,
      agent: "coder",
      task: "do work",
      model: "test-model",
      status: "running",
    };
    run.state.trace.append(node);
    const AgentCallMod = await import("../models/agent-call.ts");
    const call = new AgentCallMod.AgentCall(0, { prompt: "do work" }, node);
    run.state.calls.set(0, call);

    await store.save(run);

    const raw = readFileSync(store.stateFilePath("wf-livestrip-1"), "utf8");
    expect(raw.includes('"live"')).toBe(false);
  });

  it("pi 现网形态行（带 v）经 store 端到端恢复", async () => {
    const piForm = JSON.parse(LEGACY_LINE);
    piForm.runId = "wf-pi-e2e-1";
    piForm.v = "wf-run-v2";
    delete piForm.state.calls[0].traceNode.live;
    delete piForm.state.trace[0].live;
    writeStateFile("wf-pi-e2e-1.jsonl", JSON.stringify(piForm) + "\n");

    const back = (await store.loadAll())[0];
    expect(back.runId).toBe("wf-pi-e2e-1");
    expect(back.state.calls.size).toBe(1);
  });
});

describe("FileRunStore — stateFilePath / 端口语义", () => {
  it("路径形状 = <dataRoot>/workflow-state/<runId>.jsonl（纯计算不建目录）", () => {
    expect(store.stateFilePath("wf-x-1")).toBe(
      join(dataRoot, "workflow-state", "wf-x-1.jsonl"),
    );
  });

  it("宿主覆盖 configureCore 后路径现取新 dataRoot（不缓存路径）", () => {
    const altRoot = mkdtempSync(join(tmpdir(), "file-run-store-alt-"));
    try {
      configureCore({ dataRoot: () => altRoot, log: () => {} });
      expect(store.stateFilePath("wf-x-2")).toBe(
        join(altRoot, "workflow-state", "wf-x-2.jsonl"),
      );
    } finally {
      rmSync(altRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("未 configureCore 即消费 dataRoot → core_host_not_configured（§3.4 fail-loud）", () => {
    resetCoreForTests();
    expect(() => store.stateFilePath("wf-x-3")).toThrowError("core_host_not_configured");
  });
});

// ── 统一保留通道（W1 D5：fold 终态 + 保留窗口，废 cap）──────────────────
//
// 资格判据锚 = journal fold 终态（run-settled 帧驱动 fold 到 terminal，含收编产生
// 的 interrupted）；终态时间 = run-settled 帧 ts。时间注入 = 事件 ts 相对 Date.now
// 计算（天数偏移）；无 journal 创建帧的存量形态用 utimesSync 注入 mtime。

/** 30 天窗口（ms）——测试统一注入，不依赖 env。 */
const RETENTION_30D_MS = 30 * 86_400_000;

/** 「N 天前」的 epoch ms（事件 ts / mtime 注入用）。 */
function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

/** run journal 帧构造（W1 前格式：无 seq——读取面对缺失放行，D7 兼容读）。 */
function runCreatedFrame(runId: string, ts: number): Record<string, unknown> {
  return { type: "run-created", ts, runId, workflowName: "w", argsSummary: "args" };
}
function runSettledFrame(ts: number, outcome: "completed" | "failed" | "cancelled"): Record<string, unknown> {
  return { type: "run-settled", ts, outcome, artifactsDir: "/tmp/artifacts" };
}

/** 直接写 run journal（<runId>.events.jsonl，每帧一行 JSONL）。 */
function writeRunJournal(stateDir: string, runId: string, frames: readonly unknown[]): string {
  mkdirSync(stateDir, { recursive: true });
  const full = join(stateDir, `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
  writeFileSync(full, frames.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  return full;
}

/** 预置终态 run 磁盘足迹（state + journal + manifest）并返回三路径。 */
function seedTerminalRun(stateDir: string, runId: string, createdDaysAgo: number, settledDaysAgo: number, outcome: "completed" | "failed" | "cancelled" = "completed"): { stateFull: string; journalFull: string; manifestFull: string } {
  mkdirSync(stateDir, { recursive: true });
  const stateFull = join(stateDir, `${runId}.jsonl`);
  writeFileSync(stateFull, '{"runId":"' + runId + '","stub":true}\n', "utf8");
  const journalFull = writeRunJournal(stateDir, runId, [
    runCreatedFrame(runId, daysAgoMs(createdDaysAgo)),
    runSettledFrame(daysAgoMs(settledDaysAgo), outcome),
  ]);
  const manifestFull = join(stateDir, `${runId}.json`);
  writeFileSync(manifestFull, JSON.stringify({ runId, outcome }), "utf8");
  return { stateFull, journalFull, manifestFull };
}

/** 预置运行中 run（journal 无终态帧）。 */
function seedRunningRun(stateDir: string, runId: string, createdDaysAgo: number): { stateFull: string; journalFull: string } {
  mkdirSync(stateDir, { recursive: true });
  const stateFull = join(stateDir, `${runId}.jsonl`);
  writeFileSync(stateFull, '{"runId":"' + runId + '","stub":true}\n', "utf8");
  const journalFull = writeRunJournal(stateDir, runId, [
    runCreatedFrame(runId, daysAgoMs(createdDaysAgo)),
    { type: "ask-dispatched", ts: daysAgoMs(createdDaysAgo), taskIndex: 0, agentName: "coder", attempt: 1 },
  ]);
  return { stateFull, journalFull };
}

/** prune/维护轮的 spy deps（日志断言面）。 */
function makeRetentionDeps(): { deps: PruneStateDeps; debugCalls: string[]; warnCalls: string[] } {
  const debugCalls: string[] = [];
  const warnCalls: string[] = [];
  return {
    deps: {
      debug: (m) => debugCalls.push(m),
      warn: (m) => warnCalls.push(m),
      toMsg: (e) => (e instanceof Error ? e.message : String(e)),
    },
    debugCalls,
    warnCalls,
  };
}

describe("pruneTerminalRunFiles — fold 终态 + 保留窗口（W1 D5）", () => {
  it("窗外终态可清：state + journal 成对删，manifest 永不随裁", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const { stateFull, journalFull, manifestFull } = seedTerminalRun(stateDir, "wf-prune-1", 35, 31);

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 1, pruned: 1, nonTerminalBeyondWindow: 0 });
    expect(existsSync(stateFull)).toBe(false);
    expect(existsSync(journalFull)).toBe(false);
    expect(existsSync(manifestFull)).toBe(true); // manifest 永不随裁（孤儿判定依赖）
  });

  it("含收编产生的 interrupted：run-settled(failed) 窗外同样可清", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    // 收编（D4）幂等追加的终态事件 outcome=failed——fold 到 terminal 即获资格
    const { stateFull, journalFull } = seedTerminalRun(stateDir, "wf-prune-2", 40, 35, "failed");

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result.pruned).toBe(1);
    expect(existsSync(stateFull)).toBe(false);
    expect(existsSync(journalFull)).toBe(false);
  });

  it("窗内终态永不清（29 天前 settle，资格计数但不裁）", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const { stateFull, journalFull } = seedTerminalRun(stateDir, "wf-prune-3", 29, 29);

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 1, pruned: 0, nonTerminalBeyondWindow: 0 });
    expect(existsSync(stateFull)).toBe(true);
    expect(existsSync(journalFull)).toBe(true);
  });

  it("运行中永不清：无终态帧的 journal 无论多旧都不裁（判据②未启用），计入候选", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const { stateFull, journalFull } = seedRunningRun(stateDir, "wf-prune-4", 40);

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(existsSync(stateFull)).toBe(true);
    expect(existsSync(journalFull)).toBe(true);
  });

  it("无 journal 的存量 state 文件不裁（fold 非终态）+ mtime 兜底计入候选", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    mkdirSync(stateDir, { recursive: true });
    const stateFull = join(stateDir, "wf-legacy-nojournal.jsonl");
    writeFileSync(stateFull, '{"runId":"wf-legacy-nojournal"}\n', "utf8");
    const old = daysAgoMs(40) / 1000;
    utimesSync(stateFull, old, old); // mtime 注入：注册时间兜底锚

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(existsSync(stateFull)).toBe(true);
  });

  it("废 cap 回归（结构断言）：60 个窗内终态 run 零裁剪（多 session 分摊不再互杀）", async () => {
    // [W1 / D5] cap 语义废除：PruneTerminalRunFilesOptions 已无 cap 字段（类型层
    // 收敛），行为面 = 共享池内窗内终态数量再多也不触发「裁最旧」——另一 session
    // 保留窗口内的终态 run 不再被本 session 的清理轮挤出（A-8 回归锚）；60 > 旧
    // 上限 50，兼锁「数量截断通道退役后不再截断」
    const stateDir = join(dataRoot, "workflow-state");
    for (let i = 0; i < 60; i++) {
      seedTerminalRun(stateDir, `wf-uncapped-${i}`, 5, 1);
    }

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 60, eligible: 60, pruned: 0, nonTerminalBeyondWindow: 0 });
  });

  it("窗口 opt-out（ttlMs 缺省解析 undefined）：整轮不裁，仅候选监控不失明", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    seedTerminalRun(stateDir, "wf-optout-1", 35, 31);
    seedRunningRun(stateDir, "wf-optout-2", 40);

    vi.stubEnv("TAIJI_SUBAGENT_STATE_TTL_MS", "0"); // 非法值 → undefined = opt-out
    try {
      const { deps } = makeRetentionDeps();
      const result = await pruneTerminalRunFiles(stateDir, {}, deps);
      expect(result).toEqual({ scanned: 2, eligible: 1, pruned: 0, nonTerminalBeyondWindow: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("runRetentionMaintenanceRound — run + record 两域同轮（W1 D5）", () => {
  /** record 事件 fixture：经 u0 journal API 写入（seq 单调分配 + 头行契约）。 */
  async function seedRecord(
    recordsDir: string,
    id: string,
    frames: readonly RecordJournalEventInput[],
  ): Promise<string> {
    const journal = createRecordEventJournal(recordsDir);
    for (const frame of frames) await journal.append(id, frame);
    return join(recordsDir, `${id}.events`);
  }
  function recordCreatedInput(id: string, ts: number): RecordJournalEventInput {
    return {
      type: "record-created",
      ts,
      id,
      agent: "coder",
      task: "do work",
      slug: "coder-do-work",
      origin: "tool",
      rootSessionId: "root-1",
      depth: 0,
      mode: "background",
      startedAt: ts,
    };
  }
  function recordSettledInput(ts: number): RecordJournalEventInput {
    return { type: "record-settled", ts, stopReason: "completed", endedAt: ts, turns: 1, totalTokens: 10 };
  }

  it("两域同轮：窗外终态（run + record）同轮清理，manifest 均保留，候选数日志输出", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const recordsDir = join(dataRoot, "records");
    const runSeed = seedTerminalRun(stateDir, "wf-round-1", 35, 31);
    seedRunningRun(stateDir, "wf-round-2", 40); // 判据②候选（run 侧）
    const eventsFull = await seedRecord(recordsDir, "sa-round-1", [
      recordCreatedInput("sa-round-1", daysAgoMs(35)),
      recordSettledInput(daysAgoMs(31)),
    ]);
    writeFileSync(join(recordsDir, "sa-round-1.json"), '{"id":"sa-round-1"}', "utf8"); // record manifest
    await seedRecord(recordsDir, "sa-round-2", [
      recordCreatedInput("sa-round-2", daysAgoMs(40)),
      { type: "record-bound", ts: daysAgoMs(40), sessionFile: "/tmp/s.jsonl", engine: "pi", engineHandle: { sessionRef: { sid: "s1" }, poolKey: "shared" }, epoch: 0 },
    ]); // 运行中 record：判据②候选（record 侧）

    const { deps, debugCalls, warnCalls } = makeRetentionDeps();
    const result = await runRetentionMaintenanceRound(
      { stateDir, recordsDir },
      { retentionMs: RETENTION_30D_MS },
      deps,
    );

    expect(result.run).toEqual({ scanned: 2, eligible: 1, pruned: 1, nonTerminalBeyondWindow: 1 });
    expect(result.record).toEqual({ scanned: 2, eligible: 1, pruned: 1, nonTerminalBeyondWindow: 1 });
    // run 域成对删 + manifest 保留；record 域只删 .events、manifest 不触碰
    expect(existsSync(runSeed.stateFull)).toBe(false);
    expect(existsSync(runSeed.journalFull)).toBe(false);
    expect(existsSync(runSeed.manifestFull)).toBe(true);
    expect(existsSync(eventsFull)).toBe(false);
    expect(existsSync(join(recordsDir, "sa-round-1.json"))).toBe(true);
    // 候选数日志（判据②反向锚点）：整轮汇总 + 增长告警
    expect(debugCalls.some((m) => m.includes("maintenance round done"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("criterion-② candidates") && m.includes("run=1") && m.includes("record=1"))).toBe(true);
  });

  it("record 域窗内终态永不清；reopened 回边清除终态后同样永不清（运行保护）", async () => {
    const stateDir = join(dataRoot, "workflow-state"); // 空目录：run 域零候选
    const recordsDir = join(dataRoot, "records");
    const inWindow = await seedRecord(recordsDir, "sa-in-window", [
      recordCreatedInput("sa-in-window", daysAgoMs(5)),
      recordSettledInput(daysAgoMs(1)),
    ]);
    // settled 后 reopened（epoch 递增 + round 归零）——fold 清除终态 = 回边续跑保护
    const reopened = await seedRecord(recordsDir, "sa-reopened", [
      recordCreatedInput("sa-reopened", daysAgoMs(40)),
      recordSettledInput(daysAgoMs(35)),
      { type: "record-reopened", ts: daysAgoMs(1), epoch: 1, round: 0 },
    ]);

    const { deps } = makeRetentionDeps();
    const result = await runRetentionMaintenanceRound(
      { stateDir, recordsDir },
      { retentionMs: RETENTION_30D_MS },
      deps,
    );

    expect(result.record).toEqual({ scanned: 2, eligible: 1, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(existsSync(inWindow)).toBe(true);
    expect(existsSync(reopened)).toBe(true); // 35 天前的 settled 被 reopened 回边清除 → 永不清
  });

  it("barrel 导出面可被触发点消费（typeof function，U7 接线路径）", () => {
    expect(typeof runRetentionMaintenanceRound).toBe("function");
  });
});

// ── cap 退役结构断言（W1 / D5：数量截断通道整体删除）──────────────────────
//
// cap 族符号（数量上限常量 / env 通道名 / 解析函数）与 cap 选项字段已从导出面
// 与接口删除——保留窗口（fold 终态 ∧ 超窗）是唯一资格判据。行为面（窗内终态
// 数量再多零裁剪）由上方「废 cap 回归（结构断言）」用例锁定（60 > 旧上限 50，
// 不截断）；本段锁运行时导出面零复活。

describe("cap 退役结构断言（W1 / D5）", () => {
  it("file-run-store 导出面零 cap 族符号（键面不含数量截断通道命名形态）", async () => {
    // 拦截形态而非全名清单：cap 族三符号均含「数量上限 / MaxRuns」命名段——
    // 键面排除该段即零复活（词表级全名清扫由引擎 grep 验收承担，此处锁运行时面）
    const mod = await import("../file-run-store.ts");
    const exported = Object.keys(mod);
    expect(exported.filter((k) => k.includes("MAX_RUNS") || k.includes("MaxRuns"))).toEqual([]);
    expect(exported).not.toContain("DEFAULT_SAVE_MIN_INTERVAL_MS");
  });
});

// [W1 / D5] cap 选项字段已从 PruneTerminalRunFilesOptions 删除：类型层锚——
// 仅传 ttlMs 的对象字面量可赋值（cap 若回归为 required 字段，本行编译破）。
const CAP_RETIREMENT_TYPE_ANCHOR: import("../file-run-store.ts").PruneTerminalRunFilesOptions = { ttlMs: 1000 };
void CAP_RETIREMENT_TYPE_ANCHOR;

// ── record 首写触发维护轮（W1 / D5 触发点②，U7 接线·验收①）────────────────
//
// record-only 会话（只跑 subagents()、无任何 workflow run）的 record 域清理入口：
// RecordStore.register 的 record 事件文件首写触发统一维护轮（fire-and-forget——
// 同步写点无 await 通道），窗外终态 .events 被清、manifest 不触碰、新落账的
// record 事件文件（窗内、非终态）保留。

describe("record 首写触发维护轮（W1 / D5 触发点②：RecordStore.register 接线）", () => {
  it("record-only 会话：首写触发后窗外终态 .events 清、manifest 与新 record 保留", async () => {
    const recordsDir = join(dataRoot, "records");
    // 历史遗留：窗外终态 record（settled 31 天前 > 30 天窗口）+ 其 manifest
    const staleEvents = join(recordsDir, "sa-trig-stale.events");
    const staleManifest = join(recordsDir, "sa-trig-stale.json");
    {
      const j = createRecordEventJournal(recordsDir);
      await j.append("sa-trig-stale", {
        type: "record-created",
        ts: daysAgoMs(35),
        id: "sa-trig-stale",
        agent: "coder",
        task: "old work",
        slug: "coder-old-work",
        origin: "tool",
        rootSessionId: "root-1",
        depth: 0,
        mode: "background",
        startedAt: daysAgoMs(35),
      });
      await j.append("sa-trig-stale", {
        type: "record-settled",
        ts: daysAgoMs(31),
        stopReason: "completed",
        endedAt: daysAgoMs(31),
        turns: 1,
        totalTokens: 10,
      });
    }
    writeFileSync(staleManifest, '{"id":"sa-trig-stale"}', "utf8");

    // 触发：register 新 record（事件文件首写）→ 维护轮 fire-and-forget 启动
    const store = new RecordStore(join(dataRoot, "sessions"), undefined, undefined, recordsDir);
    const record = createRecord("sa-trig-new", {
      agent: "coder",
      model: "m",
      mode: "background",
      task: "new work",
      slug: "coder-new-work",
      startedAt: daysAgoMs(0),
      rootSessionId: "root-1",
    });
    store.register(record);
    // 触发前历史遗留原封不动（fire-and-forget 未完成前不产生清理）
    expect(existsSync(staleEvents)).toBe(true);

    // 等待 fire-and-forget 维护轮落定（真实 IO 轮询，有界 2s）
    const deadline = Date.now() + 2000;
    while (existsSync(staleEvents) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(existsSync(staleEvents)).toBe(false); // 窗外终态事件文件被清
    expect(existsSync(staleManifest)).toBe(true); // manifest 不触碰（独立 TTL）
    expect(existsSync(join(recordsDir, "sa-trig-new.events"))).toBe(true); // 新 record 保留
  });
});

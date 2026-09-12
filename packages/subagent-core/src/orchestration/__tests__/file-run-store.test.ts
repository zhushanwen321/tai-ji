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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { FileRunStore } from "../file-run-store.ts";

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

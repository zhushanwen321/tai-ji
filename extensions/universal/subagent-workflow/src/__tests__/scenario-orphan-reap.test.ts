// scenario-orphan-reap.test.ts —— C04 簇合并产物（round5-F）：孤儿 run 对账
// 清理场景层（真装配维护轮 + 壳侧三代引用解析）。两个来源的 14 个 vi.mock 为
// 同目标同工厂孪生形态，合并为文件级一份；各来源原有文件级 hook 与私有 helper
// 下沉进各自唯一的顶层 describe（用例全名不变、零新增层级）。
//
// 来源文件：
//   - scenario-08-orphan-reap.test.ts（场景 8，修订设计 §4，D9 + 裁决点 7：
//     终局化移除 + 对账清理——构造孤儿 run 确认不再被自动终局化；删引用 session
//     后触发维护轮（宽限调零/不调零对照，含老 mtime 存量组））
//   - scenario-19-orphan-reap-legacy.test.ts（场景 19，裁决点 7：对账清理存量
//     形态与接管保护——v1 条目引用的存量 run；A 建 run → 删 A → B resume 接管
//     在跑 → 维护轮）
//
// 分层：core reapOrphanRuns 单测层在 subagent-core orphan-reap.test（u1b，注入
// 集合模拟引用）。本文件是场景层——经 setupSessionLifecycle 真装配触发维护轮
// （session_start 挂点），引用集走壳侧三代解析真实实现（collectAliveWorkflowRun
// References 全池 session 文件扫描——u1b deviations 登记的壳侧缺口在此补）。
// mock 栈抄自 session-lifecycle.test.ts（同款安全网）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { _resetOncePerProcessForTest } from "@zhushanwen/pi-ext-guards";
import { resolvePiWorkflowRunsDir } from "@zhushanwen/subagent-core";
import { ORPHAN_RUN_GRACE_WINDOW_MS_ENV } from "@zhushanwen/subagent-core/execution/persistence/run-state-evidence.ts";

const { mockAgentDir } = vi.hoisted(() => ({
  mockAgentDir: { current: "/home/user/.pi/agent" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockAgentDir.current,
}));
vi.mock("@zhushanwen/subagent-core/execution/worktree/worktree-manager.ts", () => ({
  WorktreeManager: class {
    scan = vi.fn(async () => {});
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));
vi.mock("@zhushanwen/subagent-core/execution/persistence/engine-journal-gc.ts", () => ({
  startEngineJournalGcTimer: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/execution/assembly/model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    reloadGlobalConfig = vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } }));
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/execution/subagent-service.ts", () => ({
  SubagentService: class {
    initSession = vi.fn();
    recoverManifestTmpFiles = vi.fn(async () => ({ deleted: 0, recovered: 0 }));
    rebuildIndexes = vi.fn(() => 0);
  },
}));
vi.mock(
  "@zhushanwen/subagent-core/execution/service/service-bootstrap.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("@zhushanwen/subagent-core/execution/service/service-bootstrap.ts")>();
    return { ...actual, getSubagentService: () => null, setSubagentService: vi.fn() };
  },
);
const { mockStoreLoadAll } = vi.hoisted(() => ({
  mockStoreLoadAll: vi.fn(async () => []),
}));
vi.mock("../jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockStoreLoadAll;
    save = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
    flushPendingSaves = vi.fn(async () => {});
  },
}));
vi.mock("../interface/tool/subagent-tool.ts", () => ({ registerSubagentTool: vi.fn() }));
vi.mock("../interface/command/subagents.ts", () => ({ registerSubagentsCommand: vi.fn() }));
vi.mock("../interface/gui/bg-notify-render.ts", () => ({ renderBgNotifyMessage: vi.fn() }));
vi.mock("../interface/tool/tool-workflow.ts", () => ({ registerWorkflowTool: vi.fn() }));
vi.mock("../interface/tool/tool-subagents.ts", () => ({ registerSubagentsTool: vi.fn() }));
vi.mock("../interface/tool/tool-workflow-script.ts", () => ({ registerWorkflowScriptTool: vi.fn() }));
vi.mock("../interface/command/commands.ts", () => ({ registerWorkflowsCommand: vi.fn() }));

import { setupSessionLifecycle } from "../session-lifecycle.ts";

// ── 簇内共享 helpers（两来源同款合一） ──

/** 最小 fake pi/ctx（session_start 装配载体）。 */
function makePi(): ExtensionAPI {
  const noop = (): void => {};
  return {
    appendEntry: noop,
    events: { emit: noop },
    on: noop,
    sendMessage: noop,
  } as unknown as ExtensionAPI;
}

function makeCtx(sessionId: string): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode: "tui",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => "/home/user/.pi/agent/sessions/x.jsonl",
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

/** 触发一轮维护轮（reset 进程级守卫 + session_start 装配）。 */
async function runMaintenanceRound(sessionId: string): Promise<void> {
  _resetOncePerProcessForTest();
  await setupSessionLifecycle(makePi(), makeCtx(sessionId), {});
}

const OLD = Date.now() - 30 * 86_400_000; // 老 mtime 存量组锚（「不采用锚 mtime」判别）

// ══════════════════════════════════════════════════════════════
// 来源：scenario-08-orphan-reap.test.ts —— 场景 8
// ══════════════════════════════════════════════════════════════

describe("场景 8：终局化移除 + 对账清理（真装配维护轮 + 壳侧三代引用解析）", () => {
  let tmpDir: string;
  let agentDir: string;
  let stateDir: string;
  let sessionsRoot: string;
  /** 夹具 sid（stateDir 的分区键——布局反转后 runs 目录按 sid 分区）。 */
  const FIXTURE_SID = "sess-fixture";
  /** 另一 sid（多目录触发面对照组的分区键）。 */
  const OTHER_SID = "sess-other";

  /** runs 目录（`<root>/<sid>/workflow/runs/`；root = beforeEach 注入的数据根）。 */
  function runsDirFor(sessionId: string): string {
    return resolvePiWorkflowRunsDir(sessionId);
  }

  /** 全件形态 run 足迹（record 流 + manifest + 旧双源两件 + 残锁；ts 可控 mtime）。 */
  function seedRunFootprint(runId: string, workflowName = "reap-flow"): void {
    fs.writeFileSync(
      path.join(stateDir, `${runId}.record.jsonl`),
      `${JSON.stringify({ type: "run-created", runId, workflowName, argsSummary: "{}", ts: 1_000 })}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(stateDir, `${runId}.json`), JSON.stringify({ outcome: "done" }), "utf8");
    fs.writeFileSync(path.join(stateDir, `${runId}.jsonl`), '{"v":"wf-run-v2","fixture":true}\n', "utf8");
    fs.writeFileSync(path.join(stateDir, `${runId}.events.jsonl`), '{"type":"run-created"}\n', "utf8");
    fs.writeFileSync(path.join(stateDir, `${runId}.resume.lock`), "{}", "utf8");
  }

  function footprintExists(runId: string): boolean {
    return fs.existsSync(path.join(stateDir, `${runId}.record.jsonl`));
  }

  /** mtime 拨到指定时刻（注入时钟下须显式对齐——与门第二臂输入）。 */
  function ageFootprint(runId: string, at: number): void {
    const t = new Date(at);
    for (const suffix of [".record.jsonl", ".json", ".jsonl", ".events.jsonl", ".resume.lock"]) {
      try {
        fs.utimesSync(path.join(stateDir, `${runId}${suffix}`), t, t);
      } catch {
        /* ENOENT 忽略 */
      }
    }
  }

  /** 存活 session 文件（slug 子目录）写入 v2 workflow-record 注册条目行。 */
  function seedSessionWithV2Reference(slug: string, sessionId: string, runId: string): string {
    const dir = path.join(sessionsRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-28T00:00:00.000Z", cwd: "/tmp" }),
        JSON.stringify({
          type: "custom",
          customType: "workflow-record",
          data: { v: 2, kind: "registered", runId, workflowName: "reap-flow", scriptName: "reap-flow", slug: "reap-flow", startedAt: 1_000, recordPath: path.join(stateDir, `${runId}.record.jsonl`) },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    return file;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-s8-reap-"));
    // [session-store-layout-inversion D2/D3] 数据根经 env 注入（生产链同形态）——
    // 维护轮的 stateDir 与 stateDirs 枚举都由它派生。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", tmpDir);
    agentDir = path.join(tmpDir, "agent");
    stateDir = runsDirFor(FIXTURE_SID);
    fs.mkdirSync(stateDir, { recursive: true });
    // 夹具布局与 pi 实装同构（锚定不改层级）：sessions 根 = <agentDir>/sessions
    // （pi config.js getSessionsDir = join(getAgentDir(), "sessions")），session 文件
    // 落其下 encoded-cwd 子目录（session-manager.js `--<cwd>--` 形态）——层级错位
    // 会让引用集扫描恒空集，场景 8 的对照组结论失真。
    sessionsRoot = path.join(agentDir, "sessions");
    expect(sessionsRoot.startsWith(agentDir)).toBe(true);
    mockAgentDir.current = agentDir;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockAgentDir.current = "/home/user/.pi/agent";
    delete process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV];
    delete process.env.TAIJI_WORKFLOW_STATE_TTL_MS;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("存活引用 run 不受影响：v2 条目引用的 run 足迹五件保留（宽限调零也不删）", async () => {
    process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
    seedRunFootprint("wf-s8-referenced");
    seedSessionWithV2Reference("proj", "sess-a", "wf-s8-referenced");
    ageFootprint("wf-s8-referenced", OLD);

    await runMaintenanceRound("sess-a-1");
    expect(footprintExists("wf-s8-referenced")).toBe(true);
  });

  it("不调零组不删（首判时刻锚定——老 mtime 存量组首轮只登记不删）", async () => {
    // 缺省 7 天宽限；run 足迹 mtime 是 30 天前（老存量形态——若锚 mtime 首轮即删，
    // 宽限保护为零，正是裁决点 7「不采用锚 mtime」要防的）
    seedRunFootprint("wf-s8-grace");
    ageFootprint("wf-s8-grace", OLD);
    // 该 run 无任何引用（孤儿）——首轮判无主、登记首判时刻
    await runMaintenanceRound("sess-grace-1");
    expect(footprintExists("wf-s8-grace")).toBe(true); // 首轮不删（宽限窗内）
    // 登记状态文件在场（首判时刻已登记）
    const registry = JSON.parse(fs.readFileSync(path.join(stateDir, "orphan-run-reap.json"), "utf8")) as Record<string, number>;
    expect(registry["wf-s8-grace"]).toBeDefined();
  });

  it("删引用 session 后 + 宽限调零 → 维护轮删五件 + 清登记（唯一磁盘清理通道）", async () => {
    process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
    seedRunFootprint("wf-s8-doomed");
    const refFile = seedSessionWithV2Reference("proj", "sess-doomed", "wf-s8-doomed");
    ageFootprint("wf-s8-doomed", OLD);

    await runMaintenanceRound("sess-doomed-1"); // 引用在：不删
    expect(footprintExists("wf-s8-doomed")).toBe(true);

    // 删引用 session（孤儿化）
    fs.rmSync(refFile);
    await runMaintenanceRound("sess-doomed-2");

    // 删三件 + 残锁 + 清登记
    for (const suffix of [".record.jsonl", ".json", ".jsonl", ".events.jsonl", ".resume.lock"]) {
      expect(fs.existsSync(path.join(stateDir, `wf-s8-doomed${suffix}`))).toBe(false);
    }
    const registry = JSON.parse(fs.readFileSync(path.join(stateDir, "orphan-run-reap.json"), "utf8")) as Record<string, number>;
    expect(registry["wf-s8-doomed"]).toBeUndefined();
  });

  it("D9 终局化移除回归钉：维护轮不写任何事件帧（无主 run 不再被自动终局化）", async () => {
    // 缺省 7 天宽限（不调零）：run 在观察期内不被删除，帧零追加可断言
    seedRunFootprint("wf-s8-noevents");
    const before = fs.readFileSync(path.join(stateDir, "wf-s8-noevents.record.jsonl"), "utf8");
    await runMaintenanceRound("sess-noev-1");
    await runMaintenanceRound("sess-noev-2");
    // run 侧帧零追加（reap 只登记/删除，不落 run-settled / run-interrupted）
    expect(fs.readFileSync(path.join(stateDir, "wf-s8-noevents.record.jsonl"), "utf8")).toBe(before);
  });

  it("多目录触发面：引用 session 已删的其他 slug 目录残留 run 同轮回收（本 session 锚定目录覆盖不回归）", async () => {
    // docError5 接线（维护轮全目录枚举 reapOrphanRuns，对齐 core pi-host-run-store
    // 枚举口径）：单目录触发面下「其他 sid 目录」的残留 run 结构性不可达——本用例
    // 构造两个 sid 目录各一个孤儿 run（宽限调零 + 老化 mtime），一轮维护后两处都被
    // 回收。
    process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
    // 目录 A：本 session 锚定目录（夹具形态 = resolvePiSessionScopedDir 回退的
    // agentDir 根）——既有覆盖不回归
    seedRunFootprint("wf-s8-local");
    ageFootprint("wf-s8-local", OLD);
    // 目录 B：其他 sid 的 runs 目录（引用 session 已删的残留形态）
    const otherStateDir = runsDirFor(OTHER_SID);
    fs.mkdirSync(otherStateDir, { recursive: true });
    const suffixes = [".record.jsonl", ".json", ".jsonl", ".events.jsonl", ".resume.lock"];
    for (const suffix of suffixes) {
      fs.writeFileSync(path.join(otherStateDir, `wf-s8-cross${suffix}`), '{"fixture":true}\n', "utf8");
    }
    const aged = new Date(OLD);
    for (const suffix of suffixes) {
      fs.utimesSync(path.join(otherStateDir, `wf-s8-cross${suffix}`), aged, aged);
    }

    await runMaintenanceRound("sess-multi-1");

    expect(footprintExists("wf-s8-local")).toBe(false);
    for (const suffix of suffixes) {
      expect(fs.existsSync(path.join(otherStateDir, `wf-s8-cross${suffix}`))).toBe(false);
    }
    // B 目录登记条目随删除清空（core 写回空对象登记文件——条目级判定，与
    // 上方「删引用 session 后」用例同口径）
    const otherRegistry = JSON.parse(
      fs.readFileSync(path.join(otherStateDir, "orphan-run-reap.json"), "utf8"),
    ) as Record<string, number>;
    expect(otherRegistry["wf-s8-cross"]).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 来源：scenario-19-orphan-reap-legacy.test.ts —— 场景 19
// ══════════════════════════════════════════════════════════════

describe("场景 19：对账清理存量形态与接管保护", () => {
  /** 夹具 sid（stateDir 的分区键——布局反转后 runs 目录按 sid 分区）。 */
  const FIXTURE_SID = "sess-fixture";

  let tmpDir: string;
  let agentDir: string;
  let stateDir: string;
  let sessionsRoot: string;

  /** 旧双源形态存量 run 足迹（无 record 流——[D1] 前写入方产物）。 */
  function seedLegacyFootprint(runId: string): void {
    fs.writeFileSync(path.join(stateDir, `${runId}.jsonl`), '{"v":"wf-run-v1","fixture":true}\n', "utf8");
    fs.writeFileSync(path.join(stateDir, `${runId}.events.jsonl`), '{"type":"run-created"}\n', "utf8");
  }

  function seedRecordFootprint(runId: string): void {
    fs.writeFileSync(
      path.join(stateDir, `${runId}.record.jsonl`),
      `${JSON.stringify({ type: "run-created", runId, workflowName: "legacy-flow", argsSummary: "{}", ts: 1_000 })}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(stateDir, `${runId}.json`), JSON.stringify({ outcome: "done" }), "utf8");
  }

  function legacyExists(runId: string): boolean {
    return fs.existsSync(path.join(stateDir, `${runId}.jsonl`)) && fs.existsSync(path.join(stateDir, `${runId}.events.jsonl`));
  }

  function ageRun(runId: string, at: number): void {
    const t = new Date(at);
    for (const suffix of [".record.jsonl", ".json", ".jsonl", ".events.jsonl", ".resume.lock"]) {
      try {
        fs.utimesSync(path.join(stateDir, `${runId}${suffix}`), t, t);
      } catch {
        /* ENOENT 忽略 */
      }
    }
  }

  /** session 文件写入条目行（v1 快照条目 / v2 注册条目两形态）。 */
  function seedSessionEntry(slug: string, sessionId: string, entryLine: Record<string, unknown>): string {
    const dir = path.join(sessionsRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-28T00:00:00.000Z", cwd: "/tmp" }),
        JSON.stringify(entryLine),
      ].join("\n") + "\n",
      "utf8",
    );
    return file;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-s19-legacy-"));
    // [session-store-layout-inversion D2/D3] 数据根经 env 注入（生产链同形态）——维护轮
    // 的 stateDir 与 stateDirs 枚举都由它派生。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", tmpDir);
    agentDir = path.join(tmpDir, "agent");
    stateDir = resolvePiWorkflowRunsDir(FIXTURE_SID);
    fs.mkdirSync(stateDir, { recursive: true });
    // 夹具布局与 pi 实装同构（对齐 U5 修复后采集路径）：sessions 根 = <agentDir>/sessions
    // （pi config.js getSessionsDir = join(getAgentDir(), "sessions")），session 文件
    // 在 encoded-cwd 子目录下——旧写法（tmpDir/sessions）与生产采集目录不同树，
    // 引用集恒空 → 存量 run 被误判无主删除，本场景「不删」断言全红。
    sessionsRoot = path.join(agentDir, "sessions");
    expect(sessionsRoot.startsWith(agentDir)).toBe(true);
    mockAgentDir.current = agentDir;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockAgentDir.current = "/home/user/.pi/agent";
    delete process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("v1 快照条目引用的存量 run（旧双源文件形态、无 record 流）：三代引用识别，不删", async () => {
    process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
    seedLegacyFootprint("wf-s19-v1");
    ageRun("wf-s19-v1", OLD);
    // v1 快照条目行（data.v === 1 + snapshot.runId——只认 v2 会误判无主并不可逆删除）
    seedSessionEntry("legacy", "sess-v1", {
      type: "custom",
      customType: "workflow-record",
      data: { v: 1, snapshot: { runId: "wf-s19-v1", status: "running" } },
    });

    await runMaintenanceRound("sess-v1-round");
    expect(legacyExists("wf-s19-v1")).toBe(true);
  });

  it("A 建 run → 删 A → B resume 接管（v2 条目已补）→ 维护轮：三件不删（接管已补注册）", async () => {
    process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
    seedRecordFootprint("wf-s19-takeover");
    ageRun("wf-s19-takeover", OLD);

    // A 的注册条目（建 run 时落 A 的 session 文件）
    const refA = seedSessionEntry("proj", "sess-a", {
      type: "custom",
      customType: "workflow-record",
      data: { v: 2, kind: "registered", runId: "wf-s19-takeover", workflowName: "legacy-flow", scriptName: "legacy-flow", startedAt: 1_000, recordPath: path.join(stateDir, "wf-s19-takeover.record.jsonl") },
    });

    // 删 A（session 文件删除）
    fs.rmSync(refA);

    // B resume 接管：锁段内先于复活事件补写 v2 条目（落 B 的 session 文件——
    // pi appendEntry 的落盘产物形态；接管编排本体见场景 1/12）
    seedSessionEntry("proj", "sess-b", {
      type: "custom",
      customType: "workflow-record",
      data: { v: 2, kind: "registered", runId: "wf-s19-takeover", workflowName: "legacy-flow", scriptName: "legacy-flow", startedAt: 1_000, recordPath: path.join(stateDir, "wf-s19-takeover.record.jsonl") },
    });

    await runMaintenanceRound("sess-b-round");
    // 三件不删（B 的接管引用保护）
    expect(fs.existsSync(path.join(stateDir, "wf-s19-takeover.record.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "wf-s19-takeover.json"))).toBe(true);
  });

  it("pre-W17 link 指针条目引用的 run：三代引用识别的第三档，宽限调零维护轮后五件不删", async () => {
    process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
    seedRecordFootprint("wf-s19-link");
    fs.writeFileSync(path.join(stateDir, "wf-s19-link.jsonl"), '{"v":"wf-run-v1","fixture":true}\n', "utf8");
    fs.writeFileSync(path.join(stateDir, "wf-s19-link.events.jsonl"), '{"type":"run-created"}\n', "utf8");
    fs.writeFileSync(path.join(stateDir, "wf-s19-link.resume.lock"), "{}", "utf8");
    ageRun("wf-s19-link", OLD);
    // pre-W17 指针形态：workflow-state-link custom entry → data.runId
    seedSessionEntry("legacy", "sess-link", {
      type: "custom",
      customType: "workflow-state-link",
      data: { runId: "wf-s19-link", path: path.join(stateDir, "wf-s19-link.jsonl") },
    });

    await runMaintenanceRound("sess-link-round");
    // 五件全在（record 流 + manifest + 旧双源 + 残锁——link 引用命中保护）
    for (const suffix of [".record.jsonl", ".json", ".jsonl", ".events.jsonl", ".resume.lock"]) {
      expect(fs.existsSync(path.join(stateDir, `wf-s19-link${suffix}`))).toBe(true);
    }
  });

  // 真实采集器经读错分通道上抛（root 进程 chmod 不生效，跳过）
  it.skipIf(process.getuid?.() === 0)(
    "sessions 根真 IO 故障（EACCES）→ 采集失败整轮跳过：无引用 run 不删、无登记写达（core 宁保留防御经真实采集器可达）",
    async () => {
      process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV] = "0";
      seedRecordFootprint("wf-s19-iofail");
      ageRun("wf-s19-iofail", OLD);
      // 存活 session 在场（chmod 前 seed，证明「跳过」不是空集的正常路径）
      seedSessionEntry("proj", "sess-io", {
        type: "custom",
        customType: "workflow-record",
        data: { v: 2, kind: "registered", runId: "wf-s19-io", workflowName: "legacy-flow", scriptName: "legacy-flow", startedAt: 1_000, recordPath: path.join(stateDir, "wf-s19-io.record.jsonl") },
      });
      fs.chmodSync(sessionsRoot, 0o000);

      try {
        await runMaintenanceRound("sess-io-round");
      } finally {
        fs.chmodSync(sessionsRoot, 0o755);
      }
      // 采集失败 = 引用状态不可知 → 整轮跳过：候选 run 五件不删 + 无登记写达
      expect(fs.existsSync(path.join(stateDir, "wf-s19-iofail.record.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "orphan-run-reap.json"))).toBe(false);
    },
  );
});

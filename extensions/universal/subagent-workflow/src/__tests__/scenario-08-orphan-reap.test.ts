// src/__tests__/scenario-08-orphan-reap.test.ts
//
// 场景 8（修订设计 §4，D9 + 裁决点 7）：终局化移除 + 对账清理。
// 构造孤儿 run 确认不再被自动终局化；删引用 session 后触发维护轮
// （宽限调零/不调零对照，含老 mtime 存量组）。
//
// 通过标准（原文）：不调零组不删（首判时刻锚定）；调零组删三件+残锁+登记；
// 存活引用 run 不受影响。
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
import { resolvePiSessionScopedDir, STATE_DIR_NAME } from "@zhushanwen/subagent-core";
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
vi.mock("@zhushanwen/subagent-core/execution/persistence/session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
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
vi.mock("../interface/subagent-tool.ts", () => ({ registerSubagentTool: vi.fn() }));
vi.mock("../interface/subagents.ts", () => ({ registerSubagentsCommand: vi.fn() }));
vi.mock("../interface/bg-notify-render.ts", () => ({ renderBgNotifyMessage: vi.fn() }));
vi.mock("../interface/tool-workflow.ts", () => ({ registerWorkflowTool: vi.fn() }));
vi.mock("../interface/tool-subagents.ts", () => ({ registerSubagentsTool: vi.fn() }));
vi.mock("../interface/tool-workflow-script.ts", () => ({ registerWorkflowScriptTool: vi.fn() }));
vi.mock("../interface/commands.ts", () => ({ registerWorkflowsCommand: vi.fn() }));

import { setupSessionLifecycle } from "../session-lifecycle.ts";

// ── 场景夹具 ────────────────────────────────────────────────────────────────

let tmpDir: string;
let agentDir: string;
let stateDir: string;
let sessionsRoot: string;

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
        data: { v: 2, kind: "registered", runId, workflowName: "reap-flow", scriptName: "reap-flow", slug: "reap-flow", startedAt: 1_000, journalPath: path.join(stateDir, `${runId}.record.jsonl`) },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return file;
}

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-s8-reap-"));
  agentDir = path.join(tmpDir, "agent");
  stateDir = path.join(resolvePiSessionScopedDir({ agentDir }), STATE_DIR_NAME);
  fs.mkdirSync(stateDir, { recursive: true });
  sessionsRoot = path.join(tmpDir, "sessions");
  mockAgentDir.current = agentDir;
});

afterEach(() => {
  mockAgentDir.current = "/home/user/.pi/agent";
  delete process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV];
  delete process.env.TAIJI_WORKFLOW_STATE_TTL_MS;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("场景 8：终局化移除 + 对账清理（真装配维护轮 + 壳侧三代引用解析）", () => {
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
});

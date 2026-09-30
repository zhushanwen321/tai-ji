// src/__tests__/scenario-19-orphan-reap-legacy.test.ts
//
// 场景 19（修订设计 §4，裁决点 7）：对账清理存量形态与接管保护。
// v1 条目引用的存量 run；A 建 run → 删 A → B resume 接管在跑 → 维护轮。
//
// 通过标准（原文）：两类 run 三件都不删（三代引用识别；接管已补注册）。
//
// 分层：core 层在 orphan-reap.test（u1b）。本文件是场景层——三代解析走壳侧
// 真实实现（v1 快照条目行落在磁盘 session 文件——collectAliveWorkflowRun
// References 的 v1 分支）；「B resume 接管补注册」段以 v2 条目行的落盘形态
// 模拟（pi appendEntry 的落盘产物；接管编排本体在场景 1/12 覆盖）。
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
vi.mock("../interface/tool/subagent-tool.ts", () => ({ registerSubagentTool: vi.fn() }));
vi.mock("../interface/command/subagents.ts", () => ({ registerSubagentsCommand: vi.fn() }));
vi.mock("../interface/gui/bg-notify-render.ts", () => ({ renderBgNotifyMessage: vi.fn() }));
vi.mock("../interface/tool/tool-workflow.ts", () => ({ registerWorkflowTool: vi.fn() }));
vi.mock("../interface/tool/tool-subagents.ts", () => ({ registerSubagentsTool: vi.fn() }));
vi.mock("../interface/tool/tool-workflow-script.ts", () => ({ registerWorkflowScriptTool: vi.fn() }));
vi.mock("../interface/command/commands.ts", () => ({ registerWorkflowsCommand: vi.fn() }));

import { setupSessionLifecycle } from "../session-lifecycle.ts";

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

function makePi(): ExtensionAPI {
  const noop = (): void => {};
  return { appendEntry: noop, events: { emit: noop }, on: noop, sendMessage: noop } as unknown as ExtensionAPI;
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

async function runMaintenanceRound(sessionId: string): Promise<void> {
  _resetOncePerProcessForTest();
  await setupSessionLifecycle(makePi(), makeCtx(sessionId), {});
}

const OLD = Date.now() - 30 * 86_400_000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-s19-legacy-"));
  agentDir = path.join(tmpDir, "agent");
  stateDir = path.join(resolvePiSessionScopedDir({ agentDir }), STATE_DIR_NAME);
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
  mockAgentDir.current = "/home/user/.pi/agent";
  delete process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV];
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("场景 19：对账清理存量形态与接管保护", () => {
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

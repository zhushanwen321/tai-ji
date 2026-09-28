// pi-host-run-store 回归锁：枚举读侧目录由调用方注入的 agentDir 活源驱动，
// 不从进程 env/cwd/sessionFile 推测（两条推导路径均曾在 W2 D3 真机链实证
// 错位致恒空转，见被测模块头注）。
// 覆盖面（ADR-0081 / §4.1 场景 3、5）：
// 1. 枚举目录形态（agentDir 活源 + 全 session 目录 + 回退根）；
// 2. 终态返回形态 { runId, stateDir, status }（stateDir = 收编链 journalDir 注入源）；
// 3. runtime 形态：journalDir 参数显式传入时收编链（adoptInterruptedRun）读写
//    正确落位——调用进程 cwd 与落盘目录不相交，显式参数优先于模块锚；
// 4. 读错分通道：EACCES 上抛（枚举 + FileRunStore.loadAll）、ENOENT 仍空集。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileRunStore } from "../../orchestration/file-run-store.ts";
import { createRunEventJournal, type WorkflowRunEventInput } from "../../orchestration/run-events.ts";
import { adoptInterruptedRun } from "../../orchestration/run-registry.ts";
import { setRunEventJournalDirForTest } from "../../orchestration/worker-message-pump.ts";
import { readRunTerminalManifest } from "../../execution/persistence/manifest-store.ts";
import { createPiHostRunEnumeration } from "../assembly/pi-host-run-store.ts";

/** toRunSnapshot 最小合法行（fromRunSnapshot 可重水合；字段集与 W2 验收
 * synth 剧本同源——budget 六字段缺一会被形状校验拒绝）。 */
function snapshotLine(runId: string, startedAtIso: string): string {
  return `${JSON.stringify({
    v: "wf-run-v2",
    runId,
    spec: {
      scriptSource: "// fixture\n",
      args: {},
      scriptName: "fixture",
      scriptPath: "/tmp/fixture.js",
      description: "pi-host-run-store fixture",
    },
    state: {
      status: "running",
      budget: { maxTokens: 0, maxCost: 0, maxTimeMs: 0, usedTokens: 0, usedCost: 0, totalCallCount: 0 },
      calls: [],
      trace: [],
      errorLogs: [],
    },
    meta: { startedAt: startedAtIso },
  })}\n`;
}

describe("createPiHostRunEnumeration", () => {
  let agentRoot: string;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-"));
    // pi 壳布局：<agentRoot>/sessions/<slug>/workflow-state/ + <agentRoot>/workflow-state（回退根）
    const slugADir = join(agentRoot, "sessions", "--fixture-slug-a--");
    const slugBDir = join(agentRoot, "sessions", "--fixture-slug-b--");
    const wsA = join(slugADir, "workflow-state");
    const wsB = join(slugBDir, "workflow-state");
    const wsRoot = join(agentRoot, "workflow-state");
    for (const dir of [wsA, wsB, wsRoot]) mkdirSync(dir, { recursive: true });
    const iso = new Date().toISOString();
    // same-session 目录 / cross-session 目录 / agentDir 回退根各一个 run
    writeFileSync(join(wsA, "wf-a.jsonl"), snapshotLine("wf-a", iso));
    writeFileSync(join(wsB, "wf-b.jsonl"), snapshotLine("wf-b", iso));
    writeFileSync(join(wsRoot, "wf-c.jsonl"), snapshotLine("wf-c", iso));
    // journal 附属文件（.events.jsonl）不得进快照结果
    writeFileSync(join(wsA, "wf-a.events.jsonl"), '{"type":"run-created"}\n');
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("枚举全部 session 目录 + agentDir 回退根（same/cross-session 两形态一次覆盖）", async () => {
    const store = createPiHostRunEnumeration(() => agentRoot);
    const runs = await store.loadAll();
    expect(runs.map((r) => r.runId).sort()).toEqual(["wf-a", "wf-b", "wf-c"]);
    const byId = new Map(runs.map((r) => [r.runId, r]));
    for (const run of runs) {
      expect(run.status).toBe("running");
    }
    // 终态返回形态：stateDir = 该 run 的 workflow-state 目录（收编链 journalDir 注入源）
    expect(byId.get("wf-a")?.stateDir).toBe(join(agentRoot, "sessions", "--fixture-slug-a--", "workflow-state"));
    expect(byId.get("wf-b")?.stateDir).toBe(join(agentRoot, "sessions", "--fixture-slug-b--", "workflow-state"));
    expect(byId.get("wf-c")?.stateDir).toBe(join(agentRoot, "workflow-state"));
  });

  it("journal 附属文件（.events.jsonl）不进快照枚举结果", async () => {
    const store = createPiHostRunEnumeration(() => agentRoot);
    const runs = await store.loadAll();
    expect(runs.some((r) => r.runId.includes("events"))).toBe(false);
    expect(runs).toHaveLength(3);
  });

  it("进程 env 漂移不影响枚举目录（注入活源优先于 PI_CODING_AGENT_DIR）", async () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(agentRoot, "not-the-real-agent-dir");
    try {
      const store = createPiHostRunEnumeration(() => agentRoot);
      const runs = await store.loadAll();
      expect(runs.map((r) => r.runId).sort()).toEqual(["wf-a", "wf-b", "wf-c"]);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  it("sessions 根不存在时仅扫 agentDir 回退根（从未落盘的空态降级不抛）", async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-bare-"));
    try {
      const wsRoot = join(bareRoot, "workflow-state");
      mkdirSync(wsRoot, { recursive: true });
      writeFileSync(join(wsRoot, "wf-bare.jsonl"), snapshotLine("wf-bare", new Date().toISOString()));
      const store = createPiHostRunEnumeration(() => bareRoot);
      const runs = await store.loadAll();
      expect(runs.map((r) => r.runId)).toEqual(["wf-bare"]);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── runtime 形态（决策 2 目录参数化）────────────────────────
//
// 构造「调用进程 cwd 与落盘目录不相交」：落盘目录 = mkdtemp 显式路径，vitest
// 进程 cwd = 包目录——不注入模块锚时收编链的缺省解析在 vitest 下是 no-op
// 防线（零写），显式 journalDir 参数必须把 scan / 帧落账 / manifest 三面全部
// 路由到参数目录。

describe("runtime 形态：journalDir 参数显式传入时收编链读写正确落位", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = mkdtempSync(join(tmpdir(), "pi-host-run-store-runtime-"));
  });

  afterEach(() => {
    // 复位模块锚 + 清活体态/终局记录注册表/keyed journal 缓存（pump teardown 纪律）
    setRunEventJournalDirForTest(undefined);
    rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 落 running 形态事件流（run-created + ask-dispatched → fold = running）。 */
  async function seedRunning(runId: string): Promise<void> {
    const journal = createRunEventJournal(journalDir);
    const events: WorkflowRunEventInput[] = [
      { type: "run-created", runId, workflowName: "fixture-flow", argsSummary: "{}", ts: Date.now() },
      { type: "ask-dispatched", taskIndex: 1, agentName: "worker", attempt: 1, ts: Date.now() },
    ];
    for (const event of events) {
      await journal.append(runId, event);
    }
  }

  it("模块锚未注入时显式 journalDir 收编：run-settled 帧与 manifest 全落在参数目录", async () => {
    const runId = "wf-rt-direct";
    await seedRunning(runId);

    const outcome = await adoptInterruptedRun(runId, { journalDir });
    expect(outcome).toBe("adopted");

    // journal 半边：run-settled(interrupted) 帧落参数目录
    const events = await createRunEventJournal(journalDir).scan(runId);
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled?.type).toBe("run-settled");
    expect(settled?.outcome).toBe("interrupted");
    // manifest 半边：物化在参数目录（两件直落）
    const manifest = await readRunTerminalManifest(journalDir, runId);
    expect(manifest?.outcome).toBe("interrupted");
  });

  it("显式 journalDir 优先于模块锚（setRunEventJournalDirForTest 指向他目录时收编仍落参数目录）", async () => {
    const anchorDir = mkdtempSync(join(tmpdir(), "pi-host-run-store-anchor-"));
    try {
      setRunEventJournalDirForTest(anchorDir);
      const runId = "wf-rt-param-wins";
      await seedRunning(runId);

      const outcome = await adoptInterruptedRun(runId, { journalDir });
      expect(outcome).toBe("adopted");

      // 落点 = 参数目录（journal 帧 + manifest 两面）
      const events = await createRunEventJournal(journalDir).scan(runId);
      expect(events.some((e) => e.type === "run-settled")).toBe(true);
      expect((await readRunTerminalManifest(journalDir, runId))?.outcome).toBe("interrupted");
      // 模块锚目录零写入（per-call 参数不被模块锚劫持）
      expect(await createRunEventJournal(anchorDir).scan(runId)).toHaveLength(0);
    } finally {
      setRunEventJournalDirForTest(undefined);
      rmSync(anchorDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── 读错分通道（§3.1 规格 2 末段）────────────────────────────

describe("枚举读错分通道：EACCES 上抛 / ENOENT 仍空集", () => {
  /** root 进程不受权限位约束，EACCES 场景构造不出来（环境限制非语义缺口）；
   *  跳过惯用法与 record-store-index.test.ts 的 chmodProbeIt 同款。 */
  const chmodProbeIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

  chmodProbeIt("sessions 根 EACCES：枚举 loadAll 上抛而非空数组", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-eacces-"));
    try {
      const sessionsRoot = join(root, "sessions");
      mkdirSync(join(sessionsRoot, "slug"), { recursive: true });
      chmodSync(sessionsRoot, 0o000);
      const store = createPiHostRunEnumeration(() => root);
      await expect(store.loadAll()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(join(root, "sessions"), 0o755);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  chmodProbeIt("state 目录 EACCES：FileRunStore.loadAll 上抛而非空数组", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-eacces-"));
    try {
      const stateDir = join(root, "workflow-state");
      mkdirSync(stateDir, { recursive: true });
      chmodSync(stateDir, 0o000);
      const store = new FileRunStore({ stateDir });
      await expect(store.loadAll()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(join(root, "workflow-state"), 0o755);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("目录缺失（ENOENT）仍空集：FileRunStore 与枚举均不抛", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-empty-"));
    try {
      // 空树：无 sessions / 无 workflow-state
      const store = createPiHostRunEnumeration(() => root);
      expect(await store.loadAll()).toEqual([]);
      expect(
        await new FileRunStore({ stateDir: join(root, "missing-workflow-state") }).loadAll(),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

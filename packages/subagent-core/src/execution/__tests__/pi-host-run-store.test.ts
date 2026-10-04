// pi-host-run-store 回归锁：枚举读侧目录由调用方注入的 agentDir 活源驱动，
// 不从进程 env/cwd/sessionFile 推测（两条推导路径均曾在 W2 D3 真机链实证
// 错位致恒空转，见被测模块头注）。
// 覆盖面（ADR-0081 / §4.1 场景 3、5；workflow-run-store-convergence U2 枚举改接）：
// 1. 枚举目录形态（agentDir 活源 + 全 session 目录 + 回退根）；
// 2. 终态返回形态 { runId, stateDir, status }（stateDir = 收编链 journalDir 注入源；
//    status = 判定核三态映射——running/终态词/missing 跳过）；
// 3. 候选来源 = record 事件流文件族（journal 在即候选在——快照在或不在均无关，
//    走查必修缺口的回归锚）；
// 4. runtime 形态：journalDir 参数显式传入时收编链（adoptInterruptedRun）读写
//    正确落位——调用进程 cwd 与落盘目录不相交，显式参数优先于模块锚；
// 5. 读错分通道：候选目录层 EACCES 上抛（枚举自身扫描）、ENOENT 仍空集；单 run
//    判定层走判定核保守矩阵（枚举层不二次处置）；
// 6. v1 旧形态目录（[D16⑥]）：旧双源文件（.events.jsonl / .jsonl）不进候选
//    （构造性跳过）+ 聚合 warn 留痕（core logger 通道）。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogLevel } from "../../core/logger.ts";
import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";

import { RUN_EVENTS_SUFFIX } from "../../shared/run-vocabulary.ts";
import { createRunEventJournal, type WorkflowRunEventInput } from "../../orchestration/run-events.ts";
import { adoptInterruptedRun } from "../../orchestration/run-registry.ts";
import {
  setRunEventJournalDirForTest,
} from "../../orchestration/terminal-actions.ts";
import { readRunTerminalManifest } from "../../execution/persistence/manifest-store.ts";
import { createPiHostRunEnumeration } from "../assembly/pi-host-run-store.ts";

/** 落 running 形态 record 流（run-created + agent-started 两帧——fold = running，
 *  无 run-settled 帧）。枚举候选 = 本写入方落出的 <runId>.record.jsonl 文件族。 */
async function seedRunningJournal(stateDir: string, runId: string): Promise<void> {
  const journal = createRunEventJournal(stateDir);
  const events: WorkflowRunEventInput[] = [
    { type: "run-created", runId, workflowName: "fixture-flow", argsSummary: "{}", ts: Date.now() },
    { type: "agent-started", taskIndex: 1, agentName: "worker", attempt: 1, ts: Date.now() },
  ];
  for (const event of events) await journal.append(runId, event);
}

describe("createPiHostRunEnumeration", () => {
  let agentRoot: string;
  let wsA: string;
  let wsB: string;
  let wsRoot: string;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-"));
    // pi 壳布局：<agentRoot>/sessions/<slug>/workflow-state/ + <agentRoot>/workflow-state（回退根）
    const slugADir = join(agentRoot, "sessions", "--fixture-slug-a--");
    const slugBDir = join(agentRoot, "sessions", "--fixture-slug-b--");
    wsA = join(slugADir, "workflow-state");
    wsB = join(slugBDir, "workflow-state");
    wsRoot = join(agentRoot, "workflow-state");
    for (const dir of [wsA, wsB, wsRoot]) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("枚举全部 session 目录 + agentDir 回退根（same/cross-session 两形态一次覆盖）", async () => {
    // same-session 目录 / cross-session 目录 / agentDir 回退根各一个 run
    //（seed 直接落 record 流——U2 改接后枚举候选与 status 判定都只认 journal）。
    await seedRunningJournal(wsA, "wf-a");
    await seedRunningJournal(wsB, "wf-b");
    await seedRunningJournal(wsRoot, "wf-c");
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

  it("快照行文件（.jsonl）与 terminal manifest（.json）不进 journal 枚举结果", async () => {
    await seedRunningJournal(wsA, "wf-a");
    // 同名快照 + manifest、与快照-only run（快照在而 journal 不在——U2 改接后
    // 不再是候选：反方向完备性，设计 §3.1 步骤 2）都不是枚举来源
    writeFileSync(join(wsA, "wf-a.jsonl"), '{"v":"wf-run-v2","fixture":true}\n');
    writeFileSync(join(wsA, "wf-a.json"), '{"outcome":"completed"}\n');
    writeFileSync(join(wsRoot, "wf-snap-only.jsonl"), '{"v":"wf-run-v2","fixture":true}\n');
    const runs = await createPiHostRunEnumeration(() => agentRoot).loadAll();
    expect(runs.map((r) => r.runId)).toEqual(["wf-a"]);
  });

  it("journal 在而快照不在 → 候选在（候选不依赖快照存在性——走查必修缺口回归锚）", async () => {
    await seedRunningJournal(wsA, "wf-no-snap");
    // 该 run 无 <runId>.jsonl 快照、无 <runId>.json manifest——纯 journal 形态
    const runs = await createPiHostRunEnumeration(() => agentRoot).loadAll();
    expect(runs.map((r) => r.runId)).toEqual(["wf-no-snap"]);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.stateDir).toBe(wsA);
  });

  it("进程 env 漂移不影响枚举目录（注入活源优先于 PI_CODING_AGENT_DIR）", async () => {
    await seedRunningJournal(wsA, "wf-a");
    await seedRunningJournal(wsB, "wf-b");
    await seedRunningJournal(wsRoot, "wf-c");
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
      const bareWsRoot = join(bareRoot, "workflow-state");
      mkdirSync(bareWsRoot, { recursive: true });
      await seedRunningJournal(bareWsRoot, "wf-bare");
      const store = createPiHostRunEnumeration(() => bareRoot);
      const runs = await store.loadAll();
      expect(runs.map((r) => r.runId)).toEqual(["wf-bare"]);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── 判定核三态 → status 映射（U2 改接：status 从事实源推导）──────

describe("createPiHostRunEnumeration status 映射（判定核三态）", () => {
  let agentRoot: string;
  let wsA: string;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-map-"));
    wsA = join(agentRoot, "sessions", "--fixture-slug--", "workflow-state");
    mkdirSync(wsA, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("running（journal 无 run-settled 帧）→ \"running\"", async () => {
    await seedRunningJournal(wsA, "wf-live");
    const runs = await createPiHostRunEnumeration(() => agentRoot).loadAll();
    expect(runs).toEqual([{ runId: "wf-live", stateDir: wsA, status: "running" }]);
  });

  it("terminal（journal run-settled 帧在盘）→ 对应终态词", async () => {
    await seedRunningJournal(wsA, "wf-done");
    const journal = createRunEventJournal(wsA);
    await journal.append("wf-done", {
      type: "run-settled",
      outcome: "done",
      artifactsDir: wsA,
      ts: Date.now(),
    });
    const runs = await createPiHostRunEnumeration(() => agentRoot).loadAll();
    expect(runs).toEqual([{ runId: "wf-done", stateDir: wsA, status: "completed" }]);
  });

  it("terminal via manifest（journal 无终局帧 + 历史词表外 outcome=interrupted manifest 在盘）→ status 折叠 \"failed\" 恒 string（判定核单点防御——枚举 status 契约不漏 undefined）", async () => {
    await seedRunningJournal(wsA, "wf-legacy-manifest");
    // [D2] 前旧收编链物化的历史 manifest（文件名未随 [D1] 迁移故磁盘可达）：
    // 词表外 outcome 经 findRunSettlementEvidence 的 as 强转读入，派生函数
    // default 分支折叠 "failed"（W2 D5 诊断兜底容器先例）
    writeFileSync(
      join(wsA, "wf-legacy-manifest.json"),
      JSON.stringify({ outcome: "interrupted", errorCode: "idle-evicted" }),
      "utf8",
    );
    const runs = await createPiHostRunEnumeration(() => agentRoot).loadAll();
    expect(runs).toEqual([{ runId: "wf-legacy-manifest", stateDir: wsA, status: "failed" }]);
  });

  it("missing（竞态窗口：候选列举后 journal 被删）→ 候选跳过不入结果", async () => {
    await seedRunningJournal(wsA, "wf-race");
    const wsB = join(agentRoot, "sessions", "--other-slug--", "workflow-state");
    mkdirSync(wsB, { recursive: true });
    await seedRunningJournal(wsB, "wf-keep");
    const target = join(wsA, `wf-race${RUN_EVENTS_SUFFIX}`);
    // 竞态窗口模拟：候选目录 readdir 返回之后、判定核读文件之前 journal 被删
    //（枚举路径 missing 的唯一可达形态——被测模块头注）。按 path 分流拦截
    // wsA 的候选列举，其余 readdir 调用透传真实现。
    const actualReaddir = fsPromises.readdir.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "readdir");
    spy.mockImplementation((async (path: string, options?: { withFileTypes: boolean }) => {
      // 类型修复（u1a 词表批附带）：readdir 重载收窄——mock 分流只覆盖字符串路径 +
      // 可选 withFileTypes 形态，真实现透传时按 BufferEncoding 重载解析（cast 收窄）。
      const entries: unknown = options?.withFileTypes
        ? await actualReaddir(path, { withFileTypes: true })
        : await actualReaddir(path);
      if (path === wsA) rmSync(target);
      return entries as Dirent[];
    }) as typeof fsPromises.readdir);
    try {
      const runs = await createPiHostRunEnumeration(() => agentRoot).loadAll();
      expect(runs.map((r) => r.runId)).toEqual(["wf-keep"]);
    } finally {
      spy.mockRestore();
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

  /** 落 running 形态事件流（run-created + agent-started → fold = running）。 */
  async function seedRunning(runId: string): Promise<void> {
    await seedRunningJournal(journalDir, runId);
  }

  it("模块锚未注入时显式 journalDir 收编：run-interrupted 帧落参数目录 + manifest 不物化", async () => {
    const runId = "wf-rt-direct";
    await seedRunning(runId);

    const outcome = await adoptInterruptedRun(runId, { journalDir });
    expect(outcome).toBe("adopted");

    // journal 半边：run-interrupted 转移帧落参数目录（[D15] 中断编排入口——
    // interrupted 是暂停态非终局，收编产物 = 中断帧一件直落）
    const events = await createRunEventJournal(journalDir).scan(runId);
    const interrupted = events.find((e) => e.type === "run-interrupted");
    expect(interrupted?.type).toBe("run-interrupted");
    // manifest 半边：不物化（interrupted 非终局——manifest-write 仅 terminal 输出）
    expect(await readRunTerminalManifest(journalDir, runId)).toBeNull();
  });

  it("显式 journalDir 优先于模块锚（setRunEventJournalDirForTest 指向他目录时收编仍落参数目录）", async () => {
    const anchorDir = mkdtempSync(join(tmpdir(), "pi-host-run-store-anchor-"));
    try {
      setRunEventJournalDirForTest(anchorDir);
      const runId = "wf-rt-param-wins";
      await seedRunning(runId);

      const outcome = await adoptInterruptedRun(runId, { journalDir });
      expect(outcome).toBe("adopted");

      // 落点 = 参数目录（journal 中断帧）
      const events = await createRunEventJournal(journalDir).scan(runId);
      expect(events.some((e) => e.type === "run-interrupted")).toBe(true);
      // 模块锚目录零写入（per-call 参数不被模块锚劫持）
      expect(await createRunEventJournal(anchorDir).scan(runId)).toHaveLength(0);
    } finally {
      setRunEventJournalDirForTest(undefined);
      rmSync(anchorDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── 读错分通道（§3.1 规格 2 末段；U2 改接后候选目录扫描归枚举自身）──

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

  chmodProbeIt("state 目录 EACCES：枚举 loadAll 上抛而非空数组（候选目录扫描层分通道）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-eacces-"));
    try {
      const stateDir = join(root, "workflow-state");
      mkdirSync(stateDir, { recursive: true });
      chmodSync(stateDir, 0o000);
      const store = createPiHostRunEnumeration(() => root);
      await expect(store.loadAll()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(join(root, "workflow-state"), 0o755);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("目录缺失（ENOENT）仍空集：sessions 根与 state 目录均不抛", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-empty-"));
    try {
      // 空树：无 sessions / 无 workflow-state
      const store = createPiHostRunEnumeration(() => root);
      expect(await store.loadAll()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── v1 旧形态目录（[D16⑥] 检查点 8 三形态之一）────────────────────
//
// 旧双源文件（.events.jsonl 旧 journal + .jsonl 旧快照）形态：不进候选
//（候选 = .record.jsonl 文件族，构造性跳过——[D1] 历史数据不读不写不主动删）、
// 不抛错、每目录聚合一条 warn（core logger 通道——模块无注入日志面，与判定核
// 读错 warn 同通道）。历史 run 随裁决点 7 对账清理消亡，不在本枚举射程。

describe("v1 旧形态目录：构造性跳过 + warn 留痕（[D16⑥]）", () => {
  let logSpy: ReturnType<
    typeof vi.fn<(level: LogLevel, component: string, message: string, data?: unknown) => void>
  >;

  beforeEach(() => {
    resetCoreForTests();
    logSpy = vi.fn((_level: LogLevel, _component: string, _message: string, _data?: unknown) => {});
    configureCore({
      dataRoot: () => tmpdir(),
      log: logSpy,
    } satisfies HostServices);
  });

  afterEach(() => {
    resetCoreForTests();
  });

  it("只有旧双源文件（.events.jsonl + .jsonl）→ 枚举空集 + 每目录一条聚合 warn", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-v1-"));
    try {
      const wsA = join(root, "sessions", "--v1-slug--", "workflow-state");
      mkdirSync(wsA, { recursive: true });
      writeFileSync(join(wsA, "wf-v1-a.events.jsonl"), '{"type":"run-created"}\n');
      writeFileSync(join(wsA, "wf-v1-a.jsonl"), '{"v":"wf-run-v1"}\n');
      // 旧快照 only（无任何 journal）形态同跳过——无事件流无从收编
      writeFileSync(join(wsA, "wf-v1-snap-only.jsonl"), '{"v":"wf-run-v1"}\n');

      const runs = await createPiHostRunEnumeration(() => root).loadAll();

      expect(runs).toEqual([]);
      const warns = logSpy.mock.calls.filter((c) => c[0] === "warn").map((c) => String(c[2]));
      expect(warns).toHaveLength(1); // 每目录聚合一条（两个旧 journal 文件并一条）
      expect(warns[0]).toContain("legacy v1 journal");
      expect(warns[0]).toContain("wf-v1-a.events.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("新 record 流与旧文件共存 → 候选只含 record 流 run，旧文件 warn 不影响枚举结果", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-mixed-"));
    try {
      const wsA = join(root, "sessions", "--mixed-slug--", "workflow-state");
      mkdirSync(wsA, { recursive: true });
      writeFileSync(join(wsA, "wf-legacy.events.jsonl"), '{"type":"run-created"}\n');
      await seedRunningJournal(wsA, "wf-modern");

      const runs = await createPiHostRunEnumeration(() => root).loadAll();

      expect(runs.map((r) => r.runId)).toEqual(["wf-modern"]);
      const warns = logSpy.mock.calls.filter((c) => c[0] === "warn").map((c) => String(c[2]));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("wf-legacy.events.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

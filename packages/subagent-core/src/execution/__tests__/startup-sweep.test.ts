// startup-sweep 单测（机制退役设计 §4.1 场景 1/2/3/4，全部 mkdtemp 假树直调，
// 时钟用假树事件时间戳控制——不 mock 系统时间）。
//
// 场景-断言对照（[D15] 中断目标态——收编 = run-interrupted 转移帧一件直落，
// manifest / 终态条目 / 注销条目均不写）：
// - 场景 1：僵尸 run 启动收编主路径——中断帧直落（run-interrupted 帧
//   errorCode=startup-sweep）+ 反向断言（全树文件 diff：零新增、修改仅 journal
//   追加、session 文件零新增）+ info 结果行按方法名落位。
// - 场景 2：同假树二次调用幂等——journal 零新增帧 + adopted 0。
// - 场景 3：失败不阻断——3a 枚举整体失败（sessions 根 EACCES）error 留痕 +
//   函数正常 resolve；3b 单 run 收编失败（journal 文件 EACCES）warn 留痕 +
//   其余可收编 run 不受影响。
// - 场景 4：时序防拆断言——静态读 runtime main() 源码，断言 startupSweep 调用
//   位于单实例锁之后、service 构造段（pi spawn 的前置装配）之前，且时序硬
//   声明注释在位。
// - 检查点 8 三形态（[D16⑥] 枚举换源实测）：坏链 / 空 record 流 / v1 旧形态
//   目录——前两形态候选照进但收编判定拦下（零写入），v1 目录不进候选。
// - 新鲜末帧直收（ADR-0122 清查：事件流静止宽限窗已删，判僵尸依据 = 创建顺序
//   契约——单实例锁 + 扫描先于任何 pi spawn）：末帧距今 10s 的 running run
//   照常收编，无任何时间窗跳过。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRunTerminalManifest } from "../persistence/manifest-store.ts";
import { RUN_EVENTS_SUFFIX } from "../../shared/run-vocabulary.ts";
import { createRunEventJournal, type WorkflowRunEventInput } from "../../orchestration/run-events.ts";
import { startupSweep, type SweepLogChannel } from "../../orchestration/startup-sweep.ts"; // [D1 拆边 Class C] 实现已上移 orchestration/
import { createRecordEventStream } from "../persistence/record-events.ts";

/** mock 日志通道（按方法名断言级别落位——规格 6 签名的级别结构承载位）。 */
function makeLog(): SweepLogChannel {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** [session-store-layout-inversion] 构造 session 存储树的 workflow runs 目录
 *  （`<dataRoot>/ext-sessions/<sid>/workflow/runs/` + 假 session 文件锚点——
 *  旧「slug 树 + workflow-state」布局退役，枚举源 = 树内 sid 一级目录）。 */
function makeSessionRunsDirIn(root: string, sid: string): string {
  const sidRoot = join(root, "ext-sessions", sid);
  const runsDir = join(sidRoot, "workflow", "runs");
  mkdirSync(runsDir, { recursive: true });
  const sessionsDir = join(sidRoot, "subagents", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // 假 session 文件是反向断言「session 文件零新增」的锚点
  writeFileSync(join(sessionsDir, "20260928_000000_fixture-session.jsonl"), '{"fixture":true}\n');
  return runsDir;
}

/** 本文件共享 sid fixture（树内一级目录名，须过 shared isPiSessionId）。 */
const SWEEP_SID = "sid-sweep-fixture";

/** 最小合法快照行（v2 状态文件形态——budget 六字段缺一会被读侧形状校验拒绝；
 *  与 pi-host-run-store.test.ts 同源 fixture）。 */
function snapshotLine(runId: string, startedAtIso: string): string {
  return `${JSON.stringify({
    v: "wf-run-v2",
    runId,
    spec: {
      scriptSource: "// fixture\n",
      args: {},
      scriptName: "fixture",
      scriptPath: "/tmp/fixture.js",
      description: "startup-sweep fixture",
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

/** 全树文件清单（相对路径 → 字节长度）——反向断言与「session 文件零新增」的基底。 */
function walkFiles(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) visit(p);
      else out.set(relative(root, p), statSync(p).size);
    }
  };
  visit(root);
  return out;
}

describe("startupSweep（机制退役设计 §4.1 假树直调）", () => {
  let agentRoot: string;
  let log: SweepLogChannel;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "startup-sweep-"));
    log = makeLog();
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 构造 session 存储树 runs 目录（文件级 helper 的本 describe 便捷形态）。 */
  function makeSessionRunsDir(): string {
    return makeSessionRunsDirIn(agentRoot, SWEEP_SID);
  }

  /** 落 running 形态假树：state 快照 + journal 事件流（末帧时间戳 = 传入值）。 */
  async function seedRunningRun(stateDir: string, runId: string, lastEventTs: number): Promise<void> {
    writeFileSync(join(stateDir, `${runId}.jsonl`), snapshotLine(runId, new Date(lastEventTs).toISOString()));
    const journal = createRunEventJournal(stateDir);
    const events: WorkflowRunEventInput[] = [
      { type: "run-created", runId, workflowName: "fixture-flow", argsSummary: "{}", ts: lastEventTs },
      { type: "agent-started", taskIndex: 1, agentName: "worker", attempt: 1, ts: lastEventTs },
    ];
    for (const event of events) await journal.append(runId, event);
  }

  it("场景 1：僵尸 run 收编中断帧直落 + 反向断言无条目/manifest 写入 + info 结果行落位", async () => {
    const stateDir = makeSessionRunsDir();
    const runId = "wf-sweep-a";
    await seedRunningRun(stateDir, runId, Date.now() - 3 * 60 * 60 * 1000);
    const before = walkFiles(agentRoot);

    const result = await startupSweep(() => agentRoot, log);

    // 收编计数 + 幂等恒等式
    expect(result).toMatchObject({ adopted: 1, skipped: 0, stateDirs: 1, errors: [] });
    // journal 半边：run-interrupted(startup-sweep) 转移帧（[D15] 中断编排入口——
    // interrupted 是暂停态非终局，收编产物 = 中断帧一件直落）
    const events = await createRunEventJournal(stateDir).scan(runId);
    const interrupted = events[events.length - 1];
    expect(interrupted?.type).toBe("run-interrupted");
    if (interrupted?.type === "run-interrupted") {
      expect(interrupted.errorCode).toBe("startup-sweep");
      expect(interrupted.reason).toBe("runtime startup sweep: process-local run without live executor");
    }
    // manifest 半边：不物化（interrupted 非终局——manifest-write 仅 terminal 输出，
    // [D2] 暂停态可 resume，终局派生视图不落盘）
    expect(await readRunTerminalManifest(stateDir, runId)).toBeNull();
    // 反向断言：全树 diff——零新增文件、修改仅 journal 追加一个文件；session
    // 文件 / state 快照零新增零修改（无终态条目 / 注销条目 / manifest 写入的
    // 构造性验证）。
    const after = walkFiles(agentRoot);
    const added = [...after.keys()].filter((k) => !before.has(k));
    expect(added).toEqual([]);
    const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    expect(changed).toEqual([join("ext-sessions", SWEEP_SID, "workflow", "runs", `${runId}${RUN_EVENTS_SUFFIX}`)]);
    // 结果行按方法名落位：info 恰一次（三类计数），warn/error 零调用
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[subagents] startup sweep: adopted 1 run(s), skipped 0, across 1 state dir(s)",
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("场景 2：同假树二次调用幂等——journal 零新增帧 + adopted 0", async () => {
    const stateDir = makeSessionRunsDir();
    const runId = "wf-sweep-idem";
    await seedRunningRun(stateDir, runId, Date.now() - 3 * 60 * 60 * 1000);

    const first = await startupSweep(() => agentRoot, log);
    expect(first.adopted).toBe(1);
    const framesAfterFirst = (await createRunEventJournal(stateDir).scan(runId)).length;

    const second = await startupSweep(() => agentRoot, log);
    // 二次扫描：run-interrupted 帧在盘但 interrupted 是暂停态非终局——判定核无
    // run-settled 帧 / manifest → 保守判 running → 候选照进收编判定 → fold 停在
    // interrupted → skippedTerminal 幂等跳过（[D2] 暂停态可 resume，sweep 不判死）
    // → 零新增帧。
    expect(second.adopted).toBe(0);
    expect(second.skipped).toBe(1);
    expect((await createRunEventJournal(stateDir).scan(runId)).length).toBe(framesAfterFirst);
    expect(log.info).toHaveBeenLastCalledWith(
      "[subagents] startup sweep: adopted 0 run(s), skipped 1, across 1 state dir(s)",
    );
  });

  it("场景 3a：枚举整体失败（sessions 根 EACCES）——error 留痕含原因 + 正常 resolve 不 reject", async () => {
    // chmod 探针：root 进程不受权限位约束，场景构造不出来（环境限制非语义缺口；
    // pi-host-run-store.test.ts 同款惯用法）
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const storeRoot = join(agentRoot, "ext-sessions");
    mkdirSync(storeRoot, { recursive: true });
    const stateDir = makeSessionRunsDir();
    await seedRunningRun(stateDir, "wf-sweep-eacces", Date.now() - 3 * 60 * 60 * 1000);
    chmodSync(storeRoot, 0o000);
    try {
      // 不 reject：枚举整体失败折进结果对象（扫描是旁路维护，不阻断启动）
      const result = await startupSweep(() => agentRoot, log);
      expect(result).toMatchObject({ adopted: 0, skipped: 0, stateDirs: 0 });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("EACCES");
      // error 按方法名落位（级别结构承载位），枚举失败早退无 info 结果行
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(log.error).mock.calls[0]?.[0])).toContain("EACCES");
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      chmodSync(storeRoot, 0o755);
    }
  });

  it("场景 3b：单 run 收编失败——warn 留痕继续，其余可收编 run 不受影响", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const stateDir = makeSessionRunsDir();
    await seedRunningRun(stateDir, "wf-sweep-ok", Date.now() - 3 * 60 * 60 * 1000);
    await seedRunningRun(stateDir, "wf-sweep-bad", Date.now() - 3 * 60 * 60 * 1000);
    // wf-sweep-bad 的 journal 读侧破坏（EACCES）——判定核保守按 running 进收编，
    // scan 分通道上抛，收编失败
    chmodSync(join(stateDir, `wf-sweep-bad${RUN_EVENTS_SUFFIX}`), 0o000);
    try {
      const result = await startupSweep(() => agentRoot, log);
      // 其余可收编 run 正常收编；失败 run 计入 skipped + errors 摘要
      expect(result.adopted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("wf-sweep-bad");
      // 收编产物 = run-interrupted 帧（manifest 不物化——interrupted 非终局）
      const okEvents = await createRunEventJournal(stateDir).scan("wf-sweep-ok");
      expect(okEvents[okEvents.length - 1]?.type).toBe("run-interrupted");
      expect(await readRunTerminalManifest(stateDir, "wf-sweep-bad")).toBeNull();
      // 级别落位：单 run 失败 = warn（不升级 error），结果行 info 照打
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(log.warn).mock.calls[0]?.[0])).toContain("wf-sweep-bad");
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        "[subagents] startup sweep: adopted 1 run(s), skipped 1, across 1 state dir(s)",
      );
    } finally {
      chmodSync(join(stateDir, `wf-sweep-bad${RUN_EVENTS_SUFFIX}`), 0o644);
    }
  });

  it("场景 4：时序防拆——startupSweep 调用在单实例锁之后、service 构造段之前，硬声明注释在位", () => {
    const runtimeIndexPath = fileURLToPath(
      new URL("../../../../runtime/src/index.ts", import.meta.url),
    );
    const source = readFileSync(runtimeIndexPath, "utf8");
    const lineOf = (needle: string): number => {
      const idx = source.indexOf(needle);
      expect(idx, `runtime main() 应包含 ${needle}`).toBeGreaterThan(-1);
      return source.slice(0, idx).split("\n").length;
    };
    // 时序硬声明注释存在（决策 1 的代码级防线）
    expect(source).toContain("先于任何 pi spawn");
    // 调用序：单实例锁登记 → startupSweep → service 构造段首（ProcessManager——
    // 启动段不 spawn pi，service 构造段是 pi spawn 链的前置装配）
    const lockLine = lineOf("registerRuntimeInstance(getDataDir(), port)");
    const sweepLine = lineOf("await startupSweep(");
    const serviceLine = lineOf("new ProcessManager(");
    expect(sweepLine).toBeGreaterThan(lockLine);
    expect(sweepLine).toBeLessThan(serviceLine);
  });

  it("新鲜末帧直收（宽限窗已删）：末帧距今 10s 的 running run 照常收编，无时间窗跳过", async () => {
    const stateDir = makeSessionRunsDir();
    const runId = "wf-sweep-fresh";
    // 末帧距今 10s（旧实现会被 60s 宽限窗跳过）——创建顺序契约下照常收编
    await seedRunningRun(stateDir, runId, Date.now() - 10_000);

    const result = await startupSweep(() => agentRoot, log);
    expect(result).toMatchObject({ adopted: 1, skipped: 0 });
    const events = await createRunEventJournal(stateDir).scan(runId);
    expect(events[events.length - 1]?.type).toBe("run-interrupted");
    expect(await readRunTerminalManifest(stateDir, runId)).toBeNull();
    expect(log.info).toHaveBeenLastCalledWith(
      "[subagents] startup sweep: adopted 1 run(s), skipped 0, across 1 state dir(s)",
    );
  });
});

// ── 检查点 8 三形态（[D16⑥] 枚举换源实测：坏链 / 空 record 流 / v1 旧形态目录）──
//
// 枚举判据换源（快照行 status → fold record 读折叠派生视图）后的行为核实：坏链与
// 空流候选照进（判定核对「journal 在无 settled 帧」保守判 running）但收编判定
// 拦下（skippedBrokenChain / skippedMissing——零写入）；v1 旧形态目录不进候选
//（枚举空集——构造性跳过，其 warn 留痕断言在 pi-host-run-store.test.ts）。
describe("startupSweep 枚举换源三形态（[D16⑥] 检查点 8）", () => {
  let agentRoot: string;
  let log: SweepLogChannel;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "startup-sweep-forms-"));
    log = makeLog();
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("坏链：run-created 帧损坏 → fold 停在 created → skippedBrokenChain 计入 skipped、record 零写入", async () => {
    const stateDir = makeSessionRunsDirIn(agentRoot, SWEEP_SID);
    const recordPath = join(stateDir, "wf-bad-chain.record.jsonl");
    writeFileSync(
      recordPath,
      [
        "{not json", // 坏：run-created 帧损坏（fold 停在 created 的构造形态）
        JSON.stringify({ type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() - 3 * 60 * 60 * 1000 }),
      ].join("\n"),
      "utf8",
    );
    const before = readFileSync(recordPath, "utf8");

    const result = await startupSweep(() => agentRoot, log);

    // run-interrupted 对 created 是表外转移 → 保守跳过（零写入），计入 skipped
    expect(result).toMatchObject({ adopted: 0, skipped: 1, errors: [] });
    expect(readFileSync(recordPath, "utf8")).toBe(before);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("空 record 流：文件在但零事件 → skippedMissing 计入 skipped、零写入", async () => {
    const stateDir = makeSessionRunsDirIn(agentRoot, SWEEP_SID);
    const recordPath = join(stateDir, "wf-empty.record.jsonl");
    writeFileSync(recordPath, "", "utf8");

    const result = await startupSweep(() => agentRoot, log);

    // 判定核：文件在、无 settled 帧 → 保守 running 进收编判定；scan 空流 →
    // skippedMissing（无事件证据——从未写入 journal 记录或已清理），零写入
    expect(result).toMatchObject({ adopted: 0, skipped: 1, errors: [] });
    expect(readFileSync(recordPath, "utf8")).toBe("");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("v1 旧形态文件：runs 目录内只有旧双源文件（非 record 流候选）→ 枚举空集（adopted/skipped/stateDirs 全 0，结果行照打）", async () => {
    const stateDir = makeSessionRunsDirIn(agentRoot, SWEEP_SID);
    writeFileSync(join(stateDir, "wf-v1-only.events.jsonl"), '{"type":"run-created"}\n');
    writeFileSync(join(stateDir, "wf-v1-only.jsonl"), '{"v":"wf-run-v1"}\n');

    const result = await startupSweep(() => agentRoot, log);

    // [D1] 历史数据处置：旧两件不读不写——候选 = record 流文件族，v1 run 不进
    // 枚举（adopted/skipped 两侧都不计），静默空集防线由读错分通道覆盖（真 IO
    // 故障走 EACCES 上抛用例，见读错分通道 describe）
    expect(result).toMatchObject({ adopted: 0, skipped: 0, stateDirs: 0, errors: [] });
    expect(log.info).toHaveBeenCalledWith(
      "[subagents] startup sweep: adopted 0 run(s), skipped 0, across 0 state dir(s)",
    );
    // 旧件原样在盘（不读不写不主动删）
    expect(readFileSync(join(stateDir, "wf-v1-only.events.jsonl"), "utf8")).toContain("run-created");
  });
});

// ── [subagent-observability §3.3.4 合并清点] record 半边（失联清点）──────────
//
// 场景 3 单元级断言（kill -9 重启 → 合并清点）：run 收编与 record 失联清点在同一
// startupSweep 入口完成。判定全事实无时间窗：
//   - 候选枚举 = manifest 快照在途形态（executionStatus=running——快照通道，禁全量 fold）；
//   - 命中确认 = 事件流停在「轮在途」形态（轮收条未写）；
//   - 命中处置 = 失联轮收条补写（interrupted-by-restart + swept 附注）+ manifest
//     快照刷新（executionStatus=idle + 收编停因——占用判据与计数摘除）；
//   - pending 结清 lost 的发射位 = session reattach 侧对账 sweep（runtime 进程无
//     appendEntry 通道）——判据事实位断言在 sweep-binding.test.ts（u3 同批）。
describe("startupSweep 合并清点 record 半边（subagent-observability §3.3.4）", () => {
  let agentRoot: string;
  let log: SweepLogChannel;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "startup-sweep-records-"));
    log = makeLog();
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 构造 records 目录（`<root>/ext-sessions/<sid>/subagents/records/`）。 */
  function makeRecordsDir(sid: string): string {
    const recordsDir = join(agentRoot, "ext-sessions", sid, "subagents", "records");
    mkdirSync(recordsDir, { recursive: true });
    return recordsDir;
  }

  /** manifest 快照写入（生产写点同款字段形——executionStatus 两态权威词双写）。 */
  function seedManifest(recordsDir: string, id: string, executionStatus: "running" | "idle"): void {
    writeFileSync(
      join(recordsDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          rootSessionId: "sid-records-fixture",
          agentName: "worker",
          status: "running",
          executionStatus,
          createdAt: Date.now() - 60_000,
          task: "long runner",
          slug: "long-runner",
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  /** 事件流播种（created → bound 前缀 + 末帧形态控制）：events 事件经生产流 append（seq 单调）。 */
  async function seedEvents(recordsDir: string, id: string, endWithReceipt: boolean): Promise<void> {
    const stream = createRecordEventStream(() => recordsDir);
    await stream.append(id, {
      type: "record-created",
      ts: Date.now() - 60_000,
      id,
      agent: "worker",
      task: "long runner",
      slug: "long-runner",
      origin: "tool",
      rootSessionId: "sid-records-fixture",
      depth: 0,
      mode: "background",
      startedAt: Date.now() - 60_000,
    });
    await stream.append(id, {
      type: "record-round-started",
      ts: Date.now() - 10_000,
      round: 0,
      epoch: 0,
    });
    if (endWithReceipt) {
      await stream.append(id, {
        type: "record-round-idle",
        ts: Date.now() - 5_000,
        round: 1,
        stopReason: "completed",
        turns: 2,
        totalTokens: 100,
      });
    }
  }

  const readManifest = (recordsDir: string, id: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(recordsDir, `${id}.json`), "utf-8")) as Record<string, unknown>;

  const readEvents = (recordsDir: string, id: string): Array<Record<string, unknown>> =>
    readFileSync(join(recordsDir, `${id}.events`), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("场景 3 主路径：manifest 在途 + 轮收条未写 → 失联轮收条补写 + manifest 快照摘除 + 无时间窗（末帧距今 10s 照常清点）", async () => {
    const recordsDir = makeRecordsDir("sid-records-fixture");
    const id = "sa-sweep-orphan";
    seedManifest(recordsDir, id, "running");
    await seedEvents(recordsDir, id, false);
    const before = walkFiles(agentRoot);

    const result = await startupSweep(() => agentRoot, log);

    expect(result.recordsSwept).toBe(1);
    // manifest 快照：executionStatus=idle + 收编停因（占用判据与计数自此摘除——
    // manifest 直读主路径同步收敛）。
    const manifest = readManifest(recordsDir, id);
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.stopReason).toBe("interrupted-by-restart");
    // 失联轮收条：停因复用 interrupted-by-restart + 清点附注（swept 标记 + evidence）。
    const idle = readEvents(recordsDir, id).find((e) => e.type === "record-round-idle");
    expect(idle?.stopReason).toBe("interrupted-by-restart");
    expect(idle?.swept).toMatchObject({ at: expect.any(Number) });
    expect(String((idle?.swept as { evidence?: string })?.evidence)).toContain("manifest=");
    // 轮计数 = 在途轮的轮终语义值（轮始帧 round 0 + 1）；统计 carry-forward 无前帧诚实 0。
    expect(idle?.round).toBe(1);
    expect(idle?.turns).toBe(0);
    // 反向断言：改动面 = manifest + 事件文件两件（session 文件零新增——禁触碰 pi 域）。
    const after = walkFiles(agentRoot);
    const added = [...after.keys()].filter((k) => !before.has(k));
    expect(added).toEqual([]);
    const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    expect(changed.sort()).toEqual(
      [
        join("ext-sessions", "sid-records-fixture", "subagents", "records", `${id}.json`),
        join("ext-sessions", "sid-records-fixture", "subagents", "records", `${id}.events`),
      ].sort(),
    );
    // 结果行按命中落位（record 半边 info 行 + 主结果行）。
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("[subagents] startup sweep (records): swept 1 interrupted record(s)"),
    );
  });

  it("幂等：清点后二次启动扫描零重复（manifest 已 idle 不再命中）+ 半更新窗让位（收条已在不补写不覆写）", async () => {
    const recordsDir = makeRecordsDir("sid-records-fixture");
    const id = "sa-sweep-idem";
    seedManifest(recordsDir, id, "running");
    await seedEvents(recordsDir, id, false);

    const first = await startupSweep(() => agentRoot, log);
    expect(first.recordsSwept).toBe(1);
    const eventsAfterFirst = readEvents(recordsDir, id).length;

    const second = await startupSweep(() => agentRoot, log);
    expect(second.recordsSwept).toBe(0);
    expect(readEvents(recordsDir, id).length).toBe(eventsAfterFirst);

    // 半更新窗：另一 record 事件流已停在轮终收条（孤儿自收尾、manifest 快照滞后
    // running）——让位不补写（不覆写真实轮收条）。
    const lateId = "sa-sweep-late-receipt";
    seedManifest(recordsDir, lateId, "running");
    await seedEvents(recordsDir, lateId, true);
    const third = await startupSweep(() => agentRoot, log);
    expect(third.recordsSwept).toBe(0);
    const lateReceipts = readEvents(recordsDir, lateId).filter((e) => e.type === "record-round-idle");
    expect(lateReceipts).toHaveLength(1);
    expect(lateReceipts[0]?.stopReason).toBe("completed");
  });

  it("非候选：manifest 快照 idle（正常轮终/已清点）不进判定；损坏 manifest warn 跳过不炸", async () => {
    const recordsDir = makeRecordsDir("sid-records-fixture");
    seedManifest(recordsDir, "sa-idle-record", "idle");
    await seedEvents(recordsDir, "sa-idle-record", false);
    // 损坏快照（JSON 截断）。
    writeFileSync(join(recordsDir, "sa-broken.json"), '{"id":"sa-broken",', "utf-8");

    const result = await startupSweep(() => agentRoot, log);

    expect(result.recordsSwept).toBe(0);
    // 损坏快照 warn 留痕（不虚构在途判定），不放大为启动失败。
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("sa-broken.json"));
    // idle record 零写入（不在候选，事件流原样）。
    expect(readEvents(recordsDir, "sa-idle-record").every((e) => e.type !== "record-round-idle")).toBe(true);
  });
});

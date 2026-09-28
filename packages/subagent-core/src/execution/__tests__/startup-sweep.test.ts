// startup-sweep 单测（机制退役设计 §4.1 场景 1/2/3/4/7，全部 mkdtemp 假树直调，
// 时钟用假树事件时间戳控制——不 mock 系统时间）。
//
// 场景-断言对照：
// - 场景 1：僵尸 run 启动收编主路径——收编两件直落（journal run-settled 帧
//   outcome=interrupted errorCode=startup-sweep + manifest 物化内容一致）+
//   反向断言（全树文件 diff：新增仅 manifest、修改仅 journal 追加、session
//   文件零新增 = 无终态条目/注销条目写入）+ info 结果行按方法名落位。
// - 场景 2：同假树二次调用幂等——journal 零新增帧 + adopted 0。
// - 场景 3：失败不阻断——3a 枚举整体失败（sessions 根 EACCES）error 留痕 +
//   函数正常 resolve；3b 单 run 收编失败（journal 文件 EACCES）warn 留痕 +
//   其余可收编 run 不受影响。
// - 场景 4：时序防拆断言——静态读 runtime main() 源码，断言 startupSweep 调用
//   位于单实例锁之后、service 构造段（pi spawn 的前置装配）之前，且时序硬
//   声明注释在位。
// - 场景 7：宽限窗防误收编——末帧距今 < 60s 零写（journal 零新增 + manifest
//   不物化）+ skipped/grace 计数；末帧改老后重调正常收编。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRunTerminalManifest } from "../persistence/manifest-store.ts";
import {
  createRunEventJournal,
  type WorkflowRunEventInput,
} from "../../orchestration/run-events.ts";
import {
  STARTUP_SWEEP_GRACE_WINDOW_MS,
  startupSweep,
  type SweepLogChannel,
} from "../assembly/startup-sweep.ts";

/** mock 日志通道（按方法名断言级别落位——规格 6 签名的级别结构承载位）。 */
function makeLog(): SweepLogChannel {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** toRunSnapshot 最小合法行（fromRunSnapshot 可重水合；与 pi-host-run-store.test.ts
 * 同源 fixture——budget 六字段缺一会被形状校验拒绝）。 */
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

  /** 构造一个 pi 壳布局的 session 目录（slug 树 + workflow-state + 假 session 文件）。 */
  function makeSlugStateDir(slug: string): string {
    const slugDir = join(agentRoot, "sessions", slug);
    const stateDir = join(slugDir, "workflow-state");
    mkdirSync(stateDir, { recursive: true });
    // 假 session 文件（pi 布局 session 文件池与 run state slug 树同在 sessions/ 下
    // 的兄弟层）——反向断言的「session 文件零新增」锚点。
    writeFileSync(join(slugDir, "20260928_000000_fixture-session.jsonl"), '{"fixture":true}\n');
    return stateDir;
  }

  /** 落 running 形态假树：state 快照 + journal 事件流（末帧时间戳 = 传入值）。 */
  async function seedRunningRun(stateDir: string, runId: string, lastEventTs: number): Promise<void> {
    writeFileSync(join(stateDir, `${runId}.jsonl`), snapshotLine(runId, new Date(lastEventTs).toISOString()));
    const journal = createRunEventJournal(stateDir);
    const events: WorkflowRunEventInput[] = [
      { type: "run-created", runId, workflowName: "fixture-flow", argsSummary: "{}", ts: lastEventTs },
      { type: "ask-dispatched", taskIndex: 1, agentName: "worker", attempt: 1, ts: lastEventTs },
    ];
    for (const event of events) await journal.append(runId, event);
  }

  it("场景 1：僵尸 run 收编两件直落 + 反向断言无条目写入 + info 结果行落位", async () => {
    const stateDir = makeSlugStateDir("--fixture-slug--");
    const runId = "wf-sweep-a";
    const staleTs = Date.now() - 3 * 60 * 60 * 1000; // 末帧 3 小时前，远超宽限窗
    await seedRunningRun(stateDir, runId, staleTs);
    const before = walkFiles(agentRoot);

    const result = await startupSweep(() => agentRoot, log);

    // 收编计数 + 幂等恒等式
    expect(result).toMatchObject({ adopted: 1, skipped: 0, skippedGraceWindow: 0, stateDirs: 1, errors: [] });
    // journal 半边：run-settled(interrupted, startup-sweep) 帧
    const events = await createRunEventJournal(stateDir).scan(runId);
    const settled = events[events.length - 1];
    expect(settled?.type).toBe("run-settled");
    if (settled?.type === "run-settled") {
      expect(settled.outcome).toBe("interrupted");
      expect(settled.errorCode).toBe("startup-sweep");
      expect(settled.reason).toBe("runtime startup sweep: process-local run without live executor");
    }
    // manifest 半边：物化且与帧一致（两件直落）
    const manifest = await readRunTerminalManifest(stateDir, runId);
    expect(manifest).not.toBeNull();
    expect(manifest?.id).toBe(runId);
    expect(manifest?.outcome).toBe("interrupted");
    expect(manifest?.errorCode).toBe("startup-sweep");
    // 反向断言（决策 3 一律两件直落）：全树 diff——新增仅 manifest 一个文件、
    // 修改仅 journal 追加一个文件；session 文件 / state 快照零新增零修改
    //（无终态条目 / 注销条目写入的构造性验证）。
    const after = walkFiles(agentRoot);
    const added = [...after.keys()].filter((k) => !before.has(k));
    expect(added).toEqual([join("sessions", "--fixture-slug--", "workflow-state", `${runId}.json`)]);
    const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    expect(changed).toEqual([join("sessions", "--fixture-slug--", "workflow-state", `${runId}.events.jsonl`)]);
    // 结果行按方法名落位：info 恰一次（三类计数），warn/error 零调用
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[subagents] startup sweep: adopted 1 run(s), skipped 0 (grace 0), across 1 state dir(s)",
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("场景 2：同假树二次调用幂等——journal 零新增帧 + adopted 0", async () => {
    const stateDir = makeSlugStateDir("--fixture-slug--");
    const runId = "wf-sweep-idem";
    await seedRunningRun(stateDir, runId, Date.now() - 3 * 60 * 60 * 1000);

    const first = await startupSweep(() => agentRoot, log);
    expect(first.adopted).toBe(1);
    const framesAfterFirst = (await createRunEventJournal(stateDir).scan(runId)).length;

    const second = await startupSweep(() => agentRoot, log);
    // 二次扫描：fold 已 terminal → 幂等跳过，零新增帧（「一个 run 恰好一帧
    // run-settled」终态不变量保持）
    expect(second.adopted).toBe(0);
    expect(second.skipped).toBe(1);
    expect((await createRunEventJournal(stateDir).scan(runId)).length).toBe(framesAfterFirst);
    expect(log.info).toHaveBeenLastCalledWith(
      "[subagents] startup sweep: adopted 0 run(s), skipped 1 (grace 0), across 1 state dir(s)",
    );
  });

  it("场景 3a：枚举整体失败（sessions 根 EACCES）——error 留痕含原因 + 正常 resolve 不 reject", async () => {
    // chmod 探针：root 进程不受权限位约束，场景构造不出来（环境限制非语义缺口；
    // pi-host-run-store.test.ts 同款惯用法）
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const sessionsRoot = join(agentRoot, "sessions");
    mkdirSync(join(sessionsRoot, "--fixture-slug--"), { recursive: true });
    const stateDir = makeSlugStateDir("--fixture-slug--");
    await seedRunningRun(stateDir, "wf-sweep-eacces", Date.now() - 3 * 60 * 60 * 1000);
    chmodSync(sessionsRoot, 0o000);
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
      chmodSync(sessionsRoot, 0o755);
    }
  });

  it("场景 3b：单 run 收编失败——warn 留痕继续，其余可收编 run 不受影响", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const stateDir = makeSlugStateDir("--fixture-slug--");
    const staleTs = Date.now() - 3 * 60 * 60 * 1000;
    await seedRunningRun(stateDir, "wf-sweep-ok", staleTs);
    await seedRunningRun(stateDir, "wf-sweep-bad", staleTs);
    // wf-sweep-bad 的 journal 读面破坏（EACCES）——scan 分通道上抛，收编失败
    chmodSync(join(stateDir, "wf-sweep-bad.events.jsonl"), 0o000);
    try {
      const result = await startupSweep(() => agentRoot, log);
      // 其余可收编 run 正常收编；失败 run 计入 skipped + errors 摘要
      expect(result.adopted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("wf-sweep-bad");
      const okManifest = await readRunTerminalManifest(stateDir, "wf-sweep-ok");
      expect(okManifest?.outcome).toBe("interrupted");
      expect(await readRunTerminalManifest(stateDir, "wf-sweep-bad")).toBeNull();
      // 级别落位：单 run 失败 = warn（不升级 error），结果行 info 照打
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(log.warn).mock.calls[0]?.[0])).toContain("wf-sweep-bad");
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        "[subagents] startup sweep: adopted 1 run(s), skipped 1 (grace 0), across 1 state dir(s)",
      );
    } finally {
      chmodSync(join(stateDir, "wf-sweep-bad.events.jsonl"), 0o644);
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

  it("场景 7：宽限窗内零写（skipped 含 grace 计数）——末帧改老后重调正常收编", async () => {
    const stateDir = makeSlugStateDir("--fixture-slug--");
    const runId = "wf-sweep-grace";
    // 末帧距今 10s < 60s 宽限窗（假树时间戳控制，不 mock 系统时间）
    await seedRunningRun(stateDir, runId, Date.now() - 10_000);
    expect(STARTUP_SWEEP_GRACE_WINDOW_MS).toBe(60_000);

    const fresh = await startupSweep(() => agentRoot, log);
    // 零写：adoptInterruptedRun 返回 skippedGraceWindow——journal 零新增帧 +
    // manifest 不物化
    expect(fresh).toMatchObject({ adopted: 0, skipped: 1, skippedGraceWindow: 1 });
    expect((await createRunEventJournal(stateDir).scan(runId))).toHaveLength(2); // 仅 seed 两帧
    expect(await readRunTerminalManifest(stateDir, runId)).toBeNull();
    expect(log.info).toHaveBeenLastCalledWith(
      "[subagents] startup sweep: adopted 0 run(s), skipped 1 (grace 1), across 1 state dir(s)",
    );

    // 末帧改老（重建 journal 为远超窗的旧时间戳）再调 → 正常收编（场景 1 语义）
    rmSync(join(stateDir, `${runId}.events.jsonl`));
    await seedRunningRun(stateDir, runId, Date.now() - 3 * 60 * 60 * 1000);
    const stale = await startupSweep(() => agentRoot, log);
    expect(stale.adopted).toBe(1);
    const events = await createRunEventJournal(stateDir).scan(runId);
    expect(events[events.length - 1]?.type).toBe("run-settled");
    expect((await readRunTerminalManifest(stateDir, runId))?.outcome).toBe("interrupted");
  });
});

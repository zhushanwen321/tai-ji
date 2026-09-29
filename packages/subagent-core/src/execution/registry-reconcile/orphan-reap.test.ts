// 裁决点 7 对账清理场景测试（场景 8 / 场景 19——workflow-run-resume-revision
// §4 验收表，u1b 承接）：
// - 场景 8「终局化移除 + 对账清理」：D9 abandon 移除后无主 run 不再被自动终局化
//   （维护轮只登记/删除，不写任何事件帧）；删引用后触发维护轮，宽限不调零组
//   不删（首判时刻锚定——老 mtime 存量组首轮也不删，「不采用锚 mtime」裁决的
//   回归钉）、调零组删三件 + 残锁 + 清登记；存活引用 run 不受影响。
// - 场景 19「对账清理存量形态与接管保护」：v1 条目引用的存量 run（旧双源文件
//   形态、无 record 流）不删；A 建 run → 删 A → B resume 接管补注册 → 维护轮
//   三件不删。
//
// 被测函数 = reapOrphanRuns（persistence/run-state-evidence.ts，[D9] 移除后无主
// run 的唯一磁盘清理通道）。引用集三代（v2 注册条目 / v1 全量快照条目 /
// pre-W17 link 指针）的解析本体在壳侧注入面（subagent-workflow/session-lifecycle
// 的 collectAliveWorkflowRunReferences，u1a 领地）——core 层契约 = 注入并集命中
// 即保护，本文件按该契约以注入集合模拟三代引用与接管；三代解析本体的测试缺口
// 登记 deviations 待壳侧补。
//
// 测试纪律：全部 mkdtempSync 自建自删（禁触真实数据目录）；时钟经 options.now
// 注入（确定性）；reap 不读 record 内容（候选按文件名 / 引用按注入 / 时间按
// mtime 与登记），fixture 手写文件即可。
// - 登记文件损坏路径：一次性损坏自愈（空表重登记 + 轮末原子重写）、损坏读
//   warn 出声（观测面）、ENOENT 静默（不存在 ≠ 损坏的语义区分钉）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reapOrphanRuns, type OrphanRunReapDeps } from "../persistence/run-state-evidence.ts";

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-reap-"));
  stateDir = path.join(tmpDir, "workflow-state");
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 全件形态 run 落盘（record 流 + manifest 派生缓存 + 历史遗留旧双源两件 +
 *  残锁）。record 内容不被 reap 消费，一行合法 run-created JSON 即可。 */
function seedRunFootprint(runId: string): void {
  fs.writeFileSync(path.join(stateDir, `${runId}.record.jsonl`), `${JSON.stringify({
    type: "run-created",
    runId,
    workflowName: "fixture-flow",
    argsSummary: "{}",
    ts: 1_000,
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stateDir, `${runId}.json`), JSON.stringify({ outcome: "done" }), "utf8");
  fs.writeFileSync(path.join(stateDir, `${runId}.jsonl`), '{"v":"wf-run-v2","fixture":true}\n', "utf8");
  fs.writeFileSync(path.join(stateDir, `${runId}.events.jsonl`), '{"type":"run-created"}\n', "utf8");
  fs.writeFileSync(path.join(stateDir, `${runId}.resume.lock`), "{}", "utf8");
}

/** 旧双源文件形态存量 run（无 record 流——[D1] 前旧写入方产物）。 */
function seedLegacyRunFootprint(runId: string): void {
  fs.writeFileSync(path.join(stateDir, `${runId}.jsonl`), '{"v":"wf-run-v1","fixture":true}\n', "utf8");
  fs.writeFileSync(path.join(stateDir, `${runId}.events.jsonl`), '{"type":"run-created"}\n', "utf8");
}

/** 五件全在断言用文件名清单。 */
function footprintNames(runId: string): string[] {
  return [`${runId}.record.jsonl`, `${runId}.json`, `${runId}.jsonl`, `${runId}.events.jsonl`, `${runId}.resume.lock`];
}

function fileExists(name: string): boolean {
  return fs.existsSync(path.join(stateDir, name));
}

/** 五件 mtime 统一拨到指定时刻（与门第二臂输入——注入时钟下 fixture 须显式
 *  对齐 mtime，否则真实盘 mtime（未来时刻）恒拦删除）。 */
function ageFootprint(runId: string, at: number): void {
  const t = new Date(at);
  for (const name of footprintNames(runId)) {
    fs.utimesSync(path.join(stateDir, name), t, t);
  }
}

/** 读登记状态文件（无文件 = 空表）。 */
function readRegistry(): Record<string, number> {
  const full = path.join(stateDir, "orphan-run-reap.json");
  if (!fs.existsSync(full)) return {};
  return JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, number>;
}

/** deps 装配（引用集注入 + noop 日志；warn 记录供断言）。 */
function makeDeps(refs: ReadonlySet<string> | Error): { deps: OrphanRunReapDeps; warnCalls: string[] } {
  const warnCalls: string[] = [];
  const deps: OrphanRunReapDeps = {
    collectAliveRunReferences: async () => {
      if (refs instanceof Error) throw refs;
      return refs;
    },
    warn: (msg) => warnCalls.push(msg),
    debug: () => {},
    toMsg: (err) => (err instanceof Error ? err.message : String(err)),
  };
  return { deps, warnCalls };
}

describe("场景 8：终局化移除 + 对账清理（D9 + 裁决点 7）", () => {
  it("宽限不调零组：老 mtime 存量 run 首轮只登记不删——宽限锚 = 首判时刻（非 mtime，回访用例）", async () => {
    seedRunFootprint("wf-old");
    // 老 mtime 存量组：五件 mtime 全部拨回 30 天前——若按 mtime 锚定，首轮即删
    //（宽限保护为零）；按首判时刻锚定，首轮只登记进观察期。
    ageFootprint("wf-old", 1_700_000_000_000 - 30 * 86_400_000);
    const { deps } = makeDeps(new Set<string>());
    const now = 1_700_000_000_000; // 首判时刻（mtime 后 30 天——mtime 已远超窗）

    const result = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 604_800_000, now });

    expect(result).toMatchObject({ scanned: 1, skippedReferenced: 0, skippedGraceWindow: 1, reaped: 0 });
    for (const name of footprintNames("wf-old")) expect(fileExists(name)).toBe(true);
    expect(readRegistry()).toEqual({ "wf-old": now });
  });

  it("宽限不调零组：观察期内二轮不删 + 登记锚不随重扫漂移（幂等首判）", async () => {
    seedRunFootprint("wf-old");
    const { deps } = makeDeps(new Set<string>());
    const first = 1_700_000_000_000;
    await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 604_800_000, now: first });
    const mid = first + 3 * 86_400_000; // 观察期内（< 7 天）

    const result = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 604_800_000, now: mid });

    expect(result.reaped).toBe(0);
    expect(result.skippedGraceWindow).toBe(1);
    for (const name of footprintNames("wf-old")) expect(fileExists(name)).toBe(true);
    // 首判时刻保持 first（重扫不刷新登记——宽限锚不漂移）
    expect(readRegistry()).toEqual({ "wf-old": first });
  });

  it("宽限调零组：删三件 + 历史遗留旧双源 + 残锁 + 清登记条目", async () => {
    seedRunFootprint("wf-gone");
    const now = 1_700_000_000_000;
    ageFootprint("wf-gone", now - 1_000);
    const { deps } = makeDeps(new Set<string>());

    const result = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 0, now });

    expect(result).toMatchObject({ scanned: 1, skippedGraceWindow: 0, reaped: 1 });
    // 「三件」= record 流 + manifest 派生缓存 + 历史遗留旧双源（.jsonl 快照 +
    // .events.jsonl 旧 journal）；残锁顺带删；登记条目清除（登记文件本身保留）
    for (const name of footprintNames("wf-gone")) expect(fileExists(name)).toBe(false);
    expect(readRegistry()).toEqual({});
    expect(fileExists("orphan-run-reap.json")).toBe(true);
  });

  it("存活引用 run 不受影响；引用恢复清观察期登记（不再处于无主观察期）", async () => {
    seedRunFootprint("wf-live");
    const now = 1_700_000_000_000;
    // 先无引用一轮：进观察期
    const unref = makeDeps(new Set<string>());
    await reapOrphanRuns({ stateDir }, unref.deps, { graceWindowMs: 604_800_000, now });
    expect(readRegistry()).toEqual({ "wf-live": now });

    // 引用恢复（任一存活 session 引用即保留）→ 保护 + 观察期登记清除
    const ref = makeDeps(new Set(["wf-live"]));
    const result = await reapOrphanRuns({ stateDir }, ref.deps, { graceWindowMs: 604_800_000, now: now + 1 });

    expect(result).toMatchObject({ skippedReferenced: 1, reaped: 0 });
    for (const name of footprintNames("wf-live")) expect(fileExists(name)).toBe(true);
    expect(readRegistry()).toEqual({});
  });

  it("终局化移除（D9 回归钉）：维护轮对孤儿 run 只登记/删除，record 流零事件帧追加", async () => {
    seedRunFootprint("wf-noadopt");
    const recordPath = path.join(stateDir, "wf-noadopt.record.jsonl");
    const before = fs.readFileSync(recordPath, "utf8");
    ageFootprint("wf-noadopt", 1_700_000_000_000 - 1_000);
    const { deps } = makeDeps(new Set<string>());

    // 观察期轮（宽限未到）：record 流字节不变
    const first = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 604_800_000, now: 1_700_000_000_000 });
    expect(first.reaped).toBe(0);
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);

    // 删除轮（调零）：record 整文件移除而非改写——abandon 移除后无自动终局化
    // 写入方，清理通道对 record 只删不写（run-settled 终局帧 / run-interrupted 帧
    // 均不出现——终局化归用户显式动作，中断收编归 startupSweep 崩溃扫描链，均
    // 不在维护轮射程）
    const second = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 0, now: 1_700_086_400_000 });
    expect(second.reaped).toBe(1);
    expect(fs.existsSync(recordPath)).toBe(false);
  });
});

describe("场景 19：对账清理存量形态与接管保护（裁决点 7）", () => {
  it("v1 条目引用的存量 run（旧双源文件形态、无 record 流）不删——三代引用并集命中即保护", async () => {
    seedLegacyRunFootprint("wf-legacy");
    const { deps } = makeDeps(new Set(["wf-legacy"]));

    const result = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 0, now: 1_700_000_000_000 });

    // 候选并集含旧 journal 后缀（.events.jsonl）——存量 run 进扫描；引用命中保护
    expect(result).toMatchObject({ scanned: 1, skippedReferenced: 1, reaped: 0 });
    expect(fileExists("wf-legacy.jsonl")).toBe(true);
    expect(fileExists("wf-legacy.events.jsonl")).toBe(true);
  });

  it("A 建 run → 删 A → B resume 接管补注册 → 维护轮三件不删（接管保护全程时序）", async () => {
    seedRunFootprint("wf-handover");
    const now = 1_700_000_000_000;
    const grace = 604_800_000;

    // R1：A 的注册引用在场（v2 注册条目形态）→ 保护
    const r1 = await reapOrphanRuns({ stateDir }, makeDeps(new Set(["wf-handover"])).deps, { graceWindowMs: grace, now });
    expect(r1.skippedReferenced).toBe(1);

    // R2：删 A（引用消失）→ 进观察期，宽限未到不删
    const r2 = await reapOrphanRuns({ stateDir }, makeDeps(new Set<string>()).deps, { graceWindowMs: grace, now: now + 86_400_000 });
    expect(r2.skippedGraceWindow).toBe(1);
    expect(readRegistry()).toEqual({ "wf-handover": now + 86_400_000 });

    // R3：B resume 接管（引用集含 runId——接管补注册经引用集体现）→ 保护 + 登记清除
    const r3 = await reapOrphanRuns({ stateDir }, makeDeps(new Set(["wf-handover"])).deps, { graceWindowMs: grace, now: now + 2 * 86_400_000 });
    expect(r3.skippedReferenced).toBe(1);

    // 全程三件不删（record 流 + manifest + 旧双源；残锁同）
    for (const name of footprintNames("wf-handover")) expect(fileExists(name)).toBe(true);
    expect(readRegistry()).toEqual({});
  });

  it("引用集采集失败 → 整轮跳过（宁保留——引用状态不可知不删）", async () => {
    seedRunFootprint("wf-unknown");
    const { deps, warnCalls } = makeDeps(new Error("session pool scan failed"));

    const result = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 0, now: 1_700_000_000_000 });

    expect(result).toMatchObject({ scanned: 1, reaped: 0, skippedReferenced: 0, skippedGraceWindow: 0 });
    for (const name of footprintNames("wf-unknown")) expect(fileExists(name)).toBe(true);
    expect(warnCalls.some((m) => m.includes("alive reference collection failed"))).toBe(true);
    // 无登记写达（引用不可知 ≠ 判无主——不进观察期）
    expect(readRegistry()).toEqual({});
  });
});

describe("登记文件损坏路径（观测面 + 一次性自愈）", () => {
  /** 把登记文件写坏（非法 JSON——readOrphanReapRegistry 的损坏读形态）。 */
  function corruptRegistry(): void {
    fs.writeFileSync(path.join(stateDir, "orphan-run-reap.json"), "{corrupted-not-json", "utf8");
  }

  it("一次性损坏自愈：损坏轮按空重登记（超窗孤儿宽限窗重起不删），轮末原子重写为合法 JSON；次轮重置窗内仍不删", async () => {
    seedRunFootprint("wf-stale");
    const now = 1_700_000_000_000;
    const grace = 604_800_000;
    // 预置正常登记：首判在 8 天前（超 7 天宽限窗——若无损坏，本轮即删）
    fs.writeFileSync(
      path.join(stateDir, "orphan-run-reap.json"),
      JSON.stringify({ "wf-stale": now - 8 * 86_400_000 }),
      "utf8",
    );
    ageFootprint("wf-stale", now - 8 * 86_400_000); // 与门第二臂同样满足（mtime 距 now 8 天）
    corruptRegistry(); // 跑前写坏——「预置超窗登记 + 损坏读」的合成形态
    const { deps } = makeDeps(new Set<string>());

    // 损坏轮：读坏 → 空表重登记 → 宽限窗重起（firstSeen = 损坏轮时刻）→ 不删
    const first = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: grace, now });
    expect(first).toMatchObject({ scanned: 1, skippedGraceWindow: 1, reaped: 0 });
    for (const name of footprintNames("wf-stale")) expect(fileExists(name)).toBe(true);
    // 登记锚重置为损坏轮时刻；readRegistry 的 JSON.parse 不 throw = 轮末原子重写已落合法 JSON
    expect(readRegistry()).toEqual({ "wf-stale": now });

    // 次轮（登记已合法）：重置后的宽限窗内（3 天 < 7 天）仍不删，登记锚不漂移
    const second = await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: grace, now: now + 3 * 86_400_000 });
    expect(second.reaped).toBe(0);
    for (const name of footprintNames("wf-stale")) expect(fileExists(name)).toBe(true);
    expect(readRegistry()).toEqual({ "wf-stale": now });
  });

  it("损坏读 warn 出声：消息含登记文件路径与空重登记语义（观测面——损坏循环可见）", async () => {
    seedRunFootprint("wf-corrupt");
    corruptRegistry();
    const { deps, warnCalls } = makeDeps(new Set<string>());

    await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 604_800_000, now: 1_700_000_000_000 });

    const msg = warnCalls.find((m) => m.includes("orphan-run-reap.json"));
    expect(msg).toBeDefined();
    expect(msg).toContain("re-registering");
  });

  it("ENOENT 静默：无登记文件的首轮不出损坏 warn（不存在 = 正常空态，非损坏）", async () => {
    seedRunFootprint("wf-fresh");
    const { deps, warnCalls } = makeDeps(new Set<string>());

    await reapOrphanRuns({ stateDir }, deps, { graceWindowMs: 604_800_000, now: 1_700_000_000_000 });

    expect(warnCalls).toEqual([]);
  });
});

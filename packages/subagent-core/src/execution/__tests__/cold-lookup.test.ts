// src/execution/__tests__/cold-lookup.test.ts
//
// [D4-③] coldLookupForAction 单元测试（依赖注入直测）。
//
// 背景：冷查链自 SubagentService 搬移后按 ColdLookupDeps 依赖注入设计，此前仅有经
// subagent-service 集成路径的 running 重建覆盖——closed 可重连候选的「恢复失败守卫 /
// 部分恢复回边」（assertReconnectAllowed / resurrectColdRecord 的 wasClosed 分支）
// 零直测。[H1 U6] 文件随 cold-resurrect.ts → cold-lookup.ts 改名（chatMode 无条件
// 置位语义迁 Continuation D4 revive 格 + D5 gate，重建只水合持久化 chatMode）。
// 本文件锁定这些路径的可观察行为：
//   - 恢复失败：worktree 绑定丢失 / 异进程活实例（closed 与 running 候选）→
//     ResurrectDeniedError 且内存无残留（register 不被调用）；
//   - 部分恢复：closed 可重连记录 → resurrectClosed 回边翻回 running + 磁盘终态位
//     同步翻转（.state（L4 现行终态载体）与 legacy .finalized 删除 + .alive 刷新当前
//     进程）+ register/transition 上报——[U2a/B4] 回边三件套整体收编
//     store.markResurrected（deps 注入真实 RecordStore 实例承载）；
//   - [B4/D3c] 恢复源缺失（sessionFile 缺失 / marker 写失败）→ 响亮抛错中止重生主流程
//     （旧「单 try 吞错续跑」形态消灭——acquire 失败 = 双写风险敞口，§3.4）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAliveMarker, writeAliveMarker } from "../alive-store.ts";
import { COLD_LOOKUP_SCAN_LIMIT, coldLookupForAction, type ColdLookupDeps } from "../cold-lookup.ts";
import { RecordStore } from "../record-store.ts";
import type { SubagentRecord } from "../types.ts";
import { ResurrectDeniedError } from "../types.ts";

/** [U1/A4] 「异进程且存活」的确定性模拟 pid：1 号进程（launchd/init）必然存在且非
 *  本测试进程——kill(1, 0) 对普通用户返回 EPERM，isProcessAlive 按「存在但无权限」
 *  保守判活（self-pid 排除后不能再以本进程 pid 模拟异进程实例）。 */
const FOREIGN_LIVE_PID = 1;

/** 磁盘/索引侧候选记录（SubagentRecord 最小合法形状 + closed 可重连缺省）。 */
function makeFound(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-cold-1",
    agent: "general-purpose",
    task: "cold recovery task",
    slug: "cold-test",
    status: "closed",
    closedReason: "parent-shutdown",
    mode: "background",
    startedAt: 1_700_000_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 1_700_000_100_000,
    turns: 0,
    totalTokens: 0,
    model: "test/model-a",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...overrides,
  };
}

interface DepOverrides {
  /** findLightById（idToFile 索引直查）返回值。 */
  direct?: SubagentRecord;
  /** collectRecords（磁盘全扫）返回清单。 */
  disk?: SubagentRecord[];
  /** getSessionRootId 返回值（归属校验）。 */
  rootId?: string;
  /** getBaselineRecordId 返回值（直接父校验）。 */
  baseline?: string;
}

/** 构造依赖注入桩。markResurrected 经真实 RecordStore 承载（[U2a/B4] 回边收编 store
 *  原语——磁盘三件套/内存翻回/register 需真实落盘语义，stub 无法验证）；register 用
 *  spy 包住 store.register 供「内存无残留」断言（markResurrected 内部 register 与
 *  spy 同一入口）。sessionsDir 经 beforeEach 刷新（describe 作用域变量模块级桥接）。 */
let currentSessionsDir = "";
function makeDeps(o: DepOverrides = {}): ColdLookupDeps {
  const store = new RecordStore(currentSessionsDir);
  const registerSpy = vi.spyOn(store, "register");
  return {
    findLightById: vi.fn(() => o.direct),
    collectRecords: vi.fn(() => o.disk ?? []),
    register: registerSpy,
    reportRecordTransition: vi.fn(),
    markResurrected: (record, wasClosed) => store.markResurrected(record, wasClosed),
    getSessionRootId: vi.fn(() => o.rootId ?? "root-session"),
    getBaselineRecordId: vi.fn(() => o.baseline),
  };
}

describe("[D4-③] coldLookupForAction 冷查/复活链", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-lookup-"));
    currentSessionsDir = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** tmpdir 下建 session 文件 + 可选终态 sidecar（.state / legacy .finalized）+ 可选
   *  .alive sidecar，返回 sessionFile 路径。 */
  function writeSessionFixture(
    opts: { state?: string; finalized?: string; aliveMarker?: string } = {},
  ): string {
    const sessionFile = path.join(dir, "20260901T000000-000_sa-cold-1.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    if (opts.state !== undefined) {
      fs.writeFileSync(`${sessionFile}.state`, opts.state, "utf-8");
    }
    if (opts.finalized !== undefined) {
      fs.writeFileSync(`${sessionFile}.finalized`, opts.finalized, "utf-8");
    }
    if (opts.aliveMarker !== undefined) {
      fs.writeFileSync(`${sessionFile}.alive`, opts.aliveMarker, "utf-8");
    }
    return sessionFile;
  }

  // ── 部分恢复（closed 可重连 → 透明重生回边）──

  it("closed 可重连记录（parent-shutdown）+ allowReconnect → 重生翻回 running：终态位清除、sidecar 翻转、register + transition 上报", () => {
    const sessionFile = writeSessionFixture({ finalized: JSON.stringify({ reason: "parent-shutdown" }) });
    const found = makeFound({ sessionFile, round: 2 });
    const deps = makeDeps({ disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    // 重生回边：closed → running，终态语义位清除
    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined();
    expect(record.endedAt).toBeUndefined();
    // [v4 A-3 → H1 U6 / D4-D5] 水合保留持久化 chatMode：候选未持久化 chatMode
    //（undefined）→ 重建 false（升级置位归 Continuation revive 格 + gate，不在重建层）
    expect(record.chatMode).toBe(false);
    // 身份/续聊字段从磁盘候选回填
    expect(record.sessionFile).toBe(sessionFile);
    expect(record.round).toBe(2);
    expect(record.model).toBe("test/model-a");
    expect(record.hadWorktree).toBe(false);
    // register + [v8.5 D] 重生后立刻上报 transition entry（live ≡ reload）
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledWith(record);
    // [review MF-8] 磁盘终态位同步翻转：.finalized 删除 + .alive 刷新为当前进程
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "sa-cold-1" });
    // 冷查扫描契约：全目录兜底按 COLD_LOOKUP_SCAN_LIMIT 上限扫全量（无 root 过滤）
    expect(vi.mocked(deps.collectRecords)).toHaveBeenCalledWith(COLD_LOOKUP_SCAN_LIMIT, "all", undefined);
  });

  it("[L4] 磁盘 .state（现行终态载体）+ legacy .finalized 残留 → 重生回边两者同步删除（否则磁盘扫描翻回 closed）", () => {
    // [review MF-8] 残留任一终态 sidecar 都会让 record-store buildRecord 终态分支
    // （分支 1，.state 优先 / 旧名兼容归一）压过 .alive 活态分支——reload / 异进程 /
    // session-reader 全部把 running record 报成 closed，并为跨进程二次 resurrect 开门。
    const sessionFile = writeSessionFixture({
      state: JSON.stringify({ status: "finalized", reason: "parent-shutdown" }),
      finalized: JSON.stringify({ reason: "parent-shutdown" }),
    });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, closedReason: "parent-shutdown" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined();
    // 终态 sidecar 双双清除（现行 .state + legacy .finalized），磁盘扫描不再翻回 closed
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.reportRecordTransition)).toHaveBeenCalledTimes(1);
  });

  it("负向对照：重生被守卫拒绝（worktree 绑定丢失）→ 终态 sidecar 不被误删", () => {
    // 守卫先于任何状态突变与副作用（[v8.5 D] / [review MF-9]）：拒绝路径不得触碰磁盘
    const sessionFile = writeSessionFixture({
      state: JSON.stringify({ status: "finalized", reason: "parent-shutdown" }),
      finalized: JSON.stringify({ reason: "parent-shutdown" }),
    });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, worktree: true })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);

    expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);
    expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("idToFile 索引直查返回非 running 态 → 回退磁盘全扫兜底定位（closed 候选仍可重连）", () => {
    const sessionFile = writeSessionFixture();
    const found = makeFound({ sessionFile });
    // direct 命中但 status=closed → 不直接采用，落到 collectRecords 兜底
    const deps = makeDeps({ direct: found, disk: [found] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.collectRecords)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register)).toHaveBeenCalledWith(record);
  });

  it("候选持久化 chatMode=true（chat 容器）→ 水合保留 true（续聊直接走，无需升级格）", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running", chatMode: true })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(record.chatMode).toBe(true);
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  it("closed disconnected（.finalized 空内容兜底死因）同样落在可重连集内", () => {
    const sessionFile = writeSessionFixture({ finalized: "" });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, closedReason: "disconnected" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  // ── 恢复失败守卫（ResurrectDeniedError + 内存无残留）──

  it("worktree 绑定丢失（跨重启 WorktreeHandle 不可序列化）→ ResurrectDeniedError 拒绝，register 不残留", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, worktree: true })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/worktree isolation/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("closed 候选仍有异进程活实例（.alive 指向活 pid）→ 拒绝双写，register 不残留", () => {
    // [U1/A4] 探针已补 self-pid 排除——「异进程」模拟不能再用本测试进程 pid，改用
    // 恒活的外部 pid 1（launchd/init：kill(1,0) → EPERM → isProcessAlive 判活为真）。
    const sessionFile = writeSessionFixture();
    writeAliveMarker(sessionFile, { pid: FOREIGN_LIVE_PID, id: "sa-cold-1", startedAt: Date.now() });
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /still finishing in another process/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("running 候选仍有异进程活实例（父进程重启后旧子进程尚存窗口）→ 拒绝并给恢复指引", () => {
    const sessionFile = writeSessionFixture();
    writeAliveMarker(sessionFile, { pid: FOREIGN_LIVE_PID, id: "sa-cold-1", startedAt: Date.now() });
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running" })] });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(ResurrectDeniedError);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /currently running in another process instance/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("损坏 .alive marker（无法解析）→ 视为确死放行重生，marker 被当前进程覆盖写", () => {
    const sessionFile = writeSessionFixture({
      finalized: JSON.stringify({ reason: "parent-shutdown" }),
      aliveMarker: "{not valid json",
    });
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid });
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });

  // ── 候选过滤 / 归属与父层校验 ──

  it.each([
    ["自然完成死因 gc", makeFound({ closedReason: "gc" })],
    ["用户主动 close", makeFound({ closedReason: "user-close" })],
  ])("不可重连死因（%s）→ 磁盘也无候选，返回 undefined", (_label, found) => {
    const deps = makeDeps({ disk: [found] });

    expect(coldLookupForAction(deps, "sa-cold-1", true)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("allowReconnect=false：closed 候选一律不可见（running-only 查询语义）", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    expect(coldLookupForAction(deps, "sa-cold-1", false)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("rootSessionId 不匹配 → 返回 undefined（不区分失败形态，防跨 session 探测）", () => {
    const deps = makeDeps({ disk: [makeFound({ rootSessionId: "other-root" })], rootId: "root-session" });

    expect(coldLookupForAction(deps, "sa-cold-1", true)).toBeUndefined();
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("parentRecordId 跨层不匹配（候选有直接父）→ 原样抛 direct parent 错误（跨层导航指引）", () => {
    const deps = makeDeps({
      disk: [makeFound({ status: "running", parentRecordId: "sa-parent" })],
      baseline: undefined,
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/is owned by its direct parent/);
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/parent=sa-parent/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  it("顶层候选（parentRecordId 缺失）遇嵌套进程 baseline → direct parent 错误带 (root layer) 回显", () => {
    const deps = makeDeps({
      disk: [makeFound({ status: "running", parentRecordId: undefined })],
      baseline: "rec-baseline-child",
    });

    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /parent=\(root layer\)/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
  });

  // ── 恢复源缺失（[B4/D3c] 响亮失败——吞错续跑形态消灭）──

  it("[B4] sessionFile 缺失的 closed 候选 → markResurrected 响亮抛错中止重生（无锚点无法声明写权）", () => {
    const deps = makeDeps({ disk: [makeFound({ sessionFile: undefined })] });

    // acquire 失败 = 双写风险敞口，禁止 best-effort 吞错续跑（§3.4/D3c——旧形态
    // 「跳过 sidecar 翻转、重生照常完成」随回边收编消灭：无锚点的 running record
    // 缺跨进程写权声明，正是 D3 要防的事故形态入口）。
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(/no sessionFile anchor/);
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.reportRecordTransition)).not.toHaveBeenCalled();
  });

  it("[B4] sidecar 翻转失败（sessionFile 所在目录不存在，writeAliveMarker ENOENT）→ 响亮中止，终态位未被误删", () => {
    // 恢复源缺失形态：sessionFile 指向已消失的目录（推导路径过期 / 目录被清理）
    const sessionFile = path.join(dir, "vanished-dir", "20260901T000000-000_sa-cold-1.jsonl");
    // 离线预置终态位（目录存在时才可写——改为断言 acquire-first 失败后磁盘保持旧形态
    // 的推演基础：无终态位可删的目录缺失形态下，响亮失败即全部可观察行为）
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });

    // acquire-first 写权声明失败 → 整体响亮抛错（单 try 域原子收敛，D3c）。
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow(
      /write-lease acquire\/terminal-position flip failed/,
    );
    expect(vi.mocked(deps.register)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.reportRecordTransition)).not.toHaveBeenCalled();
    // marker 写入确实失败（目录不存在，未落盘）
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });

  it("[B4/D3c] acquire-first 失败后磁盘保持旧形态（终态位未删，重生可重试）", () => {
    // acquire 成功但终态位删除失败不可构造（rmSync force 幂等）——验证 acquire-first
    // 顺序的可观察等价面：目录存在 + 终态位在，marker 写成功路径下才执行删除。
    // 本用例钉失败方向的可重试性：closed 候选 + 守卫通过 + 目录消失 → 响亮中止后
    // .state 残留形态不变（无「半翻」状态）。
    const sessionFile = path.join(dir, "gone", "20260901T000000-000_sa-cold-1.jsonl");
    const deps = makeDeps({ disk: [makeFound({ sessionFile })] });
    expect(() => coldLookupForAction(deps, "sa-cold-1", true)).toThrow();
    // 磁盘面零触碰（目录本不存在——构造性「保持旧形态」）
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("[B4/D3c] running 候选接管（wasClosed=false）→ 仍 acquire marker（接管即声明，B/C 双写窗闭合）", () => {
    const sessionFile = writeSessionFixture();
    const deps = makeDeps({ disk: [makeFound({ sessionFile, status: "running" })] });

    const record = coldLookupForAction(deps, "sa-cold-1", true)!;

    expect(record.status).toBe("running");
    // 「接管即声明」：running 接管形态无终态位可删，但 acquire 照做——A 崩溃（marker
    // pid 死）→ B 接管刷新 pid=B → C 再触达被拦（S8⑤ 验收锚点的磁盘面前置）。
    expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "sa-cold-1" });
    expect(vi.mocked(deps.register)).toHaveBeenCalledTimes(1);
  });
});

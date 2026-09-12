// doFinalizeRecord — manifest status 透传 + [U2a] 终态四件套归口 store 意图原语测试。
//
// 验证 finalize-record.ts 的 status 映射：done→completed, failed→failed, cancelled→cancelled
// （cancelled 不再归并 failed）。crashed 不进 finalize 入参（TS 签名锁定 done/failed/cancelled）。
//
// [U2a/B1] 终态持久化四件套（.state/binding/archive/manifest/.alive 删）归口
// store.markFinalized / markCancelled——测试面相应切换为真实 RecordStore 承载
// （manifestDir 接线第 4 构造参数 → 终态 manifest writeSync 同步落盘，D8 v7）；
// manifest 写失败路径走缺省降级（manifestStore 异步 + mock 注入 throw）。
// [B5] doFinalizeRoundToIdle 簿记归口 store.markRoundIdle：record 须先 register 进
// store 内存（markRoundIdle 按 id 查内存），轮终 `.alive` 保留（D3a 跨轮延续）。
//
// FinalizeDeps 其余 stub 注入（manifestStore 为真实实例,指向 tmpDir）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.error 可被 spy（源码已从 console.error 改为 logger.error）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

// [B1] state-marker 写面 mock（默认透传真实实现）：终态写失败（重试耗尽返回 false）
// 用例经 vi.mocked(writeFinalizedState).mockReturnValueOnce(false) 注入——绕开真实
// 重试 3 次 ×100ms 指数退避的墙钟等待。
vi.mock("../state-marker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state-marker.ts")>();
  return {
    ...actual,
    writeFinalizedState: vi.fn(actual.writeFinalizedState),
    writeCancelledState: vi.fn(actual.writeCancelledState),
  };
});

import { writeFinalizedState } from "../state-marker.ts";

import { doFinalizeRecord, doFinalizeRoundToIdle } from "../finalize-record.ts";
import { ManifestStore } from "../manifest-store.ts";
import { RecordStore } from "../record-store.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import type { AgentResult, ExecutionRecord, WorktreeHandle } from "../types.ts";

function makeMinimalRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "finalize-test",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "test",
    startedAt: 1000,
    rootSessionId: "session-main",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    sessionFile: undefined,
    controller: undefined,
    ...overrides,
  } as ExecutionRecord;
}

function makeMinimalResult(): AgentResult {
  return {
    text: "done",
    turns: 1,
    durationMs: 100,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
  };
}

describe("doFinalizeRecord — manifest status 透传 (M3 4 态)", () => {
  let tmpDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
    manifestStore = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 构造最小 FinalizeDeps。[U2a/B1] store = 真实 RecordStore（manifestDir 第 4 参数
   *  接线 → markFinalized/markCancelled 的终态 manifest writeSync 同步落盘）；pi 经
   *  构造注入（reportRecordTransition/写失败 entry 上报可断言）。
   *  @param opts.syncManifest false = 不接 manifestDir（manifest 走 manifestStore 异步
   *  降级——manifest 写失败用例 mock manifestStore.writeManifest 注入 throw 用）。 */
  function makeDeps(opts: { syncManifest?: boolean } = {}): Parameters<typeof doFinalizeRecord>[0] {
    const pi = { appendEntry: vi.fn() };
    const store = new RecordStore(
      tmpDir,
      manifestStore,
      pi,
      opts.syncManifest === false ? undefined : tmpDir,
    );
    return {
      worktreeManager: {},
      store,
      modelService: {},
      pi,
      emitUnregister: vi.fn(),
    } as unknown as Parameters<typeof doFinalizeRecord>[0];
  }

  it("status=closed + cancelled reason → manifest 写 closed（v4 B-1：cancelled 折入 closed）", async () => {
    const record = makeMinimalRecord({ id: "rec-cancelled" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "cancelled");

    const manifest = await manifestStore.readManifest("rec-cancelled");
    expect(manifest).not.toBeNull();
    // 关键断言：v4 B-1 manifest status 恒写 closed（cancelled 区分靠 tombstone sidecar）
    expect(manifest?.status).toBe("closed");
  });

  it("status=closed + user-close → manifest 写 closed", async () => {
    const record = makeMinimalRecord({ id: "rec-done" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "user-close");

    const manifest = await manifestStore.readManifest("rec-done");
    expect(manifest?.status).toBe("closed");
  });

  it("status=closed + gc → manifest 写 closed", async () => {
    const record = makeMinimalRecord({ id: "rec-failed" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "gc");

    const manifest = await manifestStore.readManifest("rec-failed");
    expect(manifest?.status).toBe("closed");
  });

  it("[M2 Gate B] closedReason 随 manifest 持久化（manifest 源快照三分流唯一依据）", async () => {
    // 曾不携带 closedReason：sessionFile 未回填 / sidecar 缺席形态下，重启后 manifest
    // 源重建的快照丢死因，endedMessageGuard 把 user-close/cancelled 误分流进
    // 「reconnectable/fork-from」分支。
    for (const closedReason of ["user-close", "cancelled", "parent-shutdown", "gc"] as const) {
      const id = `rec-reason-${closedReason}`;
      await doFinalizeRecord(makeDeps(), makeMinimalRecord({ id }), makeMinimalResult(), "closed", closedReason);
      const manifest = await manifestStore.readManifest(id);
      expect(manifest?.status).toBe("closed");
      expect(manifest?.closedReason).toBe(closedReason);
    }
  });

  it("manifest write 抛错时 cleanup-first 顺序仍执行（终态原语内 .state 先于 manifest）", async () => {
    // record 带 sessionFile 让终态原语走真实 .state/.alive 路径；
    // 不设 worktreeHandle → Step 0 (collectPatch) 和 worktree cleanup 都跳过。
    // [U2a] manifest 写失败经 store 内部 fire-and-forget catch（record-store
    // reportManifestWriteFailure：logger.error + subagent:manifest-write-failed entry），
    // 不 throw 不跳过编排层后续步骤——对齐 [Critical #1]（manifest 是反查索引非正确性
    // 依赖）。走异步降级（syncManifest:false——同步 writeAtomicFileSync 路径不经
    // manifestStore.writeManifest，mock 无法注入）。
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const record = makeMinimalRecord({ id: "rec-cleanup-first", sessionFile });

    // 预写 .alive marker（让 removeAliveMarker 真实生效；不预写因 ENOENT 静默也 OK，
    // 但预写后用 fs.existsSync 验证更直观）。
    fs.writeFileSync(
      `${sessionFile}.alive`,
      `${JSON.stringify({ pid: 99999, id: "rec-cleanup-first", startedAt: 1000 })}\n`,
      "utf-8",
    );

    // mock writeManifest 抛错（模拟 disk full）。在 mock 内捕获「writeManifest 被调用时
    // finalized marker 是否已存在」——这是终态原语内部写序的关键断言：D8 v7 要求
    // `.state` writeSync 先、manifest 后（若有人反转写序，本标志会是 false）。
    const finalizedBeforeManifestWrite = { value: false };
    vi.spyOn(manifestStore, "writeManifest").mockImplementation(async () => {
      finalizedBeforeManifestWrite.value = fs.existsSync(`${sessionFile}.state`);
      throw new Error("disk full");
    });
    loggerMock.error.mockClear();

    const deps = makeDeps({ syncManifest: false });

    // ── 核心 claim 1：不抛错（manifest 写失败在 store 内部被吞，不 throw）──
    await expect(
      doFinalizeRecord(deps, record, makeMinimalResult(), "closed"),
    ).resolves.toBeUndefined();

    // ── 核心 claim 2：终态权威 .state 真实写入 ──
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);

    // ── 核心 claim 3：.alive 被移除（release 出口①——预写的 .alive 不再存在）──
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);

    // ── 核心 claim 4：pending-notifications 注销仍触发（emitUnregister）──
    expect(deps.emitUnregister).toHaveBeenCalledWith("rec-cleanup-first", "closed");

    // ── 核心 claim 5：manifest 写失败被 logger.error 记录（store 内 reportManifestWriteFailure）──
    await vi.waitFor(() => {
      expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining("manifest write failed"));
    });
    const errMsg = loggerMock.error.mock.calls[0]?.[0];
    expect(errMsg).toContain("rec-cleanup-first");
    expect(errMsg).toContain("disk full");

    // ── 核心 claim 6：pi.appendEntry 记录 "subagent:manifest-write-failed" 事件 ──
    expect(deps.pi!.appendEntry).toHaveBeenCalledWith(
      "subagent:manifest-write-failed",
      expect.objectContaining({ id: "rec-cleanup-first", error: "disk full" }),
    );

    // ── 核心 claim 7：manifest 实际未写入（writeManifest 抛错被吞咽）──
    expect(await manifestStore.readManifest("rec-cleanup-first")).toBeNull();

    // ── 核心 claim 8：[D8 v7] 终态原语内部写序 —— .state 先于 manifest ──
    // 若有人把 manifest 写前移到 .state 之前，mock 捕获时刻 .state 尚未写入，
    // 本标志会是 false（D8 写序不变量：终态权威优先落）。
    expect(finalizedBeforeManifestWrite.value).toBe(true);

    // 清理 mock 调用记录防污染
    vi.restoreAllMocks();
    loggerMock.error.mockClear();
  });

  it("[B1/§3.4] markFinalized 返回 false（.state 重试耗尽）→ 响亮 entry 上报 + 零持久化副作用 + cleanup 编排不跳过", async () => {
    // 终态写失败（磁盘满/权限）语义：record 留 running（磁盘无终态位、不 archive、
    // 不删 .alive），GUI 通知面腿 = subagent:state-write-failed entry（日志 error 腿
    // 由 state-marker/store 层完成，此处断言编排层接线）；worktree cleanup 等
    // 副作用继续（幂等，不可被写失败跳过——否则 worktree 泄漏）。
    vi.mocked(writeFinalizedState).mockReturnValueOnce(false);
    const sessionFile = path.join(tmpDir, "session-fail.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    fs.writeFileSync(
      `${sessionFile}.alive`,
      `${JSON.stringify({ pid: process.pid, id: "rec-write-fail", startedAt: 1000 })}\n`,
      "utf-8",
    );
    const record = makeMinimalRecord({ id: "rec-write-fail", sessionFile });
    const deps = makeDeps();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    (deps as { worktreeManager: unknown }).worktreeManager = { cleanup };
    // 「record 留 running」口径（U1 偏差 5）= 磁盘面（无 .state）+ 不 archive：
    // record 未 register 进内存（doFinalizeRecord 不 register），未 archive 以 spy 钉。
    const archiveSpy = vi.spyOn(deps.store as RecordStore, "archive");

    await expect(
      doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "gc"),
    ).resolves.toBeUndefined();

    // 响亮 entry 上报（§3.4 GUI 通知面——U1 偏差 6 的接线点）
    expect(deps.pi!.appendEntry).toHaveBeenCalledWith(
      "subagent:state-write-failed",
      expect.objectContaining({ id: "rec-write-fail", status: "closed", closedReason: "gc" }),
    );
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("terminal state write failed"),
    );
    // 零持久化副作用（D8 失败语义）：无 .state / 无 manifest / .alive 未删 / 未 archive
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    expect(await manifestStore.readManifest("rec-write-fail")).toBeNull();
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
    expect(archiveSpy).not.toHaveBeenCalled();
    // 副作用编排继续：worktree cleanup / emitUnregister 不被写失败跳过
    expect(cleanup).toHaveBeenCalledTimes(0); // 本用例 record 无 worktreeHandle
    expect(deps.emitUnregister).toHaveBeenCalledWith("rec-write-fail", "closed");
    loggerMock.error.mockClear();
  });

  // ── [T1/PS-9] sessionFile 缺失 → sessionDir 反查后 marker/alive 清理仍落地 ──
  //
  // PS-9：finalize 的 tombstone/finalized sidecar 与 removeAliveMarker 全部 gated on
  // record.sessionFile——RC-1（握手失败）+ LC-4（收尾反查未命中）的残余形态下，
  // 「sessionFile 缺失 → 终态原因丢失 + alive marker 残留」。修复：sessionFile 缺失时
  // 用 deps.sessionDir 按 identity（record.id）反查真实 session 文件作依据。
  // 真实 fs + tmp 目录（与文件既有策略一致）：session JSONL 写入 identity custom entry
  //（子进程 session_start hook 的写入形态），readIdentityHeader/readIdentityTail 真实解析。
  describe("[T1/PS-9] sessionFile 缺失 sessionDir 反查", () => {
    let sessionDir: string;

    beforeEach(() => {
      sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-ps9-sessions-"));
    });

    afterEach(() => {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    /** 在 sessionDir 写入带 identity 的 session 文件（1 行 identity entry，位于头部）。 */
    function writeSessionFileWithIdentity(fileName: string, recordId: string): string {
      const sessionFile = path.join(sessionDir, fileName);
      const identityEntry = JSON.stringify({
        type: "custom",
        customType: "subagent-identity",
        data: { id: recordId, agent: "worker", mode: "background", task: "t", startedAt: 1000 },
      });
      fs.writeFileSync(sessionFile, `${identityEntry}\n`, "utf-8");
      return sessionFile;
    }

    it("sessionFile 缺失 + 反查命中 → .state 落盘 + .alive 清理 + record/manifest 回填", async () => {
      const sessionFile = writeSessionFileWithIdentity("20260901T12000000_ps9.jsonl", "rec-ps9");
      // 预写 .alive 残留（模拟 running 期崩溃恢复窗口的 marker）
      fs.writeFileSync(
        `${sessionFile}.alive`,
        `${JSON.stringify({ pid: 99999, id: "rec-ps9", startedAt: 1000 })}\n`,
        "utf-8",
      );
      const record = makeMinimalRecord({ id: "rec-ps9", sessionFile: undefined });
      const deps = { ...makeDeps(), sessionDir };

      await doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "gc");

      // 反查回填 record.sessionFile
      expect(record.sessionFile).toBe(sessionFile);
      // 终态原因持久化不再丢失（closedReason gc 写入 .state 的 reason 字段）
      expect(JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8"))).toEqual({
        status: "finalized",
        reason: "gc",
      });
      // alive marker 不再残留
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
      // manifest 拿到真实 sessionFile（诊断/重建源不再失真）
      const manifest = await manifestStore.readManifest("rec-ps9");
      expect(manifest?.sessionFile).toBe(sessionFile);
    });

    it("cancelled + 反查命中 → cancelled 终态写反查路径（语义不因 sessionFile 缺失丢失）", async () => {
      const sessionFile = writeSessionFileWithIdentity("20260901T12000001_ps9c.jsonl", "rec-ps9c");
      const record = makeMinimalRecord({ id: "rec-ps9c", sessionFile: undefined });
      const deps = { ...makeDeps(), sessionDir };

      await doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "cancelled");

      expect(record.sessionFile).toBe(sessionFile);
      const marker = JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as {
        status: string;
        endedAt: number;
      };
      expect(marker.status).toBe("cancelled");
      expect(typeof marker.endedAt).toBe("number");
    });

    it("反查未命中（目录无 identity 匹配文件）→ 不抛、sessionFile 保持缺失、无 marker（行为退回修复前）", async () => {
      // sessionDir 存在但内容与 record 不匹配
      writeSessionFileWithIdentity("20260901T12000000_other.jsonl", "rec-someone-else");
      const record = makeMinimalRecord({ id: "rec-ps9-miss", sessionFile: undefined });
      const deps = { ...makeDeps(), sessionDir };

      await expect(
        doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "gc"),
      ).resolves.toBeUndefined();

      expect(record.sessionFile).toBeUndefined();
      // manifest sessionFile 同步保持 undefined
      const manifest = await manifestStore.readManifest("rec-ps9-miss");
      expect(manifest?.sessionFile).toBeUndefined();
      loggerMock.error.mockClear();
    });
  });

  // ── Step 3a 判别 wiring：closedReason → .state 单一终态 sidecar（L4 合并后）──
  //
  // record 带 sessionFile 直接命中 writeTerminalState 的判别分支：
  //   cancelled → .state {status:"cancelled", endedAt}（重建还原 cancelled 语义 + 精确结束时间）
  //   其余 reason → .state {status:"finalized", reason}（真实 reason 进 sidecar，重建还原 closedReason）
  // 单文件单 status 字段 → 互斥构造性成立；兼容期旧名（.finalized/.cancelled）不再被写。
  describe("writeTerminalState 判别 wiring（closedReason → .state status）", () => {
    it("closedReason=cancelled → .state 携带 status/endedAt 且不写旧名 sidecar", async () => {
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const record = makeMinimalRecord({
        id: "rec-wire-cancelled",
        sessionFile,
        // 预设 endedAt 会被 Step 1 completeRecord 冻结值覆盖（见下方 endedAt 断言注释）
        endedAt: 5678,
      });

      await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", "cancelled");

      // .state 写出且内容为终态 marker（字段逐项断言，不用 objectContaining 放宽——
      // 重建链路靠这些字段还原）
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as {
        status: string;
        endedAt: number;
      };
      expect(marker.status).toBe("cancelled");
      // endedAt 来自 completeRecord 冻结后的 record.endedAt（Step 1 先于 Step 3a，
      // record 预设的 endedAt 会被冻结值覆盖）——sidecar 携带真实收尾时间戳
      expect(marker.endedAt).toBe(record.endedAt);
      expect(typeof marker.endedAt).toBe("number");
      // 兼容期旧名不再被写（写侧单点收敛）
      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
      expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(false);
    });

    it.each(["user-close", "gc"] as const)(
      "closedReason=%s → .state 内容携带真实 reason 且不写旧名 sidecar",
      async (reason) => {
        const sessionFile = path.join(tmpDir, "session.jsonl");
        const record = makeMinimalRecord({ id: `rec-wire-${reason}`, sessionFile });

        await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "closed", reason);

        // .state 写出且 reason = 真实关因（磁盘重建用它还原 closedReason，
        // 不再一律硬编码 gc）
        expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);
        expect(JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8"))).toEqual({
          status: "finalized",
          reason,
        });
        // 兼容期旧名不再被写
        expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(false);
        expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
      },
    );
  });

  // ── Step 0 collectPatch wiring：worktreeHandle 置位 → patch 收集 + patchFile 回填 ──
  //
  // [MF#3] patchFile 必须写到 worktree 之外（sessionsDir/<branch>.patch），避免被
  // cleanup 删除；仅 patch.written=true（diff 非空且写盘成功）才回填 record.patchFile，
  // 避免悬空路径让 `git apply` 打不存在的文件。
  describe("collectPatchIfWorktree wiring（worktreeHandle 置位 + patch.written 回填）", () => {
    // agentDir 是真实写目标：finalize-record Step 0 对 sessionsDir 做 mkdirSync(recursive)，
    // 会在 agentDir 下创建整棵 subagents/<enc>/sessions 树。必须 mkdtemp 自建 + afterEach
    // 清理（测试红线），禁止硬编码真实 /tmp 路径。mainCwd / handle.path 仅作编码键与
    // startsWith 断言，源码不落盘，保持字面量即可。
    let agentDir: string;

    beforeEach(() => {
      agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-patch-agent-"));
    });

    afterEach(() => {
      fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    const mainCwd = "/tmp/collect-patch-main-repo";
    const branch = "subagent-b1";
    const handle: WorktreeHandle = {
      path: "/tmp/collect-patch-checkout",
      branch,
      baseCommit: "abc123",
      mainCwd,
    };

    function makeWorktreeDeps(
      collectPatch: ReturnType<typeof vi.fn>,
    ): ReturnType<typeof makeDeps> & { agentDir: string } {
      // 覆写 worktreeManager / modelService 为 stub（与外层 makeDeps 同款 unknown 断言——
      // FinalizeDeps 的 ModelConfigService/WorktreeManager 是宽接口，stub 只需覆盖本次路径）
      return {
        ...makeDeps(),
        modelService: { getAgentDir: () => agentDir },
        worktreeManager: { collectPatch, cleanup: vi.fn() },
        agentDir,
      } as unknown as ReturnType<typeof makeDeps> & { agentDir: string };
    }

    it("patch.written=true → collectPatch 收到 handle + sessionsDir/<branch>.patch，record.patchFile 回填", async () => {
      const { agentDir, ...deps } = makeWorktreeDeps(vi.fn().mockResolvedValue({
        patchFile: "/ignored/collector-picked-path.patch",
        failed: false,
        written: true,
      }));
      const sessionsDir = getSubagentSessionDir(agentDir, mainCwd);
      const expectedPatchFile = path.join(sessionsDir, `${branch}.patch`);
      const record = makeMinimalRecord({ id: "rec-patch", worktreeHandle: handle });

      await doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "gc");

      // collectPatch 被调用，patchFile 由 finalize-record 拼装（sessionsDir/<branch>.patch）
      expect(deps.worktreeManager.collectPatch).toHaveBeenCalledTimes(1);
      expect(deps.worktreeManager.collectPatch).toHaveBeenCalledWith(handle, expectedPatchFile);
      // sessionsDir 已 mkdir（recursive）——patchFile 的父目录真实存在
      expect(fs.existsSync(sessionsDir)).toBe(true);
      // [MF#3] patchFile 落在 worktree 之外（不会被 Step 3 cleanup 连带删除）
      expect(expectedPatchFile.startsWith(handle.path)).toBe(false);
      // patch.written=true → record.patchFile 回填为 finalize-record 拼装的路径
      expect(record.patchFile).toBe(expectedPatchFile);
    });

    it("patch.written=false（空 diff / 写失败）→ record.patchFile 不回填（避免悬空路径）", async () => {
      const { agentDir, ...deps } = makeWorktreeDeps(vi.fn().mockResolvedValue({
        patchFile: "/ignored/never-written.patch",
        failed: false,
        written: false,
      }));
      const record = makeMinimalRecord({ id: "rec-patch-empty", worktreeHandle: handle });

      await doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "gc");

      expect(deps.worktreeManager.collectPatch).toHaveBeenCalledTimes(1);
      expect(record.patchFile).toBeUndefined();
    });

    it("collectPatch 抛错 → best-effort 不阻断 finalize 链（manifest 照写、cleanup 照执行）", async () => {
      const { agentDir, ...deps } = makeWorktreeDeps(vi.fn().mockRejectedValue(new Error("git died")));
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const record = makeMinimalRecord({ id: "rec-patch-err", sessionFile, worktreeHandle: handle });

      await expect(
        doFinalizeRecord(deps, record, makeMinimalResult(), "closed", "gc"),
      ).resolves.toBeUndefined();

      // Step 0 失败不影响后续步骤：finalized sidecar 与 manifest 照常落地
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);
      const manifest = await manifestStore.readManifest("rec-patch-err");
      expect(manifest?.status).toBe("closed");
      expect(deps.worktreeManager.cleanup).toHaveBeenCalledTimes(1);
      expect(record.patchFile).toBeUndefined();
      loggerMock.error.mockClear();
    });
  });
});

// ============================================================
// doFinalizeRoundToIdle — chatMode 轮次完成进 idle（M2-A）
// ============================================================

describe("doFinalizeRoundToIdle — chatMode 轮次完成进 idle (M2-A)", () => {
  let tmpDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-idle-test-"));
    manifestStore = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 构造 FinalizeDeps + 真实 RecordStore（markRoundIdle 按 id 查内存——record 须先
   *  register；返回 store 供 register/断言用）。worktreeManager.cleanup / store.archive
   *  为 spy 以断言「不调」。 */
  function makeDeps(): { deps: Parameters<typeof doFinalizeRoundToIdle>[0]; store: RecordStore } {
    const pi = { appendEntry: vi.fn() };
    const store = new RecordStore(tmpDir, manifestStore, pi, tmpDir);
    const deps = {
      worktreeManager: { cleanup: vi.fn(), collectPatch: vi.fn() },
      store,
      modelService: {},
      pi,
      emitUnregister: vi.fn(),
    } as unknown as Parameters<typeof doFinalizeRoundToIdle>[0];
    return { deps, store };
  }

  it("[B5/D3a] record 带 sessionFile → 轮终后 .alive marker 仍在（写权声明跨轮延续）+ record.status=running + round 0→1", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    // 预写 .alive marker（[B5] 行为变化锚点：轮终**保留** marker——release = 终态原语
    // 或 idle-GC 归档两出口，轮终 record 仍 resumable 随时续聊 spawn 写同一
    // sessionFile，删则轮后跨进程防御空窗，D3a）
    fs.writeFileSync(
      `${sessionFile}.alive`,
      `${JSON.stringify({ pid: 99999, id: "rec-idle", startedAt: 1000 })}\n`,
      "utf-8",
    );
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-idle", sessionFile, chatMode: true, round: 0 });
    // tryTransition 已把 status 设为 done，模拟 runAndFinalize 调用前的状态
    record.status = "closed";
    store.register(record);

    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });

    // 状态机（v4 B-1：旧 idle 折入 running，markRoundIdle 设 running）
    expect(record.status).toBe("running");
    expect(record.round).toBe(1);
    // [B5] .alive marker 轮终保留（旧行为「删 marker」随 D3a 跨轮延续退役）
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
  });

  it("[A3] 终态簿记已冻结（endedAt 已设 = completeRecord 已跑）→ store 内硬断言 throw（S7：禁复活已终态化 record）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-frozen", chatMode: true });
    // closeChatIdle / disposeAllRecords 等完整终态化路径的产物：completeRecord 已跑
    //（endedAt 冻结）+ status=closed。迟到的轮末分流调用必须被断言拒绝。
    record.status = "closed";
    record.closedReason = "user-close";
    record.endedAt = 12345;
    store.register(record);
    const transitionSpy = vi.spyOn(store, "reportRecordTransition");

    await expect(doFinalizeRoundToIdle(deps, record, { kind: "success", content: "late" })).rejects.toThrow(
      /terminal bookkeeping already frozen/,
    );
    // 断言先于任何簿记副作用：round 不推进、状态不回滚、无迁移上报
    expect(record.round).toBeUndefined();
    expect(record.status).toBe("closed");
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(deps.emitUnregister).not.toHaveBeenCalled();
  });

  it("W16: 轮终上报 reportRecordTransition（markRoundIdle 簿记⑨，entry 携带新轮计数）", async () => {
    const { deps, store } = makeDeps();
    const transitionSpy = vi.spyOn(store, "reportRecordTransition");
    const record = makeMinimalRecord({ id: "rec-report", chatMode: true, round: 2 });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    // 上报发生在 round 推进之后（entry 携带新轮计数，重建源不滞后）
    expect(record.round).toBe(3);
    expect(record.status).toBe("running");
  });

  it("record.round 已为 N → round 变 N+1", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-round", round: 3 });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    expect(record.round).toBe(4);
    expect(record.status).toBe("running");
  });

  it("不调 store.archive（record 留内存，getMutable 仍可查）", async () => {
    const { deps, store } = makeDeps();
    const archiveSpy = vi.spyOn(store, "archive");
    const record = makeMinimalRecord({ id: "rec-noarchive" });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(store.getMutable("rec-noarchive")).toBeDefined();
  });

  it("不 cleanup worktree（即使 record 带 worktreeHandle——保留对话模式工作目录）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({
      id: "rec-noworktree",
      worktreeHandle: { path: "/tmp/x", branch: "b", baseCommit: "c", mainCwd: "/tmp" } as never,
    });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    expect(deps.worktreeManager.cleanup).not.toHaveBeenCalled();
  });

  it("轮终注销经 store 簿记⑧发射（setPendingUnregister 注入闭包，status=running）", async () => {
    const { deps, store } = makeDeps();
    // [B5/U5 收口] 注销由 store.markRoundIdle 簿记⑧统一发射（SubagentService 构造点
    // 注入 emitPendingUnregister；调用方薄壳不再双轨重复发）。
    const unregisterSpy = vi.fn();
    store.setPendingUnregister(unregisterSpy);
    const record = makeMinimalRecord({ id: "rec-emit" });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    expect(unregisterSpy).toHaveBeenCalledWith("rec-emit", "running");
  });

  it("不调 completeRecord：record 不冻结（endedAt / agentResult 仍 undefined）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-nofreeze" });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    expect(record.endedAt).toBeUndefined();
    expect(record.agentResult).toBeUndefined();
  });

  it("不写 manifest（idle 非终态，manifest 是终态诊断辅助）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-nomanifest" });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "done" });
    const manifest = await manifestStore.readManifest("rec-nomanifest");
    expect(manifest).toBeNull();
  });

  it("MF-2: record.result 设为轮终 content（否则 notifier idle 回复恒为 (empty)，G1/G2 不成立）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-result" });
    record.status = "closed";
    store.register(record);
    // [H1 U2 / D7] outcome 入参适配：成功轮正文 = content
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "review done, found 3 issues" });
    // MF-2：record.result 被 content 填充，notifier idle 分支读取后携带回复正文
    expect(record.result).toBe("review done, found 3 issues");
  });

  it("MF-2 兑底：失败轮次（无前值）record.result 用失败摘要填充（D7 outcome 入参：前值 ?? 失败摘要）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-result-err" });
    record.status = "closed";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "failed", reason: "spawn timeout" });
    // 失败轮次的 notify 需可读：无前值可保 → 兜底失败摘要
    expect(record.result).toBe("round did not complete: spawn timeout");
  });

  it("D7 失败轮前值保留：有最后成功正文时 result 不被失败摘要覆盖（GUI record 视图不被失败污染）+ lastError 写失败原因", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-fail-keep-prev", chatMode: true });
    record.status = "closed";
    record.result = "last successful round output"; // 前值（有最后成功正文则保留）
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "failed", reason: "watchdog kill" });
    // 前值 ?? 失败摘要 → 前值保留；失败原因归 lastError 字段与失败通知（可达性迁移）
    expect(record.result).toBe("last successful round output");
    expect(record.lastError).toBe("watchdog kill");
  });

  it("D7 失败轮 lastError 写失败原因（排障面——renderer 在 result 非 undefined 时不显示 error，无视觉影响）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-fail-last-error", chatMode: true });
    record.status = "closed";
    record.lastError = undefined;
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "failed", reason: "engine_round_crashed: x" });
    expect(record.lastError).toBe("engine_round_crashed: x");
    expect(record.result).toBe("round did not complete: engine_round_crashed: x");
  });

  it("D7 成功轮 lastError 不混入正文：空 content 成功轮兜底 '(no output this round)'（旧 lastError 混入形态退役）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-success-no-mix", chatMode: true });
    record.status = "closed";
    record.lastError = "stale error from previous round";
    store.register(record);
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "" });
    expect(record.result).toBe("(no output this round)");
    expect(record.result).not.toContain("stale error");
  });

  it("T2-③/LC-1: 失败轮 record.result 写失败摘要、不回显轮内旧正文（D7：可达性从 result 字段迁移到通知 outcome——失败通知由 Continuation 独立承载失败原因 + 恢复指引）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-result-err-text", chatMode: true });
    record.status = "closed";
    store.register(record);
    const failureReason =
      "subagent did not reach agent_settled within 10 min (settled watchdog); the process was terminated to bound the wait. Recovery: check state with subagents action:'list', then re-send your message to continue.";
    await doFinalizeRoundToIdle(deps, record, { kind: "failed", reason: failureReason });
    // 失败轮 record.result 携带失败摘要（前值 undefined → 失败摘要），不构成成功谎报
    expect(record.result).toBe(`round did not complete: ${failureReason}`);
    expect(record.result).not.toBe("DONE");
  });

  it("C1TC10: chatMode 空增量轮占位——record.result 固定 (no output this round)，不含上一轮文本（D5）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-increment-empty", chatMode: true });
    record.status = "closed";
    store.register(record);
    // 预置上一轮通知文本（模拟增量语义前的 record.result 残留）
    record.result = "PREV-ROUND-TEXT";
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "" });
    // 空增量轮通知不含上一轮文本：沿用旧值会让父 agent 误读为原样重复回复（D5 判定）
    expect(record.result).toBe("(no output this round)");
    expect(record.result).not.toContain("PREV-ROUND-TEXT");
  });

  it("C1TC11 [R2-1]: one-shot 首轮空文本成功完成 → record.result 补占位「(empty)」（非 undefined）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-oneshot-empty", chatMode: false });
    record.status = "closed";
    store.register(record);
    // one-shot 成功空文本完成路径（collectResult getFullText 返回 ""、success=true）：
    // result 前值 undefined
    record.result = undefined;
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "" });
    // [R2-1] 轮终信号优先：占位非 undefined 是 renderer hasRunning 排除轮终 running 的
    // 判据——保持 undefined 会让完成注入后末位 turn 永久「工作中」
    expect(record.result).toBe("(empty)");
    // notifier buildLlmContent 的 record.result ?? "(empty)" 兜底同款措辞：
    // 通知文案逐字节产出 "completed. Result:\n(empty)"（G4 保持）
    expect(record.result ?? "(empty)").toBe("(empty)");
  });

  it("C1TC11b [R2-1]: one-shot 续轮空文本 → 沿用前值（one-shot 无增量语义，不覆盖为占位）", async () => {
    const { deps, store } = makeDeps();
    const record = makeMinimalRecord({ id: "rec-oneshot-cont", chatMode: false });
    record.status = "closed";
    store.register(record);
    // 上一轮真实产出（续轮 record.result 前值）
    record.result = "first round output";
    await doFinalizeRoundToIdle(deps, record, { kind: "success", content: "" });
    // one-shot record.result = 该 subagent 最终输出：空文本续轮沿用前值，不被 "(empty)" 覆盖
    expect(record.result).toBe("first round output");
  });
});

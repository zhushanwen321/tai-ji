// src/__tests__/transparent-resume.test.ts
//
// [v8.5 D] 透明重生（transparent resurrection）集成测试：
//   message action 对断联类 ended 记录（finalizedReason ∈ {'disconnected','parent-shutdown'}）
//   直接同 id 续聊——冷查放宽 + resurrectClosed 回边 + 续写原 sessionFile（不开新 JSONL）。
//
// 六类断言：
//   1. happy path：closed(disconnected) → message → 内部状态翻 running + resume 触达
//      （协议 engine.run 捕获，对齐 ended-message-and-fork-from.test.ts [W3 改写] 手法）+
//      原 sessionFile 作为续写目标传递 + subagent-record entry 落盘（live/reload 视图恢复）。
//   2. rejected 四态：cancelled(tombstone) / user-close / worktree 记录 / 异进程活实例。
//   3. 空 .finalized 兼容：旧格式空文件 → disconnected → 可重生。
//   4. guard 一致性：fork-from 与 message 在 user-close 上行为一致地拒绝，各有文案断言。
//   外加：parent-shutdown 同样可重生、gc 完成记录维持 fork-from 指引不重生、
//        本进程自有 .alive 声明（self-pid 排除，U1 后判据）不拦截重生、resurrectClosed
//        单元语义、close action 维持严格。
//
// mock 手法（[W3 改写]）：registerFakePiEngine 协议替身 + logger；record-store /
// state-marker / alive-store 走真实实现（fixture 用临时目录写真实
// .jsonl + sidecar）。执行链观测点从 runAndFinalize 边界捕获（rafCapture/drainChains）
// 换成 fake.runs 捕获（协议 engine.run 的 task/ctx——resume 锚点在 ctx.resume.resume，[H1 U6] 键切换后唯一会话形态键）。
//
// 注意：本测试进程可能运行在 pi subagent 环境（PI_SUBAGENT_* env 被继承会污染
// rootSessionId 基线与 rootCwd 编码），beforeEach/afterEach 清理同 IDENTITY_ENV_KEYS；
// 运行侧也应 env -u 排除泄漏变量。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { findForeignLiveInstance } from "@zhushanwen/subagent-core/execution/alive-store.ts";
import { resurrectClosed } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { writeFinalizedState } from "@zhushanwen/subagent-core/execution/state-marker.ts";
import { getSubagentSessionDir } from "@zhushanwen/subagent-core/execution/path-encoding.ts";
import { SubagentService } from "@zhushanwen/subagent-core";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { forkFromHandler, messageHandler, closeHandler } from "../interface/subagent-actions.ts";

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

/** [U1/A4] 「异进程且存活」的确定性模拟 pid：1 号进程（launchd/init）必然存在且非
 *  本测试进程——kill(1, 0) 对普通用户返回 EPERM，isProcessAlive 按「存在但无权限」
 *  保守判活（self-pid 排除后不能再以本测试进程 pid 模拟异进程实例，同 subagent-core
 *  cold-lookup.test.ts FOREIGN_LIVE_PID 手法）。 */
const FOREIGN_LIVE_PID = 1;

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 写一个最小合法 subagent session.jsonl。identity 前置 model_change/thinking_level_change——
 *  light 重建只从头两处 change entry 读 model/thinkingLevel（parseIdentityFromText 找到
 *  identity 即停），respawn 时经 record identity 复原进 SpawnResumeOpts（防漂移）。 */
function writeSessionJsonl(
  sessionsDir: string,
  identity: {
    id: string;
    rootSessionId: string;
    parentRecordId?: string;
    depth?: number;
    chatMode?: boolean;
    worktree?: boolean;
  },
): string {
  const file = path.join(sessionsDir, `${identity.id}.jsonl`);
  const startedAt = 1_700_000_000_000;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-uuid",
      timestamp: new Date(startedAt).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({ type: "model_change", provider: "p", modelId: "m-1" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    JSON.stringify({
      type: "custom",
      id: "id-1",
      parentId: null,
      timestamp: new Date(startedAt).toISOString(),
      customType: "subagent-identity",
      data: {
        id: identity.id,
        agent: "general-purpose",
        mode: "background",
        task: "disconnected predecessor task",
        slug: identity.id.replace(/^sa-/, ""),
        startedAt,
        rootSessionId: identity.rootSessionId,
        ...(identity.parentRecordId !== undefined ? { parentRecordId: identity.parentRecordId } : {}),
        ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
        ...(identity.chatMode !== undefined ? { chatMode: identity.chatMode } : {}),
        ...(identity.worktree !== undefined ? { worktree: identity.worktree } : {}),
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "id-1",
      timestamp: new Date(startedAt + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "predecessor progress" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: startedAt + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 存量旧名 .cancelled sidecar fixture（L4 后生产只写 .state，此处覆盖兼容读路径）。 */
function writeTombstone(sessionFile: string, id: string): void {
  fs.writeFileSync(
    `${sessionFile}.cancelled`,
    `${JSON.stringify({ id, status: "cancelled", agent: "general-purpose", startedAt: 1, endedAt: 2 })}\n`,
    "utf-8",
  );
}

/** 写 .alive marker（异进程活实例复检 fixture）。 */
function writeAliveMarker(sessionFile: string, pid: number, startedAt: number): void {
  fs.writeFileSync(
    `${sessionFile}.alive`,
    `${JSON.stringify({ pid, id: path.basename(sessionFile, ".jsonl"), startedAt })}\n`,
    "utf-8",
  );
}

describe("[v8.5 D] 透明重生：ended 记录同 id 续写原 session", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-transparent-resume-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session-cur" });

    // 协议替身引擎（[H1 U6] 旧 interact 冷路径拒绝注入随 interact 面退役——续聊恒
    // 派发新 run + resume 锚点，与本文件全部执行链场景一致）。
    fake = registerFakePiEngine();
  });

  afterEach(async () => {
    service.dispose();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 收尾链排空
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  // ============================================================
  // 1. happy path：closed(disconnected) → 同 id 重生续写原文件
  // ============================================================

  describe("happy path", () => {
    it("closed(disconnected) 记录 message → 内部状态翻 running + resume 触达 + 原 sessionFile 作为续写目标", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-happy", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "disconnected");
      expect(service.queries.findRecord("sa-d-happy")).toBeUndefined(); // 前置：内存无

      const result = await messageHandler(service, { subagentId: "sa-d-happy", text: "continue the work" });
      expect(result.response.delivered).toBe(true);
      // 不开新 JSONL：sessions 目录仍只有原文件一个
      expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))).toEqual([
        "sa-d-happy.jsonl",
      ]);

      // 内部状态翻 running（resurrect 回边生效）
      await vi.waitFor(() => {
        const snap = service.queries.findRecord("sa-d-happy");
        expect(snap?.status).toBe("running");
        expect(snap?.sessionFile).toBe(file); // 身份字段复原：原 session 文件
      });
      const snap = service.queries.findRecord("sa-d-happy");
      expect(snap?.chatMode).toBe(true);

      // resume 触达（[W3 观测点改写] 原 runAndFinalize 边界捕获 → 协议 engine.run 捕获）：
      // 原 sessionFile 作为续写锚点传递（ctx.resume.resume.sessionRef.sessionFile = --session
      // 续写目标的协议承载位）；model 从 record identity 复原（fixture 的 model_change
      // entry → ctxModel 解析兜底）。thinkingLevel 锚点随协议化归引擎侧覆盖解析
      //（resume.sessionRef 只承载 sessionFile——引擎从 session 历史的 thinking_level_change
      // entry 自行复原），宿主侧无对应断言位。
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].ctx.taskId).toBe("sa-d-happy");
      expect(fake.runs[0].task.prompt).toBe("continue the work");
      expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
      expect(fake.runs[0].ctx.ctxModel).toMatchObject({ provider: "p", id: "m-1" });

      // subagent-record entry 落盘（register/reportRecordTransition）→ live/reload 视图恢复。
      const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
      expect(entries.length).toBeGreaterThan(0);
      const lastEntry = entries[entries.length - 1][1] as { status?: string; resumable?: boolean; round?: number };
      expect(lastEntry.status).toBe("running");

      // 重生后的死因语义位已清（不再是 closed 态残留）
      expect(snap?.closedReason).toBeUndefined();
      expect(snap?.endedAt).toBeUndefined();
    });

    it("closed(parent-shutdown) 同样可重生（可重连集第二员）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-shut", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "parent-shutdown");

      const result = await messageHandler(service, { subagentId: "sa-d-shut", text: "pick up where left" });
      expect(result.response.delivered).toBe(true);
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
    });

    it("完成后第二条完成通知 dedup key 含 round（round 从 0 重建 → key=id:1），不与终态通知互吞", async () => {
      // 结构性验证：notifier dedup key = `${id}:${round}`；重生记录 round 重建为 undefined →
      // 首轮应答 settle 时 settleChatRoundFromResponse 推进 round=(0)+1=1 —— 与旧实例在另一
      // 进程的通知互不可见（notifier 去重集随服务实例重建）。此处驱动协议应答 settle 并断言
      // entry 携带 round（保证第二轮起 key 正常递增，文档化 spec 第 4 点的行为契约）。
      // [W3 契约变更] entry 的 resumable 位原由 inproc doFinalizeRoundToIdle 写 true；协议
      // 形态下轮次 settle 不经 finalize 分流（live 态派生，entry 位不写）——resumable 断言
      // 无对应行为，随原观测点一并废弃。
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-notify", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "disconnected");

      await messageHandler(service, { subagentId: "sa-d-notify", text: "go" });
      // 收链：本轮 detached 协议 run 在用例内 settle（防跨用例竞态）
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      fake.runs[0].settle({ content: "revived round" });

      const entries = await vi.waitFor(() => {
        const all = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
        expect(all.length).toBeGreaterThan(0);
        const last = all[all.length - 1][1] as { round?: number };
        expect(last.round).toBe(1);
        return all;
      });
      const last = entries[entries.length - 1][1] as { round?: number };
      expect(last.round).toBe(1);
    });
  });

  // ============================================================
  // 2. rejected 四态：一律拒绝 + 不进入执行链 + 不注册内存
  // ============================================================

  describe("rejected 四态（红线内不走透明重生）", () => {
    it("cancelled（tombstone）→ 保持「主动关闭」拒绝文案", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-cancel", rootSessionId: "root-session-cur" });
      writeTombstone(file, "sa-d-cancel");

      await expect(messageHandler(service, { subagentId: "sa-d-cancel", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
      expect(service.queries.findRecord("sa-d-cancel")).toBeUndefined();
      expect(fake.runs.length).toBe(0);
    });

    it("user-close → 保持「主动关闭」拒绝文案（close 正式语义完整保留）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-uclose", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "user-close");

      await expect(messageHandler(service, { subagentId: "sa-d-uclose", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)[\s\S]*nothing can reattach/,
      );
      expect(service.queries.findRecord("sa-d-uclose")).toBeUndefined();
      expect(fake.runs.length).toBe(0);
    });

    it("worktree 记录 → 拒绝（binding 已丢，重生会让 spawn cwd 回落主仓）", async () => {
      const file = writeSessionJsonl(sessionsDir, {
        id: "sa-d-wt",
        rootSessionId: "root-session-cur",
        worktree: true,
      });
      writeFinalizedState(file, "disconnected");

      const err = await messageHandler(service, { subagentId: "sa-d-wt", text: "hi" }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/worktree isolation/);
      expect(msg).toMatch(/cannot be transparently resumed/);
      expect(service.queries.findRecord("sa-d-wt")).toBeUndefined();
      expect(fake.runs.length).toBe(0);
    });

    it("异进程活实例（.alive + 存活 pid）→ 拒绝（防双写 jsonl）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-alive", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "disconnected");
      // [U1/A4] 探针判据 = pid 单判据 + self-pid 排除（软超时已退役）——「异进程」模拟
      // 不能再用本测试进程 pid（会被 self-pid 排除放行），改恒活外部 pid 1。
      writeAliveMarker(file, FOREIGN_LIVE_PID, Date.now());
      expect(findForeignLiveInstance(file)).toBeDefined(); // 探针前置自检

      await expect(messageHandler(service, { subagentId: "sa-d-alive", text: "hi" })).rejects.toThrow(
        /transparently resumable[\s\S]*previous instance still finishing/,
      );
      expect(service.queries.findRecord("sa-d-alive")).toBeUndefined();
      expect(fake.runs.length).toBe(0);
    });

    it("本进程自有 .alive 声明（marker.pid = 本进程）不拦截本进程 → 可重生（self-pid 排除判据 e2e）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-stale", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "disconnected");
      // [U1/D3b] 软超时判据已退役，此前「超软超时放行」用例的真实放行原因已变——
      // 现行判据下 marker.pid === process.pid 被视同本进程自有声明（无论 startedAt
      // 新旧），探针前置自检确认放行由 self-pid 排除给出。
      writeAliveMarker(file, process.pid, Date.now());
      expect(findForeignLiveInstance(file)).toBeUndefined(); // 探针前置自检：self-pid 排除放行

      const result = await messageHandler(service, { subagentId: "sa-d-stale", text: "revive" });
      expect(result.response.delivered).toBe(true);
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    });

    it("gc 完成记录（自然 done）→ 维持 fork-from 指引、不透明重生", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-gc", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "gc");

      await expect(messageHandler(service, { subagentId: "sa-d-gc", text: "follow up" })).rejects.toThrow(
        /reconnectable[\s\S]*fork-from/,
      );
      expect(service.queries.findRecord("sa-d-gc")).toBeUndefined();
      expect(fake.runs.length).toBe(0);
    });
  });

  // ============================================================
  // 3. 空 .finalized 兼容：旧格式空文件 → disconnected → 可重生
  // ============================================================

  it("空 .finalized（v8.5 前旧格式）→ 磁盘重建兜底 disconnected → 透明重生成功", async () => {
    const file = writeSessionJsonl(sessionsDir, { id: "sa-d-legacy", rootSessionId: "root-session-cur" });
    // 存量旧格式 fixture（L4 后生产只写 .state，旧名靠 fs 直写仿真）
    fs.writeFileSync(`${file}.finalized`, "", "utf-8");

    // A 档兼容读：磁盘层 closedReason=disconnected
    const diskRec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-d-legacy");
    expect(diskRec?.status).toBe("closed");
    expect(diskRec?.closedReason).toBe("disconnected");

    // D 档：message 直接重生（Y 分支文案不再触达）
    const result = await messageHandler(service, { subagentId: "sa-d-legacy", text: "legacy continues" });
    expect(result.response.delivered).toBe(true);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
  });

  // ============================================================
  // 4. guard 一致性：fork-from 与 message 在 user-close 上行为一致地拒绝
  // ============================================================

  describe("guard 一致性（fork-from × message 在 user-close 上）", () => {
    it("fork-from 对 user-close 源拒绝（与 message 的 X 拒绝对齐，close 语义无旁路）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-fkclose", rootSessionId: "old-root" });
      writeFinalizedState(file, "user-close");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-d-fkclose" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)[\s\S]*cannot be resumed or branched from/,
      );
      expect(fake.runs.length).toBe(0); // 不产生 fork 执行链
    });

    it("fork-from 对 cancelled 源拒绝（原文案升级覆盖两类）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-fkcancel", rootSessionId: "old-root" });
      writeTombstone(file, "sa-d-fkcancel");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-d-fkcancel" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
      expect(fake.runs.length).toBe(0);
    });

    it("message 对同一 user-close 记录拒绝——两边各有独立断言（文案分叉但语义一致：都拒）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-both", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "user-close");

      // message 侧：X 分支专属文案
      await expect(messageHandler(service, { subagentId: "sa-d-both", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)/,
      );
      // fork-from 侧：守卫 4 升级文案（含 user-close 显式列入）
      await expect(forkFromHandler(service, { sourceSubagentId: "sa-d-both" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)[\s\S]*cannot be resumed or branched from/,
      );
      expect(fake.runs.length).toBe(0);
    });
  });

  // ============================================================
  // 回归边界：严格语义保持
  // ============================================================

  describe("回归边界", () => {
    it("close action 对断联类 ended 记录维持严格拒绝（默认无放宽）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-closestrict", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "disconnected");

      await expect(closeHandler(service, { subagentId: "sa-d-closestrict" })).rejects.toThrow(
        /not found or not owned/,
      );
      expect(service.queries.findRecord("sa-d-closestrict")).toBeUndefined();
      expect(fake.runs.length).toBe(0);
    });

    it("resurrectClosed 单元语义：仅 closed 可翻边且清除语义位；running 体拒绝", () => {
      const closed = {
        status: "closed" as const,
        closedReason: "disconnected" as const,
        endedAt: 123,
      };
      expect(resurrectClosed(closed)).toBe(true);
      expect(closed.status).toBe("running");
      expect(closed.closedReason).toBeUndefined();
      expect(closed.endedAt).toBeUndefined();

      const running = { status: "running" as const, closedReason: undefined, endedAt: undefined };
      expect(resurrectClosed(running)).toBe(false); // 非 closed 入态防御：no-op
      expect(running.status).toBe("running");
    });
  });
});

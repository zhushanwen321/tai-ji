// src/__tests__/ended-message-and-fork-from.test.ts
//
// [v8.5 A1/A2/B] 三块改动的集成测试：
//   A1 — message 拒绝文案分流（endedMessageGuard）：user-close/cancelled →「主动关闭，
//        无法续聊」；断联/自然完成/异归属 →「fork-from 可行动指引」。两种形态各有断言。
//   A2 — `.state` sidecar 真实 reason 读回矩阵：带 reason 用 reason / 空（旧格式）
//        兜底 disconnected（向后兼容）/ 非法内容兜底 disconnected。
//   B  — fork-from handler：正常接续（新 id + prompt 注入 + forkSource 指向源文件）、
//        cancelled 拒绝、worktree 记录拒绝、不存在 id 拒绝、本进程 running 拒绝。
//
// mock 手法（[W3 改写]）：registerFakePiEngine 协议替身（原 mock inproc session-runner
// 不 spawn 真子进程的形态随 inproc pi 引擎目录删除消亡）+ logger；record-store /
// state-marker 走真实实现（fixture 用临时目录写真实 .jsonl + sidecar）。
// 执行链观测点从 runAndFinalize 边界捕获（rafCapture）换成 fake.runs 捕获（协议 engine.run
// 的 task/ctx——冷路径 resume 锚点在 ctx.resume.resume，fork/续写语义落点）。
//
// 注意：本测试进程可能运行在 pi subagent 环境（PI_SUBAGENT_* env 被继承会污染
// rootSessionId 基线与 rootCwd 编码），beforeEach/afterEach 清理同 IDENTITY_ENV_KEYS。

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
import { writeFinalizedState } from "@zhushanwen/subagent-core/execution/state-marker.ts";
import type { ModelRegistryLike } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import { getSubagentSessionDir } from "@zhushanwen/subagent-core/execution/path-encoding.ts";
import { SubagentService } from "@zhushanwen/subagent-core";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { forkFromHandler, messageHandler } from "../interface/subagent-actions.ts";

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 写一个最小合法 subagent session.jsonl（session header + identity entry + assistant message）。 */
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

describe("[v8.5] ended-message 分流文案 + fork-from 恢复通道", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-ended-msg-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 真实 fs 路线：execute 链在 tmp 内落盘安全。
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    // modelRegistry stub：main 侧 resolveModel 的 ctxModel 孪生守卫（modelRefFromVerified）
    // 会调 source.getAvailable()（initModel 缺省时此前炸 TypeError）。本测试不测模型解析域，
    // 空 registry（无大小写孪生）即放行 ctxModel 继承路径；find/hasConfiguredAuth 仅为
    // 显式 param/agentConfig model 路径所需，本链路不触达，补齐只为满足 ModelRegistryLike。
    const modelRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session-cur" });

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
  // A2：`.state` sidecar reason 读回矩阵（磁盘重建侧）
  // ============================================================

  describe("A2 finalized sidecar reason 矩阵", () => {
    it("带合法 reason 的 sidecar → 重建 closedReason 为真实值（非 gc）", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-userclose", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "user-close");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-userclose");
      expect(rec?.status).toBe("closed");
      expect(rec?.closedReason).toBe("user-close");
    });

    it("parent-shutdown reason 同样读回真实值", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-shutdown", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "parent-shutdown");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-shutdown");
      expect(rec?.closedReason).toBe("parent-shutdown");
    });

    it("显式 gc reason（孤儿恢复写入形态）保持 gc", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-gc", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "gc");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-gc");
      expect(rec?.closedReason).toBe("gc");
    });

    it("向后兼容：旧格式空内容 sidecar → disconnected（不再误导为 gc），message 不崩", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-legacy", rootSessionId: "root-session-cur" });
      // 存量旧格式 fixture（L4 后生产只写 .state，旧名靠 fs 直写仿真）
      fs.writeFileSync(`${file}.finalized`, "", "utf-8");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-legacy");
      expect(rec?.status).toBe("closed");
      expect(rec?.closedReason).toBe("disconnected");

      // [v8.5 D 升级] disconnected ∈ 可重连集 → message 不再拒绝而是透明重生，续写原文件；
      // 「向后兼容」语义保持：旧格式 sidecar 可读、行为不崩、路径可达。
      const res = await messageHandler(service, { subagentId: "sa-a2-legacy", text: "hi" });
      expect(res.response.delivered).toBe(true);
      // [W3 观测点改写] 冷路径续写锚点：原 rafCapture（runAndFinalize args[8].sessionFile）
      // 换成协议 engine.run 的 ctx.resume.resume.sessionRef.sessionFile（--session 续写原
      // 文件的协议承载位）。
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
    });

    it("sidecar 内容非法（外部损坏/手写垃圾）→ 兜底 disconnected", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-junk", rootSessionId: "root-session-cur" });
      // .state 非 JSON（损坏形态）→ 读侧存在性宽语义 → 无 reason → disconnected
      fs.writeFileSync(`${file}.state`, "some random junk", "utf-8");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-junk");
      expect(rec?.closedReason).toBe("disconnected");
    });

    it("cancel 路径的 tombstone 优先级不变：.cancelled 存在时恒 cancelled", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-tomb", rootSessionId: "root-session-cur" });
      writeTombstone(file, "sa-a2-tomb");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-tomb");
      expect(rec?.status).toBe("closed");
      expect(rec?.closedReason).toBe("cancelled");
    });
  });

  // ============================================================
  // A1：message 拒绝文案两形态
  // ============================================================

  describe("A1 message 拒绝文案分流", () => {
    it("形态 X：user-close 终态 →「已主动关闭」文案，不再误报 not found", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-x-close", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "user-close");

      const err = await messageHandler(service, { subagentId: "sa-x-close", text: "hi" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/deliberately closed by user \(closedReason: user-close\)/);
      expect(msg).toMatch(/start a new subagent/);
      // 不再给出误导性的「历史完好可接续」指引
      expect(msg).not.toMatch(/fork-from/);
      expect(msg).not.toMatch(/not found or not owned/);
    });

    it("形态 X'：cancelled 终态 → 同款「真没了」语义", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-x-cancel", rootSessionId: "root-session-cur" });
      writeTombstone(file, "sa-x-cancel");

      await expect(messageHandler(service, { subagentId: "sa-x-cancel", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
    });

    it("形态 Y-closed：gc 完成的 done 记录追问 → fork-from 可行动指引 + sessionFile 路径", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-y-done", rootSessionId: "root-session-cur" });
      writeFinalizedState(file, "gc");

      const err = await messageHandler(service, { subagentId: "sa-y-done", text: "follow up?" }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/reconnectable/);
      expect(msg).toContain(file); // 指引必须带出 history 所在文件
      expect(msg).toMatch(/fork-from/);
      expect(msg).toMatch(/sourceSubagentId/);
    });

    it("形态 Y-running：断联遗留 running 态异树记录 → 归属差异说明 + fork-from 指引", async () => {
      // 主会话重启后（新 rootSessionId），断联 record 无 sidecar → 分支 4 重建为
      // running，但 rootSessionId=旧树 → getRecordForAction 拒绝。这是原「ended
      // cannot be messaged」文案最失真的场景——它并没有结束，只是断联了。
      writeSessionJsonl(sessionsDir, { id: "sa-y-stale-running", rootSessionId: "old-root-session" });

      const err = await messageHandler(service, { subagentId: "sa-y-stale-running", text: "hi" }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/different session tree/);
      expect(msg).toMatch(/fork-from/);
    });

    it("找不到的 id → 原样透传 not found 文案（id 打错场景不受影响）", async () => {
      await expect(messageHandler(service, { subagentId: "sa-nonexistent", text: "hi" })).rejects.toThrow(
        /not found or not owned: sa-nonexistent/,
      );
    });
  });

  // ============================================================
  // B：fork-from 场景
  // ============================================================

  describe("B fork-from action", () => {
    it("正常接续：done 记录 → 新 id + prompt 注入引导语（含源文件指引面）", async () => {
      const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src", rootSessionId: "old-root" });
      writeFinalizedState(sourceFile, "gc");

      const result = await forkFromHandler(service, {
        sourceSubagentId: "sa-src",
        prompt: "verify test results first",
      });

      // 返回形状：{ newSubagentId, sourceSessionFile }
      expect(result.response.newSubagentId).toBeTruthy();
      expect(result.response.newSubagentId).not.toBe("sa-src");
      expect(result.response.sourceSessionFile).toBe(sourceFile);
      expect(result.subagentId).toBe(result.response.newSubagentId);

      // prompt 注入：task = 用户指令在前 + 接续框架在后（--fork 上下文重建要求）。
      // kickOffChatRound 是 detached 编排——等后台链派发到协议 engine.run 再断言。
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].task.prompt).toContain("verify test results first");
      expect(fake.runs[0].task.prompt).toMatch(/inherited conversation via --fork/);
      // [断链修复恢复] fork 源 sessionFile 透传到协议 run 帧 task.forkSource（W3 改写时
      // 移除的断言——当时协议无承载位；现载体 = SDK AgentCallOpts.forkSource，pi 引擎侧
      // SpawnRunParams.forkSource → buildSpawnArgs --fork 已有专项直测，两层合成覆盖全链）。
      expect(fake.runs[0].task.forkSource).toBe(sourceFile);

      expect((service.queries.findRecord(result.response.newSubagentId))?.status).toBe("running");
      expect((service.queries.findRecord(result.response.newSubagentId))?.slug).toBe("src-resumed");
    });

    it("无 prompt → 注入默认接管框架（reconstruct state 引导语）", async () => {
      const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src2", rootSessionId: "old-root" });
      writeFinalizedState(sourceFile, "gc");

      await forkFromHandler(service, { sourceSubagentId: "sa-src2" });

      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].task.prompt).toMatch(/taking over work/i);
      expect(fake.runs[0].task.prompt).toMatch(/already done|left unfinished/);
      // [断链修复恢复] 默认 prompt 形态同样携带 fork 源（W3 移除的断言，载体同上）。
      expect(fake.runs[0].task.forkSource).toBe(path.join(sessionsDir, "sa-src2.jsonl"));
    });

    it("cancelled 源拒绝（用户主动告别，无接续通道）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-canxx", rootSessionId: "old-root" });
      writeTombstone(file, "sa-canxx");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-canxx" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
      expect(fake.runs.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("worktree 记录拒绝（binding 已丢，防 cwd 回落主仓破坏隔离）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-wtxx", rootSessionId: "old-root", worktree: true });
      writeFinalizedState(file, "gc");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-wtxx" })).rejects.toThrow(
        /worktree isolation/,
      );
      expect(fake.runs.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("本进程 running 记录拒绝（还在跑应走 message，防双写）", async () => {
      writeSessionJsonl(sessionsDir, { id: "sa-live", rootSessionId: "root-session-cur" });
      // 冷路径重建进内存（running）→ findRecord 命中
      service.chatActions.getRecordForAction("sa-live");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-live" })).rejects.toThrow(
        /still active in this process[\s\S]*action:'message'/,
      );
      expect(fake.runs.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("不存在的 id 拒绝并给 list 确认指引", async () => {
      await expect(forkFromHandler(service, { sourceSubagentId: "sa-ghost" })).rejects.toThrow(
        /No subagent record with id "sa-ghost"[\s\S]*includeFinished:true/,
      );
      expect(fake.runs.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("缺 sourceSubagentId 入参 → 行动语言报错", async () => {
      await expect(forkFromHandler(service, {})).rejects.toThrow(/forkFromParam\.sourceSubagentId is required/);
      await expect(forkFromHandler(service, { sourceSubagentId: "  " })).rejects.toThrow(
        /forkFromParam\.sourceSubagentId is required/,
      );
    });
  });
});

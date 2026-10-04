// src/__tests__/transparent-resume.test.ts
//
// 透明重生（transparent resurrection）+ fork-from 恢复通道——壳侧真链路集成测试
//（原 transparent-resume.test.ts + ended-message-and-fork-from.test.ts 合并宿主，
// 共享 writeSessionJsonl/writeTombstone/makePi 夹具）。
//
// [2026-09 测试审计] 合并删减对账（行为面权威在 core 包）：
//   - message/fork 放行矩阵（user-close/cancelled/gc/parent-shutdown/异进程活实例/
//     self-pid/fork 放行/跨树拒绝）→ core permanent-session-universal-resume.test.ts
//     it.each 7 值矩阵 + subagent-actions-core.test.ts 守卫链逐字文案已覆盖，删；
//   - worktree message/fork 拒绝 → core cold-lookup.test.ts + subagent-actions-core
//     守卫 5 已覆盖，删；
//   - resurrectClosed 单元语义 → core permanent-session-state-machine.test.ts 已覆盖，删；
//   - sidecar 合法 reason 读回矩阵 → core cold-lookup.test.ts（.state/.finalized 载体）
//     已覆盖，删；
//   - cancel tombstone 优先级（.cancelled 存在恒 cancelled）→ 收条 sidecar 读侧随 ③
//     全族退场，该行为随机制消亡；cancel 现行载体 = record-settled 帧，其折叠读回
//     投影由 core record-store.test.ts（seedTerminalRecord 收条读回矩阵）覆盖，删；
//   - 壳独有断言保留：happy path 帧面（readdir 文件集恒一 + 帧序）、轮次收口 round
//     基数、[U4] close 幂等、sidecar 残留惰性、not found 文案含 id 回显、fork-from
//     贯通（task.forkSource 透传）、默认接管框架双正则；fork cancelled 放行保留
//     真链路断言更全的一份。
//
// [③ 收条 sidecar 退场] 磁盘前置形态改经 record 事件流表达（与 core 同款 helper）：
// 终态收条 = `<recordsDir>/<id>.events` 的 record-settled 帧
//（seedTerminalRecordForSessionFile 播种）；事件流缺席/无终态帧 = 在途中断形态
//（重建兜底 idle + interrupted-by-restart，万物可续候选）。收条 sidecar 文件
//（.state/.finalized/.cancelled）读侧已退场——残留文件对判定零影响（惰性）。
//
// mock 手法（[W3 改写]）：registerFakePiEngine 协议替身 + logger；record-store /
// 事件 journal / alive-store 走真实实现（fixture 用临时目录写真实 .jsonl + 事件文件）。
// 执行链观测点 = fake.runs 捕获（协议 engine.run 的 task/ctx——resume 锚点在
// ctx.resume.resume，[H1 U6] 键切换后唯一会话形态键）。
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
import { seedTerminalRecordForSessionFile } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/seed-terminal-record.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { getSubagentSessionDir, getSubagentRecordsDir } from "@zhushanwen/subagent-core/execution/assembly/path-encoding.ts";
import { SubagentService } from "@zhushanwen/subagent-core";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { closeHandler, forkFromHandler, messageHandler } from "@zhushanwen/subagent-core";

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

/** 存量 .cancelled sidecar 残留 fixture。收条 sidecar 读侧已退场（③）：本文件在场
 *  不参与任何判定（惰性残留），仅用于验证带此残留的 record 照常被识别与放行。 */
function writeTombstone(sessionFile: string, id: string): void {
  fs.writeFileSync(
    `${sessionFile}.cancelled`,
    `${JSON.stringify({ id, status: "cancelled", agent: "general-purpose", startedAt: 1, endedAt: 2 })}\n`,
    "utf-8",
  );
}

/** [W1 / D3] 读 record 事件文件的帧序列（type；round-started 帧附 `:round`）。
 *  [W1 / D1] 停写 v1 快照后运行态事实源 = 事件文件——轮次/收口的落账断言改锚
 *  帧序列；路径推导与 SubagentService 装配同源（getSubagentRecordsDir）。 */
function readRecordEventFrames(agentDir: string, id: string): string[] {
  const eventsPath = path.join(getSubagentRecordsDir(agentDir, agentDir), `${id}.events`);
  const raw = fs.readFileSync(eventsPath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const frame = JSON.parse(l) as { type: string; round?: number };
      return frame.round !== undefined ? `${frame.type}:${frame.round}` : frame.type;
    });
}

describe("透明重生 + fork-from 恢复通道（壳侧真链路）", () => {
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
    // [U4] fork-from 放行后真正走到 service.execute 全链——resolveIdentity 需要
    // modelRegistry stub（modelRefFromVerified 调 source.getAvailable()）。
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session-cur" });

    // 协议替身引擎（续聊/fork 恒派发新 run + resume 锚点）。
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
  // happy path 帧面：在途中断遗留 → 同 id 重生续写原文件
  // ============================================================

  describe("happy path 帧面", () => {
    it("遗留中断记录（事件流无收条帧）message → 内部状态翻 running + resume 触达 + 原 sessionFile 作为续写目标", async () => {
      // 事件流缺席 = 在途中断形态（重建兜底 idle + interrupted-by-restart）——
      // 万物可续候选，message 同 id 透明重生、续写原文件。
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-happy", rootSessionId: "root-session-cur" });
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
      // [modeless 波5] chatMode 字段消亡：模式不是 record 状态，message 直接续聊
      expect(snap?.chatMode).toBeUndefined();

      // resume 触达（协议 engine.run 捕获）：原 sessionFile 作为续写锚点传递；
      // model 从 record identity 复原（fixture 的 model_change entry → ctxModel 解析兜底）。
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].ctx.taskId).toBe("sa-d-happy");
      expect(fake.runs[0].task.prompt).toBe("continue the work");
      expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
      expect(fake.runs[0].ctx.ctxModel).toMatchObject({ provider: "p", id: "m-1" });

      // subagent-record v2 注册条目落盘（[W1 / D1] 停写 v1 快照后 entry 面 = 注册/
      // 终态两条小条目；「状态翻 running」的事实落账 = record-round-started 帧；
      // 事件流缺席的遗留记录重生时补账 created 帧 + 注册条目）。
      const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
      expect(entries.length).toBeGreaterThan(0);
      const lastEntry = entries[entries.length - 1][1] as { v?: number; kind?: string; id?: string };
      expect(lastEntry).toMatchObject({ v: 2, kind: "registered", id: "sa-d-happy" });
      const frames = readRecordEventFrames(agentDir, "sa-d-happy");
      expect(frames).toContain("record-created");
      expect(frames).toContain("record-round-started:0");

      // 重生后的死因语义位已清（无 closed 态残留）
      expect(snap?.closedReason).toBeUndefined();
      expect(snap?.endedAt).toBeUndefined();
    });

    it("完成后轮次收口落账（round 从 0 重建推进 → 第二轮 key=id:1 的基数成立），不与终态通知互吞", async () => {
      // 结构性验证：notifier dedup key = `${id}:${round}`；重生记录 round 重建为 undefined →
      // 首轮应答 settle 时 round=(0)+1=1 —— 与旧实例在另一进程的通知互不可见。
      // [W1 / D1·D3] v1 快照 entry 停写后 round 快照位消亡：轮次推进的事实源 = 事件
      // 文件（record-round-started → record-round-idle 帧序）+ 记录态收口翻边（idle）。
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-notify", rootSessionId: "root-session-cur" });

      await messageHandler(service, { subagentId: "sa-d-notify", text: "go" });
      // 收链：本轮 detached 协议 run 在用例内 settle（防跨用例竞态）
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      fake.runs[0].settle({ content: "revived round" });

      const entries = await vi.waitFor(() => {
        const all = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
        expect(all.length).toBeGreaterThan(0);
        // 轮次推进的事实落账：round-started(round 0) 在前、轮终收条 round-idle 在后
        // ——第二轮 dedup key 的 round 基数（=1）由该记录态派生。
        const frames = readRecordEventFrames(agentDir, "sa-d-notify");
        expect(frames).toContain("record-round-started:0");
        // 轮终收条帧自带累计轮数（[② 读侧换源] round 进帧）：轮终帧 = record-round-idle:1
        // ——第二轮 dedup key 的 round 基数（=1）直接在帧载荷可见。
        expect(frames).toContain("record-round-idle:1");
        expect(frames.indexOf("record-round-idle:1")).toBeGreaterThan(frames.indexOf("record-round-started:0"));
        // 收口翻边：轮终后记录态 idle（第二轮起 key 正常递增的记录态前提）
        expect(service.queries.findRecord("sa-d-notify")?.status).toBe("idle");
        return all;
      });
      // v2 注册条目在盘（entry 面唯一形态——无 v1 快照、无 round 快照位）
      const last = entries[entries.length - 1][1] as { v?: number; kind?: string };
      expect(last).toMatchObject({ v: 2, kind: "registered" });
    });
  });

  // ============================================================
  // 终态 sidecar 残留惰性（③ 退场后读侧不消费任何收条 sidecar 文件）
  // ============================================================

  describe("终态 sidecar 残留惰性", () => {
    it("旧名空 .finalized 与损坏 .state 残留在场 → 读侧无视（不产出误导死因），记录仍可发现且 message 透明重生", async () => {
      // 两类残留形态并存：旧格式空文件（旧版本写入）+ 现名垃圾内容（外部损坏/手写）。
      // 读侧已整体退场（不读内容、不进缓存戳）：记录按 jsonl identity 正常重建，
      // 死因展示走事件流（缺席 = interrupted-by-restart），不再产出 disconnected/gc。
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-legacy", rootSessionId: "root-session-cur" });
      fs.writeFileSync(`${file}.finalized`, "", "utf-8");
      fs.writeFileSync(`${file}.state`, "some random junk", "utf-8");

      const rec = service.queries.collectRecords(50, "all").find((r) => r.id === "sa-a2-legacy");
      expect(rec?.status).toBe("idle");
      expect(rec?.closedReason).toBeUndefined();

      // message 透明重生不受残留影响，续写原文件
      const res = await messageHandler(service, { subagentId: "sa-a2-legacy", text: "hi" });
      expect(res.response.delivered).toBe(true);
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
    });
  });

  // ============================================================
  // fork-from 贯通（新 id + prompt 注入 + task.forkSource 协议透传）
  // ============================================================

  describe("fork-from 贯通", () => {
    it("正常接续：done 记录 → 新 id + prompt 注入引导语（含源文件指引面）", async () => {
      const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src", rootSessionId: "old-root" });
      // done 形态播种（现行载体）：事件流 record-settled 帧（stopReason=completed）
      seedTerminalRecordForSessionFile(sourceFile, getSubagentRecordsDir(agentDir, agentDir), {
        stopReason: "completed",
      });

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
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].task.prompt).toContain("verify test results first");
      expect(fake.runs[0].task.prompt).toMatch(/inherited conversation via --fork/);
      // fork 源 sessionFile 透传到协议 run 帧 task.forkSource（载体 = SDK AgentCallOpts.
      // forkSource，pi 引擎侧 buildSpawnArgs --fork 已有专项直测，两层合成覆盖全链）。
      expect(fake.runs[0].task.forkSource).toBe(sourceFile);

      expect((service.queries.findRecord(result.response.newSubagentId))?.status).toBe("running");
      expect((service.queries.findRecord(result.response.newSubagentId))?.slug).toBe("src-resumed");
    });

    it("无 prompt → 注入默认接管框架（reconstruct state 引导语）", async () => {
      const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src2", rootSessionId: "old-root" });
      // done 形态播种（载体同上）
      seedTerminalRecordForSessionFile(sourceFile, getSubagentRecordsDir(agentDir, agentDir), {
        stopReason: "completed",
      });

      await forkFromHandler(service, { sourceSubagentId: "sa-src2" });

      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
      expect(fake.runs[0].task.prompt).toMatch(/taking over work/i);
      expect(fake.runs[0].task.prompt).toMatch(/already done|left unfinished/);
      // 默认 prompt 形态同样携带 fork 源（载体同上）。
      expect(fake.runs[0].task.forkSource).toBe(path.join(sessionsDir, "sa-src2.jsonl"));
    });

    // fork cancelled 放行壳内留一（同契约另一份在 core subagent-actions-core 守卫 4
    // 删除条参数化覆盖；此处保留真链路断言更全的一份）。
    it("[U4 守卫 4 删除] cancelled 残留源 → 放行分叉（主动告别不再是 fork 例外）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-canxx", rootSessionId: "old-root" });
      writeTombstone(file, "sa-canxx");

      const r = await forkFromHandler(service, { sourceSubagentId: "sa-canxx" });
      expect(r.response.newSubagentId).not.toBe("sa-canxx");
      expect(r.response.sourceSessionFile).toBe(file);
      await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    });
  });

  // ============================================================
  // 回归边界：严格语义保持
  // ============================================================

  describe("回归边界", () => {
    it("[U4] close action 对遗留中断 record → 放行（idle 全候选：对已收口 record 操作 = 幂等收口/归档）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-closestrict", rootSessionId: "root-session-cur" });

      // [U4 万物可续] getRecordForAction 冷查不再按 allowReconnect 把门——close 的
      // 归属校验放行（冷查重建注册），closeSubagent 幂等收口。不触发续聊执行链。
      const r = await closeHandler(service, { subagentId: "sa-d-closestrict" });
      expect(r.response.closed).toBe(true);
      expect(fake.runs.length).toBe(0);
    });

    it("找不到的 id → 原样透传 not found 文案（id 打错场景不受影响，含 id 回显）", async () => {
      await expect(messageHandler(service, { subagentId: "sa-nonexistent", text: "hi" })).rejects.toThrow(
        /not found or not owned by this session: sa-nonexistent/,
      );
    });
  });
});

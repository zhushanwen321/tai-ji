// src/execution/__tests__/permanent-session-universal-resume.test.ts
//
// [U4 / §3.2.3 准入判据切换] 万物可续集成矩阵（验收条款 4 对应）：
//   ① closedReason（旧 7 值）× message → 全部放行或自动降级 reopen（形态枚举 gate 消亡）；
//   ② 唯一拒绝 = 异进程活实例（ResurrectDeniedError 文案含 pid，统一占用句式）；
//   ③ reopen 触发：锚失效 + message → markReopened（round 归零 + epoch+1 +
//      stopReason=reopened + binding 落盘）+ resume:undefined + 摘要 prompt 注入；
//   ④ 归属拒绝（跨 session 树 not owned）保留（§3.2.3 判据三）。
//   ⑤ buildReopenSummaryPrompt 模板契约锁定（摘要来源 = task/agent/round/
//      totalTokens/turns + 末轮 result；缺省 fail-soft）。
//
// mock 手法：registerFakePiEngine 协议替身 + 真实 store/state-marker/alive-store
//（fixture 用临时目录写真实 .jsonl + .state + .record-binding，自建自删，不触碰
// 真实数据目录——测试红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";
import { findForeignLiveInstance } from "../persistence/alive-store.ts";
import { writeFinalizedState, readRecordBinding } from "../persistence/state-marker.ts";
import { getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { SubagentService } from "../subagent-service.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { buildReopenSummaryPrompt } from "../assembly/conversation-continuation.ts";
import { ResurrectDeniedError } from "../assembly/types.ts";
import { forkFromHandler, messageHandler } from "../assembly/subagent-actions-core.ts";

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

/** 「异进程且存活」的确定性模拟 pid（恒活外部 pid 1，self-pid 排除后本进程 pid
 *  不可用——同 cold-lookup.test.ts FOREIGN_LIVE_PID 手法）。 */
const FOREIGN_LIVE_PID = 1;

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 写最小合法 subagent session.jsonl（session header + identity entry + assistant
 *  message——transcript 有历史，锚可解析）。 */
function writeSessionJsonl(
  sessionsDir: string,
  identity: { id: string; rootSessionId: string; task?: string },
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
        task: identity.task ?? "prior task body",
        slug: identity.id.replace(/^sa-/, ""),
        startedAt,
        rootSessionId: identity.rootSessionId,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "id-1",
      timestamp: new Date(startedAt + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior result text" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: startedAt + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 写 .alive marker（异进程活实例 fixture）。 */
function writeAliveMarker(sessionFile: string, pid: number, startedAt: number): void {
  fs.writeFileSync(
    `${sessionFile}.alive`,
    `${JSON.stringify({ pid, id: path.basename(sessionFile, ".jsonl"), startedAt })}\n`,
    "utf-8",
  );
}

describe("[U4 / §3.2.3] 万物可续矩阵：closedReason × message + 唯一拒绝 + reopen 降级 + 归属", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-universal-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    // modelRegistry stub：fork-from → service.execute 全链 resolveIdentity 需要
    //（modelRefFromVerified 调 source.getAvailable()，缺省时炸 TypeError）。
    const modelRegistry = {
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
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session-cur" });
    fake = registerFakePiEngine();
  });

  afterEach(async () => {
    service.dispose();
    clearEngines();
    await new Promise((r) => setTimeout(r, 0));
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  // ── ① closedReason（旧 7 值）× message：全部放行（可重连集 gate 消亡）──────

  it.each([
    "disconnected",
    "parent-shutdown",
    "user-close",
    "cancelled",
    "gc",
    "parent-fork",
    "parent-new",
  ] as const)("closedReason=%s 的磁盘 record 收 message → 同 id 续聊（resume 触达原文件）", async (reason) => {
    const file = writeSessionJsonl(sessionsDir, { id: `sa-u4-${reason}`, rootSessionId: "root-session-cur" });
    writeFinalizedState(file, reason);

    const result = await messageHandler(service, { subagentId: `sa-u4-${reason}`, text: "follow up" });
    expect(result.response.delivered).toBe(true);
    expect(result.subagentId).toBe(`sa-u4-${reason}`); // 同 id，不开新 record

    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // resume 锚点 = 原 sessionFile 续写（锚可解析 → 非 reopen 降级）
    expect(fake.runs[0]!.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(file);
    expect(fake.runs[0]!.task.prompt).toBe("follow up");

    // 翻边 running + 旧终态遗留位清除（closedReason 判据经全态快照确认）
    const snap = service.queries.findRecord(`sa-u4-${reason}`);
    expect(snap?.status).toBe("running");
    const full = service.queries.lookupRecordAnyState(`sa-u4-${reason}`);
    expect(full?.closedReason).toBeUndefined();
  });

  // ── ② 唯一拒绝 = 异进程活实例 ────────────────────────────────────────────

  it("异进程活实例（.alive + 恒活外部 pid）→ ResurrectDeniedError 含 pid 的统一占用句式（唯一拒绝形态）", async () => {
    const file = writeSessionJsonl(sessionsDir, { id: "sa-u4-alive", rootSessionId: "root-session-cur" });
    writeFinalizedState(file, "disconnected");
    writeAliveMarker(file, FOREIGN_LIVE_PID, Date.now());
    expect(findForeignLiveInstance(file)).toBeDefined(); // 探针前置自检

    const err = await messageHandler(service, { subagentId: "sa-u4-alive", text: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResurrectDeniedError);
    const msg = (err as Error).message;
    expect(msg).toContain(`pid ${FOREIGN_LIVE_PID}`);
    expect(msg).toContain("is writing this session");
    expect(msg).toContain("close it or wait for it to exit, then retry");
    // 不派发、不注册内存
    expect(fake.runs.length).toBe(0);
    expect(service.queries.findRecord("sa-u4-alive")).toBeUndefined();
  });

  // ── ③ reopen 降级：锚失效 + message ─────────────────────────────────────

  it("锚失效（内存 idle record 的 transcript 被回收）+ message → markReopened：round 归零 + epoch+1 + stopReason=reopened + 新锚 binding + 摘要注入 + resume:undefined", async () => {
    // 场景构造：冷查重建（内存 idle record，锚文件在盘）→ 删除 transcript 文件
    //（模拟 30 天 GC 回收）→ message。可达性说明：record 出内存 + 文件被删 = 冷查
    // 找不到（磁盘重建源 = jsonl/manifest）——「锚失效 + message」的现实触发面 =
    // record 仍在内存（或 manifest 源重建）而 transcript 被回收。
    const file = writeSessionJsonl(sessionsDir, { id: "sa-u4-reopen", rootSessionId: "root-session-cur" });
    const record = service.chatActions.getRecordForAction("sa-u4-reopen");
    // 模拟既往轮次状态（binding 快照域有值——摘要来源）
    record.status = "idle";
    record.round = 1;
    record.result = "round one conclusion";
    record.turnCount = 7;
    record.totalTokens = 500;
    (record as { -readonly [K in keyof typeof record]: typeof record[K] }).chatMode = true;
    record.controller = new AbortController();

    fs.rmSync(file); // 锚失效：transcript 被 GC 回收

    const r = await service.chatActions.deliverChatMessage(record, "continue after gc").then(
      () => ({ delivered: true as const }),
      (e: unknown) => e,
    );
    expect(r).toEqual({ delivered: true });
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // 世代推进：round 归零 + epoch+1 + stopReason=reopened（markReopened 原语副作用）
    expect(record.status).toBe("running");
    expect(record.round).toBe(0);
    expect(record.epoch).toBe(1);
    expect(record.stopReason).toBe("reopened");

    // resume:undefined（引擎开新 session——新锚由 run 应答回填）
    expect(fake.runs[0]!.ctx.resume?.resume).toBeUndefined();

    // 首轮 prompt = 历史摘要前缀 + 用户消息（§3.2.3 摘要来源契约）
    const prompt = fake.runs[0]!.task.prompt;
    expect(prompt).toContain("[Session reopened]");
    expect(prompt).toContain("- Completed rounds: 1");
    expect(prompt).toContain("- Usage so far: 500 tokens / 7 turns");
    expect(prompt).toContain("round one conclusion"); // 末轮 result 注入
    expect(prompt.endsWith("continue after gc")).toBe(true);

    // 新锚 binding 落盘（markReopened 内 writeRecordBinding——epoch 随 binding 持久化，
    // 跨重启单调防二次 reopen 击穿）
    const binding = readRecordBinding(record.sessionFile!);
    expect(binding?.recordId).toBe("sa-u4-reopen");
    expect(binding?.epoch).toBe(1);
    expect(binding?.transcriptRef).toMatchObject({ engine: "pi", sessionFile: record.sessionFile });
    expect(binding?.round).toBe(0);
  });

  // ── ④ 归属拒绝（跨 session 树）保留 ────────────────────────────────────

  it("跨 session 树 record（rootSessionId 异树）→ not owned 归属拒绝 + fork-from 分叉指引", async () => {
    writeSessionJsonl(sessionsDir, { id: "sa-u4-foreigen", rootSessionId: "old-root-session" });

    const err = await messageHandler(service, { subagentId: "sa-u4-foreigen", text: "hi" }).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toMatch(/not found or not owned|belongs to a different session tree/);
    expect(fake.runs.length).toBe(0);
  });

  it("fork-from 对跨树源放行（锚可解析即分叉——fork-from 不做归属校验）", async () => {
    // 锚可解析：分叉新 id。[U4 守卫 4 删除] 主动告别（user-close）源放行。
    const file = writeSessionJsonl(sessionsDir, { id: "sa-u4-fk", rootSessionId: "old-root" });
    writeFinalizedState(file, "user-close");
    const r = await forkFromHandler(service, { sourceSubagentId: "sa-u4-fk", prompt: "branch off" });
    expect(r.response.newSubagentId).not.toBe("sa-u4-fk");
    expect(r.response.sourceSessionFile).toBe(file);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // 锚不可解析 → 引导 message reopen 的守卫 5 文案，已在
    // subagent-actions-core.test.ts 单元面锁定（集成面无独立构造价值：jsonl 删除后
    // record 随磁盘源消失，守卫 2 先于守卫 5 命中）。
  });
});

// ============================================================
// buildReopenSummaryPrompt 模板契约锁定（§3.2.3 摘要来源）
// ============================================================

describe("[U4] buildReopenSummaryPrompt 模板契约", () => {
  it("全字段：task/agent/round/totalTokens/turns/lastResult 全注入 + 用户消息在尾", () => {
    const p = buildReopenSummaryPrompt({
      id: "sa-x",
      task: "research abc lib",
      agent: "general-purpose",
      round: 4,
      totalTokens: 12_345,
      turns: 9,
      lastResult: "final answer was 42",
    });
    expect(p).toContain('[Session reopened]');
    expect(p).toContain('subagent "sa-x"');
    expect(p).toContain("SAME subagent id");
    expect(p).toContain("- Task: research abc lib");
    expect(p).toContain("- Agent: general-purpose");
    expect(p).toContain("- Completed rounds: 4");
    expect(p).toContain("- Usage so far: 12345 tokens / 9 turns");
    expect(p).toContain("- Last delivered result: final answer was 42");
    expect(p).toContain("Resume the work from this summary");
  });

  it("fail-soft：用量与 result 缺省 → 显式 not retained/unknown（不虚构数据）", () => {
    const p = buildReopenSummaryPrompt({ id: "sa-y", task: "t", agent: "a", round: 0 });
    expect(p).not.toContain("- Usage so far:"); // 用量缺省整行省略
    expect(p).toContain("- Last delivered result: (not retained)");
  });
});

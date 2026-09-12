// src/__tests__/tool-action.test.ts
//
// tool action 路由 + adapter 出参结构测试（AC-2/AC-3/AC-9）。
// 用 stub SubagentService（不依赖真实 SDK），测 handler + adapter 纯逻辑。

import { describe, expect, it, vi } from "vitest";

import { adapter, cancelHandler, listHandler, startHandler } from "../interface/subagent-actions.ts";
import { SubagentParams } from "../interface/subagent-tool-schema.ts";
import type { SubagentService } from "@zhushanwen/subagent-core";
import type {
  ExecutionHandle,
  RecordSnapshot,
  SubagentRecord,
  SubagentToolDetails,
} from "@zhushanwen/subagent-core/execution/types.ts";

// ── stub 工厂 ──

function makeDetails(over: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    status: "closed",
    mode: "background",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    slug: "test-slug",
    turns: 1,
    totalTokens: 10,
    elapsedSeconds: 1,
    eventLog: [],
    result: "ok",
    ...over,
  };
}

function makeSnapshot(over: Partial<RecordSnapshot> = {}): RecordSnapshot {
  return {
    id: "run-1",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "t",
    slug: "test-slug",
    status: "closed",
    eventLog: [],
    turns: 1,
    totalTokens: 10,
    startedAt: 1000,
    endedAt: 2000,
    result: "ok",
    error: undefined,
    sessionFile: undefined,
    ...over,
  };
}

function makeService(over: Partial<SubagentService> = {}): SubagentService {
  const service = {
    execute: vi.fn(),
    findRecord: vi.fn(() => undefined),
    cancel: vi.fn(() => false),
    collectRecords: vi.fn(() => [] as SubagentRecord[]),
    // [perf] listHandler 逐项 enrich 会调 getFullRecord；mock 回 undefined → 调用方回退 light record
    getFullRecord: vi.fn(() => undefined as SubagentRecord | undefined),
    // [U1/U2] collect 契约面：startHandler 解析链（E4 守卫前置）必调；stub 回缺省 async
    getCollectSyncDefault: vi.fn(() => "async" as const),
    ...over,
  } as SubagentService;
  // [D4 聚合跟随] 读面经 service.queries——视图成员取 over 覆盖后的平铺键（同引用，
  // 外部 spy 断言不受影响）。
  const flat = service as unknown as Record<string, unknown>;
  (service as unknown as { queries: Record<string, unknown> }).queries = {
    findRecord: flat.findRecord,
    collectRecords: flat.collectRecords,
    getFullRecord: flat.getFullRecord,
    lookupRecordAnyState: vi.fn(() => undefined),
    onChange: vi.fn(() => () => {}),
  };
  return service;
}

// ============================================================
// startHandler
// ============================================================
describe("startHandler", () => {
  it("缺 input → throw + Correct 正例", async () => {
    const svc = makeService();
    await expect(startHandler(svc, undefined, undefined)).rejects.toThrow(/task and slug/);
    // Correct 正例存在（让弱模型撞错后能直接照抄平铺形态）
    await expect(startHandler(svc, undefined, undefined)).rejects.toThrow(/Correct: \{"action":"start"/);
  });

  it("task 空白 → throw + Correct 正例", async () => {
    const svc = makeService();
    await expect(startHandler(svc, { task: "   ", slug: "x" }, undefined)).rejects.toThrow(/task is required/);
    await expect(startHandler(svc, { task: "   ", slug: "x" }, undefined)).rejects.toThrow(/Correct: \{"action":"start"/);
  });

  it("slug 缺失 → throw + Correct 正例", async () => {
    const svc = makeService();
    await expect(startHandler(svc, { task: "ok" }, undefined)).rejects.toThrow(/slug is required/);
    await expect(startHandler(svc, { task: "ok" }, undefined)).rejects.toThrow(/Correct: \{"action":"start"/);
  });

  it("slug 空白 → throw + Correct 正例", async () => {
    const svc = makeService();
    await expect(startHandler(svc, { task: "ok", slug: "   " }, undefined)).rejects.toThrow(/slug is required/);
    await expect(startHandler(svc, { task: "ok", slug: "   " }, undefined)).rejects.toThrow(/Correct: \{"action":"start"/);
  });

  it("slug 超 35 字符 → throw", async () => {
    const svc = makeService();
    await expect(
      startHandler(svc, { task: "ok", slug: "a".repeat(36) }, undefined),
    ).rejects.toThrow(/≤35 chars/);
  });

  it("background 启动 → kind=bg + bgResponse.message 含 detached + notifyContract 恒值", async () => {
    const svc = makeService({
      execute: vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "background",
        subagentId: "bg-1-123",
        sessionFile: undefined,
        details: makeDetails({ status: "running", mode: "background" }),
      })),
    });
    const r = await startHandler(svc, { task: "long", slug: "long-running" }, undefined);
    expect(r.kind).toBe("bg");
    if (r.kind !== "bg") return;
    expect(r.subagentId).toBe("bg-1-123");
    expect(r.response.message).toMatch(/detached/);
    // [U1] 通知投递契约回显位（U2 账本兑现）
    expect(r.response.notifyContract).toBe("ledger+at-least-once");
  });

  it("[U1] start 返回值 model 为 registry 全等回显（透传 handle.details.model）", async () => {
    const svc = makeService({
      execute: vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "background",
        subagentId: "bg-2-456",
        sessionFile: undefined,
        // record.model = resolved（裁决放行条目）拼接的 "provider/id"，保留 registry 大小写
        details: makeDetails({ status: "running", mode: "background", model: "zai-coding-cn/GLM-5.3-Flash" }),
      })),
    });
    const r = await startHandler(svc, { task: "t", slug: "s" }, undefined);
    expect(r.model).toBe("zai-coding-cn/GLM-5.3-Flash");
    // adapter 外层 result 同源回显
    const toolResult = adapter({ action: "start", domain: r });
    const result = toolResult.details;
    if (result.action !== "start") throw new Error("expected start variant");
    expect(result.model).toBe("zai-coding-cn/GLM-5.3-Flash");
    // LLM content JSON 同源（与 details 一致）
    const contentJson = JSON.parse(toolResult.content[0]!.type === "text" ? toolResult.content[0].text : "{}");
    expect(contentJson.model).toBe("zai-coding-cn/GLM-5.3-Flash");
    expect(contentJson.bgResponse.notifyContract).toBe("ledger+at-least-once");
  });

  it("[U1] model 非全等 → 裁决错误向上传播（无 bgResponse 产出，execute 不重试）", async () => {
    // 裁决发生在 service.execute 内部步骤 1（IDENTITY 解析 → resolveModel），在 record
    // 创建 / runSpawn 之前——错误直接向上传播为 tool isError。resolveModel 层的拒单
    // 行为（含 P-A2 双路径）由 model-ref.test.ts + model-resolver.test.ts 锁定；本用例
    // 锁定 handler 层传播语义：异常穿越 startHandler，不产出任何受理响应。
    const svc = makeService({
      execute: vi.fn(async () => {
        throw new Error(
          'Model "zai-coding-cn/glm-5.3-flash" (paramOverride) is not a registry entry. ' +
            "Did you mean one of these?\n  zai-coding-cn/GLM-5.3-Flash",
        );
      }),
    });
    await expect(
      startHandler(svc, { task: "t", slug: "s", model: "zai-coding-cn/glm-5.3-flash" }, undefined),
    ).rejects.toThrow(/is not a registry entry.*Did you mean/s);
    expect(svc.execute).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// listHandler
// ============================================================
describe("listHandler", () => {
  it("空 → running:0, items:[]", () => {
    const svc = makeService({ collectRecords: vi.fn(() => [] as SubagentRecord[]) });
    const r = listHandler(svc, undefined);
    expect(r.response).toEqual({ running: 0, items: [] });
  });

  it("limit 夹紧 [1,100]——collectRecords 收到夹紧后的值（C1 回归）", () => {
    const collect = vi.fn(() => [] as SubagentRecord[]);
    const svc = makeService({ collectRecords: collect });
    // includeFinished=true 时 filter="all"，验证 limit 夹紧：
    // 0 → 1
    listHandler(svc, { includeFinished: true, limit: 0 });
    expect(collect).toHaveBeenLastCalledWith(1, "all", false);
    // 100000 → 100
    listHandler(svc, { includeFinished: true, limit: 100000 });
    expect(collect).toHaveBeenLastCalledWith(100, "all", false);
    // undefined → 20（默认）
    listHandler(svc, { includeFinished: true });
    expect(collect).toHaveBeenLastCalledWith(20, "all", false);
    // 负数 → 1
    listHandler(svc, { includeFinished: true, limit: -5 });
    expect(collect).toHaveBeenLastCalledWith(1, "all", false);
  });

  it("includeFinished=false → collectRecords 收到 filter='running'（C2 回归）", () => {
    const collect = vi.fn(() => [] as SubagentRecord[]);
    const svc = makeService({ collectRecords: collect });
    // includeFinished=false → filter="running"（防截断下沉到 store）
    listHandler(svc, { includeFinished: false, limit: 5 });
    expect(collect).toHaveBeenLastCalledWith(5, "running", false);
    // includeFinished=true → filter="all"
    listHandler(svc, { includeFinished: true, limit: 5 });
    expect(collect).toHaveBeenLastCalledWith(5, "all", false);
  });

  it("includeFinished=false → collectRecords 返回 running-only（过滤在 store 层）", () => {
    // store 层已过滤，listHandler 只做透传——mock 返回的即 running-only。
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "running", mode: "background", startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: false });
    expect(r.response.items).toHaveLength(1);
    expect(r.response.items[0].subagentId).toBe("r1");
    expect(r.response.running).toBe(1);
  });

  it("item 8 字段齐全（含 duration 实时计算）", () => {
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "closed", mode: "background", startedAt: 1000, endedAt: 2500, turns: 2, totalTokens: 50, model: "m", thinkingLevel: "high", eventLog: [], sessionFile: "x.jsonl" },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: true });
    const item = r.response.items[0];
    expect(item).toMatchObject({
      subagentId: "r1", agent: "w", status: "closed", mode: "background",
      duration: 1, model: "m", totalTokens: 50, sessionFile: "x.jsonl",
    });
  });

  it("items 超过 limit → 截断在 store 层（listHandler 透传 limit）", () => {
    // 截断责任在 collectRecords（store 层），listHandler 只透传 limit + map。
    // mock 返回 3 条（模拟 store 未截断），验证 listHandler 不自行截断——全量透传。
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "running", mode: "background", startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "r2", agent: "w", status: "running", mode: "background", startedAt: 2, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "r3", agent: "w", status: "running", mode: "background", startedAt: 3, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
    ];
    const collect = vi.fn(() => records);
    const svc = makeService({ collectRecords: collect });
    const r = listHandler(svc, { includeFinished: true, limit: 2 });
    // listHandler 透传 collectRecords 的结果（截断是 store 的责任）。
    expect(r.response.items).toHaveLength(3);
    // 验证 limit 确实透传给了 collectRecords。
    expect(collect).toHaveBeenCalledWith(2, "all", false);
  });

  // TC-2: running 态实时 duration（Date.now()-startedAt）随时间增长，
  // 区别于终态 endedAt-startedAt。喂给 live TUI，更易出 bug。
  it("running 态 duration 实时计算：两次 list 间隔 2s，duration 差 = 2（TC-2）", () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const records: SubagentRecord[] = [
        { id: "r1", agent: "w", status: "running", mode: "background", startedAt: 7_000, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      ];
      const svc = makeService({ collectRecords: vi.fn(() => records) });
      const r1 = listHandler(svc, { includeFinished: true });
      expect(r1.response.items[0].duration).toBe(3); // (10-7)s
      vi.advanceTimersByTime(2_000);
      const r2 = listHandler(svc, { includeFinished: true });
      expect(r2.response.items[0].duration).toBe(5); // (12-7)s
    } finally {
      vi.useRealTimers();
    }
  });

  // TC-3: listHandler 保持 collectRecords 返回的顺序（排序责任在 service 层，
  // listHandler 是顺序透传）。故意传入反序 list 验证 listHandler 不自行排序。
  it("保持 collectRecords 顺序，不自行重排（TC-3）", () => {
    // 故意按 startedAt 升序（与 desc 相反）
    const records: SubagentRecord[] = [
      { id: "old", agent: "w", status: "running", mode: "background", startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "new", agent: "w", status: "running", mode: "background", startedAt: 5, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: true });
    expect(r.response.items.map((i) => i.subagentId)).toEqual(["old", "new"]);
  });
});

// ============================================================
// cancelHandler
// ============================================================
describe("cancelHandler", () => {
  it("缺 subagentId → throw", async () => {
    const svc = makeService();
    await expect(cancelHandler(svc, undefined)).rejects.toThrow(/subagentId is required/);
    await expect(cancelHandler(svc, { subagentId: "  " })).rejects.toThrow(/subagentId is required/);
  });

  it("id 不存在 → throw No subagent record", async () => {
    const svc = makeService({ findRecord: vi.fn(() => undefined) });
    await expect(cancelHandler(svc, { subagentId: "nope" })).rejects.toThrow(/No subagent record with id "nope"/);
  });

  it("[S-19] id 属树内其他进程的 running record（磁盘可见、本进程内存无）→ throw 跨进程专属消息", async () => {
    // MF-1 全树可见后：子进程 list 能看到父/兄弟进程的 running record，但 cancel 只作用于
    // 本进程内存。旧消息「may have finished」误导（该 record 未 finished、正被列出）。
    const foreign: SubagentRecord = {
      id: "bg-foreign", agent: "w", status: "running", mode: "background", startedAt: 1,
      endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [],
    };
    const svc = makeService({
      findRecord: vi.fn(() => undefined),
      collectRecords: vi.fn(() => [foreign] as SubagentRecord[]),
    });
    await expect(cancelHandler(svc, { subagentId: "bg-foreign" })).rejects.toThrow(/owned by another process in the tree/);
  });

  it("[S-19] id 在树内但已终态（磁盘可见 done）→ 仍用 may have finished 消息", async () => {
    const done: SubagentRecord = {
      id: "bg-done", agent: "w", status: "closed", mode: "background", startedAt: 1,
      endedAt: 2, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [],
    };
    const svc = makeService({
      findRecord: vi.fn(() => undefined),
      collectRecords: vi.fn(() => [done] as SubagentRecord[]),
    });
    await expect(cancelHandler(svc, { subagentId: "bg-done" })).rejects.toThrow(/may have finished/);
  });

  it("已终态（cancel 返回 false）→ throw could not be cancelled", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "bg-1", mode: "background", status: "closed" })),
      cancel: vi.fn(() => false),
    });
    await expect(cancelHandler(svc, { subagentId: "bg-1" })).rejects.toThrow(/could not be cancelled.*status: closed/);
  });

  it("成功 → cancelled:true", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "bg-1", mode: "background", status: "running" })),
      cancel: vi.fn(() => true),
    });
    const r = await cancelHandler(svc, { subagentId: "bg-1" });
    expect(r.subagentId).toBe("bg-1");
    expect(r.response.cancelled).toBe(true);
  });

  // TC-1: 并发 CAS 场景——同一 id 两次 cancel，第一次抢锁成功，第二次 CAS 失败后
  // re-query 到终态。覆盖 cancelHandler 的 re-query 分支（subagent-actions.ts:267-272）。
  it("并发 CAS：两次 cancel 同一 id，第二次 CAS 失败 re-query 到终态", async () => {
    const running = makeSnapshot({ id: "bg-cas", mode: "background", status: "running" });
    const done = makeSnapshot({ id: "bg-cas", mode: "background", status: "closed" });

    let cancelCalls = 0;
    const svc = makeService({
      // findRecord 调用序列：
      //   call 1: 第一次 cancel 初始查询 → running
      //   call 2: 第二次 cancel 初始查询 → running（快照尚未过期）
      //   call 3: 第二次 cancel CAS 失败后 re-query → done（状态已变）
      findRecord: vi.fn()
        .mockReturnValueOnce(running)
        .mockReturnValueOnce(running)
        .mockReturnValueOnce(done),
      cancel: vi.fn(() => {
        cancelCalls++;
        return cancelCalls === 1; // 第一次 true，第二次 false（CAS 失败）
      }),
    });

    // 第一次 cancel：抢锁成功
    const r1 = await cancelHandler(svc, { subagentId: "bg-cas" });
    expect(r1.response.cancelled).toBe(true);

    // 第二次 cancel：CAS 失败，re-query 返回 closed（不是初始的 running）
    await expect(cancelHandler(svc, { subagentId: "bg-cas" }))
      .rejects.toThrow(/could not be cancelled.*status: closed/);

    // 验证 re-query 确实发生（3 次 findRecord：1 初始 + 1 初始 + 1 re-query）
    expect(svc.findRecord).toHaveBeenCalledTimes(3);
    expect(svc.cancel).toHaveBeenCalledTimes(2);
  });

  // BL-3 回归：CAS 失败后 re-query 时 record 已被 archive 移出内存，
  // 文案诚实报告 "evicted" 而非回落到可能过期的 stale status。
  it("CAS 失败 + record 被内存淘汰 → 文案诚实报告 evicted（BL-3）", async () => {
    const svc = makeService({
      // 第一次 findRecord：初始查询 → running
      // 第二次 findRecord：CAS 失败后 re-query → undefined（已被淘汰）
      findRecord: vi.fn()
        .mockReturnValueOnce(makeSnapshot({ id: "bg-evict", mode: "background", status: "running" }))
        .mockReturnValueOnce(undefined),
      cancel: vi.fn(() => false),
    });
    await expect(cancelHandler(svc, { subagentId: "bg-evict" }))
      .rejects.toThrow(/could not be cancelled.*status: unknown \(evicted from memory\)/);
    expect(svc.findRecord).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// adapter
// ============================================================
describe("adapter", () => {
  it("start bg → SubagentToolResult.bgResponse + slug 透传 + content 合法 JSON（C3 回归）", () => {
    const r = adapter({
      action: "start",
      domain: {
        kind: "bg", subagentId: "bg-1", sessionFile: undefined, slug: "extract-urls",
        response: { status: "running", mode: "background", message: "detached, will notify on completion" },
      },
    });
    expect(r.details.action).toBe("start");
    expect(r.details.subagentId).toBe("bg-1");
    expect(r.details.bgResponse).toBeDefined();
    expect(r.details.sessionFile).toBeNull();
    // slug 透传到 result（renderResult 的 background 行展示用）
    expect(r.details.slug).toBe("extract-urls");
    // content JSON round-trip（bg 序列化回归）
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.bgResponse.message).toMatch(/detached/);
    expect(parsed.slug).toBe("extract-urls");
  });

  it("list → 最外层 subagentId/sessionFile 为 null", () => {
    const r = adapter({ action: "list", domain: { response: { running: 0, items: [] } } });
    expect(r.details.action).toBe("list");
    expect(r.details.subagentId).toBeNull();
    expect(r.details.sessionFile).toBeNull();
    expect(r.details.listResponse).toEqual({ running: 0, items: [] });
  });

  // [U3 C-outcome] 对外 JSON 契约：list items 携带 outcome 且旧字段保留（验收③）。
  it("[U3] list JSON：items[].outcome 在位（failed 值）且 status/mode/state 旧字段保留", () => {
    const r = adapter({
      action: "list",
      domain: {
        response: {
          running: 0,
          items: [
            {
              subagentId: "bg-u3", agent: "w", slug: "s", state: "ended", status: "closed",
              mode: "background", duration: 1, model: "m", totalTokens: 0,
              outcome: "failed",
            },
          ],
        },
      },
    });
    const parsed = JSON.parse(r.content[0]!.text) as {
      listResponse: { items: Array<Record<string, unknown>> };
    };
    const item = parsed.listResponse.items[0]!;
    expect(item.outcome).toBe("failed");
    // 旧字段保留（向后兼容）
    expect(item.status).toBe("closed");
    expect(item.state).toBe("ended");
    expect(item.mode).toBe("background");
    // closedReason 退出对外 JSON
    expect("closedReason" in item).toBe(false);
  });

  // [U3 C-outcome] start bgResponse：旧字段保留；outcome 为契约完备位，start 时点
  // record 未终态恒 undefined（JSON.stringify 落键省略），终态成败经 list items 披露。
  it("[U3] start bgResponse JSON：status/mode/message 旧字段保留，outcome 起点为 undefined", () => {
    const r = adapter({
      action: "start",
      domain: {
        kind: "bg", subagentId: "bg-u3-2", sessionFile: undefined, slug: "s",
        response: { status: "running", mode: "background", message: "detached" },
      },
    });
    const parsed = JSON.parse(r.content[0]!.text) as { bgResponse: Record<string, unknown> };
    expect(parsed.bgResponse.status).toBe("running");
    expect(parsed.bgResponse.mode).toBe("background");
    expect(parsed.bgResponse.message).toBe("detached");
    expect(parsed.bgResponse.outcome).toBeUndefined();
  });

  it("cancel → cancelResponse.cancelled:true 字面量", () => {
    const r = adapter({ action: "cancel", domain: { subagentId: "bg-1", response: { cancelled: true } } });
    expect(r.details.cancelResponse).toEqual({ cancelled: true });
    expect(r.details.subagentId).toBe("bg-1");
  });
});

// ============================================================
// [H2 W1] listHandler includeWorkflow（record-unification D1①）
//
// 过滤责任在 store 层（collectRecords 第三参），listHandler 只透传——stub 的
// collectRecords 按第三参分流返回，模拟 store 的缺省过滤 / includeWorkflow 放行。
// ============================================================
describe("listHandler includeWorkflow（H2 W1：workflow record 投影过滤面）", () => {
  const toolRecord: SubagentRecord = {
    id: "tool-1", agent: "w", status: "running", mode: "background",
    startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [],
  };
  const wfRecord: SubagentRecord = {
    id: "wf-1", agent: "w", status: "running", mode: "background",
    startedAt: 2, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [],
    origin: "workflow", parentRunId: "run-1",
  };

  /** stub collectRecords：模拟 store 层行为（第三参 false = 缺省滤 workflow，true = 全量）。 */
  function storeLikeCollect(limit: number, _filter: string, includeWorkflow?: boolean): SubagentRecord[] {
    void limit;
    return includeWorkflow === true ? [toolRecord, wfRecord] : [toolRecord];
  }

  it("缺省（includeWorkflow 未传）→ collectRecords 第三参 false，workflow record 不可见", () => {
    const collect = vi.fn(storeLikeCollect);
    const svc = makeService({ collectRecords: collect });
    const r = listHandler(svc, { includeFinished: true });
    expect(collect).toHaveBeenLastCalledWith(20, "all", false);
    expect(r.response.items.map((i) => i.subagentId)).toEqual(["tool-1"]);
  });

  it("includeWorkflow:true → 第三参 true，workflow record 可见（排查通道）", () => {
    const collect = vi.fn(storeLikeCollect);
    const svc = makeService({ collectRecords: collect });
    const r = listHandler(svc, { includeFinished: true, includeWorkflow: true });
    expect(collect).toHaveBeenLastCalledWith(20, "all", true);
    expect(r.response.items.map((i) => i.subagentId)).toEqual(expect.arrayContaining(["tool-1", "wf-1"]));
  });

  it("includeWorkflow:false 显式传 → 同缺省（第三参 false）", () => {
    const collect = vi.fn(storeLikeCollect);
    const svc = makeService({ collectRecords: collect });
    const r = listHandler(svc, { includeFinished: true, includeWorkflow: false });
    expect(collect).toHaveBeenLastCalledWith(20, "all", false);
    expect(r.response.items.map((i) => i.subagentId)).toEqual(["tool-1"]);
  });

  it("schema 面：listParam.includeWorkflow 声明存在且 optional（D1① 工具契约）", () => {
    // 本包 typebox 被 alias 到 mock（丢 options）：JSON 往返断言数据形态；
    // 真实 typebox 编译契约由 structured-output cross-package-contract.test.ts 承担。
    const raw: unknown = JSON.parse(JSON.stringify(SubagentParams));
    if (!(typeof raw === "object" && raw !== null)) throw new Error("SubagentParams is not an object schema");
    const props = (raw as { properties?: unknown }).properties;
    if (!(typeof props === "object" && props !== null)) throw new Error("SubagentParams has no properties");
    const listParam = (props as Record<string, unknown>).listParam;
    if (!(typeof listParam === "object" && listParam !== null)) throw new Error("listParam missing");
    const listProps = (listParam as { properties?: unknown }).properties;
    if (!(typeof listProps === "object" && listProps !== null)) throw new Error("listParam has no properties");
    expect(Object.keys(listProps)).toEqual(expect.arrayContaining(["includeFinished", "includeWorkflow", "limit"]));
    const includeWorkflow = (listProps as Record<string, unknown>).includeWorkflow;
    expect(includeWorkflow).toBeDefined();
    const req = (listParam as { required?: unknown }).required;
    if (Array.isArray(req)) {
      expect(req).not.toContain("includeWorkflow");
    }
  });
});

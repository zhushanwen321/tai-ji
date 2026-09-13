// src/execution/__tests__/start-collect-guard.test.ts
//
// startHandler 的 collect 语义（subagent-sync-collect U1 foundation）：
//   1. E4 校验（设计 §3.1.5）：conversation:true + collect:"sync" → immediate throw，
//      不产生半启动 record（execute 零调用）；文案指引「sync 仅支持 one-shot，
//      去掉 conversation 或 collect」；
//   2. 合法组合放行：collect 透传 service.execute（ExecuteOptions.collect）；
//   3. start 响应 collect 段（设计 §3.1.1）：仅 resolved=sync 附段（async 响应字节
//      零变化，G3）；pendingSyncCount = 未闭合批 sync 成员数（collectMode=sync 且无
//      batchFinalized；U2 偏差#4 接线后 record 落 collectMode，枚举天然含本条，无 +1）。
//
// stub SubagentService 仅实现 handler 触达的方法子集（subagent-actions-core.test.ts
// 同款形态）；真实 service 行为归属 subagent-service 各自测试。

import { describe, expect, it, vi, type Mock } from "vitest";

import { startHandler } from "../assembly/subagent-actions-core.ts";
// SubagentService 的权威源是 subagent-service.ts（types.ts 只有 record/tool 契约）
import type { SubagentService } from "../subagent-service.ts";
import type { StatusFilter } from "../persistence/record-store.ts";
import type {
  ExecutionHandle,
  SubagentRecord,
  SubagentToolDetails,
} from "../assembly/types.ts";

function makeDetails(): SubagentToolDetails {
  return {
    status: "running",
    mode: "background",
    agent: "/home/u/agents/worker.md",
    model: "prov/m1",
    thinkingLevel: undefined,
    slug: "src-slug",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
  } as SubagentToolDetails;
}

function makeHandle(): ExecutionHandle {
  return { mode: "background", subagentId: "sa-new", sessionFile: undefined, details: makeDetails() };
}

/** collectRecords stub 数据行（只含 pendingSyncCount 口径判读所需字段）。 */
function makeRec(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  } as SubagentRecord;
}

// Mock<T> 具名签名 + Omit 类原生同名成员：ReturnType<typeof vi.fn>
// （= Mock<Procedure | Constructable>）与类方法签名交叉会收窄 never
type ServiceStub = Omit<SubagentService, "execute" | "collectRecords" | "getCollectSyncDefault"> & {
  // 带首参形态：断言消费 execute.mock.calls[0][0]（ExecuteOptions），零参签名为空元组取不到
  execute: Mock<(opts: Record<string, unknown>) => Promise<SubagentRecord>>;
  collectRecords: Mock<(limit: number, statusFilter?: StatusFilter) => SubagentRecord[]>;
  getCollectSyncDefault: Mock<() => "async" | "sync">;
};

/** startHandler 的测试包装：stub → SubagentService 断言收口一处（类私有成员不可结构模拟）。 */
function sh(svc: ServiceStub, input: Record<string, unknown>, signal?: AbortSignal) {
  return startHandler(
    svc as unknown as SubagentService,
    input as Parameters<typeof startHandler>[1],
    signal ?? undefined,
  );
}

function makeService(
  collectRecordsReturn: SubagentRecord[] = [],
  collectSyncDefault: "async" | "sync" = "async",
): ServiceStub {
  const execute = vi.fn(async (_opts: Record<string, unknown>) => makeHandle());
  const collectRecords = vi.fn(() => collectRecordsReturn);
  const getCollectSyncDefault = vi.fn(() => collectSyncDefault);
  // [D4-① 适配] countPendingSyncRecords 经查询面聚合读 collectRecords（dev 重构后
  // service.collectRecords 收窄 private，public 出口 = service.queries.collectRecords）。
  return {
    execute,
    queries: { collectRecords },
    collectRecords,
    getCollectSyncDefault,
  } as unknown as ServiceStub;
}

const BASE_INPUT = { task: "do things", slug: "do-things" };

// ============================================================
// E4：conversation + collect:"sync" 即拒
// ============================================================

describe("startHandler E4 guard (conversation + collect:sync)", () => {
  it("throws immediately and never calls execute (不产生半启动 record)", async () => {
    const service = makeService();
    await expect(
      sh(service, { ...BASE_INPUT, conversation: true, collect: "sync" }, undefined),
    ).rejects.toThrow();
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("error copy carries the design guidance verbatim (文案锚定)", async () => {
    const service = makeService();
    const err = await sh(service,
      { ...BASE_INPUT, conversation: true, collect: "sync" },
      undefined,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'collect:"sync" only supports one-shot subagents — it cannot be combined with conversation:true. ' +
      'Remove either conversation or collect (use collect:"async", or omit it, for conversational subagents).',
    );
  });

  it("allows conversation:true + collect:async (async 语义与 conversation 正交)", async () => {
    const service = makeService();
    const result = await sh(service,
      { ...BASE_INPUT, conversation: true, collect: "async" },
      undefined,
    );
    expect(result.subagentId).toBe("sa-new");
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it("allows collect:sync alone (one-shot sync 是合法主场景)", async () => {
    const service = makeService();
    const result = await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.subagentId).toBe("sa-new");
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it("E4 also blocks conversation when config default is sync (偏差#3 接线：resolved 含 config 默认)", async () => {
    const service = makeService([], "sync");
    await expect(
      sh(service, { ...BASE_INPUT, conversation: true }, undefined),
    ).rejects.toThrow('collect:"sync" only supports one-shot subagents');
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("config default=sync applies when collect omitted (缺省读真实 config，U2 偏差#3)", async () => {
    const service = makeService([], "sync");
    const result = await sh(service, { ...BASE_INPUT }, undefined);
    expect(result.response.collect).toBeDefined();
    expect(service.getCollectSyncDefault).toHaveBeenCalledTimes(1);
  });

  it("reads config default via service accessor when collect omitted (async 默认零附段)", async () => {
    const service = makeService([], "async");
    const result = await sh(service, { ...BASE_INPUT }, undefined);
    expect(result.response.collect).toBeUndefined();
    expect(service.getCollectSyncDefault).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// collect 透传 + 响应 collect 段
// ============================================================

describe("startHandler collect forwarding + response collect segment", () => {
  it("forwards collect to service.execute via ExecuteOptions.collect", async () => {
    const service = makeService();
    await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBe("sync");
  });

  it("omits collect in ExecuteOptions when not provided (resolved≠sync 时保持 undefined，async 缺省语义)", async () => {
    const service = makeService();
    await sh(service, { ...BASE_INPUT }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBeUndefined();
  });

  it("B1：config default=sync + 省略 collect → execute 收 collect:\"sync\"（缺省解析作用于 record 本体）", async () => {
    // 修复前：execute 收原始 input.collect=undefined → createRecordForMode 只认
    // ==="sync" → record 走 async 逐条通知而响应声称已入批（设计 §3.1.3/types.ts:689
    // 承诺「缺省 = config 默认」作用于 record）。修复后 resolved=sync 落值。
    const service = makeService([], "sync");
    await sh(service, { ...BASE_INPUT }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBe("sync");
  });

  it("B1：config default=sync 时显式 collect:\"async\" 优先（execute 收 \"async\"）", async () => {
    const service = makeService([], "sync");
    await sh(service, { ...BASE_INPUT, collect: "async" }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBe("async");
  });

  it("attaches collect segment counting this very record from the enumeration (U2 偏差#4：无 +1 补偿)", async () => {
    // 本条 record（id=sa-new）已由 createRecordForMode 落 collectMode 入枚举：
    // stub 枚举返回本条 + 另一未闭合 sync → count=2（无 +1 补偿即含本条）
    const service = makeService([
      makeRec({ id: "sa-new", collectMode: "sync" }),
      makeRec({ id: "sa-other", collectMode: "sync", status: "running" }),
      makeRec({ id: "sa-gone", collectMode: "sync", batchFinalized: true }),
    ]);
    const result = await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 2 });
  });

  it("reports the enumeration verbatim when no sync records exist yet (如实反映，无补偿)", async () => {
    const service = makeService([]);
    const result = await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 0 });
  });

  it("counts pending unmarked sync members from the enumeration (跨轮续累口径)", async () => {
    const service = makeService([
      makeRec({ id: "sa-1", collectMode: "sync" }), // 未闭合（无 batchFinalized）→ 计入
      makeRec({ id: "sa-2", collectMode: "sync", batchFinalized: true }), // 已离场 → 排除
      makeRec({ id: "sa-3" }), // async → 排除
      makeRec({ id: "sa-4", collectMode: "sync", batchFinalized: false }), // 显式 false → 计入
    ]);
    const result = await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 2 });
  });

  it("omits the collect segment for async starts (G3: async 响应字节零变化)", async () => {
    for (const input of [{ ...BASE_INPUT }, { ...BASE_INPUT, collect: "async" as const }]) {
      const service = makeService();
      const result = await sh(service, input, undefined);
      expect(result.response.collect).toBeUndefined();
      // G3 字节锚：response 其余字段与既有形态全等
      expect(result.response).toEqual({
        status: "running",
        mode: "background",
        message: result.response.message,
        notifyContract: "ledger+at-least-once",
      });
    }
  });
});

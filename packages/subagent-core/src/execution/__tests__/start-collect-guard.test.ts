// src/execution/__tests__/start-collect-guard.test.ts
//
// startHandler 的 collect 语义（subagent-sync-collect U1 foundation + [modeless 波3]）：
//   1. [modeless 波3·E4 删除] collect:"sync" + conversation:true 组合放行——collect 是
//      派发时的通知路由选项（批闭合自动 close 后组合的升级语义面消亡），不再是
//      record 模式，无需前置拒；
//   2. collect 透传 service.execute（ExecuteOptions.collect）；
//   3. start 响应 collect 段（设计 §3.1.1）：仅 resolved=sync 附段（async 响应字节
//      零变化，G3）；pendingSyncCount = 协调器登记态成员数（service.pendingSyncMemberCount
//      委托——[modeless 波3] 派发登记含本条，无 +1 补偿）。
//
// stub SubagentService 仅实现 handler 触达的方法子集（subagent-actions-core.test.ts
// 同款形态）；真实 service 行为归属 subagent-service 各自测试。

import { describe, expect, it, vi, type Mock } from "vitest";

import { startHandler } from "../assembly/subagent-actions-core.ts";
// SubagentService 的权威源是 subagent-service.ts（types.ts 只有 record/tool 契约）
import type { SubagentService } from "../subagent-service.ts";
import type {
  ExecutionHandle,
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

// Mock<T> 具名签名 + Omit 类原生同名成员：ReturnType<typeof vi.fn>
// （= Mock<Procedure | Constructable>）与类方法签名交叉会收窄 never
type ServiceStub = Omit<SubagentService, "execute" | "getCollectSyncDefault" | "pendingSyncMemberCount"> & {
  // 带首参形态：断言消费 execute.mock.calls[0][0]（ExecuteOptions），零参签名为空元组取不到
  execute: Mock<(opts: Record<string, unknown>) => Promise<ExecutionHandle>>;
  getCollectSyncDefault: Mock<() => "async" | "sync">;
  pendingSyncMemberCount: Mock<() => number>;
};

/** startHandler 的测试包装：stub → SubagentService 断言收口一处（类私有成员不可结构模拟）。 */
function sh(svc: ServiceStub, input: Record<string, unknown>, signal?: AbortSignal) {
  return startHandler(
    svc as unknown as SubagentService,
    input as Parameters<typeof startHandler>[1],
    signal ?? undefined,
  );
}

function makeService(pendingSyncCount = 0, collectSyncDefault: "async" | "sync" = "async"): ServiceStub {
  const execute = vi.fn(async (_opts: Record<string, unknown>) => makeHandle());
  const getCollectSyncDefault = vi.fn(() => collectSyncDefault);
  const pendingSyncMemberCount = vi.fn(() => pendingSyncCount);
  // [modeless 波3] pendingSyncCount 口径改协调器登记态（service.pendingSyncMemberCount
  // 委托）——collectRecords 枚举面随 collectMode 字段消亡退役。
  return {
    execute,
    getCollectSyncDefault,
    pendingSyncMemberCount,
  } as unknown as ServiceStub;
}

const BASE_INPUT = { task: "do things", slug: "do-things" };

// ============================================================
// [modeless 波3] E4 删除：sync + conversation 组合放行
// ============================================================

describe("startHandler collect combinations ([modeless 波3] E4 deleted)", () => {
  it("allows conversation:true + collect:sync (E4 前置拒已删——collect 是路由选项非 record 模式)", async () => {
    const service = makeService();
    const result = await sh(service,
      { ...BASE_INPUT, conversation: true, collect: "sync" },
      undefined,
    );
    expect(result.subagentId).toBe("sa-new");
    expect(service.execute).toHaveBeenCalledTimes(1);
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

  it("conversation + config default=sync also passes (E4 的 config 默认拦截面同批删除)", async () => {
    const service = makeService(0, "sync");
    const result = await sh(service, { ...BASE_INPUT, conversation: true }, undefined);
    expect(result.subagentId).toBe("sa-new");
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it("config default=sync applies when collect omitted (缺省读真实 config，U2 偏差#3)", async () => {
    const service = makeService(0, "sync");
    const result = await sh(service, { ...BASE_INPUT }, undefined);
    expect(result.response.collect).toBeDefined();
    expect(service.getCollectSyncDefault).toHaveBeenCalledTimes(1);
  });

  it("reads config default via service accessor when collect omitted (async 默认零附段)", async () => {
    const service = makeService(0, "async");
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

  it("B1：config default=sync + 省略 collect → execute 收 collect:\"sync\"（缺省解析作用于派发路由）", async () => {
    // 修复前：execute 收原始 input.collect=undefined → 派发登记面只认
    // ==="sync" → 本条走 async 逐条通知而响应声称已入批（设计 §3.1.3 承诺
    // 「缺省 = config 默认」作用于派发路由）。修复后 resolved=sync 落值。
    const service = makeService();
    (service as { getCollectSyncDefault: Mock<() => "async" | "sync"> }).getCollectSyncDefault.mockReturnValue("sync");
    await sh(service, { ...BASE_INPUT }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBe("sync");
  });

  it("B1：config default=sync 时显式 collect:\"async\" 优先（execute 收 \"async\"）", async () => {
    const service = makeService();
    (service as { getCollectSyncDefault: Mock<() => "async" | "sync"> }).getCollectSyncDefault.mockReturnValue("sync");
    await sh(service, { ...BASE_INPUT, collect: "async" }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBe("async");
  });

  it("attaches collect segment counting this very record from the registry ([modeless 波3]：登记含本条，无 +1 补偿)", async () => {
    // 本条已在 executeViaEngine 派发时点登记进协调器（execute stub 返回后 service 内部
    // 已登记）：stub pendingSyncMemberCount 返回 2 = 本条 + 另一未闭合成员。
    const service = makeService(2);
    const result = await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 2 });
    expect(service.pendingSyncMemberCount).toHaveBeenCalledTimes(1);
  });

  it("reports the registry count verbatim when no members registered yet (如实反映，无补偿)", async () => {
    const service = makeService(0);
    const result = await sh(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 0 });
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

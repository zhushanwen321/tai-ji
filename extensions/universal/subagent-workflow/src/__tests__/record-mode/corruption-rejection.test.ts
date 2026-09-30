// src/__tests__/record-mode/corruption-rejection.test.ts
//
// 场景 18：record 损坏拒绝（[D1] + D12 完整性纪律，设计 workflow-run-resume-revision
// §4 场景 18 的单测层承接——验收计划表 A14「L1 增量单测：半截行夹具」）。
//
// 回溯目标 = 「record 流是唯一事实源，读不出即拒绝」：fold 坏行停摆 + 载荷完整性
// 检查（有 settled 帧但 result 全文缺失 = 非法形态）。拒绝语义的三个构成：
// 1. 半截行 / 非法 JSON → 解析失败即抛错，不静默跳过（跳过会把损坏伪装成
//    「无 run 历史」，恢复链会在残缺事实上追加收编帧）；
// 2. 缺事件信封（type/ts）→ 同上；
// 3. agent-settled 帧缺 result 全文 → 载荷完整性拒绝（record 含全文后此形态 =
//    流被外部篡改或写入器 bug，D12）。
// 错误消息含文件 / 行定位与恢复指引（错误 → 权威源 → 处置闭环）。
//
// 宿主 fail-fast 链：loadAll 抛错 → recoverCrashedRuns 上抛 → session-lifecycle
// storeHealthy=false（workflow 域停初始化）——session-lifecycle.test.ts 的
// 「store.loadAll 失败 → storeHealthy=false」用例承接该半边，本件只锚 store 读面。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { isRunSettled } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../../jsonl-run-store.ts";
import {
  appendEvents,
  mkCtxWith,
  mkRecordEnv,
  registeredEntry,
  runCreated,
  type RecordFixtureEnv,
} from "./helpers.ts";

const RUN_ID = "wf-corrupt-1";
const SCRIPT_SOURCE = "agent('x')";

/** 预置合法首帧 + 注册条目（损坏行由各用例追加/直写）。 */
async function seedCreatedFrame(env: RecordFixtureEnv): Promise<void> {
  await appendEvents(env, RUN_ID, [runCreated({ ts: 1_759_000_000_000, runId: RUN_ID, scriptSource: SCRIPT_SOURCE })]);
}

function mkStore(env: RecordFixtureEnv): JsonlRunStore {
  const entries = [registeredEntry(RUN_ID, env.recordPath(RUN_ID))];
  return new JsonlRunStore({ sessionDir: env.sessionDir, ctx: mkCtxWith(entries) as never });
}

describe("场景 18：record 损坏拒绝（[D1] 坏行停摆——解析失败即抛错，不静默跳过）", () => {
  let env: RecordFixtureEnv;

  beforeEach(() => {
    env = mkRecordEnv("corrupt");
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it("半截行（截断 JSON）→ loadAll 抛错拒绝，错误含文件 / 行定位与恢复指引", async () => {
    await seedCreatedFrame(env);
    const { writeFileSync } = await import("node:fs");
    // 在合法首帧后追加半截行（写入器中途被 kill 的落盘形态）
    writeFileSync(env.recordPath(RUN_ID), [
      JSON.stringify({ type: "run-created", seq: 1, ts: 1_759_000_000_000, runId: RUN_ID, workflowName: "t", argsSummary: "{}", scriptSource: SCRIPT_SOURCE }),
      '{"type":"run-settled","outcome":"compl',
    ].join("\n") + "\n", "utf8");

    const store = mkStore(env);
    const err = await store.loadAll().then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeDefined();
    expect(err!.name).toBe("RecordStreamCorruptionError");
    expect(err!.message).toContain("record 流损坏");
    expect(err!.message).toContain("行=2"); // 行级定位
    expect(err!.message).toContain(env.recordPath(RUN_ID)); // 文件定位
    expect(err!.message).toContain("恢复："); // 恢复指引（错误 → 权威源 → 处置）
  });

  it("非法 JSON（垃圾行）→ 同一拒绝语义（不因首帧合法而放宽）", async () => {
    await seedCreatedFrame(env);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.recordPath(RUN_ID), "{not-json-at-all\n", "utf8");

    const store = mkStore(env);
    await expect(store.loadAll()).rejects.toThrow(/record 流损坏.*非法 JSON/s);
  });

  it("缺事件信封（type 缺失 / ts 非数值）→ 拒绝（信封是全词表必填）", async () => {
    await seedCreatedFrame(env);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.recordPath(RUN_ID), `${JSON.stringify({ seq: 2, taskIndex: 0 })}\n`, "utf8"); // 无 type/ts

    const store = mkStore(env);
    await expect(store.loadAll()).rejects.toThrow(/缺事件信封/);
  });

  it("有 agent-settled 帧但 result 全文缺失 → 拒绝（载荷完整性——D12 非法形态）", async () => {
    await seedCreatedFrame(env);
    const { appendFileSync } = await import("node:fs");
    // settled 帧缺 result 字段（篡改 / 写入器缺陷形态）
    appendFileSync(env.recordPath(RUN_ID), `${JSON.stringify({ type: "agent-settled", seq: 2, ts: 1_759_000_001_000, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 100 })}\n`, "utf8");

    const store = mkStore(env);
    const err = await store.loadAll().then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeDefined();
    expect(err!.name).toBe("RecordStreamCorruptionError");
    expect(err!.message).toContain("agent-settled 帧缺 result 全文");
    expect(err!.message).toContain("场景 18");
  });

  it("拒绝是精确的：合法流零误伤（同夹具不注入损坏行时 loadAll 正常返回）", async () => {
    await seedCreatedFrame(env);
    const store = mkStore(env);
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe(RUN_ID);
    expect(isRunSettled(loaded[0]!)).toBe(false);
  });

  it("损坏隔离面：settlement 查询（通知链）保守 miss + warn，不抛（恢复面的拒绝语义只在 loadAll）", async () => {
    await seedCreatedFrame(env);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.recordPath(RUN_ID), "{broken\n", "utf8");

    const store = mkStore(env);
    expect(store.settledRecordOf(RUN_ID)).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toContain("record stream read failed");
  });
});

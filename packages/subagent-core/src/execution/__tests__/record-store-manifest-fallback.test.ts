// src/execution/__tests__/record-store-manifest-fallback.test.ts
//
// findByIdManifestFallback（[D3 缺陷五] manifest 兜底单 id 读取）与 markModelOverride
// 身份守卫臂（非 in-memory 实例拒绝）的单元级断言。
//
// findByIdManifestFallback 消费场景 = model-switch-wiring 的引擎路由解析（getMutable /
// findLightById 双 miss 后第三源）：zcode 成员无子 session 文件不在扫描集、settle 后出
// 内存，bound/派生物化的 manifest 是其磁盘唯一载体。本测试钉住四臂行为：
//   1. manifestDir 未接线（纯内存测试形态）恒 undefined；
//   2. 文件缺失 → undefined（保守侧）；
//   3. 合法 manifest → 返回投影，身份域字段（origin/parentRunId/engine/engineHandle）
//      逐字段可信（消费方只依赖身份域——状态域禁用本方法，见方法头）；
//   4. 损坏 JSON / status 越界 → undefined（与 mergeManifestRecords 坏链保守侧同款）。
//
// markModelOverride 拒绝臂：调用方契约 = record 由调用方从 store 取出（getMutable），
// 非 in-memory 实例（未注册 / 同 id 异实例）返回 false 且零写面。
//
// 测试纪律：真实 fs 落盘断言；fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实
// 数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { RecordStore } from "../persistence/record-store.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";

/** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
function makeRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "manifest-fallback",
    startedAt: 1000,
    rootSessionId: "sess-current",
  });
  return { ...base, ...over };
}

describe("findByIdManifestFallback（D3 缺陷五 manifest 兜底单 id 读取）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-fallback-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("manifestDir 未接线（纯内存形态）恒 undefined", () => {
    const store = new RecordStore(sessionsDir);
    expect(store.findByIdManifestFallback("any-id")).toBeUndefined();
  });

  it("manifest 文件缺失 → undefined（保守侧，不抛）", () => {
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    expect(store.findByIdManifestFallback("ghost-id")).toBeUndefined();
  });

  it("合法 manifest → 返回投影，身份域字段（origin/parentRunId/engine/engineHandle）逐字段可信", () => {
    // 先经真实写面物化 manifest（register + markRoundIdle 派生投影），再以重启形态
    // 的新 store 实例（内存空）走兜底读取——对齐 model-switch-wiring 的重启恢复消费。
    const dbPath = path.join(tmpDir, "session-db", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const writer = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    const record = makeRecord("fb-zcode", {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "z-sess-9", dbPath }, poolKey: "shared" },
      origin: "workflow",
      parentRunId: "wf-run-fb",
      stepIndex: 2,
    });
    writer.register(record);
    expect(writer.markRoundIdle("fb-zcode", { kind: "success", content: "done" })).toBe(true);

    // 重启形态：同 manifestDir 新实例，内存零持有。
    const reader = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    const projected = reader.findByIdManifestFallback("fb-zcode");
    expect(projected).toBeDefined();
    expect(projected?.id).toBe("fb-zcode");
    expect(projected?.agent).toBe("worker");
    expect(projected?.rootSessionId).toBe("sess-current");
    expect(projected?.origin).toBe("workflow");
    expect(projected?.parentRunId).toBe("wf-run-fb");
    expect(projected?.engine).toBe("zcode");
    expect(projected?.engineHandle?.sessionRef.sessionId).toBe("z-sess-9");
    expect(projected?.engineHandle?.sessionRef.dbPath).toBe(dbPath);
  });

  it("损坏 JSON（非合法 manifest 文本）→ undefined（保守侧）", () => {
    fs.writeFileSync(path.join(manifestDir, "broken.json"), "{ not json", "utf-8");
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    expect(store.findByIdManifestFallback("broken")).toBeUndefined();
  });

  it("status 越界（数据损坏形态）→ undefined，不降级 failed 投影", () => {
    fs.writeFileSync(
      path.join(manifestDir, "bad-status.json"),
      JSON.stringify({
        id: "bad-status",
        rootSessionId: "sess-current",
        agentName: "worker",
        status: "crashed",
        createdAt: 1000,
      }),
      "utf-8",
    );
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    expect(store.findByIdManifestFallback("bad-status")).toBeUndefined();
  });
});

describe("markModelOverride 身份守卫臂（非 in-memory 实例拒绝）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-override-guard-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const override = {
    ref: { provider: "p1", modelId: "m9" },
    thinkingLevel: "high",
    setAt: 1234,
  } as const;

  it("id 不在内存表（未注册）→ false，零写面", () => {
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    const ghost = makeRecord("ghost-ovr");

    expect(store.markModelOverride(ghost, override)).toBe(false);
    expect(ghost.modelOverride).toBeUndefined();
    expect(fs.existsSync(path.join(manifestDir, "ghost-ovr.json"))).toBe(false);
    expect(fs.existsSync(path.join(manifestDir, "ghost-ovr.events"))).toBe(false);
  });

  it("同 id 异实例（record 非从本 store 取出）→ false，原注册实例不被触碰", () => {
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
    const registered = makeRecord("real-ovr", {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "z-1", dbPath: path.join(tmpDir, "db.sqlite") }, poolKey: "shared" },
    });
    store.register(registered);

    const stranger = makeRecord("real-ovr");
    expect(store.markModelOverride(stranger, override)).toBe(false);

    expect(stranger.modelOverride).toBeUndefined();
    // 注册实例与磁盘投影均保持无覆盖记账（写面零触碰）。
    expect(registered.modelOverride).toBeUndefined();
    expect(fs.existsSync(path.join(manifestDir, "real-ovr.json"))).toBe(false);
  });
});

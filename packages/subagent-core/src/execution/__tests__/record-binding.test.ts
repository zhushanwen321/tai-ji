// src/execution/__tests__/record-binding.test.ts
//
// [UF-1] 跨重启续聊绑定（record↔sessionFile 映射）写面与事件流重建源。
//
// 背景：engine-CLI 化后子 session 文件只含 {session, model_change,
// thinking_level_change, message} 条目族（无身份 entry），旧
// PI_SUBAGENT_SELF_RECORD_ID 注入链消失 → collectRecords/findLightById 失去
// id→file 工件 → 跨重启 message 一律「not found or not owned」（展示层 entry
// 扫描源可见 3 条 record、message 链全部 not-found 的双注册表不同源形态）。
//
// 现行形态（[身份换源第二步] 后，本套件锁定）：
//   ① 写面：sessionFile 回填点（轮应答 / idle 帧锚点 / run 域 outcome）经
//      writeBindingForRecord 落 `<sessionFile>.record-binding`（best-effort，
//      写失败 warn 不阻断派发主路径）——写面保留（读侧已换源事件流，绑定剩
//      戳职责与跨进程负缓存击穿职责）；
//   ② 读面：record-store scanFile 在 identity miss 时据事件流折叠重建 light
//      （created 身份域 + bound.sessionFile 反查键，模拟重启后空内存），
//      findLightById/collectRecords 恢复 id→file 解析；
//   ③ 全链：getRecordForAction（coldLookupForAction）→ 折叠重建 → register →
//      deliverChatMessage 续聊发起（resume 锚点续写原文件）；
//   ④ 终态不冲突：折叠收条优先于绑定的 running 形态（buildRecord 既有分支
//      矩阵构造性保证）；终态后绑定保留——保留选项由此套件锁定；
//   ⑤ 绑定写失败（只读目录）不阻塞派发主路径。
//   ⑥ [H2 S3] origin/parentRunId/stepIndex 身份域随 record-created 帧往返保真
//      （原 binding 身份面职责已随读侧换源移入事件载荷）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { clearEngines } from "../engine/registry.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { _resetLifecycleState } from "../lifecycle/lifecycle-manager.ts";
import { getSubagentSessionDir, getSubagentRecordsDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { seedTerminalRecord } from "./helpers/seed-terminal-record.ts";
import {
  readRecordBinding,
  updateRecordBinding,
  writeRecordBinding,
  RECORD_BINDING_SIDECAR_EXT,
} from "../persistence/state-marker.ts";
import type { RecordBinding } from "../persistence/state-marker.ts";
import { fullBindingPayload } from "../persistence/record-store-terminal.ts";
import { SubagentService } from "../subagent-service.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { makePi } from "./helpers/pi-mock.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
// 身份 env 清理（同 get-record-for-action-restart.test.ts：测试进程可能继承
// subagent env，污染 rootCwd 编码目录与 sessionRootId 基线）。
const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

const STARTED_AT = 1_700_000_000_000;

/** engine-CLI 化子 session 文件 fixture：{session, message} 条目族，无身份 entry。 */
function writePlainChildSession(sessionsDir: string): string {
  const file = path.join(sessionsDir, "20260910T000000-000_sa-bind-1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-child",
      timestamp: new Date(STARTED_AT).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date(STARTED_AT + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first round done" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: STARTED_AT + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 绑定 sidecar fixture（经真实写函数落盘）。 */
function writeBindingFixture(file: string, overrides: Partial<RecordBinding> = {}): void {
  writeRecordBinding(file, {
    v: 1,
    recordId: "sa-bind-1",
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    agent: "general-purpose",
    task: "binding task",
    slug: "bind-test",
    mode: "background",
    startedAt: STARTED_AT,

    round: 1,
    model: "prov/model-1",
    thinkingLevel: undefined,
    worktree: false,
    ...overrides,
  });
}

// ============================================================
// A. state-marker 绑定读写单元
// ============================================================

describe("[UF-1] record 绑定 sidecar 读写（state-marker）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-unit-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("原子写落盘 + 读回 roundtrip（载荷含 recordId/rootSessionId/round/startedAt）；无 tmp 残留", () => {
    const sessionFile = path.join(dir, "child.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    writeBindingFixture(sessionFile);

    const target = `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`;
    expect(fs.existsSync(target)).toBe(true);
    // 原子写收口：tmp 中间产物不残留
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

    const binding = readRecordBinding(sessionFile);
    expect(binding).toMatchObject({
      v: 1,
      recordId: "sa-bind-1",
      rootSessionId: "root-session",

      round: 1,
      startedAt: STARTED_AT,
      agent: "general-purpose",
      task: "binding task",
      mode: "background",
      worktree: false,
    });
  });

  it("损坏载荷拒绝重建：JSON 残缺 / 关键身份域缺失 / 版本不识别 / 文件缺失 → undefined", () => {
    const sessionFile = path.join(dir, "child.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // 文件缺失

    fs.writeFileSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`, "{not json", "utf-8");
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // JSON 损坏

    fs.writeFileSync(
      `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`,
      JSON.stringify({ v: 1, agent: "a", task: "t", mode: "background", startedAt: 1 }),
      "utf-8",
    );
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // recordId 缺失

    fs.writeFileSync(
      `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`,
      JSON.stringify({ v: 2, recordId: "sa-x", agent: "a", task: "t", mode: "background", startedAt: 1 }),
      "utf-8",
    );
    expect(readRecordBinding(sessionFile)).toBeUndefined(); // 版本不识别
  });

  it("写失败只 warn 不抛（只读目录）", () => {
    const roDir = path.join(dir, "ro");
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555);
    try {
      expect(() => writeBindingFixture(path.join(roDir, "child.jsonl"))).not.toThrow();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("record binding write failed"),
        expect.objectContaining({ detail: expect.objectContaining({ sessionFile: path.join(roDir, "child.jsonl") }) }),
      );
    } finally {
      fs.chmodSync(roDir, 0o755);
    }
  });
});

// ============================================================
// B. record-store 消费面（模拟重启后空内存——事件流折叠重建源）
// ============================================================

describe("[UF-1] record-store 据事件流折叠重建（跨重启空内存场景）", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-store-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    recordsDir = getSubagentRecordsDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    // maxRetries：扫描尾 fire-and-forget sessions-index 写可能与删除并发
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 播种 in-flight 事件流（created 身份域 + bound 反查键，无收条帧）。 */
  function seedInFlightEvents(file: string, over: Partial<Parameters<typeof seedTerminalRecord>[1]> = {}): void {
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      agent: "general-purpose",
      task: "binding task",
      slug: "bind-test",
      rootSessionId: "root-session",
      boundSessionFile: file,
      inFlight: true,
      ...over,
    });
  }

  it("collectRecords：无 identity 子文件 + 事件流（bound 反查键）→ 重建 idle light（id/rootSessionId/sessionFile）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedInFlightEvents(file);
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    const records = store.collectRecords(10, "all", undefined);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.id).toBe("sa-bind-1");
    // [U3 / §3.2.4 重建单规则] 无收条事件 → idle + interrupted-by-restart 兜底
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("interrupted-by-restart");
    expect(rec.rootSessionId).toBe("root-session");
    expect(rec.sessionFile).toBe(file);
    expect(rec.agent).toBe("general-purpose");
    expect(rec.task).toBe("binding task");
  });

  it("findLightById：冷启动空索引先 miss → collectRecords 全扫填充 → 索引命中（coldLookup 步骤 1 链）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedInFlightEvents(file);
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    // 重启后 idToFile 未热：直查 miss
    expect(store.findLightById("sa-bind-1")).toBeUndefined();
    // 全扫兜底命中并填充 idToFile 索引
    expect(store.collectRecords(10, "all", undefined).map((r) => r.id)).toContain("sa-bind-1");
    // 索引回暖：后续直查命中（把跨重启每条 message 一次全扫降为 O(1)）
    const light = store.findLightById("sa-bind-1");
    expect(light?.id).toBe("sa-bind-1");
    expect(light?.sessionFile).toBe(file);
    expect(light?.status).toBe("idle");
  });

  it("rootSessionId 过滤仍生效：异树过滤排除折叠 record（session 隔离不因反查旁路）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedInFlightEvents(file);
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    expect(store.collectRecords(10, "all", "other-root")).toHaveLength(0);
    expect(store.collectRecords(10, "all", "root-session")).toHaveLength(1);
  });

  it("无 identity 无事件流 → 不重建（负缓存语义保持，不误建幽灵 record）", () => {
    writePlainChildSession(sessionsDir);
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    expect(store.collectRecords(10, "all", undefined)).toHaveLength(0);
    expect(store.findLightById("sa-bind-1")).toBeUndefined();
  });
});

// ============================================================
// D. [H2 S3] 来源身份（origin/parentRunId）往返保真（写面载荷 + 事件流读侧）
// ============================================================
//
// [身份换源第二步] 后读侧身份源 = 事件流（identityFromFold 守卫归一，D 套件锁定）；
// binding 写面载荷单源（identityBindingPayload）与 merge 更新（updateRecordBinding）
// 仍是生产写面——本节锁定写面守卫归一行为（读侧守卫 readRecordBinding 仍被
// merge-or-create 写点消费，损坏残留不误判成合法载荷）。

describe("[H2 S3] binding 身份面 origin/parentRunId 往返保真（写面载荷）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-origin-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("读侧守卫归一：origin=workflow + parentRunId 保真；缺省 → undefined；非法值 → undefined", () => {
    const sessionFile = path.join(dir, "child.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");

    // 往返保真（正例）
    writeBindingFixture(sessionFile, { origin: "workflow", parentRunId: "run-77" });
    expect(readRecordBinding(sessionFile)).toMatchObject({ origin: "workflow", parentRunId: "run-77" });

    // 缺省负向（存量 binding 零迁移）：undefined = "tool" 语义
    writeBindingFixture(sessionFile);
    const absent = readRecordBinding(sessionFile)!;
    expect(absent.origin).toBeUndefined();
    expect(absent.parentRunId).toBeUndefined();

    // 非法值负向（字面量守卫，对齐 readEntryOriginFields）
    for (const badOrigin of ["bogus", 1, null]) {
      writeBindingFixture(sessionFile, { origin: badOrigin as unknown as "workflow" });
      expect(readRecordBinding(sessionFile)!.origin).toBeUndefined();
    }
    writeBindingFixture(sessionFile, { parentRunId: 42 as unknown as string });
    expect(readRecordBinding(sessionFile)!.parentRunId).toBeUndefined();
  });

  it("[H2 A3] updateRecordBinding merge 更新 usage 快照：合法值保真、非法守卫、binding 缺失不造新", () => {
    const sessionFile = path.join(dir, "child-usage.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");

    // binding 缺失 → 跳过不造新（updateRecordBinding 不承担身份创建职责）
    updateRecordBinding(sessionFile, { totalTokens: 100 });
    expect(readRecordBinding(sessionFile)).toBeUndefined();

    // 合并语义：既有身份字段不动，usage 快照写入
    writeBindingFixture(sessionFile, { origin: "workflow", parentRunId: "run-u" });
    updateRecordBinding(sessionFile, { totalTokens: 1234, turns: 3, endedAt: 999 });
    expect(readRecordBinding(sessionFile)).toMatchObject({
      recordId: "sa-bind-1", // 身份字段保留
      origin: "workflow",
      totalTokens: 1234,
      turns: 3,
      endedAt: 999,
    });

    // 非法值守卫：写侧不会写非法值（类型约束），读侧对磁盘垃圾值归一 undefined
    fs.writeFileSync(
      `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`,
      JSON.stringify({
        v: 1, recordId: "sa-bind-1", agent: "a", task: "t", mode: "background",
        startedAt: STARTED_AT, depth: 0, slug: "s", model: "m", worktree: false,
        totalTokens: "garbage", turns: null, endedAt: false,
      }),
      "utf-8",
    );
    const guarded = readRecordBinding(sessionFile)!;
    expect(guarded.totalTokens).toBeUndefined();
    expect(guarded.turns).toBeUndefined();
    expect(guarded.endedAt).toBeUndefined();
  });
});

// ============================================================
// D2. [H2 S3] 来源身份经事件载荷往返保真（读侧——折叠重建端到端）
// ============================================================
//
// Gate B S3 FAIL 根因的现行承载（[身份换源第二步] 后）：origin/parentRunId 随
// record-created 帧落事件流，读侧守卫归一在 identityFromFold（折叠身份投影）。
// 本套件锁定：帧载荷 → 折叠重建 → 过滤（collectRecords 缺省排除 / includeWorkflow
// + parentRunId 下钻可见）链路。binding 写面的同字段载荷单源性由 E 套件锁定。

describe("[H2 S3] record-store 据事件流重建 origin（D1 投影过滤端到端）", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-origin-store-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    recordsDir = getSubagentRecordsDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("created 帧(workflow) → collectRecords 重建 origin/parentRunId 保真；缺省过滤排除；includeWorkflow / parentRunId 下钻可见", () => {
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      origin: "workflow",
      parentRunId: "wf-run-1",
      boundSessionFile: file,
      inFlight: true,
    });
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    // 默认 list（includeWorkflow 缺省 false）：workflow record 被排除（S3 FAIL 的验收面）
    expect(store.collectRecords(10, "all", undefined)).toHaveLength(0);
    // includeWorkflow:true：可见且字段保真
    const visible = store.collectRecords(10, "all", undefined, true);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.origin).toBe("workflow");
    expect(visible[0]!.parentRunId).toBe("wf-run-1");
    // W2/W3 下钻：按 parentRunId 显式查询命中
    expect(store.collectRecordsByParentRunId("wf-run-1", 10).map((r) => r.id)).toEqual(["sa-bind-1"]);
  });

  it("created 帧(tool 缺省) → 重建 origin undefined，默认 list 保留（零迁移）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      boundSessionFile: file,
      inFlight: true,
    });
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    const records = store.collectRecords(10, "all", undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.origin).toBe("tool"); // 事件帧词表恒显式（created.origin 必填）——tool 缺省形态落盘即显式 "tool"
    expect(records[0]!.parentRunId).toBeUndefined();
  });

  it("归档（settled 收条）后重建仍保 origin：终态 workflow record 默认 list 不出现（S3 真机场景）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      origin: "workflow",
      parentRunId: "wf-run-2",
      boundSessionFile: file,
      stopReason: "disconnected",
    });
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    expect(store.collectRecords(10, "all", undefined)).toHaveLength(0);
    const visible = store.collectRecords(10, "all", undefined, true);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.status).toBe("idle");
    expect(visible[0]!.origin).toBe("workflow");
    expect(visible[0]!.parentRunId).toBe("wf-run-2");
  });

  it("[② 读侧换源] 收条事件承载统计：collectRecords 重建 light 恢复 totalTokens/turns/endedAt（list 面不再恒 0）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      origin: "workflow",
      parentRunId: "wf-run-u",
      boundSessionFile: file,
      stopReason: "disconnected",
      turns: 4,
      totalTokens: 60725,
      endedAt: STARTED_AT + 55_000,
    });
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    const visible = store.collectRecords(10, "all", undefined, true);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.totalTokens).toBe(60725);
    expect(visible[0]!.turns).toBe(4);
    expect(visible[0]!.endedAt).toBe(STARTED_AT + 55_000);
  });

  it("[② 读侧换源] 在途无收条（存量形态）→ 不投影，保持 light 缺省 0/0/undefined", () => {
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      boundSessionFile: file,
      inFlight: true,
    });
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    const records = store.collectRecords(10, "all", undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.totalTokens).toBe(0);
    expect(records[0]!.turns).toBe(0);
    expect(records[0]!.endedAt).toBeUndefined();
  });
});

// ============================================================
// E. [W0 / D1] binding 轴 stepIndex 往返（生产构造点 → 载荷）+ 折叠重建读侧
// ============================================================
//
// 禁经 state-marker 原语（writeRecordBinding）手构 fixture 断言——原语只验证
// schema/normalize 白名单（U0 已覆盖），载荷构造才是生产链路。本套件锁定两个
// 生产构造点的载荷含 stepIndex（写面——run 视图关联键的落盘面），以及读侧
// （[身份换源第二步] 后 = created 帧折叠重建）不丢字段。

describe("[W0 / D1] binding 载荷 stepIndex（生产构造点）与折叠重建读侧", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;
  let service: SubagentService;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-stepidx-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    recordsDir = getSubagentRecordsDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    clearEngines();
    registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  /** workflow record fixture（sessionFile 预先落盘并回填 record——锚基底可写）。 */
  function makeWorkflowRecord(id: string, sessionFile: string, stepIndex: number): ExecutionRecord {
    const base = createRecord(id, {
      agent: "general-purpose",
      model: "prov/model-1",
      mode: "background",
      task: "workflow task",
      slug: "wf-step",
      startedAt: STARTED_AT,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    // 锚基底回填（run 应答回填点的等价形态——writeBindingForRecord 从 record.sessionFile 取锚）
    base.sessionFile = sessionFile;
    return { ...base, origin: "workflow", parentRunId: "wf-run-step", stepIndex };
  }

  it("writeBindingForRecord 载荷含 stepIndex（spawn 回填点生产构造器）", () => {
    const sessionFile = path.join(agentDir, "wf-step-write.jsonl");
    const record = makeWorkflowRecord("sa-step-write", sessionFile, 4);
    // 生产构造点：run 应答回填点统一入口（RunOrchestration.writeBindingForRecord）
    const runOrchestration = (service as unknown as {
      runOrchestration: { writeBindingForRecord(r: ExecutionRecord): void };
    }).runOrchestration;
    runOrchestration.writeBindingForRecord(record);

    const binding = readRecordBinding(sessionFile);
    expect(binding).toMatchObject({
      recordId: "sa-step-write",
      origin: "workflow",
      parentRunId: "wf-run-step",
      stepIndex: 4,
    });
  });

  it("fullBindingPayload 载荷含 stepIndex（settle merge-or-create 的 create 腿 / reopen 新锚构造器）", () => {
    const sessionFile = path.join(agentDir, "wf-step-full.jsonl");
    const record = makeWorkflowRecord("sa-step-full", sessionFile, 12);
    const payload = fullBindingPayload(record, undefined);
    expect(payload.stepIndex).toBe(12);
    expect(payload.origin).toBe("workflow");
    expect(payload.parentRunId).toBe("wf-run-step");
    // 无 stepIndex record（tool 来源 / 旧调用方）→ 载荷 undefined（序列化自然缺省）
    const toolRecord = createRecord("sa-step-none", {
      agent: "general-purpose",
      model: "prov/model-1",
      mode: "background",
      task: "tool task",
      slug: "tool",
      startedAt: STARTED_AT,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    expect(fullBindingPayload(toolRecord, undefined).stepIndex).toBeUndefined();
  });

  it("[身份换源第二步] 折叠重建保字段：无 identity entry 子文件 + created 帧（origin/stepIndex）→ collectRecords 重建 stepIndex 保真", () => {
    // engine-CLI 化子文件（无身份 entry）——身份域来自事件流 created 帧。
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      origin: "workflow",
      parentRunId: "wf-run-step",
      stepIndex: 2,
      boundSessionFile: file,
      inFlight: true,
    });

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    const visible = store.collectRecords(10, "all", undefined, true);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.origin).toBe("workflow");
    expect(visible[0]!.parentRunId).toBe("wf-run-step");
    expect(visible[0]!.stepIndex).toBe(2);
  });

  it("created 帧无 stepIndex（tool 来源形态）→ 重建归一 undefined（run 视图守卫的上游形态）", () => {
    const file = writePlainChildSession(sessionsDir);
    seedTerminalRecord(recordsDir, {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      origin: "workflow",
      parentRunId: "wf-run-old",
      boundSessionFile: file,
      inFlight: true,
    });
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);

    const visible = store.collectRecords(10, "all", undefined, true);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.origin).toBe("workflow");
    expect(visible[0]!.stepIndex).toBeUndefined();
  });
});

// ============================================================
// C. SubagentService 集成（写入点 + 跨重启全链）
// ============================================================

interface ServiceInternals {
  store: RecordStore;
}

/** chatMode 续聊 record（首轮已完成、等待续聊；sessionFile 预置在指定目录）。 */
function makeChatRecord(id: string, sessionFile: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "cont",
    startedAt: 1000,
    rootSessionId: "root-session",

    controller: new AbortController(),
  });
  record.status = "running";
  record.round = 1;
  record.sessionFile = sessionFile;
  fs.writeFileSync(sessionFile, "{}\n", "utf-8");
  return record;
}

describe("[UF-1] SubagentService 集成：回填点绑定落盘 + 跨重启 message 链", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let fake: FakePiEnginePort;
  let readOnlyDir: string | undefined;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-binding-svc-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetCoreSpawnedChildrenMirrorForTest();
    // 只读目录先恢复权限再删（⑤用例的绑定写失败面）
    if (readOnlyDir !== undefined) {
      fs.chmodSync(readOnlyDir, 0o755);
      readOnlyDir = undefined;
    }
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  it("① chat 轮 run 应答回填点触发绑定落盘：载荷 = recordId/rootSessionId/round 快照", async () => {
    const sessionFile = path.join(agentDir, "sa-bind-live-session.jsonl");
    const record = makeChatRecord("sa-bind-live", sessionFile);
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "second round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "second round reply", sessionFile });

    // 轮应答（= L2797 回填点）后绑定在盘，身份域与 record 对齐
    await vi.waitFor(() => expect(fs.existsSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(true));
    // 轮正常收口（绑定写不影响派发主路径）——先等轮终 round+1 完成，再读快照
    //（[A-lite] 轮终 markRoundIdle 亦 merge binding，读取须在轮终收口后无竞态）。
    await vi.waitFor(() => expect(record.round).toBe(2));
    const binding = readRecordBinding(sessionFile);
    expect(binding).toMatchObject({
      v: 1,
      recordId: "sa-bind-live",
      rootSessionId: "root-session",

      // [A-lite] 轮终 markRoundIdle 亦 merge 快照（U7 水合口径）——binding.round
      // = 轮终 round+1 后最新值（原「回填点写点时点快照、round 滞后一拍」由轮终
      // 快照增补覆盖，与 markSettled settleSnapshotPatch 同构）。
      round: 2,
      agent: "general-purpose",
      model: "prov/model-1",
    });
    // [two-state-convergence U4/D3] 轮终翻边 idle（idle 即 resumable）。
    expect(record.status).toBe("idle");
  });

  it("⑤ 绑定写失败（只读目录）不阻塞派发主路径：轮正常 settle，仅 warn", async () => {
    readOnlyDir = path.join(agentDir, "ro-binding");
    fs.mkdirSync(readOnlyDir, { recursive: true });
    const sessionFile = path.join(readOnlyDir, "sa-bind-ro-session.jsonl");
    const record = makeChatRecord("sa-bind-ro", sessionFile); // makeChatRecord 内部落 sessionFile（此刻目录仍可写）
    fs.chmodSync(readOnlyDir, 0o555); // 轮应答（绑定写点）前锁只读——写失败面就位
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "round on read-only dir");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "reply", sessionFile });

    // 主路径不受影响：回填推进 + 轮终收口照常
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.sessionFile).toBe(sessionFile);
    // 记账面如实留痕：绑定缺失 + warn
    expect(fs.existsSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("record binding write failed"),
      expect.anything(),
    );
  });

  it("③ 跨重启全链：事件流 fixture → getRecordForAction 重建 register → deliverChatMessage 续写原文件", async () => {
    const file = writePlainChildSession(sessionsDir);
    // 身份源 = 事件流（[身份换源第二步]）：created 身份域 + bound 反查键（在途形态，
    // 与重启前「等待续聊」语义一致）。
    seedTerminalRecord(getSubagentRecordsDir(agentDir, agentDir), {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      rootSessionId: "root-session",
      boundSessionFile: file,
      inFlight: true,
    });

    // 重启形态：内存空，冷查链（findLightById miss → collectRecords 折叠重建）命中
    const record = service.chatActions.getRecordForAction("sa-bind-1");
    expect(record.sessionFile).toBe(file);
    expect(record.rootSessionId).toBe("root-session");
    expect(record.status).toBe("running");
    expect(store.getMutable("sa-bind-1")).toBe(record); // register 生效

    // 可 message：续聊 run 以原 sessionFile 为 resume 锚点（续写原文件）。
    // chat 会话形态参数挂在 RunContext（协议 run.params.chat 的承载位），非 task。
    await service.chatActions.deliverChatMessage(record, "resume after restart");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    const chatParams = fake.runs[0]!.ctx.resume;
    expect(chatParams?.resume?.sessionRef["sessionFile"]).toBe(file);
    expect(chatParams?.recordId).toBe("sa-bind-1");
  });

  it("④ [U4 万物可续] 折叠终态（settled 收条）→ getRecordForAction 重建放行（终态单向语义随终态概念消亡）", async () => {
    const file = writePlainChildSession(sessionsDir);
    writeBindingFixture(file);
    seedTerminalRecord(getSubagentRecordsDir(agentDir, agentDir), {
      id: "sa-bind-1",
      startedAt: STARTED_AT,
      rootSessionId: "root-session",
      boundSessionFile: file,
      stopReason: "disconnected",
    });

    // [U4 / §3.2.3] 终态收条只是展示位：折叠身份在 + 锚可解析 → 冷查重建
    // 注册放行（终态单向语义随终态概念消亡），续聊 resume 续写原文件。
    const record = service.chatActions.getRecordForAction("sa-bind-1");
    expect(record.status).toBe("running");
    expect(store.getMutable("sa-bind-1")).toBe(record);
  });
});

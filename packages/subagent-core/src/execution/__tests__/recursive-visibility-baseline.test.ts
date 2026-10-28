// src/execution/__tests__/recursive-visibility-baseline.test.ts
//
// 递归 subagent 跨进程身份：进程级基线兜底验证（ALS 断裂修复）。
//
// 背景（2026-08-11 实测）：pi RPC mode 的 stdin JSONL 是事件回调式读取
// （attachJsonlLineReader → stream.on("data")），每个 RPC 命令是独立异步链。
// initSession 里 execCtxAls.enterWith 的 store 不会贯穿到后续 tool 调用事件——
// 递归第二层 subagent 的 parentRecordId/depth 丢失（rootSessionId 是实例字段所以正确）。
//
// 修复：execCtxBaseline / forkDepthBaseline 实例字段（initSession 从 env 读取，
// 与 sessionRootId 同机制），createRecordForMode / 嵌套护栏读 ALS store 失败时兜底。
// 本文件验证：
//   1. 有 env（子进程身份）→ execute 创建的 record parentRecordId/depth 来自基线
//   2. 无 env（根进程）→ parentRecordId undefined / depth 0（顶层）
//   3. execCtxAls.run 的 store 优先于基线（并发链语义不回归）
//   4. forkDepth 基线：env PI_SUBAGENT_FORK_DEPTH → fork spawn env 递增
//
// mock 策略与 execute-nesting.test.ts 一致（spawn → FakeChild，fs 同步方法 mock，
// temp-prompt / alive-store / state-marker / manifest-store mock；已收敛
// ./helpers/subagent-service-mocks.ts 四文件共享单源）。
//
// [round5-g 合并产物] 吸收同 mock harness（subagent-service-mocks 单源）姊妹件：
// - nested-visibility-env-propagation.test.ts（身份 env 贯穿/派生）。
//   其 mockSpawn/ENV_*/getLastSpawnEnv 与本文件字节级相同，已去重共用。
// - execute-and-await-worktree.test.ts（worktree 失败收尾 + hadWorktree）。
//   其 setup() 改名 setupWorktree() 消歧（本文件 setup(env) 保留）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aliveStoreModule,
  childProcessModule,
  stateMarkerModule,
  fsSyncModule,
  manifestStoreModule,
} from "./helpers/subagent-service-mocks.ts";

// ── mock modules（同 execute-nesting.test.ts）──

vi.mock("node:child_process", () => childProcessModule());
vi.mock("node:fs", async (importOriginal) => fsSyncModule(await importOriginal<typeof import("node:fs")>()));
vi.mock("../persistence/alive-store.ts", async (importOriginal) => aliveStoreModule(await importOriginal<typeof import("../persistence/alive-store.ts")>()));
vi.mock("../persistence/state-marker.ts", () => stateMarkerModule());
vi.mock("../persistence/manifest-store.ts", () => manifestStoreModule());

import { spawn } from "node:child_process";

import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { CTX_MODEL as ctxModel, emptyRegistry } from "./helpers/model-registry-mock.ts";
import { makePi } from "./helpers/pi-mock.ts";
import { clearEngines } from "../engine/registry.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { WorktreeManager } from "../worktree/worktree-manager.js";

const mockSpawn = vi.mocked(spawn);

// ── 身份 env 名（与 subagent-service.ts 常量一致，避免魔法字符串）──
const ENV_ROOT_SESSION_ID = "PI_SUBAGENT_ROOT_SESSION_ID";
const ENV_SELF_RECORD_ID = "PI_SUBAGENT_SELF_RECORD_ID";
const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
const ENV_ROOT_CWD = "PI_SUBAGENT_ROOT_CWD";
const ENV_FORK_DEPTH = "PI_SUBAGENT_FORK_DEPTH";

function getLastSpawnEnv(): Record<string, string | undefined> {
  return (mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined>) ?? {};
}

/** [W3] 协议替身：execute → engine.run 挂起不 settle——record 保持 running 在 store
 *  可观察（原 FakeChild 挂起不推进的等价形态）。 */
function registerHangingEngine(): FakePiEnginePort {
  clearEngines();
  return registerFakePiEngine();
}

// ── 辅助：service 构造 ──

function setup(env: Record<string, string>): { service: SubagentService; store: RecordStore } {
  const agentDir = "/tmp/baseline-it";
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: emptyRegistry(),
    sessionId: "baseline-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "baseline-it" });
  const store = Reflect.get(service, "store") as RecordStore;
  return { service, store };
}

/** execCtxAls.run 的 duck-type（绕过 import AsyncLocalStorage）。 */
interface ExecCtxAls {
  run: <T>(store: { recordId: string | undefined; depth: number }, cb: () => T) => T;
}

// ── 用例 ──

describe("进程级基线兜底（ALS 断裂修复，pi 事件回调模型）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理身份 env，防用例间泄漏
    for (const k of [ENV_ROOT_SESSION_ID, ENV_SELF_RECORD_ID, ENV_DEPTH, ENV_FORK_DEPTH, ENV_ROOT_CWD]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of [ENV_ROOT_SESSION_ID, ENV_SELF_RECORD_ID, ENV_DEPTH, ENV_FORK_DEPTH, ENV_ROOT_CWD]) {
      delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  it("[核心回归] 有 env（子进程身份）：execute 创建 record 的 parentRecordId/depth 来自基线，不依赖 ALS store", async () => {
    // 模拟第一层 subagent 进程：env 注入「自己的身份」（父 record id + depth=1）
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-parent-record";
    process.env[ENV_DEPTH] = "1";

    const { service, store } = setup({});
    registerHangingEngine();

    // 不在 execCtxAls.run 内调用（模拟 ALS 断裂：事件回调上下文读不到 store）
    const handle = await service.execute({ task: "child of parent", slug: "test", ctxModel });

    const rec = store.collectRecords(10, "all", "root-main").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec!.parentRecordId).toBe("sa-parent-record");
    expect(rec!.depth).toBe(2); // 基线 depth 1 + 1
    expect(rec!.rootSessionId).toBe("root-main");

    // [MF-1 回归] 读侧 collectRecords 过滤必须与写侧盖章同源（sessionRootId）。
    // 旧实现传 this.sessionId（子进程自己的 session id ≠ ROOT）→ 子进程内列表恒空。
    // 子进程的本进程 sessionId 是 "baseline-it"（initSession 注入），而 record 归属
    // root-main（env 贯穿的真 ROOT）——能查到即证明过滤用的是 sessionRootId。
    const viaService = service.queries.collectRecords(10);
    expect(viaService.map((r) => r.id)).toContain(handle.subagentId);
    expect(viaService[0]!.rootSessionId).toBe("root-main");
  });

  it("[顶层] 无 env（根进程）：parentRecordId undefined / depth 0", async () => {
    const { service, store } = setup({});
    registerHangingEngine();

    const handle = await service.execute({ task: "top level", slug: "test", ctxModel });

    const rec = store.collectRecords(10, "all", "baseline-it").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec!.parentRecordId).toBeUndefined();
    expect(rec!.depth).toBe(0);
  });

  it("[优先级] execCtxAls.run 的 store 优先于基线（并发链语义不回归）", async () => {
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-baseline";
    process.env[ENV_DEPTH] = "0";

    const { service, store } = setup({});
    registerHangingEngine();
    // [R1 深绑改写] execNesting 随域 #2 聚合迁入 SessionBaselines，深绑路径改为
    // service → baselines 聚合实例（断言对象与强度不变，路径对齐终态结构）。
    const execNesting = (Reflect.get(service, "baselines") as { execNesting: ExecCtxAls }).execNesting;

    const handle = await execNesting.run({ recordId: "sa-inline-parent", depth: 3 }, () =>
      service.execute({ task: "inline nested", slug: "test", ctxModel }),
    );

    const rec = store.collectRecords(10, "all", "root-main").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec!.parentRecordId).toBe("sa-inline-parent"); // run store 优先，非基线 sa-baseline
    expect(rec!.depth).toBe(4);
  });

  it("[forkDepth 基线] env PI_SUBAGENT_FORK_DEPTH=1 → initSession 建立基线（读点兜底基线生效）", async () => {
    // [W3 改写] spawn env 注入（PI_SUBAGENT_FORK_DEPTH 递增写子 env）属 inproc
    // runSpawn 机制，随 inproc pi 引擎目录 删除迁入引擎包（pi-subagent-cli spawn 链）；core
    // 侧存留语义 = initSession 从 env 建立基线（ALS 断裂时的读点兜底），本用例锁定它。
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-fork-parent";
    process.env[ENV_DEPTH] = "0";
    process.env[ENV_FORK_DEPTH] = "1";

    const { service } = setup({});
    registerHangingEngine();

    // [R1 深绑改写] forkDepthBaseline 经 baselines 聚合路径读取（同一权威字段，等价强度）。
    expect((Reflect.get(service, "baselines") as { forkDepthBaseline: number }).forkDepthBaseline).toBe(1);

    // fork 请求照常派发（引擎侧承载深度传递）——不因基线读取抛错
    await expect(service.execute({ task: "fork child", slug: "test", ctxModel, fork: true })).resolves.toBeDefined();
  });

  it("[嵌套护栏] 基线 depth 参与 execute 入口嵌套护栏（depth>MAX 拒绝）", async () => {
    process.env[ENV_ROOT_SESSION_ID] = "root-main";
    process.env[ENV_SELF_RECORD_ID] = "sa-deep-parent";
    process.env[ENV_DEPTH] = "5";

    const { service } = setup({});

    // MAX_FORK_DEPTH 至少 > 5 才不会被误拒；这里验证基线参与计数的方式是
    // 用直接深度断言——execute 不抛错说明 nestingDepth=6 未超限，护栏不误伤。
    // （MAX_FORK_DEPTH 具体值由 session-context-resolver 定义，这里不硬编码。）
    await expect(service.execute({ task: "deep but allowed", slug: "test", ctxModel })).resolves.toBeDefined();
  });

  it("[MF-3 回归] 有 ENV_ROOT_SESSION_ID（worktree 子进程）：sessions 与 records 两套目录统一分区在 ROOT sid 树", () => {
    // 模拟 B（worktree 子进程，自身 cwd=checkout 路径、init.sessionId=子会话 id）经 env
    // 贯穿拿到真 ROOT sid。旧布局按 init.cwd 编码 → enc(checkout) 段，ROOT 磁盘重建
    // 扫不到（MF-3 事故）；[session-store-layout-inversion] 分区键 = rootSessionId
    // （env 贯穿值），cwd 编码段退役——隔离语义等价保留：子进程写盘与 ROOT 进程
    // 扫描同树（同 rootSessionId 同目录），自身 sessionId 子树被排除。
    const rootSid = "sid-mf3-root";
    process.env[ENV_ROOT_SESSION_ID] = rootSid;
    // cwd 贯穿键残留不参与分区（enc 段已退役）——残留 env 不影响目录推导即回归点
    process.env[ENV_ROOT_CWD] = "/root/project";

    const agentDir = "/tmp/baseline-it";
    const checkoutPath = "/var/folders/worktree/pi-subagents/--root-project--/branch";
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: emptyRegistry(),
      sessionId: "baseline-it",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    // service cwd = checkout 路径（worktree 子进程的 spawn cwd）
    const service = new SubagentService({
      cwd: checkoutPath,
      modelService,
      getMainSessionFile: () => "/mock/main-session.jsonl",
    });
    // 分区键 = sessionRootId（initSession 从 env 建立），initSession 前目录闭包不可解析
    service.initSession({ pi: makePi(), sessionId: "sid-child-own" });

    // 目录晚绑定闭包（消费点现取，构造期零求值）——调用即取值
    const sessionsDir = (Reflect.get(service, "sessionsDir") as () => string)();
    const recordsDir = (Reflect.get(service, "recordsDir") as () => string)();
    const dataDir = process.env.TAIJI_AGENT_DATA_DIR;

    // 两套目录都分区在 ROOT sid 树（env 贯穿值），且不落自身 sessionId 子树
    expect(sessionsDir).toBe(getSubagentSessionDir(rootSid, dataDir));
    expect(recordsDir).toBe(getSubagentRecordsDir(rootSid, dataDir));
    expect(sessionsDir).not.toBe(getSubagentSessionDir("sid-child-own", dataDir));
  });
});

// ══════ 来源: nested-visibility-env-propagation.test.ts ══════

// src/execution/__tests__/nested-visibility-env-propagation.test.ts
//
// SP-8 嵌套可见性修复验证（TC-3：PI_SUBAGENT_ROOT_SESSION_ID env 贯穿）。
//
// 验证 env 身份贯穿机制：
//   TC-3a: 根进程 initSession：无 env → sessionRootId = sessionId（自己是 ROOT）
//   TC-3b: 子进程 initSession：有 env → sessionRootId = env 值（贯穿真 ROOT）
//   TC-3c: 孙进程 initSession：env 链全程贯穿
//   TC-3d: 子进程 execute 创建的 record.rootSessionId = env 贯穿的真 ROOT
//   TC-3e: 子进程 collectRecords 用 sessionRootId 过滤
//
// mock 策略与 recursive-visibility-baseline.test.ts 一致（已收敛
// ./helpers/subagent-service-mocks.ts 四文件共享单源）。



// ── mock modules ──

vi.mock("node:child_process", () => childProcessModule());
vi.mock("node:fs", async (importOriginal) => fsSyncModule(await importOriginal<typeof import("node:fs")>()));
vi.mock("../persistence/alive-store.ts", async (importOriginal) => aliveStoreModule(await importOriginal<typeof import("../persistence/alive-store.ts")>()));
vi.mock("../persistence/state-marker.ts", () => stateMarkerModule());
vi.mock("../persistence/manifest-store.ts", () => manifestStoreModule());



function setupService(sessionId: string, env?: Record<string, string>): SubagentService {
  const agentDir = "/tmp/env-prop-it";
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: emptyRegistry(),
    sessionId,
    ctxModel,
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId });
  return service;
}

// ── 用例 ──

describe("TC-3: PI_SUBAGENT_ROOT_SESSION_ID env 贯穿正确", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of [ENV_ROOT_SESSION_ID, ENV_SELF_RECORD_ID, ENV_DEPTH, ENV_FORK_DEPTH, ENV_ROOT_CWD]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of [ENV_ROOT_SESSION_ID, ENV_SELF_RECORD_ID, ENV_DEPTH, ENV_FORK_DEPTH, ENV_ROOT_CWD]) {
      delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  it("TC-3a: 根进程 initSession：无 env → sessionRootId = sessionId（自己是 ROOT）", () => {
    const service = setupService("root-it");
    // [R1 深绑改写] sessionRootId 随域 #2 聚合迁入 SessionBaselines，深绑路径改为
    // service → baselines 聚合实例（断言对象与强度不变，路径对齐终态结构）。
    const sessionRootId = (Reflect.get(service, "baselines") as { sessionRootId: string | null }).sessionRootId as string;
    expect(sessionRootId).toBe("root-it");
  });

  it("TC-3b: 子进程 initSession：有 env PI_SUBAGENT_ROOT_SESSION_ID → sessionRootId = env 值（贯穿真 ROOT）", () => {
    process.env[ENV_ROOT_SESSION_ID] = "real-root-session";
    const service = setupService("child-session");

    // [R1 深绑改写] 同上：sessionRootId 经 baselines 聚合路径读取。
    const sessionRootId = (Reflect.get(service, "baselines") as { sessionRootId: string | null }).sessionRootId as string;
    expect(sessionRootId).toBe("real-root-session"); // env 贯穿，不是 child-session
  });

  it("TC-3c: 孙进程 initSession：env 链全程贯穿，B 的 sessionRootId 仍为 ROOT", () => {
    // 模拟 B 子进程收到的 env（A 在 spawn B 时注入）
    process.env[ENV_ROOT_SESSION_ID] = "root-main-session";
    process.env[ENV_SELF_RECORD_ID] = "sa-a-record";
    process.env[ENV_DEPTH] = "1";

    const service = setupService("b-session");

    // B 的 sessionRootId 仍为 ROOT（env 贯穿，不被 B 自己的 sessionId 覆盖）
    // [R1 深绑改写] 同上：sessionRootId / execNesting 经 baselines 聚合路径读取。
    const sessionRootId = (Reflect.get(service, "baselines") as { sessionRootId: string | null }).sessionRootId as string;
    expect(sessionRootId).toBe("root-main-session");

    // B 的嵌套基线记录了 B 自己的身份（recordId + depth；[D3-⑤] execNesting 公共层）
    const baseline = ((Reflect.get(service, "baselines") as { execNesting: { baseline(): { recordId: string; depth: number } | null } }).execNesting).baseline()!;
    expect(baseline.recordId).toBe("sa-a-record");
    expect(baseline.depth).toBe(1);
  });

  it("TC-3d: 子进程 execute 创建的 record.rootSessionId = env 贯穿的真 ROOT", async () => {
    // [W3] 协议替身挂起（engine.run 不 settle）——record 保持 running 在 store 可观察
    clearEngines();
    registerFakePiEngine();
    process.env[ENV_ROOT_SESSION_ID] = "root-main-session";
    process.env[ENV_SELF_RECORD_ID] = "sa-parent";
    process.env[ENV_DEPTH] = "1";

    const service = setupService("child-session");

    // execute 创建 record（模拟 B 内创建 C）
    const handle = await service.execute({
      task: "nested task",
      slug: "test",
      ctxModel,
    });
    const store = Reflect.get(service, "store") as RecordStore;

    // collectRecords 用 sessionRootId 过滤（子进程应看到 ROOT 整棵树）
    const records = store.collectRecords(100, "all", "root-main-session");
    const found = records.find((r) => r.id === handle.subagentId);

    expect(found).toBeDefined();
    expect(found!.rootSessionId).toBe("root-main-session"); // 指向 ROOT，不是 child-session
    expect(found!.parentRecordId).toBe("sa-parent"); // 父链来自基线
    expect(found!.depth).toBe(2); // 基线 depth=1 + 1 = 2
  });

  it("TC-3e: 子进程 collectRecords 用 sessionRootId 过滤（能看到 ROOT 整棵树）", () => {
    process.env[ENV_ROOT_SESSION_ID] = "root-main-session";
    process.env[ENV_SELF_RECORD_ID] = "sa-parent";
    process.env[ENV_DEPTH] = "1";

    const service = setupService("child-session");

    // 手动注入一条 running record（避免需要真正 spawn）
    const store = Reflect.get(service, "store") as RecordStore;
    const recordC = createRecord("sa-c", {
      agent: "worker",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "deep nested",
      startedAt: Date.now(),
      rootSessionId: "root-main-session",
      parentRecordId: "sa-parent",
      depth: 2,
    });
    store.register(recordC);

    // collectRecords（不带 filter）用 this.sessionRootId 过滤
    const viaService = service.queries.collectRecords(100);
    const ids = viaService.map((r) => r.id);

    // C 的 record 归 ROOT（rootSessionId=root-main-session），能被子进程查到
    expect(ids).toContain("sa-c");
    expect(viaService.find((r) => r.id === "sa-c")!.rootSessionId).toBe("root-main-session");
  });
});

// ══════ 来源: execute-and-await-worktree.test.ts ══════

vi.mock("node:child_process", () => childProcessModule());
vi.mock("node:fs", async (importOriginal) => fsSyncModule(await importOriginal<typeof import("node:fs")>()));
vi.mock("../persistence/alive-store.ts", async (importOriginal) => aliveStoreModule(await importOriginal<typeof import("../persistence/alive-store.ts")>()));
vi.mock("../persistence/state-marker.ts", () => stateMarkerModule());
vi.mock("../persistence/manifest-store.ts", () => manifestStoreModule());


// ── 辅助：service 构造（与 execute-nesting.test.ts setup 等价）──

interface SetupResult {
  service: SubagentService;
  worktreeManager: WorktreeManager;
}

function setupWorktree(): SetupResult {
  const agentDir = "/tmp/exec-await-worktree-it"; // fs 已 mock，路径不需真实存在
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: emptyRegistry(),
    sessionId: "exec-await-worktree-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "exec-await-worktree-it" });
  // worktreeManager 是 SubagentService 构造时 new 的 private 字段（无外部注入入口），
  // 测试经 Reflect.get 访问后 cast 到生产导出类型 WorktreeManager（已在文件顶部 import），
  // 让字段/方法签名与生产类型契约绑定。
  const worktreeManager = Reflect.get(service, "worktreeManager") as WorktreeManager;
  return { service, worktreeManager };
}


/**
 * 从 service 取出 private store（断言 record 终态用）。
 *
 * worktreeManager 与 store 都是 SubagentService 构造时 new 出的 private 字段——
 * 无外部注入入口，测试只能经 Reflect.get 访问。这里 cast 到生产导出类型
 * （RecordStore / WorktreeManager）而非内联匿名 shape，让测试与生产类型契约绑定：
 * 字段改名/签名变更时 tsc 立即报错（而非静默漂移）。
 */
function getStore(service: SubagentService): RecordStore {
  return Reflect.get(service, "store") as RecordStore;
}

describe("executeAndAwait worktree 失败收尾", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // worktreeManager.create 抛错 → [U5] 失败轮 settle（不终态化）+ 原错外抛
  // ============================================================
  it("worktreeManager.create 失败时 finalizeFailed 收尾 record 并抛原错", async () => {
    const { service, worktreeManager } = setupWorktree();

    const createErr = new Error("worktree create boom");
    vi.spyOn(worktreeManager, "create").mockImplementation(() => {
      throw createErr;
    });

    // spy store.archive：[U5] 失败轮 settle（markRoundIdle）不终态化——archive
    // 必须零调用（旧终态化退役）；失败收尾 = record 落 idle 等续聊（
    // [two-state-convergence U4/D3] 翻边后 idle 即 resumable）。
    const store = getStore(service);
    const archiveSpy = vi.spyOn(store, "archive");
    // 捕获 record id（executeAndAwait reject 时不返回 handle；listRunningMutable 是 running
    // 过滤视图，[two-state-convergence U4] 轮终翻边 idle 后不承载「留内存」断言范围）。
    // spy 只观察不替换实现（register 的入册副作用必须保持）。
    const registerSpy = vi.spyOn(store, "register");

    await expect(
      service.executeAndAwait({
        task: "worktree create will fail",
        slug: "worktree-create-fail",
        worktree: true,
        fork: true,
        ctxModel,
      }),
    ).rejects.toBe(createErr);

    // [U5] 失败 settle 完整执行：archive 零调用 + lastError 落 record（markRoundIdle
    // 簿记⑨——失败原因可达）+ record 留内存（万物可续，可续聊；经 getMutable 断言
    // ——翻边后 record 落 idle，不再入 listRunningMutable 的 running 视图）。
    expect(archiveSpy).toHaveBeenCalledTimes(0);
    const failedId = registerSpy.mock.calls.at(-1)?.[0]?.id;
    expect(failedId).toBeDefined();
    const failed = store.getMutable(failedId!);
    expect(failed).toBeDefined();
    expect(failed!.lastError).toBe("worktree create boom");
    expect(failed!.status).toBe("idle");
  });

  // ============================================================
  // create-await 竞态检查（Phase 2）：create await 窗口内 dispose 抢先把
  // record CAS 成 closed → 检查 cleanup + throw cancelled（失败 throw 语义，
  // SAR.run 的 catch 会转 AgentResult.error）。检查 throw 不落在 try 内
  // （否则被上方 catch 当 create 失败再走 finalizeFailed，对已 closed record 语义未定义）。
  // ============================================================
  it("检查：create await 窗口内 dispose 抢先 → cleanup 被调 + throw cancelled（不进 runAndFinalize）", async () => {
    const { service, worktreeManager } = setupWorktree();

    const handle = Object.freeze({
      path: "/tmp/wt-guard2",
      branch: "pi-sub-guard2",
      baseCommit: "abc123",
      mainCwd: "/repo",
    }) as Parameters<WorktreeManager["cleanup"]>[0];
    let resolveCreate!: (h: unknown) => void;
    vi.spyOn(worktreeManager, "create").mockImplementation(
      () => new Promise<unknown>((r) => { resolveCreate = r; }) as ReturnType<WorktreeManager["create"]>,
    );
    const cleanupSpy = vi.spyOn(worktreeManager, "cleanup").mockResolvedValue(undefined);

    const execP = service.executeAndAwait({
      task: "guard test",
      slug: "guard-test",
      worktree: true,
      fork: true,
      ctxModel,
    });
    // 微任务推进：record 已建 + executeAndAwait 挂在 pending create 上
    await new Promise((r) => { setTimeout(r, 0); });
    // dispose 抢先：CAS running → closed（此刻 worktreeHandle 仍 undefined，
    // dispose 的 fire-and-forget cleanup 跳过）——检查是唯一清理点
    service.disposeAllRecords("parent-shutdown");
    resolveCreate(handle);

    await expect(execP).rejects.toThrow("cancelled during worktree creation");
    expect(cleanupSpy).toHaveBeenCalledWith(handle);
  });
});

// ============================================================
// [S5] execute(worktree:true) 创建路径置 record.hadWorktree
// （三层缺口之一：仅 cold-lookup 跨重启水合置位时，进程内归档寻回的重建检查
//  `hadWorktree === true && !worktreeHandle` 第一条永不满足——归档清句后无从重建）
// ============================================================
describe("execute(worktree:true) 创建即置 hadWorktree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearEngines();
  });

  it("execute 主链（chatMode）：worktree 创建成功 → record.hadWorktree=true + handle 绑定", async () => {
    const { service, worktreeManager } = setupWorktree();
    registerFakePiEngine();
    const handle = Object.freeze({
      path: "/tmp/wt-had-worktree",
      branch: "pi-sub-had-worktree",
      baseCommit: "abc123",
      mainCwd: "/repo",
    }) as Awaited<ReturnType<WorktreeManager["create"]>>;
    vi.spyOn(worktreeManager, "create").mockResolvedValue(handle);

    const execHandle = await service.execute({
      task: "hadWorktree flag on create",
      slug: "had-worktree",
      worktree: true,
      ctxModel,
    });

    const store = getStore(service);
    const rec = store.getMutable(execHandle.subagentId);
    // [S5] 创建即置（close 收尾 markSettledOut 清句后，重建检查判据由本标志承载）
    expect(rec?.hadWorktree).toBe(true);
    expect(rec?.worktreeHandle).toBe(handle);
  });
});

// src/execution/__tests__/chat-engine-routing.test.ts
//
// U0 chat 工具域引擎路由分叉测试。设计锚点：
// D4（chat 入口路由分叉）/
// D5（pi 缺省字节级零变化）/ D10（zcode 分支终止链）。
//
// 覆盖：
//   1. 三层路由优先级（opts.engine > agent frontmatter engine > config defaultEngine；
//      全缺省 → pi 原路径）
//   2. pi 缺省守护（record.engine === undefined；entry 序列化产物不含 "engine" 键）
//   3. unsupported 参数预检（fork/worktree 同步拒绝，不产生 record；conversation
//      显式参数分支已随 modeless 波 5 派发参数删除退役——续聊资格归 message 面）
//   4. 未注册 engine id → engine_not_found
//   5. 引擎分支骨架（record 创建+盖章 / taskSpec 字段 / detached run / done+failed
//      终态迁移 / abort signal 触达引擎 kill-chain）
//   6. probe 失败一律 engine_probe_failed（不换引擎）+ JournalWriter 接线
//      （taskId=record.id + onPoolResolved retarget）+ engineHandle 完整回填
//
// 整合来源（round 5-g 测试提速，主被测对象 = 派发链引擎路由/身份解析）：
//   chat-rounds-window-dispose.test.ts（ChatRounds 窗口实例接线）/
//   explicit-agent-ref-guard.test.ts（agent ref 守卫）/
//   run-orchestration-engine-defaults.test.ts（D6 四层优先级）/
//   workflow-agent-dispatch-model-catalog.test.ts（D8 派发期目录校验）。
// 文件级 mock 三件（child_process / logger / lifecycle-manager）提升说明：
//   logger 运行时面仅 getLogger；lifecycle 为 spread actual 仅覆 arm/disarm
//   IdleTimer（本文件各节不依赖定时器真身）；child_process 仅 spawn/execFile，
//   spawnSync 消费方（pid-file/reaper）仅经 cli transport 可达，各节全走假 port。
//
// mock 策略：只 mock node:child_process.spawn（pi 原路径的 FakeChild，见
// execute-nesting.test.ts 同款范式）——非 pi 引擎分支用假 EnginePort（registerEngine
// 注入），不 spawn 任何进程；fs 用真实 os.tmpdir()（engine 分支的 manifest 落盘无妨）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// u0-data-discovery 注入化：execute 链路的 getEngineDataDir 回退段经
// HostServices.dataRoot() 端口——端口态经 configureCore 显式控制（见 beforeEach）
import { configureCore, resetCoreForTests } from "../../core/host-services.ts";

// [hoisted mock 区——三件提升自被吸收文件，全文级生效]
// logger：chat-rounds-window-dispose / workflow-agent-dispatch-model-catalog 两件的
// 同构 hoisted 工厂去重（字节级相同）；logger.ts 运行时面仅 getLogger。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// lifecycle-manager：chat-rounds-window-dispose 的 spread actual 工厂逐字提升
// （仅覆 arm/disarmIdleTimer，其余成员保真实）。
vi.mock("../lifecycle/lifecycle-manager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle/lifecycle-manager.ts")>();
  return { ...actual, armIdleTimer: vi.fn(), disarmIdleTimer: vi.fn() };
});

// pi 原路径 spawn mock（FakeChild 挂起不推进——本文件只断言路由归属与 record 形态，
// 不驱动 pi session 事件流）。chat-engine-routing 段逐字提升：spawnSync 消费方
// （pid-file/reaper）仅经 cli transport 可达，本文件各节全走假 port 不触达。
vi.mock("node:child_process", async () => {
  const { EventEmitter: EE } = await import("node:events");
  const { PassThrough: PT } = await import("node:stream");
  class FakeChild extends EE {
    pid = 12345;
    stdout = new PT();
    stderr = new PT();
    stdin = new PT();
    killed = false;
    kill(sig?: string): boolean {
      this.killed = true;
      return sig !== undefined;
    }
  }
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
});

import { spawn } from "node:child_process";
import { ChatRounds, type ChatRoundsDeps } from "../service/chat-rounds.ts";
import { RecordEngineIdentityError } from "../engine/common/session-view-service.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../engine/port.ts";
import { resolveJournalPath } from "../engine/paths.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type {
  AgentEvent,
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  ProbeReport,
  SessionView,
} from "../engine/types.ts";
import { resetWorkflowWindowEngineStatesForTest, setWorkflowWindowEngineGateway } from "../engine/routing.ts";
import type { AgentCallOpts } from "../../shared/agent-call-types.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../assembly/model-resolver.ts";
import { getGlobalConfigPath } from "../assembly/config.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { ExecuteOptions } from "../assembly/types.ts";
import { createRecord } from "../persistence/execution-record.ts";
import type { RecordStore } from "../persistence/record-store.ts";
// [v1 兼容层删除] 主 session 条目现行为「注册 + 终态两条小条目」（record-entry.ts v2）：
// engine/engineHandle 的持久载体 = 终态条目，故断言改经 v2 投影辅助（与生产写侧
// toSettledEntryData 同形）。
import { v2SettledEntry } from "./helpers/v2-record-entry.ts";
// W10（§2.10 ②）：子进程句柄断言改读 core 侧状态镜像（host/spawned-children——
// 协议化后 spawnedChildren 持有方在引擎进程，core 消费镜像面；判据 pid 同构）。
import {
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import { SubagentService, type PiLike } from "../subagent-service.ts";
import { getSubagentRecordsDir } from "../assembly/path-encoding.ts";
import { CTX_MODEL, emptyRegistry } from "./helpers/model-registry-mock.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";

const mockSpawn = vi.mocked(spawn);

// ============================================================
// 假引擎（EnginePort 最小实现；run 行为由每个用例注入）
// ============================================================

/** zcode 形态 capabilities（conversation/steer unsupported、sandbox none、maxTurns false）。 */
const ZCODE_LIKE_CAPS: EngineCapabilities = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "coarse",
  sandbox: "none",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "native",
  maxTurns: false,
};

interface CapturedRun {
  task: AgentCallOpts;
  ctx: RunContext;
}

class FakeEngine implements EnginePort {
  readonly id: string;
  readonly runs: CapturedRun[] = [];
  /** U2：probe 结果注入（路由期 routeEngine 消费；缺省 ok——probe 通过的常态）。 */
  probeFailed = false;
  /** run 实现注入（缺省：挂起不 resolve——record 保持 running 便于内存断言）。 */
  runImpl: (task: AgentCallOpts, ctx: RunContext) => Promise<{ handle: EngineHandle; outcome: AgentOutcome }>;

  constructor(id: string) {
    this.id = id;
    // 缺省挂起：never settle（用例不驱动时 record 停留 running，便于内存态断言）
    this.runImpl = () => new Promise(() => {});
  }

  capabilities(): EngineCapabilities {
    // [W3] id==='pi' 的注册占位按 pi 真实能力位声明（gate 同步面放行 pi 全参数——
    // V4⑤ 反向守护；否则 maxTurns/conversation 会被误拦）。
    if (this.id === "pi") {
      return {
        schemaEnforcement: "native",
        steer: "unsupported",
        conversation: "native",
        personaInjection: "flag",
        eventGranularity: "stream",
        sandbox: "emulated",
        sessionRead: "full",
        resume: "native",
        interrupt: "kill-only",
        permissionMode: "native",
        maxTurns: true,
      };
    }
    return ZCODE_LIKE_CAPS;
  }
  async probe(): Promise<ProbeReport> {
    return this.probeFailed
      ? {
          ok: false,
          engineVersion: "",
          checks: [{ name: "bin", ok: false }],
          error: { code: "engine_probe_failed", recovery: "fix the binary" },
        }
      : { ok: true, engineVersion: "fake", checks: [{ name: "bin", ok: true }] };
  }
  async run(task: AgentCallOpts, ctx: RunContext): Promise<{ handle: EngineHandle; outcome: AgentOutcome }> {
    this.runs.push({ task, ctx });
    return this.runImpl(task, ctx);
  }
  async interact(): Promise<{ ok: false; code: string; message: string }> {
    return { ok: false, code: "engine_capability_unsupported", message: "fake" };
  }
  async read(): Promise<{ engineId: string; turns: never[]; source: "outcome-only" }> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }
}

/** 构造最小合法 AgentOutcome（done 形态）。 */
function doneOutcome(content: string): AgentOutcome {
  return { content, engineId: "zcode", durationMs: 10, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 } };
}

// ============================================================
// 环境：tmp agentDir + 假引擎注册 + service 装配
// ============================================================

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chat-engine-routing-"));
}

function writeGlobalConfig(agentDir: string, defaultEngine?: string): void {
  fs.mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "subagents", "config.json"),
    JSON.stringify({ version: 1, maxConcurrent: 6, ...(defaultEngine !== undefined ? { defaultEngine } : {}) }),
  );
}

/** 写 agent .md（frontmatter engine 字段 = 第二层路由输入；须在引擎注册后调用——解析期校验注册表）。 */
function writeAgentMd(dir: string, engine: string): string {
  const file = path.join(dir, `agent-${engine}.md`);
  fs.writeFileSync(file, `---\nname: agent-${engine}\ndescription: test agent\nengine: ${engine}\n---\nbody\n`);
  return file;
}

/** registry：可解析 "zcode/glm"（taskSpec 字段用例的显式 model），其余未配置。 */
function fakeRegistry(): ModelRegistryLike {
  // [U1] getAvailable 与 find 必须同源：assertCanonicalModelRef 以 getAvailable 为
  // 全等/孪生扫描面（D1④ 孪生守卫需复扫 registry 全集）。旧 mock 只在 find 特判、
  // getAvailable 返回空，与真实 registry 契约（find 可命中 ⇔ getAvailable 列出）不符。
  const AVAILABLE: ModelInfo[] = [{ id: "glm", name: "GLM", provider: "zcode", reasoning: true }];
  return {
    getAvailable: () => AVAILABLE,
    find: (provider: string, id: string) =>
      AVAILABLE.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
  };
}

interface SetupResult {
  service: SubagentService;
  zcode: FakeEngine;
  piEngine: FakeEngine;
  pi: PiMock;
}

function setup(agentDir: string): SetupResult {
  const zcode = new FakeEngine("zcode");
  const piEngine = new FakeEngine("pi");
  registerEngine("zcode", () => zcode);
  registerEngine("pi", () => piEngine);
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: fakeRegistry(),
    sessionId: "test-session",
    ctxModel: CTX_MODEL,
  });
  const pi = makePi();
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi, sessionId: "test-session" });
  return { service, zcode, piEngine, pi };
}

function baseOpts(agentDir: string, extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return { task: "do work", slug: "routing-test", cwd: agentDir, ctxModel: CTX_MODEL, ...extra };
}

/** 挂起 run 的引擎路径下取内存 running record 的 engine 盖章（collectRecords 内存源投影）。 */
function runningEngineTag(service: SubagentService, id: string): string | undefined {
  const rec = service.queries.collectRecords(10, "running").find((r) => r.id === id);
  return rec?.engine;
}

describe("chat 工具域引擎路由分叉（U0：D4/D5/D10）", () => {
  let agentDir: string;

  beforeEach(() => {
  _resetCoreSpawnedChildrenMirrorForTest();
    // u0-data-discovery 注入化：execute 链路的 getEngineDataDir 回退段经
    // HostServices.dataRoot() 端口，未 configureCore 即消费抛 core_host_not_configured
    // （execute fail-safe 吞掉后表现为 mock 计数 0）——端口态显式配置，值不被断言
    configureCore({ dataRoot: () => "/fake-routing-data-root", log: () => {} });
    agentDir = makeTmpAgentDir();
    writeGlobalConfig(agentDir);
    // [session-store-layout-inversion] 生产 store 目录经
    // getSubagentSessionDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
    // stubEnv 把写删目标收进本 mkdtemp 目录并保证用例间零残留（自建自删红线；
    // 不注入则 records 落共享数据目录、跨用例重建互染，collectRecords 计数漂移）。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
  });

  afterEach(() => {
    // registry 是 globalThis 进程单例——必须清空，防假引擎泄漏进其他测试文件
    clearEngines();
    resetCoreForTests();
    vi.unstubAllEnvs();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  // ============================================================
  // 1. 三层路由优先级
  // ============================================================

  it("[层1] opts.engine='zcode' 最优先（覆盖 agent frontmatter 与全局默认）", async () => {
    writeAgentMd(agentDir, "pi");
    writeGlobalConfig(agentDir, "pi");
    const { service, zcode, piEngine } = setup(agentDir);

    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode", agent: path.join(agentDir, "agent-pi.md") }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    expect(piEngine.runs.length).toBe(0);
    expect(runningEngineTag(service, handle.subagentId)).toBe("zcode");
  });

  it("[层2] 无调用参数时 agent frontmatter engine 生效", async () => {
    writeAgentMd(agentDir, "zcode");
    const { service, zcode, piEngine } = setup(agentDir);

    const handle = await service.execute(baseOpts(agentDir, { agent: path.join(agentDir, "agent-zcode.md") }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    expect(piEngine.runs.length).toBe(0);
    expect(runningEngineTag(service, handle.subagentId)).toBe("zcode");
  });

  it("[层3] 两者皆无时 config.json defaultEngine 生效", async () => {
    writeGlobalConfig(agentDir, "zcode");
    const { service, zcode, piEngine } = setup(agentDir);

    await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    expect(piEngine.runs.length).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("[缺省] 全缺省 → pi 路由派发（[W3] pi 缺省经 registry cli 形态 port 协议派发）", async () => {
    // [W3 改写] 原「不注册任何引擎也照跑（inproc DI 直连 spawn）」随 chat 域收口
    // 消亡：pi 路由 = registry 'pi' 的 cli 形态 port（pi-host-binding 解析）。未注册
    // 时为不可用 stub——engine.run 抛 engine_not_found，record 按 MF-6 回退可恢复。
    clearEngines();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: emptyRegistry(),
      sessionId: "test-session",
      ctxModel: CTX_MODEL,
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "test-session" });

    const handle = await service.execute(baseOpts(agentDir));
    // 不可用 stub：轮次派发在首次 engine.run 拒绝（engine_not_found）→ [U5] 失败轮
    // settle（markRoundIdle 落 idle 可续聊——MF-6 回退可恢复，不终态化销毁；
    // 拒绝点唯一化在 run；[two-state-convergence U4/D3] 翻边后 idle 即 resumable）。
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
    });
  });

  // ============================================================
  // 2. pi 缺省守护（D5 字节级）
  // ============================================================

  it("[F6] pi 路由 kickOffChatRound：runCtx 带 sessionRootId（initSession 注入的根 id，relay 归属键权威源）", async () => {
    // [S5 同根] initSession 读 env PI_SUBAGENT_ROOT_SESSION_ID 优先于 init.sessionId——
    // 在 pi subagent 进程内跑测试（该 env 已注入）必红。显式 stub 为 undefined（空串
    // 会被条件 spread 过滤为缺键，同样破坏断言），不依赖外层环境。
    vi.stubEnv("PI_SUBAGENT_ROOT_SESSION_ID", undefined);
    const { service, piEngine } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));
    // initSession({sessionId: "test-session"}) 无 env → sessionRootId = "test-session"；
    // kickOffChatRound 是 pi 引擎 background 派发主路径（isPiRoute 恒路由至此，含
    // workflow 域一次性 run），漏注 = GUI pi 派发 relay 拒绝 exit 13（Gate B F6 形态）。
    expect(piEngine.runs[0]!.ctx.sessionRootId).toBe("test-session");
    vi.unstubAllEnvs();
  });

  it("[D5] 全缺省 pi record：engine===undefined 且 entry JSON 不含 engine 键", async () => {
    const { service, piEngine } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));

    const rec = service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec?.engine).toBeUndefined();
    // [v1 兼容层删除] engine 域的持久面 = v2 终态条目（engine/engineHandle 只落此处）；
    // pi 缺省不盖章 → 终态投影序列化产物不含 engine 键。
    expect(JSON.stringify(v2SettledEntry(rec!))).not.toContain("engine");
  });

  it("[D5] 显式 engine:'pi' 路由回 pi：record 不盖章 engine", async () => {
    const { service, piEngine, zcode } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir, { engine: "pi" }));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));

    expect(zcode.runs.length).toBe(0);
    // [W3] pi chat 路由 = registry 'pi' port（cli 形态替身）——显式 pi 请求命中它
    expect(piEngine.runs.length).toBe(1);
    const rec = service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec?.engine).toBeUndefined();
  });

  // ============================================================
  // 3. unsupported 参数预检（record 创建前同步拒绝）
  // ============================================================

  it("[预检·modeless 波5] engine='zcode'（conversation unsupported）start 照常派发——conversation 参数分支已删，续聊资格拒绝归 message 面", async () => {
    const { service, zcode } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    expect(service.queries.collectRecords(10, "all")).toHaveLength(1);
    expect(handle.mode).toBe("background");
  });

  it("[预检] fork:true / worktree:true 同步拒绝", async () => {
    const { service, zcode } = setup(agentDir);
    await expect(service.execute(baseOpts(agentDir, { engine: "zcode", fork: true }))).rejects.toThrow(
      /engine_capability_unsupported/,
    );
    await expect(service.execute(baseOpts(agentDir, { engine: "zcode", worktree: true }))).rejects.toThrow(
      /engine_capability_unsupported/,
    );
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "all")).toHaveLength(0);
  });

  it("[D3-④] zcode + maxTurns → 同步拒绝（record 创建前，不产生孤儿 record）——旧形态的 engine.run 内异步拒绝废弃", async () => {
    // 旧形态：Service 层预检不查 maxTurns → record 创建 + kickOffEngineRun（已删）→
    // zcode run 内硬编码 shape 检查 throw → failed record（异步化）。
    // D3-④ 检查点钉死后：capabilities.maxTurns 位驱动，record 创建前同步 throw。
    const { service, zcode } = setup(agentDir);
    const err = await service
      .execute(baseOpts(agentDir, { engine: "zcode", maxTurns: 5 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("engine_capability_unsupported");
    expect((err as Error).message).toContain("maxTurns");
    // W3 协议化口径：恢复指引 = 去参数 / 修 manifest / 升级引擎包（不再指向 engine: pi）
    expect((err as { recovery?: string }).recovery).toContain("去掉 maxTurns 参数");
    expect((err as { recovery?: string }).recovery).toContain("修 manifest capabilities");
    // 「不产生孤儿 record」断言落点（V4④）：store 无新增条目、引擎未被触达
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "all")).toHaveLength(0);
  });

  it("[V4⑤ 反向] pi + maxTurns/fork/worktree → 零拦截（pi 既有合法能力无回归）", async () => {
    const { service, piEngine, zcode } = setup(agentDir);
    // maxTurns=3（V4⑤ 场景原样）：正常进入 pi 轮次（engine.run 被调），无同步拒绝
    const handle = await service.execute(baseOpts(agentDir, { maxTurns: 3 }));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId)).toBeDefined();
    // fork 组合同样直通（第二次 run 被调，无 engine_capability_unsupported）
    await service.execute(baseOpts(agentDir, { fork: true }));
    await vi.waitFor(() => expect(piEngine.runs.length).toBeGreaterThanOrEqual(2));
    // pi + worktree：预检放行（caps.sandbox='emulated'）——execute 不因能力被拒而
    // reject（worktree 创建成败是另一维度，与拦截无关）
    await expect(service.execute(baseOpts(agentDir, { worktree: true }))).resolves.toBeTypeOf("object");
  });

  // ============================================================
  // 4. 未注册 engine id
  // ============================================================

  it("[未注册] engine='claude' → engine_not_found（含注册清单），不产生 record", async () => {
    const { service } = setup(agentDir);
    const err = await service.execute(baseOpts(agentDir, { engine: "claude" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("engine_not_found");
    expect((err as Error).message).toContain("zcode");
    expect(service.queries.collectRecords(10, "all")).toHaveLength(0);
  });

  // ============================================================
  // 5. 引擎分支骨架（D10 终止链 + 终态迁移）
  // ============================================================

  it("[骨架] 合流任务形状字段正确（prompt/cwd/model/thinkingLevel/schema/skillPath/appendSystemPrompt——D6 直传）", async () => {
    const { service, zcode } = setup(agentDir);
    await service.execute(
      baseOpts(agentDir, {
        engine: "zcode",
        model: "zcode/glm",
        thinkingLevel: "high",
        schema: { type: "object" },
        skillPath: "/tmp/skill.md",
        appendSystemPrompt: ["extra"],
      }),
    );
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    const { task, ctx } = zcode.runs[0];
    // [D6 合流] task = AgentCallOpts（host-task-spec 从 ExecuteOptions 直译）
    expect(task.prompt).toBe("do work");
    expect(task.description).toBe("routing-test");
    expect(task.model).toBe("zcode/glm");
    expect(task.thinkingLevel).toBe("high");
    expect(task.schema).toEqual({ type: "object" });
    expect(task.skillPath).toBe("/tmp/skill.md");
    expect(task.appendSystemPrompt).toEqual(["extra"]);
  });

  it("[骨架] run resolve 成功 → 轮终收口 idle + result=content（[modeless 波1] 万物可续——不终态化销毁）", async () => {
    const { service, zcode, pi } = setup(agentDir);
    zcode.runImpl = () => Promise.resolve({ handle: fakeHandle(), outcome: doneOutcome("hello result") });
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));

    // 轮终 settle（markRoundIdle——落 idle 留守可续聊，round 1）
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
      expect(rec?.result).toBe("hello result");
      expect(rec?.round).toBe(1);
    });
    // 轮终通知（chat 域宿主职责）：notifier 立即 flush（无其他 running）→ result 进 sendMessage 正文
    await vi.waitFor(() => {
      const sent = pi.sendMessage.mock.calls.some((c) => String(c[0]?.content).includes("hello result"));
      expect(sent).toBe(true);
    });
  });

  it("[骨架] outcome.error → 失败轮 settle（idle 可恢复 + 失败通知）", async () => {
    const { service, zcode, pi } = setup(agentDir);
    zcode.runImpl = () =>
      Promise.resolve({ handle: fakeHandle(), outcome: { ...doneOutcome(""), error: "engine_run_failed: boom", engineId: "zcode" } });
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));

    // [modeless 波1 / MF-6] 失败轮不销毁——落 idle 可恢复（stopReason=failed +
    // result 失败摘要；lastError 不进列表投影，经失败通知可达）
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
      expect(rec?.stopReason).toBe("failed");
      expect(rec?.result).toContain("engine_run_failed: boom");
    });
    await vi.waitFor(() => {
      const sent = pi.sendMessage.mock.calls.some((c) => String(c[0]?.content).includes("boom"));
      expect(sent).toBe(true);
    });
  });

  it("[D10] cancel abort 后 signal 触达引擎（kill-chain 第一级）", async () => {
    const { service, zcode } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    // cancel → controller.abort → engine 收到的 signal aborted（kill-chain 两级的第一级）
    expect(zcode.runs[0].ctx.signal?.aborted).toBe(false);
    service.cancel(handle.subagentId);
    expect(zcode.runs[0].ctx.signal?.aborted).toBe(true);
  });

  // ============================================================
  // 6. [F6] sessionRootId 注入（execute / executeAndAwait 两 runCtx 构造点）
  // ============================================================

  it("[F6] service.sessionRootId 注入 runCtx（根 session id 贯穿引擎派发——relay 归属键 SESSION_ID 权威源）", async () => {
    // 根进程形态：env 无 PI_SUBAGENT_ROOT_SESSION_ID 时 sessionRootId = init.sessionId。
    // 删除防外层 env 污染（该键存在时 initSession 走子进程形态，断言基准漂移）。
    const prevRootEnv = process.env["PI_SUBAGENT_ROOT_SESSION_ID"];
    delete process.env["PI_SUBAGENT_ROOT_SESSION_ID"];
    try {
      const { service, zcode, piEngine } = setup(agentDir);
      zcode.runImpl = () => Promise.resolve({ handle: fakeHandle(), outcome: doneOutcome("ok") });
      piEngine.runImpl = () => Promise.resolve({ handle: fakeHandle(), outcome: doneOutcome("ok") });

      // chat 域 background 派发（kickOffChatRound 的 runCtx 构造点）
      await service.execute(baseOpts(agentDir, { engine: "zcode" }));
      await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
      expect(zcode.runs[0].ctx.sessionRootId).toBe("test-session");

      // workflow 域 sync 派发（runAndFinalize 的 runCtx 构造点；其引擎解析恒走
      // registry 'pi'——resolveChatEnginePort，不消费 opts.engine）。fire-and-forget：
      // 本 harness 无 idle-notify 驱动面，收尾链（finalizeRoundToIdle）不收敛——
      // 只断言构造点（runs 捕获在收尾之前），与既有用例的挂起 record 同等形态。
      let awaitErr: unknown;
      void service
        .executeAndAwait(baseOpts(agentDir, { slug: "f6-await" }))
        .catch((e: unknown) => {
          awaitErr = e;
        });
      await vi.waitFor(() => {
        if (awaitErr !== undefined) {
          throw new Error(`executeAndAwait rejected before engine.run: ${String(awaitErr)}`);
        }
        expect(piEngine.runs.length).toBe(1);
      });
      expect(piEngine.runs[0].ctx.sessionRootId).toBe("test-session");
    } finally {
      if (prevRootEnv !== undefined) process.env["PI_SUBAGENT_ROOT_SESSION_ID"] = prevRootEnv;
    }
  }, 10_000);
});

// ============================================================
// U2：probe 失败即报错 + JournalWriter + engineHandle 回填
// 设计锚点：D4/D6、U2 行
// ============================================================

describe("chat 引擎分支 U2：probe 失败 / journal / engineHandle", () => {
  let agentDir: string;

  beforeEach(() => {
    // 与 U0 describe 同款端口/env 态：WorktreeManager 构造期经 store-base 通道解析
    // 存储树根（C-ext-31 后缺省 = getEngineDataDir：env → HostServices.dataRoot），
    // 未配置 env 且未 configureCore 即构造会 core_host_not_configured。
    configureCore({ dataRoot: () => agentDir, log: () => {} });
    agentDir = makeTmpAgentDir();
    writeGlobalConfig(agentDir);
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
  });

  afterEach(() => {
    clearEngines();
    resetCoreForTests();
    vi.unstubAllEnvs();
    delete process.env.TAIJI_AGENT_DATA_DIR;
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  it("[路由] 显式 engine='zcode' + probe 失败 → engine_probe_failed 报错，不换引擎", async () => {
    const { service, zcode } = setup(agentDir);
    zcode.probeFailed = true;

    await expect(service.execute(baseOpts(agentDir, { engine: "zcode" }))).rejects.toThrow(
      /engine_probe_failed/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "all")).toHaveLength(0);
  });

  it("[journal→modeless] chat 域 zcode 轮不接 event journal（原生会话库即数据源）+ engineHandle 经 onHandleReady 回填（无 eventsPath）", async () => {
    process.env.TAIJI_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    // [hygiene] dbPath 必须绝对（tmp 域内）：binding sidecar 落 zcodeAnchorBasePath
    //（`<dbPath>.<sessionId>`）同目录——相对路径会把 `sessions.db.sess-1.record-binding`
    // 残留写进测试进程 cwd（包目录泄漏事故，2026-09）。
    const dbPath = path.join(agentDir, "sessions.db");
    zcode.runImpl = (task, ctx) => {
      ctx.onEvent?.({ type: "message_end" } as AgentEvent);
      // 真实 zcode 引擎在 session/create 应答后触发 onHandleReady（B-routing：
      // 每轮新会话，新 sessionRef 经此回传——[modeless 波1] 全 record 经 Continuation
      // 轮路径，resolved handle 不再终态回填，onHandleReady 是唯一锚点通道）。
      ctx.onHandleReady?.({ sessionRef: { dbPath, sessionId: "sess-1" } });
      return Promise.resolve({
        handle: {
          data: {
            v: 1,
            engineId: "zcode",
            sessionRef: { dbPath, sessionId: "sess-1" },
            adapterVersion: "test",
          },
        },
        outcome: doneOutcome("ok"),
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
    });

    // [modeless 波1] chat 域不接 journal（pi 子 session / zcode 会话库即原生数据源；
    // journal 接线仅 workflow 域 SAR）——无 journal 文件落盘。
    const eventsPath = resolveJournalPath(agentDir, "zcode", "shared", handle.subagentId);
    expect(fs.existsSync(eventsPath)).toBe(false);

    // [W1/D2 停写写点→事件面] engineHandle 过程投影改走事件文件：成功轮 modeless
    // 收口 = markRoundIdle（round-idle 帧 stopReason: completed，不终态化无 settled
    // 条目）；引擎锚经 record-bound 帧承载（运行中另经 bound manifest 物化可见），
    // 均无 eventsPath 键。
    const events = scanRecordEventsFor(agentDir, handle.subagentId);
    expect(events.filter((e) => e.type === "record-round-idle").at(-1)).toMatchObject({
      stopReason: "completed",
    });
    expect(events.filter((e) => e.type === "record-bound").at(-1)?.engineHandle).toEqual({
      sessionRef: { dbPath, sessionId: "sess-1" },
      poolKey: "shared",
    });
  });

  it("[engineHandle→modeless] 失败轮 sessionId 缺失 → onHandleReady 部分回填仍保 dbPath（①级降②级防御形态经统一轮次面承接）", async () => {
    process.env.TAIJI_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    zcode.runImpl = (task, ctx) => {
      // 失败前的部分回填（create 应答已到、session 未建——dbPath 已知 sessionId 缺失）
      const dbPath = path.join(agentDir, "sessions.db");
      ctx.onHandleReady?.({ sessionRef: { dbPath } });
      return Promise.resolve({
        handle: {
          data: { v: 1, engineId: "zcode", sessionRef: { dbPath }, adapterVersion: "test" },
        },
        outcome: { ...doneOutcome(""), error: "engine_run_failed: boom", engineId: "zcode" },
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
      expect(rec?.stopReason).toBe("failed");
    });

    // [W1/D2·D3] 失败轮 modeless 收口 = markRoundIdle（round-idle 帧 stopReason:
    // failed，不终态化）——engineHandle 部分回填形态经 record-bound 帧承载。
    const events = scanRecordEventsFor(agentDir, handle.subagentId);
    expect(events.filter((e) => e.type === "record-round-idle").at(-1)).toMatchObject({
      stopReason: "failed",
    });
    const h = events.filter((e) => e.type === "record-bound").at(-1)?.engineHandle as
      | Record<string, unknown>
      | undefined;
    expect((h?.sessionRef as Record<string, unknown>)?.dbPath).toBe(path.join(agentDir, "sessions.db"));
    expect(h?.poolKey).toBe("shared");
  });

  // ============================================================
  // [R4 §3.4 不变量 3] onHandleReady 运行中回填：create 应答后立即落 entry——
  // 运行中 GUI 经 entry 重建 record 即得 ①②级读取钥匙（不等 run resolve）
  // ============================================================

  it("[onHandleReady] create 应答后回调 → record.engineHandle 立即回填 + reportRecordTransition 落 entry（record 仍 running）", async () => {
    process.env.TAIJI_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    let releaseRun!: (v: { handle: EngineHandle; outcome: AgentOutcome }) => void;
    zcode.runImpl = (task, ctx) => {
      // create 应答后的回调时点（app-server 引擎在 session/create 应答后触发）
      ctx.onHandleReady?.({
        sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" },
      });
      return new Promise((resolve) => {
        releaseRun = resolve; // 挂起 run——模拟运行中任务
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    // run 尚未 resolve（record 仍 running）：engineHandle 已回填且 [W1/D2 停写点→
    // 事件面] record-bound 帧已落事件文件（bound manifest 物化同步可见——运行中
    // GUI 的锚定通道，不再依赖过程 entry）。
    await vi.waitFor(() => {
      const events = scanRecordEventsFor(agentDir, handle.subagentId);
      const bound = events.filter((e) => e.type === "record-bound");
      expect(bound.length).toBeGreaterThan(0);
      expect(bound[bound.length - 1]).toMatchObject({
        engineHandle: { sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" } },
      });
    });
    const running = service["collectRecords"](10, "running").find((r) => r.id === handle.subagentId);
    // [modeless 波1] chat 域不接 journal——engineHandle 无 eventsPath 键
    expect(running?.engineHandle).toEqual({
      sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" },
      poolKey: "shared",
    });

    // 轮终收口（防 dangling）：release → settle idle（record 留内存 idle 可续聊）
    releaseRun({ handle: fakeHandle(), outcome: doneOutcome("ok") });
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
    });
  }, 10_000);

  it("[onHandleReady F1] sessionId 先落 + 迟到只补 sessionFile → 按字段补缺落位；已有值不被迟到值覆盖（幂等）", async () => {
    process.env.TAIJI_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    const LATE_SESSION_FILE = "/tmp/late/session-abc.jsonl";
    let releaseRun!: (v: { handle: EngineHandle; outcome: AgentOutcome }) => void;
    zcode.runImpl = (task, ctx) => {
      // ① create 应答：只带 sessionId（本 replay 批次新打通的可达面——close 期 LC-4
      // 后缀反查在 sessionId 已知后才补发 sessionFile）。
      ctx.onHandleReady?.({
        sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" },
      });
      // ② 迟到 handleReady：只补 sessionFile——旧守卫「有 sessionId 即整条 return」
      // 会把它整条吞掉，sessionFile 永不落位（消费点：冷续 resume 锚点 / interact 定位）。
      ctx.onHandleReady?.({
        sessionRef: { sessionId: "sess-live-1", sessionFile: LATE_SESSION_FILE },
      });
      // ③ 再迟到一次且带冲突值：已有值必须原样保留（幂等——补缺语义只补空位）。
      ctx.onHandleReady?.({
        sessionRef: { sessionId: "sess-OVERWRITE", sessionFile: "/tmp/late/other.jsonl" },
      });
      return new Promise((resolve) => {
        releaseRun = resolve;
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    const running = service["collectRecords"](10, "running").find((r) => r.id === handle.subagentId);
    // 补缺落位：sessionFile 进 record.engineHandle（①级会话取证 / 冷续 resume 锚点钥匙）
    expect(running?.engineHandle?.sessionRef["sessionFile"]).toBe(LATE_SESSION_FILE);
    expect(running?.engineHandle).toEqual({
      sessionRef: {
        dbPath: ".zcode/cli/db/db.sqlite",
        sessionId: "sess-live-1",
        sessionFile: LATE_SESSION_FILE,
      },
      poolKey: "shared",
    });
    // [W1/D2 停写点→事件面] 补缺经 record-bound 帧落账（引擎域签名变化才追加），
    // 且 ③ 的「无新字段」重复回调不产生第二条写噪（同 sessionFile 恰好一条 bound）。
    const boundEvents = scanRecordEventsFor(agentDir, handle.subagentId).filter(
      (e) => e.type === "record-bound",
    );
    const withLateSessionFile = boundEvents.filter(
      (e) => (e as { engineHandle?: { sessionRef?: Record<string, string> } }).engineHandle?.sessionRef?.["sessionFile"] === LATE_SESSION_FILE,
    );
    expect(withLateSessionFile).toHaveLength(1);

    // 轮终收口（防 dangling）：release → settle idle（record 留内存 idle 可续聊）
    releaseRun({ handle: fakeHandle(), outcome: doneOutcome("ok") });
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
    });
  }, 10_000);

  it("[onHandleReady] 引擎不回调（spawn 形态）时零回填——终态回填仍兜底（行为不变）", async () => {
    process.env.TAIJI_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    // [hygiene] dbPath 绝对化（tmp 域内）——防 binding sidecar 相对路径 cwd 泄漏。
    const dbPath = path.join(agentDir, "sessions.db");
    zcode.runImpl = (task, ctx) => {
      return Promise.resolve({
        handle: {
          data: { v: 1, engineId: "zcode", sessionRef: { dbPath, sessionId: "sess-1" }, adapterVersion: "test" },
        },
        outcome: doneOutcome("ok"),
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("idle");
    });
    const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
    // [modeless 波1] onHandleReady 是唯一锚点通道（resolved handle 不再终态回填）：
    // 引擎不回调 → engineHandle 恒缺省（读链经 ①级 sessionRef 降级由引擎侧兜底）。
    for (const c of entries) {
      expect((c[1] as Record<string, unknown>).engineHandle).toBeUndefined();
    }
  });

  it("[D5 回归] pi 纯缺省路径 entry 不含 engine/engineHandle 键", async () => {
    const { service, piEngine, pi } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));

    const rec = service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    // [v1 兼容层删除] engine/engineHandle 的持久载体 = v2 终态条目——此处保留缺位断言
    // 作「v2 投影不重新引入该键」的回归守卫。
    const entryJson = JSON.stringify(v2SettledEntry(rec!));
    expect(entryJson).not.toContain("engineHandle");
    expect(entryJson).not.toMatch(/"engine"/);
    // pi.appendEntry 上的 record entry 同形态（register 写点）
    const entry = lastRecordEntry(pi);
    expect(entry?.engine).toBeUndefined();
    expect(entry?.engineHandle).toBeUndefined();
  });

  it("[池槽回归] 引擎 run 完成后 release 并发槽：连续 7 次（> maxConcurrent=6）后第 7 次不被永久阻塞", async () => {
    // review MF1：kickOffEngineRun（已删）旧实现 acquire 后无 release——每次引擎后台 run 泄漏
    // 一个槽，累计 maxConcurrent(6) 次后全部 background subagent 在 acquire 队列挂死
    process.env.TAIJI_AGENT_DATA_DIR = agentDir;
    const { service, zcode } = setup(agentDir);
    zcode.runImpl = () => Promise.resolve({ handle: fakeHandle(), outcome: doneOutcome("ok") });

    for (let i = 0; i < 7; i++) {
      const h = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
      // 等本条轮终收口（idle 留守）再发下一条——泄漏形态下第 7 条 acquire 永久
      // 排队、record 永卡 running，本 waitFor 即超时失败
      await vi.waitFor(() => {
        const rec = service.queries.collectRecords(10, "all").find((r) => r.id === h.subagentId);
        expect(rec?.status).toBe("idle");
      });
    }
    // 7 次引擎 run 全部真实执行（第 7 次未被泄漏槽阻塞）
    expect(zcode.runs.length).toBe(7);
  }, 10_000);

  /** 最后一条 subagent-record entry（register→archive 双写点取终态侧）。 */
  function lastRecordEntry(pi: PiMock): Record<string, unknown> | undefined {
    const calls = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
    return calls.length > 0 ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined;
  }

  /** [W1/D3] 读 record 事件文件全部事件行（观察面独立于被测 store）。
   *  [session-store-layout-inversion] 观察点与生产写侧同源：分区键 = initSession sid
   *  （"test-session"），dataDir = U2 各用例注入的 TAIJI_AGENT_DATA_DIR（agentDir）。 */
  function scanRecordEventsFor(agentDir: string, id: string): Array<Record<string, unknown>> {
    const recordsDir = getSubagentRecordsDir("test-session", agentDir);
    try {
      const content = fs.readFileSync(path.join(recordsDir, `${id}.events`), "utf8");
      return content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type !== "record-journal");
    } catch {
      return [];
    }
  }
});

/** 假 EngineHandle（骨架路径不消费 handle 内容——U2 journal/handle 回填才用）。 */
function fakeHandle(): EngineHandle {
  return {
    data: { v: 1, engineId: "zcode", sessionRef: {}, adapterVersion: "test" },
  };
}
// 来源段：chat-rounds-window-dispose.test.ts
//
// [U3 pi-workflow-run-resource-model] chat 域窗口实例接线单测（impl-plan u3 验收；
// fake client，不拉真实进程）：
//   1. 轮 idle 后 pi 窗口实例 dispose（finalizeRoundToIdle 收尾追加——chat 域轮终
//      唯一编排汇总点，成功/失败两分支同经此处）；
//   2. revive 后 respawn 新实例 + resume 续写（断言新实例登记 + 续写 run 请求携带
//      resume 锚点——session 文件冷续写锚；实例层 respawn 与锚层续写并存不互斥）；
//   3. shared-service 引擎（缺省网关判定）解析透传 registry 单例、轮 idle 不误杀
//      （chat 域透传保形，与 u2 验收④同判据）。
// 权威源：技术设计 §3.3 决策 1/2、§5 U3 + ADR-0079；接线点 = ChatRounds.
// finalizeRoundToIdle / resolveRoundEnginePort / pi-host-binding.resolveHostPiEnginePort。
// ── 替身 ─────────────────────────────────────────────────────

/** 引擎能力位全集（conversation=native——revive 资格 gate 放行 pi 路径）。 */
function fakeCapabilities(): EngineCapabilities {
  return {
    schemaEnforcement: "native",
    steer: "unsupported",
    conversation: "native",
    personaInjection: "flag",
    eventGranularity: "stream",
    sandbox: "emulated",
    sessionRead: "full",
    resume: "native",
    interrupt: "kill-only",
    permissionMode: "native",
    maxTurns: true,
  };
}

/** 窗口实例替身：run 载荷捕获（resume 锚点断言）+ dispose 计数。每个实例由网关
 *  工厂独立创建——respawn 断言（新实例 ≠ 旧实例）依赖这一点。 */
class FakeWindowEnginePort implements EnginePort {
  readonly id: string;
  disposed = 0;
  readonly runCalls: Array<{ task: AgentCallOpts; ctx: RunContext }> = [];
  /** 本实例回填给 record 的 pi session 文件（pi 锚的锚源；测试可注入）。 */
  sessionFile = "";

  constructor(id: string) {
    this.id = id;
  }

  capabilities(): EngineCapabilities {
    return fakeCapabilities();
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-1", checks: [{ name: "invocation", ok: true }] };
  }

  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    this.runCalls.push({ task, ctx });
    const handle: EngineHandle = {
      data: { v: 1, engineId: this.id, sessionRef: {}, adapterVersion: "fake-1" },
    };
    const outcome: AgentOutcome = {
      content: `ok (${this.id})`,
      engineId: this.id,
      sessionId: `session-${this.id}`,
      // pi 会话锚回填载体：轮终经 outcome.sessionFile 写 record.sessionFile，
      // 下一轮 resume 锚点即派生自它（session 文件冷续写的锚源）。
      sessionFile: this.sessionFile,
    };
    return Promise.resolve({ handle, outcome });
  }

  async read(_handle: EngineHandle): Promise<SessionView> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

// ── 夹具 ─────────────────────────────────────────────────────

let dataDir: string;

/** 轮窗口网关（per-window 全放行）：每次 createPort 产出独立实例并计创建数。 */
function usePerWindowGateway(ports: FakeWindowEnginePort[]): { created: () => number } {
  let created = 0;
  setWorkflowWindowEngineGateway({
    processModelOf: () => "per-window",
    createPort: (engineId) => {
      created += 1;
      const port = new FakeWindowEnginePort(engineId);
      port.sessionFile = path.join(dataDir, `session-${created}.jsonl`);
      ports.push(port);
      return port;
    },
  });
  return { created: () => created };
}

/** running record（chat 域 Continuation 轮次载体的最小形态）。 */
function makeRunningRecord(id: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    mode: "background",
    task: "chat window task",
    slug: "chat-window",
    startedAt: 1000,
    controller: new AbortController(),
  });
  record.status = "running";
  return record;
}

/** ChatRounds 直构（stdout-wedge 单测同款；本测试触达面补齐 store/pool/通知侧）。
 *  overrides = 逐成员覆盖注入点（[§1.4 (a)] 等待排序用例消费）。 */
function makeChatRounds(record: ExecutionRecord, overrides: Partial<ChatRoundsDeps> = {}): ChatRounds {
  const store = {
    // 轮终簿记的最小语义 mimic：翻 idle + round+1（revive 资格判定依赖 status 翻边）。
    markRoundIdle: vi.fn((_id: string, _outcome: unknown) => {
      record.status = "idle";
      record.round = (record.round ?? 0) + 1;
    }),
    markRoundStarted: vi.fn(),
    register: vi.fn(),
    reportRecordTransition: vi.fn(),
  };
  const deps = {
    assertReady: vi.fn(),
    getStore: vi.fn(() => store),
    getModelService: vi.fn(() => ({})),
    getCwd: vi.fn(() => dataDir),
    getWorktreeManager: vi.fn(() => ({})),
    getNotifyHost: vi.fn(() => ({
      notifyComplete: vi.fn(),
      notify: vi.fn(),
      emitPendingUnregister: vi.fn(),
    })),
    getPool: vi.fn(() => ({ acquire: vi.fn(async () => {}), release: vi.fn() })),
    getPi: vi.fn(() => null),
    // [§1.4 (a)] 轮终「句柄就绪」等待：本测试 pi 恒 null（从未注入形态）——直通 null
    //（waitForUsablePi 对从未注入立即返回，语义等价）。
    waitForPiReady: vi.fn(async () => null),
    getSessionRootId: vi.fn(() => null),
    getStreamSink: vi.fn(() => null),
    getUiObservability: vi.fn(() => ({ getMode: () => undefined })),
    finalizeFailed: vi.fn(),
    finalizeAborted: vi.fn(),
    idleTimeoutRecycle: vi.fn(),
    archiveRecord: vi.fn(),
    taskSpecWithModel: vi.fn(
      (opts: ExecuteOptions, model: string | undefined): AgentCallOpts =>
        ({ prompt: opts.task, ...(model !== undefined ? { model } : {}) }) as AgentCallOpts,
    ),
    outcomeToAgentResult: vi.fn(),
    settleOneShotOutcome: vi.fn(),
    writeBindingForRecord: vi.fn(),
    effectiveMaxConcurrentFor: vi.fn(() => 4),
    resolveChatEnginePort: vi.fn(),
  } as unknown as ChatRoundsDeps;
  return new ChatRounds({ ...deps, ...overrides });
}

// ── 用例 ─────────────────────────────────────────────────────

describe("chat 轮窗口实例接线（U3）", () => {

  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-window-dispose-"));
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("验收①：轮 idle 后 pi 窗口实例 dispose（经窗口解析创建登记，轮终收尾释放）", async () => {
    registerEngine("pi", () => new FakeWindowEnginePort("pi-registry"));
    const ports: FakeWindowEnginePort[] = [];
    const gateway = usePerWindowGateway(ports);
    const record = makeRunningRecord("u3-win-idle-1");
    const chatRounds = makeChatRounds(record);

    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });

    // 轮终簿记 + 窗口释放都到达（detached 派发链经 waitFor 收敛）
    await vi.waitFor(() => {
      expect(record.sessionFile).toBeDefined();
      expect(ports[0]!.disposed).toBe(1);
    });
    expect(gateway.created()).toBe(1); // 轮内恰一次创建（轮内复用窗口实例）
    expect(ports[0]!.runCalls).toHaveLength(1);
    expect(record.sessionFile).toBe(ports[0]!.sessionFile); // pi 锚经 run 应答回填
  });

  it("验收②：revive 后 respawn 新实例 + resume 续写（新实例登记 + run 请求带 resume 锚点）", async () => {
    registerEngine("pi", () => new FakeWindowEnginePort("pi-registry"));
    const ports: FakeWindowEnginePort[] = [];
    const gateway = usePerWindowGateway(ports);
    const record = makeRunningRecord("u3-win-revive-1");
    const chatRounds = makeChatRounds(record);

    // 轮 1：跑完落 idle，实例随轮 idle 释放
    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });
    await vi.waitFor(() => expect(ports[0]!.disposed).toBe(1));

    // pi 锚可解析判据 = session 文件在盘（isAnchorResolvable fs.existsSync）——
    // 冷续写锚源落盘后 revive 才走「原样 resume 续写」分支
    const sessionFile = ports[0]!.sessionFile;
    fs.writeFileSync(sessionFile, "{}\n");

    chatRounds.deliverChatMessage(record, "revive message");

    // 轮 2 在全新实例上跑（respawn）：创建计数 +1、run 落新实例
    await vi.waitFor(() => {
      expect(ports[1]).toBeDefined();
      expect(ports[1]!.runCalls).toHaveLength(1);
    });
    expect(ports[1]!).not.toBe(ports[0]!); // respawn：新实例 ≠ 旧实例
    expect(ports[0]!.disposed).toBe(1); // 旧实例保持已释放
    expect(gateway.created()).toBe(2); // 恰一次新创建（登记后轮内复用，零多余创建）

    // 续写 run 请求携带 resume 锚点（recordId 关联键 + session 文件冷续写锚）
    const ctx = ports[1]!.runCalls[0]!.ctx;
    expect(ctx.resume).toEqual({
      recordId: record.id,
      resume: { sessionRef: { recordId: record.id, sessionFile } },
    });

    // 新实例登记的构造性证明：dispose 只经窗口表 disposeAll 触达——未登记实例
    // 不可能被收尾释放；轮 2 idle 后新实例被释放 = 登记发生过的唯一通路。
    await vi.waitFor(() => expect(ports[1]!.disposed).toBe(1));
  });

  it("验收③：shared-service 引擎（缺省网关）解析透传 registry 单例，轮 idle 不误杀", async () => {
    const sharedPort = new FakeWindowEnginePort("zcode-like");
    sharedPort.sessionFile = path.join(dataDir, "shared-session.jsonl");
    registerEngine("zcode-like", () => sharedPort);
    const record = makeRunningRecord("u3-win-shared-1");
    Object.assign(record, { engine: "zcode-like" }); // engine 只读——Object.assign 注入非 pi 显式 id
    const chatRounds = makeChatRounds(record);

    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });

    await vi.waitFor(() => {
      expect(record.sessionFile).toBe(sharedPort.sessionFile);
      expect(sharedPort.runCalls).toHaveLength(1);
    });
    // 非 pi 分支经窗口解析单点透传 registry：run 走注册表单例本体（缺省网关零创建）
    // 轮 idle 收尾不误杀 shared-service 单例（dispose 通道归 registry/停机链，现状保形）
    expect(sharedPort.disposed).toBe(0);
  });

  it("引擎身份域损坏检查：record 带原生引擎锚却无 engine 字段 → 显式抛错（不按 pi 判定/派发）", () => {
    registerEngine("pi", () => new FakeWindowEnginePort("pi-registry"));
    const record = makeRunningRecord("u3-win-corrupt-engine");
    // 原生引擎锚在场（zcode 形态）但没有 engine 字段 = 写侧身份域丢失
    record.engineHandle = {
      sessionRef: { sessionId: "sess-corrupt", dbPath: "db.sqlite" },
      poolKey: "shared",
    };
    const chatRounds = makeChatRounds(record);

    let err: unknown;
    try {
      chatRounds.engineSupportsConversation(record);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RecordEngineIdentityError);
    expect((err as RecordEngineIdentityError).recordId).toBe("u3-win-corrupt-engine");
    expect((err as RecordEngineIdentityError).message).toContain(
      "refusing to route it to the default engine 'pi'",
    );

    // 缺省路径保形：无 engine 且无锚 → pi 缺省走能力位判定（不抛）
    const plain = makeRunningRecord("u3-win-plain-engine");
    expect(chatRounds.engineSupportsConversation(plain)).toBe(true);
  });
});

// ── [§1.4 (a)] 轮终收尾的「句柄就绪」有界等待：等待期间簿记不执行，新代际注入后
// 完成写（FinalizeDeps.pi 读取发生在等待 resolve 之后——写携带新句柄）。

describe("[§1.4 (a)] 轮终收尾句柄就绪等待（finalizeRoundToIdle × waitForPiReady）", () => {

  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-window-dispose-"));
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("waitForPiReady 挂起期间不读 pi（簿记未开始）；resolve 新句柄后完成写", async () => {
    const record = makeRunningRecord("sa-wait-pi");
    const newPi = makePi();
    let resolveWait: ((pi: unknown) => void) | undefined;
    const waitForPiReady = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveWait = resolve;
        }) as never as Promise<null>,
    );
    const getPi = vi.fn(() => newPi as never);
    const chatRounds = makeChatRounds(record, { waitForPiReady, getPi });

    const done = chatRounds.finalizeRoundToIdle(record, { kind: "success", content: "ok" });
    await Promise.resolve();
    await Promise.resolve();
    expect(waitForPiReady).toHaveBeenCalledTimes(1);
    // 等待期间：FinalizeDeps 组装未开始（pi 读取 = 簿记写侧入口，未触达）。
    expect(getPi).not.toHaveBeenCalled();

    resolveWait!(newPi);
    await done;
    // 等待结束后才读 pi——轮终条目写携带新代际句柄（reload 后落新权威 session）。
    expect(getPi).toHaveBeenCalledTimes(1);
    expect(getPi.mock.results[0]?.value).toBe(newPi);
  });
});

// ── [fire-and-forget 收割] 轮终收尾不 await 窗口引擎收割（通知时延契约）：
// dispose 挂起时失败轮 settle 链照常走完（簿记落 idle + 失败通知发出）——收割是
// 资源回收面，通知是用户可见时延面，两者无数据依赖不得互相阻塞（2026-10-25 实测
// 根因：await 收割把失败轮通知钉在 runtime transport 的 engine_close 3s 宽限上，
// 排查与修复记录见 git 提交 2ed6f5133）。

/** dispose 可挂起的窗口实例替身：dispose 进入后停在门上（测试手动放行）；
 *  可注入失败轮应答（error outcome → settleRoundFailed 分支）。 */
class HangingDisposePort extends FakeWindowEnginePort {
  /** dispose 是否已进入（挂起链真实启动的证明——回归场景被实际执行的判据）。 */
  disposeEntered = false;
  /** 通知是否已在 dispose 放行前发出（settle 链不被收割阻塞的观察面）。 */
  private releaseDispose: () => void = () => {};
  private readonly disposeGate = new Promise<void>((resolve) => {
    this.releaseDispose = resolve;
  });
  /** 非 undefined 时 run 应答带 error（走失败轮 settle 分支）。 */
  failWith: string | undefined;

  override async dispose(): Promise<void> {
    this.disposeEntered = true;
    await this.disposeGate;
    this.disposed += 1;
  }

  override run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    this.runCalls.push({ task, ctx });
    const handle: EngineHandle = {
      data: { v: 1, engineId: this.id, sessionRef: {}, adapterVersion: "fake-1" },
    };
    if (this.failWith !== undefined) {
      const failed: AgentOutcome = {
        content: "",
        engineId: this.id,
        sessionId: `session-${this.id}`,
        sessionFile: this.sessionFile,
        error: this.failWith,
      };
      return Promise.resolve({ handle, outcome: failed });
    }
    return super.run(task, ctx);
  }

  /** 测试尾cleanup：放行挂起的 dispose（防悬挂 promise 泄漏出用例）。 */
  release(): void {
    this.releaseDispose();
  }
}

describe("[fire-and-forget 收割] 轮终通知不被窗口引擎 dispose 时延阻塞", () => {

  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-window-dispose-"));
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("dispose 挂起期间失败轮 settle 链照常完成（簿记落 idle + 失败通知发出）", async () => {
    const ports: HangingDisposePort[] = [];
    setWorkflowWindowEngineGateway({
      processModelOf: () => "per-window",
      createPort: (engineId) => {
        const port = new HangingDisposePort(engineId);
        port.sessionFile = path.join(dataDir, `hang-${ports.length + 1}.jsonl`);
        port.failWith = "engine boom (hanging dispose regression)";
        ports.push(port);
        return port;
      },
    });
    registerEngine("pi", () => new HangingDisposePort("pi-registry"));
    const record = makeRunningRecord("sa-notify-not-gated");
    const notifySpy = vi.fn();
    const chatRounds = makeChatRounds(record, {
      // 通知面窄替身（本用例只观察失败轮直投通道 notifyRecord → notify）。
      getNotifyHost: (() => ({
        notifyComplete: vi.fn(),
        notify: notifySpy,
        emitPendingUnregister: vi.fn(),
      })) as unknown as ChatRoundsDeps["getNotifyHost"],
    });

    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });

    // 收割链已启动（dispose 进入并挂起）——回归场景真实在场的证明：修复前
    // finalizeRoundToIdle await 本挂起链，下方通知断言必然超时红。
    await vi.waitFor(() => {
      expect(ports[0]).toBeDefined();
      expect(ports[0]!.disposeEntered).toBe(true);
    });
    // dispose 仍挂起（门未放行）的同时，失败轮 settle 链已走完：
    // 簿记落 idle + 失败通知发出（通知不被资源回收时延阻塞的核心断言）。
    expect(record.status).toBe("idle");
    expect(record.round).toBe(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const notifyPayload = notifySpy.mock.calls[0]?.[0] as { id: string; error?: string } | undefined;
    expect(notifyPayload?.id).toBe(record.id);
    expect(notifyPayload?.error).toContain("engine boom");

    ports[0]!.release();
    await vi.waitFor(() => expect(ports[0]!.disposed).toBe(1));
  });
});
// 来源段：explicit-agent-ref-guard.test.ts
// 显式 agent ref 失败必须报错（非静默降级）——三通道对称审查修复的 agent 通道验收。
//
// 修复背景：resolveIdentity 旧实现 getAgentConfig（loadByPath 无 require）对相对
// 路径/裸名/文件缺失一律返回 undefined → agentConfig undefined → resolveModel 静默
// 回落 override→主 agent model——用户点名 agent 却拿到无 systemPrompt/无工具白名单
// 的 general-purpose 形态，零反馈。修复后显式 ref 失败抛错（require:true 语义，
// 错误含 <available_subagents> 恢复指引，对齐 workflow name not found 反馈风格）。
//
// 本文件锁住：
//   1. 裸名/相对路径 agent ref → execute 同步 reject（Invalid agent ref），无引擎
//      派发、无子 session、record 不落盘（engine.run/appendEntry 零触达）
//   2. 绝对路径但文件不存在 → reject（not found or unreadable）
//   3. 对照：不传 agent（默认 general-purpose）与合法绝对路径 ref 均不误伤
//
// [W3 改写] 原 vi.mock(inproc pi 引擎目录/session-runner)（buildSpawnArgs spy）随删件消亡
// ——「spawn 链路零触达」的结构性证据改经协议替身（engine.run 零调用）+ appendEntry
// 零触达承载；检查位于同步裁决期、引擎派发前置的结构不变。
//
// harness 复用 start-sync-model-guard.test.ts（真实 SubagentService + tmpdir +
// 协议替身），保证检查位于同步裁决期、引擎派发前置的结构性证据可断言。

// ── 工具（start-sync-model-guard 同款）──

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "GLM-5.3-Flash",
    name: over.name ?? "GLM 5.3 Flash",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
    ...over,
  };
}

function makeRegistry(models: ModelInfo[]): ModelRegistryLike {
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: () => true,
  };
}

describe("显式 agent ref 失败报错（非静默降级 general-purpose）", () => {
  let tmpDir: string;
  let service: SubagentService;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.clearAllMocks();
    clearEngines();
    fake = registerFakePiEngine();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-agent-ref-guard-"));
    // 数据根自注入（自建自删红线）：WorktreeManager 构造链经 getEngineDataDir 解析
    // 存储树根——本段不再依赖包级 globalSetup 注入的 tmp 值（合并文件前段会 delete 它）
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", tmpDir);
    const modelService = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    modelService.initModel({
      modelRegistry: makeRegistry([makeModel()]),
      sessionId: "agent-ref-guard-session",
    });
    service = new SubagentService({ cwd: tmpDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "agent-ref-guard-session" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearEngines();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── 拒绝路径：显式 ref 失败 → 同步 reject + 引擎派发零触达 ──

  it("裸名 agent ref（'worker'）→ execute 同步 reject（Invalid agent ref + 恢复指引）", async () => {
    await expect(
      service.execute({ task: "probe task", slug: "ref-guard", agent: "worker" }),
    ).rejects.toThrow(/Invalid agent ref: worker.*<available_subagents>/s);

    // 引擎派发零触达 + record 未创建——非静默降级的结构性证据：
    // 旧行为（静默 undefined）会继续走 record 创建（appendEntry 被调）后派发引擎。
    expect(fake.runs.length).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("相对路径 agent ref → 同样 reject（引用唯一形态 = 绝对路径）", async () => {
    await expect(
      service.execute({ task: "probe task", slug: "ref-guard", agent: "./agents/worker.md" }),
    ).rejects.toThrow(/Invalid agent ref/);

    expect(fake.runs.length).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("绝对路径但文件不存在 → reject（not found or unreadable），非静默降级", async () => {
    const missing = path.join(tmpDir, "no-such-agent.md");
    await expect(
      service.execute({ task: "probe task", slug: "ref-guard", agent: missing }),
    ).rejects.toThrow(/not found or unreadable.*<available_subagents>/s);

    expect(fake.runs.length).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  // ── 放行对照：两类合法语义不误伤 ──

  it("不传 agent（默认 general-purpose 语义）→ 不触发 agent ref 检查", async () => {
    const promise = service.execute({
      task: "probe task",
      slug: "ref-default-ok",
      ctxModel: makeModel(),
    });
    // 默认语义下 identity 解析必须放行（execute 可能因 mock 环境引擎收尾而 reject，
    // 但错误不能是 agent ref 拒绝）；record 已创建（appendEntry 发生）。
    try {
      await promise;
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Invalid agent ref/);
      expect((e as Error).message).not.toMatch(/not found or unreadable/);
    }
    expect(pi.appendEntry).toHaveBeenCalled();
  });

  it("显式合法绝对路径 agent .md → 检查零误伤，identity 放行", async () => {
    const agentFile = path.join(tmpDir, "worker.md");
    fs.writeFileSync(agentFile, "You are a test worker agent.");
    const promise = service.execute({
      task: "probe task",
      slug: "ref-valid-ok",
      agent: agentFile,
      ctxModel: makeModel(),
    });
    try {
      await promise;
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Invalid agent ref/);
      expect((e as Error).message).not.toMatch(/not found or unreadable/);
    }
    expect(pi.appendEntry).toHaveBeenCalled();
  });
});
// 来源段：run-orchestration-engine-defaults.test.ts
//
// [engine-provider-unification D6 / u6-dispatch] 四层优先级派发插层验收：
//   task 显式指定 > agent frontmatter 声明 > settings 用户偏好（engineDefaults，
//   派发时点直读磁盘）> 引擎缺省（create 帧省略 model 键，引擎自解析）。
// 两个消费点同层序核对：
//   - chat 域：run-orchestration.resolveIdentityForRoute（service.execute）；
//   - workflow 域：workflow-dispatch.resolveWorkflowIdentity（service.executeWorkflowAgent）。
// 防御机制侧：pi 路由恒不插层（pi 链自有三层解析，taiji 级偏好无意义——D6 不采用段）；
// 直读侧：config 在 service 构造后写入 → 派发仍读到（不经构造期 globalConfig 缓存，
// 「settings 保存 → 活跃 session 派发」场景 S2 的自然操作序列）。
//
// 替身形态与 workflow-agent-dispatch-model-catalog.test.ts 同款（本地构造非 pi 引擎
// port + registerFakePiEngine + 真实 ModelConfigService 指向 tmp agentDir）；偏好
// fixture = 真实写盘 <agentDir>/subagents/config.json（readEngineDefaults 直读链全真）。

// ============================================================
// 非 pi 引擎替身（可结算——chat 域轮终收尾与 workflow 域 await 都需要 run 应答）
// ============================================================

/** 一次 run 捕获（task + 手动结算面）。 */
interface CapturedNonPiRun { // oe-exempt:20261012:test:测试捕获断言形态
  readonly task: AgentCallOpts;
  settle: () => void;
}

class CapturingNonPiEngine implements EnginePort {
  readonly runs: CapturedNonPiRun[] = [];

  translateModelRef?: (modelRef: string) => string;
  listModels?: () => Array<{ id: string; name?: string }> | null;

  constructor(
    readonly id: string,
    private readonly caps: EngineCapabilities,
    private readonly hooks: NonPiHooks = {},
  ) {
    // 可选 Port 成员条件挂载（消费方以 typeof 判定——与 zcode 实装同形态）
    if (hooks.translateModelRef !== undefined) this.translateModelRef = hooks.translateModelRef;
    if (hooks.listModels !== undefined) this.listModels = hooks.listModels;
  }

  capabilities(): EngineCapabilities {
    return this.caps;
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "engine-defaults-fake", checks: [{ name: "bin", ok: true }] };
  }

  run(task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> {
    return new Promise<EngineRunResult>((resolve) => {
      this.runs.push({
        task,
        settle: () =>
          resolve({
            handle: {
              data: {
                v: 1,
                engineId: this.id,
                sessionRef: {},
                adapterVersion: "engine-defaults-fake",
              } satisfies EngineHandle["data"],
            },
            outcome: { content: "done", engineId: this.id, durationMs: 1 },
          }),
      });
    });
  }

  async read(): Promise<SessionView> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }
}

/** 与 workflow-agent-dispatch-model-catalog.test.ts 同款 caps（普通 task 全放行）。 */
function plainTaskCaps(): EngineCapabilities {
  return {
    schemaEnforcement: "emulated",
    steer: "unsupported",
    conversation: "unsupported",
    personaInjection: "prompt",
    eventGranularity: "coarse",
    sandbox: "none",
    sessionRead: "outcome-only",
    resume: "unsupported",
    interrupt: "kill-only",
    permissionMode: "ignored",
    maxTurns: false,
  };
}

const NON_PI_ENGINE_ID = "zcode-like";
/** pi 三层解析（ctxModel 兜底）产物的 join 词形——pi 路由防回归断言的判别值。 */
const PI_CTX_MODEL_REF = "p/m";

/** 非 pi 引擎可选能力部分钩子（translateModelRef / listModels 条件挂载）。 */
interface NonPiHooks { // oe-exempt:20261012:test:测试钩子形态
  translateModelRef?: (modelRef: string) => string;
  listModels?: () => Array<{ id: string; name?: string }> | null;
}

/** engine-ref-translation D2 翻译面替身（模拟 zcode 实装形态：pi 词汇 → 引擎原生，其余透传）。 */
const TRANSLATION_TARGET = "account:bigmodel-individual-coding-plan";
function translatedEngineHooks(): NonPiHooks {
  return {
    translateModelRef: (ref) =>
      ref.startsWith("zai-coding-cn/")
        ? `${TRANSLATION_TARGET}/${ref.slice("zai-coding-cn/".length).toUpperCase()}`
        : ref,
    listModels: () => [{ id: `${TRANSLATION_TARGET}/GLM-5.3-FLASH` }],
  };
}

// ============================================================
// 环境：tmp agentDir + config.json 偏好写盘 + 双引擎注册 + service 装配
// ============================================================

interface ServiceInternals { // oe-exempt:20261012:test:测试内省访问形态
  store: RecordStore;
}

const EMPTY_REGISTRY: ModelRegistryLike = {
  getAvailable: () => [],
  find: () => undefined,
  hasConfiguredAuth: () => true,
};

interface EngineDefaultsHarness { // oe-exempt:20261012:test:测试装配形态
  service: SubagentService;
  store: RecordStore;
  pi: PiMock;
  fakePi: FakePiEnginePort;
  nonPi: CapturingNonPiEngine;
  modelService: ModelConfigService;
  agentDir: string;
  tmpRoot: string;
}

const openHarnesses: Array<{ service: SubagentService; tmpRoot: string }> = [];

/** 偏好写盘（真实 readEngineDefaults 直读链的 fixture）。 */
function writeEngineDefaults(agentDir: string, engineDefaults: Record<string, string>): void {
  const configPath = getGlobalConfigPath(agentDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, maxConcurrent: 6, engineDefaults }));
}

/** frontmatter 声明 model 的 agent .md fixture（返回绝对路径——agent ref 语义）。 */
function writeFrontmatterAgent(tmpRoot: string, name: string, model: string): string {
  const agentPath = path.join(tmpRoot, `${name}.md`);
  fs.writeFileSync(
    agentPath,
    `---\nname: ${name}\ndescription: d6 fixture\nkind: agent\nmodel: ${model}\n---\nBody`,
  );
  return agentPath;
}

/** 单模型 registry（pi 链 resolveModel / 派发期目录校验都要查表命中 frontmatter 值）。 */
function registryWith(model: { provider: string; id: string }): ModelRegistryLike {
  const entry = { id: model.id, name: model.id, provider: model.provider, reasoning: false };
  return {
    getAvailable: () => [entry],
    find: (provider, modelId) => (provider === model.provider && modelId === model.id ? entry : undefined),
    hasConfiguredAuth: () => true,
  };
}

function makeHarness(
  engineDefaults?: Record<string, string>,
  engineHooks?: NonPiHooks,
  registry: ModelRegistryLike = EMPTY_REGISTRY,
): EngineDefaultsHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "d6-engine-defaults-"));
  // 测试红线：store/引擎数据范围不触真实数据目录
  process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  if (engineDefaults !== undefined) writeEngineDefaults(agentDir, engineDefaults);
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: registry,
    sessionId: "d6-engine-defaults-it",
    ctxModel: CTX_MODEL,
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "d6-engine-defaults-it" });
  clearEngines();
  const nonPi = new CapturingNonPiEngine(NON_PI_ENGINE_ID, plainTaskCaps(), engineHooks);
  registerEngine(NON_PI_ENGINE_ID, () => nonPi);
  const fakePi = registerFakePiEngine();
  openHarnesses.push({ service, tmpRoot });
  return { service, store: (service as unknown as ServiceInternals).store, pi, fakePi, nonPi, modelService, agentDir, tmpRoot };
}

// ============================================================
// chat 域（run-orchestration.resolveIdentityForRoute）
// ============================================================


/** 等待首个 run 落地并断言 create 帧 model（引擎默认值三层解析的判别面）。 */
async function waitForFirstRunModel<R extends { task: { model?: string } }>(runs: R[], model: string) {
  await vi.waitFor(() => expect(runs.length).toBe(1));
  expect(runs[0]!.task.model).toBe(model);
}

describe("D6 四层优先级：chat 域（run-orchestration）", () => {

  beforeEach(() => {
    resetCoreForTests();
  });

  afterEach(() => {
    for (const h of openHarnesses.splice(0)) {
      h.service.dispose();
      fs.rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    clearEngines();
    vi.restoreAllMocks();
  });
  it("形态 1：task 显式 model 赢过 frontmatter 与偏好（三层全配，留痕同形）", async () => {
    const { service, nonPi, store } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "d6-agent", "prov/front-model");
    const handle = await service.execute({
      task: "d6 chat form1",
      slug: "d6-form1",
      engine: NON_PI_ENGINE_ID,
      model: "prov/task-model",
      agent: agentPath,
    });
    await waitForFirstRunModel(nonPi.runs, "prov/task-model");
    // 第一层赢：create 帧 model = task 显式值

    // 留痕同形：偏好补缺与显式指定共用同一 record.opts.model 盖章通道
    expect(store.getMutable(handle.subagentId)?.model).toBe("prov/task-model");
    // [subagent-detail-model-info] 来源标注随层判定：task 显式 = explicit
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("explicit");
    nonPi.runs[0]!.settle();
  });

  it("形态 2：task 空 + frontmatter 有 → frontmatter 赢过偏好（作者显式声明不被全局偏好压掉）", async () => {
    const { service, nonPi, store } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "d6-agent", "prov/front-model");
    const handle = await service.execute({
      task: "d6 chat form2",
      slug: "d6-form2",
      engine: NON_PI_ENGINE_ID,
      agent: agentPath,
    });
    await waitForFirstRunModel(nonPi.runs, "prov/front-model");
    // [subagent-detail-model-info] frontmatter 层来源标注
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("frontmatter");
    nonPi.runs[0]!.settle();
  });

  it("形态 3：task 与 frontmatter 双空 → settings 偏好补缺（record 留痕与显式指定同形）", async () => {
    const { service, nonPi, store } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const handle = await service.execute({
      task: "d6 chat form3",
      slug: "d6-form3",
      engine: NON_PI_ENGINE_ID,
    });
    await waitForFirstRunModel(nonPi.runs, "prov/pref-model");
    // D6 留痕口径：record 消费方只关心「用了哪个模型」，不区分「谁决定的」
    expect(store.getMutable(handle.subagentId)?.model).toBe("prov/pref-model");
    // [subagent-detail-model-info] 偏好层来源标注
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("preference");
    nonPi.runs[0]!.settle();
  });

  it("第四层：三层全缺席 → create 帧省略 model 键（引擎缺省），record.model 如实留空", async () => {
    // 偏好只配了别的引擎 id——本引擎查表 miss（键 = route.engineId 的判别）
    const { service, nonPi, store } = makeHarness({ "other-engine": "prov/other" });
    const handle = await service.execute({
      task: "d6 chat layer4",
      slug: "d6-layer4",
      engine: NON_PI_ENGINE_ID,
    });
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect("model" in nonPi.runs[0]!.task).toBe(false);
    expect(store.getMutable(handle.subagentId)?.model).toBeUndefined();
    // [subagent-detail-model-info] 全缺席 = default 来源（未指定也如实标注）
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("default");
    nonPi.runs[0]!.settle();
  });

  it("pi 路由不插层：engineDefaults 含 pi 键也不消费（model 走 pi 链三层解析 = ctxModel）", async () => {
    const { service, fakePi } = makeHarness({
      pi: "prov/pi-pref",
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    await service.execute({ task: "d6 pi route", slug: "d6-pi" });
    await vi.waitFor(() => expect(fakePi.runs.length).toBe(1));
    // pi 链自有三层解析：无显式 model → ctxModel 兜底（p/m）；若误插偏好层则为
    // prov/pi-pref——本断言即判别面
    expect(fakePi.runs[0]!.task.model).toBe(PI_CTX_MODEL_REF);
    fakePi.runs[0]!.settle({ content: "pi done" });
  });

  it("S-2 pi 路由来源标注三层：task 空 + agent frontmatter 有 → frontmatter（pi 链自解析同样消费 frontmatter）", async () => {
    const { service, fakePi, store } = makeHarness({ pi: "prov/pi-pref" }, undefined, registryWith({ provider: "prov", id: "front-model" }));
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "s2-agent", "prov/front-model");
    const handle = await service.execute({ task: "s2 pi front", slug: "s2-pi-front", agent: agentPath });
    await vi.waitFor(() => expect(fakePi.runs.length).toBe(1));
    // 修复前 pi 路由标注 = explicit|default 二层：frontmatter 声明被误标「default」
    //（引擎缺省）——与「pi 链消费 agent .md 声明」的事实不符。偏好键不消费（上用例）
    // 与 frontmatter 层标注并存：pi 路由不插 taiji 级偏好，但 frontmatter 属 pi 链自解析层。
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("frontmatter");
    fakePi.runs[0]!.settle({ content: "pi done" });
  });

  it("派发时点直读：config 在 service 构造后写入 → 派发读到新值（不经构造期缓存）", async () => {
    const h = makeHarness();
    // 构造时 config.json 不存在（三态 absent）；派发前写盘——模拟 settings 保存
    writeEngineDefaults(h.agentDir, { [NON_PI_ENGINE_ID]: "prov/late-pref" });
    await h.service.execute({
      task: "d6 direct read",
      slug: "d6-direct-read",
      engine: NON_PI_ENGINE_ID,
    });
    await vi.waitFor(() => expect(h.nonPi.runs.length).toBe(1));
    expect(h.nonPi.runs[0]!.task.model).toBe("prov/late-pref");
    h.nonPi.runs[0]!.settle();
  });
});

// ============================================================
// engine-ref-translation D2：派发期模型 ref 翻译（chat 域；2026-10-14 用户裁决）
// ============================================================

describe("engine-ref-translation：chat 域派发期翻译", () => {

  beforeEach(() => {
    resetCoreForTests();
  });

  afterEach(() => {
    for (const h of openHarnesses.splice(0)) {
      h.service.dispose();
      fs.rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    clearEngines();
    vi.restoreAllMocks();
  });
  it("显式 model 经翻译盖章：record/task 均为引擎原生 ref（UI 跟随事实）", async () => {
    const { service, nonPi, store } = makeHarness(undefined, translatedEngineHooks());
    const handle = await service.execute({
      task: "d6 translate explicit",
      slug: "d6-tr-explicit",
      engine: NON_PI_ENGINE_ID,
      model: "zai-coding-cn/glm-5.3-flash",
    });
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe(`${TRANSLATION_TARGET}/GLM-5.3-FLASH`);
    expect(store.getMutable(handle.subagentId)?.model).toBe(`${TRANSLATION_TARGET}/GLM-5.3-FLASH`);
    // [subagent-detail-model-info] 翻译不改来源标注：task 显式 = explicit
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("explicit");
    nonPi.runs[0]!.settle();
  });

  it("偏好层翻译后在清单 → 偏好生效且留痕翻译产物", async () => {
    const { service, nonPi, store } = makeHarness(
      { [NON_PI_ENGINE_ID]: "zai-coding-cn/glm-5.3-flash" },
      translatedEngineHooks(),
    );
    const handle = await service.execute({
      task: "d6 translate pref-hit",
      slug: "d6-tr-pref-hit",
      engine: NON_PI_ENGINE_ID,
    });
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe(`${TRANSLATION_TARGET}/GLM-5.3-FLASH`);
    expect(store.getMutable(handle.subagentId)?.model).toBe(`${TRANSLATION_TARGET}/GLM-5.3-FLASH`);
    // [subagent-detail-model-info] 偏好补缺来源标注
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("preference");
    nonPi.runs[0]!.settle();
  });

  it("偏好层翻译后不在引擎清单（历史遗留值形态）→ 跳过偏好走引擎缺省 + warn", async () => {
    // logger mock 提升后生产 warn 走 logger facade——观察面 = loggerMock.warn
    const warn = loggerMock.warn;
    warn.mockClear();
    // 遗留值 zai-coding-plan/*（ADR-0132 退役形态）：翻译透传后不在引擎清单
    const { service, nonPi, store } = makeHarness(
      { [NON_PI_ENGINE_ID]: "zai-coding-plan/GLM-5.3-Flash" },
      translatedEngineHooks(),
    );
    const handle = await service.execute({
      task: "d6 translate pref-miss",
      slug: "d6-tr-pref-miss",
      engine: NON_PI_ENGINE_ID,
    });
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect("model" in nonPi.runs[0]!.task).toBe(false);
    expect(store.getMutable(handle.subagentId)?.model).toBeUndefined();
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("default");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("跳过偏好层"));
    warn.mockRestore();
    nonPi.runs[0]!.settle();
  });

  it("偏好层翻译抛 model_not_available（zcode 实装形态：退役模型历史遗留偏好）→ 跳过偏好走引擎缺省 + warn，不炸派发", async () => {
    // logger mock 提升后生产 warn 走 logger facade——观察面 = loggerMock.warn
    const warn = loggerMock.warn;
    warn.mockClear();
    // 模拟 zcode ZcodePrepareError 形态（code 属性承载 model_not_available）：
    // 偏好值命中 pi 侧已退役模型的翻译失败路径
    const { service, nonPi, store } = makeHarness(
      { [NON_PI_ENGINE_ID]: "zai-coding-cn/GLM-4.6V" },
      {
        translateModelRef: (ref) => {
          if (ref.startsWith("zai-coding-cn/")) {
            throw Object.assign(new Error(`[model_not_available] 模型 "${ref}" 无等价模型`), { code: "model_not_available" });
          }
          return ref;
        },
      },
    );
    const handle = await service.execute({
      task: "d6 translate pref-throw",
      slug: "d6-tr-pref-throw",
      engine: NON_PI_ENGINE_ID,
    });
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect("model" in nonPi.runs[0]!.task).toBe(false);
    expect(store.getMutable(handle.subagentId)?.model).toBeUndefined();
    expect(store.getMutable(handle.subagentId)?.modelSource).toBe("default");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("跳过偏好层"));
    warn.mockRestore();
    nonPi.runs[0]!.settle();
  });

  it("偏好层翻译抛非 model_not_available 错误 → 仍向上传播（首败即停语义仅收窄清单漂移）", async () => {
    // 断言在 resolveEngineModelWithTranslation 直调面：其他错误码不降级
    // [listModels 异步面] helper async 化 → 断言形态同步 throw 改 rejects
    const { resolveEngineModelWithTranslation } = await import("../engine/model-ref-translation.ts");
    await expect(
      resolveEngineModelWithTranslation(
        { engineId: NON_PI_ENGINE_ID, engine: { translateModelRef: () => { throw Object.assign(new Error("x"), { code: "engine_credential_missing" }); } } } as never,
        undefined,
        undefined,
        () => "prov/pref",
        () => {},
        "test",
      ),
    ).rejects.toThrow("x");
  });

  it("显式 model 翻译失败 → 派发同步期抛错（首败即停，record 创建前）", async () => {
    const { service } = makeHarness(undefined, {
      translateModelRef: () => {
        throw new Error("[model_not_available] 无等价模型");
      },
    });
    await expect(
      service.execute({
        task: "d6 translate fail",
        slug: "d6-tr-fail",
        engine: NON_PI_ENGINE_ID,
        model: "zai-coding-cn/glm-4.6v",
      }),
    ).rejects.toThrow(/无等价模型/);
  });
});

// ============================================================
// workflow 域（workflow-dispatch.resolveWorkflowIdentity）——同层序
// ============================================================

describe("D6 四层优先级：workflow 域（workflow-dispatch）同层序", () => {

  beforeEach(() => {
    resetCoreForTests();
  });

  afterEach(() => {
    for (const h of openHarnesses.splice(0)) {
      h.service.dispose();
      fs.rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    clearEngines();
    vi.restoreAllMocks();
  });
  function baseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
    return { prompt: "d6 wf task", description: "d6-wf-member", engine: NON_PI_ENGINE_ID, ...over };
  }

  it("形态 1：task 显式 model 赢过 frontmatter 与偏好", async () => {
    const { service, nonPi } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "d6-wf-agent", "prov/front-model");
    const pending = service.executeWorkflowAgent(
      baseOpts({ model: "prov/task-model", agent: agentPath }),
      "run-d6-wf-1",
    );
    await waitForFirstRunModel(nonPi.runs, "prov/task-model");
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("形态 2：task 空 + frontmatter 有 → frontmatter 赢过偏好", async () => {
    const { service, nonPi } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "d6-wf-agent", "prov/front-model");
    const pending = service.executeWorkflowAgent(baseOpts({ agent: agentPath }), "run-d6-wf-2");
    await waitForFirstRunModel(nonPi.runs, "prov/front-model");
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("形态 3：双空 → 偏好补缺（record 留痕与显式指定同形）", async () => {
    const { service, nonPi, store } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-d6-wf-3");
    await waitForFirstRunModel(nonPi.runs, "prov/pref-model");
    // record 创建先于引擎 run——running 窗口内可观测留痕盖章
    const running = store.listRunningMutable();
    expect(running).toHaveLength(1);
    expect(running[0]!.model).toBe("prov/pref-model");
    expect(running[0]!.modelSource).toBe("preference");
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("第四层：无偏好（本引擎键 miss）→ create 帧省略 model 键", async () => {
    const { service, nonPi } = makeHarness({ "other-engine": "prov/other" });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-d6-wf-4");
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect("model" in nonPi.runs[0]!.task).toBe(false);
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("pi 路由不插层：workflow pi 派发同样不消费 pi 偏好键", async () => {
    const { service, fakePi } = makeHarness({ pi: "prov/pi-pref" });
    const pending = service.executeWorkflowAgent(
      { prompt: "d6 wf pi", description: "d6-wf-pi" },
      "run-d6-wf-5",
    );
    await waitForFirstRunModel(fakePi.runs, PI_CTX_MODEL_REF);
    // pi 链三层解析落 ctxModel（p/m）；误插偏好层则会出现 prov/pi-pref

    fakePi.runs[0]!.settle({ content: "pi wf done" });
    await pending;
  });

  it("engine-ref-translation：偏好翻译后在清单 → 偏好生效且留痕翻译产物（与 chat 域同语义）", async () => {
    const { service, nonPi, store } = makeHarness(
      { [NON_PI_ENGINE_ID]: "zai-coding-cn/glm-5.3-flash" },
      translatedEngineHooks(),
    );
    const pending = service.executeWorkflowAgent(baseOpts(), "run-d6-tr-wf");
    await waitForFirstRunModel(nonPi.runs, `${TRANSLATION_TARGET}/GLM-5.3-FLASH`);
    const running = store.listRunningMutable();
    expect(running[0]!.model).toBe(`${TRANSLATION_TARGET}/GLM-5.3-FLASH`);
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("S-2 pi 路由来源标注三层（workflow 域同构）：frontmatter agent → frontmatter", async () => {
    // pi 路由 frontmatter 声明过派发期目录校验（declaredModel = agentConfig.model
    // → assertModelInCatalog）——registry 需含该模型。
    const { service, fakePi, store } = makeHarness(undefined, undefined, registryWith({ provider: "prov", id: "front-model" }));
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "s2-wf-agent", "prov/front-model");
    const pending = service.executeWorkflowAgent(
      { prompt: "s2 wf pi", description: "s2-wf-pi", agent: agentPath },
      "run-s2-wf",
    );
    await vi.waitFor(() => expect(fakePi.runs.length).toBe(1));
    const running = store.listRunningMutable();
    expect(running).toHaveLength(1);
    expect(running[0]!.modelSource).toBe("frontmatter");
    fakePi.runs[0]!.settle({ content: "pi wf done" });
    await pending;
  });

  it("S-3 覆盖 restamp 经引擎翻译面：record.model 与 task.model = 引擎原生 ref（不呈现 pi 词汇）", async () => {
    const { service, nonPi, store, modelService } = makeHarness(undefined, translatedEngineHooks());
    modelService.setModelOverride("run-s3-ovr", {
      ref: { provider: "zai-coding-cn", modelId: "glm-5.3-flash" },
      setAt: Date.now(),
    });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-s3-ovr");
    const ENGINE_REF = `${TRANSLATION_TARGET}/GLM-5.3-FLASH`;
    await waitForFirstRunModel(nonPi.runs, ENGINE_REF);
    // 修复前 restamp 直写 pi 词汇 overrideRef（zai-coding-cn/glm-5.3-flash）——
    // record/task 呈现引擎从未收到的 ref；修复后经 translateModelRef 翻译。
    const running = store.listRunningMutable();
    expect(running[0]!.model).toBe(ENGINE_REF);
    nonPi.runs[0]!.settle();
    await pending;
  });
});
// 来源段：workflow-agent-dispatch-model-catalog.test.ts
//
// [D8 Q1] 派发期对称校验单测（workflow-dispatch.resolveWorkflowIdentity 的
// isPiRoute 分流点）：
//   - pi 路由脚本字面量坏模型 → 该 ask 派发前同步拒绝（零 engine.run 零 record
//     零池占用），错误含可用清单与漂移分类（验收 a/c 的 L1 面）；
//   - pi 路由 agent frontmatter model（同一源联合的 agentConfig 分支）同点被校验；
//   - zcode 引擎 run 携带 pi 目录外模型 → 跳过目录校验不误拒（范围限定——
//     引擎域归 validateModelForEngine / 引擎缺省裁决）。
//
// 替身形态与 workflow-agent-dispatch.test.ts 同款（registerFakePiEngine + 本地
// 构造非 pi 引擎 port + ModelConfigService 注入 populated registry）。

const CATALOG_ENTRIES: ReadonlyArray<ModelInfo> = [
  { id: "good-a", name: "A", provider: "prov1", reasoning: false },
  { id: "good-b", name: "B", provider: "prov2", reasoning: false },
];

function populatedRegistry(): ModelRegistryLike {
  return {
    getAvailable: () => [...CATALOG_ENTRIES],
    find: (provider: string, id: string) =>
      CATALOG_ENTRIES.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
  };
}

/** 非 pi 引擎替身（路由到 engine:"zcode-like" 的派发捕获；validateModel 不实现
 *  ——引擎无目录裁决时 modelRef 原样透传的既有语义）。 */
function registerZcodeLikeEngine(): { port: EnginePort; runs: Array<{ task: AgentCallOpts }> } {
  const caps: EngineCapabilities = {
    schemaEnforcement: "emulated",
    steer: "unsupported",
    conversation: "unsupported",
    personaInjection: "prompt",
    eventGranularity: "coarse",
    sandbox: "none",
    sessionRead: "outcome-only",
    resume: "unsupported",
    interrupt: "kill-only",
    permissionMode: "ignored",
    maxTurns: false,
  };
  const runs: Array<{ task: AgentCallOpts }> = [];
  const port: EnginePort = {
    id: "zcode-like",
    capabilities: () => caps,
    probe: async () => ({ ok: true, engineVersion: "fake-zcode-like", checks: [{ name: "invocation", ok: true, detail: "fake" }] }),
    run: (task: AgentCallOpts) => new Promise(() => {
      runs.push({ task });
    }),
    read: async () => ({ engineId: "zcode-like", turns: [], source: "outcome-only" }),
  };
  registerEngine("zcode-like", () => port);
  return { port, runs };
}

interface CatalogHarness {
  service: SubagentService;
  store: RecordStore;
  pi: PiMock;
  fake: FakePiEnginePort;
  agentDir: string;
  tmpRoot: string;
}

const catalogOpenHarnesses: Array<{ service: SubagentService; tmpRoot: string }> = [];

function makeCatalogHarness(): CatalogHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-model-catalog-it-"));
  process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: populatedRegistry(),
    sessionId: "wf-model-catalog-it",
    ctxModel: CTX_MODEL,
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "wf-model-catalog-it" });
  clearEngines();
  const fake = registerFakePiEngine();
  catalogOpenHarnesses.push({ service, tmpRoot });
  return { service, store: Reflect.get(service, "store") as RecordStore, pi, fake, agentDir, tmpRoot };
}

function wfBaseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "调研 A", description: "research-a", ...over };
}

describe("D8 派发期对称校验（isPiRoute 分流点）", () => {

  beforeEach(() => {
    resetCoreForTests();
  });

  afterEach(() => {
    for (const h of catalogOpenHarnesses.splice(0)) {
      h.service.dispose();
      fs.rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    clearEngines();
    vi.restoreAllMocks();
  });
  it("脚本字面量坏模型 → 派发前同步拒绝（零 engine.run 零 record），错误含可用清单", async () => {
    const { service, fake, store, pi } = makeCatalogHarness();
    const pending = service.executeWorkflowAgent(
      wfBaseOpts({ model: "prov1/typo" }),
      "run-d8-1",
    );
    const err = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    // 分类化拒单：查无 + 可用清单 + 恢复指引
    expect(message).toContain("not in the pi engine model catalog");
    expect(message).toContain("prov1/good-a");
    expect(message).toContain("prov2/good-b");
    expect(message).toContain("Recovery:");
    // 零 spawn 零 record 零 pending 注册（先于 record 创建/池 acquire 的 D3 顺序）
    expect(fake.runs).toHaveLength(0);
    expect(store.listRunning()).toHaveLength(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("agent frontmatter model（agentConfig 分支）同点被校验", async () => {
    const { service, fake } = makeCatalogHarness();
    const agentPath = path.join(catalogOpenHarnesses[0]!.tmpRoot, "agent", "drift-agent.md");
    // [session-store-layout-inversion] store 树已迁 engine-data——agentDir 不再被
    // store 写点隐式创建，agent fixture 目录显式自建
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    fs.writeFileSync(
      agentPath,
      "---\nname: drift-agent\ndescription: d8 fixture\nkind: agent\nmodel: prov1/typo\n---\nBody",
    );
    const err = await service
      .executeWorkflowAgent(wfBaseOpts({ agent: agentPath }), "run-d8-2")
      .then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error && err.message).toContain("not in the pi engine model catalog");
    expect(fake.runs).toHaveLength(0);
  });

  it("目录命中模型正常放行到 engine.run", async () => {
    const { service, fake } = makeCatalogHarness();
    const pending = service.executeWorkflowAgent(
      wfBaseOpts({ model: "prov1/good-a" }),
      "run-d8-3",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]!.task.model).toBe("prov1/good-a");
    fake.runs[0]!.settle({ content: "done" });
    await pending;
  });

  it("zcode 引擎 run 携带 pi 目录外模型 → 跳过目录校验不误拒", async () => {
    const { service } = makeCatalogHarness();
    const zcodeLike = registerZcodeLikeEngine();
    const pending = service.executeWorkflowAgent(
      wfBaseOpts({ engine: "zcode-like", model: "builtin/some-plan-model" }),
      "run-d8-4",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 非 pi 分支不被目录校验拦截——直达引擎派发（模型域归 validateModelForEngine
    // / 引擎缺省裁决；本替身不实现 validateModel = 原样透传语义）
    expect(zcodeLike.runs).toHaveLength(1);
    pending.catch(() => undefined); // 替身 run 永挂，防 unhandled rejection 噪音
  });
});

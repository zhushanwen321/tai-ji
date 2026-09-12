// src/execution/__tests__/chat-engine-routing.test.ts
//
// U0 chat 工具域引擎路由分叉测试。设计权威源：
// docs/architecture/subagent-engine-gui-visibility.md §3.3 D4（chat 入口路由分叉）/
// D5（pi 缺省字节级零变化）/ D10（zcode 分支终止链）。
//
// 覆盖：
//   1. 三层路由优先级（opts.engine > agent frontmatter engine > config defaultEngine；
//      全缺省 → pi 原路径）
//   2. pi 缺省守护（record.engine === undefined；entry 序列化产物不含 "engine" 键）
//   3. unsupported 参数预检（conversation/fork/worktree 同步拒绝，不产生 record）
//   4. 未注册 engine id → engine_not_found
//   5. 引擎分支骨架（record 创建+盖章 / taskSpec 字段 / detached run / done+failed
//      终态迁移 / spawnedChildren 注册 / abort signal 触达引擎 kill-chain）
//   6. U2：probe 兜底两态（默认路由兜底回 pi / 显式 engine 守卫报错）+ JournalWriter
//      接线（taskId=record.id + onPoolResolved retarget）+ engineHandle 完整回填
//
// mock 策略：只 mock node:child_process.spawn（pi 原路径的 FakeChild，见
// execute-nesting.test.ts 同款范式）——非 pi 引擎分支用假 EnginePort（registerEngine
// 注入），不 spawn 任何进程；fs 用真实 os.tmpdir()（engine 分支的 manifest 落盘无妨）。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// u0-data-discovery 注入化：execute 链路的 getEngineDataDir 回退段经
// HostServices.dataRoot() 端口——端口态经 configureCore 显式控制（见 beforeEach）
import { configureCore, resetCoreForTests } from "../../core/host-services.ts";

// pi 原路径 spawn mock（FakeChild 挂起不推进——本文件只断言路由归属与 record 形态，
// 不驱动 pi session 事件流）。
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

import type { EnginePort, RunContext } from "../engine/port.ts";
import { resolveJournalPath } from "../engine/paths.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type {
  AgentEvent,
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  ProbeReport,
} from "../engine/types.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import { toSubagentRecordEntry } from "../record-entry.ts";
// W10（§2.10 ②）：子进程句柄断言改读 core 侧状态镜像（host/spawned-children——
// 协议化后 spawnedChildren 持有方在引擎进程，core 消费镜像面；判据 pid 同构）。
import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import { SubagentService } from "../subagent-service.ts";
import type { ExecuteOptions } from "../types.ts";

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

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

const CTX_MODEL: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

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
  pi: ReturnType<typeof makePi>;
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
  });

  afterEach(() => {
    // registry 是 globalThis 进程单例——必须清空，防假引擎泄漏进其他测试文件
    clearEngines();
    resetCoreForTests();
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
      modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true } satisfies ModelRegistryLike,
      sessionId: "test-session",
      ctxModel: CTX_MODEL,
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "test-session" });

    const handle = await service.execute(baseOpts(agentDir));
    // 不可用 stub：轮次派发在首次 engine.run 拒绝（engine_not_found）→ chatMode=false
    // 一次性 run 终态销毁（无孤儿 record——拒绝点唯一化在 run）。
    await vi.waitFor(() => {
      const rec = service.queries.collectRecords(10, "all").find((r) => r.id === handle.subagentId);
      expect(rec?.status).toBe("closed");
    });
  });

  // ============================================================
  // 2. pi 缺省守护（D5 字节级）
  // ============================================================

  it("[F6] pi 路由 kickOffChatRound：runCtx 带 sessionRootId（initSession 注入的根 id，relay 归属键权威源）", async () => {
    const { service, piEngine } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));
    // initSession({sessionId: "test-session"}) 无 env → sessionRootId = "test-session"；
    // kickOffChatRound 是 pi 引擎 background 派发主路径（isPiRoute 恒路由至此，含
    // workflow 域一次性 run），漏注 = GUI pi 派发 relay 拒绝 exit 13（Gate B F6 形态）。
    expect(piEngine.runs[0]!.ctx.sessionRootId).toBe("test-session");
  });

  it("[D5] 全缺省 pi record：engine===undefined 且 entry JSON 不含 engine 键", async () => {
    const { service, piEngine } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));

    const rec = service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec).toBeDefined();
    expect(rec?.engine).toBeUndefined();
    expect(JSON.stringify(toSubagentRecordEntry(rec!))).not.toContain("engine");
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

  it("[预检] engine='zcode' + conversation:true → throw 且不产生 record", async () => {
    const { service, zcode } = setup(agentDir);
    const err = await service
      .execute(baseOpts(agentDir, { engine: "zcode", conversation: true }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("不支持 resume 续聊");
    // 恢复指引（EngineError.recovery）：W3 协议化口径——调参数 / 修 manifest / 升级
    // 引擎包（引擎包是能力声明载体；「改用 engine: pi」内置兜底指引已随协议化删除）
    expect((err as { recovery?: string }).recovery).toContain("去掉 conversation 参数");
    expect((err as { recovery?: string }).recovery).toContain("修 manifest capabilities");
    expect((err as { recovery?: string }).recovery).toContain("升级引擎包");
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "all")).toHaveLength(0);
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
    // 旧形态：Service 层预检不查 maxTurns → record 创建 + kickOffEngineRun →
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

  it("[V4⑤ 反向] pi + maxTurns/fork/conversation/worktree → 零拦截（pi 既有合法能力无回归）", async () => {
    const { service, piEngine, zcode } = setup(agentDir);
    // maxTurns=3（V4⑤ 场景原样）：正常进入 pi 轮次（engine.run 被调），无同步拒绝
    const handle = await service.execute(baseOpts(agentDir, { maxTurns: 3 }));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId)).toBeDefined();
    // fork / conversation 组合同样直通（第二次 run 被调，无 engine_capability_unsupported）
    await service.execute(baseOpts(agentDir, { fork: true, conversation: true }));
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
    expect(ctx.poolKey).toBe("shared");
  });

  it("[骨架] run resolve 成功 → record 终态 done + result=content", async () => {
    const { service, zcode, pi } = setup(agentDir);
    zcode.runImpl = () => Promise.resolve({ handle: fakeHandle(), outcome: doneOutcome("hello result") });
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));

    // record 终态化即 archive（无 sessionFile 不可磁盘重建）→ 内存查询落空
    await vi.waitFor(() => expect(service.queries.findRecord(handle.subagentId)).toBeUndefined());
    // 完成通知（chat 域宿主职责）：notifier 立即 flush（无其他 running）→ result 进 sendMessage 正文
    await vi.waitFor(() => {
      const sent = pi.sendMessage.mock.calls.some((c) => String(c[0]?.content).includes("hello result"));
      expect(sent).toBe(true);
    });
  });

  it("[骨架] outcome.error → record 终态 failed", async () => {
    const { service, zcode, pi } = setup(agentDir);
    zcode.runImpl = () =>
      Promise.resolve({ handle: fakeHandle(), outcome: { ...doneOutcome(""), error: "engine_run_failed: boom", engineId: "zcode" } });
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));

    await vi.waitFor(() => expect(service.queries.findRecord(handle.subagentId)).toBeUndefined());
    await vi.waitFor(() => {
      const sent = pi.sendMessage.mock.calls.some((c) => String(c[0]?.content).includes("boom"));
      expect(sent).toBe(true);
    });
  });

  it("[D10] onChildSpawned 注册进 spawnedChildren + cancel abort 后 signal 触达引擎", async () => {
    const { service, zcode } = setup(agentDir);
    class FakeProc extends EventEmitter {
      pid = 4321;
      killed = false;
      kill(sig?: string): boolean {
        this.killed = true;
        return sig !== undefined;
      }
    }
    const child = new FakeProc() as unknown as ChildProcess;
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    // 引擎经 RunContext.onChildSpawned 上报子进程 → 宿主记账（kill-chain 数据源）
    zcode.runs[0].ctx.onChildSpawned?.(child);
    expect(coreSpawnedChildrenMirror().getChildByRecord(handle.subagentId)?.pid).toBe(child.pid);

    // cancel → controller.abort → engine 收到的 signal aborted（kill-chain 两级的第一级）
    expect(zcode.runs[0].ctx.signal?.aborted).toBe(false);
    service.cancel(handle.subagentId);
    expect(zcode.runs[0].ctx.signal?.aborted).toBe(true);
    // 子进程退出后记账按句移除
    child.emit("close", 0, null);
    // 按句移除断言（W10 注）：inproc 双模不回灌 childStateChanged，镜像移除由
    // protocol-blackbox 承载（同 subprocess-agent-runner-routing D10 注）。
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

      // chat 域 background 派发（runEngineTask 的 runCtx 构造点）
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
// U2：probe/守卫兜底 + JournalWriter + engineHandle 回填
// 设计权威源：docs/architecture/subagent-engine-gui-visibility.md §3.3 D4/D6、§5 U2 行
// ============================================================

describe("chat 引擎分支 U2：probe 兜底 / journal / engineHandle", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    writeGlobalConfig(agentDir);
  });

  afterEach(() => {
    clearEngines();
    delete process.env.XYZ_AGENT_DATA_DIR;
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  it("[兜底] 默认路由 zcode + probe 失败 → 回退 pi 协议 run + engineFallback 留痕", async () => {
    writeGlobalConfig(agentDir, "zcode");
    const { service, zcode, piEngine } = setup(agentDir);
    zcode.probeFailed = true;

    const handle = await service.execute(baseOpts(agentDir));
    // 兜底 = 走 pi 协议 run 路径（engine.run 被调；[W3] pi 与 run 域同路）
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));
    expect(mockSpawn).not.toHaveBeenCalled();

    const rec = service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec?.engine).toBe("pi");
    expect(rec?.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
    // entry（register 写点）含 engineFallback——兜底路径允许新增键（D5 只约束纯缺省路径）
    expect(JSON.stringify(toSubagentRecordEntry(rec!))).toContain("engine_probe_failed");
  });

  it("[守卫] 显式 engine='zcode' + probe 失败 → engine_probe_failed 报错不兜底", async () => {
    const { service, zcode } = setup(agentDir);
    zcode.probeFailed = true;

    await expect(service.execute(baseOpts(agentDir, { engine: "zcode" }))).rejects.toThrow(
      /engine_probe_failed/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(zcode.runs.length).toBe(0);
    expect(service.queries.collectRecords(10, "all")).toHaveLength(0);
  });

  it("[journal] taskId=record.id + onPoolResolved retarget 落 engines/zcode/<poolKey>/，journalPath 同源回填", async () => {
    process.env.XYZ_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    const POOL = "zcode-p-glm";
    zcode.runImpl = (task, ctx) => {
      ctx.onPoolResolved?.(POOL);
      ctx.onEvent?.({ type: "message_end" } as AgentEvent);
      return Promise.resolve({
        handle: {
          data: {
            v: 1,
            engineId: "zcode",
            sessionRef: { dbPath: "sessions.db", sessionId: "sess-1" },
            poolKey: POOL,
            adapterVersion: "test",
          },
        },
        outcome: doneOutcome("ok"),
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(service.queries.findRecord(handle.subagentId)).toBeUndefined());

    // journal 文件名 = journal-<record.id>.jsonl，落在 engines/zcode/<poolKey>/ 下
    const journalPath = resolveJournalPath(agentDir, "zcode", POOL, handle.subagentId);
    expect(fs.existsSync(journalPath)).toBe(true);
    const firstLine = JSON.parse(fs.readFileSync(journalPath, "utf8").split("\n")[0]);
    expect(firstLine.taskId).toBe(handle.subagentId);

    // archive entry 的 engineHandle：三键齐全，journalPath 与实际落盘路径一致（同源）
    const entry = lastRecordEntry(pi);
    expect(entry?.engineHandle).toEqual({
      sessionRef: { dbPath: "sessions.db", sessionId: "sess-1" },
      poolKey: POOL,
      journalPath,
    });
  });

  it("[engineHandle] 失败终态 sessionId 缺失 → 仍回填 dbPath/poolKey（①级降②级防御形态）", async () => {
    process.env.XYZ_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    const POOL = "zcode-p-glm";
    zcode.runImpl = (task, ctx) => {
      ctx.onPoolResolved?.(POOL);
      return Promise.resolve({
        handle: {
          data: { v: 1, engineId: "zcode", sessionRef: { dbPath: "sessions.db" }, poolKey: POOL, adapterVersion: "test" },
        },
        outcome: { ...doneOutcome(""), error: "engine_run_failed: boom", engineId: "zcode" },
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(service.queries.findRecord(handle.subagentId)).toBeUndefined());

    const h = lastRecordEntry(pi)?.engineHandle as Record<string, unknown> | undefined;
    expect(h?.sessionRef).toEqual({ dbPath: "sessions.db" });
    expect(h?.poolKey).toBe(POOL);
    expect(h?.journalPath).toBe(resolveJournalPath(agentDir, "zcode", POOL, handle.subagentId));
  });

  // ============================================================
  // [R4 §3.4 不变量 3] onHandleReady 运行中回填：create 应答后立即落 entry——
  // 运行中 GUI 经 entry 重建 record 即得 ①②级读取钥匙（不等 run resolve）
  // ============================================================

  it("[onHandleReady] create 应答后回调 → record.engineHandle 立即回填 + reportRecordTransition 落 entry（record 仍 running）", async () => {
    process.env.XYZ_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    const POOL = "zcode-appserver-home";
    let releaseRun!: (v: { handle: EngineHandle; outcome: AgentOutcome }) => void;
    zcode.runImpl = (task, ctx) => {
      ctx.onPoolResolved?.(POOL);
      // create 应答后的回调时点（app-server 引擎在 session/create 应答后触发）
      ctx.onHandleReady?.({
        sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" },
        poolKey: POOL,
      });
      return new Promise((resolve) => {
        releaseRun = resolve; // 挂起 run——模拟运行中任务
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    // run 尚未 resolve（record 仍 running）：engineHandle 已回填且 entry 已落盘
    await vi.waitFor(() => {
      const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
      const withHandle = entries.filter(
        (c) => (c[1] as Record<string, unknown>).engineHandle !== undefined,
      );
      expect(withHandle.length).toBeGreaterThan(0);
    });
    const running = service["collectRecords"](10, "running").find((r) => r.id === handle.subagentId);
    expect(running?.engineHandle).toEqual({
      sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" },
      poolKey: POOL,
      journalPath: resolveJournalPath(agentDir, "zcode", POOL, handle.subagentId),
    });
    // 回填 entry 的 journalPath 与 onPoolResolved retarget 后的实际落盘路径一致（同源）
    expect(fs.existsSync(resolveJournalPath(agentDir, "zcode", POOL, handle.subagentId))).toBe(false);

    // 终态收口（防 dangling）
    releaseRun({ handle: fakeHandle(), outcome: doneOutcome("ok") });
    await vi.waitFor(() => expect(service["findRecord"](handle.subagentId)).toBeUndefined());
  }, 10_000);

  it("[onHandleReady F1] sessionId 先落 + 迟到只补 sessionFile → 按字段补缺落位；已有值不被迟到值覆盖（幂等）", async () => {
    process.env.XYZ_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    const POOL = "zcode-appserver-home";
    const LATE_SESSION_FILE = "/tmp/late/session-abc.jsonl";
    let releaseRun!: (v: { handle: EngineHandle; outcome: AgentOutcome }) => void;
    zcode.runImpl = (task, ctx) => {
      ctx.onPoolResolved?.(POOL);
      // ① create 应答：只带 sessionId（本 replay 批次新打通的可达面——close 期 LC-4
      // 后缀反查在 sessionId 已知后才补发 sessionFile）。
      ctx.onHandleReady?.({
        sessionRef: { dbPath: ".zcode/cli/db/db.sqlite", sessionId: "sess-live-1" },
        poolKey: POOL,
      });
      // ② 迟到 handleReady：只补 sessionFile——旧守卫「有 sessionId 即整条 return」
      // 会把它整条吞掉，sessionFile 永不落位（消费点：冷续 resume 锚点 / interact 定位）。
      ctx.onHandleReady?.({
        sessionRef: { sessionId: "sess-live-1", sessionFile: LATE_SESSION_FILE },
        poolKey: POOL,
      });
      // ③ 再迟到一次且带冲突值：已有值必须原样保留（幂等），poolKey 不被重置。
      ctx.onHandleReady?.({
        sessionRef: { sessionId: "sess-OVERWRITE", sessionFile: "/tmp/late/other.jsonl" },
        poolKey: "hijacked-pool",
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
      poolKey: POOL,
      journalPath: resolveJournalPath(agentDir, "zcode", POOL, handle.subagentId),
    });
    // 补缺经 entry 持久化（运行中 GUI 经 entry 重建 record 即可见），且 ③ 的
    // 「无新字段」重复回调不产生第二条写噪（同 sessionFile 恰好一条）。
    const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
    const withLateSessionFile = entries.filter(
      (c) =>
        ((c[1] as Record<string, unknown>).engineHandle as
          | { sessionRef?: Record<string, string> }
          | undefined)?.sessionRef?.["sessionFile"] === LATE_SESSION_FILE,
    );
    expect(withLateSessionFile).toHaveLength(1);

    // 终态收口（防 dangling）
    releaseRun({ handle: fakeHandle(), outcome: doneOutcome("ok") });
    await vi.waitFor(() => expect(service["findRecord"](handle.subagentId)).toBeUndefined());
  }, 10_000);

  it("[onHandleReady] 引擎不回调（spawn 形态）时零回填——终态回填仍兜底（行为不变）", async () => {
    process.env.XYZ_AGENT_DATA_DIR = agentDir;
    const { service, zcode, pi } = setup(agentDir);
    const POOL = "zcode-p-glm";
    zcode.runImpl = (task, ctx) => {
      ctx.onPoolResolved?.(POOL); // 只 onPoolResolved——spawn 引擎形态（无 onHandleReady）
      return Promise.resolve({
        handle: {
          data: { v: 1, engineId: "zcode", sessionRef: { dbPath: "sessions.db", sessionId: "sess-1" }, poolKey: POOL, adapterVersion: "test" },
        },
        outcome: doneOutcome("ok"),
      });
    };
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
    await vi.waitFor(() => expect(service["findRecord"](handle.subagentId)).toBeUndefined());
    const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
    // 运行中回填 entry 不存在（register 写点无 engineHandle；archive 终态侧才有）
    const runningEntries = entries.slice(0, -1);
    for (const c of runningEntries) {
      expect((c[1] as Record<string, unknown>).engineHandle).toBeUndefined();
    }
    const final = entries[entries.length - 1][1] as Record<string, unknown>;
    expect(final.engineHandle).toMatchObject({ poolKey: POOL });
  });

  it("[D5 回归] pi 纯缺省路径 entry 不含 engine/engineFallback/engineHandle 键", async () => {
    const { service, piEngine, pi } = setup(agentDir);
    const handle = await service.execute(baseOpts(agentDir));
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));

    const rec = service.queries.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    const entryJson = JSON.stringify(toSubagentRecordEntry(rec!));
    expect(entryJson).not.toContain("engineFallback");
    expect(entryJson).not.toContain("engineHandle");
    expect(entryJson).not.toMatch(/"engine"/);
    // pi.appendEntry 上的 record entry 同形态（register 写点）
    const entry = lastRecordEntry(pi);
    expect(entry?.engine).toBeUndefined();
    expect(entry?.engineFallback).toBeUndefined();
    expect(entry?.engineHandle).toBeUndefined();
  });

  it("[池槽回归] 引擎 run 完成后 release 并发槽：连续 7 次（> maxConcurrent=6）后第 7 次不被永久阻塞", async () => {
    // review MF1：kickOffEngineRun 旧实现 acquire 后无 release——每次引擎后台 run 泄漏
    // 一个槽，累计 maxConcurrent(6) 次后全部 background subagent 在 acquire 队列挂死
    process.env.XYZ_AGENT_DATA_DIR = agentDir;
    const { service, zcode } = setup(agentDir);
    zcode.runImpl = () => Promise.resolve({ handle: fakeHandle(), outcome: doneOutcome("ok") });

    for (let i = 0; i < 7; i++) {
      const h = await service.execute(baseOpts(agentDir, { engine: "zcode" }));
      // 等本条终态化（record 离开内存）再发下一条——泄漏形态下第 7 条 acquire 永久
      // 排队、record 永卡 running，本 waitFor 即超时失败
      await vi.waitFor(() => expect(service.queries.findRecord(h.subagentId)).toBeUndefined());
    }
    // 7 次引擎 run 全部真实执行（第 7 次未被泄漏槽阻塞）
    expect(zcode.runs.length).toBe(7);
  }, 10_000);

  /** 最后一条 subagent-record entry（register→archive 双写点取终态侧）。 */
  function lastRecordEntry(pi: ReturnType<typeof makePi>): Record<string, unknown> | undefined {
    const calls = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
    return calls.length > 0 ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined;
  }
});

/** 假 EngineHandle（骨架路径不消费 handle 内容——U2 journal/handle 回填才用）。 */
function fakeHandle(): EngineHandle {
  return {
    data: { v: 1, engineId: "zcode", sessionRef: {}, poolKey: "shared", adapterVersion: "test" },
  };
}

// src/execution/__tests__/run-orchestration-engine-defaults.test.ts
//
// [engine-provider-unification D6 / u6-dispatch] 四层优先级派发插层验收：
//   task 显式指定 > agent frontmatter 声明 > settings 用户偏好（engineDefaults，
//   派发时点直读磁盘）> 引擎缺省（create 帧省略 model 键，引擎自解析）。
// 两个消费点同层序核对：
//   - chat 域：run-orchestration.resolveIdentityForRoute（service.execute）；
//   - workflow 域：workflow-dispatch.resolveWorkflowIdentity（service.executeWorkflowAgent）。
// 防御面：pi 路由恒不插层（pi 链自有三层解析，taiji 级偏好无意义——D6 不采用段）；
// 直读面：config 在 service 构造后写入 → 派发仍读到（不经构造期 globalConfig 缓存，
// 「settings 保存 → 活跃 session 派发」场景 S2 的自然操作序列）。
//
// 替身形态与 workflow-agent-dispatch-model-catalog.test.ts 同款（本地构造非 pi 引擎
// port + registerFakePiEngine + 真实 ModelConfigService 指向 tmp agentDir）；偏好
// fixture = 真实写盘 <agentDir>/subagents/config.json（readEngineDefaults 直读链全真）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentService } from "../subagent-service.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { getGlobalConfigPath } from "../assembly/config.ts";
import type { ModelRegistryLike } from "../assembly/model-resolver.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import { resetCoreForTests } from "../../core/host-services.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type {
  EngineCapabilities,
  EngineHandle,
  ProbeReport,
  SessionView,
} from "../engine/types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../engine/port.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { CTX_MODEL } from "./helpers/model-registry-mock.ts";

// ============================================================
// 非 pi 引擎替身（可结算——chat 域轮终收口与 workflow 域 await 都需要 run 应答）
// ============================================================

/** 一次 run 捕获（task + 手动结算面）。 */
interface CapturedRun { // oe-exempt:20261012:test:测试捕获断言形态
  readonly task: AgentCallOpts;
  settle: () => void;
}

class CapturingNonPiEngine implements EnginePort {
  readonly runs: CapturedRun[] = [];

  constructor(
    readonly id: string,
    private readonly caps: EngineCapabilities,
  ) {}

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

interface Harness { // oe-exempt:20261012:test:测试装配形态
  service: SubagentService;
  store: RecordStore;
  pi: PiMock;
  fakePi: FakePiEnginePort;
  nonPi: CapturingNonPiEngine;
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

function makeHarness(engineDefaults?: Record<string, string>): Harness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "d6-engine-defaults-"));
  // 测试红线：store/引擎数据面不触真实数据目录
  process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  if (engineDefaults !== undefined) writeEngineDefaults(agentDir, engineDefaults);
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: EMPTY_REGISTRY,
    sessionId: "d6-engine-defaults-it",
    ctxModel: CTX_MODEL,
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "d6-engine-defaults-it" });
  clearEngines();
  const nonPi = new CapturingNonPiEngine(NON_PI_ENGINE_ID, plainTaskCaps());
  registerEngine(NON_PI_ENGINE_ID, () => nonPi);
  const fakePi = registerFakePiEngine();
  openHarnesses.push({ service, tmpRoot });
  return { service, store: (service as unknown as ServiceInternals).store, pi, fakePi, nonPi, agentDir, tmpRoot };
}

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

// ============================================================
// chat 域（run-orchestration.resolveIdentityForRoute）
// ============================================================

describe("D6 四层优先级：chat 域（run-orchestration）", () => {
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
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    // 第一层赢：create 帧 model = task 显式值
    expect(nonPi.runs[0]!.task.model).toBe("prov/task-model");
    // 留痕同形：偏好补缺与显式指定共用同一 record.opts.model 盖章通道
    expect(store.getMutable(handle.subagentId)?.model).toBe("prov/task-model");
    nonPi.runs[0]!.settle();
  });

  it("形态 2：task 空 + frontmatter 有 → frontmatter 赢过偏好（作者显式声明不被全局偏好压掉）", async () => {
    const { service, nonPi } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "d6-agent", "prov/front-model");
    await service.execute({
      task: "d6 chat form2",
      slug: "d6-form2",
      engine: NON_PI_ENGINE_ID,
      agent: agentPath,
    });
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe("prov/front-model");
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
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe("prov/pref-model");
    // D6 留痕口径：record 消费方只关心「用了哪个模型」，不区分「谁决定的」
    expect(store.getMutable(handle.subagentId)?.model).toBe("prov/pref-model");
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
// workflow 域（workflow-dispatch.resolveWorkflowIdentity）——同层序
// ============================================================

describe("D6 四层优先级：workflow 域（workflow-dispatch）同层序", () => {
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
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe("prov/task-model");
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("形态 2：task 空 + frontmatter 有 → frontmatter 赢过偏好", async () => {
    const { service, nonPi } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const agentPath = writeFrontmatterAgent(openHarnesses[0]!.tmpRoot, "d6-wf-agent", "prov/front-model");
    const pending = service.executeWorkflowAgent(baseOpts({ agent: agentPath }), "run-d6-wf-2");
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe("prov/front-model");
    nonPi.runs[0]!.settle();
    await pending;
  });

  it("形态 3：双空 → 偏好补缺（record 留痕与显式指定同形）", async () => {
    const { service, nonPi, store } = makeHarness({
      [NON_PI_ENGINE_ID]: "prov/pref-model",
    });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-d6-wf-3");
    await vi.waitFor(() => expect(nonPi.runs.length).toBe(1));
    expect(nonPi.runs[0]!.task.model).toBe("prov/pref-model");
    // record 创建先于引擎 run——running 窗口内可观测留痕盖章
    const running = store.listRunningMutable();
    expect(running).toHaveLength(1);
    expect(running[0]!.model).toBe("prov/pref-model");
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
    await vi.waitFor(() => expect(fakePi.runs.length).toBe(1));
    // pi 链三层解析落 ctxModel（p/m）；误插偏好层则会出现 prov/pi-pref
    expect(fakePi.runs[0]!.task.model).toBe(PI_CTX_MODEL_REF);
    fakePi.runs[0]!.settle({ content: "pi wf done" });
    await pending;
  });
});

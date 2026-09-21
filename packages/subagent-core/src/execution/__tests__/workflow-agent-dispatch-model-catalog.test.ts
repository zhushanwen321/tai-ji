// src/execution/__tests__/workflow-agent-dispatch-model-catalog.test.ts
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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { SubagentService } from "../subagent-service.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../assembly/model-resolver.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import { resetCoreForTests } from "../../core/host-services.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { EngineCapabilities } from "../engine/types.ts";
import type { EnginePort } from "../engine/port.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { CTX_MODEL as ctxModel } from "./helpers/model-registry-mock.ts";

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

interface Harness {
  service: SubagentService;
  store: RecordStore;
  pi: PiMock;
  fake: FakePiEnginePort;
  agentDir: string;
  tmpRoot: string;
}

const openHarnesses: Array<{ service: SubagentService; tmpRoot: string }> = [];

function makeHarness(): Harness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-model-catalog-it-"));
  process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: populatedRegistry(),
    sessionId: "wf-model-catalog-it",
    ctxModel,
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "wf-model-catalog-it" });
  clearEngines();
  const fake = registerFakePiEngine();
  openHarnesses.push({ service, tmpRoot });
  return { service, store: Reflect.get(service, "store") as RecordStore, pi, fake, agentDir, tmpRoot };
}

function baseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "调研 A", description: "research-a", ...over };
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

describe("D8 派发期对称校验（isPiRoute 分流点）", () => {
  it("脚本字面量坏模型 → 派发前同步拒绝（零 engine.run 零 record），错误含可用清单", async () => {
    const { service, fake, store, pi } = makeHarness();
    const pending = service.executeWorkflowAgent(
      baseOpts({ model: "prov1/typo" }),
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
    const { service, fake } = makeHarness();
    const agentPath = path.join(openHarnesses[0]!.tmpRoot, "agent", "drift-agent.md");
    fs.writeFileSync(
      agentPath,
      "---\nname: drift-agent\ndescription: d8 fixture\nkind: agent\nmodel: prov1/typo\n---\nBody",
    );
    const err = await service
      .executeWorkflowAgent(baseOpts({ agent: agentPath }), "run-d8-2")
      .then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error && err.message).toContain("not in the pi engine model catalog");
    expect(fake.runs).toHaveLength(0);
  });

  it("目录命中模型正常放行到 engine.run", async () => {
    const { service, fake } = makeHarness();
    const pending = service.executeWorkflowAgent(
      baseOpts({ model: "prov1/good-a" }),
      "run-d8-3",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]!.task.model).toBe("prov1/good-a");
    fake.runs[0]!.settle({ content: "done" });
    await pending;
  });

  it("zcode 引擎 run 携带 pi 目录外模型 → 跳过目录校验不误拒", async () => {
    const { service } = makeHarness();
    const zcodeLike = registerZcodeLikeEngine();
    const pending = service.executeWorkflowAgent(
      baseOpts({ engine: "zcode-like", model: "builtin/some-plan-model" }),
      "run-d8-4",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 非 pi 分支不被目录校验拦截——直达引擎派发（模型域归 validateModelForEngine
    // / 引擎缺省裁决；本替身不实现 validateModel = 原样透传语义）
    expect(zcodeLike.runs).toHaveLength(1);
    pending.catch(() => undefined); // 替身 run 永挂，防 unhandled rejection 噪音
  });
});

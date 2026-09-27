// engine-query.test.ts —— pi 引擎查询面（engine-query.ts，pi-workflow-run-resource-model
// §3.3 决策 11 方案 B）单测。fixture json 注入 mkdtemp tmp 目录（自建自删，零真实数据
// 目录触碰），server 接线用例经 EngineProtocolServer piAgentDir 注入同款 fixture。
// 另含零新依赖红线断言（包 dependencies 键集锁死——任务书验收 2）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_PROTOCOL_VERSION } from "@zhushanwen/subagent-engine-sdk";

import { listPiModels, resolvePiAgentDir, validatePiModel } from "../engine-query.ts";
import { EngineProtocolServer } from "../server.ts";

// ── fixture 基建 ──

let fixtureDir: string | undefined;

function writeFixture(relative: string, content: unknown | string): void {
  if (fixtureDir === undefined) fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-engine-query-"));
  fs.writeFileSync(path.join(fixtureDir, relative), typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/** 恒定 fixture 目录（无 fixture 写入时也返回一个空目录，防读真实系统 pi 目录）。 */
function fixtureDirOrAbsent(): string {
  if (fixtureDir === undefined) fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-engine-query-"));
  return fixtureDir;
}

afterEach(() => {
  if (fixtureDir !== undefined) {
    fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    fixtureDir = undefined;
  }
});

const MODELS_JSON = {
  providers: {
    "prov-a": {
      name: "Provider A",
      models: [
        { id: "m1", name: "Model One" },
        { id: "m2" },
      ],
    },
    "prov-b": {
      name: "Provider B (no credential)",
      models: [{ id: "b1", name: "B One" }],
    },
  },
};

const AUTH_JSON = {
  "prov-a": { type: "api_key", key: "sk-test" },
};

type ResponseFrame = {
  id?: number | string;
  result?: unknown;
  error?: { code: string; message: string; recovery: string };
};

/** 轮询等待断言条件。 */
async function pollUntil<T>(pred: () => T | null | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = pred();
    if (hit !== null && hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error("condition not observed in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 查询面请求往返：注入帧收集 sink 的 server + 一问一答。 */
async function queryServer(method: string, params?: unknown): Promise<ResponseFrame> {
  const frames: ResponseFrame[] = [];
  const server = new EngineProtocolServer({
    write: (f) => frames.push(f as ResponseFrame),
    piAgentDir: fixtureDirOrAbsent(),
  });
  server.handleFrame({ id: 1, method, ...(params === undefined ? {} : { params }) });
  return pollUntil(() => frames.find((f) => f.id === 1 && (f.result !== undefined || f.error !== undefined)));
}

// ── resolvePiAgentDir ──

describe("resolvePiAgentDir", () => {
  it("env PI_CODING_AGENT_DIR 优先（对齐 pi 上游 getAgentDir 惯例）", () => {
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "/data/root/agent" })).toBe("/data/root/agent");
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "  /spaced/agent  " })).toBe("/spaced/agent");
  });

  it("env 缺省 → 系统独立 pi 目录（os.homedir() 动态推导，不硬编码）", () => {
    expect(resolvePiAgentDir({})).toBe(path.join(os.homedir(), ".pi", "agent"));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "   " })).toBe(path.join(os.homedir(), ".pi", "agent"));
  });
});

// ── listPiModels ──

describe("listPiModels", () => {
  it("两数据文件都缺 → null（无枚举面语义，RemoteEngine 消费契约对偶）", () => {
    expect(listPiModels(fixtureDirOrAbsent())).toBeNull();
  });

  it("返回 pi 数据目录内容：凭据 provider 全 ref 清单 + 显示名", () => {
    writeFixture("models.json", MODELS_JSON);
    writeFixture("auth.json", AUTH_JSON);
    expect(listPiModels(fixtureDir!)).toEqual([
      { id: "prov-a/m1", name: "Model One" },
      { id: "prov-a/m2" },
    ]);
  });

  it("无凭据 provider 被过滤；全部无凭据 → []（有配置面无凭据模型语义）", () => {
    writeFixture("models.json", MODELS_JSON);
    writeFixture("auth.json", {});
    expect(listPiModels(fixtureDir!)).toEqual([]);
  });

  it("models-store.json 动态条目覆盖同 id 基线（pi mergeModels 语义）并补新条目", () => {
    writeFixture("models.json", MODELS_JSON);
    writeFixture("auth.json", AUTH_JSON);
    writeFixture("models-store.json", {
      "prov-a": {
        checkedAt: 1,
        models: [
          { id: "m1", name: "Model One (refreshed)" },
          { id: "m3", name: "Model Three" },
        ],
      },
    });
    expect(listPiModels(fixtureDir!)).toEqual([
      { id: "prov-a/m1", name: "Model One (refreshed)" },
      { id: "prov-a/m2" },
      { id: "prov-a/m3", name: "Model Three" },
    ]);
  });

  it("models.json 坏 JSON → 该源降级（warn），store 源仍可用（凭据 provider 照常过滤）", () => {
    writeFixture("models.json", "{ not valid json");
    writeFixture("models-store.json", {
      "prov-c": { models: [{ id: "c1" }] },
      "prov-d": { models: [{ id: "d1" }] },
    });
    writeFixture("auth.json", { "prov-c": { type: "api_key" } });
    expect(listPiModels(fixtureDir!)).toEqual([{ id: "prov-c/c1" }]);
  });

  it("条目 id 缺失/非串 → 丢弃该条目（unknown + 运行时 guard，不炸整清单）", () => {
    writeFixture("models.json", {
      providers: {
        "prov-a": {
          models: [{ id: "ok" }, { name: "no id" }, "not-an-object", null],
        },
      },
    });
    writeFixture("auth.json", AUTH_JSON);
    expect(listPiModels(fixtureDir!)).toEqual([{ id: "prov-a/ok" }]);
  });
});

// ── validatePiModel ──

describe("validatePiModel", () => {
  it("缺席 ref → settings.json defaultProvider+defaultModel 拼全 ref", () => {
    writeFixture("settings.json", { defaultProvider: "prov-a", defaultModel: "m1" });
    expect(validatePiModel(undefined, fixtureDir!)).toEqual({ canonicalRef: "prov-a/m1" });
    expect(validatePiModel("   ", fixtureDir!)).toEqual({ canonicalRef: "prov-a/m1" });
  });

  it("缺席 ref 且仅 defaultModel 有值 → 原样（可能为已含 provider 的全 ref 形态）", () => {
    writeFixture("settings.json", { defaultModel: "solo-model" });
    expect(validatePiModel(undefined, fixtureDir!)).toEqual({ canonicalRef: "solo-model" });
  });

  it("缺席 ref 且 settings 未声明缺省 → engine_model_unknown（pi 无静态缺省形态）", () => {
    writeFixture("settings.json", { packages: [] });
    try {
      validatePiModel(undefined, fixtureDir!);
      expect.unreachable("expected EngineSdkError");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("engine_model_unknown");
      expect((err as { recovery?: string }).recovery).toContain("pi /model");
    }
  });

  it("有值 ref 清单全等命中 → canonicalRef = 全 ref；未命中 → engine_model_unknown", () => {
    writeFixture("models.json", MODELS_JSON);
    writeFixture("auth.json", AUTH_JSON);
    expect(validatePiModel("prov-a/m1", fixtureDir!)).toEqual({ canonicalRef: "prov-a/m1" });
    try {
      validatePiModel("prov-a/m1-latest", fixtureDir!);
      expect.unreachable("expected EngineSdkError");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("engine_model_unknown");
      expect((err as Error).message).toContain("prov-a/m1-latest");
      expect((err as { recovery?: string }).recovery).toContain("listModels");
    }
  });
});

// ── server.ts 分发位接线（pi-workflow-run-resource-model §3.3 决策 11） ──

describe("EngineProtocolServer 查询面接线（分发位路由 engine-query）", () => {
  it("listModels 请求 → fixture 数据目录内容；initialize 应答 models 同源（投影仅 id）", async () => {
    writeFixture("models.json", MODELS_JSON);
    writeFixture("auth.json", AUTH_JSON);
    const frames: ResponseFrame[] = [];
    const server = new EngineProtocolServer({
      write: (f) => frames.push(f as ResponseFrame),
      piAgentDir: fixtureDirOrAbsent(),
    });
    server.handleFrame({ id: 7, method: "listModels" });
    const listResp = await pollUntil(() => frames.find((f) => f.id === 7));
    expect(listResp.result).toEqual({
      models: [{ id: "prov-a/m1", name: "Model One" }, { id: "prov-a/m2" }],
    });

    server.handleFrame({
      id: 8,
      method: "initialize",
      params: {
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        hostInfo: { name: "t", version: "0", dataRoot: "/d" },
        engineConfig: {},
      },
    });
    const initResp = await pollUntil(() => frames.find((f) => f.id === 8));
    expect((initResp.result as { models?: unknown }).models).toEqual([{ id: "prov-a/m1" }, { id: "prov-a/m2" }]);
  });

  it("validateModel 未命中 → error 帧 engine_model_unknown（结构化错误不断链）", async () => {
    const frames: ResponseFrame[] = [];
    const server = new EngineProtocolServer({
      write: (f) => frames.push(f as ResponseFrame),
      piAgentDir: fixtureDirOrAbsent(),
    });
    server.handleFrame({ id: 9, method: "validateModel", params: { modelRef: "nope/none" } });
    const resp = await pollUntil(() => frames.find((f) => f.id === 9));
    expect(resp.error?.code).toBe("engine_model_unknown");
  });

  it("两数据文件都缺的 agentDir → listModels 应答 {models: null}（无枚举面）", async () => {
    const resp = await queryServer("listModels");
    expect(resp.result).toEqual({ models: null });
  });
});

// ── 零新依赖红线（任务书验收 2） ──

describe("pi-subagent-cli 零新依赖", () => {
  it("package.json dependencies 键集 = 既有两依赖（查询面零新依赖红线）", () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@zhushanwen/pi-rpc",
      "@zhushanwen/subagent-engine-sdk",
    ]);
  });
});

// zcode-engine-harness.ts —— zcode-engine 集成测试的共享夹具（拆分产物共用基础设施）。
//
// 为什么独立成模块：zcode-engine.test.ts 曾单文件承载 61 例（~11s 用例时间）——它是
// zcode-subagent-cli 整包墙钟的临界路径（单文件串行，并行度对该包无效）。按主题拆成
// 四个文件后，各文件独立成为并行调度单元；夹具（tmp 根 / fake-appserver 场景注入 /
// 引擎登记与 teardown / 流水读取）必须单源，否则四份副本漂移即双轨。
//
// 纪律（与本包 agent-event-invariants.ts 同）：本模块不含用例，只出夹具与断言素材；
// 用例体与 describe 名留在各自 *.test.ts。
//
// 全部用例跑 __fixtures__/fake-appserver.mjs 子进程（scenario 注入），绝不 spawn 真
// zcode.cjs。每测试独立 tmp 根 + 独立 state/scenario 文件（进程内状态不跨用例）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, vi } from "vitest";

import type { AgentCallOpts, RunContext } from "../port-types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

// ── 共享常量 ──

export const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
export const PROVIDER = "test-provider";
export const GOLDEN_SESSION_ID = "sess_golden_r3_01";
export const GOLDEN_FULL_TEXT = "你好，任务完成";
/** 挂起场景：send 后零推送——turn 无事件无终态（dispose 收割 / crash 收割的形态前提）。 */
export const HANG_PUSHES: string[] = [];

// ── 每用例 tmp 夹具状态（beforeEach 重建；只经下方访问器读取） ──

const engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot = "";
let dataDir = "";
let v2Path = "";
let personalPath = "";

/** 注册共享顶层 hook：调用一次/文件（在文件顶层调用）。 */
export function registerZcodeEngineHarness(): void {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-engine-"));
    dataDir = path.join(tmpRoot, "data");
    v2Path = path.join(tmpRoot, "v2.json");
    personalPath = path.join(tmpRoot, "personal.json");
    writeJson(v2Path, {
      provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
    });
    writeJson(personalPath, {
      config: {
        providerOrder: [PROVIDER],
        providerConfigRules: {
          providerRules: [
            { providerId: PROVIDER, providerName: "t", config: { access: { type: "api-key", apiKey: "k" }, personalModelIds: ["m1"] } },
          ],
        },
      },
    });
  });

  afterEach(async () => {
    // 先收割残留引擎、再复原 env stub：engine.dispose() 的 HARVEST_GRACE 兜底窗同样
    // 走注入缝（用例体注入的短窗必须在 teardown 期仍有效，否则每个残留引擎回落到
    // 默认 1000ms 等待——时间会被记到用例头上）。
    for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
    vi.unstubAllEnvs(); // abort grace / harvest grace 注入缝等 env stub 逐用例复原（不泄漏到同文件后续用例）
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
}

export function tmpRootDir(): string {
  return tmpRoot;
}

export function dataDirPath(): string {
  return dataDir;
}

export function v2ConfigPath(): string {
  return v2Path;
}

export function personalProviderConfigPath(): string {
  return personalPath;
}

/** 引擎登记（teardown 统一 dispose——用例体不重复写清理）。 */
export function trackEngine(engine: ZcodeEngine): void {
  engines.push(engine);
}

/** 每测试独立的 state/scenario/workspace 三件套（seq 文件级递增，互不覆盖）。 */
export function nextFixtureSlot(): { stateFile: string; scenarioFile: string; workspace: string } {
  seq += 1;
  return {
    stateFile: path.join(tmpRoot, `state-${seq}.jsonl`),
    scenarioFile: path.join(tmpRoot, `scenario-${seq}.json`),
    workspace: path.join(tmpRoot, `ws-${seq}`),
  };
}

// ── 流水（state jsonl）读取与断言素材 ──

export function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

export interface StateEvent { // oe-exempt:20261026:test:测试事件序列形态（合并产物内局部类型，非对外契约）
  seq: number;
  ev: string;
  [key: string]: unknown;
}

export function readState(file: string): StateEvent[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StateEvent);
  } catch {
    return [];
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sentFrames(stateFile: string, method: string): Array<{ id: number; params: Record<string, unknown> }> {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter(
      (f): f is { id: number; params: Record<string, unknown> } =>
        isRecord(f) && f.method === method && isRecord(f.params) && typeof f.id === "number",
    );
}

export function sentMethods(stateFile: string): string[] {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.method === "string")
    .map((f) => f.method as string);
}

export function bootCount(stateFile: string): number {
  return readState(stateFile).filter((e) => e.ev === "boot").length;
}

// ── 任务 / 上下文素材 ──

export function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

export function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-appserver", ...overrides };
}

// ── fake-appserver 场景注入（引擎构造） ──

export interface RpcErrorSpec {  // oe-exempt:20261027:test:
  code: number;
  message: string;
  data?: unknown;
}

export interface EngineHandle_ {  // oe-exempt:20261027:test:
  engine: ZcodeEngine;
  stateFile: string;
  workspace: string;
}

export interface ScenarioOverrides {  // oe-exempt:20261027:test:
  dropTurnTerminal?: boolean;
  replaceSendPushes?: string[];
  createError?: RpcErrorSpec;
  /** send 应答 error 帧（运行中失败注入——-32004 会话 id 留痕用例）。 */
  sendError?: RpcErrorSpec;
  stopBehavior?: "terminal" | "none";
  stampSession?: boolean;
  /** 覆盖 read 应答（read 是全文权威来源——schema 用例须与收尾帧一致）。 */
  readResult?: unknown;
  /** 多会话用例：不覆盖 createResult/readResult（fake 缺省每会话独立 sess_<id> + read {messages:[]}）。 */
  distinctSessionIds?: boolean;
  /** 内建目录源覆盖（缺省 absent 文件——reasoningLevel 值域解析降级为不携带）。 */
  builtinCatalogPath?: string;
}

/** 建一个连到 fake 的引擎（scenario 文件随 env 固化进子进程；每测试独立 state 文件）。 */
export function makeEngine(overrides: ScenarioOverrides = {}): EngineHandle_ {
  const slot = nextFixtureSlot();
  const pushes = (
    overrides.replaceSendPushes ?? [
      ...ZCODE_APPSERVER_GOLDEN.pushStream,
      ...(overrides.dropTurnTerminal ? [] : [ZCODE_APPSERVER_GOLDEN.terminal[0]]),
      ZCODE_APPSERVER_GOLDEN.terminal[1],
    ]
  ).map((l) => (typeof l === "string" ? (JSON.parse(l) as Record<string, unknown>) : l));
  writeJson(slot.scenarioFile, {
    ...(overrides.distinctSessionIds === true
      ? {}
      : {
          createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
          readResult: overrides.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
        }),
    sendPushes: pushes,
    ...(overrides.stopBehavior !== undefined ? { stopBehavior: overrides.stopBehavior } : {}),
    ...(overrides.createError !== undefined ? { createError: overrides.createError } : {}),
    ...(overrides.sendError !== undefined ? { sendError: overrides.sendError } : {}),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: {
      v2ConfigPath: v2Path,
      personalProviderConfigPath: personalPath,
      builtinCatalogPath: overrides.builtinCatalogPath ?? path.join(tmpRoot, "absent-catalog.json"),
    },
    processEnv: {
      PATH: process.env.PATH ?? "",
      HOME: "/fake-host-home",
      FAKE_STATE_FILE: slot.stateFile,
      FAKE_SESSION_SCENARIO: slot.scenarioFile,
      ...(overrides.stampSession === true ? { FAKE_STAMP_SESSION: "1" } : {}),
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile: slot.stateFile, workspace: slot.workspace };
}

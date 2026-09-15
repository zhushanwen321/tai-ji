// zcode-engine-degrade.test.ts —— appserver 错误分类回归门（降级链已删，仅存本主题）。
// 2026-09 单一 app-server 形态重构删除了整条降级机制：CLI spawn 降级重跑、probe 冒烟
// 门控、模式钉扎 env 三态均不复存在——协议漂移类错误直接上报可操作错误，不再换通道
// 保底。原「首败漂移降级」「probe 冒烟」「env 三态」describe 随机制删除，本文件仅存
// 错误规格表回归门：
//   - -32603 "Model config is missing" → engine_credential_missing（共享宿主 HOME——
//     凭据在 ZCode 桌面端管理），不换路径（第二任务仍走 app-server，create 帧计数增长）；
//   - -32004 / -32010 → engine_run_failed 按任务失败上报（非漂移类，无 fallback 标注）。
// 全部跑 __fixtures__/fake-appserver.mjs 子进程（scenario 注入），绝不 spawn 真 zcode.cjs。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunContext } from "../port-types.ts";
import type { AgentCallOpts } from "../port-types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-degrade-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface ErrorScenario {
  /** 主连接（常驻）scenario 覆盖：create/send 阶段错误注入。 */
  createError?: { code: number; message: string; data?: unknown };
  sendError?: { code: number; message: string; data?: unknown };
}

/** 建一个连到 fake 的引擎（scenario 文件随 env 固化进子进程；每测试独立 state 文件）。 */
function makeEngine(s: ErrorScenario = {}) {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  const pushes = [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal].map((l) =>
    typeof l === "string" ? (JSON.parse(l) as Record<string, unknown>) : l,
  );
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: pushes,
    ...(s.createError !== undefined ? { createError: s.createError } : {}),
    ...(s.sendError !== undefined ? { sendError: s.sendError } : {}),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, workspace };
}

// ── 流水读取 helpers（与 zcode-engine-appserver.test.ts 同款） ──

interface StateEvent {
  seq: number;
  ev: string;
  [key: string]: unknown;
}

function readState(file: string): StateEvent[] {
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function recvFrames(stateFile: string, method: string): Array<{ id: number; params: Record<string, unknown> }> {
  return readState(stateFile)
    .filter((e) => e.ev === "recv")
    .map((e) => e.frame)
    .filter(
      (f): f is { id: number; params: Record<string, unknown> } =>
        isRecord(f) && f.method === method && isRecord(f.params) && typeof f.id === "number",
    );
}

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-degrade", ...overrides };
}

// ============================================================
// 错误分类表（非漂移类：-32603 / -32004 / -32010 不降级）
// ============================================================

describe("错误分类（错误规格表）", () => {
  it("-32603 'Model config is missing' → engine_credential_missing，不降级（第二任务仍走 app-server）", async () => {
    const { engine, stateFile, workspace } = makeEngine({
      createError: { code: -32603, message: "Model config is missing" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_credential_missing");
    expect(r1.outcome.engineFallback).toBeUndefined();
    const createsBefore = recvFrames(stateFile, "session/create").length;
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r2.outcome.error).toContain("engine_credential_missing");
    expect(recvFrames(stateFile, "session/create").length).toBeGreaterThan(createsBefore);
  }, 20_000);

  it("-32004 'Session is not active' → 任务失败上报，不降级", async () => {
    const { engine, workspace } = makeEngine({
      createError: { code: -32004, message: "Session is not active" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32004");
    expect(r1.outcome.engineFallback).toBeUndefined();
  }, 20_000);

  it("-32010（send busy）→ 任务失败上报，不降级", async () => {
    const { engine, workspace } = makeEngine({
      sendError: { code: -32010, message: "A turn is already running" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32010");
    expect(r1.outcome.engineFallback).toBeUndefined();
  }, 20_000);
});

// engine-discovery.test.ts —— [U7] registry → engines.json 同步（幂等/原子/兜底）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// core logger 桩：断言发现/IO 失败路径的 warn 留痕（控制流仍 fail-safe 不抛）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import type { SubagentEnginesFile } from "@zhushanwen/extension-protocol";

import { getEnginesFilePath, syncEnginesFile, type SyncEnginesFileOptions } from "../engine-discovery.ts";
import type { EnginePort } from "../port.ts";
import { clearEngines, registerEngine } from "../registry.ts";

/** 密闭发现注入（env:{} 斩 L1 env 根，nodeModuleRoots:[] 斩 L2 宿主 node_modules）——
 * 防宿主环境（打包态 TAIJI_AGENT_ENGINE_ROOTS / workspace 链接的引擎包）污染注册表。 */
const HERMETIC_DISCOVERY: SyncEnginesFileOptions = { env: {}, nodeModuleRoots: [] };

function stubEngine(id: string): EnginePort {
  return {
    id,
    capabilities: () => ({
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
    }),
    probe: async () => ({ ok: true, engineVersion: "test", checks: [] }),
    run: async () => {
      throw new Error("unused");
    },
    read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
  };
}

let tmpRoot: string;
let agentDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-discovery-"));
  agentDir = path.join(tmpRoot, "agent");
  clearEngines();
  loggerMock.warn.mockClear();
});

afterEach(() => {
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("syncEnginesFile", () => {
  it("注册表引擎列表落盘（v=1 + 注册序）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    registerEngine("zcode", () => stubEngine("zcode"));
    syncEnginesFile(agentDir, HERMETIC_DISCOVERY);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.v).toBe(1);
    expect(file.engines).toEqual(["pi", "zcode"]);
    expect(typeof file.updatedAt).toBe("number");
  });

  it("幂等：引擎清单未变时第二次零写（mtime 不动）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    syncEnginesFile(agentDir, HERMETIC_DISCOVERY);
    const p = getEnginesFilePath(agentDir);
    const statAfterFirst = fs.statSync(p);
    syncEnginesFile(agentDir, HERMETIC_DISCOVERY);
    expect(fs.statSync(p).mtimeMs).toBe(statAfterFirst.mtimeMs);
  });

  it("新增引擎注册后内容变化触发重写", () => {
    registerEngine("pi", () => stubEngine("pi"));
    syncEnginesFile(agentDir, HERMETIC_DISCOVERY);
    registerEngine("acp", () => stubEngine("acp"));
    syncEnginesFile(agentDir, HERMETIC_DISCOVERY);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.engines).toEqual(["pi", "acp"]);
  });

  it("现文件损坏（torn write 形态）时重建", () => {
    registerEngine("pi", () => stubEngine("pi"));
    const p = getEnginesFilePath(agentDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ torn", "utf8");
    syncEnginesFile(agentDir, HERMETIC_DISCOVERY);
    expect(() => JSON.parse(fs.readFileSync(p, "utf8"))).not.toThrow();
  });

  it("agentDir 不存在时建目录写入；IO 异常吞掉不抛（fail-safe）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    expect(() => syncEnginesFile(agentDir, HERMETIC_DISCOVERY)).not.toThrow();
    expect(fs.existsSync(getEnginesFilePath(agentDir))).toBe(true);
  });

  it("IO 失败 → 控制流不变（不抛）+ warn 留痕（含路径与「旧清单仍在用」后果）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    // 落盘目标不可达：agentDir 位置是普通文件 → 其下 subagents/ 目录无法创建，写必失败
    const blockedDir = path.join(tmpRoot, "blocked");
    fs.writeFileSync(blockedDir, "not a directory", "utf8");

    expect(() => syncEnginesFile(blockedDir, HERMETIC_DISCOVERY)).not.toThrow();

    const messages = loggerMock.warn.mock.calls.map((c) => String(c[0]));
    const syncWarn = messages.find((m) => m.includes("[engine-discovery] engines.json sync failed"));
    expect(syncWarn).toBeDefined();
    expect(syncWarn).toContain("the previous engine list stays in use");
    expect(syncWarn).toContain(getEnginesFilePath(blockedDir));
  });
});

// engine-discovery.test.ts —— [U7] registry → engines.json 同步（幂等/原子/兜底）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SubagentEnginesFile } from "@xyz-agent/extension-protocol";

import { getEnginesFilePath, syncEnginesFile } from "../engine-discovery.ts";
import type { EnginePort } from "../port.ts";
import { clearEngines, registerEngine } from "../registry.ts";

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
});

afterEach(() => {
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("syncEnginesFile", () => {
  it("注册表引擎列表落盘（v=1 + 注册序）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    registerEngine("zcode", () => stubEngine("zcode"));
    syncEnginesFile(agentDir);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.v).toBe(1);
    expect(file.engines).toEqual(["pi", "zcode"]);
    expect(typeof file.updatedAt).toBe("number");
  });

  it("幂等：引擎清单未变时第二次零写（mtime 不动）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    syncEnginesFile(agentDir);
    const p = getEnginesFilePath(agentDir);
    const statAfterFirst = fs.statSync(p);
    syncEnginesFile(agentDir);
    expect(fs.statSync(p).mtimeMs).toBe(statAfterFirst.mtimeMs);
  });

  it("新增引擎注册后内容变化触发重写", () => {
    registerEngine("pi", () => stubEngine("pi"));
    syncEnginesFile(agentDir);
    registerEngine("acp", () => stubEngine("acp"));
    syncEnginesFile(agentDir);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.engines).toEqual(["pi", "acp"]);
  });

  it("现文件损坏（torn write 形态）时重建", () => {
    registerEngine("pi", () => stubEngine("pi"));
    const p = getEnginesFilePath(agentDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ torn", "utf8");
    syncEnginesFile(agentDir);
    expect(() => JSON.parse(fs.readFileSync(p, "utf8"))).not.toThrow();
  });

  it("agentDir 不存在时建目录写入；IO 异常吞掉不抛（fail-safe）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    expect(() => syncEnginesFile(agentDir)).not.toThrow();
    expect(fs.existsSync(getEnginesFilePath(agentDir))).toBe(true);
  });
});

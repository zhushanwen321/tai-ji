// engines-declaration.test.ts —— [W4] 引擎清单投影守护（原 U7b「package.json 静态
// 声明双源一致」职责随协议化 H5 单源化消亡：引擎清单唯一来源 = 引擎包 manifest
// 自注册 + 三级发现器，扩展包 package.json 的 xyz-agent.subagentEngines 声明不再被
// runtime 冷启动回退消费，静态声明面已废弃）。
//
// 现守护 = 投影合流契约（设计 §3.4 投影面表 / impl-plan §2.4）：
//   syncEnginesFile 投影清单 = 组合根注册的引擎（inproc 过渡注册）∪ 三级发现装载的
//   引擎包（L1 env 根 fixture 注入）；契约 {v:1, engines: string[]} 不变；发现卸载
//   （包消失）→ 下次扫描自动从清单消失（清理通道）。
// 新增引擎时无需改本测试（G1 零枚举）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetCoreForTests } from "@zhushanwen/subagent-core/core/host-services.ts";
import type { EnginePort } from "@zhushanwen/subagent-core/execution/engine/port.ts";
import {
  clearEngines,
  registerEngine,
} from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { getEnginesFilePath, syncEnginesFile } from "@zhushanwen/subagent-core/execution/engine/engine-discovery.ts";

const ENGINE_ROOTS_ENV = "XYZ_AGENT_ENGINE_ROOTS";
const BIN_CONTENT = "#!/bin/sh\nexit 0\n";

// fixture 引擎包（fake「foo-subagent-cli」：只装包 + manifest，A4 最小形态）
function makeEnginePkg(rootDir: string, id: string): void {
  const pkgDir = path.join(rootDir, `${id}-subagent-cli`);
  fs.mkdirSync(pkgDir, { recursive: true });
  const binRel = "./dist/cli.mjs";
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: `@test/${id}-subagent-cli`,
      bin: { [`${id}-subagent-cli`]: binRel },
      "xyz-agent": {
        subagentEngine: {
          id,
          bin: `${id}-subagent-cli`,
          protocol: 1,
          capabilities: {
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
          },
        },
      },
    }),
  );
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, binRel), BIN_CONTENT);
  fs.chmodSync(path.join(pkgDir, binRel), 0o755);
}

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
let prevEnvRoots: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "engines-decl-"));
  agentDir = path.join(tmpRoot, "agent");
  prevEnvRoots = process.env[ENGINE_ROOTS_ENV];
  process.env[ENGINE_ROOTS_ENV] = path.join(tmpRoot, "engine-roots");
  clearEngines();
});

afterEach(() => {
  if (prevEnvRoots === undefined) delete process.env[ENGINE_ROOTS_ENV];
  else process.env[ENGINE_ROOTS_ENV] = prevEnvRoots;
  resetCoreForTests();
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("引擎清单投影合流（W4：发现器装载 ∪ 组合根注册 → engines.json）", () => {
  it("组合根注册引擎 + 发现的引擎包合流入投影（契约 {v:1, engines} 不变）", async () => {
    // 组合根注册点（registerPiEngine/registerZcodeEngine 的 inproc 形态；工厂体同款
    // registerEngine 调用——不 import 引擎内部，用 stub 等价注册面）
    registerEngine("pi", () => stubEngine("pi"));
    registerEngine("zcode", () => stubEngine("zcode"));
    // L1 env 根下的第三方引擎包（A4 最小形态：只装包 + manifest）
    makeEnginePkg(path.join(tmpRoot, "engine-roots"), "foo");

    syncEnginesFile(agentDir);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.v).toBe(1);
    expect(file.engines.sort()).toEqual(["foo", "pi", "zcode"]);
  });

  it("投影幂等零写；引擎包卸载 → 下次扫描自动从清单消失（清理通道）", async () => {
    registerEngine("pi", () => stubEngine("pi"));
    makeEnginePkg(path.join(tmpRoot, "engine-roots"), "gone-later");

    syncEnginesFile(agentDir);
    const filePath = getEnginesFilePath(agentDir);
    const statAfterFirst = fs.statSync(filePath);
    syncEnginesFile(agentDir);
    expect(fs.statSync(filePath).mtimeMs).toBe(statAfterFirst.mtimeMs);

    // 包目录移除（引擎卸载）→ 清单收缩，零改 core
    fs.rmSync(path.join(tmpRoot, "engine-roots", "gone-later-subagent-cli"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    syncEnginesFile(agentDir);
    const file = JSON.parse(fs.readFileSync(filePath, "utf8")) as SubagentEnginesFile;
    expect(file.engines).toEqual(["pi"]);
  });
});

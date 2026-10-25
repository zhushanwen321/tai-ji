// pi 引擎托管 agent 目录注入链测试（登记 docs/todo/engine-default-provider-setting.md
// 「新发现登记」节，2026-10-23 裁决：taiji 派发的 pi 参数一切由 taiji 控制——pi 引擎
// 配置目录注入 <dataDir>/agent，独立 pi CLI 直跑回落 ~/.pi/agent 不受影响）。
//
// 三层断言（每层用该层的自然观测点）：
//   ① 注入决策纯函数（piHostedAgentDirIdentityEnv）：pi → PI_CODING_AGENT_DIR =
//      <dataDir>/agent；非 pi 引擎 → undefined（PI_ 域无消费方不出站）；
//   ② 发现构造链（inspectEnginePackage → portFactory → EngineClient opts.identityEnv）：
//      pi manifest 包装载即带注入键，值随 env TAIJI_AGENT_DATA_DIR 动态推导；
//      非 pi 引擎（zcode）不注入；
//   ③ spawn env 层（LocalEngineTransport 进程端点桩）：identityEnv 经
//      buildEngineChildEnv L0 最后写入落到引擎进程 env；baseEnv 携带 ambient 陈旧值
//      （用户 shell 穿透形态）时权威注入覆盖（L0 > 基座继承）。
//
// pi 侧消费链（resolvePiAgentDir env 优先 / 缺省回落 ~/.pi/agent）由
// pi-subagent-cli __tests__/engine-query.test.ts 覆盖；消费语义锚点 = pi 1.0.0
// node_modules dist/config.js getAgentDir()（env PI_CODING_AGENT_DIR 优先）。

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectEnginePackage, piHostedAgentDirIdentityEnv } from "../engine-inspect-package.ts";
import type { EnginePort } from "../port.ts";
import type { EngineClientOptions } from "../client/client-options.ts";
import { LocalEngineTransport } from "../client/transport/local.ts";
import type { EngineLaunchSpec } from "../client/transport/types.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-inject-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 在 tmpRoot 下造一个带 manifest 的引擎包（bin 可执行；发现器只做 X_OK 探测不执行）。 */
function makeEnginePkg(pkgDirName: string, manifest: Record<string, unknown> = {}): string {
  const pkgDir = path.join(tmpRoot, pkgDirName);
  fs.mkdirSync(pkgDir, { recursive: true });
  const binRel = "./bin/cli.mjs";
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: `test-${pkgDirName}`,
      bin: { "test-engine-cli": binRel },
      taiji: { subagentEngine: { id: pkgDirName, bin: "test-engine-cli", protocol: 1, ...manifest } },
    }),
  );
  const binPath = path.join(pkgDir, binRel);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(binPath, 0o755);
  return pkgDir;
}

/** portFactory 产物（RemoteEngine）内嵌 EngineClient 构造参数读取口（②层形态断言专用）。 */
function engineClientOptsOf(engine: EnginePort): EngineClientOptions {
  const remote = engine as unknown as { opts: { client: { opts: EngineClientOptions } } };
  return remote.opts.client.opts;
}

/** 进程端点桩：只实现 open/wireChild 消费的 ChildProcess 面（pid 取不可达高位）。 */
class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  kill(): boolean {
    return true;
  }
}

/** 装配捕获 spawn env 的 transport（③层：identityEnv → buildEngineChildEnv → spawn env）。 */
function makeSpawnCapturingTransport(params: {
  dataDir: string;
  identityEnv?: Record<string, string | undefined>;
  baseEnv?: Record<string, string | undefined>;
}): { transport: LocalEngineTransport; spawnedEnv: () => Record<string, string> | undefined } {
  let captured: Record<string, string> | undefined;
  const child = new FakeChildProcess(999_999_999);
  const transport = new LocalEngineTransport({
    engineId: "pi",
    dataDir: params.dataDir,
    hostKind: "test",
    baseEnv: params.baseEnv,
    identityEnv: params.identityEnv,
    engineCmdlineMatcher: () => false,
    spawnChildProcess: (_command: string, _args: readonly string[], options: SpawnOptions) => {
      captured = options.env as Record<string, string>;
      return child as unknown as ChildProcess;
    },
  });
  return { transport, spawnedEnv: () => captured };
}

function makeSpec(cwd: string): EngineLaunchSpec {
  return {
    engineId: "pi",
    entryPath: process.execPath,
    args: [],
    cwd,
    envPrefixes: [],
    rootSessionId: "",
  };
}

// ── ① 注入决策 ────────────────────────────────────────────────

describe("piHostedAgentDirIdentityEnv（注入决策）", () => {
  it("pi 引擎 → PI_CODING_AGENT_DIR = <dataDir>/agent（动态拼接，非写死路径）", () => {
    expect(piHostedAgentDirIdentityEnv("pi", path.join(tmpRoot, "data"))).toEqual({
      PI_CODING_AGENT_DIR: path.join(tmpRoot, "data", "agent"),
    });
  });

  it("非 pi 引擎（zcode / 第三方）→ undefined（PI_ 域无消费方不出站）", () => {
    expect(piHostedAgentDirIdentityEnv("zcode", tmpRoot)).toBeUndefined();
    expect(piHostedAgentDirIdentityEnv("acme", tmpRoot)).toBeUndefined();
  });
});

// ── ② 发现构造链（两派发形态共用：runtime 派发与 pi 会话内 extension 派发同管线）──

describe("inspectEnginePackage → EngineClient identityEnv 接线", () => {
  it("pi manifest 包：portFactory 构造的 EngineClient 带注入键，值随 TAIJI_AGENT_DATA_DIR 动态推导", () => {
    const pkgDir = makeEnginePkg("pi", { envPrefixes: ["PI_"] });
    const dataRoot = path.join(tmpRoot, "host-data");
    const inspection = inspectEnginePackage(pkgDir, "test", "test", {
      TAIJI_AGENT_DATA_DIR: dataRoot,
    });
    expect(inspection.status).toBe("ok");
    if (inspection.status !== "ok") return;

    const opts = engineClientOptsOf(inspection.entry.descriptor.portFactory());
    expect(opts.identityEnv).toEqual({ PI_CODING_AGENT_DIR: path.join(dataRoot, "agent") });
  });

  it("非 pi 引擎包（zcode）：identityEnv 不注入（undefined）", () => {
    const pkgDir = makeEnginePkg("zcode");
    const inspection = inspectEnginePackage(pkgDir, "test", "test", {
      TAIJI_AGENT_DATA_DIR: tmpRoot,
    });
    expect(inspection.status).toBe("ok");
    if (inspection.status !== "ok") return;

    const opts = engineClientOptsOf(inspection.entry.descriptor.portFactory());
    expect(opts.identityEnv).toBeUndefined();
  });
});

// ── ③ spawn env 层（引擎进程实际收到的 env）───────────────────

describe("identityEnv 经 buildEngineChildEnv L0 落到引擎进程 env", () => {
  it("open 后引擎进程 env 含 PI_CODING_AGENT_DIR=<dataDir>/agent", async () => {
    const dataRoot = path.join(tmpRoot, "spawn-data");
    const { transport, spawnedEnv } = makeSpawnCapturingTransport({
      dataDir: dataRoot,
      identityEnv: piHostedAgentDirIdentityEnv("pi", dataRoot),
    });
    await transport.open(makeSpec(dataRoot));
    expect(spawnedEnv()?.["PI_CODING_AGENT_DIR"]).toBe(path.join(dataRoot, "agent"));
  });

  it("baseEnv 携带 ambient 陈旧值（用户 shell 穿透形态）→ L0 权威注入覆盖", async () => {
    const dataRoot = path.join(tmpRoot, "spawn-data-stale");
    const { transport, spawnedEnv } = makeSpawnCapturingTransport({
      dataDir: dataRoot,
      identityEnv: piHostedAgentDirIdentityEnv("pi", dataRoot),
      baseEnv: { PI_CODING_AGENT_DIR: path.join(tmpRoot, "ambient-stale-agent") },
    });
    await transport.open(makeSpec(dataRoot));
    expect(spawnedEnv()?.["PI_CODING_AGENT_DIR"]).toBe(path.join(dataRoot, "agent"));
  });
});

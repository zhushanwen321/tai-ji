// zcode-session-db-isolation.test.ts —— 2026-09 会话库隔离的单元守护面（设计权威源：
// docs/architecture/zcode-session-db-isolation.md D1/D2/D3 + §3.3 不变量 1/2/3；impl-plan
// §2.3 W3 规格「单元」行 + 探针④）。池 GC 守卫（A9/不变量 6 的可执行断言）见
// zcode-session-db-pool-gc.test.ts；生产链白名单分支守护见
// engine/__tests__/common/session-view-service-zcode-dbpath.test.ts。
//
// 覆盖：
//   - 路径单一来源（不变量 2）：zcodeSessionDbPath 值独立展开断言（选址在池目录外，
//     D1/F11——shared/ 是 journal 池目录，被 deletePoolNativeState 覆盖）+ allowlist
//     封闭集合形态（[隔离库现役, 宿主库存量兼容]）+ E5（隔离路径 ≠ 宿主路径恒成立）
//   - API 链（EnginePort.read）集合成员判定（D2 第二站点）：allowlist 成员放行
//     （隔离库/宿主库）、集合外绝对路径拒绝①级、误配形态（写侧 dataDir 漂移）拒绝
//     ——与生产链 session-view-service 同判（D2「本设计最易错的一处」的双站点守护）
//   - 两站点 dataDir 相等兜底断言（D2 传播前提）：xyz-agent spawn 配置（env 注入）
//     下写侧 engineDataDir 权威源直取注入值——env 是唯一分叉源，注入即相等
//   - env 注入（探针④，集成）：create 帧后子进程 env 快照含 ZCODE_SESSION_DB_PATH=
//     隔离路径（覆盖宿主继承值，E4）+ 别名键 ZCODE_SESSION_DB 清空 + HOME 正向透传
//     （不变量 1）——env 不随 RPC 帧传输，经 fake-appserver env 快照观测（先例：
//     connection.test.ts「env 惯例」）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../reader.ts", () => ({
  readZcodeSessionView: vi.fn(),
}));

import { readZcodeSessionView } from "../reader.ts";
import { hostZcodeDbPath, zcodeDbPathAllowlist, zcodeSessionDbPath } from "../db-path.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";
import { resolveEngineDataDir, XYZ_DATA_DIR_ENV } from "@zhushanwen/subagent-engine-sdk";
import type { EngineHandle } from "../port-types.ts";

const mockedRead = vi.mocked(readZcodeSessionView);

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

// ============================================================
// 路径单一来源（db-path 契约根，不变量 2）
// ============================================================

describe("路径单一来源（db-path 契约根，不变量 2）", () => {
  it("zcodeSessionDbPath = <engineDataDir>/engines/zcode/session-db/db.sqlite（独立展开断言，选址在池目录外）", () => {
    expect(zcodeSessionDbPath("/data-root")).toBe(
      path.join("/data-root", "engines", "zcode", "session-db", "db.sqlite"),
    );
    // D1/F11：engines/zcode/shared/ 是 journal 池目录（deletePoolNativeState 覆盖面），
    // 隔离库不得落在其下——否则池归零/TTL 清理会删掉会话库
    expect(zcodeSessionDbPath("/data-root").includes(path.join("engines", "zcode", "shared"))).toBe(false);
  });

  it("zcodeDbPathAllowlist = [隔离库（现役）, 宿主库（存量兼容）] 封闭集合，两站点唯一放行来源", () => {
    const dataDir = "/data-root";
    expect(zcodeDbPathAllowlist(dataDir)).toEqual([zcodeSessionDbPath(dataDir), hostZcodeDbPath()]);
    // 封闭性：集合外无第三项
    expect(zcodeDbPathAllowlist(dataDir)).toHaveLength(2);
  });

  it("E5 误配守卫：隔离库路径与宿主库路径恒不等（配置错误在测试期拦截）", () => {
    expect(zcodeSessionDbPath("/data-root")).not.toBe(hostZcodeDbPath());
  });
});

// ============================================================
// API 链集合成员判定（EnginePort.read，D2 第二站点）
// ============================================================

/** conformance read 降级用例同款 handle 构造（data 纯 JSON、自描述）。 */
function makeHandle(sessionRef: Record<string, string>): EngineHandle {
  return {
    data: {
      v: 1,
      engineId: "zcode",
      sessionRef,
      adapterVersion: "1.0.0-test",
    },
  };
}

function nativeView(text: string): Awaited<ReturnType<typeof readZcodeSessionView>> {
  return {
    engineId: "zcode",
    sessionId: "sess-1",
    turns: [{ text, thinking: "", toolCalls: [], closed: true }],
    source: "native",
  };
}

describe("API 链集合成员判定（EnginePort.read，D2 第二站点）", () => {
  let dataDir: string;
  let engine: ZcodeEngine;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-iso-read-"));
    mockedRead.mockReset();
    engine = new ZcodeEngine({ engineDataDir: () => dataDir });
  });

  afterEach(async () => {
    await engine.dispose().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("dbPath = 隔离库（集合第一项，现役写侧）→ reader 收到原样路径，①级命中", async () => {
    mockedRead.mockResolvedValue(nativeView("from isolated db"));
    const view = await engine.read(makeHandle({ sessionId: "sess-1", dbPath: zcodeSessionDbPath(dataDir) }));
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledWith(zcodeSessionDbPath(dataDir), "sess-1");
    expect(view.source).toBe("native");
  });

  it("dbPath = 宿主库（集合第二项，存量兼容锚点）→ 仍放行①级（D3：不迁移、不删除）", async () => {
    mockedRead.mockResolvedValue(nativeView("from host db"));
    const view = await engine.read(makeHandle({ sessionId: "sess-1", dbPath: hostZcodeDbPath() }));
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledWith(hostZcodeDbPath(), "sess-1");
    expect(view.source).toBe("native");
  });

  it("dbPath = 集合外绝对路径 → 拒绝①级（reader 零触达），journalPath 缺失落 outcome-only（防任意文件读）", async () => {
    const view = await engine.read(makeHandle({ sessionId: "sess-1", dbPath: "/tmp/attacker-chosen/db.sqlite" }));
    expect(mockedRead).not.toHaveBeenCalled();
    expect(view.source).toBe("outcome-only");
  });

  it("误配形态（D3 第四行）：dbPath = 隔离库落其他 dataDir → 本引擎集合不含，拒绝①级", async () => {
    // 传播链断时写侧隔离库落在 pi agent dir 下：读侧按自身 engineDataDir 构集合，
    // 不含漂移路径 → 拒绝①级（生产链同形态行为断言在 svs-zcode-dbpath.test.ts）
    const drifted = zcodeSessionDbPath(path.join(dataDir, "elsewhere"));
    const view = await engine.read(makeHandle({ sessionId: "sess-1", dbPath: drifted }));
    expect(mockedRead).not.toHaveBeenCalled();
    expect(view.source).toBe("outcome-only");
  });
});

// ============================================================
// 两站点 dataDir 相等（D2 传播前提的兜底断言）
// ============================================================

describe("两站点 dataDir 相等（D2 传播前提的兜底断言）", () => {
  it("xyz-agent spawn 配置（XYZ_AGENT_DATA_DIR 注入）下，写侧 engineDataDir 权威源直取注入值", () => {
    const injected = "/data/xyz-agent-injected";
    const warnings: string[] = [];
    // 写侧权威源（zcode-engine deps.engineDataDir 的缺省解析，registration.ts 同源）：
    // env 注入时直取——读侧 dataDir 由 runtime 以同一 env 值传入（传播链 process-manager
    // 注入 → pi 子进程继承 → 引擎 spawn 透传，设计 D2），两侧由同一值构集合即相等。
    // 分叉只可能来自 env 本身被剥（D3 误配形态——行为断言在 svs-zcode-dbpath.test.ts
    // 与本文件 API 链「误配形态」用例）
    expect(resolveEngineDataDir({ [XYZ_DATA_DIR_ENV]: injected })).toBe(injected);
    expect(warnings).toEqual([]);
  });
});

// ============================================================
// env 注入（探针④，集成：fake-appserver 子进程 env 快照）
// ============================================================

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

describe("env 注入（探针④：create 帧后子进程 env 快照）", () => {
  let engines: ZcodeEngine[] = [];
  let tmpRoot: string;
  let dataDir: string;
  let v2Path: string;

  beforeEach(() => {
    engines = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-iso-env-"));
    dataDir = path.join(tmpRoot, "data");
    v2Path = path.join(tmpRoot, "v2.json");
    fs.mkdirSync(path.dirname(v2Path), { recursive: true });
    fs.writeFileSync(
      v2Path,
      JSON.stringify({
        provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
      }),
    );
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("ZCODE_SESSION_DB_PATH=隔离路径覆盖宿主继承值 + 别名键 ZCODE_SESSION_DB 清空 + HOME 正向透传（不变量 1）", async () => {
    const stateFile = path.join(tmpRoot, "state.jsonl");
    const scenarioFile = path.join(tmpRoot, "scenario.json");
    const workspace = path.join(tmpRoot, "ws");
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({
        createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
        readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
        sendPushes: [
          ...ZCODE_APPSERVER_GOLDEN.pushStream,
          ...ZCODE_APPSERVER_GOLDEN.terminal,
        ].map((l) => JSON.parse(l) as Record<string, unknown>),
      }),
    );
    const deps: ZcodeEngineDeps = {
      engineDataDir: () => dataDir,
      cliPath: FAKE_CLI,
      sources: { v2ConfigPath: v2Path },
      processEnv: {
        PATH: process.env.PATH ?? "",
        HOME: "/fake-host-home",
        FAKE_STATE_FILE: stateFile,
        FAKE_SESSION_SCENARIO: scenarioFile,
        // E4：宿主继承的同名 env 是污染面——组装段必须覆盖式写入/显式清空，
        // 不得让用户 shell 的同名 env 把会话重定向到别处
        ZCODE_SESSION_DB_PATH: "/evil/inherited.sqlite",
        ZCODE_SESSION_DB: "/evil/inherited-alias.sqlite",
        // 钉扎 appserver 定向（定向不探不降，与 zcode-engine-appserver.test.ts 同款）
        XYZ_ZCODE_MODE: "appserver",
      },
    };
    const engine = new ZcodeEngine(deps);
    engines.push(engine);

    const { outcome } = await engine.run(
      { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, cwd: workspace },
      { taskId: "sa-iso-env" },
    );
    expect(outcome.error).toBeUndefined();

    // env 快照由 fake 子进程在 boot 时回写（env 不随 RPC 帧传输——子进程 env 是
    // spawn 时刻固化的，create 帧可达即进程已起、快照必已落盘）
    const envEvents = readState(stateFile).filter((e) => e.ev === "env");
    expect(envEvents).toHaveLength(1);
    const snap = envEvents[0] as { home?: string; sessionDbPath?: string; sessionDbAlias?: string };
    expect(snap.sessionDbPath).toBe(zcodeSessionDbPath(dataDir));
    expect(snap.sessionDbAlias).toBeUndefined();
    // 不变量 1：HOME 正向透传（隔离只动会话库，凭据/插件/MCP 继承宿主 HOME 不变）
    expect(snap.home).toBe("/fake-host-home");
  }, 15_000);
});

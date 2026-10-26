// zcode-session-db.test.ts —— C02 簇合并产物（round5-F）。
// 四个来源同以 src/db-path.ts（会话库路径契约根）为共同业务模块：
//   - zcode-session-db-pool-gc.test.ts（池 GC 结构检查）
//   - zcode-session-db-isolation.test.ts（路径单一来源 / API 链白名单 / env 注入）
//   - zcode-engine-status.test.ts（引擎终态 status 消费）
//   - protocol-e2e.test.ts（bin 级协议 e2e，integration 门控）
// mock 相容性 [读码]：仅 isolation 来源 vi.mock("../reader.ts")；reader.ts 生产侧
// 唯一消费方 zcode-engine.ts 且仅在 read() API（run 链不触达）；pool-gc 纯路径
// 函数；e2e 为 spawn 独立子进程（mock 不穿透进程边界）——合并后 mock 影响范围
// 与原文件等价。status / e2e 来源原有文件级 hook 与变量，下沉至各自包裹
// describe（纯前缀添加），分节间 hook 完全隔离。

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveEngineDataDir, resolvePoolDir, SHARED_POOL_KEY, TAIJI_DATA_DIR_ENV } from "@zhushanwen/subagent-engine-sdk";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "./integration-gate.local.ts";
import type { AgentCallOpts, EngineRunResult, RunContext } from "../port-types.ts";
import { readZcodeSessionView } from "../reader.ts";
import { hostZcodeDbPath, zcodeDbPathAllowlist, zcodeSessionDbPath } from "../db-path.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";
import type { EngineHandle } from "../port-types.ts";

// ── 簇内共享常量（各来源同值合一） ──

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";
const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";

// ══════════════════════════════════════════════════════════════
// 来源：zcode-session-db-pool-gc.test.ts —— 池 GC 检查（W5 迁移改写）。
// 原 core 版经公共 API + spy fs 断言「TTL 扫描枚举 session-db/ 伪池但不删隔离库」
// ——pool-manager 是 core 模块，行为检查留在 core 侧原文件。引擎包侧本节固定
// 结构前提（设计 zcode-session-db-isolation.md D1/F11）：
//   ① 隔离库与池目录的分隔是**目录级**的——session-db/ 与任何 poolKey 池目录
//      （engines/zcode/<poolKey>/，journal 落点）互不为前缀；
//   ② journal 命名（journal-<taskId>.jsonl）与 db 文件（db.sqlite*）不同名族——
//      removeOrphanJournals 的 journal-* 匹配规则对 db 文件恒不命中。
// 两条件任一破坏（未来改路径契约）时 core 侧行为检查会先红——本节提供引擎包内
// 的早期信号，不需要 core 依赖。
// ══════════════════════════════════════════════════════════════

describe("池 GC 结构检查（A9 前提：隔离库与池目录目录级分离）", () => {
  it("隔离库不在任何 poolKey 池目录之内（含 'shared' 池），亦不反向包含", () => {
    const dataDir = path.join(path.sep, "data-root");
    const sessionDb = zcodeSessionDbPath(dataDir);
    for (const poolKey of [SHARED_POOL_KEY, "builtin-provider_model", "arbitrary-pool"]) {
      const poolDir = resolvePoolDir(dataDir, "zcode", poolKey);
      // 双向前缀断言：既不在池目录下，也不把池目录包进 session-db
      expect(sessionDb.startsWith(poolDir + path.sep)).toBe(false);
      expect(poolDir.startsWith(sessionDb + path.sep)).toBe(false);
    }
  });

  it("session-db 目录名固定 'session-db'（非 poolKey 形态——池 GC 把它当伪池枚举的判据面）", () => {
    const sessionDb = zcodeSessionDbPath(path.join(path.sep, "data-root"));
    expect(path.basename(path.dirname(sessionDb))).toBe("session-db");
    // 池目录父级 = engines/zcode（与 session-db 同父、不同子——目录级分离的构造形态）
    expect(path.dirname(path.dirname(sessionDb))).toBe(
      path.dirname(resolvePoolDir(path.join(path.sep, "data-root"), "zcode", SHARED_POOL_KEY)),
    );
  });

  it("db 文件名族与 journal 名族不相交（journal-*.jsonl 匹配规则对 db.sqlite* 恒不命中）", () => {
    const sessionDb = zcodeSessionDbPath(path.join(path.sep, "data-root"));
    const dbNames = [path.basename(sessionDb), `${path.basename(sessionDb)}-wal`, `${path.basename(sessionDb)}-shm`];
    for (const name of dbNames) {
      expect(name.startsWith("journal-")).toBe(false);
      expect(name.endsWith(".jsonl")).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 来源：zcode-session-db-isolation.test.ts —— 2026-09 会话库隔离的单元守护面
//（设计权威源：docs/architecture/zcode-session-db-isolation.md D1/D2/D3 + §3.3
// 不变量 1/2/3）。生产链白名单分支守护见
// engine/__tests__/common/session-view-service-zcode-dbpath.test.ts。
// ══════════════════════════════════════════════════════════════

vi.mock("../reader.ts", () => ({
  readZcodeSessionView: vi.fn(),
}));

const mockedRead = vi.mocked(readZcodeSessionView);

// ============================================================
// 路径单一来源（db-path 契约根，不变量 2）
// ============================================================

describe("路径单一来源（db-path 契约根，不变量 2）", () => {
  it("zcodeSessionDbPath = <engineDataDir>/engines/zcode/session-db/db.sqlite（独立展开断言，选址在池目录外）", () => {
    expect(zcodeSessionDbPath("/data-root")).toBe(
      path.join("/data-root", "engines", "zcode", "session-db", "db.sqlite"),
    );
    // D1/F11：engines/zcode/shared/ 是 journal 池目录（deletePoolNativeState 覆盖范围），
    // 隔离库不得落在其下——否则池归零/TTL 清理会删掉会话库
    expect(zcodeSessionDbPath("/data-root").includes(path.join("engines", "zcode", "shared"))).toBe(false);
  });

  it("zcodeDbPathAllowlist = [隔离库（现役）, 宿主库（存量兼容）] 封闭集合，两站点唯一放行来源", () => {
    const dataDir = "/data-root";
    expect(zcodeDbPathAllowlist(dataDir)).toEqual([zcodeSessionDbPath(dataDir), hostZcodeDbPath()]);
    // 封闭性：集合外无第三项
    expect(zcodeDbPathAllowlist(dataDir)).toHaveLength(2);
  });

  it("E5 误配检查：隔离库路径与宿主库路径恒不等（配置错误在测试期拦截）", () => {
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

  it("dbPath = 集合外绝对路径 → 拒绝①级（reader 零触达），eventsPath 缺失落 outcome-only（防任意文件读）", async () => {
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

  it("dbPath = 池内相对路径（池时代旧 record）→ 池目录解析后放行①级", async () => {
    mockedRead.mockResolvedValue(nativeView("from pool db"));
    const view = await engine.read(makeHandle({ sessionId: "sess-1", dbPath: "db.sqlite" }));
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledWith(
      path.resolve(dataDir, "engines", "zcode", "shared", "db.sqlite"),
      "sess-1",
    );
    expect(view.source).toBe("native");
  });

  it("dbPath = 相对路径含 `..` 逃逸池目录 → 拒绝①级（reader 零触达），落 outcome-only（防任意文件读）", async () => {
    // join 归一化后逃逸 `<dataDir>/engines/zcode/shared` 的形态必须与集合外绝对
    // 路径同款拒绝——相对分支是绝对分支白名单的检查缺口（2026-09 review 顺手修）
    const view = await engine.read(
      makeHandle({ sessionId: "sess-1", dbPath: path.join("..", "..", "evil.sqlite") }),
    );
    expect(mockedRead).not.toHaveBeenCalled();
    expect(view.source).toBe("outcome-only");
  });
});

// ============================================================
// 两站点 dataDir 相等（D2 传播前提的兜底断言）
// ============================================================

describe("两站点 dataDir 相等（D2 传播前提的兜底断言）", () => {
  it("taiji spawn 配置（TAIJI_AGENT_DATA_DIR 注入）下，写侧 engineDataDir 权威源直取注入值", () => {
    const injected = "/data/taiji-injected";
    const warnings: string[] = [];
    // 写侧权威源（zcode-engine deps.engineDataDir 的缺省解析，registration.ts 同源）：
    // env 注入时直取——读侧 dataDir 由 runtime 以同一 env 值传入（传播链 process-manager
    // 注入 → pi 子进程继承 → 引擎 spawn 透传，设计 D2），两侧由同一值构集合即相等。
    // 分叉只可能来自 env 本身被剥（D3 误配形态——行为断言在 svs-zcode-dbpath.test.ts
    // 与本节 API 链「误配形态」用例）
    expect(resolveEngineDataDir({ [TAIJI_DATA_DIR_ENV]: injected })).toBe(injected);
    expect(warnings).toEqual([]);
  });
});

// ============================================================
// env 注入（探针④，集成：fake-appserver 子进程 env 快照）
// ============================================================

interface StateEvent { // oe-exempt:20261026:test:测试事件序列形态（合并产物内局部类型，非对外契约）
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
let personalPath: string;

  beforeEach(() => {
    engines = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-iso-env-"));
    dataDir = path.join(tmpRoot, "data");
    v2Path = path.join(tmpRoot, "v2.json");
  personalPath = path.join(tmpRoot, "personal.json");
    fs.mkdirSync(path.dirname(v2Path), { recursive: true });
    fs.writeFileSync(
      v2Path,
      JSON.stringify({
        provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
      }),
    );
    fs.writeFileSync(
      personalPath,
      JSON.stringify({
        config: {
          providerOrder: [PROVIDER],
          providerConfigRules: {
            providerRules: [
              { providerId: PROVIDER, providerName: "t", config: { access: { type: "api-key", apiKey: "k" }, personalModelIds: ["m1"] } },
            ],
          },
        },
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
      sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
      processEnv: {
        PATH: process.env.PATH ?? "",
        HOME: "/fake-host-home",
        FAKE_STATE_FILE: stateFile,
        FAKE_SESSION_SCENARIO: scenarioFile,
        // E4：宿主继承的同名 env 是污染面——组装段必须覆盖式写入/显式清空，
        // 不得让用户 shell 的同名 env 把会话重定向到别处
        ZCODE_SESSION_DB_PATH: "/evil/inherited.sqlite",
        ZCODE_SESSION_DB: "/evil/inherited-alias.sqlite",
        // 固定 appserver 定向（定向不探不降）
        TAIJI_ZCODE_MODE: "appserver",
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

// ══════════════════════════════════════════════════════════════
// 来源：zcode-engine-status.test.ts —— [P0-1 U3] 引擎终态 status 消费测试
//（设计锚点 D5、F-3、A4；⛔P-Z2 门修正：真实 status 枚举 = ["success",
// "interrupted","failed"]——判据 failed 主 + error 容错）。原文件级 hook 与
// 私有变量下沉本包裹层。失败终态即时到达，idle/ceiling 默认阈值不参与——
// 无需 env stub。
// ══════════════════════════════════════════════════════════════

describe("引擎终态 status 消费（P0-1 U3：来源合并节）", () => {
  /** 真实协议 failed 终态帧（⛔P-Z2 门 credfail 实测帧形：errorCode/errorMessage 携带）。 */
  const TERMINAL_FAILED_REAL =
    '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"failed","errorCode":"model_request_failed","errorMessage":"Provider marked the request as failed (bad port / credential invalid)"}}';
  /** failed 无错误详情变体（P-Z2 降级形态注入材料）。 */
  const TERMINAL_FAILED_BARE =
    '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"failed"}}';
  /** interrupted 终态（真实枚举成员——用户中断，不误判失败的回归测试）。 */
  const TERMINAL_INTERRUPTED_FRAME =
    '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"interrupted"}}';
  /** 非真实枚举的 "error" 终态（容错分支——防协议漂移滑回假成功）。 */
  const TERMINAL_ERROR_FRAME =
    '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"error"}}';
  /** 收尾帧（A.2 ⑤ response 形态）——final-frame 宽松终态的注入材料（golden terminal[1]）。 */
  const GOLDEN_FINAL_FRAME = ZCODE_APPSERVER_GOLDEN.terminal[1];
  /** read 兜底返回的服务端错误文本（read 尾部兜底路径的载体）。 */
  const READ_ERROR_TEXT = "Error: provider request failed (401 Unauthorized)";
  /** 真实 failed 终态的 terminal 帧错误详情（探针 credfail 实测值）。 */
  const TERMINAL_ERROR_CODE = "model_request_failed";
  const TERMINAL_ERROR_MESSAGE = "Provider marked the request as failed (bad port / credential invalid)";

  let engines: ZcodeEngine[] = [];
  let seq = 0;
  let tmpRoot: string;
  let dataDir: string;
  let v2Path: string;
  let personalPath: string;

  function writeJson(p: string, v: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v, null, 2));
  }

  beforeEach(() => {
    engines = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-status-"));
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
    for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  interface StatusScenarioOverrides { // oe-exempt:20261026:test:测试夹具参数形态（原 isolation/pool-gc 两文件搬运合并产物内局部类型，非对外契约）
    /** send 应答前逐帧推送的注入序列（覆盖缺省 golden 流）。 */
    sendPushes: string[];
    /** 覆盖 read 应答（缺省 golden readResponse——assistant 全文）。 */
    readResult?: unknown;
  }

  interface StatusEngineFixture { // oe-exempt:20261026:test:测试夹具聚合形态（合并产物内局部类型，非对外契约）
    engine: ZcodeEngine;
    workspace: string;
  }

  function makeEngine(overrides: StatusScenarioOverrides): StatusEngineFixture {
    seq += 1;
    const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
    const workspace = path.join(tmpRoot, `ws-${seq}`);
    writeJson(scenarioFile, {
      createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
      readResult: overrides.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
      sendPushes: overrides.sendPushes.map((l) => JSON.parse(l) as Record<string, unknown>),
    });
    const deps: ZcodeEngineDeps = {
      engineDataDir: () => dataDir,
      cliPath: FAKE_CLI,
      sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
      processEnv: {
        PATH: process.env.PATH ?? "",
        // 固定 appserver 定向（定向不探不降）
        TAIJI_ZCODE_MODE: "appserver",
        FAKE_SESSION_SCENARIO: scenarioFile,
      },
    };
    const engine = new ZcodeEngine(deps);
    engines.push(engine);
    return { engine, workspace };
  }

  function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
    return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
  }

  function makeCtx(overrides?: Partial<RunContext>): RunContext {
    return { taskId: "sa-status", ...overrides };
  }

  // ============================================================
  // status='failed'（真实帧形）→ run-failed（⛔P-Z2 门修正的从根源修复回归测试）
  // ============================================================

  describe("failed 终态分流（真实协议枚举：parsed 前消费 status → run-failed，不假成功）", () => {
    it("帧序 A：turn.terminal failed（errorCode/errorMessage）先到 + read 有全文 → run-failed 且详情取 terminal 帧（优先于 read 尾部）", async () => {
      const f = makeEngine({
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_FAILED_REAL],
        // read 缺省 golden（有全文）——证明 terminal 帧详情优先级高于 read 尾部
      });
      const r: EngineRunResult = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      // F-3 文案形态：engine_run_failed 前缀 + 真实枚举值 failed + 会话 id（非 engine_timeout 族）
      expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
      expect(r.outcome.error).toContain(`（会话 ${GOLDEN_SESSION_ID}）`);
      expect(r.outcome.error).not.toContain("engine_timeout");
      // ⛔P-Z2：错误详情来自 terminal 帧（read/delta 携带不了——errorCode/errorMessage 优先）
      expect(r.outcome.error).toContain(`errorCode: ${TERMINAL_ERROR_CODE}`);
      expect(r.outcome.error).toContain(TERMINAL_ERROR_MESSAGE);
      // 详情已采信，read 尾部不再叠加（详情 > read 兜底的优先级裁决）
      expect(r.outcome.error).not.toContain(GOLDEN_FULL_TEXT);
      // 恢复指引（F-3）
      expect(r.outcome.error).toContain("engine_credential_missing 同族排查");
      // 失败形态（非成功）：异常终态口径 exitCode=null、content 空
      expect(r.outcome.exitCode).toBeNull();
      expect(r.outcome.content).toBe("");
      // run 不 reject——正常 handle 返回（record 必须收尾），sessionId 留痕进 sessionRef
      //（dbPath 形态随 2026-09 会话库隔离为隔离库绝对路径——zcodeSessionDbPath(engineDataDir)）
      expect(r.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
      expect(r.handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: zcodeSessionDbPath(dataDir) });
    }, 15_000);

    it("帧序 B：final-frame 宽松 settle success 先到 + turn.terminal failed 迟到（lastTerminalStatus/lastTerminalError 衔接）→ 仍 run-failed", async () => {
      const f = makeEngine({
        // final-frame 先落定（session-channel 恒 settle success），权威 failed 只被记录
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, TERMINAL_FAILED_REAL],
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
      // 迟到 terminal 帧的详情仍透传（channel 只记录不改写落定，消费层识破假成功）
      expect(r.outcome.error).toContain(`errorCode: ${TERMINAL_ERROR_CODE}`);
      expect(r.outcome.error).toContain(TERMINAL_ERROR_MESSAGE);
      expect(r.outcome.exitCode).toBeNull();
      expect(r.outcome.content).toBe("");
    }, 15_000);

    it("P-Z2 降级形态：failed 无 errorCode/errorMessage + final-frame 先到 + read 无错误信息 → 尾部兜底，仍 run-failed 不假成功", async () => {
      const f = makeEngine({
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, TERMINAL_FAILED_BARE],
        readResult: { messages: [] }, // read 无错误信息（降级形态判据）
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      // 覆盖范围收窄但不假成功：final-frame 的宽松 success 不采信
      expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
      expect(r.outcome.exitCode).toBeNull();
      expect(r.outcome.content).toBe("");
      // 尾部以 finalText 降级合成（read 空 → 收尾帧全文 → delta 聚合的既有降级链）
      expect(r.outcome.error).toContain(GOLDEN_FULL_TEXT);
    }, 15_000);

    it("全空形态：仅 turn.terminal failed（无 delta/收尾帧/错误详情）+ read 空 → run-failed 且不伪造错误详情", async () => {
      const f = makeEngine({
        sendPushes: [TERMINAL_FAILED_BARE],
        readResult: { messages: [] },
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
      expect(r.outcome.error).toContain("服务端无返回内容");
      expect(r.outcome.exitCode).toBeNull();
      expect(r.outcome.content).toBe("");
    }, 15_000);

    it("schema 任务遇 failed 终态：分流先于 schema 校验（不产 schema_emulation_failed、不进强化重试）", async () => {
      const f = makeEngine({
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_FAILED_REAL],
      });
      const r = await f.engine.run(
        makeTask({ cwd: f.workspace, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }),
        makeCtx(),
      );
      expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
      expect(r.outcome.error).not.toContain("schema_emulation_failed");
      expect(r.outcome.parsedOutput).toBeUndefined();
    }, 15_000);
  });

  // ============================================================
  // interrupted 不误判 + error 容错分支（⛔P-Z2 门修正的两翼）
  // ============================================================

  describe("非失败终态裁决（interrupted 随宿主 abort 主路径；error 容错防漂移）", () => {
    it("status:'interrupted'（真实枚举成员）→ 不误判失败：parsed 收尾（用户中断不属引擎失败，落定语义登记）", async () => {
      const f = makeEngine({
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_INTERRUPTED_FRAME],
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      // 不分流：引擎侧不抢先把它终态化为失败（宿主 abort 主路径的收尾语义保留）
      expect(r.outcome.error).toBeUndefined();
      expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
      expect(r.outcome.exitCode).toBe(0);
    }, 15_000);

    it("status:'error'（非真实枚举，容错分支）→ 仍 run-failed 不假成功（防协议漂移滑回 v1 缺陷）", async () => {
      const f = makeEngine({
        sendPushes: [TERMINAL_ERROR_FRAME],
        readResult: { messages: [] },
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
      expect(r.outcome.error).toContain("服务端无返回内容");
      expect(r.outcome.exitCode).toBeNull();
      expect(r.outcome.content).toBe("");
    }, 15_000);
  });

  // ============================================================
  // 成功路径零回归（负面验证——§8 A6 同族）
  // ============================================================

  describe("成功路径零回归（U3 分流不误伤正常终态）", () => {
    it("terminal success 先到（golden 流）→ parsed：content 全文、exitCode 0、无 error", async () => {
      const f = makeEngine({
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal],
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      expect(r.outcome.error).toBeUndefined();
      expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
      expect(r.outcome.exitCode).toBe(0);
    }, 15_000);

    it("final-frame 先到 + terminal success 迟到 → parsed（权威 success 后到不改写已落定的成功）", async () => {
      const f = makeEngine({
        // final-frame 在权威 terminal 之前到达（宽松终态先 settle，权威后到只记录）
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, ZCODE_APPSERVER_GOLDEN.terminal[0]],
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      expect(r.outcome.error).toBeUndefined();
      expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
      expect(r.outcome.exitCode).toBe(0);
    }, 15_000);

    it("final-frame 独走（无 turn.terminal 到达）→ parsed（无权威 status 可消费，不判失败）", async () => {
      const f = makeEngine({
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME],
      });
      const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
      expect(r.outcome.error).toBeUndefined();
      expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
      expect(r.outcome.exitCode).toBe(0);
    }, 15_000);
  });
});

// ══════════════════════════════════════════════════════════════
// 来源：protocol-e2e.test.ts —— bin 级最小 e2e（W5 任务书验收）。形态：spawn
// `node bin/zcode-subagent-cli.mjs`（真实进程、真实 stdout 协议通道），用
// __fixtures__/fake-appserver.mjs 冒充 zcode CLI（TAIJI_ZCODE_CLI 注入 + HOME 指
// tmp 写入合成 v2 config——合成 apiKey，绝不碰真实凭据/真实数据目录）。
// 分层判据第三档（进程存亡/stdio 排空无稳定上界）：本地默认跳过，CI 或按改动
// 范围触发时设 TAIJI_TEST_INTEGRATION=1 真跑（门控 SSOT = test-guard/integration-gate.ts）。
// 原文件级 beforeAll/afterAll 与私有变量下沉本包裹层。
// ══════════════════════════════════════════════════════════════

describe("bin e2e 协议往返（TAIJI_TEST_INTEGRATION 门控：来源合并节）", () => {
  const BIN = fileURLToPath(new URL("../../bin/zcode-subagent-cli.mjs", import.meta.url));
  const FINAL_TEXT = "你好，任务完成";

  let root: string;
  let dataDir: string;
  let fakeHome: string;
  let scenarioFile: string;

  beforeAll(() => {
    root = mkdtempSync(joinTmp("zcode-cli-e2e-"));
    dataDir = path.join(root, "engine-data");
    fakeHome = path.join(root, "fake-home");
    mkdirSync(path.join(fakeHome, ".zcode", "v2"), { recursive: true });
    // 合成凭据（fake 值，仅满足 preparer 的校验形态——不是真实凭据）。两份：
    // v2 config = launcher 凭据注入源；provider_config = 模型解析源（2026-09-29
    // account 体系迁移后引擎侧校验对齐 app-server 注册表实况——个人 provider 单源）
    writeFileSync(
      path.join(fakeHome, ".zcode", "v2", "config.json"),
      JSON.stringify({
        provider: {
          "test-provider": {
            options: { apiKey: "synthetic-e2e-key", baseURL: "https://t.example" },
            models: { m1: {} },
          },
        },
      }),
    );
    writeFileSync(
      path.join(fakeHome, ".zcode", "v2", "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: ["test-provider"],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "test-provider",
                providerName: "test",
                config: { access: { type: "api-key", apiKey: "synthetic-e2e-key" }, personalModelIds: ["m1"] },
              },
            ],
          },
        },
      }),
    );
    scenarioFile = path.join(root, "scenario.json");
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
        // fake 的 sendPushes 要对象形态（golden 内嵌副本是 JSON 行字符串——先 parse）
        sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal].map(
          (l) => JSON.parse(l) as Record<string, unknown>,
        ),
        readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
      }),
    );
  });

  afterAll(() => {
    rmSync(path.dirname(dataDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function joinTmp(prefix: string): string {
    return path.join(os.tmpdir(), prefix);
  }

  interface Inbound { // oe-exempt:20261026:test:测试夹具入站消息形态（合并产物内局部类型，非对外契约）
    kind: "response" | "notification" | "reverse";
    id?: number | string;
    method?: string;
    result?: unknown;
    error?: { code: string; message: string };
    params?: { runId?: string; seq?: number; event?: { type: string; delta?: string } };
  }

  /** 驱动一个引擎 CLI 进程：写帧 / 读帧 / 自动应答数据范围 host/* 反向请求。 */
  class EngineProc {
    private readonly child: ChildProcess;
    private readonly frames: Inbound[] = [];
    private waiters: Array<{ test: (f: Inbound) => boolean; resolve: (f: Inbound) => void }> = [];
    private closed = false;
    private stderrText = "";

    constructor(scenarioPath: string = scenarioFile, extraEnv: Record<string, string> = {}) {
      this.child = spawn(process.execPath, [BIN], {
        env: {
          ...process.env,
          TAIJI_AGENT_DATA_DIR: dataDir,
          HOME: fakeHome,
          TAIJI_ZCODE_CLI: FAKE_CLI,
          FAKE_SESSION_SCENARIO: scenarioPath,
          // 剥可能干扰的宿主继承面（CI/本地环境差异点收敛）
          ZCODE_SESSION_DB_PATH: "",
          ZCODE_SESSION_DB: "",
          ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stdout?.setEncoding("utf8");
      let buffer = "";
      this.child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line !== "") this.onLine(line);
          nl = buffer.indexOf("\n");
        }
      });
      this.child.stderr?.setEncoding("utf8");
      this.child.stderr?.on("data", (c: string) => {
        // 全量取证（分级日志断言数据源）+ 转发宿主 stderr（本地调试可见性）
        this.stderrText += c;
        process.stderr.write(`[engine-stderr] ${c}`);
      });
      this.child.on("close", () => {
        this.closed = true;
        for (const w of this.waiters.splice(0)) w.resolve({ kind: "notification", method: "__closed__" });
      });
    }

    private onLine(line: string): void {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // 协议通道不该有坏行；忽略防挂死
      }
      let frame: Inbound;
      if (typeof parsed.method === "string" && parsed.method.startsWith("host/")) {
        frame = { kind: "reverse", id: parsed.id as string, method: parsed.method, params: parsed.params as Inbound["params"] };
        // 数据范围自动应答（host/log 等 {ok:true}；两阶段面 {ack:true}）
        this.write({ id: parsed.id, result: { ok: true } });
      } else if (typeof parsed.method === "string") {
        frame = { kind: "notification", method: parsed.method, params: parsed.params as Inbound["params"] };
      } else {
        frame = {
          kind: "response",
          id: parsed.id as number,
          ...(parsed.result !== undefined ? { result: parsed.result } : {}),
          ...(parsed.error !== undefined ? { error: parsed.error as Inbound["error"] } : {}),
        };
      }
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (w.test(frame)) {
          w.resolve(frame);
          return false;
        }
        return true;
      });
    }

    write(frame: unknown): void {
      this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
    }

    async waitFor(test: (f: Inbound) => boolean, timeoutMs = 30_000): Promise<Inbound> {
      const hit = this.frames.find(test);
      if (hit !== undefined) return hit;
      return new Promise<Inbound>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
          reject(new Error(`waitFor timeout; frames so far: ${JSON.stringify(this.frames.map((f) => ({ m: f.method, id: f.id, k: f.kind })))}`));
        }, timeoutMs);
        this.waiters.push({
          test,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    }

    async exited(timeoutMs = 10_000): Promise<boolean> {
      if (this.closed) return true;
      await this.waitFor((f) => f.method === "__closed__", timeoutMs).catch(() => null);
      return this.closed;
    }

    get allFrames(): readonly Inbound[] {
      return this.frames;
    }

    /** 子进程 stderr 全量（分级日志断言数据源——进程 close 后已 flush 完整）。 */
    get stderrOutput(): string {
      return this.stderrText;
    }

    kill(): void {
      this.child.kill("SIGKILL");
    }

    /** 模拟宿主退出：关闭 stdin（自灭检查主判据 = stdio EOF）。 */
    endStdin(): void {
      this.child.stdin?.end();
    }
  }

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
    `bin e2e：initialize → run → 终态应答 协议往返（冒烟）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
    () => {
      it("握手 + fake run 全链路（fake-appserver 冒充 zcode CLI）", { timeout: 60_000 }, async () => {
        const engine = new EngineProc();
        try {
          // ① initialize 握手
          engine.write({
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1, hostInfo: { name: "vitest-e2e", version: "0.0.0", dataRoot: dataDir }, engineConfig: {} },
          });
          const init = await engine.waitFor((f) => f.kind === "response" && f.id === 1);
          expect(init.error).toBeUndefined();
          const initResult = init.result as {
            protocolVersion: number;
            engineId: string;
            capabilities: { schemaEnforcement: string; maxTurns: boolean };
          };
          expect(initResult.protocolVersion).toBe(1);
          expect(initResult.engineId).toBe("zcode");
          expect(initResult.capabilities.schemaEnforcement).toBe("emulated");
          expect(initResult.capabilities.maxTurns).toBe(false);

          // ② run（fake 场景：delta 流 + 终态 + read 兜底）
          engine.write({
            id: 2,
            method: "run",
            params: {
              runId: "run-e2e-1",
              task: { prompt: "做点什么" },
              ctx: { cwd: dataDir, model: "test-provider/m1" },
            },
          });

          // host/handleReady（create 应答后回填）
          const handle = await engine.waitFor((f) => f.kind === "reverse" && f.method === "host/handleReady");
          const handleParams = handle.params as { sessionRef?: Record<string, string> };
          expect(handleParams?.sessionRef?.["sessionId"]).toBe(GOLDEN_SESSION_ID);

          // ③ event 通知：text_delta（golden delta 拼接）+ 终态 message_end/turn_end
          const deltas: string[] = [];
          await engine.waitFor((f) => f.kind === "notification" && f.params?.event?.type === "turn_end");
          for (const f of engine.allFrames) {
            if (f.kind !== "notification" || f.params?.runId !== "run-e2e-1") continue;
            const ev = f.params.event;
            if (ev?.type === "text_delta" && typeof ev.delta === "string") deltas.push(ev.delta);
          }
          expect(deltas.join("")).toBe(FINAL_TEXT);
          const seqs = engine.allFrames
            .filter((f) => f.kind === "notification" && f.params?.runId === "run-e2e-1" && f.params?.seq !== undefined)
            .map((f) => f.params?.seq as number);
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // seq 单调不减

          // ④ run 终态应答
          const runResp = await engine.waitFor((f) => f.kind === "response" && f.id === 2);
          expect(runResp.error).toBeUndefined();
          // 协议 RunResult.handle = EngineHandleData 本体（进程内 {data} 包装只在
          // EnginePort 面存在——与 RemoteEngine 的 `handle: { data: result.handle }` 对端互证）
          const runResult = runResp.result as {
            handle: { sessionRef: Record<string, string> };
            outcome: { content: string; exitCode: number | null; error?: string; sessionId?: string };
          };
          expect(runResult.outcome.content).toBe(FINAL_TEXT);
          expect(runResult.outcome.exitCode).toBe(0);
          expect(runResult.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
          expect(runResult.handle.sessionRef["sessionId"]).toBe(GOLDEN_SESSION_ID);
          // 隔离库路径单一来源（db-path 契约根）
          expect(runResult.handle.sessionRef["dbPath"]).toBe(zcodeSessionDbPath(dataDir));

          // ⑤ dispose 幂等 + ping
          engine.write({ id: 3, method: "dispose", params: {} });
          const disposeResp = await engine.waitFor((f) => f.kind === "response" && f.id === 3);
          expect(disposeResp.result).toEqual({ ok: true });
          engine.write({ id: 4, method: "dispose", params: {} });
          const disposeResp2 = await engine.waitFor((f) => f.kind === "response" && f.id === 4);
          expect(disposeResp2.result).toEqual({ ok: true });
          engine.write({ id: 5, method: "ping", params: {} });
          const ping = await engine.waitFor((f) => f.kind === "response" && f.id === 5);
          expect(ping.result).toEqual({ pong: true });

          // stdin 关闭（宿主退出面）→ 进程自灭（EOF 主判据的隐式验证）
          engine.endStdin();
          expect(await engine.exited()).toBe(true);
        } finally {
          engine.kill();
        }
      });
    },
  );

  // ============================================================
  // [U6 / §3.2.6 要点 3] interact(resume) 协议级 e2e
  // ============================================================

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
    `bin e2e：interact(resume) 全链（resume 读 → create 新 session → sessionRef 回填）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
    () => {
      const OLD_SID = "sess_prior_e2e_1";

      function writeResumeScenario(): string {
        const file = path.join(root, "scenario-resume.json");
        writeFileSync(
          file,
          JSON.stringify({
            // distinctSessionIds 形态：create 回独立 sess_<frameId>（≠ 旧锚）
            sendPushes: [
              ...ZCODE_APPSERVER_GOLDEN.pushStream,
              ZCODE_APPSERVER_GOLDEN.terminal[0],
              ZCODE_APPSERVER_GOLDEN.terminal[1],
            ].map((l) => JSON.parse(l) as Record<string, unknown>),
            sendDenySessionIds: [OLD_SID],
            resumeResult: {
              messages: [
                { info: { role: "user" }, parts: [{ type: "text", text: "记住暗号：蓝莓派-42" }] },
                {
                  info: { role: "assistant" },
                  parts: [
                    { type: "text", text: "收到。" },
                    { type: "step-finish", tokens: { input: 800, output: 120 } },
                  ],
                },
              ],
            },
          }),
        );
        return file;
      }

      it("resume 锚驱动：resume 帧先于 create、首轮含历史前缀、终态 sessionRef = 新会话、无向旧会话 send", { timeout: 60_000 }, async () => {
        const stateFile = path.join(root, "resume-fake-state.jsonl");
        // STAMP：golden 推送流按目标会话归因（新会话 id ≠ golden 内嵌固定 id）
        const engine = new EngineProc(writeResumeScenario(), { FAKE_STATE_FILE: stateFile, FAKE_STAMP_SESSION: "1" });
        try {
          engine.write({
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1, hostInfo: { name: "vitest-e2e", version: "0.0.0", dataRoot: dataDir }, engineConfig: {} },
          });
          const init = await engine.waitFor((f) => f.kind === "response" && f.id === 1);
          expect(init.error).toBeUndefined();

          engine.write({
            id: 2,
            method: "run",
            params: {
              runId: "run-resume-1",
              task: { prompt: "暗号是什么？" },
              ctx: { cwd: dataDir, model: "test-provider/m1" },
              // [U6] 协议 run.params.resume（RunResumeParams：recordId + ResumeAnchor）
              resume: {
                recordId: "run-resume-1",
                resume: {
                  sessionRef: { sessionId: OLD_SID, dbPath: zcodeSessionDbPath(dataDir) },
                },
              },
            },
          });

          // handleReady 的新 sessionRef（create 应答后回传——锚换新的协议范围证据）
          const handle = await engine.waitFor((f) => f.kind === "reverse" && f.method === "host/handleReady");
          const handleSid = (handle.params as { sessionRef?: Record<string, string> })?.sessionRef?.["sessionId"];
          expect(typeof handleSid).toBe("string");
          expect(handleSid).not.toBe(OLD_SID);

          const runResp = await engine.waitFor((f) => f.kind === "response" && f.id === 2);
          expect(runResp.error).toBeUndefined();
          const runResult = runResp.result as {
            handle: { sessionRef: Record<string, string> };
            outcome: { content: string; error?: string; sessionId?: string };
          };
          expect(runResult.outcome.error).toBeUndefined();
          expect(runResult.outcome.content).toBe(FINAL_TEXT);
          // 终态 handle 与 outcome 的 sessionId 均为新会话（锚更新链的引擎侧产出）
          expect(runResult.outcome.sessionId).toBe(handleSid);
          expect(runResult.handle.sessionRef["sessionId"]).toBe(handleSid);

          // fake 流水：resume 帧先于 create；唯一 send 目标 = 新会话且内容含历史前缀
          const recv = readFakeState(stateFile);
          const methods = recv.map((f) => (f as { method?: string }).method);
          expect(methods.indexOf("session/resume")).toBeGreaterThanOrEqual(0);
          expect(methods.indexOf("session/resume")).toBeLessThan(methods.indexOf("session/create"));
          expect(recv.filter((f) => (f as { method?: string }).method === "session/resume")).toHaveLength(1);
          expect((recv.find((f) => (f as { method?: string }).method === "session/resume") as { params?: unknown }).params).toEqual({
            sessionId: OLD_SID,
          });
          const sends = recv.filter((f) => (f as { method?: string }).method === "session/send");
          expect(sends).toHaveLength(1);
          const sendParams = (sends[0] as { params?: { sessionId?: string; content?: string } }).params;
          expect(sendParams?.sessionId).toBe(handleSid);
          expect(sendParams?.content).toContain("[Continued conversation]");
          expect(sendParams?.content).toContain(`prior session id: ${OLD_SID}`);
          expect(sendParams?.content).toContain("记住暗号：蓝莓派-42");
          expect(sendParams?.content?.endsWith("暗号是什么？")).toBe(true);

          engine.endStdin();
          expect(await engine.exited()).toBe(true);
        } finally {
          engine.kill();
        }
      });
    },
  );

  /** fake-appserver 流水（FAKE_STATE_FILE）的 recv 帧提取。 */
  function readFakeState(file: string): Array<Record<string, unknown>> {
    try {
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.includes('"ev":"recv"'))
        .map((l) => (JSON.parse(l) as { frame?: Record<string, unknown> }).frame)
        .filter((f): f is Record<string, unknown> => f !== undefined);
    } catch {
      return [];
    }
  }

  // ============================================================
  // 权威终态迟到分级日志：stderr 兜底链路取证（bin 真进程全链——session-channel
  // 分级 → SDK logger facade → cli-entry stderr 兜底 sink → 子进程 stderr）
  // ============================================================

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
    `bin e2e：final-frame 先落定 + 权威 turn.terminal 迟到的 stderr 分级${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
    () => {
      /** 合成「pushStream + 收尾帧（先落定）+ 迟到 turn.terminal(status)」场景文件。 */
      function writeLateTerminalScenario(status: string): string {
        const file = path.join(root, `scenario-late-${status}.json`);
        writeFileSync(
          file,
          JSON.stringify({
            createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
            sendPushes: [
              ...ZCODE_APPSERVER_GOLDEN.pushStream.map(
                (l) => JSON.parse(l) as Record<string, unknown>,
              ),
              JSON.parse(ZCODE_APPSERVER_GOLDEN.terminal[1]) as Record<string, unknown>, // 收尾帧先落定（final-frame）
              { method: "v4/telemetry/event", params: { kind: "turn.terminal", status } }, // 迟到的权威终态
            ],
            readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
          }),
        );
        return file;
      }

      /** 走完 initialize → run → 退出全链，返回 run 应答与已退出的引擎实例。 */
      async function runOnce(scenarioPath: string): Promise<{ engine: EngineProc; runResp: Inbound }> {
        const engine = new EngineProc(scenarioPath);
        try {
          engine.write({
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1, hostInfo: { name: "vitest-e2e", version: "0.0.0", dataRoot: dataDir }, engineConfig: {} },
          });
          const init = await engine.waitFor((f) => f.kind === "response" && f.id === 1);
          expect(init.error).toBeUndefined();
          engine.write({
            id: 2,
            method: "run",
            params: {
              runId: "run-late-terminal",
              task: { prompt: "做点什么" },
              ctx: { cwd: dataDir, model: "test-provider/m1" },
            },
          });
          const runResp = await engine.waitFor((f) => f.kind === "response" && f.id === 2);
          // 退出后 stdio 管道已 flush（close 事件语义）——stderr 取证无竞态
          engine.endStdin();
          expect(await engine.exited()).toBe(true);
          return { engine, runResp };
        } catch (err) {
          engine.kill();
          throw err;
        }
      }

      it("迟到 success（常态迟到）：run 成功，stderr 无迟到终态日志（降噪从根源修复点）", { timeout: 60_000 }, async () => {
        const { engine, runResp } = await runOnce(writeLateTerminalScenario("success"));
        try {
          expect(runResp.error).toBeUndefined();
          const outcome = (runResp.result as { outcome: { content: string } }).outcome;
          expect(outcome.content).toBe(FINAL_TEXT);
          expect(engine.stderrOutput).not.toContain("权威终态晚于落定");
          expect(engine.stderrOutput).not.toContain("[error]");
        } finally {
          engine.kill();
        }
      });

      it("迟到 interrupted：降 debug 且 stderr 无输出（依赖 SDK cli-entry sink 对 debug 跳过写）", { timeout: 60_000 }, async () => {
        const { engine, runResp } = await runOnce(writeLateTerminalScenario("interrupted"));
        try {
          // interrupted 不属失败终态（isFailedTerminalStatus 口径）——run 仍成功收尾
          expect(runResp.error).toBeUndefined();
          expect(engine.stderrOutput).not.toContain("权威终态晚于落定");
          expect(engine.stderrOutput).not.toContain("[debug]"); // debug 级不落 stderr（CONSOLE_SINK 语义对齐）
          expect(engine.stderrOutput).not.toContain("[error]");
        } finally {
          engine.kill();
        }
      });

      it("迟到 failed：stderr 保留 warn（假成功识破防御机制），文案含原样 status", { timeout: 60_000 }, async () => {
        const { engine, runResp } = await runOnce(writeLateTerminalScenario("failed"));
        try {
          // 权威 status=failed 经 lastTerminalStatus 分流为 run-failed（P-Z2 门修正）
          expect(runResp.error).toBeUndefined(); // run-failed 落 outcome.error，非协议 error 帧
          const outcome = (runResp.result as { outcome: { error?: string } }).outcome;
          expect(outcome.error).toContain("engine_run_failed");
          expect(engine.stderrOutput).toContain("权威终态晚于落定");
          expect(engine.stderrOutput).toContain('[warn]');
          expect(engine.stderrOutput).toContain('status="failed"');
        } finally {
          engine.kill();
        }
      });
    },
  );
});

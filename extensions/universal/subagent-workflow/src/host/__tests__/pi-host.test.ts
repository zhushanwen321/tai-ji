// pi-host.test.ts —— pi 壳宿主实现与现行为等价（u0-wire 验收①）。
//
// 三视角：①使用者——discoveryRoots 各 kind 的根清单/顺序/source 标签与
// resource-discovery.ts buildScanTargets（user-pi/npm/npm-dev 段）、
// skill-discovery.ts resolveSkillPath（skills 两根）现推导逐项一致；
// ②构建者——dataRoot/log/countActiveFromEntries/createDelivery 四端口桥接形态；
// ③观察者——getAgentDir 每次现取（PI_CODING_AGENT_DIR 实例隔离切换后重取生效，
// 无模块级缓存）。
//
// mock 策略：pi SDK / pi 宿主协作件全部 vi.mock 工厂覆盖（vitest alias 的
// mocks/ 桩只供其他测试族用，本文件需要可控返回值）。pending-notifications
// mock 返回 {count: n} 形状直接验证「适配读 .count」；session-delivery mock
// 验证 createDelivery 透传（参数 + 返回句柄）。

import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（vi.mock 工厂 hoisting 不能引用外部 let/const） ──

const piCodingAgentMock = vi.hoisted(() => ({
  // 与实装版 getAgentDir 的 env 契约一致（PI_CODING_AGENT_DIR 实例隔离优先），
  // 使「env 切换后重取生效」可直接断言；缺省值仅作 fallback。
  getAgentDir: vi.fn(() => process.env.PI_CODING_AGENT_DIR ?? "/mock/default/agent-dir"),
}));

const extensionLoggerMock = vi.hoisted(() => ({
  getLogger: vi.fn(),
}));

const pendingNotificationsMock = vi.hoisted(() => ({
  countActiveFromEntries: vi.fn(),
}));

const sessionDeliveryMock = vi.hoisted(() => ({
  createDelivery: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => piCodingAgentMock);
vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);
vi.mock("@zhushanwen/pi-pending-notifications", () => pendingNotificationsMock);
vi.mock("@zhushanwen/session-delivery", () => sessionDeliveryMock);

// 端到端用例（P5 staged 入扫描面）隔离真实用户目录：resource-discovery 用 homedir()
// 推导 user-agents 根（~/.agents/workflows），不 mock 会让「内置条目存在/两次一致」
// 断言依赖本机用户资产状态（resource-discovery.test.ts 同款手法）。
const mockHomeDir = vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "pihost-p5-home-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomeDir };
});

import { discoverResources } from "@zhushanwen/subagent-core";
// clearFileCache 仅测试消费（barrel 收窄面外）——测试深路径经 vitest alias 正则
// 重写到 core src 物理路径（B-2/D3 既有先例形态；specifier 不含 src/ 段）
import { clearFileCache } from "@zhushanwen/subagent-core/shared/resource-discovery.ts";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";
import { createDelivery } from "@zhushanwen/session-delivery";

import { createPiHostServices, createPiNotifyDomainPorts, resolveGrandchildExtensionPaths } from "../pi-host.ts";

beforeEach(() => {
  vi.mocked(getAgentDir).mockClear();
  vi.mocked(getLogger).mockReset();
  vi.mocked(countActiveFromEntries).mockReset();
  vi.mocked(createDelivery).mockReset();
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("createPiHostServices.discoveryRoots（与现推导逐项一致）", () => {
  // 基线锚点：resource-discovery.ts buildScanTargets（join(agentDir, kind) /
  // join(agentDir, "npm", "node_modules") / join(agentDir, "extensions")）与
  // skill-discovery.ts resolveSkillPath（join(getAgentDir(), "skills") +
  // join(getAgentDir(), "npm/node_modules")）。根列表按优先级低→高排列（D2）。
  const AGENT_DIR = "/fake/agent-dir";
  const argvSaved = process.argv;

  function stubAgentDir(): void {
    vi.mocked(getAgentDir).mockReturnValue(AGENT_DIR);
  }

  beforeEach(() => {
    // 独立 pi 形态基线（argv 无 --extension）：P5 扫描根修正后 npm/npm-dev 根的
    // 指向随形态分流——本 describe 全部锚定独立态推导，runner argv 形态不构成
    // 契约，显式钉死防漂移（taiji 态断言见下方专属 describe）。
    process.argv = ["node", "/pi", "--mode", "rpc"];
  });

  afterEach(() => {
    process.argv = argvSaved;
  });

  it("agents 四根：user-pi → npm → npm-dev → core 包父目录（C5⑥，source npm 追加末位）", () => {
    stubAgentDir();
    const roots = createPiHostServices().discoveryRoots?.().agents;

    // 期望的 core 注入根用与 pi-host.ts 相同的锚点解析（./workflows/* 子入口在
    // workspace 与 npm dist 双形态同径；探针证据见 probe-c5.md P1/P3）
    const require = createRequire(import.meta.url);
    const anchor = require.resolve("@zhushanwen/subagent-core/workflows/README.md");
    const coreParent = dirname(dirname(dirname(anchor)));

    expect(roots).toEqual([
      { dir: join(AGENT_DIR, "agents"), source: "user-pi" },
      { dir: join(AGENT_DIR, "npm", "node_modules"), source: "npm" },
      { dir: join(AGENT_DIR, "extensions"), source: "npm-dev" },
      // C5⑥：core 包一级父目录（npm 槽语义：一级子项 = 包目录，无 pi manifest 扫
      // agents/ 约定目录）；追加在既有 npm 根之后——同标签靠后者胜（新版遮蔽旧残留）
      { dir: coreParent, source: "npm" },
    ]);
  });

  it("agents 第 4 根指向 core 包的父目录（其下 subagent-core/agents/ 存在 10 内置角色）", () => {
    stubAgentDir();
    const roots = createPiHostServices().discoveryRoots?.().agents;
    const coreRoot = roots?.[3];

    expect(coreRoot?.source).toBe("npm");
    // 便捷断言：core 包根（注入 dir 的子目录）下 agents/ 真实存在
    expect(existsSync(join(coreRoot!.dir, "subagent-core", "agents"))).toBe(true);
  });

  it("workflows 四根：与 agents 同构，末级目录名切换为 workflows，第 4 根 core 包父目录（P5 staged 副本入扫描面）", () => {
    stubAgentDir();
    const roots = createPiHostServices().discoveryRoots?.().workflows;

    const require = createRequire(import.meta.url);
    const anchor = require.resolve("@zhushanwen/subagent-core/workflows/README.md");
    const coreParent = dirname(dirname(dirname(anchor)));

    expect(roots).toEqual([
      { dir: join(AGENT_DIR, "workflows"), source: "user-pi" },
      { dir: join(AGENT_DIR, "npm", "node_modules"), source: "npm" },
      { dir: join(AGENT_DIR, "extensions"), source: "npm-dev" },
      // P5：workflows kind 的「刻意不注入」禁区拆除——内置 workflow 随 core 包入
      // 扫描面（P-C6 裁决见 pi-host.ts 注释）
      { dir: coreParent, source: "npm" },
    ]);
  });

  it("workflows 第 4 根下 subagent-core/workflows/ 存在内置 workflow 脚本（可派发前提）", () => {
    stubAgentDir();
    const roots = createPiHostServices().discoveryRoots?.().workflows;
    const coreRoot = roots?.[3];

    expect(coreRoot?.source).toBe("npm");
    expect(existsSync(join(coreRoot!.dir, "subagent-core", "workflows"))).toBe(true);
  });

  it("skills 两根：user-pi + npm，无 npm-dev（对齐 skill-discovery 现状）", () => {
    stubAgentDir();
    const roots = createPiHostServices().discoveryRoots?.().skills;

    expect(roots).toEqual([
      { dir: join(AGENT_DIR, "skills"), source: "user-pi" },
      { dir: join(AGENT_DIR, "npm", "node_modules"), source: "npm" },
    ]);
  });

  it("每次调用现取 getAgentDir（agentDir 变更后根列表跟随，不缓存）", () => {
    stubAgentDir();
    const first = createPiHostServices().discoveryRoots?.().agents;
    const secondCallDir = "/another/agent-dir";
    vi.mocked(getAgentDir).mockReturnValue(secondCallDir);
    const second = createPiHostServices().discoveryRoots?.().agents;

    expect(second?.[0].dir).toBe(join(secondCallDir, "agents"));
    expect(first?.[0].dir).not.toBe(second?.[0].dir);
  });
});

describe("createPiHostServices.discoveryRoots（P5 D4-2 扫描根修正：taiji 态形态感知）", () => {
  const AGENT_DIR = "/fake/data-dir/agent";
  const argvSaved = process.argv;

  function stubAgentDir(): void {
    vi.mocked(getAgentDir).mockReturnValue(AGENT_DIR);
  }

  afterEach(() => {
    process.argv = argvSaved;
  });

  /** taiji 宿主注入态 argv（runtime spawn 主 pi 恒带 --extension staged 全量集）。 */
  function withTaijiArgv(fn: () => void): void {
    process.argv = [
      "node", "/pi",
      "--mode", "rpc",
      "--extension", "/staged/resources/extensions/@zhushanwen/pi-subagent-workflow",
    ];
    fn();
  }

  it("taiji 态：npm/npm-dev 根改指 agentDir 父目录（= dataDir，实际安装目录）", () => {
    stubAgentDir();
    withTaijiArgv(() => {
      const roots = createPiHostServices().discoveryRoots?.();
      const installBase = dirname(AGENT_DIR); // /fake/data-dir

      // agents kind
      expect(roots?.agents).toEqual([
        { dir: join(AGENT_DIR, "agents"), source: "user-pi" },
        { dir: join(installBase, "npm", "node_modules"), source: "npm" },
        { dir: join(installBase, "extensions"), source: "npm-dev" },
        expect.objectContaining({ source: "npm" }), // core 根（锚点解析，见独立态用例）
      ]);
      // workflows kind（core 根注入同理）
      expect(roots?.workflows?.slice(0, 3)).toEqual([
        { dir: join(AGENT_DIR, "workflows"), source: "user-pi" },
        { dir: join(installBase, "npm", "node_modules"), source: "npm" },
        { dir: join(installBase, "extensions"), source: "npm-dev" },
      ]);
    });
  });

  it("独立态：npm/npm-dev 根保留 getAgentDir() 派生的 pi 语义根（现状不变）", () => {
    stubAgentDir();
    process.argv = ["node", "/pi", "--mode", "rpc"];
    const roots = createPiHostServices().discoveryRoots?.();

    expect(roots?.agents?.slice(0, 3)).toEqual([
      { dir: join(AGENT_DIR, "agents"), source: "user-pi" },
      { dir: join(AGENT_DIR, "npm", "node_modules"), source: "npm" },
      { dir: join(AGENT_DIR, "extensions"), source: "npm-dev" },
    ]);
    expect(roots?.workflows?.slice(0, 3)).toEqual([
      { dir: join(AGENT_DIR, "workflows"), source: "user-pi" },
      { dir: join(AGENT_DIR, "npm", "node_modules"), source: "npm" },
      { dir: join(AGENT_DIR, "extensions"), source: "npm-dev" },
    ]);
  });

  it("user-pi 根两形态同指 agentDir（taiji 态布局迁移不动 user 级语义）", () => {
    stubAgentDir();
    withTaijiArgv(() => {
      expect(createPiHostServices().discoveryRoots?.().workflows?.[0]).toEqual({
        dir: join(AGENT_DIR, "workflows"),
        source: "user-pi",
      });
    });
  });
});

describe("createPiHostServices.dataRoot（每次现取 getAgentDir）", () => {
  it("返回 getAgentDir() 本身（env 覆盖段与 warn-once 留 core data-dir）", () => {
    vi.mocked(getAgentDir).mockReturnValue("/data/root");
    expect(createPiHostServices().dataRoot()).toBe("/data/root");
  });

  it("PI_CODING_AGENT_DIR 切换后重取生效（实例隔离，无模块级缓存）", () => {
    // 恢复 mock 工厂的 env 语义实现（其他用例的 mockReturnValue 会覆盖它）
    vi.mocked(getAgentDir).mockImplementation(
      () => process.env.PI_CODING_AGENT_DIR ?? "/mock/default/agent-dir",
    );
    process.env.PI_CODING_AGENT_DIR = "/instance-a";
    const host = createPiHostServices();
    expect(host.dataRoot()).toBe("/instance-a");

    process.env.PI_CODING_AGENT_DIR = "/instance-b";
    expect(host.dataRoot()).toBe("/instance-b");
  });

  it("透传 getAgentDir 调用（不缓存结果、不吞调用）", () => {
    vi.mocked(getAgentDir).mockReturnValue("/d1");
    const host = createPiHostServices();
    host.dataRoot();
    host.dataRoot();
    expect(vi.mocked(getAgentDir)).toHaveBeenCalledTimes(2);
  });
});

describe("createPiHostServices.log（桥接 pi-extension-logger）", () => {
  function stubLogger(): { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
    const fake = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(getLogger).mockReturnValue(fake);
    return fake;
  }

  it("debug level → logger.debug，(message, data) 透传", () => {
    const fake = stubLogger();
    createPiHostServices().log("debug", "subagents", "d-msg", { k: 1 });

    expect(vi.mocked(getLogger)).toHaveBeenCalledWith("subagents");
    expect(fake.debug).toHaveBeenCalledWith("d-msg", { k: 1 });
    expect(fake.warn).not.toHaveBeenCalled();
    expect(fake.error).not.toHaveBeenCalled();
  });

  it("warn level → logger.warn；error level → logger.error", () => {
    const fake = stubLogger();
    const host = createPiHostServices();

    host.log("warn", "comp-a", "w-msg");
    host.log("error", "comp-b", "e-msg", { reason: "x" });

    expect(fake.warn).toHaveBeenCalledWith("w-msg", undefined);
    expect(fake.error).toHaveBeenCalledWith("e-msg", { reason: "x" });
    expect(vi.mocked(getLogger)).toHaveBeenNthCalledWith(1, "comp-a");
    expect(vi.mocked(getLogger)).toHaveBeenNthCalledWith(2, "comp-b");
  });
});

describe("resolveGrandchildExtensionPaths / createPiHostServices.extensionPaths（[D2] 双形态注入源）", () => {
  const argvSaved = process.argv;

  function withArgv(argv: string[], fn: () => void): void {
    process.argv = argv;
    try {
      fn();
    } finally {
      process.argv = argvSaved;
    }
  }

  it("宿主形态：主进程 argv --extension 全量（extension-service 下发集）→ 白名单收窄仅 structured-output", () => {
    // taiji 宿主形态：runtime spawn 主 pi 时 --extension = getExtensionPaths 全量 staged 集
    const argv = [
      "node", "/pi",
      "--mode", "rpc", "--no-extensions", "--approve",
      "--extension", "/staged/resources/extensions/@zhushanwen/pi-subagent-workflow",
      "--extension=/staged/resources/extensions/@zhushanwen/pi-structured-output",
      "--extension", "/staged/resources/extensions/@zhushanwen/pi-goal",
      "--extension", "/staged/resources/extensions/@zhushanwen/pi-structured-output/index.js",
    ];
    expect(resolveGrandchildExtensionPaths(argv, () => undefined)).toEqual([
      "/staged/resources/extensions/@zhushanwen/pi-structured-output",
      "/staged/resources/extensions/@zhushanwen/pi-structured-output/index.js",
    ]);
  });

  it("宿主形态 dev 源码布局：extensions/universal/structured-output（目录与入口文件形态）命中收窄集", () => {
    // dev 下 runtime extension-service 下发的是源码目录（无 @zhushanwen scope 段）——
    // L4 A1 根因回归锁：白名单须识别 dev 源码布局别名段，否则孙进程扩展集恒空。
    const argv = [
      "node", "/pi",
      "--mode", "rpc", "--no-extensions", "--approve",
      "--extension", "/repo/extensions/universal/subagent-workflow",
      "--extension", "/repo/extensions/universal/structured-output",
      "--extension", "/repo/extensions/universal/structured-output/index.js",
      "--extension", "/repo/extensions/taiji/system-prompt",
    ];
    expect(resolveGrandchildExtensionPaths(argv, () => undefined)).toEqual([
      "/repo/extensions/universal/structured-output",
      "/repo/extensions/universal/structured-output/index.js",
    ]);
  });

  it("宿主形态 dev 布局形似误报不命中（尾段同名前缀目录 / 同名异分组不误收）", () => {
    const argv = [
      "node", "/pi",
      "--mode", "rpc",
      "--extension", "/repo/extensions/universal/structured-output-lookalike",
      "--extension", "/some/other/structured-output",
      "--extension", "/repo/extensions/universal/structured-output-extra/index.js",
    ];
    expect(resolveGrandchildExtensionPaths(argv, () => undefined)).toEqual([]);
  });

  it("宿主形态解析不误吃其他 flag 值（--skill 值被跳过、真 flag 不吃值、单 - 路径是值）", () => {
    const argv = [
      "node", "/pi",
      "--mode", "rpc",
      "--skill", "@zhushanwen/pi-structured-output-skill-lookalike",
      "--extension", "--approve", // 后跟真 flag 不吃值
      "--extension", "-weird-dir/@zhushanwen/pi-structured-output", // 单 - 开头路径是值（原 MF-7a）
      "some positional prompt",
    ];
    expect(resolveGrandchildExtensionPaths(argv, () => undefined)).toEqual([
      "-weird-dir/@zhushanwen/pi-structured-output",
    ]);
  });

  it("独立形态：argv 无 --extension → optional peerDep sibling 解析回退（resolvePeer 命中）", () => {
    expect(resolveGrandchildExtensionPaths(["node", "/pi", "--mode", "rpc"], () => "/npm/node_modules/@zhushanwen/pi-structured-output")).toEqual([
      "/npm/node_modules/@zhushanwen/pi-structured-output",
    ]);
  });

  it("独立形态真实解析链：workspace 布局下 peerDep sibling 可解析（createRequire 实测命中包根）", () => {
    withArgv(["node", "/pi", "--mode", "rpc"], () => {
      const paths = createPiHostServices().extensionPaths?.();
      expect(paths).toHaveLength(1);
      // workspace 布局下 pnpm symlink 解析到源目录（目录名 structured-output，
      // 无 @zhushanwen 段——npm 安装形态则命中 node_modules/@zhushanwen/… 布局）
      expect(paths![0]).toMatch(/structured-output$/);
    });
  });

  it("双源皆空（argv 无 --extension + peerDep 未安装）→ 空数组不炸", () => {
    expect(resolveGrandchildExtensionPaths(["node", "/pi", "--mode", "rpc"], () => undefined)).toEqual([]);
  });

  it("惰性求值：每次调用现解析（argv 变更后结果跟随，configureCore 只挂函数引用）", () => {
    const host = createPiHostServices();
    withArgv(["node", "/pi", "--mode", "rpc"], () => {
      expect(host.extensionPaths?.()).not.toContain("/staged/x");
    });
    withArgv(["node", "/pi", "--extension", "/staged/@zhushanwen/pi-structured-output"], () => {
      expect(host.extensionPaths?.()).toEqual(["/staged/@zhushanwen/pi-structured-output"]);
    });
  });
});

describe("createPiNotifyDomainPorts.countActiveFromEntries（适配读 .count）", () => {
	it("拆 CountActiveResult.count 为 number（core 端口契约），entries 透传（缺省过滤基准 undefined = 不过滤）", () => {
		const entries: unknown[] = [{ customType: "pending:register" }];
		vi.mocked(countActiveFromEntries).mockReturnValue({ count: 3, ids: ["a", "b", "c"], entries: [] });

		const result = createPiNotifyDomainPorts().countActiveFromEntries?.(entries);

		expect(result).toBe(3);
		// [W4 读侧过滤②] 端口适配恒透传过滤基准 opts（缺省 undefined = 不过滤，
		// 既有调用方零改动行为不变）。
		expect(vi.mocked(countActiveFromEntries)).toHaveBeenCalledWith(entries, { currentSessionId: undefined });
	});

	it("[W4 读侧过滤② / F1] 调用时传 currentSessionId（per-call 基准）→ 透传差集过滤基准", () => {
		const entries: unknown[] = [{ customType: "pending:register" }];
		vi.mocked(countActiveFromEntries).mockReturnValue({ count: 1, ids: ["a"], entries: [] });

		createPiNotifyDomainPorts().countActiveFromEntries?.(entries, { currentSessionId: "sess-child" });

		expect(vi.mocked(countActiveFromEntries)).toHaveBeenCalledWith(entries, { currentSessionId: "sess-child" });
	});

	it("零活跃返回 0（{count: 0} 形状）", () => {
		vi.mocked(countActiveFromEntries).mockReturnValue({ count: 0, ids: [], entries: [] });
		expect(createPiNotifyDomainPorts().countActiveFromEntries?.([])).toBe(0);
	});
});

describe("createPiNotifyDomainPorts.createDelivery（透传 session-delivery）", () => {
  it("参数透传 + 返回句柄透传（不经包装）", () => {
    const fakePort = {
      supportedPayloads: ["text"] as const,
      isIdle: () => true,
      hasPendingMessages: () => false,
      send: () => undefined,
    };
    const fakeConfig = { intent: "after-run" as const };
    const fakeHandle = { send: () => {}, flush: () => {}, dispose: () => {} };
    vi.mocked(createDelivery).mockReturnValue(fakeHandle);

    const result = createPiNotifyDomainPorts().createDelivery?.(fakePort, fakeConfig);

    expect(vi.mocked(createDelivery)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDelivery).mock.calls[0][0]).toBe(fakePort);
    expect(vi.mocked(createDelivery).mock.calls[0][1]).toBe(fakeConfig);
    expect(result).toBe(fakeHandle);
  });
});

// ──────────────────────────────────────────────────────────────
// P5 staged workflows 入扫描面（端到端）：taiji 态 roots → discoverResources
// 验收条款 b：location 可派发（<location> = 真实存在的脚本路径）+ 同环境两次
// 扫描 location 形态确定（P-C6 裁决「实际路径直渲染」的稳定性构造性证据）。
// ──────────────────────────────────────────────────────────────

describe("P5 staged workflows 入扫描面（端到端）", () => {
  const AGENT_DIR = "/fake/data-dir/agent";
  const argvSaved = process.argv;
  let ws: string;

  function taijiWorkflowsRoots(): ReturnType<NonNullable<ReturnType<typeof createPiHostServices>["discoveryRoots"]>["workflows"]> {
    vi.mocked(getAgentDir).mockReturnValue(AGENT_DIR);
    process.argv = [
      "node", "/pi",
      "--mode", "rpc",
      "--extension", "/staged/resources/extensions/@zhushanwen/pi-subagent-workflow",
    ];
    return createPiHostServices().discoveryRoots?.().workflows ?? [];
  }

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "pihost-p5-ws-"));
  });

  afterEach(() => {
    process.argv = argvSaved;
    rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    clearFileCache();
  });

  it("内置 workflow 条目被发现且 path 指向真实存在的脚本（location 可派发）", async () => {
    const discovered = await discoverResources({
      kind: "workflows",
      workspaceRoot: ws,
      hostRoots: taijiWorkflowsRoots(),
      includeTmp: true,
    });

    const builtin = discovered.filter((r) => r.path.includes("subagent-core/workflows"));
    expect(builtin.length).toBeGreaterThan(0);
    for (const r of builtin) {
      expect(r.available).toBe(true);
      // <location> 渲染源 = r.path——可派发 = 文件真实存在
      expect(existsSync(r.path)).toBe(true);
      expect(r.path.endsWith(".js")).toBe(true);
    }
    // 内置代表脚本（review-fix-loop = workflow 域核心脚本）在扫描面内
    expect(builtin.some((r) => r.path.endsWith("review-fix-loop.js"))).toBe(true);
  });

  it("同环境两次扫描（含缓存清空重建）location 形态确定（字节稳定断言）", async () => {
    const scan = (): Promise<ReturnType<typeof discoverResources>> =>
      discoverResources({
        kind: "workflows",
        workspaceRoot: ws,
        hostRoots: taijiWorkflowsRoots(),
        includeTmp: true,
      });

    const first = await scan();
    clearFileCache(); // 强制重建（不走 mtime/workspaceRoot 缓存——重建路径也确定）
    const second = await scan();

    // readdir 枚举序无契约（discoverResources 返回按扫描插入序）——确定性断言
    // 以 path 排序投影比较（条目集合与形态稳定，序不在契约内）
    const sorted = (rs: Awaited<ReturnType<typeof discoverResources>>) =>
      rs.map((r) => ({ path: r.path, source: r.source, available: r.available })).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(sorted(second)).toEqual(sorted(first));
    const builtinPaths = first
      .filter((r) => r.path.includes("subagent-core/workflows"))
      .map((r) => r.path)
      .sort();
    // 同环境两次扫描的 <location> 渲染源逐字节一致（staged 路径在 session 内不变——
    // KV-cache 契约的构造性证据，P-C6 裁决「实际路径直渲染」的稳定性前提）
    expect(
      second.filter((r) => r.path.includes("subagent-core/workflows")).map((r) => r.path).sort(),
    ).toEqual(builtinPaths);
  });
});

afterAll(() => {
  rmSync(mockHomeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

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
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@taiji/session-delivery", () => sessionDeliveryMock);

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";
import { createDelivery } from "@taiji/session-delivery";

import { createPiHostServices, createPiNotifyDomainPorts } from "../pi-host.ts";

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

  function stubAgentDir(): void {
    vi.mocked(getAgentDir).mockReturnValue(AGENT_DIR);
  }

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

  it("workflows 三根：与 agents 同构，末级目录名切换为 workflows", () => {
    stubAgentDir();
    const roots = createPiHostServices().discoveryRoots?.().workflows;

    expect(roots).toEqual([
      { dir: join(AGENT_DIR, "workflows"), source: "user-pi" },
      { dir: join(AGENT_DIR, "npm", "node_modules"), source: "npm" },
      { dir: join(AGENT_DIR, "extensions"), source: "npm-dev" },
    ]);
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

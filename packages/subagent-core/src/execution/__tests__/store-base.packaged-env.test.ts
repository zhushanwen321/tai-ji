/**
 * 打包态 pi 进程 env 形态回归（C-ext-31，2026-10-19 打包版 subagent 全灭事故）。
 *
 * 事故形态：打包态 pi/引擎进程持有 TAIJI_AGENT_DATA_DIR=<homedir>/.taiji（入站白名单
 * 放行）但没有 TAIJI_AGENT_PACKAGED（C-proc-09 出站 deny 清单剥除）——shared paths.ts
 * 的 C-proc-26 准入检查在该 env 组合下必抛，session_start 装配链断裂、subagent 全灭。
 * 本用例锁定的行为：同样的 env 组合下，subagent-core 的目录推导（store-base 通道 →
 * 纯公式模块）正常返回路径而不抛错。
 *
 * 全部用例只做字符串推导断言，不触 fs（不读写任何真实数据目录）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { resolveSessionStoreBase } from "../assembly/store-base.ts";
import {
	clearPiWorkflowRootSessionId,
	resolvePiWorkflowRunsDir,
	setPiWorkflowRootSessionId,
} from "../assembly/workflow-state-root.ts";

/** 复刻打包态 pi 进程 env：prod 数据目录值在场 + 打包标志被 C-proc-09 剥除。 */
function stubPackagedPiEnv(): string {
	const prodDataDir = join(homedir(), ".taiji");
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", prodDataDir);
	vi.stubEnv("TAIJI_AGENT_PACKAGED", "");
	return prodDataDir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	clearPiWorkflowRootSessionId();
});

describe("打包态 pi 进程 env 形态下 store-base 通道（C-ext-31 回归）", () => {
	it("resolveSessionStoreBase：TAIJI_AGENT_DATA_DIR 优先于缺省通道，prod 值直接采信（无准入检查）", () => {
		const prodDataDir = stubPackagedPiEnv();
		expect(resolveSessionStoreBase()).toBe(prodDataDir);
	});

	it("显式 dataDir 入参恒优先（runtime 侧调用形态不受 env 影响）", () => {
		stubPackagedPiEnv();
		expect(resolveSessionStoreBase("/tmp/whatever-data-root")).toBe("/tmp/whatever-data-root");
	});

	it("getSubagentSessionDir / getSubagentRecordsDir：同一 env 组合下正常返回存储树路径（事故形态必抛的对照面）", () => {
		const prodDataDir = stubPackagedPiEnv();
		const sid = "01a15769-1221-70d8-b7f2-0f3d62cef993";
		expect(getSubagentSessionDir(sid)).toBe(
			join(prodDataDir, "ext-sessions", sid, "subagents", "sessions"),
		);
		expect(getSubagentRecordsDir(sid)).toBe(
			join(prodDataDir, "ext-sessions", sid, "subagents", "records"),
		);
	});

	it("resolvePiWorkflowRunsDir：显式 sid 与进程级锚两形态均正常解析（session_start 装配链入口）", () => {
		const prodDataDir = stubPackagedPiEnv();
		const sid = "01a15769-1221-70d8-b7f2-0f3d62cef993";
		expect(resolvePiWorkflowRunsDir(sid)).toBe(
			join(prodDataDir, "ext-sessions", sid, "workflow", "runs"),
		);
		setPiWorkflowRootSessionId(sid);
		expect(resolvePiWorkflowRunsDir()).toBe(
			join(prodDataDir, "ext-sessions", sid, "workflow", "runs"),
		);
	});
});

describe("对照面：shared env 缺省形态在同一 env 组合下 fail-fast（通道隔离的存在理由）", () => {
	it("shared getDataDir 在打包态 pi env 组合下 throw（C-proc-26 准入检查）——证明两条通道确实隔离", async () => {
		stubPackagedPiEnv();
		const { getDataDir } = await import("@taiji/shared/paths");
		expect(() => getDataDir()).toThrow(/prod-admission guard/);
	});
});

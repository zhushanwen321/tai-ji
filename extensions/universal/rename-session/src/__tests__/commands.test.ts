import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import { executeAutoRenameCommand } from "../commands.js";

/**
 * executeAutoRenameCommand 读写 `<agentDir>/config/rename-session-ext-config.json`（经 llm-shared loadConfig/saveConfig，
 * 路径走 getAgentDir）。用 PI_CODING_AGENT_DIR 隔离到临时目录，避免读写真实 ~/.pi/agent。
 * 每次写入后 clearConfigCache 确保读盘（不命中 mtime 缓存），验证真实落盘行为。
 */
describe("executeAutoRenameCommand", () => {
	let tmpAgentDir: string;
	let origEnv: string | undefined;

	beforeEach(() => {
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-cmd-"));
		origEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		clearConfigCache();
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = origEnv;
		clearConfigCache();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	function configPath(): string {
		return path.join(tmpAgentDir, "config", "rename-session-ext-config.json");
	}

	it("无参数 → 显示当前状态（默认关闭）+ 用法", () => {
		const msg = executeAutoRenameCommand("");
		expect(msg).toContain("自动重命名会话");
		expect(msg).toContain("已关闭");
		expect(msg).toContain("用法");
	});

	it("status → 同无参数", () => {
		expect(executeAutoRenameCommand("status")).toContain("已关闭");
	});

	it("on → 创建 flag 文件（不写 config，避免残留 enabled=true）", () => {
		const msg = executeAutoRenameCommand("on");
		expect(msg).toContain("已开启");
		// 开启走 flag 契约（live 覆盖源），不落 config
		expect(fs.existsSync(path.join(tmpAgentDir, "auto-rename-enabled"))).toBe(true);
		expect(fs.existsSync(configPath())).toBe(false);
	});

	it("on 后 status 显示已开启（缓存一致，无需 clearConfigCache）", () => {
		executeAutoRenameCommand("on");
		expect(executeAutoRenameCommand("status")).toContain("已开启");
	});

	it("off → 写 config.enabled=false 落盘 + 删除 flag（双写同步）", () => {
		executeAutoRenameCommand("on");
		const msg = executeAutoRenameCommand("off");
		expect(msg).toContain("已关闭");
		clearConfigCache();
		const raw = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
		expect(raw.enabled).toBe(false);
		expect(fs.existsSync(path.join(tmpAgentDir, "auto-rename-enabled"))).toBe(false);
	});

	it("enable/disable 作为 on/off 别名", () => {
		executeAutoRenameCommand("enable");
		clearConfigCache();
		expect(executeAutoRenameCommand("status")).toContain("已开启");
		executeAutoRenameCommand("disable");
		clearConfigCache();
		expect(executeAutoRenameCommand("status")).toContain("已关闭");
	});

	it("大小写不敏感（ON / Off）", () => {
		executeAutoRenameCommand("ON");
		clearConfigCache();
		expect(executeAutoRenameCommand("status")).toContain("已开启");
		executeAutoRenameCommand("Off");
		clearConfigCache();
		expect(executeAutoRenameCommand("status")).toContain("已关闭");
	});

	it("未知参数 → 提示用法", () => {
		const msg = executeAutoRenameCommand("foo");
		expect(msg).toContain("未知参数");
		expect(msg).toContain("用法");
	});

	it("on 不动 config（手写 enabled/model/maxTitleLength 均保留）", () => {
		// 预置含自定义 model + maxTitleLength 的配置
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ enabled: false, model: { type: "ref", ref: "a/b" }, maxTitleLength: 30 }),
		);
		clearConfigCache();

		executeAutoRenameCommand("on");
		clearConfigCache();

		// on 只建 flag，config 原封不动（enabled 仍 false，但 loadRenameConfig 被 flag 覆盖为 true）
		const raw = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
		expect(raw.enabled).toBe(false);
		expect(raw.model).toEqual({ type: "ref", ref: "a/b" });
		expect(raw.maxTitleLength).toBe(30);
		expect(executeAutoRenameCommand("status")).toContain("已开启");
	});
});

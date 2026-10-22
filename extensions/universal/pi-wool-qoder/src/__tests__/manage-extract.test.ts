// manage-extract.test.ts — extract 管理动作接线测试（vi.mock 凭据模块 auth.ts →
// 经注册的 wool-qoder 命令发 envelope → 断言响应契约字段）。契约本体（提取链/
// userinfo 降级/采纳缓存）由 auth.test.ts 的 extractToAcquireData 直测覆盖。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

/** fixture 凭据获取响应（假令牌——凭据值绝不入测试 fixture 红线）。 */
const acquireFixture = {
	credentials: { apiKey: "dt-fixture-access-token-000", refreshToken: "drt-fixture-refresh-token-00" },
	account: { displayName: "fixture@example.com" },
	expiresAt: 1763624866000,
};

vi.mock("../auth.ts", () => ({
	login: vi.fn(),
	makeGetApiKey: vi.fn(() => (credentials: { access?: string }) => credentials.access ?? ""),
	refreshToken: vi.fn(),
	adoptRequestApiKey: vi.fn(async () => undefined),
	extractToAcquireData: vi.fn(async () => acquireFixture),
}));

import piWoolQoder from "../index.ts";
import { extractToAcquireData } from "../auth.ts";

type CommandOptions = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

/** 最小 pi 替身：捕获管理命令 handler 与 appendEntry 回写。 */
function fakePi() {
	const commands = new Map<string, CommandOptions>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const api = {
		on: () => undefined,
		registerProvider: () => undefined,
		registerCommand: (name: string, options: CommandOptions) => {
			commands.set(name, options);
		},
		appendEntry: (type: string, data?: unknown) => {
			entries.push({ type, data });
		},
	};
	return { api: api as unknown as ExtensionAPI, commands, entries };
}

function lastResponse(mock: ReturnType<typeof fakePi>): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
	const last = mock.entries.filter((entry) => entry.type === "wool-manage-response").at(-1);
	return (last?.data as { response: { ok: boolean; data?: unknown; error?: { code: string; message: string } } }).response;
}

describe("extract 管理动作接线（wool-qoder 命令通道）", () => {
	it("action=extract → extractToAcquireData 执行一次，契约 data 原样回写 envelope", async () => {
		const mock = fakePi();
		piWoolQoder(mock.api);
		const command = mock.commands.get("wool-qoder");
		expect(command).toBeDefined();
		await command!.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext);
		expect(extractToAcquireData).toHaveBeenCalledTimes(1);
		expect(lastResponse(mock)).toEqual({ v: 1, ok: true, data: acquireFixture });
	});

	it("提取失败 → envelope ok:false internal（消息透传，命令不外抛）", async () => {
		const mock = fakePi();
		piWoolQoder(mock.api);
		vi.mocked(extractToAcquireData).mockRejectedValueOnce(new Error("qoder extract: keychain read failed"));
		const command = mock.commands.get("wool-qoder");
		await expect(command!.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext)).resolves.toBeUndefined();
		const response = lastResponse(mock);
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.error.code).toBe("internal");
			expect(response.error.message).toContain("keychain read failed");
		}
	});

	it("action=authorize（ide-extract 家族未实现）→ invalid_request 不支持响应", async () => {
		const mock = fakePi();
		piWoolQoder(mock.api);
		const command = mock.commands.get("wool-qoder");
		await command!.handler('{"v":1,"action":"authorize"}', {} as ExtensionCommandContext);
		const response = lastResponse(mock);
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.error.code).toBe("invalid_request");
			expect(response.error.message).toContain("authorize");
		}
	});
});

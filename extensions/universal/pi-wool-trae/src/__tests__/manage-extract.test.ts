// manage-extract.test.ts — Trae extract 管理动作接线测试（vi.mock 凭据模块
// byte-crypto → 经注册的 wool-trae 命令发 envelope → 断言响应契约字段）。
// 提取链本体（容器解密/设备要素）由 byte-crypto.test.ts 覆盖；凭据双形态解析由
// credential-resolve.test.ts 覆盖（不经模块 mock）。fixture 全部为合成假令牌。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { TRAE_FIXTURE_LOGIN } from "./helpers/trae-container-fixture.ts";

/** extract 动作的 fixture 响应（假令牌）。 */
const acquireFixture = {
	credentials: {
		apiKey: TRAE_FIXTURE_LOGIN.token,
		refreshToken: TRAE_FIXTURE_LOGIN.refreshToken,
	},
	expiresAt: Date.parse(TRAE_FIXTURE_LOGIN.expiredAt),
};

vi.mock("../byte-crypto.ts", () => {
	class TraeContainerError extends Error {}
	return {
		extractTraeLogin: vi.fn(() => ({
			login: TRAE_FIXTURE_LOGIN,
			device: { machineId: "fixture-machine-id", soloDeviceId: "4242424242424242" },
		})),
		detectTraeLoginState: vi.fn(() => true),
		TRAE_EXTRACT_RECOVERY_HINT: "Open Trae IDE and sign in again, then retry the extraction.",
		TraeContainerError,
	};
});

const { default: piWoolTrae } = await import("../index.ts");
const { extractTraeLogin } = await import("../byte-crypto.ts");

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

describe("extract 管理动作接线（wool-trae 命令通道）", () => {
	it("action=extract → 提取链执行一次，契约 data（JWT 作 apiKey）回写 envelope", async () => {
		const mock = fakePi();
		piWoolTrae(mock.api);
		const command = mock.commands.get("wool-trae");
		expect(command).toBeDefined();
		await command!.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext);
		expect(extractTraeLogin).toHaveBeenCalledTimes(1);
		expect(lastResponse(mock)).toEqual({ v: 1, ok: true, data: acquireFixture });
	});

	it("提取失败（IDE 未装/未登录）→ envelope ok:false internal（消息透传，命令不外抛）", async () => {
		const mock = fakePi();
		piWoolTrae(mock.api);
		vi.mocked(extractTraeLogin).mockImplementationOnce(() => {
			throw new Error("no login container found in storage.json");
		});
		const command = mock.commands.get("wool-trae");
		await expect(command!.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext)).resolves.toBeUndefined();
		const response = lastResponse(mock);
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.error.code).toBe("internal");
			expect(response.error.message).toContain("no login container");
		}
	});

	it("action=authorize（ide-extract 家族未实现）→ invalid_request 不支持响应", async () => {
		const mock = fakePi();
		piWoolTrae(mock.api);
		const command = mock.commands.get("wool-trae");
		await command!.handler('{"v":1,"action":"authorize"}', {} as ExtensionCommandContext);
		const response = lastResponse(mock);
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.error.code).toBe("invalid_request");
			expect(response.error.message).toContain("authorize");
		}
	});
});

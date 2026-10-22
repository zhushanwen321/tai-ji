// manage-protocol.test.ts — 管理指令 envelope 编解码、守卫与命令注册接线。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	isWoolManageResponse,
	parseWoolManageRequest,
	registerWoolManageCommand,
	woolManageCommandName,
	woolManageFail,
	woolManageOk,
	WOOL_MANAGE_ACTIONS,
	WOOL_MANAGE_ENTRY_TYPE,
	WoolManageRequestError,
	type WoolManageResponse,
} from "../manage-protocol.ts";

describe("envelope 解码", () => {
	it("合法请求解析出动作与参数", () => {
		const request = parseWoolManageRequest('{"v":1,"action":"status"}', "qoder");
		expect(request).toEqual({ v: 1, action: "status" });

		const withParams = parseWoolManageRequest('{"v":1,"action":"checkin","params":{"day":"2026-10-21"}}', "trae");
		expect(withParams.params).toEqual({ day: "2026-10-21" });
	});

	it("全部动作词表可解析", () => {
		for (const action of WOOL_MANAGE_ACTIONS) {
			const request = parseWoolManageRequest(JSON.stringify({ v: 1, action }), "workbuddy");
			expect(request.action).toBe(action);
		}
	});

	it.each([
		["空参数", ""],
		["非 JSON", "not json"],
		["非对象", "[1,2]"],
		["版本不符", '{"v":2,"action":"status"}'],
		["动作未知", '{"v":1,"action":"deploy"}'],
		["params 非对象", '{"v":1,"action":"status","params":"x"}'],
	])("非法形态 %s 抛 invalid_request 错误并内嵌用法", (_label, raw) => {
		try {
			parseWoolManageRequest(raw, "qoder");
			expect.unreachable("expected WoolManageRequestError");
		} catch (error) {
			expect(error).toBeInstanceOf(WoolManageRequestError);
			const requestError = error as WoolManageRequestError;
			expect(requestError.code).toBe("invalid_request");
			expect(requestError.message).toContain("/wool-qoder");
		}
	});
});

describe("响应 envelope", () => {
	it("成功/失败形态构造", () => {
		expect(woolManageOk({ loggedIn: true })).toEqual({ v: 1, ok: true, data: { loggedIn: true } });
		const failure = woolManageFail("not_logged_in", "no credential");
		expect(failure).toEqual({ v: 1, ok: false, error: { code: "not_logged_in", message: "no credential" } });
	});

	it.each([
		["成功形态", woolManageOk(null), true],
		["失败形态", woolManageFail("internal", "boom"), true],
		["版本缺失", { ok: true, data: 1 }, false],
		["ok 缺失", { v: 1, data: 1 }, false],
		["错误缺消息", { v: 1, ok: false, error: { code: "internal" } }, false],
		["非对象", "ok", false],
	])("isWoolManageResponse：%s", (_label, value, expected) => {
		expect(isWoolManageResponse(value)).toBe(expected);
	});
});

describe("命令注册接线", () => {
	function mockPi() {
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
		const entries: Array<{ type: string; data: unknown }> = [];
		const pi = {
			registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
				commands.set(name, options);
			},
			appendEntry: (type: string, data?: unknown) => {
				entries.push({ type, data });
			},
		} as unknown as ExtensionAPI;
		return { pi, commands, entries };
	}

	it("按家族注册命令名 wool-<family>", () => {
		const { pi, commands } = mockPi();
		registerWoolManageCommand(pi, {
			family: "qoder",
			handlers: { status: async () => ({}), detect: async () => ({}), checkin: async () => ({}), clear: async () => ({}) },
		});
		expect(commands.has(woolManageCommandName("qoder"))).toBe(true);
		expect(woolManageCommandName("qoder")).toBe("wool-qoder");
	});

	it("handler 执行成功 → appendEntry 写 ok 响应", async () => {
		const { pi, commands, entries } = mockPi();
		registerWoolManageCommand(pi, {
			family: "trae",
			handlers: {
				status: async () => ({ loggedIn: true }),
				detect: async () => ({}),
				checkin: async () => ({}),
				clear: async () => ({}),
			},
		});
		const command = commands.get("wool-trae");
		expect(command).toBeDefined();
		await command?.handler('{"v":1,"action":"status"}', {} as ExtensionCommandContext);
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe(WOOL_MANAGE_ENTRY_TYPE);
		const response = (entries[0].data as { response: WoolManageResponse }).response;
		expect(isWoolManageResponse(response)).toBe(true);
		expect(response).toEqual({ v: 1, ok: true, data: { loggedIn: true } });
	});

	it("handler throw → appendEntry 写 ok:false（internal 码），命令不向外抛异常", async () => {
		const { pi, commands, entries } = mockPi();
		registerWoolManageCommand(pi, {
			family: "workbuddy",
			handlers: {
				status: async () => {
					throw new Error("upstream 502");
				},
				detect: async () => ({}),
				checkin: async () => ({}),
				clear: async () => ({}),
			},
		});
		const command = commands.get("wool-workbuddy");
		await expect(command?.handler('{"v":1,"action":"status"}', {} as ExtensionCommandContext)).resolves.toBeUndefined();
		const data = entries[0]?.data as { response: WoolManageResponse };
		expect(data.response).toEqual({ v: 1, ok: false, error: { code: "internal", message: "upstream 502" } });
	});

	it("envelope 非法 → appendEntry 写 invalid_request 失败响应", async () => {
		const { pi, commands, entries } = mockPi();
		registerWoolManageCommand(pi, {
			family: "qoder",
			handlers: { status: async () => ({}), detect: async () => ({}), checkin: async () => ({}), clear: async () => ({}) },
		});
		const command = commands.get("wool-qoder");
		await command?.handler("garbage", {} as ExtensionCommandContext);
		const data = entries[0]?.data as { response: WoolManageResponse };
		expect(data.response.ok).toBe(false);
		if (!data.response.ok) {
			expect(data.response.error.code).toBe("invalid_request");
		}
	});

	it("extract/authorize 分发：handler 返回值原样进 data（凭据获取动作通道）", async () => {
		const { pi, commands, entries } = mockPi();
		const acquireData = {
			credentials: { apiKey: "dt-fixture-token", refreshToken: "drt-fixture-refresh" },
			account: { displayName: "fixture-user" },
			expiresAt: 1735689600000,
		};
		registerWoolManageCommand(pi, {
			family: "qoder",
			handlers: {
				status: async () => ({}),
				detect: async () => ({}),
				checkin: async () => ({}),
				clear: async () => ({}),
				extract: async () => acquireData,
			},
		});
		const command = commands.get("wool-qoder");
		await command?.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext);
		const data = entries[0]?.data as { response: WoolManageResponse };
		expect(data.response).toEqual({ v: 1, ok: true, data: acquireData });
	});

	it("家族未实现的动作 → invalid_request（明确报不支持，不静默假成功）", async () => {
		const { pi, commands, entries } = mockPi();
		registerWoolManageCommand(pi, {
			family: "workbuddy",
			handlers: {
				status: async () => ({}),
				detect: async () => ({}),
				checkin: async () => ({}),
				clear: async () => ({}),
				authorize: async () => ({ credentials: { apiKey: "fixture-access" } }),
			},
		});
		const command = commands.get("wool-workbuddy");
		await command?.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext);
		const data = entries[0]?.data as { response: WoolManageResponse };
		expect(data.response.ok).toBe(false);
		if (!data.response.ok) {
			expect(data.response.error.code).toBe("invalid_request");
			expect(data.response.error.message).toContain('"extract" is not supported');
		}
	});

	it("handler ctx.notify 透传（授权页 URL 投递通道：ctx.ui.notify 投影）", async () => {
		const { pi, commands } = mockPi();
		const notices: Array<{ message: string; type?: string }> = [];
		registerWoolManageCommand(pi, {
			family: "workbuddy",
			handlers: {
				status: async () => ({}),
				detect: async () => ({}),
				checkin: async () => ({}),
				clear: async () => ({}),
				authorize: async (_params, ctx) => {
					ctx.notify('{"type":"wool-authorize"}', "info");
					return { credentials: { apiKey: "fixture-access" } };
				},
			},
		});
		const command = commands.get("wool-workbuddy");
		await command?.handler('{"v":1,"action":"authorize"}', {
			ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		} as unknown as ExtensionCommandContext);
		expect(notices).toEqual([{ message: '{"type":"wool-authorize"}', type: "info" }]);
	});
});

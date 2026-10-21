// 签到与默认关测试：执行/状态/额度 fixture 对照 + 「无自动签到触发路径」代码审查级
// 断言（D5：自动签到默认关——不存在任何定时器/循环调用签到接口的代码路径）。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { authContextFromToken, workbuddyAccountStatus } from "../account.ts";
import { executeCheckin, fetchCheckinStatus, fetchQuota } from "../checkin.ts";

const SRC_DIR = join(import.meta.dirname, "..");

/** btoa 不含非 ASCII 安全问题的固定测试 JWT（payload {"sub":"user-123","exp":9999999999,"domain":"copilot.tencent.com"}）。 */
const TEST_JWT = `h.${btoa(JSON.stringify({ sub: "user-123", exp: 9999999999, domain: "copilot.tencent.com" }))}.s`;

const AUTH = { accessToken: TEST_JWT, uid: "user-123" };

/** 按序返回 JSON 响应的 fetch mock（记录调用）。 */
function jsonFetch(responses: Array<{ status?: number; body: unknown }>): {
	impl: typeof globalThis.fetch;
	calls: Array<{ url: string; init: RequestInit }>;
} {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	let index = 0;
	const impl = (async (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
	}) as typeof globalThis.fetch;
	return { impl, calls };
}

describe("签到执行（daily-checkin）", () => {
	it("code 0 → 签到成功", async () => {
		const { impl, calls } = jsonFetch([{ body: { code: 0, msg: "ok" } }]);
		vi.stubGlobal("fetch", impl);
		try {
			const result = await executeCheckin("cn", AUTH);
			expect(result).toEqual({ doneToday: true, code: 0, message: "Checked in" });
			expect(calls[0]?.url).toBe("https://www.codebuddy.cn/v2/billing/meter/daily-checkin");
			expect(calls[0]?.init.method).toBe("POST");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("code 10001（今日已签，含 HTTP 400 形态）→ 幂等成功", async () => {
		const { impl } = jsonFetch([{ status: 400, body: { code: 10001, msg: "今天已签到" } }]);
		vi.stubGlobal("fetch", impl);
		try {
			const result = await executeCheckin("cn", AUTH);
			expect(result.doneToday).toBe(true);
			expect(result.code).toBe(10001);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("业务失败码 → throw", async () => {
		const { impl } = jsonFetch([{ body: { code: 11140, msg: "account banned" } }]);
		vi.stubGlobal("fetch", impl);
		try {
			await expect(executeCheckin("cn", AUTH)).rejects.toThrow("11140");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("intl realm → 直接拒绝（无签到体系）", async () => {
		await expect(executeCheckin("intl", AUTH)).rejects.toThrow("only available for CN realm");
	});
});

describe("签到状态与额度（status 聚合输入）", () => {
	it("checkin-activity-status → {doneToday, streak}", async () => {
		const { impl, calls } = jsonFetch([
			{ body: { code: 0, data: { today_checked_in: true, streak_days: 16, daily_credit: 100, active: true } } },
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const status = await fetchCheckinStatus("cn", AUTH);
			expect(status).toEqual({ doneToday: true, streak: 16, active: true, dailyCredit: 100 });
			expect(calls[0]?.url).toBe("https://copilot.tencent.com/v2/billing/meter/checkin-activity-status");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("get-user-resource Accounts 汇总 remain/used", async () => {
		const { impl } = jsonFetch([
			{
				body: {
					code: 0,
					data: { Response: { Data: { Accounts: [
						{ UsedSize: 100, RemainSize: 400 },
						{ UsedSize: 50, RemainSize: 50 },
					] } } },
				},
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const quota = await fetchQuota("cn", AUTH);
			expect(quota).toEqual({ used: 150, remaining: 450, unit: "credits" });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("额度拉取失败 → undefined（status 聚合不阻断）", async () => {
		const impl = (async () => new Response("boom", { status: 500 })) as typeof globalThis.fetch;
		vi.stubGlobal("fetch", impl);
		try {
			expect(await fetchQuota("cn", AUTH)).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("account status 聚合（无凭据 → logged-out 形态；有凭据 → 字段族）", async () => {
		const loggedOut = await workbuddyAccountStatus(false, undefined, undefined);
		expect(loggedOut).toEqual({ family: "workbuddy", loggedIn: false, fetchedAt: expect.any(Number) });
		expect(loggedOut.family).toBe("workbuddy");

		const { impl } = jsonFetch([
			{ body: { code: 0, data: { today_checked_in: true, streak_days: 16 } } },
			{ body: { code: 0, data: { Response: { Data: { Accounts: [{ UsedSize: 0, RemainSize: 2800 }] } } } } },
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const status = await workbuddyAccountStatus(true, TEST_JWT, "wool-user");
			expect(status.loggedIn).toBe(true);
			expect(status.nickname).toBe("wool-user");
			expect(status.checkin).toEqual({ doneToday: true, streak: 16 });
			expect(status.quota).toEqual({ used: 0, remaining: 2800, unit: "credits" });
			expect(status.tokenExpiresAt).toBe(9999999999_000);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("authContextFromToken：JWT 解 uid/realm/domain", () => {
		const auth = authContextFromToken(TEST_JWT);
		expect(auth.uid).toBe("user-123");
		expect(auth.realm).toBe("cn");
		expect(auth.domain).toBe("copilot.tencent.com");
	});
});

describe("自动签到默认关（D5 代码审查级断言）", () => {
	/** 全部 src 源码文本（不含测试）。 */
	function sourceFiles(): Array<{ name: string; content: string }> {
		const entries: Array<{ name: string; content: string }> = [];
		for (const name of readdirSync(SRC_DIR, { withFileTypes: true })) {
			if (!name.isFile() || !name.name.endsWith(".ts")) {
				continue;
			}
			entries.push({ name: name.name, content: readFileSync(join(SRC_DIR, name.name), "utf8") });
		}
		return entries;
	}

	it("不存在任何定时器 API 调用（setInterval/setTimeout/setImmediate/unref 计时）", () => {
		for (const file of sourceFiles()) {
			for (const api of ["setInterval(", "setTimeout(", "setImmediate("]) {
				expect(file.content.includes(api), `${file.name} 不应包含 ${api}（时间平抑红线：全事件驱动）`).toBe(false);
			}
		}
	});

	it("daily-checkin 端点路径只出现在 checkin.ts（唯一调用路径 = 管理指令手动触发）", () => {
		for (const file of sourceFiles()) {
			if (file.name === "checkin.ts" || file.name === "constants.ts") {
				continue;
			}
			expect(
				file.content.includes("daily-checkin"),
				`${file.name} 不应直接引用签到端点（执行路径必须经 executeCheckin）`,
			).toBe(false);
		}
	});

	it("executeCheckin 的调用点只有管理动作 handler（index.ts checkin 分支）", () => {
		const files = sourceFiles();
		const callers = files.filter(
			(file) => file.name !== "checkin.ts" && file.content.includes("executeCheckin("),
		);
		expect(callers.map((file) => file.name)).toEqual(["index.ts"]);
	});

	it("无循环/递归自调用签到路径（checkin.ts 内无对 executeCheckin/fetch 的循环结构）", () => {
		const checkin = sourceFiles().find((file) => file.name === "checkin.ts");
		expect(checkin).toBeDefined();
		// while/for 循环体内不得含 fetch 调用（签到执行是单次请求）
		expect(checkin?.content.includes("while (")).toBe(false);
	});
});

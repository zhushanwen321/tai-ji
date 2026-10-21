// account-status.test.ts — 账号状态 schema 与守卫。

import { describe, expect, it } from "vitest";

import { isWoolAccountStatus, woolLoggedOutStatus, type WoolAccountStatus } from "../account-status.ts";

describe("WoolAccountStatus", () => {
	it("未接入状态构造（loggedIn:false）", () => {
		const status = woolLoggedOutStatus("qoder", 1000);
		expect(status).toEqual({ family: "qoder", loggedIn: false, fetchedAt: 1000 });
	});

	it("守卫：完整额度+签到形态通过", () => {
		const status: WoolAccountStatus = {
			family: "workbuddy",
			loggedIn: true,
			nickname: "nick",
			quota: { used: 10, total: 400, unit: "credits" },
			checkin: { doneToday: false, streak: 3 },
			tokenExpiresAt: 9999999999,
			fetchedAt: 1234,
		};
		expect(isWoolAccountStatus(status)).toBe(true);
	});

	it.each([
		["缺 family", { loggedIn: true, fetchedAt: 1 }],
		["缺 loggedIn", { family: "qoder", fetchedAt: 1 }],
		["缺 fetchedAt", { family: "qoder", loggedIn: true }],
		["quota 缺 unit", { family: "qoder", loggedIn: true, fetchedAt: 1, quota: { used: 1 } }],
		["checkin 缺 doneToday", { family: "qoder", loggedIn: true, fetchedAt: 1, checkin: { streak: 1 } }],
		["非对象", "status"],
	])("守卫拒绝：%s", (_label, value) => {
		expect(isWoolAccountStatus(value)).toBe(false);
	});
});

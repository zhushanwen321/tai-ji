// account-status.ts — 账号状态拉取的协议类型（额度/签到/登录态字段族）。
//
// 数据流（设计 D6 ③）：taiji 经管理专用会话发 status 指令 → 家族扩展 handler 拉上游 →
// 本 schema 即扩展回包 data 的形状契约。taiji 主动拉取，无后台推送。

import { Type, type Static } from "typebox";

/** 额度字段族：total 缺省表示上游未暴露总量（只报余量型上游）。 */
export const WoolQuotaSchema = Type.Object({
	used: Type.Number({ description: "Used quota in unit" }),
	total: Type.Optional(Type.Number({ description: "Total quota; absent when upstream reports remaining only" })),
	remaining: Type.Optional(Type.Number({ description: "Remaining quota; absent when only used is reported" })),
	unit: Type.String({ description: "Quota unit label, e.g. credits / points" }),
});

/** 签到字段族：streak/lastCheckedAt 为上游提供的增值字段，缺省即未知。 */
export const WoolCheckinSchema = Type.Object({
	doneToday: Type.Boolean(),
	streak: Type.Optional(Type.Number()),
	lastCheckedAt: Type.Optional(Type.Number({ description: "Unix ms of last check-in" })),
});

export const WoolAccountStatusSchema = Type.Object({
	family: Type.String(),
	loggedIn: Type.Boolean(),
	nickname: Type.Optional(Type.String()),
	quota: Type.Optional(WoolQuotaSchema),
	checkin: Type.Optional(WoolCheckinSchema),
	/** 令牌有效期（Unix ms）。pi 到期自动续期（D3），此字段供条目徽标展示。 */
	tokenExpiresAt: Type.Optional(Type.Number()),
	/** 上游返回的原始状态采集时点（Unix ms），展示「数据时点」用，不参与任何过期判定。 */
	fetchedAt: Type.Number(),
});

export type WoolAccountStatus = Static<typeof WoolAccountStatusSchema>;

/** 未接入/无凭据时的合法状态（loggedIn:false，其余字段缺席）。 */
export function woolLoggedOutStatus(family: string, now: number): WoolAccountStatus {
	return { family, loggedIn: false, fetchedAt: now };
}

/** 运行时守卫：宿主消费 status 回包 data 前收窄（读侧不信任外部格式）。 */
export function isWoolAccountStatus(value: unknown): value is WoolAccountStatus {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.family !== "string" || typeof record.loggedIn !== "boolean" || typeof record.fetchedAt !== "number") {
		return false;
	}
	const quota = record.quota;
	if (quota !== undefined && (typeof quota !== "object" || quota === null || typeof (quota as Record<string, unknown>).used !== "number" || typeof (quota as Record<string, unknown>).unit !== "string")) {
		return false;
	}
	const checkin = record.checkin;
	if (checkin !== undefined && (typeof checkin !== "object" || checkin === null || typeof (checkin as Record<string, unknown>).doneToday !== "boolean")) {
		return false;
	}
	return true;
}

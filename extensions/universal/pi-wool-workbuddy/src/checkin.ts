// checkin.ts — 签到执行 / 签到状态 / 额度查询（管理动作的上游实装，设计 D5）。
//
// 全部为手动触发（管理指令通道），无任何定时器/自动路径——D5 风控裁决：
// 社区批量自动签到致连环封号实锤，自动签到开关由 taiji 侧 settings 承载（不在本包）。
// 端点（hub wb_accounts.py 实读）：
// - 签到执行：POST {billing}/v2/billing/meter/daily-checkin body{}（CN 限定；code 10001 = 今日已签幂等成功）
// - 签到状态：POST {chat}/v2/billing/meter/checkin-activity-status body{} → data{today_checked_in,...}
// - 额度：POST {billing}/v2/billing/meter/get-user-resource → data.Response.Data.Accounts[] 汇总

import {
	CHECKIN_ALREADY_CODE,
	CHECKIN_PATH,
	CHECKIN_STATUS_PATH,
	ERROR_DETAIL_MAX_CHARS,
	GET_RESOURCE_PATH,
	HTTP_BAD_REQUEST,
	type WorkbuddyRealm,
} from "./constants.ts";
import { isRecord } from "./guards.ts";
import { buildBillingHeaders, realmConfig, type WorkbuddyAuthContext } from "./headers.ts";

/** 上游 JSON envelope。 */
type Envelope = {
	code?: number;
	msg?: string;
	data?: Record<string, unknown>;
};

async function postJson(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Envelope> {
	const response = await fetch(url, { method: "POST", headers, body: "{}", signal });
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`WorkBuddy billing endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, ERROR_DETAIL_MAX_CHARS)}`);
	}
	if (!response.ok) {
		// HTTP 400 + code 10001 = 今日已签（上游幂等形态，按成功处理——hub _checkin_upstream 同口径）
		const envelope = parsed as Envelope;
		if (response.status === HTTP_BAD_REQUEST && envelope.code === CHECKIN_ALREADY_CODE) {
			return envelope;
		}
		const envelopeMsg = (isRecord(parsed) ? (parsed as Envelope).msg : undefined) ?? text.slice(0, ERROR_DETAIL_MAX_CHARS);
		throw new Error(`WorkBuddy billing endpoint HTTP ${response.status}: ${envelopeMsg}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("WorkBuddy billing endpoint returned a non-object envelope");
	}
	return parsed as Envelope;
}

/** 签到动作回包（管理协议 data 形态）。 */
export type CheckinResult = {
	doneToday: boolean;
	/** 上游业务码（0 = 本次签到成功；10001 = 今日已签）。 */
	code: number;
	message: string;
};

/** 执行签到（CN 限定；intl 无签到体系直接拒绝）。 */
export async function executeCheckin(realm: WorkbuddyRealm, auth: WorkbuddyAuthContext, signal?: AbortSignal): Promise<CheckinResult> {
	if (realm !== "cn") {
		throw new Error("WorkBuddy check-in is only available for CN realm accounts");
	}
	const config = realmConfig(realm);
	const payload = await postJson(`${config.billingUpstream}${CHECKIN_PATH}`, buildBillingHeaders(realm, auth), signal);
	const code = payload.code ?? -1;
	if (code !== 0 && code !== CHECKIN_ALREADY_CODE) {
		throw new Error(`WorkBuddy check-in failed: code ${String(code)} ${payload.msg ?? ""}`);
	}
	return {
		doneToday: true,
		code,
		message: code === CHECKIN_ALREADY_CODE ? "Already checked in today" : "Checked in",
	};
}

/** 签到状态（今日已签/连签天数/签到活动是否有效）。 */
export type CheckinStatus = {
	doneToday: boolean;
	streak?: number;
	active?: boolean;
	dailyCredit?: number;
	todayCredit?: number;
};

/** 拉取签到状态（chat 域端点；失败返回 undefined——状态是增值字段不阻断 status 聚合）。 */
export async function fetchCheckinStatus(
	realm: WorkbuddyRealm,
	auth: WorkbuddyAuthContext,
	signal?: AbortSignal,
): Promise<CheckinStatus | undefined> {
	if (!realmConfig(realm).hasCheckin) {
		return undefined;
	}
	const config = realmConfig(realm);
	try {
		const payload = await postJson(`${config.chatUpstream}${CHECKIN_STATUS_PATH}`, buildBillingHeaders(realm, auth), signal);
		if (payload.code !== 0) {
			return undefined;
		}
		const data = payload.data ?? {};
		const streak = data.streak_days;
		return {
			doneToday: data.today_checked_in === true,
			...(typeof streak === "number" ? { streak } : {}),
			...(typeof data.active === "boolean" ? { active: data.active } : {}),
			...(typeof data.daily_credit === "number" ? { dailyCredit: data.daily_credit } : {}),
			...(typeof data.today_credit === "number" ? { todayCredit: data.today_credit } : {}),
		};
	} catch {
		return undefined;
	}
}

/** 额度汇总（get-user-resource Accounts 求和；hub _fetch_credits_fallback 同构）。 */
export type QuotaSummary = {
	used: number;
	remaining: number;
	unit: string;
};

/** 拉取额度（失败返回 undefined——同 status 聚合口径）。 */
export async function fetchQuota(
	realm: WorkbuddyRealm,
	auth: WorkbuddyAuthContext,
	now = new Date(),
	signal?: AbortSignal,
): Promise<QuotaSummary | undefined> {
	const config = realmConfig(realm);
	const body = JSON.stringify({
		PageNumber: 1,
		PageSize: RESOURCE_PAGE_SIZE,
		ProductCode: "p_tcaca",
		Status: RESOURCE_STATUS_FILTER,
		PackageEndTimeRangeBegin: formatDateTime(now),
		PackageEndTimeRangeEnd: RESOURCE_END_BOUNDARY,
	});
	try {
		const response = await fetch(`${config.billingUpstream}${GET_RESOURCE_PATH}`, {
			method: "POST",
			headers: buildBillingHeaders(realm, auth),
			body,
			signal,
		});
		if (!response.ok) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(await response.text());
		if (!isRecord(parsed)) {
			return undefined;
		}
		if (parsed.code !== 0) {
			return undefined;
		}
		const accounts = extractAccounts(isRecord(parsed.data) ? parsed.data : undefined);
		if (accounts === undefined) {
			return undefined;
		}
		let used = 0;
		let remaining = 0;
		for (const account of accounts) {
			used += numericOr(account.UsedSize, 0);
			remaining += numericOr(account.RemainSize, 0);
		}
		return { used: round2(used), remaining: round2(remaining), unit: "credits" };
	} catch {
		return undefined;
	}
}

type RawAccount = {
	UsedSize?: unknown;
	RemainSize?: unknown;
	Size?: unknown;
};

/** 额度查询分页大小（hub 同值：单页覆盖全部资源包）。 */
const RESOURCE_PAGE_SIZE = 100;
/** 资源包状态过滤里的「使用中」状态值（0 在 lint ignore 白名单内）。 */
const RESOURCE_STATUS_IN_USE = 3;
/** 资源包状态过滤（0/3 = 有效与使用中——hub _fetch_credits_fallback 同值）。 */
const RESOURCE_STATUS_FILTER = [0, RESOURCE_STATUS_IN_USE];
/** 资源包到期上界（固定远期日，与 hub 一致）。 */
const RESOURCE_END_BOUNDARY = "2036-01-01 00:00:00";
/** 两位小数舍入因子。 */
const ROUND_SCALE = 100;

function extractAccounts(data: Record<string, unknown> | undefined): RawAccount[] | undefined {
	const response = isRecord(data?.Response) ? data.Response : undefined;
	const inner = (isRecord(response?.Data) ? response.Data : undefined) ?? (isRecord(data?.Data) ? data.Data : undefined);
	const accounts = inner?.Accounts;
	if (!Array.isArray(accounts)) {
		return undefined;
	}
	return accounts.filter((entry): entry is RawAccount => isRecord(entry));
}

function numericOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round2(value: number): number {
	return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

const DATE_PAD_WIDTH = 2;

function formatDateTime(date: Date): string {
	const pad = (n: number): string => String(n).padStart(DATE_PAD_WIDTH, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`;
}

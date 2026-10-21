// jwt.ts — WorkBuddy JWT 载荷解码（uid / 过期 / 签发者）。只解码不验签（上游签发方校验）。

import { MS_PER_SECOND } from "./constants.ts";
import { isRecord } from "./guards.ts";

/** JWT 三段形态（header.payload.signature）。 */
const JWT_SEGMENT_COUNT = 3;
const JWT_PAYLOAD_SEGMENT = 1;
const HEX_RADIX = 16;
const HEX_DIGIT_WIDTH = 2;

/** JWT payload 形状子集（WorkBuddy access token 实测字段）。 */
export type WorkbuddyJwtClaims = {
	sub?: string;
	exp?: number;
	iss?: string;
	[key: string]: unknown;
};

/** base64url 解码 JWT 载荷段；非法形态返回 undefined（不 throw——调用方按无凭据处理）。 */
export function decodeJwtClaims(token: string | undefined): WorkbuddyJwtClaims | undefined {
	if (typeof token !== "string" || token.length === 0) {
		return undefined;
	}
	const segments = token.split(".");
	if (segments.length !== JWT_SEGMENT_COUNT) {
		return undefined;
	}
	try {
		const base64 = segments[JWT_PAYLOAD_SEGMENT].replace(/-/g, "+").replace(/_/g, "/");
		const json = decodeURIComponent(
			atob(base64)
				.split("")
				.map((ch) => `%${ch.charCodeAt(0).toString(HEX_RADIX).padStart(HEX_DIGIT_WIDTH, "0")}`)
				.join(""),
		);
		const parsed: unknown = JSON.parse(json);
		if (!isRecord(parsed)) {
			return undefined;
		}
		return parsed as WorkbuddyJwtClaims;
	} catch {
		return undefined;
	}
}

/** JWT sub → uid（缺省空串）。 */
export function uidFromToken(token: string | undefined): string { // oe-exempt:20261022:wip:JWT sub→uid 派生辅助——头族接线提交后消费，暂零引用（30 天复检）
	const claims = decodeJwtClaims(token);
	return typeof claims?.sub === "string" ? claims.sub : "";
}

/** JWT exp（秒）→ 过期时刻（毫秒）；缺省 undefined（按未过期处理，刷新交 pi 仲裁）。 */
export function expiresFromToken(token: string | undefined): number | undefined {
	const claims = decodeJwtClaims(token);
	return typeof claims?.exp === "number" ? claims.exp * MS_PER_SECOND : undefined;
}

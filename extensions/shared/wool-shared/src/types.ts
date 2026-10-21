// types.ts — wool 家族基础类型（三家扩展包与 u-host 消费的公共词表）。

/** 羊毛家族 id 词表。新家族 = 新增字面量 + 家族扩展包，不改消费方结构。 */
export const WOOL_FAMILY_IDS = ["qoder", "trae", "workbuddy"] as const;

export type WoolFamilyId = (typeof WOOL_FAMILY_IDS)[number];

/** 凭据来源两值（设计 D3）：本机提取逐次确认 / OAuth 授权。 */
export type WoolCredentialsSource = "ide-extract" | "oauth";

/** 运行时守卫：外部输入的家族 id 收窄（读侧不信任外部格式）。 */
export function isWoolFamilyId(value: unknown): value is WoolFamilyId {
	return typeof value === "string" && (WOOL_FAMILY_IDS as readonly string[]).includes(value);
}

/** 家族 id → pi provider 注册名（registerProvider 的 name）。 */
export function woolProviderId(family: WoolFamilyId): string {
	return `wool-${family}`;
}

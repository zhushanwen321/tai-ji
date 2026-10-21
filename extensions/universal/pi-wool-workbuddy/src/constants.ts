// constants.ts — WorkBuddy 上游协议常量（realm 端点 / 头族字段值 / 端点路径）。
//
// 来源（2026-10-21 实读社区适配项目 workbuddy2api-hub main 分支）：
// - realm 配置与端点：wb_accounts.py REALM_CONFIGS / AUTH_*_PATH / CHECKIN_* / GET_RESOURCE_PATH
// - 桌面端身份版本与 UA：wb_identity.py DESKTOP_VERSION_CN / DESKTOP_UA_CN（2026-10-18 双区实跑抓包）
// - 缺会话头族上游拒绝形态：400 code 11-128（`conversation id missing`）
// 上游对抗持续加码（版本/UA 逐版本对齐），常量集中此处便于跟版。

/** WorkBuddy 双区配置键。任务书协议锚 copilot.tencent.com = CN 链路，默认 CN。 */
export type WorkbuddyRealm = "cn" | "intl";

export type WorkbuddyRealmConfig = {
	/** 对话上游基址（chat completions / OAuth state / token / 签到状态）。 */
	chatUpstream: string;
	/** 计费上游基址（签到执行 / 额度）。 */
	billingUpstream: string;
	/** billing 头族的 Origin / Referer 源。 */
	origin: string;
	/** X-Domain 兜底值（登录时记下的 domain 优先）。 */
	domain: string;
	/** 桌面端版本号（X-IDE-Version）。 */
	desktopVersion: string;
	/** 对话请求 User-Agent。 */
	chatUa: string;
	/** billing 请求 User-Agent。 */
	billingUa: string;
	/** billing 头族 Accept-Language。 */
	acceptLanguage: string;
	/** 该区是否有签到体系。 */
	hasCheckin: boolean;
	/** 令牌刷新头 X-Auth-Refresh-Source 的值。 */
	refreshSource: string;
};

const CN_CHAT_UPSTREAM = "https://copilot.tencent.com";

export const WORKBUDDY_REALMS: Record<WorkbuddyRealm, WorkbuddyRealmConfig> = {
	cn: {
		chatUpstream: CN_CHAT_UPSTREAM,
		billingUpstream: "https://www.codebuddy.cn",
		origin: "https://www.codebuddy.cn",
		domain: "copilot.tencent.com",
		desktopVersion: "5.8.3",
		chatUa: "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0",
		billingUa: "WorkBuddy/5.8.3",
		acceptLanguage: "zh-CN",
		hasCheckin: true,
		refreshSource: "workbuddy",
	},
	intl: {
		chatUpstream: "https://www.workbuddy.ai",
		billingUpstream: "https://www.workbuddy.ai",
		origin: "https://www.workbuddy.ai",
		domain: "www.workbuddy.ai",
		desktopVersion: "5.8.4",
		chatUa: "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0",
		billingUa: "WorkBuddy/5.8.4",
		acceptLanguage: "en-US",
		hasCheckin: false,
		refreshSource: "plugin",
	},
};

export function isWorkbuddyRealm(value: unknown): value is WorkbuddyRealm {
	return value === "cn" || value === "intl";
}

/** OAuth 授权平台参数（hub start_login 实测 platform=CLI）。 */
export const OAUTH_PLATFORM = "CLI";

/** OAuth state 轮询协议的端点路径（hub wb_accounts.py:269-272）。 */
export const AUTH_STATE_PATH = "/v2/plugin/auth/state";
export const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
export const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
export const REFRESH_PATH = "/v2/plugin/auth/token/refresh";

/** token 端点「等待浏览器登录」错误码（hub LOGIN_PENDING）。 */
export const LOGIN_PENDING_CODE = 11217;

/** 签到与额度端点（hub wb_accounts.py:273-278）。 */
export const CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
export const CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
export const GET_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";

/** 签到幂等成功错误码：今日已签（hub _checkin_upstream 按 ok 处理）。 */
export const CHECKIN_ALREADY_CODE = 10001;

/** 模型目录端点（账号级动态清单；hub wb_proxy.py MODELS_PATH）。 */
export const MODELS_PATH = "/v2/enterprises/personal/models";

/** 对话端点（OpenAI 形态）。 */
export const CHAT_PATH = "/v2/chat/completions";

/** OAuth 回调监听：仅 127.0.0.1、系统分配端口（port 0）、固定路径。 */
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PATH = "/wool-auth/callback";

/** HTTP 状态码（回调监听与上游响应判定共用）。 */
export const HTTP_OK = 200;
export const HTTP_ACCEPTED = 202;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_BAD_GATEWAY = 502;

/** 上游错误/详情文本的截断上限（日志与错误消息不无限膨胀）。 */
export const ERROR_DETAIL_MAX_CHARS = 300;
export const ARGUMENTS_DETAIL_MAX_CHARS = 120;

/** 秒 → 毫秒换算。 */
export const MS_PER_SECOND = 1000;
/** 无 exp 可解时的缺省令牌窗口（30 分钟；真实过期由刷新链从新 JWT 解）。 */
export const DEFAULT_TOKEN_TTL_MS = 1_800_000;

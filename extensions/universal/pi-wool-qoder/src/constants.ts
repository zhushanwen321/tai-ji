// constants.ts — Qoder 协议常量（全部对照开源参考实现 shuishuipingan/qoder2api-hub
// v1.6.4 的 qoder_sign.py / qoder_accounts.py 逐项翻译；每项注明依据）。
//
// 区域形态：首版只实装 CN 区（本机凭据提取链与探针均以 CN 为准，任务书协议事实锚；
// 国际版目录/网关候选留待有真实需求时扩展——不做推测性功能）。

/** CN 区 openapi 基址（纯 Bearer dt-/PAT 直调；hub qoder_accounts.py REALM_CONFIGS.cn.openapi）。 */
export const OPENAPI_BASE_URL = "https://openapi.qoder.com.cn";

/** CN 区 gateway 基址（对话/模型目录，COSY 签名域；hub REALM_CONFIGS.cn.gateway）。 */
export const GATEWAY_BASE_URL = "https://gateway.qoder.com.cn";

/** openapi 域业务端点（hub qoder_accounts.py PATH_* 常量）。 */
export const PATH_USERINFO = "/api/v1/userinfo";
export const PATH_QUOTA_USAGE = "/api/v2/quota/usage";
export const PATH_DEVICE_TOKEN_REFRESH = "/api/v1/deviceToken/refresh";

/** 对话端点（hub qoder_proxy.py CHAT_PATH；查询参数官方客户端同款）。 */
export const CHAT_PATH =
	"/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

/** 模型目录端点（hub qoder_proxy.py MODELS_PATH；签名 body = qoderEncode("{}")，裸 GET 403）。 */
export const MODELS_PATH = "/algo/api/v2/model/list?Encode=1";

/** COSY 协议版本：对齐官方 qodercli 1.1.75（hub qoder_sign.py COSY_VERSION 默认值；
 * cosy-version 头与签名 payload.cosyVersion 共用此值）。 */
export const COSY_VERSION = "1.1.75";

/** openapi 域 UA：必须用官方客户端 UA（hub REALM_CONFIGS.cn.ua；通用 UA 等于自报脚本）。 */
export const OPENAPI_USER_AGENT = "QoderWork/1.1.75";

/** gateway 域 UA：官方 CLI 推理请求的签名头表没有 User-Agent，请求经打包的
 * undici fetch 发出、由 undici 补默认值 "undici"（hub qoder_sign.py COSY_USER_AGENT 注）。 */
export const COSY_USER_AGENT = "undici";

/** Qoder 自定义 Base64 字母表（hub qoder_sign.py QODER_CUSTOM_ALPHABET，64 字符
 * 服务端逐字符映射，'=' 填充映射为 '$'）。 */
export const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
export const QODER_PAD = "$";

/** Qoder 服务端 RSA 公钥（官方客户端硬编码，SPKI PEM；hub qoder_sign.py SERVER_PUB_PEM）。
 * 实测参数：N 1024 位、e 65537——包裹 16 字节会话密钥（PKCS#1 v1.5 type 2）。 */
export const SERVER_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** 钥匙串提取链参数（macOS Electron safeStorage 经典变体，任务书协议事实锚 + 本机实测）：
 * PBKDF2-HMAC-SHA1，salt 固定 "saltysalt"，1003 次迭代，派生 16 字节 AES-128 密钥；
 * IV = 16 个空格字节（0x20）；密文去 "v10" 头后 PKCS7 填充。 */
export const KEYCHAIN_SERVICE_CN = "Qoder CN App Safe Storage";
export const KEYCHAIN_ACCOUNT_CN = "Qoder CN App Key";
export const SAFE_STORAGE_SALT = "saltysalt";
export const SAFE_STORAGE_ITERATIONS = 1003;
/** AES-128 密钥与 CBC IV 同宽（16 字节 = AES 块大小；hub 同参数）。 */
export const AES_BLOCK_BYTES = 16;
export const SAFE_STORAGE_KEY_LEN = AES_BLOCK_BYTES;
export const SAFE_STORAGE_IV = " ".repeat(AES_BLOCK_BYTES);
export const OS_CRYPT_MAGIC = "v10";

/** CN 区凭据文件目录名（hub REALM_CONFIGS.cn.app_dir；本机实测
 * ~/Library/Application Support/com.qodercn.app.stable/auth.v1.dat）。 */
export const APP_DATA_DIRNAME = "com.qodercn.app.stable";
export const AUTH_FILE_BASENAME = "auth.v1.dat";

/** 结构化工具历史白名单（hub qoder_proxy.py STRUCTURED_TOOL_HISTORY_WHITELIST）：
 * CN 出口 + 模型 key 命中前缀 + 工具调用 id 齐备时，tool 结果保留 role:"tool"
 * 直传（hub task-31 实测 null content 会丢配对消息，content 恒传空串）。 */
export const STRUCTURED_TOOL_HISTORY_PREFIXES = ["qwen", "glm", "gm4", "gm5", "deepseek", "dfmodel"] as const;

/** 非对话模型 key（hub qoder_proxy.py NON_CHAT_MODELS/PREFIXES/SUFFIXES）：
 * model/list 返回的目录含补全/图像类条目，不进 pi 对话模型目录。 */
export const NON_CHAT_MODEL_KEYS = ["lite"] as const;
export const NON_CHAT_MODEL_PREFIXES = ["codewise-", "completion-"] as const;
export const NON_CHAT_MODEL_SUFFIXES = ["-image-alpha", "-image-alpha-edit", "-taco-completion"] as const;

/** 快照兜底：model/list 从未可达时的最小可用清单（来源：hub 静态目录 CN 快照
 * qoder_catalog_cn.json 的 chat 条目集；字段按 pi chat 模型补全）。 */
export const SNAPSHOT_FALLBACK_MODELS: readonly { id: string; name: string; reasoning: boolean }[] = [
	{ id: "auto", name: "Auto", reasoning: true },
	{ id: "qmodel_38max", name: "Qwen3.8-Max", reasoning: true },
	{ id: "qfmodel", name: "Qwen3.8-Flash", reasoning: true },
	{ id: "qmodel_latest", name: "Qwen3.7-Max", reasoning: true },
	{ id: "qmodel", name: "Qwen3.7-Plus", reasoning: true },
	{ id: "q37fmodel", name: "Qwen3.7-Flash", reasoning: true },
	{ id: "dmodel", name: "DeepSeek-V4-Pro", reasoning: true },
	{ id: "dfmodel", name: "DeepSeek-Flash", reasoning: false },
	{ id: "gmodel", name: "GLM-5.3", reasoning: true },
	{ id: "gfmodel", name: "GLM-5.3-Flash", reasoning: true },
	{ id: "gm51model", name: "GLM-5.2", reasoning: true },
	{ id: "kmodel_latest", name: "Kimi-K3", reasoning: false },
	{ id: "kmodel", name: "Kimi-K2.8-Preview", reasoning: true },
	{ id: "mmodel", name: "MiniMax-M2.7", reasoning: false },
];

/** 模型目录默认上下文窗口（hub build_qoder_body：catalog_meta.max_input_tokens 缺省 180000）。 */
export const DEFAULT_CONTEXT_WINDOW = 180000;

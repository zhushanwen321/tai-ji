/**
 * network-proxy 配置读取与指纹。
 *
 * 类型与校验语义 SSOT = packages/shared/src/network-proxy.ts（u-foundation 契约）——
 * extension bundle 自包含不 import shared 运行时代码（extensions 对 shared 的既有惯例：
 * 结构类型本地声明 + 行为镜像锁定测试），本文件是复制体；漂移时以 shared 为准，
 * __tests__/config.test.ts 锁两侧行为一致。
 *
 * 配置文件 = <agentDir>/config/network-proxy-ext-config.json（llm-shared getConfigPath
 * 推导；runtime 写侧与 settings 页经 RPC 打通，设计 .tmp/tech-design/llm-network-proxy.md
 * §3.1 配置 schema）。热重载 = loadConfig 读时刷新（mtime+size），调用方每次直接调
 * loadNetworkProxyConfig，禁止上层闭包缓存（llm-shared 头注热重载契约）。
 */

import { loadConfig } from "@zhushanwen/pi-llm-shared";

import { matchesHostPattern } from "./match.js";

/** 代理协议词表：http / https 走 undici ProxyAgent，socks5 走 Socks5ProxyAgent。 */
export type NetworkProxyProtocol = "http" | "https" | "socks5";

/** 代理服务器连接参数。username/password 成对（非空时 percent-encode 拼入代理 URL）。 */
export interface NetworkProxyServer { // oe-exempt:20261019:framework:ext-config 契约的 bundle 自包含复制体声明（SSOT=shared，镜像锁定测试锚定）

	protocol: NetworkProxyProtocol;
	host: string;
	port: number;
	username: string;
	password: string;
}

/** 网络代理配置（ext-config 文件单一权威 schema；noProxy 优先级高于 rules）。 */
export interface NetworkProxyConfig { // oe-exempt:20261019:framework:ext-config 契约的 bundle 自包含复制体声明（SSOT=shared，镜像锁定测试锚定）

	enabled: boolean;
	proxy: NetworkProxyServer;
	/** 直连排除清单（主机名条目），命中即不经代理 */
	noProxy: string[];
	/** 代理规则（主机名条目），命中即经代理 */
	rules: string[];
}

/** 默认配置：禁用态 + 常见本地代理地址占位 + 保护本地回环（与 shared DEFAULT 深相等，镜像锁定测试锁两侧）。 */
export const DEFAULT_NETWORK_PROXY_CONFIG: NetworkProxyConfig = {
	enabled: false,
	proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" },
	noProxy: ["localhost", "127.0.0.1"],
	rules: [],
};

/** llm-shared loadConfig 的包名（决定文件名 network-proxy-ext-config.json）。 */
const CONFIG_PKG = "network-proxy";

const PROTOCOLS: readonly string[] = ["http", "https", "socks5"];

/** 端口合法区间（语义镜像 shared validateNetworkProxyConfig 字面量）。 */
const PORT_MIN = 1;
const PORT_MAX = 65535;

/** 校验结果信封：ok 或面向用户的错误清单（每条含修复动作，逐项收集不短路）。 */
export type NetworkProxyValidationResult = { ok: true } | { ok: false; errors: string[] };

/** noProxy/rules 条目校验：数组 + 每条为非空且首尾无空白的主机名字符串；重复条目不报错（匹配天然幂等）。 */
function collectHostEntryErrors(entries: unknown, label: string): string[] {
	if (!Array.isArray(entries)) {
		return [`${label} 必须是主机名列表（当前不是列表），请恢复为每行一个主机名的形式`];
	}
	const errors: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (typeof entry !== "string" || entry.trim() === "") {
			errors.push(`${label} 第 ${i + 1} 条为空，请填写主机名或删除该条`);
		} else if (entry !== entry.trim()) {
			// 归一化不 trim，带首尾空白的条目恒不匹配（静默不生效）——校验层显式拒绝并给出修复动作
			errors.push(`${label} 第 ${i + 1} 条首尾含空白字符，请删除空白后保存`);
		}
	}
	return errors;
}

/** proxy 对象字段校验（validateNetworkProxyConfig 的子步骤，语义镜像 shared collectProxyServerErrors）。 */
function collectProxyServerErrors(proxy: unknown): string[] {
	if (proxy === null || typeof proxy !== "object" || Array.isArray(proxy)) {
		return ["代理服务器配置必须是对象（协议 + 地址 + 端口），请重新填写代理服务器信息"];
	}
	const errors: string[] = [];
	const { protocol, host, port, username, password } = proxy as Record<string, unknown>;
	if (typeof protocol !== "string" || !PROTOCOLS.includes(protocol)) {
		errors.push(`代理协议必须是 http / https / socks5 之一: ${String(protocol)}，请重新选择协议`);
	}
	if (typeof host !== "string" || host.trim() === "") {
		errors.push("代理服务器地址不能为空，请填写代理地址（如 127.0.0.1）");
	}
	if (typeof port !== "number" || !Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
		errors.push(`代理端口必须是 ${PORT_MIN}-${PORT_MAX} 的整数: ${String(port)}，请填写正确的端口`);
	}
	if (typeof username !== "string" || typeof password !== "string") {
		errors.push("认证用户名与密码必须是文本，请检查认证输入框内容");
	} else if ((username !== "") !== (password !== "")) {
		errors.push("认证用户名与密码必须同时填写或同时留空（代理认证要求两者成对），请补全另一项或清空两项");
	}
	return errors;
}

/**
 * 网络代理配置校验（语义复制自 shared validateNetworkProxyConfig）：
 * 协议白名单、端口 1-65535 整数、凭据成对、noProxy/rules 条目非空主机名且首尾无空白
 * （归一化不 trim，带空白恒不匹配故显式拒绝）。
 * 错误逐项收集（errors 复数，不短路），文案面向用户且含修复动作。
 * 对象性守卫：null/数组解构会抛 TypeError 或静默得 undefined，读取路径须以错误信封逃逸。
 */
export function validateNetworkProxyConfig(config: unknown): NetworkProxyValidationResult {
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		return { ok: false, errors: [`网络代理配置必须是对象: ${String(config)}`] };
	}
	const errors: string[] = [];
	const { enabled, proxy, noProxy, rules } = config as Record<string, unknown>;
	if (typeof enabled !== "boolean") {
		errors.push(
			`网络代理开关必须是开或关: ${JSON.stringify(enabled) ?? String(enabled)}，请重新切换一次开关后保存`,
		);
	}
	errors.push(...collectProxyServerErrors(proxy));
	errors.push(...collectHostEntryErrors(noProxy, "直连排除清单（noProxy）"));
	errors.push(...collectHostEntryErrors(rules, "代理规则（rules）"));
	return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * loadConfig 的 normalize：校验通过的 raw 即合法配置（校验 = 运行时 guard，断言有兜底）。
 * 非法配置 throw（含逐项错误清单）→ loadConfig 回落 defaults 并把消息交给 onWarning——
 * 非法配置不静默修正（设计验收场景 10：坏配置不装分流器且 error 可归因），回落 defaults
 * 即「全部直连」的安全态。
 */
export function normalizeNetworkProxyConfig(raw: unknown): NetworkProxyConfig {
	const result = validateNetworkProxyConfig(raw);
	if (!result.ok) {
		throw new Error(result.errors.join("；"));
	}
	return raw as NetworkProxyConfig;
}

/** 条目去重 + 归一化视图（分流匹配用：匹配函数自带归一化，这里只去重保序）。 */
function dedupeEntries(entries: string[]): string[] {
	return [...new Set(entries)];
}

/** 读取配置（llm-shared mtime+size 读时刷新热重载）。 */
export function loadNetworkProxyConfig(onWarning?: (msg: string) => void): NetworkProxyConfig {
	return loadConfig(CONFIG_PKG, DEFAULT_NETWORK_PROXY_CONFIG, normalizeNetworkProxyConfig, onWarning);
}

/** 保存配置入口暂无（写入侧 = taiji runtime RMW）；pi CLI 用户直接手编文件即可。 */

/** noProxy 命中判定（去重视图 + suffix 匹配）。 */
export function hitsNoProxy(host: string, noProxy: string[]): boolean {
	return dedupeEntries(noProxy).some((pattern) => matchesHostPattern(host, pattern));
}

/** 规则命中判定（去重视图 + suffix 匹配）。 */
export function hitsRules(host: string, rules: string[]): boolean {
	return dedupeEntries(rules).some((pattern) => matchesHostPattern(host, pattern));
}

/**
 * 配置指纹：enabled+proxy+noProxy+rules 序列化比对（行为序列 2——指纹变化才重建分发器）。
 * normalize 后结构固定，JSON.stringify 字段序稳定（字面量构造序）。
 */
export function networkProxyFingerprint(config: NetworkProxyConfig): string {
	return JSON.stringify({
		enabled: config.enabled,
		proxy: config.proxy,
		noProxy: dedupeEntries(config.noProxy),
		rules: dedupeEntries(config.rules),
	});
}

/**
 * 主机名匹配语义（normalizeHostname + suffix 点边界）。
 *
 * 语义 SSOT = packages/shared/src/network-proxy.ts 的同名函数——extension bundle 自包含
 * 不 import shared 运行时代码（extensions 对 shared 的既有惯例：结构类型本地声明 + 行为
 * 真值表镜像锁定，见 rename-session RENAME_INSTRUCTION_MAX_LENGTH 先例），本文件是复制体；
 * 漂移时以 shared 为准，__tests__/match.test.ts 的真值表锁两侧行为一致。
 *
 * 匹配语义（设计 .tmp/tech-design/llm-network-proxy.md §3.1 配置 schema）：
 * suffix = 主机名等于或以 `.pattern` 结尾；点边界必须对齐——`xapi.anthropic.com` 不命中
 * `api.anthropic.com`（无点前缀拼接），`api-anthropic.com.evil.com` 不命中（恶意后缀）。
 */

/**
 * 主机名归一化：转小写、去末尾点（FQDN 根点形态与裸主机名同义）。
 * 刻意不 trim 首尾空白（语义镜像 shared normalizeHostname）：带空白的条目由校验层
 * 显式拒绝（config.ts collectHostEntryErrors，失败显式上报优于静默容忍），
 * 匹配层保持严格、带空白 pattern 恒不命中。
 */
export function normalizeHostname(host: string): string {
	return host.toLowerCase().replace(/\.+$/, "");
}

/**
 * suffix 语义匹配（noProxy 与 rules 条目同一匹配函数）：
 * 主机名等于 pattern 或以 `.pattern` 结尾。空主机名 / 空 pattern 不命中任何条目。
 */
export function matchesHostPattern(host: string, pattern: string): boolean {
	const h = normalizeHostname(host);
	const p = normalizeHostname(pattern);
	if (h === "" || p === "") return false;
	return h === p || h.endsWith(`.${p}`);
}

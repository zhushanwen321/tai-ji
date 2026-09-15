/**
 * OpenCode 风格 wildcard → RegExp 转换。
 *
 * 移植自 opencode-anomaly/packages/core/src/util/wildcard.ts。
 * 语义：
 *  - 路径分隔符统一为 '/'（replaceAll('\\','/')）
 *  - 元字符转义：`[.+^${}()|[\]\\]` → 加 `\` 前缀
 *  - `*` → `.*`（跨任意字符，含空格）
 *  - `?` → `.`（单字符）
 *  - 末尾 ` *` 改写为 `( .*)?`（使 `ls *` 也能匹配无参 `ls`）
 *  - 全锚定 `^...$`；非 win32 用 `s` flag（dotAll），win32 加 `i`（大小写不敏感）
 *
 * 注意：本模块只对 pattern 做 wildcard 编译，不对 input 做路径归一化
 * （matcher 层调用方负责把 argv.join(' ') 作为 input 传入）。
 */

/** 非 win32 平台始终返回同一个 flag 字符串，便于上层缓存 key 稳定。 */
function flags(): string {
	return process.platform === "win32" ? "si" : "s";
}

/**
 * 把 OpenCode 风格 wildcard pattern 编译为全锚定 RegExp。
 *
 * 纯函数：相同输入始终产生等价 RegExp（process.platform 在进程生命周期内稳定）。
 */
export function wildcardToRegExp(pattern: string): RegExp {
	let escaped = pattern
		.replaceAll("\\", "/")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");

	// 末尾 ` *`（已转写为 ` .*`）改写为可选的 `( .*)?`，
	// 使 `ls *` 这类 pattern 也能匹配无参 `ls`。
	const TRAILING_WILDCARD = " .*";
	const OPTIONAL_WILDCARD = "( .*)?";
	if (escaped.endsWith(TRAILING_WILDCARD)) {
		escaped = escaped.slice(0, -TRAILING_WILDCARD.length) + OPTIONAL_WILDCARD;
	}

	return new RegExp("^" + escaped + "$", flags());
}

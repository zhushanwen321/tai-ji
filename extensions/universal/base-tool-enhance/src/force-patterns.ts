/**
 * 强制后台白名单（M4，设计文档 §3.5「内置正则基线」+「匹配语义」段）。
 *
 * 两组内置正则 + 用户配置正则合并：
 *  - force-test：逐条迁自 unified-hooks test-timeout-guard.ts（主体逐条迁移；锚定
 *    前缀从原 `(^|\s|&&|\|{1,2}|;)` 收紧为命令位置锚定 CMD_ANCHOR，匹配语义双向
 *    翻转——见 FORCE_TEST_PATTERN_ENTRIES 注释）
 *  - force-longrun：M4 定稿清单，原则 = 命令语义上无自然退出点（dev server / watch /
 *    tail -f 等），按命令名与 flag 组合匹配
 *
 * 匹配语义（防误伤的关键）：正则一律锚定**命令位置**——行首，或 `;` / `&&` / `||` /
 * `|` / 换行之后的命令起始位，不做裸子串匹配。用户正则同样自动加锚（组内统一语义，
 * 用户正则无需也不应自带 `^`）。正则近似匹配的固有局限（诚实登记）：引号内换行 /
 * heredoc 内容理论上可构造误伤样例、`$(...)` 内命令会漏报——force 命中转后台是
 * 非破坏性的，漏报由模型显式 background:true 兜底。
 */

/** 命令位置锚定前缀：行首，或 `;`/`&&`/`||`/`|`/换行之后的命令起始位（后随可选空白）。 */
const CMD_ANCHOR = String.raw`(?:^|&&|\|\||;|\||\n)\s*`;

/** 内置条目：pattern 已含 CMD_ANCHOR 前缀；label 为语义标签（诊断/result 文案引用）。 */
export interface BuiltinForcePatternEntry {
	pattern: RegExp;
	label: string;
}

/**
 * force-test 组：测试套件命令（迁自 unified-hooks test-timeout-guard.ts:17-60，
 * 主体逐条迁移；锚定收紧为命令位置本身是语义变化，两个方向翻转——
 *  - 不再误伤：原 `\s` 前缀会把 `git commit -m "fix: npm test"` 这类参数文本当命令
 *    命中，锚定后不再命中
 *  - 新增漏报：wrapper 形态 `sudo npm test` / `timeout 300 npm test` /
 *    `xargs npm test` 原靠 `\s` 前缀命中，锚定后 wrapper 名占命令位置、目标命令退到
 *    参数位不再命中（§3.5 匹配语义的 wrapper 局限），由模型显式 background:true 兜底
 */
export const FORCE_TEST_PATTERN_ENTRIES: readonly BuiltinForcePatternEntry[] = [
	// === Node.js / JS / TS ===
	// 包管理器 test 脚本：npm test / pnpm test / yarn test / bun test
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(pnpm|npm|yarn|bun)\s+test\b`), label: "npm test" },
	// pnpm/npm run 跑 test 系脚本名（npm run test:unit / run test:watch 等）
	{
		pattern: new RegExp(CMD_ANCHOR + String.raw`(pnpm|npm)\s+(--filter\s+\S+\s+)?run\s+\S*test`),
		label: "npm run test",
	},
	// npx 直接调用测试 runner
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+vitest\b`), label: "vitest" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+jest\b`), label: "jest" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+mocha\b`), label: "mocha" },
	// e2e runner：npx cypress / npx playwright
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+(cypress|playwright)\s`), label: "e2e runner" },
	// vue-cli-service / react-scripts test
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+vue-cli-service\s+test`), label: "vue-cli test" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+react-scripts\s+test`), label: "react-scripts test" },
	// node_modules 直调 runner：./node_modules/.bin/vitest 等
	{
		pattern: new RegExp(CMD_ANCHOR + String.raw`\.\/?node_modules\/\.bin\/(vitest|jest|mocha)\b`),
		label: "direct test runner",
	},

	// === Python ===
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`pytest\b`), label: "pytest" },
	// python -m pytest / python3 -m unittest
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`python[3]?\s+-m\s+(pytest|unittest)\b`), label: "python test" },
	// uv run pytest / poetry run pytest
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(uv|poetry)\s+run\s+pytest\b`), label: "uv/poetry pytest" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`nosetests\b`), label: "nosetests" },

	// === Java / JVM ===
	// mvn test / mvnw test（mvn verify 等含 test 的 goal 由 \S*test 覆盖）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(mvn|\.\/mvnw)\s+\S*test`), label: "maven test" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(gradle|\.\/gradlew)\s+\S*test`), label: "gradle test" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`sbt\s+test\b`), label: "sbt test" },

	// === Go ===
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`go\s+test\b`), label: "go test" },

	// === Rust ===
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`cargo\s+test\b`), label: "cargo test" },

	// === .NET ===
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`dotnet\s+test\b`), label: "dotnet test" },

	// === Ruby ===
	// rspec / bundle exec rspec
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(rspec|bundle\s+exec\s+rspec)\b`), label: "rspec" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`rake\s+test\b`), label: "rake test" },
];

/**
 * force-longrun 组（M4 定稿）：命令语义上无自然退出点的长驻命令。判定标准 = 按命令
 * 名与 flag 组合匹配，不做 `--watch` 字面量子串匹配（`rg --files | grep watch` 不命中
 * ——watch flag 断言限定在同一命令段内、且以独立参数形态出现）。
 */
export const FORCE_LONGRUN_PATTERN_ENTRIES: readonly BuiltinForcePatternEntry[] = [
	// ── dev server：npm run dev 系 ──
	// 包管理器 dev 脚本（npm/pnpm/yarn/bun run dev，含 dev:web 等冒号变体——dev:* 按约定都是 dev server）
	{
		pattern: new RegExp(CMD_ANCHOR + String.raw`(pnpm|npm|yarn|bun)\s+(--filter\s+\S+\s+)?run\s+dev\b`),
		label: "package run dev",
	},
	// pnpm/yarn/bun 允许省略 run 的 dev 脚本简写（npm 无此语义故不含）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(pnpm|yarn|bun)\s+dev\b`), label: "package dev" },

	// ── dev server：npx 直接调用 ──
	// vite dev server（vite 缺省即 serve；排除 vite build——build 有自然退出点。
	// 双 lookahead：先钉死 vite 后必须是空白/结尾（防回溯绕过），再排除 build 子命令）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+vite(?=\s|$)(?!\s*build\b)`), label: "vite" },
	// next dev / nuxt dev / ng serve：框架 dev server 子命令
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+next\s+dev\b`), label: "next dev" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+nuxt\s+dev\b`), label: "nuxt dev" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+ng\s+serve\b`), label: "ng serve" },
	// webpack dev server：webpack-cli v4 serve 子命令 / 旧版 webpack-dev-server 直跑
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+webpack\s+serve\b`), label: "webpack serve" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`npx\s+webpack-dev-server\b`), label: "webpack-dev-server" },

	// ── dev server：语言内置 serve 命令（无自然退出点）──
	// python 静态文件服务器
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`python[3]?\s+-m\s+http\.server\b`), label: "http.server" },
	// django runserver（python manage.py runserver）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`python[3]?\s+manage\.py\s+runserver\b`), label: "runserver" },
	// flask run（flask --app x run 由段内 run 断言覆盖形态此处只认常见直跑）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`flask\s+run\b`), label: "flask run" },
	// rails server / rails s
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`rails\s+(s|server)\b`), label: "rails server" },
	// php artisan serve
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`php\s+artisan\s+serve\b`), label: "artisan serve" },

	// ── 显式 watch flags：工具名 + 同段内独立 watch 参数组合 ──
	// vitest/jest --watch / --watchAll（排除 --watch=false——显式关 watch 就是一次性运行）
	{
		pattern: new RegExp(
			CMD_ANCHOR + String.raw`(?:npx\s+)?(?:vitest|jest)\b[^;&|\n]*\s--watch(?:All)?\b(?!=)`,
		),
		label: "vitest/jest --watch",
	},
	// tsc --watch / tsc -w（持续增量编译）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`(?:npx\s+)?tsc\b[^;&|\n]*\s(?:--watch|-w)\b`), label: "tsc watch" },
	// 构建工具 watch 模式：sass / webpack / esbuild / rollup --watch
	{
		pattern: new RegExp(CMD_ANCHOR + String.raw`(?:npx\s+)?(?:sass|webpack|esbuild|rollup)\b[^;&|\n]*\s--watch\b`),
		label: "build --watch",
	},

	// ── 天然长驻工具 ──
	// cargo watch（文件变更即重跑命令，直到手动停止）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`cargo\s+watch\b`), label: "cargo watch" },
	// watchexec / nodemon（通用文件监听重启器）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`watchexec\b`), label: "watchexec" },
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`nodemon\b`), label: "nodemon" },
	// tail -f / tail -F（持续追踪日志文件；可选中段容纳 tail -n 100 -f 形态）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`tail\s(?:[^;&|\n]*\s)?-[fF]\b`), label: "tail -f" },
	// ngrok（隧道转发，直到手动停止）
	{ pattern: new RegExp(CMD_ANCHOR + String.raw`ngrok\b`), label: "ngrok" },
];

/** 命中来源：内置组（组名 test/longrun）或用户正则。 */
export type ForceMatchSource = "builtin-test" | "builtin-longrun" | "user";

/** 编译后的白名单条目。 */
export interface ForcePattern {
	re: RegExp;
	source: ForceMatchSource;
	/** result 文案引用名：内置 = 组名（test/longrun）；用户 = 正则字面量前 40 字符。 */
	name: string;
	/** 细化诊断：内置条目的语义标签。 */
	label?: string;
}

/** 用户正则字面量在 result 文案中的展示长度上限。 */
const USER_PATTERN_DISPLAY_LIMIT = 40;

function compileUserPattern(source: string): ForcePattern | undefined {
	// 防御性 compile：config normalize 已丢弃非法正则，此处再兜一层（不信任边界）
	try {
		return {
			re: new RegExp(CMD_ANCHOR + source),
			source: "user",
			name:
				source.length > USER_PATTERN_DISPLAY_LIMIT
					? `${source.slice(0, USER_PATTERN_DISPLAY_LIMIT)}…`
					: source,
		};
	} catch {
		return undefined;
	}
}

/**
 * 合并白名单（§3.5 行为矩阵）：
 *  - 零配置（无用户正则、不 disable）→ 两组内置全生效
 *  - disableBuiltinForcePatterns:true → 两组内置关闭
 *  - 用户正则始终追加（与内置并存时匹配任一即命中）
 */
export function compileForcePatterns(userPatterns: readonly string[], disableBuiltin: boolean): ForcePattern[] {
	const patterns: ForcePattern[] = [];
	if (!disableBuiltin) {
		for (const entry of FORCE_TEST_PATTERN_ENTRIES) {
			patterns.push({ re: entry.pattern, source: "builtin-test", name: "test", label: entry.label });
		}
		for (const entry of FORCE_LONGRUN_PATTERN_ENTRIES) {
			patterns.push({ re: entry.pattern, source: "builtin-longrun", name: "longrun", label: entry.label });
		}
	}
	for (const source of userPatterns) {
		const compiled = compileUserPattern(source);
		if (compiled !== undefined) patterns.push(compiled);
	}
	return patterns;
}

/** 白名单命中结果。 */
export interface ForcePatternMatch {
	source: ForceMatchSource;
	/** result 文案引用名（组名 test/longrun 或用户正则字面量前 40 字符）。 */
	name: string;
	/** 内置条目语义标签（用户正则无）。 */
	label?: string;
}

/** 判定命令是否命中白名单（命令位置锚定，见文件头「匹配语义」）。 */
export function matchForceBackground(command: string, patterns: readonly ForcePattern[]): ForcePatternMatch | undefined {
	for (const p of patterns) {
		if (p.re.test(command)) {
			return { source: p.source, name: p.name, ...(p.label !== undefined ? { label: p.label } : {}) };
		}
	}
	return undefined;
}

/** result 文案用的命中描述：内置组报组名 + 标签，用户正则报字面量。 */
export function describeForceMatch(match: ForcePatternMatch): string {
	if (match.source === "user") {
		return `user pattern '${match.name}'`;
	}
	return match.label !== undefined ? `pattern '${match.name}' (${match.label})` : `pattern '${match.name}'`;
}

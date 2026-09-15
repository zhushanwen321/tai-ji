// src/__tests__/force-patterns.test.ts —— M4 白名单：内置两组命中样例 / 锚定语义 /
// 合并矩阵三态 / 用户正则。锚定四例（参数文本不误伤）是设计 §3.5 的强制断言。
import { describe, expect, it } from "vitest";

import {
	compileForcePatterns,
	describeForceMatch,
	matchForceBackground,
	type ForcePattern,
} from "../force-patterns.ts";

function match(command: string, patterns: ForcePattern[]) {
	return matchForceBackground(command, patterns);
}

const DEFAULT_PATTERNS = compileForcePatterns([], false);

describe("内置 force-test 组命中样例（迁自 unified-hooks test-timeout-guard）", () => {
	const cases: Array<[string, string]> = [
		["npm test", "npm test"],
		["pnpm test", "npm test"],
		["yarn test", "npm test"],
		["bun test", "npm test"],
		["npm run test:unit", "npm run test"],
		["pnpm --filter @x/y run test", "npm run test"],
		["npx vitest run src/foo.test.ts", "vitest"],
		["npx jest --silent", "jest"],
		["npx mocha test/", "mocha"],
		["npx playwright test", "e2e runner"],
		["npx cypress run", "e2e runner"],
		["npx vue-cli-service test:unit", "vue-cli test"],
		["npx react-scripts test", "react-scripts test"],
		["./node_modules/.bin/vitest", "direct test runner"],
		["pytest -q", "pytest"],
		["python -m pytest", "python test"],
		["python3 -m unittest discover", "python test"],
		["uv run pytest", "uv/poetry pytest"],
		["poetry run pytest -x", "uv/poetry pytest"],
		["nosetests tests/", "nosetests"],
		["mvn test", "maven test"],
		["./mvnw test", "maven test"],
		["mvn integration-test", "maven test"],
		["gradle test --info", "gradle test"],
		["./gradlew test", "gradle test"],
		["sbt test", "sbt test"],
		["go test ./...", "go test"],
		["cargo test --all", "cargo test"],
		["dotnet test", "dotnet test"],
		["rspec spec/", "rspec"],
		["bundle exec rspec", "rspec"],
		["rake test", "rake test"],
	];
	for (const [command, label] of cases) {
		it(`${command} → label '${label}'`, () => {
			const result = match(command, DEFAULT_PATTERNS);
			expect(result).toBeDefined();
			expect(result?.source).toBe("builtin-test");
			expect(result?.name).toBe("test");
			expect(result?.label).toBe(label);
		});
	}
});

describe("内置 force-longrun 组命中样例（M4 定稿清单）", () => {
	const hitCases: Array<[string, string]> = [
		// dev server：npm run dev 系
		["npm run dev", "package run dev"],
		["pnpm run dev", "package run dev"],
		["yarn run dev", "package run dev"],
		["pnpm --filter web run dev", "package run dev"],
		["npm run dev:web", "package run dev"],
		["pnpm dev", "package dev"],
		["yarn dev", "package dev"],
		["bun dev", "package dev"],
		// dev server：npx 直接调用
		["npx vite", "vite"],
		["npx vite --port 5173", "vite"],
		["npx next dev", "next dev"],
		["npx nuxt dev", "nuxt dev"],
		["npx ng serve", "ng serve"],
		["npx webpack serve", "webpack serve"],
		["npx webpack-dev-server", "webpack-dev-server"],
		// dev server：语言内置 serve
		["python -m http.server 8080", "http.server"],
		["python3 manage.py runserver", "runserver"],
		["flask run", "flask run"],
		["rails server", "rails server"],
		["rails s -p 3001", "rails server"],
		["php artisan serve", "artisan serve"],
		// 显式 watch flags（直跑形态；npx vitest/jest --watch 会被 force-test 组先命中，
		// 两组动作一致都是强制后台，此处用直跑形态验证 watch 条目本身）
		["vitest --watch", "vitest/jest --watch"],
		["jest --watchAll", "vitest/jest --watch"],
		["tsc --watch", "tsc watch"],
		["tsc -w", "tsc watch"],
		["npx tsc --noEmit --watch", "tsc watch"],
		["sass --watch src:dist", "build --watch"],
		["webpack --watch", "build --watch"],
		["npx esbuild src.js --watch --outdir=dist", "build --watch"],
		// 天然长驻
		["cargo watch -x test", "cargo watch"],
		["watchexec make build", "watchexec"],
		["nodemon server.js", "nodemon"],
		["tail -f /var/log/system.log", "tail -f"],
		["tail -n 100 -f app.log", "tail -f"],
		["tail -F /var/log/syslog", "tail -f"],
		["ngrok http 3000", "ngrok"],
	];
	for (const [command, label] of hitCases) {
		it(`${command} → label '${label}'`, () => {
			const result = match(command, DEFAULT_PATTERNS);
			expect(result).toBeDefined();
			expect(result?.source).toBe("builtin-longrun");
			expect(result?.name).toBe("longrun");
			expect(result?.label).toBe(label);
		});
	}

	const missCases = [
		// dev server 误伤排除：build 有自然退出点
		"npm run build",
		"npx vite build",
		"vite build --watch", // 非 npx 直跑 vite build（罕见形态）不做工具名白名单外的猜测
		"npm run lint",
		"npm run deploy",
		// watch flag 形态排除：显式关 watch / 无 watch flag
		"vitest --watch=false",
		"jest --watchAll=false",
		"tsc --noEmit",
		"sass src:dist",
		// tail 无 -f
		"tail -n 20 app.log",
		"tail app.log",
		// 相似词不误伤
		"tailwind -i input.css",
		"cargo build",
		"watch_node_modules.sh",
		"dev_setup.sh",
	];
	for (const command of missCases) {
		it(`${command} 不命中任何组（build/lint/无 watch flag 有自然退出点或非命令文本）`, () => {
			expect(match(command, DEFAULT_PATTERNS)).toBeUndefined();
		});
	}
});

describe("锚定语义（命令位置锚定，防参数文本误伤——§3.5 强制四例）", () => {
	const cases: Array<{ command: string; hit: boolean; why: string }> = [
		// ① 必须不命中：commit message 参数里的 "npm test" 是文本不是命令
		{ command: `git commit -m "fix: npm test"`, hit: false, why: "参数文本不是命令位置" },
		// ② 必须不命中：watch 是 grep 的参数值，不是 flag
		{ command: "rg --files | grep watch", hit: false, why: "grep watch 的 watch 是参数不是 flag" },
		// ③ 必须命中：&& 之后是新命令起始位
		{ command: "echo hi && npm test", hit: true, why: "&& 之后是命令位置" },
		// ④ 必须命中：行首
		{ command: "npm test", hit: true, why: "行首命令位置" },
	];
	for (const { command, hit, why } of cases) {
		it(`${JSON.stringify(command)} ${hit ? "命中" : "不命中"}（${why}）`, () => {
			expect(match(command, DEFAULT_PATTERNS) !== undefined).toBe(hit);
		});
	}

	it("其余命令位置分隔符（; / || / | / 换行）之后的命令同样命中", () => {
		expect(match("cd /tmp; npm test", DEFAULT_PATTERNS)).toBeDefined();
		expect(match("false || npx vitest", DEFAULT_PATTERNS)).toBeDefined();
		expect(match("git pull\nnpm test", DEFAULT_PATTERNS)).toBeDefined();
		expect(match("rg --files | npx jest", DEFAULT_PATTERNS)).toBeDefined();
		// 引号内的命令文本不命中（引号不是命令分隔符）
		expect(match(`echo "vitest --watch"`, DEFAULT_PATTERNS)).toBeUndefined();
		expect(match(`echo "npm run dev"`, DEFAULT_PATTERNS)).toBeUndefined();
		expect(match(`git commit -m "run dev server"`, DEFAULT_PATTERNS)).toBeUndefined();
		expect(match(`grep tail -f README.md`, DEFAULT_PATTERNS)).toBeUndefined();
		// 词中子串不命中
		expect(match("npm testing", DEFAULT_PATTERNS)).toBeUndefined();
		expect(match("mytsc --watchish", DEFAULT_PATTERNS)).toBeUndefined();
	});
});

describe("合并矩阵（§3.5 配置开关 × 组）", () => {
	it("零配置：两组内置均生效", () => {
		const patterns = compileForcePatterns([], false);
		expect(match("npm test", patterns)?.source).toBe("builtin-test");
		expect(match("tail -f app.log", patterns)?.source).toBe("builtin-longrun");
	});

	it("disableBuiltinForcePatterns:true：两组内置关闭", () => {
		const patterns = compileForcePatterns([], true);
		expect(match("npm test", patterns)).toBeUndefined();
		expect(match("tail -f app.log", patterns)).toBeUndefined();
		expect(match("npx vite", patterns)).toBeUndefined();
	});

	it("用户正则追加（与内置并存，匹配任一即命中）", () => {
		const patterns = compileForcePatterns(["sleep \\d+"], false);
		expect(match("sleep 999", patterns)?.source).toBe("user");
		// 内置两组不受影响
		expect(match("npm test", patterns)?.source).toBe("builtin-test");
		expect(match("ngrok http 3000", patterns)?.source).toBe("builtin-longrun");
	});

	it("disableBuiltin + 用户正则：仅用户正则生效", () => {
		const patterns = compileForcePatterns(["sleep \\d+"], true);
		expect(match("sleep 999", patterns)?.source).toBe("user");
		expect(match("npm test", patterns)).toBeUndefined();
	});

	it("用户正则同样命令位置锚定：参数文本不误伤、链式后段命中", () => {
		const patterns = compileForcePatterns(["sleep \\d+"], false);
		expect(match("echo sleep 999", patterns)).toBeUndefined();
		expect(match("git commit -m \"sleep 999\"", patterns)).toBeUndefined();
		expect(match("echo hi && sleep 999", patterns)?.source).toBe("user");
	});
});

describe("匹配结果报告（result 文案引用）", () => {
	it("内置命中报组名 + 条目标签", () => {
		expect(describeForceMatch(match("npm test", DEFAULT_PATTERNS)!)).toBe("pattern 'test' (npm test)");
		expect(describeForceMatch(match("tail -f x", DEFAULT_PATTERNS)!)).toBe("pattern 'longrun' (tail -f)");
	});

	it("用户正则报字面量前 40 字符（超长截断加省略号）", () => {
		const short = compileForcePatterns(["sleep \\d+"], true);
		expect(describeForceMatch(match("sleep 1", short)!)).toBe("user pattern 'sleep \\d+'");
		const longPattern = "a".repeat(45);
		const long = compileForcePatterns([longPattern], true);
		const described = describeForceMatch(match("a".repeat(45), long)!);
		expect(described).toBe(`user pattern '${"a".repeat(40)}…'`);
	});
});

/**
 * PS-30 探针：pi ExtensionRunner 的 stale ctx 错误文案契约（crash-resilience D1 守卫
 * 分诊词锁，docs/pi-semantics.json PS-30）。
 *
 * 断言方式（静态直读 dist，同 packages/runtime pi-semantics-prompt-rejection.test.ts 范式）：
 * - runner.js：`invalidate()` 默认 message 含 "stale after session replacement"
 *   （staleMessage 的唯一写入点）+ `assertActive()` 的 `throw new Error(this.staleMessage)`
 *   形态（E1 崩溃堆栈帧 `assertActive → sendUserMessage` 的实装机制）。
 * - loader.js：pi API（sendMessage / sendUserMessage / appendEntry）的 `assertActive()`
 *   前置——守卫分诊词覆盖「跨 session 存活回调触碰捕获 pi」的面。
 * - runner.js：ctx 的 compact / abort / shutdown 受 assertActive 保护——守卫分诊词
 *   同样覆盖「回调触碰捕获 ctx」的面。
 *
 * 该文案是 ext-guards `guardStaleCtx` 的兜底分诊依据（代际检测为主判，本文案为
 * reload 盲区兜底）。pi 升级红 = 文案/机制漂移：守卫退化为「全部上抛」（回到现状
 * 崩溃链路，不更危险），同步 ext-guards STALE_CTX_MARKER 与本文档引用后更新 verifiedWith。
 *
 * 运行：cd extensions/shared/ext-guards && npx vitest run src/__tests__/pi-semantics-stale-ctx-wording.test.ts
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 定位实装 pi-coding-agent dist（cwd 逐级上溯，同 runtime 探针范式）。 */
function locatePiCodingAgentDist(): string | null {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
		if (existsSync(join(candidate, "core", "extensions", "runner.js"))) return candidate;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const PI_DIST = locatePiCodingAgentDist();
const SKIP_REASON = PI_DIST
	? ""
	: "node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯未命中，零依赖包无 pi devDep——在仓库根或任意可解析 pi 的目录跑 extensions:test）";
// skip 提示由 describe.skipIf 的标题携带（下行 SKIP_REASON 已拼入），不经 console

const RUNNER_SRC = PI_DIST ? readFileSync(join(PI_DIST, "core", "extensions", "runner.js"), "utf-8") : "";
const LOADER_SRC = PI_DIST ? readFileSync(join(PI_DIST, "core", "extensions", "loader.js"), "utf-8") : "";

describe.skipIf(!PI_DIST)(
	`PS-30 探针：stale ctx 错误文案与 assertActive 机制${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ""}`,
	() => {
		it("invalidate() 默认 message 含 stale after session replacement（守卫兜底分诊词的 pi 侧源头）", () => {
			expect(
				RUNNER_SRC.includes("stale after session replacement"),
				"PS-30 漂移：stale 默认文案消失/变更——guardStaleCtx 文案兜底分诊失效退化为全部上抛（回到现状崩溃链路），同步 ext-guards STALE_CTX_MARKER 后更新 verifiedWith",
			).toBe(true);
		});

		it("assertActive 以 throw new Error(this.staleMessage) 同步抛错（E1 崩溃机制的实装锚点）", () => {
			const assertIdx = RUNNER_SRC.indexOf("assertActive() {");
			expect(assertIdx, "PS-30 漂移：assertActive 方法消失/改名——复核 runner.js 锚点").toBeGreaterThanOrEqual(0);
			const body = RUNNER_SRC.slice(assertIdx, assertIdx + 300);
			expect(
				body.includes("throw new Error(this.staleMessage)"),
				"PS-30 漂移：assertActive 不再同步 throw staleMessage——E1 型崩溃机制改形，复核 guardStaleCtx 分诊前提",
			).toBe(true);
		});

		it("pi API（sendMessage/sendUserMessage/appendEntry）前置 assertActive（守卫覆盖捕获 pi 的触碰面）", () => {
			for (const method of ["sendMessage(message, options)", "sendUserMessage(content, options)", "appendEntry(customType, data)"]) {
				const idx = LOADER_SRC.indexOf(method);
				expect(idx, `PS-30 漂移：loader.js pi API ${method} 消失/改签名——复核锚点`).toBeGreaterThanOrEqual(0);
				const window = LOADER_SRC.slice(idx, idx + 160);
				expect(
					window.includes("assertActive()"),
					`PS-30 漂移：pi API ${method} 不再前置 assertActive——stale 触碰面改形，复核守卫分诊词的覆盖面`,
				).toBe(true);
			}
		});

		it("ctx 的 compact/abort/shutdown 受 assertActive 保护（守卫覆盖捕获 ctx 的触碰面）", () => {
			for (const entry of ["compact: (options) => {", "abort: () => {", "shutdown: () => {"]) {
				const idx = RUNNER_SRC.indexOf(entry);
				expect(idx, `PS-30 漂移：ctx.${entry.replace(/[: ].*/, "")} 定义消失/改形——复核 createContext 锚点`).toBeGreaterThanOrEqual(0);
				const window = RUNNER_SRC.slice(idx, idx + 200);
				expect(
					window.includes("assertActive()"),
					`PS-30 漂移：ctx.${entry.replace(/[: ].*/, "")} 不再受 assertActive 保护——stale 触碰面改形，复核守卫分诊词的覆盖面`,
				).toBe(true);
			}
		});
	},
);

/**
 * footer-provider.test.ts — consumer 端握手协议 + footer 渲染测试。
 *
 * 覆盖：
 *  - TC1：slot 不存在 → consumer 建新 slot（仅 pending，registry 空）
 *  - TC2：slot 存在 + registry 就绪 → 直接 register（不走 pending）
 *  - TC3：slot 存在 + registry 未就绪 → push pending
 *  - TC4：dispose（registry 就绪路径）→ unregister + requestFooterRender
 *  - TC5：dispose（pending 路径）→ 从 pending 移除 + requestFooterRender
 *  - TC6：requestFooterRender（statusline 未安装）→ noop（不抛）
 *  - TC7：requestFooterRender（已注册 fn）→ 调用 fn
 *  - TC8：version mismatch → readSlot 返回 undefined + warn + ensureSlot 重建
 *  - TC13：dispose 幂等（重复调用安全）
 *  - 渲染：renderPermissionFooterLine 四档模式 + enabled/disabled
 *  - 字面量跨端一致：FOOTER_HANDSHAKE_KEY / REQUEST_RENDER_KEY 与 statusline owner 端 ===
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

import {
	FOOTER_HANDSHAKE_KEY,
	type FooterLineRenderer,
	registerPermissionFooterLine,
	renderPermissionFooterLine,
	REQUEST_RENDER_KEY,
	requestFooterRender,
} from "../footer-provider.js";
import type { PermissionPalette } from "../statusline-palette.js";
import type { PermissionMode } from "../types.js";
import { MODE_LABELS } from "../types.js";

// ──────────────────────── mock helpers ────────────────────────

/** 透传 palette（不加 ANSI，便于断言原始字符串）。 */
function passthroughPalette(): PermissionPalette {
	return {
		dim: (s) => s,
		text: (s) => s,
		accent: (s) => s,
		success: (s) => s,
		warning: (s) => s,
	};
}

/** 构造最小 renderer（render 返回固定行）。 */
function makeRenderer(order = 2, line = "permission-line"): FooterLineRenderer {
	return {
		order,
		render: () => line,
	};
}

/**
 * mock registry 的显式返回类型。
 *
 * 结构上兼容 footer-provider.ts 的 FooterLineRegistry 接口（register/unregister），
 * 额外暴露 has/calls 供断言。footer-provider.ts 的 FooterLineRegistry 未导出，
 * 这里用结构等价契约绑定：若 footer-provider.ts 的 registry 接口签名漂移（如
 * register 增加 id 规范化、unregister 改名），mock 会在传入 slot.registry 时
 * 编译期暴露（slot 字面量的 registry 字段需满足该结构）。
 *
 * register 的 renderer 参数用导出的 FooterLineRenderer 替代原先的 unknown，
 * 让 mock 与 consumer 端 renderer 契约漂移时编译期即可发现。
 */
interface MockFooterRegistry {
	register(id: string, renderer: FooterLineRenderer): void;
	unregister(id: string): void;
	has(id: string): boolean;
	calls: { op: "register" | "unregister"; id: string }[];
}

/** mock registry：记录 register/unregister 调用，内部 Map 存储。 */
function makeRegistry(): MockFooterRegistry {
	const map = new Map<string, FooterLineRenderer>();
	const calls: { op: "register" | "unregister"; id: string }[] = [];
	return {
		register(id: string, renderer: FooterLineRenderer): void {
			calls.push({ op: "register", id });
			map.set(id, renderer);
		},
		unregister(id: string): void {
			calls.push({ op: "unregister", id });
			map.delete(id);
		},
		has: (id: string): boolean => map.has(id),
		calls,
	};
}

/** 读当前 slot（version 守卫后）。 */
function getRawSlot(): unknown {
	return Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY);
}

/** 清理 globalThis 上的握手 slot + requestRender fn（每个测试隔离）。 */
function cleanGlobalThis(): void {
	Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
}

beforeEach(() => {
	cleanGlobalThis();
});

afterEach(() => {
	cleanGlobalThis();
});

// ──────────────────────── TC1：slot 不存在 → consumer 建新 slot（pending） ────────────────────────

describe("TC1：slot 不存在 → consumer 建新 slot（仅 pending，registry 空）", () => {
	it("无 slot 时注册 → 新 slot 含 pending 一项，registry 未定义", () => {
		expect(getRawSlot()).toBeUndefined();
		registerPermissionFooterLine(makeRenderer());
		const slot = getRawSlot() as { version: number; registry?: unknown; pending: unknown[] };
		expect(slot).toBeDefined();
		expect(slot.version).toBe(1);
		expect(slot.registry).toBeUndefined(); // consumer 永不创建 registry
		expect(slot.pending).toHaveLength(1);
		expect((slot.pending[0] as { id: string }).id).toBe("pi-permission");
	});
});

// ──────────────────────── TC2：slot 存在 + registry 就绪 → 直接 register ────────────────────────

describe("TC2：slot 存在 + registry 就绪 → 直接 register（不走 pending）", () => {
	it("registry 已就绪 → 调 registry.register，pending 不变", () => {
		const registry = makeRegistry();
		// 预置 owner 端就绪的 slot（registry 已填）
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, {
			version: 1,
			registry,
			pending: [],
		});
		registerPermissionFooterLine(makeRenderer());
		expect(registry.has("pi-permission")).toBe(true);
		expect(registry.calls.filter((c) => c.op === "register")).toHaveLength(1);
	});
});

// ──────────────────────── TC3：slot 存在 + registry 未就绪 → push pending ────────────────────────

describe("TC3：slot 存在 + registry 未就绪 → push pending", () => {
	it("slot 存在但 registry 空 → 新 entry 进 pending（不调 register）", () => {
		// 预置一个 consumer 先建的空 slot（pending 已有别的 entry）
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, {
			version: 1,
			pending: [{ id: "other", renderer: makeRenderer(0) }],
		});
		registerPermissionFooterLine(makeRenderer());
		const slot = getRawSlot() as { pending: { id: string }[] };
		expect(slot.pending).toHaveLength(2);
		expect(slot.pending.some((p) => p.id === "pi-permission")).toBe(true);
	});
});

// ──────────────────────── TC4：dispose（registry 就绪）→ unregister ────────────────────────

describe("TC4：dispose（registry 就绪路径）→ unregister + requestFooterRender", () => {
	it("registry 就绪时 dispose → registry.unregister + 调 requestRender fn", () => {
		const registry = makeRegistry();
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, {
			version: 1,
			registry,
			pending: [],
		});
		const renderFn = vi.fn();
		Reflect.set(globalThis, REQUEST_RENDER_KEY, renderFn);

		const dispose = registerPermissionFooterLine(makeRenderer());
		expect(registry.has("pi-permission")).toBe(true);
		dispose();
		expect(registry.has("pi-permission")).toBe(false);
		expect(renderFn).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── TC5：dispose（pending 路径）→ 从 pending 移除 ────────────────────────

describe("TC5：dispose（pending 路径）→ 从 pending 移除 + requestFooterRender", () => {
	it("registry 未就绪时 dispose → pending 过滤掉 pi-permission + 调 requestRender fn", () => {
		// 空 slot（pending 路径）
		const renderFn = vi.fn();
		Reflect.set(globalThis, REQUEST_RENDER_KEY, renderFn);

		const dispose = registerPermissionFooterLine(makeRenderer());
		const slotBefore = getRawSlot() as { pending: { id: string }[] };
		expect(slotBefore.pending).toHaveLength(1);

		dispose();
		const slotAfter = getRawSlot() as { pending: { id: string }[] };
		expect(slotAfter.pending.some((p) => p.id === "pi-permission")).toBe(false);
		expect(renderFn).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── TC6/TC7：requestFooterRender ────────────────────────

describe("TC6/TC7：requestFooterRender", () => {
	it("TC6：statusline 未安装（无 REQUEST_RENDER_KEY）→ noop，不抛异常", () => {
		expect(() => requestFooterRender()).not.toThrow();
	});

	it("TC7：已注册 fn → 调用 fn", () => {
		const fn = vi.fn();
		Reflect.set(globalThis, REQUEST_RENDER_KEY, fn);
		requestFooterRender();
		expect(fn).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── TC8：version mismatch → 重建 slot ────────────────────────

describe("TC8：version mismatch → readSlot 丢弃 + ensureSlot 重建", () => {
	it("slot.version !== 1 → 注册时建新 slot（丢弃旧的），并 logger.warn", () => {
		loggerMock.warn.mockClear();
		// 污染槽位：version=99
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, {
			version: 99,
			pending: [],
		});
		registerPermissionFooterLine(makeRenderer());
		const slot = getRawSlot() as { version: number; pending: unknown[] };
		expect(slot.version).toBe(1); // 重建为 version=1
		expect(slot.pending).toHaveLength(1);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("version mismatch"),
			expect.any(Object),
		);
	});

	it("pending 非 Array → 视为无 slot，重建", () => {
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, {
			version: 1,
			pending: "not-an-array",
		});
		registerPermissionFooterLine(makeRenderer());
		const slot = getRawSlot() as { pending: unknown[] };
		expect(Array.isArray(slot.pending)).toBe(true);
		expect(slot.pending).toHaveLength(1);
	});
});

// ──────────────────────── TC13：dispose 幂等 ────────────────────────

describe("TC13：dispose 幂等（重复调用安全）", () => {
	it("dispose 两次 → 第二次 noop（once-guard：不重复 unregister / requestRender）", () => {
		const registry = makeRegistry();
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, {
			version: 1,
			registry,
			pending: [],
		});
		const renderFn = vi.fn();
		Reflect.set(globalThis, REQUEST_RENDER_KEY, renderFn);

		const dispose = registerPermissionFooterLine(makeRenderer());
		dispose();
		// 第二次：once-guard 生效，不应再触发副作用
		expect(() => dispose()).not.toThrow();
		expect(registry.calls.filter((c) => c.op === "unregister")).toHaveLength(1);
		expect(renderFn).toHaveBeenCalledOnce();
	});

	it("dispose 后 slot 整个被删 → 再次 dispose 不抛（once-guard）", () => {
		const dispose = registerPermissionFooterLine(makeRenderer());
		Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
		expect(() => dispose()).not.toThrow();
	});
});

// ──────────────────────── renderPermissionFooterLine 渲染 ────────────────────────

describe("renderPermissionFooterLine（mode + enabled + rule count + classifier）", () => {
	const ALL_MODES: PermissionMode[] = ["yolo", "auto", "approve", "strict"];

	it("enabled=true 非 auto → '[permission] <LABEL> · enabled · N user rules'", () => {
		const palette = passthroughPalette();
		for (const mode of ALL_MODES.filter((m) => m !== "auto")) {
			const line = renderPermissionFooterLine(mode, true, 3, "gpt-4", palette);
			expect(line).toContain("[permission]");
			expect(line).toContain(MODE_LABELS[mode]);
			expect(line).toContain("enabled");
			expect(line).toContain("3 user rules");
			// 非 auto 模式不显示 classifier
			expect(line).not.toContain("classifier");
		}
	});

	it("enabled=true + auto 模式 + 有 model → 含 classifier model", () => {
		const palette = passthroughPalette();
		const line = renderPermissionFooterLine("auto", true, 2, "zhipu/glm-4-flash", palette);
		expect(line).toContain("[permission]");
		expect(line).toContain(MODE_LABELS["auto"]);
		expect(line).toContain("enabled");
		expect(line).toContain("2 user rules");
		expect(line).toContain("classifier: zhipu/glm-4-flash");
	});

	it("enabled=true + auto 模式 + model 为空 → 不显示 classifier 段", () => {
		const palette = passthroughPalette();
		const line = renderPermissionFooterLine("auto", true, 0, "", palette);
		expect(line).toContain("0 user rules");
		expect(line).not.toContain("classifier");
	});

	it("enabled=true + ruleCount=1 → 'rule'（单数）", () => {
		const palette = passthroughPalette();
		const line = renderPermissionFooterLine("strict", true, 1, "", palette);
		expect(line).toContain("1 user rule");
		expect(line).not.toContain("1 user rules");
	});

	it("enabled=false → '[permission] disabled'（不含 LABEL/rule/classifier）", () => {
		const palette = passthroughPalette();
		for (const mode of ALL_MODES) {
			const line = renderPermissionFooterLine(mode, false, 3, "gpt-4", palette);
			expect(line).toContain("[permission]");
			expect(line).toContain("disabled");
			// disabled 时精简：不显示 mode label / rule count / classifier
			expect(line).not.toContain(MODE_LABELS[mode]);
			expect(line).not.toContain("rule");
			expect(line).not.toContain("classifier");
		}
	});

	it("返回单行字符串（非数组）", () => {
		const line = renderPermissionFooterLine("auto", true, 1, "gpt-4", passthroughPalette());
		expect(typeof line).toBe("string");
	});
});

// ──────────────────────── 字面量跨端一致（与 statusline owner 端 === ） ────────────────────────

describe("协议字面量跨端一致（permission consumer === statusline owner）", () => {
	it("FOOTER_HANDSHAKE_KEY 是 Symbol.for 同一字符串（Symbol.for 跨 realm 同引用）", () => {
		expect(FOOTER_HANDSHAKE_KEY).toBe(Symbol.for("@zhushanwen/pi-statusline.footerHandshake"));
	});

	it("REQUEST_RENDER_KEY 是 Symbol.for 同一字符串", () => {
		expect(REQUEST_RENDER_KEY).toBe(Symbol.for("@zhushanwen/pi-statusline.requestRender"));
	});
});

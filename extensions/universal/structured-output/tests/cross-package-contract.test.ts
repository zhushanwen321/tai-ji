// 跨包契约测试（MF-6）：structured-output ↔ subagent-workflow
//
// 两包是独立 npm 包不能直接 import（发布产物里跨包相对 import 悬空）——env 名 /
// schema 大小上限等契约常量各自保留副本，本文件在测试期动态 import SW 侧源码叶子
// 模块，锁「字节相等」防止任一端静默改名/改值（漂移守卫）。
//
// 降级策略：SW 侧叶子模块未就位 / 模块结构不符（import 失败、导出缺失）时，
// 用例 skip，不阻塞本包测试；SW 侧抽出/导出后自动生效。
//
// ② 组背景（mock 失真图谱）：两包测试环境都把 "typebox" alias 到本地 mock
//（mocks/typebox.ts），mock 的 Type.String/Object 直接丢弃 options（description/
// pattern/maxLength 全丢）、Type.Optional 只加标记不生成 required——schema 若经
// mock 构造，这些语义天生不存在。故 ② 组用 vi.doMock 把真实 typebox 注入
// "typebox" 解析位后再动态 import SW 叶子，schema 才是真实构造；③ 组再用真实
// pi-ai 的 validateToolArguments（SO 环境无 pi-ai alias，直连根 node_modules
// 实装版）对同一 schema 跑端到端校验路径，构成 mock 失真的最小真实面防线。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ENV_SCHEMA, SO_SCHEMA_SIZE_WARN_BYTES } from "../src/index.js";

// 本包 vitest alias 把 "typebox" 指向本地 mock；createRequire 走 node 解析绕过
// alias 拿真实 typebox（v1 系，npm 包名 typebox；require(esm) 返回模块命名空间）。
const nodeRequire = createRequire(import.meta.url);
const REAL_TYPEBOX = nodeRequire("typebox") as {
  Type: Record<string, (...args: unknown[]) => unknown>;
};
const REAL_TYPEBOX_COMPILE = nodeRequire("typebox/compile") as {
  Compile: (schema: unknown) => { Check: (value: unknown) => boolean; Errors: (value: unknown) => Iterable<{ message: string; instancePath: string }> };
};

/**
 * 动态 import 相对路径（本文件目录为基准）。注：不能用裸相对 specifier——Vite
 * 运行时对变量的相对 specifier 会相对项目根折叠（"../../x" → "/x"，实测）
 * 而非相对本文件；file URL 绝对路径是稳定通路。
 */
async function dynamicImportRelative(spec: string): Promise<unknown> {
	const here = dirname(fileURLToPath(import.meta.url));
	return import(pathToFileURL(join(here, spec)).href);
}

// ── ① schema env 契约（PI_WORKFLOW_SCHEMA / 256KiB 上限）─────────────────

/**
 * 对端叶子模块候选路径（相对本文件）。对端调整叶子布局时在此追加候选。
 * 契约对端迁移史：subagent-workflow 包 → packages/subagent-core shared/schema-env.ts
 *（死副本已删）→ 现 SSOT = packages/pi-subagent-cli/src/constants.ts（零依赖纯常量
 * 叶子；硬拒线消费方为 pi 侧 spawn-args.ts applySchemaEnvToChildEnv）。
 */
const SW_SCHEMA_ENV_CANDIDATES = [
	"../../../../packages/pi-subagent-cli/src/constants.ts",
];

async function tryImportSwSchemaEnv(): Promise<Record<string, unknown> | undefined> {
	for (const spec of SW_SCHEMA_ENV_CANDIDATES) {
		try {
			const mod = (await dynamicImportRelative(spec)) as Record<string, unknown>;
			if (mod && typeof mod.SCHEMA_ENV_VAR === "string") return mod;
		} catch {
			// 模块不存在 / 依赖链断裂 → 下一候选（SW 侧叶子未就位时用例 skip）
		}
	}
	return undefined;
}

describe("cross-package contract: schema env（structured-output ↔ pi-subagent-cli）", () => {
	it("SW SCHEMA_ENV_VAR 与 SO ENV_SCHEMA 字节相等（env 名漂移守卫）", async (ctx) => {
		const mod = await tryImportSwSchemaEnv();
		if (!mod) {
			// SW 侧叶子模块未就位（schema-env.ts 被移动/改名）时的降级 skip；
			// 期间两侧常量靠各自 [跨包契约 SSOT] 注释人工对齐。
			ctx.skip();
			return;
		}
		expect(mod.SCHEMA_ENV_VAR).toBe(ENV_SCHEMA);
	});

	it("SW SCHEMA_ENV_MAX_BYTES 与 SO SO_SCHEMA_SIZE_WARN_BYTES 字节相等（SO 提示线 = SW 硬拒线，SO-DATA-4）", async (ctx) => {
		const mod = await tryImportSwSchemaEnv();
		if (!mod || typeof mod.SCHEMA_ENV_MAX_BYTES !== "number") {
			ctx.skip(); // 降级 skip，同上
			return;
		}
		expect(mod.SCHEMA_ENV_MAX_BYTES).toBe(SO_SCHEMA_SIZE_WARN_BYTES);
	});
});

// ── ② SW tool schema 常量校验（真实 typebox 构造 + 编译，mock 失真对照基准）────────────

/** SW 侧 schema 叶子候选路径（相对本文件）。SW 侧调整叶子布局时在此追加候选。 */
const SW_TOOL_SCHEMA_CANDIDATES = ["../../subagent-workflow/src/interface/subagent-tool-schema.ts"];

/**
 * 动态 import SW schema 叶子，拿真实 typebox 构造的 SubagentParams。
 *
 * 关键通路：SW 叶子经 `import { Type } from "typebox"` 构造 schema，而本包 vitest
 * alias 会把 "typebox" 劫持到本地 mock（丢 options / 不生成 required）——先用
 * vi.doMock 把真实 typebox 注入 "typebox" 解析位（doMock 注册在 alias 解析后的
 * resolved id 上，与叶子 import 命中同一 id），叶子才是真实构造。加载后立即
 * doUnmock，不影响本包其他测试的 mock 语义。
 */
async function importSwSubagentSchema(): Promise<Record<string, unknown> | undefined> {
	for (const spec of SW_TOOL_SCHEMA_CANDIDATES) {
		try {
			vi.doMock("typebox", () => REAL_TYPEBOX);
			try {
				const mod = (await dynamicImportRelative(spec)) as Record<string, unknown>;
				const schema = mod.SubagentParams;
				if (schema !== null && typeof schema === "object" && "properties" in schema) return mod;
			} finally {
				vi.doUnmock("typebox");
			}
		} catch {
			// SW 叶子未就位 / 依赖链在 SO 环境不可解析 → 下一候选（降级 skip）
		}
	}
	return undefined;
}

/** schema 上的关键字段视图（局部结构类型，禁止 any）。 */
interface SchemaView {
	properties: Record<string, Record<string, unknown>>;
	required?: unknown;
}

function asSchemaView(schema: unknown): SchemaView {
	if (schema === null || typeof schema !== "object") {
		throw new Error("SW SubagentParams is not an object schema");
	}
	const rec = schema as Record<string, unknown>;
	if (rec.properties === null || typeof rec.properties !== "object") {
		throw new Error("SW SubagentParams has no properties");
	}
	return { properties: rec.properties as SchemaView["properties"], required: rec.required };
}

/** 断言 properties[key] 声明了非空 string description（转换链路丢 description = 模型理解被削弱）。 */
function expectDescription(props: SchemaView["properties"], key: string): void {
	const desc = props[key]?.description;
	expect(typeof desc === "string" && desc.length > 0, `properties.${key}.description preserved as non-empty string`).toBe(true);
}

describe("cross-package contract: SW subagent tool schema（真实 typebox 校验）", () => {
	let mod: Record<string, unknown> | undefined;

	it("SW 叶子定位 + 真实 typebox 构造形态存活（required/description/enum/pattern/maxLength）", async (ctx) => {
		mod = await importSwSubagentSchema();
		if (!mod) {
			// SW 侧叶子未就位（subagent-tool-schema.ts 被移动/改名）时的降级 skip；
			// 期间 schema 回归由 SW 包自身测试覆盖（但那侧是 mock typebox，无此防线）。
			ctx.skip();
			return;
		}
		const schema = asSchemaView(mod.SubagentParams);

		// required 存活：真实 Type.Object 收集非 Optional 字段；mock 构造无 required 键。
		// 精确断言（非仅「存在」）：顶层唯一必填是 action，改必填集必须同时改本断言。
		expect(schema.required, "SubagentParams.required preserved by real typebox").toEqual(["action"]);

		// action：枚举 + description（StringEnum 的 options 在 mock pi-ai/SW mock 下均被丢弃，
		// 真实 pi-ai StringEnum 才保留——本断言即「SO 环境解析到真实 pi-ai」的间接守卫）
		// 6 值含 fork-from（SW v8.5 断联恢复通道；schema 合法扩展 action 时同步本断言）
		expect(schema.properties.action?.enum).toEqual(["start", "list", "cancel", "message", "close", "fork-from"]);
		expectDescription(schema.properties, "action");

		// start 路径类参数：pattern ^/（R6 加入的绝对路径约束）+ description
		expect(schema.properties.skillPath?.pattern, "skillPath.pattern preserved").toBe("^/");
		expect(schema.properties.cwd?.pattern, "cwd.pattern preserved").toBe("^/");
		expectDescription(schema.properties, "skillPath");
		expectDescription(schema.properties, "cwd");

		// slug maxLength 与 SW 侧 SLUG_MAX_LENGTH 常量联动（抽叶子后同址）
		expect(schema.properties.slug?.maxLength, "slug.maxLength === SLUG_MAX_LENGTH").toBe(mod.SLUG_MAX_LENGTH);
		expect(mod.SLUG_MAX_LENGTH).toBe(35);
		expectDescription(schema.properties, "slug");
		expectDescription(schema.properties, "task");

		// thinkingLevel 枚举 = THINKING_ORDER SSOT（叶子从 shared/model-ref 派生）
		expect(schema.properties.thinkingLevel?.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

		// 嵌套对象 required 存活：messageParam.subagentId/text 非 Optional → 嵌套 required
		const messageParam = schema.properties.messageParam as SchemaView | undefined;
		expect(messageParam?.required, "nested messageParam.required preserved").toEqual(["subagentId", "text"]);
		// 30s：本用例承担 SW schema 叶子的首载 transform（动态 import TS 源 + 真实
		// typebox/pi-ai 依赖链），CI 冷缓存下超 vitest 默认 5s 实测两连红（本地暖
		// 缓存 510ms）；后续用例复用模块缓存不受影响。
	}, 30_000);

	it("真实 typebox 编译成功 + Check 行为正确（合法通过 / 非法 action 与缺 required 被拒）", async (ctx) => {
		if (!mod) mod = await importSwSubagentSchema();
		if (!mod) {
			ctx.skip();
			return;
		}
		const compiled = REAL_TYPEBOX_COMPILE.Compile(mod.SubagentParams);
		expect(typeof compiled.Check).toBe("function");
		// 合法最小 args 通过（action:"list" 无必填 param）
		expect(compiled.Check({ action: "list" })).toBe(true);
		// 非法 action 被枚举拒绝
		expect(compiled.Check({ action: "bogus" })).toBe(false);
		// 缺 required 被拒
		expect(compiled.Check({})).toBe(false);
		// skillPath 相对穿越被 pattern ^/ 拒绝；绝对路径通过
		expect(compiled.Check({ action: "start", skillPath: "../etc" })).toBe(false);
		expect(compiled.Check({ action: "start", skillPath: "/abs/skills/x" })).toBe(true);
	});

	it("对照：mock typebox 构造确实丢 required/description（本组断言对 mock 失真敏感的自校验）", async () => {
		// SW 包内 mock（零依赖文件，SO 环境可加载）：Type.String 丢 options、Optional 只加标记
		const swMock = (await dynamicImportRelative("../../subagent-workflow/mocks/typebox.ts")) as {
			Type: Record<string, (...args: unknown[]) => unknown>;
		};
		const swBuilt = swMock.Type.Object({ action: swMock.Type.String({ description: "op", pattern: "^/" }) }) as SchemaView;
		expect(swBuilt.required, "SW mock loses required").toBeUndefined();
		expect((swBuilt.properties.action as Record<string, unknown> | undefined)?.description, "SW mock drops description option").toBeUndefined();
		expect((swBuilt.properties.action as Record<string, unknown> | undefined)?.pattern, "SW mock drops pattern option").toBeUndefined();

		// SO 本地 mock（静态 import 经本包 alias）：同样的失真形态
		const { Type: soMockType } = await import("typebox");
		const soBuilt = soMockType.Object({ action: soMockType.String({ description: "op" }) }) as SchemaView;
		expect(soBuilt.required, "SO mock loses required").toBeUndefined();
		expect((soBuilt.properties.action as Record<string, unknown> | undefined)?.description, "SO mock drops description option").toBeUndefined();
		// 上面两个用例若因 mock 被「修好」而变红：那是 mock 保真度提升，同步改用例即可；
		// 若前两个用例在无 doMock 注入时也绿，说明注入失效，防线已穿拢——查 vi.doMock 通路。
	});
});

// ── ③ 真实 SDK 冒烟：pi-ai validateToolArguments 对 SW schema 的校验路径（A4）──────
//
// SO 测试环境无 pi-ai alias → 直连根 node_modules 实装版（@earendil-works/pi-ai
// 0.84.1，dist/utils/validation.js：Value.Convert :249 + typebox/compile Compile :210
// + Check :265，失败 throw `Validation failed for tool "<name>"` :272-273；登记 PS-20）。
// 这是 SW schema 在
// 真实消费链（pi 对 tool-call args 的运行时校验器）下的最小真实面：mock typebox
// 失真再重，也影响不到这里的端到端判定。
import { validateToolArguments } from "@earendil-works/pi-ai";

describe("cross-package contract: pi-ai validateToolArguments 真实 SDK 冒烟（SW schema）", () => {
	/** pi-ai Tool 形态的最小 stub（只需 name/parameters 参与校验）。 */
	function swTool(mod: Record<string, unknown>): { name: string; description: string; parameters: unknown } {
		return { name: "subagent", description: "cross-package contract probe", parameters: mod.SubagentParams };
	}
	function toolCall(args: Record<string, unknown>): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
		return { type: "toolCall", id: "probe-1", name: "subagent", arguments: args };
	}

	it("合法 args 通过（action=list / start+绝对 skillPath）", async (ctx) => {
		const mod = await importSwSubagentSchema();
		if (!mod) {
			ctx.skip();
			return;
		}
		const tool = swTool(mod);
		expect(validateToolArguments(tool, toolCall({ action: "list" }))).toEqual({ action: "list" });
		expect(validateToolArguments(tool, toolCall({ action: "start", skillPath: "/abs/skills/x" }))).toEqual({
			action: "start",
			skillPath: "/abs/skills/x",
		});
	});

	it("非法 action 被拒，错误文案为 pi-ai 实装指纹形态", async (ctx) => {
		const mod = await importSwSubagentSchema();
		if (!mod) {
			ctx.skip();
			return;
		}
		let message = "";
		try {
			validateToolArguments(swTool(mod), toolCall({ action: "bogus" }));
			expect.unreachable("illegal action must be rejected");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		// 指纹：pi-ai validation.js 的错误头 + 指向违规字段
		expect(message).toMatch(/^Validation failed for tool "subagent"/);
		expect(message).toContain("action");
	});

	it("缺 required（无 action）被拒，错误指向 action", async (ctx) => {
		const mod = await importSwSubagentSchema();
		if (!mod) {
			ctx.skip();
			return;
		}
		let message = "";
		try {
			validateToolArguments(swTool(mod), toolCall({}));
			expect.unreachable("missing required action must be rejected");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/^Validation failed for tool "subagent"/);
		expect(message).toContain("action");
	});

	it("skillPath 相对穿越被拒（R6 pattern ^/ 在真实 typebox + pi-ai 校验器下生效）", async (ctx) => {
		const mod = await importSwSubagentSchema();
		if (!mod) {
			ctx.skip();
			return;
		}
		let message = "";
		try {
			validateToolArguments(swTool(mod), toolCall({ action: "start", skillPath: "../etc/passwd" }));
			expect.unreachable("traversal skillPath must be rejected");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/^Validation failed for tool "subagent"/);
		expect(message).toContain("skillPath");
	});
});

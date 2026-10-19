/**
 * 匹配语义真值表（任务书验收②：suffix 点边界 / noProxy 条目语义 / 归一化）。
 *
 * 本包 match.ts 是 packages/shared/src/network-proxy.ts 匹配函数的复制体（bundle 自包含
 * 不 import shared 运行时代码）——真值表即两侧行为一致性的镜像锁定，漂移时以 shared 为准。
 */
import { describe, expect, it } from "vitest";

import { matchesHostPattern, normalizeHostname } from "../match.ts";

describe("normalizeHostname（归一化）", () => {
	it("转小写", () => {
		expect(normalizeHostname("API.Anthropic.COM")).toBe("api.anthropic.com");
	});

	it("去末尾点（FQDN 根点与裸主机名同义）", () => {
		expect(normalizeHostname("api.anthropic.com.")).toBe("api.anthropic.com");
		expect(normalizeHostname("api.anthropic.com..")).toBe("api.anthropic.com");
	});

	it("组合形态：大写 + 末尾点", () => {
		expect(normalizeHostname("API.Anthropic.COM.")).toBe("api.anthropic.com");
	});

	it("无点主机名原样（小写化）", () => {
		expect(normalizeHostname("localhost")).toBe("localhost");
		expect(normalizeHostname("LocalHost")).toBe("localhost");
	});

	it("不 trim 首尾空白（带空白条目由校验层显式拒绝，匹配层保持严格）", () => {
		expect(normalizeHostname(" api.anthropic.com")).toBe(" api.anthropic.com");
		expect(normalizeHostname("api.anthropic.com ")).toBe("api.anthropic.com ");
	});
});

describe("matchesHostPattern 真值表（suffix 点边界）", () => {
	const pattern = "api.anthropic.com";

	it("等于命中", () => {
		expect(matchesHostPattern("api.anthropic.com", pattern)).toBe(true);
	});

	it("子域命中（以 .pattern 结尾）", () => {
		expect(matchesHostPattern("eu.api.anthropic.com", pattern)).toBe(true);
		expect(matchesHostPattern("a.b.api.anthropic.com", pattern)).toBe(true);
	});

	it("前缀拼接不命中（点边界必须对齐）", () => {
		expect(matchesHostPattern("xapi.anthropic.com", pattern)).toBe(false);
		expect(matchesHostPattern("papi.anthropic.com", pattern)).toBe(false);
	});

	it("恶意后缀不命中（pattern 出现在中间也不命中）", () => {
		expect(matchesHostPattern("api-anthropic.com.evil.com", pattern)).toBe(false);
		expect(matchesHostPattern("api.anthropic.com.evil.com", pattern)).toBe(false); // evil.com 的子域，非 pattern 子域
	});

	it("完全不同的主机名不命中", () => {
		expect(matchesHostPattern("openai.com", pattern)).toBe(false);
		expect(matchesHostPattern("anthropic.com", pattern)).toBe(false); // pattern 本身不是其子域
	});

	it("归一化参与匹配：大小写与末尾点在 host/pattern 任一侧生效", () => {
		expect(matchesHostPattern("API.Anthropic.COM.", "api.anthropic.com")).toBe(true);
		expect(matchesHostPattern("api.anthropic.com", "API.ANTHROPIC.COM.")).toBe(true);
		expect(matchesHostPattern("EU.API.Anthropic.Com", pattern)).toBe(true);
	});

	it("空主机名 / 空 pattern 不命中任何条目", () => {
		expect(matchesHostPattern("", pattern)).toBe(false);
		expect(matchesHostPattern("api.anthropic.com", "")).toBe(false);
		expect(matchesHostPattern("", "")).toBe(false);
	});

	it("首尾空白不参与匹配（host/pattern 任一侧带空白恒不命中——空白条目由校验层显式拒绝，匹配层不静默 trim 容忍）", () => {
		expect(matchesHostPattern("api.anthropic.com", " api.anthropic.com")).toBe(false);
		expect(matchesHostPattern("api.anthropic.com", "api.anthropic.com ")).toBe(false);
		expect(matchesHostPattern(" api.anthropic.com", pattern)).toBe(false);
	});

	it("noProxy 条目语义：localhost 同时覆盖 localhost 与 *.localhost", () => {
		expect(matchesHostPattern("localhost", "localhost")).toBe(true);
		expect(matchesHostPattern("foo.localhost", "localhost")).toBe(true);
		expect(matchesHostPattern("127.0.0.1", "127.0.0.1")).toBe(true);
	});
});

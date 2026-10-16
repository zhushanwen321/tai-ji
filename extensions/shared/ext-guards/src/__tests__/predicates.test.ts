// src/__tests__/predicates.test.ts
//
// isRecord / isEnoentError / isErrnoWithCode / isSubagentProcess / isTaijiHost /
// isTaijiGuiHost 单测
//（ext-simplify-17 D3/D2/D4 新导出 + isErrnoWithCode errno 守卫上收 +
// dmg-r1-7 宿主谓词跨包收敛）：
//   - isRecord 排数组严版：数组必须 false（钉值，防回退到允数组宽版）
//   - isEnoentError scheduler 严版：仅 Error 子类 + code === "ENOENT" 才 true，
//     非 Error 对象带 code 是宽版才接受的形态，严版必须 false
//   - isErrnoWithCode：isEnoentError 的 code 参数化形态，收窄纪律同源
//   - isSubagentProcess 三态 + env 注入隔离 + 旧键宁缺勿污钉值（D4 重锚定）
//   - isTaijiHost / isTaijiGuiHost：env 严格等值 + mode 收紧 rpc 真值表
//     （自 plan state.ts / canvas host.ts 双实现收敛，dmg-r1-7）

import { describe, expect, it } from "vitest";

import {
	isEnoentError,
	isErrnoWithCode,
	isRecord,
	isSubagentProcess,
	isTaijiGuiHost,
	isTaijiHost,
	TAIJI_GUI_HOST_ENV,
} from "../index.ts";

describe("isRecord", () => {
	it("对象 true", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ key: "value" })).toBe(true);
	});

	it("null false", () => {
		expect(isRecord(null)).toBe(false);
	});

	it("undefined false", () => {
		expect(isRecord(undefined)).toBe(false);
	});

	it("数组 false（排数组钉值——Record 语义不含数组）", () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord([{ a: 1 }])).toBe(false);
	});

	it("字符串 false", () => {
		expect(isRecord("text")).toBe(false);
	});
});

describe("isEnoentError", () => {
	it("Error 带 code=ENOENT true（Node fs 错误的构造形态）", () => {
		expect(isEnoentError(Object.assign(new Error("no such file"), { code: "ENOENT" }))).toBe(
			true,
		);
	});

	it("普通 Error false（无 code 属性）", () => {
		expect(isEnoentError(new Error("x"))).toBe(false);
	});

	it("code 为其他值 false", () => {
		expect(isEnoentError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
	});

	it("非 Error 对象带 code=ENOENT false（严版：宽版才接受的形态）", () => {
		expect(isEnoentError({ code: "ENOENT" })).toBe(false);
	});

	it("undefined false", () => {
		expect(isEnoentError(undefined)).toBe(false);
	});
});

describe("isErrnoWithCode", () => {
	it("Error 带 code=期望值 true（Node fs 错误的构造形态）", () => {
		expect(isErrnoWithCode(Object.assign(new Error("exists"), { code: "EEXIST" }), "EEXIST")).toBe(
			true,
		);
	});

	it("code 为其他值 false", () => {
		expect(isErrnoWithCode(Object.assign(new Error("exists"), { code: "EEXIST" }), "EACCES")).toBe(
			false,
		);
	});

	it("普通 Error false（无 code 属性）", () => {
		expect(isErrnoWithCode(new Error("x"), "EEXIST")).toBe(false);
	});

	it("非 Error 对象带同名 code false（与 isEnoentError 同一严版口径）", () => {
		expect(isErrnoWithCode({ code: "EEXIST" }, "EEXIST")).toBe(false);
	});

	it("undefined false", () => {
		expect(isErrnoWithCode(undefined, "EEXIST")).toBe(false);
	});
});

describe("isSubagentProcess", () => {
	it("TAIJI_AGENT_SUBAGENT=1 命中（引擎 spawn 链恒注入的现行标记）", () => {
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "1" })).toBe(true);
	});

	it("值非 \"1\" 不命中（标记必须是引擎注入的字面 \"1\"）", () => {
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "0" })).toBe(false);
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "" })).toBe(false);
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "true" })).toBe(false);
	});

	it("缺失不命中（顶层会话 → 消费方不降级）", () => {
		expect(isSubagentProcess({})).toBe(false);
	});

	it("env 参数注入隔离：传入的 env 与宿主 process.env 无关（宿主即使带标记，空 env 也不命中）", () => {
		const saved = process.env.TAIJI_AGENT_SUBAGENT;
		try {
			process.env.TAIJI_AGENT_SUBAGENT = "1";
			// 显式传 env：宿主的标记不渗透，判据只看参数
			expect(isSubagentProcess({})).toBe(false);
			expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "1" })).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.TAIJI_AGENT_SUBAGENT;
			else process.env.TAIJI_AGENT_SUBAGENT = saved;
		}
	});

	it("缺省参数读 process.env（不传 env 时以宿主环境为判据）", () => {
		const saved = process.env.TAIJI_AGENT_SUBAGENT;
		try {
			process.env.TAIJI_AGENT_SUBAGENT = "1";
			expect(isSubagentProcess()).toBe(true);
			delete process.env.TAIJI_AGENT_SUBAGENT;
			expect(isSubagentProcess()).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.TAIJI_AGENT_SUBAGENT;
			else process.env.TAIJI_AGENT_SUBAGENT = saved;
		}
	});

	it("旧 PI_SUBAGENT_* 身份键不再命中（[HISTORICAL] D4 重锚前两键任一存在即命中；引擎协议化后无写入方，宁缺勿污）", () => {
		expect(isSubagentProcess({ PI_SUBAGENT_ROOT_SESSION_ID: "s1" })).toBe(false);
		expect(isSubagentProcess({ PI_SUBAGENT_SELF_RECORD_ID: "r1" })).toBe(false);
		expect(isSubagentProcess({ PI_SUBAGENT_ROOT_SESSION_ID: "s1", PI_SUBAGENT_SELF_RECORD_ID: "r1" })).toBe(
			false,
		);
	});
});

describe("isTaijiHost / isTaijiGuiHost", () => {
	// 谓词读活 env（每次调用时取 process.env，不缓存），用 saved/finally 操纵恢复；
	// 键经 TAIJI_GUI_HOST_ENV 常量取值（常量改值时测试自动跟随，防键名漂移）
	function withEnv(value: string | undefined, fn: () => void): void {
		const key = TAIJI_GUI_HOST_ENV;
		const saved = process.env[key];
		try {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
			fn();
		} finally {
			if (saved === undefined) delete process.env[key];
			else process.env[key] = saved;
		}
	}

	it("env 信号缺失 = 非宿主（mode 无关）", () => {
		withEnv(undefined, () => {
			expect(isTaijiHost()).toBe(false);
			expect(isTaijiGuiHost({ mode: "rpc" })).toBe(false);
		});
	});

	it("env=1 但 mode 非 rpc（TUI / json / print）= 非 GUI 宿主（env 泄漏形态，禁入 select）", () => {
		withEnv("1", () => {
			expect(isTaijiHost()).toBe(true);
			expect(isTaijiGuiHost({ mode: "tui" })).toBe(false);
			expect(isTaijiGuiHost({ mode: "json" })).toBe(false);
			expect(isTaijiGuiHost({ mode: "print" })).toBe(false);
		});
	});

	it("env=1 + rpc = taiji GUI 宿主", () => {
		withEnv("1", () => {
			expect(isTaijiGuiHost({ mode: "rpc" })).toBe(true);
		});
	});

	it("env 非 \"1\" 值 = 非宿主（严格等值判定）", () => {
		withEnv("0", () => {
			expect(isTaijiHost()).toBe(false);
		});
	});
});

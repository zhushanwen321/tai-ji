// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/retry-state.test.ts
//
// RetryState 转移表单测（M4-TC-2 / IF-7）——直接构造 export 的类并驱动方法，
// 断言四字段精确值 + onToolExecEnd 返回值。M5 状态机测试的基座。
//
// 与 workflow-hook 的守卫关系：onTurnEnd() 只在「判定要 steer」时被调用
// （toolUse/超上限/成功短路均不调），本测试在 RetryState 层模拟该契约。

import { describe, expect, it } from "vitest";

import { RetryState } from "../src/workflow-hook.js";

describe("RetryState transition table (IF-7 + U2 terminal)", () => {
	it("① 成功短路：onToolExecEnd(false) → soSucceededEver=true，onTurnEnd 不翻转", () => {
		const s = new RetryState();
		const r = s.onToolExecEnd(false);
		expect(r).toEqual({ shouldSteer: false });
		expect(s.soCallCount).toBe(1);
		expect(s.soSucceededEver).toBe(true);
		expect(s.hookRetryCount).toBe(0);
		expect(s.lastSchemaError).toBeNull();

		// onTurnEnd 只重置计数/累计重试，不翻转成功终态（成功短路是终态）
		s.onTurnEnd();
		expect(s.soSucceededEver).toBe(true);
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
	});

	it("② 未调用 steer：上一 turn 失败 steer 后 soCallCount=0 → calledButFailed=false（MUST call 文案分支依据）", () => {
		const s = new RetryState();
		// 上一 turn 失败并 steer（onToolExecEnd + onTurnEnd）后，本 turn 未调用任何工具。
		// onTurnEnd 无条件清零 soCallCount——RetryState 层无法观察新 turn 是否调用了工具，
		// 此序列即 steer 后状态，是 hook 下一 turn_end 判定 calledButFailed=false 走
		// MUST call 分支（而非 FAILED validation 分支）的前置。
		s.onToolExecEnd(true, "err");
		s.onTurnEnd();
		// workflow-hook 的 calledButFailed = soCallCount > 0；0 次调用 → MUST call 分支
		expect(s.soCallCount).toBe(0);
		const calledButFailed = s.soCallCount > 0;
		expect(calledButFailed).toBe(false);
		expect(s.hookRetryCount).toBe(1);
		expect(s.soSucceededEver).toBe(false);
		expect(s.lastSchemaError).toBeNull();
	});

	it("③ 失败 steer：onToolExecEnd(true, err) → onTurnEnd() → 计数归零/重试++/错误清空", () => {
		const s = new RetryState();
		const r = s.onToolExecEnd(true, "Schema validation failed: /count must be number");
		expect(r).toEqual({ shouldSteer: true });
		expect(s.lastSchemaError).toBe("Schema validation failed: /count must be number");
		expect(s.soSucceededEver).toBe(false);

		s.onTurnEnd();
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
		expect(s.lastSchemaError).toBeNull();
		expect(s.soSucceededEver).toBe(false);
	});

	it("④ 超上限放弃：hookRetryCount≥MAX 时不调 onTurnEnd → lastSchemaError 保留", () => {
		const s = new RetryState();
		// 两次「失败 → steer」循环后 hookRetryCount 达到 MAX_HOOK_RETRIES=2
		//（常量定义见 src/workflow-hook.ts L21）。RetryState 自身不感知上限，
		// 守卫责任在 hook 层（workflow-hook.ts L132 `hookRetryCount >= MAX_HOOK_RETRIES`
		// 直接 return，不调 onTurnEnd）。集成层真实验证见 characterization-hook.test.ts
		// ③「3 轮失败恰 2 次 steer」，本单测只验证 RetryState 自身状态转移契约。
		s.onToolExecEnd(true, "err1");
		s.onTurnEnd();
		s.onToolExecEnd(true, "err2");
		s.onTurnEnd();
		expect(s.hookRetryCount).toBe(2);

		// 第 3 轮失败：hook 守卫 return（不调 onTurnEnd）→ turn 自然结束不 steer，
		// 最近错误与计数保留（超上限放弃路径的状态快照）。
		s.onToolExecEnd(true, "last error text");
		expect(s.lastSchemaError).toBe("last error text");
		expect(s.soCallCount).toBe(1);
		expect(s.hookRetryCount).toBe(2);
	});

	it("⑤ toolUse 不干预：守卫不调 onTurnEnd → soCallCount 保留", () => {
		const s = new RetryState();
		s.onToolExecEnd(true, "err");
		// workflow-hook 守卫：stopReason=toolUse 直接 return（不调 onTurnEnd），
		// 故 soCallCount 累计到下一 turn（characterization ① 的行为基础）
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("err");
		expect(s.hookRetryCount).toBe(0);
	});

	it("⑥ 多 turn 重置：steer 后下一 turn 计数归零，失败再次累计", () => {
		const s = new RetryState();
		s.onToolExecEnd(true, "err1");
		s.onTurnEnd(); // turn 1 steer 后
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);

		s.onToolExecEnd(true, "err2"); // turn 2 再次失败
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("err2");
		expect(s.hookRetryCount).toBe(1);
	});

	it("reset() 五字段归零（IF-7 完整契约 + U2 terminal）", () => {
		const s = new RetryState();
		s.onToolExecEnd(true, "err");
		s.onTurnEnd();
		s.onToolExecEnd(false);
		s.markTerminal();
		expect(s.soSucceededEver).toBe(true);
		expect(s.terminal).toBe(true);

		s.reset();
		expect(s.soCallCount).toBe(0);
		expect(s.soSucceededEver).toBe(false);
		expect(s.hookRetryCount).toBe(0);
		expect(s.lastSchemaError).toBeNull();
		expect(s.terminal).toBe(false);
	});

	// ── U2（D3）terminal 态行为契约 ────────────────────────────────

	it("⑦ terminal 初始 false；markTerminal() 置位且不可逆（重复调用无副作用）", () => {
		const s = new RetryState();
		expect(s.terminal).toBe(false);
		s.markTerminal();
		expect(s.terminal).toBe(true);
		// 不可逆：再 mark 不变化（无计数/状态副作用）
		s.markTerminal();
		expect(s.terminal).toBe(true);
	});

	it("⑧ terminal 不阻断 onToolExecEnd 记录（闸门幂等，重复事件无害；hook 侧只在 turn_end 读 terminal）", () => {
		const s = new RetryState();
		s.markTerminal();
		const r = s.onToolExecEnd(true, "late error");
		expect(r).toEqual({ shouldSteer: true });
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("late error");
		expect(s.terminal).toBe(true);
	});

	it("⑨ terminal 后 onTurnEnd 仍可调用（状态机完整；hook 守卫在调用方拦，不在这里）", () => {
		const s = new RetryState();
		s.onToolExecEnd(true, "err");
		s.markTerminal();
		s.onTurnEnd();
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
		// terminal 是独立于 steer 计数的终态标记
		expect(s.terminal).toBe(true);
	});
});

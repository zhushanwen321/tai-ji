// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/retry-state.test.ts
//
// WorkflowGate steer 侧转移表单测（M4-TC-2 / IF-7；D2 合一后本文件锁定合一状态机的
// steer 侧契约，硬杀侧转移表见 loop-gate.test.ts）——直接构造 export 的类并驱动方法，
// 断言字段精确值 + onToolExecEnd 返回值（硬杀侧形状 { terminal, newlyTerminal }；
// steer 决策不经返回值表达——turn_end 时刻由装配层守卫链按状态字段推导）。
//
// 与 workflow-hook 的守卫关系：onTurnEnd() 只在「判定要 steer 且发送成功」时被调用
//（toolUse/超上限/成功短路/发送失败均不调），本测试在状态机层模拟该契约。
//
// D2 等价锚：本文件全部断言语义与合一前 RetryState 转移表逐条对应——①~⑥ 是原
// RetryState 转移表，⑦~⑨ 是 terminal 交互契约（原 markTerminal 外部置位入口随
// onTerminal 回调线退役，terminal 改由硬杀计数段内置位，用例驱动方式同步改为
// 3 次同签名失败；断言语义不变：初始 false / 置位不可逆 / 不阻断记账 / 与 steer
// 重置独立）。

import { describe, expect, it } from "vitest";

import { WorkflowGate } from "../src/loop-gate.js";

describe("WorkflowGate steer-side transition table (IF-7 + D2 unified terminal)", () => {
	it("① 成功短路：onToolExecEnd(false) → soSucceededEver=true，onTurnEnd 不翻转", () => {
		const s = new WorkflowGate();
		const r = s.onToolExecEnd(false);
		expect(r).toEqual({ terminal: false, newlyTerminal: false });
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
		const s = new WorkflowGate();
		// 上一 turn 失败并 steer（onToolExecEnd + onTurnEnd）后，本 turn 未调用任何工具。
		// onTurnEnd 无条件清零 soCallCount——状态机层无法观察新 turn 是否调用了工具，
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
		const s = new WorkflowGate();
		const r = s.onToolExecEnd(true, "Schema validation failed: /count must be number");
		expect(r).toEqual({ terminal: false, newlyTerminal: false });
		expect(s.lastSchemaError).toBe("Schema validation failed: /count must be number");
		expect(s.soSucceededEver).toBe(false);

		s.onTurnEnd();
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
		expect(s.lastSchemaError).toBeNull();
		expect(s.soSucceededEver).toBe(false);
	});

	it("④ 超上限放弃：hookRetryCount≥MAX 时不调 onTurnEnd → lastSchemaError 保留", () => {
		const s = new WorkflowGate();
		// 两次「失败 → steer」循环后 hookRetryCount 达到 MAX_HOOK_RETRIES=2
		//（常量定义见 src/workflow-hook.ts）。状态机自身不感知上限，
		// 守卫责任在 hook 层（shouldSkipSteer 的 hookRetryCount >= MAX_HOOK_RETRIES
		// 直接 return，不调 onTurnEnd）。集成层真实验证见 characterization-hook.test.ts
		// ③「3 轮失败恰 2 次 steer」，本单测只验证状态机自身状态转移契约。
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
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err");
		// workflow-hook 守卫：stopReason=toolUse 直接 return（不调 onTurnEnd），
		// 故 soCallCount 累计到下一 turn（characterization ① 的行为基础）
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("err");
		expect(s.hookRetryCount).toBe(0);
	});

	it("⑥ 多 turn 重置：steer 后下一 turn 计数归零，失败再次累计；硬杀侧计数跨 turn 连续", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err1");
		s.onTurnEnd(); // turn 1 steer 后
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);

		s.onToolExecEnd(true, "err2"); // turn 2 再次失败
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("err2");
		expect(s.hookRetryCount).toBe(1);
		// D2 等价锚：onTurnEnd 只清 steer 侧，不触碰硬杀侧字段本身；err2 与 err1 签名
		// 互异故硬杀计数重起为 1（签名语义），同签名跨 turn 连续性由 loop-gate.test.ts
		// 等价断言组「跨 turn 同签名计数连续」全序列锁定
		expect(s.consecutiveFailures).toBe(1);
	});

	it("reset() 全字段归零（IF-7 完整契约 + D2 合一后的硬杀侧字段）", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err");
		s.onTurnEnd();
		s.onToolExecEnd(false);
		// 经硬杀计数段驱动到 terminal（3 次同签名失败；原 markTerminal 外部置位入口
		// 随 onTerminal 回调线退役）
		s.onToolExecEnd(true, "err");
		s.onToolExecEnd(true, "err");
		s.onToolExecEnd(true, "err");
		s.onTurnEnd();
		expect(s.soSucceededEver).toBe(true);
		expect(s.terminal).toBe(true);
		expect(s.consecutiveFailures).toBe(3);
		expect(s.lastErrorText).not.toBeNull();

		s.reset();
		expect(s.soCallCount).toBe(0);
		expect(s.soSucceededEver).toBe(false);
		expect(s.hookRetryCount).toBe(0);
		expect(s.lastSchemaError).toBeNull();
		expect(s.consecutiveFailures).toBe(0);
		expect(s.lastErrorText).toBeNull();
		expect(s.signature).toBeNull();
		expect(s.terminal).toBe(false);
	});

	// ── terminal 交互契约（D2：terminal 由硬杀计数段内置位，单字段单写）──────

	it("⑦ terminal 初始 false；达硬杀阈值置位且不可逆（后续事件不翻转）", () => {
		const s = new WorkflowGate();
		expect(s.terminal).toBe(false);
		s.onToolExecEnd(true, "same error");
		s.onToolExecEnd(true, "same error");
		expect(s.terminal).toBe(false); // 未达 MAX_CONSECUTIVE_FAILURES
		s.onToolExecEnd(true, "same error");
		expect(s.terminal).toBe(true);
		// 不可逆：后续失败/成功均不变化（硬杀段幂等短路；成功只动 steer 侧记账）
		s.onToolExecEnd(true, "same error");
		s.onToolExecEnd(false);
		expect(s.terminal).toBe(true);
	});

	it("⑧ terminal 不阻断 steer 记账段（闸门幂等，重复事件无害；hook 侧只在 turn_end 读 terminal）", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err");
		s.onToolExecEnd(true, "err");
		s.onToolExecEnd(true, "err"); // 达阈值 → terminal
		expect(s.terminal).toBe(true);
		const r = s.onToolExecEnd(true, "late error");
		// 硬杀段短路（不重复触发），steer 记账段照常记录
		expect(r).toEqual({ terminal: true, newlyTerminal: false });
		expect(s.soCallCount).toBe(4);
		expect(s.lastSchemaError).toBe("late error");
		expect(s.terminal).toBe(true);
	});

	it("⑨ terminal 后 onTurnEnd 仍可调用（状态机完整；hook 守卫在调用方拦，不在这里）", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err");
		s.onToolExecEnd(true, "err");
		s.onToolExecEnd(true, "err"); // 达阈值 → terminal
		s.onTurnEnd();
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
		// terminal 是独立于 steer 计数的终态标记
		expect(s.terminal).toBe(true);
	});
});

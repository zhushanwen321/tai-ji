// subagent-list-injector 单测：SUBAGENT_DISPATCH_SHARED_RULES 调度纪律文案契约
//
// 无条件停下为默认（四条正向默认）的关键句断言：
// ① 默认停下（完成通知唤醒下一轮）② 等待期不做无关调用，唯一例外 = 用户明确要求
// ③ 通知未到只做一次恢复查询，然后继续停 ④ 预算与模型继承指引。
// 该常量是跨工具调度纪律的唯一权威源（工具声明零残留由 tool-prompt-contract
// 锁定），本文件锁定关键语义在文案中的存在与旧口子（模型自辩「有用工作」）的删除。

import { describe, expect, it } from "vitest";

import { SUBAGENT_DISPATCH_SHARED_RULES } from "../subagent-list-injector";

describe("SUBAGENT_DISPATCH_SHARED_RULES 无条件停下四条正向默认", () => {
	const RULES = SUBAGENT_DISPATCH_SHARED_RULES;

	it("默认停下：派发后停，结果以完成通知唤醒下一轮", () => {
		expect(RULES).toContain("after dispatching, STOP");
		expect(RULES).toContain("completion notification that wakes your next turn");
	});

	it("等待期不做无关调用，唯一例外 = 用户明确要求（自辩「有用/相关调研」口子已删）", () => {
		expect(RULES).toContain("no tool calls unrelated to it");
		expect(RULES).toContain("the user explicitly requested");
		// 旧口子字面不再存在：模型自行判定「有用」不再构成例外
		expect(RULES).not.toContain("do useful non-overlapping work");
		expect(RULES).toContain("does NOT qualify");
	});

	it("通知未到只做一次恢复查询（run: workflow_control status + runId；单发: subagent_manage list），然后继续停", () => {
		expect(RULES).toContain("exactly ONE recovery query");
		expect(RULES).toContain("workflow_control status with its runId");
		expect(RULES).toContain("subagent_manage list");
		expect(RULES).toContain("then stop again");
	});

	it("预算与模型继承：tokens/time 仅用户明确要求；model/thinkingLevel 默认继承，仅用户指定或隔离失败成员时设置", () => {
		expect(RULES).toContain("omit unless the user explicitly requests a limit");
		expect(RULES).toContain("inherit the main agent's model");
		expect(RULES).toContain("isolate a failed member onto a different model");
	});

	it("覆盖六个现行注册工具名（批量工具名 subagent_batch，2026-10-23 改名）", () => {
		expect(RULES).toContain("subagent_start");
		expect(RULES).toContain("subagent_manage");
		expect(RULES).toContain("subagent_message");
		expect(RULES).toContain("subagent_batch");
		expect(RULES).toContain("workflow_run");
		expect(RULES).toContain("workflow_control");
	});
});

import { describe, expect, it } from "vitest";

import {
	buildDegradationHintLine,
	buildDownshiftNotice,
	buildSwitchNotice,
	buildThresholdReminder,
} from "../reminder.js";
import { buildSameModelInstruction, buildTranscriptPointer, CHECKPOINT_PREAMBLE } from "../prompts.js";

describe("buildThresholdReminder（D3/D4：数据投递不强制）", () => {
	it("含用量数据、档位、三条件自查清单、可忽略出口", () => {
		const msg = buildThresholdReminder([200_000], 215_000, 1_000_000, 0);
		expect(msg).toContain("215K / 1000K");
		expect(msg).toContain("21.5%");
		expect(msg).toContain("200K");
		expect(msg).toContain("compact_context");
		expect(msg).toContain("1. 当前任务的一个阶段已完成");
		expect(msg).toContain("忽略本提示继续工作");
	});

	it("多档合并为一条消息", () => {
		const msg = buildThresholdReminder([200_000, 400_000], 430_000, 1_000_000, 0);
		expect(msg).toContain("200K（第 1 档）、400K（第 2 档）");
	});

	it("累计压缩 ≥2 次附降智提示（D13-12）", () => {
		const without = buildThresholdReminder([200_000], 215_000, 1_000_000, 1);
		const with_ = buildThresholdReminder([200_000], 215_000, 1_000_000, 2);
		expect(without).not.toContain("compacted multiple times");
		expect(with_).toContain("compacted multiple times");
	});
});

describe("buildSwitchNotice（D5 跨界通知）", () => {
	it("不可用/恢复两态文案含模型 ID 与原因", () => {
		const unavailableNotice = buildSwitchNotice("unavailable", "deepseek/deepseek-chat");
		expect(unavailableNotice).toContain("deepseek/deepseek-chat");
		expect(unavailableNotice).toContain("暂时不可用");
		expect(buildSwitchNotice("available", "zai/glm")).toContain("恢复可用");
	});
});

describe("buildDownshiftNotice（D5 窗口收缩）", () => {
	it("窗口变大或未触线返回 null", () => {
		expect(buildDownshiftNotice(100_000, 200_000, 1_000_000)).toBeNull();
		expect(buildDownshiftNotice(100_000, 1_000_000, 500_000)).toBeNull();
		expect(buildDownshiftNotice(null, 1_000_000, 200_000)).toBeNull();
	});

	it("切小窗且 tokens 超内建触发线 → 建议压缩", () => {
		const notice = buildDownshiftNotice(190_000, 1_000_000, 200_000);
		expect(notice).toContain("190K");
		expect(notice).toContain("200K");
		expect(notice).toContain("建议尽快压缩");
	});
});

describe("prompts（D13-6/7/8/9 + D12）", () => {
	it("same-model 指令：首尾 TEXT ONLY 双保险 + 结构化模板 + 先验合并规则", () => {
		const instruction = buildSameModelInstruction();
		expect(instruction.startsWith("CRITICAL: Respond with TEXT ONLY")).toBe(true);
		expect(instruction.endsWith("REMINDER: Respond with TEXT ONLY. Do NOT call any tools. Output only the checkpoint text.")).toBe(true);
		expect(instruction).toContain("## Goal");
		expect(instruction).toContain("## Files and Code");
		expect(instruction).toContain("## Errors and Fixes");
		expect(instruction).toContain("do NOT copy it forward verbatim");
	});

	it("custom_instructions 追加 focus 段", () => {
		const instruction = buildSameModelInstruction("保留验证结果");
		expect(instruction).toContain('Additional focus from the calling agent');
		expect(instruction).toContain("保留验证结果");
	});

	it("transcript 指针含路径", () => {
		expect(buildTranscriptPointer("/tmp/s.jsonl")).toContain("/tmp/s.jsonl");
	});

	it("落回包裹语存在（D13-9）", () => {
		expect(CHECKPOINT_PREAMBLE).toContain("without acknowledging this checkpoint");
	});
});

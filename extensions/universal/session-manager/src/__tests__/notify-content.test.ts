// notify-content.test.ts — buildManagedNotifyContent 纯函数（U6_UNIT 随迁 + D9 新形态）。
// 原 runtime completion-backflow.test.ts 的 U6_UNIT 组随 buildBackflowContent 迁入本包。

import { describe, it, expect } from "vitest";

import {
	MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
	buildManagedNotifyContent,
} from "../notify-content.ts";

describe("MANAGED_SESSION_NOTIFY_CUSTOM_TYPE SSOT", () => {
	it("常量值锁定为 managed-session-notify（与 shared COMPLETE_NOTIFY_CUSTOM_TYPES / core extractNotifyRecords 三处同值，防字面量漂移）", () => {
		expect(MANAGED_SESSION_NOTIFY_CUSTOM_TYPE).toBe("managed-session-notify");
	});
});

describe("buildManagedNotifyContent（D9 文案形状）", () => {
	it("settle 基本形态：label/status + 指针行缺席时省略", () => {
		expect(
			buildManagedNotifyContent({ label: "auth-refactor", sessionId: "a1b2", status: "completed" }),
		).toBe('Managed session "auth-refactor" (a1b2) finished with status "completed".');
	});

	it("fulfills N 行内追加：单数 request / 复数 requests（裁决4 合并笔数）", () => {
		expect(
			buildManagedNotifyContent({
				label: "L",
				sessionId: "s1",
				status: "completed",
				fulfills: 1,
			}),
		).toContain(". (fulfills 1 request)");
		expect(
			buildManagedNotifyContent({
				label: "L",
				sessionId: "s1",
				status: "completed",
				fulfills: 2,
			}),
		).toContain(". (fulfills 2 requests)");
	});

	it("fulfills 0 / 缺席 → 不出行（纯死亡通知无债权）", () => {
		const zero = buildManagedNotifyContent({
			label: "L",
			sessionId: "s1",
			status: "exited",
			fulfills: 0,
		});
		const absent = buildManagedNotifyContent({ label: "L", sessionId: "s1", status: "exited" });
		expect(zero).not.toContain("fulfills");
		expect(absent).not.toContain("fulfills");
	});

	it("exit code 注入 status 段内（death 文案，exit 腿诊断通路复刻）", () => {
		const content = buildManagedNotifyContent({
			label: "L",
			sessionId: "s1",
			status: "exited",
			exitCode: 1,
			fulfills: 1,
		});
		expect(content).toBe(
			'Managed session "L" (s1) finished with status "exited" (exit code: 1). (fulfills 1 request)',
		);
	});

	it("exitCode null → 字面 'null'（迁移自 completion-backflow 语义）", () => {
		expect(
			buildManagedNotifyContent({ label: "L", sessionId: "s1", status: "exited", exitCode: null }),
		).toContain('(exit code: null)');
	});

	it("stderrTail 非空 → Stderr 行；>400 字取尾部截断；全空白不输出", () => {
		const long = `${"x".repeat(500)}TAIL`;
		const tail = `  ${long}  `;
		const content = buildManagedNotifyContent({
			label: "L",
			sessionId: "s1",
			status: "exited",
			stderrTail: tail,
		});
		// 截尾语义与迁移源一致：对原始 tail 切尾 400 字后 trim
		expect(content).toContain(`\nStderr: ${tail.slice(-400).trim()}`);
		expect(content).not.toContain("x".repeat(450));

		const blank = buildManagedNotifyContent({
			label: "L",
			sessionId: "s1",
			status: "exited",
			stderrTail: "   \n  ",
		});
		expect(blank).not.toContain("Stderr");
	});

	it("sessionFilePath 提供时补 Full transcript 行（watch respond payload 已携该字段；未携 → 整行省略语义不变）", () => {
		const content = buildManagedNotifyContent({
			label: "L",
			sessionId: "s1",
			status: "completed",
			sessionFilePath: "/data/agent/sessions/s1.jsonl",
		});
		expect(content).toContain("\nFull transcript: /data/agent/sessions/s1.jsonl");
		expect(
			buildManagedNotifyContent({ label: "L", sessionId: "s1", status: "completed" }),
		).not.toContain("Full transcript");
	});
});

// src/__tests__/pi-host-notify-ports.test.ts
//
// [W4 读侧过滤② / F1 per-call 形态] pi 宿主通知域窄端口的跨 session 过滤适配单测：
// countActiveFromEntries 第二参（core 端口契约 CountActivePortOptions）透传
// pending-notifications 的 currentSessionId——传入时按「register entry 的 sessionId ≠
// 基准 → 跳过」过滤（fork 继承的父级注册残留不进后代判定差集，层主不被残留误判
// 「尚有活跃后代」而保持进程空等唤醒）；缺省不过滤（向后兼容：无基准调用方零改动
// 行为不变）。
//
// 基准来源 [F1]：core 读侧按「被读 entries 所属 session」提供（session-pending 读
// pi session 文件首行 SessionHeader.id）——本装配在扩展启动时一次定型，session id
// 逐 session 变化，factory 定型表达不了 per-call 基准（原 factory 参数已随 F1 删除）。
//
// createPiNotifyDomainPorts 构造不触 pi 运行时（getAgentDir/createDelivery 仅在
// HostServices 其他成员调用时消费），本测试直接构造端口对象验证差集口径。

import { describe, expect, it } from "vitest";

import { createPiNotifyDomainPorts } from "../host/pi-host.ts";

function registerEntry(id: string, type: string, sessionId: string): unknown {
	return {
		type: "custom",
		customType: "pending:register",
		data: { id, type, name: id, registeredAt: 1, sessionId },
	};
}

describe("createPiNotifyDomainPorts 读侧过滤②（per-call 基准）", () => {
	const entries = [
		registerEntry("bg-parent", "subagent", "sess-parent"),
		registerEntry("wf-parent", "workflow", "sess-parent"),
		registerEntry("bg-own", "subagent", "sess-child"),
	];

	it("调用时传 currentSessionId → 跨 session 残留不进后代判定差集", () => {
		const ports = createPiNotifyDomainPorts();
		expect(ports.countActiveFromEntries(entries, { currentSessionId: "sess-child" })).toBe(1);
	});

	it("调用时不传基准 → 不过滤（向后兼容：无基准调用方零改动）", () => {
		const ports = createPiNotifyDomainPorts();
		expect(ports.countActiveFromEntries(entries)).toBe(3);
	});
});

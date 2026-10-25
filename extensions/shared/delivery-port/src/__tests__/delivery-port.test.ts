// delivery-port 四步对位与提交侧机制的行为锁（impl-plan A3：port 四步对位测试）。
// 覆盖（任务书验收清单逐条）：四步对位（受理前落盘 → 注入 → message_end 命中 →
// ack）/ 幂等（同 id 重提交 swallowed）/ session_start 差集重放 / 外部通道逐条批组
// 隔离 / compaction 等待降级与事件唤醒 / deliveryId 写入与批展平逐条对位。
// fake host 全内存（无 fs——测试红线：禁触真实数据目录由构造性满足）；
// fake timers 驱动「无窗口定时器」负断言与 collect 等待时序（攒批窗已删 §3.3.7③）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ACK_CUSTOM_TYPE,
	DEFAULT_NOTIFY_CUSTOM_TYPE,
	OUTBOX_CUSTOM_TYPE,
	V1_OUTBOX_CUSTOM_TYPE,
} from "../journal.ts";
import {
	_resetDeliveryPortForTest,
	bindDeliveryPort,
	createDeliveryPort,
	getDeliveryPort,
} from "../delivery-port.ts";
import type { DeliveryPortHost } from "../types.ts";

const T0 = 1_700_000_000_000;

// ─── fake host ──────────────────────────────────────────────

type SentMessage = {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
};

function makeHost(init: { entries?: unknown[]; idle?: boolean } = {}) {
	const entries: unknown[] = init.entries ?? [];
	const sent: Array<{ message: SentMessage; options: { deliverAs: string; triggerTurn: boolean } }> = [];
	const callLog: string[] = [];
	const idle = { value: init.idle ?? true };
	const sendThrows = { value: false };
	const warn = vi.fn();
	const debug = vi.fn();
	const handlers = {
		message_end: [] as Array<(message: unknown) => void>,
		agent_settled: [] as Array<() => void>,
		session_before_compact: [] as Array<() => void>,
		session_compact: [] as Array<() => void>,
		session_compact_failed: [] as Array<() => void>,
	};
	const host: DeliveryPortHost = {
		appendEntry: (customType, data) => {
			callLog.push(`appendEntry:${customType}`);
			entries.push({ type: "custom", customType, data });
		},
		readSessionEntries: () => entries,
		isIdle: () => idle.value,
		sendMessage: (message, options) => {
			callLog.push(`sendMessage:${message.customType}`);
			if (sendThrows.value) throw new Error("sendMessage failed (fake)");
			sent.push({ message, options });
		},
		onMessageEnd: (handler) => {
			handlers.message_end.push(handler);
			return () => {
				handlers.message_end = handlers.message_end.filter((h) => h !== handler);
			};
		},
		onAgentSettled: (handler) => {
			handlers.agent_settled.push(handler);
			return () => {
				handlers.agent_settled = handlers.agent_settled.filter((h) => h !== handler);
			};
		},
		onSessionBeforeCompact: (handler) => {
			handlers.session_before_compact.push(handler);
			return () => {
				handlers.session_before_compact = handlers.session_before_compact.filter((h) => h !== handler);
			};
		},
		onSessionCompact: (handler) => {
			handlers.session_compact.push(handler);
			return () => {
				handlers.session_compact = handlers.session_compact.filter((h) => h !== handler);
			};
		},
		onSessionCompactFailed: (handler) => {
			handlers.session_compact_failed.push(handler);
			return () => {
				handlers.session_compact_failed = handlers.session_compact_failed.filter((h) => h !== handler);
			};
		},
		logger: { warn, debug },
	};
	const fireAll = (list: Array<() => void>): void => {
		for (const h of [...list]) h();
	};
	const fireMessageEnd = (message: unknown): void => {
		for (const h of [...handlers.message_end]) h(message);
	};
	/** pi 注入落 entry + 同栈 emit message_end（agent-session _appendCustomMessage 形态）。 */
	const injectAndEmit = (message: SentMessage): void => {
		entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		fireMessageEnd({ role: "custom", ...message, timestamp: Date.now() });
	};
	const outboxEntries = (): Array<Record<string, unknown>> =>
		entries.filter(
			(e): e is Record<string, unknown> =>
				typeof e === "object" && e !== null && (e as Record<string, unknown>)["customType"] === OUTBOX_CUSTOM_TYPE,
		);
	const ackEntries = (): Array<Record<string, unknown>> =>
		entries.filter(
			(e): e is Record<string, unknown> =>
				typeof e === "object" && e !== null && (e as Record<string, unknown>)["customType"] === ACK_CUSTOM_TYPE,
		);
	return {
		host,
		entries,
		sent,
		callLog,
		idle,
		sendThrows,
		warn,
		debug,
		fireMessageEnd,
		fireBeforeCompact: () => fireAll(handlers.session_before_compact),
		fireCompact: () => fireAll(handlers.session_compact),
		fireCompactFailed: () => fireAll(handlers.session_compact_failed),
		fireSettled: () => fireAll(handlers.agent_settled),
		injectAndEmit,
		outboxEntries,
		ackEntries,
	};
}

type DeliveryPortHandle = ReturnType<typeof createDeliveryPort>;
type Envelope = Parameters<DeliveryPortHandle["deliver"]>[0];

const defaultEnvelope = (overrides: Partial<Envelope> = {}): Envelope => ({
	payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "subagent done", display: true, details: { outcome: "completed" } },
	...overrides,
});

// ─── 四步对位 ───────────────────────────────────────────────

describe("四步对位（受理前落盘 → 注入 → message_end 命中 → ack）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("直通路径：outbox 落盘先于 sendMessage；命中后 ack 落盘且重放差集清零", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		const receipt = port.deliver(defaultEnvelope({ id: "n-1" }));
		expect(receipt).toEqual({ kind: "accepted", id: "n-1" });

		// ① 受理前落盘（plain entry，v2 schema；appendEntry 先于 sendMessage）
		expect(h.callLog).toEqual(["appendEntry:delivery-port-outbox", "sendMessage:subagent-bg-notify"]);
		const outbox = h.outboxEntries();
		expect(outbox).toHaveLength(1);
		expect(outbox[0]!["data"]).toMatchObject({
			v: 2,
			id: "n-1",
			timing: "steer",
			recordedAt: T0,
			payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "subagent done", display: true, details: { outcome: "completed" } },
		});

		// ② 注入直达唯一队列（steer 档 + triggerTurn；deliveryId 注入前写入 details）
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(h.sent[0].message.details).toEqual({ outcome: "completed", deliveryId: "n-1" });

		// ③ message_end 命中 details.deliveryId → ④ 内核终局 + ack entry
		h.injectAndEmit(h.sent[0].message);
		const acks = h.ackEntries();
		expect(acks).toHaveLength(1);
		expect(acks[0]!["data"]).toMatchObject({ v: 2, id: "n-1" });

		// 差集清零：重放零动作
		expect(port.recover()).toBe(0);
	});

	it("followUp 档透传 deliverAs", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		port.deliver(defaultEnvelope({ id: "n-2", timing: "followUp" }));
		expect(h.sent[0].options.deliverAs).toBe("followUp");
	});

	it("缺省 id 内部生成且注入 details 携带同一 id", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		const receipt = port.deliver(defaultEnvelope());
		expect(receipt.kind).toBe("accepted");
		expect(h.sent[0].message.details).toMatchObject({ deliveryId: (receipt as { id: string }).id });
	});
});

// ─── 幂等 ───────────────────────────────────────────────────

describe("幂等（同 id 重提交 swallowed）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("缓冲成员同 id 重提交 swallowed", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		expect(port.deliver(defaultEnvelope({ id: "dup-1" })).kind).toBe("accepted");
		expect(port.deliver(defaultEnvelope({ id: "dup-1" }))).toEqual({ kind: "swallowed", reason: "already-seen" });
		// 落盘只一份（重复提交不写第二条 outbox 记录）
		expect(h.outboxEntries()).toHaveLength(1);
	});

	it("直通条目已终局后跨实例同 id 提交不重投（判重三级：持久终局播种）", () => {
		const h = makeHost();
		const first = createDeliveryPort(h.host);
		first.deliver(defaultEnvelope({ id: "done-1" }));
		h.injectAndEmit(h.sent[0].message); // 送达 + ack
		first.dispose();

		const second = createDeliveryPort(h.host); // 新实例（同 session 文件语义）
		second.deliver(defaultEnvelope({ id: "done-1" })); // 内核判重吞（debug 留痕）
		expect(h.sent).toHaveLength(1); // 未重投
		expect(h.debug).toHaveBeenCalled();
	});

	it("缺省 id 跨实例不与历史终局 dp-N 撞车（时间戳段防 idSeq 实例重置）", () => {
		// fork / resume 复制历史 entries：dp-1 已终局（outbox + ack 终局列）——
		// 新实例 loadTerminalIds 播种判重索引，genId 若纯序号会生成同 id 被吞。
		const h = makeHost({
			entries: [
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "dp-1", timing: "steer", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "old", display: true }, recordedAt: T0 } },
				{ type: "custom", customType: ACK_CUSTOM_TYPE, data: { v: 2, id: "dp-1" } },
			],
		});
		const port = createDeliveryPort(h.host);
		const receipt = port.deliver(defaultEnvelope()); // 缺省 id：genId 生成
		expect(receipt.kind).toBe("accepted");
		const id = (receipt as { id: string }).id;
		expect(id).not.toBe("dp-1"); // 不与历史终局 id 撞车
		expect(h.sent).toHaveLength(1); // 未被内核判重吞（撞 id 会 swallowed 静默丢失）
		expect(h.sent[0].message.details).toMatchObject({ deliveryId: id });
	});
});

// ─── 边沿即投与批组隔离（subagent-observability §3.3.7③ 攒批窗退役后行为锁）──

describe("边沿即投与批组隔离（攒批窗已删）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("默认通道边沿即投：落盘受理后立即注入（单条无批 wrapper），无窗口等待", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		port.deliver(defaultEnvelope({ id: "b-1", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "first", display: true, details: { k: 1 } } }));
		// 边沿即投：无 60s 窗口——落盘受理后同步出站
		expect(h.sent).toHaveLength(1);
		expect(h.outboxEntries()).toHaveLength(1); // 受理前已落盘
		expect(h.sent[0].message.customType).toBe(DEFAULT_NOTIFY_CUSTOM_TYPE);
		expect((h.sent[0].message.details as Record<string, unknown>)["batch"]).toBeUndefined();

		// message_end 命中 → ack
		h.injectAndEmit(h.sent[0].message);
		const ackIds = h.ackEntries().map((a) => (a["data"] as { id: string }).id);
		expect(ackIds).toEqual(["b-1"]);
		// 无第二批：窗口机制已删，定时器不存在
		vi.advanceTimersByTime(120_000);
		expect(h.sent).toHaveLength(1);
	});

	it("同组多成员近同时到达 → 分组放行合成一条批消息（保留边界：pumpDirect/commitAsBatch 批形态）", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		// 同步段连续提交：首条触发的 pump 已取走首条，第二条在新一轮 pump 与首条
		// 内核注入的 merge-commit hold 窗内聚合——同通道批形态仍合法（保留边界断言）
		port.deliver(defaultEnvelope({ id: "g-1", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "one", display: true, details: { k: 1 } } }));
		port.deliver(defaultEnvelope({ id: "g-2", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "two", display: true, details: { k: 2 } } }));
		expect(h.sent.length).toBeGreaterThanOrEqual(1);
		expect(h.sent.length).toBeLessThanOrEqual(2);
		// 全部条目都出站（不丢）
		const deliveredIds = h.sent
			.flatMap((s) => {
				const details = s.message.details as { batch?: boolean; items?: Array<Record<string, unknown>>; deliveryId?: string };
				return details.batch === true ? (details.items ?? []).map((i) => i.deliveryId) : [details.deliveryId];
			})
			.sort();
		expect(deliveredIds).toEqual(["g-1", "g-2"]);
		// 出站消息恒单通道（批组隔离不变量）
		for (const s of h.sent) expect(s.message.customType).toBe(DEFAULT_NOTIFY_CUSTOM_TYPE);
	});

	it("外部通道逐条批组隔离：立即单独注入，与默认通道不混批", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		const wf = { kind: "custom" as const, customType: "workflow-result", content: "workflow done", display: true, details: { runId: "r-1" } };
		expect(port.deliver({ id: "wf-1", payload: wf })).toEqual({ kind: "accepted", id: "wf-1" });
		expect(h.sent).toHaveLength(1); // 外部通道立即逐条
		expect(h.sent[0].message.details).toEqual({ runId: "r-1", deliveryId: "wf-1" }); // 无 batch wrapper

		port.deliver(defaultEnvelope({ id: "bg-1" })); // 默认通道边沿即投
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1].message.customType).toBe(DEFAULT_NOTIFY_CUSTOM_TYPE); // 各自通道出站
		expect((h.sent[1].message.details as Record<string, unknown>)["batch"]).toBeUndefined();
		// 外部通道消息不含默认通道成员（无混批）
		expect(JSON.stringify(h.sent[0].message.details)).not.toContain("bg-1");
	});

	it("flush() 幂等放行缓冲条目（空缓冲 no-op 不报错）", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		port.flush(); // 空缓冲 no-op
		expect(h.sent).toHaveLength(0);
		port.deliver(defaultEnvelope({ id: "f-1" }));
		expect(h.sent).toHaveLength(1); // 边沿已投
		port.flush(); // 已出站，无重复注入
		expect(h.sent).toHaveLength(1);
	});
});

// ─── compaction 等待 ────────────────────────────────────────

describe("compaction 等待降级与事件唤醒", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("before_compact 置标记 → 缓冲挂起不注入（落盘已完成）；session_compact 复位唤醒重投", () => {
		const h = makeHost({ idle: false });
		const port = createDeliveryPort(h.host);
		h.fireBeforeCompact(); // compaction 开始边沿（事件标记置位，非 isIdle 判定）
		const receipt = port.deliver(defaultEnvelope({ id: "c-1" }));
		expect(receipt).toEqual({ kind: "accepted", id: "c-1" }); // 受理成功（落盘已完成）
		expect(h.sent).toHaveLength(0); // 注入被 compaction 等待挂起
		expect(h.outboxEntries()).toHaveLength(1); // 留账

		h.fireCompact(); // 终态边沿：标记复位 + 唤醒（idle 仍 false——唤醒不依赖 idle 翻转）
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].options.deliverAs).toBe("steer");

		h.injectAndEmit(h.sent[0].message);
		expect(h.ackEntries()).toHaveLength(1);
	});

	it("session_compact_failed 边沿同样复位唤醒", () => {
		const h = makeHost({ idle: false });
		const port = createDeliveryPort(h.host);
		h.fireBeforeCompact();
		port.deliver(defaultEnvelope({ id: "c-2" }));
		expect(h.sent).toHaveLength(0);
		h.fireCompactFailed();
		expect(h.sent).toHaveLength(1);
	});

	it("run 活跃（isIdle=false）未 compaction → 照常注入（steer 入 pi 队列不拒）", () => {
		const h = makeHost({ idle: false }); // run 活跃：无 before_compact，标记 false
		const port = createDeliveryPort(h.host);
		const receipt = port.deliver(defaultEnvelope({ id: "run-1" }));
		expect(receipt).toEqual({ kind: "accepted", id: "run-1" });
		expect(h.sent).toHaveLength(1); // run 活跃不再挂起——立即放行
		expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("持有期内 settled 边沿只做无谓尝试，仍挂起（无双重注入）", () => {
		const h = makeHost({ idle: false });
		const port = createDeliveryPort(h.host);
		h.fireBeforeCompact();
		port.deliver(defaultEnvelope({ id: "c-3" }));
		h.fireSettled(); // 持有期内内核 flush 驱动：send 拒受理（compaction-wait）→ retain
		expect(h.sent).toHaveLength(0); // 标记未复位 → 仍挂起
		h.fireCompact(); // 终态边沿才放行
		expect(h.sent).toHaveLength(1); // 恰好一次（无双重注入）
	});

	it("注入 throw → 内核 retain 留账 + settleRejected 计数；恢复后 settled 边沿重投", () => {
		const h = makeHost({ idle: true });
		h.sendThrows.value = true;
		const port = createDeliveryPort(h.host);
		expect(port.deliver(defaultEnvelope({ id: "t-1" })).kind).toBe("accepted");
		expect(h.sent).toHaveLength(0);
		expect(port.metrics().settleRejected).toBe(1);
		expect(h.warn).toHaveBeenCalled(); // 失败可见（kernel retain warn + bucket log）

		h.sendThrows.value = false;
		h.fireSettled(); // settled 边沿 → 内核 retain 条目重投（on-accept 旁路 busy gate）
		expect(h.sent).toHaveLength(1);
		h.injectAndEmit(h.sent[0].message);
		expect(h.ackEntries()).toHaveLength(1);
	});
});

// ─── 失败保留策略（onFailure 覆写）──────────────────────────

describe("失败保留策略（onFailure 覆写）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("显式 forget 首败即弃（真注入 throw）：discard 终局列落盘、settled 边沿不重投、重放不复活", () => {
		const h = makeHost();
		h.sendThrows.value = true; // 注入通道全程 throw
		const port = createDeliveryPort(h.host);
		expect(port.deliver(defaultEnvelope({ id: "fg-1" }), { onFailure: "forget" }).kind).toBe("accepted");
		// 提交链两段：首投被 commitAsBatch 注入门禁 hold（设计内等待，不计首败、无终局落盘）
		// → kernel.flush() 重提 → 真注入 throw（首败语义生效）：forget → discard。
		// settleRejected=1 锚定 discard 由真注入失败触发（hold 路径不计数）。
		expect(h.sent).toHaveLength(0);
		expect(port.metrics().settleRejected).toBe(1);
		// forget → 内核 store.discard → ack entry outcome:"discarded"（持久终局列）
		const acks = h.ackEntries();
		expect(acks).toHaveLength(1);
		expect(acks[0]!["data"]).toMatchObject({ v: 2, id: "fg-1", outcome: "discarded" });

		h.sendThrows.value = false;
		h.fireSettled(); // forget 条目已弃（retain 才留守重投）：无重投
		expect(h.sent).toHaveLength(0);

		// 重放差集同判：discard 条目不复活
		const second = createDeliveryPort(h.host);
		expect(second.recover()).toBe(0);
		expect(h.sent).toHaveLength(0);
	});

	it("提交窗 hold 拒不计首败：forget 条目不被 discard、留册，重提送达成功", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		// 边沿即投仍经 commitAsBatch 提交窗：首投被注入门禁 hold（设计内等待）
		expect(port.deliver(defaultEnvelope({ id: "hd-1" }), { onFailure: "forget" }).kind).toBe("accepted");
		// kernel.flush() 重提 → 送达成功（旧实现此处 hold 被误计首败 → discard 永久丢弃）
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].message.details).toMatchObject({ deliveryId: "hd-1" });
		expect(h.ackEntries()).toHaveLength(0); // 无 discard 终局（条目全程未失败）
		expect(port.metrics().settleRejected).toBe(0); // hold 不计注入失败
		const firstFailWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("first-failure"));
		expect(firstFailWarns).toHaveLength(0); // 无首败 warn（hold 走设计内等待留痕）
		// 送达正常终局
		h.injectAndEmit(h.sent[0].message);
		expect(h.ackEntries()[0]!["data"]).toEqual({ v: 2, id: "hd-1" });
	});

	it("提交窗 hold 拒对 retain 条目同样不计首败：留守不重复计数，重提送达正常终局", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		port.deliver(defaultEnvelope({ id: "hd-r" })); // 缺省 retain——边沿即投经 commitAsBatch（首投 hold 留守）→ kernel.flush 重提
		expect(h.sent).toHaveLength(1);
		expect(port.metrics().settleRejected).toBe(0); // hold 不重复计入失败
		const firstFailWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("first-failure"));
		expect(firstFailWarns).toHaveLength(0);
		h.injectAndEmit(h.sent[0].message);
		expect(h.ackEntries()[0]!["data"]).toEqual({ v: 2, id: "hd-r" }); // ack（无 outcome = 非 discard）
	});

	it("缺省（不传 onFailure）：首投经提交窗 hold 留守（设计内等待）；重投遇真注入 throw → retain 留账，恢复后边沿重投", () => {
		const h = makeHost({ idle: true });
		h.sendThrows.value = true;
		const port = createDeliveryPort(h.host);
		expect(port.deliver(defaultEnvelope({ id: "rt-1" })).kind).toBe("accepted");
		expect(h.ackEntries()).toHaveLength(0); // hold 非失败 + retain 留守：均无终局落盘
		expect(port.metrics().settleRejected).toBe(1); // 真注入 throw（重投轮）已计数
		h.sendThrows.value = false;
		h.fireSettled();
		expect(h.sent).toHaveLength(1); // settled 边沿重投
	});
});

// ─── session_start 差集重放 ─────────────────────────────────

describe("session_start 差集重放", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("崩溃在注入前：新实例 recover 重投（同组重放批形态）且 replayReplays 计数", () => {
		const h = makeHost();
		const first = createDeliveryPort(h.host);
		first.deliver(defaultEnvelope({ id: "r-1", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "one", display: true } }));
		first.deliver(defaultEnvelope({ id: "r-2", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "two", display: true } }));
		first.dispose(); // 崩溃：进程消亡，outbox entry 留在 session 文件（首实例边即投的 sent 不算送达——无 message_end）

		const second = createDeliveryPort(h.host); // respawn 后 session_start 重新装配
		const sentBefore = h.sent.length;
		expect(second.recover()).toBe(2);
		expect(second.metrics().recoveryReplays).toBe(2);
		// 重放同组两条一起放行 → 分组放行批形态（保留边界断言）：一条批消息
		expect(h.sent.length).toBe(sentBefore + 1);
		const replayMsg = h.sent[h.sent.length - 1].message;
		const items = (replayMsg.details as { items: Array<Record<string, unknown>> }).items;
		expect(items.map((i) => i.deliveryId).sort()).toEqual(["r-1", "r-2"]);
	});

	it("已送达未 ack（强杀窗口）：凭 transcript deliveryId 排除，零重投", () => {
		const h = makeHost({
			entries: [
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "sent-1", timing: "steer", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "x", display: true }, recordedAt: T0 } },
				{ type: "custom_message", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, details: { deliveryId: "sent-1" } },
			],
		});
		const port = createDeliveryPort(h.host);
		expect(port.recover()).toBe(0);
		expect(h.sent).toHaveLength(0);
	});

	it("v1 账本存量重放：notifyId 映射 id、通道映射、record→details；分组放行外部通道逐条", () => {
		const h = makeHost({
			entries: [
				{ type: "custom", customType: V1_OUTBOX_CUSTOM_TYPE, data: { v: 1, notifyId: "leg-1", content: "legacy body", record: { notifyId: "leg-1" } } },
				{ type: "custom", customType: V1_OUTBOX_CUSTOM_TYPE, data: { v: 1, notifyId: "leg-2", content: "wf body", record: { a: 1 }, deliveryCustomType: "workflow-result" } },
			],
		});
		const port = createDeliveryPort(h.host);
		expect(port.recover()).toBe(2);
		// 分组放行：默认通道 leg-1 单批一条；外部通道 leg-2 逐条一条
		expect(h.sent).toHaveLength(2);
		const byId = new Map(h.sent.map((s) => [(s.message.details as Record<string, unknown>)["deliveryId"], s.message]));
		expect(byId.get("leg-1")).toMatchObject({ customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "legacy body", details: { notifyId: "leg-1" } });
		expect(byId.get("leg-2")?.customType).toBe("workflow-result");
		expect((byId.get("leg-1") as { details: Record<string, unknown> }).details["batch"]).toBeUndefined();
	});

	it("重放幂等：recover 二次调用零动作（在途条目不重复入账）", () => {
		const h = makeHost();
		const first = createDeliveryPort(h.host);
		first.deliver(defaultEnvelope({ id: "ri-1" }));
		first.dispose();
		const second = createDeliveryPort(h.host);
		expect(second.recover()).toBe(1);
		expect(second.recover()).toBe(0); // 二次 recover：条目已入账（in-flight 等回执），不再重放
		// sent 2 条 = first 实例注入 1（投出未送达——无回执无 ack，差集合法重投）+ 重放 1
		expect(h.sent).toHaveLength(2);
	});
});

// ─── 耐久承诺 ───────────────────────────────────────────────

describe("受理前落盘（耐久承诺）", () => {
	it("appendEntry 抛错 → rejected(persist-failed)，不注入、id 不登记（可重试）", () => {
		const h = makeHost();
		let fail = false;
		const host = h.host;
		const orig = host.appendEntry;
		host.appendEntry = (customType, data) => {
			if (fail) throw new Error("disk full (fake)");
			orig(customType, data);
		};
		const port = createDeliveryPort(host);
		fail = true;
		expect(port.deliver(defaultEnvelope({ id: "pf-1" }))).toEqual({ kind: "rejected", reason: "persist-failed" });
		expect(h.sent).toHaveLength(0);
		// 恢复后同 id 重提合法（rejected 条目幂等键未登记）
		fail = false;
		expect(port.deliver(defaultEnvelope({ id: "pf-1" })).kind).toBe("accepted");
		expect(h.sent).toHaveLength(1);
	});
});

// ─── 装配槽（C-ext-06 惯例）─────────────────────────────────

describe("进程级槽（bindDeliveryPort / getDeliveryPort）", () => {
	it("bind 后 getDeliveryPort 返回同实例；重复 bind 替换并 dispose 旧实例", () => {
		const h1 = makeHost();
		const bound = bindDeliveryPort(h1.host);
		expect(getDeliveryPort()).toBe(bound);
		const h2 = makeHost();
		const bound2 = bindDeliveryPort(h2.host);
		expect(getDeliveryPort()).toBe(bound2);
		expect(bound2).not.toBe(bound);
		// 旧实例已 dispose：deliver 拒收
		expect(bound.deliver(defaultEnvelope({ id: "x" })).kind).toBe("rejected");
		_resetDeliveryPortForTest();
	});

	it("getDeliveryPort 未装配返回 undefined（缺席语义由调用方降级）", () => {
		_resetDeliveryPortForTest();
		expect(getDeliveryPort()).toBeUndefined();
	});
});

// ─── collect 挂起面（result-collect 设计 §3.1②；§4 中断形态单测分工）───

/** pending register entry fixture（写侧落盘形态：index.ts safeAppendEntry 同构）。 */
const pendingRegister = (id: string, type = "bash") => ({
	type: "custom",
	customType: "pending:register",
	data: { id, type, name: `task ${id}`, registeredAt: T0, sessionId: "s-1" },
});

/** pending unregister entry fixture（reason = 写侧真实原因词，status = mapReasonToStatus
 *  映射落盘的 legacy 副档——生产 listener 双字段同写，结清解析以 reason 为权威）。 */
const pendingUnregister = (id: string, reason: string, status: string) => ({
	type: "custom",
	customType: "pending:unregister",
	data: { id, reason, status },
});

const managedEnvelope = (id: string, overrides: Partial<Envelope> = {}): Envelope => ({
	payload: {
		kind: "custom",
		customType: "managed-session-notify",
		content: "managed batch done",
		display: true,
		details: { outcome: "completed" },
	},
	id,
	...overrides,
});
const deliverManaged = (port: ReturnType<typeof createDeliveryPort>, id: string, collectKey: string[]) =>
	port.deliver(managedEnvelope(id), { collectKey });

describe("collect 挂起分流与收取（合批多键）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("等待集命中 → 条目挂起（不注入、落盘带 collectKey）+ 到达回调；consume 全键展开写 collected 终局", () => {
		const h = makeHost({ entries: [pendingRegister("k-a"), pendingRegister("k-b")] });
		const port = createDeliveryPort(h.host);
		const arrivals = vi.fn();
		port.onCollectArrival(arrivals);

		const snap = port.collectArm(["k-a", "k-b"]);
		expect(snap.map((s) => s.state)).toEqual(["waiting", "waiting"]);

		// managed 合批条目（collectKey = 批内全部债权键）→ 挂起：不进内核、零注入
		const receipt = deliverManaged(port, "mg-1", ["k-a", "k-b"]);
		expect(receipt).toEqual({ kind: "accepted", id: "mg-1" });
		expect(h.sent).toHaveLength(0);
		expect(arrivals).toHaveBeenCalledTimes(1);
		// 落盘照常（I2）：条目 data 携带 collectKey 键集
		expect(h.outboxEntries()[0]!["data"]).toMatchObject({ id: "mg-1", collectKey: ["k-a", "k-b"] });
		// 同实例 recover 不重放挂起条目（已受理在册）
		expect(port.recover()).toBe(0);

		// consume：按条目键集全量逐键展开（每键一条、载荷共享），终局按日志条目写一次。
		// 返回条目只含 {id, content, details}——type/outcome 归消费方终局回填（MF-1-6）
		const collected = port.consume();
		expect(collected).toHaveLength(2);
		expect(collected[0]).toMatchObject({ id: "k-a", content: "managed batch done" });
		expect(collected[1]).toMatchObject({ id: "k-b", content: "managed batch done" });
		expect(collected[0]).not.toHaveProperty("type");
		expect(collected[0]).not.toHaveProperty("outcome");
		expect(collected[0]!.details).toEqual(collected[1]!.details);
		const acks = h.ackEntries();
		expect(acks).toHaveLength(1); // 一条条目一个终局（I1）
		expect(acks[0]!["data"]).toMatchObject({ v: 2, id: "mg-1", outcome: "collected" });
		// 差集重放排除 collected：重启后新实例零重放、零注入（验收判据③）
		const second = createDeliveryPort(h.host);
		expect(second.recover()).toBe(0);
		expect(h.sent).toHaveLength(0);
	});

	it("显式子集命中同批全键返回：只等 k-a，合批条目 k-a+k-b 一次收齐", () => {
		const h = makeHost({ entries: [pendingRegister("k-a"), pendingRegister("k-b")] });
		const port = createDeliveryPort(h.host);
		port.collectArm(["k-a"]); // 等待集只登记 k-a

		const receipt = deliverManaged(port, "mg-2", ["k-a", "k-b"]);
		expect(receipt.kind).toBe("accepted");
		expect(h.sent).toHaveLength(0); // 命中等待集 → 挂起

		const collected = port.consume();
		// 展开判据 = 条目键集全量：同批其余键一并返回（无部分命中中间概念）
		expect(collected.map((c) => c.id).sort()).toEqual(["k-a", "k-b"]);
	});

	it("collectRelease 解散等待集 + 未收挂起条目直通内核（边沿即投无窗口，恢复 push）", () => {
		const h = makeHost({ entries: [pendingRegister("k-a")] });
		const port = createDeliveryPort(h.host);
		port.collectArm(["k-a"]);
		deliverManaged(port, "mg-3", ["k-a"]);
		expect(h.sent).toHaveLength(0);

		port.collectRelease();
		expect(h.sent).toHaveLength(1); // 直通注入，不等窗口
		vi.advanceTimersByTime(60_000);
		expect(h.sent).toHaveLength(1); // 无窗口兜底第二投

		// 等待集已解散：后续同键条目正常 push（不再挂起）
		const later = deliverManaged(port, "mg-4", ["k-a"]);
		expect(later.kind).toBe("accepted");
		expect(h.sent).toHaveLength(2);
	});

	it("onCollectArrival 退订后不再触发；到达回调 throw 不向 deliver 传播", () => {
		const h = makeHost({ entries: [pendingRegister("k-a")] });
		const port = createDeliveryPort(h.host);
		const arrivals = vi.fn(() => {
			throw new Error("waiter gone");
		});
		const unsub = port.onCollectArrival(arrivals);
		port.collectArm(["k-a"]);
		unsub();
		expect(deliverManaged(port, "mg-5", ["k-a"]).kind).toBe("accepted");
		expect(arrivals).not.toHaveBeenCalled();
		expect(h.outboxEntries()).toHaveLength(1); // 条目在挂起缓冲（可被 consume）
		const collected = port.consume();
		expect(collected).toHaveLength(1);
	});
});

describe("collectArm 五态快照", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ready：日志条目已有终局 → 快照收取（读侧，不写新终局）", () => {
		const h = makeHost({
			entries: [
				pendingRegister("k-done"),
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "done-e1", timing: "steer", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "finished body", display: true, details: { outcome: "completed" } }, recordedAt: T0, collectKey: ["k-done"] } },
				{ type: "custom", customType: ACK_CUSTOM_TYPE, data: { v: 2, id: "done-e1" } },
			],
		});
		const port = createDeliveryPort(h.host);
		const snap = port.collectArm(["k-done"]);
		expect(snap).toHaveLength(1);
		expect(snap[0]).toMatchObject({ id: "k-done", state: "ready" });
		expect(snap[0]!.entry).toMatchObject({ type: "bash", content: "finished body", details: { outcome: "completed" } });
		// ready 是读侧快照：不写新终局（已 delivered 条目再写 collected = 日志宣称未注入过）
		expect(h.ackEntries()).toHaveLength(1);
	});

	it("in-push-pipeline：日志条目无终局（已过分流点）→ 不收取不等待，不登记等待集", () => {
		const h = makeHost({
			entries: [
				pendingRegister("k-pipe"),
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "pipe-e1", timing: "steer", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "queued", display: true }, recordedAt: T0, collectKey: ["k-pipe"] } },
			],
		});
		const port = createDeliveryPort(h.host);
		const snap = port.collectArm(["k-pipe"]);
		expect(snap[0]).toMatchObject({ id: "k-pipe", state: "in-push-pipeline" });
		// 不登记等待集：该键后续新条目到达不挂起（push 零变化）
		expect(deliverManaged(port, "mg-pipe", ["k-pipe"]).kind).toBe("accepted");
		expect(h.sent).toHaveLength(1);
	});

	it("unregistered-no-entry：曾注册已注销且无日志条目 → 按 unregister reason 结清解析定 outcome（三形态：死亡跨批 / 例外1 / 防御分支收尾）", () => {
		// 写侧 listener 双字段同写：reason = 真实原因词（结清权威通道）、status = legacy
		// 副档。exited/orphaned → cancelled（死亡跨批・例外1）、stopped → cancelled
		// （中止族——legacy status 副档为 aborted，结清视图以五值为准）、reopened →
		// completed（防御分支收尾）
		const cases: Array<{ id: string; reason: string; status: string }> = [
			{ id: "k-death", reason: "exited", status: "cancelled" },
			{ id: "k-orph", reason: "orphaned", status: "cancelled" },
			{ id: "k-stop", reason: "stopped", status: "aborted" },
			{ id: "k-defn", reason: "reopened", status: "completed" },
		];
		const h = makeHost({
			entries: [...cases.map((c) => pendingRegister(c.id)), ...cases.map((c) => pendingUnregister(c.id, c.reason, c.status))],
		});
		const port = createDeliveryPort(h.host);
		const snap = port.collectArm(cases.map((c) => c.id));
		expect(snap.map((s) => s.state)).toEqual(["unregistered-no-entry", "unregistered-no-entry", "unregistered-no-entry", "unregistered-no-entry"]);
		expect(snap[0]!.entry).toMatchObject({ outcome: "cancelled", note: expect.any(String) });
		expect(snap[2]!.entry).toMatchObject({ outcome: "cancelled" });
		expect(snap[3]!.entry).toMatchObject({ outcome: "completed" });
		// 无处可写终局（该键不属任何日志条目）：零 ack entry
		expect(h.ackEntries()).toHaveLength(0);
	});

	it("waiting：活跃无条目 → 登记等待集（deliver 命中被挂起）", () => {
		const h = makeHost({ entries: [pendingRegister("k-wait")] });
		const port = createDeliveryPort(h.host);
		const snap = port.collectArm(["k-wait"]);
		expect(snap[0]).toEqual({ id: "k-wait", state: "waiting" });
		expect(h.sent).toHaveLength(0);
		expect(deliverManaged(port, "mg-wait", ["k-wait"]).kind).toBe("accepted");
		expect(h.sent).toHaveLength(0); // 挂起
	});

	it("未知键（未注册且无条目）：显式 unknown 态——不登记等待集（deliver 不挂起）、不虚构终态", () => {
		const h = makeHost();
		const port = createDeliveryPort(h.host);
		const snap = port.collectArm(["k-ghost"]);
		// 第五态 unknown（MF-1-5）：端口未知判定单点——快照诚实表达，工具侧读本态组装 errors
		expect(snap[0]).toEqual({ id: "k-ghost", state: "unknown" });
		expect(deliverManaged(port, "mg-ghost", ["k-ghost"]).kind).toBe("accepted");
		expect(h.sent).toHaveLength(1); // 未挂起（防空等到 timeout）
	});

	it("挂起条目 consume 后 collectRelease 幂等（缓冲已清，无第二投）", () => {
		const h = makeHost({ entries: [pendingRegister("k-c")] });
		const port = createDeliveryPort(h.host);
		port.collectArm(["k-c"]);
		deliverManaged(port, "mg-c1", ["k-c"]);
		expect(port.consume()).toHaveLength(1);
		port.collectRelease();
		expect(h.sent).toHaveLength(0); // 已收条目不恢复 push（收取构造性不可再投）
	});
});

describe("collect 中断形态（§4 单测分工）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("abort 唤醒归并（AbortSignal 先于 dispose）：工具侧 abort 归并（consume + collectRelease）后 dispose 无在途 warn", () => {
		const h = makeHost({ entries: [pendingRegister("k-ab")] });
		const port = createDeliveryPort(h.host);
		port.collectArm(["k-ab"]);
		deliverManaged(port, "mg-ab", ["k-ab"]);
		// session 替换路径 abort 先到：等待器被唤醒走归并（已收部分返回 + 解散等待集）
		port.consume();
		port.collectRelease();
		port.dispose();
		const inFlightWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("in-flight collect"));
		expect(inFlightWarns).toHaveLength(0);
	});

	it("dispose 在途等待器 → warn 留痕不变量检查（不定义唤醒与返回语义）", () => {
		const h = makeHost({ entries: [pendingRegister("k-dw")] });
		const port = createDeliveryPort(h.host);
		port.collectArm(["k-dw"]); // 等待集在途
		deliverManaged(port, "mg-dw", ["k-dw"]); // 挂起缓冲非空
		port.dispose();
		const inFlightWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("in-flight collect"));
		expect(inFlightWarns).toHaveLength(1);
		expect(String(inFlightWarns[0]![0])).toMatch(/waiting=1, suspended=1/);
	});

	it("重放作用域：fork 历史祖先 fixture——接管 session journal 不含旧挂起条目 → recover()=0 负向断言", () => {
		// 旧 session journal：register + 等待期挂起条目（outbox 无终局）
		const oldJournal = [
			pendingRegister("k-fork"),
			{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "mg-old", timing: "steer", payload: { kind: "custom", customType: "managed-session-notify", content: "suspended", display: true }, recordedAt: T0, collectKey: ["k-fork"] } },
		];
		const first = createDeliveryPort(makeHost({ entries: [...oldJournal] }).host);
		first.dispose();
		// fork 历史祖先形态：新 session entries 只复制 root→fork 点祖先路径（常规 fork
		// 分支点早于等待期条目）——挂起条目不在 branch 路径内
		const forkedEntries = [pendingRegister("k-fork")];
		const second = createDeliveryPort(makeHost({ entries: forkedEntries }).host);
		expect(second.recover()).toBe(0);
	});

	it("重放作用域：旧 entries 再 bind → recover() 返回未收条目数（延迟投递正向断言）", () => {
		const h = makeHost({
			entries: [
				pendingRegister("k-rebind"),
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "mg-rb", timing: "steer", payload: { kind: "custom", customType: "managed-session-notify", content: "left behind", display: true }, recordedAt: T0, collectKey: ["k-rebind"] } },
			],
		});
		const first = createDeliveryPort(h.host);
		first.dispose(); // 旧实例消亡（未 consume——挂起条目留旧 session 日志）
		const second = createDeliveryPort(h.host); // 同 session 重开/resume 再 bind
		expect(second.recover()).toBe(1); // 差集重放按未投递重投（I2 零丢失）
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.message.details).toMatchObject({ deliveryId: "mg-rb" });
	});

	it("重放作用域边沿（fork 点取当前叶，RPC clone 形态）：新 journal 含等待期条目 → recover() 返回该条目数并重放为 push（已登记边沿）", () => {
		// createBranchedSession 取当前叶（position:"at"）时祖先路径包含等待期挂起条目，
		// 副本先于 abort 写盘、恒不含 collected 终局 → 新实例 recover 重放为 push
		const h = makeHost({
			entries: [
				pendingRegister("k-leaf"),
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "mg-leaf", timing: "steer", payload: { kind: "custom", customType: "managed-session-notify", content: "cloned", display: true }, recordedAt: T0, collectKey: ["k-leaf"] } },
			],
		});
		const port = createDeliveryPort(h.host);
		expect(port.recover()).toBe(1);
		expect(h.sent).toHaveLength(1); // 重放为 push
	});

	it("无 collectKey 旧条目照常重放（可选字段 guard：升级前条目不参与键匹配、差集不受影响）", () => {
		const h = makeHost({
			entries: [
				pendingRegister("k-legacy"),
				{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { v: 2, id: "legacy-1", timing: "steer", payload: { kind: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, content: "pre-upgrade", display: true }, recordedAt: T0 } },
			],
		});
		const port = createDeliveryPort(h.host);
		// 无键条目不参与 collect 匹配：arm 该键为 waiting（活跃无条目）
		expect(port.collectArm(["k-legacy"])[0]!.state).toBe("waiting");
		// 差集重放照常收录
		expect(port.recover()).toBe(1);
		expect(h.sent).toHaveLength(1);
	});

	it("consume 终局写失败降级：appendEntry 抛错 → warn 留痕、载荷照常返回（先写终局后返回的偶发语义）", () => {
		const h = makeHost({ entries: [pendingRegister("k-wf")] });
		const host = h.host;
		const orig = host.appendEntry;
		host.appendEntry = (customType, data) => {
			if (customType === ACK_CUSTOM_TYPE) throw new Error("disk full (fake)");
			orig(customType, data);
		};
		const port = createDeliveryPort(host);
		port.collectArm(["k-wf"]);
		deliverManaged(port, "mg-wf", ["k-wf"]);
		const collected = port.consume();
		// 载荷不丢：等待器照常拿到收取结果
		expect(collected).toHaveLength(1);
		expect(collected[0]).toMatchObject({ id: "k-wf", content: "managed batch done" });
		const terminalWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("terminal write failed"));
		expect(terminalWarns).toHaveLength(1);
		expect(h.ackEntries()).toHaveLength(0); // 终局未落盘（重放可能重投为 push——偶发语义留痕）
	});
});

// ─── dispose 语义 ───────────────────────────────────────────

describe("dispose", () => {
	it("dispose 后 deliver 拒收、订阅退订（重绑不累积死 handler）", () => {
		const h = makeHost();
		// before_compact 订阅退订计数（dispose 兑现三个 compaction 事件订阅之一）
		let beforeCompactUnsubbed = 0;
		const origBeforeCompactSub = h.host.onSessionBeforeCompact;
		h.host.onSessionBeforeCompact = (handler) => {
			const unsub = origBeforeCompactSub(handler);
			return () => {
				beforeCompactUnsubbed += 1;
				unsub();
			};
		};
		const port = createDeliveryPort(h.host);
		port.dispose();
		expect(beforeCompactUnsubbed).toBe(1);
		expect(port.deliver(defaultEnvelope({ id: "d-1" }))).toEqual({ kind: "rejected", reason: "disposed" });

		// 退订验证：旧实例 handler 不再触发（消息命中不写旧 ack）
		const h2 = makeHost();
		bindDeliveryPort(h2.host);
		h.fireMessageEnd({ role: "custom", customType: DEFAULT_NOTIFY_CUSTOM_TYPE, details: { deliveryId: "anything" } });
		expect(h.ackEntries()).toHaveLength(0);
		_resetDeliveryPortForTest();
	});
});

/**
 * BgNotifier flushPendingNotifications — 单通道 triggerTurn 契约（U2 / D5）。
 *
 * 迁移史：deliverAs 从 'followUp' 改为 'steer'（FR-3/AC-3，commit d214d0d83）后，
 * U2 courier 单通道化再收敛——steer / followUp / nextTurn 通道全部删除（nextTurn
 * 唯一 drain 点在 session.prompt() 内，主 agent 长 streaming 场景下无限期滞留，
 * 设计 D5 实测证伪），唯一发送形态 = sendCustomMessage({triggerTurn:true})；busy
 * 场景由 ledger（settled 边沿 + isIdle 二次复查）或内核 settled 订阅在空闲边沿驱动。
 *
 * 测试方法：mock NotifierHost，捕获 sendMessage 调用参数，断言 options 恰为
 * { triggerTurn: true }（G4 字节锁定测试新锚：行为契约不变，机械迁移）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import { createNotifier, type BgNotifier, type NotifierHost } from "@zhushanwen/subagent-core/execution/notify/notifier.ts";

// 投递内核经通知域窄端口注入（notifier 不再直接 import session-delivery）——
// 本文件全部用例依赖真实内核语义（isIdle gate 退避 / 60s 合批 / dedup LRU /
// settled 边沿驱动 / revive 重建），故注入真实 createDelivery 保住回归面；
// afterEach 重置防注入态泄漏到其他测试文件（vitest 文件级模块隔离内的双保险）。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

/** mock host：捕获所有 sendMessage 调用 + 控制 hasRunningBackground + isIdle。 */
function makeMockHost(): NotifierHost & {
	sendMessageCalls: { message: unknown; options: unknown }[];
	hasRunningBackground: ReturnType<typeof vi.fn>;
	isIdle: ReturnType<typeof vi.fn>;
} {
	const sendMessageCalls: { message: unknown; options: unknown }[] = [];
	const hasRunningBackground = vi.fn(() => false);
	const isIdle = vi.fn(() => true);
	return {
		sendMessageCalls,
		hasRunningBackground,
		isIdle,
		sendMessage(message, options) {
			sendMessageCalls.push({ message, options });
		},
	};
}

describe("BgNotifier.flushPendingNotifications — 单通道 triggerTurn 契约（U2/D5）", () => {
	let host: ReturnType<typeof makeMockHost>;
		let notifier: BgNotifier;

	beforeEach(() => {
		host = makeMockHost();
		notifier = createNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
	});

	it("flush 时 sendMessage 的 options 恰为 { triggerTurn: true }（无 deliverAs，D5 单通道）", () => {
		notifier.notify({
			id: "bg-test-1",
			status: "closed",
			agent: "explorer",
			result: "done",
			startedAt: Date.now() - 1000,
			endedAt: Date.now(),
		});

		// hasRunningBackground=false → notify 立即 flush
		expect(host.sendMessageCalls).toHaveLength(1);
		const call = host.sendMessageCalls[0];
		expect(call.options).toEqual({ triggerTurn: true });
	});

	it("flush 时 triggerTurn 必须为 true（让父 agent 立即唤醒）", () => {
		notifier.notify({
			id: "bg-test-2",
			status: "closed",
			agent: "worker",
			error: "boom",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		expect(host.sendMessageCalls).toHaveLength(1);
		expect(host.sendMessageCalls[0].options).toEqual({ triggerTurn: true });
	});
});

describe("BgNotifier — isIdle gate 竞态修复", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;

	beforeEach(() => {
		vi.useFakeTimers();
		host = makeMockHost();
		notifier = createNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
		vi.useRealTimers();
	});

	it("主 agent busy 时 flush 退避，idle 后才 sendMessage（规避 agent_end→finishRun 竞态窗口）", () => {
		// 模拟竞态：notify 时主 agent 仍 streaming（isIdle=false）
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-race-1",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		// busy 退避：未发送
		expect(host.sendMessageCalls).toHaveLength(0);
		expect(host.isIdle).toHaveBeenCalled();

		// 推进 1 个退避间隔（100ms）——仍 busy，继续退避
		vi.advanceTimersByTime(100);
		expect(host.sendMessageCalls).toHaveLength(0);

		// 主 agent 变 idle
		host.isIdle.mockReturnValue(true);
		vi.advanceTimersByTime(100);

		// idle 后发送，单通道 {triggerTurn:true}（U2/D5：无 deliverAs）
		expect(host.sendMessageCalls).toHaveLength(1);
		expect(host.sendMessageCalls[0].options).toEqual({ triggerTurn: true });
	});

	it("主 agent 持续 busy 达退避上限后强制发送（防通知饿死）", () => {
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-starve-1",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		expect(host.sendMessageCalls).toHaveLength(0);
		// 推进超过退避上限（50 × 100ms = 5s）
		vi.advanceTimersByTime(10_000);

		// 达上限后 fallthrough 强制发送（至少不丢消息）
		expect(host.sendMessageCalls).toHaveLength(1);
	});

	it("未注入 isIdle 时不 gate，保持原立即发送行为（向后兼容）", () => {
		// 重建无 isIdle 的 host（模拟旧调用方/测试 host）
		const legacyHost: NotifierHost = {
			sendMessage: (message, options) => host.sendMessage(message, options),
			hasRunningBackground: () => false,
		};
		const legacyNotifier = createNotifier(legacyHost);
		legacyNotifier.notify({
			id: "bg-legacy-1",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		// 无 isIdle gate → 立即发送
		expect(host.sendMessageCalls).toHaveLength(1);
		legacyNotifier.dispose();
	});

	it("dispose 后退避 timer 不再触发发送", () => {
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-dispose-1",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		notifier.dispose();
		// 推进足够久，退避 timer 若未清会触发
		vi.advanceTimersByTime(10_000);
		expect(host.sendMessageCalls).toHaveLength(0);
	});
});

describe("BgNotifier dedup 按轮次（G1 决策 9：对话模式豁免 60s dedup）", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;

	beforeEach(() => {
		host = makeMockHost();
		// hasRunningBackground=false → notify 立即 flush（不排队）；dedup 仍在 push 前生效
		notifier = createNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
	});

	it("对话模式：同 id 不同 round 的两次 notify 不互相吞（round 参与 dedup key）", () => {
		notifier.notify({
			id: "sa-chat", status: "idle", agent: "w", round: 1, result: "round1",
			startedAt: 1, endedAt: 2,
		});
		notifier.notify({
			id: "sa-chat", status: "idle", agent: "w", round: 2, result: "round2",
			startedAt: 3, endedAt: 4,
		});

		// MF-1 修复：dedup key=id:round，不同 round 不互相吞
		expect(host.sendMessageCalls).toHaveLength(2);
	});

	it("同 id 同 round 60s 内第二次被 dedup 吞（防重复通知）", () => {
		notifier.notify({
			id: "sa-dup", status: "idle", agent: "w", round: 1, result: "r",
			startedAt: 1, endedAt: 2,
		});
		notifier.notify({
			id: "sa-dup", status: "idle", agent: "w", round: 1, result: "r",
			startedAt: 3, endedAt: 4,
		});

		// 第二条被吞（dedup key=sa-dup:1 命中）
		expect(host.sendMessageCalls).toHaveLength(1);
	});

	it("非 chatMode（round undefined → key=id:0）行为同旧（向后兼容，60s 内同 id 吞）", () => {
		// round undefined → dedup key="sa-once:0"，与旧 record.id 单 key 行为一致
		notifier.notify({
			id: "sa-once", status: "closed", agent: "w", result: "done",
			startedAt: 1, endedAt: 2,
		});
		notifier.notify({
			id: "sa-once", status: "closed", agent: "w", result: "done",
			startedAt: 3, endedAt: 4,
		});

		// 第二条被吞（旧 dedup 行为不变，一次性模式回归）
		expect(host.sendMessageCalls).toHaveLength(1);
	});
});

describe("BgNotifier buildLlmContent 指针行（wave2：chatMode sessionFile 透传）", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;

	beforeEach(() => {
		host = makeMockHost();
		// hasRunningBackground=false → notify 立即 flush，sendMessageCalls 恰 1 条
		notifier = createNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
	});

	/** 取唯一一条已发消息的 content（前置断言恰 1 条）。 */
	function sentContent(): string {
		expect(host.sendMessageCalls).toHaveLength(1);
		return (host.sendMessageCalls[0]!.message as { content: string }).content;
	}

	it("running（轮次通知）+ sessionFile → 末尾追加 \\n\\n 空行分隔的指针行", () => {
		notifier.notify({
			id: "sa-ptr-1", status: "running", agent: "w", round: 1, result: "round1 text",
			sessionFile: "/tmp/sessions/child-1.jsonl",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe(
			'Subagent "w" (sa-ptr-1) finished a round. Reply:\nround1 text' +
			"\n\nFull transcript: /tmp/sessions/child-1.jsonl",
		);
	});

	it("closed 成功文案 + sessionFile → 指针行追加在最终串末尾", () => {
		notifier.notify({
			id: "sa-ptr-2", status: "closed", agent: "w", result: "final result",
			sessionFile: "/tmp/sessions/child-2.jsonl",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe(
			'Subagent "w" (sa-ptr-2) completed. Result:\nfinal result' +
			"\n\nFull transcript: /tmp/sessions/child-2.jsonl",
		);
	});

	it("closed + patchFile + sessionFile → 指针行追加在 patch 提示串末尾（最终串）", () => {
		notifier.notify({
			id: "sa-ptr-3", status: "closed", agent: "w", result: "did work",
			patchFile: "/tmp/patches/sa-ptr-3.patch",
			sessionFile: "/tmp/sessions/child-3.jsonl",
			startedAt: 1, endedAt: 2,
		});

		const content = sentContent();
		expect(content).toContain("git apply /tmp/patches/sa-ptr-3.patch");
		expect(content.endsWith("\n\nFull transcript: /tmp/sessions/child-3.jsonl")).toBe(true);
	});

	it("sessionFile 缺失 → 省略整行（running 通知正文与无指针形态逐字节一致）", () => {
		notifier.notify({
			id: "sa-ptr-4", status: "running", agent: "w", round: 2, result: "round2 text",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe('Subagent "w" (sa-ptr-4) finished a round. Reply:\nround2 text');
	});

	it("cancelled → 不追加指针行（即使 sessionFile 有值）", () => {
		notifier.notify({
			id: "sa-ptr-5", status: "closed", closedReason: "cancelled", agent: "w",
			sessionFile: "/tmp/sessions/child-5.jsonl",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe('Subagent "w" (sa-ptr-5) cancelled.');
	});

	it("gc-failed（closed + closedReason=gc + error 有值）→ 不追加指针行", () => {
		notifier.notify({
			id: "sa-ptr-6", status: "closed", closedReason: "gc", agent: "w",
			error: "spawn EPIPE",
			sessionFile: "/tmp/sessions/child-6.jsonl",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe('Subagent "w" (sa-ptr-6) failed: spawn EPIPE');
	});

	it("[review 修复] gc-failed + patchFile 并存 → failed 文案优先（失败轮也会写 patchFile，patch 提示不可达）", () => {
		// 回归锚定：doFinalizeRecord Step 0 对 worktreeHandle 无条件 collectPatch，gc 失败 +
		// worktree 并存时 patchFile 有值。[U3] 判定收口到单一 deriveOutcome（cancelled →
		// failed → patch/result），否则 LLM 被告知 completed 掩盖失败。
		notifier.notify({
			id: "sa-ptr-8", status: "closed", closedReason: "gc", agent: "w",
			error: "spawn EPIPE",
			patchFile: "/tmp/patches/sa-ptr-8.patch",
			sessionFile: "/tmp/sessions/child-8.jsonl",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe('Subagent "w" (sa-ptr-8) failed: spawn EPIPE');
	});

	it("[U3][D6 显式取舍] parent-shutdown 合成关闭 + patchFile 并存 → failed 文案优先（patch 提示不可达）", () => {
		// disposeAllRecords 合成 result 恒写 error:"closed due to ..." → outcome='failed'；
		// worktree 失败并存时仍不得展示 patch 提示（「failed 优先于 patchFile 提示」保真）。
		notifier.notify({
			id: "sa-u3-ps", status: "closed", closedReason: "parent-shutdown", agent: "w",
			error: "closed due to parent-shutdown",
			patchFile: "/tmp/patches/sa-u3-ps.patch",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe('Subagent "w" (sa-u3-ps) failed: closed due to parent-shutdown');
	});

	it("[U3] details payload 物化 outcome：closed 入参缺省时按 deriveOutcome 兑底填充", () => {
		notifier.notify({
			id: "sa-u3-mat", status: "closed", closedReason: "gc", agent: "w",
			error: "boom",
			startedAt: 1, endedAt: 2,
		});

		expect(host.sendMessageCalls).toHaveLength(1);
		const msg = host.sendMessageCalls[0]!.message as { details?: { outcome?: string } };
		expect(msg.details?.outcome).toBe("failed");
	});

	it("[U3] 显式 outcome 优先于 closedReason 兑底（一等字段直读）", () => {
		notifier.notify({
			id: "sa-u3-explicit", status: "closed", closedReason: "gc", agent: "w",
			outcome: "cancelled",
			startedAt: 1, endedAt: 2,
		});

		expect(sentContent()).toBe('Subagent "w" (sa-u3-explicit) cancelled.');
	});

	it("[U3] running（轮次通知）不物化 outcome（终态语义不适用活跃态）", () => {
		notifier.notify({
			id: "sa-u3-round", status: "running", agent: "w", round: 1, result: "r1",
			startedAt: 1, endedAt: 2,
		});

		expect(host.sendMessageCalls).toHaveLength(1);
		const msg = host.sendMessageCalls[0]!.message as { details?: { outcome?: string } };
		expect(msg.details?.outcome).toBeUndefined();
	});

	it("one-shot（sessionFile 未透传 → undefined）→ closed 通知与改造前逐字节一致（基线常量锚定）", () => {
		notifier.notify({
			id: "sa-ptr-7", status: "closed", agent: "worker", result: "done",
			startedAt: 1, endedAt: 2,
		});

		// 改造前形态：sessionFile undefined 时指针为空串，追加不改变输出——逐字节锁定
		expect(sentContent()).toBe('Subagent "worker" (sa-ptr-7) completed. Result:\ndone');
	});

	it("[C-2] closed + totalRounds（chatMode close 终态通知）→ 文案附轮次统计 after N rounds", () => {
		notifier.notify({
			id: "sa-rounds-1", status: "closed", agent: "w", totalRounds: 3, result: "",
			sessionFile: "/tmp/sessions/child-rounds.jsonl",
			startedAt: 1, endedAt: 2,
		});

		// 设计 D2 路径①：closed 分支文案附轮次统计 + sessionFile 提示；
		// 路径②正文空串（idle close）形态也走本分支（result 空串非 nullish，不触发 (empty)）
		expect(sentContent()).toBe(
			'Subagent "w" (sa-rounds-1) completed after 3 rounds. Result:\n' +
			"\n\nFull transcript: /tmp/sessions/child-rounds.jsonl",
		);
	});

	it("[C-2] 对照：totalRounds 缺失（one-shot 完成通知）→ 无轮次统计，文案逐字节保持 completed. Result:", () => {
		notifier.notify({
			id: "sa-rounds-2", status: "closed", agent: "w", result: "done",
			sessionFile: "/tmp/sessions/child-oneshot.jsonl",
			startedAt: 1, endedAt: 2,
		});

		// one-shot record 无轮次语义（totalRounds 不设置）——G4：文案不含统计
		expect(sentContent()).toBe(
			'Subagent "w" (sa-rounds-2) completed. Result:\ndone' +
			"\n\nFull transcript: /tmp/sessions/child-oneshot.jsonl",
		);
	});
});

describe("BgNotifier — subscribeSettled 装配（must-fix #4 / D8 settled 边沿驱动）", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;
	/** 内核经 port.subscribeSettled 注册的 settled 边沿回调（测试手动触发模拟 pi 事件）。 */
	let settledEdges: Array<() => void>;

	beforeEach(() => {
		vi.useFakeTimers();
		host = makeMockHost();
		settledEdges = [];
		// host 注入原生订阅能力；notifier port 内部用 disposed 标志包装（D8 适配）
		host.onAgentSettled = (handler) => {
			settledEdges.push(handler);
		};
		notifier = createNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
		vi.useRealTimers();
	});

	it("busy 入队 → settled 事件触发 → flush 送达（不依赖退避轮询）", () => {
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-settled-1",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		// busy 入队：内核装配了 subscribeSettled → settled 边沿驱动，注册过订阅
		expect(host.sendMessageCalls).toHaveLength(0);
		expect(settledEdges.length).toBeGreaterThanOrEqual(1);

		// 有订阅装配下内核不走退避强发——推进远超退避上限（50 × 100ms）仍不发送
		vi.advanceTimersByTime(10_000);
		expect(host.sendMessageCalls).toHaveLength(0);

		// settled 边沿（isIdle 已先于事件复位，agent-session.js:327-336）→ flush 送达
		host.isIdle.mockReturnValue(true);
		settledEdges[0]!();

		expect(host.sendMessageCalls).toHaveLength(1);
		expect(host.sendMessageCalls[0]!.options).toEqual({ triggerTurn: true });
	});

	it("dispose 后 settled 边沿不再触发发送（内核 disposed 拦截）", () => {
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-settled-2",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});
		notifier.dispose();

		host.isIdle.mockReturnValue(true);
		settledEdges[0]!();

		expect(host.sendMessageCalls).toHaveLength(0);
	});
});

describe("BgNotifier — revive 重建内核 handle（must-fix #5）", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;

	beforeEach(() => {
		host = makeMockHost();
		notifier = createNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
	});

	it("dispose → notify 静默丢弃 → revive → notify 恢复送达", () => {
		notifier.notify({
			id: "bg-revive-1",
			status: "closed",
			agent: "worker",
			result: "ok",
			startedAt: 1,
			endedAt: 2,
		});
		expect(host.sendMessageCalls).toHaveLength(1);

		// session_shutdown：dispose（内核 handle 销毁，disposed 不可逆）
		notifier.dispose();

		// dispose 窗口内的 notify：外层 disposed 短路，静默丢弃（旧有语义）
		notifier.notify({
			id: "bg-revive-2",
			status: "closed",
			agent: "worker",
			result: "dropped",
			startedAt: 3,
			endedAt: 4,
		});
		expect(host.sendMessageCalls).toHaveLength(1);

		// /resume /fork /new 后的 revive：必须重建内核 handle——旧实现仅复位外层标志，
		// 内核已 dispose，此后所有 notify 被内核静默吞（通知永久丢失）
		notifier.revive();
		notifier.notify({
			id: "bg-revive-3",
			status: "closed",
			agent: "worker",
			result: "alive again",
			startedAt: 5,
			endedAt: 6,
		});

		expect(host.sendMessageCalls).toHaveLength(2);
		const msg = host.sendMessageCalls[1]!.message as { content: string };
		expect(msg.content).toContain("bg-revive-3");
	});

	it("revive 后同 id 重复通知不被旧生命周期的 dedup LRU 吞（新 handle 状态复位）", () => {
		notifier.notify({ id: "bg-revive-dup", status: "closed", agent: "w", result: "r1", startedAt: 1, endedAt: 2 });
		notifier.dispose();
		notifier.revive();
		// 同 id 第二次：旧 handle 的 dedup LRU 已随 dispose 清空 + 重建，不被吞
		notifier.notify({ id: "bg-revive-dup", status: "closed", agent: "w", result: "r2", startedAt: 3, endedAt: 4 });
		expect(host.sendMessageCalls).toHaveLength(2);
	});
});

describe("U3_UNIT: createNotifier unit verification", () => {
	it("createNotifier returns object with notify/flush/dispose/revive", () => {
		const host = makeMockHost();
		const notifier = createNotifier(host);
		expect(typeof notifier.notify).toBe("function");
		expect(typeof notifier.flushPendingNotifications).toBe("function");
		expect(typeof notifier.dispose).toBe("function");
		expect(typeof notifier.revive).toBe("function");
		notifier.dispose();
	});

	it("notify calls host.sendMessage with customType=subagent-bg-notify", () => {
		const host = makeMockHost();
		const notifier = createNotifier(host);
		notifier.notify({
			id: "u3-test-1", status: "closed", agent: "worker", result: "ok",
			startedAt: 1, endedAt: 2,
		});
		expect(host.sendMessageCalls).toHaveLength(1);
		const msg = host.sendMessageCalls[0]!.message as { customType: string };
		expect(msg.customType).toBe("subagent-bg-notify");
		notifier.dispose();
	});

	it("notify with mergeHoldActive=true defers flush until explicit call", () => {
		const sendMessageCalls: unknown[] = [];
		const host: NotifierHost = {
			sendMessage: (msg) => { sendMessageCalls.push(msg); },
			hasRunningBackground: () => true,
			isIdle: () => true,
		};
		const notifier = createNotifier(host);
		notifier.notify({
			id: "u3-merge-1", status: "closed", agent: "w", result: "r1",
			startedAt: 1, endedAt: 2,
		});
		notifier.notify({
			id: "u3-merge-2", status: "closed", agent: "w", result: "r2",
			startedAt: 3, endedAt: 4,
		});
		// mergeHoldActive=true → messages queued, not sent yet
		expect(sendMessageCalls).toHaveLength(0);
		notifier.flushPendingNotifications();
		expect(sendMessageCalls).toHaveLength(1);
		const content = (sendMessageCalls[0] as { content: string }).content;
		expect(content).toContain("\n\n---\n\n");
		notifier.dispose();
	});
});

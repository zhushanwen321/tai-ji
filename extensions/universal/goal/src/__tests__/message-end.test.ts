/**
 * message_end handler 测试（D13① role 过滤 + FR-6.7 ESC 守卫）。
 *
 * 断言面：仅 user/assistant 的 message_end 进入 service 消费；system（pi 1.0
 * 新形态）/ toolResult / 缺 role 在 handler 层显式拒绝；assistant 正常透传。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMessageEnd } from "../adapters/event-handlers/message-end";
import { createGoalState } from "../engine/goal";
import { applyEvent } from "../service";
import { createGoalSession } from "../session";

vi.mock("../service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../service")>();
	return { ...actual, applyEvent: vi.fn(actual.applyEvent) };
});

function makeSession(): ReturnType<typeof createGoalSession> {
	const session = createGoalSession();
	session.state = createGoalState("obj");
	return session;
}

beforeEach(() => {
	vi.mocked(applyEvent).mockClear();
});

function ctx(signalAborted = false): Parameters<typeof handleMessageEnd>[1] {
	return { signal: { aborted: signalAborted } } as unknown as Parameters<typeof handleMessageEnd>[1];
}

function messageEndEvent(role: unknown): Parameters<typeof handleMessageEnd>[2] {
	return { type: "message_end", message: { role } } as unknown as Parameters<typeof handleMessageEnd>[2];
}

describe("handleMessageEnd（D13① role 过滤）", () => {
	it("assistant：透传 applyEvent（token 累加路径不受过滤影响）", async () => {
		const session = makeSession();
		const event = {
			type: "message_end",
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 20 } },
		} as unknown as Parameters<typeof handleMessageEnd>[2];
		await handleMessageEnd(session, ctx(), event);

		// 加权口径同 service.test.ts：100×1 + 20×0.02 + 50×2 = 200.4
		expect(session.state?.tokensUsed).toBe(200.4);
	});

	it("user：进入消费路径（applyEvent 被调；token 累加由 service 层 assistant-only 收窄）", async () => {
		const session = makeSession();
		const spy = vi.mocked(applyEvent);
		await handleMessageEnd(session, ctx(), messageEndEvent("user"));

		expect(spy).toHaveBeenCalledWith(session, "message_end", messageEndEvent("user"));
	});

	it("system（pi 1.0 新形态）：handler 层拒绝，不进 applyEvent", async () => {
		const session = makeSession();
		const spy = vi.mocked(applyEvent);
		await handleMessageEnd(session, ctx(), messageEndEvent("system"));

		expect(spy).not.toHaveBeenCalled();
	});

	it("toolResult / 缺 role：同样拒绝", async () => {
		const session = makeSession();
		const spy = vi.mocked(applyEvent);
		await handleMessageEnd(session, ctx(), messageEndEvent("toolResult"));
		await handleMessageEnd(session, ctx(), {} as Parameters<typeof handleMessageEnd>[2]);

		expect(spy).not.toHaveBeenCalled();
	});

	it("ESC 守卫先于 role 过滤（aborted 直接返回）", async () => {
		const session = makeSession();
		const spy = vi.mocked(applyEvent);
		await handleMessageEnd(session, ctx(true), messageEndEvent("assistant"));

		expect(spy).not.toHaveBeenCalled();
	});
});

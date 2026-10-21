// OAuth 回调监听生命周期测试（真实 socket，不 mock）：
// 发起/取消/回收无残留——监听 socket 关闭、端口释放（同端口可重绑）、无遗留等待。
// 生命周期纪律：仅授权期存活，完成/取消/失败/abort 即回收（全事件驱动，零定时器）。

import { createServer as createNetServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startWoolAuthCallbackServer } from "../callback-server.ts";

/** 端口释放断言：同端口重新 listen 成功（监听已回收的直接证据）。 */
async function assertPortReleased(port: number): Promise<void> {
	const probeServer = createNetServer();
	await new Promise<void>((resolve, reject) => {
		probeServer.once("error", reject);
		probeServer.listen(port, "127.0.0.1", () => {
			probeServer.off("error", reject);
			resolve();
		});
	});
	await new Promise<void>((resolve) => probeServer.close(() => resolve()));
}

/** 对回调端点发一次真实 HTTP GET（真 socket 通道）。 */
async function get(url: string): Promise<{ status: number; body: string }> {
	const response = await fetch(url, { redirect: "manual" });
	return { status: response.status, body: await response.text() };
}

function serverPort(callbackUrl: string): number {
	return Number(new URL(callbackUrl).port);
}

/** 每个用例收尾兜底引用（防用例中途失败泄漏监听）。 */
const pendingServers: Array<{ close(): void }> = [];

afterEach(() => {
	for (const server of pendingServers.splice(0)) {
		server.close();
	}
});

const NEVER_DONE = async (): Promise<{ completed: boolean; pageMessage: string }> => ({
	completed: false,
	pageMessage: "waiting",
});

describe("回调监听生命周期（发起/取消/回收无残留）", () => {
	it("发起：callbackUrl 绑定 127.0.0.1 系统分配端口且可真实访问", async () => {
		const server = await startWoolAuthCallbackServer({ state: "s1", onDone: NEVER_DONE });
		pendingServers.push(server);
		const url = new URL(server.callbackUrl);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.pathname).toBe("/wool-auth/callback");
		expect(url.port).not.toBe("0");
		// state 不匹配 → 400（服务真实在听）
		const response = await get(`${server.callbackUrl}?state=wrong&status=done`);
		expect(response.status).toBe(400);
		server.close();
		await server.wait();
		await assertPortReleased(serverPort(server.callbackUrl));
	});

	it("done 信号完成：onDone completed → wait(done) + 端口释放", async () => {
		let attempts = 0;
		const server = await startWoolAuthCallbackServer({
			state: "s1",
			onDone: async () => {
				attempts += 1;
				return { completed: true, pageMessage: "done" };
			},
		});
		pendingServers.push(server);
		const response = await get(`${server.callbackUrl}?state=s1&status=done`);
		expect(response.status).toBe(200);
		const outcome = await server.wait();
		expect(outcome).toEqual({ type: "done" });
		expect(attempts).toBe(1);
		await assertPortReleased(serverPort(server.callbackUrl));
	});

	it("pending 重试：completed=false → 202，再次 done completed=true → 完成（事件驱动无轮询）", async () => {
		let attempts = 0;
		const server = await startWoolAuthCallbackServer({
			state: "s1",
			onDone: async () => {
				attempts += 1;
				return attempts === 1
					? { completed: false, pageMessage: "not yet" }
					: { completed: true, pageMessage: "done" };
			},
		});
		pendingServers.push(server);
		const first = await get(`${server.callbackUrl}?state=s1&status=done`);
		expect(first.status).toBe(202); // 未完成不终态
		const second = await get(`${server.callbackUrl}?state=s1&status=done`);
		expect(second.status).toBe(200);
		const outcome = await server.wait();
		expect(outcome.type).toBe("done");
		expect(attempts).toBe(2);
		await assertPortReleased(serverPort(server.callbackUrl));
	});

	it("浮层 cancel 信号 → wait(cancelled) + 端口释放", async () => {
		const server = await startWoolAuthCallbackServer({ state: "s1", onDone: NEVER_DONE });
		pendingServers.push(server);
		const response = await get(`${server.callbackUrl}?state=s1&status=cancel`);
		expect(response.status).toBe(200);
		const outcome = await server.wait();
		expect(outcome.type).toBe("cancelled");
		await assertPortReleased(serverPort(server.callbackUrl));
	});

	it("外部 cancel() → wait(cancelled) + 端口释放", async () => {
		const server = await startWoolAuthCallbackServer({ state: "s1", onDone: NEVER_DONE });
		pendingServers.push(server);
		const port = serverPort(server.callbackUrl);
		server.cancel("user closed overlay");
		const outcome = await server.wait();
		expect(outcome).toEqual({ type: "cancelled", reason: "user closed overlay" });
		await assertPortReleased(port);
	});

	it("abort signal → wait(cancelled) + 端口释放", async () => {
		const controller = new AbortController();
		const server = await startWoolAuthCallbackServer({ state: "s1", onDone: NEVER_DONE, signal: controller.signal });
		pendingServers.push(server);
		const port = serverPort(server.callbackUrl);
		controller.abort();
		const outcome = await server.wait();
		expect(outcome.type).toBe("cancelled");
		await assertPortReleased(port);
	});

	it("onDone throw → 502 + cancelled 终态 + 端口释放", async () => {
		const server = await startWoolAuthCallbackServer({
			state: "s1",
			onDone: async () => {
				throw new Error("token endpoint down");
			},
		});
		pendingServers.push(server);
		const response = await get(`${server.callbackUrl}?state=s1&status=done`);
		expect(response.status).toBe(502);
		const outcome = await server.wait();
		expect(outcome.type).toBe("cancelled");
		await assertPortReleased(serverPort(server.callbackUrl));
	});

	it("完成后再次请求 → 连接拒绝或 409（窗口已关闭）且不再回调 onDone", async () => {
		let attempts = 0;
		const server = await startWoolAuthCallbackServer({
			state: "s1",
			onDone: async () => {
				attempts += 1;
				return { completed: true, pageMessage: "done" };
			},
		});
		pendingServers.push(server);
		await get(`${server.callbackUrl}?state=s1&status=done`);
		await server.wait();
		// close() 后监听已回收：连接拒绝（ECONNREFUSED）是常态；偶发 accept 竞态则为 409。
		const after = await get(`${server.callbackUrl}?state=s1&status=done`).then(
			(response) => response.status,
			() => -1,
		);
		expect(after === -1 || after === 409).toBe(true);
		expect(attempts).toBe(1);
	});

	it("已 aborted 的 signal → 发起即拒（AbortError）", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			startWoolAuthCallbackServer({ state: "s1", onDone: NEVER_DONE, signal: controller.signal }),
		).rejects.toThrow();
	});
});

describe("socket 句柄纪律", () => {
	it("终态后无活跃连接句柄（server.close 完成即无 listening socket）", async () => {
		const server = await startWoolAuthCallbackServer({ state: "s1", onDone: NEVER_DONE });
		pendingServers.push(server);
		// 建立一条客户端连接后终态（模拟授权页保持连接时被取消）
		const held = await fetch(server.callbackUrl, { headers: { connection: "keep-alive" } }).catch(() => undefined);
		void held;
		const port = serverPort(server.callbackUrl);
		server.cancel();
		await server.wait();
		// close() 只在所有连接断开后完成；等待后端口必然可重绑
		await assertPortReleased(port);
	});
});

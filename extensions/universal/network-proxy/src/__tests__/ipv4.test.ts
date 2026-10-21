/**
 * createIpv4Lookup 单测：DNS 解析族强制（锁 v4，非偏好）、回调双形态、options 透传、
 * 错误上抛不回退 IPv6。用 fake dns.lookup 注入（不碰真实解析器；fake 按 dns.lookup 真实
 * 语义回调——all:true 给地址数组，all:false 给首个地址字符串）。
 *
 * lookup 是纯地址族选择层——URL / Host / TLS 不在本层（connect.lookup 方案的设计边界，
 * 见 ipv4.ts 头注），端到端行为由 fetch-wrapper.test.ts（分流）与 ipv4-live.test.ts
 * （真机）覆盖。
 */

import dns from "node:dns";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createIpv4Lookup } from "../ipv4.js";

/** fake dns.lookup 收到的调用参数（host, options）。 */
const resolverCalls: Array<{ host: string; opts: Record<string, unknown> }> = [];

/**
 * 注入 fake 解析器：记录调用参数，按 dns.lookup 真实回调语义回应
 * （all:true → (null, addrs[])；all:false → (null, 首地址, family)；err 非空 → (err, "", 4)）。
 */
function mockResolver(
	respond: (host: string, opts: Record<string, unknown>) => {
		err?: NodeJS.ErrnoException;
		addrs: dns.LookupAddress[];
	},
): void {
	vi.spyOn(dns, "lookup").mockImplementation(((
		host: string,
		opts: unknown,
		cb: unknown,
	) => {
		const options = (opts ?? {}) as Record<string, unknown>;
		resolverCalls.push({ host, opts: options });
		const callback = cb as (
			e: NodeJS.ErrnoException | null,
			a: string | dns.LookupAddress[],
			f?: number,
		) => void;
		const { err, addrs } = respond(host, options);
		if (err !== undefined) {
			callback(err, "", 4);
			return;
		}
		if (options.all === true) {
			callback(null, addrs);
			return;
		}
		const first = addrs[0];
		callback(null, first?.address ?? "", first?.family ?? 4);
	}) as unknown as typeof dns.lookup);
}

afterEach(() => {
	vi.restoreAllMocks();
	resolverCalls.length = 0;
});

describe("createIpv4Lookup", () => {
	it("all:false 形态：回调 (err, address, family)，解析族强制为 4", async () => {
		mockResolver(() => ({ addrs: [{ address: "162.159.129.1", family: 4 }] }));
		const lookup = createIpv4Lookup();
		const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
			lookup("api.example.com", { all: false }, (err, address, family) => {
				if (err !== null || typeof address !== "string") {
					reject(err ?? new Error("expected single-address form"));
					return;
				}
				resolve({ address, family: family ?? 0 });
			});
		});
		expect(result.address).toBe("162.159.129.1");
		expect(result.family).toBe(4);
	});

	it("all:true 形态：回调 (err, addresses[])，条目 family 均为 4", async () => {
		mockResolver(() => ({
			addrs: [
				{ address: "162.159.129.1", family: 4 },
				{ address: "162.159.129.2", family: 4 },
			],
		}));
		const lookup = createIpv4Lookup();
		const addrs = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
			lookup("api.example.com", { all: true }, (err, address) => {
				if (err !== null || !Array.isArray(address)) {
					reject(err ?? new Error("expected all-addresses form"));
					return;
				}
				resolve(address);
			});
		});
		expect(addrs).toEqual([
			{ address: "162.159.129.1", family: 4 },
			{ address: "162.159.129.2", family: 4 },
		]);
	});

	it("调用方传 family:6 仍被覆写为 4（锁 v4 而非偏好 v4）", async () => {
		mockResolver(() => ({ addrs: [{ address: "10.0.0.1", family: 4 }] }));
		const lookup = createIpv4Lookup();
		await new Promise<void>((resolve, reject) => {
			lookup("forced.example.com", { family: 6 }, (err) => {
				if (err !== null) reject(err);
				else resolve();
			});
		});
		expect(resolverCalls[0]?.opts.family).toBe(4);
	});

	it("委托系统 dns.lookup（hostname 与其余 options 透传，保留 /etc/hosts 等语义）", async () => {
		mockResolver(() => ({ addrs: [{ address: "10.0.0.2", family: 4 }] }));
		const lookup = createIpv4Lookup();
		await new Promise<void>((resolve, reject) => {
			lookup("passthrough.example.com", { all: false, hints: 1, verbatim: true }, (err) => {
				if (err !== null) reject(err);
				else resolve();
			});
		});
		expect(resolverCalls[0]?.host).toBe("passthrough.example.com");
		expect(resolverCalls[0]?.opts.hints).toBe(1);
		expect(resolverCalls[0]?.opts.verbatim).toBe(true);
	});

	it("解析器报错：err 原样透传（不回退 IPv6）", async () => {
		mockResolver(() => {
			const err: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND no-a.example.com");
			err.code = "ENOTFOUND";
			return { err, addrs: [] };
		});
		const lookup = createIpv4Lookup();
		const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
			lookup("no-a.example.com", { all: false }, (e) => resolve(e));
		});
		expect(err?.code).toBe("ENOTFOUND");
	});
});

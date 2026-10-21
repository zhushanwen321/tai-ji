// 头族/指纹 fixture 对照测试：请求组装快照断言（常量表驱动的请求头/UA 组装）。
// 断言对象 = buildChatHeaders / buildBillingHeaders / buildRefreshHeaders 纯函数输出
// 与 fingerprint 形态（hub wb_identity 5.8.x 抓包对齐形态）。

import { describe, expect, it } from "vitest";

import { buildBillingHeaders, buildChatHeaders, buildRefreshHeaders } from "../headers.ts";
import {
	conversationIdFor,
	deriveDeviceId,
	machineIdFor,
	newRequestId,
	sessionIdFor,
	traceHeaders,
	uuid7,
} from "../fingerprint.ts";

const AUTH = { accessToken: "jwt-token", uid: "user-123", domain: undefined };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** RFC 9562 UUIDv7 形状（时间戳版本位 7）。 */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;

describe("chat 头族（桌面端身份，CN realm）", () => {
	it("身份头族常量逐项对照（版本/UA/X-Agent 族/X-IDE 族）", () => {
		const headers = buildChatHeaders("cn", AUTH, { conversationKey: "s1", model: "hy3" });
		expect(headers["X-IDE-Name"]).toBe("WorkBuddy");
		expect(headers["X-IDE-Type"]).toBe("WorkBuddy");
		expect(headers["X-IDE-Version"]).toBe("5.8.3");
		expect(headers["User-Agent"]).toBe("WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0");
		expect(headers["X-Agent-Intent"]).toBe("craft");
		expect(headers["X-Agent-Purpose"]).toBe("conversation");
		expect(headers["X-Agent-Type"]).toBe("main");
		expect(headers["X-Private-Data"]).toBe("true");
		expect(headers["X-Product"]).toBe("SaaS");
		expect(headers["X-Domain"]).toBe("copilot.tencent.com");
		expect(headers["X-User-Id"]).toBe("user-123");
		expect(headers.Authorization).toBe("Bearer jwt-token");
		expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
		expect(headers["Accept-Language"]).toBe("zh-CN");
		expect(headers.Origin).toBe("https://www.codebuddy.cn");
		expect(headers.Referer).toBe("https://www.codebuddy.cn/");
		expect(headers["X-CodeBuddy-Request"]).toBe("1");
	});

	it("会话头族形态：Conversation-ID 带连字符；Request-ID=Root-Request-ID 与 Message-ID=Request-ID 各自同值", () => {
		const headers = buildChatHeaders("cn", AUTH, { conversationKey: "s1", model: "hy3" });
		expect(headers["X-Conversation-ID"]).toMatch(UUID_RE);
		expect(headers["X-Conversation-Request-ID"]).toMatch(HEX32_RE);
		expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
		expect(headers["X-Conversation-Message-ID"]).toMatch(HEX32_RE);
		expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Message-ID"]);
		// 消息 id 与会话请求 id 不同值（每请求新生成 vs 一轮复用）
		expect(headers["X-Request-ID"]).not.toBe(headers["X-Conversation-Request-ID"]);
	});

	it("同一会话键复用 X-Conversation-ID；换会话键换新值", () => {
		const first = buildChatHeaders("cn", AUTH, { conversationKey: "s1", model: "hy3" });
		const second = buildChatHeaders("cn", AUTH, { conversationKey: "s1", model: "hy3" });
		const other = buildChatHeaders("cn", AUTH, { conversationKey: "s2", model: "hy3" });
		expect(second["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
		expect(other["X-Conversation-ID"]).not.toBe(first["X-Conversation-ID"]);
	});

	it("链路头族：traceparent/b3/X-B3-* 同源 trace 与 span", () => {
		const headers = buildChatHeaders("cn", AUTH, { conversationKey: "s1", model: "hy3" });
		const trace = headers["X-Trace-ID"];
		const span = headers["X-B3-SpanId"];
		expect(trace).toMatch(HEX32_RE);
		expect(span).toMatch(/^[0-9a-f]{16}$/);
		expect(headers.traceparent).toBe(`00-${trace}-${span}-01`);
		expect(headers.b3).toBe(`${trace}-${span}-1`);
		expect(headers["X-B3-TraceId"]).toBe(trace);
		expect(headers["X-B3-Sampled"]).toBe("1");
		expect("X-B3-ParentSpanId" in headers).toBe(false); // 桌面端无父 span
	});

	it("intl realm：版本 5.8.4 + 双段 UA + domain 切换", () => {
		const headers = buildChatHeaders("intl", { ...AUTH, domain: "www.workbuddy.ai" }, { conversationKey: "s1", model: "hy3" });
		expect(headers["X-IDE-Version"]).toBe("5.8.4");
		expect(headers["User-Agent"]).toBe("WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0");
		expect(headers["X-Domain"]).toBe("www.workbuddy.ai");
		expect(headers["Accept-Language"]).toBe("en-US");
	});
});

describe("billing 头族（签到/额度/OAuth 共用）", () => {
	it("字段族对照 + 按账号派生 machineId/sessionId", () => {
		const headers = buildBillingHeaders("cn", AUTH);
		expect(headers["User-Agent"]).toBe("WorkBuddy/5.8.3");
		expect(headers["X-CodeBuddy-Request"]).toBe("1");
		expect(headers["X-No-Enterprise-Id"]).toBe("1");
		expect(headers["X-Product"]).toBe("SaaS"); // CN 限定
		expect(headers["X-Machine-ID"]).toBe(machineIdFor("user-123"));
		expect(headers["X-Session-ID"]).toBe(sessionIdFor("user-123"));
		expect(headers["X-Request-ID"]).toMatch(HEX32_RE);
	});

	it("intl billing：无 X-Product、Accept-Language en-US", () => {
		const headers = buildBillingHeaders("intl", AUTH);
		expect("X-Product" in headers).toBe(false);
		expect(headers["Accept-Language"]).toBe("en-US");
	});

	it("每请求 X-Request-ID 新生成", () => {
		const first = buildBillingHeaders("cn", AUTH);
		const second = buildBillingHeaders("cn", AUTH);
		expect(first["X-Request-ID"]).not.toBe(second["X-Request-ID"]);
	});
});

describe("刷新头族", () => {
	it("X-Refresh-Token 族对照（CN source=workbuddy）", () => {
		const headers = buildRefreshHeaders("cn", AUTH, "refresh-token-1");
		expect(headers["X-Refresh-Token"]).toBe("refresh-token-1");
		expect(headers["X-Auth-Refresh-Source"]).toBe("workbuddy");
		expect(headers["X-User-Id"]).toBe("user-123");
		expect(headers["X-CodeBuddy-Request"]).toBe("1");
	});

	it("intl source=plugin", () => {
		expect(buildRefreshHeaders("intl", AUTH, "r")["X-Auth-Refresh-Source"]).toBe("plugin");
	});
});

describe("指纹形态", () => {
	it("uuid7 带连字符（v7 版本位）；newRequestId 32 位无连字符 hex", () => {
		expect(uuid7()).toMatch(UUID_V7_RE);
		expect(newRequestId()).toMatch(HEX32_RE);
	});

	it("deriveDeviceId 按 uid+salt 稳定派生、账号间互不相同", () => {
		expect(deriveDeviceId("u1", "machine")).toBe(deriveDeviceId("u1", "machine"));
		expect(deriveDeviceId("u1", "machine")).toMatch(UUID_RE);
		expect(deriveDeviceId("u2", "machine")).not.toBe(deriveDeviceId("u1", "machine"));
		expect(machineIdFor("u1")).not.toBe(sessionIdFor("u1")); // salt 域分离
	});

	it("conversationIdFor 会话键派生稳定", () => {
		expect(conversationIdFor("u1", "s1")).toBe(conversationIdFor("u1", "s1"));
		expect(conversationIdFor("u1", "s1")).not.toBe(conversationIdFor("u1", "s2"));
		expect(conversationIdFor("u1", "s1")).not.toBe(conversationIdFor("u2", "s1"));
	});

	it("traceHeaders 六头族齐全", () => {
		const headers = traceHeaders();
		for (const key of ["X-Trace-ID", "traceparent", "b3", "X-B3-TraceId", "X-B3-SpanId", "X-B3-Sampled"]) {
			expect(headers[key]).toBeDefined();
		}
	});
});

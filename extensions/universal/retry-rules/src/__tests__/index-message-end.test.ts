/**
 * message_end 钩子行为测试（rewriteMessageForRetry 纯函数壳 + entry 装配形态 + 配置降级告警）。
 *
 * 覆盖：非 assistant / 非 error 停因不动（观察契约：只覆盖「以 assistant 消息
 * stopReason=error 形态浮出」的错误，探针报告 §5 覆盖边界）、空 errorMessage 不动、
 * 命中规则改写（追加标记、原文保留）、未命中不改写、配置热重载读取（每轮判定直读，
 * 文件变更下一轮生效）、default export 的 pi.on 装配（注册事件名 / handler 收
 * event.message / 返回值透传，C-ext-05 契约测试）、非法配置回落空规则集并经
 * extension logger 告警（mtime+size 缓存去重，同一损坏文件版本只告警一次）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import retryRulesExtension, { rewriteMessageForRetry } from "../index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "retry-rules-hook-"));

beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	clearConfigCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	clearConfigCache();
});

/** 写 ext-config（effectiveRules 单条 pattern 规则）。 */
function writeConfig(effectiveRules: unknown[]): void {
	mkdirSync(join(agentDir, "config"), { recursive: true });
	writeFileSync(
		join(agentDir, "config", "retry-rules-ext-config.json"),
		JSON.stringify({ version: 1, customRules: [], effectiveRules }, null, 2),
		"utf-8",
	);
}

const RPM_RULE = {
	id: "rpm",
	name: "RPM 限流",
	verdict: "retryable",
	match: [{ kind: "pattern", pattern: "rpm limit exceeded" }],
	class: "provider",
	source: "builtin",
};

const ERROR_MESSAGE = {
	role: "assistant",
	stopReason: "error",
	errorMessage: "membership rpm limit exceeded: 101/100 resets 2026-10-23T12:00:00.000Z",
};

describe("rewriteMessageForRetry（message_end 钩子判定壳）", () => {
	it("stopReason=error 且规则命中 → 返回改写消息（追加标记、原文保留、role 不变）", () => {
		writeConfig([RPM_RULE]);
		const result = rewriteMessageForRetry(ERROR_MESSAGE);
		expect(result).toBeDefined();
		expect(result?.message.role).toBe("assistant");
		expect(result?.message.stopReason).toBe("error");
		expect(result?.message.errorMessage?.startsWith(ERROR_MESSAGE.errorMessage)).toBe(true);
		expect(result?.message.errorMessage).toContain("[taiji-retry:");
	});

	it("无规则命中 → undefined（不改写，pi 原生词表兜底）", () => {
		writeConfig([]);
		expect(rewriteMessageForRetry(ERROR_MESSAGE)).toBeUndefined();
	});

	it("非 assistant / 非 error 停因 / 无 errorMessage → undefined（探针 §5 覆盖边界）", () => {
		writeConfig([RPM_RULE]);
		expect(rewriteMessageForRetry({ role: "user", errorMessage: "rpm limit exceeded" })).toBeUndefined();
		expect(rewriteMessageForRetry({ role: "assistant", stopReason: "stop", errorMessage: "rpm limit exceeded" })).toBeUndefined();
		expect(rewriteMessageForRetry({ role: "assistant", stopReason: "error" })).toBeUndefined();
		expect(rewriteMessageForRetry({ role: "assistant", stopReason: "error", errorMessage: "" })).toBeUndefined();
	});

	it("配置热重载：文件变更后下一轮判定即生效（mtime+size 读时刷新，无进程重启）", () => {
		writeConfig([]);
		expect(rewriteMessageForRetry(ERROR_MESSAGE)).toBeUndefined();
		// 用户保存自定义规则 → runtime RMW 落盘 → 下一轮判定直读生效
		writeConfig([
			{
				id: "custom-a",
				name: "用户规则",
				verdict: "retryable",
				match: [{ kind: "pattern", pattern: "custom-provider-code-42" }],
				class: "provider",
				source: "custom",
			},
		]);
		const result = rewriteMessageForRetry({ role: "assistant", stopReason: "error", errorMessage: "boom: custom-provider-code-42" });
		expect(result?.message.errorMessage).toContain("[taiji-retry:");
	});

	it("停用回落前提（结构性断言）：配置 schema 无 enabled 独立开关——停用走 pi 原生 retry 配置（agent-session.js:787 停用门在 errorMessage 词表判定之前）", () => {
		writeConfig([RPM_RULE]);
		// 判定层在配置任意外形下均只认 verdict 字段：不存在任何「扩展侧停用开关」输入位；
		// pi 侧停用（enabled=false / maxRetries=0）时本扩展的改写结果不会进入重试循环——
		// 该上游门控行为的运行时断言归真机剧本（L3），本处锁扩展侧结构前提。
		expect(rewriteMessageForRetry(ERROR_MESSAGE)).toBeDefined();
	});
});

// ── entry 装配形态（C-ext-05 契约测试，形态对齐 delivery-port pi-host.test.ts mock pi 先例）──

type RegisteredEvent = { event: string; handler: (raw: unknown) => unknown };

/** fake pi：记录 on 注册（pi-host.test.ts makePi 同款形态）。 */
function makePi() {
	const registered: RegisteredEvent[] = [];
	const pi = {
		on: (event: string, handler: (raw: unknown) => unknown) => {
			registered.push({ event, handler });
			return () => {};
		},
	};
	return { pi, registered };
}

describe("retryRulesExtension entry 装配（pi.on 接线）", () => {
	it('注册事件名 = "message_end"；handler 收 event.message，命中改写原样透传（MessageEndEventResult.message）', () => {
		writeConfig([RPM_RULE]);
		const { pi, registered } = makePi();
		retryRulesExtension(pi as never);

		expect(registered.map((r) => r.event)).toEqual(["message_end"]);

		const event = { message: { ...ERROR_MESSAGE } };
		const result = registered[0].handler(event) as { message: { errorMessage: string } } | undefined;
		expect(result).toBeDefined();
		expect(result?.message.errorMessage).toContain("[taiji-retry:");
		// 透传不改事件入参对象（改写返回新消息，spread 守恒）
		expect(event.message.errorMessage).toBe(ERROR_MESSAGE.errorMessage);
	});

	it("不命中规则 → handler 返回 undefined（钩子无操作）", () => {
		writeConfig([]);
		const { pi, registered } = makePi();
		retryRulesExtension(pi as never);
		expect(registered[0].handler({ message: { ...ERROR_MESSAGE } })).toBeUndefined();
	});
});

// ── 配置降级告警（onWarning → extension logger，去重 = mtime+size 缓存）──

describe("非法配置降级告警（loadRetryRulesConfig onWarning 接线）", () => {
	it("坏 JSON → 回落空规则集不改写且告警一次；同文件重复判定去重；修正保存后恢复且不再告警", () => {
		mkdirSync(join(agentDir, "config"), { recursive: true });
		writeFileSync(join(agentDir, "config", "retry-rules-ext-config.json"), "{ not json", "utf-8");
		const logger = getLogger("retry-rules");
		const warnSpy = vi.spyOn(logger, "warn");

		// 首次判定：回落空规则集（无改写）+ 告警留痕（含配置文件路径与回落说明）
		expect(rewriteMessageForRetry(ERROR_MESSAGE)).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warning = String(warnSpy.mock.calls[0]?.[0]);
		expect(warning).toContain("retry-rules-ext-config.json");
		expect(warning).toContain("已回落空规则集");

		// 去重：同一损坏文件版本的后续判定命中 mtime+size 缓存，不再重复告警
		rewriteMessageForRetry(ERROR_MESSAGE);
		rewriteMessageForRetry(ERROR_MESSAGE);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();

		// 修正保存（mtime/size 变化）→ 重读重校生效，合法配置不告警
		writeConfig([RPM_RULE]);
		const warnSpyAfterFix = vi.spyOn(logger, "warn");
		expect(rewriteMessageForRetry(ERROR_MESSAGE)).toBeDefined();
		expect(warnSpyAfterFix).not.toHaveBeenCalled();
	});

	it("合法配置判定 → 零告警（降级通道不误报）", () => {
		writeConfig([RPM_RULE]);
		const logger = getLogger("retry-rules");
		const warnSpy = vi.spyOn(logger, "warn");
		expect(rewriteMessageForRetry(ERROR_MESSAGE)).toBeDefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

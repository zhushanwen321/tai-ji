// logger-mock.ts — session-manager 测试共享的 pi-extension-logger 模块 mock
//（notify-ledger-discipline / tool-non-json-response / watch-orchestration 三份
// 逐字重复的 vi.hoisted + vi.mock 样板提取）。
//
// 使用方式（测试文件内）：
//   import { createLoggerModuleMock, getLoggerMock } from "./helpers/logger-mock.ts";
//   vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());
//   const loggerMock = getLoggerMock();
//
// 初始化顺序约束（同 subagent-workflow injector-test-mocks 先例）：本文件只有
// vitest 一个运行时依赖、不 import 被测模块——vi.mock 工厂惰性执行时引用本文件的
// import 绑定，故测试文件里本 import 必须先于任何会加载 pi-extension-logger 的
// import（../index.ts / ../notify-ledger.ts / extension-harness helper）。
// 模块级单例按测试文件隔离（vitest 默认 isolate），getLoggerMock() 与被 mock 模块
// 的 getLogger() 返回同一引用——断言面与桩面同源。

import { vi } from "vitest";

/** 与被 mock 模块 getLogger() 同源的 spy 集（断言面经 getLoggerMock() 取用） */
const loggerMock = {
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
};

export type LoggerMock = typeof loggerMock;

/** 断言面：取本测试文件的 logger spy（与 mock 模块内 getLogger() 返回值同引用） */
export function getLoggerMock(): LoggerMock {
	return loggerMock;
}

/** pi-extension-logger 模块 mock 工厂（vi.mock 内调用；须写 () => createLoggerModuleMock() 惰性形式） */
export function createLoggerModuleMock() {
	return {
		getLogger: () => loggerMock,
		setPiHandle: vi.fn(),
	};
}

// workflow-events-registration-order.test.ts —— setupWorkflowDomain 的 pi.on 注册
// 顺序锁（逐位不变契约）。
//
// index.ts 头注与 setupWorkflowDomain JSDoc 声明「7 个 pi.on handler 的注册相对
// 顺序原样保留」。跨域 handler 迁出（session_compact / model_select / 父级联
// before 事件归各自域模块的 setup* 注册）后，本用例是顺序逐位不变的机器证据：
// fake pi 捕获 on() 调用序列，与锁定的 7 事件序列逐位比对。
//
// 测试直入 setupWorkflowDomain（事件族装配 seam 本体），不挂 index.ts、不 mock
// 兄弟模块——注册期不执行 handler 体，装配面无需任何 mock；对齐
// workflow-events-handler-fences.test.ts 的槽隔离模式。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { InFlightReporter } from "../host/inflight-reporter.ts";
import { peekStallWatchdog } from "../workflow-stall-watchdog.ts";
import { setupWorkflowDomain } from "../workflow-events.ts";

// 槽 key（Symbol.for 同 key 即同一 symbol——与被测实现登记的 key 一致）
const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");
const STALL_WATCHDOG_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-stall-watchdog");

/** 锁定的注册顺序（index.ts 头注声明的 7 事件序列，逐位不变契约）。 */
const EXPECTED_REGISTRATION_ORDER = [
  "session_start",
  "session_compact",
  "model_select",
  "session_tree",
  "session_before_fork",
  "session_before_switch",
  "session_shutdown",
] as const;

function makePi(): { pi: ExtensionAPI; onCalls: string[] } {
  const onCalls: string[] = [];
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (event: string) => {
      onCalls.push(event);
    },
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, onCalls };
}

function makeReporter(): InFlightReporter {
  return {
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    onInFlightChanged: vi.fn(),
  } as unknown as InFlightReporter;
}

// ── 槽隔离（防跨测试文件串扰——提权后槽是进程级共享态） ────────────────────────

function resetSlots(): void {
  // watchdog 实例先 dispose 再删槽（arm 起的 interval 防 timer 泄漏干扰后续用例）
  peekStallWatchdog()?.dispose();
  Reflect.deleteProperty(globalThis, WORKFLOW_DOMAIN_SLOT_KEY);
  Reflect.deleteProperty(globalThis, STALL_WATCHDOG_SLOT_KEY);
}

beforeEach(() => {
  resetSlots();
});

afterEach(() => {
  resetSlots();
});

describe("setupWorkflowDomain pi.on 注册顺序", () => {
  it("7 个事件按锁定序列逐位注册（跨域 setup* 调用原位、不改变序列）", () => {
    const { pi, onCalls } = makePi();
    setupWorkflowDomain(pi, { inflightReporter: makeReporter() });

    expect(onCalls).toEqual([...EXPECTED_REGISTRATION_ORDER]);
  });
});

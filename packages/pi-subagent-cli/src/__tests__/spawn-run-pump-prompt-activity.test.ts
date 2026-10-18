// src/__tests__/spawn-run-pump-prompt-activity.test.ts
//
// [C-U1 / m-pi-1] post-prompt 零输出计时器的活性判据回归：**任意** stdout 字节
// （chunk 层——含 `kind:"invalid"` 行、以及未成行的 partial chunk）都必须取消 30s
// 零输出计时器。
//
// 设计 D3 / §3.4.2 口径：prompt 写入后只要出现任意 stdout 字节（stdoutBytesAfterPrompt
// > 0）即视为通道活性证据，计时器取消但不 settle；只有「完全零输出」才判
// engine_prompt_not_delivered。修复前活性/字节计数只按完整行（invalid 分支漏报、
// 未成行 chunk 不计），健康的 pi 若只吐 invalid 行或大行慢写（无 \n）会在窗口到期
// 被 SIGKILL 误杀。当前实现把活性与字节计数上移到 chunk 层，行消费器只做解析。
//
// 驱动方式：wireChildStdoutPump（真实 pumpNdjsonLines 链）+ 真实 PromptAckTracker，
// fake timers 只接管 setTimeout/clearTimeout（stdout 的 nextTick 交付保持真实）。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPromptAckTracker, type PromptAckResult } from "../prompt-ack.ts";
import {
  createPromptRunCounters,
  createSessionIdentityTracker,
  wireChildStdoutPump,
  type PromptRunCounters,
  type RunEndState,
} from "../spawn-run-pump.ts";
import type { SpawnRunCallbacks } from "../spawn-runner.ts";

/** 零输出窗口（fake timers，取值不影响语义）。 */
const ACK_WINDOW_MS = 1_000;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "pump-prompt-activity-"));
  // 只接管计时器：PassThrough 的 data 交付（nextTick）与 setImmediate flush 保持真实。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 等待 stdout 的 data 事件链（nextTick）跑完。 */
async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeFakeChild(): {
  child: ChildProcess;
  stdout: PassThrough;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = {
    stdout,
    stdin,
    stderr: null,
    killed: false,
    pid: 6161,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  } as unknown as ChildProcess;
  return { child, stdout };
}

type Harness = {
  tracker: ReturnType<typeof createPromptAckTracker>;
  failures: PromptAckResult[];
  counters: PromptRunCounters;
  stdout: PassThrough;
};

function makeHarness(): Harness {
  const { child, stdout } = makeFakeChild();
  const counters = createPromptRunCounters();
  // prompt 已写入（onChannelActivity 的「写入后」语义门）。
  counters.promptWritten = true;
  const failures: PromptAckResult[] = [];
  const tracker = createPromptAckTracker({
    recordId: "rec-prompt-activity",
    timeoutMs: ACK_WINDOW_MS,
    diagnostics: () => ({
      pid: 6161,
      bytesWritten: 1,
      stdoutBytes: counters.stdoutBytes,
      stdoutBytesAfterPrompt: counters.stdoutBytesAfterPrompt,
      stdoutSeen: tracker.stdoutSeen,
      getStateAnswered: counters.getStateAnswered,
    }),
    onFailure: (result) => failures.push(result),
  });
  tracker.register("prompt-1");
  const callbacks: SpawnRunCallbacks = { onEvent: () => {} };
  const runEnd: RunEndState = { endedCleanly: false };
  wireChildStdoutPump({
    child,
    recordId: "rec-prompt-activity",
    callbacks,
    identity: createSessionIdentityTracker(dir, callbacks),
    handleSdkEvent: () => {},
    enqueueUi: () => {},
    stderrTee: undefined,
    runEnd,
    promptAck: tracker,
    runCounters: counters,
  });
  return { tracker, failures, counters, stdout };
}

describe("[C-U1] post-prompt invalid 行的活性语义", () => {
  it("仅 invalid 行（非法 JSON + JSON 缺 type）→ 计时器取消、run 不 settle", async () => {
    const h = makeHarness();
    // 两种 invalid 来源（parseSpawnLine）：JSON 解析失败；JSON 缺 string type。
    h.stdout.write(Buffer.from('{oops: not json\n', "utf8"));
    h.stdout.write(Buffer.from('{"foo":"bar"}\n', "utf8"));
    await flushStdout();

    // 字节计数口径（含 invalid）与活性快照同时成立
    expect(h.counters.stdoutBytesAfterPrompt).toBeGreaterThan(0);
    expect(h.tracker.stdoutSeen).toBe(true);

    vi.advanceTimersByTime(ACK_WINDOW_MS);
    expect(h.failures).toEqual([]); // 未 settle：无 timeout 失败

    // 不 settle 的直接证据：迟到的 prompt response 仍按 acked 正常结算（不产生失败面）
    h.tracker.dispatch("prompt-1", "prompt", true, { disposition: "started" });
    expect(h.failures).toEqual([]);
    h.tracker.dispose();
  });

  it("对照：post-prompt 完全零输出 → 窗口到期 settle timeout（证明上例依赖活性取消）", () => {
    const h = makeHarness();
    vi.advanceTimersByTime(ACK_WINDOW_MS);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]?.kind).toBe("timeout");
    h.tracker.dispose();
  });

  it("未成行的半个大行（无 \\n）→ chunk 活性取消计时器、不 settle、字节计数 > 0", async () => {
    const h = makeHarness();
    // 极端大行慢写形态：一个 8KB chunk 但没有行界 \\n——解析链只在内部缓冲，
    // 不产出任何行。活跃性必须由 chunk 层取消计时器（行级口径会在此漏判）。
    h.stdout.write(Buffer.from("x".repeat(8 * 1024), "utf8"));
    await flushStdout();

    expect(h.counters.stdoutBytesAfterPrompt).toBeGreaterThan(0);
    expect(h.counters.stdoutBytes).toBeGreaterThan(0);
    expect(h.tracker.stdoutSeen).toBe(true);

    vi.advanceTimersByTime(ACK_WINDOW_MS);
    expect(h.failures).toEqual([]); // 计时器已取消：partial chunk 不 settle

    // 后续 prompt response 到达仍按 acked 结算（活性不是第二回执）
    h.tracker.dispatch("prompt-1", "prompt", true, { disposition: "started" });
    expect(h.failures).toEqual([]);
    h.tracker.dispose();
  });
});
